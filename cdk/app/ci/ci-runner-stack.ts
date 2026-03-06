import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface CiRunnerStackBaseProps extends cdk.StackProps {
  readonly serviceName: string;

  /**
   * Token/credential secret name in Secrets Manager.
   * Provider-specific meaning:
   * - GitLab: runner auth token (often glrt-...)
   * - GitHub: PAT (recommended) or registration token (not recommended; expires)
   */
  readonly secretName: string;

  // Label/tag used by the CI system to target this runner host.
  readonly runnerTag: string;
}

/**
 * Raison d'etre:
 * - Provide a cheap, "always-on" CI runner in AWS for this service, without needing SSH access for ops.
 *
 * Core tradeoff:
 * - Cost: single EC2 in a public subnet avoids NAT costs and keeps this simple.
 * - Security: no inbound rules, but the runner has powerful IAM (AdministratorAccess) so a compromised CI job can
 * compromise the AWS account. Tightening that later usually means isolation + scoped deploy roles, at the cost
 * of more setup and AWS resources.
 */
export abstract class CiRunnerStackBase extends cdk.Stack {
  protected readonly vpc: ec2.IVpc;
  protected readonly runnerRole: iam.Role;
  protected readonly runnerLogGroup: logs.LogGroup;
  protected readonly tokenSecret: secretsmanager.ISecret;
  protected readonly runnerSg: ec2.SecurityGroup;
  protected readonly instance: ec2.Instance;
  protected readonly userData: ec2.UserData;

  constructor(scope: Construct, id: string, props: CiRunnerStackBaseProps) {
    super(scope, id, props);

    // 1) VPC LOOKUP (currently targets the dev VPC by tags)
    this.vpc = ec2.Vpc.fromLookup(this, 'ProjectVpc', {
      tags: {
        MyService: props.serviceName,
        MyStagingEnvironment: 'dev',
      },
    });

    // --- CloudWatch Logs (for debugging without instance access) ---
    this.runnerLogGroup = new logs.LogGroup(this, 'CiRunnerLogGroup', {
      // Must be unique per stack to avoid collisions when deploying multiple runner stacks for the same service.
      logGroupName: `/ci-runner/${props.serviceName}/${this.stackName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2) IAM ROLE
    this.runnerRole = new iam.Role(this, 'CiRunnerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // CI needs to run `cdk deploy` reliably.
        //
        // Keeping admin here is the "stop thinking about it" choice: fewer permission surprises.
        // Tradeoff: if a CI job is compromised, the AWS account is at risk.
        //
        // If you want to reduce that risk later, the usual next step is:
        // - put the runner in a network-isolated setup (separate VPC/subnets + VPC endpoints),
        // - and switch CI to assume a tightly-scoped deploy role per stage.
        // Tradeoff: more AWS resources and cost (and more setup work).
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'),

        // Optional but recommended: allows Session Manager access without opening SSH
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),

        // Recommended: allows CloudWatch Agent to push logs
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // -------------------------------------------------------
    // Allow CI to assume the EKS deploy role created by the app stack.
    //
    // AppStack creates:  <serviceName>-eks-deploy-<dev|release>
    // CI uses it for:   aws eks update-kubeconfig --role-arn <that role>
    //
    // Trust for that role is AccountPrincipal(account), so only principals with explicit
    // sts:AssumeRole permission can assume it.
    // -------------------------------------------------------
    this.runnerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/${props.serviceName}-eks-deploy-*`],
    }));

    // 3) SECRET REFERENCE (value fetched at runtime by instance)
    this.tokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'RunnerTokenSecretRef',
      props.secretName
    );
    this.tokenSecret.grantRead(this.runnerRole);

    // Allow writing to the log group (defensive; CW Agent policy usually covers this,
    // but this makes the intent explicit and avoids surprises).
    this.runnerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
        'logs:DescribeLogGroups',
      ],
      resources: [this.runnerLogGroup.logGroupArn, `${this.runnerLogGroup.logGroupArn}:*`],
    }));

    // 4) SECURITY GROUP (no inbound; outbound allowed)
    this.runnerSg = new ec2.SecurityGroup(this, 'RunnerSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for CI Runner EC2 instance (no inbound).',
      allowAllOutbound: true,
    });
    // Intentionally no ingress rules.

    // 5) EC2 INSTANCE
    this.instance = new ec2.Instance(this, 'RunnerInstance', {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, // avoid NAT costs
      securityGroup: this.runnerSg,

      // T3: extra RAM headroom for Gradle/JVM workloads
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),

      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: this.runnerRole,

      httpPutResponseHopLimit: 2,    // (Allows (roles) metadata to reach Docker containers)

      blockDevices: [
        {
          deviceName: '/dev/xvda',

          // 50GB ("stop thinking about it" size)
          volume: ec2.BlockDeviceVolume.ebs(50),
        },
      ],
    });

    // 6) USER DATA (bootstrap)
    this.userData = ec2.UserData.forLinux();

    this.userData.addCommands(
      // Fail fast + log
      'set -euo pipefail',
      'exec > /var/log/user-data.log 2>&1',

      // Updates + packages (AL2023 uses dnf)
      'dnf update -y',
      'dnf install -y docker jq awscli ca-certificates tar gzip curl-minimal',

      // Ensure SSM agent is installed + running (don’t rely on AMI defaults)
      'dnf install -y amazon-ssm-agent',
      'systemctl enable --now amazon-ssm-agent',

      // Install + start CloudWatch Agent to ship logs off-instance
      'dnf install -y amazon-cloudwatch-agent',

      // Write CloudWatch Agent config (logs only)
      'cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << \'EOF\'',
      JSON.stringify({
        logs: {
          logs_collected: {
            files: {
              collect_list: [
                {
                  file_path: '/var/log/user-data.log',
                  log_group_name: this.runnerLogGroup.logGroupName,
                  log_stream_name: '{instance_id}/user-data.log',
                  timestamp_format: '%Y-%m-%d %H:%M:%S',
                },
                {
                  file_path: '/var/log/messages',
                  log_group_name: this.runnerLogGroup.logGroupName,
                  log_stream_name: '{instance_id}/messages',
                },
                {
                  file_path: '/var/log/cloud-init-output.log',
                  log_group_name: this.runnerLogGroup.logGroupName,
                  log_stream_name: '{instance_id}/cloud-init-output.log',
                },
              ],
            },
          },
        },
      }, null, 2),
      'EOF',

      // Start CloudWatch Agent
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a stop || true',
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s',

      // Docker
      'systemctl enable --now docker',
      'usermod -a -G docker ec2-user',

      // --- Addition 1: swap (reduces "random" stalls caused by OOM) ---
      //
      // Tradeoff: if memory is genuinely too small, swap makes it slower instead of crashing.
      'if [ ! -f /swapfile ]; then',
      '  echo "Creating swapfile..."',
      '  dd if=/dev/zero of=/swapfile bs=1M count=2048',
      '  chmod 600 /swapfile',
      '  mkswap /swapfile',
      '  swapon /swapfile',
      '  echo "/swapfile swap swap defaults 0 0" >> /etc/fstab',
      'else',
      '  swapon /swapfile || true',
      'fi',

      // --- Addition 2: Docker prune (prevents disk creep from killing the runner) ---
      //
      // Tradeoff: after prune, future jobs may re-pull images and run a bit slower.
      'docker system prune -af --volumes || true',
      'cat > /etc/cron.daily/docker-prune << \'EOF\'',
      '#!/bin/bash',
      'docker system prune -af --volumes || true',
      'EOF',
      'chmod +x /etc/cron.daily/docker-prune'
    );

    // Provider-specific bootstrap
    this.addProviderUserData(props);

    this.instance.addUserData(this.userData.render());

    new cdk.CfnOutput(this, 'RunnerInstanceId', { value: this.instance.instanceId });
    new cdk.CfnOutput(this, 'RunnerSecurityGroupId', { value: this.runnerSg.securityGroupId });
    new cdk.CfnOutput(this, 'RunnerLogGroupName', { value: this.runnerLogGroup.logGroupName });
  }

  protected abstract addProviderUserData(props: CiRunnerStackBaseProps): void;
}
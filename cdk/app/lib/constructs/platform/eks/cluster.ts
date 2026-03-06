// lib/constructs/platform/eks/cluster.ts

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { KubectlV35Layer } from '@aws-cdk/lambda-layer-kubectl-v35';
import { ServiceConfig } from '../../../../config/service-config';

/**
 * Properties for the EKS cluster construct.
 */
export interface EksClusterConstructProps {
  /** The VPC where the EKS cluster and worker nodes will be deployed. */
  readonly vpc: ec2.IVpc;
  /** Staging environment, used for sizing decisions. */
  readonly stagingEnvironment: 'dev' | 'release';
  /** Service name, used for naming/tagging. */
  readonly serviceName: string;

  /**
   * Optional list of IAM role ARNs to grant kubectl (system:masters) access.
   * Use the role ARN form: arn:aws:iam::ACCOUNT:role/ROLE_NAME
   * (not the assumed-role/session form from `aws sts get-caller-identity`).
   *
   * Why this is needed: CDK deploys via a CloudFormation service role, so
   * CloudFormation -- not you -- becomes the "cluster creator" with admin access.
   * Your personal IAM/SSO role is locked out by default.
   */
  readonly adminRoleArns?: string[];
  /** Route53 hosted zone ID for automatic DNS record management via ExternalDNS. */
  readonly hostedZoneId?: string;
  /** Apex domain (e.g. 'example.com'), used for ExternalDNS domain filtering. */
  readonly apexDomain?: string;
}

/**
 * Creates an EKS cluster with a managed EC2 node group and the AWS Load Balancer Controller add-on.
 *
 * What this creates in AWS:
 *   - EKS control plane (the managed K8s API server -- ~$73/month)
 *   - Managed node group (EC2 instances in your private subnets that run pods)
 *   - AWS Load Balancer Controller (reads K8s Ingress objects and creates real ALBs)
 *   - ExternalDNS (watches Ingress resources and creates/deletes Route53 records automatically)
 *   - OIDC provider (lets K8s service accounts assume IAM roles -- needed by the LB controller)
 *
 * What this does NOT create:
 *   - Deployments, Services, Ingress -- those are applied separately via kubectl/Helm
 */
export class EksClusterConstruct extends Construct {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: EksClusterConstructProps) {
    super(scope, id);

    const k8s = ServiceConfig.kubernetes;

    const kubectlLayer = new KubectlV35Layer(this, 'KubectlLayer');

    // -------------------------------------------------------
    // 1. EKS Cluster (control plane)
    // -------------------------------------------------------
    // The mastersRole is the IAM role that can run kubectl against this cluster.
    // By default, the CDK-deploying role also gets admin access.
    this.cluster = new eks.Cluster(this, 'EksCluster', {
      vpc: props.vpc,
      version: eks.KubernetesVersion.V1_35,
      kubectlLayer,
      defaultCapacity: 0, // We'll add our own managed node group below
      clusterName: `${props.serviceName}-k8s-${props.stagingEnvironment}`,

      // Place worker nodes in private subnets (same as your ECS Fargate tasks)
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],

      // Endpoint access: public+private means kubectl works from your laptop
      // AND pods can talk to the API server over the private VPC network.
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
    });

    // -------------------------------------------------------
    // 1b. Grant kubectl access to admin roles
    // -------------------------------------------------------
    // Without this, only the CloudFormation service role (which created the
    // cluster) can use kubectl. Your personal SSO/IAM role would be locked out.
    for (const roleArn of props.adminRoleArns ?? []) {
      this.cluster.awsAuth.addRoleMapping(
        iam.Role.fromRoleArn(this, `AdminRole-${roleArn.split('/').pop()}`, roleArn),
        { groups: ['system:masters'] }
      );
    }

    // -------------------------------------------------------
    // 2. Managed Node Group (the EC2 worker instances)
    // -------------------------------------------------------
    // These are the machines that actually run your pods.
    // AWS handles: provisioning, patching, draining on updates.
    // You handle: choosing instance type and min/max counts.
    const nodeSize = props.stagingEnvironment === 'dev' ? k8s.nodeGroup.dev : k8s.nodeGroup.release;

    this.cluster.addNodegroupCapacity('WorkerNodes', {
      instanceTypes: [new ec2.InstanceType(nodeSize.instanceType)],
      minSize: nodeSize.minNodes,
      maxSize: nodeSize.maxNodes,
      desiredSize: nodeSize.desiredNodes,
      diskSize: nodeSize.diskSizeGb,
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,

      // Private subnets -- nodes don't need public IPs
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },

      // Labels let you target pods to specific node pools later if needed
      labels: {
        'app': props.serviceName,
        'environment': props.stagingEnvironment,
      },
    });

    // -------------------------------------------------------
    // 3. AWS Load Balancer Controller (add-on)
    // -------------------------------------------------------
    // This controller runs as a pod inside K8s. It watches for Ingress resources
    // and creates/manages real AWS ALBs in response.
    //
    // Without it, K8s Ingress objects are just inert YAML -- nothing happens.
    //
    // The controller needs an IAM role to create ALBs, target groups, etc.
    // We use IRSA (IAM Roles for Service Accounts) so only this specific pod
    // gets those permissions, not the entire node.
    this.installAwsLoadBalancerController(props);

    // -------------------------------------------------------
    // 4. ExternalDNS (automatic Route53 record management)
    // -------------------------------------------------------
    // This controller runs as a pod inside K8s. It watches Ingress resources
    // for the `external-dns.alpha.kubernetes.io/hostname` annotation and
    // automatically creates/updates/deletes Route53 A records.
    //
    // This is the K8s equivalent of your DnsRecordsConstruct in ECS:
    //   - ECS: CDK creates Route53 records directly (pointing at the CDK-managed ALB)
    //   - EKS: ExternalDNS creates Route53 records (pointing at the LB Controller-managed ALB)
    //
    // Only install ExternalDNS when BOTH hostedZoneId and apexDomain are set.
    const hasDnsConfig = Boolean((props.hostedZoneId ?? '').trim() && (props.apexDomain ?? '').trim());
    if (hasDnsConfig) {
      this.installExternalDns(props);
    }

    // -------------------------------------------------------
    // 5. Outputs
    // -------------------------------------------------------
    // IMPORTANT:
    // Outputs defined under a non-Stack construct get a path-prefixed OutputKey in CloudFormation.
    // CI scripts typically query for a stable key like 'EksClusterName'.
    // Define these outputs at the Stack scope so the OutputKey is predictable.
    const stack = cdk.Stack.of(this);

    new cdk.CfnOutput(stack, 'EksClusterName', {
      value: this.cluster.clusterName,
      description: 'Name of the EKS cluster (use with: aws eks update-kubeconfig --name <this>)',
    });

    new cdk.CfnOutput(stack, 'EksKubectlCommand', {
      value: `aws eks update-kubeconfig --name ${this.cluster.clusterName} --region ${stack.region}`,
      description: 'Run this command to configure kubectl for this cluster',
    });
  }

  /**
   * Installs the AWS Load Balancer Controller via Helm chart.
   *
   * This is the K8s equivalent of your LoadBalancerConstruct:
   *   - ECS: CDK creates the ALB directly
   *   - EKS: CDK installs a controller that creates ALBs based on Ingress manifests
   *
   * The controller uses IRSA (IAM Roles for Service Accounts) to get AWS permissions.
   * IRSA works via the cluster's OIDC provider -- the K8s service account gets annotated
   * with an IAM role ARN, and the AWS SDK in the pod exchanges its K8s token for
   * temporary AWS credentials.
   */
  private installAwsLoadBalancerController(props: EksClusterConstructProps): void {
    const namespace = 'kube-system';
    const serviceAccountName = 'aws-load-balancer-controller';

    // Create an IAM role that the LB controller pod can assume via IRSA
    const lbControllerSa = this.cluster.addServiceAccount('LbControllerSa', {
      name: serviceAccountName,
      namespace: namespace,
    });

    // The LB controller needs broad permissions to manage ALBs, target groups,
    // security groups, WAF associations, etc.
    // This is the official IAM policy from AWS:
    // https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json
    const lbControllerPolicyStatements = [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:CreateServiceLinkedRole',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: { 'iam:AWSServiceName': 'elasticloadbalancing.amazonaws.com' },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:DescribeAccountAttributes',
          'ec2:DescribeAddresses',
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeInternetGateways',
          'ec2:DescribeVpcs',
          'ec2:DescribeVpcPeeringConnections',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeInstances',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DescribeTags',
          'ec2:DescribeCoipPools',
          'ec2:GetCoipPoolUsage',
          'ec2:DescribeInstanceTypes',
          'elasticloadbalancing:DescribeLoadBalancers',
          'elasticloadbalancing:DescribeLoadBalancerAttributes',
          'elasticloadbalancing:DescribeListeners',
          'elasticloadbalancing:DescribeListenerCertificates',
          'elasticloadbalancing:DescribeSSLPolicies',
          'elasticloadbalancing:DescribeRules',
          'elasticloadbalancing:DescribeTargetGroups',
          'elasticloadbalancing:DescribeTargetGroupAttributes',
          'elasticloadbalancing:DescribeTargetHealth',
          'elasticloadbalancing:DescribeTags',
          'elasticloadbalancing:DescribeTrustStores',
          'elasticloadbalancing:DescribeListenerAttributes',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:DescribeUserPoolClient',
          'acm:ListCertificates',
          'acm:DescribeCertificate',
          'iam:ListServerCertificates',
          'iam:GetServerCertificate',
          'wafv2:GetWebACL',
          'wafv2:GetWebACLForResource',
          'wafv2:AssociateWebACL',
          'wafv2:DisassociateWebACL',
          'waf-regional:GetWebACLForResource',
          'waf-regional:GetWebACL',
          'waf-regional:AssociateWebACL',
          'waf-regional:DisassociateWebACL',
          'shield:GetSubscriptionState',
          'shield:DescribeProtection',
          'shield:CreateProtection',
          'shield:DeleteProtection',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:AuthorizeSecurityGroupIngress',
          'ec2:RevokeSecurityGroupIngress',
          'ec2:CreateSecurityGroup',
          'ec2:DeleteSecurityGroup',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateTags',
          'ec2:DeleteTags',
        ],
        resources: ['arn:aws:ec2:*:*:security-group/*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:CreateLoadBalancer',
          'elasticloadbalancing:CreateTargetGroup',
        ],
        resources: ['*'],
        conditions: {
          Null: { 'aws:RequestTag/elbv2.k8s.aws/cluster': 'false' },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:CreateListener',
          'elasticloadbalancing:DeleteListener',
          'elasticloadbalancing:CreateRule',
          'elasticloadbalancing:DeleteRule',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:AddTags',
          'elasticloadbalancing:RemoveTags',
        ],
        resources: [
          'arn:aws:elasticloadbalancing:*:*:targetgroup/*/*',
          'arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*',
          'arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*',
          'arn:aws:elasticloadbalancing:*:*:listener/app/*/*',
          'arn:aws:elasticloadbalancing:*:*:listener/net/*/*',
          'arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*',
          'arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*',
        ],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:ModifyLoadBalancerAttributes',
          'elasticloadbalancing:SetIpAddressType',
          'elasticloadbalancing:SetSecurityGroups',
          'elasticloadbalancing:SetSubnets',
          'elasticloadbalancing:DeleteLoadBalancer',
          'elasticloadbalancing:ModifyTargetGroup',
          'elasticloadbalancing:ModifyTargetGroupAttributes',
          'elasticloadbalancing:DeleteTargetGroup',
          'elasticloadbalancing:RegisterTargets',
          'elasticloadbalancing:DeregisterTargets',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:SetWebAcl',
          'elasticloadbalancing:ModifyListener',
          'elasticloadbalancing:AddListenerCertificates',
          'elasticloadbalancing:RemoveListenerCertificates',
          'elasticloadbalancing:ModifyRule',
        ],
        resources: ['*'],
      }),
    ];

    lbControllerPolicyStatements.forEach(statement => {
      lbControllerSa.addToPrincipalPolicy(statement);
    });

    // Install the controller via its official Helm chart
    this.cluster.addHelmChart('AwsLoadBalancerController', {
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      namespace: namespace,
      release: 'aws-load-balancer-controller',
      values: {
        clusterName: this.cluster.clusterName,
        serviceAccount: {
          create: false, // We created it above with IRSA
          name: serviceAccountName,
        },
        region: cdk.Stack.of(this).region,
        vpcId: this.cluster.vpc.vpcId,
      },
    });
  }

  /**
   * Installs ExternalDNS via Helm chart.
   *
   * This is the K8s equivalent of your DnsRecordsConstruct:
   *   - ECS: CDK creates Route53 alias records at deploy time
   *   - EKS: ExternalDNS runs as a pod and creates/deletes Route53 records
   *     whenever Ingress resources are created/deleted
   *
   * Uses IRSA for Route53 permissions (same pattern as the LB Controller).
   * Policy is `sync` so records are deleted when Ingress resources are removed.
   */
  private installExternalDns(props: EksClusterConstructProps): void {
    const namespace = 'kube-system';
    const serviceAccountName = 'external-dns';

    // This method is only called when BOTH values are set (see constructor).
    const hostedZoneId = props.hostedZoneId!.trim();
    const apexDomain = props.apexDomain!.trim();

    // Create an IAM role that ExternalDNS can assume via IRSA
    const externalDnsSa = this.cluster.addServiceAccount('ExternalDnsSa', {
      name: serviceAccountName,
      namespace: namespace,
    });

    // ExternalDNS needs permissions to read/write Route53 records
    externalDnsSa.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'route53:ChangeResourceRecordSets',
      ],
      resources: [`arn:aws:route53:::hostedzone/${hostedZoneId}`],
    }));

    externalDnsSa.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'route53:ListHostedZones',
        'route53:ListResourceRecordSets',
        'route53:ListTagsForResource',
      ],
      resources: ['*'],
    }));

    // Install ExternalDNS via its official Helm chart
    this.cluster.addHelmChart('ExternalDns', {
      chart: 'external-dns',
      repository: 'https://kubernetes-sigs.github.io/external-dns/',
      namespace: namespace,
      release: 'external-dns',
      values: {
        serviceAccount: {
          create: false, // We created it above with IRSA
          name: serviceAccountName,
        },
        provider: {
          name: 'aws',
        },
        // Only manage records in this specific hosted zone
        extraArgs: [
          `--domain-filter=${apexDomain}`,
          '--aws-zone-type=public',
          `--txt-owner-id=${props.serviceName}-k8s-${props.stagingEnvironment}`,
        ],
        // 'sync' = delete records when Ingress is removed
        // 'upsert-only' = create/update but never delete
        policy: 'sync',
        // Only watch Ingress resources (not Services, etc.)
        sources: ['ingress'],
      },
    });
  }
}
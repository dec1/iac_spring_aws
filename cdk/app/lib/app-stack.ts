// lib/app-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as constructs from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';

import { WebAclConstruct } from './constructs/web-acl';
import { VpcConstruct, VpcConstructProps } from './constructs/vpc';
import { StorageConstruct, StorageConstructProps } from './constructs/storage';
import { IamConstruct } from './constructs/iam';
import { CertificateConstruct, DnsRecordsConstruct } from './constructs/domain';
import { LoadBalancerConstruct } from './constructs/platform/ecs/loadbalancer';
import { EcsClusterConstruct } from './constructs/platform/ecs/cluster';
import { FargateServiceConstruct } from './constructs/platform/ecs/service';
import { EksClusterConstruct } from './constructs/platform/eks/cluster';
import { ContainerImageProvisioner } from './constructs/image-provisioner';
import { AppStackProps } from '../config/stack-props';

export class AppStack extends cdk.Stack {
  public readonly webAclArnOutput: cdk.CfnOutput;
  public readonly albDnsNameOutput: cdk.CfnOutput;
  public readonly serviceUrlOutput: cdk.CfnOutput;
  public readonly s3BucketNameOutput?: cdk.CfnOutput;

  constructor(scope: constructs.Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // Web ACL (WAFv2)
    const webAcl = new WebAclConstruct(this, 'ApplicationWebAcl', {
      serviceName: props.serviceName,
      environment: props.stagingEnvironment,
    });

    // Tagging
    cdk.Tags.of(this).add('MyService', props.serviceName);
    cdk.Tags.of(this).add('MyStagingEnvironment', props.stagingEnvironment);
    cdk.Tags.of(this).add('MyComputePlatform', props.computePlatform);
    cdk.Tags.of(this).add('myCdkStack', `${props.serviceName}-${props.stagingEnvironment}-${props.computePlatform}`);

    // VPC + Security Groups
    const vpcProps: VpcConstructProps = {
      restrictDefaultSecurityGroup: false,
      appPortNum: props.appPortNum,

      // - maxAzs: Number of Availability Zones to use (minimum 2 required for ALB high availability)
      //   * Dev: 2 AZs (cost optimization)
      //   * Release: 3 AZs (better redundancy across AZs)
      maxAzs: props.stagingEnvironment === 'dev' ? 2 : 3,

      // - natGateways: Number of NAT Gateways for private subnet internet access
      //   * Each NAT Gateway requires 1 Elastic IP and costs ~$32/month
      //   * 1 NAT Gateway is sufficient for both environments (shared across all private subnets)
      //   * Using more than 1 increases redundancy but also cost and EIP usage
      natGateways: props.stagingEnvironment === 'dev' ? 1 : 1,

      // Tag subnets for the AWS Load Balancer Controller (needed for EKS, harmless for ECS)
      tagSubnetsForEks: props.computePlatform === 'kubernetes',
      eksClusterName: props.computePlatform === 'kubernetes'
        ? `${props.serviceName}-k8s-${props.stagingEnvironment}`
        : undefined,
    };
    const network = new VpcConstruct(this, 'NetworkInfrastructure', vpcProps);

    // Pass bucket name and create flag if provided
    const storageProps: StorageConstructProps = {};
    if (props.s3BucketName) {
      storageProps.bucketName = props.s3BucketName;
      storageProps.createIfNecessary = props.s3BucketIsCdkManaged ?? true;
      storageProps.maxNoncurrentVersions = props.s3BucketMaxNoncurrentVersions ?? 10;
      storageProps.noncurrentVersionExpirationDays = props.s3BucketNoncurrentVersionExpirationDays ?? 1;
    }
    const storage = new StorageConstruct(this, 'ApplicationStorage', storageProps);

    // Output bucket name if bucket exists
    if (storage.dataBucket) {
      this.s3BucketNameOutput = new cdk.CfnOutput(this, 'S3BucketName', {
        value: storage.dataBucket.bucketName,
        description: `Name of the S3 bucket for ${props.stagingEnvironment} environment`,
      });
    }

    // IAM for tasks (TaskRole + ExecutionRole)
    const iamRoles = new IamConstruct(this, 'ApplicationIamRoles');

    // Container image
    const imageProvisioner = new ContainerImageProvisioner(this, 'AppContainerImage', {
      imageSource: props.imageSource,
      imageRepositoryName: props.imageRepositoryName,
      tag: props.tag,
    });

    // ---------------------------------------------------------------------------
    // Optional Custom Domain (Route53 + ACM)
    //
    // If apexDomain + hostedZoneId are both set, we:
    // - build FQDN: <hostnamePrefix>.<apexDomain>
    // - request an ACM certificate for that FQDN (HTTPS on the ALB)
    // - create Route53 records (ECS) / enable ExternalDNS filtering (EKS)
    //
    // If either is missing/empty, we:
    // - skip ACM + Route53 resources
    // - fall back to the ALB DNS name over HTTP (no TLS)
    // ---------------------------------------------------------------------------
    const apexDomain = (props.apexDomain ?? '').trim();
    const hostedZoneId = (props.hostedZoneId ?? '').trim();

    const hasCustomDomain = Boolean(apexDomain && hostedZoneId);

    if ((apexDomain && !hostedZoneId) || (!apexDomain && hostedZoneId)) {
      // Helpful synth-time hint: both fields must be set to enable custom-domain mode.
      console.warn(
        `[${id}] Custom domain partially configured: apexDomain='${apexDomain}', hostedZoneId='${hostedZoneId}'. ` +
        `Both are required for HTTPS + Route53. Falling back to ALB DNS name over HTTP.`
      );
    }

    let fqdn: string | undefined;
    let hostedZone: route53.IHostedZone | undefined;
    let acmCertificate: CertificateConstruct | undefined;

    if (hasCustomDomain) {
      // DNS / Certificate - construct FQDN from hostname prefix + apex domain
      fqdn = `${props.hostnamePrefix}.${apexDomain}`;

      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: hostedZoneId,
        zoneName: apexDomain,
      });

      acmCertificate = new CertificateConstruct(this, 'SslCertificateResource', {
        fqdn,
        hostedZone,
      });
    }



    // ECS
    if (props.computePlatform === 'ecs') {

      // Load Balancer + Listener
	  const alb = new LoadBalancerConstruct(this, 'ApplicationLoadBalancerSetup', {
	      vpc:         network.vpc,
	      albSg:       network.albSg,

          // If no custom domain is configured, certificate will be undefined and the construct
          // will create an HTTP (port 80) listener instead of HTTPS.
	      certificate: acmCertificate?.certificate,

	      webAclArn:   webAcl.webAclArn,
	    });

      const ecsCluster = new EcsClusterConstruct(this, 'ApplicationEcsCluster', {
        vpc: network.vpc,
      });

      // ----------------------------------------------
      // Environment Variables for containers
      const containerEnvironment: Record<string, string> = {
        AWS_REGION: this.region,
        SERVICE_NAME: props.serviceName,
        STAGING_ENVIRONMENT: props.stagingEnvironment,
        // === INJECT AUTH ISSUER ===
        SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI: props.identityIssuerUri,
      };
      // Add S3 bucket name if available
      if (storage.dataBucket) {
        containerEnvironment.S3_DATA_BUCKET = storage.dataBucket.bucketName;
      }
      // ----------------------------------------------

      const fargateServices = new FargateServiceConstruct(this, 'ApplicationFargateServices', {
        cluster: ecsCluster.cluster,

        // Application perms vs ECS agent perms (ECR pull happens on executionRole)
        taskRole:                    iamRoles.taskRole,
        executionRole:               iamRoles.executionRole,

        containerImage:              imageProvisioner.containerImage,
        fargateSg:                   network.fargateSg,
        listener:                    alb.listener,
        vpc:                         network.vpc,
        serviceName:                 props.serviceName,
        stagingEnvironment:          props.stagingEnvironment,
        healthChecks:                props.healthChecks,
        environment:                 containerEnvironment,
        terminationWaitTimeMinutes:  props.terminationWaitTimeMinutes,
        appPortNum:                  props.appPortNum,
        imageSource:                 props.imageSource,
        imageRepositoryName:         props.imageRepositoryName,
        tag:                         props.tag,
        wantGrafana:                 props.wantGrafana,
      });

      // Only create Route53 records when custom-domain mode is enabled.
      if (hasCustomDomain && hostedZone) {
        new DnsRecordsConstruct(this, 'ServiceDnsAliasRecords', {
          hostedZone,
          hostnamePrefix: props.hostnamePrefix,
          loadBalancer: alb.loadBalancer,
        });
      }

      if (fargateServices.blueService && fargateServices.greenService) {
        new cdk.CfnOutput(this, 'BlueFargateServiceName', {
          value: fargateServices.blueService.serviceName,
          description: 'Name of the blue (current) Fargate service',
        });
        new cdk.CfnOutput(this, 'GreenFargateServiceName', {
          value: fargateServices.greenService.serviceName,
          description: 'Name of the green (new/staging) Fargate service',
        });
      } else if (fargateServices.blueService) {
        new cdk.CfnOutput(this, 'PrimaryFargateServiceName', {
          value: fargateServices.blueService.serviceName,
          description: 'Name of the primary Fargate service',
        });
      }

      this.albDnsNameOutput = new cdk.CfnOutput(this, 'AlbDnsName', {
        value: alb.loadBalancer.loadBalancerDnsName,
        description: 'DNS name of the Application Load Balancer',
      });

      // Stable output key, but value changes based on whether custom domain is configured.
      const serviceUrl =
        (hasCustomDomain && fqdn)
          ? `https://${fqdn}`
          : `http://${alb.loadBalancer.loadBalancerDnsName}`;

      this.serviceUrlOutput = new cdk.CfnOutput(this, 'ServiceUrl', {
        value: serviceUrl,
        description: 'URL of the service',
      });

    }

    // EKS (Kubernetes)
    // CDK creates only the cluster + node group + LB controller.
    // Workloads (Deployment, Service, Ingress) are applied separately via kubectl.
    else if (props.computePlatform === 'kubernetes') {

      // -------------------------------------------------------
      // EKS deploy role (for CI)
      //
      // Why:
      // - CI runner's instance role should not need to be mapped directly into EKS.
      // - CI instead assumes this role, which IS mapped into EKS (system:masters).
      //
      // Trust model:
      // - Trusts the AWS account (AccountPrincipal). Only principals that are granted sts:AssumeRole
      //   permissions can actually assume it. We grant that permission to the CI runner role in the runner stack.
      // -------------------------------------------------------
      const eksDeployRole = new iam.Role(this, 'EksDeployRole', {
        roleName: `${props.serviceName}-eks-deploy-${props.stagingEnvironment}`,
        assumedBy: new iam.AccountPrincipal(this.account),
        description: `Role assumed by CI to run kubectl against ${props.serviceName} EKS ${props.stagingEnvironment}`,
      });

      // Build the list of EKS-admin-mapped roles.
      // - Human/admin role (optional, from config)
      // - CI deploy role (always, for kubectl in CI)
      const adminRoleArns: string[] = [];
      if (props.eksAdminRoleArn) {
        adminRoleArns.push(props.eksAdminRoleArn);
      }
      adminRoleArns.push(eksDeployRole.roleArn);

      const eksCluster = new EksClusterConstruct(this, 'ApplicationEksCluster', {
        vpc: network.vpc,
        stagingEnvironment: props.stagingEnvironment,
        serviceName: props.serviceName,
        adminRoleArns: adminRoleArns,

        // ExternalDNS is only installed when these are set (see EksClusterConstruct).
        hostedZoneId: hasCustomDomain ? hostedZoneId : undefined,
        apexDomain: hasCustomDomain ? apexDomain : undefined,
      });

      // Grant the task role access to S3 bucket if it exists.
      // The K8s pods will use this role via IRSA (configured in the K8s manifests).
      if (storage.dataBucket) {
        storage.dataBucket.grantReadWrite(iamRoles.taskRole);
      }

      // Output values needed for K8s manifests.
      // These values are used as annotations in the Ingress manifest
      // to tell the AWS Load Balancer Controller which cert and WAF to use.

      // Certificate is only available in custom-domain mode.
      new cdk.CfnOutput(this, 'EksCertificateArn', {
        value: acmCertificate
          ? acmCertificate.certificate.certificateArn
          : 'not-configured (no apexDomain/hostedZoneId)',
        description: 'ACM certificate ARN -- paste into k8s/ingress.yaml annotation (optional)',
      });

      new cdk.CfnOutput(this, 'EksWebAclArn', {
        value: webAcl.webAclArn,
        description: 'WAF WebACL ARN -- paste into k8s/ingress.yaml annotation',
      });

      new cdk.CfnOutput(this, 'EksHostname', {
        value: fqdn ?? 'not-configured (no apexDomain/hostedZoneId)',
        description: 'FQDN for the Ingress host rule (optional)',
      });

      // Used by CI/local scripts to perform:
      // aws eks update-kubeconfig --role-arn <this>
      new cdk.CfnOutput(this, 'EksDeployRoleArn', {
        value: eksDeployRole.roleArn,
        description: 'IAM role ARN to assume for kubectl access (CI deploy role)',
      });

      // DNS record pointing to the ALB will be created by the Ingress controller.
      // After your first `kubectl apply -f k8s/ingress.yaml`, the controller creates an ALB.
      // You then need to get the ALB DNS name:
      //   kubectl get ingress my-backend-ingress -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
      // and create a Route53 alias record pointing your FQDN to it.
      //
      // For production, consider ExternalDNS (a K8s add-on that auto-creates Route53 records
      // from Ingress annotations), but for now a manual `aws route53` command or console click
      // is fine to get started.

      // Placeholder outputs -- the real ALB is created by the Ingress controller at kubectl-apply time
      this.albDnsNameOutput = new cdk.CfnOutput(this, 'AlbDnsName', {
        value: 'pending -- created by AWS LB Controller when Ingress is applied',
        description: 'DNS name of the ALB (populated after kubectl apply of Ingress)',
      });

      // Stable output key, but value changes based on whether custom domain is configured.
      this.serviceUrlOutput = new cdk.CfnOutput(this, 'ServiceUrl', {
        value: fqdn
          ? `https://${fqdn}`
          : 'http://<ALB_DNS_NAME> (no custom domain configured; get via kubectl get ingress ...)',
        description: 'URL of the service (via EKS Ingress)',
      });

    }
    else {
      console.error(`Unknown computePlatform: ${props.computePlatform}`);
    }

    this.webAclArnOutput = new cdk.CfnOutput(this, 'WebAclArn', {
      value: webAcl.webAclArn,
      description: 'ARN of the associated Web Application Firewall (WAF) ACL',
    });
  }
}
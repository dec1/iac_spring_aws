// lib/constructs/vpc.ts

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * @module vpc-construct
 * This module defines a custom Virtual Private Cloud (VPC) and associated security groups
 * tailored for the application. It encapsulates the core network infrastructure setup,
 * including public subnets for the load balancer and private subnets for the Fargate services.
 */

/**
 * Properties for the VpcConstruct.
 */
export interface VpcConstructProps {
  /** Number of Availability Zones to carve out (defaults to all AZs in region if undefined). */
  readonly maxAzs?: number;
  /** Number of NAT Gateways to create (defaults to one per AZ if undefined). */
  readonly natGateways?: number;
  /** Whether to restrict the default security group via a custom resource (default: true). */
  readonly restrictDefaultSecurityGroup?: boolean;
  /** The port number on which your Fargate tasks listen (used to open SG rules). */
  readonly appPortNum: number;

  // --- EKS subnet tagging ---
  /** Whether to tag subnets for the AWS Load Balancer Controller (EKS only). */
  readonly tagSubnetsForEks?: boolean;
  /** EKS cluster name -- required when tagSubnetsForEks is true. */
  readonly eksClusterName?: string;
}

/**
 * A CDK Construct that provisions a VPC with public and private subnets,
 * and dedicated security groups for the Application Load Balancer (ALB) and AWS Fargate services.
 */
export class VpcConstruct extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly fargateSg: ec2.SecurityGroup;

  /**
   * Creates the VPC and foundational security groups.
   * @param scope The parent CDK Stack or Construct.
   * @param id The logical ID of this construct within the CDK tree.
   * @param props Optional properties for configuring the VPC.
   */
  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id);

    /**
     * Provisions a VPC.
     * - default AZ count if maxAzs is undefined
     * - default NAT gateway count per AZ if natGateways is undefined
     * - Contains public subnets: Intended for internet-facing resources like the Application Load Balancer.
     * - Contains private subnets with NAT Gateway egress: Intended for application services (e.g., Fargate tasks)
     *   that should not be directly accessible from the internet but may need to initiate outbound connections.
     */
    const vpcProps: ec2.VpcProps = {
      maxAzs: props.maxAzs,
      natGateways: props.natGateways,
      subnetConfiguration: [
        { name: 'public',  subnetType: ec2.SubnetType.PUBLIC,           cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: props.restrictDefaultSecurityGroup ?? true,
    };

    this.vpc = new ec2.Vpc(this, 'AppVpc', vpcProps);

    /**
     * Grant EC2 permissions to the Lambda that restricts the default SG, if enabled.
     */
    if (props.restrictDefaultSecurityGroup ?? true) {
      const customResource = this.vpc.node.tryFindChild('RestrictDefaultSecurityGroupCustomResource') as cdk.CustomResource | undefined;
      if (customResource) {
        try {
          const provider   = customResource.node.findChild('Provider');
          const lambdaRole = provider.node.findChild('Role') as iam.Role | undefined;
          if (lambdaRole) {
            lambdaRole.addToPolicy(new iam.PolicyStatement({
              actions: [
                'ec2:AuthorizeSecurityGroupIngress',
                'ec2:RevokeSecurityGroupIngress',
                'ec2:DescribeSecurityGroups',
                'ec2:UpdateSecurityGroupRuleDescriptionsIngress',
              ],
              resources: ['*'],
            }));
          }
        } catch (e: unknown) {
          console.warn('Custom resource provider not found; skipping permissions update:', (e as Error).message);
        }
      }
    }

    // -------------------------------------------------------
    // EKS subnet tagging
    // -------------------------------------------------------
    // The AWS Load Balancer Controller discovers which subnets to place ALBs in by looking
    // for these specific tags. Without them, `kubectl apply` of an Ingress will fail with
    // "could not find any suitable subnets".
    //
    // Public subnets get tagged for internet-facing ALBs (the Ingress-created ALB).
    // Private subnets get tagged for internal ALBs and for node placement.
    //
    // These tags are harmless when running ECS -- they're just ignored.
    if (props.tagSubnetsForEks && props.eksClusterName) {
      const clusterTag = `kubernetes.io/cluster/${props.eksClusterName}`;

      for (const subnet of this.vpc.publicSubnets) {
        cdk.Tags.of(subnet).add(clusterTag, 'shared');
        cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
      }
      for (const subnet of this.vpc.privateSubnets) {
        cdk.Tags.of(subnet).add(clusterTag, 'shared');
        cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
      }
    }

    /**
     * Security Group for the Application Load Balancer (ALB).
     * - Description: Controls network traffic to and from the ALB.
     * - Outbound: Allows all outbound traffic, enabling the ALB to forward requests to the Fargate service.
     * - Inbound: Allows HTTPS (TCP port 443) traffic from any IPv4 address, making the ALB accessible from the internet.
     */
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'Security group for the Application Load Balancer (ALB). Controls traffic to/from the ALB.',
      allowAllOutbound: true,
    });
    this.albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from the internet to the ALB'
    );

    /**
     * Security Group for the AWS Fargate service.
     * - Description: Controls network traffic to and from the Fargate containers.
     * - Outbound: Allows all outbound traffic, enabling Fargate tasks to access other AWS services (e.g., S3, CloudWatch Logs) and external APIs.
     * - Inbound: Allows HTTP (TCP port props.appPortNum) traffic exclusively from the ALB's security group. This ensures that
     *   the Fargate containers are only accessible through the ALB and not directly from the public internet.
     */
    this.fargateSg = new ec2.SecurityGroup(this, 'FargateSg', {
      vpc: this.vpc,
      description: 'Security group for the Fargate service. Controls traffic to/from the containers.',
      allowAllOutbound: true,
    });
    this.fargateSg.addIngressRule(
      this.albSg,
      ec2.Port.tcp(props.appPortNum),
      `Allow HTTP traffic from the ALB to the Fargate service on port ${props.appPortNum}`
    );
  }
}
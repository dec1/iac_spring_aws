import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Properties for the ECS cluster.
 */
export interface EcsClusterConstructProps {
  /** The VPC where the ECS cluster will be deployed. */
  readonly vpc: ec2.IVpc;
}

/**
 * A CDK Construct that provisions an ECS cluster.
 * The cluster serves as a logical grouping for Fargate services and tasks.
 */
export class EcsClusterConstruct extends Construct {
  public readonly cluster: ecs.Cluster;

  constructor(scope: Construct, id: string, props: EcsClusterConstructProps) {
    super(scope, id);

    this.cluster = new ecs.Cluster(this, 'AppCluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
  }
}

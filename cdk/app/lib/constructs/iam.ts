//  lib/constructs/iam.ts

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * A CDK Construct that provisions IAM Roles for ECS Fargate tasks.
 *
 * NOTE ON ROLES (important for ECR):
 * - "taskRole": used by YOUR APPLICATION code inside the container (e.g., S3 access).
 * - "executionRole": used by the ECS agent to pull images and publish logs.
 *   Image pulls from ECR require permissions on the executionRole (not the taskRole).
 */
export class IamConstruct extends Construct {
  public readonly taskRole: iam.Role;
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // ----------------------------------------------------------------------------
    // 1) TASK ROLE (application permissions)
    // ----------------------------------------------------------------------------
    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'IAM role for ECS Fargate tasks (application permissions like S3 and STS).',
    });

    // 2) STS: Allow the task to verify its own identity
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowStsGetCallerIdentity',
      effect: iam.Effect.ALLOW,
      actions: ['sts:GetCallerIdentity'],
      resources: ['*'],
    }));

    // 3) S3: List ALL buckets in the account
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowListAllBuckets',
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListAllMyBuckets'],
      resources: ['*'],
    }));

    // 4) S3: List the contents of any bucket
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowListAnyBucket',
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: ['arn:aws:s3:::*'],
    }));

    // 5) S3: Get, Put, and Delete objects in any bucket
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowObjectActionsAnyBucket',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
      ],
      resources: ['arn:aws:s3:::*/*'],
    }));

    // ----------------------------------------------------------------------------
    // 2) EXECUTION ROLE (ECS agent permissions)
    // ----------------------------------------------------------------------------
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'IAM role for ECS agent (pull images from ECR, write logs to CloudWatch).',
      managedPolicies: [
        /**
         * Includes (among others):
         * - ECR pull actions: ecr:GetAuthorizationToken, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer, ...
         * - CloudWatch logs actions for awslogs driver
         *
         * Safe to keep even if you switch back to Docker Hub later:
         * - Docker Hub pulls won't use these ECR permissions, but they don't break anything.
         */
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Optional hardening: you can add extra policies here if needed later.
    // For example, if you use private Docker registries that require Secrets Manager, etc.
    // this.executionRole.addToPolicy(...)
  }
}

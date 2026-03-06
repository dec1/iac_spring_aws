// config/app-stack-props.ts

import * as cdk from 'aws-cdk-lib';

/**
 * Defines the contract for the properties required to build the AppStack.
 * This interface is populated by the Mapper (in config/) and consumed by the Stack (in lib/).
 */
export interface AppStackProps extends cdk.StackProps {
  imageRepositoryName: string;
  tag: string;
  serviceName: string;
  imageSource: 'ecr' | 'dockerhub';
  computePlatform: 'ecs' | 'kubernetes';
  stagingEnvironment: 'dev' | 'release';
  
  // Optional Custom Domain:
  // - Set BOTH apexDomain and hostedZoneId to enable ACM + Route53 + HTTPS.
  // - Leave either/both empty to fall back to ALB DNS name over HTTP (no TLS).
  apexDomain: string;
  hostedZoneId: string;

  hostnamePrefix: string;
  
  healthChecks: {
    containerHealthCheckCommand: string[];
    containerHealthCheckRetries: number;
    containerHealthCheckStartPeriod: cdk.Duration;
    containerHealthCheckTimeout: cdk.Duration;
    containerHealthCheckInterval: cdk.Duration;
    targetGroupHealthCheckPath: string;
    targetGroupHealthCheckInterval: cdk.Duration;
    targetGroupHealthCheckTimeout: cdk.Duration;
    targetGroupHealthyThresholdCount: number;
  };

  s3BucketName?: string;
  s3BucketIsCdkManaged?: boolean;
  s3BucketMaxNoncurrentVersions?: number;
  s3BucketNoncurrentVersionExpirationDays?: number;
  
  terminationWaitTimeMinutes?: number;
  greenImageTag?: string;
  appPortNum: number;
  wantGrafana?: boolean;

  // === Identity Provider URI ===
  identityIssuerUri: string;

  // === EKS admin access ===
  // IAM role ARN granted kubectl (system:masters) access to EKS clusters.
  // Only used when computePlatform is 'kubernetes'.
  eksAdminRoleArn?: string;
}
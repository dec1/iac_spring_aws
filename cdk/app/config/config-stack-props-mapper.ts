// config/stack-props-mapper.ts

import * as cdk from 'aws-cdk-lib';
import { AppConfig, EnvConfig } from './config-reader';
// CHANGE: Import from local config file instead of lib
import { AppStackProps } from './stack-props';

/**
 * Responsible for mapping "Pure Configuration Data" (from AppConfigReader)
 * into "Infrastructure Properties" required by the AppStack.
 * * * It takes the primitive values (strings, numbers) and converts them into
 * CDK-specific objects (like cdk.Duration) that the AppStack constructs require.
 * * Note: The target interface 'AppStackProps' is defined in './app-stack-props.ts'.
 */
export class StackPropsMapper {

  public static mapToAppStackProps(
    appConfig: AppConfig,
    envCfg: EnvConfig,
    identityIssuerUri: string
  ): AppStackProps {
      // ... (Implementation remains exactly the same) ...
    const hc = envCfg.healthConfig;

    return {
      serviceName:                  appConfig.serviceName,
      stagingEnvironment:           envCfg.stagingEnvironment,
      computePlatform:              envCfg.computePlatform,
      apexDomain:                   appConfig.apexDomain,
      hostedZoneId:                 appConfig.hostedZoneId,
      hostnamePrefix:               envCfg.hostnamePrefix!,

      appPortNum:                   appConfig.appPortNum,
      terminationWaitTimeMinutes:   appConfig.terminationWaitTimeMinutes,
      wantGrafana:                  appConfig.wantGrafana ?? false,

      imageSource:                  envCfg.imageSource,
      imageRepositoryName:          envCfg.imageRepositoryName,
      tag:                          envCfg.imageTag,

      s3BucketName:                 envCfg.s3BucketName,
      s3BucketIsCdkManaged:         envCfg.s3BucketIsCdkManaged,

      identityIssuerUri:            identityIssuerUri,

      eksAdminRoleArn:              appConfig.eksAdminRoleArn,

      healthChecks: {
        containerHealthCheckCommand:     hc.command,
        containerHealthCheckRetries:     hc.retries,
        containerHealthCheckStartPeriod: cdk.Duration.seconds(hc.startPeriodSeconds),
        containerHealthCheckTimeout:     cdk.Duration.seconds(hc.timeoutSeconds),
        containerHealthCheckInterval:    cdk.Duration.seconds(hc.intervalSeconds),
        targetGroupHealthCheckPath:      hc.path,
        targetGroupHealthCheckTimeout:   cdk.Duration.seconds(hc.timeoutSeconds),
        targetGroupHealthCheckInterval:  cdk.Duration.seconds(hc.intervalSeconds),
        targetGroupHealthyThresholdCount: hc.healthyThreshold,
      },
    };
  }
}

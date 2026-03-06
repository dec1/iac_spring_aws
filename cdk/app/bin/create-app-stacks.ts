import * as cdk from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { IdentityStack } from '../idp/identity-stack';
import { AppConfig } from '../config/config-reader';
import { StackPropsMapper } from '../config/config-stack-props-mapper';

//-----------------------------------------------------------------------------------------
// 2. Create App Stacks (Dev / Release)
//-----------------------------------------------------------------------------------------
// These stacks are instantiated here but typically deployed by GitLab Runner in CI
// Manual deployment: `cdk deploy <serviceName>-dev --profile <aws-profile>`
// CI deployment: Automatic on git push (runner handles this)
export function createAppStacks(
  app: cdk.App,
  appConfig: AppConfig,
  serviceName: string,
  env: { account: string; region: string },
  identityStack: IdentityStack
) {
  // Create both ECS and Kubernetes stacks for each environment
  const devStack = createAppStack('dev');
  devStack.addDependency(identityStack); 

  const releaseStack = createAppStack('release');
  releaseStack.addDependency(identityStack); 

const devStack_k8s =  createAppStack('k8s-dev');
const releaseStack_k8s= createAppStack('k8s-release');

  return { devStack, releaseStack };

  function createAppStack(name: string) {
    // Figure out the stack name based on the serviceName and environment
    const stackName = `${serviceName}-${name}`;

    // Pick the nested EnvConfig for this environment
    const envCfg = appConfig.envConfigs[name];

    if (!envCfg) {
      throw new Error(`No configuration found for name '${name}'.`);
    }

    // Log details of stack being used
    console.log(`[CDK] Creating stack: ${stackName}`);
    console.log(`[CDK] Using image for environment '${name}':`);
    console.log(`       source: ${envCfg.imageSource}`);
    console.log(`       repository: ${envCfg.imageRepositoryName}`);
    console.log(`       tag: ${envCfg.imageTag}`);
    console.log(`       computePlatform: ${envCfg.computePlatform}`);

    // Use the Mapper to convert Pure Data (envCfg) into Infrastructure Props (props)
    // This keeps the "ugly" conversion logic out of this file.
    const props = {
      ...StackPropsMapper.mapToAppStackProps(
        appConfig,
        envCfg,
        identityStack.issuerUri
      ),
      env: env,
    };

    return new AppStack(app, stackName, props);
  }
}
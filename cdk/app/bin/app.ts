import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AppConfigReader, AppConfig } from '../config/config-reader';

import { resolveEnv } from './resolve-env';
import { createIdentityStack } from './create-identity-stack';
import { createAppStacks } from './create-app-stacks';
import { createCiRunnerStacks } from './create-ci-runner-stacks';

const app = new cdk.App();

// Load the resolved application configuration once using the static reader
// Note: 'tryGetContext' checks if you passed "-c myAppConfig=..." on the CLI.
// If not (returns undefined - effectively ignored), the reader falls back to default - reading 'app/config.yaml')
const appConfig: AppConfig = AppConfigReader.loadAppConfig(app.node.tryGetContext('myAppConfig'));
const serviceName = appConfig.serviceName;

/**
 * Entry point for this CDK app.
 *
 * Steps:
 * 1) Load config and resolve target AWS environment (account + region) for lookups and stack envs.
 * 2) Create identity foundation (shared).
 * 3) Create application stacks (dev/release).
 * 4) Optionally create CI runner stacks (GitLab/GitHub).
 *
 * Orchestration only. Specific logic is abstracted to isolated modules.
 */
main();

function main() {

  const env = resolveEnv(app, appConfig);
  const identityStack = createIdentityStack(app, serviceName, env);
  const { devStack, releaseStack } = createAppStacks(app, appConfig, serviceName, env, identityStack);
  createCiRunnerStacks(app, serviceName, env, appConfig, devStack);
}
import * as cdk from 'aws-cdk-lib';
import { IdentityStack } from '../idp/identity-stack';

//-----------------------------------------------------------------------------------------
// 1. Create Identity Stack (Shared across Dev and Release)
//-----------------------------------------------------------------------------------------
export function createIdentityStack(app: cdk.App, serviceName: string, env: { account: string; region: string }) {
  const identityStack = new IdentityStack(app, `${serviceName}-identity`, {
      env: env,

      // Pass the service name (e.g. "my-backend")
      serviceName: serviceName,

      // Automatically use the service name for the API identifier (e.g. "api://my-backend")
      apiIdentifier: `api://${serviceName}`,

      // Automatically combine service name + account ID to guarantee global uniqueness
      // (e.g. "my-backend-auth-739275440763")
      domainPrefix: `${serviceName}-auth-${env.account}`,
  });

  // Optional: Tagging for the stack
  cdk.Tags.of(identityStack).add('MyService', serviceName);
  cdk.Tags.of(identityStack).add('StackType', 'IdentityFoundation');

  return identityStack;
}
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * Configuration for the Identity Provider.
 * When reusing this script for a new project, you must decide on new values here.
 */
export interface IdentityStackProps extends cdk.StackProps {
  /** * The logical name of your project/service (e.g. "<serviceName>").
   * Used to prefix resource names in AWS so you can find them easily.
   */
  serviceName: string;

  /** * A unique namespace for your API Scopes (e.g. "api://<serviceName>").
   * This string appears inside the access tokens.
   * DECISION: Use "api://" + a short name describing your business logic.
   */
  apiIdentifier: string;

  /** * The prefix for the public login/token URL: https://<service-fqdn>-auth
   * CONSTRAINT: Must be GLOBALLY unique across ALL AWS customers.
   * DECISION: Combine project name + account ID  to ensure uniqueness.
   */
  domainPrefix: string;
}

/**
 * ============================================================================
 * IDENTITY STACK
 * ============================================================================
 * WHAT THIS FILE DOES:
 * 1. Creates a "User Pool": A directory for your machine identities.
 * 2. Creates a "Resource Server": Defines the API identifier and scopes (Read/Write).
 * 3. Creates "App Clients": Generates the Client ID & Secret credentials.
 * * LIFECYCLE NOTE:
 * This stack is "Foundational". It is meant to exist for the entire lifetime 
 * of your project. It is shared by both Dev and Release environments.
 * ============================================================================
 */
export class IdentityStack extends cdk.Stack {
  public readonly issuerUri: string;
  public readonly tokenEndpoint: string;
  public readonly internalClientId: string;
  public readonly externalClientId: string;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    // 1. Create User Pool (The Directory)
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.serviceName}-userpool`,
      
      // === SAFETY SETTING ===
      // DESTROY: If you delete this stack, the User Pool and ALL credentials are deleted. 
      //          Good for dev/testing.
      // RETAIN:  If you delete this stack, the User Pool remains in AWS (orphaned). 
      //          Recommended if this pool serves a live Production system to prevent data loss.
      //          Note: If you 'destroy' then 'deploy' again with RETAIN, CDK will create a NEW pool.
      //          It will NOT reconnect to the retained pool automatically.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      
      mfa: cognito.Mfa.OFF,
      selfSignUpEnabled: false,
    });

    // 2. Create Domain (The URL for the login server)
    const userPoolDomain = userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: props.domainPrefix,
      },
    });

    // --- Define Scopes Objects (Fix for TS2345) ---
    // We define these objects once to ensure consistency and satisfy TypeScript
    // which requires both name and description when referencing them later.
    const readScope = { scopeName: 'read', scopeDescription: 'Read access' };
    const writeScope = { scopeName: 'write', scopeDescription: 'Write access' };

    // 3. Create Resource Server (The Rules/Permissions)
    const apiResourceServer = userPool.addResourceServer('ApiResourceServer', {
      identifier: props.apiIdentifier,
      // Fix for CloudFormation Error: Explicitly set a friendly name.
      // If omitted, CDK defaults this to 'identifier' (api://...), which contains illegal characters (: /).
      userPoolResourceServerName: props.serviceName, 
      scopes: [ readScope, writeScope ],
    });

    // 4. Create "Internal" Client (Allowed to Read AND Write)
    const internalClient = userPool.addClient('ServiceClientInternal', {
      userPoolClientName: 'service_client_internal',
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [
          cognito.OAuthScope.resourceServer(apiResourceServer, readScope),
          cognito.OAuthScope.resourceServer(apiResourceServer, writeScope),
        ],
      },
    });

    // 5. Create "External" Client (Allowed to Read ONLY)
    const externalClient = userPool.addClient('ServiceClientExternal', {
      userPoolClientName: 'service_client_external',
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [
          cognito.OAuthScope.resourceServer(apiResourceServer, readScope),
        ],
      },
    });

    // 6. Outputs (Public info needed by the app)
    // These values are printed to your terminal after 'cdk deploy'
    this.issuerUri = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
    this.tokenEndpoint = userPoolDomain.baseUrl() + '/oauth2/token';
    this.internalClientId = internalClient.userPoolClientId;
    this.externalClientId = externalClient.userPoolClientId;

    new cdk.CfnOutput(this, 'IssuerUriOutput', {
      value: this.issuerUri,
      description: 'The OIDC Issuer URI to use in Spring Boot config',
    });

    new cdk.CfnOutput(this, 'TokenEndpointOutput', {
      value: this.tokenEndpoint,
      description: 'Endpoint to request tokens (OAuth2 Token URL)',
    });

    new cdk.CfnOutput(this, 'InternalClientIdOutput', {
      value: this.internalClientId,
      description: 'Client ID for Internal Service (Read/Write)',
    });
    
    // Note: Client Secrets are NOT output here. They must be retrieved via CLI/Console.
  }
}
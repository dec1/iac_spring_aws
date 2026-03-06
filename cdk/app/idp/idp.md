# Identity Provider (IDP) Setup

This directory contains the CDK configuration for the shared Identity Provider used by both `dev` and `release` environments.

## Why Deploy This First

This stack must be deployed before app stacks (dev/release) because:
- App stacks reference `identityStack.issuerUri` in their configuration
- Keeps auth credentials stable even if dev/release environments are destroyed/recreated
- Shared by both environments, so deploy once manually

## Architecture

- **Service:** AWS Cognito User Pool
- **Flow:** OAuth2 Client Credentials (Machine-to-Machine)
- **Resource Server Identifier:** `api://<serviceName>`
- **Scopes:**
    - `read`: Read-only access
    - `write`: Write access

For how the Spring app validates tokens and maps scopes to roles (see [spring](../../../spring/spring.md)).

## Clients

1. **service_client_internal**
    - Permissions: `read`, `write`
    - Use case: Internal backend services requiring full access.
2. **service_client_external**
    - Permissions: `read`
    - Use case: Third-party or external integrations requiring limited access.

## Deployment

```bash
cdk deploy <serviceName>-identity --profile <aws-profile>
```

## Retrieving Credentials (Scripts)

For security reasons, client secrets are **not** output to the console or stored in git. You can view the credentials in AWS Console or (see below) via AWS CLI after deployment.

**Prerequisites:**
1. The stack must be deployed (e.g., `<serviceName>-identity`).
2. You must have AWS CLI configured with appropriate permissions.

### Option 1: PowerShell (Windows)

    # 1. Define your stack name
    $StackName = "<serviceName>-identity"

    # 2. Get the User Pool ID from the Stack Outputs
    $IssuerUri = aws cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs[?OutputKey=='IssuerUriOutput'].OutputValue" --output text
    $UserPoolId = $IssuerUri.Split('/')[-1]
    Write-Host "Found User Pool ID: $UserPoolId"

    # 3. Get the Client ID for the INTERNAL service
    $ClientId = aws cognito-idp list-user-pool-clients --user-pool-id $UserPoolId --query "UserPoolClients[?ClientName=='service_client_internal'].ClientId" --output text
    Write-Host "Internal Client ID: $ClientId"

    # 4. Retrieve the Secret (Sensitive!)
    $Secret = aws cognito-idp describe-user-pool-client --user-pool-id $UserPoolId --client-id $ClientId --query "UserPoolClient.ClientSecret" --output text
    Write-Host "Internal Client Secret: $Secret"

### Option 2: Command Prompt (Windows CMD)

*Note: In CMD, we manually copy the User Pool ID first because automated text parsing is difficult.*

    REM 1. Get the User Pool ID. Look at the end of the URL (e.g., eu-west-3_xxxx)
    aws cloudformation describe-stacks --stack-name <serviceName>-identity --query "Stacks[0].Outputs[?OutputKey=='IssuerUriOutput'].OutputValue" --output text

    REM 2. Set the User Pool ID you found above
    set USER_POOL_ID=<REPLACE_WITH_YOUR_POOL_ID>

    REM 3. Get the Client ID
    aws cognito-idp list-user-pool-clients --user-pool-id %USER_POOL_ID% --query "UserPoolClients[?ClientName=='service_client_internal'].ClientId" --output text

    REM 4. Set the Client ID you found above
    set CLIENT_ID=<REPLACE_WITH_CLIENT_ID_FROM_STEP_3>

    REM 5. Get the Secret
    aws cognito-idp describe-user-pool-client --user-pool-id %USER_POOL_ID% --client-id %CLIENT_ID% --query "UserPoolClient.ClientSecret" --output text

### Option 3: Bash (Linux / macOS / Git Bash)

    # 1. Get User Pool ID
    STACK_NAME="<serviceName>-identity"
    USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='IssuerUriOutput'].OutputValue" --output text | awk -F/ '{print $NF}')

    echo "User Pool ID: $USER_POOL_ID"

    # 2. Get Internal Client ID & Secret
    CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id $USER_POOL_ID --query "UserPoolClients[?ClientName=='service_client_internal'].ClientId" --output text)

    echo "Client ID: $CLIENT_ID"

    # 3. Retrieve Secret
    aws cognito-idp describe-user-pool-client --user-pool-id $USER_POOL_ID --client-id $CLIENT_ID --query "UserPoolClient.ClientSecret" --output text

## Application Integration (Spring Boot)

The main application stacks (`dev`/`release`) automatically inject the `Issuer URI` into the container environment.

Spring Security validates the JWT and extracts scopes. The security configuration maps Cognito scopes to Spring authorities:

```java
http.authorizeHttpRequests(auth -> auth
    .requestMatchers(HttpMethod.GET, "/api/products/**")
        .hasAuthority("SCOPE_api://<serviceName>/read")
    .requestMatchers(HttpMethod.POST, "/api/products/**")
        .hasAuthority("SCOPE_api://<serviceName>/write")
    .anyRequest().authenticated()
)
.oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()));
```


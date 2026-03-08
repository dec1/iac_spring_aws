## Setup

### Prerequisites

- _AWS CLI_ configured with a profile that has admin-level access
- _AWS CDK_
- _Node.js_ 20+ 

#####
- Environment Variables
    Keeps credential resolution consistent everywhere -- the AWS SDK, CDK, Gradle, and Spring all pick them up the same way.
    - `AWS_REGION`
    - `AWS_PROFILE`   
        -  (pointing to a locally configured AWS profile - not needed for CI, which uses IAM roles instead)
####
- *Custom Domain (optional)*
Without a custom domain, your app is still reachable via the auto-generated ALB DNS name 
(e.g. `my-alb-123456789.eu-central-1.elb.amazonaws.com`).
To use a custom domain, you will need a _Route 53_ hosted _zone_ for your custom (apex) domain (see [config.yaml](cdk/config.yaml)). The CDK uses this zone to request a TLS certificate (ACM validates domain ownership via DNS records in the zone) and to create a DNS record pointing your hostname at the load balancer. If you registered your domain through Route 53, you're all set -- the hosted zone and name servers are configured automatically. If you registered elsewhere, you need to point your registrar's name servers at the Route 53 hosted zone.



### Dependency Order

Some resources must exist before others can reference them:

1. **ECR repository** -- shared image registry; must exist before the first image push
2. **Cognito (identity stack)** -- shared auth provider; all environments reference its issuer URI (no VPC, deploy once)
3. **Dev environment**(s) -- ECS or EKS dev stack (in its own VPC).
4. **CI runner** -- deployed into the dev VPC (of whichever of ECS or EKS has been created); handles all subsequent deploys
5. **Release environment(s)** -- ECS or EKS release stack (in its own VPC)
6. **K8s manifests** (EKS only) -- after `cdk deploy` creates the EKS cluster, run `deploy-manifests.sh` (or `.ps1`) to apply the K8s workloads. 
See [manifest](cdk/app/lib/constructs/platform/eks/manifests.md).

After this one-time bootstrap, the CI pipeline owns all further deploys.





### Additional preparatory steps


- #### Gitlab/Github Runner *Connectors*



    In the Gitlab/Github Web UI, you must create a _connector_ for your custom AWS runner, during which you will be allocated a "token". Your runner presents this token once at startup to register itself with Gitlab/Github on your behalf. Store this token in AWS *Secrets Manager* as the value of a (plaintext) secret with a name matching that in config.yaml (eg _GithubRunnerToken-my-backend_), so the runner can securely access it during registration.
    

    _Beware_: It's common, even in official documentation, for both the connector and the custom runner instance itself to be called _"the runner"_, but they are conceptually distinct.


- #### Manual tests _(optional)_
     To run `manual_tests.sh`, set 
     `EXT_CLIENT_ID`, `EXT_CLIENT_SECRET`, `INT_CLIENT_ID`, `INT_CLIENT_SECRET` 
     as CI/CD variables in the Github/Gitlab UI. These are the long-term credential pairs allocated to the two Cognito app clients automatically — retrievable from the AWS Console under Cognito. (The automated Kotlin tests don't need these, as they retrieve tokens directly via the AWS SDK.)

- #### Grafana Observability (_optional_)
    Grafana is a popular observability platform, available as a cloud or self-hosted instance (similar to GitLab). To automatically enable it, set `wantGrafana: true` in config.yaml and provide three environment variables from your Grafana account — see [grafana](cdk/app/lib/constructs/platform/ecs/grafana/grafana.md) for setup details.

- #### Proxy (Zscaler or similar)

    If behind a corporate proxy that rewrites TLS certificates, you will need to trust its CA in multiple places:

    | Tool | How |
    |------|-----|
    | AWS CLI | `set AWS_CA_BUNDLE=<path-to-proxy-cert.pem>` |
    | Node.js / CDK | `set NODE_EXTRA_CA_CERTS=<path-to-proxy-cert.pem>` |
    | JDK (Gradle, Spring) | Import into JDK truststore -- see `spring/local/proxy/readme.md` |
    | Docker (Grafana Alloy) | Custom debug image bundles the cert -- see [grafana](cdk/app/lib/constructs/platform/ecs/grafana/grafana.md) |

    As a temporary workaround for Node.js: `set NODE_TLS_REJECT_UNAUTHORIZED=0` (disables cert checking entirely -- use only for debugging).


- #### AWS Credentials
    You need access to an AWS account with valid credentials, available where the AWS CLI, CDK, and SDK expect to find them. A recommended approach is to configure a named _profile_ — see [AWS CLI named profiles](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-profiles.html).

    You can use either SSO or IAM credentials behind that profile:

    For example :
    - **SSO** (recommended for organizations):
        ```bash
        aws configure sso --profile <aws-profile>     # one-time setup
        aws sso login --profile <aws-profile>         # login when tokens expire
        ```

    - **IAM User** (with access keys):
        ```bash
        aws configure --profile <aws-profile>
        # enter access key ID, secret access key, region, output format
        # credentials stored in ~/.aws/credentials
        ```

    
    ######
    _Beware_: If your credentials have expired (eg SSO session timeout), CDK may show misleading errors about missing 
    `CDK_DEFAULT_ACCOUNT` or `AWS_REGION`. 
    Refresh your credentials first.
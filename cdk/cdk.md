# CDK - Infrastructure as Code (IaC)

AWS CDK (_TypeScript_) project that provisions all infrastructure: identity (_Cognito_), application stacks (_ECS/Fargate_ or _EKS (Kubernetes)_, _ALB_, _WAF_, _S3_, _DNS_), and self-hosted CI runners (GitLab/GitHub).

For bootstrapping and deployment order, see the main [readme](../readme.md). For CI pipeline details, see [ci](app/ci/ci.md).
For the Spring application, see [spring](../spring/spring.md).
For EKS-specific setup (kubectl, manifests, architecture comparison), see [eks](app/lib/constructs/platform/eks/eks.md).

---

## Getting Started

```bash
cd cdk/app
npm install
cdk synth              # validate templates without deploying
cdk deploy --all --profile <aws-profile>
```

Always have `AWS_REGION` and `AWS_PROFILE` set as env vars before running CDK commands.

### CDK Tests

Jest and its TypeScript support are declared in `package.json`, so `npm install` pulls them in.

```bash
npm test               # Execute the automated test suite.

# `npm test` is shorthand for `npm run test`
# it runs whatever command is configured as the `test` script in `package.json`
# Here its the test runner tool `jest` which figures out where the tests are located (`/test` dir via the `jest.config.js`
```

---

## ECR Repository (One-Time Setup)

All environments (ECS and EKS, dev and release) pull images from the same ECR repository.
It is created manually outside CDK so that image history survives stack deletions and there are no conflicts when stacks try to create a repository that already exists.

Create the repo once in your target account/region:


`aws ecr create-repository --repository-name <image-repo-name> --image-scanning-configuration scanOnPush=true --profile <aws-profile>`
-    eg `aws ecr create-repository --repository-name my-backend-img --image-scanning-configuration scanOnPush=true --profile myb`


If it already exists, AWS returns a `RepositoryAlreadyExistsException` -- that is fine.

Confirm it exists (_optional_):
`aws ecr describe-repositories --repository-names <image-repo-name> --profile <aws-profile>`


_Note on retention:_ All images are currently kept to make rollbacks straightforward. If the repo grows too large, consider adding an ECR lifecycle policy (e.g. keep last N images, expire untagged images after X days).

---

## Stacks Overview

The CDK app (`bin/app.ts`) creates stacks in this order:


1. **Identity Stack**
    - `<serviceName>-identity`
     Cognito User Pool, domain prefix, internal + external app clients
     Outputs: issuerUri, tokenEndpoint, clientIds
     No VPC -- shared by all app stacks.

2. **App Stacks (ECS)**
    - `<serviceName>-dev`
    - `<serviceName>-release`
     Each contains: VPC, WAF, ALB, ACM cert, DNS, ECS cluster,
     Fargate service(s), S3 bucket, IAM roles, CodeDeploy (release only)
     Depends on: _Identity Stack_ (for issuerUri)

3. **App Stacks (EKS)**
    - `<serviceName>-k8s-dev`
    - `<serviceName>-k8s-release`
     Each contains: VPC, WAF, ACM cert, EKS cluster, managed node group,
     AWS LB Controller, ExternalDNS, S3 bucket, IAM roles
     ALB and DNS records are created by in-cluster controllers (not CDK) when K8s manifests are applied.
     Depends on: _Identity Stack_ (for issuerUri)

4. **CI Runner Stacks**
    - `<serviceName>-ci-runner-gitlab`
    - `<serviceName>-ci-runner-github`
     EC2 instance with IAM role, Secrets Manager access
     Depends on: dev App Stack (for VPC)

Which app stacks are created depends on the environment blocks in `config.yaml`. Any combination of ECS and EKS, dev and release, is valid.

All stacks share the same AWS account and region, resolved once by `bin/resolve-env.ts`.


### Deployment order

Must be deployed in this order because of dependencies:

1. **ECR Repository** -- must exist before first image push. One-time manual creation, shared across environments.
2. **Identity Stack** (`<serviceName>-identity`) -- Cognito auth, needed by app stacks for issuer URI
3. **Dev Stack(s)** (`<serviceName>-dev` and/or `<serviceName>-k8s-dev`) -- creates the VPC that the runner will live in
4. **CI Runner Stack(s)** -- EC2 runner in the dev VPC's public subnet
5. **K8s manifests (EKS only)** -- after `cdk deploy` creates the EKS cluster, run `deploy-manifests.sh` to apply workloads

```bash
cd cdk/app
npm install

# Deploy in order (or deploy all -- CDK respects dependency order)
cdk deploy --all --profile <aws-profile>
```

---

## First-Time Deployment

Deploy these stacks once, manually, in order.

```bash
cd cdk/app
npm install

cdk bootstrap --profile <aws-profile>    # one-time CDK bootstrap (per AWS {account, region} combination)

# All at once (CDK respects dependency order):
cdk deploy --all --profile <aws-profile> [--require-approval never]

# Or one at a time:
cdk deploy <serviceName>-identity --profile <aws-profile>
cdk deploy <serviceName>-dev --profile <aws-profile>
cdk deploy <serviceName>-k8s-dev --profile <aws-profile>
cdk deploy <serviceName>-ci-runner-gitlab --profile <aws-profile>
cdk deploy <serviceName>-ci-runner-github --profile <aws-profile>
```

For ECS release, also trigger the blue/green deployment:
```bash
# Windows
powershell -File .\code_deploy\trigger_blue_green.ps1 -AwsProfile <aws-profile>

# Linux/macOS
./code_deploy/trigger_blue_green.sh --awsProfile <aws-profile>
```

For EKS stacks, apply K8s manifests after `cdk deploy`:
```bash
# Windows
.\lib\constructs\platform\eks\manifest\scripts\deploy-manifests.ps1 -StackName <serviceName>-k8s-dev -Profile <aws-profile> -Apply

# Linux/macOS
./lib/constructs/platform/eks/manifest/scripts/deploy-manifests.sh --stack-name <serviceName>-k8s-dev --profile <aws-profile> --apply
```

After these stacks are deployed, CI handles all dev/release updates automatically.

### Ongoing Workflow (CI)

- Push to `dev` branch -> Runner auto-deploys dev stacks (ECS and/or EKS, depending on config.yaml)
- Push to `main`/`master` -> Runner auto-deploys release stacks (after manual approval)

For ECS release: monitor progress in AWS Console under Developer Tools > CodeDeploy > Deployments. See the main [readme](../readme.md) for details on the blue/green canary strategy.

### How AWS config is resolved

- **Account:** From active AWS credentials (profile locally, assumed role in CI)
- **Region:** From local environment (`CDK_DEFAULT_REGION`, `AWS_REGION`) or config.yaml fallback
- Identity, dev, and runner all inherit whatever was active when you deployed them
- Runner passes these same values to app stack deployments in CI

---


## Deployment Strategies

### ECS

**Dev** uses ECS rolling updates -- new tasks replace old ones incrementally. Simple and fast for a non-production environment.

**Release** uses a Blue/Green Canary model orchestrated by AWS CodeDeploy. A complete "Green" environment is provisioned alongside the existing "Blue" one.
CodeDeploy then shifts 10% of live traffic to Green for a 5-minute bake period. If no alarms fire and no one intervenes, the remaining 90% shifts over and Blue is terminated.
If issues appear during the bake, traffic reverts to Blue instantly.

The lifecycle in more detail:

1. **Before deployment:** 100% of traffic runs on the Blue task set. A new Green task definition must be registered (CI or the trigger script handles this).
2. **Trigger:** The deployment script generates an AppSpec mapping the Green task definition to the target group. CodeDeploy provisions Green tasks and shifts 10% of ALB traffic to them.
3. **Bake (5 minutes):** Monitor logs and metrics. The deployment is in a wait state -- you can roll back manually at any point.
4. **Completion:** If the bake passes, CodeDeploy shifts the remaining 90% to Green and terminates Blue.

To trigger manually (ECS release only):
```bash
# Windows
powershell -File .\code_deploy\trigger_blue_green.ps1 -AwsProfile <aws-profile>

# Linux/macOS
./code_deploy/trigger_blue_green.sh --awsProfile <aws-profile>
```

Monitor progress in AWS Console under Developer Tools > CodeDeploy > Deployments.


For pipeline stages and the manual release gate, see [ci](app/ci/ci.md)


### EKS

Both dev and release use Kubernetes rolling updates, controlled by the Deployment spec (`maxSurge: 1`, `maxUnavailable: 0`). This ensures zero-downtime deploys but does not provide canary traffic splitting.

For EKS blue/green (canary traffic splitting with automated rollback), you'd install a K8s-native controller like Argo Rollouts or Flagger. See the "EKS Blue/Green" section below.


### EKS Blue/Green (not yet implemented)

The ECS blue/green canary is orchestrated entirely by AWS CodeDeploy, which is purpose-built for ECS: it creates a second ECS target group, spins up "green" Fargate tasks, shifts ALB traffic between two target groups at a defined pace (10%/90%), and rolls back if alarms fire. CDK creates all of this declaratively -- two services, two target groups, a CodeDeploy deployment group, and the canary config.

EKS has no equivalent AWS-managed mechanism. To achieve blue/green on EKS you'd use one of:

- **Argo Rollouts** -- a K8s-native controller that replaces the standard Deployment resource with a `Rollout` resource supporting canary and blue/green strategies. It manipulates multiple ReplicaSets behind a Service, shifting traffic via Ingress annotation changes or service selectors. This is the most common EKS solution.
- **Flagger** -- similar to Argo Rollouts, but integrates with service meshes (Istio, Linkerd) or Ingress controllers for traffic splitting. More complex to set up.
- **Manual** -- run two Deployments (blue and green) behind the same Service, using label selectors to shift traffic. Simple but no automated rollback.

The key difference: on ECS, CodeDeploy owns the entire lifecycle (create green tasks, shift traffic, monitor, rollback). On EKS, you install a third-party controller (Argo Rollouts or Flagger) that does the equivalent using K8s-native primitives. The result is the same -- canary traffic shifting with automated rollback -- but the machinery is different.

For now, EKS uses standard Kubernetes rolling updates (zero-downtime, but no canary traffic splitting).

---

## AWS Infrastructure Details




### Networking

Each app stack creates its own VPC with public and private subnets:
- **Public subnets:** ALB lives here (ECS) or is created here by the LB Controller (EKS), internet-facing
- **Private subnets:** Fargate tasks (ECS) or EC2 worker nodes (EKS) run here, outbound-only via NAT gateway
- Dev uses 2 AZs, release uses 3 AZs for higher redundancy
- 1 NAT gateway per environment (each costs ~$32/month)

Security groups enforce that containers are only reachable through the ALB (not directly from the internet). The ALB accepts HTTPS on port 443 only.

### Load Balancer and DNS

**ECS:** CDK creates the ALB, HTTPS listener, target groups, and Route 53 alias record directly.

**EKS:** CDK creates the ACM certificate and WAF WebACL, but the ALB itself is created by the AWS Load Balancer Controller when a K8s Ingress resource is applied. ExternalDNS (also installed by CDK) watches the Ingress for hostname annotations and automatically creates/deletes Route 53 A records. See [eks](app/lib/constructs/platform/eks/eks.md) for details on why this split exists.

Common to both:
- Internet-facing ALB with HTTPS listener (ACM certificate auto-validated via Route 53 DNS)
- Route 53 alias record points `<hostnamePrefix>.<apexDomain>` to the ALB
- Forward-headers strategy (`FRAMEWORK`) configured in Spring so Swagger generates correct HTTPS links behind the ALB

### WAF (Web Application Firewall)

Each app stack gets its own WAFv2 Web ACL attached to the ALB, with rules evaluated in priority order:

1. **Rate limiting** -- per-IP request cap (lower for dev, higher for release)
2. **IP reputation** -- AWS managed list of known-bad IPs
3. **Binary content passthrough** -- allows binary uploads (Excel, etc.) to skip text-focused rules that would produce false positives. Binary requests still pass rate-limit and IP-reputation checks above.
4. **Common Rule Set** -- XSS, command injection, etc. (only text/JSON requests reach this)
5. **SQLi protection** -- SQL injection patterns (only text requests)

_Tradeoff:_ Bot control (rule 6) is available but currently disabled. It blocks legitimate dev tools (Postman, curl) unless they spoof browser headers.

For ECS, CDK associates the WAF directly to the ALB it creates. For EKS, the WAF ARN is passed as an annotation in the K8s Ingress manifest, and the LB Controller associates it when creating the ALB.

### Security layers overview

| Layer | Service | What it does |
|-------|---------|-------------|
| Layer 3/4 | AWS Shield Standard | Automatic DDoS protection (always on for ALB) |
| Layer 7 | AWS WAF | Rate limiting per IP, XSS/SQLi filtering, IP reputation |
| App layer | Spring Security | OAuth2 JWT validation, role-based access control |

Shield Advanced, API Gateway, and additional bot control are available upgrades if needed -- see AWS docs for cost/benefit tradeoffs.

### ECS / Fargate

- Tasks run on Fargate (serverless, no EC2 instances to manage)
- Task CPU: 0.5 vCPU, Memory: 1 GB (configurable in `config/service-config.ts`)
- Auto-scaling based on 70% CPU utilization, with cooldowns to prevent flapping
- Container health check: `wget` against `/actuator/health` (configurable in config.yaml `healthCheckPath`)
- ALB target group health check: same path, checked by the load balancer independently

### EKS / Kubernetes

- Cluster runs on managed EC2 node groups (t3.medium by default)
- Pods defined in standard K8s YAML (Deployment, Service, Ingress, HPA)
- AWS Load Balancer Controller creates the ALB from Ingress annotations
- ExternalDNS creates Route 53 records from Ingress hostname annotations
- HPA auto-scales pods based on CPU utilization (70% target)
- Container health check: HTTP GET against `/actuator/health` (liveness + readiness probes)

For detailed EKS architecture, kubectl setup, and manifest deployment, see [eks](app/lib/constructs/platform/eks/eks.md).

### Storage (S3)

- One bucket per environment (dev and release), versioned
- Lifecycle rules: noncurrent versions expire after configurable days
- CDK-managed by default (`s3BucketIsCdkManaged: true`), meaning CDK creates and deletes the bucket. Set to `false` to manage the bucket independently.

### IAM Roles

**ECS:** Two roles per app stack, following least-privilege:
- **Task role:** used by application code at runtime (S3 read/write, STS get-caller-identity)
- **Execution role:** used by the ECS agent (pull images from ECR, push logs to CloudWatch)

**EKS:** IAM roles for:
- **Node group instance role:** EC2 workers (pull images from ECR, join cluster)
- **Pod service account role:** mapped via IRSA (IAM Roles for Service Accounts) for S3 access
- **LB Controller role:** manages ALBs, target groups, WAF association
- **ExternalDNS role:** manages Route 53 records

### Identity and Authentication

A dedicated Identity Stack (`<serviceName>-identity`) manages Cognito separately from app stacks. This ensures credentials remain stable even if dev/release stacks are destroyed and recreated.

Deploy this stack first, before app stacks, since they need the Cognito issuer URI.

See [idp](app/idp/idp.md) for detailed architecture, client scopes, and how to retrieve generated client secrets.

### Certificate Management

- ACM certificate created per app stack for `<hostnamePrefix>.<apexDomain>`
- DNS validation via Route 53 CNAME records, managed automatically by CDK

### Resource Tagging

All resources tagged with `MyService` and `MyStagingEnvironment` for cost tracking. Tags propagate to VPC, ALB, ECS services, EKS clusters, S3, etc. Filterable in AWS Console's Resource Groups & Tag Editor.

### Logging and Monitoring

- **ECS:** Container logs stream to CloudWatch Logs (under `/aws/ecs/...` log groups). Container health checks visible in ECS Console under Tasks -> Health.
- **EKS:** Application logs go to stdout/stderr (viewable via `kubectl logs`). Control plane logs available in CloudWatch under `/aws/eks/<cluster>/cluster` if enabled.
- ALB target group health metrics in EC2 Console -> Target Groups -> Monitoring and via CloudWatch Metrics (namespace: ELB)
- Actuator endpoints exposed: `health`, `info`, `metrics`, `prometheus`
- Optional Grafana Alloy sidecar for Prometheus remote-write (ECS only, enabled via `wantGrafana: true` + env vars). See [grafana](app/lib/constructs/platform/ecs/grafana/grafana.md) for setup and costs.

---

## Dev vs Release Environments

| Aspect | Dev (ECS) | Release (ECS) | Dev (EKS) | Release (EKS) |
|--------|-----------|---------------|-----------|----------------|
| AZs | 2 | 3 | 2 | 3 |
| Deployment | Rolling update | Blue/green via CodeDeploy | K8s rolling update | K8s rolling update |
| Auto-scaling | 1-2 tasks | Blue: 1-10, Green: 0-10 | HPA: 1-2 pods | HPA: 1-10 pods |
| WAF rate limit | lower | higher | lower | higher |
| Hostname | `dev.api.<domain>` | `api.<domain>` | `k8s.dev.api.<domain>` | `k8s.api.<domain>` |
| Compute | Fargate (serverless) | Fargate (serverless) | Managed EC2 nodes | Managed EC2 nodes |

### Blue/Green deployments (ECS release only)

- Managed by AWS CodeDeploy ECS deployment groups
- 10% canary traffic shift for a 5-minute bake period before full cutover
- Includes manual approval window and termination wait time for controlled rollout/rollback
- During deployment, green tasks scale up to handle traffic before blue tasks scale down
- Auto-scaling applies independently to blue and green services

See the main [readme](../readme.md) for the full deployment lifecycle description and EKS blue/green comparison.

---


## Configuration
 `config.yaml` contains settings consumed only by CDK. The Spring app never sees this file.


### Resolution priority

`config-reader.ts` resolves each value with this chain (first one found wins):

1. **CDK context** (`-c myAppConfig=...` on the CLI)
2. **Environment variables** (`CDK_DEFAULT_ACCOUNT`, `AWS_REGION`, etc.)
3. **config.yaml** (file fallback)
4. **config_common.yaml** (for `serviceName`, `imageSource`, `imageRepositoryName`, `appVersion`)

Account and region are intentionally optional in config.yaml. CDK infers them from the active AWS credentials. If you do provide them, they work as explicit overrides.

### Per-environment merging

Each environment block (e.g., `"dev"`) is shallow-merged with `"_defaults"`:

```
effective_dev = { ..._defaults, ...dev }
```

Environment-specific keys override defaults. Arrays and objects are replaced wholesale, not deep-merged.

The `imageTag` (container image version) always comes from `config_common.yaml` (`appVersion`), regardless of what's in config.yaml. This ensures the Spring app and CDK always agree on which version to build and deploy.

### computePlatform

Each environment block has a `computePlatform` field (defaults to `ecs`). Set it to `kubernetes` for EKS. The config reader uses this to determine which CDK constructs to instantiate and which CI deploy path to follow.

---

## What CDK Injects Into Containers

`app-stack.ts` passes environment variables to the container (ECS task definition or K8s Deployment):

```typescript
const containerEnvironment: Record<string, string> = {
  AWS_REGION:            this.region,
  SERVICE_NAME:          props.serviceName,
  STAGING_ENVIRONMENT:   props.stagingEnvironment,
  SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI: props.identityIssuerUri,
};
if (storage.dataBucket) {
  containerEnvironment.S3_DATA_BUCKET = storage.dataBucket.bucketName;
}
```

For ECS, these are set directly on the Fargate task definition. For EKS, these values are resolved by the `deploy-manifests` script from CloudFormation outputs and injected into the K8s Deployment YAML.

These are the env vars the Spring app reads at runtime (see [spring](../spring/spring.md) for how it resolves them).

---

## Known Issues and Workarounds

### ACM certificate stuck in pending

CDK sometimes fails to create the CNAME record needed for ACM DNS validation. If the certificate stays in "Pending validation":

1. Go to **AWS Certificate Manager** -> your certificate -> note the CNAME name/value pair
2. Manually create the CNAME record in **Route 53** -> Hosted Zones -> your domain
3. Wait for validation to complete, then re-run `cdk deploy`

If `cdk deploy` gets stuck trying to re-create an A record that already exists, manually delete the existing `dev.api.<domain>` A record in Route 53, then re-deploy.

### ALB redirects

To redirect `old.api.<domain>` to another host, add a listener rule and DNS record:

```typescript
listener.addAction('RedirectOldApi', {
  priority: 5,
  conditions: [
    elbv2.ListenerCondition.hostHeaders(['old.api.<domainName>']),
  ],
  action: elbv2.ListenerAction.redirect({
    host: 'some.other.com',
    permanent: true,
  }),
});

new route53.ARecord(this, 'OldApiRecord', {
  zone: hostedZone,
  recordName: 'old.api',
  target: route53.RecordTarget.fromAlias(
    new route53Targets.LoadBalancerTarget(loadBalancer)
  ),
});
```

### Stale `Vpc.fromLookup()` context -

`Vpc.fromLookup()` is called when deploying the **CI Runners** (they are being _installed_ into the the vpc of a dev-stack). The CDK uses a **context cache** to avoid repeatedly querying AWS during synth. The lookup result is stored in `cdk.context.json`. If the underlying infrastructure changes (for example the VPC was deleted, recreated, or you switch account/region), the cached value may become invalid.

This can cause deployment failures such as:

~~~
The vpc ID 'vpc-xxxxxxxx' does not exist
~~~

because CDK is still synthesizing the stack using the *old cached VPC ID*.

**Remedy**

Clear the cached context so CDK performs the lookup again:

~~~
cdk context --clear
~~~

or remove the cache file directly:

~~~
rm cdk.context.json
~~~

Then re-run:

~~~
cdk synth
cdk deploy
~~~

CDK will re-query AWS for the VPC and regenerate the correct configuration.


### Runner not appearing in GitHub or GitLab

If the EC2 instance starts but the runner does not appear in the GitHub or GitLab UI, the bootstrap script likely failed during registration.

Use **AWS Systems Manager → Session Manager → Connect** to access the instance and inspect the bootstrap log. All user-data output is redirected to:

~~~
sudo tail -n 200 /var/log/user-data.log
~~~

This log shows the exact step where runner installation or registration failed.

Common issues include:

- expired or invalid registration token
- missing IAM permissions to read the token from Secrets Manager
- no outbound internet access (GitHub/GitLab API unreachable)
- runner registration failing during first boot

Typical successful messages you should see:

~~~
Runner successfully added
Listening for Jobs
GitHub Actions Runner bootstrap completed
~~~

or for GitLab:

~~~
Registering runner... succeeded
GitLab Runner bootstrap completed
~~~
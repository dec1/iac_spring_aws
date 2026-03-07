
# Spring Backend on AWS (IaC)

A complete, working example of a modern web backend and its automated cloud deployment.


[![Custom](https://github.com/dec1/iac_spring_aws/actions/workflows/ci.yaml/badge.svg?branch=master&label=Backend+Tests)](https://github.com/dec1/iac_spring_aws/actions/workflows/ci.yaml)

Getting a web application from source code to running in the cloud - with security, load balancing, and cost control handled properly - involves a surprising amount of moving parts. Most tutorials cover one piece at a time (here's how to set up a load balancer, here's how to write a Dockerfile), but rarely show how everything fits together end-to-end: a single commit triggering a fully automated pipeline that builds, tests, and deploys your application onto cloud infrastructure that is itself defined and version-controlled as code.

This project is that complete picture. It pairs a Spring Boot (Kotlin) REST API with the AWS infrastructure to run it, all wired together through CI/CD pipelines tailored for both GitLab and GitHub, with a choice of ECS/Fargate (serverless containers) or EKS (managed Kubernetes) as the compute platform, leveraging shared configuration — usable side-by-side,  or independently. Both pipelines use custom runners hosted in AWS, so deployments use short-lived IAM credentials rather than long-lived secrets, and the app's resources (like S3 buckets) never need to be exposed outside the AWS account. No manual steps or console clicks required.


![Config](config.svg)


###
The application and the AWS resources are both kept deliberately modest - a REST API backed by S3 for storage, with no database or other heavyweight services - so the infrastructure patterns stay visible rather than getting buried under application complexity. The framework is laid out so that adding further resources (databases, queues, caches) follows the same approach. The goal is to provide a useful reference for how to actually do a full CI/CD pipeline in a modern cloud context, and a practical starting point for customized setups.

There is coverage of all the pillars you'd expect in any real backend (OAuth2/Cognito, CORS, OpenAPI/Swagger UI, automated tests) and the web app handles a concrete use case (storing and retrieving images and JSON in S3 via the AWS SDK), but its business logic is kept thin so it doesn't distract from the main subject of the project: the _Infrastructure as Code (IaC)_ that defines the AWS infrastructure and can automatically deploy both it and the Spring application onto it. The AWS integration is kept low-friction — credentials and region are resolved through IAM roles when deployed, environment variables when running locally, and tests use mocks and fakes so they don't need real AWS resources. Common integration pain points — such as handling proxies, working around CDK bootstrap requirements, and cross-account IAM trust — are called out explicitly with working solutions rather than left as an exercise for the reader.


CDK was chosen over cross-vendor IaC alternatives like _Terraform_ or _Pulumi_ for two reasons: it's (effectively) stateless (there's no extra state file you have to maintain or store, so deployments can be triggered from anywhere with just the code), and it's AWS-native (always has first-class support for the latest AWS features). CDK manages all infrastructure: VPC, ALB, WAF, ECS or EKS, S3, IAM, DNS, and Cognito. For EKS stacks, CDK builds the platform (cluster, LB Controller, ExternalDNS) and a separate deploy-manifests script applies standard K8s YAML with values resolved from CloudFormation outputs.


---

## Day-to-Day Workflow

The documentation below covers a lot of infrastructure - CDK stacks, runner bootstrapping, WAF rules, blue/green deployments. Most of that complexity exists so that the typical development cycle stays simple:

1. Edit Kotlin code in `spring/`
2. Run tests locally (`./gradlew check`)
3. Push to GitLab/GitHub

The CI pipeline handles everything from there: build, image push, deploy to dev, run integration tests, and (with manual approval) promote to release. Once the infrastructure is bootstrapped, you rarely need to touch it again.

The rest of this document covers the one-time setup that makes that workflow possible, and the architecture behind it.

---


## Documentation Layout


| Document | Covers |
|----------|--------|
| *this file* | Project and documemtation overview, shared config, authentication, deployment architecture|
| [setup](setup.md) | General setup details and prerequisites |
| [spring](spring/spring.md) | Spring Boot app setup, profiles, API endpoints, test tiers, Jib image builds |
| [grafana](cdk/app/lib/constructs/platform/ecs/grafana/grafana.md) | Observability: Grafana Cloud metrics sidecar setup, dashboards, costs |
| [testing](spring/src/testing.md) | Test architecture design rationale, environment isolation strategy, FakeAws concept |
| [manualTest](spring/src/manualTest/manualTest.md) | End-to-end manual test setup and execution |
| [cdk](cdk/cdk.md)  | CDK stacks, config.yaml, AWS infrastructure (VPC, WAF, ECS/EKS, S3, IAM), first-time deploy commands |
| [eks](cdk/app/lib/constructs/platform/eks/eks.md) | EKS getting started, kubectl setup, manifest deployment, architecture comparison |
| [manifests & kubectl](cdk/app/lib/constructs/platform/eks/manifest/readme.md) | K8s manifest templates, and cluster access via kubectl |
| [idp](cdk/app/idp/idp.md)  | Cognito identity provider setup, client scopes, credential retrieval scripts |
| [ci](cdk/app/ci/ci.md) | CI/CD pipeline stages, runner infrastructure, secrets, GitLab vs GitHub differences |
| [issues](issues.md) | Known issues and workarounds |


---

## Authentication

The API is secured using the **_Client Credentials (machine-to-machine)_ OAuth2  Flow** . A dedicated Cognito User Pool acts as the identity provider.
Clients authenticate by exchanging a client ID and secret for a JWT access token, which is then sent as a Bearer token on every API request.
Spring Security validates the token's signature and extracts role-based scopes (`Role_Read`, `Role_Write`) for endpoint-level authorization.

Two pre-configured clients exist: an internal client with read/write access and an external client with read-only access.
See [idp](cdk/app/idp/idp.md) for Cognito setup, client details, and credential retrieval.



---

## Deployment Architecture

The AWS infrastructure is duplicated across independent _environments_: _**dev**_ and _**release**_. Each is a full, isolated copy of all cloud resources needed to run the app (dedicated VPC with ALB, WAF, ECS/EKS, etc.). In CDK/CloudFormation terms, Each environment is a set of (CDK/CloudFormation)  *stacks* -- a named, versioned bundle of AWS resources that can be deployed, updated, or torn down as a unit.

Each environment can use either ECS/Fargate or EKS (Kubernetes) as its compute platform, configured per-environment in `config.yaml`. Its possible to create both both a ECS and an EKS version of a single environment (e.g. `dev` and  `k8s-dev`). If you do, each will have a dedicated VPC. However, its recommended to use either ECS or EKS, and not both simultaneously.   Both platforms use the same container image from ECR, the same Cognito auth, and the same WAF/ALB/DNS pattern.

Dev is intentionally cheaper/smaller and serves as dedicated _experimental_ ground before changes (not just of the app but the infrastructure itself) are promoted to release.

The two environments also use different _deployment strategies_:

**ECS:** Dev uses simple rolling updates -- fast and good enough for a testing environment. Release uses a blue/green canary orchestrated by AWS CodeDeploy: a complete second copy of the app is provisioned, 10% of live traffic shifts to it for a 5-minute bake, and the remaining 90% follows only if no alarms fire. If anything looks wrong during the bake, traffic reverts to the original instantly.

**EKS:** Both dev and release use Kubernetes rolling updates (controlled by the Deployment spec's `maxSurge`/`maxUnavailable`). For a blue/green equivalent on EKS, see the "EKS Blue/Green" section below.

A few resources are shared between all environments rather than duplicated: the ECR image registry, the Cognito identity provider, and the CI runner (which lives in the dev VPC).

The diagram below shows how all components relate. The web of deploy, run, test, and use relationships is surprisingly tangled for what is conceptually a straightforward setup -- but the picture helps make sense of it. (_Note_: The diagram simplifies some details for clarity: for example, there are actually 2 VPCs - one for each for the dev and release stacks, and the runner is located inside the dev VPC)


![Deployment Architecture](deployment_architecture.svg)

**Heavy lines show the most common flow:** shared resources (ECR, Cognito) and the CI runner are deployed once from your local machine. After that, the runner handles all subsequent deploys. Your app runs inside whichever environment it was deployed to.

*Other flows in the diagram:*
- *local -> App (outside AWS):* running and testing locally during development
- *local -> App (inside AWS):* testing against the deployed app (system tests, curl)
- *App -> S3, Cognito (dashed):* runtime dependencies -- the app reads/writes S3 and validates JWTs




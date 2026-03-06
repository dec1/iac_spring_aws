# EKS Getting Started Guide

With your EKS cluster (`<serviceName>-dev`) successfully running in `AWS_REGION`, 
this guide covers local `kubectl` setup, deploying your app, and useful AWS console views.


## 1. Prerequisites

Install these locally if you don't have them already:

- **AWS CLI v2**: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
- **kubectl**: https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/ (or via `choco install kubernetes-cli` on Windows)
- **Verify versions**:

  - `aws --version`
    - `aws-cli/2.33.25 Python/3.13.11 Windows/11 exe/AMD64`

- `kubectl version`

        Client Version: v1.35.0
        Kustomize Version: v5.7.1
        Server Version: v1.35.0-eks-3a10415
        


## 2. Configure kubectl

This tells kubectl how to talk to your EKS control plane. Run the command from the CDK output:


`aws eks update-kubeconfig --name my-backend-dev --region eu-west-2 --profile myb`


This writes a context entry to `~/.kube/config`. 

Verify it works:
- `kubectl get nodes`

        NAME                                      STATUS   ROLES    AGE   VERSION
        ip-10-0-2-42.eu-west-2.compute.internal   Ready    <none>   70m   v1.35.0-eks-efcacff


You should see your t3.medium worker node(s) with status `Ready`. If you get an auth error, make sure the `--profile` matches the AWS profile you used for `cdk deploy`.


## 3. Verify the cluster is healthy


- Check nodes are Ready
    `kubectl get nodes -o wide`

        NAME                                      STATUS   ROLES    AGE   VERSION               INTERNAL-IP   EXTERNAL-IP   OS-IMAGE                        KERNEL-VERSION                   CONTAINER-RUNTIME
        ip-10-0-2-42.eu-west-2.compute.internal   Ready    <none>   74m   v1.35.0-eks-efcacff   10.0.2.42     <none>        Amazon Linux 2023.10.20260216   6.12.68-92.122.amzn2023.x86_64   containerd://2.1.5

- Check system pods are running (kube-system namespace)
    `kubectl get pods -n kube-system`

        NAME                                            READY   STATUS    RESTARTS   AGE
        aws-load-balancer-controller-78b998857b-lhcr9   1/1     Running   0          70m
        aws-load-balancer-controller-78b998857b-mqpk6   1/1     Running   0          70m
        aws-node-spstw                                  2/2     Running   0          72m
        coredns-7b48f44ccb-2t4nc                        1/1     Running   0          76m
        coredns-7b48f44ccb-llsft                        1/1     Running   0          76m
        external-dns-5bfbcf7b69-jv8z9                   1/1     Running   0          5m
        kube-proxy-mh7rx                                1/1     Running   0          72m

- Confirm the AWS Load Balancer Controller is running
    `kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller`

        NAME                                            READY   STATUS    RESTARTS   AGE
        aws-load-balancer-controller-78b998857b-lhcr9   1/1     Running   0          70m
        aws-load-balancer-controller-78b998857b-mqpk6   1/1     Running   0          70m

- Confirm ExternalDNS is running
    `kubectl get pods -n kube-system -l app.kubernetes.io/name=external-dns`

        NAME                            READY   STATUS    RESTARTS   AGE
        external-dns-5bfbcf7b69-jv8z9   1/1     Running   0          5m


The LB Controller pods should show `Running` with `1/1` ready. If they're not there or are in `CrashLoopBackOff`, check the logs:

`kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller`



## 4. Deploy your application

#### 4a. Verify your image exists in ECR

The EKS worker nodes pull images from ECR automatically using their IAM instance role (no Docker login needed -- that's only for local development). Just confirm the image is there:

```
aws ecr describe-images --repository-name my-backend-img --image-ids imageTag=19.7.3 --region eu-west-2 --profile myb
```


#### 4b. Fill in the Manifest placeholders

The K8s manifest files contain placeholder values that you need to replace with real values from your CDK deployment. All placeholders are clearly marked with `PLACEHOLDER:` comments in the YAML files. Scripts are provided for automatic replacement - see See [manifests](manifest/readme.md)




If this returns image details, you're good. If it returns an error, push the image to ECR first before applying the K8s manifests. If your pods show `ImagePullBackOff` after applying, check `kubectl describe pod <pod-name>` for the exact error.


#### 4c. Apply the manifests

```bash
kubectl apply -f <path_to_manifests>/manifest/
```

This creates the Deployment, Service, Ingress, and HPA in one shot. Check progress:

- Watch pods starting up
    `kubectl get pods -w`

        NAME                         READY   STATUS    RESTARTS   AGE
        my-backend-8648bbdcd-clzst   1/1     Running   0          104s

- Check deployment rollout status
    `kubectl rollout status deployment/my-backend`
            
        deployment "my-backend" successfully rolled out

- Check the Ingress (ALB creation takes 2-3 minutes)
    `kubectl get ingress my-backend-ingress` 

        NAME                 CLASS   HOSTS                        ADDRESS                                                                  PORTS   AGE
        my-backend-ingress   alb     k8s.dev.api2.my-domain.com   k8s-default-mybacken-99f94d64b5-1040977293.eu-west-2.elb.amazonaws.com   80      44m


Wait until the `ADDRESS` column shows an ALB hostname.


#### 4d. DNS (automatic via ExternalDNS)

ExternalDNS is installed by CDK and runs as a pod in your cluster. It watches Ingress resources for the `external-dns.alpha.kubernetes.io/hostname` annotation and automatically creates/updates/deletes Route53 A records.

No manual DNS step needed. After the ALB gets its address (~2-3 min), ExternalDNS creates the Route53 record within ~1 minute.

Check ExternalDNS logs to confirm:
```
kubectl logs -n kube-system -l app.kubernetes.io/name=external-dns --tail=10
```

You should see lines like:  
```
Desired change: CREATE k8s.dev.api2.my-domain.com A
4 record(s) were successfully updated
```

When you `kubectl delete` the Ingress, ExternalDNS removes the Route53 record automatically.

After DNS propagates (usually < 1 minute), test:
```
curl https://k8s.dev.api2.my-domain.com/actuator/health
```

If DNS doesn't resolve immediately, flush your local cache: `ipconfig /flushdns` (Windows) or `sudo dscacheutil -flushcache` (Mac).


## 5. Useful kubectl commands

```bash
# --- Day-to-day ---
kubectl get pods                          # List running pods
kubectl get pods -o wide                  # Show which node each pod is on
kubectl logs <pod-name>                   # View logs
kubectl logs <pod-name> --tail=100 -f     # Tail logs live
kubectl describe pod <pod-name>           # Detailed pod info (events, status, volumes)

# --- Debugging ---
kubectl get events --sort-by=.lastTimestamp   # Recent cluster events
kubectl describe ingress my-backend-ingress   # Check ALB/Ingress status
kubectl top pods                              # CPU/memory usage (needs metrics-server)
kubectl exec -it <pod-name> -- /bin/sh        # Shell into a running pod

# --- Debugging add-ons ---
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller  # LB Controller logs
kubectl logs -n kube-system -l app.kubernetes.io/name=external-dns                  # ExternalDNS logs

# --- Deployments ---
kubectl rollout status deployment/my-backend          # Watch a rollout
kubectl rollout history deployment/my-backend         # See revision history
kubectl rollout undo deployment/my-backend            # Rollback to previous version
kubectl set image deployment/my-backend app=<new-image>  # Deploy new image

# --- Scaling ---
kubectl get hpa                            # Check autoscaler status
kubectl scale deployment/my-backend --replicas=3   # Manual scale (HPA will override)

# --- Cleanup ---
kubectl delete -f k8s/                     # Remove all K8s resources (ALB + DNS record get deleted too)
```


## 6. AWS Console resources

### EKS Console
**Console -> EKS -> Clusters -> `<serviceName>-dev`**

- **Overview tab**: Cluster status, K8s version, API server endpoint, OIDC provider
- **Compute tab**: Your managed node group, instance types, scaling config, node health
- **Resources tab**: Browse K8s objects (Deployments, Pods, Services, Ingresses) directly in the console without kubectl. Useful for quick checks
- **Add-ons tab**: Shows installed add-ons (VPC CNI, CoreDNS, kube-proxy)

### EC2 Console
**Console -> EC2 -> Instances**

Filter by tag `eks:cluster-name = <serviceName>-dev` to see your worker nodes. You can check CPU/memory utilization, network traffic, and instance status here.

### CloudWatch
**Console -> CloudWatch -> Container Insights** (if enabled)

Shows cluster-level and pod-level metrics: CPU, memory, network, disk. Useful for understanding resource usage patterns before tuning your HPA thresholds.

**Console -> CloudWatch -> Log Groups**

EKS control plane logs (if enabled) appear under `/aws/eks/<serviceName>-dev/cluster`. Application logs go to stdout/stderr and can be collected by installing a log agent (e.g., Fluent Bit DaemonSet) -- not set up by default.

### WAF Console
**Console -> WAF & Shield -> Web ACLs** (region: eu-west-2)

Once the Ingress creates the ALB and the WAF is associated, you'll see request metrics, blocked requests, and rule match details here. Same WAF setup as your ECS environment.

### Route 53
**Console -> Route 53 -> Hosted Zones -> my-domain.com**

ExternalDNS manages the alias record pointing your hostname to the Ingress-created ALB. You can verify it exists here, but you shouldn't need to create or edit it manually.


## 7. Tearing down

To remove everything:

```bash
# 1. Delete K8s resources first (this deletes the Ingress-created ALB + DNS record)
kubectl delete -f <path_to_manifests>/manifest/

# 2. Wait for the ALB to be fully deleted (check EC2 -> Load Balancers)

# 3. Destroy the CDK stack
cdk destroy <serviceName>-k8s-dev --profile myb
```

Order matters: if you destroy the CDK stack first, the ALB created by the Ingress controller becomes orphaned (CDK doesn't know about it) and you'd have to delete it manually in the EC2 console. The Route53 record would also be orphaned.


## 8. Costs summary (dev environment)

| Resource | Approximate monthly cost |
|----------|------------------------|
| EKS control plane | $73 |
| t3.medium node (1 instance) | $30 |
| NAT Gateway | $32 |
| ALB (created by Ingress) | $16 + usage |
| **Total (idle)** | **~$151/month** |

For comparison, your ECS Fargate dev setup costs roughly $50-80/month. The EKS premium is mostly the control plane fee.

To minimize costs when not actively using the cluster, destroy the stack entirely (`cdk destroy`) and redeploy when needed (~16 minutes).


## 9. Architecture comparison

### This setup (CDK infra + kubectl workloads)

CDK and kubectl each own a clearly separated set of resources. CDK builds the platform; kubectl deploys the app onto it.

```
cdk deploy                                  kubectl apply -f k8s/
(runs once to build infrastructure)         (runs per app deployment)
    |                                            |
    v                                            v
  VPC, subnets, NAT Gateway                    Deployment (pods running your Spring Boot app)
  EKS cluster (control plane)                  Service (internal routing to pods)
  Managed node group (EC2 workers)             Ingress (triggers ALB + DNS record creation)
  AWS LB Controller                            HPA (auto-scaling rules)
  ExternalDNS
  WAF WebACL
  ACM certificate
  IAM roles, OIDC provider
```

**How CDK installs the LB Controller and ExternalDNS:** CDK doesn't just create AWS resources
-- when it creates an EKS cluster, it also provisions a hidden Lambda function with kubectl/helm
baked in (that's what the `KubectlV35Layer` is for). When your CDK code says
`cluster.addHelmChart(...)`, CloudFormation invokes that Lambda to run `helm install` inside
the cluster during `cdk deploy`. You never see this happen -- it's all behind the scenes.
After deployment, CDK's Lambda goes dormant and the controllers run as regular pods
inside your cluster.

**Why the LB Controller creates the ALB (rather than CDK creating it directly):** The ALB's
target group needs to know which pod IPs are healthy, and that changes constantly -- pods
scale up, roll out, crash, restart. Only something running continuously inside the cluster
can keep the target group in sync with live pod state. CDK runs once at deploy time and
stops, so it can't do this.

In theory, CDK could create the ALB and hand a reference to a controller that only manages
target group registrations. That would work fine, but nobody built that tool -- the K8s
ecosystem's standard pattern is for the LB Controller to create and fully manage the ALB
end-to-end. It's the off-the-shelf solution.

**Why ExternalDNS creates the Route53 record (rather than CDK):** Same reason -- the ALB
doesn't exist at CDK deploy time, so CDK can't create a DNS record pointing to it.
ExternalDNS watches the Ingress, waits for the ALB address to appear, then creates the
Route53 alias record. When the Ingress is deleted, ExternalDNS deletes the record.

```
Internet
  |
  v
Route53 (k8s.dev.api2.my-domain.com -> ALB)   [managed by ExternalDNS]
  |
  v
ALB (created and managed by LB Controller)
  |  - HTTPS/443 with ACM cert
  |  - WAF attached
  |  - Target group kept in sync with live pod IPs
  v
Worker nodes (EC2 in private subnets)
  |
  v
Pods (your Spring Boot containers)
  |
  v
S3, Cognito, etc. (via IAM roles)
```


### ECS setup (current, everything in CDK)

CDK creates and owns every resource, including the ALB and container services. There is no separate deployment step -- `cdk deploy` does it all.

```
cdk deploy
(runs for both infra changes AND app deployments)
    |
    v
  VPC, subnets, NAT Gateway
  ECS cluster (just a logical grouping, no running processes)
  ALB + HTTPS listener + target groups
  WAF associated to ALB
  ACM certificate
  Route53 DNS record
  Fargate task definitions + services (blue/green)
  Auto-scaling rules
  CodeDeploy (for blue/green in release)
  IAM roles
```

```
Internet
  |
  v
ALB (created directly by CDK)
  |  - HTTPS/443 with ACM cert
  |  - WAF attached
  v
Fargate tasks (serverless, no EC2 to manage)
  |
  v
Pods (your Spring Boot containers)
  |
  v
S3, Cognito, etc. (via IAM task role)
```

Key difference: In ECS there are no worker nodes -- AWS runs your containers on shared infrastructure (Fargate). You never see or manage EC2 instances.


### Old K8s approach (CDK manages everything, the workload.ts approach)

CDK creates the cluster AND applies K8s manifests (Deployment, Service, Ingress) via a Lambda function that calls kubectl behind the scenes. One `cdk deploy` does everything.

```
cdk deploy
(runs for both infra changes AND app deployments)
    |
    v
  VPC, subnets, NAT Gateway
  EKS cluster + node group
  LB Controller
  WAF, ACM cert
  IAM roles
  AND via the same hidden Lambda (see above):
    K8s Deployment (pods)
    K8s Service (internal routing)
    K8s Ingress (triggers ALB creation)
```

This uses the same CDK Lambda mechanism described above -- `cdk deploy` invokes a Lambda
with kubectl to apply K8s manifests. The end result is identical to "this setup" (same pods,
same ALB, same traffic flow). The difference is purely operational: CDK's Lambda applies the
manifests vs you running kubectl yourself.

You could still use kubectl with this approach (the cluster exists and accepts commands),
but you'd have two sources of truth -- CDK's Lambda and your kubectl -- fighting over the
same K8s resources. That's one reason it's messy.

Problems with this approach:
- Every app change (new image tag, env var tweak) requires a full `cdk deploy` (~16 min)
- K8s manifests are embedded in TypeScript, not standard YAML (harder to debug, can't use `kubectl apply` directly)
- The hidden Lambda adds complexity and failure modes (the `ROLLBACK_FAILED` error you hit was partly due to this machinery)
- Can't use Helm charts, ArgoCD, or other standard K8s tooling for app deployment


### Summary

| | ECS | This EKS setup | Old EKS (workload.ts) |
|---|---|---|---|
| Infra deployment | `cdk deploy` | `cdk deploy` | `cdk deploy` |
| App deployment | `cdk deploy` | `kubectl apply` | `cdk deploy` |
| ALB created by | CDK directly | LB Controller (triggered by Ingress) | LB Controller (triggered by CDK's hidden Lambda) |
| DNS created by | CDK directly | ExternalDNS (triggered by Ingress) | Manual |
| Worker nodes | None (Fargate) | Managed EC2 node group | Managed EC2 node group |
| App manifests | TypeScript (CDK) | Standard K8s YAML | TypeScript (CDK) |
| Deploy time for app changes | ~5 min | ~30 seconds | ~16 min |
| K8s ecosystem tools | N/A | Helm, ArgoCD, etc. | Limited |
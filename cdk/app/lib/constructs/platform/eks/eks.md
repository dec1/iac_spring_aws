# EKS Getting Started Guide

This guide covers what you need to know after your Kubernetes cluster is setup and running
eg local `kubectl` setup, deploying your app, and useful AWS console views. 
Further details and useful scripts are described in [manifests](manifests.md).

By default, your Kubernetes 
**`<clusterName>`** is **`<serviceName>-k8s-dev|release`**


## 1. Prerequisites

Install these locally if you don't have them already:

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
    - make sure your local aws credentials are valid (refreshed), eg via `aws sso login --profile <profile>`
     
  - `aws --version`
    - `aws-cli/2.33.25 Python/3.13.11 Windows/11 exe/AMD64`


#####    
- [kubectl](https://kubernetes.io/docs/tasks/tools/) 

    - `kubectl version`

        ~~~
        Client Version: v1.35.0
        Kustomize Version: v5.7.1
        Server Version: v1.35.0-eks-3a10415
        ~~~
        


## 2. Configure kubectl

This tells kubectl how to talk to your EKS control plane. Run the command from the CDK output:


`aws eks update-kubeconfig --name <clusterName> --region <region> --profile <profile>`


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


See [deploy manifests](manifests.md)




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

- ####  Cleanup
    If you no longer need your cluster, make sure undo the manifest deployment ([cleanup](manifests.md)) before destroying the cdk stack.

    Order matters: if you destroy the CDK stack first, the ALB created by the Ingress controller becomes orphaned (CDK doesn't know about it) and you'd have to delete it (and many other resources) manually in the EC2 console. 


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

#### EKS Console
*Console -> EKS -> Clusters -> `<clusterName>`*

- *Overview* -  Cluster status, K8s version, API server endpoint, OIDC provider
- *Compute* -  Your managed node group, instance types, scaling config, node health
- *Resources* -  Browse K8s objects (Deployments, Pods, Services, Ingresses) directly in the console without kubectl. Useful for quick checks
- *Add-ons* -  Shows installed add-ons (VPC CNI, CoreDNS, kube-proxy)

#### EC2 Console
*Console -> EC2 -> Instances*

Filter by tag `eks:cluster-name = <clusterName>` to see your worker nodes. You can check CPU/memory utilization, network traffic, and instance status here.

#### CloudWatch
*Console -> CloudWatch -> Container Insights* (if enabled)

Shows cluster-level and pod-level metrics: CPU, memory, network, disk. Useful for understanding resource usage patterns before tuning your HPA thresholds.

*Console -> CloudWatch -> Log Groups*

EKS control plane logs (if enabled) appear under `/aws/eks/<clusterName>/cluster`. Application logs go to stdout/stderr and can be collected by installing a log agent (e.g., Fluent Bit DaemonSet) -- not set up by default.

#### WAF Console
*Console -> WAF & Shield -> Web ACLs* 

Once the Ingress creates the ALB and the WAF is associated, you'll see request metrics, blocked requests, and rule match details here. Same WAF setup as your ECS environment.

#### Route 53
*Console -> Route 53 -> Hosted Zones -> your-domain.com*

ExternalDNS manages the alias record pointing your hostname to the Ingress-created ALB. You can verify it exists here, but you shouldn't need to create or edit it manually.





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



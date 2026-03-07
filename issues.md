
## Known Issues and Workarounds

- #### Can't access Kubernetes Cluster
    The kubernetes cluster was created successfully but you cant access it eg via `kubectl` - see [EKS Guide](app/lib/constructs/platform/eks/eks.md)

- #### ACM certificate stuck in pending

    CDK sometimes fails to create the CNAME record needed for ACM DNS validation. If the certificate stays in "Pending validation":

    1. Go to **AWS Certificate Manager** -> your certificate -> note the CNAME name/value pair
    2. Manually create the CNAME record in **Route 53** -> Hosted Zones -> your domain
    3. Wait for validation to complete, then re-run `cdk deploy`

    If `cdk deploy` gets stuck trying to re-create an A record that already exists, manually delete the existing `dev.api.<domain>` A record in Route 53, then re-deploy.


- #### Cant find Vpc when creating Ci Runner

    `Vpc.fromLookup()` is called when deploying the **CI Runners** (they are being _installed_ into the the vpc of a dev-stack). The CDK uses a **context cache** to avoid repeatedly querying AWS during synth. The lookup result is stored in `cdk.context.json`. If the underlying infrastructure changes (for example the VPC was deleted, recreated, or you switch account/region), the cached value may become invalid.

    This can cause deployment failures such as:

    ~~~
    The vpc ID 'vpc-xxxxxxxx' does not exist
    ~~~

    because CDK is still synthesizing the stack using the *old cached VPC ID*.

    *Remedy* - clear the cached context so CDK performs the lookup again:

    `cdk context --clear`


    or remove the cache file directly:

    `rm cdk.context.json`


    Then re-run:

    ~~~
    cdk synth
    cdk deploy
    ~~~

    CDK will re-query AWS for the VPC and regenerate the correct configuration.


- #### Ci Runner not appearing in GitHub or GitLab

    If the EC2 instance starts but the runner does not appear in the GitHub or GitLab UI, the bootstrap script likely failed during registration.

    Use *AWS Systems Manager → Session Manager → Connect* to access the instance and inspect the bootstrap log. All user-data output is redirected to:

    `sudo tail --lines 200 --follow /var/log/user-data.log`


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


- #### Proxy Support
    - [spring](spring/local/proxy/readme.md) 
    - [setup](setup.md)

- #### ALB redirects

    To redirect `old.api.<domain>` to another host, add a listener rule and DNS record:

    ~~~typescript
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
    ~~~
# deploy-manifests.ps1
#
# Resolves __PLACEHOLDER__ tokens in K8s manifest templates using CDK/CloudFormation outputs,
# writes the result to a generated/ directory, and optionally runs kubectl apply.
#
# Usage:
#   .\deploy-manifests.ps1 -StackName my-backend-k8s-dev -Apply -Profile myb
#   .\deploy-manifests.ps1 -StackName my-backend-k8s-dev                        # resolve only
#   .\deploy-manifests.ps1 -StackName my-backend-k8s-dev -IdentityStackName my-other-identity -Apply
#   .\deploy-manifests.ps1 -StackName my-backend-k8s-dev -KubectlRoleArn arn:aws:iam::123:role/my-role -Apply

param(
    [Parameter(Mandatory)]
    [string]$StackName,

    [string]$IdentityStackName,

    [string]$Profile,

    [switch]$Apply,

    # Optional: force kubectl to assume a specific role when generating kubeconfig.
    [string]$KubectlRoleArn,

    # Path to the repo root (where config_common.yaml lives).
    # Defaults to 3 levels up from this script (assuming script is at <repo>/cdk/app/lib/constructs/platform/eks/manifest/scripts/)
    [string]$RepoRoot
)

$ErrorActionPreference = "Stop"

# -------------------------------------------------------
# Webhook readiness gate settings (used only when -Apply)
#
# Purpose:
#   The AWS Load Balancer Controller installs admission webhooks for Service/Ingress.
#   Right after an infra deploy/rollout, the webhook Service can exist but have no ready
#   endpoints yet. If we apply during that window, the API server rejects the resources with:
#     "no endpoints available for service aws-load-balancer-webhook-service"
#
#   Putting the wait here ensures kubeconfig is already set (works in clean CI containers).
# -------------------------------------------------------
$AlbWebhookNamespace   = $env:ALB_WEBHOOK_NAMESPACE;      if (-not $AlbWebhookNamespace)   { $AlbWebhookNamespace = "kube-system" }
$AlbWebhookServiceName = $env:ALB_WEBHOOK_SERVICE_NAME;   if (-not $AlbWebhookServiceName) { $AlbWebhookServiceName = "aws-load-balancer-webhook-service" }
$AlbControllerLabel    = $env:ALB_CONTROLLER_LABEL;       if (-not $AlbControllerLabel)    { $AlbControllerLabel = "app.kubernetes.io/name=aws-load-balancer-controller" }
$AlbWebhookMaxAttempts = $env:ALB_WEBHOOK_MAX_ATTEMPTS;   if (-not $AlbWebhookMaxAttempts) { $AlbWebhookMaxAttempts = "60" }
$AlbWebhookSleepSecs   = $env:ALB_WEBHOOK_SLEEP_SECONDS;  if (-not $AlbWebhookSleepSecs)   { $AlbWebhookSleepSecs = "5" }

# -------------------------------------------------------
# Resolve paths
# -------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TemplateDir = Join-Path (Join-Path (Join-Path $ScriptDir "..") "..") (Join-Path "manifest" "template")
$GeneratedDir = Join-Path (Join-Path (Join-Path $ScriptDir "..") "..") (Join-Path "manifest" "generated")

if (-not $RepoRoot) {
    # Default: assume script is at <repo>/cdk/app/lib/constructs/platform/eks/manifest/scripts/
    $RepoRoot = Resolve-Path (Join-Path $ScriptDir ([IO.Path]::Combine("..", "..", "..", "..", "..", "..", "..", "..")))
}

$ConfigCommonPath = Join-Path $RepoRoot "config_common.yaml"

# -------------------------------------------------------
# Helper: run aws cli with optional --profile
# -------------------------------------------------------
function Invoke-Aws {
    param([string[]]$AwsArgs)
    if ($Profile) {
        $AwsArgs += "--profile", $Profile
    }
    # PowerShell 5.1 treats any native stderr output as a terminating error
    # when $ErrorActionPreference is Stop. Temporarily relax it.
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $result = & aws @AwsArgs 2>$null
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevPref
    if ($exitCode -ne 0) {
        Write-Error "AWS CLI failed (exit code $exitCode) running: aws $($AwsArgs -join ' ')"
    }
    return $result
}

# -------------------------------------------------------
# Helper: get a specific CloudFormation output value
# -------------------------------------------------------
function Get-StackOutput {
    param([string]$Stack, [string]$OutputKey)
    $json = Invoke-Aws "cloudformation", "describe-stacks", "--stack-name", $Stack, "--output", "json"
    $stacks = ($json -join "`n") | ConvertFrom-Json
    $outputs = $stacks.Stacks[0].Outputs
    $match = $outputs | Where-Object { $_.OutputKey -eq $OutputKey }
    if (-not $match) {
        Write-Error "Output '$OutputKey' not found in stack '$Stack'. Available outputs: $(($outputs | ForEach-Object { $_.OutputKey }) -join ', ')"
    }
    return $match.OutputValue
}

# -------------------------------------------------------
# Helper: get CloudFormation stack ARN (used to derive region/account reliably)
# -------------------------------------------------------
function Get-StackArn {
    param([string]$Stack)
    $json = Invoke-Aws "cloudformation", "describe-stacks", "--stack-name", $Stack, "--output", "json"
    $stacks = ($json -join "`n") | ConvertFrom-Json
    return $stacks.Stacks[0].StackId
}

# -------------------------------------------------------
# Helper: try get output (best-effort; returns $null if missing)
# -------------------------------------------------------
function Try-GetStackOutput {
    param([string]$Stack, [string]$OutputKey)
    try {
        return Get-StackOutput -Stack $Stack -OutputKey $OutputKey
    } catch {
        return $null
    }
}

# -------------------------------------------------------
# Helper: wait for AWS LB Controller webhook endpoints (requires kubeconfig already set)
# -------------------------------------------------------
function Wait-AlbWebhookEndpoints {
    param(
        [string]$Namespace,
        [string]$ServiceName,
        [int]$MaxAttempts,
        [int]$SleepSeconds,
        [string]$ControllerLabel
    )

    Write-Host "Waiting for ${ServiceName} endpoints in ${Namespace} (max ${MaxAttempts} attempts, ${SleepSeconds}s sleep)..." -ForegroundColor Cyan

    # If the Service itself doesn't exist, fail fast with useful context.
    & kubectl -n $Namespace get svc $ServiceName *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Service ${Namespace}/${ServiceName} not found. Is aws-load-balancer-controller installed?"
    }

    for ($i = 1; $i -le $MaxAttempts; $i++) {
        $ep = & kubectl -n $Namespace get endpoints $ServiceName -o "jsonpath={.subsets[*].addresses[*].ip}" 2>$null
        if ($ep -and $ep.Trim().Length -gt 0) {
            Write-Host "Webhook endpoints ready: $ep" -ForegroundColor Green
            return
        }
        Start-Sleep -Seconds $SleepSeconds
    }

    Write-Host "ERROR: webhook endpoints still empty after waiting" -ForegroundColor Red
    & kubectl -n $Namespace get pods,svc,endpoints | Write-Host
    & kubectl -n $Namespace get pods -l $ControllerLabel -o wide | Write-Host
    throw "ALB webhook endpoints not ready"
}

# -------------------------------------------------------
# 1. Read config_common.yaml
# -------------------------------------------------------
Write-Host "Reading $ConfigCommonPath ..." -ForegroundColor Cyan

if (-not (Test-Path $ConfigCommonPath)) {
    Write-Error "config_common.yaml not found at: $ConfigCommonPath. Use -RepoRoot to specify the repo root."
}

# Simple YAML parser -- config_common.yaml is flat key: value pairs
$commonConfig = @{}
Get-Content $ConfigCommonPath | ForEach-Object {
    if ($_ -match '^\s*([^#]\S+)\s*:\s*"?([^"#]+)"?\s*$') {
        $commonConfig[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

$serviceName = $commonConfig["serviceName"]
$imageRepoName = $commonConfig["imageRepositoryName"]
$appVersion = $commonConfig["appVersion"]

if (-not $serviceName -or -not $imageRepoName -or -not $appVersion) {
    Write-Error "config_common.yaml must contain serviceName, imageRepositoryName, and appVersion"
}

# Default identity stack name: <serviceName>-identity
if (-not $IdentityStackName) {
    $IdentityStackName = "${serviceName}-identity"
}

Write-Host "  serviceName:         $serviceName" -ForegroundColor Gray
Write-Host "  imageRepositoryName: $imageRepoName" -ForegroundColor Gray
Write-Host "  appVersion:          $appVersion" -ForegroundColor Gray
Write-Host "  identityStackName:   $IdentityStackName" -ForegroundColor Gray

# -------------------------------------------------------
# 1b. Read config.yaml (CDK config -- for appPortNum, healthCheckPath)
# -------------------------------------------------------
$CdkConfigPath = Join-Path (Join-Path $RepoRoot "cdk") (Join-Path "app" (Join-Path "config" "config.yaml"))
Write-Host "Reading $CdkConfigPath ..." -ForegroundColor Cyan

if (-not (Test-Path $CdkConfigPath)) {
    Write-Error "config.yaml not found at: $CdkConfigPath"
}

$cdkConfig = @{}
$currentSection = ""
Get-Content $CdkConfigPath | ForEach-Object {
    # Track section headers (e.g. _defaults:, dev:, k8s-dev:)
    if ($_ -match '^(\S+)\s*:\s*$') {
        $currentSection = $Matches[1]
    }
    # Parse key: value pairs (top-level and within sections)
    elseif ($_ -match '^\s+(\S+)\s*:\s*"?([^"#]+)"?\s*$') {
        $key = $Matches[1].Trim()
        $val = $Matches[2].Trim()
        $cdkConfig["${currentSection}.${key}"] = $val
    }
    elseif ($_ -match '^(\S+)\s*:\s*"?([^"#\s]+)"?\s*$') {
        $key = $Matches[1].Trim()
        $val = $Matches[2].Trim()
        if ($val -ne "null") {
            $cdkConfig[$key] = $val
        }
    }
}

$appPort = $cdkConfig["appPortNum"]
# healthCheckPath: check _defaults section
$healthCheckPath = $cdkConfig["_defaults.healthCheckPath"]

if (-not $appPort) {
    Write-Error "config.yaml must contain appPortNum"
}
if (-not $healthCheckPath) {
    $healthCheckPath = "/actuator/health"
    Write-Host "  healthCheckPath:     $healthCheckPath (default -- not found in config.yaml)" -ForegroundColor Yellow
} else {
    Write-Host "  healthCheckPath:     $healthCheckPath" -ForegroundColor Gray
}
Write-Host "  appPortNum:          $appPort" -ForegroundColor Gray

# -------------------------------------------------------
# 2. Query app stack outputs
# -------------------------------------------------------
Write-Host "Querying stack '$StackName' ..." -ForegroundColor Cyan

$certArn         = Get-StackOutput -Stack $StackName -OutputKey "EksCertificateArn"
$webAclArn       = Get-StackOutput -Stack $StackName -OutputKey "EksWebAclArn"
$hostname        = Get-StackOutput -Stack $StackName -OutputKey "EksHostname"
$s3Bucket        = Get-StackOutput -Stack $StackName -OutputKey "S3BucketName"
$eksClusterName  = Get-StackOutput -Stack $StackName -OutputKey "EksClusterName"

# Optional: new output (for CI kubectl assume-role). Best-effort if stack not yet redeployed.
if (-not $KubectlRoleArn) {
    $candidate = Try-GetStackOutput -Stack $StackName -OutputKey "EksDeployRoleArn"
    if ($candidate) {
        $KubectlRoleArn = $candidate
    }
}

# NOTE:
# We must NOT derive region/account from the ACM cert ARN.
# In "no custom domain" mode the cert output is intentionally a placeholder string.
$stackArn  = Get-StackArn -Stack $StackName
$arnParts  = $stackArn -split ":"
$awsRegion = $arnParts[3]
$accountId = $arnParts[4]

# Derive staging environment from the stack name (my-backend-k8s-dev -> dev, my-backend-k8s-release -> release)
if ($StackName -match '-(dev|release)$') {
    $stagingEnv = $Matches[1]
} else {
    Write-Error "Cannot derive staging environment from stack name '$StackName'. Expected it to end with -dev or -release."
}

Write-Host "  region:      $awsRegion" -ForegroundColor Gray
Write-Host "  account:     $accountId" -ForegroundColor Gray
Write-Host "  environment: $stagingEnv" -ForegroundColor Gray
Write-Host "  hostname:    $hostname" -ForegroundColor Gray
Write-Host "  certArn:     $certArn" -ForegroundColor Gray
Write-Host "  webAclArn:   $webAclArn" -ForegroundColor Gray
Write-Host "  s3Bucket:    $s3Bucket" -ForegroundColor Gray
Write-Host "  clusterName: $eksClusterName" -ForegroundColor Gray
if ($KubectlRoleArn) {
    Write-Host "  kubectlRole: $KubectlRoleArn" -ForegroundColor Gray
}

# Determine if we have a custom domain configured.
$notConfiguredDomain = "not-configured (no apexDomain/hostedZoneId)"
$hasCustomDomain = $true
if ($certArn -eq $notConfiguredDomain -or $hostname -eq $notConfiguredDomain) {
    $hasCustomDomain = $false
} elseif ($certArn -notmatch '^arn:aws:acm:[^:]+:[0-9]{12}:certificate/.+') {
    $hasCustomDomain = $false
}

# -------------------------------------------------------
# 3. Query identity stack for Issuer URI
# -------------------------------------------------------
Write-Host "Querying stack '$IdentityStackName' ..." -ForegroundColor Cyan

$issuerUri = Get-StackOutput -Stack $IdentityStackName -OutputKey "IssuerUriOutput"

Write-Host "  issuerUri:   $issuerUri" -ForegroundColor Gray

# -------------------------------------------------------
# 4. Build ECR image URI
# -------------------------------------------------------
$ecrImageUri = "$accountId.dkr.ecr.$awsRegion.amazonaws.com/${imageRepoName}:${appVersion}"
Write-Host "  imageUri:    $ecrImageUri" -ForegroundColor Gray

# In no-domain mode, substitute empty strings for cert/hostname (then post-process ingress.yaml).
$certArnSub = $certArn
$hostnameSub = $hostname
if (-not $hasCustomDomain) {
    $certArnSub = ""
    $hostnameSub = ""
}

# -------------------------------------------------------
# 5. Build replacement map
# -------------------------------------------------------
$replacements = @{
    "__ECR_IMAGE_URI__"         = $ecrImageUri
    "__AWS_REGION__"            = $awsRegion
    "__SERVICE_NAME__"          = $serviceName
    "__STAGING_ENVIRONMENT__"   = $stagingEnv
    "__ISSUER_URI__"            = $issuerUri
    "__S3_BUCKET_NAME__"        = $s3Bucket
    "__EKS_CERTIFICATE_ARN__"   = $certArnSub
    "__EKS_WEB_ACL_ARN__"       = $webAclArn
    "__EKS_HOSTNAME__"          = $hostnameSub
    "__APP_PORT__"              = $appPort
    "__HEALTH_CHECK_PATH__"     = $healthCheckPath
}

# -------------------------------------------------------
# 6. Replace placeholders in template files -> generated/
# -------------------------------------------------------
Write-Host "Generating manifests ..." -ForegroundColor Cyan

if (Test-Path $GeneratedDir) {
    Remove-Item $GeneratedDir -Recurse -Force
}
New-Item -ItemType Directory -Path $GeneratedDir -Force | Out-Null

$templateFiles = Get-ChildItem -Path $TemplateDir -Filter "*.yaml"

foreach ($file in $templateFiles) {
    $content = Get-Content $file.FullName -Raw

    foreach ($key in $replacements.Keys) {
        $content = $content -replace [regex]::Escape($key), $replacements[$key]
    }

    # In no-domain mode, convert the Ingress to HTTP-only and hostless so the ALB DNS name works.
    if (-not $hasCustomDomain -and $file.Name -eq "ingress.yaml") {
        $lines = $content -split "`r?`n"
        $outLines = New-Object System.Collections.Generic.List[string]
        $skipNextHttpLine = $false

        foreach ($line in $lines) {

            if ($line -match '^\s*alb\.ingress\.kubernetes\.io/listen-ports:') {
                $outLines.Add("    alb.ingress.kubernetes.io/listen-ports: '[{""HTTP"": 80}]'")
                continue
            }

            if ($line -match '^\s*alb\.ingress\.kubernetes\.io/(certificate-arn|ssl-policy|ssl-redirect|actions\.ssl-redirect):') {
                continue
            }

            if ($line -match '^\s*external-dns\.alpha\.kubernetes\.io/hostname:') {
                continue
            }

            if ($skipNextHttpLine) {
                if ($line -match '^\s*http:\s*$') {
                    $skipNextHttpLine = $false
                    continue
                }
                $skipNextHttpLine = $false
            }

            if ($line -match '^\s*-\s*host:\s*') {
                $outLines.Add(($line -replace 'host:.*$', 'http:'))
                $skipNextHttpLine = $true
                continue
            }

            $outLines.Add($line)
        }

        $content = ($outLines -join "`n")
    }

    # Check for any remaining placeholders
    $remaining = [regex]::Matches($content, '__[A-Z_]+__')
    if ($remaining.Count -gt 0) {
        $names = ($remaining | ForEach-Object { $_.Value }) | Select-Object -Unique
        Write-Warning "$($file.Name): unresolved placeholders: $($names -join ', ')"
    }

    $outPath = Join-Path $GeneratedDir $file.Name
    Set-Content -Path $outPath -Value $content -NoNewline
    Write-Host "  wrote $outPath" -ForegroundColor Green
}

# -------------------------------------------------------
# 7. Optionally apply
# -------------------------------------------------------
if ($Apply) {
    Write-Host "Applying manifests ..." -ForegroundColor Cyan

    # Configure kubectl for this cluster (idempotent)
    $kubeconfigArgs = @("eks", "update-kubeconfig", "--name", $eksClusterName, "--region", $awsRegion)
    if ($KubectlRoleArn) {
        $kubeconfigArgs += "--role-arn", $KubectlRoleArn
    }
    Invoke-Aws $kubeconfigArgs | Out-Null

    # Webhook readiness gate (Ingress/Service admission)
    Wait-AlbWebhookEndpoints `
        -Namespace $AlbWebhookNamespace `
        -ServiceName $AlbWebhookServiceName `
        -MaxAttempts ([int]$AlbWebhookMaxAttempts) `
        -SleepSeconds ([int]$AlbWebhookSleepSecs) `
        -ControllerLabel $AlbControllerLabel

    kubectl apply -f $GeneratedDir
    if ($LASTEXITCODE -ne 0) {
        Write-Error "kubectl apply failed"
    }

    Write-Host ""
    Write-Host "Waiting for rollout ..." -ForegroundColor Cyan
    kubectl rollout status deployment/$serviceName --timeout=300s

    Write-Host ""
    Write-Host "Checking ingress ..." -ForegroundColor Cyan
    kubectl get ingress "${serviceName}-ingress"

    Write-Host ""
    if ($hasCustomDomain) {
        Write-Host "Done. ExternalDNS will create the Route53 record within ~1 minute." -ForegroundColor Green
        Write-Host "Test with: curl https://$hostname/actuator/health" -ForegroundColor Green
    } else {
        Write-Host "Done. Custom domain is not configured; using ALB DNS name over HTTP." -ForegroundColor Yellow
        Write-Host "Get the ALB DNS name with: kubectl get ingress ${serviceName}-ingress" -ForegroundColor Yellow
        Write-Host "Then test with: curl http://<ALB_DNS_NAME>$healthCheckPath" -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "Manifests written to $GeneratedDir" -ForegroundColor Green
    Write-Host "To apply: kubectl apply -f $GeneratedDir" -ForegroundColor Green
    Write-Host "Or re-run with -Apply flag." -ForegroundColor Green
}
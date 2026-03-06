# cleanup-manifests.* is required because some AWS resources (notably the ALB, target groups, and related SG rules)
# are created indirectly by the AWS Load Balancer Controller when you `kubectl apply` an Ingress.
# CloudFormation/CDK does not "own" those controller-created resources, so `cdk destroy` can fail if they still exist
# or are still being cleaned up.
#
# This script deletes the Kubernetes manifests first (especially Ingress), waits for controller cleanup to finish,
# and only then you run `cdk destroy`.
#
#
# Example usage:
#
#   .\cleanup-manifests.ps1 -StackName my-service-k8s-dev -Profile my-aws-profile
#   cdk destroy my-service-k8s-dev



param(
  [Parameter(Mandatory)]
  [string]$StackName,

  [string]$Profile,

  [string]$RepoRoot
)

$ErrorActionPreference = "Stop"

function Invoke-Aws {
  param([string[]]$AwsArgs)
  if ($Profile) { $AwsArgs += "--profile", $Profile }
  $json = & aws @AwsArgs
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI failed: aws $($AwsArgs -join ' ')" }
  $json
}

function Get-StackOutput {
  param([string]$Stack, [string]$OutputKey)
  $json = Invoke-Aws "cloudformation","describe-stacks","--stack-name",$Stack,"--output","json"
  $stacks = ($json -join "`n") | ConvertFrom-Json
  $outputs = $stacks.Stacks[0].Outputs
  ($outputs | Where-Object { $_.OutputKey -eq $OutputKey }).OutputValue
}

function Get-StackArn {
  param([string]$Stack)
  $json = Invoke-Aws "cloudformation","describe-stacks","--stack-name",$Stack,"--output","json"
  $stacks = ($json -join "`n") | ConvertFrom-Json
  $stacks.Stacks[0].StackId
}

$ScriptDir = $PSScriptRoot
$GeneratedDir = Join-Path (Join-Path (Join-Path $ScriptDir "..") "..") (Join-Path "manifest" "generated")

# NOTE:
# We must NOT derive region from the ACM cert ARN.
# In "no custom domain" mode the cert output is intentionally a placeholder string.
$stackArn = Get-StackArn -Stack $StackName
$awsRegion = ($stackArn -split ":")[3]

$eksClusterName = Get-StackOutput -Stack $StackName -OutputKey "EksClusterName"

Write-Host "Using cluster: $eksClusterName (region: $awsRegion)"

$kubeconfigArgs = @("eks","update-kubeconfig","--name",$eksClusterName,"--region",$awsRegion)
if ($Profile) { $kubeconfigArgs += @("--profile",$Profile) }
& aws @kubeconfigArgs | Out-Null

if (Test-Path $GeneratedDir) {
  Write-Host "Deleting resources defined in manifests from $GeneratedDir ..."
  & kubectl delete -f $GeneratedDir --ignore-not-found=true | Out-Null
} else {
  Write-Warning "$GeneratedDir not found. If you applied from template/ or elsewhere, delete those manifests manually."
}

Write-Host "Waiting for Ingress resources to be deleted (and ALB cleanup to finish) ..."
for ($i = 0; $i -lt 60; $i++) {
  $out = & kubectl get ingress --all-namespaces -o name 2>$null
  if ($LASTEXITCODE -eq 0 -and $out -match '\S') {
    Start-Sleep -Seconds 10
  } else {
    break
  }
}

Write-Host "Cleanup done. Now run: cdk destroy"
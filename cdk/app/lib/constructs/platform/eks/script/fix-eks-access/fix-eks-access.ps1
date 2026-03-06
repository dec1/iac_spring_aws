<#
.SYNOPSIS
    Fixes EKS "provide credentials" errors by granting your local IAM identity admin access.

.DESCRIPTION
    PROBLEM: 
    EKS clusters created via CDK often only recognize the deployment role as the admin.
    This prevents 'kubectl' from cleaning up Ingress resources, which in turn prevents 
    'cdk destroy' from deleting the VPC due to orphaned Load Balancers.

    SOLUTION:
    This script enables the modern EKS Access Entry system, waits for the update 
    to propagate, and registers your current IAM identity as a Cluster Admin.

.EXAMPLE
    .\fix-eks-access.ps1 -StackName my-backend-k8s-release -Region eu-west-2 -Profile myb
#>#>

param(
    [string]$StackName,
    [string]$ClusterName,
    [Parameter(Mandatory)]
    [string]$Region,
    [string]$Profile
)

$ErrorActionPreference = "Stop"

function Invoke-Aws {
    param([string[]]$AwsArgs)
    if ($Profile) { $AwsArgs += "--profile", $Profile }
    $result = & aws @AwsArgs
    if ($LASTEXITCODE -ne 0) { throw "AWS CLI failed: aws $($AwsArgs -join ' ')" }
    return $result
}

# 1. Resolve Cluster Name
if (-not $ClusterName) {
    Write-Host "Fetching cluster name from stack '$StackName'..." -ForegroundColor Cyan
    try {
        $json = Invoke-Aws @("cloudformation", "describe-stacks", "--stack-name", $StackName, "--region", $Region, "--output", "json")
        $stacks = ($json -join "`n") | ConvertFrom-Json
        $ClusterName = ($stacks.Stacks[0].Outputs | Where-Object { $_.OutputKey -eq "EksClusterName" }).OutputValue
    } catch {
        Write-Host "ERROR: Could not find stack '$StackName'." -ForegroundColor Red
        exit 1
    }
}

# 2. Resolve IAM Identity (Precise Role Discovery)
Write-Host "Determining your IAM Role ARN..." -ForegroundColor Cyan
$identityJson = Invoke-Aws @("sts", "get-caller-identity", "--output", "json") | ConvertFrom-Json
$currentArn = $identityJson.Arn

# SSO Roles often look like: arn:aws:sts::123:assumed-role/AWSReservedSSO_rio-admin_abc/user
# EKS Access Entry needs: arn:aws:iam::123:role/aws-reserved/sso.amazonaws.com/eu-west-1/AWSReservedSSO_rio-admin_abc
if ($currentArn -match "arn:aws:sts::(\d+):assumed-role/([^/]+)/(.+)") {
    $roleNameWithOptionalPath = $Matches[2]
    # We ask IAM for the true Role ARN to avoid path/prefix guesswork
    Write-Host "Extracting base role: $roleNameWithOptionalPath" -ForegroundColor Gray
    $roleInfo = Invoke-Aws @("iam", "get-role", "--role-name", $roleNameWithOptionalPath, "--query", "Role.Arn", "--output", "text")
    $baseRoleArn = $roleInfo.Trim()
} else {
    $baseRoleArn = $currentArn
}

Write-Host "Target Cluster: $ClusterName"
Write-Host "Target Principal: $baseRoleArn"

# 3. Handle Auth Mode
$clusterInfo = Invoke-Aws @("eks", "describe-cluster", "--name", $ClusterName, "--region", $Region, "--output", "json") | ConvertFrom-Json
$currentMode = $clusterInfo.cluster.accessConfig.authenticationMode

if ($currentMode -ne "API_AND_CONFIG_MAP" -and $currentMode -ne "API") {
    Write-Host "Updating mode to API_AND_CONFIG_MAP..." -ForegroundColor Yellow
    $updateJson = Invoke-Aws @("eks", "update-cluster-config", "--name", $ClusterName, "--region", $Region, "--access-config", "authenticationMode=API_AND_CONFIG_MAP", "--output", "json") | ConvertFrom-Json
    $updateId = $updateJson.update.id

    while ($true) {
        $updateStatus = Invoke-Aws @("eks", "describe-update", "--name", $ClusterName, "--region", $Region, "--update-id", $updateId, "--query", "update.status", "--output", "text")
        if ($updateStatus -eq "Successful") { break }
        Write-Host "Update Status: $updateStatus. Waiting 20s..."
        Start-Sleep -Seconds 20
    }
}

# 4. Create Access Entry
Write-Host "Registering access entry..." -ForegroundColor Cyan
try {
    # Use the discovered IAM Role ARN exactly as provided by 'iam get-role'
    Invoke-Aws @("eks", "create-access-entry", "--cluster-name", $ClusterName, "--region", $Region, "--principal-arn", $baseRoleArn, "--type", "STANDARD") | Out-Null
} catch {
    if ($_ -match "ResourceInUseException" -or $_ -match "already exists") {
        Write-Host "Access entry already exists." -ForegroundColor Gray
    } else { throw $_ }
}

# 5. Associate Policy
Write-Host "Associating Admin policy..." -ForegroundColor Cyan
Invoke-Aws @("eks", "associate-access-policy", "--cluster-name", $ClusterName, "--region", $Region, "--principal-arn", $baseRoleArn, "--policy-arn", "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy", "--access-scope", "type=cluster") | Out-Null

Write-Host "`nSUCCESS: Access granted." -ForegroundColor Green
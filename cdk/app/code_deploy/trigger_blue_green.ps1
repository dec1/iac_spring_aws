<#
.SYNOPSIS
  Trigger a Blue/Green deployment for your ECS Fargate service.

.DESCRIPTION
  - Auto-detects your ECS cluster and the "*-blue-svc" service in the "release" stagingEnvironment
  - Finds the latest ACTIVE "*-green-task" revision and its container port
  - Selects the first CodeDeploy Application & its first Deployment Group
  - Generates an AppSpecContent JSON (schema version 1) on the fly
  - Writes it to a BOM-free temp file
  - Executes `aws deploy create-deployment` to shift traffic
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$AwsProfile,

  [ValidateSet('release')]
  [string]$StagingEnvironment = 'release'
)

# -------------------------------------------------------
# 1) Locate the ECS cluster and its blue service
# -------------------------------------------------------
Write-Host "Searching for a '$StagingEnvironment' cluster with a '*-blue-svc' service..."

$allClusters = (aws ecs list-clusters `
    --profile $AwsProfile `
    --output json | ConvertFrom-Json).clusterArns
$targetClusters = $allClusters | Where-Object { $_ -like "*-$StagingEnvironment-*" }

if (-not $targetClusters) {
  Write-Error "ERROR: No ECS clusters found matching '*-$StagingEnvironment-*'."
  exit 1
}

$found = $null
foreach ($clusterArn in $targetClusters) {
  $svcList = (aws ecs list-services `
      --cluster $clusterArn `
      --profile $AwsProfile `
      --output json | ConvertFrom-Json).serviceArns
  $svcArn = $svcList | Where-Object { $_ -like "*-blue-svc" } | Select-Object -First 1
  if ($svcArn) {
    $found = [PSCustomObject]@{
      ClusterArn = $clusterArn
      ServiceArn = $svcArn
    }
    break
  }
}

if (-not $found) {
  Write-Error "ERROR: No '*-blue-svc' service found in any '*-$StagingEnvironment-*' cluster."
  exit 1
}

$serviceName = $found.ServiceArn.Split('/')[-1]
Write-Host "ECS Cluster: $($found.ClusterArn)"
Write-Host "Blue Service: $serviceName"

# -------------------------------------------------------
# 2) Get current (blue) task definition ARN
# -------------------------------------------------------
$currentBlueTd = (aws ecs describe-services `
    --cluster $found.ClusterArn `
    --services $serviceName `
    --profile $AwsProfile `
    --output text `
    --query 'services[0].taskDefinition')
Write-Host "Current (blue) TaskDefinition: $currentBlueTd"

# -------------------------------------------------------
# 3) Determine the latest ACTIVE green-task revision
# -------------------------------------------------------
$greenFamily = ($serviceName -replace '-blue-svc$','') + '-green-task'
$tdListObj   = aws ecs list-task-definitions `
    --family-prefix $greenFamily `
    --status ACTIVE `
    --sort DESC `
    --profile $AwsProfile `
    --output json | ConvertFrom-Json

$newTaskDefArn = $tdListObj.taskDefinitionArns | Select-Object -First 1
if (-not $newTaskDefArn) {
  Write-Error "ERROR: No ACTIVE task definitions found for family '$greenFamily'."
  exit 1
}
Write-Host "New (green) TaskDefinition: $newTaskDefArn"

# -------------------------------------------------------
# 4) Retrieve containerPort from the new task definition
# -------------------------------------------------------
$tdDesc = aws ecs describe-task-definition `
    --task-definition $newTaskDefArn `
    --profile $AwsProfile `
    --output json | ConvertFrom-Json

$containerPort = $tdDesc.taskDefinition.containerDefinitions[0].portMappings[0].containerPort
if (-not $containerPort) {
  Write-Error "ERROR: Unable to determine containerPort from task definition."
  exit 1
}
Write-Host "ContainerPort: $containerPort"

# -------------------------------------------------------
# 5) Pick CodeDeploy Application & Deployment Group
# -------------------------------------------------------
$cdApp = (aws deploy list-applications --profile $AwsProfile --output text --query 'applications[0]')
if (-not $cdApp) {
  Write-Error "ERROR: No CodeDeploy application found."
  exit 1
}
Write-Host "CodeDeploy Application: $cdApp"

$cdDG = (aws deploy list-deployment-groups --application-name $cdApp --profile $AwsProfile --output text --query 'deploymentGroups[0]')
if (-not $cdDG) {
  Write-Error "ERROR: No Deployment Group found under application '$cdApp'."
  exit 1
}
Write-Host "Deployment Group: $cdDG"

# -------------------------------------------------------
# 6) Build the AppSpecContent JSON dynamically
# -------------------------------------------------------
$appSpec = @{
  version   = 1
  Resources = @(
    @{
      TargetService = @{
        Type       = "AWS::ECS::Service"
        Properties = @{
          TaskDefinition   = $newTaskDefArn
          LoadBalancerInfo = @{
            ContainerName  = "AppContainer"
            ContainerPort  = [int]$containerPort
          }
        }
      }
    }
  )
}

$appSpecJson  = $appSpec | ConvertTo-Json -Depth 10 -Compress
$revisionObj  = @{
  revisionType   = "AppSpecContent"
  appSpecContent = @{ content = $appSpecJson }
}
$revisionJson = $revisionObj | ConvertTo-Json -Depth 10 -Compress

# -------------------------------------------------------
# 7) Write a BOM-free temp file for the revision
# -------------------------------------------------------
$tempFile  = Join-Path $env:TEMP ("codedeploy-revision-{0}.json" -f ([guid]::NewGuid()))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tempFile, $revisionJson, $utf8NoBom)
Write-Host "Revision JSON written to: $tempFile" -ForegroundColor Green

# -------------------------------------------------------
# 8) Trigger the Blue/Green deployment in CodeDeploy
# -------------------------------------------------------
aws deploy create-deployment `
  --application-name       $cdApp `
  --deployment-group-name  $cdDG `
  --deployment-config-name CodeDeployDefault.ECSCanary10Percent5Minutes `
  --description            "Blue/Green deploy: $newTaskDefArn" `
  --revision               file://$tempFile `
  --profile                $AwsProfile

Write-Host "Deployment requested." -ForegroundColor Cyan

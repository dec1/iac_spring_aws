#!/bin/bash

# SYNOPSIS
#   Trigger a Blue/Green deployment for your ECS Fargate service.
#
# DESCRIPTION
# - Auto-detects your ECS cluster and the "*-blue-svc" service in the "release" environment only
# - Finds the latest ACTIVE "*-green-task" revision and its container port
# - Selects the first CodeDeploy Application & its first Deployment Group
# - Generates an AppSpecContent JSON (schema version 1) on the fly via jq
# - Writes it to a BOM-free temp file
# - Executes `aws deploy create-deployment` to shift traffic

# --- Input Parameters ---
awsProfile=""                     # Optional: AWS CLI profile (local SSO case). If empty, use env/instance-role creds (CI-friendly).
stagingEnvironment="release"      # Only 'release' is supported

# Function to display usage information
usage() {
  echo "Usage: $0 [--awsProfile <AWS_PROFILE>]"
  echo "  --awsProfile   Optional. Use an AWS CLI profile (e.g., mpb)."
  echo "                If omitted, AWS CLI uses env vars / instance role credentials (works in CI)."
  exit 1
}

# Parse command-line arguments
while (( "$#" )); do
  case "$1" in
    --awsProfile)
      if [ -n "$2" ] && [ "${2:0:1}" != "-" ]; then
        awsProfile="$2"
        shift 2
      else
        echo "Error: Argument for --awsProfile is missing." >&2
        usage
      fi
      ;;
    --environment)
      echo "Error: only 'release' environment is supported by this script." >&2
      usage
      ;;
    *)
      echo "Error: Unknown argument $1" >&2
      usage
      ;;
  esac
done

# make profile optional + build common AWS args once ---
# - Local dev often uses SSO via an AWS CLI profile (needs --profile).
# - but CI usually has no profile config; it uses env vars (AWS_ACCESS_KEY_ID/...) or instance role creds.
AWS_ARGS=()
if [ -n "$awsProfile" ]; then
  AWS_ARGS+=(--profile "$awsProfile")
fi


# Require an explicit region (either AWS_REGION or AWS_DEFAULT_REGION).
if [ -n "${AWS_REGION:-}" ]; then
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}"
elif [ -n "${AWS_DEFAULT_REGION:-}" ]; then
  export AWS_REGION="$AWS_DEFAULT_REGION"
else
  log_error "AWS region not set. Export AWS_REGION (preferred) or AWS_DEFAULT_REGION before running this script."
fi

# --- Helper Functions ---
log_info() {
  echo -e "\e[36mINFO:\e[0m $1"
}

log_success() {
  echo -e "\e[32mSUCCESS:\e[0m $1"
}

log_error() {
  echo -e "\e[31mERROR:\e[0m $1"
  exit 1
}

# --- Main Script Logic ---

# 1) Locate the ECS cluster and its blue service
log_info "Searching for a '$stagingEnvironment' cluster with a '*-blue-svc' service..."

ALL_CLUSTER_ARNS=$(aws ecs list-clusters \
  "${AWS_ARGS[@]}" \
  --output json | jq -r '.clusterArns[]')

if [ -z "$ALL_CLUSTER_ARNS" ]; then
  log_error "No ECS clusters found."
fi

FOUND_CLUSTER_ARN=""
FOUND_SERVICE_ARN=""

for CLUSTER_ARN in $ALL_CLUSTER_ARNS; do
  if [[ "$CLUSTER_ARN" == *"-${stagingEnvironment}-"* ]]; then
    SERVICE_ARNS=$(aws ecs list-services \
      --cluster "$CLUSTER_ARN" \
      "${AWS_ARGS[@]}" \
      --output json | jq -r '.serviceArns[]')

    for SVC_ARN in $SERVICE_ARNS; do
      if [[ "$SVC_ARN" == *"-blue-svc"* ]]; then
        FOUND_CLUSTER_ARN="$CLUSTER_ARN"
        FOUND_SERVICE_ARN="$SVC_ARN"
        break 2
      fi
    done
  fi
done

if [ -z "$FOUND_SERVICE_ARN" ]; then
  log_error "No '*-blue-svc' service found in any '*-$stagingEnvironment-*' cluster."
fi

SERVICE_NAME=$(basename "$FOUND_SERVICE_ARN")
log_info "ECS Cluster: $FOUND_CLUSTER_ARN"
log_info "Blue Service: $SERVICE_NAME"

# 2) Get current (blue) task definition ARN
CURRENT_BLUE_TD=$(aws ecs describe-services \
  --cluster "$FOUND_CLUSTER_ARN" \
  --services "$SERVICE_NAME" \
  "${AWS_ARGS[@]}" \
  --output json \
  --query 'services[0].taskDefinition' | tr -d '"')

if [ -z "$CURRENT_BLUE_TD" ]; then
  log_error "Unable to get current (blue) TaskDefinition."
fi
log_info "Current (blue) TaskDefinition: $CURRENT_BLUE_TD"

# 3) Determine the latest ACTIVE green-task revision
GREEN_FAMILY="${SERVICE_NAME//-blue-svc/-green-task}"
NEW_TASK_DEF_ARN=$(aws ecs list-task-definitions \
  --family-prefix "$GREEN_FAMILY" \
  --status ACTIVE \
  --sort DESC \
  "${AWS_ARGS[@]}" \
  --output json | jq -r '.taskDefinitionArns[0]')

if [ -z "$NEW_TASK_DEF_ARN" ]; then
  log_error "No ACTIVE task definitions found for family '$GREEN_FAMILY'."
fi
log_info "New (green) TaskDefinition: $NEW_TASK_DEF_ARN"

# 4) Retrieve containerPort from the new task definition
CONTAINER_PORT=$(aws ecs describe-task-definition \
  --task-definition "$NEW_TASK_DEF_ARN" \
  "${AWS_ARGS[@]}" \
  --output json | jq -r '.taskDefinition.containerDefinitions[0].portMappings[0].containerPort')

if [ -z "$CONTAINER_PORT" ]; then
  log_error "Unable to determine containerPort from task definition."
fi
log_info "ContainerPort: $CONTAINER_PORT"

# 5) Pick CodeDeploy Application & Deployment Group
CD_APP=$(aws deploy list-applications \
  "${AWS_ARGS[@]}" \
  --output json | jq -r '.applications[0]')

if [ -z "$CD_APP" ]; then
  log_error "No CodeDeploy application found."
fi
log_info "CodeDeploy Application: $CD_APP"

CD_DG=$(aws deploy list-deployment-groups \
  --application-name "$CD_APP" \
  "${AWS_ARGS[@]}" \
  --output json | jq -r '.deploymentGroups[0]')

if [ -z "$CD_DG" ]; then
  log_error "No Deployment Group found under application '$CD_APP'."
fi
log_info "Deployment Group: $CD_DG"

# -------------------------------------------------------
# 6) Build the AppSpecContent & Revision JSON dynamically via jq
# -------------------------------------------------------

# Build the AppSpecContent object
APPSPEC_JSON=$(jq -n \
  --arg td   "$NEW_TASK_DEF_ARN" \
  --argjson port "$CONTAINER_PORT" \
  '{
     version: 1,
     Resources: [
       {
         TargetService: {
           Type: "AWS::ECS::Service",
           Properties: {
             TaskDefinition: $td,
             LoadBalancerInfo: {
               ContainerName: "AppContainer",
               ContainerPort: $port
             }
           }
         }
       }
     ]
   }'
)

# Build the Revision JSON, embedding the AppSpecContent as a JSON-string
REVISION_JSON=$(jq -n \
  --argjson appspec "$APPSPEC_JSON" \
  '{
     revisionType: "AppSpecContent",
     appSpecContent: {
       content: ($appspec | tojson)
     }
   }'
)

[ -n "$REVISION_JSON" ] || log_error "Failed to construct Revision JSON."

# 7) Write a temp file for the revision
# -------------------------------------------------------
TEMP_FILE=$(mktemp /tmp/codedeploy-revision-XXXXXX.json)
echo "$REVISION_JSON" > "$TEMP_FILE"
log_info "Revision JSON written to: $TEMP_FILE"

# -------------------------------------------------------
# 8) Trigger the Blue/Green deployment in CodeDeploy
# -------------------------------------------------------
log_info "Triggering Blue/Green deployment..."
aws deploy create-deployment \
  --application-name "$CD_APP" \
  --deployment-group-name "$CD_DG" \
  --deployment-config-name CodeDeployDefault.ECSCanary10Percent5Minutes \
  --description "Blue/Green deploy: $NEW_TASK_DEF_ARN" \
  --revision "file://$TEMP_FILE" \
  "${AWS_ARGS[@]}"

# Cleanup temp file
rm "$TEMP_FILE"
log_success "Deployment requested. Temporary file removed."

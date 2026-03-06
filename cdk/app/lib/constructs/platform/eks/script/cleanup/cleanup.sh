#!/usr/bin/env bash
set -euo pipefail

# .SYNOPSIS
#     Deletes the generated Kubernetes manifests from the target EKS cluster to undo deployment.
#
# .DESCRIPTION
#     This script:
#     1. Resolves the EKS cluster name from the CloudFormation stack outputs.
#     2. Updates your local kubeconfig for that cluster.
#     3. Deletes the rendered manifests from manifest/generated/.
#     4. Waits for Ingress resources to disappear so ALB cleanup can complete.
#
# Usage:
#   ./cleanup.sh --stackName <serviceName>-k8s-<dev|release> [--region <region>] --profile <profileName>
#
# Notes:
#   - --region is optional when --stackName is provided; it will be derived from the stack ARN.

STACK_NAME=""
PROFILE=""
REGION=""
REPO_ROOT=""

usage() {
  echo "Usage: $0 --stackName <stack-name> --profile <profile> [--region <region>] [--repo-root <path>]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stackName|--stack-name) STACK_NAME="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

if [[ -z "$STACK_NAME" || -z "$PROFILE" ]]; then
  usage
fi

run_aws() {
  if [[ -n "$PROFILE" ]]; then aws "$@" --profile "$PROFILE"; else aws "$@"; fi
}

get_stack_output() {
  local stack="$1"
  local key="$2"
  run_aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" \
    --output text
}

get_stack_arn() {
  local stack="$1"
  run_aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --query "Stacks[0].StackId" \
    --output text
}

SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ "$SCRIPT_PATH" != /* ]]; then
  SCRIPT_PATH="$(command -v -- "$SCRIPT_PATH" 2>/dev/null || true)"
fi
if [[ -z "$SCRIPT_PATH" || ! -e "$SCRIPT_PATH" ]]; then
  echo "ERROR: unable to resolve script path for $0" >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
MANIFEST_ROOT="$SCRIPT_DIR/../../manifest"
GENERATED_DIR="$MANIFEST_ROOT/generated"

# NOTE:
# We must NOT derive region from the ACM cert ARN.
# In "no custom domain" mode the cert output is intentionally a placeholder string.
if [[ -n "$REGION" ]]; then
  AWS_REGION="$REGION"
else
  STACK_ARN=$(get_stack_arn "$STACK_NAME")
  AWS_REGION=$(echo "$STACK_ARN" | cut -d: -f4)
fi

EKS_CLUSTER_NAME=$(get_stack_output "$STACK_NAME" "EksClusterName")

echo "Using cluster: $EKS_CLUSTER_NAME (region: $AWS_REGION)"
run_aws eks update-kubeconfig --name "$EKS_CLUSTER_NAME" --region "$AWS_REGION" >/dev/null

if [[ -d "$GENERATED_DIR" ]]; then
  echo "Deleting manifests from $GENERATED_DIR ..."
  kubectl delete -f "$GENERATED_DIR" --ignore-not-found=true || true
else
  echo "WARNING: $GENERATED_DIR not found. If you applied from template/ or elsewhere, delete those manifests manually."
fi

# Wait for ingress cleanup (best-effort). If you know the ingress name, you can target it explicitly.
echo "Waiting for Ingress resources to be deleted (and ALB cleanup to finish) ..."
for i in {1..60}; do
  if kubectl get ingress --all-namespaces -o name 2>/dev/null | grep -q .; then
    sleep 10
  else
    break
  fi
done

echo "Cleanup done. Now run: cdk destroy"
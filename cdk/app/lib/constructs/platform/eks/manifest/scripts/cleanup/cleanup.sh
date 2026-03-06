#!/usr/bin/env bash
set -euo pipefail

STACK_NAME=""
PROFILE=""
REPO_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$STACK_NAME" ]]; then
  echo "Usage: $0 --stack-name <stack-name> [--profile <profile>] [--repo-root <path>]"
  exit 1
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST_ROOT="$SCRIPT_DIR/../"               # scripts/../
GENERATED_DIR="$MANIFEST_ROOT/generated"

# NOTE:
# We must NOT derive region from the ACM cert ARN.
# In "no custom domain" mode the cert output is intentionally a placeholder string.
STACK_ARN=$(get_stack_arn "$STACK_NAME")
AWS_REGION=$(echo "$STACK_ARN" | cut -d: -f4)

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
  if kubectl get ingress --all-namespaces 2>/dev/null | grep -q .; then
    sleep 10
  else
    break
  fi
done

echo "Cleanup done. Now run: cdk destroy"
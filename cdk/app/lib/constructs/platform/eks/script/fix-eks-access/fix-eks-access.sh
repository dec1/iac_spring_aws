#!/usr/bin/env bash
set -euo pipefail

# .SYNOPSIS
#     Ensure your local AWS credentials allow you kubectl access to the Kubernetes cluster.
#     Fixes EKS "provide credentials" errors by granting your local IAM identity admin access.
#
# .DESCRIPTION
#     PROBLEM:
#     EKS clusters created via CDK often only recognize the deployment role (the "creator")
#     as the administrator. This locks out your local SSO/IAM profile.
#
#     THE "CLEANUP CATCH-22" SIDE-EFFECT:
#     1. You need to run 'cdk destroy' to delete your stack.
#     2. 'cdk destroy' will fail or hang because it cannot delete the VPC.
#     3. The VPC cannot be deleted because an ALB (Load Balancer) still exists.
#     4. The ALB exists because it was created dynamically by a Kubernetes Ingress.
#     5. You cannot delete the Ingress because 'kubectl' doesn't recognize your identity.
#
#     This script breaks the loop by injecting your IAM identity into the EKS access list
#     from the outside using the AWS API.
#
# Usage:
#   ./fix-eks-access.sh --stackName <serviceName>-k8s-<dev|release> [--region <region>] --profile <profileName>
#
# Notes:
#   - --region is optional when --stackName is provided; it will be derived from the stack ARN.
#   - --clusterName can be used instead of --stackName.

STACK_NAME=""
CLUSTER_NAME=""
PROFILE=""
REGION=""

usage() {
    cat <<USAGE
Usage: $0 --stackName <stack-name> [--region <region>] --profile <profile> [--clusterName <cluster-name>]

Also accepted for compatibility:
  --stack-name, --cluster-name
USAGE
    exit 1
}

invoke_aws() {
    local args=("$@")
    if [[ -n "$PROFILE" ]]; then
        args+=("--profile" "$PROFILE")
    fi
    aws "${args[@]}"
}

get_stack_arn() {
    local stack="$1"
    invoke_aws cloudformation describe-stacks \
        --stack-name "$stack" \
        --query "Stacks[0].StackId" \
        --output text
}

get_stack_output() {
    local stack="$1"
    local key="$2"
    invoke_aws cloudformation describe-stacks \
        --stack-name "$stack" \
        --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" \
        --output text
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --stackName|--stack-name) STACK_NAME="$2"; shift 2 ;;
        --clusterName|--cluster-name) CLUSTER_NAME="$2"; shift 2 ;;
        --region) REGION="$2"; shift 2 ;;
        --profile) PROFILE="$2"; shift 2 ;;
        -s) STACK_NAME="$2"; shift 2 ;;
        -c) CLUSTER_NAME="$2"; shift 2 ;;
        -r) REGION="$2"; shift 2 ;;
        -p) PROFILE="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "Unknown arg: $1"; usage ;;
    esac
done

if [[ -z "$PROFILE" ]] || [[ -z "$STACK_NAME" && -z "$CLUSTER_NAME" ]]; then
    usage
fi

# 1. Resolve cluster name / region from stack if needed
if [[ -n "$STACK_NAME" ]]; then
    if [[ -z "$REGION" ]]; then
        echo "Deriving region from stack '$STACK_NAME'..."
        STACK_ARN="$(get_stack_arn "$STACK_NAME")"
        REGION="$(echo "$STACK_ARN" | cut -d: -f4)"
        if [[ -z "$REGION" || "$REGION" == "None" ]]; then
            echo "Error: Could not derive region from stack ARN: $STACK_ARN"
            exit 1
        fi
    fi

    if [[ -z "$CLUSTER_NAME" ]]; then
        echo "Fetching cluster name from stack '$STACK_NAME'..."
        CLUSTER_NAME="$(get_stack_output "$STACK_NAME" "EksClusterName")"
        if [[ "$CLUSTER_NAME" == "None" || -z "$CLUSTER_NAME" ]]; then
            echo "Error: Could not find EksClusterName in stack outputs."
            exit 1
        fi
    fi
fi

if [[ -z "$REGION" ]]; then
    echo "Error: --region is required when --clusterName is used without --stackName."
    exit 1
fi

# 2. Resolve authoritative IAM role ARN

echo "Determining your IAM Role ARN..."
CURRENT_ARN="$(invoke_aws sts get-caller-identity --query "Arn" --output text)"

if [[ "$CURRENT_ARN" =~ :assumed-role/([^/]+)/ ]]; then
    ROLE_NAME="${BASH_REMATCH[1]}"
    echo "Extracting base role: $ROLE_NAME"
    BASE_ROLE_ARN="$(invoke_aws iam get-role --role-name "$ROLE_NAME" --query "Role.Arn" --output text)"
else
    BASE_ROLE_ARN="$CURRENT_ARN"
fi

echo "Target Cluster: $CLUSTER_NAME"
echo "Target Region: $REGION"
echo "Target Principal: $BASE_ROLE_ARN"

# 3. Handle auth mode (upgrade if needed)
CURRENT_MODE="$(invoke_aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query "cluster.accessConfig.authenticationMode" --output text)"

if [[ "$CURRENT_MODE" != "API_AND_CONFIG_MAP" && "$CURRENT_MODE" != "API" ]]; then
    echo "Updating mode to API_AND_CONFIG_MAP..."
    UPDATE_ID="$(invoke_aws eks update-cluster-config \
        --name "$CLUSTER_NAME" \
        --region "$REGION" \
        --access-config authenticationMode=API_AND_CONFIG_MAP \
        --query "update.id" --output text)"

    while true; do
        STATUS="$(invoke_aws eks describe-update --name "$CLUSTER_NAME" --region "$REGION" --update-id "$UPDATE_ID" --query "update.status" --output text)"
        if [[ "$STATUS" == "Successful" ]]; then
            echo "Update successful."
            break
        elif [[ "$STATUS" == "Failed" || "$STATUS" == "Cancelled" ]]; then
            echo "EKS update failed."
            exit 1
        fi
        echo "Status: $STATUS. Waiting 20s..."
        sleep 20
    done
else
    echo "Authentication mode is already $CURRENT_MODE."
fi

# 4. Create access entry

echo "Registering access entry..."
if ! invoke_aws eks create-access-entry \
    --cluster-name "$CLUSTER_NAME" \
    --region "$REGION" \
    --principal-arn "$BASE_ROLE_ARN" \
    --type STANDARD > /dev/null 2>&1; then
    echo "Access entry already exists or registration skipped."
fi

# 5. Associate admin policy

echo "Associating AmazonEKSClusterAdminPolicy..."
invoke_aws eks associate-access-policy \
    --cluster-name "$CLUSTER_NAME" \
    --region "$REGION" \
    --principal-arn "$BASE_ROLE_ARN" \
    --policy-arn "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy" \
    --access-scope type=cluster > /dev/null

echo
echo "SUCCESS: Access granted. You can now run your cleanup script."
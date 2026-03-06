#!/bin/bash

# .SYNOPSIS
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
# .EXAMPLE
#     chmod +x fix-eks-access.sh
#     ./fix-eks-access.sh -s my-backend-k8s-release -r eu-west-2 -p myb

set -e

usage() {
    echo "Usage: $0 -s <stack-name> -r <region> [-p <profile>] [-c <cluster-name>]"
    exit 1
}

while getopts "s:r:p:c:" opt; do
    case $opt in
        s) STACK_NAME=$OPTARG ;;
        r) REGION=$OPTARG ;;
        p) PROFILE=$OPTARG ;;
        c) CLUSTER_NAME=$OPTARG ;;
        *) usage ;;
    esac
done

if [[ -z "$REGION" ]] || [[ -z "$STACK_NAME" && -z "$CLUSTER_NAME" ]]; then
    usage
fi

# Helper function for AWS CLI calls
invoke_aws() {
    local args=("$@")
    if [[ -n "$PROFILE" ]]; then
        args+=("--profile" "$PROFILE")
    fi
    aws "${args[@]}"
}

# 1. Resolve Cluster Name from Stack if not provided
if [[ -z "$CLUSTER_NAME" ]]; then
    echo "Fetching cluster name from stack '$STACK_NAME'..."
    CLUSTER_NAME=$(invoke_aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='EksClusterName'].OutputValue" \
        --output text)
    
    if [[ "$CLUSTER_NAME" == "None" || -z "$CLUSTER_NAME" ]]; then
        echo "Error: Could not find EksClusterName in stack outputs."
        exit 1
    fi
fi

# 2. Resolve Authoritative IAM Role ARN
echo "Determining your IAM Role ARN..."
CURRENT_ARN=$(invoke_aws sts get-caller-identity --query "Arn" --output text)

# Regex to extract role name from assumed-role ARN
if [[ "$CURRENT_ARN" =~ :assumed-role/([^/]+)/ ]]; then
    ROLE_NAME="${BASH_REMATCH[1]}"
    echo "Extracting base role: $ROLE_NAME"
    # Query IAM for the full authoritative Role ARN (with paths)
    BASE_ROLE_ARN=$(invoke_aws iam get-role --role-name "$ROLE_NAME" --query "Role.Arn" --output text)
else
    BASE_ROLE_ARN="$CURRENT_ARN"
fi

echo "Target Cluster: $CLUSTER_NAME"
echo "Target Principal: $BASE_ROLE_ARN"

# 3. Handle Auth Mode (upgrade if needed)
CURRENT_MODE=$(invoke_aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query "cluster.accessConfig.authenticationMode" --output text)

if [[ "$CURRENT_MODE" != "API_AND_CONFIG_MAP" && "$CURRENT_MODE" != "API" ]]; then
    echo "Updating mode to API_AND_CONFIG_MAP..."
    UPDATE_ID=$(invoke_aws eks update-cluster-config \
        --name "$CLUSTER_NAME" \
        --region "$REGION" \
        --access-config authenticationMode=API_AND_CONFIG_MAP \
        --query "update.id" --output text)

    while true; do
        STATUS=$(invoke_aws eks describe-update --name "$CLUSTER_NAME" --region "$REGION" --update-id "$UPDATE_ID" --query "update.status" --output text)
        if [[ "$STATUS" == "Successful" ]]; then
            echo "Update Successful."
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

# 4. Create Access Entry
echo "Registering access entry..."
if ! invoke_aws eks create-access-entry \
    --cluster-name "$CLUSTER_NAME" \
    --region "$REGION" \
    --principal-arn "$BASE_ROLE_ARN" \
    --type STANDARD > /dev/null 2>&1; then
    echo "Access entry already exists or registration skipped."
fi

# 5. Associate Admin Policy
echo "Associating AmazonEKSClusterAdminPolicy..."
invoke_aws eks associate-access-policy \
    --cluster-name "$CLUSTER_NAME" \
    --region "$REGION" \
    --principal-arn "$BASE_ROLE_ARN" \
    --policy-arn "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy" \
    --access-scope type=cluster > /dev/null

echo -e "\nSUCCESS: Access granted. You can now run your cleanup script."
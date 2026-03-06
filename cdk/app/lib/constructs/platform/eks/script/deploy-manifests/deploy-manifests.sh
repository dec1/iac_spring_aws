#!/usr/bin/env bash
# lib\constructs\platform\eks\manifest\scripts\deploy-manifests.sh
set -euo pipefail

# -------------------------------------------------------
# deploy-manifests.sh
#
# Resolves __PLACEHOLDER__ tokens in K8s manifest templates using CDK/CloudFormation outputs,
# writes the result to a generated/ directory, and optionally runs kubectl apply.
#
# Usage:
#   # Local (with profile):
#   ./deploy-manifests.sh --stack-name my-backend-k8s-dev --profile myb --apply
#
#   # CI (uses ambient credentials):
#   ./deploy-manifests.sh --stack-name my-backend-k8s-dev --apply
#
#   # Resolve only (no apply):
#   ./deploy-manifests.sh --stack-name my-backend-k8s-dev
#
#   # Optional: force kubectl to assume a specific role when generating kubeconfig:
#   ./deploy-manifests.sh --stack-name my-backend-k8s-dev --kubectl-role-arn arn:aws:iam::123:role/my-role --apply
# -------------------------------------------------------

STACK_NAME=""
IDENTITY_STACK_NAME=""
PROFILE=""
APPLY=false
REPO_ROOT=""
KUBECTL_ROLE_ARN=""

# -------------------------------------------------------
# Webhook readiness gate settings (used only when --apply)
#
# Purpose:
#   The AWS Load Balancer Controller installs admission webhooks for Service/Ingress.
#   Right after an infra deploy/rollout, the webhook Service can exist but have no ready
#   endpoints yet. If we "kubectl apply" during that window, the API server rejects the
#   resources with:
#     "no endpoints available for service aws-load-balancer-webhook-service"
#
#   Putting the wait here ensures kubeconfig is already set (works in clean CI containers).
# -------------------------------------------------------
ALB_WEBHOOK_NAMESPACE="${ALB_WEBHOOK_NAMESPACE:-kube-system}"
ALB_WEBHOOK_SERVICE_NAME="${ALB_WEBHOOK_SERVICE_NAME:-aws-load-balancer-webhook-service}"
ALB_CONTROLLER_LABEL="${ALB_CONTROLLER_LABEL:-app.kubernetes.io/name=aws-load-balancer-controller}"
ALB_WEBHOOK_MAX_ATTEMPTS="${ALB_WEBHOOK_MAX_ATTEMPTS:-60}"
ALB_WEBHOOK_SLEEP_SECONDS="${ALB_WEBHOOK_SLEEP_SECONDS:-5}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --stack-name)       STACK_NAME="$2"; shift 2 ;;
        --identity-stack)   IDENTITY_STACK_NAME="$2"; shift 2 ;;
        --profile)          PROFILE="$2"; shift 2 ;;
        --repo-root)        REPO_ROOT="$2"; shift 2 ;;
        --kubectl-role-arn) KUBECTL_ROLE_ARN="$2"; shift 2 ;;
        --apply)            APPLY=true; shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

if [[ -z "$STACK_NAME" ]]; then
    echo "Usage: $0 --stack-name <stack-name> [--profile <profile>] [--identity-stack <name>] [--repo-root <path>] [--kubectl-role-arn <arn>] [--apply]"
    exit 1
fi

# -------------------------------------------------------
# Resolve paths
# -------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../template"
GENERATED_DIR="$SCRIPT_DIR/../generated"

if [[ -z "$REPO_ROOT" ]]; then
    # Default: assume script is at <repo>/cdk/app/lib/constructs/platform/eks/manifest/scripts/
    REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../../../../.." && pwd)"
fi

CONFIG_COMMON="$REPO_ROOT/config_common.yaml"
CDK_CONFIG="$REPO_ROOT/cdk/config.yaml"

# -------------------------------------------------------
# Helper: aws cli with optional --profile
# -------------------------------------------------------
run_aws() {
    if [[ -n "$PROFILE" ]]; then
        aws "$@" --profile "$PROFILE"
    else
        aws "$@"
    fi
}

# -------------------------------------------------------
# Helper: get a specific CloudFormation output value
# -------------------------------------------------------
get_stack_output() {
    local stack="$1"
    local key="$2"
    run_aws cloudformation describe-stacks \
        --stack-name "$stack" \
        --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" \
        --output text
}

# -------------------------------------------------------
# Helper: get stack ARN (used to derive region/account reliably)
# -------------------------------------------------------
get_stack_arn() {
    local stack="$1"
    run_aws cloudformation describe-stacks \
        --stack-name "$stack" \
        --query "Stacks[0].StackId" \
        --output text
}

# -------------------------------------------------------
# Helper: wait for AWS LB Controller webhook endpoints (requires kubeconfig already set)
# -------------------------------------------------------
wait_for_alb_webhook_endpoints() {
    local ns="$1"
    local svc="$2"
    local max_attempts="$3"
    local sleep_seconds="$4"

    echo "Waiting for ${svc} endpoints in ${ns} (max ${max_attempts} attempts, ${sleep_seconds}s sleep)..."

    # If the Service itself doesn't exist, fail fast with useful context.
    if ! kubectl -n "${ns}" get svc "${svc}" >/dev/null 2>&1; then
        echo "ERROR: Service ${ns}/${svc} not found. Is aws-load-balancer-controller installed?"
        kubectl -n "${ns}" get svc | sed -n '1,200p' || true
        kubectl -n "${ns}" get pods -l "${ALB_CONTROLLER_LABEL}" -o wide || true
        return 1
    fi

    local ep=""
    local i=""
    for i in $(seq 1 "${max_attempts}"); do
        ep="$(kubectl -n "${ns}" get endpoints "${svc}" -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null || true)"
        if [[ -n "${ep}" ]]; then
            echo "Webhook endpoints ready: ${ep}"
            return 0
        fi
        sleep "${sleep_seconds}"
    done

    echo "ERROR: webhook endpoints still empty after waiting"
    kubectl -n "${ns}" get pods,svc,endpoints || true
    kubectl -n "${ns}" get pods -l "${ALB_CONTROLLER_LABEL}" -o wide || true
    return 1
}

# -------------------------------------------------------
# 1. Read config_common.yaml
# -------------------------------------------------------
echo "Reading $CONFIG_COMMON ..."

if [[ ! -f "$CONFIG_COMMON" ]]; then
    echo "ERROR: config_common.yaml not found at: $CONFIG_COMMON. Use --repo-root to specify the repo root."
    exit 1
fi

# Simple YAML parser for flat key: value pairs
SERVICE_NAME=$(grep -E '^\s*serviceName\s*:' "$CONFIG_COMMON" | sed 's/.*:\s*"\?\([^"#]*\)"\?.*/\1/' | tr -d '[:space:]')
IMAGE_REPO_NAME=$(grep -E '^\s*imageRepositoryName\s*:' "$CONFIG_COMMON" | sed 's/.*:\s*"\?\([^"#]*\)"\?.*/\1/' | tr -d '[:space:]')
APP_VERSION=$(grep -E '^\s*appVersion\s*:' "$CONFIG_COMMON" | sed 's/.*:\s*"\?\([^"#]*\)"\?.*/\1/' | tr -d '[:space:]')

if [[ -z "$SERVICE_NAME" || -z "$IMAGE_REPO_NAME" || -z "$APP_VERSION" ]]; then
    echo "ERROR: config_common.yaml must contain serviceName, imageRepositoryName, and appVersion"
    exit 1
fi

# Default identity stack name: <serviceName>-identity
if [[ -z "$IDENTITY_STACK_NAME" ]]; then
    IDENTITY_STACK_NAME="${SERVICE_NAME}-identity"
fi

echo "  serviceName:         $SERVICE_NAME"
echo "  imageRepositoryName: $IMAGE_REPO_NAME"
echo "  appVersion:          $APP_VERSION"
echo "  identityStackName:   $IDENTITY_STACK_NAME"

# -------------------------------------------------------
# 1b. Read config.yaml (CDK config -- for appPortNum, healthCheckPath)
# -------------------------------------------------------

echo "Reading $CDK_CONFIG ..."

if [[ ! -f "$CDK_CONFIG" ]]; then
    echo "ERROR: config.yaml not found at: $CDK_CONFIG"
    exit 1
fi

APP_PORT=$(grep -E '^\s*appPortNum\s*:' "$CDK_CONFIG" | sed 's/.*:\s*"\?\([^"#]*\)"\?.*/\1/' | tr -d '[:space:]')
HEALTH_CHECK_PATH=$(grep -A20 '^_defaults:' "$CDK_CONFIG" | grep -E '^\s+healthCheckPath\s*:' | head -1 | sed 's/.*:\s*"\?\([^"#]*\)"\?.*/\1/' | tr -d '[:space:]')

if [[ -z "$APP_PORT" ]]; then
    echo "ERROR: config.yaml must contain appPortNum"
    exit 1
fi
if [[ -z "$HEALTH_CHECK_PATH" ]]; then
    HEALTH_CHECK_PATH="/actuator/health"
    echo "  healthCheckPath:     $HEALTH_CHECK_PATH (default -- not found in config.yaml)"
else
    echo "  healthCheckPath:     $HEALTH_CHECK_PATH"
fi
echo "  appPortNum:          $APP_PORT"

# -------------------------------------------------------
# 2. Query app stack outputs
# -------------------------------------------------------
echo "Querying stack '$STACK_NAME' ..."

CERT_ARN=$(get_stack_output "$STACK_NAME" "EksCertificateArn")
WEB_ACL_ARN=$(get_stack_output "$STACK_NAME" "EksWebAclArn")
HOSTNAME=$(get_stack_output "$STACK_NAME" "EksHostname")
S3_BUCKET=$(get_stack_output "$STACK_NAME" "S3BucketName")
EKS_CLUSTER_NAME=$(get_stack_output "$STACK_NAME" "EksClusterName")

# Optional: new output (for CI kubectl assume-role).
# If the stack hasn't been redeployed yet, this key won't exist; keep it best-effort.
if [[ -z "$KUBECTL_ROLE_ARN" ]]; then
    candidate_role_arn="$(get_stack_output "$STACK_NAME" "EksDeployRoleArn" 2>/dev/null || true)"
    if [[ -n "$candidate_role_arn" && "$candidate_role_arn" != "None" && "$candidate_role_arn" != "null" ]]; then
        KUBECTL_ROLE_ARN="$candidate_role_arn"
    fi
fi

# NOTE:
# We must NOT derive region/account from the ACM cert ARN.
# In "no custom domain" mode the cert output is intentionally a placeholder string,
# which then breaks AWS CLI region parsing.
STACK_ARN=$(get_stack_arn "$STACK_NAME")
AWS_REGION=$(echo "$STACK_ARN" | cut -d: -f4)
ACCOUNT_ID=$(echo "$STACK_ARN" | cut -d: -f5)

if [[ -z "$AWS_REGION" || -z "$ACCOUNT_ID" || "$AWS_REGION" == "None" || "$ACCOUNT_ID" == "None" ]]; then
    echo "ERROR: Failed to derive region/account from stack ARN: $STACK_ARN"
    exit 1
fi

# Derive staging environment from stack name
if [[ "$STACK_NAME" =~ -(dev|release)$ ]]; then
    STAGING_ENV="${BASH_REMATCH[1]}"
else
    echo "ERROR: Cannot derive staging environment from stack name '$STACK_NAME'. Expected -dev or -release suffix."
    exit 1
fi

echo "  region:      $AWS_REGION"
echo "  account:     $ACCOUNT_ID"
echo "  environment: $STAGING_ENV"
echo "  hostname:    $HOSTNAME"
echo "  certArn:     $CERT_ARN"
echo "  webAclArn:   $WEB_ACL_ARN"
echo "  s3Bucket:    $S3_BUCKET"
echo "  clusterName: $EKS_CLUSTER_NAME"
if [[ -n "$KUBECTL_ROLE_ARN" ]]; then
    echo "  kubectlRole: $KUBECTL_ROLE_ARN"
fi

# Determine if we have a custom domain configured.
# If not, we still deploy the ALB and app, but we must generate an HTTP-only hostless Ingress.
NOT_CONFIGURED_DOMAIN="not-configured (no apexDomain/hostedZoneId)"
HAS_CUSTOM_DOMAIN=true
if [[ "$CERT_ARN" == "$NOT_CONFIGURED_DOMAIN" || "$HOSTNAME" == "$NOT_CONFIGURED_DOMAIN" ]]; then
    HAS_CUSTOM_DOMAIN=false
elif [[ ! "$CERT_ARN" =~ ^arn:aws:acm:[^:]+:[0-9]{12}:certificate/.+ ]]; then
    HAS_CUSTOM_DOMAIN=false
fi

# -------------------------------------------------------
# 3. Query identity stack for Issuer URI
# -------------------------------------------------------
echo "Querying stack '$IDENTITY_STACK_NAME' ..."

ISSUER_URI=$(get_stack_output "$IDENTITY_STACK_NAME" "IssuerUriOutput")

echo "  issuerUri:   $ISSUER_URI"

# -------------------------------------------------------
# 4. Build ECR image URI
# -------------------------------------------------------
ECR_IMAGE_URI="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$IMAGE_REPO_NAME:$APP_VERSION"
echo "  imageUri:    $ECR_IMAGE_URI"

# -------------------------------------------------------
# 5. Replace placeholders in template files -> generated/
# -------------------------------------------------------
echo "Generating manifests ..."

rm -rf "$GENERATED_DIR"
mkdir -p "$GENERATED_DIR"

# Escape values used in sed replacements (prevents sed parse errors if values contain '&', '\' or '|')
escape_sed_replacement() {
    printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

ECR_IMAGE_URI_ESC="$(escape_sed_replacement "$ECR_IMAGE_URI")"
ISSUER_URI_ESC="$(escape_sed_replacement "$ISSUER_URI")"
S3_BUCKET_ESC="$(escape_sed_replacement "$S3_BUCKET")"
WEB_ACL_ARN_ESC="$(escape_sed_replacement "$WEB_ACL_ARN")"

# In no-domain mode, substitute empty strings for cert/hostname (then post-process ingress.yaml).
CERT_ARN_SUB="$CERT_ARN"
HOSTNAME_SUB="$HOSTNAME"
if ! $HAS_CUSTOM_DOMAIN; then
    CERT_ARN_SUB=""
    HOSTNAME_SUB=""
fi
CERT_ARN_ESC="$(escape_sed_replacement "$CERT_ARN_SUB")"
HOSTNAME_ESC="$(escape_sed_replacement "$HOSTNAME_SUB")"

for tmpl in "$TEMPLATE_DIR"/*.yaml; do
    filename=$(basename "$tmpl")
    sed \
        -e "s|__ECR_IMAGE_URI__|$ECR_IMAGE_URI_ESC|g" \
        -e "s|__AWS_REGION__|$AWS_REGION|g" \
        -e "s|__SERVICE_NAME__|$SERVICE_NAME|g" \
        -e "s|__STAGING_ENVIRONMENT__|$STAGING_ENV|g" \
        -e "s|__ISSUER_URI__|$ISSUER_URI_ESC|g" \
        -e "s|__S3_BUCKET_NAME__|$S3_BUCKET_ESC|g" \
        -e "s|__EKS_CERTIFICATE_ARN__|$CERT_ARN_ESC|g" \
        -e "s|__EKS_WEB_ACL_ARN__|$WEB_ACL_ARN_ESC|g" \
        -e "s|__EKS_HOSTNAME__|$HOSTNAME_ESC|g" \
        -e "s|__APP_PORT__|$APP_PORT|g" \
        -e "s|__HEALTH_CHECK_PATH__|$HEALTH_CHECK_PATH|g" \
        "$tmpl" > "$GENERATED_DIR/$filename"

    # In no-domain mode, convert the Ingress to HTTP-only and hostless so the ALB DNS name works.
    if ! $HAS_CUSTOM_DOMAIN && [[ "$filename" == "ingress.yaml" ]]; then
        tmpfile="$GENERATED_DIR/.${filename}.tmp"

        # Remove TLS + ExternalDNS annotations, flip listen-ports to HTTP, and remove host rule.
        grep -v -E '^    alb\.ingress\.kubernetes\.io/(certificate-arn|ssl-policy|ssl-redirect|actions\.ssl-redirect):' "$GENERATED_DIR/$filename" \
          | grep -v -E '^    external-dns\.alpha\.kubernetes\.io/hostname:' \
          | sed \
              -e "s|^    alb\.ingress\.kubernetes\.io/listen-ports:.*|    alb.ingress.kubernetes.io/listen-ports: '[{\"HTTP\": 80}]'|" \
              -e "s|^    - host: .*|    - http:|" \
              -e '/^      http:$/d' \
              > "$tmpfile"

        mv "$tmpfile" "$GENERATED_DIR/$filename"
    fi

    # Check for any remaining placeholders
    remaining=$(grep -oE '__[A-Z_]+__' "$GENERATED_DIR/$filename" || true)
    if [[ -n "$remaining" ]]; then
        echo "  WARNING: $filename has unresolved placeholders: $(echo "$remaining" | sort -u | tr '\n' ' ')"
    fi

    echo "  wrote $GENERATED_DIR/$filename"
done

# -------------------------------------------------------
# 6. Optionally apply
# -------------------------------------------------------
if $APPLY; then
    echo "Applying manifests ..."

    # Configure kubectl for this cluster (idempotent)
    if [[ -n "$KUBECTL_ROLE_ARN" ]]; then
        run_aws eks update-kubeconfig --name "$EKS_CLUSTER_NAME" --region "$AWS_REGION" --role-arn "$KUBECTL_ROLE_ARN" > /dev/null
    else
        run_aws eks update-kubeconfig --name "$EKS_CLUSTER_NAME" --region "$AWS_REGION" > /dev/null
    fi

    # Webhook readiness gate (Ingress/Service admission)
    wait_for_alb_webhook_endpoints \
        "${ALB_WEBHOOK_NAMESPACE}" \
        "${ALB_WEBHOOK_SERVICE_NAME}" \
        "${ALB_WEBHOOK_MAX_ATTEMPTS}" \
        "${ALB_WEBHOOK_SLEEP_SECONDS}"

    kubectl apply -f "$GENERATED_DIR"

    echo ""
    echo "Waiting for rollout ..."
    kubectl rollout status "deployment/$SERVICE_NAME" --timeout=300s

    echo ""
    echo "Checking ingress ..."
    kubectl get ingress "${SERVICE_NAME}-ingress"

    echo ""
    if $HAS_CUSTOM_DOMAIN; then
        echo "Done. ExternalDNS will create the Route53 record within ~1 minute."
        echo "Test with: curl https://$HOSTNAME/actuator/health"
    else
        echo "Done. Custom domain is not configured; using ALB DNS name over HTTP."
        echo "Get the ALB DNS name with: kubectl get ingress ${SERVICE_NAME}-ingress"
        echo "Then test with: curl http://<ALB_DNS_NAME>$HEALTH_CHECK_PATH"
    fi
else
    echo ""
    echo "Manifests written to $GENERATED_DIR"
    echo "To apply: kubectl apply -f $GENERATED_DIR"
    echo "Or re-run with --apply flag."
fi
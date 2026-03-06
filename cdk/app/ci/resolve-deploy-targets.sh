#!/usr/bin/env bash
# resolve-deploy-targets.sh
#
# Reads config.yaml to discover which environment blocks exist and their computePlatform.
# Outputs KEY=VALUE lines suitable for sourcing (bash) or appending to $GITHUB_ENV.
#
# Usage:
#   eval $(./resolve-deploy-targets.sh)                          # bash: source into current shell
#   ./resolve-deploy-targets.sh >> "$GITHUB_ENV"                 # GitHub Actions: export to job env
#   ./resolve-deploy-targets.sh > /tmp/deploy_targets.env        # write to file for later sourcing
#
# Output variables:
#   HAS_ECS_DEV=true/false
#   HAS_ECS_RELEASE=true/false
#   HAS_K8S_DEV=true/false
#   HAS_K8S_RELEASE=true/false
#
# An environment block is any top-level key in config.yaml that is NOT in the reserved set
# (_defaults, serviceName, imageSource, etc.). Each block's computePlatform (default: ecs)
# determines which deploy path to use.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${1:-$SCRIPT_DIR/../../config.yaml}"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: config.yaml not found at $CONFIG" >&2
  exit 1
fi

# Reserved top-level keys (not environment blocks)
RESERVED="serviceName|imageSource|imageRepositoryName|appVersion|apexDomain|hostedZoneId|eksAdminRoleArn|appPortNum|terminationWaitTimeMinutes|wantGrafana|ci|_defaults|account|region|productName|apiName"

# Parse environment blocks and their computePlatform.
# We track which section we're in and look for computePlatform within each section.
HAS_ECS_DEV=false
HAS_ECS_RELEASE=false
HAS_K8S_DEV=false
HAS_K8S_RELEASE=false

current_section=""
current_platform=""
current_staging=""

emit_section() {
  if [[ -z "$current_section" ]]; then return; fi
  # Skip reserved keys
  if echo "$current_section" | grep -qE "^($RESERVED)$"; then return; fi

  local platform="${current_platform:-ecs}"
  local staging="${current_staging:-}"

  case "${platform}:${staging}" in
    ecs:dev)          HAS_ECS_DEV=true ;;
    ecs:release)      HAS_ECS_RELEASE=true ;;
    kubernetes:dev)   HAS_K8S_DEV=true ;;
    kubernetes:release) HAS_K8S_RELEASE=true ;;
  esac
}

while IFS= read -r line; do
  # Skip comments and blank lines
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue

  # Top-level key with no value on the same line (section header like "dev:", "_defaults:")
  if [[ "$line" =~ ^([a-zA-Z0-9_-]+)[[:space:]]*:[[:space:]]*$ ]]; then
    emit_section
    current_section="${BASH_REMATCH[1]}"
    current_platform=""
    current_staging=""
  # Top-level key with a value (like "appPortNum: 8080") -- not a section, skip
  elif [[ "$line" =~ ^[a-zA-Z0-9_-]+[[:space:]]*:[[:space:]]*[^[:space:]] ]]; then
    emit_section
    current_section=""
  # Indented key: value within a section
  elif [[ -n "$current_section" ]]; then
    if [[ "$line" =~ ^[[:space:]]+computePlatform[[:space:]]*:[[:space:]]*\"?([^\"#]+)\"? ]]; then
      current_platform="$(echo "${BASH_REMATCH[1]}" | tr -d '[:space:]')"
    fi
    if [[ "$line" =~ ^[[:space:]]+stagingEnvironment[[:space:]]*:[[:space:]]*\"?([^\"#]+)\"? ]]; then
      current_staging="$(echo "${BASH_REMATCH[1]}" | tr -d '[:space:]')"
    fi
  fi
done < "$CONFIG"
# Don't forget the last section
emit_section

echo "HAS_ECS_DEV=$HAS_ECS_DEV"
echo "HAS_ECS_RELEASE=$HAS_ECS_RELEASE"
echo "HAS_K8S_DEV=$HAS_K8S_DEV"
echo "HAS_K8S_RELEASE=$HAS_K8S_RELEASE"
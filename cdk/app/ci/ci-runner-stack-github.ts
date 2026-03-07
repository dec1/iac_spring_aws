import { Construct } from 'constructs';
import { CiRunnerStackBase, CiRunnerStackBaseProps } from './ci-runner-stack';

export interface GithubRunnerStackProps extends CiRunnerStackBaseProps {
  /**
   * Where to register the runner:
   * - org-level:  https://github.com/<org>   + use /orgs/<org>/actions/runners/registration-token
   * - repo-level: https://github.com/<org>/<repo> + use /repos/<org>/<repo>/actions/runners/registration-token
   */
  readonly githubScope: 'org' | 'repo';
  readonly githubOrg: string;
  readonly githubRepo?: string;

  /**
   * GitHub "labels" for runs-on targeting.
   * - Always includes: self-hosted, linux, x64 (added by GitHub automatically).
   * - Add at least one custom label so workflows can target this runner (e.g. "my-backend-runner-label").
   */
  readonly runnerLabels: string[];
}

export class GithubRunnerStack extends CiRunnerStackBase {
  constructor(scope: Construct, id: string, props: GithubRunnerStackProps) {
    super(scope, id, props);
  }

  protected addProviderUserData(props: GithubRunnerStackProps): void {
    // Build the API endpoint for registration-token
    const regTokenApi =
      props.githubScope === 'org'
        ? `https://api.github.com/orgs/${props.githubOrg}/actions/runners/registration-token`
        : `https://api.github.com/repos/${props.githubOrg}/${props.githubRepo}/actions/runners/registration-token`;

    const labelCsv = props.runnerLabels.join(',');

    this.userData.addCommands(
      // Create user + working dir
      'id -u actions >/dev/null 2>&1 || useradd --comment "GitHub Actions Runner" --create-home actions --shell /bin/bash',
      'mkdir -p /opt/actions-runner',
      'chown -R actions:actions /opt/actions-runner',

      // Runner user should be able to use Docker for container-based workflows.
      'usermod -a -G docker actions || true',

      // AL2023: GitHub runner uses dotnet; libicu and friends are required.
      // installdependencies.sh does not reliably detect AL2023, so install explicitly.
      'dnf install -y libicu openssl-libs krb5-libs zlib libunwind lttng-ust || true',

      // Download runner (pinning is better; kept simple here)
      // NOTE: replace the URL/version with a pinned version once you choose one.
      'cd /opt/actions-runner',
      // Pin the runner version.
      // Why: the "latest" tarball URL can return a tiny HTML redirect/response, which then fails extraction.
      'RUNNER_VERSION="2.331.0"',
      'RUNNER_TAR="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"',
      'RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_TAR}"',
      'curl -fL --retry 5 --retry-delay 2 -o actions-runner-linux-x64.tar.gz "$RUNNER_URL"',
      'tar xzf actions-runner-linux-x64.tar.gz',
      'chown -R actions:actions /opt/actions-runner',

      // Utility: mask a token for safe logging -- shows first 3 and last 3 characters,
      // replaces everything in between with lowercase "x".
      'mask_token() {',
      '  local t="$1"',
      '  local len=${#t}',
      '  if [ "$len" -le 6 ]; then',
      '    printf "%s" "$(printf "x%.0s" $(seq 1 "$len"))"',
      '  else',
      '    local mid=$((len - 6))',
      '    printf "%s%s%s" "${t:0:3}" "$(printf "x%.0s" $(seq 1 "$mid"))" "${t: -3}"',
      '  fi',
      '}',

      // Register only once -- skip straight to service start if already configured.
      'if [ -f /opt/actions-runner/.runner ]; then',
      '  echo "GitHub Actions runner already configured. Skipping registration."',
      'else',

      // Retry loop: keeps trying registration every 60s until it succeeds.
      // This allows the operator to update the secret in Secrets Manager externally
      // (e.g. create a new PAT or registration token) without having to reboot the instance.
      '  while true; do',

      // Fetch secret from Secrets Manager (runtime)
      //
      // This secret may contain either:
      // - a GitHub PAT / token that can call the registration-token API (recommended), OR
      // - a one-time runner registration token (expires quickly; use only for ad-hoc bootstrap).
      `    GITHUB_TOKEN="$(aws secretsmanager get-secret-value --secret-id ${props.secretName} --region ${this.region} --query SecretString --output text)"`,
      '    if [ -z "$GITHUB_TOKEN" ]; then',
      '      echo "WARNING: GitHub token is empty (Secrets Manager fetch failed). Retrying in 60s..."',
      '      sleep 60',
      '      continue',
      '    fi',
      '    echo "Fetched token: $(mask_token "$GITHUB_TOKEN")"',
      '',

      '    echo "Determining how to obtain a registration token..."',
      '    IS_PAT="false"',
      '    case "$GITHUB_TOKEN" in',
      '      ghp_*|github_pat_*|gho_*|ghu_*|ghs_*|ghr_*) IS_PAT="true" ;;',
      '    esac',
      '',

      '    REG_TOKEN=""',
      '    REG_FAILED="false"',
      '    if [ "$IS_PAT" = "true" ]; then',
      '      echo "Secret looks like a GitHub token/PAT; requesting a registration token via API..."',
      // Capture HTTP status so we can fail with a clearer error if the token is invalid.
      '      HTTP_CODE="$(curl -sS -o /tmp/gh_reg.json -w "%{http_code}" -X POST \\',
      `        -H "Authorization: token $GITHUB_TOKEN" \\`,
      '        -H "Accept: application/vnd.github+json" \\',
      `        "${regTokenApi}")"`,
      '      if [ "$HTTP_CODE" != "201" ]; then',
      '        echo "WARNING: GitHub registration-token API call failed (HTTP $HTTP_CODE). Response:"',
      '        cat /tmp/gh_reg.json || true',
      '        REG_FAILED="true"',
      '      else',
      '        REG_TOKEN="$(cat /tmp/gh_reg.json | sed -n \'s/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\')"',
      '        if [ -z "$REG_TOKEN" ]; then',
      '          echo "WARNING: Could not parse registration token from API response."',
      '          cat /tmp/gh_reg.json || true',
      '          REG_FAILED="true"',
      '        fi',
      '      fi',
      '    else',
      '      echo "Secret does not look like a PAT; treating it as a runner registration token (must still be valid)."',
      '      REG_TOKEN="$GITHUB_TOKEN"',
      '    fi',
      '',

      // If token acquisition failed, wait and re-fetch from Secrets Manager.
      '    if [ "$REG_FAILED" = "true" ]; then',
      '      echo "Registration token acquisition failed. Retrying in 60s (update the secret in Secrets Manager if needed)..."',
      '      sleep 60',
      '      continue',
      '    fi',
      '',

      // Configure runner
      `    if su - actions -c 'cd /opt/actions-runner && ./config.sh --unattended --replace --url "https://github.com/${props.githubOrg}${props.githubScope === 'repo' ? `/${props.githubRepo}` : ''}" --token "'"$REG_TOKEN"'" --labels "${labelCsv}" --name "aws-ec2-${props.serviceName}"'; then`,
      '      echo "Runner registration succeeded."',
      '      break',
      '    else',
      '      echo "WARNING: config.sh failed. Retrying in 60s (update the secret in Secrets Manager if needed)..."',
      '      sleep 60',
      '      continue',
      '    fi',
      '',

      '  done',
      'fi',

      // Install + start as a service
      'cd /opt/actions-runner',
      './svc.sh install actions || true',
      '',
      // Make AWS environment available to all GitHub Actions jobs on this runner (mirrors GitLab runner --env injection).
      //
      // GitHub Actions runner does not support a `--env ...` equivalent at registration time, so we inject env vars
      // into the runner\'s systemd service so every workflow step inherits them.
      'SERVICE_UNIT="$(ls /etc/systemd/system/actions.runner*.service 2>/dev/null | head -n 1)"',
      'if [ -n "$SERVICE_UNIT" ]; then',
      '  SERVICE_NAME="$(basename "$SERVICE_UNIT")"',
      '  mkdir -p "/etc/systemd/system/${SERVICE_NAME}.d"',
      `  cat > "/etc/systemd/system/\${SERVICE_NAME}.d/10-aws-env.conf" <<'EOF'
[Service]
Environment=AWS_REGION=${this.region}
Environment=AWS_DEFAULT_REGION=${this.region}
Environment=AWS_ACCOUNT_ID=${this.account}
EOF`,
      '  systemctl daemon-reload',
      'fi',
      './svc.sh start || true',

      'echo "GitHub Actions Runner bootstrap completed."'
    );
  }
}
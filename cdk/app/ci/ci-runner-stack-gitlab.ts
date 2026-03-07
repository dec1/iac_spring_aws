import { Construct } from 'constructs';
import { CiRunnerStackBase, CiRunnerStackBaseProps } from './ci-runner-stack';

export interface GitlabRunnerStackProps extends CiRunnerStackBaseProps {
  readonly gitlabUrl: string;
  // Must match the tag used in .gitlab web ui when configuring runner
  readonly runnerTag: string;
}

export class GitlabRunnerStack extends CiRunnerStackBase {
  constructor(scope: Construct, id: string, props: GitlabRunnerStackProps) {
    super(scope, id, props);
  }

  protected addProviderUserData(props: GitlabRunnerStackProps): void {
    this.userData.addCommands(
      // GitLab Runner binary
      'curl -L --output /usr/local/bin/gitlab-runner https://gitlab-runner-downloads.s3.amazonaws.com/latest/binaries/gitlab-runner-linux-amd64',
      'chmod +x /usr/local/bin/gitlab-runner',

      // Runner user
      'id -u gitlab-runner >/dev/null 2>&1 || useradd --comment "GitLab Runner" --create-home gitlab-runner --shell /bin/bash',

      // Install + start service (safe to re-run)
      'gitlab-runner install --user=gitlab-runner --working-directory=/home/gitlab-runner || true',
      'gitlab-runner start || true',

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

      // Register runner only once (avoid duplicate runners after reboot)
      //
      // Why we check for [[runners]]:
      // - GitLab Runner will start even with an "empty" /etc/gitlab-runner/config.toml (it then has no registered runners).
      // - The reliable signal that registration actually happened is the presence of a [[runners]] block in config.toml.
      // - Previously, touching/creating config.toml could cause us to skip registration even though there was no [[runners]] entry.
      //
      // Note on tags:
      // - With "runner authentication tokens" (glrt-*), GitLab reserves certain settings (including tags, locked, run-untagged, etc.)
      //   to server-side configuration. This is why we do NOT pass --tag-list/--locked/etc. on the register command.
      // - Runner tags must be configured in the GitLab UI/API to match pipeline `tags:` (e.g. my-backend-runner).
      'mkdir -p /etc/gitlab-runner',
      'if [ -f /etc/gitlab-runner/config.toml ] && grep -q "^\\[\\[runners\\]\\]" /etc/gitlab-runner/config.toml; then',
      '  echo "GitLab Runner already registered (config.toml contains [[runners]]). Skipping registration."',
      'else',
      '  echo "Registering GitLab Runner (first boot or config missing)..."',

      // Retry loop: keeps trying registration every 60s until it succeeds.
      // This allows the operator to update the secret in Secrets Manager externally
      // (e.g. rotate the glrt-* token in the GitLab UI) without having to reboot the instance.
      '  while true; do',

      // Fetch token from Secrets Manager (runtime) -- re-fetched each iteration so that
      // an externally updated secret is picked up without a reboot.
      `    TOKEN="$(aws secretsmanager get-secret-value --secret-id ${props.secretName} --region ${this.region} --query SecretString --output text)"`,
      '    if [ -z "$TOKEN" ]; then',
      '      echo "WARNING: Runner token is empty (Secrets Manager fetch failed). Retrying in 60s..."',
      '      sleep 60',
      '      continue',
      '    fi',
      '    echo "Fetched token: $(mask_token "$TOKEN")"',

      // Safety: detect new-workflow tokens and clarify behavior.
      '    if echo "$TOKEN" | grep -q "^glrt-"; then echo "Using glrt-* runner auth token (new workflow). Runner tags must be configured in GitLab UI."; fi',

      `    echo "Registering runner against: ${props.gitlabUrl}"`,
      `    if gitlab-runner register --non-interactive \\`,
      `      --url "${props.gitlabUrl}" \\`,
      `      --token "$TOKEN" \\`,
      `      --executor "docker" \\`,
      `      --docker-image "docker:latest" \\`,
      `      --description "AWS-EC2-Runner-${props.serviceName}" \\`,
      `      --docker-privileged \\`,
      `      --env "AWS_REGION=${this.region}" \\`,
      `      --env "AWS_DEFAULT_REGION=${this.region}" \\`,
      `      --env "AWS_ACCOUNT_ID=${this.account}" \\`,
      `      --docker-volumes "/var/run/docker.sock:/var/run/docker.sock"; then`,
      '      echo "Runner registration succeeded."',
      '      break',
      '    else',
      '      echo "WARNING: gitlab-runner register failed. Retrying in 60s (update the secret in Secrets Manager if needed)..."',
      '      sleep 60',
      '      continue',
      '    fi',
      '',
      '  done',

      '  if [ ! -f /etc/gitlab-runner/config.toml ] || ! grep -q "^\\[\\[runners\\]\\]" /etc/gitlab-runner/config.toml; then',
      '    echo "ERROR: registration did not create a runner entry in config.toml";',
      '    exit 1;',
      '  fi',
      'fi',

      // Restart to ensure it picks up config cleanly
      'gitlab-runner restart || true',

      'echo "GitLab Runner bootstrap completed."'
    );
  }
}
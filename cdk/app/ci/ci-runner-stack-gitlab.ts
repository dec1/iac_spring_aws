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

      // Fetch token from Secrets Manager (runtime)
      `TOKEN="$(aws secretsmanager get-secret-value --secret-id ${props.secretName} --region ${this.region} --query SecretString --output text)"`,
      'if [ -z "$TOKEN" ]; then echo "ERROR: Runner token is empty (Secrets Manager fetch failed)"; exit 1; fi',

      // Install + start service (safe to re-run)
      'gitlab-runner install --user=gitlab-runner --working-directory=/home/gitlab-runner || true',
      'gitlab-runner start || true',

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

      // Safety: detect new-workflow tokens and clarify behavior.
      'if echo "$TOKEN" | grep -q "^glrt-"; then echo "Using glrt-* runner auth token (new workflow). Runner tags must be configured in GitLab UI."; fi',

      '  for i in 1 2 3 4 5; do',
      `    gitlab-runner register --non-interactive \\`,
      `      --url "${props.gitlabUrl}" \\`,
      `      --token "$TOKEN" \\`,
      `      --executor "docker" \\`,
      `      --docker-image "docker:latest" \\`,
      `      --description "AWS-EC2-Runner-${props.serviceName}" \\`,
      `      --docker-privileged \\`,
      `      --env "AWS_REGION=${this.region}" \\`,
      `      --env "AWS_DEFAULT_REGION=${this.region}" \\`,
      `      --env "AWS_ACCOUNT_ID=${this.account}" \\`,
      `      --docker-volumes "/var/run/docker.sock:/var/run/docker.sock" && break || true`,
      '    echo "Register attempt $i failed; sleeping 10s..."',
      '    sleep 10',
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

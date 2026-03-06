import * as cdk from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { AppConfig } from '../config/config-reader';
import { GitlabRunnerStack } from '../ci/ci-runner-stack-gitlab';
import { GithubRunnerStack } from '../ci/ci-runner-stack-github';
import { ciConfig } from '../config/ci-config';

//-----------------------------------------------------------------------------------------
// 3. CI Runner Stacks (GitLab / GitHub)
//-----------------------------------------------------------------------------------------
// Deployed manually once - captures region/account from your active AWS profile
// Runner instance uses these same values when deploying dev/release in CI
export function createCiRunnerStacks(
  app: cdk.App,
  serviceName: string,
  env: { account: string; region: string },
  appConfig: AppConfig,
  devStack: AppStack
) {

   const conf = ciConfig(appConfig, serviceName);


  if (conf.hasGitlabCiConfig) {
    const gitlabRunnerStack = new GitlabRunnerStack(app, `${serviceName}-ci-runner-gitlab`, {
      env: env,

      serviceName: serviceName,
      // Use the base instance URL here (prefer config/config.yaml; env var overrides are supported)
      gitlabUrl: conf.gitlabUrl!,                               // Your gitlab instance URL
      secretName: conf.gitlabRunnerTokenSecretName!,      
      // GitLab (Web UI)  gives you a token when you create a "runner" (interface : CI/CD - Runners - create a new runner.)
      // The runner instance (ie EC2 Vm) in AWS that wants to implement his runner interface, must pass back this token to "verify" itself
      // Save (eg manually) this token in a AWS secret with this name, as the runner instance created here needs it at run time
      runnerTag: conf.gitlabRunnerTag
        // must match a tag on the runner in GitLab (Web UI) - useful if you want different runners for different pipelines
    });

    cdk.Tags.of(gitlabRunnerStack).add('MyService', serviceName);
    cdk.Tags.of(gitlabRunnerStack).add('StackType', 'DevOpsInfrastructure');
    gitlabRunnerStack.addDependency(devStack); 
  }

  if (conf.hasGithubCiConfig) {
    const githubRunnerLabelsEffective =
      (conf.githubRunnerLabels && conf.githubRunnerLabels.length > 0)
        ? conf.githubRunnerLabels
        : [`${serviceName}-runner`];

    const githubRunnerStack = new GithubRunnerStack(app, `${serviceName}-ci-runner-github`, {
      env: env,

      serviceName: serviceName,
      // Secret contains either:
      // - a GitHub PAT/token that can call the registration-token API (recommended), or
      // - a one-time runner registration token from the GitHub UI (expires quickly; only for ad-hoc bootstrap).
      secretName: conf.githubRunnerTokenSecretName!,

      // Used for AWS tagging/naming; for GitHub the real targeting is via runnerLabels.
      runnerTag: githubRunnerLabelsEffective[0] ?? `${serviceName}-runner`,

      githubScope: conf.githubRepo ? 'repo' : 'org',
      githubOrg: conf.githubOrg!,
      githubRepo: conf.githubRepo,

      // Must match the workflow `runs-on: [...]` labels
      runnerLabels: githubRunnerLabelsEffective,
    });

    cdk.Tags.of(githubRunnerStack).add('MyService', serviceName);
    cdk.Tags.of(githubRunnerStack).add('StackType', 'DevOpsInfrastructure');
    githubRunnerStack.addDependency(devStack); 
  }
}
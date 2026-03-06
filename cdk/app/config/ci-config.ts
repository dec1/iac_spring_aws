import { AppConfig } from './config-reader';

/**
 * Orchestrates CI configuration resolution, validation, and status output.
 */
export function ciConfig(appConfig: AppConfig, serviceName: string) {
  const conf = resolveCiConfig(appConfig, serviceName);
  validateCiConfig(conf);
  printStatusSummary(conf);
  return conf;
}

/**
 * Resolve CI config values (and defaults) from appConfig.
 *
 * Kept separate from validation so the "what are the effective values?" logic stays together.
 */
function resolveCiConfig(appConfig: AppConfig, serviceName: string) {
  const gitlabUrl = appConfig.ci?.gitlab?.url;
  const gitlabRunnerTokenSecretName = appConfig.ci?.gitlab?.runnerTokenSecretName;
  // Runner tag must match the pipeline `tags:` (defaults to "<serviceName>-runner")
  const gitlabRunnerTag = appConfig.ci?.gitlab?.runnerTag ?? `${serviceName}-runner`;

  const githubOrg = appConfig.ci?.github?.org;
  const githubRepo = appConfig.ci?.github?.repo;
  const githubRunnerTokenSecretName = appConfig.ci?.github?.runnerTokenSecretName;
  // GitHub runner labels must match workflows `runs-on:` targeting (defaults to ["<serviceName>-runner"])
  const githubRunnerLabels = appConfig.ci?.github?.runnerLabels ?? [`${serviceName}-runner`];

  const hasGitlabCiConfig = Boolean(
    gitlabUrl || gitlabRunnerTokenSecretName || appConfig.ci?.gitlab?.runnerTag
  );

  const hasGithubCiConfig = Boolean(
    githubOrg ||
    githubRepo ||
    githubRunnerTokenSecretName ||
    (appConfig.ci?.github?.runnerLabels && appConfig.ci?.github?.runnerLabels.length > 0)
  );

  return {
    gitlabUrl,
    gitlabRunnerTokenSecretName,
    gitlabRunnerTag,

    githubOrg,
    githubRepo,
    githubRunnerTokenSecretName,
    githubRunnerLabels,

    hasGitlabCiConfig,
    hasGithubCiConfig,
  };
}

function validateCiConfig(ci: ReturnType<typeof resolveCiConfig>) {
  if (ci.hasGitlabCiConfig) {
    if (!ci.gitlabUrl) {
      throw new Error('GitLab Runner config missing: set ci.gitlab.url in config/config.yaml (or CDK_GITLAB_URL env var).');
    }
    if (!ci.gitlabRunnerTokenSecretName) {
      throw new Error('GitLab Runner config missing: set ci.gitlab.runnerTokenSecretName in config/config.yaml (or CDK_GITLAB_RUNNER_TOKEN_SECRET_NAME env var).');
    }
  }

  if (ci.hasGithubCiConfig) {
    if (!ci.githubOrg) {
      throw new Error('GitHub Runner config missing: set ci.github.org in config/config.yaml (or CDK_GITHUB_ORG env var).');
    }
    if (!ci.githubRunnerTokenSecretName) {
      throw new Error('GitHub Runner config missing: set ci.github.runnerTokenSecretName in config/config.yaml (or CDK_GITHUB_RUNNER_TOKEN_SECRET_NAME env var).');
    }
  }

  if (!ci.hasGitlabCiConfig && !ci.hasGithubCiConfig) {
    console.warn('WARNING: No CI runner configured (ci.gitlab / ci.github). Runner stacks will not be created.');
  }
}

//-----------------------------------------------------------------------------------------
// Status Summary
//-----------------------------------------------------------------------------------------
function printStatusSummary(ci: ReturnType<typeof resolveCiConfig>) {
  const runnersToDeploy = [];
  if (ci.hasGitlabCiConfig) runnersToDeploy.push('GitLab');
  if (ci.hasGithubCiConfig) runnersToDeploy.push('GitHub');

  console.log('--------------------------------------------------');
  console.log(`[CDK] Deploying Runners: ${runnersToDeploy.join(' & ') || 'None'}`);
  console.log('--------------------------------------------------');
}
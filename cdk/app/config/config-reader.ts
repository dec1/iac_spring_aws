// config/app-config-reader.ts

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { ImageConfig, HealthConfig } from './image-config';

/**
 * WHAT THIS FILE DOES:
 * This is the application's "Settings Manager."
 * It gathers configuration settings (like Account ID, Region, Service Name) 
 * so the app knows where and how to deploy.
 *
 * HOW IT WORKS:
 * Settings are resolved in the following priority (first one found wins):
 * 1. CDK Context (passed via command line: -c myAppConfig=...)
 * 2. Environment Variables (e.g. CDK_DEFAULT_ACCOUNT / AWS_REGION set in your terminal or CI)
 * 3. Global Defaults (config_common.yaml for shared values like service name and version)
 * 4. Local Config (config/config.yaml for environment-specific fallbacks)
 *
 * Note: The application version (imageTag) is sourced exclusively from config_common.yaml.
 * If a required setting is missing from all relevant sources, the app stops with an error.
 */

// Path resolution constants
// Assumptions based on: <repoRoot>/cdk/app/config/app-config-reader.ts
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_COMMON_YAML_PATH = path.join(REPO_ROOT, 'config_common.yaml');
const CONFIG_YAML_PATH = path.join(REPO_ROOT, 'cdk', 'config.yaml'); 

/**
 * Keys in config.yaml that are expected to be supplied by config_common.yaml.
 * If any of these are still null after merging both files, we fail fast.
 */
const KEYS_FROM_COMMON: readonly string[] = [
  'serviceName',
  'imageSource',
  'imageRepositoryName',
  'appVersion',
];

/**
 * Interface representing environment-specific configuration.
 */
export interface EnvConfig {
  readonly computePlatform: 'ecs' | 'kubernetes';
  readonly stagingEnvironment: 'dev' | 'release';
  readonly imageSource: 'ecr' | 'dockerhub';
  readonly imageRepositoryName: string;
  readonly imageTag: string;
  
  /**
   * Fully calculated health check settings (primitive values).
   * The reader handles the logic of populating this.
   */
  readonly healthConfig: HealthConfig;

  /** optional explicit S3 bucket name for this environment */
  readonly s3BucketName?: string;
  
  /** whether to import bucket should be created/deleted by cdk automatically or is independent*/
  readonly s3BucketIsCdkManaged?: boolean;
  
  /** hostname prefix (e.g. 'dev.api', 'k8s.dev.api', etc.) - the part before the apex domain */
  readonly hostnamePrefix?: string;
}

export interface GitlabRunnerConfig {
  /** Base instance URL, e.g. "https://gitlab.example.com/" */
  readonly url?: string;
  
  /** Name of the AWS Secrets Manager secret holding the runner token */
  readonly runnerTokenSecretName?: string;
  
  /** Tag used to target this runner in .gitlab-ci.yml */
  readonly runnerTag?: string;
}

export interface GithubRunnerConfig {
  /** Owner/org name in GitHub, e.g. "dec1" */
  readonly org?: string;
  
  /** Repo name in GitHub, e.g. "my-backend" (omit for org-level runner) */
  readonly repo?: string;
  
  /** Name of the AWS Secrets Manager secret holding the token (PAT recommended) */
  readonly runnerTokenSecretName?: string;
  
  /** Labels used to target this runner in GitHub Actions (runs-on) */
  readonly runnerLabels?: string[];
}

export interface CiConfig {
  readonly gitlab?: GitlabRunnerConfig;
  readonly github?: GithubRunnerConfig;
}

/**
 * Fully resolved application configuration.
 */
export interface AppConfig {
  /**
   * Optional:
   * - If omitted, CDK will infer the target account/region from the active AWS credentials at deploy time.
   * - Keeping these optional avoids hard-coding and keeps local/CI deploys consistent.
   *
   * Note:
   * - Some stacks (e.g. Vpc.fromLookup) still require a concrete env at synth time.
   * app.ts resolves that env by preferring runtime environment over this fallback.
   */
  readonly account?: string;
  readonly region?: string;

  readonly serviceName: string;

  /**
   * Optional Custom Domain:
   * - If BOTH apexDomain and hostedZoneId are non-empty, stacks will provision:
   *   - ACM certificate (for HTTPS on the ALB)
   *   - Route53 records (ECS) / ExternalDNS filtering (EKS)
   * - If either is empty, stacks fall back to ALB DNS name over HTTP (no TLS).
   *
   * Implementation detail:
   * - We normalize missing/null values to empty string '' to keep downstream code simple.
   */
  readonly apexDomain: string;
  readonly hostedZoneId: string;

  readonly appPortNum: number;
  
  /** map of all environment configs by key ('dev','k8s-dev','release','k8s-release') */
  readonly envConfigs: Record<string, EnvConfig>;
  readonly terminationWaitTimeMinutes: number;
  readonly wantGrafana?: boolean;

  /** Optional CI/runner settings */
  readonly ci?: CiConfig;

  /**
   * IAM role ARN granted kubectl (system:masters) access to EKS clusters.
   * Use the iam role form: arn:aws:iam::ACCOUNT:role/ROLE_NAME
   * (not the sts assumed-role form from `aws sts get-caller-identity`)
   */
  readonly eksAdminRoleArn?: string;
}

/**
 * Static class to load and resolve the application configuration.
 */
export class AppConfigReader {

    public static loadAppConfig(context: any): AppConfig {
        // Read config from context (highest priority)
        const contextConfig: Record<string, any> | undefined =
        context &&
        context.myAppConfig &&
        typeof context.myAppConfig === 'object'
            ? context.myAppConfig
            : undefined;

        // Read config from file (fallback only; ignored when contextConfig is provided)
        let fileConfig: Record<string, any> = {};

        if (!contextConfig) {
        try {
            const raw = fs.readFileSync(CONFIG_YAML_PATH, 'utf-8');
            fileConfig = YAML.parse(raw);
            console.log(`Loaded configuration from ${CONFIG_YAML_PATH}`);
        } catch (e: any) {
            if (e.code !== 'ENOENT') {
            console.error(`Error reading ${CONFIG_YAML_PATH}`, e);
            } else {
            console.log('No local config.yaml file found; using defaults and environment variables');
            }
        }
        } else {
        console.log('Using configuration from CDK context');
        }

        // Use context config if present; otherwise use file config.
        const cfg = contextConfig ?? fileConfig;

    //-----------------------------------------------------------------------------------------
    // Read global configuration defaults from config_common.yaml 
    //
    // Motivation:
    // - variables like serviceName, imageSource, imageRepositoryName are no longer stored in config/config.yaml
    // - they are now pulled from a single global YAML file.
    //-----------------------------------------------------------------------------------------

    let commonConfig: Record<string, any> = {};
    try {
        const raw = fs.readFileSync(CONFIG_COMMON_YAML_PATH, 'utf-8');
        commonConfig = YAML.parse(raw) as Record<string, any>;
    } catch (e: any) {
        // Critical dependency: fail fast if global config is missing or invalid
        throw new Error(`Failed to read/parse required YAML file at ${CONFIG_COMMON_YAML_PATH}: ${e.message ?? String(e)}`);
    }

    //-----------------------------------------------------------------------------------------
    // Validate: every key listed in KEYS_FROM_COMMON must be non-null after merging.
    // config.yaml declares these as null sentinels; config_common.yaml must supply real values.
    //-----------------------------------------------------------------------------------------
    const missingKeys = KEYS_FROM_COMMON.filter(
        (key) => commonConfig[key] === undefined || commonConfig[key] === null
    );
    if (missingKeys.length > 0) {
        throw new Error(
        `config_common.yaml must supply the following keys (they are null sentinels in config.yaml): ${missingKeys.join(', ')}`
        );
    }

    // Convenience alias matching the old "globalDefaults" shape used below
    const globalDefaults = {
        serviceName:         commonConfig.serviceName as string | undefined,
        imageSource:         commonConfig.imageSource as string | undefined,
        imageRepositoryName: commonConfig.imageRepositoryName as string | undefined,
        appVersion:          commonConfig.appVersion as string | undefined,
    };

    // Top-level fallbacks: context -> env -> config file (fallback only)
    //
    // Note:
    // - account/region are OPTIONAL: CDK can infer these from the active AWS credentials at deploy time.
    // - if you DO provide them (context/config/env), they still work as before.
    const account =
      contextConfig?.account ??
      process.env.CDK_DEFAULT_ACCOUNT ??
      fileConfig.account;

    const region =
      contextConfig?.region ??
      process.env.CDK_DEFAULT_REGION ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      fileConfig.region;

    const serviceName =
      contextConfig?.serviceName ??
      process.env.CDK_SERVICE_NAME ??
      globalDefaults.serviceName;

    // ---------------------------------------------------------------------------------------
    // Optional custom domain settings
    //
    // Important:
    // - These are NOT required for synth/deploy.
    // - When omitted/empty, stacks fall back to ALB DNS name over HTTP (no TLS).
    //
    // We normalize missing/null to '' (empty string), and trim whitespace so:
    // - apexDomain:    (blank)  => ''
    // - apexDomain: ""         => ''
    // - missing key            => ''
    // ---------------------------------------------------------------------------------------
    const apexDomain = (
      contextConfig?.apexDomain ??
      process.env.CDK_APEX_DOMAIN ??
      fileConfig.apexDomain ??
      ''
    ).toString().trim();

    const hostedZoneId = (
      contextConfig?.hostedZoneId ??
      process.env.CDK_HOSTED_ZONE_ID ??
      fileConfig.hostedZoneId ??
      ''
    ).toString().trim();

    const appPortNum = Number(
      contextConfig?.appPortNum ??
      process.env.CDK_APP_PORT_NUM ??
      fileConfig.appPortNum ??
      3000
    );

    const terminationWaitTimeMinutes = Number(
      contextConfig?.terminationWaitTimeMinutes ??
      process.env.CDK_TERMINATION_WAIT_TIME_MINUTES ??
      fileConfig.terminationWaitTimeMinutes ??
      5
    );

    const wantGrafana =
      (contextConfig?.wantGrafana ?? fileConfig.wantGrafana) === true;

    const eksAdminRoleArn =
      contextConfig?.eksAdminRoleArn ??
      process.env.CDK_EKS_ADMIN_ROLE_ARN ??
      fileConfig.eksAdminRoleArn;


    function parseCsv(v?: string): string[] | undefined {
      if (!v) return undefined;
      const items = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return items.length ? items : undefined;
    }

    const ciGitlabUrl =
      contextConfig?.ci?.gitlab?.url ??
      process.env.CDK_GITLAB_URL ??
      fileConfig.ci?.gitlab?.url;

    const ciGitlabRunnerTokenSecretName =
      contextConfig?.ci?.gitlab?.runnerTokenSecretName ??
      process.env.CDK_GITLAB_RUNNER_TOKEN_SECRET_NAME ??
      fileConfig.ci?.gitlab?.runnerTokenSecretName;

    const ciGitlabRunnerTag =
      contextConfig?.ci?.gitlab?.runnerTag ??
      process.env.CDK_GITLAB_RUNNER_TAG ??
      fileConfig.ci?.gitlab?.runnerTag;

    const ciGithubOrg =
      contextConfig?.ci?.github?.org ??
      process.env.CDK_GITHUB_ORG ??
      fileConfig.ci?.github?.org;

    const ciGithubRepo =
      contextConfig?.ci?.github?.repo ??
      process.env.CDK_GITHUB_REPO ??
      fileConfig.ci?.github?.repo;

    const ciGithubRunnerTokenSecretName =
      contextConfig?.ci?.github?.runnerTokenSecretName ??
      process.env.CDK_GITHUB_RUNNER_TOKEN_SECRET_NAME ??
      fileConfig.ci?.github?.runnerTokenSecretName;

    const ciGithubRunnerLabels =
      contextConfig?.ci?.github?.runnerLabels ??
      parseCsv(process.env.CDK_GITHUB_RUNNER_LABELS) ??
      fileConfig.ci?.github?.runnerLabels;

    const hasGitlabCi = Boolean(
      ciGitlabUrl || ciGitlabRunnerTokenSecretName || ciGitlabRunnerTag
    );

    const hasGithubCi = Boolean(
      ciGithubOrg ||
      ciGithubRepo ||
      ciGithubRunnerTokenSecretName ||
      (ciGithubRunnerLabels && ciGithubRunnerLabels.length > 0)
    );

    const ci: CiConfig | undefined =
      (hasGitlabCi || hasGithubCi)
        ? {
            ...(hasGitlabCi
              ? {
                  gitlab: {
                    url: ciGitlabUrl,
                    runnerTokenSecretName: ciGitlabRunnerTokenSecretName,
                    runnerTag: ciGitlabRunnerTag,
                  },
                }
              : {}),
            ...(hasGithubCi
              ? {
                  github: {
                    org: ciGithubOrg,
                    repo: ciGithubRepo,
                    runnerTokenSecretName: ciGithubRunnerTokenSecretName,
                    runnerLabels: ciGithubRunnerLabels,
                  },
                }
              : {}),
          }
        : undefined;

    const appVersionFromYaml = globalDefaults.appVersion?.toString().trim();

    if (!appVersionFromYaml) {
    throw new Error(
        'config_common.yaml is required and must include a non-empty appVersion (it is the sole source of the container image tag).'
    );
    }

    // ensure a non-optional value for nested functions/closures.
    // The tag is sourced strictly from config_common.yaml.
    const imageTagFromYaml: string = appVersionFromYaml;

    // --- Fail fast with clear messages for required fields ---
    //
    // account/region are intentionally NOT required.

    if (!serviceName) {
      throw new Error('serviceName is required (via context, env, or config_common.yaml)');
    }

    /**
     * Optional shared defaults for all environments.
     *
     * Precedence rule:
     * - dev/release specific values override defaults (merge order: { ...defaults, ...dev/release }).
     *
     * Note:
     * - This is a shallow merge.
     * Arrays/objects are replaced as a whole, not deep-merged.
     */
    const defaults = (cfg._defaults as Record<string, any>) || {};

    // Extract each env config
    function extractEnv(key: string): EnvConfig {
      const overrides = (cfg[key] as Record<string, any>) || {};

      // Merge shared defaults with env-specific overrides (env wins on key collisions)
      const merged = { ...defaults, ...overrides };

      // Gather raw inputs to pass to logic calculator
      //
      // imageSource/imageRepositoryName are now sourced from repoRoot/config_common.yaml (global defaults),
      // unless the env explicitly overrides them (e.g. k8s-dev/k8s-release).
      const imageSource =
        (merged.imageSource ?? globalDefaults.imageSource) as 'ecr' | 'dockerhub';

      const imageRepositoryName =
        (merged.imageRepositoryName ?? globalDefaults.imageRepositoryName) as string;

      if (!imageSource) {
        throw new Error(
          `Missing imageSource for env '${key}'. Provide it in config_common.yaml (imageSource: ecr|dockerhub) or override in config.yaml under '${key}'.`
        );
      }
      if (!imageRepositoryName) {
        throw new Error(
          `Missing imageRepositoryName for env '${key}'. Provide it in config_common.yaml (imageRepositoryName: ...) or override in config.yaml under '${key}'.`
        );
      }

      const healthCmd = merged.healthCheckCommand;
      const healthPath = merged.healthCheckPath;

      // Default health check command uses appPortNum + healthCheckPath so port/path stay single-source.
      const effectiveHealthCmd =
        healthCmd ??
        (healthPath
          ? [
              'CMD-SHELL',
              `wget --quiet --tries=1 --spider http://localhost:${appPortNum}${healthPath} || exit 1`
            ]
          : undefined);

      // Delegate logic to ImageConfig to get pure data primitives
      const healthConfig = ImageConfig.getHealthConfig(
        imageSource,
        appPortNum,
        { cmd: effectiveHealthCmd, path: healthPath }
      );

      return {
        computePlatform:       merged.computePlatform as 'ecs' | 'kubernetes',
        stagingEnvironment:    merged.stagingEnvironment as 'dev' | 'release',
        imageSource:           imageSource,
        imageRepositoryName:   imageRepositoryName,

        imageTag:              imageTagFromYaml,

        // Store the result
        healthConfig:          healthConfig,

        s3BucketName:          merged.s3BucketName,
        s3BucketIsCdkManaged:  merged.s3BucketIsCdkManaged,
        hostnamePrefix:        merged.hostnamePrefix,
      };
    }

    const RESERVED = new Set([
      'account','region','serviceName','apexDomain','hostedZoneId',
      'appPortNum','terminationWaitTimeMinutes','wantGrafana',
      'ci','eksAdminRoleArn',

      // Not an environment block; used only for shared defaults
      '_defaults',

      // Null sentinel keys supplied by config_common.yaml -- not environment blocks
      ...KEYS_FROM_COMMON,
    ]);

    const envConfigs: Record<string, EnvConfig> = {};
    for (const key of Object.keys(cfg)) {
      if (!RESERVED.has(key)) {
        envConfigs[key] = extractEnv(key);
      }
    }

    const appConfig: AppConfig = {
      account,
      region,
      serviceName,
      apexDomain,
      hostedZoneId,
      appPortNum,
      envConfigs,
      terminationWaitTimeMinutes,
      wantGrafana,
      ci,
      eksAdminRoleArn,
    };

    return appConfig;

  }
}
import { AppConfigReader, AppConfig } from '../config/config-reader';
import * as fs from 'fs';
import * as YAML from 'yaml';

jest.mock('fs');
jest.mock('yaml');

// We mock ImageConfig.getHealthConfig to avoid pulling in the real implementation.
// Tests for health check logic belong in image-config.test.ts.
jest.mock('../config/image-config', () => ({
  ImageConfig: {
    getHealthConfig: jest.fn(() => ({
      command: ['CMD-SHELL', 'wget --quiet --tries=1 --spider http://localhost:8080/actuator/health || exit 1'],
      retries: 3,
      startPeriodSeconds: 30,
      timeoutSeconds: 5,
      intervalSeconds: 10,
      healthyThreshold: 2,
      path: '/actuator/health',
    })),
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal valid config_common.yaml content (as parsed object) */
const VALID_COMMON_CONFIG = {
  serviceName: 'my-backend',
  imageSource: 'ecr',
  imageRepositoryName: 'my-backend-img',
  appVersion: '1.96.9',
  productName: 'MyProduct',
  apiName: 'Backend API',
};

/** Minimal valid config.yaml content (as parsed object) */
const VALID_FILE_CONFIG = {
  // Null sentinels -- supplied by config_common.yaml
  serviceName: null,
  imageSource: null,
  imageRepositoryName: null,
  appVersion: null,

  apexDomain: 'my-domain.com',
  hostedZoneId: 'ZXXXXXXXXXXXXXXXXX',
  appPortNum: 8080,
  terminationWaitTimeMinutes: 5,
  wantGrafana: false,

  _defaults: {
    healthCheckPath: '/actuator/health',
    s3BucketIsCdkManaged: true,
    computePlatform: 'ecs',
  },

  dev: {
    stagingEnvironment: 'dev',
    s3BucketName: 'my-backend-bucket-dev',
    hostnamePrefix: 'dev.api',
  },

  release: {
    stagingEnvironment: 'release',
    s3BucketName: 'my-backend-bucket-release',
    hostnamePrefix: 'api',
  },

  'k8s-dev': {
    stagingEnvironment: 'dev',
    computePlatform: 'kubernetes',
    imageSource: 'dockerhub',
    imageRepositoryName: 'dec1/spring-aws-app',
    hostnamePrefix: 'k8s.dev.api',
  },

  'k8s-release': {
    stagingEnvironment: 'release',
    computePlatform: 'kubernetes',
    imageSource: 'dockerhub',
    imageRepositoryName: 'dec1/spring-aws-app',
    hostnamePrefix: 'k8s.api',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sets up fs.readFileSync and YAML.parse mocks for the two config files.
 * Both parameters are optional -- pass undefined to simulate a missing file.
 */
function mockConfigFiles(
  commonConfig: Record<string, any> | undefined,
  fileConfig: Record<string, any> | undefined,
) {
  const mockReadFileSync = fs.readFileSync as jest.Mock;
  const mockYamlParse = (YAML.parse as unknown) as jest.Mock;

  mockReadFileSync.mockImplementation((filePath: string) => {
    if (filePath.includes('config_common.yaml')) {
      if (!commonConfig) throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
      return 'common-yaml-raw';
    }
    if (filePath.includes('config.yaml')) {
      if (!fileConfig) throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
      return 'file-yaml-raw';
    }
    throw new Error(`Unexpected file read: ${filePath}`);
  });

  mockYamlParse.mockImplementation((raw: string) => {
    if (raw === 'common-yaml-raw') return { ...commonConfig };
    if (raw === 'file-yaml-raw') return { ...fileConfig };
    throw new Error(`Unexpected YAML.parse input: ${raw}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppConfigReader.loadAppConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // Happy path: config.yaml + config_common.yaml
  // =========================================================================

  describe('loading from config files (no context, no env vars)', () => {
    test('resolves top-level values from config.yaml and config_common.yaml', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});

      expect(config.serviceName).toBe('my-backend');
      expect(config.apexDomain).toBe('my-domain.com');
      expect(config.hostedZoneId).toBe('ZXXXXXXXXXXXXXXXXX');
      expect(config.appPortNum).toBe(8080);
      expect(config.terminationWaitTimeMinutes).toBe(5);
      expect(config.wantGrafana).toBe(false);
    });

    test('account and region are optional (undefined when not provided)', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});

      expect(config.account).toBeUndefined();
      expect(config.region).toBeUndefined();
    });

    test('discovers all environment blocks (dev, release, k8s-dev, k8s-release)', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});

      expect(Object.keys(config.envConfigs).sort()).toEqual(
        ['dev', 'k8s-dev', 'k8s-release', 'release']
      );
    });

    test('imageTag on every env comes exclusively from config_common.yaml appVersion', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});

      for (const env of Object.values(config.envConfigs)) {
        expect(env.imageTag).toBe('1.96.9');
      }
    });

    test('_defaults are applied to envs that do not override them', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});
      const dev = config.envConfigs['dev'];

      // computePlatform comes from _defaults (dev block does not set it)
      expect(dev.computePlatform).toBe('ecs');
      expect(dev.s3BucketIsCdkManaged).toBe(true);
    });

    test('env-specific values override _defaults', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});
      const k8sDev = config.envConfigs['k8s-dev'];

      // k8s-dev explicitly sets computePlatform, overriding the _defaults value of 'ecs'
      expect(k8sDev.computePlatform).toBe('kubernetes');
    });

    test('env blocks can override imageSource/imageRepositoryName from config_common.yaml', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});

      // dev inherits from config_common.yaml
      expect(config.envConfigs['dev'].imageSource).toBe('ecr');
      expect(config.envConfigs['dev'].imageRepositoryName).toBe('my-backend-img');

      // k8s-dev overrides both
      expect(config.envConfigs['k8s-dev'].imageSource).toBe('dockerhub');
      expect(config.envConfigs['k8s-dev'].imageRepositoryName).toBe('dec1/spring-aws-app');
    });
  });

  // =========================================================================
  // Priority: CDK context > env vars > config files
  // =========================================================================

  describe('priority resolution', () => {
    test('CDK context wins over file config', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const context = {
        myAppConfig: {
          ...VALID_FILE_CONFIG,
          apexDomain: 'context-domain.com',
          hostedZoneId: 'ZCONTEXT',
          dev: {
            stagingEnvironment: 'dev',
            hostnamePrefix: 'context.dev.api',
          },
        },
      };

      const config = AppConfigReader.loadAppConfig(context);

      expect(config.apexDomain).toBe('context-domain.com');
      expect(config.hostedZoneId).toBe('ZCONTEXT');
    });

    test('CDK context serviceName wins over config_common.yaml', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const context = {
        myAppConfig: {
          ...VALID_FILE_CONFIG,
          serviceName: 'context-service',
        },
      };

      const config = AppConfigReader.loadAppConfig(context);
      expect(config.serviceName).toBe('context-service');
    });

    test('environment variables win over file config for account/region', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, {
        ...VALID_FILE_CONFIG,
        account: 'file-account',
        region: 'file-region',
      });

      process.env.CDK_DEFAULT_ACCOUNT = '999999999999';
      process.env.CDK_DEFAULT_REGION = 'eu-central-1';

      const config = AppConfigReader.loadAppConfig({});

      expect(config.account).toBe('999999999999');
      expect(config.region).toBe('eu-central-1');
    });

    test('CDK_SERVICE_NAME env var wins over config_common.yaml', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      process.env.CDK_SERVICE_NAME = 'env-service';

      const config = AppConfigReader.loadAppConfig({});
      expect(config.serviceName).toBe('env-service');
    });

    test('AWS_REGION is used as fallback when CDK_DEFAULT_REGION is not set', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      process.env.AWS_REGION = 'us-west-2';

      const config = AppConfigReader.loadAppConfig({});
      expect(config.region).toBe('us-west-2');
    });
  });

  // =========================================================================
  // Sentinel validation (config_common.yaml must supply required keys)
  // =========================================================================

  describe('sentinel key validation', () => {
    test('throws if config_common.yaml is missing serviceName', () => {
      const brokenCommon = { ...VALID_COMMON_CONFIG, serviceName: undefined };
      mockConfigFiles(brokenCommon, VALID_FILE_CONFIG);

      expect(() => AppConfigReader.loadAppConfig({})).toThrow(
        /config_common\.yaml must supply.*serviceName/
      );
    });

    test('throws if config_common.yaml has null appVersion', () => {
      const brokenCommon = { ...VALID_COMMON_CONFIG, appVersion: null };
      mockConfigFiles(brokenCommon, VALID_FILE_CONFIG);

      expect(() => AppConfigReader.loadAppConfig({})).toThrow(
        /config_common\.yaml must supply.*appVersion/
      );
    });

    test('throws listing all missing sentinel keys at once', () => {
      const brokenCommon = {
        ...VALID_COMMON_CONFIG,
        serviceName: null,
        imageSource: undefined,
      };
      mockConfigFiles(brokenCommon, VALID_FILE_CONFIG);

      expect(() => AppConfigReader.loadAppConfig({})).toThrow(
        /serviceName, imageSource/
      );
    });
  });

  // =========================================================================
  // Fail-fast on required fields
  // =========================================================================

  describe('required field validation', () => {
    test('throws if config_common.yaml file is missing entirely', () => {
      mockConfigFiles(undefined, VALID_FILE_CONFIG);

      expect(() => AppConfigReader.loadAppConfig({})).toThrow(
        /Failed to read\/parse required YAML file/
      );
    });

    test('throws if appVersion is empty string', () => {
      const brokenCommon = { ...VALID_COMMON_CONFIG, appVersion: '  ' };
      mockConfigFiles(brokenCommon, VALID_FILE_CONFIG);

      expect(() => AppConfigReader.loadAppConfig({})).toThrow(
        /must include a non-empty appVersion/
      );
    });

    test('throws if serviceName resolves to falsy from all sources', () => {
      // config_common.yaml has serviceName, but context overrides it to empty
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const context = {
        myAppConfig: {
          ...VALID_FILE_CONFIG,
          serviceName: '',
        },
      };

      expect(() => AppConfigReader.loadAppConfig(context)).toThrow(
        /serviceName is required/
      );
    });

    test('throws if apexDomain is missing from all sources', () => {
      const fileConfigNoDomain = { ...VALID_FILE_CONFIG };
      delete (fileConfigNoDomain as any).apexDomain;
      mockConfigFiles(VALID_COMMON_CONFIG, fileConfigNoDomain);

      expect(() => AppConfigReader.loadAppConfig({})).toThrow(
        /CDK_APEX_DOMAIN is required/
      );
    });
  });

  // =========================================================================
  // Defaults for optional numeric fields
  // =========================================================================

  describe('default values', () => {
    test('appPortNum defaults to 3000 if not provided anywhere', () => {
      const fileConfigNoPort = { ...VALID_FILE_CONFIG };
      delete (fileConfigNoPort as any).appPortNum;
      mockConfigFiles(VALID_COMMON_CONFIG, fileConfigNoPort);

      const config = AppConfigReader.loadAppConfig({});
      expect(config.appPortNum).toBe(3000);
    });

    test('terminationWaitTimeMinutes defaults to 5 if not provided', () => {
      const fileConfigNoTerm = { ...VALID_FILE_CONFIG };
      delete (fileConfigNoTerm as any).terminationWaitTimeMinutes;
      mockConfigFiles(VALID_COMMON_CONFIG, fileConfigNoTerm);

      const config = AppConfigReader.loadAppConfig({});
      expect(config.terminationWaitTimeMinutes).toBe(5);
    });

    test('hostedZoneId defaults to empty string if not provided', () => {
      const fileConfigNoZone = { ...VALID_FILE_CONFIG };
      delete (fileConfigNoZone as any).hostedZoneId;
      mockConfigFiles(VALID_COMMON_CONFIG, fileConfigNoZone);

      const config = AppConfigReader.loadAppConfig({});
      expect(config.hostedZoneId).toBe('');
    });

    test('wantGrafana defaults to false if not provided', () => {
      const fileConfigNoGrafana = { ...VALID_FILE_CONFIG };
      delete (fileConfigNoGrafana as any).wantGrafana;
      mockConfigFiles(VALID_COMMON_CONFIG, fileConfigNoGrafana);

      const config = AppConfigReader.loadAppConfig({});
      expect(config.wantGrafana).toBe(false);
    });
  });

  // =========================================================================
  // CI configuration
  // =========================================================================

  describe('CI configuration', () => {
    test('parses gitlab and github CI config from file', () => {
      const fileConfigWithCi = {
        ...VALID_FILE_CONFIG,
        ci: {
          gitlab: {
            url: 'https://gitlab.example.com/',
            runnerTokenSecretName: 'GitlabToken',
            runnerTag: 'my-tag',
          },
          github: {
            org: 'dec1',
            repo: 'my-backend',
            runnerTokenSecretName: 'GithubToken',
            runnerLabels: ['label-1'],
          },
        },
      };
      mockConfigFiles(VALID_COMMON_CONFIG, fileConfigWithCi);

      const config = AppConfigReader.loadAppConfig({});

      expect(config.ci?.gitlab?.url).toBe('https://gitlab.example.com/');
      expect(config.ci?.gitlab?.runnerTag).toBe('my-tag');
      expect(config.ci?.github?.org).toBe('dec1');
      expect(config.ci?.github?.runnerLabels).toEqual(['label-1']);
    });

    test('ci is undefined when no CI settings exist', () => {
      const fileConfigNoCi = { ...VALID_FILE_CONFIG };
      delete (fileConfigNoCi as any).ci;
      mockConfigFiles(VALID_COMMON_CONFIG, fileConfigNoCi);

      const config = AppConfigReader.loadAppConfig({});
      expect(config.ci).toBeUndefined();
    });

    test('CI env vars override file config', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      process.env.CDK_GITLAB_URL = 'https://env-gitlab.example.com/';
      process.env.CDK_GITHUB_ORG = 'env-org';
      process.env.CDK_GITHUB_RUNNER_LABELS = 'label-a, label-b';

      const config = AppConfigReader.loadAppConfig({});

      expect(config.ci?.gitlab?.url).toBe('https://env-gitlab.example.com/');
      expect(config.ci?.github?.org).toBe('env-org');
      expect(config.ci?.github?.runnerLabels).toEqual(['label-a', 'label-b']);
    });
  });

  // =========================================================================
  // Reserved keys are not treated as environment blocks
  // =========================================================================

  describe('reserved key filtering', () => {
    test('null sentinel keys from KEYS_FROM_COMMON are not treated as env blocks', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});

      // These are top-level keys in config.yaml but must not appear as env blocks
      expect(config.envConfigs['serviceName']).toBeUndefined();
      expect(config.envConfigs['imageSource']).toBeUndefined();
      expect(config.envConfigs['imageRepositoryName']).toBeUndefined();
      expect(config.envConfigs['appVersion']).toBeUndefined();
    });

    test('_defaults is not treated as an env block', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, VALID_FILE_CONFIG);

      const config = AppConfigReader.loadAppConfig({});
      expect(config.envConfigs['_defaults']).toBeUndefined();
    });
  });

  // =========================================================================
  // Edge: config.yaml missing (env vars + config_common.yaml only)
  // =========================================================================

  describe('missing config.yaml (env vars only)', () => {
    test('works with env vars and config_common.yaml when config.yaml is absent', () => {
      mockConfigFiles(VALID_COMMON_CONFIG, undefined);

      process.env.CDK_APEX_DOMAIN = 'env-domain.com';

      const config = AppConfigReader.loadAppConfig({});

      expect(config.serviceName).toBe('my-backend');
      expect(config.apexDomain).toBe('env-domain.com');
      expect(Object.keys(config.envConfigs)).toEqual([]); // no env blocks without file
    });
  });
});
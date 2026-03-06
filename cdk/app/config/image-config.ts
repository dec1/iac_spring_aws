// config/image-config.ts

/**
 * Pure data interface for health check settings.
 * All time values are in seconds.
 */
export interface HealthConfig {
  command: string[];
  retries: number;
  startPeriodSeconds: number;
  timeoutSeconds: number;
  intervalSeconds: number;
  path: string;
  healthyThreshold: number;
}

/**
 * Holds container-image and health-check config, with optional overrides
 * from config.yaml.
 */
export class ImageConfig {

  public static getHealthConfig(
    imageSource: 'dockerhub' | 'ecr',
    appPortNum: number,
    overrides?: { cmd?: string[], path?: string }
  ): HealthConfig {

    // allow path override, otherwise default to "/api/hello"
    const HEALTH_CHECK_PATH = overrides?.path ?? "/api/hello";

    const TIMEOUT_SEC = 5;    // max seconds to wait for result of health check
    const INTERVAL_SEC = 7;   // how often (in seconds) to run health check

    const START_PERIOD_SHORT_SEC = 60;  // seconds, e.g. dockerhub
    const START_PERIOD_LONG_SEC  = 300; // seconds, e.g. ecr

    // base command
    // wget’s “--spider” mode fetches headers only; if the URL is not reachable, it returns non‐zero.
    const commandOptions = `wget --quiet --tries=1 --spider`;
    const defaultUrl = `http://localhost:${appPortNum}${HEALTH_CHECK_PATH}`;
    const defaultCommand = ['CMD-SHELL', `${commandOptions} ${defaultUrl} || exit 1`];

    // pick override or default
    const command = overrides?.cmd ?? defaultCommand;

    // start-period based on image source
    const startPeriodSeconds = (imageSource === 'ecr')
      ? START_PERIOD_LONG_SEC
      : START_PERIOD_SHORT_SEC;

    return {
      // Called by container on container itself
      command,
      retries: 2,
      startPeriodSeconds,
      timeoutSeconds: TIMEOUT_SEC,
      intervalSeconds: INTERVAL_SEC,

      // Called by ALB on containers (targetGroup)
      path: HEALTH_CHECK_PATH,
      healthyThreshold: 5,
    };
  }
}
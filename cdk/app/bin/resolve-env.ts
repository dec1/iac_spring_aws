import * as cdk from 'aws-cdk-lib';
import { execFileSync } from 'node:child_process';
import { AppConfig } from '../config/config-reader';

/**
 * Resolve the concrete target environment (account and region) for stacks.
 *
 * Why:
 * - CDK context lookups (e.g. Vpc.fromLookup) require a concrete env at synth time.
 * - Account comes from the *active AWS credentials* (locally often via AWS_PROFILE; in CI usually via assumed role/web-identity/instance role).
 * - Region and account must be provided somewhere (context override, env vars, active AWS config/profile, or config fallback).
 *
 * Precedence:
 * 1) Explicit CDK context overrides: -c account=... -c region=...
 * 2) Explicit environment variables in this process: CDK_ACCOUNT, AWS_REGION / AWS_DEFAULT_REGION
 * 3) CDK-provided defaults: CDK_DEFAULT_ACCOUNT, CDK_DEFAULT_REGION
 * - when you run via `cdk ...`, the CDK CLI may set these based on the credentials/region it resolves
 * 4) Active credentials/config (AWS SDK/CLI):
 * - Region: if still missing, resolve from `aws configure get region`
 * (uses AWS_REGION/AWS_DEFAULT_REGION if set; otherwise checks the active profile; otherwise empty)
 * - Account: if still missing, resolve from STS `aws sts get-caller-identity`
 * (uses whatever credentials CI provides: assumed role/web identity/instance role/profile)
 * 5) Config fallback (config/config.yaml) only if still missing
 */
export function resolveEnv(app: cdk.App, appConfig: AppConfig): { account: string; region: string } {
  const ctxAccount = app.node.tryGetContext('account') as string | undefined;
  const ctxRegion = app.node.tryGetContext('region') as string | undefined;

  let account =
    ctxAccount ??
    process.env.CDK_ACCOUNT ??
    process.env.CDK_DEFAULT_ACCOUNT ??
    appConfig.account;

  let region =
    ctxRegion ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    process.env.CDK_DEFAULT_REGION ??
    appConfig.region;

  // If region still missing, ask AWS CLI (works locally and in CI if AWS CLI is installed).
  if (!region) {
    try {
      const out = execFileSync('aws', ['configure', 'get', 'region'], { encoding: 'utf8' }).trim();
      if (out) region = out;
    } catch {
      // ignore; handled by the fail-fast below
    }
  }

  // If account still missing, ask STS (works locally and in CI if credentials are configured).
  if (!account) {
    try {
      const out = execFileSync(
        'aws',
        ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'],
        { encoding: 'utf8' }
      ).trim();
      if (out) account = out;
    } catch {
      // ignore; handled by the fail-fast below
    }
  }

  // Fail fast: stacks with lookups (runner) need a concrete env.
  if (!account) {
    throw new Error(
      'Unable to resolve AWS account. Expected CDK_DEFAULT_ACCOUNT / CDK_ACCOUNT, an STS-derived account from active credentials, or a config fallback (config.account) or a context override (-c account=...).'
    );
  }
  if (!region) {
    throw new Error(
      'Unable to resolve AWS region. Expected AWS_REGION / AWS_DEFAULT_REGION / CDK_DEFAULT_REGION, the active config region (aws configure get region), or a config fallback (config.region) or a context override (-c region=...).'
    );
  }

  return { account, region };
}
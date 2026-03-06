// config/web-acl-config.ts

/**
 * Centralized configuration for WAF rules.
 * Defines environment-specific security thresholds.
 */
export const WebAclConfig = {
  // Rate limit (requests per 5 minutes per IP)
  rateLimitDev: 500,
  rateLimitRelease: 2000,
};
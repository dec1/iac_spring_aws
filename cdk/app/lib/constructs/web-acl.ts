// lib/constructs/web-acl.ts

import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { WebAclConfig } from '../../config/web-acl-config';

/**
 * Properties for the WebAclConstruct.
 */
export interface WebAclConstructProps {
  /**
   * The service name to be used in WAF metric names.
   */
  serviceName: string;
  /**
   * The environment name ('dev' or 'release') to be used in WAF metric names and rate limits.
   */
  environment: 'dev' | 'release';
  // Add any other WAF-specific configurations you might need here
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Matchers for the Content-Type header (case-insensitive).
// - Header name must be lowercase ('content-type').
// - LOWERCASE transform makes value comparisons case-insensitive.

/**
 * CloudFormation requires SingleHeader to be { Name: 'header-name' } (capital N).
 * Some CDK versions end up synthesizing { name: ... } which CloudFormation rejects.
 * Force the correct CFN shape here.
 */
const singleHeaderCfn = (headerNameLower: string): any => ({
  singleHeader: { Name: headerNameLower },
});

/** Content-Type starts with the given prefix (e.g. 'application/json'). */
const ctStartsWith = (prefix: string): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch: singleHeaderCfn('content-type'),
    positionalConstraint: 'STARTS_WITH',
    searchString: prefix.toLowerCase(),
    textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
  },
});

/** Content-Type contains the given substring (e.g. '+json', 'spreadsheetml'). */
const ctContains = (substring: string): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch: singleHeaderCfn('content-type'),
    positionalConstraint: 'CONTAINS',
    searchString: substring.toLowerCase(),
    textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
  },
});

/**
 * A CDK Construct that provisions a regional AWS WAFv2 WebACL with common rules.
 */
export class WebAclConstruct extends Construct {
  /**
   * The ARN of the created WebACL. Useful for associating with other resources.
   */
  public readonly webAclArn: string;

  /**
   * Creates a regional Web Application Firewall (WAF) ACL.
   * @param scope The parent CDK Stack or Construct.
   * @param id The logical ID of this construct.
   * @param props Configuration properties for the WebACL.
   */
  constructor(scope: Construct, id: string, props: WebAclConstructProps) {
    super(scope, id);

    // Determine limit based on environment
    const rateLimit = props.environment === 'dev'
      ? WebAclConfig.rateLimitDev
      : WebAclConfig.rateLimitRelease;

    // Define the rules for the WebACL
    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      // 1) Rate limit - applies to all requests
      {
        name: 'RateLimitRule',
        priority: 1,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            limit: rateLimit,
            aggregateKeyType: 'IP',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'RateLimitRule',
        },
      },

      // 2) IP reputation - applies to all requests
      {
        name: 'IpReputation',
        priority: 2,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesAmazonIpReputationList',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'IpReputation',
        },
      },

      // 3) Binary content allow rule
      //
      //    Explicitly allows binary uploads and stops further processing.
      //
      //    Why: WAF's text-focused rules (XSS/command injection patterns) do not add meaningful
      //         protection for binary formats (e.g., XLSX, PDFs) and can produce false positives.
      //
      //    What happens:
      //      - Textual content (JSON, text/*, forms) -> continues to pattern matching rules below
      //      - Everything else (binary/unknown types) -> allowed here, stops processing
      //
      //    Security note:
      //      - Binary uploads still pass the rate limit and IP reputation checks above.
      //      - Perform file-type validation, size limits and malware scanning in the application.
      {
        name: 'AllowBinaryContent',
        priority: 3,
        action: { allow: {} },
        statement: {
          notStatement: {
            statement: {
              orStatement: {
                statements: [
                  ctStartsWith('application/json'),
                  ctContains('+json'), // vendor JSON types, e.g. application/ld+json, application/problem+json
                  ctStartsWith('text/'),
                  ctStartsWith('application/x-www-form-urlencoded'),
                ],
              },
            },
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'AllowBinaryContent',
        },
      },

      // 4) Common Rule Set - text-based attack detection (XSS, command injection, etc.)
      //
      //    Only textual requests reach this rule (binary was already allowed and stopped above).
      //    Body size restriction removed to allow larger textual POST requests.
      {
        name: 'CommonRuleSet',
        priority: 4,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesCommonRuleSet',
            // Allow larger POST bodies by excluding the size-based body rule from CRS.
            // Excluding a managed subrule changes its action to COUNT (not BLOCK).
            excludedRules: [
              { name: 'SizeRestrictions_BODY' },
              // Optional: if you also want to relax size checks for URL/query/headers, add:
              // { name: 'SizeRestrictions_QUERYSTRING' },
              // { name: 'SizeRestrictions_URI' },
              // { name: 'SizeRestrictions_URIPATH' },
              // { name: 'SizeRestrictions_HEADERS' },
              // { name: 'SizeRestrictions_Cookie_HEADER' },
            ],
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'CommonRuleSet',
        },
      },

      // 5) SQLi protection - only textual requests reach this rule
      {
        name: 'SQLiRuleSet',
        priority: 5,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: 'AWS',
            name: 'AWSManagedRulesSQLiRuleSet',
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          sampledRequestsEnabled: true,
          metricName: 'SQLiRuleSet',
        },
      },

      // 6) Bot control (optional, extra fee)
      // has the disadvantage of also blocking sone dev tools (like postman, curl) unless they
      // "spoof" - ie add extra headers to "pretend" they are different client browser
      // {
      //   name: 'BotControl',
      //   priority: 6,
      //   overrideAction: { none: {} },
      //   statement: {
      //     managedRuleGroupStatement: {
      //       vendorName: 'AWS',
      //       name: 'AWSManagedRulesBotControlRuleSet',
      //     },
      //   },
      //   visibilityConfig: {
      //     cloudWatchMetricsEnabled: true,
      //     sampledRequestsEnabled: true,
      //     metricName: 'BotControl',
      //   },
      // },
    ];

    // Create the CfnWebACL resource
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL', // Or 'CLOUDFRONT' if associating with CloudFront
      defaultAction: { allow: {} }, // Default behavior is to allow requests
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: `${props.serviceName}-${props.environment}-WAF`,
      },
      rules: rules, // Assign the defined rules
    });

    // Store the ARN in a public property
    this.webAclArn = webAcl.attrArn;
  }
}



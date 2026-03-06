// lib/constructs/storage.ts

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Properties for the StorageConstruct
 */
export interface StorageConstructProps {
  /** Optional bucket name for the S3 bucket */
  bucketName?: string;
  /** Whether to create bucket if it doesn't exist (default: true) */
  createIfNecessary?: boolean;
  /** Number of noncurrent versions to retain (default: 10, set to 0 to disable FIFO) */
  maxNoncurrentVersions?: number;
  /** Days after objects become noncurrent before deletion (default: 1) */
  noncurrentVersionExpirationDays?: number;
}

/**
 * A CDK construct that creates or imports an S3 bucket for storing application data.
 * The bucket is configured with versioning, server-side encryption,
 * and blocks all public access by default.
 */
export class StorageConstruct extends Construct {
  public readonly dataBucket?: s3.IBucket;

  /**
   * Creates or imports an S3 bucket with the specified configuration.
   * @param scope The CDK Stack or Construct that this construct belongs to
   * @param id The logical ID of this construct
   * @param props Optional properties, including a custom bucket name
   */
  constructor(scope: Construct, id: string, props: StorageConstructProps = {}) {
    super(scope, id);

    if (!props.bucketName) {
      console.log('[Storage] No bucket configured');
      return;
    }

    const shouldCreate = props.createIfNecessary !== false;

    if (shouldCreate) {
      // Default FIFO configuration
      const maxVersions = props.maxNoncurrentVersions ?? 10;
      const expirationDays = props.noncurrentVersionExpirationDays ?? 1;

      /**
       * Provisions an S3 bucket with the following configuration:
       * - bucketName: Uses the provided name or a default CDK-generated name
       * - encryption: Uses AWS-managed server-side encryption (SSE-S3)
       * - blockPublicAccess: Blocks all public access to the bucket and its objects
       * - versioned: Enables versioning to retain object versions
       * - lifecycleRules: Implements FIFO version limiting (keeps newest N versions)
       */
      this.dataBucket = new s3.Bucket(this, 'DataBucket', {
        bucketName: props.bucketName,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        versioned: true,

        // Prioritize safety over convenience
        // Prevent bucket deletion (on stack update (without bucket), or on stack delete)
        // Instead, the bucket to become "orphaned". 
        // Redeploying (with the same bucket name) will only succeed if you delete the bucket manually
        
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        // Non-empty buckets are never deleted (even with RemovalPolicy=DESTROY). autoDeleteObjects = true, allows cdk to empty them automatically before deletion
        // autoDeleteObjects: false,


        lifecycleRules: maxVersions > 0 ? [
          {
            // FIFO versioning: keeps only the N newest noncurrent versions
            noncurrentVersionExpiration: cdk.Duration.days(expirationDays),
            noncurrentVersionsToRetain: maxVersions,
          },
        ] : undefined,
      });
      console.log(`[Storage] Creating bucket: ${props.bucketName}`);
      if (maxVersions > 0) {
        console.log(`[Storage] FIFO versioning enabled: keeping ${maxVersions} noncurrent versions, ${expirationDays} day(s) grace period`);
      }
    } else {
      // Import existing bucket
      this.dataBucket = s3.Bucket.fromBucketName(this, 'DataBucket', props.bucketName);
      console.log(`[Storage] Importing existing bucket: ${props.bucketName}`);
    }
  }
}
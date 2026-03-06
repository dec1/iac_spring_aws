package dec.aws.service

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import dec.aws.model.S3ObjectMetadata
import dec.aws.model.S3ObjectMetadataRaw
import org.springframework.stereotype.Service
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider
import software.amazon.awssdk.core.sync.RequestBody
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.*
import software.amazon.awssdk.services.sts.StsClient
import software.amazon.awssdk.services.sts.model.GetCallerIdentityRequest

/**
 * AWS Service Wrapper - handles S3 and STS connections.
 * * Logic Note:
 * Region, Credentials, Endpoints, and S3 Addressing Styles are resolved
 * automatically by the SDK's default chains. It checks:
 * 1. Environment Variables (AWS_REGION, AWS_PROFILE, etc.)
 * 2. System Properties
 * 3. ~/.aws/config and ~/.aws/credentials
 * 4. ECS/Instance Metadata (in CI/CD)
 */
data class CallerIdentity(
    val userId: String?,
    val account: String?,
    val arn: String?
) {
    override fun toString(): String {
        return "CallerIdentity:\n" +
                "  User ID: $userId\n" +
                "  Account: $account\n" +
                "  ARN: $arn"
    }
}

@Service
class Aws {
    private val objectMapper = ObjectMapper()

    // Client builders with no explicit configuration default to the "Default Chain"
    private val s3Client: S3Client = S3Client.builder()
        .credentialsProvider(DefaultCredentialsProvider.create())
        .build()

    private val stsClient: StsClient = StsClient.builder()
        .credentialsProvider(DefaultCredentialsProvider.create())
        .build()

    fun test(): String {
        return query_caller_id()
    }

    fun query_caller_id(): String {
        val request = GetCallerIdentityRequest.builder().build()
        val response = stsClient.getCallerIdentity(request)

        val callerIdentity = CallerIdentity(
            userId = response.userId(),
            account = response.account(),
            arn = response.arn()
        )
        return callerIdentity.toString()
    }

    // --------------------------------------------------------------------------------
    // S3 LISTING / QUERY
    // --------------------------------------------------------------------------------

    fun s3_ls(): String {
        var ret = "s3_ls Failed"
        try {
            val listBucketsResponse = s3Client.listBuckets()
            val buckets = listBucketsResponse.buckets()

            ret = if (buckets.isEmpty()) {
                "No buckets found."
            } else {
                "Buckets:\n" + buckets.joinToString("\n") { "- ${it.name()} (Created: ${it.creationDate()})" }
            }
        } catch (e: S3Exception) {
            ret = "S3 error occurred: ${e.awsErrorDetails().errorMessage()}"
        } catch (e: Exception) {
            ret = "An unexpected error occurred: ${e.message}"
        }
        println(ret)
        return ret
    }

    fun s3_query(bucketName: String): String {
        var ret = "s3_query Failed"
        try {
            val listObjectsRequest = ListObjectsV2Request.builder()
                .bucket(bucketName)
                .build()

            val listObjectsResponse = s3Client.listObjectsV2(listObjectsRequest)

            ret = "Objects in bucket '$bucketName': <br>" +
                    listObjectsResponse.contents().joinToString("<br>") { "- ${it.key()} (Size: ${it.size()} bytes)" }

        } catch (e: S3Exception) {
            ret = "S3 error occurred: ${e.awsErrorDetails().errorMessage()}"
        } catch (e: Exception) {
            ret = "An unexpected error occurred: ${e.message}"
        }
        println(ret)
        return ret
    }

    // --------------------------------------------------------------------------------
    // S3 WRITE OPERATIONS
    // --------------------------------------------------------------------------------

    fun s3_insert(bucketName: String, objectKey: String, content: String): String {
        return try {
            val putObjectRequest = PutObjectRequest.builder()
                .bucket(bucketName)
                .key(objectKey)
                .build()

            s3Client.putObject(putObjectRequest, RequestBody.fromString(content))
            "Successfully added object '$objectKey' to bucket '$bucketName'."
        } catch (e: S3Exception) {
            "S3 error occurred: ${e.awsErrorDetails().errorMessage()}"
        } catch (e: Exception) {
            "An unexpected error occurred: ${e.message}"
        }.also { println(it) }
    }

    fun s3_put_object(
        bucketName: String,
        objectKey: String,
        data: ByteArray,
        tags: Map<String, String> = emptyMap(),
        contentType: String = "application/octet-stream"
    ): S3ObjectMetadata {
        try {
            val putObjectRequest = PutObjectRequest.builder()
                .bucket(bucketName)
                .key(objectKey)
                .contentType(contentType)
                .apply {
                    if (tags.isNotEmpty()) {
                        tagging(
                            Tagging.builder()
                                .tagSet(tags.map { Tag.builder().key(it.key).value(it.value).build() })
                                .build()
                        )
                    }
                }
                .build()

            val putResponse = s3Client.putObject(putObjectRequest, RequestBody.fromBytes(data))

            // Metadata confirmation via HEAD
            val headResponse = s3Client.headObject(
                HeadObjectRequest.builder().bucket(bucketName).key(objectKey).build()
            )

            return S3ObjectMetadata(
                data = null,
                lastModified = headResponse.lastModified(),
                etag = putResponse.eTag(),
                contentLength = data.size.toLong(),
                contentType = contentType,
                versionId = putResponse.versionId(),
                tags = tags
            )
        } catch (e: S3Exception) {
            throw RuntimeException("S3 error: ${e.awsErrorDetails().errorMessage()}", e)
        } catch (e: Exception) {
            throw RuntimeException("Unexpected error: ${e.message}", e)
        }
    }

    fun s3_put_object(
        bucketName: String,
        objectKey: String,
        data: JsonNode,
        tags: Map<String, String> = emptyMap()
    ): S3ObjectMetadata {
        val jsonBytes = objectMapper.writeValueAsBytes(data)
        return s3_put_object(bucketName, objectKey, jsonBytes, tags, contentType = "application/json")
    }

    // --------------------------------------------------------------------------------
    // S3 READ OPERATIONS
    // --------------------------------------------------------------------------------

    fun s3_head_object_metadata(bucketName: String, objectKey: String): S3ObjectMetadata {
        try {
            val headResponse = s3Client.headObject(
                HeadObjectRequest.builder().bucket(bucketName).key(objectKey).build()
            )

            val tags = try {
                s3Client.getObjectTagging(
                    GetObjectTaggingRequest.builder().bucket(bucketName).key(objectKey).build()
                ).tagSet().associate { it.key() to it.value() }
            } catch (_: Exception) {
                emptyMap()
            }

            return S3ObjectMetadata(
                data = null,
                lastModified = headResponse.lastModified(),
                etag = headResponse.eTag(),
                contentLength = headResponse.contentLength(),
                contentType = headResponse.contentType(),
                versionId = headResponse.versionId(),
                tags = tags
            )
        } catch (e: Exception) {
            throw RuntimeException("Failed to fetch object metadata: ${e.message}", e)
        }
    }

    fun s3_get_object_raw(bucketName: String, objectKey: String): S3ObjectMetadataRaw {
        try {
            val respBytes = s3Client.getObjectAsBytes(
                GetObjectRequest.builder().bucket(bucketName).key(objectKey).build()
            )
            val meta = respBytes.response()
            val bytes = respBytes.asByteArray()

            return S3ObjectMetadataRaw(
                data = bytes,
                lastModified = meta.lastModified(),
                etag = meta.eTag(),
                contentLength = bytes.size.toLong(),
                contentType = meta.contentType()
            )
        } catch (e: Exception) {
            throw RuntimeException("Failed to download raw object: ${e.message}", e)
        }
    }

    fun s3_get_object_with_metadata(bucketName: String, objectKey: String): S3ObjectMetadata {
        val raw = s3_get_object_raw(bucketName, objectKey)
        val jsonData = objectMapper.readTree(raw.data)

        val tags = try {
            s3Client.getObjectTagging(
                GetObjectTaggingRequest.builder().bucket(bucketName).key(objectKey).build()
            ).tagSet().associate { it.key() to it.value() }
        } catch (_: Exception) {
            emptyMap()
        }

        return S3ObjectMetadata(
            data = jsonData,
            lastModified = raw.lastModified,
            etag = raw.etag,
            contentLength = raw.contentLength,
            contentType = raw.contentType,
            versionId = null,
            tags = tags
        )
    }
}
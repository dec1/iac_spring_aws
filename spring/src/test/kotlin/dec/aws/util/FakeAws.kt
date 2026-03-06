package dec.aws.util

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import java.time.Instant
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import dec.aws.model.S3ObjectMetadata
import dec.aws.model.S3ObjectMetadataRaw
import dec.aws.service.Aws



/**
 * FakeAws: A deterministic, in-memory simulation of the S3 service.
 *
 * WHY: We need to test logic that depends on S3 metadata (like "Is this file newer
 * than the last one?") without the flakiness of a real network or the speed
 * variations of the system clock.
 *
 * THE MANUAL CLOCK:
 * Real S3 assigns timestamps. Here, we use a manual 'Instant' that we control.
 * Every 'put' operation ticks the clock forward exactly 1 second.
 * This guarantees that Version 2 always has a later timestamp than Version 1,
 * making our sorting and versioning tests 100% predictable.
 */
class FakeAws : Aws() {

    private val mapper = ObjectMapper().registerKotlinModule()

    private data class StoredObject(
        val bytes: ByteArray,
        val contentType: String,
        val lastModified: Instant,
        val etag: String,
        val versionId: String,
        val tags: Map<String, String>
    ) {
        val contentLength: Long = bytes.size.toLong()
    }

    // Store data in a map: Key -> StoredObject (includes metadata per key)
    private val storage = mutableMapOf<String, StoredObject>()

    // Track metadata deterministically
    private var current: Instant = Instant.parse("2025-01-01T00:00:00Z")
    private var versionCounter: Long = 0

    fun setTime(t: Instant) { current = t }

    fun reset() {
        storage.clear()
        current = Instant.parse("2025-01-01T00:00:00Z")
        versionCounter = 0
    }

    // --- PUT (Raw Bytes) ---
    override fun s3_put_object(
        bucketName: String,
        objectKey: String,
        data: ByteArray,
        tags: Map<String, String>,
        contentType: String
    ): S3ObjectMetadata {
        current = current.plusSeconds(1)
        versionCounter += 1

        val versionId = "v$versionCounter"
        val etag = "\"fake-etag-${current.epochSecond}\""

        // Store in memory (per-key metadata)
        storage[objectKey] = StoredObject(
            bytes = data,
            contentType = contentType,
            lastModified = current,
            etag = etag,
            versionId = versionId,
            tags = tags
        )

        return S3ObjectMetadata(
            data = null,
            lastModified = current,
            etag = etag,
            contentLength = data.size.toLong(),
            contentType = contentType,
            versionId = versionId,
            tags = tags
        )
    }

    // --- PUT (JSON wrapper) ---
    override fun s3_put_object(
        bucketName: String,
        objectKey: String,
        data: JsonNode,
        tags: Map<String, String>
    ): S3ObjectMetadata {
        val bytes = mapper.writeValueAsBytes(data)
        return s3_put_object(bucketName, objectKey, bytes, tags, "application/json")
    }

    // --- GET (Raw Bytes) ---
    override fun s3_get_object_raw(bucketName: String, objectKey: String): S3ObjectMetadataRaw {
        val obj = storage[objectKey] ?: throw RuntimeException("NoSuchKey: $objectKey")

        return S3ObjectMetadataRaw(
            data = obj.bytes,
            lastModified = obj.lastModified,
            etag = obj.etag,
            contentLength = obj.contentLength,
            contentType = obj.contentType
        )
    }

    // --- GET (JSON wrapper) ---
    override fun s3_get_object_with_metadata(bucketName: String, objectKey: String): S3ObjectMetadata {
        val obj = storage[objectKey] ?: throw RuntimeException("NoSuchKey: $objectKey")
        val jsonNode = mapper.readTree(obj.bytes)

        return S3ObjectMetadata(
            data = jsonNode,
            lastModified = obj.lastModified,
            etag = obj.etag,
            contentLength = obj.contentLength,
            contentType = obj.contentType,
            versionId = obj.versionId,
            tags = obj.tags
        )
    }

    // --- HEAD (Metadata only) ---
    override fun s3_head_object_metadata(bucketName: String, objectKey: String): S3ObjectMetadata {
        val obj = storage[objectKey] ?: return S3ObjectMetadata(
            data = null,
            lastModified = current, // deterministic fallback
            etag = "",
            contentLength = 0,
            contentType = "",
            versionId = "",
            tags = emptyMap()
        )

        return S3ObjectMetadata(
            data = null,
            lastModified = obj.lastModified,
            etag = obj.etag,
            contentLength = obj.contentLength,
            contentType = obj.contentType,
            versionId = obj.versionId,
            tags = obj.tags
        )
    }
}

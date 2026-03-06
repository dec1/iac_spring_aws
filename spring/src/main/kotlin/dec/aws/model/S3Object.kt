package dec.aws.model
import com.fasterxml.jackson.databind.JsonNode
import java.time.Instant


data class S3ObjectMetadata(
    val data: JsonNode?,  // ← Now nullable to support non-JSON data
    val lastModified: Instant,
    val etag: String,
    val contentLength: Long,
    val contentType: String?,
    val versionId: String?,
    val tags: Map<String, String> = emptyMap()
)

data class S3ObjectMetadataRaw(
    val data: ByteArray,
    val lastModified: Instant,
    val etag: String,
    val contentLength: Long,
    val contentType: String?
)
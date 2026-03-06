package dec.aws.controller

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import dec.aws.config.S3Config
import dec.aws.service.Aws
import dec.aws.service.ImageValidator
import dec.aws.service.ProductsValidator
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import jakarta.servlet.http.HttpServletRequest

abstract class AbstractProductsController(
    protected val s3Config: S3Config,
    protected val aws: Aws,
    protected val productsValidator: ProductsValidator,
    protected val imageValidator: ImageValidator
) {
    protected val imageObjectKey = "products-image"
    protected val productsObjectKey = "products-catalog"
    protected val objectMapper = ObjectMapper()

    private val filenameHeader = "X-Filename"
    private val filenameTagKey = "filename"

    // -----------------------------------------------------------------------
    // Versions  (metadata for both resources)
    // -----------------------------------------------------------------------

    protected fun executeGetVersions(): ResponseEntity<Any> {
        val products = aws.s3_head_object_metadata(s3Config.bucketName, productsObjectKey)
        val image = aws.s3_head_object_metadata(s3Config.bucketName, imageObjectKey)

        val response = mapOf(
            "versions" to mapOf(
                "products" to mapOf(
                    "version" to products.lastModified.epochSecond,
                    "lastModified" to products.lastModified.toString()
                ),
                "image" to mapOf(
                    "version" to image.lastModified.epochSecond,
                    "lastModified" to image.lastModified.toString()
                )
            )
        )
        return ResponseEntity.ok(response)
    }

    // -----------------------------------------------------------------------
    // Products  (JSON resource)
    // -----------------------------------------------------------------------

    protected fun executeGetProducts(
        pretty: Boolean
    ): ResponseEntity<Any> {
        val metadata = aws.s3_get_object_with_metadata(s3Config.bucketName, productsObjectKey)
        val response = objectMapper.createObjectNode().apply {
            set<JsonNode>("meta", objectMapper.createObjectNode().apply {
                put("version", metadata.lastModified.epochSecond)
                put("lastModified", metadata.lastModified.toString())
            })
            setAll<JsonNode>(metadata.data as ObjectNode)
        }
        return if (pretty) ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(response))
        else ResponseEntity.ok(response)
    }

    protected fun executePostProducts(
        data: JsonNode,
        tags: Map<String, String>?
    ): ResponseEntity<Map<String, Any>> {
        productsValidator.validate(data)
        val metadata = aws.s3_put_object(s3Config.bucketName, productsObjectKey, data, tags ?: emptyMap())
        return ResponseEntity.ok(linkedMapOf(
            "success" to true,
            "message" to "Products uploaded successfully",
            "version" to metadata.lastModified.epochSecond,
            "lastModified" to metadata.lastModified.toString(),
            "etag" to metadata.etag,
            "contentLength" to metadata.contentLength
        ))
    }

    // -----------------------------------------------------------------------
    // Images  (binary resource)
    // -----------------------------------------------------------------------

    protected fun executeGetImage(): ResponseEntity<ByteArray> {
        val response = aws.s3_get_object_raw(s3Config.bucketName, imageObjectKey)

        val head = aws.s3_head_object_metadata(s3Config.bucketName, imageObjectKey)
        val filename = head.tags[filenameTagKey]?.takeIf { it.isNotBlank() } ?: "image.bin"

        val builder = ResponseEntity.ok()
            .header("Content-Type", "application/octet-stream")
            .contentLength(response.contentLength)
            .header("ETag", response.etag)
            .header("S3d-Meta-LastModified", response.lastModified.toString())
            .header("S3d-Meta-Version", response.lastModified.epochSecond.toString())
            .header("Cache-Control", "no-transform")
            .header("Content-Transfer-Encoding", "binary")
            .header("Content-Disposition", """attachment; filename="$filename"""")

        return builder.body(response.data)
    }

    protected fun executePostImage(
        request: HttpServletRequest,
        tags: Map<String, String>?
    ): ResponseEntity<Map<String, Any>> {
        val data = request.inputStream.readAllBytes()
        val incomingCt = request.contentType

        // Validate before persisting: non-empty + size limit.
        // Content-Type is treated as metadata only and is not validated.
        imageValidator.validate(data)

        // Optional: client-provided filename for downstream UX on GET (Content-Disposition).
        // Avoid path traversal; keep a safe basename only.
        val incomingFilename = sanitizeFilename(request.getHeader(filenameHeader))

        val safeContentType = if (incomingCt.isNullOrBlank() || incomingCt.contains("*")) "application/octet-stream" else incomingCt

        val mergedTags = linkedMapOf<String, String>().apply {
            putAll(tags ?: emptyMap())
            if (!incomingFilename.isNullOrBlank()) {
                put(filenameTagKey, incomingFilename)
            }
        }

        val metadata = aws.s3_put_object(
            s3Config.bucketName,
            imageObjectKey,
            data,
            mergedTags,
            contentType = safeContentType
        )

        return ResponseEntity.ok(linkedMapOf(
            "success" to true,
            "message" to "Image uploaded successfully",
            "version" to metadata.lastModified.epochSecond,
            "lastModified" to metadata.lastModified.toString(),
            "etag" to metadata.etag,
            "contentLength" to metadata.contentLength,
            "contentType" to (metadata.contentType ?: "application/octet-stream"),
            "filename" to (mergedTags[filenameTagKey] ?: "")
        ))
    }

    private fun sanitizeFilename(raw: String?): String? {
        if (raw.isNullOrBlank()) return null

        // Drop any path components (both Unix and Windows separators)
        var name = raw.trim()
        name = name.substringAfterLast('/')
        name = name.substringAfterLast('\\')

        // Remove quotes and control chars; keep a conservative set of characters
        name = name.replace("\"", "")
        name = name.filter { ch ->
            ch.code in 0x20..0x7E && ch !in listOf('<', '>', ':', '|', '?', '*')
        }

        // Avoid empty / dot names
        if (name.isBlank() || name == "." || name == "..") return null

        return name
    }
}
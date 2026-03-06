package dec.aws.controller

import com.fasterxml.jackson.databind.JsonNode
import io.swagger.v3.oas.annotations.Operation
import io.swagger.v3.oas.annotations.Parameter
import io.swagger.v3.oas.annotations.media.Content
import io.swagger.v3.oas.annotations.media.Schema
import io.swagger.v3.oas.annotations.parameters.RequestBody
import io.swagger.v3.oas.annotations.responses.ApiResponse
import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RequestParam

interface ProductsApi {

    @Operation(
        summary = "Download version metadata",
        description = "Returns version number and lastModified (ISO) timestamp as JSON, for the most recently uploaded products and images."
    )
    fun getVersions(): ResponseEntity<Any>

    // -----------------------------------------------------------------------
    // Products  (JSON resource)
    // -----------------------------------------------------------------------

    @Operation(
        summary = "Download products",
        description = "Returns the most recently uploaded product catalog as JSON, together with its version metadata."
    )
    fun getProducts(
        @Parameter(description = "Formats the JSON output (indentation and newlines) to facilitate reading by humans.")
        pretty: Boolean
    ): ResponseEntity<Any>

    @Operation(
        summary = "Upload products",
        description = "Uploads a product catalog as JSON. Validates structure before persisting. Returns version metadata on success."
    )
    fun postProducts(
        @RequestBody data: JsonNode,
        @Parameter(description = "Optional key-value pairs stored as S3 object metadata tags.")
        @RequestParam(required = false) tags: Map<String, String>?
    ): ResponseEntity<Map<String, Any>>

    // -----------------------------------------------------------------------
    // Images  (binary resource)
    // -----------------------------------------------------------------------
    @Operation(
        summary = "Upload image",
        description = "Uploads raw bytes. The payload is treated as application/octet-stream regardless of the incoming Content-Type header.",
        requestBody = RequestBody(
            required = true,
            content = [
                Content(
                    mediaType = "application/octet-stream",
                    schema = Schema(type = "string", format = "binary")
                )
            ]
        )
    )
    fun postImage(
        request: HttpServletRequest,
        @RequestParam(required = false) tags: Map<String, String>?
    ): ResponseEntity<Map<String, Any>>

    @Operation(
        summary = "Download image",
        description = "Returns the raw bytes as application/octet-stream.",
        responses = [
            ApiResponse(
                responseCode = "200",
                description = "Binary stream",
                content = [Content(mediaType = "application/octet-stream")]
            )
        ]
    )
    fun getImage(): ResponseEntity<ByteArray>
}
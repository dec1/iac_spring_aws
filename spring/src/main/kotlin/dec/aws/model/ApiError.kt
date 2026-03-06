package dec.aws.model

import java.time.Instant
import io.swagger.v3.oas.annotations.media.Schema


//data class ApiError(
//    val status: Int,          // HTTP Status Code (e.g. 400, 401, 403)
//    val error: String,        // Short text description (e.g. "Bad Request")
//    val message: String,      // User-friendly explanation
//    val timestamp: String = Instant.now().toString()
//)

@Schema(
    name = "ApiError",
    description = "Standard error payload returned by this API.",
    example = """{"status":400,"error":"Bad Request","message":"Validation failed: missing field 'x'","timestamp":"2026-01-01T12:00:00Z"}"""
)
data class ApiError(
    @field:Schema(description = "HTTP status code", example = "400")
    val status: Int,

    @field:Schema(description = "Short status text", example = "Bad Request")
    val error: String,

    @field:Schema(description = "Human-readable explanation", example = "Validation failed: ...")
    val message: String,

    @field:Schema(description = "UTC timestamp", example = "2026-01-01T12:00:00Z")
    val timestamp: String = Instant.now().toString()
)
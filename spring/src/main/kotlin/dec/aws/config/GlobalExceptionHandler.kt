package dec.aws.config

import dec.aws.model.ApiError
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.security.access.AccessDeniedException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.server.ResponseStatusException
import software.amazon.awssdk.services.s3.model.NoSuchKeyException

@RestControllerAdvice
class GlobalExceptionHandler {

    // 1. AWS S3 Not Found Errors
    // Catches direct NoSuchKeyException OR RuntimeExceptions wrapping it (from Aws service)
    @ExceptionHandler(value = [NoSuchKeyException::class, RuntimeException::class])
    fun handleAwsErrors(ex: Exception): ResponseEntity<ApiError> {
        // Check for S3 "Not Found" signatures (either direct exception or wrapped in RuntimeException by Aws service)
        val isNotFound = ex is NoSuchKeyException ||
                (ex is RuntimeException && (ex.message?.contains("NoSuchKey") == true || ex.message?.contains("does not exist") == true)) ||
                (ex.cause is NoSuchKeyException)

        if (isNotFound) {
            val error = ApiError(
                status = HttpStatus.NOT_FOUND.value(),
                error = "Not Found",
                message = "The requested data/resource does not exist."
            )
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(error)
        }

        // If it's a generic RuntimeException not related to 404, delegate to generic handler
        if (ex is RuntimeException) return handleGeneric(ex)

        return handleGeneric(ex)
    }

    // 2. Manual Logic Errors (throw ResponseStatusException(...))
    @ExceptionHandler(ResponseStatusException::class)
    fun handleResponseStatus(ex: ResponseStatusException): ResponseEntity<ApiError> {
        val error = ApiError(
            status = ex.statusCode.value(),
            error = ex.statusCode.toString(),
            message = ex.reason ?: "An error occurred"
        )
        return ResponseEntity.status(ex.statusCode).body(error)
    }

    // 3. Invalid JSON Syntax (e.g. malformed POST body)
    @ExceptionHandler(HttpMessageNotReadableException::class)
    fun handleJsonErrors(ex: HttpMessageNotReadableException): ResponseEntity<ApiError> {
        val error = ApiError(
            status = HttpStatus.BAD_REQUEST.value(),
            error = "Bad Request",
            message = "Malformed JSON request. Please check your syntax."
        )
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(error)
    }

    // 4. Security: Authorized but Forbidden (@PreAuthorize failure)
    @ExceptionHandler(AccessDeniedException::class)
    fun handleAccessDenied(ex: AccessDeniedException): ResponseEntity<ApiError> {
        val error = ApiError(
            status = HttpStatus.FORBIDDEN.value(),
            error = "Forbidden",
            message = "You do not have permission to perform this action."
        )
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(error)
    }

    // 5. Catch-All for unexpected crashes
    @ExceptionHandler(Exception::class)
    fun handleGeneric(ex: Exception): ResponseEntity<ApiError> {
        ex.printStackTrace() // Log for developers
        val error = ApiError(
            status = HttpStatus.INTERNAL_SERVER_ERROR.value(),
            error = "Internal Server Error",
            message = "An unexpected system error occurred: ${ex.message}"
        )
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(error)
    }
}
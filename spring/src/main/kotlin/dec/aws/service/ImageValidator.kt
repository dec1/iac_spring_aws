package dec.aws.service

import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.web.server.ResponseStatusException

/**
 * Validates a binary upload before it is persisted to S3.
 *
 * This API treats the payload as opaque bytes. The HTTP Content-Type header is
 * accepted as metadata only and is not validated or cross-checked.
 *
 * Checks:
 * 1. Non-empty payload
 * 2. File size is within limits
 */
@Service
class ImageValidator {

    companion object {
        /** Maximum allowed image size: 10 MB */
        const val MAX_IMAGE_SIZE_BYTES: Long = 10 * 1024 * 1024
    }

    fun validate(
        data: ByteArray
    ) {
        // 1. Non-empty
        if (data.isEmpty()) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Image payload must not be empty.")
        }

        // 2. File size
        if (data.size > MAX_IMAGE_SIZE_BYTES) {
            throw ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                "Image exceeds maximum allowed size of ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)} MB."
            )
        }
    }
}
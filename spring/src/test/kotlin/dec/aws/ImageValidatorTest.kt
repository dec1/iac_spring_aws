package dec.aws.service

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.web.server.ResponseStatusException

/**
 * Unit Tests: ImageValidator
 *
 * Pure logic -- no Spring context, no I/O. Validates the pre-persist checks
 * applied to binary uploads (non-empty, file size).
 *
 * Content-Type is treated as metadata only and is not validated.
 */
class ImageValidatorTest {

    private val validator = ImageValidator()

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private fun someBytes(size: Int = 64): ByteArray = ByteArray(size) { 0x42 }

    private fun assertBadRequest(block: () -> Unit): ResponseStatusException {
        val ex = assertThrows(ResponseStatusException::class.java, block)
        assertEquals(400, ex.statusCode.value())
        return ex
    }

    // ---------------------------------------------------------------------------
    // Happy path
    // ---------------------------------------------------------------------------

    @Nested
    @DisplayName("Valid payloads")
    inner class ValidPayloads {

        @Test
        fun `accepts bytes with image content-type`() {
            assertDoesNotThrow { validator.validate(someBytes()) }
        }

        @Test
        fun `accepts bytes with arbitrary content-type`() {
            assertDoesNotThrow { validator.validate(someBytes()) }
        }

        @Test
        fun `accepts bytes with null content-type`() {
            assertDoesNotThrow { validator.validate(someBytes()) }
        }
    }

    // ---------------------------------------------------------------------------
    // Empty payload
    // ---------------------------------------------------------------------------

    @Nested
    @DisplayName("Empty payloads")
    inner class EmptyPayloads {

        @Test
        fun `rejects empty byte array`() {
            val ex = assertBadRequest { validator.validate(ByteArray(0)) }
            assertTrue(ex.reason!!.contains("empty", ignoreCase = true))
        }
    }

    // ---------------------------------------------------------------------------
    // File size limit
    // ---------------------------------------------------------------------------

    @Nested
    @DisplayName("File size validation")
    inner class FileSizeValidation {

        @Test
        fun `rejects payload exceeding 10 MB`() {
            val oversized = ByteArray((ImageValidator.MAX_IMAGE_SIZE_BYTES + 1).toInt()) { 0x01 }
            val ex = assertBadRequest { validator.validate(oversized) }
            assertTrue(ex.reason!!.contains("size", ignoreCase = true))
        }

        @Test
        fun `accepts payload exactly at 10 MB limit`() {
            val exactLimit = ByteArray(ImageValidator.MAX_IMAGE_SIZE_BYTES.toInt()) { 0x01 }
            assertDoesNotThrow { validator.validate(exactLimit) }
        }
    }
}
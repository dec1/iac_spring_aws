package dec.aws.service

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.springframework.web.server.ResponseStatusException

/**
 * Unit Tests: ProductsValidator
 *
 * Pure logic -- no Spring context, no I/O. Validates the structural checks
 * applied to a product catalog JSON payload before it reaches S3.
 */
class ProductsValidatorTest {

    private val validator = ProductsValidator()
    private val mapper = ObjectMapper()

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /** Build a valid catalog with N products. */
    private fun validCatalog(count: Int = 2) = mapper.readTree(
        """
        {
          "products": [
            ${(1..count).joinToString(",") { """{"id": "p$it", "name": "Product $it"}""" }}
          ]
        }
        """.trimIndent()
    )

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
        fun `accepts a minimal valid catalog`() {
            assertDoesNotThrow { validator.validate(validCatalog(1)) }
        }

        @Test
        fun `accepts catalog with extra fields on products`() {
            val json = mapper.readTree("""
                { "products": [{"id": "x1", "name": "Widget", "price": 9.99, "tags": ["sale"]}] }
            """.trimIndent())
            assertDoesNotThrow { validator.validate(json) }
        }

        @Test
        fun `accepts catalog with extra top-level fields`() {
            val json = mapper.readTree("""
                { "products": [{"id": "x1", "name": "Widget"}], "meta": {"source": "import"} }
            """.trimIndent())
            assertDoesNotThrow { validator.validate(json) }
        }
    }

    // ---------------------------------------------------------------------------
    // Structural rejections
    // ---------------------------------------------------------------------------

    @Nested
    @DisplayName("Structural rejections")
    inner class StructuralRejections {

        @Test
        fun `rejects empty object`() {
            val ex = assertBadRequest { validator.validate(mapper.readTree("{}")) }
            assertTrue(ex.reason!!.contains("empty", ignoreCase = true))
        }

        @Test
        fun `rejects null node`() {
            val ex = assertBadRequest { validator.validate(mapper.readTree("null")) }
            assertTrue(ex.reason!!.contains("empty", ignoreCase = true))
        }

        @Test
        fun `rejects missing products field`() {
            val json = mapper.readTree("""{"items": []}""")
            val ex = assertBadRequest { validator.validate(json) }
            assertTrue(ex.reason!!.contains("products", ignoreCase = true))
        }

        @Test
        fun `rejects products as non-array`() {
            val json = mapper.readTree("""{"products": "not-an-array"}""")
            val ex = assertBadRequest { validator.validate(json) }
            assertTrue(ex.reason!!.contains("array", ignoreCase = true))
        }

        @Test
        fun `rejects products as object instead of array`() {
            val json = mapper.readTree("""{"products": {"id": "x1", "name": "Widget"}}""")
            val ex = assertBadRequest { validator.validate(json) }
            assertTrue(ex.reason!!.contains("array", ignoreCase = true))
        }
    }

    // ---------------------------------------------------------------------------
    // Per-product field validation
    // ---------------------------------------------------------------------------

    @Nested
    @DisplayName("Per-product field validation")
    inner class PerProductValidation {

        @Test
        fun `rejects product missing id`() {
            val json = mapper.readTree("""{"products": [{"name": "Widget"}]}""")
            val ex = assertBadRequest { validator.validate(json) }
            assertTrue(ex.reason!!.contains("id", ignoreCase = true))
            assertTrue(ex.reason!!.contains("index 0"))
        }

        @Test
        fun `rejects product missing name`() {
            val json = mapper.readTree("""{"products": [{"id": "x1"}]}""")
            val ex = assertBadRequest { validator.validate(json) }
            assertTrue(ex.reason!!.contains("name", ignoreCase = true))
            assertTrue(ex.reason!!.contains("index 0"))
        }

        @Test
        fun `reports correct index for second product`() {
            val json = mapper.readTree("""
                {"products": [
                    {"id": "x1", "name": "OK"},
                    {"id": "x2"}
                ]}
            """.trimIndent())
            val ex = assertBadRequest { validator.validate(json) }
            assertTrue(ex.reason!!.contains("index 1"))
        }
    }
}

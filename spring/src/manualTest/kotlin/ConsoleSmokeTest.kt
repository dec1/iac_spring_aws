// src/manualTest/kotlin/ConsoleSmokeTest.kt
package dec.aws.service.local.console

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import dec.aws.service.ImageValidator
import dec.aws.service.ProductsValidator
import dec.aws.util.TestDataDefaults
import org.junit.jupiter.api.Test
import org.springframework.core.io.ClassPathResource
import kotlin.test.assertTrue

/**
 * Console Smoke Test
 * ------------------
 * Quick human-readable sanity check. Loads the shared test fixtures from
 * the classpath, exercises the validators, and prints diagnostic output.
 *
 * Run with:
 *   ./gradlew manualTest --tests "*ConsoleSmokeTest"
 *
 * Output sections:
 *   1) "Product Catalog Fixture"   -> Pretty-printed JSON loaded from file
 *   2) "Products Validation"       -> Runs ProductsValidator against the fixture
 *   3) "Image Fixture"             -> Loads sample image, reports size and leading bytes
 *   4) "Image Validation"          -> Runs ImageValidator against the fixture
 *   5) "JSON Round-Trip"           -> Serialize -> deserialize -> compare
 *
 * If any validation fails, the test fails with a diagnostic report.
 */
class ConsoleSmokeTest {

    private val mapper = ObjectMapper().registerKotlinModule()
    private val productsValidator = ProductsValidator()
    private val imageValidator = ImageValidator()

    @Test
    fun `smoke test - load fixtures, validate, and round-trip`() {
        val productsRes = ClassPathResource(TestDataDefaults.PRODUCTS_NAME)
        val imageRes = ClassPathResource(TestDataDefaults.IMAGE_NAME)

        println(
            """
            |============================== Console Smoke Test ==============================
            |Purpose:
            |  - Load test fixtures from classpath:
            |      Products: ${productsRes.path}
            |      Image:    ${imageRes.path}
            |  - Validate using production validators (ProductsValidator, ImageValidator)
            |  - Print human-readable diagnostics
            |  - Verify JSON round-trip fidelity
            |
            |Notes:
            |  - ImageValidator treats the payload as opaque bytes:
            |      - validates non-empty + max size only
            |      - does NOT validate Content-Type or magic bytes
            |===============================================================================
            """.trimMargin()
        )

        // --- 1. Load and display product catalog fixture ---
        require(productsRes.exists()) { "Missing test resource: ${productsRes.path}" }
        val productsJson = productsRes.inputStream.use { it.readAllBytes().toString(Charsets.UTF_8) }
        val catalog = mapper.readTree(productsJson)

        println("\n== Product Catalog Fixture (${TestDataDefaults.PRODUCTS_NAME}) ==")
        println(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(catalog))
        println("Product count: ${catalog["products"].size()}")
        println("Serialized size: ${productsJson.toByteArray().size} bytes")

        // --- 2. Products validation ---
        println("\n== Products Validation ==")
        try {
            productsValidator.validate(catalog)
            println("PASS: Catalog is structurally valid")
            println("  - Has top-level 'products' array: yes")
            println("  - Each product has 'id' and 'name': yes")
            catalog["products"].forEachIndexed { i, p ->
                println("  - [$i] id=${p["id"].asText()}, name=${p["name"].asText()}")
            }
        } catch (e: Exception) {
            println("FAIL: ${e.message}")
            throw e
        }

        // --- 3. Load and display image fixture ---
        require(imageRes.exists()) { "Missing test resource: ${imageRes.path}" }
        val imageBytes = imageRes.inputStream.use { it.readAllBytes() }

        println("\n== Image Fixture (${TestDataDefaults.IMAGE_NAME}) ==")
        println("Size: ${imageBytes.size} bytes")
        println("First 8 bytes (hex): ${imageBytes.take(8).joinToString(" ") { "%02x".format(it) }}")

        // --- 4. Image validation (fixture file) ---
        println("\n== Image Validation (fixture) ==")
        try {
            imageValidator.validate(imageBytes) // treated as metadata only
            println("PASS: Fixture payload passes non-empty + size validation")
        } catch (e: Exception) {
            println("FAIL: ${e.message}")
            throw e
        }

        // --- 5. JSON round-trip ---
        println("\n== JSON Round-Trip ==")
        val serialized = mapper.writeValueAsString(catalog)
        val deserialized = mapper.readTree(serialized)
        val match = catalog == deserialized
        println("Original == Deserialized: $match")
        println("Serialized size: ${serialized.toByteArray().size} bytes")

        // --- Assertions ---
        assertTrue(match, "JSON round-trip should preserve data exactly")
        println("\n== All checks passed ==")
    }
}
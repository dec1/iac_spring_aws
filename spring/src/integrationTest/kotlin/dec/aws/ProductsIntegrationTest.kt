package dec.aws.controller

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import dec.aws.AwsApplication
import dec.aws.service.Aws
import dec.aws.util.FakeAws
import dec.aws.util.TestDataDefaults
import org.junit.jupiter.api.*
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.core.io.ClassPathResource
import org.springframework.http.MediaType
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.test.context.TestPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import java.time.Instant

/**
 * INTEGRATION TEST STRATEGY
 * -------------------------
 * TESTED (REAL):
 * - Spring Boot Application Context (wiring)
 * - Controllers & Endpoints
 * - Security Configuration (Role checks, Filters)
 * - JSON Serialization
 * - Validation (ProductsValidator, ImageValidator)
 *
 * NOT TESTED (FAKED):
 * - AWS S3 Connectivity (Replaced by in-memory FakeAws)
 * - Docker/LocalStack infrastructure
 *
 * FIXTURES:
 * - Round-trip and success tests load data from classpath (TestDataDefaults)
 * - Validation edge-case tests use inline data for clarity
 */

@TestConfiguration
class ProductsITConfig {
    @Bean
    @Primary
    fun awsFakeProducts(): Aws = FakeAws()
}

@SpringBootTest(classes = [AwsApplication::class, ProductsITConfig::class])
@AutoConfigureMockMvc
@TestPropertySource(
    properties = [
        "app.s3.bucket-name=test-bucket"
    ]
)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ProductsIntegrationTest(
    @Autowired private val mockMvc: MockMvc,
    @Autowired private val aws: Aws
) {
    // Mocks the JWT decoder so Security Config loads without needing a real Identity Provider URL
    @MockitoBean
    lateinit var jwtDecoder: JwtDecoder

    private val mapper = ObjectMapper().registerKotlinModule()

    @BeforeEach
    fun resetFake() {
        (aws as FakeAws).reset()
    }

    // ---------------------------------------------------------------------------
    // Fixture loading
    // ---------------------------------------------------------------------------

    private val fixtureProductsJson: String by lazy {
        val res = ClassPathResource(TestDataDefaults.PRODUCTS_NAME)
        require(res.exists()) { "Missing test resource: ${TestDataDefaults.PRODUCTS_NAME}" }
        res.inputStream.use { it.readAllBytes().toString(Charsets.UTF_8) }
    }

    private val fixtureImageBytes: ByteArray by lazy {
        val res = ClassPathResource(TestDataDefaults.IMAGE_NAME)
        require(res.exists()) { "Missing test resource: ${TestDataDefaults.IMAGE_NAME}" }
        res.inputStream.use { it.readAllBytes() }
    }

    private fun parseJson(s: String) = mapper.readTree(s)

    /** Minimal PNG: 89 50 4E 47 followed by filler (useful for mismatch tests). */
    private fun pngBytes(size: Int = 128): ByteArray =
        byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47) + ByteArray(size - 4)

    // Endpoints (nosec variants for test-harness profile)
    private val versionsUrl = "/api/products/versions-nosec"
    private val productsUrl = "/api/products-nosec"
    private val imageUrl = "/api/products/image-nosec"

    // =========================================================================
    // PRODUCTS (JSON) -- POST validation (inline data for edge cases)
    // =========================================================================

    @Test
    fun `POST products - rejects empty JSON object`() {
        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}")
        ).andExpect(status().isBadRequest)
    }

    @Test
    fun `POST products - rejects catalog missing products array`() {
        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"items": []}""")
        ).andExpect(status().isBadRequest)
    }

    @Test
    fun `POST products - rejects product missing required id field`() {
        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"products": [{"name": "Widget"}]}""")
        ).andExpect(status().isBadRequest)
    }

    @Test
    fun `POST products - rejects malformed JSON`() {
        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{not valid json")
        ).andExpect(status().isBadRequest)
    }

    // =========================================================================
    // PRODUCTS (JSON) -- POST and GET using fixture file
    // =========================================================================

    @Test
    fun `POST products - uploads fixture catalog and returns success metadata`() {
        val expectedLen = mapper.writeValueAsBytes(mapper.readTree(fixtureProductsJson)).size.toLong()

        val res = mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content(fixtureProductsJson)
        ).andExpect(status().isOk).andReturn()

        val j = parseJson(res.response.contentAsString)
        assertTrue(j["success"].asBoolean())
        assertEquals("Products uploaded successfully", j["message"].asText())
        assertEquals(expectedLen, j["contentLength"].asLong())
        assertTrue(j["etag"].asText().isNotBlank())
        assertTrue(j["version"].asLong() > 0)
    }

    @Test
    fun `POST then GET products - round-trip returns same data and matching meta`() {
        // --- POST ---
        val postRes = mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content(fixtureProductsJson)
        ).andExpect(status().isOk).andReturn()
        val postJson = parseJson(postRes.response.contentAsString)

        val postVersion = postJson["version"].asLong()
        val postLastModEpoch = Instant.parse(postJson["lastModified"].asText()).epochSecond
        assertEquals(postVersion, postLastModEpoch, "version should equal epochSecond(lastModified)")

        // --- GET ---
        val getRes = mockMvc.perform(
            get(productsUrl).accept(MediaType.APPLICATION_JSON)
        ).andExpect(status().isOk).andReturn()
        val getJson = parseJson(getRes.response.contentAsString)

        // Body: GET "products" equals the original posted payload
        val original = mapper.readTree(fixtureProductsJson)
        assertEquals(original["products"], getJson["products"])

        // Meta: POST metadata should reappear in GET "meta"
        assertEquals(
            postVersion,
            getJson["meta"]["version"].asLong(),
            "GET meta.version must match POST version"
        )
        assertEquals(
            postLastModEpoch,
            Instant.parse(getJson["meta"]["lastModified"].asText()).epochSecond,
            "GET meta.lastModified must match POST lastModified (epoch seconds)"
        )
    }

    @Test
    fun `POST products multiple times - version increases monotonically`() {
        var prevVersion: Long? = null

        repeat(3) {
            val res = mockMvc.perform(
                post(productsUrl)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(fixtureProductsJson)
            ).andExpect(status().isOk).andReturn()

            val ver = parseJson(res.response.contentAsString)["version"].asLong()
            if (prevVersion != null) {
                assertTrue(ver > prevVersion!!, "version should increase between posts")
            }
            prevVersion = ver
        }
    }

    @Test
    fun `GET products - pretty parameter returns indented JSON`() {
        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content(fixtureProductsJson)
        ).andExpect(status().isOk)

        val result = mockMvc.perform(get("$productsUrl?pretty=true"))
            .andExpect(status().isOk)
            .andReturn()

        assertTrue(result.response.contentAsString.contains("\n"))
    }

    @Test
    fun `GET products - second upload overwrites first`() {
        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"products": [{"id": "old", "name": "Old"}]}""")
        ).andExpect(status().isOk)

        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content(fixtureProductsJson)
        ).andExpect(status().isOk)

        val result = mockMvc.perform(get(productsUrl).accept(MediaType.APPLICATION_JSON))
            .andExpect(status().isOk)
            .andReturn()

        // Second upload was the fixture, so first product id should be "prod-001"
        assertEquals("prod-001", parseJson(result.response.contentAsString)["products"][0]["id"].asText())
    }

    // =========================================================================
    // IMAGES (binary) -- POST validation (edge cases)
    // =========================================================================

    @Test
    fun `POST image - rejects empty payload`() {
        mockMvc.perform(
            post(imageUrl)
                .contentType("image/jpeg")
                .content(ByteArray(0))
        ).andExpect(status().isBadRequest)
    }

    @Test
    fun `POST image - accepts arbitrary content-type`() {
        mockMvc.perform(
            post(imageUrl)
                .contentType("application/pdf")
                .content(fixtureImageBytes)
        ).andExpect(status().isOk)
    }

    @Test
    fun `POST image - accepts magic byte mismatch (PNG bytes declared as JPEG)`() {
        mockMvc.perform(
            post(imageUrl)
                .contentType("image/jpeg")
                .content(pngBytes())
        ).andExpect(status().isOk)
    }

    // =========================================================================
    // IMAGES (binary) -- POST and GET using fixture file
    // =========================================================================

    @Test
    fun `POST image - uploads fixture image and returns success metadata`() {
        val res = mockMvc.perform(
            post(imageUrl)
                .contentType("image/jpeg")
                .content(fixtureImageBytes)
        ).andExpect(status().isOk).andReturn()

        val j = parseJson(res.response.contentAsString)
        assertTrue(j["success"].asBoolean())
        assertEquals("Image uploaded successfully", j["message"].asText())
        assertEquals("image/jpeg", j["contentType"].asText())
        assertTrue(j["version"].asLong() > 0)
        assertEquals(fixtureImageBytes.size.toLong(), j["contentLength"].asLong())
    }

    @Test
    fun `POST then GET image - round-trip preserves fixture bytes and headers`() {
        // --- POST ---
        val postRes = mockMvc.perform(
            post(imageUrl)
                .contentType("image/jpeg")
                .content(fixtureImageBytes)
        ).andExpect(status().isOk).andReturn()
        val postJson = parseJson(postRes.response.contentAsString)
        val postVersion = postJson["version"].asLong()

        // --- GET ---
        val getRes = mockMvc.perform(get(imageUrl))
            .andExpect(status().isOk)
            .andReturn()

        // Binary fidelity
        assertArrayEquals(
            fixtureImageBytes,
            getRes.response.contentAsByteArray,
            "Downloaded image bytes must exactly match fixture bytes"
        )

        // Headers
        assertEquals("application/octet-stream", getRes.response.getHeader("Content-Type"))
        assertNotNull(getRes.response.getHeader("ETag"))
        assertEquals(postVersion.toString(), getRes.response.getHeader("S3d-Meta-Version"))
        assertNotNull(getRes.response.getHeader("S3d-Meta-LastModified"))
    }

    @Test
    fun `POST image - uploads valid PNG`() {
        mockMvc.perform(
            post(imageUrl)
                .contentType("application/octet-stream")
                .content(pngBytes())
        ).andExpect(status().isOk)
    }

    @Test
    fun `GET image - second upload overwrites first`() {
        // Upload PNG first
        mockMvc.perform(post(imageUrl).contentType("image/png").content(pngBytes(100)))
            .andExpect(status().isOk)

        // Upload fixture second
        mockMvc.perform(post(imageUrl).contentType("image/jpeg").content(fixtureImageBytes))
            .andExpect(status().isOk)

        val result = mockMvc.perform(get(imageUrl))
            .andExpect(status().isOk)
            .andReturn()

        assertArrayEquals(fixtureImageBytes, result.response.contentAsByteArray)
    }

    // =========================================================================
    // VERSIONS (metadata for both resources)
    // =========================================================================

    @Test
    fun `GET versions - returns metadata for both resources after upload`() {
        // Seed both with fixtures
        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content(fixtureProductsJson)
        ).andExpect(status().isOk)

        mockMvc.perform(
            post(imageUrl)
                .contentType("image/jpeg")
                .content(fixtureImageBytes)
        ).andExpect(status().isOk)

        val res = mockMvc.perform(get(versionsUrl).accept(MediaType.APPLICATION_JSON))
            .andExpect(status().isOk)
            .andReturn()

        val j = parseJson(res.response.contentAsString)
        val versions = j["versions"]
        assertTrue(versions["products"]["version"].asLong() > 0)
        assertNotNull(versions["products"]["lastModified"])
        assertTrue(versions["image"]["version"].asLong() > 0)
        assertNotNull(versions["image"]["lastModified"])
    }

    @Test
    fun `GET versions - image version is later than products when uploaded second`() {
        // Products first (FakeAws clock: T+1s)
        mockMvc.perform(
            post(productsUrl)
                .contentType(MediaType.APPLICATION_JSON)
                .content(fixtureProductsJson)
        ).andExpect(status().isOk)

        // Image second (FakeAws clock: T+2s)
        mockMvc.perform(
            post(imageUrl)
                .contentType("image/jpeg")
                .content(fixtureImageBytes)
        ).andExpect(status().isOk)

        val res = mockMvc.perform(get(versionsUrl).accept(MediaType.APPLICATION_JSON))
            .andExpect(status().isOk)
            .andReturn()

        val j = parseJson(res.response.contentAsString)
        val productsVer = j["versions"]["products"]["version"].asLong()
        val imageVer = j["versions"]["image"]["version"].asLong()
        assertTrue(
            imageVer > productsVer,
            "Image (uploaded second) should have a later version than products"
        )
    }
}
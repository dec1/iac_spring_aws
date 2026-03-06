// src/systemTest/kotlin/dec/aws/ProductsSystemTest.kt
package dec.aws.controller

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import dec.aws.AwsApplication
import dec.aws.util.TestDataDefaults
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.client.TestRestTemplate
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.core.io.ClassPathResource
import org.springframework.http.HttpEntity
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType

/**
 * SYSTEM TEST STRATEGY
 * --------------------
 * Uses @SpringBootTest with RANDOM_PORT to boot the real app and hit it
 * over actual HTTP via TestRestTemplate. This exercises the full network
 * stack (serialization, filters, security, CORS) -- not just MockMvc's
 * in-process simulation.
 *
 * Test fixtures are loaded from the shared classpath resources
 * (src/test/resources/static/) via TestDataDefaults.
 *
 * These tests hit real AWS S3 (via the default credential chain) so they
 * require a configured bucket and valid credentials.
 */
@SpringBootTest(
    classes = [AwsApplication::class],
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT
)
class ProductsSystemTest {

    @LocalServerPort
    private var port: Int = 0

    @Autowired
    private lateinit var rest: TestRestTemplate

    private val mapper = ObjectMapper().registerKotlinModule()
    private fun url(p: String) = "http://localhost:$port$p"

    // ---------------------------------------------------------------------------
    // Fixture loading
    // ---------------------------------------------------------------------------

    private fun loadProductsFixture(): String {
        val res = ClassPathResource(TestDataDefaults.PRODUCTS_NAME)
        require(res.exists()) { "Missing test resource: ${TestDataDefaults.PRODUCTS_NAME}" }
        return res.inputStream.use { it.readAllBytes().toString(Charsets.UTF_8) }
    }

    private fun loadImageFixture(): ByteArray {
        val res = ClassPathResource(TestDataDefaults.IMAGE_NAME)
        require(res.exists()) { "Missing test resource: ${TestDataDefaults.IMAGE_NAME}" }
        return res.inputStream.use { it.readAllBytes() }
    }

    private fun jsonHeaders() = HttpHeaders().apply { contentType = MediaType.APPLICATION_JSON }

    private fun imageHeaders(ct: String) = HttpHeaders().apply {
        contentType = MediaType.parseMediaType(ct)
    }

    // =========================================================================
    // PRODUCTS (JSON) -- POST twice, version increments, GET returns body + meta
    // =========================================================================

    @Test
    fun `POST products twice increments version, GET returns body and meta`() {
        val json = loadProductsFixture()
        val entity = HttpEntity(json, jsonHeaders())

        // POST #1
        val post1 = rest.postForEntity(url("/api/products-nosec"), entity, String::class.java)
        assertThat(post1.statusCode.is2xxSuccessful).isTrue()
        val j1 = mapper.readTree(post1.body) as ObjectNode
        val v1 = j1["version"].asLong()
        val lm1 = j1["lastModified"].asText()

        // Ensure epoch-second changes
        Thread.sleep(1_100)

        // POST #2
        val post2 = rest.postForEntity(url("/api/products-nosec"), entity, String::class.java)
        assertThat(post2.statusCode.is2xxSuccessful).isTrue()
        val j2 = mapper.readTree(post2.body) as ObjectNode
        val v2 = j2["version"].asLong()
        val lm2 = j2["lastModified"].asText()

        assertTrue(v2 > v1, "version should increase between posts")
        assertThat(lm2).isNotEqualTo(lm1)

        // GET should reflect last POST
        val get = rest.getForEntity(url("/api/products-nosec"), String::class.java)
        assertThat(get.statusCode.is2xxSuccessful).isTrue()
        val getRoot = mapper.readTree(get.body) as ObjectNode

        // Compare GET body WITHOUT meta to the COMPLETE JSON sent in POST
        val getWithoutMeta: ObjectNode = getRoot.deepCopy()
        getWithoutMeta.remove("meta")
        val postedRoot = mapper.readTree(json) as ObjectNode
        assertThat(getWithoutMeta).isEqualTo(postedRoot)

        // Ensure meta of GET matches that returned by last POST
        val getMeta = getRoot["meta"]
        assertThat(getMeta["version"].asLong()).isEqualTo(v2)
        assertThat(getMeta["lastModified"].asText()).isEqualTo(lm2)
    }

    // =========================================================================
    // PRODUCTS (JSON) -- Validation
    // =========================================================================

    @Test
    fun `POST products - rejects invalid payload`() {
        val entity = HttpEntity("""{"not_products": true}""", jsonHeaders())
        val res = rest.postForEntity(url("/api/products-nosec"), entity, String::class.java)
        assertThat(res.statusCode.value()).isEqualTo(400)
    }

    @Test
    fun `POST products - rejects product missing id`() {
        val entity = HttpEntity("""{"products": [{"name": "Widget"}]}""", jsonHeaders())
        val res = rest.postForEntity(url("/api/products-nosec"), entity, String::class.java)
        assertThat(res.statusCode.value()).isEqualTo(400)
    }

    // =========================================================================
    // IMAGES (binary) -- POST twice, version increments, GET returns bytes
    // =========================================================================

    @Test
    fun `POST image twice increments version, GET returns correct bytes and headers`() {
        val fixtureImage = loadImageFixture()

        // POST #1
        val post1 = rest.postForEntity(
            url("/api/products/image-nosec"),
            HttpEntity(fixtureImage, imageHeaders("image/jpeg")),
            String::class.java
        )
        assertThat(post1.statusCode.is2xxSuccessful).isTrue()
        val j1 = mapper.readTree(post1.body) as ObjectNode
        val v1 = j1["version"].asLong()

        // Ensure epoch-second changes
        Thread.sleep(1_100)

        // POST #2 (same image, but version should still increment)
        val post2 = rest.postForEntity(
            url("/api/products/image-nosec"),
            HttpEntity(fixtureImage, imageHeaders("image/jpeg")),
            String::class.java
        )
        assertThat(post2.statusCode.is2xxSuccessful).isTrue()
        val j2 = mapper.readTree(post2.body) as ObjectNode
        val v2 = j2["version"].asLong()

        assertTrue(v2 > v1, "version should increase between posts")

        // GET should return the image
        val get = rest.exchange(
            url("/api/products/image-nosec"),
            HttpMethod.GET,
            null,
            ByteArray::class.java
        )
        assertThat(get.statusCode.is2xxSuccessful).isTrue()
        assertArrayEquals(fixtureImage, get.body, "GET should return the uploaded image bytes exactly")

        val ct = get.headers.contentType?.toString() ?: ""
        assertThat(ct).contains("application/octet-stream")
    }

    // =========================================================================
    // IMAGES (binary) -- Validation
    // =========================================================================

    @Test
    fun `POST image - accepts arbitrary content-type`() {
        val res = rest.postForEntity(
            url("/api/products/image-nosec"),
            HttpEntity(loadImageFixture(), imageHeaders("application/pdf")),
            String::class.java
        )
        assertThat(res.statusCode.is2xxSuccessful).isTrue()
    }

    @Test
    fun `POST image - rejects empty payload`() {
        val res = rest.postForEntity(
            url("/api/products/image-nosec"),
            HttpEntity(ByteArray(0), imageHeaders("image/jpeg")),
            String::class.java
        )
        assertThat(res.statusCode.value()).isEqualTo(400)
    }

    // =========================================================================
    // VERSIONS
    // =========================================================================

    @Test
    fun `GET versions - returns metadata for both resources after seeding`() {
        // Seed products
        rest.postForEntity(
            url("/api/products-nosec"),
            HttpEntity(loadProductsFixture(), jsonHeaders()),
            String::class.java
        )

        // Seed image
        rest.postForEntity(
            url("/api/products/image-nosec"),
            HttpEntity(loadImageFixture(), imageHeaders("image/jpeg")),
            String::class.java
        )

        val get = rest.getForEntity(url("/api/products/versions-nosec"), String::class.java)
        assertThat(get.statusCode.is2xxSuccessful).isTrue()

        val versions = (mapper.readTree(get.body) as ObjectNode)["versions"]
        assertTrue(versions["products"]["version"].asLong() > 0)
        assertNotNull(versions["products"]["lastModified"])
        assertTrue(versions["image"]["version"].asLong() > 0)
        assertNotNull(versions["image"]["lastModified"])
    }

    // =========================================================================
    // ROUND-TRIP with fixture files
    // =========================================================================

    @Test
    fun `round-trip - fixture image bytes preserved exactly`() {
        val original = loadImageFixture()

        // Upload
        val post = rest.postForEntity(
            url("/api/products/image-nosec"),
            HttpEntity(original, imageHeaders("image/jpeg")),
            String::class.java
        )
        assertThat(post.statusCode.is2xxSuccessful).isTrue()

        // Download
        val get = rest.exchange(
            url("/api/products/image-nosec"),
            HttpMethod.GET,
            null,
            ByteArray::class.java
        )
        assertThat(get.statusCode.is2xxSuccessful).isTrue()
        assertArrayEquals(
            original,
            get.body,
            "Round-tripped fixture image bytes should match original exactly"
        )
    }

    @Test
    fun `round-trip - fixture products JSON preserved exactly`() {
        val json = loadProductsFixture()

        // Upload
        val post = rest.postForEntity(
            url("/api/products-nosec"),
            HttpEntity(json, jsonHeaders()),
            String::class.java
        )
        assertThat(post.statusCode.is2xxSuccessful).isTrue()

        // Download
        val get = rest.getForEntity(url("/api/products-nosec"), String::class.java)
        assertThat(get.statusCode.is2xxSuccessful).isTrue()

        val original = mapper.readTree(json) as ObjectNode
        val getRoot = mapper.readTree(get.body) as ObjectNode
        val getWithoutMeta: ObjectNode = getRoot.deepCopy()
        getWithoutMeta.remove("meta")

        assertThat(getWithoutMeta).isEqualTo(original)
    }
}
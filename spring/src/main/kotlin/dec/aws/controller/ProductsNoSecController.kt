package dec.aws.controller

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import org.springframework.context.annotation.Profile
import org.springframework.web.bind.annotation.*
import dec.aws.config.S3Config
import dec.aws.service.Aws
import dec.aws.service.ImageValidator
import dec.aws.service.ProductsValidator

@Profile("test-harness") // only created when running locally or in CI (spring profile: "test-harness" active)
@RestController
@RequestMapping("/api")
class ProductsNoSecController(
    s3Config: S3Config,
    aws: Aws,
    productsValidator: ProductsValidator,
    imageValidator: ImageValidator
) : AbstractProductsController(s3Config, aws, productsValidator, imageValidator), ProductsApi {

    // NOTE:
    // 1. The paths retain the "-nosec" suffix (unique to this controller).
    // 2. The function names match ProductsApi (shared).
    // 3. 'override' links the two, applying the Swagger docs from the Interface to this Endpoint.

    @GetMapping("/products/versions-nosec")
    override fun getVersions() = executeGetVersions()

    // -----------------------------------------------------------------------
    // Products  (JSON)
    // -----------------------------------------------------------------------

    @GetMapping("/products-nosec", produces = ["application/json"])
    override fun getProducts(
        @RequestParam(required = false, defaultValue = "false") pretty: Boolean
    ) = executeGetProducts(pretty)

    @PostMapping("/products-nosec", consumes = ["application/json"], produces = ["application/json"])
    override fun postProducts(
        @RequestBody data: JsonNode,
        @RequestParam(required = false) tags: Map<String, String>?
    ) = executePostProducts(data, tags)

    // -----------------------------------------------------------------------
    // Images  (binary)
    // -----------------------------------------------------------------------

    @GetMapping("/products/image-nosec", produces = ["application/octet-stream", "image/*"])
    override fun getImage() = executeGetImage()

    @PostMapping("/products/image-nosec", produces = ["application/json"])
    override fun postImage(
        request: HttpServletRequest,
        @RequestParam(required = false) tags: Map<String, String>?
    ) = executePostImage(request, tags)
}
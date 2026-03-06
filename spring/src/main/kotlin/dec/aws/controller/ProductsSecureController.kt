package dec.aws.controller

import com.fasterxml.jackson.databind.JsonNode
import dec.aws.config.S3Config
import dec.aws.service.Aws
import dec.aws.service.ImageValidator
import dec.aws.service.ProductsValidator
import io.swagger.v3.oas.annotations.security.SecurityRequirement
import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.ResponseEntity
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.web.bind.annotation.*

@RestController
@SecurityRequirement(name = "bearerAuth")
@RequestMapping("/api")
class ProductsSecureController(
    s3Config: S3Config,
    aws: Aws,
    productsValidator: ProductsValidator,
    imageValidator: ImageValidator
) : AbstractProductsController(s3Config, aws, productsValidator, imageValidator), ProductsApi {

    @PreAuthorize("hasAuthority('Role_Read')")
    @GetMapping("/products/versions")
    override fun getVersions() = executeGetVersions()

    // -----------------------------------------------------------------------
    // Products  (JSON)
    // -----------------------------------------------------------------------

    @PreAuthorize("hasAuthority('Role_Read')")
    @GetMapping("/products", produces = ["application/json"])
    override fun getProducts(
        @RequestParam(required = false, defaultValue = "false") pretty: Boolean
    ) = executeGetProducts(pretty)

    @PreAuthorize("hasAuthority('Role_Write')")
    @PostMapping("/products", consumes = ["application/json"], produces = ["application/json"])
    override fun postProducts(
        @RequestBody data: JsonNode,
        @RequestParam(required = false) tags: Map<String, String>?
    ) = executePostProducts(data, tags)

    // -----------------------------------------------------------------------
    // Images  (binary)
    // -----------------------------------------------------------------------

    @PreAuthorize("hasAuthority('Role_Read')")
    @GetMapping("/products/image", produces = ["application/octet-stream", "image/*"])
    override fun getImage() = executeGetImage()

    @PreAuthorize("hasAuthority('Role_Write')")
    @PostMapping("/products/image", produces = ["application/json"])
    override fun postImage(
        request: HttpServletRequest,
        @RequestParam(required = false) tags: Map<String, String>?
    ) = executePostImage(request, tags)
}
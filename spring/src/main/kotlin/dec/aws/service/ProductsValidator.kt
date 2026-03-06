package dec.aws.service

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.web.server.ResponseStatusException

/**
 * Validates a product catalog JSON payload before it is persisted to S3.
 *
 * Intended as a lightweight structural check -- not full business-rule validation.
 * Extend the checks here as the schema evolves.
 */
@Service
class ProductsValidator {

    fun validate(data: JsonNode) {
        if (data.isNull || data.isEmpty) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Product catalog must not be empty.")
        }

        // Expect a top-level "products" array
        val products = data.get("products")
            ?: throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Missing required top-level field: 'products'.")

        if (!products.isArray) {
            throw ResponseStatusException(HttpStatus.BAD_REQUEST, "'products' must be a JSON array.")
        }

        // Each product must have at least an "id" and a "name"
        products.forEachIndexed { index, product ->
            if (!product.has("id")) {
                throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Product at index $index is missing required field: 'id'.")
            }
            if (!product.has("name")) {
                throw ResponseStatusException(HttpStatus.BAD_REQUEST, "Product at index $index is missing required field: 'name'.")
            }
        }
    }
}

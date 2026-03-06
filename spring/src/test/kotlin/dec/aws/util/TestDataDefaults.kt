// src/test/kotlin/dec/aws/util/TestDataDefaults.kt
package dec.aws.util

/**
 * Central reference for test fixture file paths on the classpath.
 *
 * All test tiers (unit, integration, system, manual) share fixtures
 * from src/test/resources/static/ via the addTestTier resource sharing
 * configured in build.gradle.kts.
 */
object TestDataDefaults {
    /** Sample product catalog JSON (3 products with id, name, price, optional fields). */
    const val PRODUCTS_NAME = "static/sample_products.json"

    /** Sample image fixture (PNG). */
    const val IMAGE_NAME = "static/sample_image.png"
}
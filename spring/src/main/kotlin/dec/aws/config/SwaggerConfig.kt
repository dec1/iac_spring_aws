package dec.aws.config

import dec.aws.model.ApiError
import io.swagger.v3.core.converter.ModelConverters
import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.media.Content
import io.swagger.v3.oas.models.media.MediaType
import io.swagger.v3.oas.models.media.Schema
import io.swagger.v3.oas.models.responses.ApiResponse
import io.swagger.v3.oas.models.responses.ApiResponses
import io.swagger.v3.oas.models.security.SecurityScheme
import org.springdoc.core.customizers.OpenApiCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.env.Environment

@Configuration
class SwaggerConfig(private val env: Environment) {

    // Swagger UI Security Scheme name (used by "Authorize" button)
    private val bearerSchemeName = "bearerAuth"

    @Bean
    fun customOpenAPI(): OpenAPI {
        val appVersion = env.getProperty("app.version") ?: "unknown"
        val productName = env.getProperty("app.productName") ?: "unknown"
        val apiName = env.getProperty("app.apiName") ?: "unknown"
        return OpenAPI()
            .info(
                Info()
                    .title(productName)
                    .version(appVersion)
                    .description(apiName)
            )
            // Enable Swagger UI "Authorize" for JWT Bearer tokens.
            // This does NOT enforce security (Spring Security does that). It only improves docs + Try-it-out.
            .components(
                Components().addSecuritySchemes(
                    bearerSchemeName,
                    SecurityScheme()
                        .type(SecurityScheme.Type.HTTP)
                        .scheme("bearer")
                        .bearerFormat("JWT")
                )
            )
    }

    /**
     * Global Customizer:
     * 1. Auto-detects the schema for the 'ApiError' class using ModelConverters.
     * 2. Registers it in the OpenAPI Components section.
     * 3. Iterates over all endpoints and adds standard 4xx/5xx error responses referencing that schema.
     */
    @Bean
    fun globalErrorResponsesCustomizer(): OpenApiCustomizer {
        return OpenApiCustomizer { openApi ->
            // 1. Initialize Components if null
            if (openApi.components == null) {
                openApi.components = Components()
            }

            // 2. Generate and Register 'ApiError' Schema from the Kotlin class
            // This ensures the doc is always in sync with your actual ApiError data class
            val schemas = ModelConverters.getInstance().read(ApiError::class.java)
            schemas.forEach { (name, schema) ->
                openApi.components.addSchemas(name, schema)
            }

            // 2b. Register shared examples once (keeps docs DRY and stops Swagger showing unhelpful "string" examples).
            ensureCommonExamples(openApi)

            // 3. Add Error Responses to all operations
            // We iterate over all paths and operations to append standard error responses.
            openApi.paths.values.forEach { pathItem ->
                pathItem.readOperationsMap().forEach { (httpMethod, operation) ->
                    val responses = operation.responses

                    // DETECT: Has the Controller defined @SecurityRequirement?
                    // If yes, Springdoc has ALREADY added the security item (Lock Icon) before this customizer runs.
                    // We simply check for its existence to decide if we should document 401/403 errors.
                    val isSecure = !operation.security.isNullOrEmpty()

                    // Always: server-side failures can happen anywhere
                    addErrorResponseIfMissing(responses, "500", "Internal Server Error", "Err500")

                    // Security-related codes only make sense on secured endpoints
                    if (isSecure) {
                        addErrorResponseIfMissing(responses, "401", "Unauthorized (missing/invalid token)", "Err401")
                        addErrorResponseIfMissing(responses, "403", "Forbidden (token valid, but missing required Role/Scope)", "Err403")
                    }

                    // Validation failures are most commonly on POST/PUT/PATCH where inputs are checked.
                    // Add 400 only where it is likely (keeps Swagger UI shorter and more accurate).
                    val m = httpMethod.name.uppercase()
                    if (m == "POST" || m == "PUT" || m == "PATCH") {
                        addErrorResponseIfMissing(responses, "400", "Bad Request (validation failed)", "Err400")
                    }

                    // Add 404 only if your API actually returns it for these operations.
                    // Many APIs rely on framework routing 404s rather than explicit per-operation 404 semantics.
                    // addErrorResponseIfMissing(responses, "404", "Not Found", "Err404")
                }
            }
        }
    }

    /**
     * Register examples once so every operation can reference them without repeating large JSON blocks.
     * Swagger UI will display these examples instead of generic "string" placeholders.
     */
    private fun ensureCommonExamples(openApi: OpenAPI) {
        val components = openApi.components ?: Components().also { openApi.components = it }
        val examples = components.examples ?: linkedMapOf<String, io.swagger.v3.oas.models.examples.Example>()
            .also { components.examples = it }

        fun putIfMissing(name: String, value: Map<String, Any>) {
            if (examples.containsKey(name)) return
            examples[name] = io.swagger.v3.oas.models.examples.Example().value(value)
        }

        // Keep timestamps in ISO-8601 so copy/paste into logs is straightforward.
        putIfMissing(
            "Err400",
            mapOf(
                "status" to 400,
                "error" to "Bad Request",
                "message" to "Validation failed: missing or invalid input.",
                "timestamp" to "2026-01-01T12:00:00Z"
            )
        )
        putIfMissing(
            "Err401",
            mapOf(
                "status" to 401,
                "error" to "Unauthorized",
                "message" to "Authentication failed: missing or invalid Bearer token.",
                "timestamp" to "2026-01-01T12:00:00Z"
            )
        )
        putIfMissing(
            "Err403",
            mapOf(
                "status" to 403,
                "error" to "Forbidden",
                "message" to "Access denied: token valid, but missing required Role/Scope.",
                "timestamp" to "2026-01-01T12:00:00Z"
            )
        )
        putIfMissing(
            "Err500",
            mapOf(
                "status" to 500,
                "error" to "Internal Server Error",
                "message" to "Unexpected error.",
                "timestamp" to "2026-01-01T12:00:00Z"
            )
        )
    }

    private fun addErrorResponseIfMissing(responses: ApiResponses, code: String, defaultDescription: String, exampleName: String) {
        // If the controller already has an annotation (e.g. @ApiResponse(responseCode="403")),
        // keep its description, but ensure it uses the ApiError schema and a useful example.
        val existing = responses[code]
        val desc = existing?.description ?: defaultDescription

        if (existing != null) {
            // Keep existing but overwrite content to ensure consistent schema + example.
            existing.description = desc
            existing.content = apiErrorContent(exampleName)
            return
        }

        responses.addApiResponse(code, ApiResponse().description(desc).content(apiErrorContent(exampleName)))
    }

    private fun apiErrorContent(exampleName: String): Content {
        val exampleRef = io.swagger.v3.oas.models.examples.Example().`$ref`("#/components/examples/$exampleName")

        return Content().addMediaType(
            org.springframework.http.MediaType.APPLICATION_JSON_VALUE,
            MediaType()
                .schema(Schema<Any>().`$ref`("#/components/schemas/ApiError"))
                .addExamples("example", exampleRef)
        )
    }
}
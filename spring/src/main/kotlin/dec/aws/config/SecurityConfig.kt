package dec.aws.config

import com.fasterxml.jackson.databind.ObjectMapper
import dec.aws.model.ApiError
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.convert.converter.Converter
import org.springframework.http.HttpMethod  // <--- ADDED IMPORT
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.config.Customizer // <--- ADDED IMPORT
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.core.GrantedAuthority
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.oauth2.jwt.BadJwtException
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.JwtDecoders
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter
import org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter
import org.springframework.security.web.SecurityFilterChain

@Configuration
@EnableMethodSecurity(prePostEnabled = true)
class SecurityConfig(
    // Inject ObjectMapper to serialize security errors exactly like controller errors
    private val objectMapper: ObjectMapper
) {

    @Bean
    fun securityFilterChain(http: HttpSecurity): SecurityFilterChain {
        http
            // --- 1. ACTIVATE CORS ---
            // Apply the CORS rules defined in 'CorsConfig.kt'.
            // Without this, Spring Security ignores your custom CORS configuration,
            // preventing the necessary 'Access-Control-Allow-*' headers from being sent.
            .cors(Customizer.withDefaults())
            .authorizeHttpRequests { auth ->
                auth
                    // --- CORS PRE-FLIGHT FIX ---
                    // Don't require authentication for OPTIONS method, which clients like browsers are mandated
                    // to send as a pre-flight check ("can I send you an authenticated POST request?")
                    // before sending the actual authenticated POST.
                    .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()

                    // secure endpoints (require valid token; method-level @PreAuthorize will enforce roles)
                    .requestMatchers("/api/products", "/api/products/images").authenticated()
                    // allow open access to other API endpoints (same as current behaviour)
                    .anyRequest().permitAll()
            }
            .oauth2ResourceServer { oauth2 ->
                oauth2.jwt { jwt ->
                    // Note: jwtAuthenticationConverter() returns a Spring Converter<Jwt, AbstractAuthenticationToken>
                    jwt.jwtAuthenticationConverter(jwtAuthenticationConverter())
                }

                // --- UNIFORM ERROR HANDLING START ---
                // Handle 401 (Missing or Invalid Token)
                oauth2.authenticationEntryPoint { _, response, authException ->
                    response.contentType = MediaType.APPLICATION_JSON_VALUE
                    response.status = HttpStatus.UNAUTHORIZED.value()

                    val error = ApiError(
                        status = HttpStatus.UNAUTHORIZED.value(),
                        error = "Unauthorized",
                        message = "Authentication failed: ${authException.message}"
                    )
                    // Write directly to stream using the same Jackson mapper as the app
                    objectMapper.writeValue(response.writer, error)
                }

                // Handle 403 (Valid Token, but missing required Scope/Role at the filter URL level)
                oauth2.accessDeniedHandler { _, response, accessDeniedException ->
                    response.contentType = MediaType.APPLICATION_JSON_VALUE
                    response.status = HttpStatus.FORBIDDEN.value()

                    val error = ApiError(
                        status = HttpStatus.FORBIDDEN.value(),
                        error = "Forbidden",
                        message = "Access denied: ${accessDeniedException.message}"
                    )
                    objectMapper.writeValue(response.writer, error)
                }
                // --- UNIFORM ERROR HANDLING END ---
            }
            .csrf { it.disable() } // API only; if you have browser forms enable CSRF appropriately
        return http.build()
    }

    /**
     * Creates the JwtDecoder bean required by the OAuth2 Resource Server.
     *
     * If 'spring.security.oauth2.resourceserver.jwt.issuer-uri' is present, it configures
     * the decoder automatically (fetching keys from the IdP).
     *
     * If the property is missing (e.g. local dev without env vars), it returns a dummy
     * decoder that throws an exception, preventing the application from crashing on startup.
     */
    @Bean
    fun jwtDecoder(@Value("\${spring.security.oauth2.resourceserver.jwt.issuer-uri:}") issuerUri: String): JwtDecoder {
        return if (issuerUri.isNotBlank()) {
            JwtDecoders.fromIssuerLocation(issuerUri)
        } else {
            JwtDecoder { throw BadJwtException("No IDP_ISSUER_URI configured; cannot verify token.") }
        }
    }

    /**
     * Build a Jwt -> Authentication converter that:
     * - extracts scope authorities (SCOPE_xxx) via JwtGrantedAuthoritiesConverter
     * - [NEW] maps specific M2M scopes (ending in /read or /write) to Application Roles (Role_Read, Role_Write)
     * - also extracts a "roles" claim (or nested claims) and maps each to a GrantedAuthority whose
     * name equals the role value.
     *
     * Adjust claim names if your IdP uses a different claim (e.g. "realm_access.roles" or "authorities").
     */
    private fun jwtAuthenticationConverter(): Converter<Jwt, AbstractAuthenticationToken> {
        val jwtAuthConverter = JwtAuthenticationConverter()

        // Default converter maps scopes to SCOPE_... authorities
        val scopeConverter = JwtGrantedAuthoritiesConverter()

        jwtAuthConverter.setJwtGrantedAuthoritiesConverter(Converter { jwt: Jwt ->
            // start with scope-derived authorities
            val authorities: MutableSet<GrantedAuthority> = scopeConverter.convert(jwt)?.toMutableSet()
                ?: mutableSetOf()

            // Map Scopes to Roles ---
            // Cognito Client Credentials flow uses Scopes, not Roles.
            // We map the scope "api://.../read" to the role "Role_Read" expected by the Controller.
            val scopes = authorities.map { it.authority }

            if (scopes.any { it.endsWith("/read") }) {
                authorities.add(SimpleGrantedAuthority("Role_Read"))
            }
            if (scopes.any { it.endsWith("/write") }) {
                authorities.add(SimpleGrantedAuthority("Role_Write"))
            }
            // --------------------------------------

            // add role-based authorities extracted from claims (no ROLE_ prefix; use raw role strings)
            val roleStrings: List<String> = extractRoleClaim(jwt)
            roleStrings.forEach { r -> authorities.add(SimpleGrantedAuthority(r)) }

            authorities
        })

        // Return a Converter that delegates to the configured JwtAuthenticationConverter
        return Converter { jwt -> jwtAuthConverter.convert(jwt) as AbstractAuthenticationToken }
    }

    private fun extractRoleClaim(jwt: Jwt): List<String> {
        // Try common claim locations. Adapt to your IdP.
        // 1) top-level "roles": ["Role_Read"]
        // 2) top-level "authorities"
        // 3) nested "realm_access" -> "roles"
        // 4) empty list if not present
        val claims = jwt.claims

        val asList: (Any?) -> List<String> = { v ->
            when (v) {
                is List<*> -> v.filterIsInstance<String>()
                is Array<*> -> v.mapNotNull { it?.toString() }
                is String -> listOf(v)
                else -> emptyList()
            }
        }

        val fromRoles = asList(claims["roles"])
        if (fromRoles.isNotEmpty()) return fromRoles

        val fromAuthorities = asList(claims["authorities"])
        if (fromAuthorities.isNotEmpty()) return fromAuthorities

        val realmAccess = claims["realm_access"]
        if (realmAccess is Map<*, *>) {
            val r = asList(realmAccess["roles"])
            if (r.isNotEmpty()) return r
        }

        // fallback: empty
        return emptyList()
    }
}
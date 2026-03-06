// src/main/kotlin/dec/aws/config/AwsClientConfig.kt
package dec.aws.config

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Bound from:
 *
 * app:
 *   aws:
 *     mode: ${APP_AWS_MODE:real}         # none | fake | localstack | real
 *     region: ${AWS_REGION:eu-west-3}
 *     endpoint: ${AWS_ENDPOINT:}
 *
 * And for localstack profile:
 *   app:
 *     aws:
 *       mode: localstack
 *       endpoint: http://localhost:4566
 *       access-key: test
 *       secret-key: test
 */
@ConfigurationProperties(prefix = "app.aws")
data class AwsClientConfig(
    val mode: AwsMode = AwsMode.REAL,
    val region: String = "eu-west-3",
    val endpoint: String? = null,

    // Only meaningful for localstack mode (keeps localstack diffs in YAML)
    val accessKey: String? = null,
    val secretKey: String? = null,
    val sessionToken: String? = null
)

enum class AwsMode {
    NONE,       // no aws calls allowed (unit tests)
    FAKE,       // fake/in-memory impl (integration tests)
    LOCALSTACK, // localstack endpoint + dummy creds
    REAL        // real aws + default creds chain
}

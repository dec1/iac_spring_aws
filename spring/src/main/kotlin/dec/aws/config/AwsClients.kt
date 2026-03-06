// src/main/kotlin/dec/aws/config/AwsClients.kt
package dec.aws.config

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider
import software.amazon.awssdk.auth.credentials.AwsSessionCredentials
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.S3Configuration
import software.amazon.awssdk.services.sts.StsClient
import java.net.URI

@Configuration
@EnableConfigurationProperties(AwsClientConfig::class)
class AwsClients(private val p: AwsClientConfig) {

    @Bean
    fun awsCredentialsProvider(): AwsCredentialsProvider {
        return when (p.mode) {
            AwsMode.LOCALSTACK -> {
                val ak = requireNotNull(p.accessKey) { "app.aws.access-key required for localstack mode" }
                val sk = requireNotNull(p.secretKey) { "app.aws.secret-key required for localstack mode" }

                val provider = if (!p.sessionToken.isNullOrBlank()) {
                    val st = requireNotNull(p.sessionToken)
                    StaticCredentialsProvider.create(AwsSessionCredentials.create(ak, sk, st))
                } else {
                    StaticCredentialsProvider.create(AwsBasicCredentials.create(ak, sk))
                }
                provider
            }

            // In REAL mode we *always* use the default chain, so:
            // - env creds win if set
            // - then web identity (OIDC)
            // - then profile if AWS_PROFILE is set
            // - then ECS/EC2 role
            AwsMode.REAL -> DefaultCredentialsProvider.create()

            // These should never be used to build real AWS clients
            AwsMode.NONE, AwsMode.FAKE -> DefaultCredentialsProvider.create()
        }
    }

    @Bean
    fun s3Client(credentials: AwsCredentialsProvider): S3Client {
        require(p.mode != AwsMode.NONE && p.mode != AwsMode.FAKE) {
            "S3Client should not be created in app.aws.mode=${p.mode} (use a fake service instead)"
        }

        val b = S3Client.builder()
            .credentialsProvider(credentials)
            .region(Region.of(p.region))

        if (p.mode == AwsMode.LOCALSTACK) {
            val endpoint = requireNotNull(p.endpoint) { "app.aws.endpoint required for localstack mode" }
            b.endpointOverride(URI.create(endpoint))
            b.serviceConfiguration(
                S3Configuration.builder()
                    .pathStyleAccessEnabled(true)
                    .build()
            )
        }

        return b.build()
    }

    @Bean
    fun stsClient(credentials: AwsCredentialsProvider): StsClient {
        require(p.mode != AwsMode.NONE && p.mode != AwsMode.FAKE) {
            "StsClient should not be created in app.aws.mode=${p.mode}"
        }

        val b = StsClient.builder()
            .credentialsProvider(credentials)
            .region(Region.of(p.region))

        if (p.mode == AwsMode.LOCALSTACK) {
            val endpoint = requireNotNull(p.endpoint) { "app.aws.endpoint required for localstack mode" }
            b.endpointOverride(URI.create(endpoint))
        }

        return b.build()
    }
}

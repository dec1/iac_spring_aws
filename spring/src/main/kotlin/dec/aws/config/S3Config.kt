package dec.aws.config

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.context.annotation.Configuration

@Configuration
@ConfigurationProperties(prefix = "app.s3")
class S3Config {
    lateinit var bucketName: String
}
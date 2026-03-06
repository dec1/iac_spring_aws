package dec.aws

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class AwsApplication

fun main(args: Array<String>) {
    runApplication<AwsApplication>(*args)
}

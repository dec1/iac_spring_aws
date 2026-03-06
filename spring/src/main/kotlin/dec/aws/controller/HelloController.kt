package dec.aws.controller

import dec.aws.service.Aws
import dec.aws.service.HttpProbe
import io.swagger.v3.oas.annotations.Operation
import org.springframework.context.annotation.Profile
import org.springframework.core.env.Environment
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestMethod
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@Profile("test-harness")  // only create when running locally (spring profile: "local/ci" active -> application-local/ci.yaml)
@RestController
@RequestMapping("/api")
class HelloController(
    private val env: Environment,
    private val aws: Aws  // Spring injects this
) {
    fun getAppVersion(): String = env.getProperty("app.version") ?: "unknown"

    fun getAppName(): String = env.getProperty("spring.application.name") ?: "unknown"

    // http://localhost:8080/api/hello
    @Operation(summary = "Brief Info", description = "Welcome confirmation message with all environment variables")
    @RequestMapping("/hello", method = [RequestMethod.GET])
    fun greet(): Map<String, Any> {
        return mapOf(
            "message" to "Welcome to ${getAppName()}, version ${getAppVersion()}",
            "environment" to System.getenv()
        )
    }

    // http://localhost:8080/api/http_hello
    @Operation(summary = "Brief Info", description = "Test Http connectivity")
    @RequestMapping("/http_hello", method = [RequestMethod.GET])
    fun http_hello(): String {
        val probe_val = HttpProbe().probe()
        return "Http hello says: $probe_val"
    }


    // http://localhost:8080/api/aws_hello
    @Operation(summary = "Query Aws Access", description = "Query Aws for the id and account of the caller (getCallerIdentity)")
    @RequestMapping("/aws_caller_info", method = [RequestMethod.GET])
    fun greet_aws(): Map<String, Any> {
        val aws_val = aws.test()  // Use injected instance
        return mapOf(
            "message" to "Welcome to ${getAppName()}, version ${getAppVersion()}",
            "environment" to System.getenv(),
            "aws_caller_identity" to aws_val
        )
    }

    // http://localhost:8080/api/s3_insert?bucket_name=my-bucket&object_name=obj34&object_value=57
    @Operation(summary = "Insert into an S3 bucket")
    @RequestMapping("/s3_bucket_insert", method = [RequestMethod.POST])
    fun s3_insert(
        @RequestParam(name = "bucket_name", required = false, defaultValue = "my-bucket") bucketName: String,
        @RequestParam(name = "object_name", required = false, defaultValue = "my-object") objectName: String,
        @RequestParam(name = "object_value", required = false, defaultValue = "Hello, AWS!") objectValue: String)
            : ResponseEntity<String>
    {
        val ret = aws.s3_insert(bucketName, objectName, objectValue)  // Use injected instance
        return ResponseEntity.ok(ret)
    }

    //http://localhost:8080/api/s3_query?bucket_name=my-bucket
    @Operation(summary = "Show contents of an S3 bucket")
    @RequestMapping("/s3_bucket_show", method = [RequestMethod.GET])
    fun s3_query(
        @RequestParam(name = "bucket_name", required = false, defaultValue = "my-bucket") bucketName: String)
            : ResponseEntity<String> {
        val ret = aws.s3_query(bucketName)  // Use injected instance
        return ResponseEntity.ok(ret)
    }

    //http://localhost:8080/api/s3_list
    @Operation(summary = "List S3 buckets accessible to the caller")
    @RequestMapping("/s3_buckets_list", method = [RequestMethod.GET])
    fun s3_ls(): ResponseEntity<String> {
        val ret = aws.s3_ls()  // Use injected instance
        return ResponseEntity.ok(ret)
    }
}

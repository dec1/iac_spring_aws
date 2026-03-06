package dec.aws.service

import java.net.URI
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.springframework.stereotype.Component  // Optional: for Spring autowiring

@Component  // Optional: Makes it injectable in Spring controllers/services
class HttpProbe {

    /**
     * Performs an HTTPS probe to test connectivity and cert setup.
     * @return Success message with response code.
     * @throws Exception on connection failure (e.g., SSLHandshakeException if cert issue).
     */
    fun probe(): String {
        val uri = URI.create("https://www.google.com")
        val url: URL = uri.toURL()
        val conn = url.openConnection() as HttpsURLConnection
        conn.requestMethod = "GET"
        conn.connect()
        val responseCode = conn.responseCode
        val bodySnippet = conn.inputStream.bufferedReader().use { it.readText().take(1000) }  // Read body, limit to first 200 chars
        return "Success! Response code: $responseCode\nBody snippet: $bodySnippet"
    }
}
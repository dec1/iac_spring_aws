package dec.aws.service.local.console

import java.io.File
import java.net.URISyntaxException
import java.net.URL

/**
 * Finds a file by trying:
 * 1) a direct/local path (cwd)
 * 2) test resources folder: src/test/resources/...
 * 3) classpath resource
 *
* @param resourceName The name or path of the resource/file to find (e.g., "static/sample_products.json").
 * Returns a readable File or null.
 */
object ResourceLoader {

    fun findFile(resourceName: String): File? {
        val cleanResourceName = if (resourceName.startsWith("/")) resourceName.substring(1) else resourceName

        // 1) local path / cwd
        println("Attempt 1: local file '$resourceName'...")
        val localFileFromInput = File(resourceName)
        if (localFileFromInput.exists() && localFileFromInput.canRead()) {
            println("Success: ${localFileFromInput.absolutePath}")
            return localFileFromInput
        } else {
            println("Attempt 1 Failed: ${localFileFromInput.absolutePath}")
        }

        // 2) src/test/resources (handy when running locally without test runtime classpath)
        val testResourceRelativePath = "src/test/resources/$cleanResourceName"
        println("Attempt 2: test resource path '$testResourceRelativePath'...")
        val testResourceFile = File(testResourceRelativePath)
        if (testResourceFile.exists() && testResourceFile.canRead()) {
            println("Success: ${testResourceFile.absolutePath}")
            return testResourceFile
        } else {
            println("Attempt 2 Failed: ${testResourceFile.absolutePath}")
        }

        // 3) classpath
        println("Attempt 3: classpath resource '$cleanResourceName'...")
        val resourceUrl = Thread.currentThread().contextClassLoader.getResource(cleanResourceName)
        if (resourceUrl != null) {
            println("Success: URL = $resourceUrl")
            val fileFromUrl = getFileFromUrl(resourceUrl, cleanResourceName)
            if (fileFromUrl != null && fileFromUrl.exists() && fileFromUrl.canRead()) {
                println("Success: classpath mapped to ${fileFromUrl.absolutePath}")
                return fileFromUrl
            } else {
                println("Attempt 3 Failed: cannot convert to readable File")
            }
        } else {
            println("Attempt 3 Failed: not found on classpath")
        }

        println("File '$resourceName' not found by any method.")
        return null
    }

    /** Converts a file: URL to File; returns null for non-file protocols (e.g., jar:). */
    private fun getFileFromUrl(url: URL, resourcePath: String): File? {
        return try {
            if (url.protocol == "file") File(url.toURI()) else null
        } catch (e: URISyntaxException) {
            println("Bad URI for $url: ${e.message}"); null
        } catch (e: IllegalArgumentException) {
            println("Invalid File from $url: ${e.message}"); null
        } catch (e: Exception) {
            println("URL->File error for $url: ${e.message}"); null
        }
    }
}

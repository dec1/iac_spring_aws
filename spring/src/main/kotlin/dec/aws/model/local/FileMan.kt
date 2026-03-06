package local

import java.io.IOException
import java.nio.file.Files
import java.nio.file.Paths

/**
 * Tiny file helper for tests/console:
 * - write(String)
 * - read(String)
 * - readBytes(String)
 */
object FileMan {
    /** Write String to file as UTF-8 */
    @Throws(IOException::class)
    fun write(filePath: String, contents: String) {
        Files.write(Paths.get(filePath), contents.toByteArray(Charsets.UTF_8))
    }

    /** Read file as UTF-8 String. */
    @Throws(IOException::class)
    fun read(filePath: String): String =
        Files.readString(Paths.get(filePath), Charsets.UTF_8)

    /** Read entire file as bytes. */
    @Throws(IOException::class)
    fun readBytes(filePath: String): ByteArray =
        Files.readAllBytes(Paths.get(filePath))
}

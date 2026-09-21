package app.daftar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Final Release Blocker 6 — DEBUG / RELEASE NETWORKING COHERENCE.
 *
 * Release: cleartext denied everywhere, HTTPS production base URL.
 * Debug: cleartext permitted for the emulator host 10.0.2.2 ONLY (the local
 * development API), so the configured debug base URL can actually connect;
 * every other host stays TLS-only.
 *
 * The test reads the real resource files and build script of this module, so a
 * drift in either direction (an http production URL, a cleartext-all debug
 * config, a debug URL that the debug config would block) fails the build.
 */
class NetworkSecurityConfigTest {
    private fun module(path: String): File {
        val candidates = listOf(File(path), File("app/$path"), File("apps/android/app/$path"))
        return candidates.firstOrNull { it.exists() } ?: error("cannot locate $path from ${File(".").absolutePath}")
    }

    private fun parse(path: String): Element {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(module(path))
        return doc.documentElement
    }

    private fun Element.children(tag: String): List<Element> {
        val out = mutableListOf<Element>()
        val nodes = getElementsByTagName(tag)
        for (i in 0 until nodes.length) out += nodes.item(i) as Element
        return out
    }

    private fun baseUrl(buildType: String): String {
        val gradle = module("build.gradle.kts").readText()
        val block = Regex("$buildType\\s*\\{([\\s\\S]*?)\\n\\s*\\}").find(gradle)?.groupValues?.get(1) ?: error("no $buildType block")
        return Regex("API_BASE_URL\",\\s*\"\\\\\"([^\\\\]+)\\\\\"\"").find(block)?.groupValues?.get(1) ?: error("no API_BASE_URL in $buildType")
    }

    @Test
    fun `release configuration denies cleartext everywhere and uses an https base URL`() {
        val main = parse("src/main/res/xml/network_security_config.xml")
        val base = main.children("base-config").single()
        assertEquals("false", base.getAttribute("cleartextTrafficPermitted"))
        assertTrue("release config must not carry any cleartext domain-config", main.children("domain-config").none { it.getAttribute("cleartextTrafficPermitted") == "true" })
        assertTrue("release base URL must be https", baseUrl("release").startsWith("https://"))
        val manifest = module("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:usesCleartextTraffic=\"false\""))
    }

    @Test
    fun `debug configuration permits cleartext for the emulator host only, matching the debug base URL`() {
        val debug = parse("src/debug/res/xml/network_security_config.xml")
        assertEquals("false", debug.children("base-config").single().getAttribute("cleartextTrafficPermitted"))
        val cleartext = debug.children("domain-config").filter { it.getAttribute("cleartextTrafficPermitted") == "true" }
        assertEquals(1, cleartext.size)
        val domains = cleartext.single().children("domain").map { it.textContent.trim() }
        assertEquals(listOf("10.0.2.2"), domains)
        assertFalse(cleartext.single().children("domain").single().getAttribute("includeSubdomains") == "true")

        val debugUrl = java.net.URI(baseUrl("debug"))
        assertEquals("http", debugUrl.scheme)
        assertEquals("10.0.2.2", debugUrl.host)
        assertTrue("debug URL host must be the cleartext-permitted host", domains.contains(debugUrl.host))
    }

    @Test
    fun `no release source set overrides the network security config`() {
        assertFalse(File(module("src/main").parentFile, "release/res/xml/network_security_config.xml").exists())
    }
}

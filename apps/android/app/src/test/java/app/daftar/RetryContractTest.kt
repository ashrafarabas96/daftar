package app.daftar

import app.daftar.data.ApiClient
import app.daftar.data.Result
import app.daftar.data.TokenStore
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Directive §31–32 — CRITICAL ANDROID RETRY: on 401 → refresh success, the
 * client MUST replay the ORIGINAL request: same method, URL, query, headers,
 * body, business context and Idempotency-Key. The response body is never
 * used as a request body, and the retry carries the NEW access token.
 */
class RetryContractTest {
    private class MemoryTokenStore : TokenStore {
        private var access: String? = "old-access"
        override var refreshToken: String? = "rt-1"
        override fun accessToken(): String? = access
        override fun setAccessToken(token: String?) { access = token }
        override fun clear() { access = null; refreshToken = null }
    }

    @Test
    fun `401 then refresh then IDENTICAL replay with the same Idempotency-Key`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"UNAUTHENTICATED","message":"x","requestId":"r"}}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"accessToken":"new-access","refreshToken":"rt-2","expiresInSeconds":900}"""))
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"id":"p1","name":"Coffee","translations":{"en":"Coffee"},"sku":"C-1","barcode":null,"unit":null,"categoryId":null,"basePriceMinor":"1250","priceCurrency":"JOD","version":1,"status":"active","variants":[],"media":[]}""",
            ),
        )
        server.start()
        val store = MemoryTokenStore()
        val api = ApiClient(server.url("/").toString().trimEnd('/'), store)
        api.businessId = "biz-1"

        val res = api.createProduct("Coffee", "1250", "en", "C-1")
        assertTrue(res.toString(), res is Result.Ok)

        val first = server.takeRequest()
        val refresh = server.takeRequest()
        val replay = server.takeRequest()

        assertEquals("POST", first.method)
        assertEquals("/v1/catalog/products", first.path)
        assertEquals("POST", refresh.method)
        assertEquals("/v1/auth/refresh", refresh.path)
        assertEquals("""{"refreshToken":"rt-1"}""", refresh.body.readUtf8())

        // The replay is the ORIGINAL request, byte for byte, with the new token.
        assertEquals(first.method, replay.method)
        assertEquals(first.path, replay.path)
        assertEquals(first.getHeader("Content-Type"), replay.getHeader("Content-Type"))
        assertEquals("biz-1", replay.getHeader("X-Business-Id"))
        assertEquals("Bearer old-access", first.getHeader("Authorization"))
        assertEquals("Bearer new-access", replay.getHeader("Authorization"))
        val key = first.getHeader("Idempotency-Key")
        assertNotNull(key)
        assertEquals(key, replay.getHeader("Idempotency-Key")) // §32 same operation = same key
        val firstBody = first.body.readUtf8()
        assertEquals(firstBody, replay.body.readUtf8())
        assertEquals("""{"translations":{"en":"Coffee"},"basePriceMinor":"1250","sku":"C-1"}""", firstBody)
        assertEquals("rt-2", store.refreshToken) // rotation applied
        server.shutdown()
    }

    @Test
    fun `GET replay keeps the query string and never sends an Idempotency-Key`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"accessToken":"new","refreshToken":"rt-2"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"items":[],"nextCursor":null}"""))
        server.start()
        val api = ApiClient(server.url("/").toString().trimEnd('/'), MemoryTokenStore())
        api.businessId = "biz-1"
        val res = api.products("قهوة & sugar")
        assertTrue(res is Result.Ok)
        val first = server.takeRequest()
        server.takeRequest() // refresh
        val replay = server.takeRequest()
        assertEquals("/v1/catalog/products?search=%D9%82%D9%87%D9%88%D8%A9+%26+sugar", first.path)
        assertEquals(first.path, replay.path)
        assertEquals(null, first.getHeader("Idempotency-Key"))
        assertEquals(null, replay.getHeader("Idempotency-Key"))
        server.shutdown()
    }

    @Test
    fun `401 with failed refresh surfaces Unauthorized and clears the session`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        server.start()
        val store = MemoryTokenStore()
        val api = ApiClient(server.url("/").toString().trimEnd('/'), store)
        val res = api.members()
        assertTrue(res is Result.Unauthorized)
        assertEquals(null, store.refreshToken)
        assertEquals(2, server.requestCount) // no blind retry storm
        server.shutdown()
    }
}

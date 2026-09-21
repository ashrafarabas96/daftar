package app.daftar

import app.daftar.data.AuthTokens
import app.daftar.data.Product
import app.daftar.data.ProductsResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM contract tests (no Android runtime): the wire shapes the app depends on
 * must stay stable, and money must round-trip as integer minor units.
 */
class ApiContractTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `auth tokens parse from API shape`() {
        val tokens = json.decodeFromString(
            AuthTokens.serializer(),
            """{"accessToken":"a","refreshToken":"r","expiresInSeconds":900}""",
        )
        assertEquals("a", tokens.accessToken)
        assertEquals("r", tokens.refreshToken)
        assertEquals(900L, tokens.expiresInSeconds)
    }

    @Test
    fun `product price stays integer minor units`() {
        val product = json.decodeFromString(
            Product.serializer(),
            """{"id":"p1","translations":{"ar":"قهوة"},"basePriceMinor":"1999","priceCurrency":"JOD","status":"active"}""",
        )
        assertEquals("1999", product.basePriceMinor)
        assertTrue(product.basePriceMinor.all { it.isDigit() }) // never "19.99"
    }

    @Test
    fun `products response ignores unknown fields (forward compatible)`() {
        val res = json.decodeFromString(
            ProductsResponse.serializer(),
            """{"items":[{"id":"p1","basePriceMinor":"100","priceCurrency":"ILS","futureField":42}],"cursor":"abc"}""",
        )
        assertEquals(1, res.items.size)
        assertEquals("100", res.items[0].basePriceMinor)
    }
}

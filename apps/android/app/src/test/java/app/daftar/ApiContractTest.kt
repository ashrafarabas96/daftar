package app.daftar

import app.daftar.data.AuthTokens
import app.daftar.data.BusinessesResponse
import app.daftar.data.EntitlementSummary
import app.daftar.data.MembersResponse
import app.daftar.data.ProductDetail
import app.daftar.data.ProductListItem
import app.daftar.data.ProductsResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM contract tests (no Android runtime): every Kotlin DTO must parse the
 * REAL API shape from @daftar/shared-contracts (Directive §30). The fixtures
 * below are the exact wire shapes the API returns.
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
    fun `business list uses businessId (BusinessSummaryDto), wrapped in items`() {
        val res = json.decodeFromString(
            BusinessesResponse.serializer(),
            """{"items":[{"businessId":"b1","tenantId":"t1","name":"Shop","storeSlug":"shop","countryCode":"JO","baseCurrency":"JOD",
               "industryProfileKey":"general","defaultLocale":"ar","enabledLocales":["ar"],"timezone":"Asia/Amman","storefrontLocale":"ar","roleKey":"owner"}]}""",
        )
        assertEquals("b1", res.items.single().businessId)
        assertEquals("owner", res.items.single().roleKey)
        assertEquals("JOD", res.items.single().baseCurrency)
    }

    @Test
    fun `product list item uses resolved name, never a translations map`() {
        val item = json.decodeFromString(
            ProductListItem.serializer(),
            """{"id":"p1","name":"قهوة","sku":"C-1","basePriceMinor":"1999","priceCurrency":"JOD","status":"active"}""",
        )
        assertEquals("قهوة", item.name)
        assertEquals("1999", item.basePriceMinor)
        assertTrue(item.basePriceMinor.all { it.isDigit() }) // never "19.99"
    }

    @Test
    fun `product page carries nextCursor and ignores unknown fields`() {
        val res = json.decodeFromString(
            ProductsResponse.serializer(),
            """{"items":[{"id":"p1","name":"x","sku":null,"basePriceMinor":"100","priceCurrency":"ILS","status":"active","futureField":42}],"nextCursor":null}""",
        )
        assertEquals(1, res.items.size)
        assertNull(res.nextCursor)
    }

    @Test
    fun `product detail keeps version for optimistic concurrency and a huge price exactly`() {
        val p = json.decodeFromString(
            ProductDetail.serializer(),
            """{"id":"p1","name":"x","translations":{"ar":"x","en":"y"},"sku":null,"barcode":null,"unit":null,"categoryId":null,
               "basePriceMinor":"900719925474099399","priceCurrency":"ILS","version":7,"status":"active","variants":[],"media":[]}""",
        )
        assertEquals(7, p.version)
        assertEquals("900719925474099399", p.basePriceMinor) // > 2^53: exact as a string
        assertEquals("y", p.translations["en"])
    }

    @Test
    fun `member uses roleKeys (MemberDto), not roles`() {
        val res = json.decodeFromString(
            MembersResponse.serializer(),
            """{"items":[{"userId":"u1","email":"a@b.c","displayName":"A","roleKeys":["owner","manager"],"status":"active",
               "joinedAt":"2026-01-01T00:00:00.000Z","branchScopeMode":"all","allowedBranchIds":[]}]}""",
        )
        assertEquals(listOf("owner", "manager"), res.items.single().roleKeys)
        assertEquals("all", res.items.single().branchScopeMode)
    }

    @Test
    fun `entitlement summary parses the plan page contract`() {
        val e = json.decodeFromString(
            EntitlementSummary.serializer(),
            """{"planKey":"free","planVersion":1,"state":"trial","effectiveState":"trial","trialEndsAt":"2026-10-01T00:00:00.000Z","periodEndsAt":null,
               "features":[{"key":"MULTI_BRANCH","enabled":false}],"limits":[{"key":"MAX_PRODUCTS","limit":-1,"usage":3}]}""",
        )
        assertEquals("free", e.planKey)
        assertEquals(-1L, e.limits.single().limit)
        assertEquals(false, e.features.single().enabled)
    }
}

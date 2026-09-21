package app.daftar.data

import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/** Sealed result — callers must handle every failure mode explicitly. */
sealed interface Result<out T> {
    data class Ok<T>(val value: T) : Result<T>
    data class HttpError(val status: Int, val code: String?) : Result<Nothing>
    data object NetworkError : Result<Nothing>
    data object Unauthorized : Result<Nothing>
}

// ── Wire DTOs — MIRROR @daftar/shared-contracts EXACTLY (Directive §30) ──────
// Field names are the API's field names. Money is a decimal STRING of minor
// units (never a float, never a Long that could overflow). Unknown fields are
// ignored for forward compatibility.

@Serializable
data class AuthTokens(val accessToken: String, val refreshToken: String, val expiresInSeconds: Long? = null)

/** BusinessSummaryDto */
@Serializable
data class BusinessSummary(
    val businessId: String,
    val tenantId: String,
    val name: String,
    val storeSlug: String,
    val countryCode: String = "",
    val baseCurrency: String,
    val defaultLocale: String = "ar",
    val timezone: String = "",
    val roleKey: String = "member",
)

@Serializable
data class BusinessesResponse(val items: List<BusinessSummary> = emptyList())

/** BusinessSettingsDto */
@Serializable
data class BusinessSettings(
    val businessId: String,
    val tenantId: String,
    val name: String,
    val storeSlug: String,
    val countryCode: String = "",
    val baseCurrency: String,
    val defaultLocale: String = "ar",
    val timezone: String = "",
    val roleKey: String = "member",
    val baseCurrencyLocked: Boolean = false,
)

/** ProductListItemDto — list items carry the locale-resolved `name`, NOT a translations map. */
@Serializable
data class ProductListItem(
    val id: String,
    val name: String,
    val sku: String? = null,
    val basePriceMinor: String, // integer minor units as string — never a float
    val priceCurrency: String,
    val status: String = "active",
)

/** Page<ProductListItemDto> */
@Serializable
data class ProductsResponse(val items: List<ProductListItem> = emptyList(), val nextCursor: String? = null)

/** ProductDto (detail) */
@Serializable
data class ProductDetail(
    val id: String,
    val name: String,
    val translations: Map<String, String> = emptyMap(),
    val sku: String? = null,
    val barcode: String? = null,
    val unit: String? = null,
    val categoryId: String? = null,
    val basePriceMinor: String,
    val priceCurrency: String,
    val version: Int = 1,
    val status: String = "active",
    val media: List<MediaItem> = emptyList(),
)

@Serializable
data class MediaItem(val id: String, val url: String)

@Serializable
data class MediaUploadResult(val id: String, val url: String)

/** MemberDto — `roleKeys`, not `roles`. */
@Serializable
data class Member(
    val userId: String,
    val email: String? = null,
    val displayName: String,
    val roleKeys: List<String> = emptyList(),
    val status: String,
    val branchScopeMode: String = "all",
    val allowedBranchIds: List<String> = emptyList(),
)

@Serializable
data class MembersResponse(val items: List<Member> = emptyList())

/** EntitlementSummaryDto */
@Serializable
data class EntitlementSummary(
    val planKey: String,
    val planVersion: Int,
    val state: String,
    val effectiveState: String,
    val trialEndsAt: String? = null,
    val periodEndsAt: String? = null,
    val features: List<FeatureEntitlement> = emptyList(),
    val limits: List<LimitUsage> = emptyList(),
)

@Serializable
data class FeatureEntitlement(val key: String, val enabled: Boolean)

@Serializable
data class LimitUsage(val key: String, val limit: Long, val usage: Long)

/** CurrencyDto — the ONLY source of minor units on Android (Directive §35): served by the API from domain-core. */
@Serializable
data class CurrencyInfo(val code: String, val name: String, val minorUnits: Int)

@Serializable
data class CurrenciesResponse(val items: List<CurrencyInfo> = emptyList())

@Serializable
data class OnboardingResult(val businessId: String, val tenantId: String, val storeSlug: String, val replayed: Boolean = false)

@Serializable
private data class ApiErrorBody(val error: ApiErrorDetail? = null)

@Serializable
private data class ApiErrorDetail(val code: String? = null)

/**
 * One in-flight operation. Directive §31–32: a 401 → refresh → retry MUST
 * resend the ORIGINAL request — same method, URL, query, headers, body,
 * business context and Idempotency-Key. The spec is the single source the
 * retry is rebuilt from; the response body is never used as a request body.
 */
class RequestSpec internal constructor(
    val method: String,
    val path: String,
    val jsonBody: String? = null,
    val multipart: MultipartSpec? = null,
    val authorized: Boolean = true,
    /** Generated ONCE per operation; every retry of this operation reuses it. */
    val idempotencyKey: String? = if (method == "GET") null else UUID.randomUUID().toString(),
)

class MultipartSpec(val fieldName: String, val fileName: String, val mimeType: String, val bytes: ByteArray)

class ApiClient(
    private val baseUrl: String,
    private val tokenStore: TokenStore,
    private val client: OkHttpClient = OkHttpClient(),
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    /** Server-authorized business context (X-Business-Id); the server resolves membership. */
    var businessId: String? = null

    internal fun build(spec: RequestSpec): Request {
        val builder = Request.Builder().url("$baseUrl/v1${spec.path}")
        if (spec.authorized) {
            tokenStore.accessToken()?.let { builder.header("Authorization", "Bearer $it") }
            businessId?.let { builder.header("X-Business-Id", it) }
        }
        spec.idempotencyKey?.let { builder.header("Idempotency-Key", it) }
        val body: RequestBody? = when {
            spec.multipart != null -> MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart(
                    spec.multipart.fieldName,
                    spec.multipart.fileName,
                    spec.multipart.bytes.toRequestBody(spec.multipart.mimeType.toMediaType()),
                )
                .build()
            spec.jsonBody != null -> spec.jsonBody.toRequestBody(jsonType)
            spec.method == "GET" -> null
            else -> "".toRequestBody(jsonType)
        }
        return builder.method(spec.method, body).build()
    }

    private fun errorCode(text: String): String? =
        runCatching { json.decodeFromString<ApiErrorBody>(text).error?.code }.getOrNull()

    private suspend fun <T> call(spec: RequestSpec, retry: Boolean = true, parse: (String) -> T): Result<T> =
        withContext(Dispatchers.IO) {
            try {
                client.newCall(build(spec)).execute().use { res ->
                    val text = res.body?.string().orEmpty()
                    when {
                        res.isSuccessful -> Result.Ok(parse(text))
                        // §31: refresh, then REPLAY THE SAME SPEC (same key, same body).
                        res.code == 401 && retry && spec.authorized && refresh() is Result.Ok<*> ->
                            call(spec, retry = false, parse = parse)
                        res.code == 401 -> Result.Unauthorized
                        else -> Result.HttpError(res.code, errorCode(text))
                    }
                }
            } catch (e: IOException) {
                Result.NetworkError
            }
        }

    @Serializable
    private data class LoginRequest(val email: String, val password: String)

    @Serializable
    private data class RefreshRequest(val refreshToken: String)

    suspend fun login(email: String, password: String): Result<AuthTokens> {
        val spec = RequestSpec("POST", "/auth/login", json.encodeToString(LoginRequest(email, password)), authorized = false)
        return when (val res = call(spec, retry = false) { s: String -> json.decodeFromString<AuthTokens>(s) }) {
            is Result.Ok -> {
                tokenStore.setAccessToken(res.value.accessToken)
                tokenStore.refreshToken = res.value.refreshToken
                res
            }
            else -> res
        }
    }

    suspend fun refresh(): Result<AuthTokens> {
        val rt = tokenStore.refreshToken ?: return Result.Unauthorized
        val spec = RequestSpec("POST", "/auth/refresh", json.encodeToString(RefreshRequest(rt)), authorized = false)
        return when (val res = call(spec, retry = false) { s: String -> json.decodeFromString<AuthTokens>(s) }) {
            is Result.Ok -> {
                tokenStore.setAccessToken(res.value.accessToken)
                tokenStore.refreshToken = res.value.refreshToken // rotation
                res
            }
            else -> {
                if (res is Result.Unauthorized || (res as? Result.HttpError)?.status == 401) tokenStore.clear()
                res
            }
        }
    }

    // ── Reference data ──────────────────────────────────────────────────────
    suspend fun currencies(): Result<CurrenciesResponse> =
        call(RequestSpec("GET", "/platform/currencies", authorized = false)) { json.decodeFromString<CurrenciesResponse>(it) }

    // ── Business context ────────────────────────────────────────────────────
    suspend fun businesses(): Result<BusinessesResponse> =
        call(RequestSpec("GET", "/me/businesses")) { json.decodeFromString<BusinessesResponse>(it) }

    suspend fun currentBusiness(): Result<BusinessSettings> =
        call(RequestSpec("GET", "/businesses/current")) { json.decodeFromString<BusinessSettings>(it) }

    @Serializable
    private data class SettingsPatch(val name: String? = null, val defaultLocale: String? = null)

    suspend fun updateSettings(name: String?, defaultLocale: String?): Result<BusinessSettings> =
        call(RequestSpec("PATCH", "/businesses/current", json.encodeToString(SettingsPatch(name, defaultLocale)))) {
            json.decodeFromString<BusinessSettings>(it)
        }

    // ── Catalog ─────────────────────────────────────────────────────────────
    suspend fun products(search: String? = null): Result<ProductsResponse> {
        val q = search?.takeIf { it.isNotBlank() }?.let { "?search=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""
        return call(RequestSpec("GET", "/catalog/products$q")) { json.decodeFromString<ProductsResponse>(it) }
    }

    suspend fun product(id: String): Result<ProductDetail> =
        call(RequestSpec("GET", "/catalog/products/$id")) { json.decodeFromString<ProductDetail>(it) }

    @Serializable
    private data class ProductCreateRequest(val translations: Map<String, String>, val basePriceMinor: String, val sku: String? = null)

    /** §41: the client sends minor units ONLY — the server derives priceCurrency from the business base currency. */
    suspend fun createProduct(name: String, priceMinor: String, locale: String, sku: String? = null): Result<ProductDetail> {
        val body = json.encodeToString(ProductCreateRequest(mapOf(locale to name), priceMinor, sku?.takeIf { it.isNotBlank() }))
        return call(RequestSpec("POST", "/catalog/products", body)) { json.decodeFromString<ProductDetail>(it) }
    }

    @Serializable
    private data class ProductUpdateRequest(
        val translations: Map<String, String>? = null,
        val basePriceMinor: String? = null,
        val sku: String? = null,
        val version: Int? = null,
    )

    suspend fun updateProduct(id: String, name: String?, locale: String, priceMinor: String?, sku: String?, version: Int): Result<ProductDetail> {
        val body = json.encodeToString(
            ProductUpdateRequest(name?.let { mapOf(locale to it) }, priceMinor, sku?.takeIf { it.isNotBlank() }, version),
        )
        return call(RequestSpec("PATCH", "/catalog/products/$id", body)) { json.decodeFromString<ProductDetail>(it) }
    }

    suspend fun uploadMedia(bytes: ByteArray, mimeType: String, fileName: String): Result<MediaUploadResult> =
        call(RequestSpec("POST", "/catalog/media", multipart = MultipartSpec("file", fileName, mimeType, bytes))) {
            json.decodeFromString<MediaUploadResult>(it)
        }

    suspend fun attachMedia(productId: String, mediaId: String): Result<Unit> =
        call(RequestSpec("POST", "/catalog/products/$productId/media/$mediaId")) { }

    // ── Onboarding ──────────────────────────────────────────────────────────
    @Serializable
    private data class OnboardingRequest(
        val businessName: String,
        val countryCode: String,
        val baseCurrency: String,
        val storeSlug: String,
        val preferredLocale: String,
    )

    suspend fun onboard(businessName: String, countryCode: String, baseCurrency: String, storeSlug: String, locale: String): Result<OnboardingResult> {
        val body = json.encodeToString(OnboardingRequest(businessName, countryCode, baseCurrency, storeSlug, locale))
        val res: Result<OnboardingResult> = call(RequestSpec("POST", "/onboarding/complete", body)) { s: String -> json.decodeFromString<OnboardingResult>(s) }
        return when (res) {
            is Result.Ok -> {
                businessId = res.value.businessId
                res
            }
            else -> res
        }
    }

    // ── Team / plan ─────────────────────────────────────────────────────────
    suspend fun members(): Result<MembersResponse> =
        call(RequestSpec("GET", "/businesses/current/members")) { json.decodeFromString<MembersResponse>(it) }

    suspend fun entitlement(): Result<EntitlementSummary> =
        call(RequestSpec("GET", "/businesses/current/entitlement")) { json.decodeFromString<EntitlementSummary>(it) }

    // ── Session ─────────────────────────────────────────────────────────────
    suspend fun logout() {
        if (tokenStore.accessToken() != null) {
            // Best-effort server-side revocation of the CURRENT session; local state is always cleared.
            call(RequestSpec("POST", "/auth/logout"), retry = false) { }
        }
        tokenStore.clear()
    }
}

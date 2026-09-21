package app.daftar.data

import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Sealed result — callers must handle every failure mode explicitly. */
sealed interface Result<out T> {
    data class Ok<T>(val value: T) : Result<T>
    data class HttpError(val status: Int, val code: String?) : Result<Nothing>
    data object NetworkError : Result<Nothing>
    data object Unauthorized : Result<Nothing>
}

@Serializable
data class AuthTokens(val accessToken: String, val refreshToken: String, val expiresInSeconds: Long? = null)

@Serializable
data class Business(val id: String, val name: String, val storeSlug: String? = null, val baseCurrency: String? = null)

@Serializable
data class BusinessesResponse(val items: List<Business> = emptyList())

@Serializable
data class Product(
    val id: String,
    val translations: Map<String, String> = emptyMap(),
    val sku: String? = null,
    val basePriceMinor: String, // integer minor units as string — never a float
    val priceCurrency: String,
    val status: String = "active",
)

@Serializable
data class ProductsResponse(val items: List<Product> = emptyList())

@Serializable
data class Member(val userId: String, val email: String, val displayName: String, val status: String, val roles: List<String> = emptyList())

@Serializable
data class MembersResponse(val items: List<Member> = emptyList())

class ApiClient(
    private val baseUrl: String,
    private val tokenStore: TokenStore,
    private val client: OkHttpClient = OkHttpClient(),
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    var businessId: String? = null

    private fun build(path: String, method: String, body: String? = null, authorized: Boolean = true): Request {
        val builder = Request.Builder().url("$baseUrl/v1$path")
        if (authorized) {
            tokenStore.accessToken()?.let { builder.header("Authorization", "Bearer $it") }
            businessId?.let { builder.header("X-Business-Id", it) }
        }
        if (body != null) {
            builder.header("Idempotency-Key", UUID.randomUUID().toString())
            builder.method(method, body.toRequestBody(jsonType))
        } else {
            builder.method(method, if (method == "GET") null else "".toRequestBody(jsonType))
        }
        return builder.build()
    }

    private suspend fun <T> call(request: Request, parse: (String) -> T, retry: Boolean = true): Result<T> =
        withContext(Dispatchers.IO) {
            try {
                client.newCall(request).execute().use { res ->
                    val text = res.body?.string().orEmpty()
                    when {
                        res.isSuccessful -> Result.Ok(parse(text))
                        res.code == 401 && retry && refresh() is Result.Ok<*> -> {
                            val retried = build(
                                request.url.encodedPath.removePrefix("/v1"),
                                request.method,
                                if (request.body != null) text else null,
                            )
                            call(retried, parse, retry = false)
                        }
                        res.code == 401 -> Result.Unauthorized
                        else -> Result.HttpError(res.code, null)
                    }
                }
            } catch (e: IOException) {
                Result.NetworkError
            }
        }

    @Serializable
    private data class LoginRequest(val email: String, val password: String)

    suspend fun login(email: String, password: String): Result<AuthTokens> {
        val body = json.encodeToString(LoginRequest.serializer(), LoginRequest(email, password))
        val request = build("/auth/login", "POST", body, authorized = false)
        return when (val res = call(request, { s: String -> json.decodeFromString<AuthTokens>(s) }, retry = false)) {
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
        val body = """{"refreshToken":"$rt"}"""
        val request = build("/auth/refresh", "POST", body, authorized = false)
        return when (val res = call(request, { s: String -> json.decodeFromString<AuthTokens>(s) }, retry = false)) {
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

    suspend fun businesses(): Result<BusinessesResponse> =
        call(build("/me/businesses", "GET")) { json.decodeFromString<BusinessesResponse>(it) }

    suspend fun products(query: String? = null): Result<ProductsResponse> =
        call(build("/catalog/products${query?.let { "?q=$it" } ?: ""}", "GET")) { json.decodeFromString<ProductsResponse>(it) }

    suspend fun createProduct(name: String, priceMinor: String, currency: String, locale: String): Result<Product> {
        val body = """{"translations":{"$locale":${json.encodeToString(kotlinx.serialization.builtins.serializer<String>(), name)}},""" +
            """"basePriceMinor":"$priceMinor","priceCurrency":"$currency"}"""
        return call(build("/catalog/products", "POST", body)) { json.decodeFromString<Product>(it) }
    }

    @Serializable
    private data class OnboardingRequest(
        val businessName: String,
        val countryCode: String,
        val baseCurrency: String,
        val storeSlug: String,
        val preferredLocale: String = "ar",
    )

    @Serializable
    private data class OnboardingResponse(val businessId: String)

    suspend fun onboard(businessName: String, countryCode: String, baseCurrency: String, storeSlug: String): Boolean {
        val body = json.encodeToString(
            OnboardingRequest.serializer(),
            OnboardingRequest(businessName, countryCode, baseCurrency, storeSlug),
        )
        return when (val res = call(build("/onboarding/complete", "POST", body)) { s: String ->
            json.decodeFromString<OnboardingResponse>(s)
        }) {
            is Result.Ok -> {
                businessId = res.value.businessId
                true
            }
            else -> false
        }
    }

    suspend fun members(): Result<MembersResponse> =
        call(build("/businesses/current/members", "GET")) { json.decodeFromString<MembersResponse>(it) }

    suspend fun logout() {
        val rt = tokenStore.refreshToken
        if (rt != null) {
            try {
                client.newCall(build("/auth/logout", "POST", """{"refreshToken":"$rt"}""")).execute().close()
            } catch (_: IOException) {
                // Logout is best-effort; local session is always cleared.
            }
        }
        tokenStore.clear()
    }
}

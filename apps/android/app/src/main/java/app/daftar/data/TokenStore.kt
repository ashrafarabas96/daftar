package app.daftar.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Credential storage (Phase 1 security contract):
 * - refresh token lives ONLY in Keystore-backed EncryptedSharedPreferences,
 * - access token lives in process memory only (never persisted),
 * - nothing sensitive is ever logged.
 */
class TokenStore(context: Context) {

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "daftar_session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    @Volatile
    private var accessToken: String? = null

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH, null)
        set(value) {
            prefs.edit().apply {
                if (value == null) remove(KEY_REFRESH) else putString(KEY_REFRESH, value)
            }.apply()
        }

    fun accessToken(): String? = accessToken

    fun setAccessToken(token: String?) {
        accessToken = token
    }

    fun clear() {
        accessToken = null
        prefs.edit().clear().apply()
    }

    private companion object {
        const val KEY_REFRESH = "refresh_token"
    }
}

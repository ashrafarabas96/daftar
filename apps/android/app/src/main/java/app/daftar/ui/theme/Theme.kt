package app.daftar.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Mirrors @daftar/design-system tokens — single visual truth across surfaces.
val BrandPrimary = Color(0xFF2563EB)
val BrandPrimarySoft = Color(0xFFDBEAFE)
val BrandAccent = Color(0xFF60A5FA)
val SemanticSuccess = Color(0xFF059669)
val SemanticDanger = Color(0xFFDC2626)
val Neutral900 = Color(0xFF111827)
val Neutral100 = Color(0xFFF3F4F6)
val Neutral0 = Color(0xFFFFFFFF)

private val LightColors = lightColorScheme(
    primary = BrandPrimary,
    onPrimary = Neutral0,
    primaryContainer = BrandPrimarySoft,
    secondary = BrandAccent,
    surface = Neutral0,
    background = Neutral100,
    onSurface = Neutral900,
    error = SemanticDanger,
)

private val DarkColors = darkColorScheme(
    primary = BrandAccent,
    onPrimary = Neutral900,
    primaryContainer = BrandPrimary,
    secondary = BrandAccent,
    error = SemanticDanger,
)

@Composable
fun DaftarTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}

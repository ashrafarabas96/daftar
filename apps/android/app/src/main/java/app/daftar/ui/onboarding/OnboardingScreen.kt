package app.daftar.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.daftar.R
import app.daftar.data.ApiClient
import app.daftar.data.Result
import kotlinx.coroutines.launch

@Composable
fun OnboardingScreen(api: ApiClient, onDone: () -> Unit) {
    var businessName by remember { mutableStateOf("") }
    var countryCode by remember { mutableStateOf("") }
    var baseCurrency by remember { mutableStateOf("") }
    var storeSlug by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()
    val locale = LocalConfiguration.current.locales[0].language.takeIf { it in setOf("ar", "en", "tr") } ?: "ar"

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(stringResource(R.string.onboarding_title), style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(value = businessName, onValueChange = { businessName = it }, label = { Text(stringResource(R.string.onboarding_business_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 16.dp))
        OutlinedTextField(value = countryCode, onValueChange = { countryCode = it.uppercase() }, label = { Text(stringResource(R.string.onboarding_country)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
        OutlinedTextField(value = baseCurrency, onValueChange = { baseCurrency = it.uppercase() }, label = { Text(stringResource(R.string.onboarding_currency)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
        OutlinedTextField(value = storeSlug, onValueChange = { storeSlug = it.lowercase() }, label = { Text(stringResource(R.string.onboarding_slug)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
        error?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
        Button(
            onClick = {
                scope.launch {
                    busy = true
                    error = null
                    when (val res = api.onboard(businessName, countryCode, baseCurrency, storeSlug, locale)) {
                        is Result.Ok -> onDone()
                        is Result.NetworkError -> { error = R.string.error_offline; busy = false }
                        else -> { error = R.string.onboarding_failed; busy = false }
                    }
                }
            },
            enabled = !busy && businessName.isNotBlank() && countryCode.length == 2 && baseCurrency.length == 3 && storeSlug.length >= 3,
            modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
        ) {
            Text(stringResource(R.string.onboarding_submit))
        }
    }
}

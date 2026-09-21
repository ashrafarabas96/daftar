package app.daftar.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.daftar.R
import app.daftar.data.ApiClient
import app.daftar.data.Result
import kotlinx.coroutines.launch

/** Settings subset (Android Phase 1 scope §33): business name + default language (read-only base currency) + logout. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(api: ApiClient, onLoggedOut: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var defaultLocale by remember { mutableStateOf("ar") }
    var baseCurrency by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<Int?>(null) }

    LaunchedEffect(Unit) {
        when (val res = api.currentBusiness()) {
            is Result.Ok -> {
                name = res.value.name
                defaultLocale = res.value.defaultLocale
                baseCurrency = res.value.baseCurrency
            }
            is Result.NetworkError -> message = R.string.error_offline
            else -> Unit
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.settings_title)) }) }) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState())) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.settings_business_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(stringResource(R.string.settings_default_locale), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 16.dp))
            androidx.compose.foundation.layout.Row(modifier = Modifier.padding(top = 4.dp)) {
                listOf("ar" to "العربية", "en" to "English", "tr" to "Türkçe").forEach { (code, label) ->
                    FilterChip(selected = defaultLocale == code, onClick = { defaultLocale = code }, label = { Text(label) }, modifier = Modifier.padding(end = 8.dp))
                }
            }
            OutlinedTextField(
                value = baseCurrency,
                onValueChange = {},
                enabled = false,
                label = { Text(stringResource(R.string.settings_base_currency)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
            message?.let { Text(stringResource(it), modifier = Modifier.padding(top = 12.dp)) }
            Button(
                onClick = {
                    scope.launch {
                        busy = true
                        message = when (api.updateSettings(name, defaultLocale)) {
                            is Result.Ok -> R.string.common_saved
                            is Result.NetworkError -> R.string.error_offline
                            else -> R.string.error_generic
                        }
                        busy = false
                    }
                },
                enabled = !busy && name.isNotBlank(),
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
            ) {
                Text(stringResource(R.string.common_save))
            }

            Text(stringResource(R.string.settings_security), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 32.dp))
            Button(
                onClick = {
                    scope.launch {
                        api.logout()
                        onLoggedOut()
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            ) {
                Text(stringResource(R.string.auth_logout))
            }
        }
    }
}

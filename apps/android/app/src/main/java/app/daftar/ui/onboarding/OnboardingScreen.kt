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
import androidx.compose.ui.unit.dp
import app.daftar.data.ApiClient
import kotlinx.coroutines.launch

@Composable
fun OnboardingScreen(api: ApiClient, onDone: () -> Unit) {
    var businessName by remember { mutableStateOf("") }
    var countryCode by remember { mutableStateOf("") }
    var baseCurrency by remember { mutableStateOf("") }
    var storeSlug by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("إعداد نشاطك التجاري", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(value = businessName, onValueChange = { businessName = it }, label = { Text("اسم النشاط") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 16.dp))
        OutlinedTextField(value = countryCode, onValueChange = { countryCode = it.uppercase() }, label = { Text("الدولة (مثل JO)") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
        OutlinedTextField(value = baseCurrency, onValueChange = { baseCurrency = it.uppercase() }, label = { Text("العملة (مثل JOD)") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
        OutlinedTextField(value = storeSlug, onValueChange = { storeSlug = it.lowercase() }, label = { Text("الرابط المميز") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
        Button(
            onClick = {
                scope.launch {
                    busy = true
                    error = null
                    val ok = api.onboard(businessName, countryCode, baseCurrency, storeSlug)
                    if (ok) onDone() else {
                        error = "تعذر إنشاء النشاط — تحقق من البيانات"
                        busy = false
                    }
                }
            },
            enabled = !busy && businessName.isNotBlank() && countryCode.length == 2 && baseCurrency.length == 3 && storeSlug.length >= 3,
            modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
        ) {
            Text("إنشاء النشاط")
        }
    }
}

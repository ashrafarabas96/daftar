package app.daftar.ui.catalog

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.daftar.data.ApiClient
import app.daftar.data.Product
import app.daftar.data.Result
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProductListScreen(api: ApiClient) {
    var products by remember { mutableStateOf<List<Product>>(emptyList()) }
    var query by remember { mutableStateOf("") }
    var offline by remember { mutableStateOf(false) }

    suspend fun load(q: String) {
        when (val res = api.products(q.ifBlank { null })) {
            is Result.Ok -> {
                products = res.value.items
                offline = false
            }
            is Result.NetworkError -> offline = true
            else -> Unit
        }
    }

    LaunchedEffect(query) {
        delay(300) // debounce
        load(query)
    }

    Scaffold(topBar = { TopAppBar(title = { Text("المنتجات") }) }) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("ابحث بالاسم أو الرمز…") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (offline) {
                Text("لا يوجد اتصال — تحقق من الشبكة", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp))
            }
            if (products.isEmpty() && !offline) {
                Text("لا توجد منتجات بعد — أنشئ أول منتج.", modifier = Modifier.padding(top = 24.dp))
            }
            LazyColumn(modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) {
                items(products) { p ->
                    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(p.translations["ar"] ?: p.translations.values.firstOrNull() ?: "—", style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${p.sku ?: ""} · ${p.basePriceMinor} ${p.priceCurrency}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

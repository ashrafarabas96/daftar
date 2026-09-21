package app.daftar.ui.catalog

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.daftar.R
import app.daftar.data.ApiClient
import app.daftar.data.Money
import app.daftar.data.ProductListItem
import app.daftar.data.Result
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProductListScreen(api: ApiClient, onOpen: (String) -> Unit, onCreate: () -> Unit) {
    var products by remember { mutableStateOf<List<ProductListItem>>(emptyList()) }
    var minorUnits by remember { mutableStateOf<Map<String, Int>>(emptyMap()) }
    var query by remember { mutableStateOf("") }
    var offline by remember { mutableStateOf(false) }
    val locale = LocalConfiguration.current.locales[0]

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

    LaunchedEffect(Unit) {
        // §35: minor units come from the API (domain-core registry) — never a local table.
        when (val res = api.currencies()) {
            is Result.Ok -> minorUnits = res.value.items.associate { it.code to it.minorUnits }
            else -> Unit
        }
    }

    LaunchedEffect(query) {
        delay(300) // debounce
        load(query)
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.catalog_title)) }) },
        floatingActionButton = {
            FloatingActionButton(onClick = onCreate) { Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.catalog_new)) }
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text(stringResource(R.string.catalog_search)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (offline) {
                Text(stringResource(R.string.error_offline), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp))
            }
            if (products.isEmpty() && !offline) {
                Text(stringResource(R.string.catalog_empty), modifier = Modifier.padding(top = 24.dp))
            }
            LazyColumn(modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) {
                items(products, key = { it.id }) { p ->
                    Card(onClick = { onOpen(p.id) }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(p.name, style = MaterialTheme.typography.titleMedium)
                            val price = minorUnits[p.priceCurrency]?.let { Money.format(p.basePriceMinor, p.priceCurrency, it, locale) }
                                ?: "${p.basePriceMinor} ${p.priceCurrency}" // minor units until the registry loads — never a float
                            Text(
                                listOfNotNull(p.sku, price, if (p.status == "archived") stringResource(R.string.catalog_archived) else null).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

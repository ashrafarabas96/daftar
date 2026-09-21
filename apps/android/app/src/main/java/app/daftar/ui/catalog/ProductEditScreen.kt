package app.daftar.ui.catalog

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.daftar.R
import app.daftar.data.ApiClient
import app.daftar.data.Money
import app.daftar.data.ProductDetail
import app.daftar.data.Result
import java.math.BigDecimal
import java.math.BigInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Product create/edit (Phase 1 Android scope §33): name + price (+ optional
 * SKU), optimistic concurrency via `version`, and photo upload → attach.
 * Money: the user types a MAJOR decimal; it is converted EXACTLY to minor
 * units with the currency's minor units from the API (§35–36).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProductEditScreen(api: ApiClient, productId: String?, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val uiLocale = locale.language.takeIf { it in setOf("ar", "en", "tr") } ?: "ar"

    var product by remember { mutableStateOf<ProductDetail?>(null) }
    var currency by remember { mutableStateOf("") }
    var minorUnits by remember { mutableIntStateOf(2) }
    var name by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var sku by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<Int?>(null) }
    var priceError by remember { mutableStateOf(false) }

    LaunchedEffect(productId) {
        when (val biz = api.currentBusiness()) {
            is Result.Ok -> currency = biz.value.baseCurrency
            else -> Unit
        }
        when (val cur = api.currencies()) {
            is Result.Ok -> cur.value.items.firstOrNull { it.code == currency }?.let { minorUnits = it.minorUnits }
            else -> Unit
        }
        if (productId != null) {
            when (val res = api.product(productId)) {
                is Result.Ok -> {
                    product = res.value
                    name = res.value.translations[uiLocale] ?: res.value.name
                    sku = res.value.sku.orEmpty()
                    price = BigDecimal(BigInteger(res.value.basePriceMinor)).movePointLeft(minorUnits).toPlainString()
                }
                is Result.NetworkError -> message = R.string.error_offline
                else -> message = R.string.error_generic
            }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        val current = product ?: return@rememberLauncherForActivityResult
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            busy = true
            val bytes = withContext(Dispatchers.IO) { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }
            val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
            val uploaded = if (bytes == null) null else api.uploadMedia(bytes, mime, "photo")
            message = when (uploaded) {
                is Result.Ok -> when (api.attachMedia(current.id, uploaded.value.id)) {
                    is Result.Ok -> R.string.catalog_photo_uploaded
                    else -> R.string.catalog_photo_failed
                }
                is Result.NetworkError -> R.string.error_offline
                else -> R.string.catalog_photo_failed
            }
            busy = false
        }
    }

    fun save() {
        val minor = try {
            Money.parseMajorToMinor(price, minorUnits)
        } catch (e: Money.InvalidAmount) {
            priceError = true
            return
        }
        priceError = false
        scope.launch {
            busy = true
            message = null
            val res = product?.let { api.updateProduct(it.id, name, uiLocale, minor, sku, it.version) }
                ?: api.createProduct(name, minor, uiLocale, sku)
            when (res) {
                is Result.Ok -> onDone()
                is Result.NetworkError -> message = R.string.error_offline
                is Result.HttpError -> message = when {
                    res.status == 409 && res.code == "PLAN_LIMIT_EXCEEDED" -> R.string.error_plan_limit
                    res.status == 409 -> R.string.error_conflict
                    else -> R.string.error_generic
                }
                is Result.Unauthorized -> message = R.string.error_generic
            }
            busy = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (productId == null) R.string.catalog_new else R.string.catalog_edit)) },
                navigationIcon = {
                    IconButton(onClick = onDone) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back)) }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState())) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.catalog_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = price,
                onValueChange = { price = it },
                label = { Text(stringResource(R.string.catalog_price, currency)) },
                isError = priceError,
                supportingText = if (priceError) ({ Text(stringResource(R.string.catalog_price_invalid)) }) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
            OutlinedTextField(
                value = sku,
                onValueChange = { sku = it },
                label = { Text(stringResource(R.string.catalog_sku)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
            message?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
            Row(modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) {
                Button(onClick = { save() }, enabled = !busy && name.isNotBlank() && price.isNotBlank() && currency.isNotBlank(), modifier = Modifier.weight(1f)) {
                    Text(stringResource(R.string.common_save))
                }
            }
            if (product != null) {
                Text(stringResource(R.string.catalog_media), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 24.dp))
                Text("${product?.media?.size ?: 0}", style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { picker.launch("image/*") }, enabled = !busy, modifier = Modifier.padding(top = 8.dp)) {
                    Text(stringResource(R.string.catalog_add_photo))
                }
            }
        }
    }
}

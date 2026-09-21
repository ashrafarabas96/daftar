package app.daftar.ui.plan

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.daftar.R
import app.daftar.data.ApiClient
import app.daftar.data.EntitlementSummary
import app.daftar.data.Result

/** Plan / usage (Android Phase 1 scope §33): the SAME /businesses/current/entitlement contract the web plan page renders. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlanScreen(api: ApiClient) {
    var plan by remember { mutableStateOf<EntitlementSummary?>(null) }
    var error by remember { mutableStateOf<Int?>(null) }

    LaunchedEffect(Unit) {
        when (val res = api.entitlement()) {
            is Result.Ok -> plan = res.value
            is Result.NetworkError -> error = R.string.error_offline
            else -> error = R.string.error_generic
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.plan_title)) }) }) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState())) {
            error?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
            val p = plan
            if (p == null) {
                if (error == null) Text(stringResource(R.string.common_loading))
            } else {
                Text(stringResource(R.string.plan_current), style = MaterialTheme.typography.titleMedium)
                Text("${p.planKey} · v${p.planVersion} · ${p.effectiveState}", style = MaterialTheme.typography.bodyLarge)
                Text(stringResource(R.string.plan_limits), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
                val unlimited = stringResource(R.string.plan_unlimited)
                p.limits.forEach { l ->
                    Text("${l.key}: ${l.usage} / ${if (l.limit == -1L) unlimited else l.limit.toString()}", style = MaterialTheme.typography.bodyMedium)
                }
                Text(stringResource(R.string.plan_features), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
                p.features.forEach { f ->
                    Text("${f.key}: ${if (f.enabled) "✓" else "—"}", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

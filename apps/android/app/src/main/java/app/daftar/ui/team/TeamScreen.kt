package app.daftar.ui.team

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
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
import androidx.compose.ui.unit.dp
import app.daftar.data.ApiClient
import app.daftar.data.Member
import app.daftar.data.Result

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TeamScreen(api: ApiClient) {
    var members by remember { mutableStateOf<List<Member>>(emptyList()) }

    LaunchedEffect(Unit) {
        when (val res = api.members()) {
            is Result.Ok -> members = res.value.items
            else -> Unit
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text("الفريق") }) }) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            items(members) { m ->
                Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(m.displayName, style = MaterialTheme.typography.titleMedium)
                        Text("${m.email} · ${m.roles.joinToString()} · ${m.status}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

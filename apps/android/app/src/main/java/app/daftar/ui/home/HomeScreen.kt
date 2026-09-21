package app.daftar.ui.home

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import app.daftar.data.ApiClient
import app.daftar.data.Business
import app.daftar.data.Result

/**
 * Home / business switch. Intentional adaptive layout:
 * - phone: bottom NavigationBar,
 * - tablet: NavigationRail side rail.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(api: ApiClient, nav: NavHostController, isTablet: Boolean) {
    var businesses by remember { mutableStateOf<List<Business>>(emptyList()) }

    LaunchedEffect(Unit) {
        when (val res = api.businesses()) {
            is Result.Ok -> {
                businesses = res.value.items
                if (api.businessId == null) api.businessId = res.value.items.firstOrNull()?.id
            }
            else -> Unit
        }
    }

    val destinations = listOf(
        Triple("home", "الرئيسية", Icons.Filled.Home),
        Triple("catalog", "المنتجات", Icons.Filled.List),
        Triple("team", "الفريق", Icons.Filled.People),
        Triple("settings", "الإعدادات", Icons.Filled.Settings),
    )

    val content: @Composable (Modifier) -> Unit = { modifier ->
        Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
            Text("أنشطتي التجارية", style = MaterialTheme.typography.headlineSmall)
            LazyColumn(modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) {
                items(businesses) { b ->
                    Card(
                        onClick = { api.businessId = b.id },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(b.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${b.storeSlug ?: ""} · ${b.baseCurrency ?: ""}" + if (b.id == api.businessId) " · ✓" else "",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
    }

    if (isTablet) {
        Row(modifier = Modifier.fillMaxSize()) {
            NavigationRail {
                destinations.forEach { (route, label, icon) ->
                    NavigationRailItem(
                        selected = route == "home",
                        onClick = { if (route != "home") nav.navigate(route) },
                        icon = { Icon(icon, contentDescription = label) },
                        label = { Text(label) },
                    )
                }
            }
            content(Modifier.weight(1f))
        }
    } else {
        Scaffold(
            topBar = { TopAppBar(title = { Text("دفتر") }) },
            bottomBar = {
                NavigationBar {
                    destinations.forEach { (route, label, icon) ->
                        NavigationBarItem(
                            selected = route == "home",
                            onClick = { if (route != "home") nav.navigate(route) },
                            icon = { Icon(icon, contentDescription = label) },
                            label = { Text(label) },
                        )
                    }
                }
            },
        ) { padding ->
            content(Modifier.padding(padding))
        }
    }
}

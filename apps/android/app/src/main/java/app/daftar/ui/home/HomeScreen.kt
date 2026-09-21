package app.daftar.ui.home

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import app.daftar.R
import app.daftar.data.ApiClient
import app.daftar.data.BusinessSummary
import app.daftar.data.Result

/**
 * Home / business switch. Intentional adaptive layout:
 * - phone: bottom NavigationBar,
 * - tablet: NavigationRail side rail.
 * A user with NO business is sent to onboarding.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(api: ApiClient, nav: NavHostController, isTablet: Boolean, onNeedsOnboarding: () -> Unit) {
    var businesses by remember { mutableStateOf<List<BusinessSummary>>(emptyList()) }
    var offline by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        when (val res = api.businesses()) {
            is Result.Ok -> {
                businesses = res.value.items
                offline = false
                if (res.value.items.isEmpty()) {
                    onNeedsOnboarding()
                } else if (api.businessId == null || res.value.items.none { it.businessId == api.businessId }) {
                    api.businessId = res.value.items.first().businessId
                }
            }
            is Result.NetworkError -> offline = true
            else -> Unit
        }
    }

    val destinations = listOf(
        Triple("home", R.string.nav_home, Icons.Filled.Home),
        Triple("catalog", R.string.nav_catalog, Icons.Filled.List),
        Triple("team", R.string.nav_team, Icons.Filled.People),
        Triple("plan", R.string.nav_plan, Icons.Filled.Star),
        Triple("settings", R.string.nav_settings, Icons.Filled.Settings),
    )

    val content: @Composable (Modifier) -> Unit = { modifier ->
        Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
            Text(stringResource(R.string.home_my_businesses), style = MaterialTheme.typography.headlineSmall)
            if (offline) Text(stringResource(R.string.error_offline), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp))
            LazyColumn(modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) {
                items(businesses, key = { it.businessId }) { b ->
                    val current = b.businessId == api.businessId
                    Card(
                        onClick = { api.businessId = b.businessId },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(b.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                listOfNotNull(b.storeSlug, b.baseCurrency, b.roleKey, if (current) stringResource(R.string.home_current) else null).joinToString(" · "),
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
                        icon = { Icon(icon, contentDescription = stringResource(label)) },
                        label = { Text(stringResource(label)) },
                    )
                }
            }
            content(Modifier.weight(1f))
        }
    } else {
        Scaffold(
            topBar = { TopAppBar(title = { Text(stringResource(R.string.app_name)) }) },
            bottomBar = {
                NavigationBar {
                    destinations.forEach { (route, label, icon) ->
                        NavigationBarItem(
                            selected = route == "home",
                            onClick = { if (route != "home") nav.navigate(route) },
                            icon = { Icon(icon, contentDescription = stringResource(label)) },
                            label = { Text(stringResource(label)) },
                        )
                    }
                }
            },
        ) { padding ->
            content(Modifier.padding(padding))
        }
    }
}

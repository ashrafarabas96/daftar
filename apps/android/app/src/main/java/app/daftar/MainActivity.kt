package app.daftar

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.daftar.data.ApiClient
import app.daftar.data.TokenStore
import app.daftar.ui.catalog.ProductEditScreen
import app.daftar.ui.catalog.ProductListScreen
import app.daftar.ui.home.HomeScreen
import app.daftar.ui.login.LoginScreen
import app.daftar.ui.onboarding.OnboardingScreen
import app.daftar.ui.plan.PlanScreen
import app.daftar.ui.settings.SettingsScreen
import app.daftar.ui.team.TeamScreen
import app.daftar.ui.theme.DaftarTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tokenStore = TokenStore(applicationContext)
        val api = ApiClient(BuildConfig.API_BASE_URL, tokenStore)
        setContent {
            DaftarTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    DaftarNavHost(api)
                }
            }
        }
    }
}

@Composable
fun DaftarNavHost(api: ApiClient) {
    val nav = rememberNavController()
    // Intentional adaptive layout: tablets (smallestWidth >= 600dp) get a
    // side navigation rail; phones get bottom navigation. See HomeScreen.
    val isTablet = LocalConfiguration.current.smallestScreenWidthDp >= 600
    // Always start at login; LoginScreen silently refreshes a stored session.
    NavHost(navController = nav, startDestination = "login") {
        composable("login") {
            LoginScreen(api = api, onLoggedIn = {
                nav.navigate("home") { popUpTo("login") { inclusive = true } }
            })
        }
        composable("onboarding") {
            OnboardingScreen(api = api, onDone = {
                nav.navigate("home") { popUpTo("onboarding") { inclusive = true } }
            })
        }
        composable("home") { HomeScreen(api = api, nav = nav, isTablet = isTablet, onNeedsOnboarding = { nav.navigate("onboarding") }) }
        composable("catalog") { ProductListScreen(api = api, onOpen = { id -> nav.navigate("product/$id") }, onCreate = { nav.navigate("product/new") }) }
        composable("product/new") { ProductEditScreen(api = api, productId = null, onDone = { nav.popBackStack() }) }
        composable("product/{id}") { entry ->
            ProductEditScreen(api = api, productId = entry.arguments?.getString("id"), onDone = { nav.popBackStack() })
        }
        composable("team") { TeamScreen(api = api) }
        composable("plan") { PlanScreen(api = api) }
        composable("settings") {
            SettingsScreen(api = api, onLoggedOut = {
                nav.navigate("login") { popUpTo(0) { inclusive = true } }
            })
        }
    }
}

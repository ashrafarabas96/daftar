package app.daftar.ui.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.daftar.data.ApiClient
import app.daftar.data.Result
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(api: ApiClient, onLoggedIn: () -> Unit, onNeedsOnboarding: () -> Unit) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // Silent session restore: a stored refresh token skips the form.
    LaunchedEffect(Unit) {
        if (api.tryRestoreSession()) onLoggedIn()
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("دفتر", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.primary)
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("البريد الإلكتروني") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("كلمة المرور") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
        )
        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp))
        }
        Button(
            onClick = {
                scope.launch {
                    busy = true
                    error = null
                    when (api.login(email, password)) {
                        is Result.Ok -> onLoggedIn()
                        is Result.Unauthorized -> error = "بيانات الدخول غير صحيحة"
                        is Result.NetworkError -> error = "لا يوجد اتصال — تحقق من الشبكة"
                        is Result.HttpError -> error = "حدث خطأ. حاول مجدداً."
                    }
                    busy = false
                }
            },
            enabled = !busy && email.contains('@') && password.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().padding(top = 24.dp),
        ) {
            if (busy) CircularProgressIndicator() else Text("دخول")
        }
    }
}

private suspend fun ApiClient.tryRestoreSession(): Boolean =
    refresh() is Result.Ok

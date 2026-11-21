package com.tray.airoom.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tray.airoom.BuildConfig
import com.tray.airoom.EncryptedPrefs
import com.tray.airoom.NetworkMonitor
import com.tray.airoom.R
import com.tray.airoom.ServerPolicy
import kotlinx.coroutines.launch

/**
 * 로컬 설정 화면. 서버 주소를 검증·저장하고 실제 HTTPS 확인 결과를 사실대로 보여준다.
 * 확인에 실패하면 "저장은 했지만 지금은 확인되지 않는다"고 그대로 말한다(성공으로 꾸미지 않는다).
 */
@Composable
fun SettingsScreen(
    initialUrl: String,
    notificationsEnabled: Boolean,
    notificationsAllowed: Boolean,
    onRequestNotifications: () -> Unit,
    onNotificationsChange: (Boolean) -> Unit,
    onSaved: (String) -> Unit,
    onClearAll: () -> Unit,
    prefs: EncryptedPrefs,
) {
    var urlInput by rememberSaveable { mutableStateOf(initialUrl) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var messageIsError by remember { mutableStateOf(false) }
    var probe by remember { mutableStateOf<NetworkMonitor.Probe?>(null) }
    var confirmClear by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun run(save: Boolean) {
        when (val result = ServerPolicy.normalize(urlInput, allowDevLoopback = BuildConfig.DEBUG)) {
            is ServerPolicy.Result.Rejected -> {
                message = reasonText(result.reason)
                messageIsError = true
            }
            is ServerPolicy.Result.Ok -> {
                if (save) prefs.serverUrl = result.url
                busy = true
                message = null
                scope.launch {
                    val checked = NetworkMonitor.probe(result.url)
                    probe = checked
                    busy = false
                    val reachable = checked.reachability == NetworkMonitor.Reachability.ONLINE ||
                        checked.reachability == NetworkMonitor.Reachability.AUTH_REQUIRED ||
                        checked.reachability == NetworkMonitor.Reachability.SERVER_ERROR
                    if (save) {
                        if (reachable) {
                            onSaved(result.url)
                        } else {
                            message = "주소는 저장했습니다. 다만 지금은 확인되지 않습니다: ${checked.detail}"
                            messageIsError = true
                        }
                    } else {
                        message = if (reachable) checked.detail else "확인 실패: ${checked.detail}"
                        messageIsError = !reachable
                    }
                }
            }
        }
    }

    Scaffold { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column {
                Text(
                    text = stringResource(R.string.app_name),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = stringResource(R.string.app_tagline),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(stringResource(R.string.server_label), style = MaterialTheme.typography.labelLarge)
                    OutlinedTextField(
                        value = urlInput,
                        onValueChange = { urlInput = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        placeholder = { Text(stringResource(R.string.server_hint)) },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Go,
                        ),
                    )
                    Text(
                        text = stringResource(R.string.server_help),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Button(onClick = { run(save = true) }, enabled = !busy) {
                            Text(stringResource(R.string.save_and_connect))
                        }
                        OutlinedButton(onClick = { run(save = false) }, enabled = !busy) {
                            Text(stringResource(R.string.test_without_saving))
                        }
                        if (busy) {
                            Spacer(Modifier.width(4.dp))
                            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        }
                    }
                    val status = probe
                    if (status != null) {
                        Text(
                            text = buildString {
                                append(statusLabel(status.reachability))
                                append(" · ")
                                append(status.detail)
                                status.httpStatus?.let { append(" (HTTP ").append(it).append(')') }
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = statusColor(status.reachability),
                        )
                    }
                    message?.let { text ->
                        Text(
                            text = text,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (messageIsError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(stringResource(R.string.notify_toggle), style = MaterialTheme.typography.labelLarge)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Switch(
                            checked = notificationsEnabled && notificationsAllowed,
                            onCheckedChange = { checked ->
                                if (checked && !notificationsAllowed) {
                                    onRequestNotifications()
                                } else {
                                    onNotificationsChange(checked)
                                }
                            },
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = if (notificationsAllowed) {
                                stringResource(R.string.notification_channel_desc)
                            } else {
                                "알림 권한이 필요합니다(Android 13+)."
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(stringResource(R.string.security_title), style = MaterialTheme.typography.labelLarge)
                    Text(
                        text = stringResource(R.string.security_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = { confirmClear = true }) {
                        Text(stringResource(R.string.clear_session), color = MaterialTheme.colorScheme.error)
                    }
                }
            }

            Text(
                text = "v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) · targetSdk ${BuildConfig.TARGET_SDK}\n" +
                    "API root: ${BuildConfig.API_BASE_PATH}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text(stringResource(R.string.clear_session)) },
            text = { Text(stringResource(R.string.clear_session_confirm)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmClear = false
                        urlInput = ""
                        probe = null
                        message = null
                        onClearAll()
                    },
                ) { Text(stringResource(R.string.clear_session_done)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmClear = false }) { Text(stringResource(R.string.close)) }
            },
        )
    }
}

internal fun reasonText(reason: ServerPolicy.Reason): String = when (reason) {
    ServerPolicy.Reason.EMPTY -> "서버 주소를 입력하세요."
    ServerPolicy.Reason.TOO_LONG -> "주소가 너무 깁니다."
    ServerPolicy.Reason.HTTPS_ONLY -> "https:// 주소만 사용할 수 있습니다."
    ServerPolicy.Reason.USER_INFO -> "주소에 사용자 이름·비밀번호를 넣을 수 없습니다."
    ServerPolicy.Reason.QUERY_OR_FRAGMENT -> "주소에 ?쿼리 또는 #프래그먼트를 넣을 수 없습니다."
    ServerPolicy.Reason.HOST -> "이 주소는 허용되지 않습니다. 공용 HTTPS 주소를 입력하세요."
    ServerPolicy.Reason.FORMAT -> "주소 형식이 올바르지 않습니다."
}

internal fun statusLabel(reachability: NetworkMonitor.Reachability): String = when (reachability) {
    NetworkMonitor.Reachability.UNKNOWN -> "확인 전"
    NetworkMonitor.Reachability.CHECKING -> "확인 중"
    NetworkMonitor.Reachability.ONLINE -> "연결됨"
    NetworkMonitor.Reachability.AUTH_REQUIRED -> "연결됨 · 로그인 필요"
    NetworkMonitor.Reachability.SERVER_ERROR -> "서버 오류"
    NetworkMonitor.Reachability.OFFLINE -> "오프라인"
}

@Composable
internal fun statusColor(reachability: NetworkMonitor.Reachability) = when (reachability) {
    NetworkMonitor.Reachability.ONLINE -> MaterialTheme.colorScheme.primary
    NetworkMonitor.Reachability.AUTH_REQUIRED -> MaterialTheme.colorScheme.secondary
    NetworkMonitor.Reachability.SERVER_ERROR,
    NetworkMonitor.Reachability.OFFLINE,
    -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

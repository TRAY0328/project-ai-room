package com.tray.airoom

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import com.tray.airoom.ui.AiRoomTheme
import com.tray.airoom.ui.SettingsScreen
import com.tray.airoom.ui.WorkspaceScreen

/**
 * 앱 진입점 — 화면은 두 개다.
 *   settings  : 로컬 설정(서버 주소·알림·보안 안내)
 *   workspace : 클라우드 웹 앱(WebView)
 *
 * 네이티브 쪽은 서버 주소 보관과 연결 표시만 한다. AI 키·토큰은 이 앱에 저장하지 않는다.
 */
class MainActivity : ComponentActivity() {

    private lateinit var prefs: EncryptedPrefs
    private lateinit var notifier: Notifier
    private lateinit var networkMonitor: NetworkMonitor

    /** 알림 권한 상태. 런타임 요청 결과를 즉시 화면에 반영하기 위해 컴포지션 밖에서 보관한다. */
    private val notificationsAllowed = mutableStateOf(false)

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            notificationsAllowed.value = granted
            prefs.notificationsEnabled = granted
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        prefs = EncryptedPrefs(this)
        notifier = Notifier(this)
        notifier.ensureChannel()
        notificationsAllowed.value = notifier.hasPermission()
        networkMonitor = NetworkMonitor(this)
        networkMonitor.start()

        setContent {
            AiRoomTheme {
                AiRoomApp(
                    prefs = prefs,
                    networkMonitor = networkMonitor,
                    notifier = notifier,
                    notificationsAllowed = notificationsAllowed.value,
                    onRequestNotifications = { requestNotificationPermission() },
                )
            }
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            notificationsAllowed.value = true
            prefs.notificationsEnabled = true
        }
    }

    override fun onDestroy() {
        networkMonitor.stop()
        super.onDestroy()
    }
}

@Composable
private fun AiRoomApp(
    prefs: EncryptedPrefs,
    networkMonitor: NetworkMonitor,
    notifier: Notifier,
    notificationsAllowed: Boolean,
    onRequestNotifications: () -> Unit,
) {
    var showWorkspace by rememberSaveable { mutableStateOf(prefs.containsServerUrl()) }
    var serverUrl by rememberSaveable { mutableStateOf(prefs.serverUrl.orEmpty()) }
    var notificationsEnabled by rememberSaveable { mutableStateOf(prefs.notificationsEnabled) }

    if (showWorkspace && serverUrl.isNotBlank()) {
        WorkspaceScreen(
            serverUrl = serverUrl,
            networkMonitor = networkMonitor,
            notifier = notifier,
            notificationsEnabled = notificationsEnabled,
            onChangeServer = { showWorkspace = false },
        )
    } else {
        SettingsScreen(
            initialUrl = serverUrl,
            notificationsEnabled = notificationsEnabled,
            notificationsAllowed = notificationsAllowed,
            onRequestNotifications = {
                onRequestNotifications()
            },
            onNotificationsChange = { enabled ->
                notificationsEnabled = enabled
                prefs.notificationsEnabled = enabled
            },
            onSaved = { saved ->
                serverUrl = saved
                prefs.serverUrl = saved
                showWorkspace = true
            },
            onClearAll = {
                prefs.clearAll()
                serverUrl = ""
                notificationsEnabled = false
                showWorkspace = false
            },
            prefs = prefs,
        )
    }
}

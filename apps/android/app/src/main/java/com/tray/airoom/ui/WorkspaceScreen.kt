package com.tray.airoom.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tray.airoom.BuildConfig
import com.tray.airoom.NetworkMonitor
import com.tray.airoom.Notifier
import com.tray.airoom.R
import java.net.URI

/**
 * 클라우드 웹 앱을 여는 화면.
 *
 * WebView 보안 설정: 파일 접근 금지, 혼합 콘텐츠 금지, 자바스크립트 브리지 **없음**,
 * 설정한 호스트 이외의 https 링크는 시스템 브라우저로 넘긴다. 오프라인/서버 오류 시 배너를 띄운다.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(
    serverUrl: String,
    networkMonitor: NetworkMonitor,
    notifier: Notifier,
    notificationsEnabled: Boolean,
    onChangeServer: () -> Unit,
) {
    val context = LocalContext.current
    val online by networkMonitor.online.collectAsStateWithLifecycle()

    val host = remember(serverUrl) {
        runCatching { URI(serverUrl).host.orEmpty().lowercase() }.getOrDefault("")
    }

    var canGoBack by remember { mutableStateOf(false) }
    var probe by remember { mutableStateOf<NetworkMonitor.Probe?>(null) }
    var pageError by remember { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    var lastOnline by remember { mutableStateOf(online) }
    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val holder = remember { WebViewHolder() }

    val fileLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = fileCallback
        fileCallback = null
        if (callback == null) return@rememberLauncherForActivityResult
        if (result.resultCode != Activity.RESULT_OK) {
            callback.onReceiveValue(null)
            return@rememberLauncherForActivityResult
        }
        val data = result.data
        val clip = data?.clipData
        val uris: Array<Uri>? = when {
            data == null -> null
            clip != null -> Array(clip.itemCount) { index -> clip.getItemAt(index).uri }
            data.data != null -> arrayOf(data.data!!)
            else -> null
        }
        callback.onReceiveValue(uris)
    }

    // 오프라인 → 온라인 전환 시 한 번 알린다(권한·설정이 허용된 경우에만).
    LaunchedEffect(online) {
        if (!lastOnline && online) notifier.notifyReconnected(notificationsEnabled)
        lastOnline = online
    }

    // 연결 확인: 네트워크가 돌아오거나 다시 시도를 누르면 재실행된다.
    LaunchedEffect(serverUrl, online, attempt) {
        if (serverUrl.isBlank()) return@LaunchedEffect
        probe = if (!online) {
            NetworkMonitor.Probe(
                reachability = NetworkMonitor.Reachability.OFFLINE,
                detail = "네트워크가 연결되어 있지 않습니다.",
            )
        } else {
            NetworkMonitor.probe(serverUrl)
        }
        if (online && pageError) {
            pageError = false
            holder.view?.reload()
        }
    }

    BackHandler(enabled = canGoBack) {
        holder.view?.goBack()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = host.ifEmpty { "AI ROOM" },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleSmall,
                        )
                        val status = probe
                        Text(
                            text = status?.let { statusLabel(it.reachability) } ?: "확인 전",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    TextButton(onClick = { holder.view?.reload() }) {
                        Text(stringResource(R.string.reload))
                    }
                    TextButton(onClick = onChangeServer) {
                        Text(stringResource(R.string.change_server))
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            if (!online || pageError || probe?.reachability == NetworkMonitor.Reachability.SERVER_ERROR) {
                OfflineBanner(
                    message = if (!online) {
                        stringResource(R.string.offline_banner)
                    } else {
                        stringResource(R.string.server_error_banner)
                    },
                    onRetry = {
                        attempt += 1
                        holder.view?.reload()
                    },
                )
            }

            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    buildWebView(
                        context = ctx,
                        serverUrl = serverUrl,
                        host = host,
                        onWebViewReady = { view -> holder.view = view },
                        onBackAvailable = { available -> canGoBack = available },
                        onPageError = { failed -> pageError = failed },
                        onShowFileChooser = { callback, params ->
                            fileCallback?.onReceiveValue(null)
                            fileCallback = callback
                            val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                                type = "*/*"
                                addCategory(Intent.CATEGORY_OPENABLE)
                            }
                            runCatching { fileLauncher.launch(intent) }.onFailure {
                                fileCallback?.onReceiveValue(null)
                                fileCallback = null
                                Toast.makeText(context, R.string.file_picker_unavailable, Toast.LENGTH_SHORT).show()
                            }
                        },
                        onDownload = { url, contentDisposition, mimeType ->
                            enqueueDownload(context, url, contentDisposition, mimeType)
                        },
                    )
                },
            )
        }
    }
}

@Composable
private fun OfflineBanner(message: String, onRetry: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(end = 8.dp),
        )
        TextButton(onClick = onRetry) {
            Text(stringResource(R.string.retry))
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun buildWebView(
    context: Context,
    serverUrl: String,
    host: String,
    onWebViewReady: (WebView) -> Unit,
    onBackAvailable: (Boolean) -> Unit,
    onPageError: (Boolean) -> Unit,
    onShowFileChooser: (ValueCallback<Array<Uri>>?, WebChromeClient.FileChooserParams?) -> Unit,
    onDownload: (String, String?, String?) -> Unit,
): WebView {
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    return WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        val webViewRef = this

        settings.apply {
            javaScriptEnabled = true // 웹 앱 자체가 SPA이므로 필요. 브리지는 두지 않는다.
            domStorageEnabled = true
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            setGeolocationEnabled(false)
            safeBrowsingEnabled = true
            builtInZoomControls = false
            displayZoomControls = false
            userAgentString = "$userAgentString AiRoomAndroid/${BuildConfig.VERSION_NAME}"
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webViewRef, false)
        }

        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                val targetHost = target.host?.lowercase().orEmpty()
                val sameOrigin = target.scheme == "https" && targetHost == host
                if (sameOrigin) return false

                // 같은 호스트의 서브도메인도 앱 안에서 연다(로그인 리다이렉트 등).
                if (target.scheme == "https" && host.isNotEmpty() && targetHost.endsWith(".$host")) {
                    return false
                }

                val external = Intent(Intent.ACTION_VIEW, target)
                return runCatching {
                    view.context.startActivity(external)
                    true
                }.getOrElse {
                    Toast.makeText(view.context, R.string.external_link_blocked, Toast.LENGTH_SHORT).show()
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                onBackAvailable(view.canGoBack())
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError,
            ) {
                super.onReceivedError(view, request, error)
                if (request.isForMainFrame) onPageError(true)
            }
        }

        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                onShowFileChooser(filePathCallback, fileChooserParams)
                return true
            }
        }

        setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            onDownload(url, contentDisposition, mimeType)
        }

        loadUrl(serverUrl)
        onWebViewReady(this)
    }
}

private fun enqueueDownload(context: Context, url: String, contentDisposition: String?, mimeType: String?) {
    val uri = Uri.parse(url)
    if (uri.scheme != "https") {
        Toast.makeText(context, R.string.download_blocked, Toast.LENGTH_SHORT).show()
        return
    }
    val request = DownloadManager.Request(uri).apply {
        setMimeType(mimeType)
        setTitle(safeFileName(url, contentDisposition))
        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        setAllowedOverMetered(true)
        setAllowedOverRoaming(false)
        runCatching {
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeFileName(url, contentDisposition))
        }
    }
    val manager = context.getSystemService(DownloadManager::class.java)
    val result = runCatching { manager?.enqueue(request) }
    val name = safeFileName(url, contentDisposition)
    if (result.isSuccess && result.getOrNull() != null) {
        Toast.makeText(context, context.getString(R.string.download_queued, name), Toast.LENGTH_SHORT).show()
    } else {
        Toast.makeText(context, R.string.download_blocked, Toast.LENGTH_SHORT).show()
    }
}

internal fun safeFileName(url: String, contentDisposition: String?): String {
    val fromHeader = contentDisposition
        ?.split(';')
        ?.map { it.trim() }
        ?.firstOrNull { it.startsWith("filename*=", ignoreCase = true) || it.startsWith("filename=", ignoreCase = true) }
        ?.substringAfter('=')
        ?.trim('"')
        ?.substringAfterLast("''")
    val fromUrl = runCatching { Uri.parse(url).lastPathSegment }.getOrNull()
    val candidate = (fromHeader ?: fromUrl ?: "ai-room-download").substringAfterLast('/')
    val sanitized = candidate
        .replace(Regex("[^\\p{L}\\p{N}._-]"), "_")
        .trim('_', '.')
        .take(120)
    return sanitized.ifBlank { "ai-room-download" }
}

/** WebView 참조 보관용. 상태(state)로 두면 합성 중 쓰기가 되어 리컴포지션이 반복될 수 있어 일반 홀더를 쓴다. */
private class WebViewHolder {
    var view: WebView? = null
}

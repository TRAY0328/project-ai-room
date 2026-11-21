package com.tray.airoom

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

/**
 * 네트워크 상태 감시 + 서버 연결 확인.
 *
 * 상태 흐름: 기기 네트워크(ConnectivityManager) + 실제 HTTPS 응답(probe)을 함께 본다.
 * 기기 네트워크가 있어도 서버에 닿지 않을 수 있으므로 둘을 구분해서 보여준다.
 */
class NetworkMonitor(context: Context) {

    enum class Reachability { UNKNOWN, CHECKING, ONLINE, AUTH_REQUIRED, SERVER_ERROR, OFFLINE }

    data class Probe(
        val reachability: Reachability,
        val httpStatus: Int? = null,
        val latencyMs: Long? = null,
        val detail: String = "",
        val checkedAt: String = Instant.now().toString(),
    )

    private val connectivityManager =
        context.applicationContext.getSystemService(ConnectivityManager::class.java)

    private val _online = MutableStateFlow(isCurrentlyOnline())
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            _online.value = true
        }

        override fun onLost(network: Network) {
            _online.value = isCurrentlyOnline()
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            _online.value = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }
    }

    fun start() {
        runCatching { connectivityManager?.registerDefaultNetworkCallback(callback) }
    }

    fun stop() {
        runCatching { connectivityManager?.unregisterNetworkCallback(callback) }
    }

    fun isCurrentlyOnline(): Boolean {
        val cm = connectivityManager ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    companion object {
        private const val TIMEOUT_MS = 8_000

        /**
         * `GET {server}/api/v1` — 인증 없음, 리다이렉트 미추적, 8초 제한.
         * 계약 base path이므로 404도 "서버가 응답했다"까지만 인정한다.
         */
        suspend fun probe(serverUrl: String): Probe = withContext(Dispatchers.IO) {
            val started = System.nanoTime()
            var connection: HttpURLConnection? = null
            try {
                val url = URL(ServerPolicy.apiRoot(serverUrl))
                if (url.protocol != "https") {
                    return@withContext Probe(
                        reachability = Reachability.OFFLINE,
                        detail = "https 주소만 확인할 수 있습니다.",
                    )
                }
                connection = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = TIMEOUT_MS
                    readTimeout = TIMEOUT_MS
                    instanceFollowRedirects = false
                    useCaches = false
                    setRequestProperty("Accept", "application/json")
                    setRequestProperty("User-Agent", "AI-ROOM-Android/${BuildConfig.VERSION_NAME}")
                }
                val status = connection.responseCode
                val latency = (System.nanoTime() - started) / 1_000_000
                val reachability = when {
                    status in 500..599 -> Reachability.SERVER_ERROR
                    status == 401 || status == 403 -> Reachability.AUTH_REQUIRED
                    else -> Reachability.ONLINE
                }
                val detail = when (reachability) {
                    Reachability.SERVER_ERROR -> "서버가 오류 상태로 응답했습니다(5xx)."
                    Reachability.AUTH_REQUIRED -> "서버는 응답하며 로그인이 필요합니다."
                    else -> "서버가 응답했습니다(HTTP $status)."
                }
                Probe(reachability = reachability, httpStatus = status, latencyMs = latency, detail = detail)
            } catch (error: Exception) {
                Probe(
                    reachability = Reachability.OFFLINE,
                    latencyMs = (System.nanoTime() - started) / 1_000_000,
                    detail = when (error) {
                        is java.net.SocketTimeoutException -> "${TIMEOUT_MS / 1000}초 안에 응답이 없습니다."
                        is java.net.UnknownHostException -> "호스트를 찾지 못했습니다(DNS)."
                        else -> "서버에 연결하지 못했습니다."
                    },
                )
            } finally {
                connection?.disconnect()
            }
        }
    }
}

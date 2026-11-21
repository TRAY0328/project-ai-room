package com.tray.airoom

import java.net.URI

/**
 * 서버 주소 정책 — 데스크톱(src-tauri/src/url_policy.rs)과 같은 규칙.
 *
 * 클라우드 전용이므로 https만, 사설/loopback/링크로컬/메타데이터 호스트는 거부한다.
 * android.net.Uri 대신 java.net.URI를 쓰는 이유: 이 클래스는 JVM 단위 테스트에서도 그대로 검증한다.
 */
object ServerPolicy {

    const val MAX_URL_LEN = 2048
    const val API_BASE_PATH = "/api/v1"

    private val SCHEME_PREFIX = Regex("^([A-Za-z][A-Za-z0-9+.\\-]*):")

    /** `example.com:8080`처럼 스킴처럼 보이나 실제로는 호스트인 경우를 구분한다. */
    private fun projectIsHostLike(candidate: String): Boolean =
        candidate.contains('.') && candidate !in KNOWN_SCHEMES

    private val KNOWN_SCHEMES = setOf(
        "http", "https", "ws", "wss", "ftp", "javascript", "data", "file", "content",
        "intent", "about", "blob", "vbscript", "chrome", "mailto", "tel", "sms", "market",
    )

    enum class Reason { EMPTY, TOO_LONG, HTTPS_ONLY, USER_INFO, QUERY_OR_FRAGMENT, HOST, FORMAT }

    sealed interface Result {
        data class Ok(val url: String, val host: String) : Result
        data class Rejected(val reason: Reason) : Result
    }

    /**
     * @param allowDevLoopback 디버그 빌드에서만 true. 평문 http는 loopback 개발 주소에 한해 허용한다.
     */
    fun normalize(raw: String, allowDevLoopback: Boolean = false): Result {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return Result.Rejected(Reason.EMPTY)
        if (trimmed.length > MAX_URL_LEN) return Result.Rejected(Reason.TOO_LONG)
        if (trimmed.any { it.isWhitespace() || it.isISOControl() }) return Result.Rejected(Reason.FORMAT)

        val schemeName = SCHEME_PREFIX.find(trimmed)?.groupValues?.get(1)?.lowercase()
        val hasAuthority = trimmed.contains("://")
        val candidate = when {
            schemeName == null -> "https://$trimmed"
            hasAuthority -> trimmed
            schemeName == "http" || schemeName == "https" -> "https://$trimmed"
            // host:port 형태(콜론 뒤가 전부 숫자)는 스킴이 아니라 호스트로 본다.
            trimmed.substringAfter(':').let { it.isNotEmpty() && it.all { c -> c.isDigit() } } && projectIsHostLike(schemeName) ->
                "https://$trimmed"
            // javascript:, data:, file:, intent: 같은 스킴은 주소로 쓰지 않는다.
            else -> return Result.Rejected(Reason.HTTPS_ONLY)
        }

        val uri = try {
            URI(candidate)
        } catch (_: Exception) {
            return Result.Rejected(Reason.FORMAT)
        }

        if (!uri.userInfo.isNullOrEmpty()) return Result.Rejected(Reason.USER_INFO)
        if (uri.rawQuery != null || uri.rawFragment != null) return Result.Rejected(Reason.QUERY_OR_FRAGMENT)

        val scheme = uri.scheme?.lowercase() ?: return Result.Rejected(Reason.FORMAT)
        // 스킴을 먼저 판정한다. `file:///...`처럼 호스트가 없는 스킴은 HOST가 아니라 HTTPS_ONLY로 거부해야 한다.
        if (scheme != "https" && scheme != "http") return Result.Rejected(Reason.HTTPS_ONLY)
        val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return Result.Rejected(Reason.HOST)

        when (scheme) {
            "https" -> if (isBlockedHost(host)) return Result.Rejected(Reason.HOST)
            "http" -> if (!allowDevLoopback || !isLoopbackHost(host)) {
                return Result.Rejected(Reason.HTTPS_ONLY)
            }
            else -> return Result.Rejected(Reason.HTTPS_ONLY)
        }

        val path = uri.path?.trimEnd('/').orEmpty()
        val normalized = buildString {
            append(scheme).append("://").append(host)
            if (uri.port != -1) append(':').append(uri.port)
            append(path.ifEmpty { "" })
        }
        return Result.Ok(url = normalized, host = host)
    }

    /** 연결 확인·API 호출에 쓰는 계약 루트. */
    fun apiRoot(serverUrl: String): String = serverUrl.trimEnd('/') + API_BASE_PATH

    fun isLoopbackHost(host: String): Boolean {
        val h = host.trim('[', ']')
        return h == "localhost" || h == "::1" || h.startsWith("127.") || h.endsWith(".localhost") ||
            // 에뮬레이터가 호스트 머신을 가리키는 주소(디버그 전용 허용 목록)
            h == "10.0.2.2" || h == "10.0.3.2"
    }

    fun isBlockedHost(host: String): Boolean {
        val h = host.trimEnd('.').trim('[', ']')
        if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
            h.endsWith(".internal") || h.endsWith(".localdomain") || h == "metadata"
        ) {
            return true
        }
        val parts = h.split('.')
        if (parts.size == 4 && parts.all { it.isNotEmpty() && it.length <= 3 && it.all(Char::isDigit) }) {
            val octets = parts.mapNotNull { it.toIntOrNull()?.takeIf { n -> n in 0..255 } }
            if (octets.size == 4) {
                val (a, b) = octets
                return a == 127 || a == 10 || a == 0 || // loopback, 사설, 미지정
                    (a == 192 && b == 168) ||
                    (a == 172 && b in 16..31) ||
                    (a == 169 && b == 254) || // 링크로컬(클라우드 메타데이터 포함)
                    (a == 100 && b in 64..127) // CGNAT
            }
        }
        return false
    }
}

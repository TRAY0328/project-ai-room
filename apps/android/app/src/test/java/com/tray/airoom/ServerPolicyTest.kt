package com.tray.airoom

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 서버 주소 정책 단위 테스트(JVM, 기기 불필요).
 * 데스크톱(src-tauri/src/url_policy.rs)의 테스트와 같은 규칙을 확인한다.
 */
class ServerPolicyTest {

    private fun ok(raw: String, allowDevLoopback: Boolean = false) =
        ServerPolicy.normalize(raw, allowDevLoopback) as ServerPolicy.Result.Ok

    private fun rejected(raw: String, allowDevLoopback: Boolean = false) =
        ServerPolicy.normalize(raw, allowDevLoopback) as ServerPolicy.Result.Rejected

    @Test
    fun acceptsWorkersHttpsUrl() {
        val result = ok("https://ai-room.example.workers.dev")
        assertEquals("https://ai-room.example.workers.dev", result.url)
        assertEquals("ai-room.example.workers.dev", result.host)
    }

    @Test
    fun addsHttpsWhenSchemeMissing() {
        assertEquals("https://ai-room.example.workers.dev", ok("ai-room.example.workers.dev").url)
    }

    @Test
    fun stripsTrailingSlashAndKeepsPath() {
        assertEquals("https://example.com/room", ok("https://example.com/room/").url)
    }

    @Test
    fun rejectsNonHttpsSchemes() {
        assertEquals(ServerPolicy.Reason.HTTPS_ONLY, rejected("javascript:alert(1)").reason)
        assertEquals(ServerPolicy.Reason.HTTPS_ONLY, rejected("file:///data/local/tmp/x").reason)
        assertEquals(ServerPolicy.Reason.HTTPS_ONLY, rejected("http://ai-room.example.workers.dev").reason)
    }

    @Test
    fun allowsCleartextLoopbackOnlyWhenDevPolicyPermits() {
        assertEquals(ServerPolicy.Reason.HTTPS_ONLY, rejected("http://10.0.2.2:8787").reason)
        assertTrue(ServerPolicy.normalize("http://10.0.2.2:8787", allowDevLoopback = true) is ServerPolicy.Result.Ok)
        assertEquals(
            ServerPolicy.Reason.HTTPS_ONLY,
            rejected("http://example.com", allowDevLoopback = true).reason,
        )
    }

    @Test
    fun rejectsUserInfo() {
        assertEquals(
            ServerPolicy.Reason.USER_INFO,
            rejected("https://user:pass@example.com").reason,
        )
    }

    @Test
    fun rejectsQueryAndFragment() {
        assertEquals(
            ServerPolicy.Reason.QUERY_OR_FRAGMENT,
            rejected("https://example.com/?token=abc").reason,
        )
        assertEquals(
            ServerPolicy.Reason.QUERY_OR_FRAGMENT,
            rejected("https://example.com/#frag").reason,
        )
    }

    @Test
    fun rejectsPrivateAndMetadataHosts() {
        val blocked = listOf(
            "https://127.0.0.1",
            "https://10.0.0.5",
            "https://192.168.0.10",
            "https://172.20.1.1",
            "https://169.254.169.254",
            "https://printer.local",
            "https://build.internal",
            "https://localhost",
        )
        for (raw in blocked) {
            assertEquals("$raw should be rejected", ServerPolicy.Reason.HOST, rejected(raw).reason)
        }
    }

    @Test
    fun allowsPublicIpLiteral() {
        assertTrue(ServerPolicy.normalize("https://203.0.113.10") is ServerPolicy.Result.Ok)
    }

    @Test
    fun rejectsEmptyAndMalformed() {
        assertEquals(ServerPolicy.Reason.EMPTY, rejected("   ").reason)
        assertEquals(ServerPolicy.Reason.FORMAT, rejected("https://exa mple.com").reason)
    }

    @Test
    fun apiRootAppendsContractPath() {
        assertEquals(
            "https://ai-room.example.workers.dev/api/v1",
            ServerPolicy.apiRoot("https://ai-room.example.workers.dev"),
        )
        assertEquals(
            "https://example.com/room/api/v1",
            ServerPolicy.apiRoot("https://example.com/room/"),
        )
    }

    @Test
    fun loopbackDetectionMatchesPolicyUse() {
        assertTrue(ServerPolicy.isLoopbackHost("10.0.2.2"))
        assertTrue(ServerPolicy.isLoopbackHost("127.0.0.1"))
        assertTrue(ServerPolicy.isLoopbackHost("localhost"))
        assertFalse(ServerPolicy.isLoopbackHost("ai-room.example.workers.dev"))
        assertFalse(ServerPolicy.isBlockedHost("ai-room.example.workers.dev"))
    }

    @Test
    fun safeFileNameStripsDangerousCharacters() {
        assertEquals(
            "보고서_2026_.pdf",
            com.tray.airoom.ui.safeFileName(
                "https://example.com/download",
                "attachment; filename=\"보고서 2026?.pdf\"",
            ),
        )
    }
}

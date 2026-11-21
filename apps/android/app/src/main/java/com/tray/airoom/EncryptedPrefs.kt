package com.tray.airoom

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * 기기 저장소. Android Keystore의 AES-256-GCM 키로 값을 암호화해 SharedPreferences에 보관한다.
 *
 * 왜 EncryptedSharedPreferences가 아니라 직접 구현인가:
 *  - androidx.security:security-crypto 1.0.0은 폐기 예정이고, 1.1.x는 알파다.
 *  - 여기서 필요한 것은 문자열 몇 개를 AES-GCM으로 감싸는 일뿐이라 직접 구현이 더 투명하고
 *    이벤트(키 무효화·복호화 실패)를 사용자에게 정확히 알릴 수 있다.
 *
 * 저장하는 값은 **비밀이 아닌** 설정이다(AI 제공자 키·토큰은 저장하지 않는다).
 * 암호화하는 이유는 기기 분실·백업 시 서버 주소·세션 상태가 그대로 노출되지 않게 하기 위해서다.
 */
class EncryptedPrefs(context: Context) {

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = get(KEY_SERVER_URL)
        set(value) {
            if (value.isNullOrBlank()) remove(KEY_SERVER_URL) else put(KEY_SERVER_URL, value)
        }

    var notificationsEnabled: Boolean
        get() = get(KEY_NOTIFICATIONS) == "true"
        set(value) = put(KEY_NOTIFICATIONS, if (value) "true" else "false")

    var openWorkspaceOnStart: Boolean
        get() = get(KEY_OPEN_ON_START) != "false"
        set(value) = put(KEY_OPEN_ON_START, if (value) "true" else "false")

    fun containsServerUrl(): Boolean = !serverUrl.isNullOrBlank()

    fun clearServerConfig() {
        remove(KEY_SERVER_URL)
    }

    /** 기기에 남은 암호문 전부 삭제. Keystore 키는 남겨 두어 다음 저장이 새 키 생성을 기다리지 않게 한다. */
    fun clearAll() {
        prefs.edit().clear().apply()
    }

    private fun put(name: String, value: String) {
        runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val iv = cipher.iv
            val cipherText = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val blob = ByteBuffer.allocate(1 + iv.size + cipherText.size)
                .put(iv.size.toByte())
                .put(iv)
                .put(cipherText)
                .array()
            prefs.edit()
                .putString(name, Base64.encodeToString(blob, Base64.NO_WRAP))
                .apply()
        }.onFailure {
            // 저장 실패를 조용히 삼키면 "저장됨"으로 보인다. 호출부가 알 수 있게 남긴다.
            lastError = it
        }
    }

    private fun get(name: String): String? {
        val encoded = prefs.getString(name, null) ?: return null
        return runCatching {
            val blob = Base64.decode(encoded, Base64.NO_WRAP)
            if (blob.size < 2) return null
            val ivSize = blob[0].toInt() and 0xff
            if (ivSize < 1 || blob.size <= 1 + ivSize) return null
            val iv = blob.copyOfRange(1, 1 + ivSize)
            val cipherText = blob.copyOfRange(1 + ivSize, blob.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), javax.crypto.spec.GCMParameterSpec(128, iv))
            String(cipher.doFinal(cipherText), Charsets.UTF_8)
        }.getOrElse {
            // 키가 무효화되었거나(잠금화면 변경·복원) 데이터가 손상된 경우: 항목만 지운다.
            prefs.edit().remove(name).apply()
            lastError = it
            null
        }
    }

    private fun remove(name: String) {
        prefs.edit().remove(name).apply()
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    companion object {
        private const val PREFS_FILE = "ai_room_secure"
        private const val KEY_ALIAS = "ai_room_device_key_v1"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"

        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_NOTIFICATIONS = "notifications_enabled"
        private const val KEY_OPEN_ON_START = "open_workspace_on_start"

        /** 마지막 저장·복호화 실패. 진단 화면에서만 보여준다. */
        @Volatile
        var lastError: Throwable? = null
            private set
    }
}

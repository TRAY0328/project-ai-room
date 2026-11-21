package com.tray.airoom

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * 앱이 실제로 보내는 알림은 하나다: 작업 공간이 오프라인이었다가 복구되었을 때.
 * 알림 권한이 없거나 사용자가 끄면 아무 것도 보내지 않는다(권한을 우회하지 않는다).
 */
class Notifier(private val context: Context) {

    fun ensureChannel(): Boolean = runCatching {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return true
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.notification_channel_desc)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
        true
    }.getOrDefault(false)

    fun hasPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun notifyReconnected(enabled: Boolean) {
        if (!enabled || !hasPermission()) return
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_ai_room)
            .setContentTitle(context.getString(R.string.notification_reconnected_title))
            .setContentText(context.getString(R.string.notification_reconnected_body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        runCatching {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val CHANNEL_ID = "ai_room_connection"
        private const val NOTIFICATION_ID = 1001
    }
}

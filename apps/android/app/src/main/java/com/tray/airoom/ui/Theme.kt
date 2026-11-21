package com.tray.airoom.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF0F9B8E),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFCFF3ED),
    onPrimaryContainer = Color(0xFF06302B),
    secondary = Color(0xFF3E6F82),
    background = Color(0xFFF6F7F9),
    onBackground = Color(0xFF12161D),
    surface = Color.White,
    onSurface = Color(0xFF12161D),
    surfaceVariant = Color(0xFFF1F3F6),
    onSurfaceVariant = Color(0xFF5B6573),
    outline = Color(0xFFE3E7ED),
    error = Color(0xFFC0392B),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF3DDBC6),
    onPrimary = Color(0xFF06231F),
    primaryContainer = Color(0xFF123833),
    onPrimaryContainer = Color(0xFFB8F5EC),
    secondary = Color(0xFF8FB8C8),
    background = Color(0xFF0B1220),
    onBackground = Color(0xFFE6EBF3),
    surface = Color(0xFF111A2A),
    onSurface = Color(0xFFE6EBF3),
    surfaceVariant = Color(0xFF16223A),
    onSurfaceVariant = Color(0xFF9AA8BD),
    outline = Color(0xFF223047),
    error = Color(0xFFF2756A),
)

@Composable
fun AiRoomTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography(),
        content = content,
    )
}

# Compose + WebView. R8 기본 규칙으로 충분하지만, WebView의 JS 콜백을 위해 남겨 둔다.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Compose 런타임
-keep class androidx.compose.runtime.** { *; }
-dontwarn org.jetbrains.annotations.**

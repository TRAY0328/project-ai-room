// AGP 8.6.0 ↔ Gradle 8.7 ↔ Kotlin 2.0.21 조합. 세 값은 서로 맞물려 있으니 따로 올리지 않는다.
plugins {
    id("com.android.application") version "8.6.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}

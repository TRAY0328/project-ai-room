plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

/**
 * 릴리스 서명은 환경변수로만 받는다(저장소에 키를 두지 않는다).
 * 네 값이 모두 준비되지 않으면 release 빌드는 서명 없이 나가고, CI는 그 경우
 * assembleRelease를 실행하지 않는다(.github/workflows/build-android.yml).
 */
val releaseKeystorePath = System.getenv("AIROOM_ANDROID_KEYSTORE_PATH")
val releaseKeystorePassword = System.getenv("AIROOM_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("AIROOM_ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("AIROOM_ANDROID_KEY_PASSWORD")
val keystoreFile = releaseKeystorePath?.let { file(it) }
val hasReleaseSigning = keystoreFile != null &&
    keystoreFile.exists() &&
    !releaseKeystorePassword.isNullOrBlank() &&
    !releaseKeyAlias.isNullOrBlank() &&
    !releaseKeyPassword.isNullOrBlank()

android {
    namespace = "com.tray.airoom"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.tray.airoom"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        resourceConfigurations += listOf("ko", "en")

        // 화면에 보이는 계약 정보는 빌드 설정에서 온다(문자열을 코드에 중복 기재하지 않는다).
        buildConfigField("int", "TARGET_SDK", "35")
        buildConfigField("String", "API_BASE_PATH", "\"/api/v1\"")
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = keystoreFile
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            // 시험용 APK임을 패키지 이름으로 구분한다(정식 배포 APK와 동시 설치 가능).
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isMinifyEnabled = false
            isDebuggable = true
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.03"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
}

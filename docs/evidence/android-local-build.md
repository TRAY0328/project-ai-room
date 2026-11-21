# Android 로컬 빌드 산출물 (실측)

로컬 워크스페이스에서 Gradle로 만든 APK다. CI(`build-android.yml`) 실행 결과가 붙기 전까지의
증거이며, 실기기 설치 시험은 하지 않았다.

- 빌드 시각: 2026-11-21 13:40~13:44 KST (파일 mtime)
- 빌드 명령: `./gradlew testDebugUnitTest assembleDebug` 및 `assembleRelease` (apps/android)
- JDK/Gradle: 이 워크스페이스의 Gradle 래퍼(8.7)·JDK 17

| 파일 | applicationId | versionName | 크기(bytes) | SHA-256 |
|---|---|---|---|---|
| `app-debug.apk` | `com.tray.airoom.debug` | `0.1.0-debug` | 9,146,029 | `f20b2681323420cae3ebfd1ef2fc4ea7f26fd494f9f365c97a6dfdaa11cc9d11` |
| `app-release-unsigned.apk` | `com.tray.airoom` | `0.1.0` | 1,197,616 | `0f6a82638bcd2fe4a4d3c755cee363c9252f418898d4f54035284934471b1cdf` |

- 위치: `apps/android/app/build/outputs/apk/{debug,release}/` (빌드 산출물이라 `.gitignore` 대상, 리포지토리에 커밋하지 않는다)
- `app-release-unsigned.apk`는 **서명되지 않았다.** 서명 키는 CI에서 시크릿으로만 주입하며, 이 워크스페이스에는 서명 키가 없다.
- 실기기(Galaxy S23 Ultra) 설치·실행 시험: **미실시**. 따라서 G-07은 PARTIAL이다.

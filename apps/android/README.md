# apps/android — Android 클라이언트 (Kotlin + Jetpack Compose + WebView)

PROJECT AI ROOM의 Android 클라이언트. 클라우드 전용이며, 네이티브 쪽은 **서버 주소 보관·연결 표시·
웹 화면 호스팅**만 한다. AI 제공자 키·Cloudflare 토큰은 이 앱에 넣지 않는다(명세 18.3).

## 구성

```
apps/android/
  settings.gradle.kts / build.gradle.kts / gradle.properties   AGP 8.6.0 · Kotlin 2.0.21 · Gradle 8.7
  gradle/wrapper/                                              gradlew (CI는 ./gradlew 사용)
  app/build.gradle.kts                                         compileSdk 35 · minSdk 26 · targetSdk 35
  app/src/main/AndroidManifest.xml                             권한·네트워크 보안·백업 제외
  app/src/main/java/com/tray/airoom/
    MainActivity.kt     진입점, 알림 권한 요청, 화면 전환
    EncryptedPrefs.kt   Android Keystore(AES-256-GCM)로 암호화한 SharedPreferences
    NetworkMonitor.kt   ConnectivityManager 감시 + `GET {서버}/api/v1` 확인(8초 제한)
    Notifier.kt         알림 채널 + 연결 복구 알림(권한·설정이 허용될 때만)
    ServerPolicy.kt     서버 URL 정책(https 강제, 사설/loopback/메타데이터 차단)
    ui/Theme.kt         라이트/다크 색 체계
    ui/SettingsScreen.kt 로컬 설정 화면
    ui/WorkspaceScreen.kt WebView 화면 + 오프라인 배너 + 파일 선택/다운로드
  app/src/test/java/com/tray/airoom/ServerPolicyTest.kt         JVM 단위 테스트 13개
  app/src/debug/res/xml/network_security_config.xml             디버그만 로컬 평문 허용
```

## 동작

| 항목 | 구현 |
|---|---|
| 서버 주소 | `ServerPolicy`가 https만 허용, 자격 증명·쿼리·프래그먼트 금지, 사설·링크로컬(169.254.x)·메타데이터 호스트 차단 |
| 저장 | Android Keystore AES-256-GCM(IV 12바이트, GCM 태그 128비트). 복호화 실패 시 해당 항목만 삭제하고 오류를 남긴다 |
| 연결 확인 | `GET {서버}/api/v1` — 응답 코드로 online / auth_required / server_error / offline 구분. 404도 "응답함"까지만 인정 |
| 오프라인 배너 | 네트워크 끊김·페이지 로드 실패·5xx에서 표시. 네트워크가 돌아오면 자동 재로드 + "다시 시도" |
| 알림 | Android 13+ `POST_NOTIFICATIONS` 런타임 요청. 실제 알림은 **연결 복구 1종**만(사용자 토글이 켜져 있을 때) |
| 파일 업로드 | `WebChromeClient.onShowFileChooser` → SAF 선택기(`ACTION_GET_CONTENT`, 결과 없으면 콜백 null) |
| 파일 다운로드 | `DownloadListener` → DownloadManager. **https만**, 파일명은 헤더/URL에서 안전 문자만 남김 |
| 인증 | 쿠키는 WebView 쿠키 저장소에만 존재. 앱이 값을 읽지 않고, `acceptThirdPartyCookies=false` |
| 로그아웃 | 설정 화면의 "이 기기 데이터 지우기" → SharedPreferences 삭제. WebView 쿠키 삭제는 화면의 웹 로그아웃이 담당 |

### WebView 하드닝

- `javaScriptEnabled=true`(SPA 필수)이지만 **`addJavascriptInterface` 없음** — 네이티브 브리지 자체를 두지 않는다.
- `allowFileAccess=false`, `allowContentAccess=false`, `allowFileAccessFromFileURLs=false`, `allowUniversalAccessFromFileURLs=false`.
- `mixedContentMode = MIXED_CONTENT_NEVER_ALLOW`, `usesCleartextTraffic=false`, `network_security_config`에서 평문 차단.
- 이동 제한: 설정한 호스트(+그 서브도메인)의 https만 WebView 안에서 열고, 그 밖의 링크는 시스템 브라우저로 위임.
- `setSupportMultipleWindows(false)`, `javaScriptCanOpenWindowsAutomatically=false`, `safeBrowsingEnabled=true`.
- 백업·기기이전에서 앱 데이터 제외(`allowBackup=false` + `data_extraction_rules.xml`).

## 빌드

```bash
cd apps/android
./gradlew assembleDebug            # 시험용 APK (applicationIdSuffix=.debug)
./gradlew assembleRelease          # 서명 키가 없으면 unsigned 로 나온다
./gradlew testDebugUnitTest        # JVM 단위 테스트 13개
```

릴리스 서명은 **환경변수로만** 주입한다(저장소·gradle.properties에 키를 두지 않는다):

| 환경변수 | 값 |
|---|---|
| `AIROOM_ANDROID_KEYSTORE_PATH` | keystore 파일 경로 |
| `AIROOM_ANDROID_KEYSTORE_PASSWORD` | keystore 비밀번호 |
| `AIROOM_ANDROID_KEY_ALIAS` | 키 별칭 |
| `AIROOM_ANDROID_KEY_PASSWORD` | 키 비밀번호 |

네 값이 모두 없으면 `assembleRelease`는 서명 없이 끝나고, CI(`build-android.yml`)는 그 경우
`assembleDebug`만 산출물로 올린다. 서명된 APK와 시험용 APK는 패키지 이름(`com.tray.airoom` vs
`com.tray.airoom.debug`)으로 구분된다.

## 검증 상태 (사실만)

이 작업 환경에서 **실제로 빌드했다**. 결과:

| 항목 | 결과 | 증거 |
|---|---|---|
| `assembleDebug` (clean build) | **PASS** | `app/build/outputs/apk/debug/app-debug.apk`, 9,146,029 B, SHA-256 `f20b2681323420cae3ebfd1ef2fc4ea7f26fd494f9f365c97a6dfdaa11cc9d11` |
| `assembleRelease` (R8 축소·리소스 축소) | **PASS** (unsigned) | `app/build/outputs/apk/release/app-release-unsigned.apk`, 1,197,616 B, SHA-256 `0f6a82638bcd2fe4a4d3c755cee363c9252f418898d4f54035284934471b1cdf` |
| `testDebugUnitTest` | **PASS 13/13** | `app/build/test-results/testDebugUnitTest/*.xml` (testcase 13건, 실패 0) |
| APK 메타데이터 | 확인 | debug: `com.tray.airoom.debug` 0.1.0-debug / release: `com.tray.airoom` 0.1.0 · minSdk 26 · targetSdk 35 |
| 권한 목록 | 확인 | INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, WRITE_EXTERNAL_STORAGE(maxSdk 28) |
| 실기기 설치·로그인·채팅·파일·알림 | **NOT_RUN** | 연결 가능한 기기/에뮬레이터 없음 |
| 서명된 릴리스 APK | **NOT_RUN** | 서명 키 없음 |

빌드는 이 환경의 JDK 17 + Android SDK(platform 35, build-tools 35.0.0) + Gradle 8.7로 했다.
메모리가 4GB뿐이라 `--no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx1400m`로 실행했다
(CI 표준 러너는 기본 설정으로 충분하다).

APK 바이트는 빌드마다 같지 않다(서명 블록·빌드 시각이 들어간다). 위 SHA-256은 그 빌드의 산출물을
가리키는 값이고, CI는 각 실행에서 자기 산출물의 SHA-256을 만들어 아티팩트에 넣는다.
같은 커밋을 다시 빌드했을 때 해시가 다르다고 해서 변조로 단정하지 말 것 — 대신 이전/이후 해시를 함께 남긴다.

## 아직 없는 것 (격차)

| 항목 | 상태 | 이유 |
|---|---|---|
| 딥링크/앱 링크 | **미구현** | 배포된 웹 도메인·검증 파일이 없어 실제 검증 불가 |
| 푸시(FCM) | **미구현** | FCM 프로젝트·서버 키가 없다. 알림은 로컬 연결 복구 1종 |
| 인증 다운로드 | **부분** | DownloadManager는 WebView 쿠키를 넘기지 못한다. 로그인 필요한 파일은 웹 화면의 자체 다운로드 흐름을 써야 한다 |
| Play 스토어 배포 | **없음** | 서명 키·스토어 계정·정책 검토 없음(사용자 승인 필요) |

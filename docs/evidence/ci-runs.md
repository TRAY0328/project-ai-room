# GitHub Actions 실행 기록 (실측)

- 저장소: `https://github.com/TRAY0328/project-ai-room` (PUBLIC)
- 기록 시각: 2026-11-21T05:50Z (KST 14:50)
- 기준 커밋: `cf00dd884e39095986655b392f156db9075d2d89` (`cf00dd8`)
- 아티팩트는 `gh run download <run-id>`로 내려받아 `SHA256SUMS.txt`·`build-info.json`과 함께 대조했다.

## 최종 5개 워크플로 (커밋 cf00dd8)

| 워크플로 | Run ID | 결과 | 링크 |
|---|---|---|---|
| verify | `44871990981` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44871990981 |
| build-web | `44871990894` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44871990894 |
| build-android | `44871990867` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44871990867 |
| build-windows | `44871990877` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44871990877 |
| security | `44871990908` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44871990908 |

## 아티팩트와 SHA-256

### Windows x64 — run `44871990877` (`windows-x64-cf00dd8…`)

| 파일 | 크기(bytes) | SHA-256 |
|---|---|---|
| `AI ROOM.exe` | 4,820,992 | `d76a019bb603f9deb4cfbcf63d88bb31bc7db2fa6608e787124dcf27aefe89a0` |
| `AI ROOM_0.1.0_x64-setup.exe` (NSIS) | 1,873,186 | `de3fbaa8411db40c5e9168c1a180140c636fb8892b6292a3077bb0bcf507cff5` |
| `AI ROOM_0.1.0_x64_en-US.msi` | 2,510,848 | `416c4f8bee11e570ec173213ef0378d9aeaae62debd81d4df15df43f50919ff9` |
| `SHA256SUMS.txt` | 269 | `4e6a376f2e0953205be2dc03aa3fdb897e5fd3446650bf2c9654d7b437e4eb81` |

- `build-info.json`: `built_at 2026-11-21T05:47:38Z`, `signing: unsigned — 코드 서명 인증서 없음(SmartScreen 경고 발생)`, `verification_status: BUILT_UNVERIFIED`
- Windows 11 x64 러너(windows-latest), rustc 1.100.0, Tauri 2.12.7 · `cargo fmt --check`·`cargo test` 통과 후 EXE+NSIS+MSI 빌드

### Android — run `44871990867` (`android-cf00dd8…`)

| 파일 | 크기(bytes) | SHA-256 |
|---|---|---|
| `app-debug.apk` | 9,146,029 | `ce281f78d7a40e967e98ea4735be3758a5d62c8f7430920e090e65236077d0d8` |

- `build-info.json`: JDK `17.0.21`, `release_signed: false`(서명 시크릿 없음 → debug APK만), `BUILT_UNVERIFIED`
- **release APK는 생성되지 않았다.** 서명 키 시크릿(`AIROOM_ANDROID_KEYSTORE_*`)이 없기 때문이며, 워크플로가 그 사실을 출력하고 넘어가도록 되어 있다.

### Web — run `44871990894` (`web-dist-cf00dd8…`)

- `dist/` 12개 파일, 4.5MB
- `index.html` `c11a67b23fea5abd8b5dcf6fedcf4fac9ac2f354bd1e9fbf31a17850aa65e536`
- `ai-portal.txt` = `llms.txt` `593f41ea22cfe294b9c55a9ffe55151353b8da47302fc41a8b5609feb926ae66`
- 로컬 빌드 해시와 **동일**하다(빌드 결정성 확인). `verification_status: BUILT_UNVERIFIED`, `signing: none`

## 실행 중 고친 실패 (원인 → 조치)

| 회차 | 실패 워크플로 | 원인 | 조치 |
|---|---|---|---|
| `b9f26ad` | verify | `../work/ai_room_pack/...`(로컬 작업팩) 경로 ENOENT | 스펙 카탈로그를 `spec/`에 벤더링 + 경로 해석 6곳 수정(`455ce39`) |
| `b9f26ad` | security | 테스트 픽스처의 가짜 키 51건을 gitleaks가 탐지 | `.gitleaks.toml`(경로 허용목록, 기본 규칙 유지) 추가 |
| `73c4da5` | security | `npm sbom` 실행 전 `npm ci` 없음(ESBOMPROBLEMS) | 워크플로에 `npm ci` 추가(사용자가 GitHub 웹에서 커밋 `a613a30`) |
| `a613a30` | build-windows | rustc 1.100.0 E0597: `read_load_note`의 MutexGuard 임시값이 `State`보다 오래 삶 | 가드를 지역 변수로 바인딩(`0d7fcd8`) |
| `0d7fcd8` | build-windows | 카고 산출물이 `ai-room-desktop.exe`인데 아티팩트 단계는 `AI ROOM.exe`를 찾음 | `tauri.conf.json`의 `mainBinaryName: "AI ROOM"` 설정(`cf00dd8`) — 카고 타깃 이름에는 공백을 쓸 수 없어 `[[bin]]` 방식은 실패했다 |
| `0d7fcd8` | build-android | Maven 저장소 POM 일시 오류(`Could not find kotlin-gradle-plugin:2.0.21`) | 다음 실행(`f1510d8`)에서 동일 코드로 통과 — 환경 플레이크로 판단 |

## 남은 것

- Windows 설치·실행 시험: **미실시** (러너에서 빌드만 확인). 실제 Windows 11 기기에 설치해 실행하는 시험은 별도다.
- Android 실기기 설치: **미실시**.
- 서명: Windows 코드 서명 인증서 없음, Android release 키 없음 → 두 산출물 모두 미서명.

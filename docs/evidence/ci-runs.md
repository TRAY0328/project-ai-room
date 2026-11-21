# GitHub Actions 실행 기록 (실측)

- 저장소: `https://github.com/TRAY0328/project-ai-room` (PUBLIC)
- 기록 시각: 2026-11-21T06:00Z (KST 15:00)
- **최종 HEAD**: `fc922169d7711cbeb38303d3dc48db63a605043c` (`fc92216`) — 5개 워크플로 전부 success
- 아티팩트는 `gh run download <run-id>`로 내려받아 `SHA256SUMS.txt`·`build-info.json`과 대조했다.

> 재현성 주의: **웹 빌드는 결정적**(같은 소스 → 같은 해시)이지만, **Windows·Android 산출물은 빌드 시각이 바이너리에 박혀** 다시 빌드하면 바이트가 달라진다. 그래서 아래 표는 **실행(run ID) 단위로** 해시를 기록한다. 진본은 그 실행의 `SHA256SUMS.txt` 아티팩트다.

## 최종 실행 (커밋 fc92216)

| 워크플로 | Run ID | 결과 | 링크 |
|---|---|---|---|
| verify | `44872798593` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44872798593 |
| build-web | `44872798632` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44872798632 |
| build-android | `44872798638` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44872798638 |
| build-windows | `44872798579` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44872798579 |
| security | `44872798661` | ✅ success | https://github.com/TRAY0328/project-ai-room/actions/runs/44872798661 |

| 산출물 | 크기(bytes) | SHA-256 |
|---|---|---|
| `AI ROOM.exe` | 4,820,992 | `7e600b0d732790f8a2dccc3b7fdd16ab93eb53d15467678782bd08d0b695a58e` |
| `AI ROOM_0.1.0_x64-setup.exe` (NSIS) | 1,873,114 | `261958dea0c0c1c27597843f4e575899616ecc042f6d83dc7344b11d92aaf0f8` |
| `AI ROOM_0.1.0_x64_en-US.msi` | 2,510,848 | `0eae82422b320745520b3e09b76a579af7b9059f2168a39c42e532222bb23343` |
| `app-debug.apk` | 9,146,029 | `d254707b1400ab50f21cdfa6af3beff8c9d5bed2f4216401d67710995b60de0f` |
| `dist/index.html` | – | `c11a67b23fea5abd8b5dcf6fedcf4fac9ac2f354bd1e9fbf31a17850aa65e536` |
| `dist/ai-portal.txt` = `dist/llms.txt` | – | `593f41ea22cfe294b9c55a9ffe55151353b8da47302fc41a8b5609feb926ae66` |

- `build-info.json`(windows): `built_at 2026-11-21T05:55:08Z`, `signing: unsigned`, `BUILT_UNVERIFIED`
- `build-info.json`(android): JDK 17.0.21, `release_signed: false`, `BUILT_UNVERIFIED`
- `build-info.json`(web): `built_at 2026-11-21T05:51:50Z`, `signing: none`, 12개 파일 4.5MB

## 첫 Green 실행 (커밋 cf00dd8) — 참고

| 워크플로 | Run ID | 결과 |
|---|---|---|
| verify | `44871990981` | ✅ success |
| build-web | `44871990894` | ✅ success |
| build-android | `44871990867` | ✅ success |
| build-windows | `44871990877` | ✅ success |
| security | `44871990908` | ✅ success |

이 실행의 해시는 `AI ROOM.exe d76a019b…efe89a0` · NSIS `de3fbaa8…507cff5` · MSI `416c4f8b…50919ff9` · `app-debug.apk ce281f78…6077d0d8`. 위 재현성 주의대로 바이트가 위 최종 실행과 다르다(소스 동일).

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

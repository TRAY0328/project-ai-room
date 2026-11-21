# apps/desktop — Windows 11 x64 클라이언트 (Tauri v2)

PROJECT AI ROOM의 Windows 클라이언트. **클라우드 전용 셸**이다 — 화면은 Cloudflare Workers의
웹 앱을 HTTPS로 불러오고, 로컬에서 임의 명령·빌드·에이전트를 실행하는 기능은 없다(명세 01장·18.2장).

## 구조

```
apps/desktop/
  package.json                 @tauri-apps/cli 고정 버전(2.12.6) + lockfile
  scripts/make-icons.mjs       아이콘 생성(의존성 없음, 재현 가능)
  ui/                          로컬 셸 화면(설정·상태). 번들러 없음, CSP 'self'만
  src-tauri/
    Cargo.toml                 tauri 2.12.7 / reqwest 0.12.28(정확 고정) + Cargo.lock
    tauri.conf.json            창(settings), CSP, NSIS·MSI 번들 설정
    capabilities/default.json  IPC 권한은 `settings` 창에만
    src/main.rs                진입점
    src/lib.rs                 빌더, 트레이 초기화, 30초 상태 확인 루프, 시작 시 작업 공간 열기
    src/app_state.rs           공용 상태·창 관리·세션 초기화·호출자 검사
    src/commands.rs            IPC 명령 8개(아래 표)
    src/probe.rs               HTTPS 연결 확인(8초 제한, 리다이렉트 미추적)
    src/url_policy.rs          서버 URL 정책(https 강제, 사설 주소 차단)
    src/settings.rs            비밀 없는 설정 저장(원자적 쓰기)
    src/tray.rs                트레이 아이콘·메뉴
```

### 창 두 개와 권한 경계

| 창 | 내용 | IPC 권한 |
|---|---|---|
| `settings` | 로컬 셸(`ui/`, `tauri://`·`http://tauri.localhost`) | 있음 (`core:default`만) |
| `workspace` | 클라우드 웹 앱을 `https://`로 로드 | **없음** (capability의 `windows` 목록에 없고 `remote` 선언 없음) |

그래서 원격 페이지(웹 앱)는 셸의 어떤 명령도 호출할 수 없다. 여기에 더해 모든 상태 변경 명령은
`WebviewWindow`를 받아 라벨이 `settings`이고 문서가 로컬 앱 origin인지 다시 확인한다
(`app_state::ensure_shell_caller`) — 권한 구성이 뚫려도 명령은 거부된다.

### IPC 명령

| 명령 | 하는 일 |
|---|---|
| `get_client_view` | 서버 URL·상태·설정 파일 경로·버전 |
| `get_diagnostics` | 진단 값(타임아웃·주기·API 기본 경로 등) |
| `save_settings` | URL 정책 검증 → 저장 → 즉시 확인 |
| `test_server_url` | 저장하지 않고 입력 주소만 확인 |
| `refresh_status` | 저장된 주소로 즉시 확인 |
| `open_workspace` | 작업 공간 창을 열거나 앞으로 가져옴 |
| `show_settings` | 설정 창 표시 |
| `clear_session` | 이 기기의 웹뷰 데이터(쿠키·스토리지) 삭제 + 작업 공간 창 닫기 |

명령 목록은 이 8개가 전부이며, 셸 실행·파일 시스템 접근·프로세스 실행 명령은 존재하지 않는다.

### 키·세션 저장 방식

- **AI 제공자 키, Cloudflare 토큰, GitHub 앱 키**: 앱이 저장하지도 요청하지도 않는다. 서버(Cloudflare secret)에만 있다.
- **로그인 세션**: WebView2 사용자 프로필의 쿠키로만 존재(HttpOnly, DPAPI 보호). 앱 코드가 쿠키 값을 읽지 않는다.
- **설정 파일**: `%APPDATA%\app.airoom.desktop\client-settings.json` — 서버 URL·시작 동작·테마뿐. 쓰기는 임시 파일 + rename.
- **로그아웃**: `clear_all_browsing_data`로 이 기기의 웹뷰 데이터를 지운다. 서버 세션 폐기는 웹 앱의 로그아웃 API가 담당한다.

### 연결 상태 표시

`probe.rs`가 30초마다 `GET {서버}/api/v1`을 보내 다음을 구분한다.

| 상태 | 의미 |
|---|---|
| `online` | 2xx~4xx 응답 — 서버가 살아 있음 |
| `auth_required` | 401/403 — 서버는 살아 있고 로그인이 필요 |
| `server_error` | 5xx |
| `offline` | 시간 초과·DNS·TLS 실패 |
| `invalid_url` | 저장된 주소가 정책에 맞지 않음 |

트레이 툴팁이 같은 상태를 보여주고, 설정 창은 이벤트(`client://status`)로 즉시 갱신한다.
`/api/v1`은 계약의 API_BASE_PATH이며, 별도 health 라우트는 아직 계약 카탈로그에 없어서 404도
"응답했다"까지만 인정하고 서버 전체 정상으로 승격하지 않는다.

## 빌드

로컬(Windows 11 x64, Rust + WebView2):

```powershell
cd apps/desktop
npm ci
npm run tauri build      # → src-tauri/target/release/bundle/{nsis,msi}/
```

CI: `.github/workflows/build-windows.yml` (`windows-latest`, Rust stable + `npm ci` + `tauri build`).
산출물은 `AI ROOM_0.1.0_x64-setup.exe`(NSIS, currentUser 설치)와 `AI ROOM_0.1.0_x64_en-US.msi`이며,
워크플로가 SHA-256을 만들고 artifact로 올린다.

## 검증 상태 (사실만)

| 항목 | 결과 |
|---|---|
| `tauri.conf.json` 스키마 검증 (공식 2.12.7 스키마, ajv) | **PASS** |
| `capabilities/default.json` 스키마 검증 | **PASS** |
| 아이콘 5종 생성·형식 확인(PNG 32/128/256/512, ICO 256 PNG 엔트리) | **PASS** |
| `package-lock.json` 생성(CLI 2.12.6 고정) | **PASS** |
| Rust 소스 구문 파싱 (`rustc --emit=metadata`) | **PASS** — 문법 오류 0(의존성 미링크로 타입 검사는 아님) |
| `cargo fmt --check` (rustfmt 1.11.0) | **PASS** |
| 의존성 해석 (`cargo generate-lockfile`) | **PASS** — 470개 패키지, 버전 충돌 없음 |
| `cargo check`/`cargo build`/`cargo test` (타입 검사·단위 테스트) | **NOT_RUN** — 이 작업 환경에 C 링커(`cc`)와 MSVC 타깃이 없다. `cargo check`도 proc-macro 빌드 단계에서 링커가 필요해 실패한다 |
| EXE·NSIS·MSI 실제 생성 | **NOT_RUN** — 최초 생성은 GitHub Actions `build-windows`이며, 저장소가 아직 원격에 없어 한 번도 실행되지 않았다 |
| Windows 11 설치·실행·제거 시험 | **NOT_RUN** |

로컬에서 빌드했다고 주장하지 않는다. 위 표의 `NOT_RUN`은 CI 첫 실행 결과로 채워야 한다.

## 아직 없는 것 (격차, 숨기지 않음)

| 항목 | 상태 | 이유 |
|---|---|---|
| 네이티브 알림 | **미구현** | 원격 웹 앱에 IPC 브리지를 열어야 하는데, 그 경계를 열지 않는 것이 이 클라이언트의 설계다. 웹 앱의 알림 권한 흐름에 맡긴다 |
| 딥링크(`airoom://`) | **미구현** | 배포된 웹 앱·등록 스킴이 없어 실제 시험 불가. 도입 시 `tauri-plugin-deep-link` + 설치 프로그램 스킴 등록 필요 |
| 자동 업데이트 | **미설정** | `createUpdaterArtifacts: false`. 서명 키·업데이트 서버가 없어 켜지 않았다. 현재 정책: CI 산출물 재설치 |
| 코드 서명 | **없음** | 인증서 없음 → SmartScreen 경고가 뜬다. 경고를 숨기지 않는다(명세 14.5) |

## 보안 메모

- CSP: 로컬 셸(`settings` 창)에만 적용된다 — `default-src 'self'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. 인라인 스크립트·원격 스크립트 없음.
- 작업 공간(원격) 문서의 CSP·HSTS·WSS 정책은 서버가 내려주는 헤더를 따른다. 이 클라이언트는 그 문서에 IPC 권한을 주지 않는 것으로 경계를 지킨다(웹 앱의 CSP는 웹 트랙 책임).
- `freezePrototype: true`.
- 서버 URL: https만, 자격 증명·쿼리·프래그먼트 금지, 사설/loopback/링크로컬/메타데이터 호스트 차단(SSRF·DNS rebinding 완화). 평문 http는 디버그 빌드의 loopback만.
- 연결 확인 요청은 리다이렉트를 따라가지 않고 8초에서 끊는다.
- 빌드 환경에 Cloudflare 프로덕션 비밀을 넣지 않는다(`build-windows.yml`은 시크릿을 쓰지 않는다).

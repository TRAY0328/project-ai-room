# PROJECT AI ROOM — FINAL RELEASE REPORT

> 이 문서는 `FINAL_RELEASE_REPORT_TEMPLATE.md` 양식에 **현재 실제 상태**를 채운 것이다.
> 확인되지 않은 run ID·SHA·스크린샷은 넣지 않았고, 미완료를 완료로 적지 않았다.
> 상세 실행 기록: [`deployment-live.md`](deployment-live.md), [`../operator-guide/DEPLOYMENT.md`](../operator-guide/DEPLOYMENT.md)

- Report date/time UTC: **2026-11-21T05:55Z** (KST 14:55)
- Requested completion status: **`NOT_RELEASE_READY`** (G-01..G-12 PASS 전에는 변경 금지)
- 이번 단계 성격: 웹·Windows·Android 앱과 게이트웨이를 **Cloudflare에 실제 배포**하고, GitHub Actions 5종을 **모두 통과**시켜 EXE·설치파일·APK·웹 빌드를 산출했다.
- Git commit SHA: **`cf00dd884e39095986655b392f156db9075d2d89`** (원격 `main`, CI 5/5 success)
- Cloudflare deployment/environment: **DEPLOYED (staging)** — `https://project-ai-room.playtray0328.workers.dev`, Worker `project-ai-room`, 버전 `3bb6682c-ee36-4dae-967c-36f13bccfcf6`
- GitHub repository: `https://github.com/TRAY0328/project-ai-room` (**PUBLIC — 사용자 명시 승인**). 코드·문서는 이 저장소가 단일 진본이다.
- Source code archive and SHA-256: **NOT_PRODUCED** (git 커밋으로 관리, 별도 아카이브 없음)
- Web build SHA-256 / test URL: `index.html` `c11a67b2…65e536` · `ai-portal.txt`= `llms.txt` `593f41ea…26ae66` · 12개 파일 · https://project-ai-room.playtray0328.workers.dev/
- Windows EXE + installer SHA-256 / install test: `AI ROOM.exe` `d76a019b…efe89a0` (4,820,992B) · NSIS `de3fbaa8…507cff5` (1,873,186B) · MSI `416c4f8b…50919ff9` (2,510,848B) · **미서명, 실제 기기 설치·실행 시험 미실시**
- Android APK SHA-256 / device install test: CI debug `ce281f78…6077d0d8` (9,146,029B) · release **미생성(서명 키 없음)** · **실기기 설치 미실시**

## 이번 단계 실제 산출물

| 산출물 | 경로 / 위치 | 검증 |
|---|---|---|
| 웹 클라이언트 빌드 | `apps/web/dist` (12개 파일, 4.5MB) | vite 프로덕션 빌드, `llms.txt`·`ai-portal.txt` 포함, CI 아티팩트와 동일 해시 |
| Cloudflare Worker | `project-ai-room` (workers.dev) | 라이브 200/401 응답 실측(`live/live-probe-20261121T050232Z.txt`) |
| D1 스키마 | `ai-room-db` `483c3df3-…eeb3` | `0001_initial.sql` 원격 적용, 테이블 97 · 트리거 26 · 인덱스 151 |
| Windows 산출물 | CI `44871990877` | `AI ROOM.exe` + NSIS 설치프로그램 + MSI, SHA-256 기록([`ci-runs.md`](ci-runs.md)) |
| Android APK | CI `44871990867` | debug APK 9,146,029B, SHA-256 기록 |
| 로컬 검증 | `npm run verify` | typecheck + 계약 78 + 테스트 83/83 PASS |
| 웹 테스트 | `apps/web` vitest | 80/80 PASS (1회차에서 1건 flaky 실패 후 재실행 통과) |
| 보안 테스트 | `tests/security/*` | PASS, 금지패턴 스캔 clean, GPL계열 라이선스 0건 |

## Live 응답 (실측)

| 경로 | 코드 | 의미 |
|---|---|---|
| `GET /` | 200 | 웹 클라이언트(SPA) 서빙 |
| `GET /ai-portal.txt` · `GET /llms.txt` | 200 | AI 참여 포털 문서 동일 Origin 제공 |
| `GET /api/v1/health/live` | 200 | `{"status":"ok"}` |
| `GET /api/v1/health/ready` | 200 | `worker: up, d1: up, r2: down, github: unknown` → `degraded` |
| `GET /v1/health/live` | 200 | `/v1/*` 별칭 라우팅 동작 |
| `GET /api/v1/rooms` · `/v1/rooms` | 401 | 인증 없이 차단(`AUTH_REQUIRED`) |
| `POST /v1/auth/login` | 401 | 소유자 부트스트랩 전이라 `OWNER_PASSWORD_VERIFIER` 미설정을 정직하게 반환 |

`health/ready`가 `degraded`인 이유는 R2 미활성과 GitHub 상태 미확인이다. Worker·D1은 `up`이며, 이 사실을 `ok`로 바꾸지 않는다.

## Required real AI roster

| Provider/AI | Official auth | Autonomous delivery | Code changes | Free use verified | Overall | Evidence |
|---|---|---|---|---|---|---|
| ChatGPT | API 키(문서 확인) | 문서상 가능 | 미시험 | **미확인** | `NOT_CONFIGURED` | provider-capabilities.md §3.1 |
| Claude | API 키(문서 확인) | 문서상 가능 | 미시험 | 아님(1회성 테스트 크레딧) | `PAID_API_REQUIRED` | §3.2 |
| Gemini | API 키(문서 확인) | 문서상 가능 | 미시험 | **무료 등급 존재**(학습 활용 조항) | `NOT_CONFIGURED` | §3.3 |
| PICKLE | 공식 서버 API 없음 | 불가 | 불가 | 해당 없음 | `NO_OFFICIAL_EVIDENCE` | §3.4 |
| Keyring | 없음(로컬 데스크톱) | 불가 | 불가 | 유료 라이선스 | `NO_OFFICIAL_EVIDENCE` | §3.5 |
| vooy | 없음(소비자 앱) | 불가 | 불가 | 소비자 무료 요금제(개발자 API 아님) | `NO_OFFICIAL_EVIDENCE` | §3.6 |
| MUSE (Meta Model API) | API 키(문서 확인) | 문서상 가능 | 미시험 | 아님(종량 과금) | `PAID_API_REQUIRED` | §3.7 |
| CUE (Cue AI) | API 키(분석 API) | 불가 | 불가 | 미확인 | `CAPABILITY_MISSING` | §3.8 |

Q039 게이트: **`BLOCKED_EXTERNAL_DEPENDENCY` (blocker 8/8)** — `services/provider-adapters`의 `q039Gate()` 실행 결과와 일치.
T-AI-01~08 시험: **0건 수행**. 키·계정이 없으므로 "수행 불가"이며, 수행한 것처럼 기록하지 않는다.

## Acceptance gates

`node scripts/verify-release.mjs` 실측(2026-11-21T05:11Z).

| Gate | Status | Evidence / link |
|---|---|---|
| G-01 Q001–Q041 features | `BLOCKED` | QA 103항목: PASS 46 · PARTIAL 24 · BLOCKED 8 · NOT_TESTED 25 · FAILED 0 (`tests/acceptance/qa-matrix-status.md`) |
| G-02 All required real AI | `BLOCKED` | Q039 8/8 blocker, provider-capabilities.md §4 |
| G-03 Multi-AI collaboration | `BLOCKED` | 실제 AI 키 없음 — `release-evidence.json` G-03 |
| G-04 GitHub PR/Actions/merge | `PARTIAL` | Actions 5종 success(커밋 `cf00dd8`), PR·리뷰·검증 병합 흐름은 미실시 — [`ci-runs.md`](ci-runs.md) |
| G-05 Web | `PARTIAL` | 라이브 200/401 확인, 소유자 로그인·대화·IDE 시연은 계정 미생성으로 미실시 |
| G-06 Windows | `PARTIAL` | EXE·NSIS·MSI 생성 + SHA-256 확보, 실제 설치·실행 시험 및 코드 서명 미실시 |
| G-07 Android | `PARTIAL` | CI debug APK 생성, release 미서명 미생성, 실기기 설치 미실시 |
| G-08 Security | `BLOCKED` | 보안 50건: PASS 17 · PARTIAL 11 · BLOCKED 2 · NOT_TESTED 20 · FAILED 0 |
| G-09 Failure recovery | `PARTIAL` | 장애·복구 9항목: PASS 5 · PARTIAL 2 · NOT_TESTED 2 |
| G-10 Data integrity | `BLOCKED` | 무결성 11항목 중 1건 BLOCKED(R2/원격 복원), 원격 D1 적용·구조 확인 완료 |
| G-11 Free operation/billing protection | `PARTIAL` | 유료 API 미사용(비용 0), 사용량 수집·선제 경보는 AI 호출 경로 없어 미시험 |
| G-12 Documentation and artifacts | `PARTIAL` | 문서 13종·OpenAPI 동기화·테스트 120 PASS, Windows EXE 누락 |

## CI results, security findings, backup restore, known blockers, operator handoff

### CI 결과
- 원격 Actions **5/5 success** — 커밋 `cf00dd884e39095986655b392f156db9075d2d89`:
  verify `44871990981` · build-web `44871990894` · build-android `44871990867` · build-windows `44871990877` · security `44871990908`
- 실패에서 통과까지 고친 원인 5건은 [`ci-runs.md`](ci-runs.md) 표에 남겼다: 로컬 전용 스펙 경로, gitleaks 오탐, `npm sbom` 전 `npm ci` 누락, rustc E0597, 카고 산출물 파일명 불일치.
- Actions 무료 한도: 저장소가 **PUBLIC**이라 표준 러너 분당 과금이 없다.
- 남은 CI 공백: PR 생성·리뷰·검증 병합 경로는 실제로 돌리지 않았고(푸시 직행), 이는 G-04를 PARTIAL로 둔다.

### 보안 점검
- 통과: 기본 거부 권한 모델, AI↔소유자 권한 분리, 비멤버 접근 차단, 승인 없는 고위험 작업 차단, 내부 오류 비노출, 웹훅 서명 상수시간 비교, 감사 로그 append-only.
- 의존성: **배포 런타임 의존성 취약점 0건**(`npm audit --omit=dev`). 개발 도구(vite ≤6.4.3, vitest/tinypool 계열)에는
  high/critical 고지가 남아 있어 `security.yml`을 "프로덕션 의존성 차단 + 개발도구 고지는 기록"으로 분리했다.
  개발 서버·테스트 실행에만 쓰이는 도구이며 배포 산출물에는 포함되지 않는다. 이 구분은 [`../security/SECURITY_CONTROLS.md`](../security/SECURITY_CONTROLS.md)에 적었다.
- 미실시: 실제 침투 시험, 부하 시험, gitleaks 원격 실행(로컬 패턴 스캔만).

### 백업/복구
- `backup_manifests`·`restore_runs` 테이블과 승인 결박 제약 존재. 원격 D1이 생겼으므로 이제 실제 백업 시험이 가능하지만 **아직 0건**이다.

### 알려진 차단 요인
1. **R2 미활성** — `10042 Please enable R2 through the Cloudflare Dashboard`. 파일 본문·스냅샷 경로는 `R2_NOT_ENABLED`.
2. **Q039 외부 AI 연결 불가** — 8종 중 무료 무인 경로가 문서로 확인된 것은 Gemini뿐이고 키가 없다.
3. **소유자 계정 미생성** — 부트스트랩에 사용자가 정할 이메일·비밀번호가 필요해 대신 만들지 않았다. 그래서 로그인 이후 기능 시연(G-05)이 PARTIAL이다.
4. **서명·설치 시험 없음** — Windows 코드 서명 인증서와 Android release 키가 없고, 실제 기기 설치·실행 시험을 하지 않았다(G-06·G-07 PARTIAL).

### 운영 인계 / 다음 단계 제안
1. (사용자 결정) 소유자 계정(이메일·비밀번호) 확정 → 부트스트랩 → `OWNER_PASSWORD_VERIFIER` 시크릿 등록 → 로그인·대화·IDE 라이브 시연(G-05 확정).
2. (승인 필요) R2 활성화 → 파일 업로드/다운로드 경로 구현·시험.
3. (사용자 결정) Gemini 무료 키 제공 여부 / 유료 API 금지 조건 해제 여부.
4. (선택) Windows 11 기기에 `AI ROOM_0.1.0_x64-setup.exe` 설치·실행 시험, Android 기기에 `app-debug.apk` 설치 시험 → G-06·G-07 확정.
5. (선택) 코드 서명 인증서·Android release 키 도입 시 서명된 산출물로 교체.

## 해시·증거

- 웹 빌드(CI `44871990894`): `dist/` 12개 파일, `index.html` `c11a67b2`…`65e536`, `ai-portal.txt` = `llms.txt` `593f41ea`…`26ae66` (로컬 빌드와 동일 해시)
- Windows(CI `44871990877`): `AI ROOM.exe` `d76a019b`…`efe89a0` · `AI ROOM_0.1.0_x64-setup.exe` `de3fbaa8`…`507cff5` · `AI ROOM_0.1.0_x64_en-US.msi` `416c4f8b`…`50919ff9`
- Android(CI `44871990867`): `app-debug.apk` `ce281f78`…`6077d0d8`
- 마이그레이션: `db/migrations/0001_initial.sql` — 원격 적용 2026-11-21T04:53:08Z, 157개 명령, 테이블 97·트리거 26·인덱스 151
- 증거 원장: [`release-evidence.json`](release-evidence.json) (G-03~G-11) · CI 상세: [`ci-runs.md`](ci-runs.md) · 배포 상세: [`deployment-live.md`](deployment-live.md)
- 계약 버전: `2026-11-21.1` (엔드포인트 78, 오류코드 26, 이벤트 45, 권한 액션 57, 작업 상태 18)

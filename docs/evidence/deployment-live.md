# 배포 실측 기록 — Cloudflare (2026-11-21)

이 문서는 **실제로 실행한 명령과 그 응답**만 기록한다. 실행하지 않은 것은 "미실행"으로 남긴다.
비밀 값(토큰·시크릿)은 어디에도 쓰지 않는다.

- 실행 시각(UTC): 2026-11-21T04:50Z ~ 05:05Z (KST 13:50 ~ 14:05)
- 배포한 소스: 로컬 커밋 `46fd4f1`의 작업 트리 (커밋 직전 빌드/배포, 내용 동일)
- 계정: `e2b6a799ae8fbaa94a08b703a079be92` · 서브도메인 `playtray0328.workers.dev`
- 도구: wrangler 4.166.0 (이번에 설치. 이전 `toolchain.lock.json`의 "미설치" 기록을 갱신함)

---

## 1. D1

| 항목 | 값 |
|---|---|
| 데이터베이스 | `ai-room-db` |
| id | `483c3df3-3ef1-44f8-a135-65fb7e05eeb3` |
| 리전 | WNAM (served_by_primary, colo LAX) |
| 생성 | `wrangler d1 create ai-room-db` → `Successfully created DB` |

원격 마이그레이션:

```
wrangler d1 migrations apply ai-room-db --remote
🌀 Executed 157 commands in 44.03ms
0001_initial.sql  ✅
```

원격 확인(실행한 쿼리와 결과):

| 쿼리 | 결과 |
|---|---|
| `SELECT * FROM d1_migrations` | `id=1, name=0001_initial.sql, applied_at=2026-11-21 04:53:08` |
| `SELECT type, count(*) FROM sqlite_master GROUP BY type` | `table 97 · index 151 · trigger 26` |
| `SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'` | `12` (FTS5 본체 + 섀도 테이블) |
| `SELECT * FROM schema_migrations` | `version=0001_initial, checksum='pending'(SQL 파일이 넣는 값), note='initial contract schema'` |
| `PRAGMA integrity_check` | **실패: `not authorized: SQLITE_AUTH [code: 7500]`** |

`PRAGMA integrity_check`는 D1 원격 API에서 허용되지 않는다(Cloudflare D1 제약). 무결성 확인은
로컬 SQLite(3.50.4)에서 `node scripts/db-migrate.mjs --memory --check`(integrity_check=ok,
foreign_key_check 0건)로 수행했고, **원격 D1에 대해서는 구조(테이블·트리거·인덱스 수)와
`schema_migrations` 행으로만 확인했다.** 이 한계를 PASS로 바꿔 부르지 않는다.

---

## 2. Worker + 정적 자산 (단일 URL)

`wrangler.toml`:

- `name = "project-ai-room"`, `main = services/gateway-worker/dist/worker-entry.js`
- D1 바인딩 `DB`, Durable Objects `ROOM_DO`(RoomDurableObject)·`COLLAB_DO`(CollabDurableObject), `migrations.tag = v1-room-do (new_sqlite_classes)`
- `[assets] directory = "apps/web/dist" · binding = "ASSETS" · run_worker_first = ["/api/*","/v1/*","/health*"] · not_found_handling = "single-page-application"`
- `worker-entry.ts`는 `/v1/*`를 `/api/v1/*`로 넘기고, API가 아닌 경로는 `env.ASSETS.fetch`로 보낸다.

배포 로그:

```
wrangler deploy
Read 13 files from the assets directory .../apps/web/dist
Uploaded 11 files (1 already uploaded)
Total Upload: 1261.42 KiB / gzip: 213.34 KiB
Worker Startup Time: 143 ms
Binding: ROOM_DO, COLLAB_DO, DB (ai-room-db), ASSETS, APP_ENV=staging, API_BASE_PATH=/api/v1
Deployed project-ai-room triggers
  https://project-ai-room.playtray0328.workers.dev
```

배포 버전 이력(`wrangler deployments list`):

| 시각(UTC) | 버전 ID | 내용 |
|---|---|---|
| 04:53:53 | `4c7e5cba-b267-4abe-b96b-f9899e69b873` | Secret Change (시크릿 5종 등록) |
| 04:54:03 | `ef17f36c-d40b-4bfd-b24d-d70f7880b176` | 최초 업로드 배포 |
| 04:54:23 | `3bb6682c-ee36-4dae-967c-36f13bccfcf6` | `/v1/*` 별칭 라우팅 추가 배포 (현재 100%) |

---

## 3. 시크릿 (값은 기록하지 않음)

`wrangler secret put`으로 5종을 등록했고 모두 `Success! Uploaded secret`을 받았다.
값은 32바이트 난수를 base64url로 만든 것이며 셸 히스토리·로그·문서·Git에 남기지 않았다.

`SESSION_SIGNING_KEY`, `WS_TICKET_SIGNING_KEY`, `AGENT_INVITE_SECRET`, `OWNER_BOOTSTRAP_SECRET`, `GITHUB_WEBHOOK_SECRET`

- `OWNER_PASSWORD_VERIFIER`는 **등록하지 않았다.** 이 값은 `POST /v1/owner/bootstrap` 응답에서
  한 번만 받아 넣는 설계이고, 부트스트랩은 소유자 이메일·비밀번호를 요구한다. 소유자 비밀번호를
  대신 정하는 것은 이 작업 범위 밖이라 계정을 만들지 않았다.

---

## 4. 라이브 응답 (실측)

`docs/evidence/live/live-probe-20261121T050232Z.txt` (원본 캡처)

| 경로 | 코드 | 응답 요약 |
|---|---|---|
| `GET /` | 200 | `<!doctype html> … <html lang="ko">` (웹 클라이언트) |
| `GET /ai-portal.txt` | 200 | `PROJECT AI ROOM — AI PARTICIPATION PORTAL (machine-readable)` |
| `GET /llms.txt` | 200 | 동일 문서(에이전트용 진입점) |
| `GET /index.html` | 307 | 자산 계층이 `/`로 정규화 |
| `GET /room/ABC/chat` | 200 | SPA 폴백(unknown route도 앱 진입점) |
| `GET /api/v1/health/live` | 200 | `{"status":"ok","checks":{"worker":"up"}}` |
| `GET /api/v1/health/ready` | 200 | `{"status":"degraded","checks":{"worker":"up","d1":"up","r2":"down","github":"unknown"}}` |
| `GET /v1/health/live` | 200 | 위와 동일 (`/v1/*` 별칭 동작 확인) |
| `GET /api/v1/rooms` | 401 | `AUTH_REQUIRED` — 인증 없이 방 목록 차단 |
| `GET /v1/rooms` | 401 | 동일 (별칭도 같은 가드) |
| `POST /v1/auth/login` | 401 | `OWNER_PASSWORD_VERIFIER` 미설정(소유자 부트스트랩 전 상태를 정직하게 반환) |
| `POST /v1/owner/bootstrap` (빈 본문) | 400 | `VALIDATION_FAILED: display_name/email/password` 필요 — 엔드포인트는 살아 있음 |

`health/ready`의 `status`가 `degraded`인 이유는 R2 미활성(`r2: down`)과 GitHub 상태 미확인(`github: unknown`)이다.
Worker와 D1은 `up`이다. 이 상태를 `ok`로 바꾸지 않는다.

---

## 5. 이 배포로 확정된 것 / 여전히 안 된 것

확정:
- 단일 Origin에서 웹 클라이언트·포털 문서·REST API·Durable Object 바인딩이 함께 배포됨(바인딩 목록으로 확인)
- 원격 D1에 마이그레이션 적용(테이블 97·트리거 26)
- 인증 없는 요청이 차단됨(401) — 인증/인가 경로가 실제로 도는 것을 확인

안 된 것(정직하게):
- 소유자 계정 미생성 → 로그인·대화·IDE 실사용 시연 없음 (G-05는 PARTIAL)
- R2 비활성 → 파일 본문 경로는 `R2_NOT_ENABLED` (G-10의 일부 차단 유지)
- 실제 AI 제공자 키 없음 → 다중 AI 협업 시연 없음 (G-02/G-03 차단 유지)
- GitHub 리포지토리 미생성(Pickle 연결에 저장소 생성 권한 없음) → Actions 실행 증거 없음 (G-04 차단)

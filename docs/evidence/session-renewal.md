# 세션 자동 연장 실측 기록 — 쿠키 기반 refresh + 클라이언트 백그라운드 연장 (2026-11-22)

이 문서는 **실제로 실행한 명령과 그 응답**만 기록한다. 실행하지 않은 것은 "미실행"으로 남긴다.
비밀 값(토큰·쿠키 원문)은 어디에도 쓰지 않는다.

- 계정: `e2b6a799ae8fbaa94a08b703a079be92` · 서브도메인 `playtray0328.workers.dev`
- 배포 URL: <https://project-ai-room.playtray0328.workers.dev>
- 로컬 브랜치: `main` · 배포 시점 커밋 `66dd569`

---

## 1. 고친 이유 (실서버에서 먼저 확인한 결함)

로그인은 `air_session`(30분) · `air_refresh`(30일) · `air_csrf` 쿠키를 내려주지만, 브라우저는
HttpOnly인 `air_refresh`를 읽을 수 없다. 그런데 `POST /api/v1/auth/refresh`는 본문
`refresh_token`을 **필수**로 요구했다.

```
POST /api/v1/auth/refresh   (air_refresh 쿠키만, 본문 {})
→ 400 VALIDATION_FAILED
   {"issues":[{"path":"refresh_token","code":"invalid_type",
               "message":"Invalid input: expected string, received undefined"}]}
   Set-Cookie: (없음)
```

같은 시각 본문에 토큰을 넣으면 200 + 새 쿠키 3종이 정상 발급됐다. 즉 **쿠키 경로만 빠져 있었고**,
그 결과 30분 뒤 `GET /v1/rooms`가 `AUTH_EXPIRED`가 되면 화면은 다시 로그인을 요구했다.

---

## 2. 서버 변경

| 파일 | 변경 |
|---|---|
| `services/gateway-worker/src/schemas.ts` | `post-auth-refresh` 본문의 `refresh_token`을 **선택**으로 (쿠키만 있는 브라우저 요청 허용) |
| `services/gateway-worker/src/handlers/identity.ts` | 본문 토큰이 없으면 `air_refresh` 쿠키로 연장. 둘 다 없으면 `AUTH_REQUIRED` |
| `services/gateway-worker/src/index.ts` | 연장이 401로 거절되면(폐기·만료) 세션 쿠키 3종을 `Max-Age=0`으로 만료시키는 `Set-Cookie`를 함께 반환 |

회전·재사용 차단 정책은 그대로다(회전할 때마다 새 refresh, 이전 토큰 재사용 시 세션 패밀리 폐기).

---

## 3. 클라이언트 변경

| 파일 | 변경 |
|---|---|
| `apps/web/src/api/session.ts` (신규) | `SessionKeeper`: 만료 6분 전 타이머 연장, 401 시 1회 연장, 단일 비행(single-flight), **Web Locks로 탭 간 직렬화**, 탭 간 마커(localStorage `air.session.renewed`), 네트워크 실패는 로그아웃으로 보지 않음 |
| `apps/web/src/api/client.ts` | 401 응답에서 `renewSession()` 1회 시도 후 같은 요청을 1회 재시도. 연장까지 거절되면 그때 `onUnauthorized` |
| `apps/web/src/api/realtime.ts` | 1008(expired/revoked)·4401/4403·1006(거절된 업그레이드)에서 **한 번** 연장 시도 후 같은 커서로 즉시 재연결. 연장 거절 시에만 `세션이 만료되었습니다` 상태. `ensureConnected()`로 백그라운드 탭 복귀 시 즉시 재연결 |
| `apps/web/src/state/AppState.tsx` | keeper 생성·주입, `ready`일 때만 타이머, `visibilitychange`/`online`에서 `renewIfStale()`, 만료 판정 시 세션 힌트 정리 |
| `apps/web/src/screens/Chat.tsx` | `onAuthExpired` 연결, 탭 복귀 시 `ensureConnected()` |
| `apps/web/src/screens/Start.tsx` | 로그인(소유자·AI 키) 응답의 `access_expires_at`을 keeper에 전달 |

---

## 4. 테스트

```
$ npm run typecheck                 # tsc -b → 오류 0
$ npm run verify                    # typecheck + contracts + 단위·통합 테스트
# tests 89 / pass 89 / fail 0        (기존 87 + 신규 2)
$ cd apps/web && npm run typecheck  # 오류 0
$ cd apps/web && npm test
# Test Files 12 passed · Tests 103 passed  (기존 88 + 신규 15)
$ cd apps/web && npm run build      # vite build 성공
```

이번에 추가한 테스트:

- `tests/integration/api_identity.test.mjs`
  - 로그인 쿠키만으로 연장 → 새 `air_session`·`air_refresh` 발급 → 그 새 쿠키로 `/v1/rooms` 200,
    `/v1/auth/refresh` 별칭도 200
  - 세션 없는 연장 → 401 `AUTH_REQUIRED` + `Max-Age=0`, 로그아웃된 세션 연장 → 401 `AUTH_REVOKED` + 쿠키 만료
- `apps/web/src/__tests__/session.test.ts` (신규 11건)
  - 빈 본문·`credentials: include`로 `/v1/auth/refresh` 1회 호출
  - 동시 3건 요청 → 실제 fetch 1회(중복 회전 방지)
  - 401은 로그아웃, 네트워크 실패는 로그아웃 아님
  - 다른 탭의 최근 연장은 건너뜀, 15분 내 재연장 안 함, 백그라운드 탭 복귀 시 따라잡기
  - 만료 6분 전에 타이머가 먼저 발동(가짜 타이머로 24분 경과)
  - 401 → 연장 → 같은 요청 재시도 성공 / 연장 거절 → `onUnauthorized` 1회
- `apps/web/src/__tests__/realtime.test.ts` (+4건)
  - `1008 expired` → 연장 후 **대기 없이 같은 커서로** 재연결, `live` 복귀
  - `1006` → 장애 1회당 연장 1회(두 번째는 백오프)
  - 연장 거절 → `세션이 만료되었습니다` 오류 상태, 재연결 없음
  - `ensureConnected()`가 백그라운드 탭 복귀 시 즉시 재연결

---

## 5. 라이브 검증 (배포본 대상)

### 5-1. API·WebSocket (`session-e2e.cjs`, Node `ws`)

```
1-0 저장된 쿠키 세션              GET /v1/rooms → 200
1   쿠키만으로 연장               POST /v1/auth/refresh {} → 200
                                  Set-Cookie: air_session, air_refresh, air_csrf
                                  refresh 회전 true / access 재발급 true
2   새 쿠키로 인증                GET /v1/rooms → 200 (room_06GZSBDW6HYGV84V8G0N00KJ84)
3   세션 없는 연장                → 401 AUTH_REQUIRED, 만료 쿠키 3종
4   만료 air_session으로 업그레이드 → 401 (소켓 열리지 않음)
5   연장 후 업그레이드            → 101, 첫 프레임 SNAPSHOT_REQUIRED(seq 노출)
5b  PING → PONG                   확인
6a  소켓 열린 채 회전             → 200, refresh 회전 true
6b  같은 소켓 PING → PONG          확인(readyState 1, 끊기지 않음)
6c  새 세션으로 재연결            → 101
=== PASS ===
```

### 5-2. 실제 브라우저 (Playwright/Chromium, `session-browser-e2e.cjs`)

| 단계 | 상황 | 결과 |
|---|---|---|
| A | 정상 세션으로 `#/chat` | 배지 `실시간 수신 중 (+0)`, 로그인 화면 없음 |
| B | 탭을 연 채 `air_session`을 만료 토큰으로 교체 | **자동 연장 1회**, 화면 유지, 배지 `실시간 수신 중`, `로그인 필요` 없음, JS 오류 0 |
| B2 | 그 상태에서 새로고침 | 여전히 로그인 유지 + `실시간 수신 중` |
| C | 새 프로필, 만료된 `air_session` + 유효한 `air_refresh`(40분 뒤 재방문) | 연장 1회 → 로그인 화면 없이 `#/chat` 실시간 |
| D | 같은 쿠키를 쓰는 탭 2개를 동시에 만료 | **연장 요청 총 1회**, 거절 0회, 두 탭 모두 `실시간 수신 중` |

D는 회전 토큰을 동시에 두 번 제시하면 서버가 세션을 폐기하기 때문에 중요하다.
Web Locks로 직렬화한 결과 실제 요청이 1회뿐이었고, 두 탭 모두 세션을 유지했다.

### 5-3. 하지 않은 것

- 주기 타이머(만료 6분 전)의 **라이브** 발동은 확인하지 않았다. 실제로는 24분을 기다려야 하므로,
  가짜 타이머 단위 테스트로만 검증했다. 라이브 확인은 401 경로(위 B·C·D)로 했다.
- 모든 브라우저(사파리·파이어폭스)에서의 Web Locks 동작은 미확인. Web Locks가 없는 환경에서는
  localStorage 마커 검사만 남는다(경쟁 창이 좁아지지만 0은 아님).

---

## 6. 테스트 데이터 정리

- 생성한 AI·메시지·초대: **없음**. 스크립트는 `GET /v1/rooms`, `POST /v1/auth/refresh`,
  WebSocket `PING`만 수행했다.
- D1 확인: `agents` 1건(Gemini, 2026-11-21 생성·기존), `messages` 16건(기존), `agent_invites` 4건(기존).
- 연장으로 바뀐 것은 `auth_sessions.refresh_token_hash`·`last_seen_at`(정상 세션 유지 동작)과
  `/v1/auth/refresh` 감사 로그뿐이다.

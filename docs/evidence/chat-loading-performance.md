# 메시지 로딩 속도 실측·최적화 기록 (2026-11-22)

이 문서는 **실제로 돌린 명령과 그 출력**만 적는다. 재지 않은 것은 "미측정"으로 남긴다.
비밀 값(비밀번호·토큰·쿠키)은 어디에도 쓰지 않는다.

- 대상: <https://project-ai-room.playtray0328.workers.dev>
- 방: `room_06GZSBDW6HYGV84V8G0N00KJ84` (측정 시점 라이브 메시지 39개, 전체 58행 중 19행은 삭제)
- D1: `ai-room-db` · 리전 WNAM(colo LAX) · 계정 `e2b6a799…`
- 측정 위치: 서울(대전) → WAN, Cloudflare 엣지 경유

---

## 1. 무엇이 느렸나 (원인 실측)

`GET /v1/rooms/{roomId}/messages?limit=50` 한 번에 **D1 왕복 203회**가 있었다.

| 위치 | 문장 수 | 비고 |
|---|---|---|
| `authenticate` (세션 조회 → last_seen 갱신 → 소유자 조회) | 3 | 매 요청 |
| `loadPrincipal` (room_acl · project_acl · room_members) | 3 | 매 요청 |
| `getRoom` + 페이지 + `latestSeq` | 3 | |
| `serializeMessage` × 50 | **200** | 메시지마다 version·mentions·reactions·tombstone 4회 |

D1은 문장마다 왕복이 붙으므로 203회 × ≈25ms = **약 5.0초**. 화면은 이 응답을 기다렸고,
게다가 첫 WebSocket 구독이 커서 없이 붙어 서버가 `SNAPSHOT_REQUIRED`를 보내면 같은 페이지를
한 번 더(5초) 받아 **첫 메시지까지 약 11초**가 걸렸다.

실측(변경 전, 같은 배포):

```
GET /v1/rooms            0.447 / 0.430 / 0.415 s
GET /v1/rooms/{id}/messages?limit=50   5.032 / 4.838 / 5.159 s  (30,850 bytes)
GET /v1/agents           0.379 / 0.342 / 0.366 s
```

---

## 2. 고친 것

### 서버 — 왕복을 문장 수에서 떼어내기

| 파일 | 변경 |
|---|---|
| `packages/auth/src/db.ts` | `batchRows()`·`placeholders()` 추가. 여러 읽기를 `D1.batch()` 한 번으로 보내고, `batch`가 없는 구현(테스트 shim)은 문장별로 순서대로 실행 |
| `services/gateway-worker/src/domain.ts` | `serializeMessages()` 추가 — 페이지 전체의 version·mentions·reactions·tombstone을 `message_id IN (…)` + `JOIN`으로 **4문장**에 모으고 한 배치로 전송. `serializeMessage()`는 같은 코드를 1건에 적용(라이브 프레임과 페이지가 같은 모양) |
| `services/gateway-worker/src/handlers/chat.ts` | ① 메시지 목록: 방 가드·페이지·`latest_seq`를 한 배치로 ② `get-rooms`: 방마다 2회씩이던 구성원 수·최신 seq를 `GROUP BY` 1회씩으로 ③ `after_seq` 지원(꼬리 동기화), `SELECT *` → 필요한 컬럼만 |
| `packages/auth/src/service.ts` | `authenticate`: 세션 조회·주체 조회·`last_seen_at` 갱신을 한 배치로 (3 → 1) |
| `packages/permissions/src/index.ts` | `loadPrincipal`: 세 멤버십 조회를 한 배치로 (3 → 1) |
| `packages/testing/d1-sqlite.mjs` | shim의 `batch()`가 D1처럼 `{ results }`를 돌려주도록 수정(이전에는 SELECT 결과를 버려 배치 읽기가 빈 값이 됐다) |
| `db/migrations/0003_message_read_indexes.sql` | `messages(room_id, room_seq DESC) WHERE deleted_at IS NULL`(부분 인덱스) + `messages(room_id, reply_to_id)` |

결과: 목록 1회 = **13문장 / 4배치**(인증 2 + 페이지 1 + 관계 1) — 메시지 수와 무관.

### 클라이언트 — 기다리지 않게

| 파일 | 변경 |
|---|---|
| `apps/web/src/api/chat-cache.ts` (신규) | 마지막으로 보던 방·방 목록·최근 메시지를 `localStorage`에 보관(방당 60개, 24시간). 소유자 힌트가 없는 브라우저는 캐시를 쓰지 않는다 |
| `apps/web/src/screens/Chat.tsx` | ① 기억한 방으로 **마운트 즉시** 메시지 요청(방 목록과 병렬) ② 캐시 페이지를 먼저 그리고 서버 응답이 `message_id` 기준으로 덮어씀 ③ 첫 페이지 40개 + 위로 스크롤하면 30개씩 이전 페이지 ④ 실시간이 끊긴 동안에만 30초 `after_seq` 꼬리 동기화(전체 페이지 재요청 제거) ⑤ WebSocket을 첫 페이지가 온 뒤 커서와 함께 연결(중복 스냅샷 요청 제거) |
| `apps/web/src/components/chat/index.tsx` | 이전 페이지 컨트롤·스크롤 트리거(위로 이동했을 때만), 레이아웃 이펙트로 읽던 자리 유지(부드러운 스크롤을 잠시 끄고 오프셋 보정) |
| `apps/web/src/styles/app.css` | `.air-chat-scroll { align-content: safe end }` — **아래 3절 참고** |

---

## 3. 검증 중에 발견한 기존 결함 (이번에 함께 고침)

`.air-chat-scroll`이 `align-content: end`였는데, 대화가 화면보다 길어지면 그리드 내용이
**위쪽으로 넘쳐** `scrollHeight == clientHeight`가 되고 컨테이너가 위로 스크롤되지 않았다.
즉 첫 화면 이후의 메시지를 읽을 수 없었다(측정: 높이 634 = 스크롤 높이 634, 첫 메시지 y=-2972).
`align-content: safe end`로 바꾸면 내용이 넘칠 때만 `start`로 떨어져 정상 스크롤된다
(수정 후 `scrollHeight 3763`, `scrollTop 3129`).

---

## 4. 변경 후 실측

### API (같은 엔드포인트, 같은 조건)

| 요청 | 변경 전 | 변경 후 |
|---|---|---|
| `GET /v1/rooms` | 0.431 s | **0.232 ~ 0.329 s** |
| `GET /v1/rooms/{id}/messages?limit=50` | 5.032 s | **0.224 ~ 0.242 s** (약 21배) |
| `GET /v1/rooms/{id}/messages?after_seq=55` | (없음) | **0.227 s** (4,044 bytes) |
| `GET /v1/agents` | 0.362 s | **0.196 ~ 0.202 s** |

### 브라우저 (`#/chat` 실제 로드, Chromium headless 1280×800)

측정 스크립트: `/workspace/work/airoom-perf/measure.py` (reload 기준, 첫 `article.air-msg` 표시까지)

| 조건 | 첫 메시지 표시 | 실시간 `live` | 메시지 요청 수 |
|---|---|---|---|
| 변경 전 (콜드) | **11.38 s** | 11.44 s | 2회(페이지 + 스냅샷 재조회) |
| 변경 후 (콜드, 캐시 없음) | **0.99 s** | 1.06 s | 1회 |
| 변경 후 (웜, 캐시 있음) | **0.45 s** | 0.71 s | 1회 |

JS 오류 0건.

### 기능 유지 (실서버, Playwright)

| 확인 | 결과 |
|---|---|
| 이전 페이지: 40개 → 위로 스크롤 → `limit=30&cursor=25` 1회, 45개로 증가 | 통과 |
| 읽던 자리 유지: 보정 후 `scrollTop 266`(= 추가된 높이) | 통과 |
| 더 없을 때 컨트롤 숨김(`hasOlder=false`)·불필요한 요청 없음 | 통과 (39개 방에서 요청 1회뿐) |
| 메시지 전송(Enter) → 서버 저장(`seq 59~72`)·다른 AI의 답장 도착 | 통과 |
| 반응 버튼(`👍 반응` 등 13개 도구) 노출·클릭 → 서버 저장 | 통과 |
| 실시간 배지 `live`, 방 이름·인원 표시 | 통과 (`실시간 연결 · 9명`) |

검증용으로 만든 메시지(seq 59~102)는 모두 삭제해 방의 보이는 이력은 측정 전과 같다(현재 최신 라이브 seq 58).

---

## 5. 테스트·배포

```
npm run typecheck                         # 오류 0
npm test                                  # 95/95 pass (성능 회귀 테스트 2건 추가)
apps/web: tsc --noEmit                    # 오류 0
apps/web: vitest run                      # 131/131 pass (캐시 6, 캐시 우선 3, 이전 페이지 6 추가)
apps/web: vite build                      # 성공
```

추가한 회귀 테스트:
- `tests/integration/api_chat.test.mjs` — 20개 메시지 페이지가 **16문장·4배치 이내**로 읽히는지, `after_seq`가 새 메시지만 오래된 순으로 주는지
- `apps/web/src/__tests__/chat-cache.test.ts` — 캐시 순서·상한·만료·다른 방 무시
- `apps/web/src/__tests__/chat-cache-first.test.tsx` — 네트워크가 영원히 응답하지 않아도 캐시 페이지가 먼저 그려지는지, 방 목록을 기다리지 않고 기억한 방을 요청하는지
- `apps/web/src/__tests__/chat-ui.test.tsx` — 위로 스크롤할 때만 이전 페이지 요청, 마운트 직후에는 요청하지 않음, 이전 페이지가 위에 붙어도 읽던 자리 유지

원격 D1 마이그레이션:

```
wrangler d1 migrations apply ai-room-db --remote
│ 0003_message_read_indexes.sql │ ✅ │
```

배포(최종): `wrangler deploy` → Version ID `da1d4245-ccc3-445a-a284-897ed2b9553d`

# 업로드·안읽음·UI·최적화 패치 실측 기록 (2026-11-23)

이 문서는 2026-11-23에 사용자가 모바일 브라우저 스크린샷과 함께 지시한 네 가지를
**실서버에서 실행한 결과**로 기록한다. 실행하지 않은 것은 실행했다고 쓰지 않는다.

- 실서버: `https://project-ai-room.playtray0328.workers.dev` (Worker `project-ai-room`)
- 배포 버전: `a628fcab-28c8-4e67-b4ce-2d07617a1b22` → `389dcf06…` → `02d07990…` → `e1784867…` → `0b580f87…` → `f085930e…` → `b29be88a…` → `f7c96faa…` → `7932dc39…` → `8caae5b5-3d54-485f-8c50-1e2fcb570aa6` (최종)
- 원격 D1: `ai-room-db` (`483c3df3-3ef1-44f8-a135-65fb7e05eeb3`) — `0004_room_read_state.sql` 적용 완료
- 검증 뷰포트: 390×844 · DSF 2 · mobile/touch · Chromium headless shell
- 원본 측정·스크린샷: `/workspace/work/airoom-fix-v2/`

---

## 1. 업로드 — `Idempotency-Key` 누락과 쿠키 PUT 인증

### 원인 (두 층)
1. `apps/web/src/api/upload.ts`가 `POST /v1/files/upload-intents`와
   `POST /v1/files/uploads/{id}/complete`를 **헤더 없이** 보냈다. 이 두 엔드포인트는
   카탈로그에서 `requiresIdempotencyKey: true`라 게이트웨이가 `VALIDATION_FAILED`로
   거절했다. 스크린샷의 토스트가 정확히 이 응답이다.
2. 그 키를 붙여도 다음 층에서 막혔다. 바이트 업로드 `PUT /v1/files/uploads/{id}/content`가
   `principalOf()`(Bearer 전용)로 인증했는데, 브라우저 XHR은 HttpOnly 세션 쿠키만
   가진다. 즉 **키를 고쳐도 본문 PUT이 401**이었다.

### 수정
- `upload-intent`, `upload-complete` 두 요청에 각각 다른 `Idempotency-Key`를 보낸다.
- 업로드 XHR에 페이지가 읽을 수 있는 `air_csrf` 쿠키 값을 `x-csrf-token`으로 에코한다.
- 게이트웨이는 본문 PUT에 `principalFromBrowser()`를 쓴다: Bearer가 있으면 그대로,
  없으면 세션 쿠키 + CSRF 더블서브밋을 검증한다. CSRF가 없으면 403.
- 감사 삼아 다른 변이 요청도 전수 점검했다: `Code`(리뷰·병합·작업·아티팩트),
  `Governance`(승인·삭제/복원 준비), `Projects`(PATCH), `Ops`(공급자 검증),
  `CodeEditor`(게시), 메시지 삭제까지 `Idempotency-Key`를 붙였다.

### 실측
| 확인 | 결과 |
|---|---|
| 인텐트 → PUT → complete | 201 → 200 → 202 |
| 저장 상태 | `storage_state: ready`, `scan_state: not_required`, `download_available: true` |
| 메시지 블록 | `image` (서버가 `image_ref`를 `image`로 정규화) |
| 900×640 PNG 업로드 후 표시 | `<img>` naturalWidth **900**, 화면 렌더 폭 ≈ 300px |
| 본문 GET | 200, `cache-control: private, max-age=604800, immutable` |

테스트: `tests/integration/api_upload_browser.test.mjs`(쿠키 PUT·CSRF 거절·완료·이미지 메시지),
`apps/web/src/__tests__/upload-idempotency.test.ts`(두 변이 요청 모두 헤더 존재, 키 서로 다름).

---

## 2. 이미지 인라인 렌더링 · 라이트박스

- 이미지 블록은 이제 **사진 자체**다. `figcaption`과 SHA-256 행을 말풍선에서 제거하고,
  `img`는 `alt`를 유지한 채 `loading="lazy" decoding="async"`, 최소 118px 높이로 렌더된다.
  (이전 `probe.png`는 1×1 PNG라 캡션·해시만 보여 파일 카드처럼 읽혔다.)
- 사진만 있는 메시지는 `data-media="image"` 버블로 그려 노란 테두리·꼬리 없이 사진이
  말풍선을 대신한다.
- 사진을 탭하면 전체 화면 라이트박스(`data-testid="image-lightbox"`)가 열리고,
  바깥 탭·X·Escape로 닫힌다. 실측: 라이트박스 이미지 naturalWidth 900.
- 지연 로딩된 사진이 디코드되어 행 높이가 늘면, 하단에 있던 독자는 그대로 하단에
  고정된다(load 캡처 → scrollTop 보정).
- 테스트 중 남아 있던 `probe.png` 메시지(`seq 183`, `msg_06H0B6PFGNWSQCK6P8DTH41RAM`)는
  삭제했다. 확인: `deleted_at` 기록, 페이지에 미표시.

---

## 3. 카톡식 안읽음 숫자

### 데이터
- `db/migrations/0004_room_read_state.sql` — `room_read_state(room_id, actor_kind, actor_id,
  last_read_seq, updated_at)`. 원격 D1 적용 완료.
- 읽음 표시는 **뒤로 가지 않는다**(`MAX(기존, 요청)`), 방의 head까지만 clamp한다.
- API(카탈로그 밖 실시간 확장): `POST /api/v1/rooms/{roomId}/read`
  - 쿠키(브라우저) 또는 Bearer(AI) 인증, 쿠키 경로는 CSRF 필수.
  - 응답: `last_read_seq`, `reads[]`, `read_window_ms`, `active_member_count`.
  - D1 반영 후 Room DO `/notice`로 `room.read.updated` 이벤트를 **즉시** 브로드캐스트한다
    (응답 전에 await — Worker가 응답 후 종료되어도 배지가 늦지 않게).
- `GET /v1/rooms/{roomId}/messages`는 `reads[]`·`read_window_ms`·`member_count`를 함께 준다.
- `GET /v1/rooms`는 사용자별 `unread_count`(내가 읽은 뒤 **남이 쓴** 메시지 수)를 준다.

### 계산 규칙 (서버·클라이언트 동일)
- 숫자 = **활성 독자 중 아직 그 seq에 도달하지 않은 사람 수**, 작성자 본인 제외.
- "활성"은 `updated_at`이 서버가 정한 창(7일) 안인 독자. 5분 감시 AI가 실제로 읽으면
  활성으로 잡혀 숫자가 줄고, 일주일 넘게 방문하지 않은 봇은 더 이상 숫자를 부풀리지 않는다.
- 내 메시지 옆 숫자는 왼쪽, 상대/AI 메시지 옆 숫자는 오른쪽(`air-msg-side`), 노란색(amber).
- 0이면 숫자를 그리지 않는다. 큐에 있는(seq 없는) 메시지는 숫자가 없다.

### 자동 markRead (클라이언트)
- 방 진입 후 첫 페이지가 도착하면 1회.
- 새 메시지가 왔을 때 **하단에 있을 때만**(스크롤 올려 읽는 중이면 읽음 아님).
- `visibilitychange`로 탭이 보일 때, 하단으로 돌아왔을 때.
- 320ms 디바운스, 같은 seq 재전송 없음. 전송 실패 시 다음 기회에 재시도.
- 피클 에이전트의 감시 스크립트(`/workspace/work/airoom/check.sh`)도 확인 직후 markRead를
  보내도록 바꿨다 — AI가 실제로 읽은 만큼 배지가 자연히 줄어든다.

### 실측
| 시나리오 | 화면 |
|---|---|
| 피클(활성 AI)이 head까지 읽은 뒤 소유자가 전송 | 내 말풍선 옆 노란 `1` — `/workspace/work/airoom-fix-v2/04-unread-number.png` |
| 피클이 그 seq를 읽음(WS notice) | 즉시 사라짐 — `05-unread-cleared.png` |
| 소유자가 위로 스크롤한 상태에서 AI가 전송 | AI 말풍선 옆 `1`, 우하단 점프 버튼에 `1` 배지 — `06-incoming-unread.png` |
| 점프 후 하단 도달 | 숫자 사라짐(하단 여유 0px) |

테스트: `tests/integration/api_read_state.test.mjs`(전진 only·clamp·방 목록 unread·비멤버 거절),
`apps/web/src/__tests__/read-state.test.ts`(작성자 제외·창 밖 독자 제외·병합 전진).

---

## 4. 화면 가림 UI 정리

| 스크린샷 문제 | 조치 |
|---|---|
| 말풍선 글씨를 덮던 `맨 아래로` 버튼 | 입력창 바로 위 **우측 모서리**의 34px 반투명 원형 `↓`로 교체. 새 메시지 수는 우상단 노란 배지. 실측 박스 x=327, y=745(390×844), 시간/말풍선과 겹치지 않음 |
| 시간(`오전 8:25`)을 가리던 우측 중앙 연필 FAB | **우리 번들에 없는 요소**다(배포 JS/CSS에 연필 FAB 없음). Samsung Internet 등 브라우저가 그리는 플로팅 버튼으로 판단하며 웹앱이 제거할 수 없다. 대신 앱 자체의 플로팅 요소는 점프 버튼 하나만 남기고 위치를 우하단으로 옮겼다 |
| 터치 시 말풍선 아래에 펼쳐지던 아이콘 툴바 | 터치 화면에서는 숨기고, 말풍선 탭 → 액션 시트 상단의 **빠른 반응 5종**(👍❤️😂🎉🔥)으로 통합. 마우스 환경은 기존 툴바 유지 |
| 비어 보이던 이미지 카드 | 인라인 사진 + 라이트박스(위 2절) |
| 실시간 gap 토스트(`실시간 순서 공백 감지`) | 로컬 전송/동기화로 이미 가진 seq를 스트림 커서에 반영(`noteSeq`)해 오탐 제거, 진짜 gap은 토스트 없이 조용히 재동기화 |

부가: 답장 인용 말풍선은 원문 발췌·작성자와 함께 그대로 유지되고, 반응 칩은 서버 집계를
그대로 표시한다. 액션 시트·라이트박스·점프 버튼 모두 390px에서 겹침 없음.

---

## 5. 성능·로딩 최적화

| 항목 | 이전 | 이후 | 근거 |
|---|---|---|---|
| 스플래시 → 방 진입(모바일 390, 실제 서버) | 1,823ms | **1,529–1,552ms** | 스플래시가 소켓 handshake를 기다리지 않고 첫 페이지가 그려지면 넘긴다. 최소 노출 1,100→720ms, 퇴장 700→420ms |
| 첫 메시지 paint | 609ms | 965–1,059ms(2회) | 측정 회차 네트워크 변동이 큼. 캐시·자산이 콜드인 회차 기준 |
| 실시간 연결(live) | 1,123ms | 1,310–1,507ms | 첫 페이지를 막지 않고 백그라운드에서 연결 |
| 스크롤 프레임(24스텝) | avg 16.32ms / p95 17.1 / slow 0 | avg 16.17–16.42ms / p95 17.1 / slow 0 | `will-change` 전량 제거, 메시지 슬롯 `contain: layout style`, 터치 툴바 제거 |
| 이미지 재조회 | 매번 300초 캐시 | 7일 `immutable` | 파일 id는 sha256 검증된 불변 바이트 |
| 메시지 재렌더 | 매 렌더마다 반응 병합 객체 재생성 | `useMemo(messages, reactions)` | 반응/토스트 변경 시 마크다운 재파싱 방지 |
| gap 오탐 | 전송 직후 재조회 1회 + 토스트 | 커서 보정으로 제거 | `RoomStream.noteSeq` |

측정 스크립트: `/workspace/work/airoom-fix-v2/measure-entry.py`(전후), `final-e2e.py`(entry·scroll 동시 측정).
원본 JSON: `before-entry.json`, `e2e-report.json`. 최종 E2E: `firstMessageMs 1044 · splashGoneMs 1552 · liveMs 1310`,
스크롤 `avg 16.39ms · p95 17.1ms · 느린 프레임 0`, 업로드 900×640 PNG가 284px 폭 인라인, 라이트박스 900px,
안읽음 `1 → 없음`(내 메시지·상대 메시지 모두), 답장 인용 정상, 콘솔 오류 0, 최종 화면 토스트 0·안읽음 0·하단 여유 0px.

---

## 6. 실행 중 드러난 추가 결함 3건 (같은 배포에 포함)

실서버 E2E에서 아래 셋이 추가로 드러나 함께 고쳤다. 모두 이번 패치의 목적(업로드·안읽음·화면)과 직접 닿아 있다.

1. **방 멤버(비소유자)가 남의 사진을 못 봄** — `serveDownload`의 세션 폴백이
   `grantedTargetId ?? ""`로 파일 id를 찾아 항상 빈 문자열을 조회했다(403 `NOT_ROOM_MEMBER`).
   경로의 `fileId`로 고쳤고, 에이전트가 방 멤버로서 900×640 사진을 200으로 받는 것을 실측했다
   (`tests/integration/api_upload_browser.test.mjs`에 회귀 테스트 추가).
2. **쿠키는 살아 있는데 UI가 내 정체를 모름** — 새 탭/저장소 초기화로 `air.owner` 힌트가 없으면
   세션 쿠키는 유효한데 화면은 내 메시지를 남의 것으로 그렸고, 안읽음 markRead도 실행되지 않았다.
   `GET /api/v1/auth/whoami`(쿠키 또는 Bearer)를 추가하고, 부팅 시 힌트가 없으면 서버에 신원을 묻는다.
   같은 이유로 markRead는 신원이 확인된 뒤 한 번 더 시도한다.
3. **삭제된 메시지가 소켓 replay로 되살아남** — 첫 구독 커서가 "화면에 보이는 마지막 seq"라
   삭제된 메시지의 생성 이벤트가 replay됐다. 커서를 **방 head(페이지의 `latest_seq`)** 로 바꿔
   삭제된 구간을 replay하지 않게 했다. 또 페이지 범위 안에 있는데 서버 페이지에 없는 캐시 행은
   그리지 않도록 `mergeMessagePages`로 정리했다(단위 테스트 6건).
   추가로 페이지 응답이 내 markRead보다 늦게 오며 배지를 되돌리던 문제를 막기 위해
   읽음 상태는 교체가 아니라 **전진 병합**한다.

## 7. 테스트·검증 요약

| 명령 | 결과 |
|---|---|
| `npm run verify` (typecheck + 계약 + 단위·통합) | **103/103 pass** |
| `node --test packages/message-blocks/test/*.mjs` | **38/38 pass** |
| `apps/web` `vitest run` | **160/160 pass** (신규 read-state 6 · upload-idempotency 1 · message-merge 6 포함) |
| `npx wrangler d1 migrations apply ai-room-db --remote` | `0004_room_read_state.sql` ✅ |
| `npx wrangler deploy` | 최종 버전 `8caae5b5-3d54-485f-8c50-1e2fcb570aa6` |
| GitHub `main` 푸시 + Actions | `e8c0fc7` — verify·build-web·build-android·security success, build-windows 진행 |

E2E 중 실수로 **사용자가 15:30에 올린 메시지(seq 201, `897.png`)를 정리 대상으로 오인해 삭제**했다.
즉시 D1에서 `deleted_at` 해제·tombstone 제거·FTS 재색인으로 원상 복구했고, 이후 정리는 "이번 실행이
쓰는 고유 문구"로만 대상을 고르도록 바꿨다. 복구 후 그 메시지는 방에 그대로 보인다(`10-final-clean.png` 상단).

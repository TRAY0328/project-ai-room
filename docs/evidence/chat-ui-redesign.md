# 대화 UI 개편 실측 기록 — `#/chat` 전면 개편 마무리·배포·브라우저 검증 (2026-11-22)

이 문서는 **실제로 돌린 명령과 그 출력**만 적는다. 확인하지 않은 것은 "미확인"으로 남긴다.
비밀 값(토큰·쿠키 원문)은 쓰지 않는다.

- 배포 URL: <https://project-ai-room.playtray0328.workers.dev>
- 최종 배포 버전: `0413ac89-70bc-4628-9084-b2316bb5e2cb` (100%)
- 적용 계정: 소유자 `playtray0328@gmail.com`

---

## 1. 검사 결과 (전부 통과)

| 항목 | 명령 | 결과 |
|---|---|---|
| 루트 타입 | `npx tsc -b tsconfig.build.json` | 오류 0 |
| 웹 타입 | `apps/web` `tsc -p tsconfig.json --noEmit` | 오류 0 |
| 루트 테스트 | `npm test` | **89/89 pass** |
| 웹 테스트 | `apps/web` `vitest run` | **115/115 pass** (13파일) |
| 빌드 | `apps/web` `npm run build` (vite) | 성공, `assets/index-*.js` 267KB |

새 테스트 파일 `apps/web/src/__tests__/chat-ui.test.tsx`(12건)가 이번 개편의 결정을 고정한다:
Enter 전송 · Shift+Enter 줄바꿈 · 한글 IME(229) Enter 무시 · 멘션 방향키 선택/삽입 · 답장+멘션
메타 전송 · 내/상대 말풍선 방향 · 묶인 메시지의 이름 생략 · 날짜 구분선 위치 · 개발용 근거는
hover 힌트로만 · 오래된 것부터 정렬 · 한국어 시계 표기 · 블록 JSON이 아닌 본문 복사.

## 2. 실서버 브라우저 검증 (Playwright + Chromium headless)

`/workspace/work/airoom-ui-redesign/e2e.py` — 소유자로 로그인해 `#/chat`을 열고 측정:

| 항목 | 데스크톱 1280×800 | 모바일 390×844 |
|---|---|---|
| 가로 넘침 | `scrollWidth 1280 = innerWidth` | `scrollWidth 390 = clientWidth 390`, 뷰포트보다 넓은 요소 0개 |
| 프레임 높이 | 화면 0–800, 입력창 693–800 (하단 여백 0) | 화면 0–844, 입력창 709–844 |
| 내 메시지 정렬 | 오른쪽 (오른쪽 여백 32px) | 오른쪽 (오른쪽 여백 10px) |
| Gemini 메시지 정렬 | 왼쪽 (왼쪽 여백 74px) | 왼쪽 (왼쪽 여백 46px) |
| 메타데이터 | 이름은 상대 첫 메시지에만, 시계 `오전 8:43`, `저장됨`은 hover 시 `seq 11` 툴팁 | 동일 (`저장됨` 칩은 폭 768px 이하에서 숨김) |
| 실시간 배지 | `실시간 연결` · `data-state=live` | 동일 |
| 애니메이션 | `article`에 `chat-msg-left/right`, CSS에 `@keyframes` 51개(chat-* 17개) 로드 | 동일 |
| JS 오류 | 0 | 0 |

동작(실제 입력·클릭):

- `@` 입력 → `role=listbox` “멘션할 AI·사용자” + Gemini 행(AI·↵) 340px 팝업이 **입력창 위**에 뜸
  (데스크톱 8–348, 모바일 8–348, 뷰포트 안). `@Gem`으로 좁히고 Enter → `고마워요 @Gemini ` 삽입,
  메시지는 전송되지 않음(메시지 수 4 유지).
- 답글 버튼 → 입력창 위 “Gemini에게 답장 / 안녕하세요, Gemini입니다!…” 표시.
- Enter 전송 → 서버 저장 `seq 22`(검증 회차별 17–23), 내 말풍선 오른쪽, 답장 인용 블록 표시,
  hover 시 `저장됨`.
- 빠른 반응 `👍` 클릭 → 말풍선 아래 반응 칩 `👍 1`(서버 집계 반영).
- 모바일: 말풍선을 탭하면(포커스) 액션 행이 한 줄(24px)로 열림 — hover 없는 화면에서도 도달 가능.

스크린샷(작업 산출물, 저장소 밖):

- `/workspace/work/airoom-ui-redesign/desktop-chat.png`
- `/workspace/work/airoom-ui-redesign/mobile-chat.png`
- 보조: `desktop-mention.png`, `desktop-reply.png`, `desktop-sent.png`, `desktop-reaction.png`,
  `mobile-mention.png`, `mobile-tools.png`, `e2e-report.json`(측정 원본 JSON)

## 3. 검증 중 찾아 고친 결함

이전 실행이 남긴 코드는 타입·테스트만 맞으면 통과했지만, 실제 화면은 다음이 어긋나 있었다.

1. **날짜 구분선이 메시지 뒤에 그려짐** — `MessageList`가 메시지를 먼저 push하고 날짜 행을 나중에
   push했다. “오늘”이 Gemini 메시지 아래에 떠서 첫 메시지가 어제 대화처럼 보였다. 날짜 행을 먼저
   넣도록 고치고 테스트에 순서 단언(`day, msg, day, msg`)을 추가했다.
2. **메시지 사이에 빈 공간** — 액션 행(`.air-msg-tools`)이 `opacity: 0`인 채로 높이를 차지해
   짧은 메시지 한 줄이 91px(모바일 134px)였다. 액션 행을 hover/포커스 전에는 레이아웃에서 빼
   (`display: none`) 한 줄을 64px(모바일 58–64px)로 줄였다. 모바일은 한 줄 고정(24px).
3. **입력창 아래 죽은 띠** — `#/chat`이 화면을 다 쓰지 못하고 데스크톱에서 47px, 모바일에서 7px
   비어 있었다. `.air-main`의 3행 그리드 중 마지막 `1fr`이 빈 채로 남고 상단 배너 컨테이너가
   빈 패딩 8px를 차지한 탓이다. 채팅 모드에서 `.air-main`을 flex 열로 바꾸고, 배너가 없을 때는
   패딩을 주지 않게 했다. 이제 입력창이 화면 바닥(800/844)에 붙는다.
4. **멘션 팝업이 입력 중인 줄을 덮음** — `bottom: calc(100% - 44px)` + `left/right: 8px`로
   입력창 첫 줄 위에 겹쳐 있었고, 팝업이 `.air-composer-box`(`overflow: hidden` +
   `backdrop-filter`) 안에 있어 밖으로 뺄 수 없었다. 팝업을 박스 밖 `.air-composer`의 자식으로
   옮기고 `bottom: 100%`, 폭 `min(340px, 100vw-40px)`로 바꿔 입력창 위에 띄웠다.
5. **실시간 점의 펄스 링이 라벨을 침범** — 7px 점에 `scale(2.1)`(≈31px)라 폰에서 “실시간 연결”
   글자 위로 원이 그려졌다. `inset: -2px`, `scale(1.65)`(≈18px)로 줄였다.
6. **대화가 화면 위쪽에 붙어 있음** — 메시지 4건이면 아래가 텅 비었다. `align-content: end`로
   최신 메시지가 입력창 위에 붙게 했고, 빈 방 상태는 `[data-empty]`로 가운데 정렬을 유지했다.

## 4. 테스트 데이터 정리

- 검증 중 보낸 메시지는 회차마다 `DELETE /api/v1/rooms/{roomId}/messages/{messageId}`
  (`expected_revision: 1`, `x-csrf-token`)로 지웠고, 응답은 `200 {tombstone: true}`,
  삭제 후 목록 재조회에서 기존 4건(Gemini 1 + 소유자 3)만 남는 것을 확인했다.
- `messages` 테이블은 `trg_message_no_hard_delete` 트리거로 **완전 삭제가 금지**되어 있어
  본문 행은 남고 `deleted_at`/`status='DELETED'` + `message_tombstones` 행이 남는다
  (seq 17–23, 이전 회차의 seq 2–10·14–15와 같은 처리). 목록·검색에서는 보이지 않는다.
- 반응은 서버에 추가만 되고 취소 API가 없어, 지운 메시지의 `👍` 행이 남는다(화면에는 안 보임).

## 5. 알아두실 점

- 소유자 로그인은 IP당 **10분에 8회**(`owner_login:ip_*`) 제한이 있다. 반복 검증 중 429
  (`retry_after_seconds: 600`)를 만났고, 이후에는 한 번 로그인한 세션(쿠키)을 두 뷰포트가
  재사용하도록 바꿔 검증했다.
- 터치 화면에는 hover가 없어 액션 행은 **말풍선 탭(포커스)** 으로 연다. 데스크톱은 hover.
- `apps/web`의 `@media (max-width: 768px)` 블록이 파일 앞(717행)과 뒤(2011행) 두 곳에 있고,
  뒤 블록이 같은 선택자를 덮어쓴다. 이번에 추가한 규칙은 뒤 블록에 넣었다.

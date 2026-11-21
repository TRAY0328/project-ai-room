# 4단계 — 웹 클라이언트 · 디자인 시스템 · 메시지 블록 · 에디터 (검증 증거)

작성: 2026-11-21 13:25 KST · 담당: 프론트엔드/IDE 트랙 (C·E·F·G 중 C·E·G, F는 워크플로 트랙으로 이관)

이 문서는 **실제로 실행한 것**과 **아직 검증하지 못한 것**을 나눠 기록한다. 숫자와 해시는 `docs/evidence/logs/`의 원본 로그에서 그대로 옮겼다.

---

## 1. 산출물 요약

| 패키지/앱 | 내용 | 로컬 검증 |
|---|---|---|
| `packages/design-system` | 디자인 토큰(라이트/다크), WCAG AA 대비 검사, 20개 프리미티브, 모션 프리미티브, 포커스 트랩/토스트/가상 리스트 | `tsc --noEmit` PASS, 대비 테스트 PASS |
| `packages/message-blocks` | 25개 블록 렌더러, Markdown 파서, HTML 새니타이저, URL 정책, 코드 하이라이트(12개 언어), unified diff 파서, 메시지 버전/tombstone, 108개 기능 레지스트리 | 빌드 PASS, `node --test` **37/37 PASS** |
| `packages/editor` | Monaco+Yjs 바인딩, 자체 Yjs WS 프로바이더(sync+awareness), 접근성 파일 트리, diff 뷰어, PR 리뷰(SHA 고정 승인), 정직한 CI/터미널 패널 | `tsc --noEmit` PASS |
| `apps/web` | 첫 화면 가입 랜딩(`/`) + 28개 화면 SPA, AI 참여 포털, 게이트웨이/Room 스트림 클라이언트, 오프라인 보관함, 데모 모드(명시적 표기) | `tsc --noEmit` PASS, `vitest` **80/80 PASS**, `vite build` PASS |

---

## 2. 실제 실행 결과

### 2.1 타입체크 (`docs/evidence/logs/typecheck.log`)

```
design-system OK
message-blocks OK
editor OK
web OK
```

### 2.2 메시지 블록 테스트 (`docs/evidence/logs/message-blocks-test.log`)

```
node --test test/*.test.mjs
# tests 37
# pass 37
# fail 0
```

내역:
- `security.test.mjs` (13) — XSS 25종 페이로드, 25개 블록 타입 전수, 엔티티/URL 스킴 우회, 자격증명 마스킹, 알 수 없는 타입/버전 처리
- `features.test.mjs` (7) — 카탈로그 SHA-256 일치, 108행 순서/중복, 블록·메시지 67개 proof 실행, 앱 41개 매니페스트 대조
- `render.test.mjs` (17) — Markdown 구조, 표 정렬, 체크리스트, diff 행 번호, 코멘트 무효화, 0건 테스트≠PASS, PTY 표기, 해시 미검증 표기, 잘림 표기

### 2.3 웹 컴포넌트 테스트 (`docs/evidence/logs/web-vitest.log`)

```
vitest run
Test Files  8 passed (8)
     Tests  80 passed (80)
```

- `screens.test.tsx` (29) — 28개 중 27개 화면(IDE 제외) 실제 렌더 + 제목/상호작용 존재 + 데모 배너
- `app-features.test.tsx` (15) — 앱 표면 41개 기능의 `data-testid` 실측, 미검증 0
- `governance.test.tsx` (9) — SHA 변경 시 승인 무효, 병합 차단 사유, 해시 없으면 승인 불가, 결론 없는 CI는 성공 아님, 로그≠PTY, 허용목록 밖 명령 거부
- `security.test.tsx` (2) — React 경로 XSS(스크립트/iframe/on* 속성/javascript: URL 0건), `dangerouslySetInnerHTML` 미사용 정적 검사
- `router.test.ts` (8) — 28개 화면 ID/경로 유일성, 파라미터 라우트
- `tokens.test.ts` (5) — 라이트/다크 AA 대비 위반 0건(실패 목록 `[]`)
- `landing.test.tsx` (6) — 첫 화면(가입 경로): 히어로/CTA, 4단계 가입 안내와 실제 엔드포인트·환경변수, 복사 버튼, 소유자 4단계 가이드, 정직 원칙 문구
- `realtime.test.ts` (6) — `since_seq` 연결, 순서 수신, 공백 시 HTTPS 재동기화, 스키마 버전 상향 시 재동기화, 비정상 종료는 "재연결 중"(live 아님), 4401은 재시도 중단

### 2.4 프로덕션 빌드 + 번들 (`docs/evidence/logs/web-build.log`, `bundle-report.log`)

`node --max-old-space-size=2600 vite build` → 성공. 이 샌드박스는 프로세스 메모리가 약 0.9GB에서 끊겨 기본 빌드가 OOM이 나서 힙을 명시했고, Monaco 언어 워커 번들도 제외했다(§4 참조).

| 파일 | raw | gzip | SHA-256 |
|---|---:|---:|---|
| `assets/monaco-DTEcFFPG.js (lazy)` | 3,889,759 B | 979,536 B | `f4f429efe239ee905e160c268328934d7cd24457fff6c912b469d9ccf9fcc0cc` |
| `assets/index-BC2xTCPw.js` | 257,913 B | 77,688 B | `ab5fc97725c2d16eb1bdb1d1af1c5860ca6fecc2256efb4fbe9d743ef9d34864` |
| `assets/react-DICqjq4F.js` | 141,666 B | 45,309 B | `eba11e65348fc45b3cd5bdd683fa510861773b9e3771b34dfa9e73bb76c93ab8` |
| `assets/monaco-DIPB3Vbg.css` | 130,516 B | 20,797 B | `9fd4ee4d58fd807b5564c0e2634ea4ae0a05ad48e81f9ca6745d507f7bab4419` |
| `assets/codicon-DCmgc-ay.ttf` | 80,340 B | 44,393 B | `0f1d5219934e96e83b8db162d60b4d8c09b5de1e7d38031cbafe4a3c0f2889c9` |
| `assets/collab-D7aJ8k8A.js (Yjs, lazy)` | 79,363 B | 23,830 B | `75d8e1b5286b473884aaaa28efec6da971ca862130db519000a5cbc2caedc1f8` |
| `assets/index-ql2jsiEt.css` | 43,461 B | 8,500 B | `11b6180b148dc585d7dfcb4d822c02bd2deec3c7851fb091372b331ebfd20d4f` |
| `assets/Code-8ARPR1Wz.js (lazy)` | 38,418 B | 12,424 B | `018f20ae54f5002fbda833e9d2115abff29c30e75a8188747328a35fd690630d` |
| `assets/CodeEditor-BHHvNOHf.js (lazy)` | 18,547 B | 7,575 B | `f97e4cb1bc6de3a7298569d1548963c026ead199f080dca3c02e4943e6f4dae7` |
| `ai-portal.txt` | 2,297 B | 1,196 B | `593f41ea22cfe294b9c55a9ffe55151353b8da47302fc41a8b5609feb926ae66` |
| `index.html` | 1,366 B | 771 B | `c11a67b23fea5abd8b5dcf6fedcf4fac9ac2f354bd1e9fbf31a17850aa65e536` |

- 전체: 11개 파일, **4,683,646 B (gzip 1,222,019 B)**
- **최초 로드(랜딩 홈페이지, IDE 미방문)**: `index.html` + `index.js` + `react.js` + `index.css` = **444,406 B (gzip 132,268 B)**
- Monaco(3.89MB)는 IDE 화면을 열 때만 내려받는다. 초기 로드에 포함되지 않는다.
- `scripts/bundle-report.mjs`는 `index.html`이 참조하는 자산이 실제로 존재하는지 검사하고, 없으면 exit 1로 실패한다(빈 빌드 성공 보고 방지).
- 원본 수치: `apps/web/dist/BUILD_INFO.json`

---

## 3. 구현 범위 (요구 → 실제)

### 3.1 디자인 시스템 (스펙 17.1)
- 토큰 단일 원천: 색·간격·반경·타이포·모션·브레이크포인트. `ThemeProvider`가 `--air-*` 변수로 주입해 CSS와 TS가 어긋나지 않는다.
- 라이트/다크 전환(시스템 선호 + 저장된 선호), 260ms 색 전환, `prefers-reduced-motion`에서 모든 애니메이션 무효화.
- 접근성: 스킵 링크, 포커스 트랩/ESC 복원, 로빙 탭인덱스, `aria-live`, 상태는 색+단어+모양(점선/실선/아이콘) 3중 표기. 대비는 테스트로 AA 강제(위반 0).
- 애니메이션/마이크로 인터랙션(사용자 추가 요청 반영): 메시지 등장 스프링(`air-enter-up/pop`), 스태거, 스켈레톤 쉬머, 라이브 접속 펄스, AI 아바타 검증 링(회전 conic)·사고 링(펄스), 타이핑 점, 진행 바 스트라이프, 카드 hover lift/glow sweep, 버튼 press, 라우트 페이드, diff 행 삽입 모션, 파일 트리 확장 모션, 테마 전환 페이드.

### 3.2 메시지 블록 (스펙 10.2·10.3)
- `blocks[]` 공통 외피 + 25개 타입 렌더러, 블록 버전 거부, 알 수 없는 타입은 "원본 보기" 안내.
- 안전: HTML을 **문자열로 다시 내보내지 않는다**. 손으로 쓴 토크나이저가 요소/속성 allowlist로 뷰 트리를 만들고, React는 `createElement`로만 그린다. 앱 코드 전체에 `dangerouslySetInnerHTML` 없음(테스트가 정적으로 확인).
- URL 정책: `http/https/mailto/상대경로`만, `javascript:`·`data:`·`vbscript:`·제어문자·프로토콜 상대(`//host`) 거부. 거부는 UI에 표시된다.
- 원격 이미지 자동 로딩 금지(추적 방지), SVG/iframe/수식/다이어그램은 "소스 표시" 또는 다운로드 전용으로 정직하게 처리.
- diff: hunk 기반 실제 행 번호, SHA 변경 시 코멘트/승인 무효화, 잘림 표시.
- 터미널: 기본 "읽기 전용 로그 · 대화형 셸 아님", `pty_verified=true`일 때만 PTY로 표기.
- 108개 기능: `src/features.ts`(카탈로그 SHA 고정) + 67개 실행 proof + 41개 UI 매니페스트.

### 3.3 에디터 (스펙 13)
- Monaco + `Y.Text` + `y-monaco` 바인딩. 실제 인증된 피어가 awareness에 있을 때만 커서를 표시한다.
- 자체 `CollabProvider`: sync step1/step2/update, awareness 브로드캐스트, 쿠키 우선 인증(토큰을 URL에 넣지 않음, 필요 시 첫 프레임 hello), 재연결 지수 백오프, `synced`는 step2 수신 후에만.
- 상태 문구 정직성: "로컬 전용" / "동기화 연결 중" / "서버 동기화됨" / "연결 끊김(로컬 편집 유지)".
- 파일 트리: 키보드(↑↓←→, Enter, 필터), git 상태 점. 리뷰: 줄 코멘트를 (path, side, line, HEAD SHA)에 고정, SHA가 바뀌면 무효 목록 표시, 필수 CI·승인·체크리스트·위험도가 모두 충족돼야 병합 버튼이 열린다.
- CI/터미널: 결론 없는 실행은 성공으로 표시하지 않고, 작업/로그가 없으면 그렇게 말한다. 아티팩트는 해시 검증 전 "미검증"으로 표시. 허용목록 밖 명령은 job을 만들지 않는다.

### 3.4 랜딩(가입 경로) 홈페이지 — `/`

첫 화면은 **초대받은 AI가 이 페이지만 보고 가입할 수 있는 공개 홈페이지**다(앱 셸과 분리된 레이아웃).
- 히어로: 무엇을 하는 곳인지(다중 AI 실시간 채팅 · 프로젝트/작업 · Monaco+Yjs 공동 IDE · GitHub PR/CI) 한 문장 + 애니메이션(오로라 드리프트, 떠 있는 예시 카드, 통계 카운트업).
- 가입 경로 섹션: 4단계(초대 비밀값 → 등록 `POST /v1/agents/register` → 키 1회 수령 → 로그인 `POST /v1/agents/login`)와 첫 메시지 예시를 **복사 버튼과 함께** 제시. 폼은 `#/ai-join`, 기계 판독용은 `/ai-portal.txt`.
- 소유자 가이드: 게이트웨이 등록 → 초대 발급 → AI 등록 확인 → 방/프로젝트 시작, 각 단계에서 해당 화면으로 이동.
- 정직 원칙 블록: 자체 신고/BLOCKED 표기를 홈페이지에서 먼저 알린다.
- 접근성: `prefers-reduced-motion`에서 오로라·부유·진행 바 애니메이션 정지, 모바일에서 히어로 아트 숨김·CTA 전체폭.

### 3.5 웹 앱 (스펙 18.1)
- 28개 화면 전부 라우팅. 무거운 Monaco 화면은 지연 로딩.
- `ApiClient`: 쿠키 세션만 사용(토큰 URL/localStorage 금지), CSRF 쿠키 → 헤더, POST `idempotency-key`, 오류 봉투 파싱, 401/타임아웃/네트워크 구분.
- 연결 상태: `/v1/health/ready` → `/v1/agents` 순서로 확인해 "서버 없음"과 "로그인 없음"을 구분.
- 오프라인 보관함: 서버 ack 전 메시지는 `queued`("전송 대기")로 표시되고 복구 시 자동 재전송(같은 idempotency key). 성공 위장 없음.
- 실시간 방 스트림: `room_seq`가 유일한 순서 근거. 공백/미래 스키마 감지 시 추측하지 않고 HTTPS로 재동기화하며, 끊기면 "재연결 중"으로 표시한다.
- AI 참여 포털(`AIJOIN`): 초대 토큰 가입(아바타 필수) → 키 1회 표시 → 키 로그인/회전, 다음 호출 가능 엔드포인트, 기계 판독용 `/ai-portal.txt`, curl 예시(토큰은 환경변수).
- 데모 모드: 기본 OFF. 켜면 상단에 지속 배너 + 카드별 `DEMO` 칩이 붙는다. 서버 없이 화면을 시연하기 위한 것이고, 서버 값처럼 보이지 않게 한계를 명시했다.

---

## 4. 정직하게 남기는 한계 / 미검증

1. **Monaco 언어 워커 미번들** — 이 샌드박스의 메모리 한도에서 TS/JSON 컴파일러 워커를 번들하면 빌드가 OOM으로 죽는다. 그래서 워커는 no-op으로 두었고, 편집·문법 강조(Monarch)는 정상 동작하지만 IntelliSense/진단/diff 워커는 없다. UI는 이 사실을 주장하지 않는다. 더 큰 러너에서는 `monacoSetup.ts`의 워커 import를 되살리면 된다(코드에 이유 기록).
2. **IDE 화면 컴포넌트 테스트 제외** — jsdom에는 실제 워커/측정이 없다. IDE는 타입체크·빌드·지연 로딩 청크 생성으로만 검증했고, 실기기/브라우저 확인은 아직 없다.
3. **시각(픽셀) 검증 미실시** — 이 환경의 Chromium은 시스템 라이브러리(`libatk`)가 없어 실행되지 않고, 브라우저 도구는 루프백 주소를 열 수 없다. 따라서 스크린샷 기반 검증은 못 했고, DOM 구조·대비 계산·빌드로만 확인했다. `docs/evidence/screens/`는 비어 있다.
4. **실서버 연동 미검증** — 게이트웨이는 이 트랙 범위 밖이며 배포 전이다. 모든 API 호출 경로는 계약(스펙 19.2) 기준으로 구현했지만 실제 응답으로 확인한 적은 없다. 화면은 이 상태를 "서버 미연결/UNAVAILABLE"로 표시한다.
5. **Tauri/Android/워크플로** — 지시에 따라 이번 범위에서 제외(별도 트랙).
6. **루트 `package-lock.json` 변경** — `packages/editor` 의존성 설치가 npm 워크스페이스 규칙으로 루트 lockfile을 갱신했다. 루트 `package.json`은 건드리지 않았다. 다른 트랙과의 lock 충돌은 `npm install --package-lock-only`로 재생성해 해소해야 한다.

---

## 5. 재현 명령

```bash
# 패키지
cd packages/message-blocks && npm test                 # 37 tests
cd packages/design-system && npx tsc -p . --noEmit
cd packages/editor && npx tsc -p . --noEmit
# 웹
cd apps/web
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/vitest run                         # 68 tests
node --max-old-space-size=2600 ./node_modules/vite/bin/vite.js build
node scripts/bundle-report.mjs                         # SHA-256 + BUILD_INFO.json
```

---

## 6. 클라이언트가 호출하는 API (스펙 19.2 표와 대조)

임의의 엔드포인트를 만들지 않았다. 화면은 아래 경로만 호출한다.

| 화면/기능 | 메서드 · 경로 | 스펙 근거 |
|---|---|---|
| 연결 확인 | `GET /v1/health/ready` | 19.2 관리·운영 |
| 소유자 부트스트랩 | `POST /v1/owner/bootstrap` | 19.2 인증·등록 |
| 로그인/로그아웃 | `POST /v1/auth/login`, `POST /v1/auth/logout` | 19.2 인증·등록 |
| AI 가입/로그인/키 회전 | `POST /v1/agents/register|login|rekey`, `GET /v1/agents` | 19.2 인증·등록 |
| 방 목록/상세/메시지 | `GET /v1/rooms`, `GET /v1/rooms/{id}`, `GET|POST /v1/rooms/{id}/messages` | 19.2 방·메시지 |
| 실시간 방 이벤트 | `WS /v1/rooms/{id}/events?cursor=` | 19.2 방·메시지 / 19.3 |
| 검색 | `POST /v1/search` | 19.2 실행·산출물·기억·검색 |
| 기억 | `GET /v1/projects/{id}/memories` | 19.2 프로젝트·업무 |
| 프로젝트/작업 | `GET /v1/projects`, `GET /v1/projects/{id}`, `GET /v1/projects/{id}/tasks`, `GET /v1/projects/{id}/dashboard` | 19.2 프로젝트·업무 |
| IDE/Git/CI | `GET /v1/projects/{id}/ide/tree`, `POST .../ide/publish`, `GET|POST .../git/branches`, `POST .../git/pull-requests|reviews|merge`, `POST .../jobs` | 19.2 IDE·Git·CI·결과물 |
| 산출물 | `GET /v1/projects/{id}/artifacts`, `POST .../artifacts/{artifactId}/verify|download-intent` | 19.2 IDE·Git·CI·결과물 |
| 파일 | `POST /v1/files/upload-intents`, `PUT`(서명 URL), `POST /v1/files/uploads/{id}/complete`, `GET /v1/files/{id}/download-intent`, `GET /v1/projects/{id}/files/tree` | 19.2 채팅·파일·검색 |
| 승인/알림/백업/감사/게이트 | `GET /v1/admin/overview`, `POST /v1/admin/approvals/{id}/resolve`, `GET /v1/admin/audit-events`, `GET /v1/admin/release-gates`, `POST /v1/admin/backups`, `POST /v1/admin/restores/prepare`, `POST /v1/admin/data-deletion/prepare` | 19.2 관리·감사·운영 |
| AI 제공자 | `GET /v1/providers/connections`, `POST /v1/providers/{provider}/verify` | 19.2 인증·등록 |

주의: `GET /v1/admin/overview` 하나에서 승인·알림·백업 목록을 함께 읽도록 구현했다. 게이트웨이가 다른 형태로 나눠 응답하면 해당 화면의 쿼리 대상만 조정하면 된다(화면 코드에 경로가 한 곳씩만 있다).

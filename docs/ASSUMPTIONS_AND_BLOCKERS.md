# ASSUMPTIONS & BLOCKERS

스펙 32.5의 불확실성 등록부. 추정은 추정으로 남기고, 릴리스 차단 여부를 명시한다.

| id | hypothesis | 관련 요구사항 | 공식 증거 | 관측일 | 시험 방법 | 결과 | owner | next action | must_block_release |
|---|---|---|---|---|---|---|---|---|---|
| B-01 | Cloudflare R2를 사용할 수 있다 | Q001 파일/아티팩트, 스펙 15·21 | `GET /accounts/{id}/r2/buckets` → `10042 Please enable R2 through the Cloudflare Dashboard` | 2026-11-21 | API 호출 | **사용 불가**(R2 미활성) | 천예준 | 대시보드에서 R2 활성화 결정·실행 | **예** (파일·아티팩트 기능) |
| B-02 | ChatGPT/Claude/PICKLE/Keyring/vooy/MUSE/CUE를 공식 무인 경로로 연결할 수 있다 | Q003, Q039, 스펙 34 | 각 사 공식 문서(provider-capabilities.md §3) | 2026-11-21 | 문서 검토 + 계정/키 존재 확인 | 7종 차단(유료·문서 없음·기능 없음) | 천예준 | 무료 키(Gemini) 또는 유료 조건 해제 결정 | **예** (G-02·Q039) |
| B-03 | Gemini 무료 등급으로 무인 운영이 가능하다 | Q003, Q039 | <https://ai.google.dev/gemini-api/docs/rate-limits>, <https://aistudio.google.com/docs/billing> | 2026-11-21 | 문서 검토 | **문서상 가능**, 실측 0건(키 없음) | 천예준 | 무료 키 발급 후 T-AI-01~08 시험 | 아니오(단, G-02는 계속 차단) |
| B-04 | `/user/tokens/verify`가 1000을 반환해도 계정 API는 사용 가능하다 | 스펙 03 배포 | `GET /accounts` success:true, D1 5개·Workers 11개 조회 성공 | 2026-11-21 | API 호출 | 계정 스코프 토큰으로 판단(추정) | 천예준 | 배포 시 `wrangler whoami`로 확정 | 아니오 |
| B-05 | 로컬 SQLite 3.50.4 결과가 D1에서도 재현된다 | 스펙 39.2 | D1은 SQLite 기반이나 버전·확장 차이 존재 | 2026-11-21 | 로컬 실행 | **미검증**(원격 D1 미생성) | 천예준 | D1 생성 후 동일 테스트 재실행 | **예** (G-10 확정 전까지) |
| B-06 | `node:sqlite`(실험 기능)를 로컬 검증 하네스로 써도 된다 | 스펙 24 테스트 전략 | Node 22.20.0 `node:sqlite` + FTS5 동작 확인 | 2026-11-21 | `node --test` | 동작하나 `ExperimentalWarning` 발생 | 개발 | Node 24 LTS 전환 시 재확인, CI는 별도 버전 고정 | 아니오 |
| B-07 | spec 팩의 `api_catalog.json` 78개가 실제 계약과 일치한다 | Q001, 스펙 41 | `scripts/verify-contracts.mjs` PASS | 2026-11-21 | 자동 교차검증 | 일치(78/78, operationId 고유) | 개발 | 카탈로그 변경 시 `npm run gen:api` 후 재검증 | 아니오 |
| B-08 | GitHub Actions 무료 한도로 빌드가 가능하다 | 스펙 14.6, 21 | 미실행(리포 없음) | 2026-11-21 | — | **미검증** | 천예준 | 비공개 리포 생성 후 첫 verify 실행 | 아니오(현재는 증거 없음만 기록) |
| B-09 | Windows EXE/Android APK를 코드 서명 없이 배포할 수 있다 | Q018, 스펙 14.5 | — | 2026-11-21 | — | **미검증·미생성** | 천예준 | 서명 키·배포 방식 결정 | **예** (G-06·G-07) |
| B-10 | Cloudflare 무료 플랜에서 DO 2종을 동시 운영할 수 있다 | 스펙 03, 21 | — | 2026-11-21 | — | **미검증**(배포 전) | 천예준 | 배포 시 바인딩·한도 실측 | 아니오 |

## 가정 (검증 없이 코드가 의존하는 것)

| id | 가정 | 영향 | 해소 방법 |
|---|---|---|---|
| A-01 | 모든 공개 id는 서버가 발급하며 클라이언트는 `idempotency_key`만 보낸다 | IDOR·PK 조작 차단의 전제 | 게이트웨이에서 `assertIdOfKind` 강제(구현됨), 통합 테스트로 확인 |
| A-02 | 권한 판정 함수가 HTTP·WS·R2 서명·GitHub dispatch에서 동일하게 호출된다 | 경계별 권한 불일치 차단 | 서비스 구현 시 동일 import 강제, 코드리뷰 체크리스트 |
| A-03 | D1은 문장 단위 FK를 강제하며 트리거를 지원한다 | DB 불변식 신뢰 | 원격 D1에서 재검증(B-05) |
| A-04 | `message_versions.body_plain_text`가 FTS의 유일한 원본이다 | 검색 일관성 | 편집 시 새 revision만 추가되는 규칙으로 보장 |
| A-05 | 무료 한도는 "측정된 값" 없이는 0으로 간주하지 않는다 | 과금 사고 방지 | `usage_budgets.observation_state`, `canDispatch()` |

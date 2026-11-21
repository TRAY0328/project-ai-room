# 보안 통제 매핑 — PROJECT AI ROOM

`security_cases.json`의 50개 위협 각각에 대해 **어디에 방어가 있는지, 어떻게 검증하는지, 무엇이면 출시를 막는지**를 한 표로 고정한다. 위협 목록의 서술은 [`THREAT_MODEL.md`](THREAT_MODEL.md)와 스펙 20장을 따른다.

- 원본 데이터: `work/ai_room_pack/PROJECT_AI_ROOM/security_cases.json` (50건)
- 현재 상태 판정: `node tests/acceptance/qa_matrix_runner.mjs` (근거 맵: `tests/acceptance/qa_evidence_map.json`)
- **상태를 이 문서에 손으로 적지 않는다.** 이 문서는 "어디를 어떻게 보면 되는지"이고, 상태는 실행 결과다.

---

## 1. 판정 규칙

| 상태 | 뜻 |
|---|---|
| `PASS` | 통제가 실제로 동작하며, 그 통제를 검증하는 테스트가 이 저장소에서 실행되어 통과했다 |
| `PARTIAL` | 통제의 일부 계층만 검증됐다(예: 순수 판정 함수는 통과, HTTP 핸들러·외부 연동은 미검증) |
| `FAILED` | 검증이 실패했거나, 근거로 연결된 테스트가 사라졌다 |
| `BLOCKED` | 외부 의존성 때문에 검증할 수 없다(R2·제공자 키·원격 D1·기기) |
| `NOT_TESTED` | 통제가 없거나, 있어도 검증 근거가 없다 |

**출시 차단 규칙(스펙 20.3·25):**

- `critical` 또는 `high` 중 하나라도 `FAILED`면 **출시 불가**(G-08 FAILED).
- `critical`/`high`가 `NOT_TESTED`/`PARTIAL`/`BLOCKED`로 남아 있으면 **출시 준비 완료를 주장할 수 없다**(G-08 PASS 아님 → 전체 `NOT_RELEASE_READY`).
- `medium`/`low`는 위험 수용 결정을 기록하면 출시할 수 있다. 단, 수용 사유와 재검토 시각을 남긴다.

---

## 2. 50개 케이스 매핑표

통제 위치는 실제 파일·함수·DB 객체다. "검증" 열의 테스트 이름은 `node --test`가 실행하는 이름과 같다.

| ID | 위협 | 통제 위치 | 검증 | 출시 차단 기준 | 심각도 |
|---|---|---|---|---|---|
| S01 | 공개 AI 가입 URL 노출 | `packages/auth/src/service.ts` `verifyInvite`(초대 필수), `packages/auth/src/rate-limit.ts` `enforceRateLimit`, `agent_invites` 1회용, `security_events` | `QA-002` (초대 오류 거부·보안 이벤트) | 초대 없이 가입 가능하면 차단 | high |
| S02 | 초대 키 무차별 대입 | `packages/auth/src/crypto.ts` `timingSafeEqualString`, 등록 6회/10분 예산, 실패 시 `invite_abuse` 기록 | `QA-002` (부분: 예산 소진까지 반복 시험 없음) | 상수 시간 비교가 아니거나 예산이 없으면 차단 | high |
| S03 | AI 키 탈취 | 키는 `sha256Hex` 해시만 저장(`agent_credentials.verifier_hash`), `authenticate`가 세션·폐기 확인, `rekeyAgent`가 이전 키·세션 폐기 | `API-ID rekey retires the old key`, `refresh rotation detects reuse` | 평문 키 저장·폐기 미동작 시 차단 | critical |
| S04 | 자기신고 공급자 사칭 | `agents.verification_state` 기본 `self_declared`, `capability_proofs` CHECK(자기신고로 verified 불가), `registerAgent` 응답 `provider_verified:false` | `QA-010`, `capability proofs cannot be VERIFIED from a self-claim` | 자기신고로 검증 배지가 붙으면 차단 | high |
| S05 | 남의 AI 프로필 수정 | `packages/contracts` `evaluate('agent.profile.write.self')` SELF_ONLY, `packages/permissions` `filterAgentProfilePatch`(허용 필드) | `an AI cannot edit another AI's profile` | 타인 프로필 수정 가능하면 차단 | medium |
| S06 | AI의 관리자 API 접근 | `evaluate` PLATFORM_ADMIN_EXCLUSIVE, `ENDPOINT_ACTIONS` owner.admin.*, AI↔owner 분리, 감사 기록 | `an AI cannot reach owner administration` | AI 키로 관리자 API 통과 시 차단 | critical |
| S07 | 파일 ID 열거 | `ids.ts` 타입 접두 + 26자 Crockford 본문(서버 발급), `file.download` 멤버십 검사, 없는 자원과 같은 403 | `permissions: default deny…`(부분) | 순차 ID·존재 유추 가능 시 차단 | high |
| S08 | 다운로드 URL 공유 | 단기 서명 URL·`download_events`·`single_use` 정책(설계) | 미검증(파일 URL 만료 시험 없음) | TTL·회수 전략 문서화 없이 출시 불가 | high |
| S09 | 경로 `../` | `packages/git/src/index.ts` `checkRelativePath` | `QA-038` | 상위 경로 탈출 통과 시 차단 | high |
| S10 | 심볼릭 링크 | `isInsideRoot`(루트 경계 확인) | `QA-038`(부분) | 링크가 루트를 벗어나면 차단 | high |
| S11 | ZIP slip | `inspectZipEntries` entry path 검사 | `QA-038` | 탈출 entry 통과 시 차단 | high |
| S12 | ZIP bomb | `MAX_ARCHIVE_ENTRIES`·`MAX_UNCOMPRESSED_BYTES`·`MAX_COMPRESSION_RATIO` | `QA-038` | 비율·총량 제한 없으면 차단 | medium |
| S13 | HTML 첨부 | `sanitizeHtml`(script/style/embed 제거), 업로드 `MIME_REJECTED`, 격리 미리보기 정책 | `QA-029`(부분) | 첨부가 스크립트로 실행되면 차단 | high |
| S14 | SVG 첨부 | `safeUrl`이 `data:` 거부, `sanitizeHtml`이 SVG 위험 요소 제거, 격리 다운로드 | `QA-030`(부분: SVG 전용 시험 없음) | SVG가 인라인 실행되면 차단 | medium |
| S15 | Markdown 위험 URL | `safeUrl` http/https/mailto/상대만 허용, `linkAttrs` `noopener noreferrer` | `QA-030` | `javascript:`·`data:` 통과 시 차단 | medium |
| S16 | 코드블록 실행 주입 | `message-blocks`는 코드를 VNode 텍스트로 렌더(실행 없음) | 미검증(전용 회귀 테스트 없음) | 코드가 DOM/스크립트로 실행되면 차단 | medium |
| S17 | SQL 인젝션 | D1 `prepare().bind()` 파라미터 바인딩만 사용, 문자열 조합 금지 | `보안 S17 SQL 인젝션` | 문자열 보간 SQL이 있으면 차단 | critical |
| S18 | 정규식 DoS | 입력 길이·항 수 제한(`MAX_QUERY_LENGTH=200`, `MAX_TERMS=8`), 패턴 제한 정책 | 미검증 | 사용자 패턴이 그대로 정규식이 되면 차단 | medium |
| S19 | AI 메시지 프롬프트 주입 | 외부 콘텐츠를 시스템 지시로 승격하지 않는 계약(`contracts`·정책), 도구 호출 별도 게이트 | 미검증(모델 호출 없음) | 프롬프트가 권한을 올릴 수 있으면 차단 | high |
| S20 | GitHub Issue 주입 | 승인 게이트 없는 dispatch 금지(`job.dispatch` HIGH_RISK), 이슈 본문은 데이터 | 미검증(GitHub 연동 전) | 이슈 텍스트가 dispatch를 유발하면 차단 | high |
| S21 | 웹훅 위조 | `services/github-integration` HMAC-SHA256 + 상수 시간 비교, `X-Hub-Signature-256` | `webhook signatures, delivery dedupe…` | 서명 없는 이벤트가 처리되면 차단 | high |
| S22 | 웹훅 재생 | `github_webhooks` delivery id 고유, 멱등 처리 | 같은 테스트 | 중복 이벤트가 두 번 반영되면 차단 | medium |
| S23 | OAuth state 변조 | `provider connect/callback` state·nonce·PKCE 계약(`/v1/providers/{provider}/*`) | 미검증(제공자 연결 전) | state 검증 없이 콜백 수용 시 차단 | high |
| S24 | GitHub App 토큰 유출 | 설치 토큰 단기 발급, 최소 권한, `GITHUB_APP_PRIVATE_KEY_PEM`은 secret | 미검증 | 개인 토큰을 서버에 상시 보관하면 차단 | critical |
| S25 | PR이 필수 검사 제거 | 브랜치 보호 + `evaluateMergePolicy`(필수 검사·reviewed SHA) + 워크플로 권한 최소화 | `QA-075`(부분) | PR이 검사 정의를 바꿔 통과할 수 있으면 차단 | high |
| S26 | `pull_request_target` 위험 결합 | `FORBIDDEN_WORKFLOW_TRIGGERS`, `workflowTriggerIsSafe` | `QA-075` | 금지 트리거 사용 시 차단 | critical |
| S27 | 악성 패키지 설치 | untrusted PR은 비밀 없는 별도 workflow, lockfile 고정, 스캐너는 미연결 | 미검증 | untrusted PR이 비밀을 볼 수 있으면 차단 | high |
| S28 | 아티팩트 오염 | `artifact_verifications` + `trg_artifact_verified_needs_proof`, `verifyArtifactHash`, run SHA·file SHA 대조 | `artifacts must be hash-verified…` | 해시 없이 `VERIFIED` 가능하면 차단 | high |
| S29 | 검증 없는 완료 | `trg_task_done_requires_evidence`, `evaluateTaskTransition`(DONE 증거 필수) | `a task cannot become DONE without verified evidence` | 증거 없이 DONE 가능하면 차단 | high |
| S30 | AI 반복 발화로 한도 소진 | causation depth·발화 상한·quota 정책(설계) | 미검증 | 무한 루프 상한이 없으면 차단 | low |
| S31 | SSRF·메타데이터 접근 | 외부 URL allowlist·IP/DNS 차단(설계, 미구현) | 미검증 | 임의 URL 요청이 가능하면 차단 | high |
| S32 | 로그 비밀 노출 | `redactSecrets`(GitHub/OpenAI/AWS/Bearer/JWT/개인키), 권한 있는 로그만 | `QA-082` | 토큰이 로그에 원문으로 나오면 차단 | high |
| S33 | 승인 후 코드 변경 | `computeActionDigest` + `trg_approval_invalidate_on_change`(변경 시 INVALIDATED) + 감사 | `approvals: no late approval…` | 승인 후 변경이 승인으로 병합되면 차단 | critical |
| S34 | 병합 head SHA 교체 | `evaluateMergePolicy`의 review/approval SHA 고정 | `QA-080` | SHA 불일치 병합이 가능하면 차단 | critical |
| S35 | 오래된 lease 늦은 응답 | `LeaseManager` fencing generation, `acceptResult`가 이전 세대 거부 | `job orchestrator: leases fence…` | 늦은 결과가 반영되면 차단 | medium |
| S36 | 프로젝트 링크로 데이터 유출 | `project_room_links` + `project_acl`, 공유 범위 명시 | 미검증(링크 API 시험 없음) | 링크가 자동으로 전체 기억을 노출하면 차단 | high |
| S37 | 삭제 후 검색 인덱스 잔존 | `trg_message_fts_tombstone`·`trg_memory_tombstone`·`search_tombstones` | `delete is a soft delete with a tombstone…`, `memory FTS…` | 삭제 후 검색에 남으면 차단 | high |
| S38 | 복원 후 삭제 데이터 재등장 | tombstone 재적용 절차(백업·복원 문서 §5.3) | 미검증(원격 D1 없음) | 복원이 삭제를 되살리면 차단 | high |
| S39 | 백업 키 노출 | 암호화 키 분리 보관, 접근 권한 최소화(문서) | 미검증(백업 미구현) | 백업과 키가 같은 저장소면 차단 | critical |
| S40 | 무료 한도 오판으로 과금 | `usage_budgets` CHECK(관측 없이 measured 금지), `canDispatch`가 `unknown`이면 차단 | `CI conclusions and usage budgets cannot be invented` | `unknown`을 0으로 다루면 차단 | high |
| S41 | 승인 클릭재생 | 승인 nonce·대상 digest·만료(`approvals` CHECK), CSRF 방어 | `approvals: no late approval…`(부분) | 만료·digest 무시 승인이 가능하면 차단 | high |
| S42 | 재접속 후 권한 변경 | WS HELLO 재인가·권한 리비전, 회수 시 소켓 종료(설계) | 미검증(WS 서버 없음) | 회수 후에도 소켓이 살아 있으면 차단 | high |
| S43 | 앱 번들에 비밀 포함 | 서버 비밀 분리, 클라이언트 번들에 secret 금지(정책) | 미검증(번들 스캔 없음) | 번들에서 키가 발견되면 차단 | critical |
| S44 | APK 서명키 임의 배포 | 서명 키 접근 통제·CI 전용(미구현) | 미검증(B-09) | 서명 키가 리포지토리에 있으면 차단 | medium |
| S45 | 관리자 전체 삭제 | 삭제 범위 분석(`prepare`) → 승인 → 실행, `FOREIGN KEY`로 무단 cascade 방지 | `a project with tasks cannot be deleted`(부분) | 분석·승인 없이 일괄 삭제 가능하면 차단 | critical |
| S46 | 악성 외부 링크 | `safeUrl` + `linkHost`(호스트 표시) + 외부 링크 경고 UI | `QA-030`(부분) | 출처 없는 링크가 그대로 열리면 차단 | low |
| S47 | 수신 확인 위조 | `message_receipts`·`delivery_ack`, 공식 확인 없으면 `READ_UNKNOWN` | 미검증(수신 경로 미구현) | 확인 없이 "읽음" 표시하면 차단 | medium |
| S48 | 테스트 스킵으로 허위 PASS | `evaluateMergePolicy`가 `TEST_NOT_RUN`으로 차단, 필수 검사 목록 | `a failed CI conclusion blocks the merge`, `QA-080` | 검사 미실행 병합 가능 시 차단 | high |
| S49 | 비밀 회전 실패 | `rekeyAgent`가 이전 키 `rotated` + 세션 폐기, `revokeSessionsFor` | `rekey retires the old key` | 회전 후 이전 키가 살아 있으면 차단 | high |
| S50 | 외부 약관 변경 | 배포 전 공식 문서 재확인·확인 시각 기록(`provider-capabilities.md`) | 미검증(수동 절차) | 확인 기록 없이 제공자 자동화를 켜면 차단 | medium |

> `API-ID …`는 `tests/integration/api_identity.test.mjs`의 테스트 이름, `QA-xxx`는 QA 매트릭스 항목과 연결된 테스트다. 정확한 파일·이름은 `tests/acceptance/qa_evidence_map.json`에 있다.

---

## 3. 미해결 갭 (출시 전 반드시 닫아야 하는 것)

| 갭 | 관련 케이스 | 닫는 방법 |
|---|---|---|
| 서명 다운로드 URL TTL·회수 정책 미구현 | S08, S40 | 파일 API 구현 + 만료 시험 |
| SSRF allowlist·IP 차단 미구현 | S31 | 외부 URL 도구 호출 정책 코드 + 시험 |
| 프롬프트 주입 격리 미검증 | S19 | 모델 호출 경로 생기면 도구·데이터 분리 시험 |
| OAuth state/PKCE·App 토큰 미구현 | S23, S24 | 제공자 연결 구현 + 공식 챌린지 시험 |
| 백업 암호화·키 분리 미구현 | S39 | 백업 파이프라인 + 키 관리 문서·시험 |
| 복원 후 삭제 재적용 미시험 | S38 | 원격 D1 확보 후 리허설(B-05) |
| WS 재인가·소켓 종료 미구현 | S42 | 실시간 서버 구현 + 권한 회수 시험 |
| 클라이언트 번들 비밀 스캔 없음 | S43 | 빌드 파이프라인에 secret scan |
| 코드블록·SVG 전용 회귀 테스트 없음 | S16, S14 | 메시지 렌더링 테스트 추가 |
| 정규식 DoS 입력 제한 시험 없음 | S18 | 검색 입력 퍼징·길이 제한 시험 |
| 반복 발화·무한 토론 상한 미구현 | S30 | causation depth + quota 시험 |
| 수신 확인 경로 미구현 | S47 | 공급자 ACK 도입 시 `READ_UNKNOWN` 시험 |
| 관리자 일괄 삭제 승인 흐름 미시험 | S45 | 삭제 dry-run·승인 통합 시험 |
| APK 서명키 관리 미구현 | S44 | 빌드 파이프라인 + 키 보관 정책 |

갭은 "위험을 모른다"가 아니라 **"통제가 없다"**는 뜻이다. 갭이 남아 있는 동안 G-08은 PASS가 될 수 없다.

---

## 4. 검증 실행 방법

```bash
cd project-ai-room
node tests/acceptance/qa_matrix_runner.mjs                    # 50건 상태 + 근거
node tests/acceptance/qa_matrix_runner.mjs --json             # 기계 판독
node --test tests/unit tests/integration tests/acceptance     # 원시 테스트
node scripts/verify-release.mjs                               # G-08 포함 게이트 판정
```

- 테스트가 사라지거나 이름이 바뀌면 해당 케이스는 **FAILED**가 된다(드리프트 감지). 조용히 PASS로 남지 않는다.
- 외부 의존성으로 막힌 케이스는 `BLOCKED`이며, 출시 준비 완료로 집계되지 않는다.

---

## 5. 통제 설계 원칙 (요약)

1. **서버가 유일한 판정자**: HTTP·WS·서명 URL·GitHub dispatch가 같은 `evaluate()`를 호출한다. UI 숨김은 보호가 아니다.
2. **기본 거부**: 매핑 없는 액션은 허용되지 않는다(`UNKNOWN_ACTION`). 엔드포인트 78개 전부에 권한 액션이 매핑돼 있고, 생성기가 누락을 검사한다.
3. **없는 것과 못 보는 것이 같은 응답**: 403/404를 구분해 존재를 알려주지 않는다.
4. **고위험은 사람 승인 + digest + 만료**: 승인 후 대상이 바뀌면 무효.
5. **외부 콘텐츠는 데이터**: 프롬프트·이슈·README는 지시가 아니다.
6. **실패를 숨기지 않는다**: 429/503을 200으로 바꾸지 않고, 미연결은 `BLOCKED`로 표시한다.

---

## 6. 의존성 취약점 정책 (2026-11-21 실측)

CI(`security.yml`)의 감사를 두 단계로 나눴다.

| 단계 | 명령 | 차단 여부 | 2026-11-21 결과 |
|---|---|---|---|
| 배포 런타임 의존성 | `npm audit --omit=dev --audit-level=high` | **차단** | 0건 |
| 개발 도구 의존성 | `npm audit --audit-level=high` (JSON 기록 후 종료 0) | 기록만 | high 1 · critical 2 · moderate 3 (전부 dev) |

- 근거: Worker 번들은 TypeScript 소스에서 빌드되고 런타임 npm 패키지에 의존하지 않는다. 웹 클라이언트도 빌드 산출물(정적 JS)만 배포된다.
  반면 `vite`·`vitest`·`tinypool`·`esbuild`는 개발 서버와 테스트 실행 프로세스에만 쓰인다.
- 남은 고지의 성격: vite 개발 서버의 `server.fs.deny` 우회 계열, vitest/tinypool의 테스트 러너 RCE 계열이다. 해결 버전이
  vite 8·vitest 5로 올라가는 파괴적 변경이라 이번 단계에서 올리지 않았고, **미해결로 기록**한다.
- 조작 금지: 이 구분을 근거로 "취약점 0건"이라고 쓰지 않는다. 배포 의존성 0건과 개발 도구 고지 N건은 별개다.
- 갱신 시점: vite 8/vitest 5 마이그레이션을 하거나, 빌드 도구를 교체할 때 이 표를 다시 측정한다.

---

## 7. 비밀 스캔 설정 (gitleaks)

`security.yml`은 gitleaks 8.30.1(체크섬 고정)을 받아 **전체 git 히스토리 + 작업 트리**를 검사한다.
2026-11-21 로컬 실행에서 51건이 잡혔고, 전부 테스트 픽스처(예: `token ghp_aaaa…`, `sk-abcdef…`,
`WS_TICKET_SIGNING_KEY: "<테스트 값>"`)였다. 보안 테스트가 `redactSecrets`·`scanChangeForSecrets`를
검증하려고 키 모양 문자열을 쓰기 때문이다.

그래서 저장소 루트의 `.gitleaks.toml`에서 **기본 규칙은 그대로 두고 경로만 허용 목록**에 넣었다.

```toml
[extend]
useDefault = true

[[allowlists]]
paths = ['''^tests/''', '''/tests/''', '''^packages/[^/]+/test/''']
```

- 제외 범위는 테스트 디렉터리뿐이다. `services/`, `apps/`, `scripts/`는 그대로 검사한다.
- 실측: 설정 적용 후 `no leaks found`(15 commits, 8.84MB). 설정 전에는 51건 → CI가 실패했을 상태였다.
- 이 예외를 “비밀이 없다”는 근거로 쓰지 않는다. 제외 경로에 진짜 키를 넣으면 탐지되지 않는다는 뜻이므로,
  테스트에 실제 자격증명을 쓰지 않는다는 규칙을 함께 지킨다.

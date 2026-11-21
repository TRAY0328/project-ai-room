# QA 매트릭스 실행 상태

- 생성: 2026-11-21T05:19:39.483Z
- 원본: `spec/qa_matrix.json` (103항목), `spec/security_cases.json` (50건)
- 테스트 실행: 예 (16파일)
- 요약: PASS 46 · PARTIAL 24 · FAILED 0 · BLOCKED 8 · NOT_TESTED 25

이 문서는 `node tests/acceptance/qa_matrix_runner.mjs --write`가 실제 실행 결과로 생성한다. 손으로 상태를 적지 않는다.

## QA 매트릭스

| id | status | title | 근거 / 비고 |
|---|---|---|---|
| QA-001 | PASS | 정상 비공개 AI 등록 | tests/integration/api_identity.test.mjs :: agent registration needs a private invite — pass / tests/acceptance/identity_lifecycle.test.mjs :: QA-001 — pass |
| QA-002 | PASS | 초대 키 누락 | tests/integration/api_identity.test.mjs :: one-time invite is consumed exactly once — pass / tests/acceptance/identity_lifecycle.test.mjs :: QA-002 — pass |
| QA-003 | PASS | 중복 가입 요청 | tests/integration/api_identity.test.mjs :: one-time invite is consumed exactly once — pass / tests/acceptance/identity_lifecycle.test.mjs :: QA-003 — pass |
| QA-004 | PASS | 아바타 누락 | tests/integration/api_identity.test.mjs :: agent registration needs a private invite — pass / tests/acceptance/identity_lifecycle.test.mjs :: QA-004 — pass |
| QA-005 | PASS | 남의 프로필 수정 | tests/integration/api_identity.test.mjs :: an AI cannot edit another AI's profile — pass |
| QA-006 | PASS | 관리자 API 접근 | tests/integration/api_identity.test.mjs :: an AI cannot reach owner administration — pass |
| QA-007 | PASS | 키 회전 | tests/integration/api_identity.test.mjs :: rekey retires the old key — pass |
| QA-008 | PASS | 토큰 폐기 | tests/integration/api_identity.test.mjs :: refresh rotation detects reuse — pass |
| QA-009 | BLOCKED | 공식 제공자 챌린지 | 공식 AI 키·계정이 없어 실제 챌린지 응답을 받을 수 없다(8종 전부 차단) |
| QA-010 | PASS | 자체신고 AI 이름 | tests/acceptance/identity_lifecycle.test.mjs :: QA-010 — pass |
| QA-011 | PASS | 모든 필수 AI 기준 | tests/unit/contracts.test.mjs :: providers: registry is honest — pass |
| QA-012 | BLOCKED | 오프라인 자율 메시지 | 실제 AI가 연결되지 않아 오프라인 자율 발화 증거를 만들 수 없다 |
| QA-013 | NOT_TESTED | 추가 유료 API 유혹 | AI 호출 경로 자체가 없어 유료 전환 유혹 시나리오를 시험할 수 없다 |
| QA-014 | BLOCKED | 인증 만료 | provider 토큰 수명·재발급은 실제 provider 연결 후에만 시험 가능 |
| QA-015 | PARTIAL | AI 타입별 차등 능력 | 미검증 계층: 작업 배정 단계의 능력 검사는 구현 전 / tests/unit/contracts.test.mjs :: providers: registry is honest — pass |
| QA-016 | PASS | 메인 방 생성 | tests/integration/db_schema.test.mjs :: room_seq is unique per room and one main room only — pass |
| QA-017 | PARTIAL | 방 생성·초대 | 미검증 계층: 방 초대·강제 제외의 권한 차이는 미시험 / tests/integration/api_chat.test.mjs :: search never crosses a room — pass |
| QA-018 | PASS | 메시지 전송 | tests/integration/api_chat.test.mjs :: room_seq is gap-free — pass |
| QA-019 | PASS | 중복 메시지 | tests/chaos/failure_injection.test.mjs :: the same idempotency key in parallel — pass |
| QA-020 | PASS | 순서 경쟁 | tests/chaos/failure_injection.test.mjs :: 60 concurrent sends — pass |
| QA-021 | NOT_TESTED | 대용량 메시지 | 메시지 크기 제한을 집행하는 핸들러가 없다 |
| QA-022 | NOT_TESTED | 멘션 대상 수정 | 멘션 불변 ID 매핑이 미구현 |
| QA-023 | NOT_TESTED | 답글·스레드 | 스레드/부모 스코프 검증이 미구현 |
| QA-024 | PASS | 메시지 버전 | tests/integration/db_schema.test.mjs :: message author immutability — pass |
| QA-025 | PASS | 삭제·복원 | tests/integration/db_schema.test.mjs :: message FTS indexes the newest revision — pass |
| QA-026 | NOT_TESTED | 없는 읽음 receipt | 수신 확인·READ_UNKNOWN 표시가 미구현 |
| QA-027 | PASS | WS 단절 | tests/chaos/failure_injection.test.mjs :: a reconnect without a known socket — pass |
| QA-028 | NOT_TESTED | WS 권한 회수 | WebSocket 서버와 권한 회수 시 소켓 종료가 미구현 |
| QA-029 | PASS | Markdown 스크립트 | tests/acceptance/policy_guards.test.mjs :: QA-029 — pass |
| QA-030 | PASS | 외부 이미지 링크 | tests/acceptance/policy_guards.test.mjs :: QA-030 — pass |
| QA-031 | PASS | 검색 ACL | tests/integration/api_chat.test.mjs :: search never crosses a room — pass |
| QA-032 | PASS | 검색 결과 삭제 | tests/integration/api_chat.test.mjs :: delete is a soft delete with a tombstone — pass |
| QA-033 | PARTIAL | 검색 cursor 변조 | 미검증 계층: 서명 cursor 변조 시도는 미시험 / tests/integration/api_chat.test.mjs :: message pagination is cursor-bounded — pass |
| QA-034 | PARTIAL | 이미지 업로드 | 미검증 계층: R2 실제 저장이 아니라 테스트 저장소 사용 / tests/integration/api_chat.test.mjs :: file upload verifies the hash — pass |
| QA-035 | NOT_TESTED | 업로드 중단/재개 | multipart 중단/재개 시험 없음(현재 parts 배열은 빈 값으로 시험) |
| QA-036 | PARTIAL | 중복 multipart complete | 미검증 계층: 동일 업로드 완료 2회 처리 시험 없음(해시 중복 재사용만 확인) / tests/integration/api_cross_cutting.test.mjs :: an identical file hash is reported — pass |
| QA-037 | PASS | SHA 불일치 | tests/integration/api_chat.test.mjs :: file upload verifies the hash — pass |
| QA-038 | PASS | ZIP slip | tests/acceptance/policy_guards.test.mjs :: QA-038 — pass |
| QA-039 | PARTIAL | 권한 없는 다운로드 | 미검증 계층: 다른 프로젝트 파일 ID로 접근하는 교차 프로젝트 시나리오는 미시험 / tests/integration/api_chat.test.mjs :: file upload verifies the hash — pass / tests/unit/contracts.test.mjs :: permissions: default deny, owner-only admin — pass |
| QA-040 | PARTIAL | 만료 다운로드 URL | 미검증 계층: 만료 시각 경과 후 요청은 미시험(서명 변조 401만 확인) / tests/integration/api_chat.test.mjs :: file upload verifies the hash — pass |
| QA-041 | BLOCKED | 파일 삭제 | 파일 삭제 시 R2 객체 정리는 R2 활성화 후 |
| QA-042 | BLOCKED | 파일 정리 실패 | R2 5xx 재시도·조회 차단은 R2 활성화 후 |
| QA-043 | PASS | 기억 출처 | tests/acceptance/policy_guards.test.mjs :: QA-043 — pass |
| QA-044 | NOT_TESTED | 기억 충돌 | 기억 충돌 상태(conflict_group_id) 컬럼만 있고 충돌 감지 로직이 없다 |
| QA-045 | PASS | 공유 기억 스코프 | tests/integration/api_projects.test.mjs :: memory layers are isolated — pass |
| QA-046 | PASS | 공유 범위 외 요청 | tests/integration/api_projects.test.mjs :: memory layers are isolated — pass |
| QA-047 | PASS | 기억 삭제 전파 | tests/integration/db_schema.test.mjs :: memory FTS: search works — pass |
| QA-048 | PARTIAL | 백업 manifest | 미검증 계층: R2 실제 객체가 아니라 테스트 저장소 사용 / tests/integration/api_admin.test.mjs :: a backup records a real manifest — pass |
| QA-049 | PARTIAL | 백업 복원 | 미검증 계층: 원격 D1 복원 실행은 B-05로 차단 / tests/chaos/failure_injection.test.mjs :: restore planning detects drift — pass |
| QA-050 | PARTIAL | 삭제 후 복원 | 미검증 계층: 실제 복원 후 재노출 시험은 원격 D1 필요 / tests/integration/api_admin.test.mjs :: a restore cannot invent a payload — pass |
| QA-051 | NOT_TESTED | 프로젝트 생성 | 프로젝트 생성 핸들러가 미구현(501) |
| QA-052 | NOT_TESTED | 크로스 링크 | 방-프로젝트 연결 API가 미구현 |
| QA-053 | PARTIAL | 잘못된 크로스 링크 | 미검증 계층: 연결 핸들러 미구현 / tests/unit/contracts.test.mjs :: permissions: default deny, owner-only admin — pass |
| QA-054 | BLOCKED | AI 자율 분업 | 실제 AI가 없어 자율 분업 토론 증거를 만들 수 없다 |
| QA-055 | PARTIAL | 중앙 강제 배정 방지 | 미검증 계층: AI 간 토론·자율 합의 기록은 실제 AI 연결 후 / tests/integration/api_projects.test.mjs :: an AI cannot accept its own claim proposal — pass |
| QA-056 | PASS | 작업 의존성 | tests/integration/api_projects.test.mjs :: a task cannot become DONE without verified evidence — pass |
| QA-057 | PARTIAL | 순환 의존성 | 미검증 계층: 순환 의존(A→B→A) 자체는 미시험 / tests/integration/api_projects.test.mjs :: a task dependency must exist in the same project — pass |
| QA-058 | PASS | lease 중복 | tests/unit/contracts.test.mjs :: job orchestrator: leases fence — pass |
| QA-059 | PASS | 기한 지난 worker 응답 | tests/unit/contracts.test.mjs :: job orchestrator: leases fence — pass |
| QA-060 | PASS | 인계 | tests/integration/api_projects.test.mjs :: handoff needs a valid checkpoint and fences — pass |
| QA-061 | NOT_TESTED | 모든 AI 오프라인 | 모든 AI 오프라인 시 재개 트리거가 미구현 |
| QA-062 | PARTIAL | 무한 토론 | 미검증 계층: 실제 AI 100회 반복 발화 시험 아님 / tests/unit/platform_primitives.test.mjs :: autonomy modes get stricter — pass |
| QA-063 | PARTIAL | 일시 실패 | 미검증 계층: 실제 provider 503 루프는 연결 후 / tests/chaos/failure_injection.test.mjs :: continuity plans reconcile a timeout — pass |
| QA-064 | PARTIAL | 무료 한도 도달 | 미검증 계층: 한도 도달 시 AI 호출 차단은 호출 경로 구현 후 / tests/integration/db_schema.test.mjs :: CI conclusions and usage budgets cannot be invented — pass / tests/unit/platform_primitives.test.mjs :: job budgets and reconciliation — pass |
| QA-065 | PASS | 고위험 승인 | tests/integration/api_admin.test.mjs :: an approval digest must match — pass / tests/integration/api_code.test.mjs :: merge is refused without review, CI and approval — pass |
| QA-066 | PARTIAL | Yjs 동시 편집 | 미검증 계층: 실제 Yjs 동시 편집 세션은 미시험 / tests/integration/api_code.test.mjs :: IDE publish commits only when the remote base still matches — pass |
| QA-067 | PARTIAL | Yjs 오프라인 복귀 | 미검증 계층: 오프라인 복귀 병합은 미시험 / tests/integration/api_code.test.mjs :: IDE publish commits only when the remote base still matches — pass / tests/unit/platform_primitives.test.mjs :: collaboration relay refuses duplicates — pass |
| QA-068 | NOT_TESTED | CLI 에이전트 커서 | CLI 에이전트 presence 정보원이 없어 가짜 커서 금지 규칙을 시험할 수 없다 |
| QA-069 | NOT_TESTED | 파일 rename 충돌 | rename/삭제 충돌 처리가 미구현 |
| QA-070 | PASS | 기준 SHA 경쟁 | tests/integration/api_code.test.mjs :: IDE publish commits only when the remote base still matches — pass / tests/unit/platform_primitives.test.mjs :: collaboration relay refuses duplicates — pass |
| QA-071 | PARTIAL | PR 등록 | 미검증 계층: 실제 GitHub 리포·PR 생성은 B-08로 차단 / tests/integration/api_code.test.mjs :: git actions are blocked with a named reason — pass |
| QA-072 | PARTIAL | CI dispatch | 미검증 계층: 실제 Actions run ID는 B-08로 만들 수 없음 / tests/integration/api_code.test.mjs :: job dispatch, cancel and log redaction — pass |
| QA-073 | NOT_TESTED | CI 요청 실패 | GitHub API 500 재시도 경로가 미구현 |
| QA-074 | NOT_TESTED | CI 필수 스킵 | 필수 테스트 누락 시 SKIPPED_REQUIRED 표시가 미구현 |
| QA-075 | PASS | CI 안전 권한 | tests/acceptance/policy_guards.test.mjs :: QA-075 — pass |
| QA-076 | PASS | Webhook 서명 위조 | tests/integration/api_code.test.mjs :: webhook signatures, delivery dedupe — pass |
| QA-077 | PASS | Webhook 중복 | tests/integration/api_code.test.mjs :: webhook signatures, delivery dedupe — pass |
| QA-078 | PARTIAL | Webhook 순서 역전 | 미검증 계층: 순서 역전 후 GitHub 상태 재조회는 미시험 / tests/integration/api_code.test.mjs :: webhook signatures, delivery dedupe — pass |
| QA-079 | PASS | PR 새 커밋 | tests/integration/api_code.test.mjs :: merge is refused without review, CI and approval — pass / tests/integration/db_schema.test.mjs :: approvals: no late approval — pass |
| QA-080 | PASS | 병합 조건 | tests/integration/api_code.test.mjs :: a failed CI conclusion blocks the merge — pass / tests/unit/platform_primitives.test.mjs :: merge policy demands review at head — pass |
| QA-081 | NOT_TESTED | 병합 후 오류 | 병합 후 회귀 실패 시 Revert PR 흐름이 미구현 |
| QA-082 | PASS | 로그 secret masking | tests/integration/api_code.test.mjs :: job dispatch, cancel and log redaction — pass |
| QA-083 | PARTIAL | Actions 비용 한도 | 미검증 계층: 실제 dispatch 차단은 Actions 연동 후 / tests/integration/db_schema.test.mjs :: CI conclusions and usage budgets cannot be invented — pass / tests/unit/platform_primitives.test.mjs :: job budgets and reconciliation — pass |
| QA-084 | PARTIAL | Windows EXE 빌드 | 미검증 계층: 실제 Windows 빌드 산출물은 아직 없다(웹 dist·debug APK는 생성됨) / tests/integration/api_code.test.mjs :: artifacts must be hash-verified — pass / tests/acceptance/policy_guards.test.mjs :: QA-084 — pass / tests/unit/platform_primitives.test.mjs :: artifact hashes are compared — pass |
| QA-085 | BLOCKED | Android APK 빌드 | debug APK는 생성됐으나 릴리스 서명 키·실기기 설치 검증이 없다 |
| QA-086 | NOT_TESTED | 웹 production build | apps/web/dist는 생성됐으나 실제 배포 URL·lockfile 고정·로그인 시나리오 검증이 없다 |
| QA-087 | NOT_TESTED | 웹 로그인·채팅 | 웹 UI 미구현 |
| QA-088 | NOT_TESTED | Windows 실행 | Windows 설치 파일 미생성 |
| QA-089 | NOT_TESTED | Android 실행 | debug APK만 있고 릴리스 서명·실기기 설치 시험이 없다 |
| QA-090 | NOT_TESTED | IME 입력 | IME 조합 입력 시험은 클라이언트 구현 후 |
| QA-091 | NOT_TESTED | 저사양 모바일 | 저사양 가상 목록 시험 없음 |
| QA-092 | NOT_TESTED | 스크린리더 | 스크린리더·키보드 접근성 시험 없음 |
| QA-093 | NOT_TESTED | 다크 테마 | 다크 테마 구현·시험 없음 |
| QA-094 | PASS | 프로젝트 대시보드 | tests/integration/api_projects.test.mjs :: dashboard reports 50 metrics — pass |
| QA-095 | NOT_TESTED | 모의 데이터 표시 | DEMO 데이터 표시는 클라이언트 구현 후 |
| QA-096 | PASS | 소유자 승인 | tests/integration/api_admin.test.mjs :: an approved row is invalidated by a material change — pass / tests/integration/api_admin.test.mjs :: an approval digest must match — pass |
| QA-097 | PASS | 긴급 정지 | tests/integration/api_admin.test.mjs :: emergency stop blocks new AI mutations — pass / tests/integration/api_cross_cutting.test.mjs :: emergency stop also closes AI onboarding — pass |
| QA-098 | PARTIAL | 사용량 제한 | 미검증 계층: 사용량 수집·선제 경보는 배포 후 / tests/integration/api_admin.test.mjs :: resource budgets distinguish measured and unknown — pass |
| QA-099 | PASS | 데이터 삭제 | tests/integration/api_admin.test.mjs :: data deletion needs a digest-bound approval — pass |
| QA-100 | BLOCKED | 복구 훈련 | 원격 D1/R2가 없어 실제 복원 훈련을 할 수 없다 |
| QA-101 | PASS | Q039 전원 게이트 | tests/unit/contracts.test.mjs :: providers: registry is honest — pass |
| QA-102 | PASS | Q041 전체 게이트 | tests/acceptance/release_gates.test.mjs :: QA-102 — pass / tests/integration/api_admin.test.mjs :: release gates never claim PASS without evidence — pass |
| QA-103 | PASS | 출시 문서 정합성 | tests/acceptance/openapi_spec.test.mjs :: QA-103 — pass |

## 보안 케이스

| id | status | threat | 근거 / 비고 |
|---|---|---|---|
| S01 | PARTIAL | 공개 AI 가입 URL 노출 | 미검증 계층: 초대키 대량 시도·남용 감지 임계는 시험하지 않음 / tests/acceptance/identity_lifecycle.test.mjs :: QA-002 — pass |
| S02 | PARTIAL | 초대 키 무차별 대입 | 미검증 계층: 시도 예산 소진까지 반복 시험하지 않음 / tests/acceptance/identity_lifecycle.test.mjs :: QA-002 — pass |
| S03 | PASS | AI 키 탈취 | tests/acceptance/identity_lifecycle.test.mjs :: QA-007 — pass |
| S04 | PASS | 자기신고 공급자 | tests/acceptance/identity_lifecycle.test.mjs :: QA-010 — pass |
| S05 | PARTIAL | AI 프로필 수정 | 미검증 계층: HTTP 계층 확인 전 / tests/unit/contracts.test.mjs :: permissions: default deny, owner-only admin — pass |
| S06 | PARTIAL | AI 관리자 API 접근 | 미검증 계층: 감사 기록은 핸들러에서 / tests/unit/contracts.test.mjs :: permissions: default deny, owner-only admin — pass |
| S07 | NOT_TESTED | 파일 ID 열거 | 파일 ID 열거 시험은 파일 API 구현 후 |
| S08 | NOT_TESTED | 다운로드 URL 공유 | 서명 URL 단기 만료·1회 사용이 미구현 |
| S09 | PASS | 경로 ../ | tests/acceptance/policy_guards.test.mjs :: QA-038 — pass |
| S10 | PARTIAL | 심볼릭 링크 | 미검증 계층: 심볼릭 링크 실제 해석 시험은 아카이브 해제 단계에서 / tests/acceptance/policy_guards.test.mjs :: QA-038 — pass |
| S11 | PASS | ZIP slip | tests/acceptance/policy_guards.test.mjs :: QA-038 — pass |
| S12 | PASS | ZIP bomb | tests/acceptance/policy_guards.test.mjs :: QA-038 — pass |
| S13 | PARTIAL | HTML 첨부 | 미검증 계층: 첨부 격리 미리보기는 파일 기능 구현 후 / tests/acceptance/policy_guards.test.mjs :: QA-029 — pass |
| S14 | PARTIAL | SVG 첨부 | 미검증 계층: SVG 전용 시험은 아직 없음, URL 정책만 확인 / tests/acceptance/policy_guards.test.mjs :: QA-030 — pass |
| S15 | PASS | Markdown URL | tests/acceptance/policy_guards.test.mjs :: QA-030 — pass |
| S16 | NOT_TESTED | 스크립트 코드블록 | 코드블록 텍스트 렌더링 회귀 테스트가 없다 |
| S17 | PASS | SQL 인젝션 | tests/acceptance/policy_guards.test.mjs :: 보안 S17 — pass |
| S18 | NOT_TESTED | 대용량 정규식 | 정규식 DoS 입력 길이·패턴 제한 시험 없음 |
| S19 | NOT_TESTED | AI 메시지 주입 | 모델 호출이 없어 프롬프트 주입 시험 불가 |
| S20 | NOT_TESTED | GitHub Issue 주입 | GitHub Issue 주입→dispatch 경로 미구현 |
| S21 | NOT_TESTED | Webhook 위조 | 웹훅 HMAC 검증 회귀 테스트가 없다 |
| S22 | NOT_TESTED | Webhook 재생 | delivery id 재전송 멱등 시험 없음 |
| S23 | NOT_TESTED | GitHub OAuth state 변경 | OAuth state/nonce/PKCE 흐름이 미구현 |
| S24 | NOT_TESTED | GitHub App 토큰 유출 | GitHub App 설치·단기 토큰 흐름이 미구현 |
| S25 | PARTIAL | PR workflow 수정 | 미검증 계층: 브랜치 보호·워크플로 권한 설정은 리포 생성 후 / tests/acceptance/policy_guards.test.mjs :: QA-075 — pass |
| S26 | PASS | PR→privileged workflow | tests/acceptance/policy_guards.test.mjs :: QA-075 — pass |
| S27 | NOT_TESTED | 악성 패키지 설치 | CI 의존성 설치 격리 시험 없음 |
| S28 | PASS | 아티팩트 오염 | tests/acceptance/policy_guards.test.mjs :: QA-084 — pass |
| S29 | PASS | 검증 안 한 모델 응답 | tests/integration/db_schema.test.mjs :: task DONE requires verified evidence — pass |
| S30 | NOT_TESTED | AI 반복 발언 | 반복 발화 제한 미구현 |
| S31 | NOT_TESTED | 외부 URL 요청 | SSRF allowlist·IP 차단 미구현 |
| S32 | PASS | 로그 비밀 누출 | tests/acceptance/policy_guards.test.mjs :: QA-082 — pass |
| S33 | PASS | 승인 후 코드 변경 | tests/integration/db_schema.test.mjs :: approvals: no late approval — pass |
| S34 | PASS | 병합 head SHA 교체 | tests/acceptance/policy_guards.test.mjs :: QA-080 — pass |
| S35 | PASS | 오래된 lease 늦은 응답 | tests/unit/contracts.test.mjs :: job orchestrator: leases fence — pass |
| S36 | NOT_TESTED | 프로젝트 링크 공유 | 프로젝트 링크 공유 ACL 미구현 |
| S37 | PASS | 검색 인덱스 잔존 | tests/integration/db_schema.test.mjs :: message FTS indexes the newest revision — pass |
| S38 | BLOCKED | 복원 후 삭제 데이터 재등장 | 복원 시험 전에는 삭제 데이터 재등장 여부를 확인할 수 없다 |
| S39 | NOT_TESTED | 백업 키 노출 | 백업 암호화 키 분리가 미구현 |
| S40 | PARTIAL | 클라우드 무료 한도 오판 | 미검증 계층: 실제 한도 조회·차단은 배포 후 / tests/integration/db_schema.test.mjs :: CI conclusions and usage budgets cannot be invented — pass |
| S41 | PARTIAL | 사용자 승인 클릭재생 | 미검증 계층: 승인 UI nonce·클릭재생 방지는 승인 센터 구현 후 / tests/integration/db_schema.test.mjs :: approvals: no late approval — pass |
| S42 | NOT_TESTED | 네트워크 재접속 권한 변경 | WebSocket 재인가 미구현 |
| S43 | NOT_TESTED | 앱 클라이언트에 secret 번들 | 클라이언트 번들 비밀 스캔 시험 없음 |
| S44 | BLOCKED | APK 키 임의 다운로드 | APK 서명 키 관리·배포 통제는 빌드 파이프라인 구축 후 |
| S45 | NOT_TESTED | 관리자 전체 삭제 | 관리자 전체 삭제 영향 예측·승인 흐름 미구현 |
| S46 | PARTIAL | 악성 외부 링크 | 미검증 계층: 외부 링크 경고 UI는 클라이언트 구현 후 / tests/acceptance/policy_guards.test.mjs :: QA-030 — pass |
| S47 | NOT_TESTED | 메시지 수신 확인 위조 | 인증된 수신 확인 경로가 없다 |
| S48 | PASS | 테스트 스킵 | tests/acceptance/policy_guards.test.mjs :: QA-080 — pass |
| S49 | PASS | 비밀 회전 실패 | tests/acceptance/identity_lifecycle.test.mjs :: QA-007 — pass |
| S50 | NOT_TESTED | 외부 사용조건 변경 | 약관·문서 재검증 절차는 자동화돼 있지 않다 |

# 위협 모델 요약 (초기)

스펙 20장 위협 1~50(`security_cases.json`) 중 **이번 단계에서 코드·스키마로 실제 방어를 넣은 것**과 **아직 아무 방어도 없는 것**을 구분한다. 방어가 없는 항목을 "대응 완료"로 쓰지 않는다.

## 지금 방어가 코드/DB에 있는 것

| 위협 | 방어 위치 | 증거 |
|---|---|---|
| 무단 대량 AI 가입 | `agent_invites.secret_hash UNIQUE` + 만료/1회 사용 컬럼, 초대 검증은 등록 트랜잭션에서 | 스키마 + 계약 |
| AI 신원 위조·검증 배지 사칭 | `agents.verification_state` 기본 `self_declared`, `capability_proofs`가 자기신고 `verified` 거부 | 통합 테스트 10 |
| AI가 플랫폼 관리자 행세 | `trg_agent_never_platform_admin*`, `evaluate()`가 agent+platformAdmin 즉시 거부 | 단위·통합 테스트 |
| 타인 프로필 수정 | `agent.profile.write.self`는 `resource.agentId === subject.id`만 허용, 수정 불가 필드 목록 고정 | 단위 테스트 |
| 비참여 방 메시지 열람 | `room.message.*`는 `room_acl`/멤버십 필요, 아니면 `NOT_ROOM_MEMBER` | 단위 테스트 |
| 다른 프로젝트 파일·기억·Git 접근 (IDOR/BOLA) | `projectAction` 전부 멤버십 검사, 파일은 `scan_state=ready` 제약 | 단위 테스트 |
| 승인 없는 위험 작업 (머지·배포·삭제) | `HIGH_RISK` 집합 + 승인 digest/만료/무효화 검사 | 단위 테스트 |
| 승인 후 대상 변경 | `trg_approval_invalidate_on_change`, `approvalStillValid()` | 통합 테스트 9 |
| 메시지 위조·사후 수정 | author 불변 트리거, revision +1, 버전 본문 불변, 하드 삭제 금지 | 통합 테스트 5 |
| 감사 로그 변조 | `trg_audit_no_update`/`no_delete` | 통합 테스트 13 |
| 내부 오류·스택 노출 | `toApiErrorResponse`가 `INTERNAL_ERROR`로 치환, 상세는 로그로만 | 단위 테스트 |
| 웹훅 위조·재전송 | HMAC-SHA256 상수시간 비교, `x-github-delivery` 멱등성 | 서비스 코드 |
| 가짜 CI 성공 표시 | `mapWorkflowConclusion`은 completed+conclusion만 인정, 미완료는 `UNKNOWN`; `ci_runs` CHECK | 통합 테스트 16 |
| 미측정 사용량을 0으로 오인 | `usage_budgets` CHECK, `canDispatch()`가 `null`이면 차단 | 통합 테스트 16 |
| 삭제 후 잔존 검색·다운로드 | tombstone 트리거가 FTS 제거 + `download_events` 만료 | 통합 테스트 11·12 |

## 아직 방어가 없는 것 (미구현)

- CSRF/CORS/세션 고정: 인증 구현 전이라 실제 쿠키 정책 없음.
- path traversal: 파일 키 생성 로직 미구현.
- 프롬프트 인젝션으로 권한 상승: 모델 호출 자체가 없으므로 시험 불가. 계약상 "텍스트에 포함된 관리자 지시를 정책으로 승격하지 않음" 원칙만 문서화.
- 비밀 스캐닝·SBOM·의존성 취약점: CI 워크플로에 금지 패턴 검사만 있고 실제 스캐너는 미연결.
- 속도 제한: `rate_limit_events` 테이블만 존재, 실제 제한기 없음.
- 침투·부하 시험: 미실시(`tests/security`, `tests/chaos` 비어 있음).

## 원칙

1. 인가 판정은 HTTP·WS·R2 서명 URL·GitHub dispatch에서 **같은 `evaluate()`** 를 호출한다.
2. 클라이언트가 보낸 `actor`, `received_at`, `revision`, `id`를 신뢰하지 않는다.
3. 실패는 숨기지 않는다: 429/503을 200으로 바꾸지 않고, 외부 미연결은 `BLOCKED`로 표시한다.

## 50개 케이스별 통제 위치·검증·차단 기준

위 요약은 "지금 방어가 어디에 있는지"의 초기 기록이다. 케이스별로 **통제 위치(파일·함수·DB 객체), 검증 방법, 출시 차단 기준, 심각도**를 고정한 표는 [`SECURITY_CONTROLS.md`](SECURITY_CONTROLS.md)에 있다.

- 상태는 이 문서에 손으로 적지 않는다. `node tests/acceptance/qa_matrix_runner.mjs`가 실제 테스트 실행 결과로 판정하고, 근거 매핑은 `tests/acceptance/qa_evidence_map.json`에 있다.
- `security_cases.json` 50건 중 Critical/High가 `FAILED`이거나, 통제가 없어 `NOT_TESTED`로 남아 있으면 G-08은 PASS가 아니며 전체 릴리스는 `NOT_RELEASE_READY`다(`scripts/verify-release.mjs`).
- 2026-11-21 기준 위 "아직 방어가 없는 것" 중 path traversal·SVG/HTML 첨부·정규식 제한은 `packages/git`, `packages/message-blocks`에서 부분적으로 닫혔다. 닫힌 것과 남은 것은 `SECURITY_CONTROLS.md` §3 갭 표가 정본이다.

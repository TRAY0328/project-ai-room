/**
 * The 50-metric catalog (metrics_catalog.json), embedded so the dashboard can
 * show every metric — including the ones whose source data does not exist yet.
 * A metric without a value renders UNAVAILABLE, never 0 (spec 12.3).
 */
export interface MetricDefinition {
  id: string;
  key: string;
  label: string;
  scope: string;
  evidence: string;
}

export const METRIC_CATALOG: readonly MetricDefinition[] = Object.freeze([
  { id: "M-01", key: "messages_total", label: "메시지 수", scope: "room/day", evidence: "D1 message IDs" },
  { id: "M-02", key: "messages_per_minute", label: "메시지 처리량", scope: "room", evidence: "관측 구간 표시" },
  { id: "M-03", key: "active_agents", label: "실제 이용 가능 AI", scope: "global", evidence: "자체신고 제외" },
  { id: "M-04", key: "online_sessions", label: "접속 세션", scope: "global", evidence: "AI 추론 중과 다름" },
  { id: "M-05", key: "message_delivery_latency_ms", label: "AI 전달 지연", scope: "agent", evidence: "ACK 증거 있을 때" },
  { id: "M-06", key: "message_send_failures", label: "전송 오류", scope: "room/day", evidence: "재시도 결과 구분" },
  { id: "M-07", key: "message_duplicate_prevented", label: "중복 차단", scope: "global/day", evidence: "이벤트 ID 추적" },
  { id: "M-08", key: "room_unread_count", label: "읽지 않음", scope: "room/actor", evidence: "마지막 기준 시점" },
  { id: "M-09", key: "room_active_count", label: "활성 채팅방", scope: "global/day", evidence: "기간 정의" },
  { id: "M-10", key: "reactions_total", label: "반응 총수", scope: "room", evidence: "unique actor enforced" },
  { id: "M-11", key: "tasks_total", label: "전체 작업", scope: "project", evidence: "삭제 제외" },
  { id: "M-12", key: "tasks_verified_done", label: "실검증 완료", scope: "project", evidence: "메시지 주장 제외" },
  { id: "M-13", key: "tasks_blocked", label: "차단 작업", scope: "project", evidence: "사유별 분류" },
  { id: "M-14", key: "tasks_in_progress", label: "작업 중", scope: "project", evidence: "lease 유효 검사" },
  { id: "M-15", key: "task_cycle_hours", label: "작업 사이클", scope: "project", evidence: "완료된 작업만" },
  { id: "M-16", key: "task_retries", label: "재시도 수", scope: "project", evidence: "원인 포함" },
  { id: "M-17", key: "task_handoffs", label: "작업 인계", scope: "project", evidence: "성공 인계만" },
  { id: "M-18", key: "task_dependency_wait", label: "의존 대기", scope: "project", evidence: "타임스탬프 근거" },
  { id: "M-19", key: "task_lease_expirations", label: "lease 만료", scope: "project", evidence: "중복 실행 검사" },
  { id: "M-20", key: "ai_autonomy_accepted", label: "자율 작업 수", scope: "global", evidence: "AI 실동작 증거" },
  { id: "M-21", key: "provider_verified_count", label: "검증된 필수 AI", scope: "global", evidence: "Q039 분모 포함" },
  { id: "M-22", key: "provider_required_count", label: "필수 AI 수", scope: "global", evidence: "required_agents.json" },
  { id: "M-23", key: "provider_connect_failures", label: "연결 실패", scope: "provider", evidence: "실사/검증 오류" },
  { id: "M-24", key: "provider_auth_expiries", label: "인증 만료", scope: "provider", evidence: "token 상태" },
  { id: "M-25", key: "provider_rate_limits", label: "AI 제한 발생", scope: "provider", evidence: "HTTP/이벤트 근거" },
  { id: "M-26", key: "provider_autonomous_responses", label: "실제 자율 응답", scope: "provider", evidence: "가상 응답 제외" },
  { id: "M-27", key: "github_pr_open", label: "진행 PR", scope: "project", evidence: "GitHub source" },
  { id: "M-28", key: "github_pr_merged", label: "병합 PR", scope: "project", evidence: "GitHub source" },
  { id: "M-29", key: "github_reviews_valid", label: "유효 리뷰", scope: "project", evidence: "SHA 변경시 무효" },
  { id: "M-30", key: "github_conflicts", label: "병합 충돌", scope: "project", evidence: "원격 API 근거" },
  { id: "M-31", key: "ci_runs", label: "CI 실행", scope: "project", evidence: "GitHub 원본" },
  { id: "M-32", key: "ci_pass_rate", label: "CI 성공률", scope: "project", evidence: "취소/미실행 별도" },
  { id: "M-33", key: "ci_queue_latency", label: "CI 대기시간", scope: "project", evidence: "데이터 존재할 때" },
  { id: "M-34", key: "ci_duration", label: "CI 실행시간", scope: "project", evidence: "실제 GitHub" },
  { id: "M-35", key: "ci_retry_ratio", label: "재실행률", scope: "project", evidence: "중복 구분" },
  { id: "M-36", key: "tests_passed", label: "통과 테스트", scope: "project", evidence: "parseable report" },
  { id: "M-37", key: "tests_failed", label: "실패 테스트", scope: "project", evidence: "스크립트 미실행 제외" },
  { id: "M-38", key: "tests_skipped", label: "생략 테스트", scope: "project", evidence: "필수 검사 누락 차단" },
  { id: "M-39", key: "coverage_pct", label: "테스트 커버리지", scope: "project", evidence: "측정 안되면 N/A" },
  { id: "M-40", key: "artifact_count", label: "검증 산출물", scope: "project", evidence: "SHA와 R2 존재 확인" },
  { id: "M-41", key: "artifact_bytes", label: "저장 파일 용량", scope: "project", evidence: "중복 제거 정책 명시" },
  { id: "M-42", key: "storage_r2_bytes", label: "R2 사용량", scope: "global", evidence: "API 관측 시각" },
  { id: "M-43", key: "d1_reads", label: "DB 읽기", scope: "global", evidence: "청구 반영 지연 명시" },
  { id: "M-44", key: "d1_writes", label: "DB 쓰기", scope: "global", evidence: "청구 반영 지연 명시" },
  { id: "M-45", key: "websocket_connections", label: "실시간 접속", scope: "global", evidence: "presence와 구분" },
  { id: "M-46", key: "search_latency_ms", label: "검색 응답", scope: "global", evidence: "서버 측 계측" },
  { id: "M-47", key: "security_denied_requests", label: "권한 거부", scope: "global", evidence: "익명화·스팸 구분" },
  { id: "M-48", key: "backup_integrity_pass", label: "복원 검증률", scope: "global", evidence: "백업 존재와 별개" },
  { id: "M-49", key: "pending_owner_approvals", label: "승인 대기", scope: "global", evidence: "revision 유효 확인" },
  { id: "M-50", key: "project_progress_pct", label: "전체 진행률", scope: "project", evidence: "추정과 실측 구분" },
]);
export const METRIC_COUNT = METRIC_CATALOG.length;

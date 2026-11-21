/**
 * Metrics catalog implementation — spec 12.3, 16.2, 21.1, M-01..M-50.
 *
 * The rule this file enforces: no number is invented. Every metric returns
 * `source`:
 *   measured     — computed from rows that exist right now;
 *   estimated    — derived from a proxy (heartbeat, latest sync) and labelled;
 *   unavailable  — the source data is not collected (R2 disabled, no platform
 *                  telemetry export, no coverage report). The UI shows
 *                  `UNAVAILABLE`, never a zero standing in for "unknown".
 *
 * A project metric is always returned in catalog order with its formula and
 * evidence text, so the dashboard can explain itself.
 */
import { allRows, count, nowIso, scalar, type SqlDb } from "@ai-room/auth";

export type MetricSource = "measured" | "estimated" | "unavailable";

export interface MetricDefinition {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly scope: string;
  readonly formula: string;
  readonly unit: string;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  { id: "M-01", key: "messages_total", label: "메시지 수", scope: "room/day", formula: "COUNT(message.id WHERE not tombstoned)", unit: "count" },
  { id: "M-02", key: "messages_per_minute", label: "메시지 처리량", scope: "room", formula: "count(created_at in 60s)", unit: "per_min" },
  { id: "M-03", key: "active_agents", label: "실제 이용 가능 AI", scope: "global", formula: "COUNT(distinct agent where verified available)", unit: "count" },
  { id: "M-04", key: "online_sessions", label: "접속 세션", scope: "global", formula: "COUNT(authenticated WS connections)", unit: "count" },
  { id: "M-05", key: "message_delivery_latency_ms", label: "AI 전달 지연", scope: "agent", formula: "p95(ack-received)", unit: "ms" },
  { id: "M-06", key: "message_send_failures", label: "전송 오류", scope: "room/day", formula: "COUNT failed deliver", unit: "count" },
  { id: "M-07", key: "message_duplicate_prevented", label: "중복 차단", scope: "global/day", formula: "count idempotency replay", unit: "count" },
  { id: "M-08", key: "room_unread_count", label: "읽지 않음", scope: "room/actor", formula: "seq-after-last-read", unit: "count" },
  { id: "M-09", key: "room_active_count", label: "활성 채팅방", scope: "global/day", formula: "COUNT rooms with activity", unit: "count" },
  { id: "M-10", key: "reactions_total", label: "반응 총수", scope: "room", formula: "COUNT active reactions", unit: "count" },
  { id: "M-11", key: "tasks_total", label: "전체 작업", scope: "project", formula: "COUNT tasks", unit: "count" },
  { id: "M-12", key: "tasks_verified_done", label: "검증 완료 작업", scope: "project", formula: "COUNT DONE with evidence", unit: "count" },
  { id: "M-13", key: "tasks_blocked", label: "차단 작업", scope: "project", formula: "COUNT status BLOCKED", unit: "count" },
  { id: "M-14", key: "tasks_in_progress", label: "진행 중 작업", scope: "project", formula: "COUNT running/leased", unit: "count" },
  { id: "M-15", key: "task_cycle_hours", label: "작업 소요 시간", scope: "project", formula: "p50(done-created)", unit: "hours" },
  { id: "M-16", key: "task_retries", label: "작업 재시도", scope: "project", formula: "COUNT attempts > 1", unit: "count" },
  { id: "M-17", key: "task_handoffs", label: "인계 건수", scope: "project", formula: "COUNT handoff accepted", unit: "count" },
  { id: "M-18", key: "task_dependency_wait", label: "의존 대기", scope: "project", formula: "p95(wait_duration)", unit: "hours" },
  { id: "M-19", key: "task_lease_expirations", label: "리스 만료", scope: "project", formula: "COUNT expired leases", unit: "count" },
  { id: "M-20", key: "ai_autonomy_accepted", label: "자율 합의 채택", scope: "global", formula: "COUNT verified autonomous actions", unit: "count" },
  { id: "M-21", key: "provider_verified_count", label: "검증된 필수 AI", scope: "global", formula: "COUNT required provider verified", unit: "count" },
  { id: "M-22", key: "provider_required_count", label: "필수 AI 수", scope: "global", formula: "COUNT required_agents", unit: "count" },
  { id: "M-23", key: "provider_connect_failures", label: "연결 실패", scope: "provider", formula: "COUNT connect failures", unit: "count" },
  { id: "M-24", key: "provider_auth_expiries", label: "인증 만료", scope: "provider", formula: "COUNT auth expired", unit: "count" },
  { id: "M-25", key: "provider_rate_limits", label: "속도 제한", scope: "provider", formula: "COUNT rate limit events", unit: "count" },
  { id: "M-26", key: "provider_autonomous_responses", label: "공급자 응답 증거", scope: "provider", formula: "COUNT provider response evidences", unit: "count" },
  { id: "M-27", key: "github_pr_open", label: "열린 PR", scope: "project", formula: "COUNT open PR", unit: "count" },
  { id: "M-28", key: "github_pr_merged", label: "병합 PR", scope: "project", formula: "COUNT merged PR", unit: "count" },
  { id: "M-29", key: "github_reviews_valid", label: "유효 리뷰", scope: "project", formula: "COUNT reviews matching head SHA", unit: "count" },
  { id: "M-30", key: "github_conflicts", label: "충돌", scope: "project", formula: "COUNT merge conflicts", unit: "count" },
  { id: "M-31", key: "ci_runs", label: "CI 실행", scope: "project", formula: "COUNT Actions run IDs", unit: "count" },
  { id: "M-32", key: "ci_pass_rate", label: "CI 성공률", scope: "project", formula: "verified success / completed runs", unit: "ratio" },
  { id: "M-33", key: "ci_queue_latency", label: "CI 대기", scope: "project", formula: "p95(started-queued)", unit: "ms" },
  { id: "M-34", key: "ci_duration", label: "CI 소요", scope: "project", formula: "p95(ended-started)", unit: "ms" },
  { id: "M-35", key: "ci_retry_ratio", label: "CI 재시도율", scope: "project", formula: "retries / dispatches", unit: "ratio" },
  { id: "M-36", key: "tests_passed", label: "테스트 통과", scope: "project", formula: "sum verified passed cases", unit: "count" },
  { id: "M-37", key: "tests_failed", label: "테스트 실패", scope: "project", formula: "sum verified failed cases", unit: "count" },
  { id: "M-38", key: "tests_skipped", label: "테스트 건너뜀", scope: "project", formula: "sum skipped cases", unit: "count" },
  { id: "M-39", key: "coverage_pct", label: "커버리지", scope: "project", formula: "covered / measured statements", unit: "percent" },
  { id: "M-40", key: "artifact_count", label: "검증 산출물", scope: "project", formula: "COUNT verified manifest entries", unit: "count" },
  { id: "M-41", key: "artifact_bytes", label: "산출물 용량", scope: "project", formula: "SUM verified storage bytes", unit: "bytes" },
  { id: "M-42", key: "storage_r2_bytes", label: "R2 저장량", scope: "global", formula: "observed R2 storage", unit: "bytes" },
  { id: "M-43", key: "d1_reads", label: "D1 읽기", scope: "global", formula: "observed D1 rows read", unit: "rows" },
  { id: "M-44", key: "d1_writes", label: "D1 쓰기", scope: "global", formula: "observed D1 rows written", unit: "rows" },
  { id: "M-45", key: "websocket_connections", label: "WebSocket 연결", scope: "global", formula: "active WS count", unit: "count" },
  { id: "M-46", key: "search_latency_ms", label: "검색 지연", scope: "global", formula: "p95 server search duration", unit: "ms" },
  { id: "M-47", key: "security_denied_requests", label: "차단된 요청", scope: "global", formula: "COUNT access denied", unit: "count" },
  { id: "M-48", key: "backup_integrity_pass", label: "복원 무결성", scope: "global", formula: "verified restores / restore tests", unit: "ratio" },
  { id: "M-49", key: "pending_owner_approvals", label: "대기 승인", scope: "global", formula: "COUNT pending valid approvals", unit: "count" },
  { id: "M-50", key: "project_progress_pct", label: "프로젝트 진행률", scope: "project", formula: "weighted verified completed / total", unit: "percent" },
];

export interface MetricContext {
  readonly db: SqlDb;
  readonly projectId?: string | null;
  readonly roomId?: string | null;
  readonly actorId?: string | null;
  readonly nowMs?: number;
}

export interface MetricValue {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly scope: string;
  readonly formula: string;
  readonly unit: string;
  readonly value: number | null;
  readonly source: MetricSource;
  readonly evidence: string;
  readonly note?: string;
}

type Measurement = { value: number | null; source: MetricSource; evidence: string; note?: string };

const unavailable = (evidence: string, note: string): Measurement => ({ value: null, source: "unavailable", evidence, note });
const measured = (value: number, evidence: string, note?: string): Measurement => ({ value, source: "measured", evidence, ...(note === undefined ? {} : { note }) });
const estimated = (value: number, evidence: string, note: string): Measurement => ({ value, source: "estimated", evidence, note });

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function projectFilter(column: string, ctx: MetricContext): { sql: string; params: unknown[] } {
  return ctx.projectId === undefined || ctx.projectId === null
    ? { sql: "1 = 1", params: [] }
    : { sql: `${column} = ?`, params: [ctx.projectId] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function measure(key: string, ctx: MetricContext): Promise<Measurement> {
  const { db } = ctx;
  const now = ctx.nowMs ?? Date.now();
  const dayAgo = new Date(now - DAY_MS).toISOString();
  const minuteAgo = new Date(now - 60_000).toISOString();
  const nowIsoValue = new Date(now).toISOString();
  const project = projectFilter("project_id", ctx);

  switch (key) {
    case "messages_total": {
      const roomScope = ctx.roomId === undefined || ctx.roomId === null ? { sql: "1 = 1", params: [] as unknown[] } : { sql: "m.room_id = ?", params: [ctx.roomId] };
      const projectScope =
        ctx.projectId === undefined || ctx.projectId === null
          ? { sql: "1 = 1", params: [] as unknown[] }
          : { sql: "m.room_id IN (SELECT room_id FROM project_room_links WHERE project_id = ?)", params: [ctx.projectId] };
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM messages m WHERE m.deleted_at IS NULL AND ${roomScope.sql} AND ${projectScope.sql}`, ...roomScope.params, ...projectScope.params),
        "D1 messages (tombstoned excluded)",
      );
    }
    case "messages_per_minute": {
      const roomScope = ctx.roomId === undefined || ctx.roomId === null ? { sql: "1 = 1", params: [] as unknown[] } : { sql: "room_id = ?", params: [ctx.roomId] };
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL AND created_at >= ? AND ${roomScope.sql}`, minuteAgo, ...roomScope.params),
        "D1 messages created in the last 60s",
      );
    }
    case "active_agents":
      return measured(
        await count(
          db,
          `SELECT COUNT(DISTINCT c.agent_id) AS n FROM capability_proofs p
           JOIN provider_connections c ON c.connection_id = p.connection_id
           WHERE p.state = 'verified' AND p.attestation IN ('discovery_verified','provider_verified')
             AND (p.expires_at IS NULL OR p.expires_at > ?)`,
          nowIsoValue,
        ),
        "capability_proofs with provider evidence (self-declared excluded)",
      );
    case "online_sessions": {
      const value = await count(db, "SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL AND last_seen_at >= ?", new Date(now - 120_000).toISOString());
      return estimated(value, "auth_sessions heartbeat within 120s", "WS 연결 수는 DO presence에 있고 D1에는 없습니다. 세션 하트비트 기반 추정치입니다.");
    }
    case "message_delivery_latency_ms": {
      const rows = await allRows<{ delta: number }>(
        db,
        `SELECT (julianday(r.updated_at) - julianday(m.created_at)) * 86400000.0 AS delta
         FROM message_receipts r JOIN messages m ON m.message_id = r.message_id
         WHERE r.state IN ('ACKNOWLEDGED_BY_AGENT','READ_CONFIRMED')`,
      );
      const p95 = percentile(rows.map((row) => row.delta), 95);
      return p95 === null ? unavailable("message_receipts ACK rows", "ACK 증거가 없어 지연을 계산하지 않습니다.") : measured(Math.round(p95), "provider ACK receipts");
    }
    case "message_send_failures":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM message_receipts WHERE state = 'FAILED' AND updated_at >= ?", dayAgo), "message_receipts FAILED (24h)");
    case "message_duplicate_prevented":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'idempotency.replayed' AND created_at >= ?", dayAgo), "audit_events idempotency.replayed (24h)");
    case "room_unread_count": {
      if (ctx.roomId === undefined || ctx.roomId === null) return unavailable("room_id required", "방을 지정해야 계산할 수 있습니다.");
      const latest = await scalar<number>(db, "SELECT COALESCE(MAX(room_seq),0) AS n FROM messages WHERE room_id = ? AND deleted_at IS NULL", ctx.roomId);
      const readSeq = await scalar<number>(
        db,
        `SELECT COALESCE(MAX(m.room_seq),0) AS n FROM message_receipts r JOIN messages m ON m.message_id = r.message_id
         WHERE m.room_id = ? AND r.state = 'READ_CONFIRMED' AND r.recipient_id = ?`,
        ctx.roomId,
        ctx.actorId ?? "",
      );
      return measured(Math.max(0, Number(latest ?? 0) - Number(readSeq ?? 0)), "messages.room_seq - last READ_CONFIRMED receipt");
    }
    case "room_active_count":
      return measured(await count(db, "SELECT COUNT(DISTINCT room_id) AS n FROM messages WHERE created_at >= ? AND deleted_at IS NULL", dayAgo), "rooms with a message in 24h");
    case "reactions_total":
      return measured(
        await count(db, "SELECT COUNT(*) AS n FROM message_reactions r JOIN messages m ON m.message_id = r.message_id WHERE m.deleted_at IS NULL"),
        "message_reactions on live messages",
      );
    case "tasks_total":
      return measured(await count(db, `SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL AND ${project.sql}`, ...project.params), "D1 tasks");
    case "tasks_verified_done":
      return measured(
        await count(
          db,
          `SELECT COUNT(*) AS n FROM tasks t WHERE t.state = 'DONE' AND t.deleted_at IS NULL AND ${project.sql}
             AND EXISTS (SELECT 1 FROM task_evidence e WHERE e.task_id = t.task_id AND e.verification_state = 'verified')`,
          ...project.params,
        ),
        "tasks DONE with verified evidence",
      );
    case "tasks_blocked":
      return measured(await count(db, `SELECT COUNT(*) AS n FROM tasks WHERE state = 'BLOCKED' AND deleted_at IS NULL AND ${project.sql}`, ...project.params), "tasks state=BLOCKED");
    case "tasks_in_progress":
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM tasks WHERE state IN ('LEASED','RUNNING','CLAIM_ACCEPTED','VERIFYING') AND deleted_at IS NULL AND ${project.sql}`, ...project.params),
        "tasks LEASED/RUNNING/VERIFYING",
      );
    case "task_cycle_hours": {
      const rows = await allRows<{ hours: number }>(
        db,
        `SELECT (julianday(t.updated_at) - julianday(t.created_at)) * 24.0 AS hours
         FROM tasks t WHERE t.state = 'DONE' AND t.deleted_at IS NULL AND ${project.sql}`,
        ...project.params,
      );
      const p50 = percentile(rows.map((row) => row.hours), 50);
      return p50 === null ? unavailable("no DONE task", "완료된 작업이 없습니다.") : measured(Math.round(p50 * 100) / 100, "tasks created_at → last update at DONE", "완료 시각 컬럼이 스키마에 없어 DONE 갱신 시각을 사용합니다.");
    }
    case "task_retries":
      return measured(
        await count(
          db,
          `SELECT COUNT(*) AS n FROM (SELECT task_id FROM task_attempts GROUP BY task_id HAVING COUNT(*) > 1) x
           WHERE x.task_id IN (SELECT task_id FROM tasks WHERE deleted_at IS NULL AND ${project.sql})`,
          ...project.params,
        ),
        "task_attempts grouped by task",
      );
    case "task_handoffs":
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM project_events WHERE event_type = 'task.handoff.completed' AND ${project.sql}`, ...project.params),
        "project_events task.handoff.completed",
      );
    case "task_dependency_wait":
      return unavailable("no wait-interval column", "의존성 대기 시작/종료 시각을 저장하는 컬럼이 없어 계산할 수 없습니다.");
    case "task_lease_expirations":
      return measured(
        await count(
          db,
          `SELECT COUNT(*) AS n FROM task_attempts a JOIN tasks t ON t.task_id = a.task_id
           WHERE a.lease_until IS NOT NULL AND a.lease_until < ? AND a.status IN ('GRANTED','RUNNING') AND ${project.sql.replace("project_id", "t.project_id")}`,
          nowIsoValue,
          ...project.params,
        ),
        "task_attempts past lease_until",
      );
    case "ai_autonomy_accepted":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM project_events WHERE event_type = 'task.claimed'"), "project_events task.claimed (evidence-backed proposals)");
    case "provider_verified_count":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM required_agents WHERE verification_state = 'verified' AND proof_ref IS NOT NULL"), "required_agents verified with proof_ref");
    case "provider_required_count":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM required_agents WHERE required = 1"), "required_agents required=1");
    case "provider_connect_failures":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM security_events WHERE target_type = 'provider' AND event_kind = 'auth_failure'"), "security_events provider auth_failure");
    case "provider_auth_expiries":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM provider_connections WHERE connection_state = 'EXPIRED'"), "provider_connections EXPIRED");
    case "provider_rate_limits":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM rate_limit_events WHERE action_taken = 'throttled' AND window_start >= ?", dayAgo), "rate_limit_events throttled (24h)");
    case "provider_autonomous_responses":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM capability_proofs WHERE state = 'verified' AND provider_response_id IS NOT NULL"), "capability_proofs with provider_response_id");
    case "github_pr_open":
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM git_pull_requests p JOIN git_repositories r ON r.repo_id = p.repo_id WHERE p.status IN ('OPEN','REVIEW_PENDING','APPROVED','MERGING') AND ${project.sql.replace("project_id", "r.project_id")}`, ...project.params),
        "git_pull_requests open states",
      );
    case "github_pr_merged":
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM git_pull_requests p JOIN git_repositories r ON r.repo_id = p.repo_id WHERE p.status = 'MERGED' AND ${project.sql.replace("project_id", "r.project_id")}`, ...project.params),
        "git_pull_requests MERGED",
      );
    case "github_reviews_valid":
      return measured(
        await count(
          db,
          `SELECT COUNT(*) AS n FROM code_reviews v JOIN git_pull_requests p ON p.pull_request_id = v.pull_request_id
           JOIN git_repositories r ON r.repo_id = p.repo_id
           WHERE v.reviewed_sha = p.head_sha AND v.verdict = 'APPROVE' AND ${project.sql.replace("project_id", "r.project_id")}`,
          ...project.params,
        ),
        "code_reviews reviewed_sha = PR head_sha",
      );
    case "github_conflicts":
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM git_pull_requests p JOIN git_repositories r ON r.repo_id = p.repo_id WHERE p.status = 'CONFLICT' AND ${project.sql.replace("project_id", "r.project_id")}`, ...project.params),
        "git_pull_requests CONFLICT",
      );
    case "ci_runs":
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM ci_runs c JOIN git_repositories r ON r.repo_id = c.repo_id WHERE ${project.sql.replace("project_id", "r.project_id")}`, ...project.params),
        "ci_runs (real GitHub run ids)",
      );
    case "ci_pass_rate": {
      const completed = await count(
        db,
        `SELECT COUNT(*) AS n FROM ci_runs c JOIN git_repositories r ON r.repo_id = c.repo_id
         WHERE c.status = 'completed' AND ${project.sql.replace("project_id", "r.project_id")}`,
        ...project.params,
      );
      const passed = await count(
        db,
        `SELECT COUNT(*) AS n FROM ci_runs c JOIN git_repositories r ON r.repo_id = c.repo_id
         WHERE c.status = 'completed' AND c.conclusion = 'success' AND ${project.sql.replace("project_id", "r.project_id")}`,
        ...project.params,
      );
      return completed === 0 ? unavailable("no completed run", "완료된 Actions 실행이 없습니다.") : measured(Math.round((passed / completed) * 1000) / 1000, `${passed}/${completed} completed runs`);
    }
    case "ci_queue_latency":
      return unavailable("no queued_at column", "큐 진입 시각을 저장하지 않아 대기 시간을 계산할 수 없습니다.");
    case "ci_duration": {
      const rows = await allRows<{ delta: number }>(
        db,
        `SELECT (julianday(c.last_synced_at) - julianday(c.created_at)) * 86400000.0 AS delta
         FROM ci_runs c JOIN git_repositories r ON r.repo_id = c.repo_id
         WHERE c.status = 'completed' AND ${project.sql.replace("project_id", "r.project_id")}`,
        ...project.params,
      );
      const p95 = percentile(rows.map((row) => row.delta), 95);
      return p95 === null ? unavailable("no completed run", "완료된 실행이 없습니다.") : estimated(Math.round(p95), "ci_runs created_at → last_synced_at", "Actions 시작/종료 시각이 없어 마지막 동기화 시각으로 추정합니다.");
    }
    case "ci_retry_ratio": {
      const jobs = await count(db, `SELECT COUNT(*) AS n FROM jobs WHERE ${project.sql}`, ...project.params);
      const retried = await count(
        db,
        `SELECT COUNT(*) AS n FROM (SELECT job_id FROM job_attempts GROUP BY job_id HAVING COUNT(*) > 1) x
         WHERE x.job_id IN (SELECT job_id FROM jobs WHERE ${project.sql})`,
        ...project.params,
      );
      return jobs === 0 ? unavailable("no job", "실행 기록이 없습니다.") : measured(Math.round((retried / jobs) * 1000) / 1000, `${retried}/${jobs} jobs retried`);
    }
    case "tests_passed":
      return measured(
        await count(db, `SELECT COALESCE(SUM(t.total - t.failed - t.skipped),0) AS n FROM test_runs t JOIN ci_runs c ON c.ci_run_id = t.ci_run_id JOIN git_repositories r ON r.repo_id = c.repo_id WHERE ${project.sql.replace("project_id", "r.project_id")}`, ...project.params),
        "test_runs passed = total - failed - skipped",
      );
    case "tests_failed":
      return measured(await count(db, `SELECT COALESCE(SUM(t.failed),0) AS n FROM test_runs t JOIN ci_runs c ON c.ci_run_id = t.ci_run_id JOIN git_repositories r ON r.repo_id = c.repo_id WHERE ${project.sql.replace("project_id", "r.project_id")}`, ...project.params), "test_runs failed");
    case "tests_skipped":
      return measured(await count(db, `SELECT COALESCE(SUM(t.skipped),0) AS n FROM test_runs t JOIN ci_runs c ON c.ci_run_id = t.ci_run_id JOIN git_repositories r ON r.repo_id = c.repo_id WHERE ${project.sql.replace("project_id", "r.project_id")}`, ...project.params), "test_runs skipped");
    case "coverage_pct":
      return unavailable("no coverage report", "커버리지 리포트가 업로드되지 않았습니다.");
    case "artifact_count":
      return measured(
        await count(db, `SELECT COUNT(*) AS n FROM artifact_files f JOIN artifacts a ON a.artifact_id = f.artifact_id WHERE a.verification_state = 'VERIFIED' AND a.deleted_at IS NULL AND ${project.sql.replace("project_id", "a.project_id")}`, ...project.params),
        "artifact_files of VERIFIED artifacts",
      );
    case "artifact_bytes":
      return measured(
        await count(db, `SELECT COALESCE(SUM(f.size_bytes),0) AS n FROM artifact_files f JOIN artifacts a ON a.artifact_id = f.artifact_id WHERE a.verification_state = 'VERIFIED' AND a.deleted_at IS NULL AND ${project.sql.replace("project_id", "a.project_id")}`, ...project.params),
        "sum artifact_files.size_bytes (VERIFIED)",
      );
    case "storage_r2_bytes":
      return unavailable("R2 not enabled", "R2 바인딩이 없어 저장량을 관측할 수 없습니다.");
    case "d1_reads":
    case "d1_writes":
      return unavailable("no platform telemetry export", "Cloudflare D1 사용량은 배포 계정의 관측 API에서만 확인할 수 있습니다.");
    case "websocket_connections": {
      const value = await count(db, "SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL AND session_assurance = 'ephemeral_ws_ticket'");
      return estimated(value, "WS tickets issued (session rows)", "DO presence는 D1에 없어 발급된 WS 티켓 세션으로 추정합니다.");
    }
    case "search_latency_ms": {
      const rows = await allRows<{ value: number }>(
        db,
        "SELECT value FROM project_metrics WHERE metric_key = 'search_latency_ms' AND value IS NOT NULL ORDER BY computed_at DESC LIMIT 200",
      );
      const p95 = percentile(rows.map((row) => row.value), 95);
      return p95 === null ? unavailable("no recorded search", "검색 실행 기록이 없습니다.") : measured(Math.round(p95), "project_metrics search_latency_ms");
    }
    case "security_denied_requests":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM audit_events WHERE allow_or_deny = 'deny' AND created_at >= ?", dayAgo), "audit_events deny (24h)");
    case "backup_integrity_pass": {
      const tests = await count(db, "SELECT COUNT(*) AS n FROM restore_runs WHERE integrity_check_state IS NOT NULL");
      const passed = await count(db, "SELECT COUNT(*) AS n FROM restore_runs WHERE integrity_check_state = 'passed'");
      return tests === 0 ? unavailable("no restore test", "복원 검증 실행 기록이 없습니다.") : measured(Math.round((passed / tests) * 1000) / 1000, `${passed}/${tests} restore integrity checks`);
    }
    case "pending_owner_approvals":
      return measured(await count(db, "SELECT COUNT(*) AS n FROM approvals WHERE state = 'PENDING' AND expires_at > ?", nowIsoValue), "approvals PENDING and unexpired");
    case "project_progress_pct": {
      const rows = await allRows<{ state: string; risk_level: string; verified: number }>(
        db,
        `SELECT t.state, t.risk_level,
                (SELECT COUNT(*) FROM task_evidence e WHERE e.task_id = t.task_id AND e.verification_state = 'verified') AS verified
         FROM tasks t WHERE t.deleted_at IS NULL AND ${project.sql}`,
        ...project.params,
      );
      if (rows.length === 0) return unavailable("no task", "작업이 없습니다.");
      const weight = (risk: string): number => (risk === "critical" ? 4 : risk === "high" ? 3 : risk === "medium" ? 2 : 1);
      const total = rows.reduce((sum, row) => sum + weight(row.risk_level), 0);
      const done = rows.filter((row) => row.state === "DONE" && row.verified > 0).reduce((sum, row) => sum + weight(row.risk_level), 0);
      return estimated(Math.round((done / total) * 1000) / 10, `${done}/${total} risk-weighted tasks verified DONE`, "acceptance-criteria 테이블이 없어 위험도 가중치로 근사합니다.");
    }
    default:
      return unavailable("unknown metric", "카탈로그에 없는 지표입니다.");
  }
}

export async function computeMetrics(ctx: MetricContext): Promise<MetricValue[]> {
  const out: MetricValue[] = [];
  for (const definition of METRIC_DEFINITIONS) {
    const measurement = await measure(definition.key, ctx);
    out.push({
      ...definition,
      value: measurement.value,
      source: measurement.source,
      evidence: measurement.evidence,
      ...(measurement.note === undefined ? {} : { note: measurement.note }),
    });
  }
  return out;
}

export function metricSummary(values: readonly MetricValue[]): { measured: number; estimated: number; unavailable: number; total: number } {
  return {
    measured: values.filter((value) => value.source === "measured").length,
    estimated: values.filter((value) => value.source === "estimated").length,
    unavailable: values.filter((value) => value.source === "unavailable").length,
    total: values.length,
  };
}

/** Stores a measured value for a project so a later read reports evidence, not a guess. */
export async function recordProjectMetric(
  db: SqlDb,
  input: { projectId: string; key: string; value: number; unit: string; periodStart: string; source?: "measured" | "estimated" },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_metrics (project_id, metric_key, period_start, value, unit, source, computed_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(project_id, metric_key, period_start)
       DO UPDATE SET value = excluded.value, source = excluded.source, computed_at = excluded.computed_at`,
    )
    .bind(input.projectId, input.key, input.periodStart, input.value, input.unit, input.source ?? "measured", nowIso())
    .run();
}

export interface AuditInput {
  readonly db: SqlDb;
  readonly eventType: string;
  readonly actorKind: "owner" | "agent" | "system";
  readonly actorId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly allowOrDeny: "allow" | "deny";
  readonly reasonCode: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Append-only audit write; the schema refuses UPDATE/DELETE on these rows. */
export async function writeAudit(input: AuditInput): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO audit_events
        (audit_id, event_type, actor_kind, actor_id, target_type, target_id, correlation_id, request_id, allow_or_deny, reason_code, metadata_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      `evt_${Math.random().toString(36).slice(2, 12)}`,
      input.eventType,
      input.actorKind,
      input.actorId,
      input.targetType,
      input.targetId,
      input.correlationId ?? null,
      input.requestId ?? null,
      input.allowOrDeny,
      input.reasonCode,
      JSON.stringify(input.metadata ?? {}),
      nowIso(),
    )
    .run();
}

/** Alert evaluation over the catalog (spec 16.3). Rules are data, not if-statements. */
export async function evaluateAlertRules(db: SqlDb, values: readonly MetricValue[]): Promise<{ raised: number; rules: number }> {
  const rules = await allRows<{ rule_id: string; metric_key: string; comparison: string; threshold: number; severity: "info" | "warning" | "critical"; enabled: number }>(
    db,
    "SELECT rule_id, metric_key, comparison, threshold, severity, enabled FROM alert_rules WHERE enabled = 1",
  );
  const byKey = new Map(values.map((value) => [value.key, value]));
  let raised = 0;
  for (const rule of rules) {
    const metric = byKey.get(rule.metric_key);
    if (metric === undefined || metric.value === null) continue;
    const hit =
      rule.comparison === "gt" ? metric.value > rule.threshold :
      rule.comparison === "gte" ? metric.value >= rule.threshold :
      rule.comparison === "lt" ? metric.value < rule.threshold :
      rule.comparison === "lte" ? metric.value <= rule.threshold :
      metric.value === rule.threshold;
    if (!hit) continue;
    const existing = await count(
      db,
      "SELECT COUNT(*) AS n FROM alerts WHERE rule_id = ? AND state = 'OPEN'",
      rule.rule_id,
    );
    if (existing > 0) continue;
    await db
      .prepare("INSERT INTO alerts (alert_id, rule_id, severity, title, detail, state, raised_at) VALUES (?,?,?,?,?,'OPEN',?)")
      .bind(`alt_${Math.random().toString(36).slice(2, 12)}`, rule.rule_id, rule.severity, `${metric.label} 경보`, `${metric.key}=${metric.value} (${rule.comparison} ${rule.threshold})`, nowIso())
      .run();
    raised += 1;
  }
  return { raised, rules: rules.length };
}

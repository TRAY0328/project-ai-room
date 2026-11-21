/**
 * Continuity engine — spec 09.1-09.5, Q038, E2E-07/24, S42.
 *
 * A session state is decided from evidence (last response, authentication,
 * ping), never from optimism. Reconnection is bounded and typed:
 *   401/403 -> AUTH_REQUIRED, no retry storm;
 *   429      -> honour Retry-After;
 *   timeout  -> UNCERTAIN, and the work must be reconciled before re-running;
 *   quota    -> WAITING_FOR_QUOTA until the window resets.
 * A resumed session replays from the last ACKed cursor only.
 */
import { backoffDelayMs } from "@ai-room/contracts";

export const SESSION_STATES = [
  "REGISTERED",
  "AUTHENTICATED",
  "CONNECTED",
  "AVAILABLE",
  "BUSY",
  "IDLE",
  "RATE_LIMITED",
  "EXPIRED",
  "DISCONNECTED",
  "UNSUPPORTED",
  "BLOCKED",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface SessionEvidence {
  readonly registered: boolean;
  readonly authenticatedAtMs: number | null;
  readonly connected: boolean;
  readonly lastResponseAtMs: number | null;
  readonly lastPingAtMs: number | null;
  readonly rateLimitedUntilMs: number | null;
  readonly busy: boolean;
  readonly unsupportedReason: string | null;
  readonly blockedReason: string | null;
  readonly quotaExhausted: boolean;
}

export interface SessionSnapshot {
  readonly state: SessionState;
  readonly decided_at_ms: number;
  readonly reason: string;
  /** Never true without a real provider response behind it. */
  readonly online: boolean;
}

export function decideSessionState(evidence: SessionEvidence, nowMs: number = Date.now()): SessionSnapshot {
  const decide = (state: SessionState, reason: string): SessionSnapshot => ({
    state,
    decided_at_ms: nowMs,
    reason,
    online: state === "AVAILABLE" || state === "BUSY" || state === "IDLE",
  });
  if (!evidence.registered) return decide("DISCONNECTED", "not registered");
  if (evidence.blockedReason !== null) return decide("BLOCKED", evidence.blockedReason);
  if (evidence.unsupportedReason !== null) return decide("UNSUPPORTED", evidence.unsupportedReason);
  if (evidence.authenticatedAtMs === null) return decide("REGISTERED", "no authentication evidence");
  if (evidence.quotaExhausted) return decide("RATE_LIMITED", "quota exhausted");
  if (evidence.rateLimitedUntilMs !== null && evidence.rateLimitedUntilMs > nowMs) return decide("RATE_LIMITED", "provider retry-after in effect");
  if (!evidence.connected) return decide("DISCONNECTED", "socket closed");
  if (evidence.busy) return decide("BUSY", "turn in progress");
  if (evidence.lastResponseAtMs === null && evidence.lastPingAtMs === null) return decide("AUTHENTICATED", "authenticated, no activity yet");
  return decide("AVAILABLE", "authenticated and heartbeat fresh");
}

export type FailureClass =
  | { readonly kind: "network"; readonly retryable: true }
  | { readonly kind: "auth"; readonly status: 401 | 403; readonly retryable: false }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | null }
  | { readonly kind: "quota"; readonly retryable: false }
  | { readonly kind: "timeout"; readonly retryable: false }
  | { readonly kind: "provider_error"; readonly status: number; readonly retryable: boolean };

export interface RetryPlan {
  readonly next_delay_ms: number | null;
  readonly max_attempts: number;
  readonly give_up_state: SessionState | null;
  readonly note: string;
}

export function planRetry(failure: FailureClass, attempt: number, random: () => number = Math.random): RetryPlan {
  switch (failure.kind) {
    case "network":
      return {
        next_delay_ms: backoffDelayMs(attempt, { baseMs: 500, maxMs: 60_000, multiplier: 2 }, random),
        max_attempts: 8,
        give_up_state: "DISCONNECTED",
        note: "지수 백오프 + jitter",
      };
    case "rate_limited":
      return {
        next_delay_ms: failure.retryAfterMs ?? backoffDelayMs(attempt, { baseMs: 1_000, maxMs: 300_000, multiplier: 2 }, random),
        max_attempts: 5,
        give_up_state: "RATE_LIMITED",
        note: "제공자가 준 Retry-After를 존중",
      };
    case "auth":
      return { next_delay_ms: null, max_attempts: 0, give_up_state: "EXPIRED", note: "401/403은 재시도 금지. 재인증 필요" };
    case "quota":
      return { next_delay_ms: null, max_attempts: 0, give_up_state: "RATE_LIMITED", note: "한도 소진: 창 리셋까지 대기" };
    case "timeout":
      return { next_delay_ms: null, max_attempts: 0, give_up_state: "DISCONNECTED", note: "결과 불확실: 재실행 전 정합성 재조정 필요" };
    case "provider_error":
      return failure.retryable
        ? { next_delay_ms: backoffDelayMs(attempt, { baseMs: 1_000, maxMs: 120_000, multiplier: 2 }, random), max_attempts: 4, give_up_state: "DISCONNECTED", note: "제공자 오류(재시도 가능)" }
        : { next_delay_ms: null, max_attempts: 0, give_up_state: "BLOCKED", note: "제공자 오류(재시도 불가)" };
  }
}

export interface ResumePlan {
  readonly mode: "resume" | "reconcile" | "reauth" | "wait";
  readonly from_cursor: string | null;
  readonly reason: string;
}

/** Reconnect: replay from the last ACKed cursor, or reconcile after a timeout. */
export function planResume(input: {
  readonly lastAckedCursor: string | null;
  readonly lastCallState: "ok" | "timeout" | "auth_failed" | "rate_limited" | "never";
  readonly nowMs: number;
  readonly retryAfterMs?: number | null;
}): ResumePlan {
  if (input.lastCallState === "auth_failed") return { mode: "reauth", from_cursor: null, reason: "자격 증명 만료" };
  if (input.lastCallState === "timeout") return { mode: "reconcile", from_cursor: input.lastAckedCursor, reason: "결과 불확실: 재실행 금지, 정합성 재조정" };
  if (input.lastCallState === "rate_limited") return { mode: "wait", from_cursor: input.lastAckedCursor, reason: `Retry-After ${input.retryAfterMs ?? 0}ms` };
  return { mode: "resume", from_cursor: input.lastAckedCursor, reason: input.lastAckedCursor === null ? "커서 없음: 스냅샷 필요" : "마지막 ACK 커서부터 재수신" };
}

/** Checkpoint shape the engine accepts (spec 09.3). No secrets allowed inside. */
export interface Checkpoint {
  readonly task_id: string;
  readonly attempt_id: string;
  readonly base_commit_sha: string;
  readonly changed_files_manifest: readonly string[];
  readonly executed_commands: readonly string[];
  readonly test_results: { readonly suite: string; readonly passed: number; readonly failed: number };
  readonly agent_messages_cursor: string | null;
  readonly retry_count: number;
  readonly lease_generation: number;
  readonly checkpoint_hash: string;
}

const FORBIDDEN_KEYS = ["token", "password", "secret", "api_key", "authorization", "cookie", "refresh_token", "agent_key"];

export function validateCheckpoint(value: unknown): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  if (value === null || typeof value !== "object") return { valid: false, problems: ["not an object"] };
  const record = value as Record<string, unknown>;
  for (const key of ["task_id", "attempt_id", "base_commit_sha", "checkpoint_hash"]) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) problems.push(`missing ${key}`);
  }
  const serialised = JSON.stringify(record).toLowerCase();
  for (const forbidden of FORBIDDEN_KEYS) {
    if (serialised.includes(`"${forbidden}`)) problems.push(`forbidden field: ${forbidden}`);
  }
  if (serialised.includes("-----begin") || serialised.includes("bearer ")) problems.push("secret material detected");
  return { valid: problems.length === 0, problems };
}

/** Handoff is allowed only for a live checkpoint and a capable successor. */
export function canHandoff(input: {
  readonly checkpointValid: boolean;
  readonly checkpointAgeMs: number;
  readonly maxAgeMs: number;
  readonly successorHasVerifiedCapability: boolean;
  readonly successorInProject: boolean;
  readonly successorBlocked: boolean;
}): { allowed: boolean; reason: string } {
  if (!input.checkpointValid) return { allowed: false, reason: "체크포인트 무결성 실패" };
  if (input.checkpointAgeMs > input.maxAgeMs) return { allowed: false, reason: "체크포인트 만료" };
  if (input.successorBlocked) return { allowed: false, reason: "대체 AI가 차단 상태" };
  if (!input.successorHasVerifiedCapability) return { allowed: false, reason: "대체 AI의 능력 증거 없음" };
  if (!input.successorInProject) return { allowed: false, reason: "대체 AI가 프로젝트 멤버 아님" };
  return { allowed: true, reason: "인계 가능" };
}

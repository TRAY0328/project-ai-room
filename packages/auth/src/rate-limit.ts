/**
 * Attempt budgets — spec 06.1 (등록 레이트리밋), 20.2 (과금/남용), S01, S02.
 *
 * A fixed window count in D1 is enough here: the budgets are small (a handful of
 * attempts per window), D1 is single-writer, and the row also becomes the audit
 * trail for abuse detection. A throttled attempt is recorded, never hidden.
 */
import { ApiError, newRequestId } from "@ai-room/contracts";
import type { SqlDb } from "./db.js";
import { count, nowIso } from "./db.js";
import { randomToken } from "./crypto.js";

export interface RateLimitPolicy {
  /** Stable key: e.g. `invite:register:<ip-hash>` — never a raw IP or a secret. */
  readonly limitKey: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly providerKey: string;
  readonly subjectKind: "owner" | "agent" | "ip" | "invite";
  readonly subjectId: string;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly used: number;
}

export async function consumeRateLimit(
  db: SqlDb,
  policy: RateLimitPolicy,
  nowMs: number = Date.now(),
): Promise<RateLimitDecision> {
  const windowStartIso = new Date(nowMs - policy.windowMs).toISOString();
  const used = await count(
    db,
    "SELECT COUNT(*) AS n FROM rate_limit_events WHERE limit_key = ? AND window_start >= ?",
    policy.limitKey,
    windowStartIso,
  );
  const allowed = used < policy.limit;
  const action = allowed ? "allowed" : "throttled";
  await db
    .prepare(
      `INSERT INTO rate_limit_events
        (event_id, provider_key, subject_kind, subject_id, limit_key, window_start, count, action_taken, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      `rle_${randomToken("", 12)}`,
      policy.providerKey,
      policy.subjectKind,
      policy.subjectId,
      policy.limitKey,
      nowIso(),
      used + 1,
      action,
      nowIso(),
    )
    .run();
  return {
    allowed,
    used,
    remaining: Math.max(0, policy.limit - used - (allowed ? 1 : 0)),
    retryAfterSeconds: allowed ? 0 : Math.ceil(policy.windowMs / 1000),
  };
}

/** Throws RATE_LIMITED with a Retry-After hint when the budget is spent. */
export async function enforceRateLimit(
  db: SqlDb,
  policy: RateLimitPolicy,
  requestId: string,
  nowMs: number = Date.now(),
): Promise<RateLimitDecision> {
  const decision = await consumeRateLimit(db, policy, nowMs);
  if (!decision.allowed) {
    throw new ApiError({
      code: "RATE_LIMITED",
      requestId,
      details: { retry_after_seconds: decision.retryAfterSeconds, limit_key: policy.limitKey },
    });
  }
  return decision;
}

export function requireRequestId(value: string | undefined): string {
  return value !== undefined && value.startsWith("req_") ? value : newRequestId();
}

/**
 * Failure-only budget: a successful invite check must not spend the abuse
 * budget, otherwise a normal onboarding day would lock out legitimate AIs.
 * Every failure is recorded, and the budget is checked before verifying.
 */
export async function enforceFailureBudget(
  db: SqlDb,
  policy: RateLimitPolicy,
  requestId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const windowStartIso = new Date(nowMs - policy.windowMs).toISOString();
  const failures = await count(
    db,
    "SELECT COUNT(*) AS n FROM rate_limit_events WHERE limit_key = ? AND window_start >= ?",
    policy.limitKey,
    windowStartIso,
  );
  if (failures >= policy.limit) {
    throw new ApiError({
      code: "RATE_LIMITED",
      requestId,
      details: { retry_after_seconds: Math.ceil(policy.windowMs / 1000), limit_key: policy.limitKey, failures },
    });
  }
}

export async function recordFailure(db: SqlDb, policy: RateLimitPolicy, nowMs: number = Date.now()): Promise<void> {
  const windowStartIso = new Date(nowMs - policy.windowMs).toISOString();
  const failures = await count(
    db,
    "SELECT COUNT(*) AS n FROM rate_limit_events WHERE limit_key = ? AND window_start >= ?",
    policy.limitKey,
    windowStartIso,
  );
  await db
    .prepare(
      `INSERT INTO rate_limit_events (event_id, provider_key, subject_kind, subject_id, limit_key, window_start, count, action_taken, created_at)
       VALUES (?,?,?,?,?,?,?,'throttled',?)`,
    )
    .bind(`rle_${randomToken("", 12)}`, policy.providerKey, policy.subjectKind, policy.subjectId, policy.limitKey, nowIso(), failures + 1, nowIso())
    .run();
}

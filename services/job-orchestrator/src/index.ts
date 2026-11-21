/**
 * Job orchestrator — spec 36.3, 36.4, 14.2, 14.6
 *
 * The orchestrator owns task leases and job state, and its most important job
 * is refusing to overstate progress:
 *   - a lease is time-bounded and a late result from an old generation is rejected
 *     (fencing), so two AIs editing the same task cannot both "win";
 *   - a dispatch request is not a started run;
 *   - a cancel request is not a cancelled run — the platform's own state decides.
 */
import {
  canTransitionJob,
  reconcileJobCancel,
  type JobState,
} from "@ai-room/contracts";

export interface Lease {
  readonly taskId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly fencingGeneration: number;
  readonly grantedAtMs: number;
  readonly expiresAtMs: number;
}

export interface LeaseDecision {
  readonly granted: boolean;
  readonly reason: "GRANTED" | "NOT_EXPIRED" | "TASK_NOT_READY" | "DEPENDENCIES_INCOMPLETE" | "AGENT_BLOCKED";
  readonly lease?: Lease;
}

export interface AgentAvailability {
  readonly agentId: string;
  readonly blocked: boolean;
  /** True only when at least one capability proof is verified and unexpired. */
  readonly hasVerifiedCapability: boolean;
}

export class LeaseManager {
  private readonly leases = new Map<string, Lease>();
  private readonly generations = new Map<string, number>();

  grant(input: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly agent: AgentAvailability;
    readonly taskReady: boolean;
    readonly dependenciesDone: boolean;
    readonly nowMs: number;
    readonly ttlMs: number;
  }): LeaseDecision {
    if (input.agent.blocked || !input.agent.hasVerifiedCapability) {
      return { granted: false, reason: "AGENT_BLOCKED" };
    }
    if (!input.taskReady) return { granted: false, reason: "TASK_NOT_READY" };
    if (!input.dependenciesDone) return { granted: false, reason: "DEPENDENCIES_INCOMPLETE" };
    const current = this.leases.get(input.taskId);
    if (current !== undefined && current.expiresAtMs > input.nowMs) {
      return { granted: false, reason: "NOT_EXPIRED" };
    }
    const generation = (this.generations.get(input.taskId) ?? 0) + 1;
    this.generations.set(input.taskId, generation);
    const lease: Lease = {
      taskId: input.taskId,
      attemptId: input.attemptId,
      agentId: input.agent.agentId,
      fencingGeneration: generation,
      grantedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + input.ttlMs,
    };
    this.leases.set(input.taskId, lease);
    return { granted: true, reason: "GRANTED", lease };
  }

  /**
   * A result is accepted only from the current generation and before expiry.
   * A late return from an expired lease is rejected, not merged.
   */
  acceptResult(taskId: string, attemptId: string, fencingGeneration: number, nowMs: number): boolean {
    const lease = this.leases.get(taskId);
    if (lease === undefined) return false;
    if (lease.attemptId !== attemptId) return false;
    if (lease.fencingGeneration !== fencingGeneration) return false;
    if (lease.expiresAtMs <= nowMs) return false;
    return true;
  }

  currentGeneration(taskId: string): number {
    return this.generations.get(taskId) ?? 0;
  }
}

export interface JobRecord {
  readonly jobId: string;
  state: JobState;
  attempts: number;
  lastPlatformState: "queued" | "in_progress" | "completed" | "unknown";
  lastConclusion: "success" | "failure" | "cancelled" | "timed_out" | null;
  cancelRequested: boolean;
}

export interface JobAction {
  readonly accepted: boolean;
  readonly reason: "OK" | "ILLEGAL_TRANSITION" | "CANCEL_NOT_CONFIRMED" | "BUDGET_BLOCKED";
  readonly state: JobState;
}

/** Free-tier guard: no new dispatch when the budget check cannot prove headroom. */
export function canDispatch(input: {
  readonly observedUsage: number | null;
  readonly hardLimit: number;
  readonly estimatedCost: number;
}): boolean {
  if (input.observedUsage === null) return false; // unmeasured usage is not "zero"
  return input.observedUsage + input.estimatedCost <= input.hardLimit;
}

export class JobOrchestrator {
  private readonly jobs = new Map<string, JobRecord>();

  enqueue(jobId: string): JobRecord {
    const record: JobRecord = {
      jobId,
      state: "QUEUED",
      attempts: 0,
      lastPlatformState: "unknown",
      lastConclusion: null,
      cancelRequested: false,
    };
    this.jobs.set(jobId, record);
    return record;
  }

  transition(jobId: string, to: JobState): JobAction {
    const record = this.jobs.get(jobId);
    if (record === undefined) return { accepted: false, reason: "ILLEGAL_TRANSITION", state: "FAILED" };
    if (!canTransitionJob(record.state, to)) {
      return { accepted: false, reason: "ILLEGAL_TRANSITION", state: record.state };
    }
    record.state = to;
    if (to === "DISPATCHED" || to === "RUNNING") record.attempts += 1;
    return { accepted: true, reason: "OK", state: record.state };
  }

  /** Records the owner's cancel wish; it does not change the state by itself. */
  requestCancel(jobId: string): JobAction {
    const record = this.jobs.get(jobId);
    if (record === undefined) return { accepted: false, reason: "ILLEGAL_TRANSITION", state: "FAILED" };
    if (!canTransitionJob(record.state, "CANCEL_REQUESTED")) {
      return { accepted: false, reason: "ILLEGAL_TRANSITION", state: record.state };
    }
    record.cancelRequested = true;
    record.state = "CANCEL_REQUESTED";
    return { accepted: true, reason: "OK", state: record.state };
  }

  /** Applies the platform's reported run state; this is where CANCEL becomes final. */
  applyPlatformState(jobId: string, platformState: "queued" | "in_progress" | "completed" | "unknown", conclusion: JobRecord["lastConclusion"]): JobAction {
    const record = this.jobs.get(jobId);
    if (record === undefined) return { accepted: false, reason: "ILLEGAL_TRANSITION", state: "FAILED" };
    record.lastPlatformState = platformState;
    record.lastConclusion = conclusion;
    const next = reconcileJobCancel({
      requested: record.cancelRequested,
      platformState,
      platformConclusion: conclusion,
    });
    if (next === record.state) {
      return {
        accepted: true,
        reason: platformState === "unknown" ? "CANCEL_NOT_CONFIRMED" : "OK",
        state: record.state,
      };
    }
    record.state = next;
    return { accepted: true, reason: "OK", state: record.state };
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }
}

// ---------------------------------------------------------------------------
// Dispatch gate, budget ledger and handoff coordination
// ---------------------------------------------------------------------------

export type DispatchBlocker =
  | "EMERGENCY_STOP"
  | "NO_REPOSITORY"
  | "NO_PROVIDER_CLIENT"
  | "OBSERVED_USAGE_UNKNOWN"
  | "HARD_LIMIT_REACHED"
  | "WORKFLOW_NOT_ALLOWED";

export interface DispatchDecision {
  readonly allowed: boolean;
  readonly blockers: readonly DispatchBlocker[];
  readonly state_if_blocked: JobState;
}

/**
 * A dispatch is allowed only when every precondition is *observed*, not assumed.
 * Unknown usage is a blocker: "we could not measure it" is not "it is free".
 */
export function evaluateDispatch(input: {
  readonly emergencyStop: boolean;
  readonly repositoryBound: boolean;
  readonly providerClientBound: boolean;
  readonly observedUsage: number | null;
  readonly hardLimit: number;
  readonly estimatedCost: number;
  readonly workflowAllowlisted: boolean;
}): DispatchDecision {
  const blockers: DispatchBlocker[] = [];
  if (input.emergencyStop) blockers.push("EMERGENCY_STOP");
  if (!input.repositoryBound) blockers.push("NO_REPOSITORY");
  if (!input.providerClientBound) blockers.push("NO_PROVIDER_CLIENT");
  if (!input.workflowAllowlisted) blockers.push("WORKFLOW_NOT_ALLOWED");
  if (input.observedUsage === null) blockers.push("OBSERVED_USAGE_UNKNOWN");
  else if (input.observedUsage + input.estimatedCost > input.hardLimit) blockers.push("HARD_LIMIT_REACHED");
  return {
    allowed: blockers.length === 0,
    blockers,
    state_if_blocked: blockers.includes("EMERGENCY_STOP") ? "BLOCKED_EXTERNAL_DEPENDENCY" : "BLOCKED_EXTERNAL_DEPENDENCY",
  };
}

/** Workflows a project may dispatch: a literal allowlist, never a glob. */
export const ALLOWED_WORKFLOW_FILES = [
  ".github/workflows/verify.yml",
  ".github/workflows/build-web.yml",
  ".github/workflows/build-windows.yml",
  ".github/workflows/build-android.yml",
  ".github/workflows/security.yml",
] as const;

export function workflowAllowlisted(file: string): boolean {
  return (ALLOWED_WORKFLOW_FILES as readonly string[]).includes(file);
}

export interface BudgetWindow {
  readonly key: string;
  readonly limit: number;
  readonly used: number;
  readonly measured: boolean;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly reason: "OK" | "UNMEASURED" | "EXHAUSTED";
  readonly remaining: number | null;
}

export class BudgetLedger {
  private readonly windows = new Map<string, BudgetWindow>();

  set(window: BudgetWindow): void {
    this.windows.set(window.key, window);
  }

  check(key: string, cost: number): BudgetDecision {
    const window = this.windows.get(key);
    if (window === undefined) return { allowed: false, reason: "UNMEASURED", remaining: null };
    if (!window.measured) return { allowed: false, reason: "UNMEASURED", remaining: null };
    const remaining = window.limit - window.used;
    if (remaining < cost) return { allowed: false, reason: "EXHAUSTED", remaining };
    return { allowed: true, reason: "OK", remaining: remaining - cost };
  }

  consume(key: string, amount: number): void {
    const window = this.windows.get(key);
    if (window === undefined) return;
    this.windows.set(key, { ...window, used: window.used + amount });
  }
}

export interface HandoffCheckpoint {
  readonly checkpoint_id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly fencing_generation: number;
  readonly created_at_ms: number;
  readonly valid_for_ms: number;
  readonly checkpoint_sha256: string;
  /** Integrity: recomputed hash must equal the stored one. */
  readonly integrity_ok: boolean;
}

export interface HandoffPlan {
  readonly allowed: boolean;
  readonly reason:
    | "OK"
    | "CHECKPOINT_INTEGRITY_FAILED"
    | "CHECKPOINT_EXPIRED"
    | "SUCCESSOR_NOT_CAPABLE"
    | "SUCCESSOR_BLOCKED"
    | "SUCCESSOR_SAME_AGENT";
  readonly old_attempt_status: "SUPERSEDED" | "KEPT";
  readonly new_fencing_generation: number | null;
}

/**
 * Handoff: stop the old attempt first (supersede), then grant a new generation.
 * Only work context travels; credentials never do.
 */
export function planHandoff(input: {
  readonly checkpoint: HandoffCheckpoint;
  readonly currentGeneration: number;
  readonly successorHasVerifiedCapability: boolean;
  readonly successorBlocked: boolean;
  readonly successorIsSameAgent: boolean;
  readonly nowMs: number;
}): HandoffPlan {
  if (!input.checkpoint.integrity_ok) return { allowed: false, reason: "CHECKPOINT_INTEGRITY_FAILED", old_attempt_status: "KEPT", new_fencing_generation: null };
  if (input.nowMs - input.checkpoint.created_at_ms > input.checkpoint.valid_for_ms) {
    return { allowed: false, reason: "CHECKPOINT_EXPIRED", old_attempt_status: "KEPT", new_fencing_generation: null };
  }
  if (input.successorBlocked) return { allowed: false, reason: "SUCCESSOR_BLOCKED", old_attempt_status: "KEPT", new_fencing_generation: null };
  if (!input.successorHasVerifiedCapability) return { allowed: false, reason: "SUCCESSOR_NOT_CAPABLE", old_attempt_status: "KEPT", new_fencing_generation: null };
  if (input.successorIsSameAgent) return { allowed: false, reason: "SUCCESSOR_SAME_AGENT", old_attempt_status: "KEPT", new_fencing_generation: null };
  return { allowed: true, reason: "OK", old_attempt_status: "SUPERSEDED", new_fencing_generation: input.currentGeneration + 1 };
}

/** Periodic reconciliation: a message saying "done" is not a completed run. */
export function reconcileJobAgainstPlatform(input: {
  readonly localState: JobState;
  readonly platformState: "queued" | "in_progress" | "completed" | "unknown";
  readonly platformConclusion: "success" | "failure" | "cancelled" | "timed_out" | null;
}): { readonly state: JobState; readonly changed: boolean; readonly note: string } {
  if (input.platformState === "unknown") {
    return { state: input.localState, changed: false, note: "플랫폼 상태 미확인: 로컬 상태를 신뢰하지 않고 유지" };
  }
  const next = reconcileJobCancel({ requested: input.localState === "CANCEL_REQUESTED", platformState: input.platformState, platformConclusion: input.platformConclusion });
  const terminal: readonly JobState[] = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"];
  const state = terminal.includes(input.localState) ? input.localState : next;
  return { state, changed: state !== input.localState, note: `platform=${input.platformState}/${input.platformConclusion ?? "null"}` };
}

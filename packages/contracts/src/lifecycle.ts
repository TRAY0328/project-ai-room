/**
 * Lifecycle contracts — spec 36.2, 36.3, 43, 07.3
 *
 * State names are the spec's uppercase ones. Transitions are explicit because
 * the product must never treat "accepted" as "succeeded": a queued job is not a
 * finished job, a requested cancel is not a cancelled run, and DONE needs
 * evidence rather than a message that says so.
 */

export const TASK_STATES = [
  "PROPOSED",
  "SPECIFIED",
  "OPEN_FOR_CLAIM",
  "CLAIM_PROPOSED",
  "CLAIM_ACCEPTED",
  "WAITING_DEPENDENCY",
  "READY",
  "LEASED",
  "RUNNING",
  "VERIFYING",
  "RETRY_WAIT",
  "HANDOFF_REQUESTED",
  "HANDOFF_ACCEPTED",
  "BLOCKED",
  "CANCELLED",
  "FAILED",
  "DONE",
  "REOPENED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PROPOSED: ["SPECIFIED", "CANCELLED"],
  SPECIFIED: ["OPEN_FOR_CLAIM", "CANCELLED"],
  OPEN_FOR_CLAIM: ["CLAIM_PROPOSED", "CANCELLED", "BLOCKED"],
  CLAIM_PROPOSED: ["CLAIM_ACCEPTED", "OPEN_FOR_CLAIM", "CANCELLED"],
  CLAIM_ACCEPTED: ["WAITING_DEPENDENCY", "READY", "CANCELLED", "BLOCKED"],
  WAITING_DEPENDENCY: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["LEASED", "BLOCKED", "CANCELLED", "FAILED"],
  LEASED: ["RUNNING", "READY", "BLOCKED", "FAILED", "CANCELLED"],
  RUNNING: ["VERIFYING", "HANDOFF_REQUESTED", "BLOCKED", "FAILED", "CANCELLED"],
  VERIFYING: ["DONE", "RETRY_WAIT", "FAILED", "BLOCKED"],
  RETRY_WAIT: ["READY", "FAILED", "CANCELLED"],
  HANDOFF_REQUESTED: ["HANDOFF_ACCEPTED", "RUNNING", "BLOCKED", "FAILED", "CANCELLED"],
  HANDOFF_ACCEPTED: ["READY", "BLOCKED", "CANCELLED"],
  BLOCKED: ["READY", "CANCELLED", "FAILED"],
  CANCELLED: [],
  FAILED: ["REOPENED", "CANCELLED"],
  DONE: ["REOPENED"],
  REOPENED: ["SPECIFIED", "OPEN_FOR_CLAIM", "CANCELLED"],
};

export interface TransitionRequest {
  readonly from: TaskState;
  readonly to: TaskState;
  /** True only when at least one verified evidence row exists for this revision. */
  readonly hasVerifiedEvidence: boolean;
  /** True when every dependency task is DONE. */
  readonly dependenciesDone: boolean;
  /** True when the caller holds the current lease/fencing generation. */
  readonly holdsCurrentLease: boolean;
}

export type TransitionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: TransitionViolation; readonly detail: string };

export type TransitionViolation =
  | "TASK_TRANSITION_NOT_ALLOWED"
  | "TASK_DONE_REQUIRES_EVIDENCE"
  | "TASK_READY_REQUIRES_COMPLETE_DEPENDENCIES"
  | "TASK_LEASE_NOT_HELD"
  | "TASK_REOPEN_REQUIRES_REVISION";

/**
 * Validates a task transition. Default is refusal: an unlisted pair never runs.
 */
export function evaluateTaskTransition(request: TransitionRequest): TransitionVerdict {
  const allowed = TASK_TRANSITIONS[request.from] ?? [];
  if (!allowed.includes(request.to)) {
    return { ok: false, code: "TASK_TRANSITION_NOT_ALLOWED", detail: `${request.from} -> ${request.to}` };
  }
  if (request.to === "DONE" && !request.hasVerifiedEvidence) {
    return { ok: false, code: "TASK_DONE_REQUIRES_EVIDENCE", detail: "no verified evidence attached" };
  }
  if (request.to === "READY" && !request.dependenciesDone) {
    return {
      ok: false,
      code: "TASK_READY_REQUIRES_COMPLETE_DEPENDENCIES",
      detail: "at least one dependency is not DONE",
    };
  }
  if ((request.to === "RUNNING" || request.to === "VERIFYING") && !request.holdsCurrentLease) {
    return { ok: false, code: "TASK_LEASE_NOT_HELD", detail: "stale fencing generation" };
  }
  return { ok: true };
}

/** Job lifecycle: a dispatch request is not a started run, a cancel is not a stop. */
export const JOB_STATES = [
  "QUEUED",
  "DISPATCH_REQUESTED",
  "DISPATCHED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "TIMED_OUT",
  "BLOCKED_EXTERNAL_DEPENDENCY",
] as const;
export type JobState = (typeof JOB_STATES)[number];

const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  QUEUED: ["DISPATCH_REQUESTED", "BLOCKED_EXTERNAL_DEPENDENCY", "CANCELLED"],
  DISPATCH_REQUESTED: ["DISPATCHED", "FAILED", "BLOCKED_EXTERNAL_DEPENDENCY", "CANCEL_REQUESTED"],
  DISPATCHED: ["RUNNING", "FAILED", "CANCEL_REQUESTED", "TIMED_OUT"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "TIMED_OUT"],
  CANCEL_REQUESTED: ["CANCELLED", "RUNNING", "SUCCEEDED", "FAILED"],
  CANCELLED: [],
  SUCCEEDED: [],
  FAILED: [],
  TIMED_OUT: [],
  BLOCKED_EXTERNAL_DEPENDENCY: ["QUEUED", "CANCELLED"],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return (JOB_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * A cancel request is honoured only after the platform reports the run gone.
 * This helper encodes that: it never maps "requested" to "cancelled".
 */
export function reconcileJobCancel(input: {
  readonly requested: boolean;
  readonly platformState: "queued" | "in_progress" | "completed" | "unknown";
  readonly platformConclusion: "success" | "failure" | "cancelled" | "timed_out" | null;
}): JobState {
  if (input.platformState === "unknown") return "CANCEL_REQUESTED";
  if (input.platformState === "completed") {
    if (input.platformConclusion === "cancelled") return "CANCELLED";
    if (input.platformConclusion === "success") return "SUCCEEDED";
    if (input.platformConclusion === "timed_out") return "TIMED_OUT";
    return "FAILED";
  }
  return input.requested ? "CANCEL_REQUESTED" : "RUNNING";
}

export const APPROVAL_STATES = ["PENDING", "APPROVED", "DENIED", "EXPIRED", "INVALIDATED", "REVOKED"] as const;
export type ApprovalLifecycleState = (typeof APPROVAL_STATES)[number];

/**
 * An approval binds project_id, target, commit_sha, job_id, diff_sha and
 * expires_at. Any material change after approval invalidates it (spec 05.3 #9).
 */
export function approvalStillValid(input: {
  readonly state: ApprovalLifecycleState;
  readonly approvedDigest: string;
  readonly currentDigest: string;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}): { readonly valid: boolean; readonly reason: "OK" | "NOT_APPROVED" | "DIGEST_CHANGED" | "EXPIRED" } {
  if (input.state !== "APPROVED") return { valid: false, reason: "NOT_APPROVED" };
  if (input.approvedDigest !== input.currentDigest) return { valid: false, reason: "DIGEST_CHANGED" };
  if (input.nowMs >= input.expiresAtMs) return { valid: false, reason: "EXPIRED" };
  return { valid: true, reason: "OK" };
}

export const ARTIFACT_VERIFICATION_STATES = ["UNVERIFIED", "PENDING", "VERIFIED", "MISMATCH"] as const;
export type ArtifactVerificationState = (typeof ARTIFACT_VERIFICATION_STATES)[number];

export const PROVIDER_CONNECTION_STATES = [
  "DISCONNECTED",
  "AUTHENTICATING",
  "CONNECTED",
  "DEGRADED",
  "EXPIRED",
  "REVOKED",
  "BLOCKED",
] as const;
export type ProviderConnectionState = (typeof PROVIDER_CONNECTION_STATES)[number];

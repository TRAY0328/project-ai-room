/**
 * Worker bindings. Only the pieces this track owns are declared here.
 *
 * `GITHUB` and `R2` are optional on purpose: an absent binding is a product
 * state (`BLOCKED_EXTERNAL_DEPENDENCY` / `R2_NOT_ENABLED`), never a mock. Tests
 * inject a compatible fake to prove the contract on the way out.
 */
import type { SqlDb } from "@ai-room/auth";

export interface R2ObjectLike {
  readonly key: string;
  readonly size: number;
  readonly body?: ReadableStream | Uint8Array;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: Record<string, unknown>): Promise<{ key: string; size?: number; etag?: string }>;
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<{ key: string; size?: number } | null>;
  delete(key: string): Promise<void>;
}

export interface GitHubRunLike {
  readonly id: number;
  readonly name: string;
  readonly head_sha: string;
  readonly status: "queued" | "in_progress" | "completed" | "requested" | "waiting" | "unknown";
  readonly conclusion: "success" | "failure" | "cancelled" | "timed_out" | "startup_failure" | "action_required" | "neutral" | "skipped" | "stale" | null;
  readonly created_at: string;
}

/**
 * The narrow GitHub surface the gateway needs. `services/github-integration`
 * implements the policy and `github-integration/src/app-client.ts` the HTTP
 * calls; tests inject an in-memory implementation of this interface.
 */
export interface GitHubClient {
  readonly provider: string;
  createBranch(input: { owner: string; repo: string; branch: string; fromSha: string }): Promise<{ ref: string; sha: string }>;
  openPullRequest(input: { owner: string; repo: string; head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string; head_sha: string; base_sha: string }>;
  submitReview(input: { owner: string; repo: string; number: number; commitSha: string; verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string }): Promise<{ review_id: string; state: string }>;
  mergePullRequest(input: { owner: string; repo: string; number: number; expectedHeadSha: string; method: "squash" | "merge" | "rebase" }): Promise<{ merged: boolean; merge_sha: string | null; message: string }>;
  dispatchWorkflow(input: { owner: string; repo: string; workflowFile: string; ref: string; inputs: Record<string, string> }): Promise<{ dispatched: boolean; run_id: number | null }>;
  cancelRun(input: { owner: string; repo: string; runId: number }): Promise<{ cancelled: boolean }>;
  getRun(input: { owner: string; repo: string; runId: number }): Promise<GitHubRunLike | null>;
  getRunLogs(input: { owner: string; repo: string; runId: number }): Promise<{ log: string }>;
  listBranches(input: { owner: string; repo: string }): Promise<{ name: string; sha: string }[]>;
  createCommit(input: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
    content: string;
    message: string;
    baseSha: string;
  }): Promise<{ commit_sha: string; blob_sha: string }>;
}

/**
 * The narrow Durable Object surface the gateway needs to open a room socket and
 * to publish a persisted message to it. Kept structural so tests can inject a
 * fake namespace instead of a real one.
 */
export interface DurableObjectIdLike {
  readonly name?: string;
  toString(): string;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface Env {
  readonly APP_ENV?: "dev" | "test" | "staging" | "production";
  readonly DB: SqlDb;
  /** Room Durable Object namespace: the live socket fan-out authority (19.3). */
  readonly ROOM_DO?: DurableObjectNamespaceLike;
  readonly R2?: R2BucketLike;
  readonly SESSION_SIGNING_KEY?: string;
  readonly WS_TICKET_SIGNING_KEY?: string;
  readonly AGENT_INVITE_SECRET?: string;
  readonly OWNER_BOOTSTRAP_SECRET?: string;
  readonly OWNER_PASSWORD_VERIFIER?: string;
  readonly GITHUB_WEBHOOK_SECRET?: string;
  readonly GITHUB?: GitHubClient;
  /** Fixed clock for deterministic tests; production leaves it unset. */
  readonly NOW_MS?: number;
  /** In-memory presence reported by room-do for M-04/M-45 (optional). */
  readonly PRESENCE_COUNT?: () => number;
}

export function nowOf(env: Env): string {
  return new Date(env.NOW_MS ?? Date.now()).toISOString();
}

export function nowMsOf(env: Env): number {
  return env.NOW_MS ?? Date.now();
}

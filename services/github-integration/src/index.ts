/**
 * GitHub integration — spec 14, 45
 *
 * What is fixed here:
 *   - webhook authenticity (HMAC-SHA256 over the raw body, constant-time compare),
 *   - delivery idempotency (a redelivered webhook must not duplicate a run row),
 *   - the mapping from GitHub events to internal state, with "unknown" staying
 *     unknown instead of becoming a guessed success.
 *
 * What is deliberately absent: any call that writes to a repository. Push, PR,
 * review and merge go out only behind the owner approval contract.
 */

export const GITHUB_EVENT_HEADERS = {
  event: "x-github-event",
  delivery: "x-github-delivery",
  signature: "x-hub-signature-256",
} as const;

export type GithubEventName =
  | "push"
  | "pull_request"
  | "pull_request_review"
  | "workflow_run"
  | "installation"
  | "installation_repositories"
  | "check_run";

export interface GithubWebhookHeaders {
  readonly event: string;
  readonly deliveryId: string;
  readonly signature256: string;
}

export type WebhookVerification =
  | { readonly ok: true; readonly event: GithubEventName }
  | { readonly ok: false; readonly reason: "MISSING_SIGNATURE" | "BAD_SIGNATURE" | "UNSUPPORTED_EVENT" | "MISSING_DELIVERY_ID" };

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison so a signature cannot be guessed byte by byte. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhook(
  rawBody: string,
  headers: GithubWebhookHeaders,
  secret: string,
): Promise<WebhookVerification> {
  if (headers.deliveryId.length === 0) return { ok: false, reason: "MISSING_DELIVERY_ID" };
  if (!headers.signature256.startsWith("sha256=")) return { ok: false, reason: "MISSING_SIGNATURE" };
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${toHex(digest)}`;
  if (!timingSafeEqualHex(expected, headers.signature256)) return { ok: false, reason: "BAD_SIGNATURE" };

  const known: readonly string[] = [
    "push",
    "pull_request",
    "pull_request_review",
    "workflow_run",
    "installation",
    "installation_repositories",
    "check_run",
  ];
  if (!known.includes(headers.event)) return { ok: false, reason: "UNSUPPORTED_EVENT" };
  return { ok: true, event: headers.event as GithubEventName };
}

export type CiConclusion = "SUCCESS" | "FAILURE" | "CANCELLED" | "TIMED_OUT" | "UNKNOWN";

/**
 * A workflow_run webhook is the only source of a real conclusion. Anything else
 * — a queued run, a missing conclusion, an in-progress run — stays UNKNOWN and
 * must be polled again rather than reported as success.
 */
export function mapWorkflowConclusion(status: string, conclusion: string | null): CiConclusion {
  if (status !== "completed" || conclusion === null) return "UNKNOWN";
  switch (conclusion) {
    case "success":
      return "SUCCESS";
    case "failure":
    case "startup_failure":
      return "FAILURE";
    case "cancelled":
      return "CANCELLED";
    case "timed_out":
      return "TIMED_OUT";
    default:
      return "UNKNOWN";
  }
}

export interface WorkflowRunRecord {
  readonly github_run_id: number;
  readonly github_run_attempt: number;
  readonly head_sha: string;
  readonly conclusion: CiConclusion;
  readonly delivery_id: string;
}

/** Dedupes redeliveries by `x-github-delivery` + run identity. */
export class DeliveryDeduplicator {
  private readonly seen = new Set<string>();

  key(deliveryId: string, runId: number, attempt: number): string {
    return `${deliveryId}:${runId}:${attempt}`;
  }

  accept(deliveryId: string, runId: number, attempt: number): boolean {
    const key = this.key(deliveryId, runId, attempt);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

/**
 * Dispatch guard: an outbound workflow dispatch is a write, so it needs an
 * approved request bound to the exact commit and workflow file.
 */
export interface DispatchRequest {
  readonly projectId: string;
  readonly workflowFile: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly approvalDigest: string;
}

export function assertDispatchEntitled(request: DispatchRequest, approval: { digest: string; state: string } | null): void {
  if (approval === null || approval.state !== "APPROVED" || approval.digest !== request.approvalDigest) {
    throw new Error("dispatch requires an approved, digest-matching owner approval");
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(request.commitSha)) {
    throw new Error("dispatch requires a full commit SHA");
  }
}

// D1-backed webhook persistence, event mapping and the REST client live in
// separate modules so the pure verifier stays dependency-free.
export * from "./webhooks.js";
export * from "./app-client.js";

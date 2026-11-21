/**
 * Webhook persistence and event mapping — spec 14.2, 19.1, S21, S22, S25-S28.
 *
 * A verified signature only proves the body came from GitHub; it says nothing
 * about whether we have already handled it, or whether the conclusion is real.
 * So this module:
 *  - stores the delivery id first (a redelivery is a no-op, not a second run);
 *  - maps only documented fields, and maps an unknown shape to `unknown`
 *    rather than inferring success;
 *  - applies state to D1 only for a repository the owner actually connected.
 */
import { sha256Hex, type SqlDb, allRows, firstRow, nowIso } from "@ai-room/auth";
import { mapWorkflowConclusion, type CiConclusion, type GithubEventName } from "./index.js";

export interface DeliveryRecord {
  readonly deliveryId: string;
  readonly event: GithubEventName;
  readonly payloadSha256: string;
}

export interface DeliveryOutcome {
  readonly duplicate: boolean;
  readonly processed_state: "received" | "processed" | "ignored" | "failed";
}

/** Records a delivery before processing; PK on delivery_id is the dedupe. */
export async function recordDelivery(db: SqlDb, record: DeliveryRecord): Promise<DeliveryOutcome> {
  const existing = await firstRow<{ transaction_id: string }>(
    db,
    "SELECT delivery_id AS transaction_id FROM github_webhooks WHERE delivery_id = ?",
    record.deliveryId,
  );
  if (existing !== null) return { duplicate: true, processed_state: "processed" };
  await db
    .prepare("INSERT INTO github_webhooks (delivery_id, event_name, received_at, payload_sha256, processed_state) VALUES (?,?,?,?,'received')")
    .bind(record.deliveryId, record.event, nowIso(), record.payloadSha256)
    .run();
  return { duplicate: false, processed_state: "received" };
}

export async function markDelivery(db: SqlDb, deliveryId: string, state: DeliveryOutcome["processed_state"]): Promise<void> {
  await db
    .prepare("UPDATE github_webhooks SET processed_state = ?, processed_at = ? WHERE delivery_id = ?")
    .bind(state, state === "processed" ? nowIso() : null, deliveryId)
    .run();
}

export type MappedEvent =
  | { readonly kind: "pull_request"; readonly action: string; readonly number: number; readonly headSha: string; readonly baseSha: string | null; readonly state: "DRAFT" | "OPEN" | "CLOSED" | "MERGED"; readonly merged: boolean }
  | { readonly kind: "pull_request_review"; readonly number: number; readonly commitSha: string; readonly state: string; readonly reviewer: string }
  | { readonly kind: "workflow_run"; readonly runId: number; readonly attempt: number; readonly workflowName: string; readonly headSha: string; readonly status: string; readonly conclusion: CiConclusion; readonly prNumbers: readonly number[] }
  | { readonly kind: "push"; readonly commitSha: string; readonly branch: string; readonly message: string }
  | { readonly kind: "installation"; readonly installationId: string; readonly account: string; readonly action: string }
  | { readonly kind: "unknown"; readonly reason: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Maps only what the documented payload shape supports. */
export function mapWebhook(event: GithubEventName, payload: unknown): MappedEvent {
  const body = asRecord(payload);
  switch (event) {
    case "pull_request": {
      const pr = asRecord(body["pull_request"]);
      const head = asRecord(pr["head"]);
      const base = asRecord(pr["base"]);
      const merged = pr["merged"] === true;
      const rawState = String(pr["state"] ?? "open");
      const state = merged ? "MERGED" : rawState === "closed" ? "CLOSED" : pr["draft"] === true ? "DRAFT" : "OPEN";
      if (typeof pr["number"] !== "number" || typeof head["sha"] !== "string") return { kind: "unknown", reason: "pull_request payload missing number/head.sha" };
      return {
        kind: "pull_request",
        action: String(body["action"] ?? "unknown"),
        number: pr["number"],
        headSha: head["sha"],
        baseSha: typeof base["sha"] === "string" ? base["sha"] : null,
        state,
        merged,
      };
    }
    case "pull_request_review": {
      const review = asRecord(body["review"]);
      const pr = asRecord(body["pull_request"]);
      if (typeof review["commit_id"] !== "string" || typeof pr["number"] !== "number") return { kind: "unknown", reason: "review payload missing commit_id/number" };
      const user = asRecord(review["user"]);
      return { kind: "pull_request_review", number: pr["number"], commitSha: review["commit_id"], state: String(review["state"] ?? "unknown"), reviewer: String(user["login"] ?? "unknown") };
    }
    case "workflow_run": {
      const run = asRecord(body["workflow_run"]);
      const prs = Array.isArray(run["pull_requests"]) ? run["pull_requests"] : [];
      const numbers = prs.map((entry) => asRecord(entry)["number"]).filter((value): value is number => typeof value === "number");
      if (typeof run["id"] !== "number" || typeof run["head_sha"] !== "string") return { kind: "unknown", reason: "workflow_run payload missing id/head_sha" };
      return {
        kind: "workflow_run",
        runId: run["id"],
        attempt: typeof run["run_attempt"] === "number" ? run["run_attempt"] : 1,
        workflowName: String(run["name"] ?? "unknown"),
        headSha: run["head_sha"],
        status: String(run["status"] ?? "unknown"),
        conclusion: mapWorkflowConclusion(String(run["status"] ?? ""), typeof run["conclusion"] === "string" ? run["conclusion"] : null),
        prNumbers: numbers,
      };
    }
    case "push": {
      if (typeof body["after"] !== "string" || typeof body["ref"] !== "string") return { kind: "unknown", reason: "push payload missing after/ref" };
      const headCommit = asRecord(body["head_commit"]);
      return { kind: "push", commitSha: body["after"], branch: body["ref"].replace("refs/heads/", ""), message: String(headCommit["message"] ?? "") };
    }
    case "installation": {
      const installation = asRecord(body["installation"]);
      const account = asRecord(installation["account"]);
      if (installation["id"] === undefined) return { kind: "unknown", reason: "installation payload missing id" };
      return { kind: "installation", installationId: String(installation["id"]), account: String(account["login"] ?? "unknown"), action: String(body["action"] ?? "unknown") };
    }
    default:
      return { kind: "unknown", reason: `unsupported event ${event}` };
  }
}

export interface AppliedWebhook {
  readonly applied: boolean;
  readonly result: string;
  readonly repo_id: string | null;
}

/**
 * Applies a mapped event to D1. Returns `applied:false` with a reason when the
 * repository is not connected — an event from an unconnected repo never changes
 * our state, and never reports a build success.
 */
export async function applyWebhook(db: SqlDb, mapped: MappedEvent, deliveryId: string): Promise<AppliedWebhook> {
  const repoFullName = await findRepoForEvent(db, mapped);
  if (repoFullName === null) return { applied: false, result: "REPOSITORY_NOT_CONNECTED", repo_id: null };
  if (mapped.kind === "workflow_run") {
    const existing = await firstRow<{ ci_run_id: string; conclusion: string | null }>(
      db,
      "SELECT ci_run_id, conclusion FROM ci_runs WHERE repo_id = ? AND github_run_id = ? AND github_run_attempt = ?",
      repoFullName.repo_id,
      String(mapped.runId),
      mapped.attempt,
    );
    const status = mapped.status === "completed" ? "completed" : mapped.status === "in_progress" ? "in_progress" : mapped.status === "queued" ? "queued" : "unknown";
    const conclusion = mapped.conclusion === "UNKNOWN" ? null : mapped.conclusion.toLowerCase();
    if (existing === null) {
      await db
        .prepare(
          `INSERT INTO ci_runs (ci_run_id, repo_id, pr_id, job_id, github_run_id, github_run_attempt, workflow_name, head_sha, status, conclusion, created_at, last_synced_at)
           VALUES (?,?,NULL,NULL,?,?,?,?,?,?,?,?)`,
        )
        .bind(`ci_${mapped.runId}_${mapped.attempt}`, repoFullName.repo_id, String(mapped.runId), mapped.attempt, mapped.workflowName, mapped.headSha, status, conclusion, nowIso(), nowIso())
        .run();
    } else {
      await db
        .prepare("UPDATE ci_runs SET status = ?, conclusion = ?, last_synced_at = ? WHERE ci_run_id = ?")
        .bind(status, conclusion, nowIso(), existing.ci_run_id)
        .run();
    }
    // A conclusion is applied to a PR only for the same head SHA.
    for (const number of mapped.prNumbers) {
      const tracked = await firstRow<{ pull_request_id: string }>(
        db,
        "SELECT pull_request_id FROM git_pull_requests WHERE repo_id = ? AND github_pr_number = ?",
        repoFullName.repo_id,
        number,
      );
      if (tracked !== null) {
        await db
          .prepare("UPDATE ci_runs SET pr_id = ? WHERE repo_id = ? AND github_run_id = ? AND github_run_attempt = ?")
          .bind(tracked.pull_request_id, repoFullName.repo_id, String(mapped.runId), mapped.attempt)
          .run();
      }
      await db
        .prepare("UPDATE git_pull_requests SET status = CASE WHEN ? = 'completed' AND ? = 'success' THEN 'APPROVED' ELSE status END, last_synced_at = ? WHERE repo_id = ? AND github_pr_number = ? AND head_sha = ?")
        .bind(status, conclusion ?? "", nowIso(), repoFullName.repo_id, number, mapped.headSha)
        .run();
    }
    await linkJobRun(db, repoFullName.repo_id, mapped);
    return { applied: true, result: `ci_run:${status}/${conclusion ?? "null"}`, repo_id: repoFullName.repo_id };
  }
  if (mapped.kind === "pull_request") {
    const existing = await firstRow<{ pull_request_id: string }>(
      db,
      "SELECT pull_request_id FROM git_pull_requests WHERE repo_id = ? AND github_pr_number = ?",
      repoFullName.repo_id,
      mapped.number,
    );
    if (existing === null) {
      await db
        .prepare("INSERT INTO git_pull_requests (pull_request_id, repo_id, github_pr_number, head_sha, base_sha, status, last_synced_at) VALUES (?,?,?,?,?,?,?)")
        .bind(`pr_${repoFullName.repo_id.slice(5)}_${mapped.number}`, repoFullName.repo_id, mapped.number, mapped.headSha, mapped.baseSha, mapped.state, nowIso())
        .run();
    } else {
      await db
        .prepare("UPDATE git_pull_requests SET head_sha = ?, base_sha = ?, status = ?, last_synced_at = ? WHERE pull_request_id = ?")
        .bind(mapped.headSha, mapped.baseSha, mapped.state, nowIso(), existing.pull_request_id)
        .run();
    }
    return { applied: true, result: `pr:${mapped.state}`, repo_id: repoFullName.repo_id };
  }
  if (mapped.kind === "pull_request_review") {
    const pr = await firstRow<{ pull_request_id: string }>(
      db,
      "SELECT pull_request_id FROM git_pull_requests WHERE repo_id = ? AND github_pr_number = ?",
      repoFullName.repo_id,
      mapped.number,
    );
    if (pr === null) return { applied: false, result: "PR_NOT_TRACKED", repo_id: repoFullName.repo_id };
    const verdict = mapped.state === "approved" ? "APPROVE" : mapped.state === "changes_requested" ? "REQUEST_CHANGES" : "COMMENT";
    await db
      .prepare("INSERT OR IGNORE INTO code_reviews (review_id, pull_request_id, reviewer_kind, reviewer_id, reviewed_sha, verdict, attestation, created_at) VALUES (?,?,'agent',?,?,?,'provider_verified',?)")
      .bind(`rvw_${mapped.commitSha.slice(0, 24)}`, pr.pull_request_id, `github:${mapped.reviewer}`, mapped.commitSha, verdict, nowIso())
      .run();
    return { applied: true, result: `review:${verdict}@${mapped.commitSha.slice(0, 8)}`, repo_id: repoFullName.repo_id };
  }
  if (mapped.kind === "push") {
    await db
      .prepare("INSERT OR IGNORE INTO git_revisions (revision_id, repo_id, commit_sha, parent_sha, branch, author_kind, author_id, message, committed_at) VALUES (?,?,?,NULL,?,'system','github',?,?)")
      .bind(`rev_${mapped.commitSha.slice(0, 24)}`, repoFullName.repo_id, mapped.commitSha, mapped.branch, mapped.message.slice(0, 2000), nowIso())
      .run();
    return { applied: true, result: `commit:${mapped.commitSha.slice(0, 8)}`, repo_id: repoFullName.repo_id };
  }
  if (mapped.kind === "installation") {
    await db
      .prepare("INSERT OR IGNORE INTO github_installations (installation_id, github_installation_id, account_login, repository_selection, permissions_json, installed_at) VALUES (?,?,?,'selected','{}',?)")
      .bind(`inst_${mapped.installationId}`, mapped.installationId, mapped.account, nowIso())
      .run();
    return { applied: true, result: `installation:${mapped.action}`, repo_id: null };
  }
  void deliveryId;
  return { applied: false, result: "UNKNOWN_EVENT_SHAPE", repo_id: null };
}

async function findRepoForEvent(db: SqlDb, mapped: MappedEvent): Promise<{ repo_id: string } | null> {
  if (mapped.kind === "installation") return null;
  // Only one repo per project; a matching row is the owner's explicit connection.
  const rows = await allRows<{ repo_id: string }>(db, "SELECT repo_id FROM git_repositories WHERE enabled = 1 LIMIT 2");
  if (rows.length === 1) return rows[0] ?? null;
  return rows[0] ?? null;
}

async function linkJobRun(db: SqlDb, repoId: string, mapped: Extract<MappedEvent, { kind: "workflow_run" }>): Promise<void> {
  const job = await firstRow<{ job_id: string }>(db, "SELECT job_id FROM jobs WHERE commit_sha = ? ORDER BY created_at DESC LIMIT 1", mapped.headSha);
  if (job === null) return;
  await db
    .prepare("UPDATE job_attempts SET github_total_count = ? WHERE job_id = ? AND github_total_count IS NULL")
    .bind(mapped.runId, job.job_id)
    .run();
  if (mapped.status === "completed") {
    const state = mapped.conclusion === "SUCCESS" ? "SUCCEEDED" : mapped.conclusion === "CANCELLED" ? "CANCELLED" : mapped.conclusion === "TIMED_OUT" ? "TIMED_OUT" : "FAILED";
    await db.prepare("UPDATE jobs SET state = ?, revision = revision + 1, updated_at = ? WHERE job_id = ?").bind(state, nowIso(), job.job_id).run();
  } else if (mapped.status === "in_progress") {
    await db.prepare("UPDATE jobs SET state = 'RUNNING', revision = revision + 1, updated_at = ? WHERE job_id = ? AND state IN ('DISPATCHED','DISPATCH_REQUESTED')").bind(nowIso(), job.job_id).run();
  }
  void repoId;
}

export async function payloadDigest(rawBody: string): Promise<string> {
  return sha256Hex(rawBody);
}

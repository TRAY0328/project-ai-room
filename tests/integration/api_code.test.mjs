/**
 * IDE/Git/CI/artifact integration tests.
 *
 * The important assertions are refusals: a merge without a review at the head
 * SHA, without a successful run for that SHA, or with a stale approval must not
 * happen — and a dispatch without a GitHub App must not become "SUCCEEDED".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { setup, WEBHOOK_SECRET } from "./helpers.mjs";
import { computeActionDigest } from "../../packages/permissions/dist/index.js";
import { recordDelivery, mapWebhook, applyWebhook, verifyWebhook } from "../../services/github-integration/dist/index.js";

const BASE_SHA = "a".repeat(40);

async function prepareRepo(harness, agentIds = []) {
  const { call, ownerToken, createProject, github } = harness;
  const projectId = await createProject("IDE 프로젝트", agentIds);
  const repo = await call("POST", `/api/v1/projects/${projectId}/repositories`, {
    token: ownerToken,
    body: { repo_full_name: "TRAY0328/project-ai-room", default_branch: "main", github_repository_id: "1234567" },
  });
  assert.equal(repo.status, 201, repo.text);
  return { projectId, repoId: repo.json.data.repo_id, github };
}

async function openPullRequest(harness, projectId) {
  const { call, ownerToken } = harness;
  const branch = await call("POST", `/api/v1/projects/${projectId}/git/branches`, {
    token: ownerToken,
    body: { name: "ai/feature-1", from_sha: BASE_SHA },
  });
  assert.equal(branch.status, 201, branch.text);
  const pr = await call("POST", `/api/v1/projects/${projectId}/git/pull-requests`, {
    token: ownerToken,
    body: { title: "AI 변경", body: "내용", head: "ai/feature-1", base: "main", head_sha: BASE_SHA },
  });
  assert.equal(pr.status, 201, pr.text);
  return pr.json.data.pull_request_id;
}

async function feedCi(harness, projectId, prNumber, headSha, conclusion = "success") {
  const payload = JSON.stringify({
    action: "completed",
    workflow_run: { id: 91001, name: "verify", head_sha: headSha, status: "completed", conclusion, run_attempt: 1, pull_requests: [{ number: prNumber }] },
  });
  const delivery = `delivery-${prNumber}-${headSha.slice(0, 6)}`;
  const recorded = await recordDelivery(harness.db, { deliveryId: delivery, event: "workflow_run", payloadSha256: createHash("sha256").update(payload).digest("hex") });
  const mapped = mapWebhook("workflow_run", JSON.parse(payload));
  const applied = await applyWebhook(harness.db, mapped, delivery);
  return { recorded, mapped, applied, payload, delivery };
}

test("git actions are blocked with a named reason when no repository/client exists", async () => {
  const { call, ownerToken, createProject, close } = await setup({ github: false });
  try {
    const projectId = await createProject("저장소 없음");
    const branches = await call("GET", `/api/v1/projects/${projectId}/git/branches`, { token: ownerToken });
    assert.equal(branches.status, 503);
    assert.equal(branches.json.error.code, "EXTERNAL_DEPENDENCY_BLOCKED");
    assert.equal(branches.json.error.details.reason, "GITHUB_REPOSITORY_NOT_CONNECTED");

    const job = await call("POST", `/api/v1/projects/${projectId}/jobs`, {
      token: ownerToken,
      idempotencyKey: "job-blocked-0001",
      body: { job_kind: "ci_test", workflow_ref: ".github/workflows/verify.yml", commit_sha: BASE_SHA, ref: "main" },
    });
    assert.equal(job.status, 202);
    assert.equal(job.json.data.state, "BLOCKED_EXTERNAL_DEPENDENCY");
    const fetched = await call("GET", `/api/v1/projects/${projectId}/jobs/${job.json.data.job_id}`, { token: ownerToken });
    assert.equal(fetched.json.data.state, "BLOCKED_EXTERNAL_DEPENDENCY");
    assert.equal(fetched.json.data.is_terminal, false);
  } finally {
    close();
  }
});

test("merge is refused without review, CI and approval bound to the head SHA", async () => {
  const harness = await setup();
  const { call, ownerToken, registerAgent, close } = harness;
  try {
    const agent = await registerAgent("피클");
    const { projectId } = await prepareRepo(harness, [agent.agentId]);
    const pullRequestId = await openPullRequest(harness, projectId);
    const list = await call("GET", `/api/v1/projects/${projectId}/git/branches`, { token: ownerToken });
    assert.deepEqual(list.json.data.items.map((item) => item.name).sort(), ["ai/feature-1", "main"]);

    const noReview = await call("POST", `/api/v1/projects/${projectId}/git/merge`, {
      token: ownerToken,
      body: { pull_request_id: pullRequestId, expected_head_sha: BASE_SHA, method: "squash" },
    });
    assert.equal(noReview.status, 409);
    assert.ok(noReview.json.error.details.blocking.includes("REVIEW_AT_HEAD"));

    // A review of a different SHA does not count.
    const wrongShaReview = await call("POST", `/api/v1/projects/${projectId}/git/reviews`, {
      token: ownerToken,
      body: { pull_request_id: pullRequestId, commit_sha: "e".repeat(40), verdict: "APPROVE", body: "다른 커밋" },
    });
    assert.equal(wrongShaReview.status, 201);
    assert.equal(wrongShaReview.json.data.at_head, false);
    const stillBlocked = await call("POST", `/api/v1/projects/${projectId}/git/merge`, {
      token: ownerToken,
      body: { pull_request_id: pullRequestId, expected_head_sha: BASE_SHA, method: "squash" },
    });
    assert.equal(stillBlocked.status, 409);

    const review = await call("POST", `/api/v1/projects/${projectId}/git/reviews`, {
      token: ownerToken,
      body: { pull_request_id: pullRequestId, commit_sha: BASE_SHA, verdict: "APPROVE", body: "좋습니다" },
    });
    assert.equal(review.status, 201);
    assert.equal(review.json.data.at_head, true);

    const noCi = await call("POST", `/api/v1/projects/${projectId}/git/merge`, {
      token: ownerToken,
      body: { pull_request_id: pullRequestId, expected_head_sha: BASE_SHA, method: "squash" },
    });
    assert.equal(noCi.status, 412);
    assert.equal(noCi.json.error.code, "TEST_NOT_RUN");

    const ci = await feedCi(harness, projectId, 1, BASE_SHA, "success");
    assert.equal(ci.applied.applied, true, "a completed run for a tracked PR must be applied");

    // The AI's merge still needs an approval bound to this exact head SHA.
    const agentMergeNoApproval = await call("POST", `/api/v1/projects/${projectId}/git/merge`, {
      token: agent.token,
      body: { pull_request_id: pullRequestId, expected_head_sha: BASE_SHA, method: "squash" },
    });
    assert.equal(agentMergeNoApproval.status, 428);
    assert.equal(agentMergeNoApproval.json.error.code, "APPROVAL_REQUIRED");

    const digest = await computeActionDigest({ target_type: "pull_request", target_id: pullRequestId, project_id: projectId, bound_commit_sha: BASE_SHA, diff_sha: null });
    const approval = await call("POST", "/api/v1/admin/approvals", {
      token: ownerToken,
      body: {
        project_id: projectId,
        target_type: "pull_request",
        target_id: pullRequestId,
        action_digest: digest,
        request_reason: "병합 승인",
        bound_commit_sha: BASE_SHA,
        expires_in_seconds: 600,
      },
    });
    assert.equal(approval.status, 201, approval.text);
    const resolved = await call("POST", `/api/v1/admin/approvals/${approval.json.data.approval_id}/resolve`, { token: ownerToken, body: { decision: "approve" } });
    assert.equal(resolved.status, 200);

    const merged = await call("POST", `/api/v1/projects/${projectId}/git/merge`, {
      token: agent.token,
      headers: { "x-approval-id": approval.json.data.approval_id },
      body: { pull_request_id: pullRequestId, expected_head_sha: BASE_SHA, method: "squash" },
    });
    assert.equal(merged.status, 200, merged.text);
    assert.equal(merged.json.data.merged, true);
    assert.equal(merged.json.data.merge_sha, "c".repeat(40));
    assert.equal(harness.github.state.merges.length, 1);
  } finally {
    close();
  }
});

test("a failed CI conclusion blocks the merge", async () => {
  const harness = await setup();
  const { call, ownerToken, close } = harness;
  try {
    const { projectId } = await prepareRepo(harness);
    const pullRequestId = await openPullRequest(harness, projectId);
    await call("POST", `/api/v1/projects/${projectId}/git/reviews`, {
      token: ownerToken,
      body: { pull_request_id: pullRequestId, commit_sha: BASE_SHA, verdict: "APPROVE", body: "ok" },
    });
    await feedCi(harness, projectId, 1, BASE_SHA, "failure");
    const response = await call("POST", `/api/v1/projects/${projectId}/git/merge`, {
      token: ownerToken,
      body: { pull_request_id: pullRequestId, expected_head_sha: BASE_SHA, method: "squash" },
    });
    assert.equal(response.status, 422);
    assert.equal(response.json.error.code, "CI_FAILED");
  } finally {
    close();
  }
});

test("webhook signatures, delivery dedupe and unknown shapes are handled honestly", async () => {
  const harness = await setup();
  const { db, close } = harness;
  try {
    const body = JSON.stringify({ action: "opened", pull_request: { number: 5, head: { sha: BASE_SHA }, base: { sha: "b".repeat(40) }, state: "open", draft: false, merged: false } });
    const good = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const verified = await verifyWebhook(body, { event: "pull_request", deliveryId: "d-1", signature256: `sha256=${good}` }, WEBHOOK_SECRET);
    assert.equal(verified.ok, true);
    const tampered = await verifyWebhook(`${body} `, { event: "pull_request", deliveryId: "d-1", signature256: `sha256=${good}` }, WEBHOOK_SECRET);
    assert.deepEqual(tampered, { ok: false, reason: "BAD_SIGNATURE" });

    const first = await recordDelivery(db, { deliveryId: "d-1", event: "pull_request", payloadSha256: "a".repeat(64) });
    const second = await recordDelivery(db, { deliveryId: "d-1", event: "pull_request", payloadSha256: "a".repeat(64) });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);

    const unknown = mapWebhook("push", { nonsense: true });
    assert.equal(unknown.kind, "unknown");
    const queued = mapWebhook("workflow_run", { workflow_run: { id: 5, head_sha: BASE_SHA, status: "in_progress", conclusion: null } });
    assert.equal(queued.kind === "workflow_run" ? queued.conclusion : "n/a", "UNKNOWN", "an unfinished run is never a success");
  } finally {
    close();
  }
});

test("job dispatch, cancel and log redaction follow the platform", async () => {
  const harness = await setup();
  const { call, ownerToken, close } = harness;
  try {
    const { projectId } = await prepareRepo(harness);
    const dispatched = await call("POST", `/api/v1/projects/${projectId}/jobs`, {
      token: ownerToken,
      idempotencyKey: "job-dispatch-0001",
      body: { job_kind: "ci_test", workflow_ref: ".github/workflows/verify.yml", commit_sha: BASE_SHA, ref: "main" },
    });
    assert.equal(dispatched.status, 202, dispatched.text);
    assert.equal(dispatched.json.data.state, "DISPATCHED");
    assert.equal(harness.github.state.dispatches.length, 1);

    const logs = await call("GET", `/api/v1/projects/${projectId}/jobs/${dispatched.json.data.job_id}/logs`, { token: ownerToken });
    assert.equal(logs.status, 200);
    assert.ok(logs.json.data.redacted.includes("github_token"));
    assert.ok(!logs.text.includes("ghp_aaaaaaaa"), "a provider token must never leave the server");

    const cancel = await call("POST", `/api/v1/projects/${projectId}/jobs/${dispatched.json.data.job_id}/cancel`, {
      token: ownerToken,
      idempotencyKey: "job-cancel-0001",
      body: { reason: "테스트" },
    });
    assert.equal(cancel.status, 202);
    assert.equal(cancel.json.data.provider_confirmed, true);
    assert.equal(cancel.json.data.state, "CANCELLED");
  } finally {
    close();
  }
});

test("artifacts must be hash-verified before a download link is issued", async () => {
  const { call, ownerToken, createProject, close } = await setup();
  try {
    const projectId = await createProject("산출물");
    const created = await call("POST", `/api/v1/projects/${projectId}/artifacts`, {
      token: ownerToken,
      body: { artifact_type: "report", version: "1.0.0", path: "report.txt", content: "artifact-bytes" },
    });
    assert.equal(created.status, 201, created.text);
    const artifactId = created.json.data.artifact_id;

    const blocked = await call("POST", `/api/v1/projects/${projectId}/artifacts/${artifactId}/download-intent`, { token: ownerToken, body: {} });
    assert.equal(blocked.status, 412);
    assert.equal(blocked.json.error.code, "ARTIFACT_NOT_VERIFIED");

    const verified = await call("POST", `/api/v1/projects/${projectId}/artifacts/${artifactId}/verify`, { token: ownerToken, body: {} });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.json.data.verification_state, "VERIFIED");

    const intent = await call("POST", `/api/v1/projects/${projectId}/artifacts/${artifactId}/download-intent`, { token: ownerToken, body: {} });
    assert.equal(intent.status, 200);
    const download = await call("GET", intent.json.data.download_url);
    assert.equal(download.status, 200);
    assert.equal(download.text, "artifact-bytes");

    const list = await call("GET", `/api/v1/projects/${projectId}/artifacts`, { token: ownerToken });
    assert.equal(list.json.data.items[0].verification_state, "VERIFIED");
    assert.equal(list.json.data.items[0].download_allowed, true);
  } finally {
    close();
  }
});

test("IDE publish commits only when the remote base still matches", async () => {
  const harness = await setup();
  const { call, ownerToken, createProject, close } = harness;
  try {
    const projectId = await createProject("IDE");
    await call("POST", `/api/v1/projects/${projectId}/repositories`, {
      token: ownerToken,
      body: { repo_full_name: "TRAY0328/project-ai-room", default_branch: "main", github_repository_id: "7654321" },
    });
    const document = await call("POST", `/api/v1/projects/${projectId}/documents`, {
      token: ownerToken,
      body: { path: "src/app.ts", language: "typescript", content: "export const x = 1;\n" },
    });
    assert.equal(document.status, 201, document.text);
    const documentId = document.json.data.document_id;

    const tree = await call("GET", `/api/v1/projects/${projectId}/ide/tree`, { token: ownerToken });
    assert.equal(tree.json.data.base.kind, "github");
    assert.equal(tree.json.data.items.length, 1);

    const detail = await call("GET", `/api/v1/projects/${projectId}/ide/documents/${documentId}`, { token: ownerToken });
    assert.equal(detail.json.data.content, "export const x = 1;\n");

    const stale = await call("POST", `/api/v1/projects/${projectId}/ide/publish`, {
      token: ownerToken,
      body: { document_id: documentId, base_commit_sha: "f".repeat(40), commit_message: "stale" },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "REVISION_CONFLICT");

    const published = await call("POST", `/api/v1/projects/${projectId}/ide/publish`, {
      token: ownerToken,
      body: { document_id: documentId, base_commit_sha: BASE_SHA, commit_message: "feat: publish" },
    });
    assert.equal(published.status, 201, published.text);
    assert.equal(harness.github.state.commits.length, 1);
    assert.equal(harness.github.state.commits[0].path, "src/app.ts");
  } finally {
    close();
  }
});

test("the project report endpoint returns evidence-linked rows only", async () => {
  const { call, ownerToken, createProject, raw, close } = await setup();
  try {
    const projectId = await createProject("보고서");
    raw
      .prepare("INSERT INTO project_reports (report_id, project_id, report_kind, body_md, evidence_refs_json, created_by_kind, created_by_id, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("rep_1", projectId, "status", "# 상태\n근거 기반", JSON.stringify(["ci_run:1"]), "system", "system", "2026-11-21T03:00:00.000Z");
    const reports = await call("GET", `/api/v1/projects/${projectId}/reports`, { token: ownerToken });
    assert.equal(reports.status, 200);
    assert.equal(reports.json.data.items.length, 1);
    assert.deepEqual(reports.json.data.items[0].evidence_refs, ["ci_run:1"]);
  } finally {
    close();
  }
});

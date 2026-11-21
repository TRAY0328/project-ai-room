/**
 * Admin/approval/backup/deletion tests — refusals and audit evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup } from "./helpers.mjs";
import { computeActionDigest } from "../../packages/permissions/dist/index.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("an approval digest must match the exact target it names", async () => {
  const { call, ownerToken, createProject, close } = await setup();
  try {
    const projectId = await createProject();
    const wrong = await call("POST", "/api/v1/admin/approvals", {
      token: ownerToken,
      body: {
        project_id: projectId,
        target_type: "job",
        target_id: "job_X",
        action_digest: "0".repeat(64),
        request_reason: "digest mismatch",
        bound_commit_sha: "a".repeat(40),
      },
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error.code, "VALIDATION_FAILED");
    assert.match(wrong.json.error.details.expected_digest, /^[0-9a-f]{64}$/);
  } finally {
    close();
  }
});

test("an approved row is invalidated by a material change and never becomes late-approved", async () => {
  const { call, ownerToken, raw, close } = await setup();
  try {
    const digest = await computeActionDigest({ target_type: "pull_request", target_id: "pr_1", project_id: null, bound_commit_sha: "a".repeat(40), diff_sha: null });
    const created = await call("POST", "/api/v1/admin/approvals", {
      token: ownerToken,
      body: { target_type: "pull_request", target_id: "pr_1", action_digest: digest, request_reason: "검증", bound_commit_sha: "a".repeat(40), expires_in_seconds: 600 },
    });
    assert.equal(created.status, 201);
    const approvalId = created.json.data.approval_id;
    const approved = await call("POST", `/api/v1/admin/approvals/${approvalId}/resolve`, { token: ownerToken, body: { decision: "approve" } });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.data.state, "APPROVED");

    // A new commit after approval moves every bound field; the trigger invalidates it.
    const newDigest = await computeActionDigest({ target_type: "pull_request", target_id: "pr_1", project_id: null, bound_commit_sha: "b".repeat(40), diff_sha: null });
    raw.prepare("UPDATE approvals SET bound_commit_sha = ?, action_digest = ? WHERE approval_id = ?").run("b".repeat(40), newDigest, approvalId);
    const row = raw.prepare("SELECT state FROM approvals WHERE approval_id = ?").get(approvalId);
    assert.equal(row.state, "INVALIDATED");
    const audit = raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'approval.invalidated' AND target_id = ?").get(approvalId);
    assert.equal(audit.n, 1);

    // An expired approval cannot be approved at all.
    raw.prepare("UPDATE approvals SET state = 'PENDING', requested_at = ?, expires_at = ? WHERE approval_id = ?").run("2019-12-31T00:00:00.000Z", "2020-01-01T00:00:00.000Z", approvalId);
    const late = await call("POST", `/api/v1/admin/approvals/${approvalId}/resolve`, { token: ownerToken, body: { decision: "approve" } });
    assert.equal(late.status, 412);
    assert.equal(late.json.error.code, "APPROVAL_STALE");
  } finally {
    close();
  }
});

test("emergency stop blocks new AI mutations until the owner resumes", async () => {
  const { call, ownerToken, registerAgent, roomId, close } = await setup();
  try {
    const agent = await registerAgent("피클");
    const stop = await call("POST", "/api/v1/admin/emergency-stop", { token: ownerToken, body: { reason: "SEV-1 drill", revoke_agent_keys: false, cancel_running_jobs: true } });
    assert.equal(stop.status, 200);
    assert.equal(stop.json.data.emergency_stop, true);

    const blockedWrite = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: agent.token,
      idempotencyKey: "emergency-message-01",
      body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text: "정지 중" } }], idempotency_key: "emergency-message-01" },
    });
    assert.equal(blockedWrite.status, 403);
    assert.equal(blockedWrite.json.error.details.reason_code, "EMERGENCY_STOP_ENGAGED");

    // Reading is still allowed: a stop halts actions, not the audit trail.
    const read = await call("GET", `/api/v1/rooms/${roomId}/messages`, { token: agent.token });
    assert.equal(read.status, 200);

    const resume = await call("POST", "/api/v1/admin/emergency-resume", { token: ownerToken, body: { note: "drill complete" } });
    assert.equal(resume.status, 200);
    const after = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: agent.token,
      idempotencyKey: "emergency-message-02",
      body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text: "재개 후" } }], idempotency_key: "emergency-message-02" },
    });
    assert.equal(after.status, 201);
  } finally {
    close();
  }
});

test("audit rows are append-only at the database level", async () => {
  const { raw, close } = await setup();
  try {
    const row = raw.prepare("SELECT audit_id FROM audit_events LIMIT 1").get();
    assert.ok(row.audit_id !== undefined);
    assert.throws(() => raw.prepare("UPDATE audit_events SET reason_code = 'X' WHERE audit_id = ?").run(row.audit_id), /AUDIT_IMMUTABLE/);
    assert.throws(() => raw.prepare("DELETE FROM audit_events WHERE audit_id = ?").run(row.audit_id), /AUDIT_IMMUTABLE/);
  } finally {
    close();
  }
});

test("a backup records a real manifest and a restore cannot invent a payload", async () => {
  const { call, ownerToken, close } = await setup();
  try {
    const backup = await call("POST", "/api/v1/admin/backups", { token: ownerToken, body: { scope: ["identity", "chat", "projects"] } });
    assert.equal(backup.status, 201, backup.text);
    assert.equal(backup.json.data.state, "COMPLETE");
    assert.match(backup.json.data.manifest_sha256, /^[0-9a-f]{64}$/);
    assert.ok(backup.json.data.counts.messages >= 0);
    assert.equal(backup.json.data.payload_state, "METADATA_ONLY");

    const prepared = await call("POST", "/api/v1/admin/restores/prepare", { token: ownerToken, body: { backup_id: backup.json.data.backup_id } });
    assert.equal(prepared.status, 201, prepared.text);
    assert.equal(prepared.json.data.plan.restore_possible, false);
    assert.equal(prepared.json.data.plan.blocked_reason, "BACKUP_PAYLOAD_NOT_STORED");
    assert.ok(prepared.json.data.plan.integrity_checks.includes("tombstone_replay"));

    const commitNoApproval = await call("POST", "/api/v1/admin/restores/commit", {
      token: ownerToken,
      idempotencyKey: "restore-commit-001",
      body: { restore_id: prepared.json.data.restore_id, approval_id: "apr_AAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    assert.equal(commitNoApproval.status, 428);
    assert.equal(commitNoApproval.json.error.code, "APPROVAL_REQUIRED");

    const digest = prepared.json.data.plan.plan_digest;
    const approval = await call("POST", "/api/v1/admin/approvals", {
      token: ownerToken,
      body: {
        target_type: "restore",
        target_id: backup.json.data.backup_id,
        action_digest: digest,
        request_reason: "복원 승인",
        bound_commit_sha: backup.json.data.manifest_sha256,
        expires_in_seconds: 600,
      },
    });
    assert.equal(approval.status, 201, approval.text);
    await call("POST", `/api/v1/admin/approvals/${approval.json.data.approval_id}/resolve`, { token: ownerToken, body: { decision: "approve" } });
    const blocked = await call("POST", "/api/v1/admin/restores/commit", {
      token: ownerToken,
      idempotencyKey: "restore-commit-002",
      body: { restore_id: prepared.json.data.restore_id, approval_id: approval.json.data.approval_id },
    });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.json.error.details.reason, "BACKUP_PAYLOAD_NOT_STORED");
  } finally {
    close();
  }
});

test("data deletion needs a digest-bound approval and then purges every copy", async () => {
  const { call, ownerToken, roomId, raw, close } = await setup();
  try {
    const message = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: ownerToken,
      idempotencyKey: "deletion-message-01",
      body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text: "파기 대상 데이터" } }], body_plain_text: "파기 대상 데이터", idempotency_key: "deletion-message-01" },
    });
    const messageId = message.json.data.message.message_id;

    const prepared = await call("POST", "/api/v1/admin/data-deletion/prepare", { token: ownerToken, body: { message_ids: [messageId] } });
    assert.equal(prepared.status, 200);
    const planDigest = prepared.json.data.plan_digest;
    assert.equal(prepared.json.data.scope.message_count, 1);

    const unapproved = await call("POST", "/api/v1/admin/data-deletion/commit", {
      token: ownerToken,
      idempotencyKey: "deletion-commit-bad",
      body: { plan_digest: planDigest, approval_id: "apr_AAAAAAAAAAAAAAAAAAAAAAAAAA", message_ids: [messageId] },
    });
    assert.equal(unapproved.status, 428);

    const approval = await call("POST", "/api/v1/admin/approvals", {
      token: ownerToken,
      body: { target_type: "data_deletion", target_id: planDigest, action_digest: planDigest, request_reason: "파기 승인", expires_in_seconds: 600 },
    });
    assert.equal(approval.status, 201, approval.text);
    await call("POST", `/api/v1/admin/approvals/${approval.json.data.approval_id}/resolve`, { token: ownerToken, body: { decision: "approve" } });

    const wrongDigest = await call("POST", "/api/v1/admin/data-deletion/commit", {
      token: ownerToken,
      idempotencyKey: "deletion-commit-003",
      body: { plan_digest: sha256("other plan"), approval_id: approval.json.data.approval_id, message_ids: [messageId] },
    });
    assert.equal(wrongDigest.status, 412);
    assert.equal(wrongDigest.json.error.code, "APPROVAL_STALE");

    const executed = await call("POST", "/api/v1/admin/data-deletion/commit", {
      token: ownerToken,
      idempotencyKey: "deletion-commit-004",
      body: { plan_digest: planDigest, approval_id: approval.json.data.approval_id, message_ids: [messageId] },
    });
    assert.equal(executed.status, 200, executed.text);
    const version = raw.prepare("SELECT COUNT(*) AS n FROM message_versions WHERE message_id = ?").get(messageId);
    assert.equal(version.n, 0, "erasure removes stored versions");
    const blocks = raw.prepare("SELECT COUNT(*) AS n FROM message_blocks WHERE message_id = ?").get(messageId);
    assert.equal(blocks.n, 0);
    const fts = raw.prepare("SELECT COUNT(*) AS n FROM message_fts WHERE message_id = ?").get(messageId);
    assert.equal(fts.n, 0);
    const search = await call("POST", "/api/v1/search", { token: ownerToken, body: { query: "파기" } });
    assert.equal(search.json.data.items.length, 0);
  } finally {
    close();
  }
});

test("release gates never claim PASS without evidence", async () => {
  const { call, ownerToken, close } = await setup();
  try {
    const gates = await call("GET", "/api/v1/admin/release-gates", { token: ownerToken });
    assert.equal(gates.status, 200);
    assert.equal(gates.json.data.gates.length, 12);
    assert.equal(gates.json.data.overall, "NOT_RELEASE_READY");
    const g02 = gates.json.data.gates.find((gate) => gate.gate === "G-02");
    assert.equal(g02.status, "BLOCKED_EXTERNAL_DEPENDENCY");
    const g01 = gates.json.data.gates.find((gate) => gate.gate === "G-01");
    assert.equal(g01.status, "INCOMPLETE");
    assert.equal(gates.json.data.gates.some((gate) => gate.status === "PASS"), false, "no gate may pass on this build");
  } finally {
    close();
  }
});

test("resource budgets distinguish measured and unknown usage", async () => {
  const { call, ownerToken, close } = await setup();
  try {
    await call("POST", "/api/v1/admin/usage-budgets", {
      token: ownerToken,
      body: { provider: "github", resource_kind: "workflow_dispatch", hard_limit_value: 10 },
    });
    const budgets = await call("GET", "/api/v1/admin/resource-budgets", { token: ownerToken });
    assert.equal(budgets.status, 200);
    assert.equal(budgets.json.data.auto_billing, "forbidden");
    const dispatchBudget = budgets.json.data.budgets.find((entry) => entry.resource_kind === "workflow_dispatch");
    assert.equal(dispatchBudget.observation_state, "unknown");
    assert.equal(dispatchBudget.remaining, null, "unknown usage has no remaining value");
  } finally {
    close();
  }
});

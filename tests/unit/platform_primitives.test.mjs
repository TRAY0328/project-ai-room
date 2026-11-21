/**
 * Unit coverage for the primitives the API leans on: autonomy guards, continuity,
 * git path/merge policy, collaboration relay, adapter honesty and budgets.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AutonomyGuard, AUTONOMY_LIMITS, detectLoops, similarity } from "../../services/provider-adapters/dist/autonomy.js";
import { validateCheckpoint, canHandoff, planRetry, decideSessionState } from "../../services/provider-adapters/dist/continuity.js";
import { LocalTestAgentAdapter, BrowserSessionAdapter } from "../../services/provider-adapters/dist/adapters.js";
import { CollabSession, DocumentSession } from "../../services/collab-do/dist/index.js";
import { BudgetLedger, planHandoff, reconcileJobAgainstPlatform, workflowAllowlisted, evaluateDispatch, ALLOWED_WORKFLOW_FILES } from "../../services/job-orchestrator/dist/index.js";
import {
  checkRelativePath,
  evaluateMergePolicy,
  inspectZipEntries,
  isValidBranchName,
  redactSecrets,
  scanChangeForSecrets,
  verifyArtifactHash,
  workflowTriggerIsSafe,
} from "../../packages/git/dist/index.js";

const T = "2026-11-21T03:00:00.000Z";

test("autonomy modes get stricter from NATURAL to ECO, and guards refuse repeats", () => {
  assert.ok(AUTONOMY_LIMITS.ECO.max_consecutive_agent_turns < AUTONOMY_LIMITS.NATURAL.max_consecutive_agent_turns);
  assert.ok(AUTONOMY_LIMITS.ECO.max_messages_per_thread < AUTONOMY_LIMITS.NATURAL.max_messages_per_thread);
  assert.ok(AUTONOMY_LIMITS.FAST.max_turn_tokens < AUTONOMY_LIMITS.NATURAL.max_turn_tokens);

  const eco = new AutonomyGuard("ECO");
  const request = { consecutiveAgentTurns: 2, threadMessageCount: 1, chainDepth: 0, lastAgentMessageText: null, proposedText: "새 답변", msSinceAgentLastSpoke: 60_000, agentDailyUsed: 0, projectUsed: 0, agentParallelTasks: 0, recentAuthors: ["a", "b"] };
  assert.equal(eco.check(request).reason, "CONSECUTIVE_TURN_LIMIT");
  const natural = new AutonomyGuard("NATURAL");
  assert.equal(natural.check(request).allowed, true);
  assert.equal(natural.check({ ...request, threadMessageCount: 999 }).reason, "THREAD_MESSAGE_LIMIT");
  assert.equal(natural.check({ ...request, projectUsed: 999_999 }).reason, "PROJECT_BUDGET_EXHAUSTED");
  assert.equal(natural.check({ ...request, msSinceAgentLastSpoke: 10 }).reason, "COOLDOWN");
  assert.ok(similarity("같은 문장입니다", "같은 문장입니다") === 1);
  const loop = detectLoops([
    { author_id: "a", body: "반복 답변" },
    { author_id: "b", body: "반복 답변" },
  ]);
  assert.equal(loop.repeated, true);
  const pingpong = detectLoops(
    ["a", "b", "a", "b", "a", "b"].map((author) => ({ author_id: author, body: Math.random().toString(36) })),
  );
  assert.equal(pingpong.pingPong, true);
});

test("a checkpoint cannot carry a secret", () => {
  const ok = validateCheckpoint({ task_id: "task_1", attempt_id: "att_1", base_commit_sha: "a".repeat(40), checkpoint_hash: "b".repeat(64), agent_messages_cursor: "1" });
  assert.equal(ok.valid, true);
  const leaked = validateCheckpoint({ task_id: "task_1", attempt_id: "att_1", base_commit_sha: "a".repeat(40), checkpoint_hash: "b".repeat(64), refresh_token: "rt_x" });
  assert.equal(leaked.valid, false);
  assert.ok(leaked.problems.some((problem) => problem.includes("refresh_token")));
  const bearer = validateCheckpoint({ task_id: "t", attempt_id: "a", base_commit_sha: "b", checkpoint_hash: "c", log: "Authorization: Bearer abc" });
  assert.equal(bearer.valid, false);
});

test("merge policy demands review at head, a successful check, and a live approval", () => {
  const base = {
    pullRequestState: "OPEN",
    reviewedSha: "a".repeat(40),
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    requiredChecks: [{ name: "verify", conclusion: "success", headSha: "a".repeat(40) }],
    approvals: [{ state: "APPROVED", boundCommitSha: "a".repeat(40), diffSha: null, actionDigest: "d".repeat(64), expectedDigest: "d".repeat(64), expiresAt: "2030-01-01T00:00:00.000Z" }],
    nowMs: Date.parse(T),
  };
  assert.equal(evaluateMergePolicy(base).allowed, true);
  assert.equal(evaluateMergePolicy({ ...base, reviewedSha: "c".repeat(40) }).allowed, false);
  assert.equal(evaluateMergePolicy({ ...base, requiredChecks: [{ name: "verify", conclusion: "failure", headSha: "a".repeat(40) }] }).blocking[0].error_code, "CI_FAILED");
  assert.equal(evaluateMergePolicy({ ...base, requiredChecks: [] }).allowed, true, "policy alone cannot invent a required check");
  assert.equal(evaluateMergePolicy({ ...base, approvals: [{ ...base.approvals[0], actionDigest: "e".repeat(64) }] }).blocking[0].error_code, "APPROVAL_STALE");
  assert.equal(evaluateMergePolicy({ ...base, approvals: [{ ...base.approvals[0], expiresAt: "2020-01-01T00:00:00.000Z" }] }).blocking[0].error_code, "APPROVAL_STALE");
});

test("paths, branches, archives and workflows are refused by shape", () => {
  assert.equal(checkRelativePath("a/../b.txt").ok, true);
  assert.equal(checkRelativePath("a/../../b.txt").ok, false);
  assert.equal(checkRelativePath("a\\b").reason, "BACKSLASH");
  assert.equal(checkRelativePath("a\u0000b").reason, "NUL_BYTE");
  assert.equal(isValidBranchName("ai/feature-1"), true);
  assert.equal(isValidBranchName("main"), false);
  assert.equal(isValidBranchName("feature..x"), false);
  assert.equal(isValidBranchName("bad name"), false);
  assert.equal(inspectZipEntries([{ path: "ok/file.txt", compressedBytes: 10, uncompressedBytes: 20 }]).ok, true);
  assert.equal(workflowTriggerIsSafe("on: [push]").safe, true);
  assert.equal(scanChangeForSecrets("const key = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';").clean, false);
});

test("artifact hashes are compared, not trusted", async () => {
  const bytes = new TextEncoder().encode("hello");
  const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  assert.equal((await verifyArtifactHash(expected, bytes)).matches, true);
  const bad = await verifyArtifactHash("0".repeat(64), bytes);
  assert.equal(bad.matches, false);
  assert.equal(bad.error_code, "ARTIFACT_NOT_VERIFIED");
});

test("the local test adapter proves a nonce round trip and nothing more", async () => {
  const honest = new LocalTestAgentAdapter({ async respond({ nonce }) { return { echo: nonce, responseId: `resp_${nonce}` }; } });
  const proof = await honest.verifyCapability("message.send");
  assert.equal(proof.state, "verified");
  assert.equal(proof.attestation, "discovery_verified", "a round trip is not a provider attestation");
  const fake = new LocalTestAgentAdapter({ async respond() { return { echo: "OK", responseId: "resp_static" }; } });
  assert.equal((await fake.verifyCapability("message.send")).state, "failed");

  const browser = new BrowserSessionAdapter({
    providerKey: "browser",
    support: { provider_key: "browser", display_label: "Browser", official_doc_urls: ["https://example.com"], auth_method: "none_documented", supported_operations: [], unattended_operation: false, cloud_callable: false, free_entitlement: "unknown", free_entitlement_note: "", terms_version_checked_at: null, measured_limits: {}, state: "AUTONOMY_UNSUPPORTED", last_checked_at: T, evidence_ref: null },
    verifySession: async (token) => (token === "good" ? { subjectId: "agent_1", label: "browser" } : null),
  });
  assert.equal((await browser.verifyCapability("message.send")).state, "unsupported");
  assert.equal((await browser.health()).state, "degraded");
  await assert.rejects(() => browser.authenticate({ state_nonce: "n", provider_key: "browser" }));
  assert.deepEqual(await browser.verifyWebSession("good"), { subjectId: "agent_1", label: "browser" });
  await assert.rejects(() => browser.verifyWebSession("bad"));
});

test("collaboration relay refuses duplicates, oversized updates and stale bases", async () => {
  const session = new CollabSession("proj_1", "doc_1", "a".repeat(40));
  const first = session.applyUpdate({ updateId: "u1", bytes: new Uint8Array([1, 2, 3]), originSessionId: "s1" });
  assert.deepEqual(first, { accepted: true, revision: 1 });
  assert.equal(session.applyUpdate({ updateId: "u1", bytes: new Uint8Array([1]), originSessionId: "s1" }).reason, "DUPLICATE");
  assert.equal(session.applyUpdate({ updateId: "u2", bytes: new Uint8Array(600 * 1024), originSessionId: "s2" }).reason, "TOO_LARGE");
  const sync = session.syncSince(0);
  assert.equal(sync.updates.length, 1);
  assert.equal(session.syncSince(5), null);
  assert.equal(session.publish({ commitMessage: "x", baseSha: "b".repeat(40), authorId: "a" }, "a".repeat(40)).status, "CONFLICT");
  assert.equal(session.publish({ commitMessage: "x", baseSha: "a".repeat(40), authorId: "a" }, "c".repeat(40)).reason, "REMOTE_MOVED");
  assert.equal(session.publish({ commitMessage: "x", baseSha: "a".repeat(40), authorId: "a" }, null).status, "UNSUPPORTED");
  session.updateAwareness({ session_id: "s1", actor_id: "agent_1", cursor: { anchor: 1, head: 2 }, selection: false }, 1000);
  assert.equal(session.liveAwareness(1000).length, 1);
  assert.equal(session.liveAwareness(200_000).length, 0, "a stale cursor disappears");
  const digest = await session.snapshotDigest();
  assert.equal(digest.update_count, 1);
  assert.equal(digest.digest_sha256.length, 64);
  session.advanceBase("d".repeat(40));
  assert.equal(session.info().update_count, 0);
});

test("job budgets and reconciliation never promote unknown or requested to done", () => {
  const ledger = new BudgetLedger();
  assert.deepEqual(ledger.check("agent:1", 1), { allowed: false, reason: "UNMEASURED", remaining: null });
  ledger.set({ key: "agent:1", limit: 10, used: 9, measured: true });
  assert.equal(ledger.check("agent:1", 2).reason, "EXHAUSTED");
  assert.equal(ledger.check("agent:1", 1).allowed, true);
  ledger.consume("agent:1", 1);
  assert.equal(ledger.check("agent:1", 1).reason, "EXHAUSTED");
  assert.equal(reconcileJobAgainstPlatform({ localState: "CANCEL_REQUESTED", platformState: "in_progress", platformConclusion: null }).state, "CANCEL_REQUESTED");
  assert.equal(reconcileJobAgainstPlatform({ localState: "RUNNING", platformState: "completed", platformConclusion: "success" }).state, "SUCCEEDED");
  assert.equal(reconcileJobAgainstPlatform({ localState: "RUNNING", platformState: "unknown", platformConclusion: null }).changed, false);
  assert.equal(workflowAllowlisted(ALLOWED_WORKFLOW_FILES[0]), true);
  assert.equal(workflowAllowlisted("../../evil.yml"), false);
  const decision = evaluateDispatch({ emergencyStop: true, repositoryBound: true, providerClientBound: true, observedUsage: 0, hardLimit: 10, estimatedCost: 1, workflowAllowlisted: true });
  assert.ok(decision.blockers.includes("EMERGENCY_STOP"));
});

test("document session keeps the Git binding separate from the relay revision", () => {
  const session = new DocumentSession("proj_1", "doc_1", "a".repeat(40));
  session.applyUpdate(new Uint8Array([9]));
  assert.equal(session.snapshotRef().revision, 1);
  session.advanceBase("f".repeat(40));
  assert.equal(session.snapshotRef().baseSha, "f".repeat(40));
  assert.equal(session.publish({ commitMessage: "x", baseSha: "a".repeat(40), authorId: "a" }, "f".repeat(40)).status, "CONFLICT");
  assert.equal(canHandoff({ checkpointValid: true, checkpointAgeMs: 1, maxAgeMs: 10, successorHasVerifiedCapability: true, successorInProject: true, successorBlocked: false }).allowed, true);
  void planRetry;
  void decideSessionState;
  void planHandoff;
});

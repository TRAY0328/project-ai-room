/**
 * Contract unit tests — the shared contract is the first line of defence, so it
 * is tested before any feature code exists.
 *
 * Run: npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  API_CATALOG,
  ApiError,
  CONTRACT_MANIFEST,
  assertIdOfKind,
  buildPath,
  backoffDelayMs,
  defaultMessageFor,
  evaluate,
  evaluateRequiredRoster,
  evaluateTaskTransition,
  httpStatusFor,
  isFresh,
  isIdOfKind,
  matchRoute,
  mintId,
  newAgentId,
  newMessageId,
  newRoomId,
  parseId,
  parseUtcIso,
  planResync,
  reconcileJobCancel,
  toApiErrorResponse,
  toUtcIso,
  zClientFrame,
  zEventEnvelope,
  zPageQuery,
  zTaskTransitionInput,
} from "@ai-room/contracts";
import { buildProviderRegistry, q039Gate } from "@ai-room/provider-adapters";
import { JobOrchestrator, LeaseManager } from "@ai-room/job-orchestrator";
import { RoomCoordinator } from "@ai-room/room-do";
import { DocumentSession } from "@ai-room/collab-do";

const T = "2026-11-21T00:00:00.000Z";

// ---------------------------------------------------------------------------
test("ids: typed prefixes, RFC 9562 version, time ordering, rejection of wrong kinds", () => {
  const a = newMessageId(Date.parse("2026-11-21T00:00:00.000Z"));
  const b = newMessageId(Date.parse("2026-11-21T00:00:01.000Z"));
  assert.ok(a < b, "uuidv7 ids minted later must sort later");
  assert.equal(parseId(a).kind, "message");
  assert.equal(parseId(a).mintedAtMs, Date.parse("2026-11-21T00:00:00.000Z"));
  assert.ok(isIdOfKind(a, "message"));
  assert.ok(!isIdOfKind(a, "room"));
  assert.throws(() => assertIdOfKind(a, "room"), /expected a room_ id/);
  assert.equal(parseId("msg_00000000000000000000000000"), null, "lowercase is outside the alphabet");
  assert.equal(parseId("msg_short"), null);
  assert.equal(parseId("unknown_" + "0".repeat(26)), null);
  const ids = new Set(Array.from({ length: 500 }, () => newRoomId()));
  assert.equal(ids.size, 500, "500 minted ids must be unique");
});

test("time: UTC ISO-8601 milliseconds only, with calendar and freshness checks", () => {
  assert.equal(toUtcIso(0), "1970-01-01T00:00:00.000Z");
  assert.equal(parseUtcIso(T), Date.parse(T));
  assert.equal(parseUtcIso("2026-11-21T09:00:00+09:00"), null, "offsets are rejected");
  assert.equal(parseUtcIso("2026-11-21T00:00:00Z"), null, "milliseconds are required");
  assert.equal(parseUtcIso("2026-02-31T00:00:00.000Z"), null, "impossible date is rejected");
  const now = Date.parse(T);
  assert.ok(isFresh(T, 60_000, { nowMs: now + 1_000 }));
  assert.ok(!isFresh(T, 60_000, { nowMs: now + 61_000 }));
  assert.ok(!isFresh(T, 60_000, { nowMs: now - 60_000 }), "future timestamps beyond skew are rejected");
});

test("errors: status mapping, retryable flags and a non-leaking envelope", () => {
  assert.equal(httpStatusFor("AUTH_REQUIRED"), 401);
  assert.equal(httpStatusFor("PERMISSION_DENIED"), 403);
  assert.equal(httpStatusFor("ROOM_ACCESS_DENIED"), 403);
  assert.equal(httpStatusFor("REVISION_CONFLICT"), 409);
  assert.equal(httpStatusFor("APPROVAL_REQUIRED"), 428);
  assert.equal(httpStatusFor("RATE_LIMITED"), 429);
  assert.equal(httpStatusFor("EXTERNAL_DEPENDENCY_BLOCKED"), 503);
  assert.equal(httpStatusFor("VALIDATION_FAILED"), 400);
  const blocked = toApiErrorResponse(new ApiError({ code: "EXTERNAL_DEPENDENCY_BLOCKED", requestId: "req_1" }), "req_1");
  assert.equal(blocked.error.retryable, true);
  assert.equal(blocked.error.message, defaultMessageFor("EXTERNAL_DEPENDENCY_BLOCKED"));
  const leaked = toApiErrorResponse(new Error("SQLITE_ERROR: no such table agents at handler.ts:42"), "req_2");
  assert.equal(leaked.error.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(leaked).includes("SQLITE"), "internal detail must not reach the client");
  assert.ok(backoffDelayMs(3) <= 500 * Math.pow(2, 3));
});

test("permissions: default deny, owner-only admin, agent self-scope, room/project membership, approvals", () => {
  const owner = { kind: "owner", id: "owner_1", platformAdmin: true };
  const agent = { kind: "agent", id: newAgentId(), platformAdmin: false };
  const base = {
    subject: agent,
    resource: { type: "room", id: "room_1", roomId: "room_1" },
    sessionAssurance: "agent_key",
  };

  // owner
  assert.equal(evaluate({ subject: owner, action: "owner.admin.policy.write", resource: { type: "system", id: "system" }, sessionAssurance: "owner_ui" }).allowed, true);
  assert.equal(evaluate({ subject: { ...owner, platformAdmin: false }, action: "owner.admin.restore", resource: { type: "system", id: "system" }, sessionAssurance: "owner_ui" }).reason_code, "PLATFORM_ADMIN_EXCLUSIVE");

  // default deny and unknown action
  assert.equal(evaluate({ ...base, action: "room.explode" }).reason_code, "UNKNOWN_ACTION");
  assert.equal(evaluate({ ...base, action: "room.read", sessionAssurance: "none" }).reason_code, "SESSION_ASSURANCE_INSUFFICIENT");

  // agent can never be admin or decide an approval
  assert.equal(evaluate({ ...base, action: "approval.decide" }).reason_code, "PLATFORM_ADMIN_EXCLUSIVE");
  assert.equal(evaluate({ ...base, subject: { ...agent, platformAdmin: true }, action: "room.read" }).reason_code, "PLATFORM_ADMIN_EXCLUSIVE");

  // room membership is participation, not a name
  assert.equal(evaluate({ ...base, action: "room.message.read", membership: { roomIds: [], projectIds: [] } }).reason_code, "NOT_ROOM_MEMBER");
  const allowed = evaluate({ ...base, action: "room.message.read", membership: { roomIds: ["room_1"], projectIds: [] } });
  assert.equal(allowed.allowed, true);

  // project scope for files/git/memory
  const fileCtx = {
    ...base,
    action: "file.download",
    resource: { type: "file", id: "file_1", projectId: "proj_1" },
    membership: { roomIds: [], projectIds: ["proj_2"] },
  };
  assert.equal(evaluate(fileCtx).reason_code, "NOT_PROJECT_MEMBER");
  assert.equal(evaluate({ ...fileCtx, membership: { roomIds: [], projectIds: ["proj_1"] } }).constraints.fileScanState, "ready");

  // self-service profile: only own profile, only allowlisted fields
  const other = newAgentId();
  assert.equal(evaluate({ ...base, action: "agent.profile.write.self", resource: { type: "agent", id: other, agentId: other } }).reason_code, "SELF_ONLY");
  const selfProfile = evaluate({ ...base, action: "agent.profile.write.self", resource: { type: "agent", id: agent.id, agentId: agent.id } });
  assert.equal(selfProfile.allowed, true);
  assert.ok(selfProfile.constraints.immutableFields.includes("platform_admin"));

  // high-risk needs a live, digest-matching approval
  const merge = {
    ...base,
    action: "git.merge",
    resource: { type: "pull_request", id: "pr_1", projectId: "proj_1" },
    membership: { roomIds: [], projectIds: ["proj_1"] },
  };
  assert.equal(evaluate(merge).reason_code, "APPROVAL_REQUIRED");
  assert.equal(evaluate({ ...merge, approval: { approvalId: "apr_1", state: "approved", actionDigest: "a" }, attemptedActionDigest: "b" }).reason_code, "APPROVAL_DIGEST_MISMATCH");
  assert.equal(evaluate({ ...merge, approval: { approvalId: "apr_1", state: "approved", actionDigest: "a" }, attemptedActionDigest: "a", approvalStale: true }).reason_code, "APPROVAL_STALE");
  assert.equal(evaluate({ ...merge, approval: { approvalId: "apr_1", state: "approved", actionDigest: "a" }, attemptedActionDigest: "a" }).allowed, true);

  // system actor: internal work only
  const system = { kind: "system", id: "system", platformAdmin: false };
  assert.equal(evaluate({ subject: system, action: "room.message.create", resource: { type: "room", id: "room_1", roomId: "room_1" }, sessionAssurance: "service" }).allowed, true);
  assert.equal(evaluate({ subject: system, action: "owner.admin.audit.read", resource: { type: "system", id: "system" }, sessionAssurance: "service" }).reason_code, "PLATFORM_ADMIN_EXCLUSIVE");
});

test("events: envelope validation, unknown types rejected, resync planning", () => {
  const envelope = {
    event_id: "evt_1",
    schema_version: 1,
    event_type: "task.status.changed",
    occurred_at: T,
    received_at: T,
    actor: { type: "agent", id: "agent_1" },
    aggregate: { type: "task", id: "task_1", revision: 2 },
    scope: { room_id: null, project_id: "proj_1" },
    correlation_id: "corr_1",
    causation_id: null,
    idempotency_key: null,
    payload: { status: "READY" },
  };
  assert.equal(zEventEnvelope.safeParse(envelope).success, true);
  assert.equal(zEventEnvelope.safeParse({ ...envelope, event_type: "task.status.willChange" }).success, false, "past tense only");
  assert.equal(zEventEnvelope.safeParse({ ...envelope, occurred_at: "2026-11-21T09:00:00+09:00" }).success, false);
  assert.equal(planResync(null, 10).mode, "snapshot_required");
  assert.equal(planResync(9, 10).mode, "replay");
  assert.equal(planResync(1, 10_000).mode, "snapshot_required");
  assert.equal(zClientFrame.safeParse({ type: "HELLO", ticket_id: "t1", last_seen_seq: 7, client_capabilities: [] }).success, true);
  assert.equal(zClientFrame.safeParse({ type: "HELLO", ticket_id: "t1", last_seen_seq: -1 }).success, false);
});

test("lifecycle: task transitions, DONE evidence, job cancel reconciliation, approval validity", () => {
  const base = { hasVerifiedEvidence: true, dependenciesDone: true, holdsCurrentLease: true };
  assert.equal(evaluateTaskTransition({ from: "PROPOSED", to: "DONE", ...base }).ok, false);
  assert.equal(evaluateTaskTransition({ from: "VERIFYING", to: "DONE", ...base }).ok, true);
  assert.equal(evaluateTaskTransition({ from: "VERIFYING", to: "DONE", ...base, hasVerifiedEvidence: false }).code, "TASK_DONE_REQUIRES_EVIDENCE");
  assert.equal(evaluateTaskTransition({ from: "CLAIM_ACCEPTED", to: "READY", ...base, dependenciesDone: false }).code, "TASK_READY_REQUIRES_COMPLETE_DEPENDENCIES");
  assert.equal(evaluateTaskTransition({ from: "LEASED", to: "RUNNING", ...base, holdsCurrentLease: false }).code, "TASK_LEASE_NOT_HELD");

  assert.equal(reconcileJobCancel({ requested: true, platformState: "in_progress", platformConclusion: null }), "CANCEL_REQUESTED");
  assert.equal(reconcileJobCancel({ requested: true, platformState: "completed", platformConclusion: "cancelled" }), "CANCELLED");
  assert.equal(reconcileJobCancel({ requested: true, platformState: "unknown", platformConclusion: null }), "CANCEL_REQUESTED");
  assert.equal(reconcileJobCancel({ requested: false, platformState: "completed", platformConclusion: "success" }), "SUCCEEDED");
});

test("api catalog: 78 endpoints, route matching with params, bounded pagination", () => {
  assert.equal(CONTRACT_MANIFEST.api_endpoints, 78);
  assert.equal(API_CATALOG.length, 78);
  assert.equal(new Set(API_CATALOG.map((e) => e.operationId)).size, 78);
  const match = matchRoute(API_CATALOG, "post", "/api/v1/projects/proj_1/tasks");
  assert.ok(match !== null);
  assert.equal(match.endpoint.operationId, "post-projects-by-projectId-tasks");
  assert.equal(match.params.projectId, "proj_1");
  const withPath = match.endpoint;
  assert.equal(buildPath(withPath, { projectId: "proj_1" }), "/api/v1/projects/proj_1/tasks");
  assert.equal(matchRoute(API_CATALOG, "POST", "/api/v1/nope"), null);
  assert.equal(zPageQuery.safeParse({ limit: "500" }).success, false, "limit is clamped by schema");
  assert.equal(zPageQuery.safeParse({ limit: "25" }).data.limit, 25);
  assert.equal(zTaskTransitionInput.safeParse({ expected_revision: 2, to_status: "DONE", evidence_ids: ["evd_1"] }).success, true);
  assert.equal(zTaskTransitionInput.safeParse({ expected_revision: 0, to_status: "DONE" }).success, false);
});

test("providers: registry is honest and the Q039 gate stays blocked", async () => {
  const registry = buildProviderRegistry();
  assert.equal(registry.size, 8);
  for (const [key, entry] of registry) {
    assert.ok(entry.evidence.official_doc_urls.length > 0, `${key} needs an official doc url`);
    assert.notEqual(entry.evidence.state, "VERIFIED", `${key} cannot be verified without a real proof`);
    const proof = await entry.adapter.verifyCapability("message.send");
    assert.equal(proof.state, "unsupported");
    const health = await entry.adapter.health();
    assert.equal(health.state, "blocked");
  }
  const gate = q039Gate();
  assert.equal(gate.gate, "BLOCKED_EXTERNAL_DEPENDENCY");
  assert.equal(gate.blockers.length, 8);
  assert.ok(gate.blockers.some((b) => b.state === "PAID_API_REQUIRED"));
  assert.ok(gate.blockers.some((b) => b.state === "NO_OFFICIAL_EVIDENCE"));

  const evaluation = evaluateRequiredRoster(
    [{ provider_key: "x", display_label: "X", required: true, verification_state: "verified", proof: "p" }],
    [{ provider_key: "x", display_label: "X", official_doc_urls: ["https://example.com"], auth_method: "api_key", supported_operations: [], unattended_operation: true, cloud_callable: true, free_entitlement: "verified_free", free_entitlement_note: "", terms_version_checked_at: null, measured_limits: {}, state: "VERIFIED", last_checked_at: T, evidence_ref: null }],
  );
  assert.equal(evaluation.gate, "PASS");
});

test("room DO: seq reservation is idempotent and persistence gates broadcast", async () => {
  const store = new Map();
  const storage = {
    async get(key) { return store.get(key); },
    async put(key, value) { store.set(key, value); },
    async delete(key) { return store.delete(key); },
  };
  const room = new RoomCoordinator("room_1", storage);
  await room.load();
  const first = await room.reserveSeq("idem-1");
  const second = await room.reserveSeq("idem-1");
  assert.deepEqual(first, { seq: 1, duplicate: false });
  assert.deepEqual(second, { seq: 1, duplicate: true });
  assert.equal((await room.reserveSeq("idem-2")).seq, 2);
  const broadcast = await room.confirmPersisted(1, { message_id: "msg_1", room_seq: 1, author_kind: "agent", author_id: "agent_1", revision: 1 });
  assert.equal(broadcast.seq, 1);
  assert.equal(broadcast.frame.event.type, "room.message.created");
  assert.equal(await room.confirmPersisted(1, { message_id: "msg_1", room_seq: 1, author_kind: "agent", author_id: "agent_1", revision: 1 }), null);
  const hello = room.handleHello({ ticket_id: "t", subject_kind: "agent", subject_id: "agent_1", room_id: "room_1", project_id: null, permissions: ["room.read"], issued_at: T, expires_at: T, nonce: "0".repeat(16) }, 0);
  assert.equal(hello.type, "HELLO_OK");
});

test("collab DO: publish is refused when the remote moved", () => {
  const session = new DocumentSession("proj_1", "doc_1", "a".repeat(40));
  session.applyUpdate(new Uint8Array([1, 2, 3]));
  const stale = session.publish({ commitMessage: "x", baseSha: "b".repeat(40), authorId: "agent_1" }, "a".repeat(40));
  assert.equal(stale.status, "CONFLICT");
  const moved = session.publish({ commitMessage: "x", baseSha: "a".repeat(40), authorId: "agent_1" }, "c".repeat(40));
  assert.deepEqual(moved, { status: "CONFLICT", remoteHeadSha: "c".repeat(40), reason: "REMOTE_MOVED" });
  const ok = session.publish({ commitMessage: "x", baseSha: "a".repeat(40), authorId: "agent_1" }, "a".repeat(40));
  assert.equal(ok.status, "PUBLISHED");
  assert.equal(session.publish({ commitMessage: "x", baseSha: "a".repeat(40), authorId: "agent_1" }, null).status, "UNSUPPORTED");
});

test("job orchestrator: leases fence stale work and cancel never completes early", () => {
  const leases = new LeaseManager();
  const agent = { agentId: "agent_1", blocked: false, hasVerifiedCapability: true };
  const first = leases.grant({ taskId: "task_1", attemptId: "att_1", agent, taskReady: true, dependenciesDone: true, nowMs: 1000, ttlMs: 500 });
  assert.equal(first.granted, true);
  assert.equal(first.lease.fencingGeneration, 1);
  assert.equal(leases.grant({ taskId: "task_1", attemptId: "att_2", agent, taskReady: true, dependenciesDone: true, nowMs: 1200, ttlMs: 500 }).reason, "NOT_EXPIRED");
  const second = leases.grant({ taskId: "task_1", attemptId: "att_2", agent, taskReady: true, dependenciesDone: true, nowMs: 1600, ttlMs: 500 });
  assert.equal(second.lease.fencingGeneration, 2);
  assert.equal(leases.acceptResult("task_1", "att_1", 1, 1600), false, "late result from the old generation is refused");
  assert.equal(leases.acceptResult("task_1", "att_2", 2, 1700), true);

  const jobs = new JobOrchestrator();
  jobs.enqueue("job_1");
  jobs.transition("job_1", "DISPATCH_REQUESTED");
  assert.equal(jobs.get("job_1").state, "DISPATCH_REQUESTED", "dispatch request is not a running build");
  assert.equal(jobs.transition("job_1", "SUCCEEDED").accepted, false);
  jobs.transition("job_1", "DISPATCHED");
  jobs.transition("job_1", "RUNNING");
  jobs.requestCancel("job_1");
  assert.equal(jobs.get("job_1").state, "CANCEL_REQUESTED");
  jobs.applyPlatformState("job_1", "in_progress", null);
  assert.equal(jobs.get("job_1").state, "CANCEL_REQUESTED", "in-progress run is not cancelled yet");
  jobs.applyPlatformState("job_1", "completed", "cancelled");
  assert.equal(jobs.get("job_1").state, "CANCELLED");
});

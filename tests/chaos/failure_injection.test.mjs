/**
 * Concurrency and failure injection — spec 08.5, 09, 24.1 (7), E2E-06/07/24/25/27.
 *
 * The point is not that these paths work when everything is fine. It is that a
 * retry, a duplicate, a timeout or a single failed statement leaves a state the
 * server can describe truthfully.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "../integration/helpers.mjs";
import { RoomLiveSession } from "../../services/room-do/dist/index.js";
import { planResume, planRetry, decideSessionState, canHandoff } from "../../services/provider-adapters/dist/continuity.js";
import { planHandoff, evaluateDispatch } from "../../services/job-orchestrator/dist/index.js";
import { applyWebhook, mapWebhook, recordDelivery } from "../../services/github-integration/dist/index.js";

function memoryStorage() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.get(key);
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      return store.delete(key);
    },
  };
}

test("60 concurrent sends produce a gap-free, duplicate-free sequence", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        call("POST", `/api/v1/rooms/${roomId}/messages`, {
          token: ownerToken,
          idempotencyKey: `chaos-msg-${String(index).padStart(4, "0")}`,
          body: { blocks: [{ block_id: "b", block_type: "text", payload: { text: `msg ${index}` } }], idempotency_key: `chaos-msg-${String(index).padStart(4, "0")}` },
        }),
      ),
    );
    assert.equal(responses.filter((response) => response.status === 500).length, 0);
    const ok = responses.filter((response) => response.status === 201);
    assert.equal(ok.length, 60);
    const seqs = ok.map((response) => response.json.data.message.room_seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 60 }, (_, index) => index + 1), "room_seq must be contiguous");
    assert.equal(new Set(ok.map((response) => response.json.data.message.message_id)).size, 60);
  } finally {
    close();
  }
});

test("the same idempotency key in parallel creates exactly one message", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        call("POST", `/api/v1/rooms/${roomId}/messages`, {
          token: ownerToken,
          idempotencyKey: "chaos-same-key-0001",
          body: { blocks: [{ block_id: "b", block_type: "text", payload: { text: "동시 전송" } }], idempotency_key: "chaos-same-key-0001" },
        }),
      ),
    );
    const created = responses.filter((response) => response.status === 201);
    const retried = responses.filter((response) => response.status === 503 || response.status === 409);
    assert.equal(created.length + retried.length, 5);
    const list = await call("GET", `/api/v1/rooms/${roomId}/messages`, { token: ownerToken });
    assert.equal(list.json.data.items.length, 1, "one key, one message");
  } finally {
    close();
  }
});

test("a failed statement leaves no partial message and the retry succeeds", async () => {
  const harness = await setup();
  const { call, ownerToken, roomId, env, close } = harness;
  try {
    let failed = false;
    const wrappedDb = {
      prepare(sql) {
        const statement = env.DB.prepare(sql);
        if (!failed && sql.startsWith("INSERT INTO messages")) {
          failed = true;
          return {
            bind() {
              throw new Error("injected D1 write failure");
            },
          };
        }
        return statement;
      },
      async exec(sql) {
        return env.DB.exec(sql);
      },
    };
    const broken = { ...env, DB: wrappedDb };
    const { createCaller } = await import("../../packages/testing/index.mjs");
    const gateway = (await import("../../services/gateway-worker/dist/index.js")).default;
    const brokenCall = createCaller(gateway, broken);
    const attempt = await brokenCall("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: ownerToken,
      idempotencyKey: "chaos-failure-0001",
      body: { blocks: [{ block_id: "b", block_type: "text", payload: { text: "실패" } }], idempotency_key: "chaos-failure-0001" },
    });
    assert.equal(attempt.status, 500);
    assert.equal(attempt.json.error.code, "INTERNAL_ERROR");
    assert.ok(!attempt.text.includes("injected"), "the internal reason must not leak");

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first();
    assert.equal(rows.n, 0, "no partial row");
    const keys = await env.DB.prepare("SELECT status FROM idempotency_keys WHERE idempotency_key = ?").bind("chaos-failure-0001").all();
    assert.equal(keys.results[0].status, "failed", "a failed attempt is recorded so a retry is allowed");

    const retry = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: ownerToken,
      idempotencyKey: "chaos-failure-0001",
      body: { blocks: [{ block_id: "b", block_type: "text", payload: { text: "실패" } }], idempotency_key: "chaos-failure-0001" },
    });
    assert.equal(retry.status, 201);
  } finally {
    close();
  }
});

test("a reconnect without a known socket is told to take a snapshot", async () => {
  const { env, roomId, close } = await setup();
  try {
    const session = new RoomLiveSession(roomId, memoryStorage(), env.WS_TICKET_SIGNING_KEY, 1);
    await session.load();
    for (let seq = 1; seq <= 3; seq += 1) {
      await session.broadcastPersisted(seq, { message_id: `msg_${seq}`, room_seq: seq, author_kind: "owner", author_id: "owner_1", revision: 1 });
    }
    const unknown = session.resume("missing-socket", 0);
    assert.equal(unknown.snapshotRequired, true);
    assert.equal(unknown.frames[0].type, "CLOSE");
    const farBehind = session.resume("another-missing", 0);
    assert.equal(farBehind.snapshotRequired, true);
    assert.equal(session.latestSeq, 3);
  } finally {
    close();
  }
});

test("room-do buffer replay, ticket expiry and heartbeat sweep", async () => {
  const { env, roomId, close } = await setup();
  try {
    const session = new RoomLiveSession(roomId, memoryStorage(), env.WS_TICKET_SIGNING_KEY, 1);
    await session.load();
    const received = [];
    const socket = { send: (data) => received.push(data), close() {} };
    const ticket = await env.SESSION_SIGNING_KEY;
    void ticket;

    // Expired ticket is refused at the handshake.
    const { signWsTicket } = await import("../../packages/auth/dist/index.js");
    const expired = await signWsTicket(
      {
        v: "v1",
        ticket_id: "ticket_expired",
        subject_kind: "owner",
        subject_id: "owner_1",
        room_id: roomId,
        project_id: null,
        permissions: ["ws.subscribe"],
        issued_at: "2026-11-21T02:00:00.000Z",
        expires_at: "2026-11-21T02:01:00.000Z",
        nonce: "0".repeat(16),
        acl_revision: 1,
      },
      env.WS_TICKET_SIGNING_KEY,
    );
    const refused = await session.accept(expired, socket, "s0", Date.parse("2026-11-21T03:00:00.000Z"));
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.frame, { type: "CLOSE", reason: "expired" });

    const live = await signWsTicket(
      {
        v: "v1",
        ticket_id: "ticket_live",
        subject_kind: "owner",
        subject_id: "owner_1",
        room_id: roomId,
        project_id: null,
        permissions: ["ws.subscribe"],
        issued_at: "2026-11-21T02:59:30.000Z",
        expires_at: "2026-11-21T03:00:30.000Z",
        nonce: "1".repeat(16),
        acl_revision: 1,
      },
      env.WS_TICKET_SIGNING_KEY,
    );
    const accepted = await session.accept(live, socket, "s1", Date.parse("2026-11-21T03:00:00.000Z"));
    assert.equal(accepted.ok, true);
    assert.equal(session.socketCount(), 1);
    assert.equal(session.presence(Date.parse("2026-11-21T03:00:00.000Z")).length, 1);

    for (let seq = 1; seq <= 3; seq += 1) {
      await session.broadcastPersisted(seq, { message_id: `msg_${seq}`, room_seq: seq, author_kind: "owner", author_id: "owner_1", revision: 1 });
    }
    const replay = session.resume("s1", 1);
    assert.equal(replay.snapshotRequired, false);
    assert.equal(replay.frames.length, 2, "exactly the two missed events");

    // No heartbeat for 90s: the socket is closed as heartbeat_timeout.
    const swept = await session.sweepHeartbeats(Date.parse("2026-11-21T03:01:30.000Z"));
    assert.equal(swept, 1);
    assert.equal(session.socketCount(), 0);
    assert.ok(received.some((entry) => String(entry).includes("heartbeat_timeout")));
  } finally {
    close();
  }
});

test("duplicate webhook deliveries create one run row and one state", async () => {
  const harness = await setup();
  const { db, call, ownerToken, createProject, close } = harness;
  try {
    const projectId = await createProject("웹훅 중복");
    await call("POST", `/api/v1/projects/${projectId}/repositories`, { token: ownerToken, body: { repo_full_name: "TRAY0328/chaos", github_repository_id: "990099" } });
    const payload = { workflow_run: { id: 424242, name: "verify", head_sha: "a".repeat(40), status: "completed", conclusion: "success", run_attempt: 1, pull_requests: [] } };
    const mapped = mapWebhook("workflow_run", payload);
    const first = await recordDelivery(db, { deliveryId: "chaos-delivery-1", event: "workflow_run", payloadSha256: "a".repeat(64) });
    assert.equal(first.duplicate, false);
    const appliedFirst = await applyWebhook(db, mapped, "chaos-delivery-1");
    const appliedAgain = await applyWebhook(db, mapped, "chaos-delivery-1");
    assert.equal(appliedFirst.applied, true);
    assert.equal(appliedAgain.applied, true, "re-application is idempotent, not a second run");
    const runs = await db.prepare("SELECT COUNT(*) AS n FROM ci_runs WHERE github_run_id = ?").bind("424242").all();
    assert.equal(runs.results[0].n, 1);
    const second = await recordDelivery(db, { deliveryId: "chaos-delivery-1", event: "workflow_run", payloadSha256: "a".repeat(64) });
    assert.equal(second.duplicate, true);
  } finally {
    close();
  }
});

test("restore planning detects drift after the backup", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    const backup = await call("POST", "/api/v1/admin/backups", { token: ownerToken, body: { scope: ["chat"] } });
    await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: ownerToken,
      idempotencyKey: "chaos-drift-0001",
      body: { blocks: [{ block_id: "b", block_type: "text", payload: { text: "백업 이후 변경" } }], idempotency_key: "chaos-drift-0001" },
    });
    const prepared = await call("POST", "/api/v1/admin/restores/prepare", { token: ownerToken, body: { backup_id: backup.json.data.backup_id } });
    assert.equal(prepared.status, 201);
    assert.ok(prepared.json.data.plan.drift.some((entry) => entry.table === "messages"), "drift must be reported");
    assert.ok(prepared.json.data.plan.drift.some((entry) => entry.signature_changed));
  } finally {
    close();
  }
});

test("continuity plans reconcile a timeout instead of re-running it", () => {
  const resume = planResume({ lastAckedCursor: "42", lastCallState: "timeout", nowMs: 1000 });
  assert.equal(resume.mode, "reconcile");
  assert.equal(resume.from_cursor, "42");
  const authResume = planResume({ lastAckedCursor: "42", lastCallState: "auth_failed", nowMs: 1000 });
  assert.equal(authResume.mode, "reauth");
  assert.equal(planRetry({ kind: "auth", status: 401, retryable: false }, 0).max_attempts, 0);
  assert.equal(planRetry({ kind: "rate_limited", retryAfterMs: 30_000 }, 1, () => 0.5).next_delay_ms, 30_000);
  const network = planRetry({ kind: "network", retryable: true }, 3, () => 1);
  assert.ok(network.next_delay_ms !== null && network.next_delay_ms > 0);
  const state = decideSessionState({ registered: true, authenticatedAtMs: 1, connected: true, lastResponseAtMs: null, lastPingAtMs: 900, rateLimitedUntilMs: null, busy: false, unsupportedReason: null, blockedReason: null, quotaExhausted: false }, 1000);
  assert.equal(state.state, "AVAILABLE");
  assert.equal(state.online, true);
  const quota = decideSessionState({ registered: true, authenticatedAtMs: 1, connected: true, lastResponseAtMs: null, lastPingAtMs: 900, rateLimitedUntilMs: null, busy: false, unsupportedReason: null, blockedReason: null, quotaExhausted: true }, 1000);
  assert.equal(quota.state, "RATE_LIMITED");
});

test("handoff and dispatch refuse when the successor or budget is not proven", () => {
  const checkpoint = { checkpoint_id: "cp_1", task_id: "task_1", attempt_id: "att_1", fencing_generation: 1, created_at_ms: 1000, valid_for_ms: 60_000, checkpoint_sha256: "a".repeat(64), integrity_ok: true };
  const ok = planHandoff({ checkpoint, currentGeneration: 1, successorHasVerifiedCapability: true, successorBlocked: false, successorIsSameAgent: false, nowMs: 2000 });
  assert.equal(ok.allowed, true);
  assert.equal(ok.new_fencing_generation, 2);
  assert.equal(ok.old_attempt_status, "SUPERSEDED");
  assert.equal(planHandoff({ checkpoint: { ...checkpoint, integrity_ok: false }, currentGeneration: 1, successorHasVerifiedCapability: true, successorBlocked: false, successorIsSameAgent: false, nowMs: 2000 }).reason, "CHECKPOINT_INTEGRITY_FAILED");
  assert.equal(planHandoff({ checkpoint, currentGeneration: 1, successorHasVerifiedCapability: false, successorBlocked: false, successorIsSameAgent: false, nowMs: 2000 }).reason, "SUCCESSOR_NOT_CAPABLE");
  assert.equal(canHandoff({ checkpointValid: true, checkpointAgeMs: 999_999, maxAgeMs: 1000, successorHasVerifiedCapability: true, successorInProject: true, successorBlocked: false }).allowed, false);

  const decision = evaluateDispatch({ emergencyStop: false, repositoryBound: true, providerClientBound: true, observedUsage: null, hardLimit: 10, estimatedCost: 1, workflowAllowlisted: true });
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockers.includes("OBSERVED_USAGE_UNKNOWN"));
});

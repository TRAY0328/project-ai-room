/**
 * Project/task/memory integration tests — the 18-state machine, evidence-gated
 * completion, fencing, handoff, and the three memory layers with an explicit
 * cross-project share.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";

async function move(call, token, taskId, toState, expectedRevision, extra = {}) {
  return call("POST", `/api/v1/tasks/${taskId}/transition`, {
    token,
    body: { to_state: toState, expected_revision: expectedRevision, ...extra },
  });
}

test("a task cannot become DONE without verified evidence", async () => {
  const { call, ownerToken, registerAgent, createProject, close } = await setup();
  try {
    const agent = await registerAgent("피클");
    const projectId = await createProject("PROJECT AI ROOM", [agent.agentId]);
    const created = await call("POST", `/api/v1/projects/${projectId}/tasks`, {
      token: ownerToken,
      body: { title: "계약 확정", description: "18상태 테스트", risk_level: "high", acceptance_criteria: ["테스트 PASS"] },
    });
    assert.equal(created.status, 201);
    const taskId = created.json.data.task_id;

    const steps = [
      ["SPECIFIED", 1],
      ["OPEN_FOR_CLAIM", 2],
      ["CLAIM_PROPOSED", 3],
    ];
    let revision = 1;
    const proposalMessage = await call("POST", `/api/v1/rooms/${(await call("GET", "/api/v1/rooms", { token: agent.token })).json.data.items[0].room_id}/messages`, {
      token: agent.token,
      idempotencyKey: "claim-evidence-001",
      body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text: "제가 맡겠습니다. 계획은..." } }], idempotency_key: "claim-evidence-001" },
    });
    assert.equal(proposalMessage.status, 201);
    const evidenceMessageId = proposalMessage.json.data.message.message_id;

    for (const [state, expected] of steps.slice(0, 2)) {
      const response = await move(call, ownerToken, taskId, state, expected);
      assert.equal(response.status, 200, `transition to ${state}: ${response.text}`);
      revision = expected + 1;
    }
    const proposal = await call("POST", `/api/v1/tasks/${taskId}/claim-proposals`, {
      token: agent.token,
      idempotencyKey: "claim-proposal-001",
      body: { reason: "제가 맡겠습니다", evidence_message_ids: [evidenceMessageId] },
    });
    assert.equal(proposal.status, 201);
    assert.equal(proposal.json.data.state, "CLAIM_PROPOSED");

    const accepted = await call("POST", `/api/v1/tasks/${taskId}/claims/accept`, {
      token: ownerToken,
      idempotencyKey: "claim-accept-001",
      body: { proposal_event_id: proposal.json.data.proposal_event_id, evidence_message_ids: [evidenceMessageId] },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.data.owner_agent_id, agent.agentId);
    const attemptId = accepted.json.data.attempt_id;
    revision = 5; // create=1, SPECIFIED=2, OPEN_FOR_CLAIM=3, CLAIM_PROPOSED=4, CLAIM_ACCEPTED=5

    const toReady = await move(call, ownerToken, taskId, "READY", revision);
    assert.equal(toReady.status, 200);
    revision += 1;
    const toLeased = await move(call, ownerToken, taskId, "LEASED", revision);
    assert.equal(toLeased.status, 200);
    revision += 1;

    const wrongFencing = await move(call, agent.token, taskId, "RUNNING", revision, { attempt_id: attemptId, fencing_generation: 9 });
    assert.equal(wrongFencing.status, 409);
    assert.equal(wrongFencing.json.error.details.reason_code, "TASK_LEASE_NOT_HELD");

    const toRunning = await move(call, agent.token, taskId, "RUNNING", revision, { attempt_id: attemptId, fencing_generation: 1 });
    assert.equal(toRunning.status, 200);
    revision += 1;
    const toVerifying = await move(call, agent.token, taskId, "VERIFYING", revision, { attempt_id: attemptId, fencing_generation: 1 });
    assert.equal(toVerifying.status, 200);
    revision += 1;

    const prematureDone = await move(call, ownerToken, taskId, "DONE", revision);
    assert.equal(prematureDone.status, 412);
    assert.equal(prematureDone.json.error.code, "TEST_NOT_RUN");
    assert.equal(prematureDone.json.error.details.reason_code, "TASK_DONE_REQUIRES_EVIDENCE");

    const pendingEvidence = await call("POST", `/api/v1/tasks/${taskId}/evidence`, {
      token: ownerToken,
      body: { evidence_kind: "test_run", ref_id: "ci_1", verification_state: "pending" },
    });
    assert.equal(pendingEvidence.status, 201);
    const stillBlocked = await move(call, ownerToken, taskId, "DONE", revision);
    assert.equal(stillBlocked.status, 412, "pending evidence is not verified evidence");

    const verified = await call("POST", `/api/v1/tasks/${taskId}/evidence`, {
      token: ownerToken,
      body: { evidence_kind: "test_run", ref_id: "ci_1", verification_state: "verified", sha256: "a".repeat(64) },
    });
    assert.equal(verified.status, 201);
    const done = await move(call, ownerToken, taskId, "DONE", revision, { evidence_ids: [verified.json.data.evidence_id] });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.data.state, "DONE");

    const illegal = await move(call, ownerToken, taskId, "RUNNING", revision + 1);
    assert.equal(illegal.status, 409);
    assert.equal(illegal.json.error.details.reason_code, "TASK_TRANSITION_NOT_ALLOWED");
  } finally {
    close();
  }
});

test("an AI cannot accept its own claim proposal and a non-author cannot propose", async () => {
  const { call, ownerToken, registerAgent, createProject, roomId, close } = await setup();
  try {
    const a = await registerAgent("피클");
    const b = await registerAgent("키링");
    const projectId = await createProject("PROJECT AI ROOM", [a.agentId, b.agentId]);
    const task = await call("POST", `/api/v1/projects/${projectId}/tasks`, { token: ownerToken, body: { title: "분업 테스트", risk_level: "medium" } });
    const taskId = task.json.data.task_id;
    await move(call, ownerToken, taskId, "SPECIFIED", 1);
    await move(call, ownerToken, taskId, "OPEN_FOR_CLAIM", 2);

    const message = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: b.token,
      idempotencyKey: "claim-b-message-01",
      body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text: "제가 할 수 있습니다" } }], idempotency_key: "claim-b-message-01" },
    });
    const messageId = message.json.data.message.message_id;

    const notAuthor = await call("POST", `/api/v1/tasks/${taskId}/claim-proposals`, {
      token: a.token,
      idempotencyKey: "claim-a-proposal-01",
      body: { reason: "대신 제안", evidence_message_ids: [messageId] },
    });
    assert.equal(notAuthor.status, 400);

    const proposal = await call("POST", `/api/v1/tasks/${taskId}/claim-proposals`, {
      token: b.token,
      idempotencyKey: "claim-b-proposal-01",
      body: { reason: "제가 하겠습니다", evidence_message_ids: [messageId] },
    });
    assert.equal(proposal.status, 201);
    const selfAccept = await call("POST", `/api/v1/tasks/${taskId}/claims/accept`, {
      token: b.token,
      idempotencyKey: "claim-b-accept-01",
      body: { proposal_event_id: proposal.json.data.proposal_event_id, evidence_message_ids: [messageId] },
    });
    assert.equal(selfAccept.status, 403);
    assert.equal(selfAccept.json.error.details.reason_code, "SELF_ACCEPT_FORBIDDEN");
  } finally {
    close();
  }
});

test("handoff needs a valid checkpoint and fences the old attempt", async () => {
  const { call, ownerToken, registerAgent, createProject, roomId, close } = await setup();
  try {
    const a = await registerAgent("피클");
    const b = await registerAgent("VOOY");
    const projectId = await createProject("PROJECT AI ROOM", [a.agentId, b.agentId]);
    const task = await call("POST", `/api/v1/projects/${projectId}/tasks`, { token: ownerToken, body: { title: "인계 테스트", risk_level: "low" } });
    const taskId = task.json.data.task_id;
    await move(call, ownerToken, taskId, "SPECIFIED", 1);
    await move(call, ownerToken, taskId, "OPEN_FOR_CLAIM", 2);
    const message = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: a.token,
      idempotencyKey: "handoff-message-01",
      body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text: "시작합니다" } }], idempotency_key: "handoff-message-01" },
    });
    void message;
    const proposal = await call("POST", `/api/v1/tasks/${taskId}/claim-proposals`, {
      token: a.token,
      idempotencyKey: "handoff-proposal-01",
      body: { reason: "맡겠습니다", evidence_message_ids: [message.json.data.message.message_id] },
    });
    const accepted = await call("POST", `/api/v1/tasks/${taskId}/claims/accept`, {
      token: ownerToken,
      idempotencyKey: "handoff-accept-01",
      body: { proposal_event_id: proposal.json.data.proposal_event_id, evidence_message_ids: [message.json.data.message.message_id] },
    });
    const attemptId = accepted.json.data.attempt_id;

    const noCheckpoint = await call("POST", `/api/v1/tasks/${taskId}/handoff`, {
      token: ownerToken,
      body: { to_agent_id: b.agentId, reason: "장애" },
    });
    assert.equal(noCheckpoint.status, 409);
    assert.equal(noCheckpoint.json.error.details.reason_code, "CHECKPOINT_REQUIRED");

    const checkpoint = await call("POST", `/api/v1/tasks/${taskId}/checkpoint`, {
      token: a.token,
      body: {
        attempt_id: attemptId,
        fencing_generation: 1,
        checkpoint: { base_commit_sha: "a".repeat(40), changed_files_manifest: ["src/x.ts"], executed_commands: ["npm test"], test_results: { suite: "unit", passed: 3, failed: 0 }, agent_messages_cursor: "12", retry_count: 0, lease_generation: 1 },
      },
    });
    assert.equal(checkpoint.status, 201, checkpoint.text);
    assert.equal(checkpoint.json.data.secrets_stored, false);

    const handoff = await call("POST", `/api/v1/tasks/${taskId}/handoff`, {
      token: ownerToken,
      body: { to_agent_id: b.agentId, checkpoint_id: checkpoint.json.data.checkpoint_id, reason: "장애 인계" },
    });
    assert.equal(handoff.status, 200, handoff.text);
    assert.equal(handoff.json.data.fencing_generation, 2);
    assert.equal(handoff.json.data.previous_attempt.status, "SUPERSEDED");
    const attempts = (await call("GET", `/api/v1/projects/${projectId}/tasks`, { token: ownerToken })).json.data.items[0];
    assert.equal(attempts.owner_agent_id, b.agentId);

    // The superseded AI can no longer complete work under its old generation.
    const lateResult = await call("POST", `/api/v1/tasks/${taskId}/checkpoint`, {
      token: a.token,
      body: { attempt_id: attemptId, fencing_generation: 1, checkpoint: { stale: true } },
    });
    assert.equal(lateResult.status, 409);
  } finally {
    close();
  }
});

test("memory layers are isolated and a share is revocable at the source", async () => {
  const { call, ownerToken, registerAgent, createProject, raw, close } = await setup();
  try {
    const a = await registerAgent("피클");
    const b = await registerAgent("키링");
    const projectA = await createProject("프로젝트 A", [a.agentId, b.agentId]);
    const projectB = await createProject("프로젝트 B", [b.agentId]);

    const privateMemory = await call("POST", `/api/v1/projects/${projectA}/memories`, {
      token: a.token,
      body: { scope: "agent_private", kind: "note", body: "나만 아는 개인 메모 사파이어", sources: [{ source_kind: "manual", source_id: "manual:1" }] },
    });
    assert.equal(privateMemory.status, 201, privateMemory.text);
    const privateId = privateMemory.json.data.memory.memory_id;

    const aList = await call("GET", `/api/v1/projects/${projectA}/memories`, { token: a.token });
    assert.ok(aList.json.data.items.some((item) => item.memory_id === privateId));
    const bList = await call("GET", `/api/v1/projects/${projectA}/memories`, { token: b.token });
    assert.equal(bList.json.data.items.some((item) => item.memory_id === privateId), false, "agent_private must not leak");

    const projectMemory = await call("POST", `/api/v1/projects/${projectA}/memories`, {
      token: ownerToken,
      body: { scope: "project", kind: "decision", body: "계약은 12월 1일 확정 사파이어", sources: [{ source_kind: "message", source_id: "msg_1", quote: "12월 1일" }] },
    });
    assert.equal(projectMemory.status, 201);
    const sharedId = projectMemory.json.data.memory.memory_id;

    const search = await call("POST", `/api/v1/projects/${projectA}/memories/search`, { token: b.token, body: { query: "사파이어" } });
    assert.equal(search.status, 200);
    assert.ok(search.json.data.items.some((item) => item.memory_id === sharedId));
    assert.equal(search.json.data.items.some((item) => item.memory_id === privateId), false);

    const noSource = await call("POST", `/api/v1/projects/${projectA}/memories`, {
      token: ownerToken,
      body: { scope: "project", kind: "fact", body: "출처 없는 사실", sources: [] },
    });
    assert.equal(noSource.status, 400);

    const share = await call("POST", `/api/v1/projects/${projectA}/shares`, {
      token: ownerToken,
      body: { memory_id: sharedId, target_project_id: projectB, note: "B에서 참고" },
    });
    assert.equal(share.status, 201, share.text);
    assert.equal(share.json.data.pinned_revision, 1);

    // The shared reference is readable in B while the source exists...
    const bProjectB = await call("GET", `/api/v1/projects/${projectB}/memories`, { token: b.token });
    assert.ok(bProjectB.json.data.items.some((item) => item.memory_id === sharedId), "share must be visible to the target project");

    // ...and stops resolving when the source is gone (it is a reference, not a copy).
    const deleted = await call("DELETE", `/api/v1/memories/${sharedId}`, { token: ownerToken });
    assert.equal(deleted.status, 200, deleted.text);
    const afterDelete = await call("POST", `/api/v1/projects/${projectA}/memories/search`, { token: ownerToken, body: { query: "사파이어" } });
    assert.equal(afterDelete.json.data.items.length, 0, "deleted memory must leave the FTS index");
    const tombstone = raw.prepare("SELECT * FROM search_tombstones WHERE target_kind = 'memory' AND target_id = ?").get(sharedId);
    assert.ok(tombstone !== undefined && tombstone !== null, "deletion must write a search tombstone");
  } finally {
    close();
  }
});

test("dashboard reports 50 metrics with measured/estimated/unavailable sources", async () => {
  const { call, ownerToken, createProject, close } = await setup();
  try {
    const projectId = await createProject();
    await call("POST", `/api/v1/projects/${projectId}/tasks`, { token: ownerToken, body: { title: "지표 테스트" } });
    const dashboard = await call("GET", `/api/v1/projects/${projectId}/dashboard`, { token: ownerToken });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.json.data.metrics.length, 50);
    assert.deepEqual(dashboard.json.data.metrics.map((metric) => metric.id), Array.from({ length: 50 }, (_, index) => `M-${String(index + 1).padStart(2, "0")}`));
    const measured = dashboard.json.data.metrics.filter((metric) => metric.source === "measured");
    assert.ok(measured.length >= 15, `expected at least 15 measured metrics, got ${measured.length}`);
    const tasksTotal = dashboard.json.data.metrics.find((metric) => metric.key === "tasks_total");
    assert.equal(tasksTotal.value, 1);
    assert.equal(tasksTotal.source, "measured");
    const r2 = dashboard.json.data.metrics.find((metric) => metric.key === "storage_r2_bytes");
    assert.equal(r2.source, "unavailable", "R2 storage is a platform observation we cannot make from D1");
    assert.equal(r2.value, null);
    const coverage = dashboard.json.data.metrics.find((metric) => metric.key === "coverage_pct");
    assert.equal(coverage.source, "unavailable");
    assert.equal(coverage.value, null);
    assert.equal(dashboard.json.data.metrics_summary.total, 50);
  } finally {
    close();
  }
});

test("a task dependency must exist in the same project", async () => {
  const { call, ownerToken, createProject, close } = await setup();
  try {
    const projectId = await createProject();
    const other = await createProject("다른 프로젝트");
    const first = await call("POST", `/api/v1/projects/${projectId}/tasks`, { token: ownerToken, body: { title: "선행" } });
    const foreign = await call("POST", `/api/v1/projects/${other}/tasks`, { token: ownerToken, body: { title: "남의 작업" } });
    const bad = await call("POST", `/api/v1/projects/${projectId}/tasks`, {
      token: ownerToken,
      body: { title: "후행", dependencies: [foreign.json.data.task_id] },
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.error.details.foreign_project, [foreign.json.data.task_id]);
    const unknown = await call("POST", `/api/v1/projects/${projectId}/tasks`, {
      token: ownerToken,
      body: { title: "후행2", dependencies: ["task_AAAAAAAAAAAAAAAAAAAAAAAAAA"] },
    });
    assert.equal(unknown.status, 400);
    const good = await call("POST", `/api/v1/projects/${projectId}/tasks`, {
      token: ownerToken,
      body: { title: "후행3", dependencies: [first.json.data.task_id] },
    });
    assert.equal(good.status, 201);
  } finally {
    close();
  }
});

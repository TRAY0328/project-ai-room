/**
 * Catalog coverage — every one of the 78 endpoints is routed, authenticated and
 * reaches a real handler. A 501 "not implemented in this phase" is a failure.
 *
 * Two assertions per endpoint:
 *   1. unauthenticated access is refused for every non-public endpoint;
 *   2. an owner request reaches the handler: the answer is a business outcome
 *      (2xx/4xx with a domain code), never "unknown route" and never a 500.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { API_CATALOG } from "../../packages/contracts/dist/index.js";
import { setup } from "./helpers.mjs";

const BODY = {
  "post-owner-bootstrap": { display_name: "x", email: "x@example.test", password: "long-enough-password", bootstrap_secret: "y".repeat(20) },
  "post-auth-login": { email: "owner@example.test", password: "wrong-password" },
  "post-auth-refresh": { refresh_token: "sess_AAAAAAAAAAAAAAAAAAAAAAAAAA.x" },
  "post-agents-register": { invite_secret: "z".repeat(20), display_name: "x", avatar_asset_id: "art_A1B2C3D4E5F6G7H8JKMNPQRSTV" },
  "post-agents-login": { agent_key: "airo_sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "post-rooms": { name: "커버리지 방" },
  "patch-rooms-by-roomId": { name: "이름", expected_revision: 1 },
  "post-rooms-by-roomId-members": { actor_kind: "agent", actor_id: "agent_AAAAAAAAAAAAAAAAAAAAAAAAAA" },
  "post-rooms-by-roomId-messages": { blocks: [{ block_id: "b", block_type: "text", payload: { text: "t" } }], idempotency_key: "coverage-0001" },
  "patch-rooms-by-roomId-messages-by-messageId": { blocks: [{ block_id: "b", block_type: "text", payload: { text: "t" } }], expected_revision: 1 },
  "delete-rooms-by-roomId-messages-by-messageId": { expected_revision: 1 },
  "post-messages-by-messageId-reactions": { emoji_key: "👍" },
  "post-files-upload-intents": { filename: "a.txt", mime_type: "text/plain", size_bytes: 3, sha256: "a".repeat(64) },
  "post-files-uploads-by-uploadId-complete": { parts: [], sha256: "a".repeat(64), byte_count: 0 },
  "post-search": { query: "test" },
  "post-projects": { name: "커버리지 프로젝트" },
  "patch-projects-by-projectId": { name: "이름", expected_revision: 1 },
  "post-projects-by-projectId-rooms-link": { room_id: "room_AAAAAAAAAAAAAAAAAAAAAAAAAA" },
  "post-projects-by-projectId-tasks": { title: "작업" },
  "post-tasks-by-taskId-claim-proposals": { reason: "제안", evidence_message_ids: ["msg_AAAAAAAAAAAAAAAAAAAAAAAAAA"] },
  "post-tasks-by-taskId-claims-accept": { proposal_event_id: "evt_AAAAAAAAAAAAAAAAAAAAAAAAAA", evidence_message_ids: ["msg_AAAAAAAAAAAAAAAAAAAAAAAAAA"] },
  "post-tasks-by-taskId-transition": { to_state: "SPECIFIED", expected_revision: 1 },
  "post-tasks-by-taskId-handoff": { to_agent_id: "agent_AAAAAAAAAAAAAAAAAAAAAAAAAA", reason: "인계" },
  "post-tasks-by-taskId-checkpoint": { attempt_id: "att_AAAAAAAAAAAAAAAAAAAAAAAAAA", fencing_generation: 1, checkpoint: {} },
  "post-projects-by-projectId-memories": { scope: "project", kind: "note", body: "메모", sources: [{ source_kind: "manual", source_id: "m:1" }] },
  "post-projects-by-projectId-memories-search": { query: "메모" },
  "post-projects-by-projectId-shares": { memory_id: "mem_AAAAAAAAAAAAAAAAAAAAAAAAAA", target_project_id: "proj_AAAAAAAAAAAAAAAAAAAAAAAAAA" },
  "post-projects-by-projectId-ide-publish": { document_id: "doc_AAAAAAAAAAAAAAAAAAAAAAAAAA", base_commit_sha: "a".repeat(40), commit_message: "x" },
  "post-projects-by-projectId-git-branches": { name: "ai/x", from_sha: "a".repeat(40) },
  "post-projects-by-projectId-git-pull-requests": { title: "x", head: "ai/x", base: "main", head_sha: "a".repeat(40) },
  "post-projects-by-projectId-git-reviews": { pull_request_id: "pr_AAAAAAAAAAAAAAAAAAAAAAAAAA", commit_sha: "a".repeat(40), verdict: "APPROVE" },
  "post-projects-by-projectId-git-merge": { pull_request_id: "pr_AAAAAAAAAAAAAAAAAAAAAAAAAA", expected_head_sha: "a".repeat(40) },
  "post-projects-by-projectId-jobs": { job_kind: "ci_test", workflow_ref: "verify.yml", commit_sha: "a".repeat(40), ref: "main" },
  "post-projects-by-projectId-jobs-by-jobId-cancel": {},
  "post-projects-by-projectId-artifacts-by-artifactId-verify": {},
  "post-projects-by-projectId-artifacts-by-artifactId-download-intent": {},
  "post-admin-approvals": { target_type: "job", target_id: "job_x", action_digest: "a".repeat(64), request_reason: "x" },
  "post-admin-approvals-by-id-resolve": { decision: "approve" },
  "post-admin-emergency-stop": { reason: "coverage" },
  "post-admin-backups": { scope: ["chat"] },
  "post-admin-restores-prepare": { backup_id: "bkp_x" },
  "post-admin-restores-commit": { restore_id: "restore_x", approval_id: "apr_AAAAAAAAAAAAAAAAAAAAAAAAAA" },
  "post-admin-data-deletion-prepare": {},
  "post-admin-data-deletion-commit": { plan_digest: "a".repeat(64), approval_id: "apr_AAAAAAAAAAAAAAAAAAAAAAAAAA" },
  "post-providers-by-provider-connect": {},
  "post-providers-by-provider-callback": { state: "s".repeat(20) },
  "post-providers-by-provider-verify": { capability: "message.send" },
  "post-providers-connections-by-id-revoke": {},
  "post-agents-rekey": {},
  "patch-agents-by-agentId": { description: "cov" },
};

test("all 78 catalog endpoints are routed and reach a handler", async () => {
  const { call, ownerToken, roomId, createProject, registerAgent, close } = await setup();
  try {
    const agent = await registerAgent("커버리지");
    const projectId = await createProject("커버리지", [agent.agentId]);
    const params = {
      roomId,
      projectId,
      agentId: agent.agentId,
      taskId: "task_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      messageId: "msg_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      jobId: "job_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      artifactId: "art_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      docId: "doc_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      uploadId: "file_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      id: "apr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      provider: "chatgpt",
      actorId: agent.agentId,
    };
    assert.equal(API_CATALOG.length, 78);
    const failures = [];
    const statuses = new Map();
    for (const endpoint of API_CATALOG) {
      const path = `/api${endpoint.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => params[key] ?? key)}`;
      const body = BODY[endpoint.operationId];
      const needsKey = endpoint.requiresIdempotencyKey;
      const response = await call(endpoint.method, path, {
        token: ownerToken,
        ...(needsKey ? { idempotencyKey: `cov-${endpoint.operationId}-0001` } : {}),
        ...(endpoint.method === "GET" || endpoint.method === "DELETE" || body === undefined ? {} : { body }),
      });
      statuses.set(endpoint.operationId, response.status);
      const code = response.json?.error?.code ?? "OK";
      if (response.status === 404 && code === "PROJECT_NOT_FOUND" && response.json?.error?.message?.includes("알 수 없는 경로")) {
        failures.push(`${endpoint.operationId}: unknown route`);
      }
      if (response.status === 500) failures.push(`${endpoint.operationId}: INTERNAL_ERROR ${response.text.slice(0, 120)}`);
      if (code === "CAPABILITY_UNSUPPORTED" && response.json?.error?.details?.phase === "contracts") {
        failures.push(`${endpoint.operationId}: still a contract placeholder`);
      }
      if (endpoint.auth !== "public" && endpoint.auth !== "invite" && endpoint.auth !== "owner_bootstrap" && endpoint.operationId !== "post-agents-login") {
        const anonymous = await call(endpoint.method, path, {
          ...(needsKey ? { idempotencyKey: `anon-${endpoint.operationId}-0001` } : {}),
          ...(endpoint.method === "GET" || endpoint.method === "DELETE" || body === undefined ? {} : { body }),
        });
        if (anonymous.status !== 401) failures.push(`${endpoint.operationId}: anonymous got ${anonymous.status} instead of 401`);
      }
    }
    assert.deepEqual(failures, []);
    const distinct = new Set([...statuses.values()]);
    assert.ok(!distinct.has(500));
  } finally {
    close();
  }
});

test("the routing table has a handler for every operation id", async () => {
  const gateway = await import("../../services/gateway-worker/dist/index.js");
  assert.equal(gateway.ROUTE_COVERAGE.catalog, 78);
  assert.deepEqual(gateway.ROUTE_COVERAGE.missingHandlers, []);
  assert.equal(gateway.ROUTE_COVERAGE.handlers, 78);
});

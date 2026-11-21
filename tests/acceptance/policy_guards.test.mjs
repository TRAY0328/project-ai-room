/**
 * Acceptance tests — policy guards that exist in shared packages
 * (path/zip containment, CI workflow triggers, merge policy, log redaction,
 * message rendering safety, memory provenance and ACL).
 *
 * Each guard is called exactly as a service handler would call it. What is NOT
 * proven here is the HTTP wiring: that is recorded as PARTIAL in the QA matrix,
 * not as a pass.
 */
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createTestDb, seedBase, T0 } from "../../packages/testing/index.mjs";
import {
  checkRelativePath,
  inspectZipEntries,
  evaluateMergePolicy,
  redactSecrets,
  workflowTriggerIsSafe,
  verifyArtifactHash,
} from "@ai-room/git";
import { safeUrl, sanitizeHtml } from "@ai-room/message-blocks";
import { MemoryService } from "@ai-room/memory";
import { ApiError } from "@ai-room/contracts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OWNER = { kind: "owner", id: "owner_A1B2C3D4E5F6G7H8JKMNPQRS", platformAdmin: true, ownerId: "owner_A1B2C3D4E5F6G7H8JKMNPQRS" };
const AGENT = { kind: "agent", id: "agent_A1B2C3D4E5F6G7H8JKMNPQRS", platformAdmin: false, agentId: "agent_A1B2C3D4E5F6G7H8JKMNPQRS", verificationState: "self_declared" };

function seedAgent(raw, agentId, name = "피클") {
  raw.prepare(`INSERT INTO agents (agent_id, display_name, avatar_asset_id, created_at, updated_at)
               VALUES (?,?,?,?,?)`).run(agentId, name, "art_0123456789ABCDEFGHJKMNPQRS", T0, T0);
}

// ---------------------------------------------------------------------------
test("QA-038 ZIP 경로 탈출·압축 폭탄: 차단/격리", () => {
  assert.equal(checkRelativePath("../../etc/passwd").ok, false);
  assert.equal(checkRelativePath("/etc/passwd").ok, false);
  assert.equal(checkRelativePath("a/../../b").ok, false);
  assert.equal(checkRelativePath("src/./app.ts").ok, true);
  assert.equal(checkRelativePath("src/./app.ts").normalised, "src/app.ts");

  const slip = inspectZipEntries([{ path: "../escape.sh", compressedBytes: 10, uncompressedBytes: 20 }]);
  assert.equal(slip.ok, false);
  assert.ok(slip.blockers.includes("ZIP_SLIP"));

  const bomb = inspectZipEntries([{ path: "a.txt", compressedBytes: 1, uncompressedBytes: 1024 * 1024 * 1024 }]);
  assert.equal(bomb.ok, false);
  assert.ok(bomb.blockers.includes("RATIO_LIMIT") || bomb.blockers.includes("SIZE_LIMIT"));

  const clean = inspectZipEntries([
    { path: "src/index.ts", compressedBytes: 100, uncompressedBytes: 300 },
    { path: "README.md", compressedBytes: 50, uncompressedBytes: 120 },
  ]);
  assert.equal(clean.ok, true);
});

test("QA-075 untrusted PR CI: pull_request_target·workflow_run 트리거 금지", () => {
  const dangerous = "name: ci\non:\n  pull_request_target:\n    types: [opened]\njobs:\n  build:\n    runs-on: ubuntu-latest\n";
  const verdict = workflowTriggerIsSafe(dangerous);
  assert.equal(verdict.safe, false);
  assert.deepEqual(verdict.found, ["pull_request_target"]);

  const dangerous2 = "on:\n  workflow_run:\n    workflows: [build]\n";
  assert.deepEqual(workflowTriggerIsSafe(dangerous2).found, ["workflow_run"]);

  const safe = "name: verify\non:\n  pull_request:\n  push:\n    branches: [main]\n";
  assert.equal(workflowTriggerIsSafe(safe).safe, true);
});

test("QA-080 병합 조건: 테스트 실패·head SHA 불일치는 병합 차단", () => {
  const base = {
    pullRequestState: "OPEN",
    reviewedSha: HEAD,
    headSha: HEAD,
    baseSha: BASE,
    requiredChecks: [{ name: "verify", conclusion: "success", headSha: HEAD }],
    approvals: [],
    nowMs: Date.parse(T0),
  };
  const ok = evaluateMergePolicy(base);
  assert.equal(ok.allowed, true, `unexpected blockers: ${JSON.stringify(ok.blocking)}`);

  const failed = evaluateMergePolicy({ ...base, requiredChecks: [{ name: "verify", conclusion: "failure", headSha: HEAD }] });
  assert.equal(failed.allowed, false);
  assert.ok(failed.blocking.some((check) => check.error_code === "CI_FAILED"));

  const moved = evaluateMergePolicy({ ...base, reviewedSha: "c".repeat(40) });
  assert.equal(moved.allowed, false);
  assert.ok(moved.blocking.some((check) => check.id === "REVIEW_AT_HEAD"));

  const notRun = evaluateMergePolicy({ ...base, requiredChecks: [{ name: "verify", conclusion: null, headSha: HEAD }] });
  assert.equal(notRun.allowed, false);
  assert.ok(notRun.blocking.some((check) => check.error_code === "TEST_NOT_RUN"));

  // An approval bound to an older commit cannot merge a moved head.
  const staleApproval = evaluateMergePolicy({
    ...base,
    headSha: "d".repeat(40),
    reviewedSha: "d".repeat(40),
    requiredChecks: [{ name: "verify", conclusion: "success", headSha: "d".repeat(40) }],
    approvals: [{ state: "APPROVED", boundCommitSha: HEAD, diffSha: null, actionDigest: "x", expectedDigest: "x", expiresAt: "2099-01-01T00:00:00.000Z" }],
  });
  assert.equal(staleApproval.allowed, false);
});

test("QA-082 로그 secret 마스킹: 토큰 패턴 원문 노출 없음", () => {
  const line = `GET /repo Authorization: Bearer ${"z".repeat(30)} key=ghp_${"A".repeat(24)} openai=sk-${"B".repeat(30)}`;
  const { text, redacted } = redactSecrets(line);
  assert.ok(redacted.includes("github_token"));
  assert.ok(redacted.includes("openai_key"));
  assert.ok(!text.includes(`ghp_${"A".repeat(24)}`));
  assert.ok(!text.includes(`sk-${"B".repeat(30)}`));
  assert.ok(text.includes("[REDACTED"));
  assert.deepEqual(redactSecrets("평범한 로그 한 줄").redacted, []);
});

test("QA-029 Markdown/HTML 스크립트: 실행 경로 없이 텍스트로만 남는다", () => {
  const html = '<p>안녕</p><script>alert(1)</script><img src=x onerror="alert(2)"><b onclick="steal()">굵게</b>';
  const result = sanitizeHtml(html);
  const serialized = JSON.stringify(result.node);
  assert.ok(!/<script/i.test(serialized), "script element must not survive");
  assert.ok(!/alert\(/.test(serialized), "script payload must not survive");
  assert.ok(!/onerror|onclick/i.test(serialized), "event handler attributes must not survive");
  assert.ok(result.removed.includes("script"));
  assert.ok(result.kept.includes("p") || serialized.includes("안녕"));

  const plain = sanitizeHtml("<p>hello</p>");
  assert.equal(JSON.stringify(plain.node).includes("script"), false);
});

test("QA-030 외부 이미지·위험 링크: 원격 로드는 정책상 기본 차단", () => {
  const tracker = safeUrl("https://tracker.example/pixel.gif");
  assert.equal(tracker.ok, true, "an https URL itself is allowed; loading policy is separate");

  const img = sanitizeHtml('<p>사진<img src="https://tracker.example/pixel.gif" alt="x"></p>', { allowRemoteImages: false });
  assert.ok(!JSON.stringify(img.node).includes("tracker.example"), "remote image must not be fetched by default");

  const allowed = sanitizeHtml('<p>사진<img src="https://cdn.example/a.png" alt="x"></p>', { allowRemoteImages: true });
  assert.ok(JSON.stringify(allowed.node).includes("cdn.example"));

  for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "//evil.example/x", "java\u0000script:alert(1)"]) {
    assert.equal(safeUrl(bad).ok, false, `${bad} must be rejected`);
  }
  assert.equal(safeUrl("/v1/rooms").ok, true);
  assert.equal(safeUrl("mailto:a@b.co").ok, true);
});

test("QA-084 산출물 해시: 저장된 SHA와 다르면 검증 실패", async () => {
  const payload = "web-build-artifact-bytes";
  const expected = createHash("sha256").update(payload).digest("hex");
  const good = await verifyArtifactHash(expected, payload);
  assert.equal(good.matches, true);

  const mismatch = await verifyArtifactHash("0".repeat(64), payload);
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.error_code, "ARTIFACT_NOT_VERIFIED");
});

test("보안 S17 SQL 인젝션: 값은 바인딩되어 리터럴로 저장된다", async () => {
  const { raw, close } = await createTestDb();
  try {
    seedBase(raw);
    const hostile = "'; DROP TABLE messages; --";
    raw.prepare(`INSERT INTO messages (message_id, room_id, author_kind, author_id, room_seq, created_at)
                 VALUES (?,?,?,?,?,?)`).run("msg_0123456789ABCDEFGHJKMNPQRS", "room_A1B2C3D4E5F6G7H8JKMNPQRS", "owner", OWNER.id, 1, T0);
    raw.prepare(`INSERT INTO message_versions (message_id, revision, blocks_json, body_plain_text, content_sha256, editor_kind, editor_id, created_at)
                 VALUES (?,?,?,?,?,?,?,?)`).run("msg_0123456789ABCDEFGHJKMNPQRS", 1, "[]", hostile, "a".repeat(64), "owner", OWNER.id, T0);

    const stored = raw.prepare("SELECT body_plain_text FROM message_versions WHERE message_id = ?").get("msg_0123456789ABCDEFGHJKMNPQRS");
    assert.equal(stored.body_plain_text, hostile, "the payload must be stored as text, not executed");
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").all();
    assert.equal(tables.length, 1, "messages table must still exist");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1);
  } finally {
    close();
  }
});

test("QA-043 기억: 출처 없는 기록은 거부, 출처는 provenance로 저장", async () => {
  const { db, raw, close } = await createTestDb();
  try {
    seedBase(raw);
    seedAgent(raw, AGENT.id);
    const memory = new MemoryService(db);
    const access = { subject: AGENT, roomIds: [], projectIds: [] };

    await assert.rejects(
      memory.create({
        subject: AGENT, access, scope: "agent_private", scopeId: AGENT.id, projectId: null,
        kind: "fact", body: "D1은 SQLite 기반이다", sources: [], requestId: "req_0123456789ABCDEFGHJKMNPQRS",
      }),
      (error) => error instanceof ApiError && error.code === "VALIDATION_FAILED",
    );

    const record = await memory.create({
      subject: AGENT, access, scope: "agent_private", scopeId: AGENT.id, projectId: null,
      kind: "fact", body: "D1은 SQLite 기반이다",
      sources: [{ source_kind: "message", source_id: "msg_0123456789ABCDEFGHJKMNPQRS", quote: "SQLite 기반" }],
      requestId: "req_0123456789ABCDEFGHJKMNPQRS",
    });
    assert.equal(record.trust_state, "unverified", "a single source is not 'corroborated'");
    const provenance = raw.prepare("SELECT source_kind, source_id FROM memory_provenance WHERE memory_id = ?").all(record.memory_id);
    assert.deepEqual(provenance.map((row) => row.source_kind), ["message"]);
  } finally {
    close();
  }
});

test("QA-045 공유 기억: 다른 프로젝트에서도 ACL 유지한 채 조회된다", async () => {
  const { db, raw, close } = await createTestDb();
  try {
    seedBase(raw);
    seedAgent(raw, AGENT.id);
    const memory = new MemoryService(db);
    const ownerAccess = { subject: OWNER, roomIds: [], projectIds: [] };
    const projectId = "proj_A1B2C3D4E5F6G7H8JKMNPQRS";
    const otherProject = "proj_B1B2C3D4E5F6G7H8JKMNPQRS";
    raw.prepare("INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?,?,?,?)").run(projectId, "AI ROOM", T0, T0);
    raw.prepare("INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?,?,?,?)").run(otherProject, "other", T0, T0);

    const shared = await memory.create({
      subject: OWNER, access: ownerAccess, scope: "shared", scopeId: "owner_A1B2C3D4E5F6G7H8JKMNPQRS", projectId: null,
      kind: "decision", body: "공유 결정: 배포는 수동 승인", sources: [{ source_kind: "manual", source_id: "owner" }],
      requestId: "req_0123456789ABCDEFGHJKMNPQRS",
    });
    const agentView = await memory.list({ access: { subject: AGENT, roomIds: [], projectIds: [otherProject] }, projectId: otherProject, limit: 10 });
    assert.deepEqual(agentView.items.map((item) => item.memory_id), [shared.memory_id]);
    assert.equal(agentView.items[0].memory_scope, "shared");
  } finally {
    close();
  }
});

test("QA-046 공유 범위 밖 기억: 프로젝트 기억은 비멤버에게 보이지 않는다", async () => {
  const { db, raw, close } = await createTestDb();
  try {
    seedBase(raw);
    seedAgent(raw, AGENT.id);
    const memory = new MemoryService(db);
    const projectId = "proj_A1B2C3D4E5F6G7H8JKMNPQRS";
    const otherProject = "proj_B1B2C3D4E5F6G7H8JKMNPQRS";
    raw.prepare("INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?,?,?,?)").run(projectId, "AI ROOM", T0, T0);
    raw.prepare("INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?,?,?,?)").run(otherProject, "other", T0, T0);

    const secret = await memory.create({
      subject: OWNER, access: { subject: OWNER, roomIds: [], projectIds: [] }, scope: "project", scopeId: projectId, projectId,
      kind: "note", body: "A 프로젝트만의 비공개 기억", sources: [{ source_kind: "manual", source_id: "owner" }],
      requestId: "req_0123456789ABCDEFGHJKMNPQRS",
    });

    const outsider = await memory.list({ access: { subject: AGENT, roomIds: [], projectIds: [otherProject] }, projectId: otherProject, limit: 10 });
    assert.equal(outsider.items.some((item) => item.memory_id === secret.memory_id), false);

    const member = await memory.list({ access: { subject: AGENT, roomIds: [], projectIds: [projectId] }, projectId, limit: 10 });
    assert.equal(member.items.some((item) => item.memory_id === secret.memory_id), true);

    // Writing into someone else's project is refused outright.
    await assert.rejects(
      memory.create({
        subject: AGENT, access: { subject: AGENT, roomIds: [], projectIds: [otherProject] }, scope: "project", scopeId: projectId, projectId,
        kind: "note", body: "침입 시도", sources: [{ source_kind: "manual", source_id: "agent" }],
        requestId: "req_0123456789ABCDEFGHJKMNPQRS",
      }),
      (error) => error instanceof ApiError && error.code === "PERMISSION_DENIED",
    );
  } finally {
    close();
  }
});

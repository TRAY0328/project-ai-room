/**
 * D1 schema integration tests — real SQLite, real migration file, real triggers.
 *
 * Every test opens a fresh database, applies db/migrations/0001_initial.sql and
 * then tries to break an invariant. A test that only shows the happy path is
 * worthless here: the point is that the database refuses the wrong write.
 *
 * Run: npm run test:db   (node --test tests/integration)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = join(repoRoot, "db/migrations");
const T = "2026-11-21T00:00:00.000Z";
const SHA = "a".repeat(64);

async function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) db.exec(await readFile(join(migrationsDir, file), "utf8"));
  return db;
}

function seed(db) {
  db.prepare("INSERT INTO owners (owner_id, display_name, created_at, updated_at) VALUES (?,?,?,?)")
    .run("owner_1", "천예준", T, T);
  db.prepare(`INSERT INTO agents (agent_id, display_name, avatar_asset_id, claimed_provider, created_at, updated_at)
              VALUES (?,?,?,?,?,?)`).run("agent_1", "피클", "file_avatar", "pickle", T, T);
  db.prepare(`INSERT INTO rooms (room_id, room_type, name, created_by, created_at, updated_at)
              VALUES (?,?,?,?,?,?)`).run("room_main", "main", "AI ROOM", "owner_1", T, T);
  db.prepare(`INSERT INTO projects (project_id, name, created_at, updated_at) VALUES (?,?,?,?)`)
    .run("proj_1", "PROJECT AI ROOM", T, T);
  db.prepare(`INSERT INTO tasks (task_id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run("task_1", "proj_1", "계약 확정", T, T);
  db.prepare(`INSERT INTO messages (message_id, room_id, author_kind, author_id, room_seq, created_at)
              VALUES (?,?,?,?,?,?)`).run("msg_1", "room_main", "agent", "agent_1", 1, T);
  db.prepare(`INSERT INTO message_versions (message_id, revision, blocks_json, body_plain_text, content_sha256, editor_kind, editor_id, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run("msg_1", 1, JSON.stringify([{ type: "text", text: "hello d1 migration" }]), "hello d1 migration", SHA, "agent", "agent_1", T);
}

// ---------------------------------------------------------------------------
test("migration applies cleanly and covers every table named in spec 05.2", async () => {
  const db = await freshDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const required = [
    "owners", "agents", "agent_profiles", "agent_credentials", "agent_invites", "auth_sessions",
    "provider_connections", "capability_proofs", "project_acl", "room_acl", "approvals", "audit_events",
    "rooms", "room_members", "messages", "message_versions", "message_blocks", "message_reactions",
    "message_receipts", "message_mentions", "message_tombstones", "delivery_outbox", "delivery_ack",
    "projects", "project_room_links", "tasks", "task_dependencies", "task_attempts", "task_evidence",
    "task_checkpoints", "project_events", "project_metrics", "project_reports",
    "documents", "document_snapshots", "document_update_refs", "file_operations", "git_repositories",
    "git_revisions", "git_pull_requests", "merge_requests", "code_reviews", "review_comments",
    "jobs", "job_attempts", "job_leases", "job_checkpoints", "github_installations", "github_webhooks",
    "ci_runs", "test_runs", "execution_evidence",
    "memory_records", "memory_provenance", "memory_links", "memory_permissions",
    "search_index_tasks", "search_tombstones",
    "files", "file_versions", "file_links", "artifacts", "artifact_manifests", "artifact_files",
    "artifact_verifications", "download_events", "retention_policies", "backup_manifests", "restore_runs",
    "provider_usage", "quota_policies", "rate_limit_events", "alert_rules", "alerts", "notifications",
    "feature_capabilities", "security_events", "schema_migrations",
  ];
  const missing = required.filter((table) => !names.includes(table));
  assert.deepEqual(missing, [], `missing tables: ${missing.join(", ")}`);
  const fts = db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%USING fts5%'").all().map((r) => r.name);
  assert.ok(fts.includes("memory_fts") && fts.includes("message_fts"));
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  const row = db.prepare("SELECT version, checksum FROM schema_migrations").get();
  assert.equal(row.version, "0001_initial");
  assert.equal(row.checksum, "pending"); // filled by scripts/db-migrate.mjs
  db.close();
});

test("foreign keys are enforced on child rows", async () => {
  const db = await freshDb();
  seed(db);
  assert.throws(
    () => db.prepare(`INSERT INTO messages (message_id, room_id, author_kind, author_id, room_seq, created_at)
                      VALUES (?,?,?,?,?,?)`).run("msg_orphan", "room_missing", "agent", "agent_1", 9, T),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?,?,?)`)
      .run("task_1", "task_missing", T),
    /FOREIGN KEY constraint failed/,
  );
  db.close();
});

test("check constraints reject malformed rows, ids and timestamps", async () => {
  const db = await freshDb();
  seed(db);
  assert.throws(() => db.prepare(`INSERT INTO rooms (room_id, room_type, name, created_by, created_at, updated_at)
    VALUES ('room_x','group','x','owner_1',?,?)`).run(T, T), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO files (file_id, creator_kind, creator_id, filename, mime_declared, size_bytes, sha256, r2_key, storage_state, scan_state, created_at)
    VALUES ('file_1','owner','owner_1','a.txt','text/plain',-1,?, 'r2/a', 'ready','clean',?)`).run(SHA, T), /CHECK constraint failed/);
  // local offset timestamp is not a UTC ISO-ms value
  assert.throws(() => db.prepare(`INSERT INTO projects (project_id, name, created_at, updated_at) VALUES ('proj_x','x','2026-11-21T09:00:00+09:00',?)`).run(T), /CHECK constraint failed/);
  // second-precision timestamp also rejected
  assert.throws(() => db.prepare(`INSERT INTO projects (project_id, name, created_at, updated_at) VALUES ('proj_y','y','2026-11-21T00:00:00Z',?)`).run(T), /CHECK constraint failed/);
  // wrong-aggregate id
  assert.throws(() => db.prepare(`INSERT INTO messages (message_id, room_id, author_kind, author_id, room_seq, created_at)
    VALUES ('room_2','room_main','agent','agent_1',2,?)`).run(T), /CHECK constraint failed/);
  // a "ready" file must have been scanned clean
  assert.throws(() => db.prepare(`INSERT INTO files (file_id, creator_kind, creator_id, filename, mime_declared, size_bytes, sha256, r2_key, storage_state, scan_state, created_at)
    VALUES ('file_2','owner','owner_1','b.txt','text/plain',10,?,'r2/b','ready','pending',?)`).run(SHA, T), /CHECK constraint failed/);
  db.close();
});

test("room_seq is unique per room and one main room only", async () => {
  const db = await freshDb();
  seed(db);
  assert.throws(() => db.prepare(`INSERT INTO messages (message_id, room_id, author_kind, author_id, room_seq, created_at)
    VALUES ('msg_2','room_main','owner','owner_1',1,?)`).run(T), /UNIQUE constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO rooms (room_id, room_type, name, created_by, created_at, updated_at)
    VALUES ('room_other','main','second main','owner_1',?,?)`).run(T, T), /UNIQUE constraint failed/);
  // two different rooms may both start at seq 1
  db.prepare(`INSERT INTO rooms (room_id, room_type, name, created_by, created_at, updated_at)
    VALUES ('room_p','project','p','owner_1',?,?)`).run(T, T);
  db.prepare(`INSERT INTO messages (message_id, room_id, author_kind, author_id, room_seq, created_at)
    VALUES ('msg_3','room_p','owner','owner_1',1,?)`).run(T);
  db.close();
});

test("message author immutability, revision +1, no hard delete, version content immutable", async () => {
  const db = await freshDb();
  seed(db);
  assert.throws(() => db.prepare("UPDATE messages SET author_id='owner_1' WHERE message_id='msg_1'").run(), /MESSAGE_AUTHOR_IMMUTABLE/);
  assert.throws(() => db.prepare("UPDATE messages SET current_revision=3 WHERE message_id='msg_1'").run(), /MESSAGE_REVISION_MUST_INCREMENT/);
  db.prepare("UPDATE messages SET current_revision=2, updated_at=? WHERE message_id='msg_1'").run(T);
  assert.throws(() => db.prepare("DELETE FROM messages WHERE message_id='msg_1'").run(), /MESSAGE_SOFT_DELETE_ONLY/);
  db.prepare(`INSERT INTO message_versions (message_id, revision, blocks_json, body_plain_text, content_sha256, editor_kind, editor_id, created_at)
    VALUES ('msg_1',2,'[]','edited','b'||substr(?,2),'owner','owner_1',?)`).run(SHA, T);
  assert.throws(
    () => db.prepare("UPDATE message_versions SET body_plain_text='rewritten' WHERE message_id='msg_1' AND revision=2").run(),
    /MESSAGE_VERSION_IMMUTABLE/,
  );
  db.close();
});

test("task DONE requires verified evidence, and revisions must increment by one", async () => {
  const db = await freshDb();
  seed(db);
  assert.throws(() => db.prepare("UPDATE tasks SET state='DONE', revision=2 WHERE task_id='task_1'").run(), /TASK_DONE_REQUIRES_VERIFIED_EVIDENCE/);
  db.prepare("UPDATE tasks SET state='SPECIFIED', revision=2 WHERE task_id='task_1'").run();
  assert.throws(() => db.prepare("UPDATE tasks SET title='또 바꿈', revision=4 WHERE task_id='task_1'").run(), /TASK_REVISION_MUST_INCREMENT/);
  db.prepare(`INSERT INTO task_evidence (evidence_id, task_id, evidence_kind, ref_id, verification_state, verified_by_kind, verified_by_id, sha256, created_at)
    VALUES ('ci_1','task_1','ci_run','ci_run_1','verified','system','system',?,?)`).run(SHA, T);
  db.prepare("UPDATE tasks SET state='DONE', revision=3 WHERE task_id='task_1'").run();
  assert.equal(db.prepare("SELECT state FROM tasks WHERE task_id='task_1'").get().state, "DONE");
  // a pending (unverified) evidence row does not open DONE for another task
  db.prepare(`INSERT INTO tasks (task_id, project_id, title, state, revision, created_at, updated_at)
    VALUES ('task_2','proj_1','t2','VERIFYING',1,?,?)`).run(T, T);
  db.prepare(`INSERT INTO task_evidence (evidence_id, task_id, evidence_kind, ref_id, verification_state, created_at)
    VALUES ('ci_2','task_2','ci_run','ci_run_2','pending',?)`).run(T);
  assert.throws(() => db.prepare("UPDATE tasks SET state='DONE', revision=2 WHERE task_id='task_2'").run(), /TASK_DONE_REQUIRES_VERIFIED_EVIDENCE/);
  db.close();
});

test("artifact VERIFIED needs a verification row matching the stored hash", async () => {
  const db = await freshDb();
  seed(db);
  db.prepare(`INSERT INTO artifacts (artifact_id, project_id, artifact_type, version, sha256, size_bytes, r2_key, created_at)
    VALUES ('art_1','proj_1','android_apk','1.0.0',?,1000,'r2/apk',?)`).run(SHA, T);
  assert.throws(() => db.prepare("UPDATE artifacts SET verification_state='VERIFIED' WHERE artifact_id='art_1'").run(), /ARTIFACT_VERIFICATION_REQUIRED/);
  db.prepare(`INSERT INTO artifact_verifications (verification_id, artifact_id, computed_sha256, result, byte_count, verified_at, verifier_kind)
    VALUES ('v1','art_1',?,'verified',1000,?,'system')`).run(SHA, T);
  db.prepare("UPDATE artifacts SET verification_state='VERIFIED' WHERE artifact_id='art_1'").run();
  assert.equal(db.prepare("SELECT verification_state FROM artifacts WHERE artifact_id='art_1'").get().verification_state, "VERIFIED");
  // a mismatching hash cannot verify a different artifact
  db.prepare(`INSERT INTO artifacts (artifact_id, project_id, artifact_type, version, sha256, size_bytes, r2_key, created_at)
    VALUES ('art_2','proj_1','web','1.0.0',?,500,'r2/web',?)`).run("c".repeat(64), T);
  db.prepare(`INSERT INTO artifact_verifications (verification_id, artifact_id, computed_sha256, result, byte_count, verified_at, verifier_kind)
    VALUES ('v2','art_2',?,'verified',500,?,'system')`).run("d".repeat(64), T);
  assert.throws(() => db.prepare("UPDATE artifacts SET verification_state='VERIFIED' WHERE artifact_id='art_2'").run(), /ARTIFACT_VERIFICATION_REQUIRED/);
  db.close();
});

test("approvals: no late approval, material change invalidates and writes an audit event", async () => {
  const db = await freshDb();
  seed(db);
  db.prepare(`INSERT INTO approvals (approval_id, project_id, target_type, target_id, bound_commit_sha, action_digest, request_reason, state, requested_by_kind, requested_by_id, requested_at, expires_at)
    VALUES ('apr_1','proj_1','pull_request','42',?,?,'머지 승인 요청','PENDING','agent','agent_1',?,?)`)
    .run("e".repeat(40), SHA, T, "2026-11-21T01:00:00.000Z");
  // decided_at must exist for APPROVED and must be before expiry
  assert.throws(() => db.prepare("UPDATE approvals SET state='APPROVED' WHERE approval_id='apr_1'").run(), /CHECK constraint failed/);
  db.prepare("UPDATE approvals SET state='APPROVED', decided_at=?, decided_by_owner_id='owner_1' WHERE approval_id='apr_1'").run(T);
  // a late owner approval at/after expiry is refused
  db.prepare(`INSERT INTO approvals (approval_id, project_id, target_type, target_id, action_digest, request_reason, state, requested_by_kind, requested_by_id, requested_at, expires_at)
    VALUES ('apr_2','proj_1','job','job_1',?,'배포','PENDING','agent','agent_1',?,?)`).run(SHA, T, "2026-11-21T00:30:00.000Z");
  assert.throws(
    () => db.prepare("UPDATE approvals SET state='APPROVED', decided_at=?, decided_by_owner_id='owner_1' WHERE approval_id='apr_2'").run("2026-11-21T00:45:00.000Z"),
    /APPROVAL_EXPIRED/,
  );
  // changing the bound commit after approval invalidates it and is audited
  db.prepare("UPDATE approvals SET bound_commit_sha=? WHERE approval_id='apr_1'").run("f".repeat(40));
  assert.equal(db.prepare("SELECT state FROM approvals WHERE approval_id='apr_1'").get().state, "INVALIDATED");
  const audit = db.prepare("SELECT reason_code FROM audit_events WHERE target_id='apr_1'").all();
  assert.deepEqual(audit.map((r) => r.reason_code), ["APPROVAL_STALE"]);
  db.close();
});

test("capability proofs cannot be VERIFIED from a self-claim", async () => {
  const db = await freshDb();
  seed(db);
  db.prepare(`INSERT INTO provider_connections (connection_id, agent_id, provider_key, auth_method, updated_at)
    VALUES ('conn_1','agent_1','gemini','api_key',?)`).run(T);
  assert.throws(() => db.prepare(`INSERT INTO capability_proofs (proof_id, connection_id, capability, state, verified_at, attestation)
    VALUES ('p1','conn_1','message.send','verified',?,'self_declared')`).run(T), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO capability_proofs (proof_id, connection_id, capability, state, verified_at, attestation)
    VALUES ('p2','conn_1','message.send','verified',?,'provider_verified')`).run(T), /CHECK constraint failed/);
  db.prepare(`INSERT INTO capability_proofs (proof_id, connection_id, capability, state, provider_response_id, verified_at, attestation)
    VALUES ('p3','conn_1','message.send','verified','resp_123',?,'provider_verified')`).run(T);
  db.close();
});

test("memory FTS: search works, updates reindex, delete removes and tombstones", async () => {
  const db = await freshDb();
  seed(db);
  db.prepare(`INSERT INTO memory_records (memory_id, memory_scope, scope_id, project_id, memory_kind, body_text, source_json, created_at, updated_at)
    VALUES ('mem_1','project','proj_1','proj_1','decision','cloudflare d1 migration verification notes','[]',?,?)`).run(T, T);
  const hit = db.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH 'migration'").all();
  assert.deepEqual(hit.map((r) => r.memory_id), ["mem_1"]);
  db.prepare("UPDATE memory_records SET body_text='rewritten text about approvals', revision=2, updated_at=? WHERE memory_id='mem_1'").run(T);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'migration'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'approvals'").get().n, 1);
  db.prepare("UPDATE memory_records SET deleted_at=? WHERE memory_id='mem_1'").run(T);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts").get().n, 0);
  assert.equal(db.prepare("SELECT target_kind FROM search_tombstones WHERE target_id='mem_1'").get().target_kind, "memory");
  db.close();
});

test("message FTS indexes the newest revision and follows a soft delete/restore", async () => {
  const db = await freshDb();
  seed(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'hello'").get().n, 1);
  db.prepare(`INSERT INTO message_versions (message_id, revision, blocks_json, body_plain_text, content_sha256, editor_kind, editor_id, created_at)
    VALUES ('msg_1',2,'[]','replacement text','b'||substr(?,2),'owner','owner_1',?)`).run(SHA, T);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'hello'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'replacement'").get().n, 1);
  db.prepare("UPDATE messages SET deleted_at=?, current_revision=2 WHERE message_id='msg_1'").run(T);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_fts").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_tombstones WHERE message_id='msg_1'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM search_tombstones WHERE target_id='msg_1'").get().n, 1);
  db.prepare("UPDATE messages SET deleted_at=NULL WHERE message_id='msg_1'").run();
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'replacement'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message_tombstones").get().n, 0);
  db.close();
});

test("audit events are append-only", async () => {
  const db = await freshDb();
  seed(db);
  db.prepare(`INSERT INTO audit_events (audit_id, event_type, actor_kind, actor_id, target_type, target_id, allow_or_deny, metadata_json, created_at)
    VALUES ('evt_1','room.read','agent','agent_1','room','room_main','deny','{}',?)`).run(T);
  assert.throws(() => db.prepare("UPDATE audit_events SET allow_or_deny='allow' WHERE audit_id='evt_1'").run(), /AUDIT_IMMUTABLE/);
  assert.throws(() => db.prepare("DELETE FROM audit_events WHERE audit_id='evt_1'").run(), /AUDIT_IMMUTABLE/);
  db.close();
});

test("no agent may hold platform admin and only one owner exists", async () => {
  const db = await freshDb();
  seed(db);
  assert.throws(() => db.prepare(`INSERT INTO agents (agent_id, display_name, avatar_asset_id, platform_admin, created_at, updated_at)
    VALUES ('agent_2','관리자','file_a',1,?,?)`).run(T, T), /AGENT_PLATFORM_ADMIN_FORBIDDEN/);
  assert.throws(() => db.prepare("UPDATE agents SET platform_admin=1 WHERE agent_id='agent_1'").run(), /AGENT_PLATFORM_ADMIN_FORBIDDEN/);
  assert.throws(() => db.prepare(`INSERT INTO owners (owner_id, display_name, created_at, updated_at) VALUES ('owner_2','둘째',?,?)`).run(T, T), /OWNER_SINGLETON_VIOLATION/);
  db.close();
});

test("a project with tasks cannot be deleted (no silent cascade)", async () => {
  const db = await freshDb();
  seed(db);
  assert.throws(() => db.prepare("DELETE FROM projects WHERE project_id='proj_1'").run(), /FOREIGN KEY constraint failed/);
  db.close();
});

test("CI conclusions and usage budgets cannot be invented", async () => {
  const db = await freshDb();
  seed(db);
  db.prepare(`INSERT INTO projects (project_id, name, created_at, updated_at) VALUES ('proj_2','x',?,?)`).run(T, T);
  db.prepare(`INSERT INTO github_installations (installation_id, github_installation_id, account_login, installed_at)
    VALUES ('inst_1','12345','TRAY0328',?)`).run(T);
  db.prepare(`INSERT INTO git_repositories (repo_id, project_id, github_installation_id, github_repository_id, repo_full_name, connected_at)
    VALUES ('repo_1','proj_2','inst_1','999','TRAY0328/project-ai-room',?)`).run(T);
  assert.throws(() => db.prepare(`INSERT INTO ci_runs (ci_run_id, repo_id, github_run_id, head_sha, status, conclusion, created_at, last_synced_at)
    VALUES ('ci_1','repo_1','100','${"1".repeat(40)}','in_progress','success',?,?)`).run(T, T), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO usage_budgets (budget_id, provider, resource_kind, period_start, period_end, hard_limit_value, observation_state, updated_at)
    VALUES ('b1','cloudflare','d1_reads',?,?,100000,'measured',?)`).run(T, T, T), /CHECK constraint failed/);
  db.prepare(`INSERT INTO usage_budgets (budget_id, provider, resource_kind, period_start, period_end, hard_limit_value, observed_value, observation_state, updated_at)
    VALUES ('b2','cloudflare','d1_reads',?,?,100000,0,'unknown',?)`).run(T, T, T);
  db.close();
});

test("whole schema stays consistent after a realistic seed", async () => {
  const db = await freshDb();
  seed(db);
  db.prepare(`INSERT INTO room_members (room_id, actor_kind, actor_id, joined_at) VALUES ('room_main','agent','agent_1',?)`).run(T);
  db.prepare(`INSERT INTO room_acl (room_id, actor_kind, actor_id, role, granted_by, granted_at) VALUES ('room_main','agent','agent_1','contributor','owner_1',?)`).run(T);
  db.prepare(`INSERT INTO memory_records (memory_id, memory_scope, scope_id, project_id, memory_kind, body_text, source_json, created_at, updated_at)
    VALUES ('mem_2','room','room_main',NULL,'fact','room fact','[]',?,?)`).run(T, T);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  db.close();
});

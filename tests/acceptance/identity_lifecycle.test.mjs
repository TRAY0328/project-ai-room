/**
 * Acceptance tests — AI identity lifecycle (qa_matrix.json group 1).
 *
 * These exercise the real `AuthService` against the real D1 schema (SQLite shim),
 * not a mock: invitations, key issuance, rotation and session revocation are the
 * security boundary the spec calls out (S01–S03, S49).
 *
 * Test names start with the QA id they accept, which is how
 * tests/acceptance/qa_matrix_runner.mjs finds its evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
// Plain-ESM harness (no build, no workspace link needed).
import { createTestDb, seedBase } from "../../packages/testing/index.mjs";
import { AuthService } from "@ai-room/auth";
import { ApiError } from "@ai-room/contracts";

const ENV = {
  SESSION_SIGNING_KEY: "test-session-signing-key-32-bytes-min",
  WS_TICKET_SIGNING_KEY: "test-ws-ticket-signing-key-32-bytes",
  AGENT_INVITE_SECRET: "test-agent-invite-secret-32-bytes-ok",
  OWNER_BOOTSTRAP_SECRET: "test-owner-bootstrap-secret-32-bytes",
};

const OWNER = "owner_A1B2C3D4E5F6G7H8JKMNPQRS";
const MAIN_ROOM = "room_A1B2C3D4E5F6G7H8JKMNPQRS";
const AVATAR = "art_0123456789ABCDEFGHJKMNPQRS";
const UPLOADED_AVATAR = "file_0123456789ABCDEFGHJKMNPQRS";

async function fixture() {
  const { db, raw, close } = await createTestDb();
  seedBase(raw);
  const auth = new AuthService(db, ENV);
  return { db, raw, close, auth };
}

function register(auth, overrides = {}) {
  return auth.registerAgent({
    display_name: "피클",
    avatar_asset_id: AVATAR,
    invite_secret: ENV.AGENT_INVITE_SECRET,
    request_id: "req_0123456789ABCDEFGHJKMNPQRS",
    ...overrides,
  });
}

function count(raw, table) {
  return raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

async function expectApiError(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}, nothing was thrown`);
}

// ---------------------------------------------------------------------------
test("QA-001 초대 비밀값으로 AI 등록: 불변 ID·1회 키 발급·DB 저장·기본 방 참여", async () => {
  const { raw, close, auth } = await fixture();
  try {
    const result = await register(auth);
    assert.match(result.agent.agent_id, /^agent_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(result.credential.agent_key, /^airo_sk_/);
    assert.equal(result.identity.verification_state, "self_declared");
    assert.equal(result.identity.provider_verified, false);

    const agent = raw.prepare("SELECT agent_id, display_name, verification_state FROM agents WHERE agent_id = ?").get(result.agent.agent_id);
    assert.equal(agent.display_name, "피클");
    assert.equal(agent.verification_state, "self_declared");

    const credential = raw.prepare("SELECT verifier_hash, status FROM agent_credentials WHERE credential_id = ?").get(result.credential.credential_id);
    assert.equal(credential.status, "active");
    assert.equal(credential.verifier_hash, createHash("sha256").update(result.credential.agent_key).digest("hex"));
    assert.notEqual(credential.verifier_hash, result.credential.agent_key, "the plaintext key must never be stored");

    // A registered AI can speak in the one main room and nothing more.
    const membership = raw.prepare("SELECT room_id, role FROM room_acl WHERE actor_kind='agent' AND actor_id = ?").all(result.agent.agent_id);
    assert.deepEqual(membership.map((row) => row.room_id), [MAIN_ROOM]);
    assert.equal(membership[0].role, "contributor");
    assert.equal(count(raw, "agents"), 1);
    assert.equal(count(raw, "audit_events") >= 1, true, "registration is audited");
  } finally {
    close();
  }
});

test("QA-002 초대 비밀값 오류·누락: INVITE_INVALID, 계정·키 미생성", async () => {
  const { raw, close, auth } = await fixture();
  try {
    await expectApiError(register(auth, { invite_secret: "wrong-secret-value-000000" }), "INVITE_INVALID");
    await expectApiError(register(auth, { invite_secret: "" }), "INVITE_INVALID");
    assert.equal(count(raw, "agents"), 0);
    assert.equal(count(raw, "agent_credentials"), 0);
    assert.ok(count(raw, "security_events") >= 1, "a failed invite is recorded as a security event");
  } finally {
    close();
  }
});

test("QA-003 같은 idempotency 재전송: 계정·키 중복 발급 없음", async () => {
  const { raw, close, auth } = await fixture();
  try {
    const first = await register(auth, { idempotency_key: "idem-register-0001" });
    await expectApiError(register(auth, { idempotency_key: "idem-register-0001" }), "IDEMPOTENCY_CONFLICT");
    assert.equal(count(raw, "agents"), 1);
    assert.equal(count(raw, "agent_credentials"), 1);
    assert.equal(raw.prepare("SELECT agent_id FROM agents").get().agent_id, first.agent.agent_id);
  } finally {
    close();
  }
});

test("QA-004 아바타 누락: VALIDATION_FAILED, 계정 미생성", async () => {
  const { raw, close, auth } = await fixture();
  try {
    await expectApiError(register(auth, { avatar_asset_id: "" }), "VALIDATION_FAILED");
    assert.equal(count(raw, "agents"), 0);
    const ok = await register(auth, { avatar_asset_id: UPLOADED_AVATAR });
    assert.equal(ok.agent.avatar_asset_id, UPLOADED_AVATAR);
  } finally {
    close();
  }
});

test("QA-007 키 회전: 기존 키 무효, 새 키만 유효", async () => {
  const { raw, close, auth } = await fixture();
  try {
    const registered = await register(auth);
    const oldKey = registered.credential.agent_key;
    const rotated = await auth.rekeyAgent(registered.agent.agent_id, "req_0123456789ABCDEFGHJKMNPQRS");

    assert.notEqual(rotated.agent_key, oldKey);
    const statuses = raw.prepare("SELECT credential_id, status FROM agent_credentials ORDER BY created_at").all();
    assert.deepEqual(statuses.map((row) => row.status), ["rotated", "active"]);

    await expectApiError(auth.loginAgent({ agent_key: oldKey, request_id: "req_0123456789ABCDEFGHJKMNPQRS" }), "AUTH_REVOKED");
    const session = await auth.loginAgent({ agent_key: rotated.agent_key, request_id: "req_0123456789ABCDEFGHJKMNPQRS" });
    assert.equal(session.agent_id, registered.agent.agent_id);
  } finally {
    close();
  }
});

test("QA-008 세션 폐기: 폐기된 세션 토큰은 API/WS에서 거부", async () => {
  const { close, auth } = await fixture();
  try {
    const registered = await register(auth);
    const session = await auth.createSession({
      subjectKind: "agent",
      subjectId: registered.agent.agent_id,
      assurance: "agent_key",
      requestId: "req_0123456789ABCDEFGHJKMNPQRS",
    });
    const who = await auth.authenticate(session.access_token, "req_0123456789ABCDEFGHJKMNPQRS");
    assert.equal(who.subject.id, registered.agent.agent_id);

    const revoked = await auth.revokeSessionsFor(registered.agent.agent_id, "test_revoke");
    assert.ok(revoked >= 1);
    await expectApiError(auth.authenticate(session.access_token, "req_0123456789ABCDEFGHJKMNPQRS"), "AUTH_REVOKED");
  } finally {
    close();
  }
});

test("QA-010 자기신고 제공자 이름: '검증됨' 배지가 생기지 않는다", async () => {
  const { raw, close, auth } = await fixture();
  try {
    const result = await register(auth, { claimed_provider: "ChatGPT", model_name: "gpt-5" });
    assert.equal(result.identity.verification_state, "self_declared");
    assert.equal(result.identity.provider_verified, false);
    const row = raw.prepare("SELECT verification_state, claimed_provider FROM agents WHERE agent_id = ?").get(result.agent.agent_id);
    assert.equal(row.verification_state, "self_declared");
    assert.equal(row.claimed_provider, "ChatGPT");

    // The badge lives in capability_proofs, which refuses a self-claim.
    raw.prepare(`INSERT INTO provider_connections (connection_id, agent_id, provider_key, auth_method, updated_at)
                 VALUES ('conn_0123456789ABCDEFGHJKMNPQRS', ?, 'openai', 'api_key', '2026-11-21T00:00:00.000Z')`)
      .run(result.agent.agent_id);
    assert.throws(
      () => raw.prepare(`INSERT INTO capability_proofs (proof_id, connection_id, capability, state, verified_at, attestation)
                          VALUES ('prf_1', 'conn_0123456789ABCDEFGHJKMNPQRS', 'message.send', 'verified', '2026-11-21T00:00:00.000Z', 'self_declared')`).run(),
      /CHECK constraint failed/,
    );
  } finally {
    close();
  }
});

test("소유자 부트스트랩은 1회만, 두 번째는 거부된다", async () => {
  const { close, auth } = await fixture();
  try {
    await expectApiError(
      auth.bootstrapOwner({ display_name: "둘째", email: "x@example.test", password: "very-long-password-1", bootstrap_secret: ENV.OWNER_BOOTSTRAP_SECRET, request_id: "req_0123456789ABCDEFGHJKMNPQRS" }),
      "PERMISSION_DENIED",
    );
  } finally {
    close();
  }
});

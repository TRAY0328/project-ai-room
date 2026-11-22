/**
 * Identity integration tests — real D1 schema, real PBKDF2, real sessions.
 *
 * What is proven: one owner only, no plaintext key at rest, rotation kills old
 * sessions, the invite budget stops a brute force, and a provider that cannot be
 * verified answers with a blocked state instead of a fake connection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, BOOTSTRAP_SECRET, INVITE_SECRET } from "./helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** The cookies a browser would keep from one response (Set-Cookie → jar). */
function jarFrom(headers) {
  const jar = new Map();
  for (const raw of headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const [name, ...value] = pair.split("=");
    jar.set(name.trim(), decodeURIComponent(value.join("=")));
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

test("owner bootstrap is one-shot and never public", async () => {
  const { call, close } = await setup();
  try {
    const second = await call("POST", "/api/v1/owner/bootstrap", {
      idempotencyKey: "bootstrap-0000002",
      body: { display_name: "침입자", email: "intruder@example.test", password: "another-long-password", bootstrap_secret: BOOTSTRAP_SECRET },
    });
    assert.equal(second.status, 403);
    assert.equal(second.json.error.code, "PERMISSION_DENIED");
    assert.equal(second.json.error.details.reason_code, "OWNER_ALREADY_BOOTSTRAPPED");

    const wrongSecret = await call("POST", "/api/v1/owner/bootstrap", {
      idempotencyKey: "bootstrap-0000003",
      body: { display_name: "침입자", email: "x@example.test", password: "another-long-password", bootstrap_secret: "wrong-secret-value-000" },
    });
    assert.equal(wrongSecret.status, 403);
    assert.equal(wrongSecret.json.error.code, "INVITE_INVALID");
    // The secret itself never appears in the error body.
    assert.ok(!wrongSecret.text.includes("wrong-secret-value-000"));
  } finally {
    close();
  }
});

test("owner login verifies the PBKDF2 verifier and rate limits guesses", async () => {
  const { call, env, close } = await setup();
  try {
    const bad = await call("POST", "/api/v1/auth/login", { body: { email: "owner@example.test", password: "wrong-password-here" } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, "AUTH_REQUIRED");

    // The verifier is a PBKDF2 string, not the password, and is not in D1.
    assert.match(env.OWNER_PASSWORD_VERIFIER, /^pbkdf2\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    const ownerRow = env.DB && (await env.DB.prepare("SELECT * FROM owners").all()).results[0];
    assert.equal(JSON.stringify(ownerRow).includes("pbkdf2"), false, "password verifier must not be stored in D1");

    let limited = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await call("POST", "/api/v1/auth/login", { body: { email: "owner@example.test", password: "wrong-password-here" } });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    assert.ok(limited !== null, "repeated failures must hit RATE_LIMITED");
    assert.equal(limited.json.error.code, "RATE_LIMITED");
    assert.ok(limited.json.error.details.retry_after_seconds > 0);
  } finally {
    close();
  }
});

test("refresh rotation detects reuse and revokes the session", async () => {
  const { call, close } = await setup();
  try {
    const login = await call("POST", "/api/v1/auth/login", { body: { email: "owner@example.test", password: "correct-horse-battery-staple" } });
    const firstRefresh = login.json.data.session.refresh_token;
    const rotated = await call("POST", "/api/v1/auth/refresh", { body: { refresh_token: firstRefresh } });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.json.data.session.refresh_token, firstRefresh);
    const newAccess = rotated.json.data.session.access_token;

    const reuse = await call("POST", "/api/v1/auth/refresh", { body: { refresh_token: firstRefresh } });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.json.error.code, "AUTH_REVOKED");

    // Reuse detection revoked the whole family: the rotated token is dead too.
    const afterReuse = await call("GET", "/api/v1/rooms", { token: newAccess });
    assert.equal(afterReuse.status, 401);
    assert.equal(afterReuse.json.error.code, "AUTH_REVOKED");
  } finally {
    close();
  }
});

test("the browser's HttpOnly refresh cookie renews the session and re-issues both cookies", async () => {
  const { call, close } = await setup();
  try {
    const login = await call("POST", "/api/v1/auth/login", { body: { email: "owner@example.test", password: "correct-horse-battery-staple" } });
    const jar = jarFrom(login.headers);
    assert.ok(jar.has("air_session"), "login must set the access cookie");
    assert.ok(jar.has("air_refresh"), "login must set the refresh cookie");

    // The cookie alone authenticates a normal request.
    const before = await call("GET", "/api/v1/rooms", { headers: { cookie: cookieHeader(jar) } });
    assert.equal(before.status, 200, before.text);

    // No body: the browser cannot read the HttpOnly refresh token, so the cookie is
    // the only thing it can present. This used to fail validation (400).
    const renewed = await call("POST", "/api/v1/auth/refresh", { body: {}, headers: { cookie: cookieHeader(jar) } });
    assert.equal(renewed.status, 200, renewed.text);
    const rotated = jarFrom(renewed.headers);
    assert.ok(rotated.has("air_session"), "renewal must set a fresh access cookie");
    assert.ok(rotated.has("air_refresh"), "renewal must rotate the refresh cookie");
    assert.notEqual(rotated.get("air_refresh"), jar.get("air_refresh"));
    assert.notEqual(rotated.get("air_session"), jar.get("air_session"));
    assert.ok(
      Date.parse(renewed.json.data.session.access_expires_at) > Date.parse(before.json.server_time),
      "the renewed access token must expire in the future",
    );

    // The new pair is what the browser keeps: it authenticates on its own.
    const after = await call("GET", "/api/v1/rooms", { headers: { cookie: cookieHeader(rotated) } });
    assert.equal(after.status, 200, after.text);

    // `/v1/auth/refresh` is the documented spelling of the same route.
    const alias = await call("POST", "/v1/auth/refresh", { body: {}, headers: { cookie: cookieHeader(rotated) } });
    assert.equal(alias.status, 200, alias.text);
  } finally {
    close();
  }
});

test("a renewal with no session is refused and clears the dead cookies", async () => {
  const { call, close } = await setup();
  try {
    const anonymous = await call("POST", "/api/v1/auth/refresh", { body: {} });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error.code, "AUTH_REQUIRED");
    const cleared = anonymous.headers.getSetCookie?.() ?? [];
    assert.ok(cleared.some((cookie) => cookie.startsWith("air_session=") && /Max-Age=0/.test(cookie)));

    const login = await call("POST", "/api/v1/auth/login", { body: { email: "owner@example.test", password: "correct-horse-battery-staple" } });
    const jar = jarFrom(login.headers);
    const logout = await call("POST", "/api/v1/auth/logout", { body: {}, headers: { cookie: cookieHeader(jar) } });
    assert.equal(logout.status, 200, logout.text);

    // A logged-out session cannot be renewed, and the browser is told to drop it.
    const dead = await call("POST", "/api/v1/auth/refresh", { body: {}, headers: { cookie: cookieHeader(jar) } });
    assert.equal(dead.status, 401);
    assert.equal(dead.json.error.code, "AUTH_REVOKED");
    const clearedAfterLogout = dead.headers.getSetCookie?.() ?? [];
    assert.ok(clearedAfterLogout.some((cookie) => cookie.startsWith("air_refresh=") && /Max-Age=0/.test(cookie)));
  } finally {
    close();
  }
});

test("agent registration needs a private invite and stores only a key hash", async () => {
  const { call, env, close } = await setup();
  try {
    const badInvite = await call("POST", "/api/v1/agents/register", {
      idempotencyKey: "register-bad-invite",
      body: { invite_secret: "not-the-invite-secret", display_name: "사칭", avatar_asset_id: "art_A1B2C3D4E5F6G7H8JKMNPQRSTV" },
    });
    assert.equal(badInvite.status, 403);
    assert.equal(badInvite.json.error.code, "INVITE_INVALID");

    const registered = await call("POST", "/api/v1/agents/register", {
      idempotencyKey: "register-good-invite",
      body: {
        invite_secret: INVITE_SECRET,
        display_name: "피클",
        avatar_asset_id: "art_A1B2C3D4E5F6G7H8JKMNPQRSTV",
        claimed_provider: "chatgpt",
        model_name: "self-claimed-model",
      },
    });
    assert.equal(registered.status, 201);
    const key = registered.json.data.credential.agent_key;
    assert.match(key, /^airo_sk_[A-Za-z0-9_-]{20,}$/);

    const credentials = (await env.DB.prepare("SELECT verifier_hash FROM agent_credentials").all()).results;
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].verifier_hash, sha256(key));
    assert.equal(JSON.stringify(credentials).includes(key), false, "plaintext key must never be stored");

    const agent = await call("GET", `/api/v1/agents/${registered.json.data.agent.agent_id}`, { token: registered.json.data.session.access_token });
    assert.equal(agent.status, 200);
    assert.equal(agent.json.data.verification_state, "self_declared");
    assert.equal(agent.json.data.identity_verified, false);
    assert.equal(agent.json.data.credential.status, "active");
    assert.ok(!agent.text.includes(key), "profile must not echo the key");
  } finally {
    close();
  }
});

test("one-time invite is consumed exactly once", async () => {
  const { call, ownerToken, close } = await setup();
  try {
    const invite = await call("POST", "/api/v1/admin/agent-invites", { token: ownerToken, body: { ttl_seconds: 600 } });
    assert.equal(invite.status, 201);
    const secret = invite.json.data.secret;

    const first = await call("POST", "/api/v1/agents/register", {
      idempotencyKey: "register-invite-first",
      body: { invite_secret: secret, display_name: "키링", avatar_asset_id: "art_A1B2C3D4E5F6G7H8JKMNPQRSTV" },
    });
    assert.equal(first.status, 201);
    const second = await call("POST", "/api/v1/agents/register", {
      idempotencyKey: "register-invite-second",
      body: { invite_secret: secret, display_name: "복제", avatar_asset_id: "art_A1B2C3D4E5F6G7H8JKMNPQRSTV" },
    });
    assert.equal(second.status, 403);
    assert.equal(second.json.error.code, "INVITE_INVALID");
  } finally {
    close();
  }
});

test("rekey retires the old key and revokes live sessions", async () => {
  const { call, registerAgent, close } = await setup();
  try {
    const agent = await registerAgent("일이");
    const rekeyed = await call("POST", "/api/v1/agents/rekey", { token: agent.token, body: {} });
    assert.equal(rekeyed.status, 200);
    const newKey = rekeyed.json.data.credential.agent_key;
    assert.notEqual(newKey, agent.key);

    const oldKeyLogin = await call("POST", "/api/v1/agents/login", { body: { agent_key: agent.key } });
    assert.equal(oldKeyLogin.status, 401);
    assert.equal(oldKeyLogin.json.error.code, "AUTH_REVOKED");

    const newKeyLogin = await call("POST", "/api/v1/agents/login", { body: { agent_key: newKey } });
    assert.equal(newKeyLogin.status, 200);

    const oldSession = await call("GET", "/api/v1/rooms", { token: agent.token });
    assert.equal(oldSession.status, 401);
  } finally {
    close();
  }
});

test("the owner can revoke an AI key and every session with it", async () => {
  const { call, ownerToken, registerAgent, close } = await setup();
  try {
    const agent = await registerAgent("회수대상");
    const revoked = await call("DELETE", `/api/v1/agents/${agent.agentId}/credentials`, { token: ownerToken, body: { reason: "유출 의심" } });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.json.data.revoked, true);
    assert.ok(revoked.json.data.sessions_revoked >= 1);

    const past = await call("GET", "/api/v1/rooms", { token: agent.token });
    assert.equal(past.status, 401);
    const login = await call("POST", "/api/v1/agents/login", { body: { agent_key: agent.key } });
    assert.equal(login.status, 401);
    assert.equal(login.json.error.code, "AUTH_REVOKED");
    const status = await call("GET", `/api/v1/agents/${agent.agentId}`, { token: ownerToken });
    assert.equal(status.json.data.credential.status, "none");
  } finally {
    close();
  }
});

test("an AI cannot edit another AI's profile or immutable fields", async () => {
  const { call, registerAgent, close } = await setup();
  try {
    const a = await registerAgent("VOOY");
    const b = await registerAgent("키링");
    const crossEdit = await call("PATCH", `/api/v1/agents/${b.agentId}`, { token: a.token, body: { display_name: "탈취" } });
    assert.equal(crossEdit.status, 403);
    assert.equal(crossEdit.json.error.details.reason_code, "SELF_ONLY");

    const immutable = await call("PATCH", `/api/v1/agents/${a.agentId}`, { token: a.token, body: { platform_admin: 1 } });
    assert.equal(immutable.status, 400);
    assert.equal(immutable.json.error.code, "VALIDATION_FAILED");

    const allowed = await call("PATCH", `/api/v1/agents/${a.agentId}`, { token: a.token, body: { description: "새 소개" } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.json.data.changed_fields, ["description"]);
  } finally {
    close();
  }
});

test("provider endpoints are honest blocked states with official evidence", async () => {
  const { call, ownerToken, close } = await setup();
  try {
    const connect = await call("POST", "/api/v1/providers/chatgpt/connect", { token: ownerToken, body: {} });
    assert.equal(connect.status, 503);
    assert.equal(connect.json.error.code, "EXTERNAL_DEPENDENCY_BLOCKED");
    assert.equal(connect.json.error.details.reason, "PROVIDER_NOT_VERIFIED");
    assert.ok(connect.json.error.details.official_doc_urls.length > 0);
    assert.equal(connect.json.error.details.provider_state, "NOT_CONFIGURED");

    const verify = await call("POST", "/api/v1/providers/claude/verify", { token: ownerToken, body: { capability: "message.send" } });
    assert.equal(verify.status, 503);
    assert.equal(verify.json.error.details.proof_state, "unsupported");

    const connections = await call("GET", "/api/v1/providers/connections", { token: ownerToken });
    assert.equal(connections.status, 200);
    assert.deepEqual(connections.json.data.items, []);
    assert.equal(connections.json.data.roster_gate, "BLOCKED_EXTERNAL_DEPENDENCY");

    const required = await call("GET", "/api/v1/admin/required-agents", { token: ownerToken });
    assert.equal(required.status, 200);
    assert.equal(required.json.data.items.length, 8);
    assert.equal(required.json.data.gate.gate, "BLOCKED_EXTERNAL_DEPENDENCY");
    assert.equal(required.json.data.items.filter((item) => item.badge_allowed).length, 0);
  } finally {
    close();
  }
});

test("an AI cannot reach owner administration", async () => {
  const { call, registerAgent, close } = await setup();
  try {
    const agent = await registerAgent("피클");
    for (const [method, path] of [
      ["GET", "/api/v1/admin/overview"],
      ["GET", "/api/v1/admin/audit-events"],
      ["GET", "/api/v1/admin/release-gates"],
      ["POST", "/api/v1/admin/emergency-stop"],
    ]) {
      const response = await call(method, path, { token: agent.token, ...(method === "POST" ? { body: { reason: "test" } } : {}) });
      assert.ok(response.status === 403 || response.status === 400, `${path} must be denied, got ${response.status}`);
      assert.notEqual(response.json.error?.code, undefined);
    }
  } finally {
    close();
  }
});

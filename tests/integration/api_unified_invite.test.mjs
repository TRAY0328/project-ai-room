/**
 * One shared invite code, many AIs — the documented registration path.
 *
 * This is the flow the portal documents, exercised end to end against the real
 * worker: two different AIs register with the SAME invite code and no uploaded
 * asset (avatar_url only), log in with the key they were given, and post a
 * message whose blocks use the client spelling (`type`, `payload`) with the
 * idempotency key in the header only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setup, INVITE_SECRET } from "./helpers.mjs";

function cookiesFrom(response) {
  const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const jar = new Map();
  for (const line of raw) {
    const [pair] = line.split(";");
    const [name, ...rest] = (pair ?? "").split("=");
    if (name !== undefined && name.length > 0) jar.set(name.trim(), rest.join("="));
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

test("one unified invite code registers several AIs, and each keeps its own key", async () => {
  const { call, close, env } = await setup();
  try {
    const names = ["ChatGPT", "Claude", "Gemini"];
    const agents = [];
    for (const [index, name] of names.entries()) {
      const registered = await call("POST", "/api/v1/agents/register", {
        idempotencyKey: `register-unified-${index}`,
        body: {
          invite_secret: INVITE_SECRET,
          display_name: name,
          avatar_url: `https://cdn.example.test/${name.toLowerCase()}.png`,
          provider_claim: "other",
          bio: `${name} · 통합 초대코드로 등록`,
        },
      });
      assert.equal(registered.status, 201, registered.text);
      assert.equal(registered.json.data.agent.display_name, name);
      assert.equal(registered.json.data.agent.avatar_url, `https://cdn.example.test/${name.toLowerCase()}.png`);
      assert.equal(registered.json.data.agent.avatar_asset_id, "", "no uploaded asset was claimed");
      assert.match(registered.json.data.credential.agent_key, /^airo_sk_/);
      assert.equal(registered.json.data.identity.verification_state, "self_declared");
      agents.push(registered.json.data);
    }

    const ids = new Set(agents.map((a) => a.agent.agent_id));
    const keys = new Set(agents.map((a) => a.credential.agent_key));
    assert.equal(ids.size, names.length, "every AI is its own identity");
    assert.equal(keys.size, names.length, "every AI gets its own key");

    // The shared code is not consumed by the first use: the bootstrap invite row
    // stays unused, and each registration above succeeded with the same secret.
    const used = (await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_invites WHERE used_at IS NOT NULL").all()).results;
    assert.equal(used[0].n, 0, "the unified code is never marked used");
    const agentsInDb = (await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").all()).results;
    assert.equal(agentsInDb[0].n, names.length, "every AI is stored as its own agent");
  } finally {
    close();
  }
});

test("a self-claimed provider badge is refused, so the roster stays honest", async () => {
  const { call, close } = await setup();
  try {
    const refused = await call("POST", "/api/v1/agents/register", {
      idempotencyKey: "register-claim-true",
      body: {
        invite_secret: INVITE_SECRET,
        display_name: "SelfVerified",
        avatar_url: "https://cdn.example.test/self.png",
        provider_verified: true,
      },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error.code, "VALIDATION_FAILED");
    assert.equal(refused.json.error.details.field, "provider_verified");
  } finally {
    close();
  }
});

test("register -> login sets an HttpOnly session cookie, and /v1/ answers like /api/v1/", async () => {
  const { call, close, roomId } = await setup();
  try {
    const registered = await call("POST", "/v1/agents/register", {
      idempotencyKey: "register-cookie-flow",
      body: { invite_secret: INVITE_SECRET, display_name: "Cookie AI", avatar_url: "https://cdn.example.test/cookie.png" },
    });
    assert.equal(registered.status, 201, registered.text);
    const agentKey = registered.json.data.credential.agent_key;

    const login = await call("POST", "/v1/agents/login", { body: { agent_key: agentKey } });
    assert.equal(login.status, 200, login.text);
    const jar = cookiesFrom(login);
    assert.ok(jar.get("air_session"), "session cookie is set");
    assert.ok(jar.get("air_csrf"), "csrf cookie is set");
    assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/);

    const sessionBody = await call("GET", "/v1/rooms", { headers: { cookie: cookieHeader(jar) } });
    assert.equal(sessionBody.status, 200, sessionBody.text);
    assert.ok(sessionBody.json.data.items.length >= 1);

    // A cookie-authenticated write without the CSRF echo is refused.
    const withoutCsrf = await call("POST", `/v1/rooms/${roomId}/messages`, {
      headers: { cookie: cookieHeader(jar) },
      idempotencyKey: "cookie-no-csrf",
      body: { blocks: [{ type: "markdown", payload: { markdown: "csrf 없음" } }] },
    });
    assert.equal(withoutCsrf.status, 403);

    const withCsrf = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      headers: { cookie: cookieHeader(jar), "x-csrf-token": jar.get("air_csrf") },
      idempotencyKey: "cookie-with-csrf",
      body: { blocks: [{ type: "markdown", payload: { markdown: "쿠키 세션으로 전송" } }] },
    });
    assert.equal(withCsrf.status, 201, withCsrf.text);
    assert.equal(withCsrf.json.data.message.block_count ?? withCsrf.json.data.message.blocks.length, 1);
  } finally {
    close();
  }
});

test("the documented message body works with the idempotency key only in the header", async () => {
  const { call, close, roomId } = await setup();
  try {
    const registered = await call("POST", "/api/v1/agents/register", {
      idempotencyKey: "register-message-flow",
      body: { invite_secret: INVITE_SECRET, display_name: "Messenger AI", avatar_url: "https://cdn.example.test/m.png" },
    });
    assert.equal(registered.status, 201, registered.text);
    const token = registered.json.data.session.access_token;

    const first = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token,
      idempotencyKey: "message-doc-shape-0001",
      body: { blocks: [{ type: "markdown", version: 1, payload: { markdown: "참여했습니다." } }] },
    });
    assert.equal(first.status, 201, first.text);
    const message = first.json.data.message;
    assert.equal(message.blocks.length, 1);
    assert.equal(message.blocks[0].block_type, "markdown", "the client spelling normalizes to the stored one");
    assert.ok(message.blocks[0].block_id.startsWith("blk_"), "a block id is minted when the client sends none");
    assert.equal(message.body_plain_text, "참여했습니다.");

    // Same idempotency key, same body: the replay returns the same message.
    const replay = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token,
      idempotencyKey: "message-doc-shape-0001",
      body: { blocks: [{ type: "markdown", version: 1, payload: { markdown: "참여했습니다." } }] },
    });
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.json.data.message.message_id, message.message_id);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
  } finally {
    close();
  }
});

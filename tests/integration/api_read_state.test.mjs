/**
 * Read state — the fact behind the unread number.
 *
 * The gateway stores one row per (room, reader); these tests check that the
 * mark only moves forward, that it is clamped to the room head, that it is
 * visible to the other members, and that a non-member cannot mark a room they
 * cannot read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";

async function send(call, token, roomId, text, key) {
  return call("POST", `/api/v1/rooms/${roomId}/messages`, {
    token,
    idempotencyKey: key,
    body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text } }], idempotency_key: key },
  });
}

async function markRead(call, token, roomId, seq) {
  return call("POST", `/api/v1/rooms/${roomId}/read`, { token, body: { last_read_seq: seq } });
}

test("a read mark is stored, shared with the room, and never moves backwards", async () => {
  const { call, ownerToken, roomId, registerAgent, close } = await setup();
  try {
    const agent = await registerAgent("읽는AI");
    const join = await call("POST", `/api/v1/rooms/${roomId}/members`, {
      token: ownerToken,
      body: { actor_kind: "agent", actor_id: agent.agentId },
    });
    assert.equal(join.status, 201);

    const one = await send(call, ownerToken, roomId, "첫 메시지", "idem-read-00001");
    assert.equal(one.status, 201);
    const two = await send(call, agent.token, roomId, "AI 답장", "idem-read-00002");
    assert.equal(two.status, 201);
    assert.equal(two.json.data.message.room_seq, 2);

    const firstMark = await markRead(call, ownerToken, roomId, 2);
    assert.equal(firstMark.status, 201);
    assert.equal(firstMark.json.data.last_read_seq, 2);
    assert.equal(firstMark.json.data.actor_kind, "owner");
    const ownerRow = firstMark.json.data.reads.find((row) => row.actor_kind === "owner");
    assert.equal(ownerRow.last_read_seq, 2);

    // A stale report (another tab that was behind) cannot rewind the reader.
    const backwards = await markRead(call, ownerToken, roomId, 1);
    assert.equal(backwards.status, 201);
    assert.equal(backwards.json.data.last_read_seq, 2);

    // A page never returns a place beyond the room head, and the mark is clamped.
    const ahead = await markRead(call, agent.token, roomId, 999);
    assert.equal(ahead.status, 201);
    assert.equal(ahead.json.data.last_read_seq, 2);
    assert.equal(ahead.json.data.latest_seq, 2);

    const page = await call("GET", `/api/v1/rooms/${roomId}/messages?limit=10`, { token: ownerToken });
    assert.equal(page.status, 200);
    const reads = new Map(page.json.data.reads.map((row) => [`${row.actor_kind}:${row.actor_id}`, row.last_read_seq]));
    assert.equal(reads.get(`owner:${page.json.data.reads.find((row) => row.actor_kind === "owner").actor_id}`), 2);
    assert.equal(page.json.data.read_window_ms, 7 * 24 * 60 * 60 * 1000);
    assert.ok(page.json.data.member_count >= 2);
  } finally {
    close();
  }
});

test("room list unread counts what arrived after my last mark and was not written by me", async () => {
  const { call, ownerToken, roomId, registerAgent, close } = await setup();
  try {
    const agent = await registerAgent("집계AI");
    await call("POST", `/api/v1/rooms/${roomId}/members`, { token: ownerToken, body: { actor_kind: "agent", actor_id: agent.agentId } });

    await send(call, ownerToken, roomId, "1", "idem-unread-00001");
    await send(call, ownerToken, roomId, "2", "idem-unread-00002");

    const roomsBefore = await call("GET", "/api/v1/rooms", { token: agent.token });
    const before = roomsBefore.json.data.items.find((room) => room.room_id === roomId);
    assert.equal(before.unread_count, 2);

    await markRead(call, agent.token, roomId, 2);
    const roomsAfter = await call("GET", "/api/v1/rooms", { token: agent.token });
    const after = roomsAfter.json.data.items.find((room) => room.room_id === roomId);
    assert.equal(after.unread_count, 0);

    // My own message is never unread for me, even before I mark it.
    await send(call, agent.token, roomId, "제 메시지", "idem-unread-00003");
    const roomsOwn = await call("GET", "/api/v1/rooms", { token: agent.token });
    assert.equal(roomsOwn.json.data.items.find((room) => room.room_id === roomId).unread_count, 0);
  } finally {
    close();
  }
});

test("whoami recovers the identity behind a cookie or an agent key", async () => {
  const { call, ownerToken, registerAgent, close } = await setup();
  try {
    const asOwner = await call("GET", "/api/v1/auth/whoami", { token: ownerToken });
    assert.equal(asOwner.status, 200);
    assert.equal(asOwner.json.data.subject_kind, "owner");
    assert.equal(asOwner.json.data.display_name, "천예준");

    const agent = await registerAgent("정체AI");
    const asAgent = await call("GET", "/api/v1/auth/whoami", { token: agent.token });
    assert.equal(asAgent.status, 200);
    assert.equal(asAgent.json.data.subject_kind, "agent");
    assert.equal(asAgent.json.data.display_name, "정체AI");
    assert.ok(asAgent.json.data.room_ids.length >= 1);

    const anonymous = await call("GET", "/api/v1/auth/whoami");
    assert.equal(anonymous.status, 401);
  } finally {
    close();
  }
});

test("a room cannot be marked read by someone who is not in it", async () => {
  const { call, ownerToken, registerAgent, close } = await setup();
  try {
    const outsider = await registerAgent("외부AI");
    // A custom room has only its creator: registration joins the default room,
    // not every room.
    const created = await call("POST", "/api/v1/rooms", {
      token: ownerToken,
      idempotencyKey: "idem-room-private-1",
      body: { name: "비밀방", room_type: "custom" },
    });
    assert.equal(created.status, 201);
    const refused = await markRead(call, outsider.token, created.json.data.room_id, 0);
    assert.ok([403, 404].includes(refused.status), `unexpected status ${refused.status}`);
  } finally {
    close();
  }
});

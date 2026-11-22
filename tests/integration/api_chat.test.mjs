/**
 * Chat/files/search integration tests — real ordering, real tombstones, real
 * quarantine, and an ACL that is enforced in the query itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup } from "./helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function send(call, token, roomId, text, key) {
  return call("POST", `/api/v1/rooms/${roomId}/messages`, {
    token,
    idempotencyKey: key,
    body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text } }], idempotency_key: key },
  });
}

test("room_seq is gap-free and the same idempotency key never creates two messages", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    const first = await send(call, ownerToken, roomId, "첫 메시지", "idem-msg-00001");
    assert.equal(first.status, 201);
    assert.equal(first.json.data.message.room_seq, 1);

    const replay = await send(call, ownerToken, roomId, "첫 메시지", "idem-msg-00001");
    // An idempotent replay returns the original response, marked as a replay.
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal(replay.json.data.message.message_id, first.json.data.message.message_id);

    const conflict = await send(call, ownerToken, roomId, "다른 내용", "idem-msg-00001");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, "IDEMPOTENCY_CONFLICT");

    const second = await send(call, ownerToken, roomId, "두 번째", "idem-msg-00002");
    assert.equal(second.json.data.message.room_seq, 2);

    const list = await call("GET", `/api/v1/rooms/${roomId}/messages?limit=10`, { token: ownerToken });
    assert.equal(list.status, 200);
    assert.equal(list.json.data.items.length, 2);
    assert.deepEqual(list.json.data.items.map((item) => item.room_seq), [2, 1]);
    assert.equal(list.json.data.latest_seq, 2);
  } finally {
    close();
  }
});

test("an edit creates a new immutable version and a stale revision is refused", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    const created = await send(call, ownerToken, roomId, "원본", "idem-edit-00001");
    const messageId = created.json.data.message.message_id;
    const edited = await call("PATCH", `/api/v1/rooms/${roomId}/messages/${messageId}`, {
      token: ownerToken,
      body: {
        blocks: [{ block_id: "b1", block_type: "markdown", payload: { text: "수정본" } }],
        body_plain_text: "수정본",
        expected_revision: 1,
      },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.data.message.revision, 2);

    const stale = await call("PATCH", `/api/v1/rooms/${roomId}/messages/${messageId}`, {
      token: ownerToken,
      body: { blocks: [{ block_id: "b1", block_type: "text", payload: { text: "늦은 수정" } }], expected_revision: 1 },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "REVISION_CONFLICT");

    const versions = await call("GET", `/api/v1/messages/${messageId}/versions`, { token: ownerToken });
    assert.equal(versions.status, 200);
    assert.equal(versions.json.data.items.length, 2);
    assert.equal(versions.json.data.items[0].revision, 2);
    assert.equal(versions.json.data.items[0].body_plain_text, "수정본");
    assert.equal(versions.json.data.items[1].body_plain_text, "원본");
  } finally {
    close();
  }
});

test("delete is a soft delete with a tombstone that reaches search", async () => {
  const { call, ownerToken, roomId, raw, close } = await setup();
  try {
    const created = await send(call, ownerToken, roomId, "지워질 비밀 단어 코코아", "idem-del-00001");
    const messageId = created.json.data.message.message_id;
    const before = await call("POST", "/api/v1/search", { token: ownerToken, body: { query: "코코아" } });
    assert.equal(before.json.data.items.length, 1);

    const deleted = await call("DELETE", `/api/v1/rooms/${roomId}/messages/${messageId}`, { token: ownerToken, body: { expected_revision: 1, reason: "테스트" } });
    assert.equal(deleted.status, 200);

    const after = await call("POST", "/api/v1/search", { token: ownerToken, body: { query: "코코아" } });
    assert.equal(after.json.data.items.length, 0, "deleted content must not be searchable");

    const tombstone = raw.prepare("SELECT * FROM message_tombstones WHERE message_id = ?").get(messageId);
    assert.equal(tombstone.deleted_by_kind, "owner");
    assert.equal(tombstone.reason, "테스트");
    const ftsRows = raw.prepare("SELECT COUNT(*) AS n FROM message_fts WHERE message_id = ?").get(messageId);
    assert.equal(ftsRows.n, 0);
    const listed = await call("GET", `/api/v1/rooms/${roomId}/messages`, { token: ownerToken });
    assert.equal(listed.json.data.items.length, 0);
    const asOwnerWithDeleted = await call("GET", `/api/v1/rooms/${roomId}/messages?include_deleted=true`, { token: ownerToken });
    assert.equal(asOwnerWithDeleted.json.data.items.length, 1);
    assert.equal(asOwnerWithDeleted.json.data.items[0].body_plain_text, null);
  } finally {
    close();
  }
});

test("reactions are deduped per actor and bounded", async () => {
  const { call, ownerToken, registerAgent, roomId, close } = await setup();
  try {
    const agent = await registerAgent("피클");
    const created = await send(call, ownerToken, roomId, "반응 테스트", "idem-react-0001");
    const messageId = created.json.data.message.message_id;
    const twice = await call("POST", `/api/v1/messages/${messageId}/reactions`, { token: agent.token, idempotencyKey: "react-0000001", body: { emoji_key: "👍" } });
    assert.equal(twice.status, 201);
    const again = await call("POST", `/api/v1/messages/${messageId}/reactions`, { token: agent.token, idempotencyKey: "react-0000001b", body: { emoji_key: "👍" } });
    assert.equal(again.status, 201);
    const counts = again.json.data.reactions.find((reaction) => reaction.emoji_key === "👍");
    assert.equal(counts.count, 1);
  } finally {
    close();
  }
});

test("file upload verifies the hash, quarantines, and refuses download until scanned", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    const rejected = await call("POST", "/api/v1/files/upload-intents", {
      token: ownerToken,
      idempotencyKey: "upload-intent-0001",
      body: { filename: "attack.html", mime_type: "text/html", size_bytes: 10, sha256: sha256("x") },
    });
    assert.equal(rejected.status, 415);
    assert.equal(rejected.json.error.code, "MIME_REJECTED");

    const content = "AI ROOM 파일 본문입니다.";
    const bytes = new TextEncoder().encode(content);
    const intent = await call("POST", "/api/v1/files/upload-intents", {
      token: ownerToken,
      idempotencyKey: "upload-intent-0002",
      body: { filename: "note.txt", mime_type: "text/plain", size_bytes: bytes.length, sha256: sha256(bytes) },
    });
    assert.equal(intent.status, 201);
    const uploadId = intent.json.data.upload_id;

    const upload = await call("PUT", `/api/v1/files/uploads/${uploadId}/content`, { token: ownerToken, rawBody: bytes });
    assert.equal(upload.status, 200);

    const wrongHash = await call("POST", `/api/v1/files/uploads/${uploadId}/complete`, {
      token: ownerToken,
      idempotencyKey: "upload-complete-bad",
      body: { parts: [], sha256: sha256("다른 내용"), byte_count: bytes.length },
    });
    assert.equal(wrongHash.status, 400);

    const correct = await call("POST", `/api/v1/files/uploads/${uploadId}/complete`, {
      token: ownerToken,
      idempotencyKey: "upload-complete-good",
      body: { parts: [], sha256: sha256(bytes), byte_count: bytes.length },
    });
    assert.equal(correct.status, 202);
    assert.equal(correct.json.data.storage_state, "quarantined");

    const blocked = await call("GET", `/api/v1/files/${uploadId}/download-intent`, { token: ownerToken });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, "FILE_SCAN_PENDING");

    const scanned = await call("POST", `/api/v1/files/${uploadId}/scan-result`, { token: ownerToken, body: { scan_state: "clean" } });
    assert.equal(scanned.status, 200);
    assert.equal(scanned.json.data.storage_state, "ready");

    const intentDownload = await call("GET", `/api/v1/files/${uploadId}/download-intent`, { token: ownerToken });
    assert.equal(intentDownload.status, 200);
    const url = intentDownload.json.data.download_url;
    const download = await call("GET", url);
    assert.equal(download.status, 200);
    assert.equal(download.text, content);

    const tampered = await call("GET", `${url.slice(0, -4)}AAAA`);
    assert.equal(tampered.status, 401);

    void roomId;
  } finally {
    close();
  }
});

test("an AI can attach a scanned file and reading it is limited to the room", async () => {
  const { call, ownerToken, registerAgent, roomId, close } = await setup();
  try {
    const author = await registerAgent("피클");
    const other = await registerAgent("키링");
    const content = "방 첨부 파일";
    const bytes = new TextEncoder().encode(content);
    const intent = await call("POST", "/api/v1/files/upload-intents", {
      token: author.token,
      idempotencyKey: "attach-intent-0001",
      body: { filename: "chat.txt", mime_type: "text/plain", size_bytes: bytes.length, sha256: sha256(bytes) },
    });
    assert.equal(intent.status, 201, intent.text);
    const fileId = intent.json.data.upload_id;
    await call("PUT", `/api/v1/files/uploads/${fileId}/content`, { token: author.token, rawBody: bytes });

    // Still quarantined: it cannot be attached yet.
    const tooEarly = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: author.token,
      idempotencyKey: "attach-message-early",
      body: { blocks: [{ block_id: "f", block_type: "file", payload: { file_id: fileId } }], idempotency_key: "attach-message-early" },
    });
    assert.equal(tooEarly.status, 409);
    assert.equal(tooEarly.json.error.code, "FILE_SCAN_PENDING");

    await call("POST", `/api/v1/files/uploads/${fileId}/complete`, {
      token: author.token,
      idempotencyKey: "attach-complete-0001",
      body: { parts: [], sha256: sha256(bytes), byte_count: bytes.length },
    });
    await call("POST", `/api/v1/files/${fileId}/scan-result`, { token: ownerToken, body: { scan_state: "clean" } });

    const attached = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: author.token,
      idempotencyKey: "attach-message-ok",
      body: { blocks: [{ block_id: "f", block_type: "file", payload: { file_id: fileId } }], idempotency_key: "attach-message-ok" },
    });
    assert.equal(attached.status, 201, attached.text);

    // A member of the room can fetch it (registered AIs join the default room).
    const memberAccess = await call("GET", `/api/v1/files/${fileId}/download-intent`, { token: other.token });
    assert.equal(memberAccess.status, 200);

    // A file attached to a private room is not readable by an AI outside it.
    const privateRoom = await call("POST", "/api/v1/rooms", { token: author.token, body: { name: "비공개 첨부방" } });
    assert.equal(privateRoom.status, 201, privateRoom.text);
    const privateRoomId = privateRoom.json.data.room_id;
    const secondContent = "비공개 방 첨부";
    const secondBytes = new TextEncoder().encode(secondContent);
    const privateIntent = await call("POST", "/api/v1/files/upload-intents", {
      token: author.token,
      idempotencyKey: "attach-intent-0002",
      body: { filename: "private.txt", mime_type: "text/plain", size_bytes: secondBytes.length, sha256: sha256(secondBytes) },
    });
    const privateFileId = privateIntent.json.data.upload_id;
    await call("PUT", `/api/v1/files/uploads/${privateFileId}/content`, { token: author.token, rawBody: secondBytes });
    await call("POST", `/api/v1/files/uploads/${privateFileId}/complete`, {
      token: author.token,
      idempotencyKey: "attach-complete-0002",
      body: { parts: [], sha256: sha256(secondBytes), byte_count: secondBytes.length },
    });
    await call("POST", `/api/v1/files/${privateFileId}/scan-result`, { token: ownerToken, body: { scan_state: "clean" } });
    const attachedPrivate = await call("POST", `/api/v1/rooms/${privateRoomId}/messages`, {
      token: author.token,
      idempotencyKey: "attach-message-private",
      body: { blocks: [{ block_id: "f", block_type: "file", payload: { file_id: privateFileId } }], idempotency_key: "attach-message-private" },
    });
    assert.equal(attachedPrivate.status, 201, attachedPrivate.text);
    const denied = await call("GET", `/api/v1/files/${privateFileId}/download-intent`, { token: other.token });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.details.reason_code, "NOT_ROOM_MEMBER");
  } finally {
    close();
  }
});

test("search never crosses a room the AI is not in", async () => {
  const { call, ownerToken, registerAgent, roomId, close } = await setup();
  try {
    const agent = await registerAgent("피클");
    const secretRoom = await call("POST", "/api/v1/rooms", { token: ownerToken, body: { name: "비공개 방" } });
    assert.equal(secretRoom.status, 201);
    const secretRoomId = secretRoom.json.data.room_id;
    await send(call, ownerToken, secretRoomId, "비공개 키워드 하바나", "idem-secret-0001");
    await send(call, ownerToken, roomId, "공개 키워드 하바나", "idem-public-0002");

    const agentSearch = await call("POST", "/api/v1/search", { token: agent.token, body: { query: "하바나" } });
    assert.equal(agentSearch.status, 200);
    assert.equal(agentSearch.json.data.items.length, 1);
    assert.equal(agentSearch.json.data.items[0].room_id, roomId);

    const intrusion = await call("GET", `/api/v1/rooms/${secretRoomId}/messages`, { token: agent.token });
    assert.equal(intrusion.status, 403);
    assert.equal(intrusion.json.error.code, "ROOM_ACCESS_DENIED");

    const ownerSearch = await call("POST", "/api/v1/search", { token: ownerToken, body: { query: "하바나" } });
    assert.equal(ownerSearch.json.data.items.length, 2);
  } finally {
    close();
  }
});

test("read receipts need provider evidence and drive the unread metric", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    const created = await send(call, ownerToken, roomId, "읽음 테스트", "idem-receipt-0001");
    const messageId = created.json.data.message.message_id;
    const unverified = await call("POST", `/api/v1/messages/${messageId}/receipts`, {
      token: ownerToken,
      body: { recipient_kind: "agent", recipient_id: "agent_AAAAAAAAAAAAAAAAAAAAAAAAAA", state: "READ_CONFIRMED" },
    });
    assert.equal(unverified.status, 412);
    assert.equal(unverified.json.error.code, "PROVIDER_UNVERIFIED");

    const queued = await call("POST", `/api/v1/messages/${messageId}/receipts`, {
      token: ownerToken,
      body: { recipient_kind: "agent", recipient_id: "agent_AAAAAAAAAAAAAAAAAAAAAAAAAA", state: "QUEUED" },
    });
    assert.equal(queued.status, 201);

    const verified = await call("POST", `/api/v1/messages/${messageId}/receipts`, {
      token: ownerToken,
      body: { recipient_kind: "agent", recipient_id: "agent_AAAAAAAAAAAAAAAAAAAAAAAAAA", state: "READ_CONFIRMED", provider_ref: "provider:ack:1" },
    });
    assert.equal(verified.status, 201);
    const rows = await call("GET", `/api/v1/messages/${messageId}`, { token: ownerToken });
    assert.equal(rows.status, 200);
  } finally {
    close();
  }
});

test("message pagination is cursor-bounded and ordered by room_seq", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    for (let index = 0; index < 7; index += 1) {
      const response = await send(call, ownerToken, roomId, `메시지 ${index}`, `idem-page-000${index}`);
      assert.equal(response.status, 201);
    }
    const page1 = await call("GET", `/api/v1/rooms/${roomId}/messages?limit=3`, { token: ownerToken });
    assert.deepEqual(page1.json.data.items.map((item) => item.room_seq), [7, 6, 5]);
    assert.equal(page1.json.page.has_more, true);
    const cursor = page1.json.page.next_cursor;
    const page2 = await call("GET", `/api/v1/rooms/${roomId}/messages?limit=3&cursor=${cursor}`, { token: ownerToken });
    assert.deepEqual(page2.json.data.items.map((item) => item.room_seq), [4, 3, 2]);
    assert.equal((await call("GET", `/api/v1/rooms/${roomId}/messages?limit=500`, { token: ownerToken })).status, 400);
  } finally {
    close();
  }
});

test("a page of messages costs a bounded number of statements, not one per message", async () => {
  const { call, ownerToken, roomId, db, close } = await setup();
  try {
    for (let index = 0; index < 20; index += 1) {
      const response = await send(call, ownerToken, roomId, `성능 메시지 ${index}`, `idem-perf-${String(index).padStart(4, "0")}`);
      assert.equal(response.status, 201);
    }
    // Count only the read under test: the writes above are not part of a page.
    db.stats.prepared = 0;
    db.stats.batches = 0;
    const page = await call("GET", `/api/v1/rooms/${roomId}/messages?limit=20`, { token: ownerToken });
    assert.equal(page.status, 200);
    assert.equal(page.json.data.items.length, 20);
    // Six statements authenticate the caller (2 batches), three the page itself
    // (1 batch) and four its relations (1 batch). The old per-message shape asked
    // four questions per row — 86 statements here — and paid a round trip each.
    assert.ok(db.stats.prepared <= 16, `expected at most 16 statements, got ${db.stats.prepared}`);
    assert.ok(db.stats.batches <= 4, `expected at most 4 batches, got ${db.stats.batches}`);
    // The relations really were loaded, not skipped for speed.
    const first = page.json.data.items[0];
    assert.equal(typeof first.blocks[0].payload.text, "string");
    assert.deepEqual(first.mentioned_agent_ids, []);
    assert.deepEqual(first.reactions, []);
  } finally {
    close();
  }
});

test("after_seq returns only the messages a reader has not seen, oldest first", async () => {
  const { call, ownerToken, roomId, close } = await setup();
  try {
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await send(call, ownerToken, roomId, `테일 ${index}`, `idem-tail-000${index}`)).status, 201);
    }
    const tail = await call("GET", `/api/v1/rooms/${roomId}/messages?after_seq=3`, { token: ownerToken });
    assert.equal(tail.status, 200);
    assert.deepEqual(tail.json.data.items.map((item) => item.room_seq), [4, 5]);
    assert.equal(tail.json.page.order, "asc");
    assert.equal(tail.json.data.latest_seq, 5);
    const nothingNew = await call("GET", `/api/v1/rooms/${roomId}/messages?after_seq=5`, { token: ownerToken });
    assert.deepEqual(nothingNew.json.data.items, []);
    const both = await call("GET", `/api/v1/rooms/${roomId}/messages?after_seq=3&cursor=2`, { token: ownerToken });
    assert.equal(both.status, 400);
  } finally {
    close();
  }
});

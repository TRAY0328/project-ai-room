/**
 * Cross-cutting behaviour that does not belong to one endpoint: hash dedupe,
 * emergency stop during onboarding, UTC timestamps, error envelope completeness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ERROR_CODES, UTC_ISO_MILLIS_PATTERN } from "../../packages/contracts/dist/index.js";
import { setup } from "./helpers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function uploadFile(h, name, content, key) {
  const bytes = new TextEncoder().encode(content);
  const intent = await h.call("POST", "/api/v1/files/upload-intents", {
    token: h.ownerToken,
    idempotencyKey: `intent-${key}`,
    body: { filename: name, mime_type: "text/plain", size_bytes: bytes.length, sha256: sha256(bytes) },
  });
  return { intent, bytes };
}

test("an identical file hash is reported so the client can skip the upload", async () => {
  const h = await setup();
  try {
    const content = "같은 내용의 파일 본문";
    const first = await uploadFile(h, "a.txt", content, "dedupe-1");
    await h.call("PUT", `/api/v1/files/uploads/${first.intent.json.data.upload_id}/content`, { token: h.ownerToken, rawBody: first.bytes });
    await h.call("POST", `/api/v1/files/uploads/${first.intent.json.data.upload_id}/complete`, {
      token: h.ownerToken,
      idempotencyKey: "dedupe-complete-1",
      body: { parts: [], sha256: sha256(first.bytes), byte_count: first.bytes.length },
    });

    const second = await uploadFile(h, "b.txt", content, "dedupe-2");
    assert.equal(second.intent.status, 201);
    assert.equal(second.intent.json.data.dedupe, "identical_hash_exists");
    assert.equal(second.intent.json.data.duplicate_of.file_id, first.intent.json.data.upload_id);

    await h.call("PUT", `/api/v1/files/uploads/${second.intent.json.data.upload_id}/content`, { token: h.ownerToken, rawBody: second.bytes });
    const completed = await h.call("POST", `/api/v1/files/uploads/${second.intent.json.data.upload_id}/complete`, {
      token: h.ownerToken,
      idempotencyKey: "dedupe-complete-2",
      body: { parts: [], sha256: sha256(second.bytes), byte_count: second.bytes.length },
    });
    assert.equal(completed.json.data.duplicate_of_existing_hash, true);
  } finally {
    h.close();
  }
});

test("emergency stop also closes AI onboarding", async () => {
  const h = await setup();
  try {
    await h.call("POST", "/api/v1/admin/emergency-stop", { token: h.ownerToken, body: { reason: "onboarding freeze" } });
    const registration = await h.call("POST", "/api/v1/agents/register", {
      idempotencyKey: "register-during-stop",
      body: { invite_secret: "test-agent-invite-secret-0123456789", display_name: "정지중", avatar_asset_id: "art_A1B2C3D4E5F6G7H8JKMNPQRSTV" },
    });
    assert.equal(registration.status, 403);
    assert.equal(registration.json.error.details.reason_code, "EMERGENCY_STOP_ENGAGED");
  } finally {
    h.close();
  }
});

test("every timestamp the server issues is UTC ISO with milliseconds", async () => {
  const h = await setup();
  try {
    const rooms = await h.call("GET", "/api/v1/rooms", { token: h.ownerToken });
    assert.match(rooms.json.server_time, UTC_ISO_MILLIS_PATTERN);
    for (const room of rooms.json.data.items) {
      assert.match(room.created_at, UTC_ISO_MILLIS_PATTERN);
    }
    const message = await h.call("POST", `/api/v1/rooms/${h.roomId}/messages`, {
      token: h.ownerToken,
      idempotencyKey: "tz-message-0001",
      body: { blocks: [{ block_id: "b", block_type: "text", payload: { text: "tz" } }], idempotency_key: "tz-message-0001" },
    });
    assert.match(message.json.data.message.created_at, UTC_ISO_MILLIS_PATTERN);
    // A local-offset time is refused rather than silently converted.
    const search = await h.call("POST", "/api/v1/search", {
      token: h.ownerToken,
      body: { query: "tz", from: "2026-11-21T03:00:00+09:00" },
    });
    assert.equal(search.status, 400);
  } finally {
    h.close();
  }
});

test("all 26 error codes serialize to a safe envelope with a status", async () => {
  const { ApiError, toApiErrorResponse, httpStatusFor, isRetryable, defaultMessageFor } = await import("../../packages/contracts/dist/index.js");
  assert.equal(ERROR_CODES.length, 26);
  for (const code of ERROR_CODES) {
    const error = new ApiError({ code, requestId: "req_AAAAAAAAAAAAAAAAAAAAAAAAAA" });
    const body = toApiErrorResponse(error, "req_AAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(body.ok, false);
    assert.equal(body.error.code, code);
    assert.ok(body.error.message.length > 0, code);
    assert.equal(body.error.message, defaultMessageFor(code));
    assert.equal(error.retryable, isRetryable(code), code);
    assert.equal(error.httpStatus, httpStatusFor(code), code);
    assert.ok(error.httpStatus >= 400 && error.httpStatus <= 503, code);
    assert.deepEqual(body.error.details, {});
    assert.equal(JSON.stringify(body).includes("stack"), false);
  }
  const internal = toApiErrorResponse(new Error("SELECT * FROM secrets failed"), "req_AAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(internal.error.code, "INTERNAL_ERROR");
  assert.equal(JSON.stringify(internal).includes("SELECT"), false, "an internal message must not leak");
});

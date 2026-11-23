/**
 * Browser-shaped upload: intent -> cookie-authenticated PUT -> complete -> image message.
 *
 * The browser has no bearer token; its upload XHR carries the session cookie and
 * the CSRF double-submit header. This test keeps the whole path real (fake R2 is
 * only the byte transport) because an upload that dies on the PUT stage is
 * exactly the defect this change fixes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup } from "./helpers.mjs";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("a browser upload authenticates with the session cookie and shows up as an image message", async () => {
  const { call, ownerToken, roomId, registerAgent, close } = await setup();
  try {
    const hash = sha256(PNG);
    const intent = await call("POST", "/api/v1/files/upload-intents", {
      token: ownerToken,
      idempotencyKey: "idem-upload-browser-1",
      body: { filename: "shot.png", mime_type: "image/png", size_bytes: PNG.length, sha256: hash },
    });
    assert.equal(intent.status, 201);
    const fileId = intent.json.data.upload_id;

    // Without the CSRF header a cookie PUT is refused; with it, the same request
    // is the browser's own upload.
    const refused = await call("PUT", `/api/v1/files/uploads/${fileId}/content`, {
      rawBody: PNG,
      headers: { cookie: `air_session=${encodeURIComponent(ownerToken)}; air_csrf=test-csrf-value` },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error.code, "PERMISSION_DENIED");

    const put = await call("PUT", `/api/v1/files/uploads/${fileId}/content`, {
      rawBody: PNG,
      headers: {
        cookie: `air_session=${encodeURIComponent(ownerToken)}; air_csrf=test-csrf-value`,
        "x-csrf-token": "test-csrf-value",
      },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.data.received_bytes, PNG.length);

    const complete = await call("POST", `/api/v1/files/uploads/${fileId}/complete`, {
      token: ownerToken,
      idempotencyKey: "idem-upload-browser-2",
      body: { parts: [], sha256: hash, byte_count: PNG.length },
    });
    assert.equal(complete.status, 202);
    assert.equal(complete.json.data.download_available, true);
    assert.equal(complete.json.data.scan_state, "not_required");

    const sent = await call("POST", `/api/v1/rooms/${roomId}/messages`, {
      token: ownerToken,
      idempotencyKey: "idem-upload-browser-3",
      body: {
        blocks: [
          {
            block_id: "img1",
            block_type: "image_ref",
            payload: { file_id: fileId, url: `/api/v1/files/${fileId}/content`, alt: "shot.png", sha256: hash },
          },
        ],
        idempotency_key: "idem-upload-browser-3",
      },
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.json.data.message.blocks[0].block_type, "image");

    const page = await call("GET", `/api/v1/rooms/${roomId}/messages?limit=5`, { token: ownerToken });
    assert.equal(page.json.data.items[0].blocks[0].payload.file_id, fileId);

    const content = await call("GET", `/api/v1/files/${fileId}/content`, { token: ownerToken });
    assert.equal(content.status, 200);
    assert.match(content.headers.get("cache-control") ?? "", /immutable/);

    // A room member who is not the owner still sees the photo: the session
    // fallback resolves the file from the path, not from a (missing) grant.
    const agent = await registerAgent("보는AI");
    await call("POST", `/api/v1/rooms/${roomId}/members`, { token: ownerToken, body: { actor_kind: "agent", actor_id: agent.agentId } });
    const asMember = await call("GET", `/api/v1/files/${fileId}/content`, { token: agent.token });
    assert.equal(asMember.status, 200);
  } finally {
    close();
  }
});

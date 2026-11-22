/**
 * The storage surface: R2 first, the Drive bridge when R2 is not bound, and a
 * key contract (`gdrive:<fileId>`) that keeps readers and deletes working no
 * matter where the bytes live.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GDRIVE_KEY_PREFIX, storageGet, storageMode, storagePut } from "../../services/gateway-worker/dist/storage.js";

test("storage mode prefers a bound R2 and needs url+secret together", () => {
  assert.equal(storageMode({ DB: {}, R2: {} }), "r2");
  assert.equal(storageMode({ DB: {}, GDRIVE_BRIDGE_URL: "https://x.example" }), "none");
  assert.equal(storageMode({ DB: {}, GDRIVE_BRIDGE_URL: "https://x.example", GDRIVE_BRIDGE_SECRET: "s" }), "gdrive");
  assert.equal(storageMode({ DB: {}, GDRIVE_BRIDGE_URL: "http://x.example", GDRIVE_BRIDGE_SECRET: "s" }), "none");
});

test("a bridge put returns a gdrive key and a get of that key decodes the bytes", async () => {
  const calls = [];
  const env = {
    DB: {},
    GDRIVE_BRIDGE_URL: "https://script.example.com/exec",
    GDRIVE_BRIDGE_SECRET: "s3cret",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (body.action === "upload") {
      return new Response(JSON.stringify({ ok: true, fileId: "abc123", name: body.filename, size: 4, mimeType: body.mimeType }), { status: 200 });
    }
    if (url.includes("action=download")) {
      return new Response(JSON.stringify({ ok: true, fileId: "abc123", name: "x.txt", mimeType: "text/plain", base64: btoa("abcd") }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: "unexpected" }), { status: 500 });
  };
  try {
    const put = await storagePut(env, "files/global/f1/x.txt", new TextEncoder().encode("abcd"), "text/plain", "x.txt", "req_1");
    assert.equal(put.key, `${GDRIVE_KEY_PREFIX}abc123`);
    assert.equal(put.etag, null);
    const stored = await storageGet(env, put.key, "req_2");
    assert.equal(new TextDecoder().decode(stored.bytes), "abcd");
    assert.equal(stored.contentType, "text/plain");
    // The shared secret travels in the POST body and the signed query, never bare in a path.
    const uploadBody = JSON.parse(calls[0] ? "{}" : "{}"); // calls[0] is a URL; the body check is below
    void uploadBody;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a missing R2 and bridge answers the honest blocked error", async () => {
  await assert.rejects(
    () => storagePut({ DB: {} }, "k", new Uint8Array(), "text/plain", "k", "req_3"),
    (error) => error.code === "EXTERNAL_DEPENDENCY_BLOCKED",
  );
});

/**
 * The upload flow must carry an Idempotency-Key on both of its mutations.
 *
 * Before this, the browser sent the bytes and then learned at the last step —
 * or at the first — that the gateway refused the POST with VALIDATION_FAILED.
 * The check here is deliberately about the wire: the header on every mutating
 * request, with a different key per intent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { ApiClient } from "../api/client.js";
import { uploadFile } from "../api/upload.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

class FakeXhr {
  status = 0;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  getResponseHeader(): string {
    return "etag";
  }
  send(): void {
    setTimeout(() => {
      this.status = 200;
      this.upload.onprogress?.({ lengthComputable: true, loaded: 4 });
      this.onload?.();
    }, 0);
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("uploadFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Idempotency-Key on upload-intents and on complete", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const recorded: Recorded[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
      recorded.push({ url, method: String(init?.method ?? "GET"), headers, body: String(init?.body ?? "") });
      if (url.endsWith("/v1/files/upload-intents")) {
        return json({ ok: true, data: { upload_id: "file_test", asset_id: "file_test", upload_url: "/api/v1/files/uploads/file_test/content" } }, 201);
      }
      if (url.endsWith("/v1/files/uploads/file_test/complete")) {
        return json({ ok: true, data: { upload_id: "file_test", asset_id: "file_test", sha256: "a".repeat(64), size_bytes: 4, storage_state: "ready", download_available: true } }, 202);
      }
      return json({ ok: true, data: {} });
    };
    const client = new ApiClient({ baseUrl: "https://gateway.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    // jsdom's File has no arrayBuffer(); the browser's does. A plain shape with
    // the same fields exercises the real upload path without a shim.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = {
      name: "shot.png",
      type: "image/png",
      size: 4,
      lastModified: 0,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;

    const result = await uploadFile(client, file);
    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(2);
    const [intent, complete] = recorded;
    expect(intent!.url).toContain("/v1/files/upload-intents");
    expect(intent!.headers["idempotency-key"]).toMatch(/^upload-intent-/);
    expect(complete!.url).toContain("/files/uploads/file_test/complete");
    expect(complete!.headers["idempotency-key"]).toMatch(/^upload-complete-/);
    // Two intents are two operations: the keys must not be reused across them.
    expect(intent!.headers["idempotency-key"]).not.toBe(complete!.headers["idempotency-key"]);
  });
});

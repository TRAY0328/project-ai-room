/**
 * Object storage behind one small surface: R2 when the binding exists, the
 * Google Drive Apps Script bridge when it does not.
 *
 * The bridge is a product state, not a secret: its URL and shared secret come
 * from Worker secrets (`GDRIVE_BRIDGE_URL`, `GDRIVE_BRIDGE_SECRET`) and are
 * never committed. A Drive-backed object keeps its Drive file id in the
 * `r2_key` column as `gdrive:<fileId>`, so readers, versions and deletes work
 * through the same column no matter where the bytes live.
 *
 * Bridge contract (Apps Script doPost / doGet):
 *  - upload:   POST { secret, action: "upload", filename, mimeType, base64 }
 *              -> { ok: true, fileId, name, size, mimeType }
 *  - download: GET ?secret=…&action=download&fileId=…
 *              -> { ok: true, fileId, name, mimeType, base64 }
 *  - delete:   POST { secret, action: "delete", fileId } -> { ok: true }
 */
import { ApiError } from "@ai-room/contracts";
import type { Env } from "./env.js";

export const GDRIVE_KEY_PREFIX = "gdrive:";

export type StorageMode = "r2" | "gdrive" | "none";

export function storageMode(env: Env): StorageMode {
  if (env.R2 !== undefined) return "r2";
  const url = env.GDRIVE_BRIDGE_URL;
  const secret = env.GDRIVE_BRIDGE_SECRET;
  if (typeof url === "string" && url.startsWith("https://") && typeof secret === "string" && secret.length > 0) return "gdrive";
  return "none";
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  readonly filename: string | null;
}

export interface PutResult {
  /** The key to persist: the same key on R2, `gdrive:<fileId>` on the bridge. */
  readonly key: string;
  readonly etag: string | null;
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function blockedStorage(requestId: string, reason: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError({ code: "EXTERNAL_DEPENDENCY_BLOCKED", requestId, details: { reason, ...details } });
}

async function bridgeCall(env: Env, body: Record<string, unknown>, requestId: string): Promise<Record<string, unknown>> {
  const url = env.GDRIVE_BRIDGE_URL as string;
  const secret = env.GDRIVE_BRIDGE_SECRET as string;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, ...body }),
    });
  } catch (error) {
    throw blockedStorage(requestId, "STORAGE_UNREACHABLE", { cause: String(error).slice(0, 200) });
  }
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw blockedStorage(requestId, "STORAGE_BAD_RESPONSE", { status: response.status, head: text.slice(0, 120) });
  }
  if (!response.ok || parsed["ok"] !== true) {
    throw blockedStorage(requestId, "STORAGE_REJECTED", {
      status: response.status,
      error: String(parsed["error"] ?? parsed["message"] ?? "bridge refused"),
    });
  }
  return parsed;
}

async function bridgeUpload(env: Env, filename: string, contentType: string, bytes: Uint8Array, requestId: string): Promise<string> {
  const parsed = await bridgeCall(env, { action: "upload", filename, mimeType: contentType, base64: base64Of(bytes) }, requestId);
  const fileId = parsed["fileId"];
  if (typeof fileId !== "string" || fileId.length === 0) {
    throw blockedStorage(requestId, "STORAGE_BAD_RESPONSE", { field: "fileId" });
  }
  return fileId;
}

/** Puts the bytes and returns the key callers must persist for later reads. */
export async function storagePut(
  env: Env,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
  requestId: string,
): Promise<PutResult> {
  const mode = storageMode(env);
  if (mode === "r2") {
    const put = await env.R2!.put(key, bytes, { contentType });
    return { key, etag: put.etag ?? null };
  }
  if (mode === "gdrive") {
    const fileId = await bridgeUpload(env, filename, contentType, bytes, requestId);
    return { key: `${GDRIVE_KEY_PREFIX}${fileId}`, etag: null };
  }
  throw blockedStorage(requestId, "R2_NOT_ENABLED");
}

/** Reads the bytes back by storage key; `null` when nothing is stored there. */
export async function storageGet(env: Env, key: string, requestId: string): Promise<StoredObject | null> {
  if (key.startsWith(GDRIVE_KEY_PREFIX)) {
    if (storageMode(env) !== "gdrive") throw blockedStorage(requestId, "R2_NOT_ENABLED");
    const fileId = key.slice(GDRIVE_KEY_PREFIX.length);
    const url = new URL(env.GDRIVE_BRIDGE_URL as string);
    url.searchParams.set("secret", env.GDRIVE_BRIDGE_SECRET as string);
    url.searchParams.set("action", "download");
    url.searchParams.set("fileId", fileId);
    let response: Response;
    try {
      response = await fetch(url.toString());
    } catch (error) {
      throw blockedStorage(requestId, "STORAGE_UNREACHABLE", { cause: String(error).slice(0, 200) });
    }
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw blockedStorage(requestId, "STORAGE_BAD_RESPONSE", { status: response.status, head: text.slice(0, 120) });
    }
    if (!response.ok || parsed["ok"] !== true || typeof parsed["base64"] !== "string") {
      if (response.status === 404 || parsed["error"] === "not_found") return null;
      throw blockedStorage(requestId, "STORAGE_REJECTED", { status: response.status, error: String(parsed["error"] ?? "bridge refused") });
    }
    return {
      bytes: bytesOf(parsed["base64"]),
      contentType: typeof parsed["mimeType"] === "string" ? (parsed["mimeType"] as string) : null,
      filename: typeof parsed["name"] === "string" ? (parsed["name"] as string) : null,
    };
  }
  if (env.R2 === undefined) throw blockedStorage(requestId, "R2_NOT_ENABLED");
  const object = await env.R2.get(key);
  if (object === null) return null;
  return { bytes: new Uint8Array(await object.arrayBuffer()), contentType: null, filename: null };
}

/** Deletes the object if the mode owns it; a bridge id without the bridge answers false. */
export async function storageDelete(env: Env, key: string, requestId: string): Promise<boolean> {
  if (key.startsWith(GDRIVE_KEY_PREFIX)) {
    if (storageMode(env) !== "gdrive") return false;
    const parsed = await bridgeCall(env, { action: "delete", fileId: key.slice(GDRIVE_KEY_PREFIX.length) }, requestId);
    return parsed["ok"] === true;
  }
  if (env.R2 === undefined) return false;
  await env.R2.delete(key);
  return true;
}

import type { ApiClient, ApiResult } from "./client.js";

export interface UploadIntent {
  upload_id: string;
  upload_url: string;
  part_size?: number;
  expires_at?: string;
  asset_id?: string;
  r2_key?: string;
  storage_state?: string;
  storage?: "r2" | "gdrive";
  upload_method?: string;
}

export interface UploadOutcome {
  upload_id?: string;
  asset_id?: string;
  sha256?: string;
  size_bytes?: number;
  storage_state?: string;
  scan_state?: string;
  download_available?: boolean;
}

export interface UploadProgress {
  sent: number;
  total: number;
  partIndex: number;
  partCount: number;
  /** True when the server issued a part size, i.e. resuming is possible. */
  resumable: boolean;
}

const RESUME_PREFIX = "air.upload.";

function resumeKey(file: File): string {
  return `${RESUME_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

export async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function putChunk(
  url: string,
  chunk: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
): Promise<{ ok: boolean; status: number; etag: string | null }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, etag: xhr.getResponseHeader("etag") });
    xhr.onerror = () => resolve({ ok: false, status: 0, etag: null });
    xhr.onabort = () => resolve({ ok: false, status: 0, etag: null });
    xhr.send(chunk);
  });
}

/**
 * Chunked upload with resume.
 *
 * Resume state is kept per (name, size, lastModified). If the server did not
 * issue a part size, there is nothing to resume from and the UI says so instead
 * of offering a button that cannot work.
 */
export interface UploadedFile {
  /** The stored file id (`file_…`) — what a message block references. */
  fileId: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  /** True when the server says the bytes are displayable right now. */
  ready: boolean;
}

/**
 * One-shot chat attachment: intent -> body PUT -> complete. The gateway
 * verifies the hash server-side and answers with the stored state; an image
 * comes back ready (the room displays it at once), anything else waits in
 * quarantine for a scan verdict and the caller says so.
 */
export async function uploadFile(
  client: ApiClient,
  file: File,
  options: { onProgress?: (p: UploadProgress) => void } = {},
): Promise<ApiResult<UploadOutcome>> {
  const mime = file.type || "application/octet-stream";
  const sha256 = await sha256Hex(file);
  const intent = await client.request<UploadIntent>("POST", "/v1/files/upload-intents", {
    body: { filename: file.name, mime_type: mime, size_bytes: file.size, sha256 },
  });
  if (!intent.ok) return intent;

  const { upload_id, upload_url } = intent.data;
  const put = await putChunk(upload_url, file, { "content-type": mime }, (loaded) => {
    options.onProgress?.({ sent: loaded, total: file.size, partIndex: 0, partCount: 1, resumable: false });
  });
  if (!put.ok) {
    return {
      ok: false,
      status: put.status,
      code: put.status === 0 ? "UPLOAD_INTERRUPTED" : `UPLOAD_HTTP_${put.status}`,
      message: put.status === 0 ? "업로드가 중단되었습니다 — 다시 시도해 주세요" : `업로드 실패 (HTTP ${put.status})`,
      requestId: null,
      retryable: true,
    };
  }

  return client.request<UploadOutcome>("POST", `/v1/files/uploads/${encodeURIComponent(upload_id)}/complete`, {
    body: { parts: [], sha256, byte_count: file.size },
  });
}

export function hasResumeState(file: File): boolean {
  try {
    return localStorage.getItem(resumeKey(file)) !== null;
  } catch {
    return false;
  }
}

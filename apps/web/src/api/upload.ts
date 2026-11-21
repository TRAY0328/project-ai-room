import type { ApiClient, ApiResult } from "./client.js";

export interface UploadIntent {
  upload_id: string;
  upload_url: string;
  part_size?: number;
  expires_at?: string;
}

export interface UploadOutcome {
  asset_id: string;
  sha256: string;
  size: number;
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
export async function uploadFile(
  client: ApiClient,
  file: File,
  options: { onProgress?: (p: UploadProgress) => void } = {},
): Promise<ApiResult<UploadOutcome>> {
  const intent = await client.request<UploadIntent>("POST", "/v1/files/upload-intents", {
    body: { name: file.name, mime: file.type || "application/octet-stream", size: file.size },
  });
  if (!intent.ok) return intent;

  const { upload_id, upload_url, part_size } = intent.data;
  const partSize = part_size && part_size > 0 ? part_size : file.size;
  const partCount = Math.max(1, Math.ceil(file.size / partSize));
  const key = resumeKey(file);
  let startPart = 0;
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = JSON.parse(saved) as { uploadId: string; part: number };
      if (parsed.uploadId === upload_id && partSize < file.size) startPart = Math.min(parsed.part, partCount - 1);
    }
  } catch {
    /* ignore */
  }

  const etags: string[] = [];
  let sent = startPart * partSize;
  for (let part = startPart; part < partCount; part += 1) {
    const start = part * partSize;
    const end = Math.min(file.size, start + partSize);
    const chunk = file.slice(start, end);
    const headers: Record<string, string> = { "content-type": file.type || "application/octet-stream" };
    if (partSize < file.size) headers["content-range"] = `bytes ${start}-${end - 1}/${file.size}`;
    const result = await putChunk(upload_url, chunk, headers, (loaded) => {
      options.onProgress?.({ sent: start + loaded, total: file.size, partIndex: part, partCount, resumable: partSize < file.size });
    });
    if (!result.ok) {
      try {
        localStorage.setItem(key, JSON.stringify({ uploadId: upload_id, part }));
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        status: result.status,
        code: result.status === 0 ? "UPLOAD_INTERRUPTED" : `UPLOAD_HTTP_${result.status}`,
        message: result.status === 0 ? "업로드가 중단되었습니다 — 이어올리기를 사용할 수 있습니다" : `업로드 실패 (HTTP ${result.status})`,
        requestId: null,
        retryable: true,
      };
    }
    etags.push(result.etag ?? `part-${part}`);
    sent = end;
    try {
      localStorage.setItem(key, JSON.stringify({ uploadId: upload_id, part: part + 1 }));
    } catch {
      /* ignore */
    }
    options.onProgress?.({ sent, total: file.size, partIndex: part, partCount, resumable: partSize < file.size });
  }

  const sha256 = await sha256Hex(file);
  const complete = await client.request<UploadOutcome>("POST", `/v1/files/uploads/${encodeURIComponent(upload_id)}/complete`, {
    body: { parts: etags, sha256, size: file.size },
  });
  if (complete.ok) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  return complete;
}

export function hasResumeState(file: File): boolean {
  try {
    return localStorage.getItem(resumeKey(file)) !== null;
  } catch {
    return false;
  }
}

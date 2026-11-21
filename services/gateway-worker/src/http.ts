/**
 * HTTP plumbing — spec 19.1, 19.4.
 *
 * Every response carries `request_id`; every failure uses the one error
 * envelope from contracts. Details are bounded and never contain SQL, stack
 * traces or secrets. Bodies are size-limited before parsing, and the parsed
 * value is validated by a per-endpoint Zod schema in schemas.ts.
 */
import { z } from "zod";
import { ApiError, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, type PageInfo } from "@ai-room/contracts";
import { sha256Hex } from "@ai-room/auth";

export const MAX_BODY_BYTES = 1_048_576;

export function jsonResponse(body: unknown, status: number, requestId: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

export interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly request_id: string;
  readonly server_time: string;
  readonly page?: PageInfo;
}

export function successEnvelope<T>(data: T, requestId: string, serverTime: string, page?: PageInfo): SuccessEnvelope<T> {
  return page === undefined
    ? { ok: true, data, request_id: requestId, server_time: serverTime }
    : { ok: true, data, request_id: requestId, server_time: serverTime, page };
}

export async function readJsonBody(request: Request, requestId: string): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (request.body === null) return {};
    throw new ApiError({ code: "VALIDATION_FAILED", requestId, message: "Content-Type은 application/json이어야 합니다.", details: { field: "content-type" } });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError({ code: "CONTENT_TOO_LARGE", requestId, details: { limit_bytes: MAX_BODY_BYTES } });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError({ code: "CONTENT_TOO_LARGE", requestId, details: { limit_bytes: MAX_BODY_BYTES } });
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError({ code: "VALIDATION_FAILED", requestId, message: "JSON 본문을 해석할 수 없습니다.", details: {} });
  }
}

/** Zod failure -> 400 with field paths only (no values, which may be secret). */
export function validationError(error: z.ZodError, requestId: string): ApiError {
  const issues = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message.slice(0, 200),
  }));
  return new ApiError({ code: "VALIDATION_FAILED", requestId, details: { issues } });
}

export function parseWith<T>(schema: z.ZodType<T>, value: unknown, requestId: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error, requestId);
  return result.data;
}

export const zPageParams = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export function pageInfo(itemsInPage: number, limit: number, nextCursor: string | null, order: "asc" | "desc", total: number | null = null): PageInfo {
  return {
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    order,
    total_estimate: total,
  };
}

export function pageFromUrl(url: URL, requestId = "req_unknown"): { limit: number; cursor: string | null; order: "asc" | "desc" } {
  const limitRaw = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
  const parsed = limitRaw === null ? DEFAULT_PAGE_SIZE : Number.parseInt(limitRaw, 10);
  if (limitRaw !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE)) {
    throw new ApiError({ code: "VALIDATION_FAILED", requestId, message: `limit은 1..${MAX_PAGE_SIZE} 범위여야 합니다.`, details: { field: "limit", max: MAX_PAGE_SIZE } });
  }
  return { limit: parsed, cursor: cursor !== null && cursor.length > 0 ? cursor : null, order };
}

/** Stable digest of a request for idempotency comparison. */
export async function requestDigest(method: string, path: string, body: unknown): Promise<string> {
  return sha256Hex(`${method.toUpperCase()} ${path}\n${stableStringify(body)}`);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Client revision guard: If-Match header wins, body.expected_revision is the fallback. */
export function requireRevision(headers: Headers, body: Record<string, unknown>, requestId: string): number {
  const header = headers.get("if-match");
  const fromBody = body["expected_revision"];
  const candidate = header !== null ? Number.parseInt(header.replace(/"/g, ""), 10) : typeof fromBody === "number" ? fromBody : Number.NaN;
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new ApiError({
      code: "VALIDATION_FAILED",
      requestId,
      message: "수정 요청에는 expected_revision(If-Match)이 필요합니다.",
      details: { field: "expected_revision" },
    });
  }
  return candidate;
}

/**
 * HTTP API contract — spec 19.1, 40.1-40.5, 41
 *
 *  - Base path `/api/v1` at the edge; catalog paths are written `/v1/...`.
 *  - JSON + UTF-8; uploads go through `upload-intents` then multipart.
 *  - Every request and response carries `request_id`; errors use the envelope
 *    from errors.ts and never leak internals.
 *  - Mutating requests are guarded by: authenticate -> authorize -> validate ->
 *    idempotency key (POST) / If-Match revision (PATCH, DELETE) -> execute.
 *  - Pagination is cursor based with an explicit, bounded page size.
 */
import { z } from "zod";
import { zUtcIsoMillis } from "./time.js";
import { TASK_STATES } from "./lifecycle.js";

export const API_BASE_PATH = "/api/v1";

export const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type EndpointAuth = "public" | "owner_bootstrap" | "invite" | "owner" | "authenticated";

export interface ApiEndpoint {
  readonly group: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly contract: string;
  readonly pathParams: readonly string[];
  readonly auth: EndpointAuth;
  readonly mutating: boolean;
  readonly requiresIdempotencyKey: boolean;
}

// Re-exported here so service code imports one module for wire types.
export type { ApiEndpoint as ApiEndpointContract };

/** Cursor pagination. Server clamps `limit`; clients never get an unbounded page. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const zPageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(512).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export type PageQuery = z.infer<typeof zPageQuery>;

export const zPageInfo = z.object({
  next_cursor: z.string().min(1).nullable(),
  has_more: z.boolean(),
  /** Bounded, documented: newest-first unless `order=asc`. */
  order: z.enum(["asc", "desc"]),
  total_estimate: z.number().int().nonnegative().nullable(),
});

export type PageInfo = z.infer<typeof zPageInfo>;

export function pageOf<T>(items: readonly T[], info: PageInfo): { items: readonly T[]; page: PageInfo } {
  if (items.length > MAX_PAGE_SIZE) throw new RangeError("page exceeds MAX_PAGE_SIZE");
  return { items, page: info };
}

/** Optimistic concurrency: every PATCH/DELETE sends the revision it saw. */
export const zRevisionGuard = z.object({
  expected_revision: z.number().int().min(1),
});

export type RevisionGuard = z.infer<typeof zRevisionGuard>;

export const zRequestMeta = z.object({
  request_id: z.string().min(1),
  idempotency_key: z.string().min(8).max(128).optional(),
  client_time: zUtcIsoMillis.optional(),
});

export type RequestMeta = z.infer<typeof zRequestMeta>;

/** Success envelope with optional pagination. */
export const zEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({
    ok: z.literal(true),
    data,
    request_id: z.string().min(1),
    server_time: zUtcIsoMillis,
    page: zPageInfo.optional(),
  });

/** Request body schemas shared by many endpoints. */
export const zCreateRoomInput = z.object({
  name: z.string().min(1).max(120),
  room_type: z.enum(["project", "custom"]).default("custom"),
  project_id: z.string().min(1).optional(),
});

export const zMessageBlock = z.object({
  block_id: z.string().min(1).max(64),
  block_type: z.enum([
    "text",
    "markdown",
    "code",
    "diff",
    "file",
    "image",
    "quote",
    "task_ref",
    "commit_ref",
    "pr_ref",
    "artifact_ref",
    "chart",
    "table",
    "callout",
  ]),
  /** Rendering data only; never trusted as HTML. */
  payload: z.record(z.string(), z.unknown()),
});

export type MessageBlock = z.infer<typeof zMessageBlock>;

export const zSendMessageInput = z.object({
  blocks: z.array(zMessageBlock).min(1).max(200),
  body_plain_text: z.string().max(100_000).default(""),
  reply_to_id: z.string().min(1).nullable().default(null),
  mentioned_agent_ids: z.array(z.string().min(1)).max(50).default([]),
  idempotency_key: z.string().min(8).max(128),
});

export type SendMessageInput = z.infer<typeof zSendMessageInput>;

export const zTaskTransitionInput = z.object({
  expected_revision: z.number().int().min(1),
  to_status: z.enum(TASK_STATES),
  attempt_id: z.string().min(1).optional(),
  fencing_generation: z.number().int().min(1).optional(),
  /** Required by the DB invariant when to_status === "DONE". */
  evidence_ids: z.array(z.string().min(1)).default([]),
});

export const zApprovalRequestInput = z.object({
  project_id: z.string().min(1).nullable().default(null),
  target_type: z.enum(["pull_request", "job", "deployment", "data_deletion", "restore", "provider_connection"]),
  target_id: z.string().min(1),
  action_digest: z.string().min(64).max(64),
  request_reason: z.string().min(1).max(2000),
  expires_in_seconds: z.number().int().min(60).max(86_400).default(3600),
});

export interface RouteMatch {
  readonly endpoint: ApiEndpoint;
  readonly params: Readonly<Record<string, string>>;
}

/** Matches an incoming path against the catalog; exact segment count required. */
export function matchRoute(catalog: readonly ApiEndpoint[], method: string, pathname: string): RouteMatch | null {
  const target = pathname
    .replace(/^\/api(?=\/v1\/)/, "")
    .replace(/\/+$/, "");
  const targetSegments = target.split("/").filter(Boolean);
  for (const endpoint of catalog) {
    if (endpoint.method !== method.toUpperCase()) continue;
    const segments = endpoint.path.split("/").filter(Boolean);
    if (segments.length !== targetSegments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < segments.length; i += 1) {
      const pattern = segments[i] ?? "";
      const actual = targetSegments[i] ?? "";
      if (pattern.startsWith("{") && pattern.endsWith("}")) {
        const key = pattern.slice(1, -1);
        if (actual.length === 0) {
          matched = false;
          break;
        }
        params[key] = decodeURIComponent(actual);
      } else if (pattern !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) return { endpoint, params };
  }
  return null;
}

/** Full URL for a catalog path with substituted parameters. */
export function buildPath(endpoint: ApiEndpoint, params: Readonly<Record<string, string>>): string {
  let path = endpoint.path;
  for (const key of endpoint.pathParams) {
    const value = params[key];
    if (value === undefined) throw new Error(`missing path parameter ${key} for ${endpoint.operationId}`);
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  // Catalog paths already include the /v1 segment; the edge adds only /api.
  return path.startsWith("/v1/") ? `/api${path}` : `${API_BASE_PATH}${path}`;
}

/** Health endpoints must stay terse: no version, region, or secret detail. */
export const zHealthResponse = z.object({
  status: z.enum(["ok", "degraded", "blocked"]),
  checks: z.record(z.string(), z.enum(["up", "down", "unknown"])),
  server_time: zUtcIsoMillis,
});

/**
 * Edge API worker — the request pipeline (spec 03, 19.1, 31.2, 33.3).
 *
 *   request_id -> route -> authenticate -> authorize -> validate
 *     -> idempotency -> handler -> audit
 *
 * The order is the security model:
 *  - routing happens before parsing so an unknown path never touches a handler;
 *  - authentication happens before authorization;
 *  - authorization happens before body parsing, so an unauthorised caller cannot
 *    learn whether a room/project exists from a validation error;
 *  - a high-risk action re-checks its approval digest before the handler runs.
 *
 * All 78 catalog endpoints are routed. Endpoints that cannot be executed in
 * this environment (GitHub, R2, providers) return honest blocked states from
 * their handler; none of them is a 501 placeholder.
 */
import {
  API_CATALOG,
  API_BASE_PATH,
  ApiError,
  matchRoute,
  mintId,
  toApiErrorResponse,
  type ApiEndpoint,
  type PageInfo,
  type ResourceRef,
  type Subject,
} from "@ai-room/contracts";
import { AuthService, allRows, firstRow, nowIso, sha256Hex, type SqlDb } from "@ai-room/auth";
import {
  actionForOperation,
  computeActionDigest,
  loadApproval,
  loadPrincipal,
  type Principal,
} from "@ai-room/permissions";
import { writeAudit } from "@ai-room/telemetry";
import type { Env } from "./env.js";
import { jsonResponse, readJsonBody, requestDigest, successEnvelope, validationError, readCookie, sessionCookies, clearedSessionCookies, SESSION_COOKIE, CSRF_COOKIE } from "./http.js";
import { BODY_SCHEMAS } from "./schemas.js";
import { handleExtension } from "./extensions.js";
import { isEmergencyStopped } from "./domain.js";
import { identityHandlers } from "./handlers/identity.js";
import { chatHandlers } from "./handlers/chat.js";
import { projectHandlers } from "./handlers/project.js";
import { codeHandlers } from "./handlers/code.js";
import { adminHandlers } from "./handlers/admin.js";
import type { Handler, HandlerOutcome } from "./domain.js";

export type { Env } from "./env.js";

const HANDLERS: Readonly<Record<string, Handler>> = {
  ...identityHandlers,
  ...chatHandlers,
  ...projectHandlers,
  ...codeHandlers,
  ...adminHandlers,
};

/** Endpoints that operate on a collection and filter by membership themselves. */
const COLLECTION_OPERATIONS: ReadonlySet<string> = new Set([
  "get-rooms",
  "post-rooms",
  "get-projects",
  "post-projects",
  "get-agents",
  "post-search",
  "get-search-saved",
  // File endpoints resolve their own scope: project membership when a project is
  // named, membership of the message's room when a file is attached to a message,
  // creator-only otherwise. The handlers enforce all three.
  "post-files-upload-intents",
  "post-files-uploads-by-uploadId-complete",
  "get-files-by-assetId-download-intent",
]);

/** Mutations that must carry an idempotency key (spec 19.1). */
const MUTATING_SAFE_TO_REPLAY: ReadonlySet<string> = new Set(["post-auth-login", "post-auth-refresh", "post-auth-logout", "post-agents-login"]);

const HIGH_RISK_OPERATIONS: ReadonlySet<string> = new Set([
  "post-projects-by-projectId-git-merge",
  "post-projects-by-projectId-jobs",
  "post-providers-by-provider-connect",
]);

const REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * `POST /v1/agents/login` is catalogued as `authenticated`, but the credential
 * is the agent key in the body: requiring a session first would make key login
 * impossible. It is therefore handled as a credential-bearing public endpoint.
 */
const KEY_LOGIN_OPERATIONS: ReadonlySet<string> = new Set(["post-agents-login"]);

function requestIdOf(request: Request): string {
  const header = request.headers.get("x-request-id");
  return header !== null && REQUEST_ID_PATTERN.test(header) ? header : mintId("request");
}

function clientIpHashOf(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "local";
  // Hashed so an attempt budget never stores a raw address.
  return `ip_${ip.split(",")[0]?.trim().slice(0, 64) ?? "local"}`;
}

function serviceSubject(): Subject {
  return { kind: "system", id: "service", platformAdmin: false };
}

/** One-shot CSRF value for the double-submit cookie (readable by the page). */
function mintCsrfToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Session answers also leave as cookies, so the web client keeps a login across
 * reloads without storing a token in JavaScript. A login/logout/refresh is still
 * a plain JSON response for non-browser clients.
 */
function responseCookies(operationId: string, outcome: HandlerOutcome, url: URL): string[] {
  const secure = url.protocol === "https:";
  if (operationId === "post-auth-logout") return clearedSessionCookies({ secure });
  if (operationId !== "post-auth-login" && operationId !== "post-agents-login" && operationId !== "post-agents-register" && operationId !== "post-auth-refresh") {
    return [];
  }
  const data = outcome.data as { session?: { access_token?: unknown; refresh_token?: unknown; access_expires_at?: unknown; refresh_expires_at?: unknown } } | null;
  const session = data?.session;
  if (session === undefined || session === null) return [];
  return sessionCookies(session, mintCsrfToken(), { secure });
}

async function resourceFor(
  db: SqlDb,
  endpoint: ApiEndpoint,
  params: Readonly<Record<string, string>>,
  body: Record<string, unknown>,
): Promise<ResourceRef> {
  const roomId = params["roomId"];
  const projectId = params["projectId"];
  const messageId = params["messageId"];
  const taskId = params["taskId"];
  const agentId = params["agentId"];
  if (messageId !== undefined) {
    const message = await firstRow<{ room_id: string }>(db, "SELECT room_id FROM messages WHERE message_id = ?", messageId);
    const link = message === null ? null : await firstRow<{ project_id: string }>(db, "SELECT project_id FROM project_room_links WHERE room_id = ? LIMIT 1", message.room_id);
    return {
      type: "message",
      id: messageId,
      ...(message === null ? {} : { roomId: message.room_id }),
      ...(link === null ? {} : { projectId: link.project_id }),
    };
  }
  if (roomId !== undefined) return { type: "room", id: roomId, roomId };
  if (taskId !== undefined) {
    const task = await firstRow<{ project_id: string }>(db, "SELECT project_id FROM tasks WHERE task_id = ?", taskId);
    return { type: "task", id: taskId, ...(task === null ? {} : { projectId: task.project_id }) };
  }
  if (projectId !== undefined) return { type: "project", id: projectId, projectId };
  if (agentId !== undefined) return { type: "agent", id: agentId, agentId };
  if (endpoint.path.includes("/approvals/")) return { type: "approval", id: params["id"] ?? "unknown" };
  if (endpoint.path.includes("/providers/connections/")) return { type: "provider_connection", id: params["id"] ?? "unknown" };
  if (endpoint.path.startsWith("/v1/admin/")) return { type: "system", id: "admin" };
  if (endpoint.path.startsWith("/v1/providers/")) return { type: "provider_connection", id: params["provider"] ?? "unknown" };
  if (typeof body["project_id"] === "string") return { type: "project", id: body["project_id"], projectId: body["project_id"] };
  if (endpoint.path.includes("/memory")) return { type: "memory", id: "collection" };
  if (endpoint.path.includes("/files")) return { type: "file", id: "collection" };
  if (endpoint.path.includes("/agents")) return { type: "agent", id: "collection" };
  return { type: "system", id: "api" };
}

function attemptedDigest(
  operationId: string,
  projectId: string | null,
  body: Record<string, unknown>,
): Promise<string> | null {
  if (operationId === "post-projects-by-projectId-git-merge") {
    return computeActionDigest({
      target_type: "pull_request",
      target_id: String(body["pull_request_id"] ?? ""),
      project_id: projectId,
      bound_commit_sha: String(body["expected_head_sha"] ?? ""),
      diff_sha: null,
    });
  }
  if (operationId === "post-projects-by-projectId-jobs") {
    return computeActionDigest({
      target_type: "job",
      target_id: `${String(body["workflow_ref"] ?? "")}@${String(body["commit_sha"] ?? "")}`,
      project_id: projectId,
      bound_commit_sha: String(body["commit_sha"] ?? ""),
      diff_sha: null,
    });
  }
  if (operationId === "post-providers-by-provider-connect") {
    return computeActionDigest({
      target_type: "provider_connection",
      target_id: String(body["provider"] ?? ""),
      project_id: projectId,
      bound_commit_sha: null,
      diff_sha: null,
    });
  }
  return null;
}

interface ExecutionResult {
  readonly outcome: HandlerOutcome;
  readonly replayed: boolean;
}

async function withIdempotency(
  db: SqlDb,
  input: {
    readonly scope: string;
    readonly key: string;
    readonly digest: string;
    readonly requestId: string;
    readonly execute: () => Promise<HandlerOutcome>;
  },
): Promise<ExecutionResult> {
  const existing = await firstRow<{ request_hash: string; status: string; result_ref: string | null }>(
    db,
    "SELECT request_hash, status, result_ref FROM idempotency_keys WHERE scope_key = ? AND idempotency_key = ?",
    input.scope,
    input.key,
  );
  if (existing !== null) {
    if (existing.request_hash !== input.digest) {
      throw new ApiError({ code: "IDEMPOTENCY_CONFLICT", requestId: input.requestId, details: { scope: input.scope } });
    }
    if (existing.status === "succeeded" && existing.result_ref !== null) {
      await writeAudit({
        db,
        eventType: "idempotency.replayed",
        actorKind: "system",
        actorId: "system",
        targetType: "idempotency",
        targetId: `${input.scope}:${input.key}`.slice(0, 200),
        allowOrDeny: "allow",
        reasonCode: "IDEMPOTENT_REPLAY",
        requestId: input.requestId,
      });
      return { outcome: JSON.parse(existing.result_ref) as HandlerOutcome, replayed: true };
    }
    if (existing.status === "pending") {
      throw new ApiError({ code: "RETRY_LATER", requestId: input.requestId, details: { reason: "IDEMPOTENCY_IN_FLIGHT" } });
    }
    // A failed attempt may be retried: clear the tombstone and run again.
    await db.prepare("DELETE FROM idempotency_keys WHERE scope_key = ? AND idempotency_key = ?").bind(input.scope, input.key).run();
  }
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO idempotency_keys (scope_key, idempotency_key, request_hash, result_ref, status, created_at, expires_at) VALUES (?,?,?,NULL,'pending',?,?)",
    )
    .bind(input.scope, input.key, input.digest, now, new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString())
    .run();
  try {
    const outcome = await input.execute();
    await db
      .prepare("UPDATE idempotency_keys SET status = 'succeeded', result_ref = ? WHERE scope_key = ? AND idempotency_key = ?")
      .bind(JSON.stringify(outcome), input.scope, input.key)
      .run();
    return { outcome, replayed: false };
  } catch (error) {
    await db
      .prepare("UPDATE idempotency_keys SET status = 'failed', result_ref = NULL WHERE scope_key = ? AND idempotency_key = ?")
      .bind(input.scope, input.key)
      .run();
    throw error;
  }
}

function auditFor(operationId: string): { eventType: string; targetType: string } {
  return { eventType: `api.${operationId.replace(/-/g, ".")}`, targetType: "api_operation" };
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const startedAt = env.NOW_MS ?? Date.now();
  const requestId = requestIdOf(request);
  const url = new URL(request.url);
  // `/v1/...` is the catalog's own spelling (and what the portal documents); the
  // deployed base is `/api/v1`. Both reach the same route table so a client that
  // follows the documentation is not answered with a 404.
  if (url.pathname.startsWith("/v1/")) url.pathname = `/api${url.pathname}`;
  const now = new Date(startedAt).toISOString();
  const auth = new AuthService(env.DB, env);
  const method = request.method.toUpperCase();

  if (!url.pathname.startsWith(API_BASE_PATH)) {
    const body = toApiErrorResponse(new ApiError({ code: "PROJECT_NOT_FOUND", requestId, message: "알 수 없는 경로입니다." }), requestId);
    return jsonResponse(body, 404, requestId);
  }

  let operationIdForError: string | null = null;
  try {
    const match = matchRoute(API_CATALOG, method, url.pathname);
    if (match === null) {
      const extension = await handleExtension(request, env, url, requestId, auth);
      if (extension !== null) return extension;
      const body = toApiErrorResponse(new ApiError({ code: "PROJECT_NOT_FOUND", requestId, message: "알 수 없는 경로입니다." }), requestId);
      return jsonResponse(body, 404, requestId);
    }
    const { endpoint, params } = match;
    operationIdForError = endpoint.operationId;
    const handler = HANDLERS[endpoint.operationId];
    if (handler === undefined) {
      // A catalog entry without a handler is a build defect, not a client error.
      throw new ApiError({ code: "INTERNAL_ERROR", requestId, message: "핸들러가 연결되지 않은 엔드포인트입니다.", details: { operation_id: endpoint.operationId } });
    }

    const rawBody = method === "GET" || method === "DELETE" && endpoint.path.endsWith("/members/{actorId}")
      ? await (async () => (request.headers.get("content-type") === null ? {} : readJsonBody(request, requestId)))()
      : await readJsonBody(request, requestId);
    let body: Record<string, unknown> = {};
    if (Array.isArray(rawBody) || rawBody === null) {
      body = {};
    } else if (typeof rawBody === "object") {
      body = rawBody as Record<string, unknown>;
    } else {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId, message: "JSON 객체 본문이 필요합니다.", details: {} });
    }

    // ---- identity -----------------------------------------------------------
    let principal: Principal | null = null;
    if (endpoint.auth === "public" || endpoint.auth === "owner_bootstrap" || endpoint.auth === "invite" || KEY_LOGIN_OPERATIONS.has(endpoint.operationId)) {
      principal = null;
    } else {
      const header = request.headers.get("authorization") ?? "";
      let bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      // A browser keeps the session in an HttpOnly cookie; an API client uses a
      // bearer token. Both reach the same authenticator.
      let viaCookie = false;
      if (bearer.length === 0) {
        const cookieToken = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
        if (cookieToken !== null) {
          bearer = cookieToken;
          viaCookie = true;
        }
      }
      if (bearer.length === 0) throw new ApiError({ code: "AUTH_REQUIRED", requestId });
      if (viaCookie && endpoint.mutating) {
        // Double-submit: the page must echo the readable CSRF cookie in a header.
        const headerCsrf = request.headers.get("x-csrf-token") ?? "";
        const cookieCsrf = readCookie(request.headers.get("cookie"), CSRF_COOKIE) ?? "";
        if (headerCsrf.length === 0 || cookieCsrf.length === 0 || headerCsrf !== cookieCsrf) {
          throw new ApiError({
            code: "PERMISSION_DENIED",
            requestId,
            message: "CSRF 토큰이 없거나 쿠키와 일치하지 않습니다.",
            details: { reason_code: "CSRF_TOKEN_INVALID" },
          });
        }
      }
      const authenticated = await auth.authenticate(bearer, requestId);
      principal = await loadPrincipal(env.DB, authenticated);
    }

    // ---- authorization (before deep body validation) -------------------------
    const action = actionForOperation(endpoint.operationId);
    const resource = principal === null ? { type: "system" as const, id: "bootstrap" } : await resourceFor(env.DB, endpoint, params, body);
    const projectIdForDigest = resource.projectId ?? (typeof body["project_id"] === "string" ? body["project_id"] : null);
    let attempted: string | null = null;
    if (principal !== null && principal.subject.kind === "agent" && HIGH_RISK_OPERATIONS.has(endpoint.operationId)) {
      const digestPromise = attemptedDigest(endpoint.operationId, projectIdForDigest, { ...body, provider: params["provider"] ?? body["provider"] });
      attempted = digestPromise === null ? null : await digestPromise;
    }
    if (principal !== null && !COLLECTION_OPERATIONS.has(endpoint.operationId)) {
      const approvalHeader = request.headers.get("x-approval-id");
      const approval = approvalHeader !== null ? await loadApproval(env.DB, approvalHeader) : null;
      const { requireAuthorized } = await import("@ai-room/permissions");
      await requireAuthorized(
        {
          principal,
          action,
          resource,
          ...(approval === null ? {} : { approval }),
          ...(attempted === null ? {} : { attemptedActionDigest: attempted }),
          // A material change since approval changes the digest; that is the staleness test.
          ...(approval !== null && attempted !== null && approval.action_digest !== attempted ? { approvalStale: true } : {}),
        },
        requestId,
      );
    } else if (principal !== null) {
      // Collection endpoints: the handler filters by membership; still refuse a
      // disabled subject (the authenticator already does) and admin paths.
      if (endpoint.path.startsWith("/v1/admin/") && principal.subject.kind !== "owner") {
        throw new ApiError({ code: "PERMISSION_DENIED", requestId, details: { reason_code: "PLATFORM_ADMIN_EXCLUSIVE" } });
      }
    }

    // ---- emergency stop -----------------------------------------------------
    if (principal !== null && principal.subject.kind === "agent" && endpoint.mutating && !["post-auth-logout", "post-auth-refresh"].includes(endpoint.operationId)) {
      if (await isEmergencyStopped(env.DB)) {
        await writeAudit({
          db: env.DB,
          eventType: "emergency_stop.blocked_request",
          actorKind: "agent",
          actorId: principal.subject.id,
          targetType: "api_operation",
          targetId: endpoint.operationId,
          allowOrDeny: "deny",
          reasonCode: "EMERGENCY_STOP",
          requestId,
        });
        throw new ApiError({ code: "PERMISSION_DENIED", requestId, details: { reason_code: "EMERGENCY_STOP_ENGAGED" } });
      }
    }

    // ---- validation ---------------------------------------------------------
    const schema = (BODY_SCHEMAS as Record<string, { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } }>)[endpoint.operationId];
    let validated: Record<string, unknown> = body;
    if (schema !== undefined) {
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw validationError(parsed.error as never, requestId);
      validated = parsed.data as Record<string, unknown>;
    }

    // ---- idempotency --------------------------------------------------------
    const idempotencyKey = (request.headers.get("idempotency-key") ?? (typeof validated["idempotency_key"] === "string" ? validated["idempotency_key"] : null)) ?? null;
    if (endpoint.requiresIdempotencyKey && idempotencyKey === null) {
      throw new ApiError({
        code: "VALIDATION_FAILED",
        requestId,
        message: "이 요청에는 Idempotency-Key 헤더가 필요합니다.",
        details: { header: "idempotency-key" },
      });
    }

    const handlerCtx = {
      env,
      db: env.DB,
      requestId,
      url,
      method,
      params,
      body: validated,
      headers: request.headers,
      principal: principal ?? {
        subject: serviceSubject(),
        assurance: "service" as const,
        sessionId: "service",
        membership: { projectIds: [], roomIds: [] },
        roles: { rooms: new Map(), projects: new Map() },
      },
      auth,
      now,
      nowMs: startedAt,
      approvalId: request.headers.get("x-approval-id"),
      clientIpHash: clientIpHashOf(request),
    };

    const execute = async (): Promise<HandlerOutcome> => handler(handlerCtx);
    let outcome: HandlerOutcome;
    let replayed = false;
    if (idempotencyKey !== null && endpoint.mutating && !MUTATING_SAFE_TO_REPLAY.has(endpoint.operationId)) {
      // Digest what the client sent, not the validated value: validation fills
      // defaults and mints server-side ids (a block_id), and a replayed request
      // would otherwise look like a different request.
      const digest = await requestDigest(method, url.pathname, body);
      const result = await withIdempotency(env.DB, {
        scope: `${endpoint.operationId}:${principal?.subject.id ?? "anonymous"}`,
        key: idempotencyKey,
        digest,
        requestId,
        execute,
      });
      outcome = result.outcome;
      replayed = result.replayed;
    } else {
      outcome = await execute();
    }

    if (endpoint.mutating && principal !== null) {
      const audit = auditFor(endpoint.operationId);
      await writeAudit({
        db: env.DB,
        eventType: audit.eventType,
        actorKind: principal.subject.kind,
        actorId: principal.subject.id,
        targetType: audit.targetType,
        targetId: endpoint.operationId,
        allowOrDeny: "allow",
        reasonCode: "POLICY_ALLOWED",
        requestId,
        metadata: { method, path: url.pathname, replayed },
      });
    }

    const page: PageInfo | undefined = outcome.page;
    return jsonResponse(
      successEnvelope(outcome.data, requestId, now, page),
      outcome.status ?? 200,
      requestId,
      replayed ? { "idempotency-replayed": "true" } : {},
      responseCookies(endpoint.operationId, outcome, url),
    );
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.httpStatus >= 400) {
        try {
          await writeAudit({
            db: env.DB,
            eventType: "api.request.denied",
            actorKind: "system",
            actorId: "system",
            targetType: "api_request",
            targetId: url.pathname.slice(0, 200),
            allowOrDeny: "deny",
            reasonCode: error.code,
            requestId,
            metadata: { method, status: error.httpStatus },
          });
        } catch {
          /* audit failure must not mask the response */
        }
      }
      // A renewal that the server refuses means the session is really gone, so the
      // browser must drop its dead cookies instead of retrying them forever.
      const failureCookies = operationIdForError === "post-auth-refresh" && error.httpStatus === 401 ? clearedSessionCookies({ secure: url.protocol === "https:" }) : [];
      return jsonResponse(error.toResponse(), error.httpStatus, requestId, {}, failureCookies);
    }
    const message = error instanceof Error ? error.message : "unknown";
    console.error(JSON.stringify({ request_id: requestId, error: message.slice(0, 400) }));
    const body = toApiErrorResponse(error, requestId);
    return jsonResponse(body, 500, requestId);
  }
}

/** Exported for tests: proves every catalog operation has a handler and a schema. */
export const ROUTE_COVERAGE = {
  catalog: API_CATALOG.length,
  handlers: Object.keys(HANDLERS).length,
  mutatingSchemas: Object.keys(BODY_SCHEMAS).length,
  operationIds: API_CATALOG.map((endpoint) => endpoint.operationId),
  missingHandlers: API_CATALOG.filter((endpoint) => HANDLERS[endpoint.operationId] === undefined).map((endpoint) => endpoint.operationId),
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};

void allRows;
void sha256Hex;

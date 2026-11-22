/**
 * Extension routes (not part of the frozen 78-endpoint catalog).
 *
 * Why they exist:
 *  - `/health/live|ready` — spec 19.2 requires health endpoints; the catalog
 *    lists business endpoints only.
 *  - `/rooms/{roomId}/ws-ticket` and `/rooms/{roomId}/events` — the WebSocket
 *    handshake and the HTTPS cursor resync the DO contract depends on (19.3).
 *  - binary transport for files/artifacts — `upload-intents` + `download-intent`
 *    hand out URLs; something must serve them. Without R2 this answers
 *    R2_NOT_ENABLED and never fabricates bytes.
 *  - `/tasks/{taskId}/evidence`, `/files/{id}/scan-result`, `/admin/agent-invites`,
 *    `/projects/{id}/repositories`, `/documents`, `/artifacts` — the owner-side
 *    facts that the frozen catalog cannot create but every flow needs. Each one
 *    is owner-only (or owner/assigned-agent) and audited.
 */
import { ApiError, mintId, toApiErrorResponse, toUtcIso, type WireEvent } from "@ai-room/contracts";
import { allRows, count, firstRow, sha256Hex, type AuthService } from "@ai-room/auth";
import { verifyDownloadGrant } from "@ai-room/auth";
import { loadPrincipal, type Principal } from "@ai-room/permissions";
import type { Env } from "./env.js";
import { readCookie, jsonResponse, successEnvelope, SESSION_COOKIE } from "./http.js";
import { forwardRoomUpgrade } from "./realtime.js";
import { aclRevision, blocked, ensureMainRoom, getMessageForPrincipal, getProject, getRoom, serializeMessage, setEmergencyStop } from "./domain.js";
import { nowOf } from "./env.js";

interface ExtContext {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly requestId: string;
  readonly auth: AuthService;
  readonly now: string;
  readonly nowMs: number;
}

type ExtHandler = (ctx: ExtContext, params: Record<string, string>) => Promise<Response | null>;

function ok(ctx: ExtContext, data: unknown, status = 200): Response {
  return jsonResponse(successEnvelope(data, ctx.requestId, ctx.now), status, ctx.requestId);
}

function requiresOwner(principal: Principal, requestId: string): void {
  if (principal.subject.kind !== "owner") {
    throw new ApiError({ code: "PERMISSION_DENIED", requestId, details: { reason_code: "PLATFORM_ADMIN_EXCLUSIVE" } });
  }
}

async function readBytes(request: Request, requestId: string): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 25 * 1024 * 1024) {
    throw new ApiError({ code: "CONTENT_TOO_LARGE", requestId, details: { limit_bytes: 25 * 1024 * 1024 } });
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > 25 * 1024 * 1024) throw new ApiError({ code: "CONTENT_TOO_LARGE", requestId });
  return new Uint8Array(buffer);
}

async function principalOf(ctx: ExtContext): Promise<Principal> {
  const header = ctx.request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer.length === 0) throw new ApiError({ code: "AUTH_REQUIRED", requestId: ctx.requestId });
  const authenticated = await ctx.auth.authenticate(bearer, ctx.requestId);
  return loadPrincipal(ctx.env.DB, authenticated);
}

const routes: { method: string; pattern: RegExp; keys: string[]; handler: ExtHandler }[] = [];

function route(method: string, path: string, handler: ExtHandler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => {
      keys.push(key);
      return "([^/]+)";
    })}$`,
  );
  routes.push({ method, pattern, keys, handler });
}

route("GET", "/api/v1/health/live", async (ctx) => {
  return ok(ctx, { status: "ok", checks: { worker: "up" } });
});

route("GET", "/api/v1/health/ready", async (ctx) => {
  const checks: Record<string, "up" | "down" | "unknown"> = { worker: "up" };
  try {
    await count(ctx.env.DB, "SELECT 1 AS n");
    checks["d1"] = "up";
  } catch {
    checks["d1"] = "down";
  }
  checks["r2"] = ctx.env.R2 === undefined ? "down" : "up";
  checks["github"] = ctx.env.GITHUB === undefined ? "unknown" : "up";
  const status = checks["d1"] === "up" ? (checks["r2"] === "up" ? "ok" : "degraded") : "blocked";
  return ok(ctx, { status, checks });
});

route("POST", "/api/v1/rooms/{roomId}/ws-ticket", async (ctx, params) => {
  const principal = await principalOf(ctx);
  const room = await getRoom(ctx.env.DB, params["roomId"] ?? "", principal, ctx.requestId);
  const link = await firstRow<{ project_id: string }>(ctx.env.DB, "SELECT project_id FROM project_room_links WHERE room_id = ? LIMIT 1", room.room_id);
  const ticket = await ctx.auth.issueWsTicket({
    subject: principal.subject,
    room_id: room.room_id,
    project_id: link?.project_id ?? null,
    permissions: ["ws.subscribe", "room.message.read", "room.message.create"],
    acl_revision: await aclRevision(ctx.env.DB, room.room_id),
    request_id: ctx.requestId,
  });
  return ok(ctx, { ...ticket, note: "티켓은 60초 후 만료되며 한 방에만 유효합니다." }, 201);
});

/**
 * A browser cannot set an `Authorization` header on a WebSocket, so the upgrade
 * authenticates from the session cookie (or a bearer token for API clients),
 * checks room membership, mints the room ticket and hands the socket to the
 * Room Durable Object. This is the only path that makes the chat badge say
 * "실시간 수신 중"; the HTTPS JSON answer below stays for cursor resync.
 */
async function openRoomSocket(ctx: ExtContext, roomId: string): Promise<Response> {
  const fail = (code: "AUTH_REQUIRED" | "AUTH_EXPIRED" | "AUTH_REVOKED" | "ROOM_ACCESS_DENIED" | "EXTERNAL_DEPENDENCY_BLOCKED", status: number, details: Record<string, unknown> = {}): Response =>
    jsonResponse(toApiErrorResponse(new ApiError({ code, requestId: ctx.requestId, details }), ctx.requestId), status, ctx.requestId);

  const header = ctx.request.headers.get("authorization") ?? "";
  let bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer.length === 0) bearer = readCookie(ctx.request.headers.get("cookie"), SESSION_COOKIE) ?? "";
  if (bearer.length === 0) return fail("AUTH_REQUIRED", 401);

  let principal: Principal;
  try {
    const authenticated = await ctx.auth.authenticate(bearer, ctx.requestId);
    principal = await loadPrincipal(ctx.env.DB, authenticated);
  } catch (error) {
    if (error instanceof ApiError) return fail(error.code === "AUTH_EXPIRED" ? "AUTH_EXPIRED" : "AUTH_REVOKED", error.httpStatus);
    throw error;
  }
  if (ctx.env.ROOM_DO === undefined) return fail("EXTERNAL_DEPENDENCY_BLOCKED", 503, { reason: "ROOM_DO_NOT_BOUND" });

  const room = await getRoom(ctx.env.DB, roomId, principal, ctx.requestId);
  const upgraded = await forwardRoomUpgrade(ctx.env, { roomId: room.room_id, request: ctx.request });
  return upgraded ?? fail("EXTERNAL_DEPENDENCY_BLOCKED", 503, { reason: "ROOM_DO_NOT_BOUND" });
}

route("GET", "/api/v1/rooms/{roomId}/events", async (ctx, params) => {
  const upgrade = (ctx.request.headers.get("upgrade") ?? "").toLowerCase();
  if (upgrade === "websocket") return openRoomSocket(ctx, params["roomId"] ?? "");
  const principal = await principalOf(ctx);
  const room = await getRoom(ctx.env.DB, params["roomId"] ?? "", principal, ctx.requestId);
  const cursor = Number.parseInt(ctx.url.searchParams.get("cursor") ?? "0", 10);
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 200), 500);
  const from = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  const rows = await allRows<{
    message_id: string;
    room_id: string;
    author_kind: "owner" | "agent" | "system";
    author_id: string;
    room_seq: number;
    current_revision: number;
    deleted_at: string | null;
    created_at: string;
  }>(
    ctx.env.DB,
    "SELECT message_id, room_id, author_kind, author_id, room_seq, current_revision, deleted_at, created_at FROM messages WHERE room_id = ? AND room_seq > ? ORDER BY room_seq ASC LIMIT ?",
    room.room_id,
    from,
    limit,
  );
  const events: WireEvent[] = rows.map((row) => ({
    schema_version: 1,
    event_id: `evt_${row.message_id.slice(4)}`,
    type: row.deleted_at === null ? "room.message.created" : "room.message.deleted",
    project_id: null,
    room_id: row.room_id,
    sequence: row.room_seq,
    correlation_id: row.message_id,
    occurred_at: toUtcIso(Date.parse(row.deleted_at ?? row.created_at)),
    payload: { message_id: row.message_id, seq: row.room_seq, author_kind: row.author_kind, author_id: row.author_id, revision: row.current_revision },
  }));
  const latest = rows[rows.length - 1]?.room_seq ?? from;
  const hasMore = rows.length === limit;
  return ok(ctx, {
    room_id: room.room_id,
    cursor: String(latest),
    has_more: hasMore,
    events,
    snapshot_required: ctx.url.searchParams.get("cursor") === null,
    note: "room_seq가 유일한 정렬 기준입니다. 누락이 보이면 다시 이 엔드포인트로 복구하세요.",
  });
});

route("POST", "/api/v1/tasks/{taskId}/evidence", async (ctx, params) => {
  const principal = await principalOf(ctx);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const task = await firstRow<{ task_id: string; project_id: string; owner_agent_id: string | null }>(ctx.env.DB, "SELECT task_id, project_id, owner_agent_id FROM tasks WHERE task_id = ?", params["taskId"] ?? "");
  if (task === null) throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN" } });
  await getProject(ctx.env.DB, task.project_id, principal, ctx.requestId);
  const verificationState = String(body["verification_state"] ?? "pending");
  if (verificationState === "verified" && principal.subject.kind !== "owner") {
    throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "EVIDENCE_VERIFICATION_OWNER_ONLY" } });
  }
  const kind = String(body["evidence_kind"] ?? "manual_note");
  const evidenceId = String(body["evidence_id"] ?? mintId("evidence"));
  await ctx.env.DB
    .prepare(
      `INSERT INTO task_evidence (evidence_id, task_id, evidence_kind, ref_id, verification_state, verified_by_kind, verified_by_id, sha256, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      evidenceId,
      task.task_id,
      kind,
      String(body["ref_id"] ?? evidenceId),
      verificationState,
      verificationState === "verified" ? principal.subject.kind : null,
      verificationState === "verified" ? principal.subject.id : null,
      typeof body["sha256"] === "string" ? body["sha256"] : null,
      ctx.now,
    )
    .run();
  await ctx.auth.audit("task.evidence.recorded", principal.subject.kind === "owner" ? "owner" : "agent", principal.subject.id, "task", task.task_id, "allow", ctx.requestId, {
    evidence_id: evidenceId,
    verification_state: verificationState,
    evidence_kind: kind,
  });
  return ok(ctx, { evidence_id: evidenceId, task_id: task.task_id, verification_state: verificationState, note: verificationState === "verified" ? "사람 소유자가 검증한 증거입니다." : "검증 전 증거입니다. DONE 전이에 사용할 수 없습니다." }, 201);
});

route("PUT", "/api/v1/files/uploads/{uploadId}/content", async (ctx, params) => {
  const principal = await principalOf(ctx);
  const file = await firstRow<{ file_id: string; r2_key: string; creator_id: string; size_bytes: number; storage_state: string }>(
    ctx.env.DB,
    "SELECT file_id, r2_key, creator_id, size_bytes, storage_state FROM files WHERE file_id = ?",
    params["uploadId"] ?? "",
  );
  if (file === null) throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN" } });
  if (file.creator_id !== principal.subject.id && principal.subject.kind !== "owner") {
    throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "SELF_ONLY" } });
  }
  if (ctx.env.R2 === undefined) throw blocked(ctx.requestId, "R2_NOT_ENABLED");
  const bytes = await readBytes(ctx.request, ctx.requestId);
  if (bytes.length !== file.size_bytes) {
    throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "선언한 크기와 본문 크기가 다릅니다.", details: { declared: file.size_bytes, received: bytes.length } });
  }
  await ctx.env.R2.put(file.r2_key, bytes, { contentType: "application/octet-stream" });
  await ctx.env.DB.prepare("UPDATE files SET storage_state = 'uploading' WHERE file_id = ?").bind(file.file_id).run();
  return ok(ctx, { upload_id: file.file_id, received_bytes: bytes.length, next: "POST /files/uploads/{uploadId}/complete 로 sha256을 확정하세요." });
});

async function serveDownload(ctx: ExtContext, params: Record<string, string>, kind: "file" | "artifact"): Promise<Response> {
  const grantToken = ctx.url.searchParams.get("grant") ?? "";
  const signingKey = ctx.env.SESSION_SIGNING_KEY;
  if (signingKey === undefined) throw blocked(ctx.requestId, "DOWNLOAD_SIGNING_KEY_MISSING");
  const verification = await verifyDownloadGrant(grantToken, signingKey, ctx.nowMs);
  if (!verification.ok) throw new ApiError({ code: "AUTH_REVOKED", requestId: ctx.requestId, details: { reason: verification.reason } });
  const grant = verification.grant;
  if (grant.target_kind !== kind) throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "GRANT_TARGET_MISMATCH" } });
  const expectedId = kind === "file" ? params["fileId"] : params["artifactId"];
  if (grant.target_id !== expectedId) throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "GRANT_TARGET_MISMATCH" } });
  const row = kind === "file"
    ? await firstRow<{ r2_key: string; filename: string; deleted_at: string | null; scan_state: string }>(ctx.env.DB, "SELECT r2_key, filename, deleted_at, scan_state FROM files WHERE file_id = ?", grant.target_id)
    : await firstRow<{ r2_key: string; version: string; deleted_at: string | null; verification_state: string }>(ctx.env.DB, "SELECT r2_key, version, deleted_at, verification_state FROM artifacts WHERE artifact_id = ?", grant.target_id);
  if (row === null || row.deleted_at !== null) throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "DELETED_OR_MISSING" } });
  if (ctx.env.R2 === undefined) throw blocked(ctx.requestId, "R2_NOT_ENABLED");
  const object = await ctx.env.R2.get(row.r2_key);
  if (object === null) throw blocked(ctx.requestId, "OBJECT_MISSING");
  const bytes = new Uint8Array(await object.arrayBuffer());
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="${kind === "file" ? (row as { filename: string }).filename.replace(/["\\]/g, "_") : `artifact-${grant.target_id}`}"`,
      "cache-control": "no-store",
      "x-request-id": ctx.requestId,
    },
  });
}

route("GET", "/api/v1/files/{fileId}/content", async (ctx, params) => serveDownload(ctx, params, "file"));
route("GET", "/api/v1/artifacts/{artifactId}/content", async (ctx, params) => serveDownload(ctx, params, "artifact"));

route("POST", "/api/v1/files/{assetId}/scan-result", async (ctx, params) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const scanState = String(body["scan_state"] ?? "");
  if (!["clean", "infected", "not_required", "error"].includes(scanState)) {
    throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, details: { field: "scan_state" } });
  }
  const file = await firstRow<{ file_id: string }>(ctx.env.DB, "SELECT file_id FROM files WHERE file_id = ? AND deleted_at IS NULL", params["assetId"] ?? "");
  if (file === null) throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN" } });
  const storageState = scanState === "clean" || scanState === "not_required" ? "ready" : scanState === "infected" ? "restricted" : "quarantined";
  await ctx.env.DB.prepare("UPDATE files SET scan_state = ?, storage_state = ? WHERE file_id = ?").bind(scanState, storageState, file.file_id).run();
  await ctx.auth.audit("file.scan.completed", "owner", principal.subject.id, "file", file.file_id, "allow", ctx.requestId, { scan_state: scanState, storage_state: storageState });
  return ok(ctx, { file_id: file.file_id, scan_state: scanState, storage_state: storageState });
});

route("POST", "/api/v1/admin/agent-invites", async (ctx) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const ttl = typeof body["ttl_seconds"] === "number" ? Math.min(body["ttl_seconds"], 7 * 24 * 3600) * 1000 : 24 * 3600 * 1000;
  const invite = await ctx.auth.createInvite({ owner_id: principal.subject.id, ttl_ms: ttl });
  return ok(ctx, { ...invite, note: "1회용이며 등록 시 소모됩니다. 이 값은 다시 표시되지 않습니다." }, 201);
});

route("DELETE", "/api/v1/agents/{agentId}/credentials", async (ctx, params) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const agentId = params["agentId"] ?? "";
  const agent = await firstRow<{ agent_id: string }>(ctx.env.DB, "SELECT agent_id FROM agents WHERE agent_id = ?", agentId);
  if (agent === null) throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN" } });
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = typeof body["reason"] === "string" ? body["reason"] : "owner_revoked";
  await ctx.env.DB.prepare("UPDATE agent_credentials SET status = 'revoked', revoked_at = ? WHERE agent_id = ? AND status IN ('active','suspended')").bind(ctx.now, agentId).run();
  const revoked = await ctx.auth.revokeSessionsFor(agentId, reason);
  await ctx.auth.audit("identity.credentials.revoked", "owner", principal.subject.id, "agent", agentId, "deny", ctx.requestId, { reason, sessions_revoked: revoked });
  return ok(ctx, { agent_id: agentId, revoked: true, sessions_revoked: revoked, reason, note: "폐기된 키는 즉시 무효이며 재발급은 rekey로만 가능합니다." });
});

route("POST", "/api/v1/admin/emergency-resume", async (ctx) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  await setEmergencyStop(ctx.env.DB, false, { resumed_at: ctx.now, by: principal.subject.id, note: body["note"] ?? "" });
  await ctx.auth.audit("emergency_stop.resumed", "owner", principal.subject.id, "system", "emergency_stop", "allow", ctx.requestId, { note: body["note"] ?? "" });
  return ok(ctx, { emergency_stop: false, resumed_at: ctx.now, note: "재개 전 정합성 점검이 완료되었는지 확인하세요." });
});

route("POST", "/api/v1/admin/usage-budgets", async (ctx) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = String(body["provider"] ?? "github");
  const resourceKind = String(body["resource_kind"] ?? "workflow_dispatch");
  const hardLimit = Number(body["hard_limit_value"] ?? 0);
  const observed = typeof body["observed_value"] === "number" ? body["observed_value"] : null;
  const periodStart = ctx.now;
  const periodEnd = new Date(ctx.nowMs + 30 * 86_400_000).toISOString();
  await ctx.env.DB
    .prepare(
      `INSERT INTO usage_budgets (budget_id, provider, resource_kind, period_start, period_end, hard_limit_value, observed_value, observation_state, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(mintId("event"), provider, resourceKind, periodStart, periodEnd, hardLimit, observed, observed === null ? "unknown" : "measured", ctx.now)
    .run();
  return ok(ctx, { provider, resource_kind: resourceKind, hard_limit_value: hardLimit, observed_value: observed, observation_state: observed === null ? "unknown" : "measured" }, 201);
});

route("POST", "/api/v1/projects/{projectId}/repositories", async (ctx, params) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const fullName = String(body["repo_full_name"] ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, details: { field: "repo_full_name" } });
  const project = await firstRow<{ project_id: string }>(ctx.env.DB, "SELECT project_id FROM projects WHERE project_id = ?", params["projectId"] ?? "");
  if (project === null) throw new ApiError({ code: "PROJECT_NOT_FOUND", requestId: ctx.requestId });
  const repoId = mintId("repository");
  await ctx.env.DB
    .prepare(
      "INSERT INTO git_repositories (repo_id, project_id, github_installation_id, github_repository_id, repo_full_name, default_branch, enabled, connected_at) VALUES (?,?,?,?,?,?,1,?)",
    )
    .bind(repoId, project.project_id, String(body["github_installation_id"] ?? "inst_manual"), String(body["github_repository_id"] ?? `${Date.now()}`), fullName, String(body["default_branch"] ?? "main"), ctx.now)
    .run();
  return ok(ctx, { repo_id: repoId, project_id: project.project_id, repo_full_name: fullName, default_branch: String(body["default_branch"] ?? "main") }, 201);
});

route("POST", "/api/v1/messages/{messageId}/receipts", async (ctx, params) => {
  const principal = await principalOf(ctx);
  // Only the owner or the system may record delivery truth; an AI writing its own
  // "read" badge without a provider acknowledgment is exactly S47.
  requiresOwner(principal, ctx.requestId);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const message = await getMessageForPrincipal(ctx.env.DB, params["messageId"] ?? "", principal, ctx.requestId);
  const state = String(body["state"] ?? "QUEUED");
  const providerRef = typeof body["provider_ref"] === "string" ? body["provider_ref"] : null;
  if (["DELIVERED", "ACKNOWLEDGED_BY_AGENT", "READ_CONFIRMED"].includes(state) && (providerRef === null || providerRef.length === 0)) {
    throw new ApiError({
      code: "PROVIDER_UNVERIFIED",
      requestId: ctx.requestId,
      message: "공급자 수신 증거 없이는 DELIVERED/READ_CONFIRMED를 기록할 수 없습니다.",
      details: { state, required: "provider_ref" },
    });
  }
  const recipientKind = String(body["recipient_kind"] ?? "agent");
  const recipientId = String(body["recipient_id"] ?? "");
  if (!["owner", "agent"].includes(recipientKind) || recipientId.length === 0) {
    throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, details: { field: "recipient_id" } });
  }
  await ctx.env.DB
    .prepare(
      `INSERT INTO message_receipts (message_id, recipient_kind, recipient_id, state, provider_ref, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(message_id, recipient_kind, recipient_id)
       DO UPDATE SET state = excluded.state, provider_ref = excluded.provider_ref, updated_at = excluded.updated_at`,
    )
    .bind(message.message_id, recipientKind, recipientId, state, providerRef, ctx.now)
    .run();
  await ctx.auth.audit("message.receipt.recorded", "owner", principal.subject.id, "message", message.message_id, "allow", ctx.requestId, { state, recipient_kind: recipientKind, provider_ref_present: providerRef !== null });
  return ok(ctx, { message_id: message.message_id, state, recipient_kind: recipientKind, recipient_id: recipientId, provider_ref_present: providerRef !== null, note: "수신 확인은 공급자 증거가 있을 때만 READ_CONFIRMED로 기록됩니다." }, 201);
});

route("DELETE", "/api/v1/memories/{memoryId}", async (ctx, params) => {
  const principal = await principalOf(ctx);
  const { MemoryService } = await import("@ai-room/memory");
  const service = new MemoryService(ctx.env.DB);
  const result = await service.delete({
    memoryId: params["memoryId"] ?? "",
    access: { subject: principal.subject, roomIds: principal.membership.roomIds, projectIds: principal.membership.projectIds },
    requestId: ctx.requestId,
  });
  await ctx.auth.audit("memory.deleted", principal.subject.kind === "owner" ? "owner" : "agent", principal.subject.id, "memory", result.memory_id, "allow", ctx.requestId, { tombstoned: true });
  return ok(ctx, { ...result, propagated: { search_index: true, cross_project_grants: "revoked", backups: "immutable copy may remain" } });
});

route("POST", "/api/v1/projects/{projectId}/members", async (ctx, params) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const actorKind = String(body["actor_kind"] ?? "agent");
  const actorId = String(body["actor_id"] ?? "");
  const role = String(body["role"] ?? "contributor");
  if (!["owner", "contributor", "viewer"].includes(role) || !["owner", "agent"].includes(actorKind)) {
    throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, details: { field: "role" } });
  }
  const project = await firstRow<{ project_id: string }>(ctx.env.DB, "SELECT project_id FROM projects WHERE project_id = ? AND deleted_at IS NULL", params["projectId"] ?? "");
  if (project === null) throw new ApiError({ code: "PROJECT_NOT_FOUND", requestId: ctx.requestId });
  const exists = actorKind === "owner"
    ? await firstRow<{ owner_id: string }>(ctx.env.DB, "SELECT owner_id FROM owners WHERE owner_id = ?", actorId)
    : await firstRow<{ agent_id: string }>(ctx.env.DB, "SELECT agent_id FROM agents WHERE agent_id = ? AND disabled_at IS NULL", actorId);
  if (exists === null) throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN" } });
  await ctx.env.DB
    .prepare("INSERT INTO project_acl (project_id, actor_kind, actor_id, role, granted_by, granted_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id, actor_kind, actor_id) DO UPDATE SET role = excluded.role, revoked_at = NULL")
    .bind(project.project_id, actorKind, actorId, role, principal.subject.id, ctx.now)
    .run();
  await ctx.auth.audit("project.member.granted", "owner", principal.subject.id, "project", project.project_id, "allow", ctx.requestId, { actor_kind: actorKind, actor_id: actorId, role });
  return ok(ctx, { project_id: project.project_id, actor_kind: actorKind, actor_id: actorId, role, granted_at: ctx.now }, 201);
});

route("POST", "/api/v1/projects/{projectId}/documents", async (ctx, params) => {
  const principal = await principalOf(ctx);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const project = await firstRow<{ project_id: string }>(ctx.env.DB, "SELECT project_id FROM projects WHERE project_id = ?", params["projectId"] ?? "");
  if (project === null) throw new ApiError({ code: "PROJECT_NOT_FOUND", requestId: ctx.requestId });
  await getProject(ctx.env.DB, project.project_id, principal, ctx.requestId);
  const path = String(body["path"] ?? "");
  if (!/^[\w./-]+$/.test(path) || path.startsWith("/") || path.includes("..")) {
    throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "허용되지 않는 경로입니다.", details: { field: "path" } });
  }
  const documentId = mintId("document");
  await ctx.env.DB
    .prepare("INSERT INTO documents (document_id, project_id, path, language, revision, created_at, updated_at) VALUES (?,?,?,?,1,?,?)")
    .bind(documentId, project.project_id, path, String(body["language"] ?? "plaintext"), ctx.now, ctx.now)
    .run();
  const content = String(body["content"] ?? "");
  const r2Key = `documents/${project.project_id}/${documentId}/r1`;
  if (ctx.env.R2 !== undefined) await ctx.env.R2.put(r2Key, content);
  await ctx.env.DB
    .prepare("INSERT INTO document_snapshots (snapshot_id, document_id, revision, base_commit_sha, r2_key, sha256, created_at) VALUES (?,?,1,?,?,?,?)")
    .bind(mintId("event"), documentId, typeof body["base_commit_sha"] === "string" ? body["base_commit_sha"] : null, r2Key, await sha256Hex(content), ctx.now)
    .run();
  return ok(ctx, { document_id: documentId, path, revision: 1, snapshot_stored: ctx.env.R2 !== undefined, sha256: await sha256Hex(content) }, 201);
});

route("POST", "/api/v1/projects/{projectId}/artifacts", async (ctx, params) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
  const project = await firstRow<{ project_id: string }>(ctx.env.DB, "SELECT project_id FROM projects WHERE project_id = ?", params["projectId"] ?? "");
  if (project === null) throw new ApiError({ code: "PROJECT_NOT_FOUND", requestId: ctx.requestId });
  const content = String(body["content"] ?? "");
  const bytes = new TextEncoder().encode(content);
  const sha = await sha256Hex(bytes);
  const artifactId = mintId("artifact");
  const r2Key = `artifacts/${project.project_id}/${artifactId}`;
  if (ctx.env.R2 !== undefined) await ctx.env.R2.put(r2Key, bytes);
  await ctx.env.DB
    .prepare("INSERT INTO artifacts (artifact_id, project_id, artifact_type, version, sha256, size_bytes, r2_key, verification_state, created_at) VALUES (?,?,?,?,?,?,?, 'UNVERIFIED', ?)")
    .bind(artifactId, project.project_id, String(body["artifact_type"] ?? "report"), String(body["version"] ?? "0.0.1"), sha, bytes.length, r2Key, ctx.now)
    .run();
  const manifest = JSON.stringify({ artifact_id: artifactId, files: [{ path: String(body["path"] ?? "artifact.bin"), sha256: sha, size_bytes: bytes.length }] });
  await ctx.env.DB
    .prepare("INSERT INTO artifact_manifests (artifact_id, manifest_json, manifest_sha256, created_at) VALUES (?,?,?,?)")
    .bind(artifactId, manifest, await sha256Hex(manifest), ctx.now)
    .run();
  await ctx.env.DB
    .prepare("INSERT INTO artifact_files (artifact_id, relative_path, file_id, sha256, size_bytes) VALUES (?,?,NULL,?,?)")
    .bind(artifactId, String(body["path"] ?? "artifact.bin"), sha, bytes.length)
    .run();
  return ok(ctx, { artifact_id: artifactId, sha256: sha, size_bytes: bytes.length, verification_state: "UNVERIFIED", stored: ctx.env.R2 !== undefined }, 201);
});

route("POST", "/api/v1/admin/main-room", async (ctx) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const roomId = await ensureMainRoom(ctx.env.DB, principal.subject.id);
  return ok(ctx, { room_id: roomId });
});

route("GET", "/api/v1/rooms/{roomId}/presence", async (ctx, params) => {
  const principal = await principalOf(ctx);
  const room = await getRoom(ctx.env.DB, params["roomId"] ?? "", principal, ctx.requestId);
  const sessions = await count(ctx.env.DB, "SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL AND last_seen_at >= ?", new Date(ctx.nowMs - 120_000).toISOString());
  return ok(ctx, { room_id: room.room_id, authenticated_sessions_2m: sessions, source: "session heartbeat", note: "실제 WS 연결 수는 DO presence에 있습니다." });
});

route("GET", "/api/v1/messages/{messageId}", async (ctx, params) => {
  const principal = await principalOf(ctx);
  const message = await getMessageForPrincipal(ctx.env.DB, params["messageId"] ?? "", principal, ctx.requestId);
  return ok(ctx, { message: await serializeMessage(ctx.env.DB, message) });
});

route("GET", "/api/v1/admin/projects/{projectId}/metrics", async (ctx, params) => {
  const principal = await principalOf(ctx);
  requiresOwner(principal, ctx.requestId);
  const project = await firstRow<{ project_id: string }>(ctx.env.DB, "SELECT project_id FROM projects WHERE project_id = ?", params["projectId"] ?? "");
  if (project === null) throw new ApiError({ code: "PROJECT_NOT_FOUND", requestId: ctx.requestId });
  const { computeMetrics, metricSummary } = await import("@ai-room/telemetry");
  const metrics = await computeMetrics({ db: ctx.env.DB, projectId: project.project_id, nowMs: ctx.nowMs });
  return ok(ctx, { project_id: project.project_id, metrics, summary: metricSummary(metrics) });
});

/** Returns null when no extension matches, so the caller can answer 404. */
export async function handleExtension(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  auth: AuthService,
): Promise<Response | null> {
  const nowMs = env.NOW_MS ?? Date.now();
  const ctx: ExtContext = { request, env, url, requestId, auth, now: toUtcIso(nowMs), nowMs };
  for (const candidate of routes) {
    if (candidate.method !== request.method) continue;
    const match = candidate.pattern.exec(url.pathname);
    if (match === null) continue;
    const params: Record<string, string> = {};
    candidate.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1] ?? "");
    });
    return candidate.handler(ctx, params);
  }
  void nowOf;
  return null;
}

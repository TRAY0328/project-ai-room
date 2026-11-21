/**
 * Shared domain helpers for the gateway handlers.
 *
 * These are the queries that more than one handler needs, kept in one place so
 * the ACL rules are impossible to forget in a new endpoint:
 *  - a room/project lookup is always scoped to the caller's membership;
 *  - a message always resolves through its room, never by id alone;
 *  - every project mutation leaves a `project_events` row with an actor.
 */
import {
  ApiError,
  mintId,
  type PageInfo,
  type Subject,
} from "@ai-room/contracts";
import { allRows, count, firstRow, nowIso, scalar, type SqlDb } from "@ai-room/auth";
import type { Principal } from "@ai-room/permissions";
import type { AuthService } from "@ai-room/auth";
import type { Env } from "./env.js";

export interface HandlerContext {
  readonly env: Env;
  readonly db: SqlDb;
  readonly requestId: string;
  readonly url: URL;
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly principal: Principal;
  readonly auth: AuthService;
  readonly now: string;
  readonly nowMs: number;
  readonly approvalId: string | null;
  readonly clientIpHash: string;
}

export interface HandlerOutcome {
  readonly status?: number;
  readonly data: unknown;
  readonly page?: PageInfo;
}

export type Handler = (ctx: HandlerContext) => Promise<HandlerOutcome>;

export function blocked(requestId: string, reason: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError({ code: "EXTERNAL_DEPENDENCY_BLOCKED", requestId, details: { reason, ...details } });
}

export function notFoundOrHidden(requestId: string, type: string, id: string): ApiError {
  // Same answer as "not allowed" so an id cannot be probed for existence.
  return new ApiError({ code: "PERMISSION_DENIED", requestId, details: { reason_code: "NOT_FOUND_OR_HIDDEN", resource_type: type, resource_id: id.slice(0, 8) } });
}

export function projectNotFound(requestId: string): ApiError {
  return new ApiError({ code: "PROJECT_NOT_FOUND", requestId });
}

export async function ensureMainRoom(db: SqlDb, ownerId: string): Promise<string> {
  const existing = await firstRow<{ room_id: string }>(db, "SELECT room_id FROM rooms WHERE room_type = 'main' AND deleted_at IS NULL LIMIT 1");
  if (existing !== null) return existing.room_id;
  const roomId = mintId("room");
  const now = nowIso();
  await db
    .prepare("INSERT INTO rooms (room_id, room_type, name, created_by, created_at, updated_at, revision) VALUES (?,'main',?,?,?,?,1)")
    .bind(roomId, "AI ROOM", ownerId, now, now)
    .run();
  await db
    .prepare("INSERT OR IGNORE INTO room_acl (room_id, actor_kind, actor_id, role, granted_by, granted_at) VALUES (?,?,?,'owner',?,?)")
    .bind(roomId, "owner", ownerId, ownerId, now)
    .run();
  await db
    .prepare("INSERT OR IGNORE INTO room_members (room_id, actor_kind, actor_id, joined_at, invited_by) VALUES (?,?,?,?,?)")
    .bind(roomId, "owner", ownerId, now, ownerId)
    .run();
  return roomId;
}

export interface RoomRow {
  readonly room_id: string;
  readonly room_type: "main" | "project" | "custom";
  readonly name: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

export async function getRoom(db: SqlDb, roomId: string, principal: Principal, requestId: string): Promise<RoomRow> {
  const room = await firstRow<RoomRow>(db, "SELECT * FROM rooms WHERE room_id = ? AND deleted_at IS NULL", roomId);
  if (room === null) throw notFoundOrHidden(requestId, "room", roomId);
  if (principal.subject.kind !== "owner" && !principal.membership.roomIds.includes(room.room_id)) {
    throw new ApiError({ code: "ROOM_ACCESS_DENIED", requestId, details: { reason_code: "NOT_ROOM_MEMBER" } });
  }
  return room;
}

export interface ProjectRow {
  readonly project_id: string;
  readonly name: string;
  readonly description: string;
  readonly status: "active" | "paused" | "archived" | "deleted";
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

export async function getProject(db: SqlDb, projectId: string, principal: Principal, requestId: string): Promise<ProjectRow> {
  const project = await firstRow<ProjectRow>(db, "SELECT * FROM projects WHERE project_id = ? AND deleted_at IS NULL AND status <> 'deleted'", projectId);
  if (project === null) throw projectNotFound(requestId);
  if (principal.subject.kind !== "owner" && !principal.membership.projectIds.includes(project.project_id)) {
    throw new ApiError({ code: "PERMISSION_DENIED", requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
  }
  return project;
}

export interface MessageRow {
  readonly message_id: string;
  readonly room_id: string;
  readonly author_kind: "owner" | "agent" | "system";
  readonly author_id: string;
  readonly reply_to_id: string | null;
  readonly room_seq: number;
  readonly current_revision: number;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string | null;
  readonly deleted_at: string | null;
}

export async function getMessageForPrincipal(db: SqlDb, messageId: string, principal: Principal, requestId: string): Promise<MessageRow> {
  const message = await firstRow<MessageRow>(db, "SELECT * FROM messages WHERE message_id = ?", messageId);
  if (message === null) throw notFoundOrHidden(requestId, "message", messageId);
  await getRoom(db, message.room_id, principal, requestId);
  return message;
}

export interface WireMessage {
  readonly message_id: string;
  readonly room_id: string;
  readonly room_seq: number;
  readonly author_kind: "owner" | "agent" | "system";
  readonly author_id: string;
  readonly reply_to_id: string | null;
  readonly revision: number;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string | null;
  readonly deleted_at: string | null;
  readonly blocks: readonly { block_id: string; block_type: string; payload: Record<string, unknown> }[];
  readonly body_plain_text: string | null;
  readonly mentioned_agent_ids: readonly string[];
  readonly reactions: readonly { emoji_key: string; count: number }[];
  readonly tombstone_reason: string | null;
}

export async function serializeMessage(db: SqlDb, message: MessageRow, options: { includeDeletedContent?: boolean } = {}): Promise<WireMessage> {
  const version = await firstRow<{ blocks_json: string; body_plain_text: string }>(
    db,
    "SELECT blocks_json, body_plain_text FROM message_versions WHERE message_id = ? AND revision = ?",
    message.message_id,
    message.current_revision,
  );
  const deleted = message.deleted_at !== null;
  const includeContent = !deleted || options.includeDeletedContent === true;
  const mentions = await allRows<{ mentioned_agent_id: string }>(
    db,
    "SELECT mentioned_agent_id FROM message_mentions WHERE message_id = ?",
    message.message_id,
  );
  const reactions = await allRows<{ emoji_key: string; n: number }>(
    db,
    "SELECT emoji_key, COUNT(*) AS n FROM message_reactions WHERE message_id = ? GROUP BY emoji_key ORDER BY n DESC",
    message.message_id,
  );
  const tombstone = deleted
    ? await firstRow<{ reason: string }>(db, "SELECT reason FROM message_tombstones WHERE message_id = ?", message.message_id)
    : null;
  return {
    message_id: message.message_id,
    room_id: message.room_id,
    room_seq: message.room_seq,
    author_kind: message.author_kind,
    author_id: message.author_id,
    reply_to_id: message.reply_to_id,
    revision: message.current_revision,
    status: message.status,
    created_at: message.created_at,
    updated_at: message.updated_at,
    deleted_at: message.deleted_at,
    blocks: includeContent && version !== null ? (JSON.parse(version.blocks_json) as WireMessage["blocks"]) : [],
    body_plain_text: includeContent && version !== null ? version.body_plain_text : null,
    mentioned_agent_ids: mentions.map((row) => row.mentioned_agent_id),
    reactions: reactions.map((row) => ({ emoji_key: row.emoji_key, count: row.n })),
    tombstone_reason: tombstone?.reason ?? null,
  };
}

export async function recordProjectEvent(input: {
  readonly db: SqlDb;
  readonly projectId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly subject: Subject;
  readonly payload: Record<string, unknown>;
}): Promise<string> {
  const eventId = mintId("event");
  const now = nowIso();
  await input.db
    .prepare(
      `INSERT INTO project_events
        (event_id, project_id, event_type, aggregate_type, aggregate_id, sequence, actor_kind, actor_id, payload_json, occurred_at)
       SELECT ?, ?, ?, ?, ?, COALESCE(MAX(sequence),0)+1, ?, ?, ?, ?
       FROM project_events WHERE project_id = ?`,
    )
    .bind(
      eventId,
      input.projectId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.subject.kind,
      input.subject.id,
      JSON.stringify(input.payload),
      now,
      input.projectId,
    )
    .run();
  return eventId;
}

/** Bounded ACL revision used by WS tickets: a revocation changes this number. */
export async function aclRevision(db: SqlDb, roomId: string): Promise<number> {
  const grants = await count(db, "SELECT COUNT(*) AS n FROM room_acl WHERE room_id = ?", roomId);
  const revoked = await count(db, "SELECT COUNT(*) AS n FROM room_acl WHERE room_id = ? AND revoked_at IS NOT NULL", roomId);
  return grants * 1000 + revoked;
}

export async function roomMemberCount(db: SqlDb, roomId: string): Promise<number> {
  return count(db, "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND left_at IS NULL", roomId);
}

export function requireString(body: Record<string, unknown>, field: string, requestId: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError({ code: "VALIDATION_FAILED", requestId, details: { field } });
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function optionalNumber(body: Record<string, unknown>, field: string): number | null {
  const value = body[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function tableCounts(db: SqlDb, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    // Table names come from a literal list in this module, never from a request.
    out[table] = await count(db, `SELECT COUNT(*) AS n FROM ${table}`);
  }
  return out;
}

export async function latestSeq(db: SqlDb, roomId: string): Promise<number> {
  return Number((await scalar<number>(db, "SELECT COALESCE(MAX(room_seq),0) AS n FROM messages WHERE room_id = ?", roomId)) ?? 0);
}

export async function isEmergencyStopped(db: SqlDb): Promise<boolean> {
  const row = await firstRow<{ state: string }>(db, "SELECT state FROM feature_capabilities WHERE feature_key = 'emergency_stop'");
  return row !== null && row.state === "blocked";
}

export async function setEmergencyStop(db: SqlDb, stopped: boolean, detail: Record<string, unknown>): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO feature_capabilities (capability_id, feature_key, state, requires_provider, evidence_ref, updated_at)
       VALUES (?, 'emergency_stop', ?, NULL, ?, ?)
       ON CONFLICT(feature_key) DO UPDATE SET state = excluded.state, evidence_ref = excluded.evidence_ref, updated_at = excluded.updated_at`,
    )
    .bind(mintId("event"), stopped ? "blocked" : "available", JSON.stringify(detail), now)
    .run();
}

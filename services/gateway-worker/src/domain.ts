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
import { allRows, count, firstRow, nowIso, scalar, batchRows, placeholders, type SqlDb } from "@ai-room/auth";
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
  return assertRoomVisible(room, roomId, principal, requestId);
}

/**
 * The same check `getRoom` makes, for a handler that already read the row in a
 * batched query. A room a caller cannot see answers "not found or hidden", so an
 * id cannot be probed for existence.
 */
export function assertRoomVisible(room: RoomRow | null, roomId: string, principal: Principal, requestId: string): RoomRow {
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
  const [wire] = await serializeMessages(db, [message], options);
  // The single-message path is the same code, so a live frame and a page item can
  // never disagree about what a message looks like.
  return wire!;
}

/**
 * Serializes a page of messages with a FIXED number of queries.
 *
 * The obvious implementation asks four questions per message (its version, its
 * mentions, its reactions, its tombstone). At 40 messages that is 160 sequential
 * D1 round trips — seconds of waiting for a screen that is otherwise ready. Here
 * each relation is read once for the whole page with `message_id IN (...)`, and
 * the four reads travel together in one `batch()`. Content and ordering are
 * identical to the per-message version; only the number of round trips changes.
 */
export async function serializeMessages(db: SqlDb, messages: readonly MessageRow[], options: { includeDeletedContent?: boolean } = {}): Promise<WireMessage[]> {
  if (messages.length === 0) return [];
  const ids = messages.map((message) => message.message_id);
  const inList = placeholders(ids.length);
  const [versionRows, mentionRows, reactionRows, tombstoneRows] = await batchRows(db, [
    {
      // The current revision is per message, so it is joined rather than bound.
      sql: `SELECT v.message_id, v.blocks_json, v.body_plain_text
            FROM message_versions v JOIN messages m ON m.message_id = v.message_id AND m.current_revision = v.revision
            WHERE v.message_id IN (${inList})`,
      params: ids,
    },
    { sql: `SELECT message_id, mentioned_agent_id FROM message_mentions WHERE message_id IN (${inList})`, params: ids },
    {
      sql: `SELECT message_id, emoji_key, COUNT(*) AS n FROM message_reactions WHERE message_id IN (${inList}) GROUP BY message_id, emoji_key ORDER BY n DESC`,
      params: ids,
    },
    { sql: `SELECT message_id, reason FROM message_tombstones WHERE message_id IN (${inList})`, params: ids },
  ]);

  const versions = new Map<string, { blocks_json: string; body_plain_text: string }>();
  for (const row of versionRows as Array<{ message_id: string; blocks_json: string; body_plain_text: string }>) {
    versions.set(row.message_id, row);
  }
  const mentions = new Map<string, string[]>();
  for (const row of mentionRows as Array<{ message_id: string; mentioned_agent_id: string }>) {
    const list = mentions.get(row.message_id);
    if (list === undefined) mentions.set(row.message_id, [row.mentioned_agent_id]);
    else list.push(row.mentioned_agent_id);
  }
  const reactions = new Map<string, Array<{ emoji_key: string; count: number }>>();
  for (const row of reactionRows as Array<{ message_id: string; emoji_key: string; n: number }>) {
    const list = reactions.get(row.message_id);
    const entry = { emoji_key: row.emoji_key, count: row.n };
    if (list === undefined) reactions.set(row.message_id, [entry]);
    else list.push(entry);
  }
  const tombstones = new Map<string, string>();
  for (const row of tombstoneRows as Array<{ message_id: string; reason: string }>) tombstones.set(row.message_id, row.reason);

  return messages.map((message) => {
    const version = versions.get(message.message_id) ?? null;
    const deleted = message.deleted_at !== null;
    const includeContent = !deleted || options.includeDeletedContent === true;
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
      mentioned_agent_ids: mentions.get(message.message_id) ?? [],
      reactions: reactions.get(message.message_id) ?? [],
      tombstone_reason: deleted ? tombstones.get(message.message_id) ?? null : null,
    };
  });
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

/**
 * Read state: the last room_seq each member has actually seen.
 *
 * A reader counts toward an unread badge only while their row was touched inside
 * the active window. That is what keeps the number honest in a room that holds
 * AI members: an assistant that visited yesterday is a reader, and one that has
 * not opened the room in a week no longer inflates every message.
 */
export const READ_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RoomReadStateRow {
  readonly actor_kind: "owner" | "agent";
  readonly actor_id: string;
  readonly last_read_seq: number;
  readonly updated_at: string;
}

export async function roomReadState(db: SqlDb, roomId: string): Promise<RoomReadStateRow[]> {
  try {
    return await allRows<RoomReadStateRow>(
      db,
      "SELECT actor_kind, actor_id, last_read_seq, updated_at FROM room_read_state WHERE room_id = ? ORDER BY updated_at ASC",
      roomId,
    );
  } catch {
    // A database that has not applied 0004 keeps working: no rows, no badges.
    return [];
  }
}

/** Readers that count toward unread badges right now. */
export function activeReaders(rows: readonly RoomReadStateRow[], nowMs = Date.now(), windowMs = READ_ACTIVE_WINDOW_MS): RoomReadStateRow[] {
  return rows.filter((row) => {
    const seen = Date.parse(row.updated_at);
    return Number.isFinite(seen) && nowMs - seen <= windowMs;
  });
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

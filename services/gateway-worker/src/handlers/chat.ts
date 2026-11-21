/**
 * Chat, files and search — catalog group "채팅·파일·검색" (17 of 78).
 *
 * Ordering and integrity:
 *  - `room_seq` is allocated by a single INSERT..SELECT MAX()+1 statement guarded
 *    by UNIQUE(room_id, room_seq). D1 is single-writer per database, so this is
 *    the same guarantee the Room DO provides in production; the DO is the fan-out
 *    authority, D1 is the durable one.
 *  - An edit writes a NEW message_versions row; the old one stays readable, so
 *    "삭제/수정 배지" and version history are not lost.
 *  - A delete writes a tombstone with the real actor, removes FTS rows through
 *    the trigger, fails pending receipts and expires download links.
 */
import { ApiError, mintId } from "@ai-room/contracts";
import { allRows, count, firstRow, scalar, sha256Hex, nowIso } from "@ai-room/auth";
import { SearchService } from "@ai-room/search";
import { recordProjectMetric } from "@ai-room/telemetry";
import { signDownloadGrant } from "@ai-room/auth";
import type { Handler } from "../domain.js";
import {
  aclRevision,
  blocked,
  getMessageForPrincipal,
  getRoom,
  latestSeq,
  notFoundOrHidden,
  optionalString,
  recordProjectEvent,
  roomMemberCount,
  serializeMessage,
} from "../domain.js";
import { pageFromUrl } from "../http.js";

const ALLOWED_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/json",
  "application/zip",
];

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PROJECT_FILE_BYTES = 200 * 1024 * 1024;

function requireR2(ctx: Parameters<Handler>[0]) {
  if (ctx.env.R2 === undefined) {
    throw blocked(ctx.requestId, "R2_NOT_ENABLED", {
      detail: "R2 바인딩이 없습니다. 파일 본문은 저장하지 않고 메타데이터 파이프라인만 동작합니다.",
      status: 503,
    });
  }
  return ctx.env.R2;
}

function extractPlainText(blocks: readonly { block_type: string; payload: Record<string, unknown> }[]): string {
  return blocks
    .filter((block) => block.block_type === "text" || block.block_type === "markdown" || block.block_type === "quote" || block.block_type === "code")
    .map((block) => {
      // The client block model puts a markdown body under `markdown`; a plain or
      // quoted one under `text`. Both are the same idea: the readable body.
      if (typeof block.payload["text"] === "string") return block.payload["text"];
      if (typeof block.payload["markdown"] === "string") return block.payload["markdown"];
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .slice(0, 100_000);
}

export const chatHandlers: Record<string, Handler> = {
  "get-rooms": async (ctx) => {
    const rows =
      ctx.principal.subject.kind === "owner"
        ? await allRows<{ room_id: string; room_type: string; name: string; revision: number; created_at: string; updated_at: string }>(
            ctx.db,
            "SELECT room_id, room_type, name, revision, created_at, updated_at FROM rooms WHERE deleted_at IS NULL ORDER BY room_type = 'main' DESC, created_at ASC",
          )
        : await allRows<{ room_id: string; room_type: string; name: string; revision: number; created_at: string; updated_at: string }>(
            ctx.db,
            `SELECT r.room_id, r.room_type, r.name, r.revision, r.created_at, r.updated_at
             FROM rooms r JOIN room_members m ON m.room_id = r.room_id AND m.actor_kind = 'agent' AND m.actor_id = ? AND m.left_at IS NULL
             WHERE r.deleted_at IS NULL ORDER BY r.room_type = 'main' DESC, r.created_at ASC`,
            ctx.principal.subject.id,
          );
    const items = [];
    for (const row of rows) {
      items.push({
        room_id: row.room_id,
        room_type: row.room_type,
        name: row.name,
        revision: row.revision,
        member_count: await roomMemberCount(ctx.db, row.room_id),
        latest_seq: await latestSeq(ctx.db, row.room_id),
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }
    return { status: 200, data: { items } };
  },

  "post-rooms": async (ctx) => {
    const name = String(ctx.body["name"]);
    const roomType = String(ctx.body["room_type"] ?? "custom") as "custom" | "project";
    const projectId = optionalString(ctx.body, "project_id");
    if (projectId !== null) {
      const project = await firstRow<{ project_id: string }>(ctx.db, "SELECT project_id FROM projects WHERE project_id = ? AND deleted_at IS NULL", projectId);
      if (project === null) throw new ApiError({ code: "PROJECT_NOT_FOUND", requestId: ctx.requestId });
      if (ctx.principal.subject.kind !== "owner" && !ctx.principal.membership.projectIds.includes(projectId)) {
        throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
      }
    }
    const roomId = mintId("room");
    const now = ctx.now;
    const role = ctx.principal.subject.kind === "owner" ? "owner" : "contributor";
    try {
      await ctx.db
        .prepare("INSERT INTO rooms (room_id, room_type, name, created_by, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,1)")
        .bind(roomId, projectId === null ? "custom" : "project", name, ctx.principal.subject.id, now, now)
        .run();
    } catch (error) {
      if (String(error).includes("idx_single_main_room") || String(error).includes("UNIQUE constraint failed: rooms.room_type")) {
        throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "기본 방은 1개만 존재할 수 있습니다.", details: { field: "room_type" } });
      }
      throw error;
    }
    await ctx.db
      .prepare("INSERT INTO room_acl (room_id, actor_kind, actor_id, role, granted_by, granted_at) VALUES (?,?,?,?,?,?)")
      .bind(roomId, ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, role, ctx.principal.subject.id, now)
      .run();
    await ctx.db
      .prepare("INSERT INTO room_members (room_id, actor_kind, actor_id, joined_at, invited_by) VALUES (?,?,?,?,?)")
      .bind(roomId, ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, now, ctx.principal.subject.id)
      .run();
    if (projectId !== null) {
      await ctx.db
        .prepare("INSERT OR IGNORE INTO project_room_links (project_id, room_id, linked_at, linked_by) VALUES (?,?,?,?)")
        .bind(projectId, roomId, now, ctx.principal.subject.id)
        .run();
    }
    await ctx.auth.audit("room.created", ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, "room", roomId, "allow", ctx.requestId, {
      room_type: projectId === null ? "custom" : "project",
    });
    return { status: 201, data: { room_id: roomId, name, room_type: projectId === null ? "custom" : "project", revision: 1, created_at: now } };
  },

  "get-rooms-by-roomId": async (ctx) => {
    const room = await getRoom(ctx.db, ctx.params["roomId"] ?? "", ctx.principal, ctx.requestId);
    const members = await allRows<{ actor_kind: string; actor_id: string; joined_at: string; left_at: string | null }>(
      ctx.db,
      "SELECT actor_kind, actor_id, joined_at, left_at FROM room_members WHERE room_id = ? ORDER BY joined_at ASC",
      room.room_id,
    );
    const links = await allRows<{ project_id: string }>(ctx.db, "SELECT project_id FROM project_room_links WHERE room_id = ?", room.room_id);
    return {
      status: 200,
      data: {
        room_id: room.room_id,
        room_type: room.room_type,
        name: room.name,
        revision: room.revision,
        created_at: room.created_at,
        updated_at: room.updated_at,
        members: members.filter((member) => member.left_at === null).map((member) => ({ actor_kind: member.actor_kind, actor_id: member.actor_id, joined_at: member.joined_at })),
        project_ids: links.map((link) => link.project_id),
        latest_seq: await latestSeq(ctx.db, room.room_id),
        acl_revision: await aclRevision(ctx.db, room.room_id),
      },
    };
  },

  "patch-rooms-by-roomId": async (ctx) => {
    const room = await getRoom(ctx.db, ctx.params["roomId"] ?? "", ctx.principal, ctx.requestId);
    if (ctx.principal.subject.kind !== "owner") {
      const role = ctx.principal.roles.rooms.get(room.room_id);
      if (role !== "owner") throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "READ_ONLY_ROLE" } });
    }
    const expected = Number(ctx.body["expected_revision"]);
    if (expected !== room.revision) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { current_revision: room.revision } });
    }
    await ctx.db
      .prepare("UPDATE rooms SET name = ?, revision = revision + 1, updated_at = ? WHERE room_id = ? AND revision = ?")
      .bind(String(ctx.body["name"]), ctx.now, room.room_id, expected)
      .run();
    return { status: 200, data: { room_id: room.room_id, name: ctx.body["name"], revision: expected + 1, updated_at: ctx.now } };
  },

  "post-rooms-by-roomId-members": async (ctx) => {
    const room = await getRoom(ctx.db, ctx.params["roomId"] ?? "", ctx.principal, ctx.requestId);
    const actorKind = String(ctx.body["actor_kind"]) as "owner" | "agent";
    const actorId = String(ctx.body["actor_id"]);
    const selfJoin = ctx.principal.subject.kind === "agent" && actorKind === "agent" && actorId === ctx.principal.subject.id;
    if (ctx.principal.subject.kind !== "owner" && !selfJoin) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "SELF_ONLY" } });
    }
    if (selfJoin && room.room_type === "project") {
      throw new ApiError({ code: "ROOM_ACCESS_DENIED", requestId: ctx.requestId, details: { reason_code: "PROJECT_ROOM_INVITE_ONLY" } });
    }
    const target = actorKind === "owner"
      ? await firstRow<{ owner_id: string }>(ctx.db, "SELECT owner_id FROM owners WHERE owner_id = ?", actorId)
      : await firstRow<{ agent_id: string; disabled_at: string | null }>(ctx.db, "SELECT agent_id, disabled_at FROM agents WHERE agent_id = ?", actorId);
    if (target === null) throw notFoundOrHidden(ctx.requestId, actorKind, actorId);
    const now = ctx.now;
    await ctx.db
      .prepare("INSERT INTO room_members (room_id, actor_kind, actor_id, joined_at, invited_by) VALUES (?,?,?,?,?) ON CONFLICT(room_id, actor_kind, actor_id) DO UPDATE SET left_at = NULL")
      .bind(room.room_id, actorKind, actorId, now, ctx.principal.subject.id)
      .run();
    await ctx.db
      .prepare("INSERT OR IGNORE INTO room_acl (room_id, actor_kind, actor_id, role, granted_by, granted_at) VALUES (?,?,?,?,?,?)")
      .bind(room.room_id, actorKind, actorId, actorKind === "owner" ? "owner" : "contributor", ctx.principal.subject.id, now)
      .run();
    return { status: 201, data: { room_id: room.room_id, actor_kind: actorKind, actor_id: actorId, joined_at: now } };
  },

  "delete-rooms-by-roomId-members-by-actorId": async (ctx) => {
    const room = await getRoom(ctx.db, ctx.params["roomId"] ?? "", ctx.principal, ctx.requestId);
    const actorId = ctx.params["actorId"] ?? "";
    const self = actorId === ctx.principal.subject.id;
    if (ctx.principal.subject.kind !== "owner" && !self) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "SELF_ONLY" } });
    }
    if (room.room_type === "main" && actorId === (await firstRow<{ owner_id: string }>(ctx.db, "SELECT owner_id FROM owners LIMIT 1"))?.owner_id) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "MAIN_ROOM_OWNER_IMMUTABLE" } });
    }
    const now = ctx.now;
    await ctx.db
      .prepare("UPDATE room_members SET left_at = ? WHERE room_id = ? AND actor_id = ? AND left_at IS NULL")
      .bind(now, room.room_id, actorId)
      .run();
    await ctx.db
      .prepare("UPDATE room_acl SET revoked_at = ? WHERE room_id = ? AND actor_id = ? AND revoked_at IS NULL")
      .bind(now, room.room_id, actorId)
      .run();
    await ctx.auth.audit("room.member.removed", ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, "room", room.room_id, "allow", ctx.requestId, {
      removed_actor_id: actorId,
      forced: !self,
    });
    return { status: 200, data: { room_id: room.room_id, actor_id: actorId, left_at: now, forced: !self } };
  },

  "get-rooms-by-roomId-messages": async (ctx) => {
    const room = await getRoom(ctx.db, ctx.params["roomId"] ?? "", ctx.principal, ctx.requestId);
    const page = pageFromUrl(ctx.url, ctx.requestId);
    const includeDeleted = ctx.url.searchParams.get("include_deleted") === "true" && ctx.principal.subject.kind === "owner";
    const thread = ctx.url.searchParams.get("thread_id");
    const clauses = ["room_id = ?"];
    const params: unknown[] = [room.room_id];
    if (!includeDeleted) clauses.push("deleted_at IS NULL");
    if (thread !== null && thread.length > 0) {
      clauses.push("(reply_to_id = ? OR message_id = ?)");
      params.push(thread, thread);
    }
    if (page.cursor !== null) {
      const cursorSeq = Number.parseInt(page.cursor, 10);
      if (!Number.isFinite(cursorSeq)) throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, details: { field: "cursor", note: "room_seq 숫자여야 합니다." } });
      clauses.push(page.order === "desc" ? "room_seq < ?" : "room_seq > ?");
      params.push(cursorSeq);
    }
    const rows = await allRows<{
      message_id: string;
      room_id: string;
      author_kind: "owner" | "agent" | "system";
      author_id: string;
      reply_to_id: string | null;
      room_seq: number;
      current_revision: number;
      status: string;
      created_at: string;
      updated_at: string | null;
      deleted_at: string | null;
    }>(
      ctx.db,
      `SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY room_seq ${page.order === "desc" ? "DESC" : "ASC"} LIMIT ?`,
      ...params,
      page.limit + 1,
    );
    const pageRows = rows.slice(0, page.limit);
    const items = [];
    for (const row of pageRows) items.push(await serializeMessage(ctx.db, row));
    const last = pageRows[pageRows.length - 1];
    const nextCursor = rows.length > page.limit && last !== undefined ? String(last.room_seq) : null;
    return {
      status: 200,
      data: { room_id: room.room_id, latest_seq: await latestSeq(ctx.db, room.room_id), items },
      page: {
        next_cursor: nextCursor,
        has_more: nextCursor !== null,
        order: page.order,
        total_estimate: null,
      },
    };
  },

  "post-rooms-by-roomId-messages": async (ctx) => {
    const room = await getRoom(ctx.db, ctx.params["roomId"] ?? "", ctx.principal, ctx.requestId);
    const subject = ctx.principal.subject;
    const authorKind = subject.kind === "owner" ? "owner" : "agent";
    const blocks = ctx.body["blocks"] as { block_id: string; block_type: string; payload: Record<string, unknown> }[];
    // The Idempotency-Key header is the documented spelling; the body field is
    // accepted for clients that only send a JSON body.
    const idempotencyKey = typeof ctx.body["idempotency_key"] === "string" && ctx.body["idempotency_key"].length > 0
      ? String(ctx.body["idempotency_key"])
      : (ctx.headers.get("idempotency-key") ?? "");
    if (idempotencyKey.length < 8) {
      throw new ApiError({
        code: "VALIDATION_FAILED",
        requestId: ctx.requestId,
        message: "Idempotency-Key 헤더(8자 이상)가 필요합니다.",
        details: { header: "idempotency-key" },
      });
    }
    const bodyText = typeof ctx.body["body_plain_text"] === "string" && ctx.body["body_plain_text"].length > 0
      ? ctx.body["body_plain_text"]
      : extractPlainText(blocks);
    const replyTo = optionalString(ctx.body, "reply_to_id");
    const mentioned = (ctx.body["mentioned_agent_ids"] as string[] | undefined) ?? [];

    if (room.room_type === "project") {
      const link = await firstRow<{ project_id: string }>(ctx.db, "SELECT project_id FROM project_room_links WHERE room_id = ? LIMIT 1", room.room_id);
      if (link !== null && subject.kind !== "owner" && !ctx.principal.membership.projectIds.includes(link.project_id)) {
        throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
      }
    }
    if (replyTo !== null) {
      const parent = await firstRow<{ room_id: string }>(ctx.db, "SELECT room_id FROM messages WHERE message_id = ? AND deleted_at IS NULL", replyTo);
      if (parent === null || parent.room_id !== room.room_id) {
        throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "답글 대상이 이 방에 없습니다.", details: { field: "reply_to_id" } });
      }
    }
    for (const agentId of mentioned) {
      const member = await firstRow<{ agent_id: string }>(
        ctx.db,
        "SELECT agent_id FROM room_members WHERE room_id = ? AND actor_kind = 'agent' AND actor_id = ? AND left_at IS NULL",
        room.room_id,
        agentId,
      );
      if (member === null) {
        throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "이 방에 없는 AI는 멘션할 수 없습니다.", details: { field: "mentioned_agent_ids", agent_id: agentId } });
      }
    }

    const existing = await firstRow<{ message_id: string; room_seq: number; current_revision: number }>(
      ctx.db,
      "SELECT message_id, room_seq, current_revision FROM messages WHERE room_id = ? AND author_id = ? AND idempotency_key = ?",
      room.room_id,
      subject.id,
      idempotencyKey,
    );
    if (existing !== null) {
      const row = await getMessageForPrincipal(ctx.db, existing.message_id, ctx.principal, ctx.requestId);
      return { status: 200, data: { message: await serializeMessage(ctx.db, row), duplicate: true } };
    }

    const messageId = mintId("message");
    const now = ctx.now;
    try {
      await ctx.db
        .prepare(
          `INSERT INTO messages (message_id, room_id, author_kind, author_id, reply_to_id, room_seq, current_revision, status, idempotency_key, created_at)
           SELECT ?, ?, ?, ?, ?, COALESCE(MAX(room_seq),0) + 1, 1, 'PERSISTED', ?, ?
           FROM messages WHERE room_id = ?`,
        )
        .bind(messageId, room.room_id, authorKind, subject.id, replyTo, idempotencyKey, now, room.room_id)
        .run();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: messages.room_id, messages.room_seq")) {
        throw new ApiError({ code: "RETRY_LATER", requestId: ctx.requestId, details: { reason: "ROOM_SEQ_CONTENTION" } });
      }
      throw error;
    }
    const seq = Number(await scalar<number>(ctx.db, "SELECT room_seq FROM messages WHERE message_id = ?", messageId));
    const blocksJson = JSON.stringify(blocks);
    const contentSha = await sha256Hex(blocksJson);
    await ctx.db
      .prepare(
        `INSERT INTO message_versions (message_id, revision, blocks_json, body_plain_text, content_sha256, editor_kind, editor_id, created_at)
         VALUES (?,1,?,?,?,?,?,?)`,
      )
      .bind(messageId, blocksJson, bodyText, contentSha, authorKind, subject.id, now)
      .run();
    for (const [index, block] of blocks.entries()) {
      await ctx.db
        .prepare("INSERT INTO message_blocks (message_id, revision, block_index, block_id, block_type, payload_json) VALUES (?,1,?,?,?,?)")
        .bind(messageId, index, block.block_id, block.block_type, JSON.stringify(block.payload))
        .run();
    }
    for (const agentId of mentioned) {
      await ctx.db.prepare("INSERT OR IGNORE INTO message_mentions (message_id, mentioned_agent_id) VALUES (?,?)").bind(messageId, agentId).run();
    }
    // A message may only reference a file that has passed the scan gate (35.5).
    for (const block of blocks) {
      if (block.block_type !== "file" && block.block_type !== "image") continue;
      const fileId = block.payload["file_id"];
      if (typeof fileId !== "string" || !fileId.startsWith("file_")) continue;
      const file = await firstRow<{ file_id: string; storage_state: string; scan_state: string; deleted_at: string | null; project_id: string | null }>(
        ctx.db,
        "SELECT file_id, storage_state, scan_state, deleted_at, project_id FROM files WHERE file_id = ?",
        fileId,
      );
      if (file === null || file.deleted_at !== null) {
        throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "첨부 파일을 찾을 수 없습니다.", details: { field: "blocks", file_id: fileId } });
      }
      if (file.scan_state !== "clean" && file.scan_state !== "not_required") {
        throw new ApiError({ code: "FILE_SCAN_PENDING", requestId: ctx.requestId, details: { file_id: fileId, scan_state: file.scan_state } });
      }
      if (file.project_id !== null && ctx.principal.subject.kind !== "owner" && !ctx.principal.membership.projectIds.includes(file.project_id)) {
        throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_PROJECT_MEMBER", file_id: fileId } });
      }
      await ctx.db.prepare("INSERT OR IGNORE INTO message_files (message_id, file_id) VALUES (?,?)").bind(messageId, fileId).run();
    }
    await ctx.db
      .prepare("INSERT INTO delivery_outbox (delivery_id, message_id, channel, target_ref, state, attempts, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)")
      .bind(mintId("event"), messageId, "room_ws", room.room_id, "QUEUED", now, now)
      .run();
    const link = await firstRow<{ project_id: string }>(ctx.db, "SELECT project_id FROM project_room_links WHERE room_id = ? LIMIT 1", room.room_id);
    if (link !== null) {
      await recordProjectEvent({
        db: ctx.db,
        projectId: link.project_id,
        eventType: "room.message.created",
        aggregateType: "message",
        aggregateId: messageId,
        subject,
        payload: { message_id: messageId, room_id: room.room_id, seq, author_kind: authorKind, mentioned_agent_ids: mentioned },
      });
    }
    const row = await getMessageForPrincipal(ctx.db, messageId, ctx.principal, ctx.requestId);
    return {
      status: 201,
      data: {
        message: await serializeMessage(ctx.db, row),
        delivery: { state: "QUEUED", note: "전달 성공과 저장 성공은 다릅니다. ACK 전에는 CONFIRMED가 아닙니다." },
        room_ac_revision: await aclRevision(ctx.db, room.room_id),
      },
    };
  },

  "patch-rooms-by-roomId-messages-by-messageId": async (ctx) => {
    const room = await getRoom(ctx.db, ctx.params["roomId"] ?? "", ctx.principal, ctx.requestId);
    const message = await getMessageForPrincipal(ctx.db, ctx.params["messageId"] ?? "", ctx.principal, ctx.requestId);
    if (message.room_id !== room.room_id) throw notFoundOrHidden(ctx.requestId, "message", message.message_id);
    if (message.deleted_at !== null) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { reason: "MESSAGE_DELETED" } });
    }
    if (ctx.principal.subject.kind !== "owner") {
      if (message.author_kind !== "agent" || message.author_id !== ctx.principal.subject.id) {
        throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "SELF_ONLY" } });
      }
    }
    const expected = Number(ctx.body["expected_revision"]);
    if (expected !== message.current_revision) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { current_revision: message.current_revision } });
    }
    const blocks = ctx.body["blocks"] as { block_id: string; block_type: string; payload: Record<string, unknown> }[];
    const blocksJson = JSON.stringify(blocks);
    const revision = message.current_revision + 1;
    const now = ctx.now;
    await ctx.db
      .prepare(
        `INSERT INTO message_versions (message_id, revision, blocks_json, body_plain_text, content_sha256, editor_kind, editor_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(message.message_id, revision, blocksJson, String(ctx.body["body_plain_text"] ?? extractPlainText(blocks)), await sha256Hex(blocksJson), message.author_kind, ctx.principal.subject.id, now)
      .run();
    for (const [index, block] of blocks.entries()) {
      await ctx.db
        .prepare("INSERT INTO message_blocks (message_id, revision, block_index, block_id, block_type, payload_json) VALUES (?,?,?,?,?,?)")
        .bind(message.message_id, revision, index, block.block_id, block.block_type, JSON.stringify(block.payload))
        .run();
    }
    await ctx.db
      .prepare("UPDATE messages SET current_revision = ?, updated_at = ? WHERE message_id = ? AND current_revision = ?")
      .bind(revision, now, message.message_id, expected)
      .run();
    const updated = await getMessageForPrincipal(ctx.db, message.message_id, ctx.principal, ctx.requestId);
    return { status: 200, data: { message: await serializeMessage(ctx.db, updated), previous_revision: expected } };
  },

  "delete-rooms-by-roomId-messages-by-messageId": async (ctx) => {
    const message = await getMessageForPrincipal(ctx.db, ctx.params["messageId"] ?? "", ctx.principal, ctx.requestId);
    if (ctx.principal.subject.kind !== "owner") {
      if (message.author_kind !== "agent" || message.author_id !== ctx.principal.subject.id) {
        throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "SELF_ONLY" } });
      }
    }
    if (message.deleted_at !== null) return { status: 200, data: { message_id: message.message_id, deleted_at: message.deleted_at, already_deleted: true } };
    const expected = Number(ctx.body["expected_revision"]);
    if (expected !== message.current_revision) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { current_revision: message.current_revision } });
    }
    const now = ctx.now;
    const latest = await firstRow<{ content_sha256: string }>(ctx.db, "SELECT content_sha256 FROM message_versions WHERE message_id = ? ORDER BY revision DESC LIMIT 1", message.message_id);
    await ctx.db
      .prepare(
        `INSERT INTO message_tombstones (message_id, room_id, deleted_by_kind, deleted_by_id, deleted_at, content_sha256, reason)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(message_id) DO UPDATE SET deleted_by_kind = excluded.deleted_by_kind, deleted_by_id = excluded.deleted_by_id, deleted_at = excluded.deleted_at`,
      )
      .bind(message.message_id, message.room_id, ctx.principal.subject.kind, ctx.principal.subject.id, now, latest?.content_sha256 ?? null, optionalString(ctx.body, "reason") ?? "")
      .run();
    await ctx.db
      .prepare("UPDATE messages SET deleted_at = ?, status = 'DELETED' WHERE message_id = ? AND deleted_at IS NULL")
      .bind(now, message.message_id)
      .run();
    await ctx.auth.audit("room.message.deleted", ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, "message", message.message_id, "allow", ctx.requestId, {
      room_id: message.room_id,
      reason: optionalString(ctx.body, "reason") ?? "",
    });
    return {
      status: 200,
      data: {
        message_id: message.message_id,
        deleted_at: now,
        tombstone: true,
        propagated: { search_index: true, download_links: true, receipts: true },
      },
    };
  },

  "post-messages-by-messageId-reactions": async (ctx) => {
    const message = await getMessageForPrincipal(ctx.db, ctx.params["messageId"] ?? "", ctx.principal, ctx.requestId);
    if (message.deleted_at !== null) throw notFoundOrHidden(ctx.requestId, "message", message.message_id);
    const emoji = String(ctx.body["emoji_key"]);
    const actorKind = ctx.principal.subject.kind === "owner" ? "owner" : "agent";
    const distinct = await count(
      ctx.db,
      "SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ? AND actor_kind = ? AND actor_id = ?",
      message.message_id,
      actorKind,
      ctx.principal.subject.id,
    );
    if (distinct >= 20) {
      throw new ApiError({ code: "RATE_LIMITED", requestId: ctx.requestId, details: { reason: "REACTION_BUDGET", limit: 20 } });
    }
    await ctx.db
      .prepare("INSERT OR IGNORE INTO message_reactions (message_id, actor_kind, actor_id, emoji_key, created_at) VALUES (?,?,?,?,?)")
      .bind(message.message_id, actorKind, ctx.principal.subject.id, emoji, ctx.now)
      .run();
    const reactions = await allRows<{ emoji_key: string; n: number }>(
      ctx.db,
      "SELECT emoji_key, COUNT(*) AS n FROM message_reactions WHERE message_id = ? GROUP BY emoji_key",
      message.message_id,
    );
    return { status: 201, data: { message_id: message.message_id, emoji_key: emoji, reactions: reactions.map((row) => ({ emoji_key: row.emoji_key, count: row.n })) } };
  },

  "get-messages-by-messageId-versions": async (ctx) => {
    const message = await getMessageForPrincipal(ctx.db, ctx.params["messageId"] ?? "", ctx.principal, ctx.requestId);
    const versions = await allRows<{ revision: number; blocks_json: string; body_plain_text: string; content_sha256: string; editor_kind: string; editor_id: string; created_at: string; purged_at: string | null }>(
      ctx.db,
      "SELECT revision, blocks_json, body_plain_text, content_sha256, editor_kind, editor_id, created_at, purged_at FROM message_versions WHERE message_id = ? ORDER BY revision DESC",
      message.message_id,
    );
    return {
      status: 200,
      data: {
        message_id: message.message_id,
        current_revision: message.current_revision,
        items: versions.map((row) => ({
          revision: row.revision,
          editor_kind: row.editor_kind,
          editor_id: row.editor_id,
          content_sha256: row.content_sha256,
          created_at: row.created_at,
          purged: row.purged_at !== null,
          blocks: row.purged_at !== null ? [] : (JSON.parse(row.blocks_json) as unknown[]),
          body_plain_text: row.purged_at !== null ? null : row.body_plain_text,
        })),
      },
    };
  },

  "post-files-upload-intents": async (ctx) => {
    const mime = String(ctx.body["mime_type"]).toLowerCase();
    const size = Number(ctx.body["size_bytes"]);
    const declaredSha = String(ctx.body["sha256"]);
    if (!ALLOWED_MIME.includes(mime)) {
      throw new ApiError({ code: "MIME_REJECTED", requestId: ctx.requestId, details: { mime_type: mime.slice(0, 80), allowed: ALLOWED_MIME } });
    }
    if (size > MAX_FILE_BYTES) {
      throw new ApiError({ code: "CONTENT_TOO_LARGE", requestId: ctx.requestId, details: { limit_bytes: MAX_FILE_BYTES } });
    }
    const projectId = optionalString(ctx.body, "project_id");
    if (projectId !== null) {
      if (ctx.principal.subject.kind !== "owner" && !ctx.principal.membership.projectIds.includes(projectId)) {
        throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
      }
      const used = Number(
        (await scalar<number>(ctx.db, "SELECT COALESCE(SUM(size_bytes),0) AS n FROM files WHERE project_id = ? AND deleted_at IS NULL", projectId)) ?? 0,
      );
      if (used + size > MAX_PROJECT_FILE_BYTES) {
        throw new ApiError({ code: "QUOTA_EXHAUSTED", requestId: ctx.requestId, details: { limit_bytes: MAX_PROJECT_FILE_BYTES, used_bytes: used } });
      }
    }
    const r2 = requireR2(ctx);
    // Hash dedupe: report an identical stored object so a client can skip the
    // upload. R2 keys are unique per file row, so this is a metadata-level dedupe
    // (a real content-addressed bucket layout would need a schema change).
    const duplicate = await firstRow<{ file_id: string; filename: string; storage_state: string }>(
      ctx.db,
      "SELECT file_id, filename, storage_state FROM files WHERE sha256 = ? AND size_bytes = ? AND deleted_at IS NULL AND storage_state IN ('ready','quarantined') ORDER BY created_at ASC LIMIT 1",
      declaredSha,
      size,
    );
    const fileId = mintId("file");
    const fileName = String(ctx.body["filename"]);
    const r2Key = `files/${projectId ?? "global"}/${fileId}/${fileName.replace(/[^\w.\-가-힣]/g, "_")}`;
    const now = ctx.now;
    await ctx.db
      .prepare(
        `INSERT INTO files (file_id, project_id, creator_kind, creator_id, filename, mime_declared, size_bytes, sha256, r2_key, storage_state, scan_state, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'uploading','pending',?)`,
      )
      .bind(fileId, projectId, ctx.principal.subject.kind, ctx.principal.subject.id, fileName, mime, size, declaredSha, r2Key, now)
      .run();
    const stamp = await r2.put(`${r2Key}.intent`, JSON.stringify({ file_id: fileId, declared_sha256: declaredSha, size_bytes: size }));
    return {
      status: 201,
      data: {
        upload_id: fileId,
        asset_id: fileId,
        r2_key: r2Key,
        storage_state: "uploading",
        upload_url: `/api/v1/files/uploads/${fileId}/content`,
        upload_method: "PUT",
        expires_at: new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(),
        intent_etag: stamp.etag ?? null,
        ...(duplicate === null ? {} : { duplicate_of: { file_id: duplicate.file_id, filename: duplicate.filename, storage_state: duplicate.storage_state } }),
        dedupe: duplicate === null ? "no_duplicate" : "identical_hash_exists",
        note: "업로드 완료 시 sha256과 크기를 다시 검증한 뒤 quarantine 상태로 둡니다.",
      },
    };
  },

  "post-files-uploads-by-uploadId-complete": async (ctx) => {
    const fileId = ctx.params["uploadId"] ?? "";
    const file = await firstRow<{ file_id: string; r2_key: string; sha256: string; size_bytes: number; storage_state: string; creator_id: string }>(
      ctx.db,
      "SELECT * FROM files WHERE file_id = ?",
      fileId,
    );
    if (file === null) throw notFoundOrHidden(ctx.requestId, "file", fileId);
    if (file.creator_id !== ctx.principal.subject.id && ctx.principal.subject.kind !== "owner") {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "SELF_ONLY" } });
    }
    const r2 = requireR2(ctx);
    const duplicateFile = await firstRow<{ file_id: string }>(
      ctx.db,
      "SELECT file_id FROM files WHERE sha256 = ? AND file_id <> ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1",
      file.sha256,
      file.file_id,
    );
    const object = await r2.get(file.r2_key);
    if (object === null) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "업로드된 본문이 없습니다.", details: { field: "upload_id" } });
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const computed = await sha256Hex(bytes);
    const declared = String(ctx.body["sha256"]);
    const byteCount = Number(ctx.body["byte_count"]);
    const parts = ctx.body["parts"] as { part_number: number; etag: string; size_bytes: number }[];
    const partsTotal = parts.reduce((sum, part) => sum + part.size_bytes, 0);
    if (parts.length > 0 && partsTotal !== byteCount) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "parts 합계와 byte_count가 다릅니다.", details: { parts_total: partsTotal, byte_count: byteCount } });
    }
    if (computed !== declared || computed !== file.sha256 || bytes.length !== file.size_bytes || byteCount !== bytes.length) {
      await ctx.db
        .prepare("UPDATE files SET storage_state = 'delete_pending', mime_detected = ? WHERE file_id = ?")
        .bind(`mismatch:${computed.slice(0, 16)}`, fileId)
        .run();
      throw new ApiError({
        code: "VALIDATION_FAILED",
        requestId: ctx.requestId,
        message: "무결성 검증에 실패했습니다. 파일을 격리 대상으로 표시했습니다.",
        details: { computed_sha256: computed, declared_sha256: declared, size_bytes: bytes.length },
      });
    }
    const now = ctx.now;
    // Hash verified, but content is not scanned: quarantine until a scanner verdict.
    await ctx.db
      .prepare("UPDATE files SET storage_state = 'quarantined', scan_state = 'pending' WHERE file_id = ?")
      .bind(fileId)
      .run();
    await ctx.db
      .prepare("INSERT OR REPLACE INTO file_versions (file_id, version, sha256, size_bytes, r2_key, created_at) VALUES (?,1,?,?,?,?)")
      .bind(fileId, computed, bytes.length, file.r2_key, now)
      .run();
    return {
      status: 202,
      data: {
        upload_id: fileId,
        sha256: computed,
        size_bytes: bytes.length,
        storage_state: "quarantined",
        scan_state: "pending",
        duplicate_of_existing_hash: duplicateFile !== null,
        download_available: false,
        error_if_downloaded: "FILE_SCAN_PENDING",
      },
    };
  },

  "get-files-by-assetId-download-intent": async (ctx) => {
    const assetId = ctx.params["assetId"] ?? "";
    const file = await firstRow<{ file_id: string; project_id: string | null; creator_id: string; storage_state: string; scan_state: string; deleted_at: string | null; filename: string; r2_key: string; sha256: string }>(
      ctx.db,
      "SELECT * FROM files WHERE file_id = ?",
      assetId,
    );
    if (file === null) throw notFoundOrHidden(ctx.requestId, "file", assetId);
    if (ctx.principal.subject.kind !== "owner") {
      if (file.project_id !== null && !ctx.principal.membership.projectIds.includes(file.project_id)) {
        throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
      }
      if (file.project_id === null && file.creator_id !== ctx.principal.subject.id) {
        // A room attachment is readable by the members of the room it was sent to.
        const attached = await firstRow<{ room_id: string }>(
          ctx.db,
          "SELECT m.room_id FROM message_files mf JOIN messages m ON m.message_id = mf.message_id WHERE mf.file_id = ? LIMIT 1",
          file.file_id,
        );
        if (attached === null || !ctx.principal.membership.roomIds.includes(attached.room_id)) {
          throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_ROOM_MEMBER" } });
        }
      }
    }
    if (file.deleted_at !== null) throw notFoundOrHidden(ctx.requestId, "file", assetId);
    if (file.scan_state !== "clean" && file.scan_state !== "not_required") {
      throw new ApiError({ code: "FILE_SCAN_PENDING", requestId: ctx.requestId, details: { scan_state: file.scan_state, storage_state: file.storage_state } });
    }
    if (file.storage_state !== "ready") {
      throw new ApiError({ code: "FILE_SCAN_PENDING", requestId: ctx.requestId, details: { storage_state: file.storage_state } });
    }
    const r2 = requireR2(ctx);
    const signingKey = ctx.env.SESSION_SIGNING_KEY;
    if (signingKey === undefined) throw blocked(ctx.requestId, "DOWNLOAD_SIGNING_KEY_MISSING");
    const nowMs = ctx.nowMs;
    const expiresAt = new Date(nowMs + 5 * 60 * 1000).toISOString();
    const grant = await signDownloadGrant(
      {
        grant_id: mintId("event"),
        target_kind: "file",
        target_id: file.file_id,
        actor_kind: ctx.principal.subject.kind === "owner" ? "owner" : "agent",
        actor_id: ctx.principal.subject.id,
        issued_at: ctx.now,
        expires_at: expiresAt,
        single_use: false,
      },
      signingKey,
    );
    await ctx.db
      .prepare(
        `INSERT INTO download_events (download_id, file_id, artifact_id, actor_kind, actor_id, issued_at, expires_at)
         VALUES (?,?,NULL,?,?,?,?)`,
      )
      .bind(mintId("event"), file.file_id, ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, ctx.now, expiresAt)
      .run();
    void r2;
    return {
      status: 200,
      data: {
        asset_id: file.file_id,
        filename: file.filename,
        sha256: file.sha256,
        download_url: `/api/v1/files/${file.file_id}/content?grant=${encodeURIComponent(grant)}`,
        expires_at: expiresAt,
        ttl_seconds: 300,
        note: "짧은 수명 링크입니다. 삭제된 파일의 링크는 즉시 만료됩니다.",
      },
    };
  },

  "post-search": async (ctx) => {
    const service = new SearchService(ctx.db);
    const projectId = optionalString(ctx.body, "project_id");
    if (projectId !== null && ctx.principal.subject.kind !== "owner" && !ctx.principal.membership.projectIds.includes(projectId)) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
    }
    const roomId = optionalString(ctx.body, "room_id");
    if (roomId !== null && ctx.principal.subject.kind !== "owner" && !ctx.principal.membership.roomIds.includes(roomId)) {
      throw new ApiError({ code: "ROOM_ACCESS_DENIED", requestId: ctx.requestId });
    }
    const result = await service.search(
      {
        kind: ctx.principal.subject.kind === "owner" ? "owner" : "agent",
        actor_id: ctx.principal.subject.id,
        room_ids: ctx.principal.membership.roomIds,
        project_ids: ctx.principal.membership.projectIds,
      },
      {
        query: String(ctx.body["query"]),
        projectId,
        roomId,
        ...(Array.isArray(ctx.body["kinds"]) ? { kinds: ctx.body["kinds"] as ("message" | "memory" | "task" | "document" | "project")[] } : {}),
        ...(typeof ctx.body["limit"] === "number" ? { limit: ctx.body["limit"] } : {}),
        author: optionalString(ctx.body, "author"),
        from: optionalString(ctx.body, "from"),
        to: optionalString(ctx.body, "to"),
      },
    );
    if (projectId !== null) {
      await recordProjectMetric(ctx.db, {
        projectId,
        key: "search_latency_ms",
        value: result.took_ms,
        unit: "ms",
        periodStart: ctx.now.slice(0, 13) + ":00:00.000Z",
      });
    }
    return { status: 200, data: result };
  },

  "get-search-saved": async (ctx) => {
    // No table in the schema stores saved searches; saying so is better than
    // pretending to persist them. Clients keep them locally until a migration
    // adds `saved_searches`.
    return {
      status: 200,
      data: {
        items: [],
        storage_state: "client_only",
        note: "저장된 검색을 보관하는 서버 테이블이 스키마에 없습니다. 검색 조건은 클라이언트에 보관하세요.",
        checked_at: nowIso(),
      },
    };
  },
};

export { requireR2 };

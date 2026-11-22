/**
 * Wire -> view adapter for messages.
 *
 * The gateway stores a block as `{ block_id, block_type, payload, version }`,
 * while the renderer works with `{ type, version, payload }`, and the author
 * arrives as `author_kind` / `author_id` rather than a nested object. This
 * adapter is the one place that difference is handled, so a screen never has to
 * know both spellings — and a server that adds a field cannot break a screen.
 */
import type { ActorKind, MessageDto } from "./types.js";

interface WireBlock {
  readonly type?: string;
  readonly block_type?: string;
  readonly version?: number;
  readonly payload?: Record<string, unknown>;
}

export interface WireMessage {
  readonly message_id?: string;
  readonly room_id?: string;
  readonly room_seq?: number | null;
  readonly author?: { actor_id?: string; display_name?: string; kind?: string; attestation?: string };
  readonly author_kind?: string;
  readonly author_id?: string;
  readonly blocks?: readonly WireBlock[];
  readonly body_plain_text?: string | null;
  readonly created_at?: string;
  readonly edited_at?: string | null;
  readonly updated_at?: string | null;
  readonly deleted_at?: string | null;
  readonly revision?: number;
  readonly reactions?: ReadonlyArray<{ emoji_key?: string; count?: number }> | Record<string, number>;
  readonly reply_to_id?: string | null;
  readonly status?: string;
  readonly tombstone_reason?: string | null;
}

/**
 * The server's stored `status` is the only delivery evidence there is. Mapping it
 * (instead of dropping it) is why a stored message no longer renders "전달 상태
 * 미확인": PERSISTED/CONFIRMED are server-stored facts, and a rejected message
 * says so instead of looking fine.
 */
function deliveryOf(raw: WireMessage): MessageDto["delivery"] {
  switch (raw.status) {
    case "PERSISTED":
    case "CONFIRMED":
      return "server_stored";
    case "DRAFT":
    case "VALIDATING":
    case "ACCEPTED":
    case "DISTRIBUTING":
      return "queued";
    case "REJECTED":
    case "DEAD_LETTER":
      return "failed";
    default:
      return undefined;
  }
}

function reactionsOf(raw: WireMessage["reactions"]): Record<string, number> | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const out: Record<string, number> = {};
    for (const entry of raw as ReadonlyArray<{ emoji_key?: string; count?: number }>) {
      if (typeof entry?.emoji_key === "string" && typeof entry.count === "number") out[entry.emoji_key] = entry.count;
    }
    return out;
  }
  return { ...(raw as Record<string, number>) };
}

export function normalizeWireMessage(raw: WireMessage, nameOf: (agentId: string) => string = (id) => id): MessageDto {
  const kind = (raw.author?.kind ?? raw.author_kind ?? "agent") as ActorKind;
  const authorId = raw.author?.actor_id ?? raw.author_id ?? "";
  const explicitName = raw.author?.display_name;
  const deleted = raw.deleted_at ?? null;
  const blocks = (raw.blocks ?? []).map((block) => ({
    type: block.type ?? block.block_type ?? "text",
    version: typeof block.version === "number" ? block.version : 1,
    payload: block.payload ?? {},
  }));
  // A message with only a plain body still has to say something on screen.
  if (blocks.length === 0 && deleted === null && typeof raw.body_plain_text === "string" && raw.body_plain_text.trim().length > 0) {
    blocks.push({ type: "markdown", version: 1, payload: { markdown: raw.body_plain_text } });
  }
  return {
    message_id: raw.message_id ?? "",
    room_id: raw.room_id ?? "",
    room_seq: raw.room_seq ?? null,
    author: {
      actor_id: authorId,
      display_name: explicitName ?? (kind === "agent" ? nameOf(authorId) : "소유자"),
      kind,
      ...(raw.author?.attestation === undefined ? {} : { attestation: raw.author.attestation }),
    },
    blocks,
    created_at: raw.created_at ?? new Date().toISOString(),
    edited_at: raw.edited_at ?? raw.updated_at ?? null,
    deleted_at: deleted,
    revision: raw.revision,
    ...(deliveryOf(raw) === undefined ? {} : { delivery: deliveryOf(raw) }),
    ...(reactionsOf(raw.reactions) === undefined ? {} : { reactions: reactionsOf(raw.reactions) }),
    ...(raw.reply_to_id === undefined ? {} : { thread_root_id: raw.reply_to_id }),
  };
}

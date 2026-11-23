/**
 * Unread arithmetic for the chat badges (KakaoTalk's small amber number).
 *
 * The server stores one row per (room, reader): the highest `room_seq` that
 * reader has seen, and when they last moved it. A number beside a bubble is the
 * count of *active* readers who have not reached that message yet.
 *
 * Two rules keep the number honest in a room that mixes people and AI:
 *  - the author is never one of the readers who owe themselves a read;
 *  - a reader whose mark is older than the active window stops counting, so an
 *    assistant that stopped visiting the room does not inflate every message
 *    forever. The window is the server's (`read_window_ms`), not a client guess.
 */

export interface ReaderState {
  actor_kind: "owner" | "agent";
  actor_id: string;
  last_read_seq: number;
  /** ISO instant of the last mark; absent means "unknown age" and does not count. */
  updated_at?: string;
}

export const DEFAULT_READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Readers whose mark is recent enough to count right now. */
export function activeReaders(
  readers: readonly ReaderState[],
  nowMs: number,
  windowMs: number = DEFAULT_READ_WINDOW_MS,
): ReaderState[] {
  return readers.filter((reader) => {
    if (reader.updated_at === undefined) return false;
    const seen = Date.parse(reader.updated_at);
    if (!Number.isFinite(seen)) return false;
    return nowMs - seen <= windowMs;
  });
}

/**
 * How many active readers have not reached this message.
 *
 * A message without a room_seq (still queued in this browser) has no readers to
 * count, and a message the author themself wrote never counts the author.
 */
export function unreadCount(message: { room_seq: number | null; author: { actor_id: string; kind: string } }, active: readonly ReaderState[]): number {
  const seq = message.room_seq;
  if (typeof seq !== "number" || seq <= 0) return 0;
  let missing = 0;
  for (const reader of active) {
    if (reader.actor_id === message.author.actor_id && reader.actor_kind === message.author.kind) continue;
    if (reader.last_read_seq < seq) missing += 1;
  }
  return missing;
}

/** Merge a newer read place without ever moving a reader backwards. */
export function mergeReaderStates(previous: readonly ReaderState[], incoming: readonly ReaderState[]): ReaderState[] {
  const keyOf = (reader: ReaderState): string => `${reader.actor_kind}:${reader.actor_id}`;
  const byKey = new Map(previous.map((reader) => [keyOf(reader), reader]));
  for (const reader of incoming) {
    const before = byKey.get(keyOf(reader));
    if (before === undefined || reader.last_read_seq >= before.last_read_seq) byKey.set(keyOf(reader), reader);
  }
  return [...byKey.values()];
}

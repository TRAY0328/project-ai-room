/**
 * Merging a cached/loaded conversation with the server's page.
 *
 * The cache exists so the room paints before the network answers, but it is not
 * truth: a message the server no longer returns inside the range the page covers
 * was deleted (or is no longer visible to this reader) and must stop being drawn.
 * Rows *older* than the page are kept — they are history the reader can still
 * scroll to, and the page says nothing about them.
 */

export interface MessageLike {
  message_id: string;
  room_seq: number | null;
}

export interface PageWindow {
  /** Smallest room_seq in the server page. */
  oldest: number;
  /** The room's head at the time the page was read. */
  latest: number;
  /** message_ids the server page actually contains. */
  ids: ReadonlySet<string>;
}

export function mergeMessagePages<T extends MessageLike>(
  seeded: readonly T[],
  older: readonly T[],
  server: readonly T[],
  page: PageWindow | null,
): T[] {
  const stale = (message: T): boolean =>
    page !== null &&
    typeof message.room_seq === "number" &&
    message.room_seq >= page.oldest &&
    message.room_seq <= page.latest &&
    !page.ids.has(message.message_id);
  const byId = new Map<string, T>();
  for (const message of seeded) if (!stale(message)) byId.set(message.message_id, message);
  for (const message of older) if (!stale(message)) byId.set(message.message_id, message);
  // The server row always wins over a cached copy of the same id.
  for (const message of server) byId.set(message.message_id, message);
  return [...byId.values()];
}

/**
 * The chat's own local cache — so a room opens with the conversation already on
 * screen instead of after a request.
 *
 * What is stored, and why it is safe:
 *  - the last page of messages the *browser itself* was allowed to see, as the
 *    rendered `MessageDto` (no token, no cookie, nothing the server did not
 *    already hand this browser);
 *  - the room list and the room the reader was last in, so the header and the
 *    first request do not wait for each other.
 *
 * The cache is a first paint, never the truth: the server answer replaces it
 * message by message (same `message_id` wins), and it is dropped when the room is
 * not in the caller's room list any more. A signed-out browser uses none of it.
 */
import type { MessageDto, RoomSummary } from "./types.js";

const LAST_ROOM_KEY = "air.chat.last_room";
const ROOMS_KEY = "air.chat.rooms";
const MESSAGE_PREFIX = "air.chat.messages.v1:";

/** A page is 40; keeping 60 lets the newer page still be the first paint. */
const MAX_CACHED_MESSAGES = 60;
/** Older than a day is not "where I was", it is history. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CachedMessages {
  readonly room_id: string;
  readonly saved_at: number;
  readonly latest_seq: number | null;
  readonly messages: readonly MessageDto[];
}

export interface CachedRooms {
  readonly saved_at: number;
  readonly rooms: readonly RoomSummary[];
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  const store = storage();
  if (store === null) return;
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // A full quota must never break the screen: drop the chat cache and retry once.
    try {
      for (const key of Object.keys(store)) if (key.startsWith("air.chat.")) store.removeItem(key);
      if (value !== null) store.setItem(key, value);
    } catch {
      /* the screen still works without a cache */
    }
  }
}

function roomKey(roomId: string): string {
  return `${MESSAGE_PREFIX}${roomId}`;
}

export function readLastRoomId(): string | null {
  const value = readRaw(LAST_ROOM_KEY);
  return value !== null && value.length > 0 ? value : null;
}

export function rememberLastRoomId(roomId: string): void {
  if (roomId.length > 0) writeRaw(LAST_ROOM_KEY, roomId);
}

export function forgetLastRoomId(): void {
  writeRaw(LAST_ROOM_KEY, null);
}

export function readCachedRooms(): RoomSummary[] {
  const raw = readRaw(ROOMS_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as CachedRooms;
    if (typeof parsed.saved_at !== "number" || Date.now() - parsed.saved_at > MAX_AGE_MS) return [];
    return Array.isArray(parsed.rooms) ? parsed.rooms.filter((room) => typeof room?.room_id === "string") : [];
  } catch {
    return [];
  }
}

export function writeCachedRooms(rooms: readonly RoomSummary[]): void {
  if (rooms.length === 0) return;
  writeRaw(ROOMS_KEY, JSON.stringify({ saved_at: Date.now(), rooms: rooms.slice(0, 50) } satisfies CachedRooms));
}

export function readCachedMessages(roomId: string): CachedMessages | null {
  if (roomId.length === 0) return null;
  const raw = readRaw(roomKey(roomId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as CachedMessages;
    if (parsed.room_id !== roomId || typeof parsed.saved_at !== "number") return null;
    if (Date.now() - parsed.saved_at > MAX_AGE_MS) return null;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Remembers the newest messages of a room. The list is trimmed by `room_seq` (the
 * only ordering authority) and bounded, so one long conversation cannot fill the
 * browser's storage.
 */
export function writeCachedMessages(roomId: string, messages: readonly MessageDto[], latestSeq: number | null = null): void {
  if (roomId.length === 0 || messages.length === 0) return;
  const ordered = [...messages]
    .filter((message) => typeof message.message_id === "string" && message.message_id.length > 0)
    .sort((a, b) => (a.room_seq ?? 0) - (b.room_seq ?? 0));
  const tail = ordered.slice(Math.max(0, ordered.length - MAX_CACHED_MESSAGES));
  const head = tail[tail.length - 1];
  writeRaw(
    roomKey(roomId),
    JSON.stringify({
      room_id: roomId,
      saved_at: Date.now(),
      latest_seq: latestSeq ?? head?.room_seq ?? null,
      messages: tail,
    } satisfies CachedMessages),
  );
}

export function clearCachedMessages(roomId: string): void {
  writeRaw(roomKey(roomId), null);
}

/**
 * The chat cache is what makes a room open with the conversation already there.
 * These tests pin the two things that make it safe: a bounded, ordered tail, and
 * a refusal to use anything stale or unparsable.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearCachedMessages, readCachedMessages, readLastRoomId, rememberLastRoomId, writeCachedMessages } from "../api/chat-cache.js";
import type { MessageDto } from "../api/types.js";

const message = (seq: number): MessageDto => ({
  message_id: `msg-${seq}`,
  room_id: "room-1",
  room_seq: seq,
  author: { actor_id: "agent-1", display_name: "Gemini", kind: "agent" },
  blocks: [{ type: "markdown", version: 1, payload: { markdown: `메시지 ${seq}` } }],
  created_at: "2026-11-22T02:00:00.000Z",
});

describe("chat cache", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the last room the reader was in", () => {
    expect(readLastRoomId()).toBeNull();
    rememberLastRoomId("room-1");
    expect(readLastRoomId()).toBe("room-1");
  });

  it("keeps the newest messages in room_seq order", () => {
    writeCachedMessages("room-1", [message(3), message(1), message(2)], null);
    const cached = readCachedMessages("room-1");
    expect(cached?.messages.map((m) => m.room_seq)).toEqual([1, 2, 3]);
    expect(cached?.latest_seq).toBe(3);
  });

  it("bounds what it stores", () => {
    const many = Array.from({ length: 90 }, (_, index) => message(index + 1));
    writeCachedMessages("room-1", many, null);
    const cached = readCachedMessages("room-1");
    expect(cached?.messages.length).toBe(60);
    // The tail is what a reader opens on, so the oldest rows are the ones dropped.
    expect(cached?.messages[0]?.room_seq).toBe(31);
  });

  it("ignores another room's entry and unreadable data", () => {
    writeCachedMessages("room-1", [message(1)], null);
    expect(readCachedMessages("room-2")).toBeNull();
    localStorage.setItem("air.chat.messages.v1:room-3", "{not json");
    expect(readCachedMessages("room-3")).toBeNull();
  });

  it("drops a cache older than a day", () => {
    writeCachedMessages("room-1", [message(1)], null);
    const raw = JSON.parse(localStorage.getItem("air.chat.messages.v1:room-1")!) as { saved_at: number };
    raw.saved_at = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem("air.chat.messages.v1:room-1", JSON.stringify({ ...raw, room_id: "room-1", latest_seq: 1, messages: [message(1)] }));
    expect(readCachedMessages("room-1")).toBeNull();
  });

  it("forgets one room without touching another", () => {
    writeCachedMessages("room-1", [message(1)], null);
    writeCachedMessages("room-2", [message(2)], null);
    clearCachedMessages("room-1");
    expect(readCachedMessages("room-1")).toBeNull();
    expect(readCachedMessages("room-2")?.messages.length).toBe(1);
  });
});

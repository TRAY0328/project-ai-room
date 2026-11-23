/**
 * Read badges — the arithmetic the chat screen draws.
 *
 * These cases are the ones that made a naive "members - 1" number wrong: the
 * author is not owed a read, an idle AI stops counting, a queued message has no
 * sequence, and a merge never rewinds a reader.
 */
import { describe, expect, it } from "vitest";
import { activeReaders, mergeReaderStates, unreadCount, type ReaderState } from "../lib/read-state.js";

const NOW = Date.parse("2026-11-23T06:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const readers: ReaderState[] = [
  { actor_kind: "owner", actor_id: "owner_1", last_read_seq: 10, updated_at: minutesAgo(1) },
  { actor_kind: "agent", actor_id: "agent_pickle", last_read_seq: 8, updated_at: minutesAgo(2) },
  { actor_kind: "agent", actor_id: "agent_sleepy", last_read_seq: 1, updated_at: minutesAgo(60 * 24 * 30) },
];

describe("unreadCount", () => {
  it("counts active readers who have not reached the message", () => {
    const active = activeReaders(readers, NOW);
    const mine = { room_seq: 10, author: { actor_id: "owner_1", kind: "owner" } };
    // The owner wrote it; pickle is active but only reached 8. Sleepy is outside
    // the window, so the badge is 1 rather than a number that never falls.
    expect(unreadCount(mine, active)).toBe(1);
  });

  it("hides when every active reader has reached it", () => {
    const active = activeReaders(readers, NOW);
    const old = { room_seq: 8, author: { actor_id: "owner_1", kind: "owner" } };
    expect(unreadCount(old, active)).toBe(0);
  });

  it("counts me as a reader of someone else's message until I read it", () => {
    const active = activeReaders(readers, NOW);
    const aiMessage = { room_seq: 9, author: { actor_id: "agent_pickle", kind: "agent" } };
    // owner last_read_seq 10 >= 9 → 0; the author is excluded too.
    expect(unreadCount(aiMessage, active)).toBe(0);
    const newer = { room_seq: 12, author: { actor_id: "agent_pickle", kind: "agent" } };
    expect(unreadCount(newer, active)).toBe(1);
  });

  it("has no number for a message still queued in this browser", () => {
    expect(unreadCount({ room_seq: null, author: { actor_id: "owner_1", kind: "owner" } }, readers)).toBe(0);
  });
});

describe("mergeReaderStates", () => {
  it("keeps the furthest place per reader", () => {
    const merged = mergeReaderStates(readers, [
      { actor_kind: "agent", actor_id: "agent_pickle", last_read_seq: 7, updated_at: minutesAgo(5) },
      { actor_kind: "agent", actor_id: "agent_pickle", last_read_seq: 11, updated_at: minutesAgo(0.5) },
    ]);
    expect(merged.find((reader) => reader.actor_id === "agent_pickle")?.last_read_seq).toBe(11);
    expect(merged).toHaveLength(readers.length);
  });

  it("ignores a reader with an unparseable timestamp", () => {
    expect(activeReaders([{ actor_kind: "agent", actor_id: "a", last_read_seq: 1, updated_at: "not-a-date" }], NOW)).toHaveLength(0);
  });
});

/**
 * A cached message the server no longer returns inside the page's own range was
 * deleted (or hidden): it must stop being drawn. History older than the page is
 * kept, and a server row always replaces its cached copy.
 */
import { describe, expect, it } from "vitest";
import { mergeMessagePages, type PageWindow } from "../lib/message-merge.js";

interface Row {
  message_id: string;
  room_seq: number | null;
  text: string;
}

const row = (id: string, seq: number | null, text = id): Row => ({ message_id: id, room_seq: seq, text });

describe("mergeMessagePages", () => {
  const page: PageWindow = { oldest: 10, latest: 14, ids: new Set(["m10", "m11", "m13", "m14"]) };

  it("drops a cached row inside the page range that the server no longer has", () => {
    const merged = mergeMessagePages([row("m12", 12, "삭제됨")], [], [row("m10", 10), row("m11", 11)], page);
    expect(merged.map((m) => m.message_id)).toEqual(["m10", "m11"]);
  });

  it("keeps history older than the page", () => {
    const merged = mergeMessagePages([row("m3", 3, "옛 메시지")], [], [row("m10", 10)], page);
    expect(merged.map((m) => m.message_id)).toEqual(["m3", "m10"]);
  });

  it("keeps a cached row newer than the head (arrived after the page)", () => {
    const merged = mergeMessagePages([row("m20", 20, "새 메시지")], [], [row("m10", 10)], page);
    expect(merged.map((m) => m.message_id)).toEqual(["m20", "m10"]);
  });

  it("lets the server row win over its cached copy", () => {
    const merged = mergeMessagePages([row("m10", 10, "예전 본문")], [], [row("m10", 10, "서버 본문")], page);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.text).toBe("서버 본문");
  });

  it("does no pruning without a page window", () => {
    const merged = mergeMessagePages([row("m12", 12)], [row("m11", 11)], [], null);
    expect(merged.map((m) => m.message_id).sort()).toEqual(["m11", "m12"]);
  });

  it("keeps a queued row that has no sequence yet", () => {
    const merged = mergeMessagePages([row("pending", null)], [], [row("m10", 10)], page);
    expect(merged.map((m) => m.message_id)).toContain("pending");
  });
});

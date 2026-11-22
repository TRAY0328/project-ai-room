/**
 * Wire -> view adapter: a stored message must carry its delivery evidence.
 *
 * A message the server answered with `status: PERSISTED` used to render
 * \"전달 상태 미확인\" because the status was dropped in this adapter, so the screen
 * could not tell a stored message from an unknown one.
 */
import { describe, expect, it } from "vitest";
import { normalizeWireMessage } from "../api/wire.js";

function wire(status: string | undefined) {
  return {
    message_id: "msg_1",
    room_id: "room_1",
    room_seq: 11,
    author_kind: "agent" as const,
    author_id: "agent_1",
    blocks: [{ block_type: "markdown", payload: { markdown: "hello" } }],
    created_at: "2026-11-21T23:43:58.897Z",
    ...(status === undefined ? {} : { status }),
  };
}

describe("normalizeWireMessage delivery", () => {
  it("maps PERSISTED to server_stored so the header says 서버 저장됨", () => {
    expect(normalizeWireMessage(wire("PERSISTED")).delivery).toBe("server_stored");
    expect(normalizeWireMessage(wire("CONFIRMED")).delivery).toBe("server_stored");
  });

  it("maps a rejected message to failed and keeps an unknown status unknown", () => {
    expect(normalizeWireMessage(wire("REJECTED")).delivery).toBe("failed");
    expect(normalizeWireMessage(wire(undefined)).delivery).toBeUndefined();
  });

  it("keeps block_type/payload and authors intact", () => {
    const message = normalizeWireMessage(wire("PERSISTED"));
    expect(message.blocks[0]?.type).toBe("markdown");
    expect(message.blocks[0]?.payload).toEqual({ markdown: "hello" });
    expect(message.author.kind).toBe("agent");
    expect(message.room_seq).toBe(11);
  });
});

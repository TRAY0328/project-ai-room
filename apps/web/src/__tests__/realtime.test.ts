/**
 * Realtime stream rules (spec 19.3): ordering is the server's `room_seq`.
 * A gap must trigger an HTTPS resync, never a guessed order, and a closed
 * socket must report reconnecting rather than pretending to be live.
 */
import { describe, expect, it, vi } from "vitest";
import { RoomStream } from "../api/realtime.js";
import type { MessageDto } from "../api/types.js";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close(code = 1000) {
    this.onclose?.({ code });
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function message(seq: number): MessageDto {
  return {
    message_id: `m-${seq}`,
    room_id: "room-1",
    room_seq: seq,
    author: { actor_id: "a", display_name: "AI", kind: "agent" },
    blocks: [{ type: "text", version: 1, payload: { text: `seq ${seq}` } }],
    created_at: new Date().toISOString(),
  };
}

describe("room stream", () => {
  it("connects with the last seen seq and reports live", () => {
    FakeSocket.instances = [];
    const statuses: string[] = [];
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: () => undefined,
      onResync: () => undefined,
      onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    stream.connect(41);
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("wss://gw.example/v1/rooms/room-1/events?cursor=41");
    socket.onopen?.();
    expect(statuses).toEqual(["connecting", "live"]);
  });

  it("delivers ordered messages", () => {
    FakeSocket.instances = [];
    const received: string[] = [];
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: (m) => received.push(m.message_id),
      onResync: () => undefined,
      onStatus: () => undefined,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    stream.connect(1);
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    socket.emit({ type: "room.message.created", schema_version: 1, room_seq: 2, message: message(2) });
    socket.emit({ type: "room.message.created", schema_version: 1, room_seq: 3, message: message(3) });
    expect(received).toEqual(["m-2", "m-3"]);
    expect(stream.statusSeq).toBe(3);
  });

  it("resyncs on a sequence gap instead of guessing", () => {
    FakeSocket.instances = [];
    const resync = vi.fn();
    const received: string[] = [];
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: (m) => received.push(m.message_id),
      onResync: resync,
      onStatus: () => undefined,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    stream.connect(1);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.emit({ type: "room.message.created", room_seq: 5, message: message(5) });
    expect(resync).toHaveBeenCalledWith(expect.stringContaining("gap"));
    expect(received).toEqual([]);
  });

  it("resyncs when the schema version is newer than the client", () => {
    FakeSocket.instances = [];
    const resync = vi.fn();
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: () => undefined,
      onResync: resync,
      onStatus: () => undefined,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    stream.connect(0);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.emit({ type: "room.message.created", schema_version: 99, room_seq: 1 });
    expect(resync).toHaveBeenCalledWith(expect.stringContaining("schema_version"));
  });

  it("reports reconnecting (not live) after an unexpected close", () => {
    FakeSocket.instances = [];
    const statuses: Array<[string, string | undefined]> = [];
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: () => undefined,
      onResync: () => undefined,
      onStatus: (s, d) => statuses.push([s, d]),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      maxRetries: 1,
    });
    stream.connect(0);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.close(1006);
    expect(statuses.at(-1)?.[0]).toBe("reconnecting");
    stream.close();
  });

  it("stops on an auth close code", () => {
    FakeSocket.instances = [];
    const statuses: string[] = [];
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: () => undefined,
      onResync: () => undefined,
      onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    stream.connect(0);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.close(4401);
    expect(statuses.at(-1)).toBe("error");
  });
});

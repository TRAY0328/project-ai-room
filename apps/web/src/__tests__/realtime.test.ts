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
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  close(code = 1000, reason = "") {
    this.onclose?.({ code, reason });
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

  it("reads the Room DO's EVENT envelope and keeps the cursor moving", () => {
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
    socket.emit({
      type: "EVENT",
      event: {
        schema_version: 1,
        event_id: "evt_2",
        type: "room.message.created",
        project_id: null,
        room_id: "room-1",
        sequence: 2,
        correlation_id: "m-2",
        occurred_at: new Date().toISOString(),
        payload: { message_id: "m-2", seq: 2, message: message(2) },
      },
    });
    expect(received).toEqual(["m-2"]);
    expect(stream.statusSeq).toBe(2);
  });

  it("resyncs when the server calls for a snapshot", () => {
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
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    socket.emit({ type: "SNAPSHOT_REQUIRED", reason: "no_cursor", latest_seq: 9 });
    expect(resync).toHaveBeenCalledWith(expect.stringContaining("server requested resync"));
    stream.close();
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

  /** Lets the renewal promise settle and the reconnect it triggers to run. */
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("renews the session, then reconnects at once with the same cursor after an expired close", async () => {
    FakeSocket.instances = [];
    const statuses: Array<[string, string | undefined]> = [];
    const renew = vi.fn(async () => true);
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: () => undefined,
      onResync: () => undefined,
      onStatus: (s, d) => statuses.push([s, d]),
      onAuthExpired: renew,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    stream.connect(7);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.close(1008, "expired");
    expect(renew).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)?.[0]).toBe("reconnecting");

    await flush();
    // A new socket, no backoff wait, and the same cursor: nothing is re-read.
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toBe("wss://gw.example/v1/rooms/room-1/events?cursor=7");
    FakeSocket.instances[1]!.onopen?.();
    expect(statuses.at(-1)?.[0]).toBe("live");
    stream.close();
  });

  it("tries a renewal on an abnormal close, once per outage", async () => {
    FakeSocket.instances = [];
    const renew = vi.fn(async () => true);
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: () => undefined,
      onResync: () => undefined,
      onStatus: () => undefined,
      onAuthExpired: renew,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    stream.connect(0);
    FakeSocket.instances[0]!.onopen?.();
    // A refused upgrade reaches the browser as 1006 — no handshake to read.
    FakeSocket.instances[0]!.close(1006);
    await flush();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // The second failure in the same outage goes to normal backoff, not another renewal.
    FakeSocket.instances[1]!.close(1006);
    await flush();
    expect(renew).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("says the session is over when the renewal itself is refused", async () => {
    FakeSocket.instances = [];
    const statuses: Array<[string, string | undefined]> = [];
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: () => undefined,
      onResync: () => undefined,
      onStatus: (s, d) => statuses.push([s, d]),
      onAuthExpired: async () => false,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    stream.connect(0);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.close(1008, "revoked");
    await flush();
    expect(statuses.at(-1)?.[0]).toBe("error");
    expect(statuses.at(-1)?.[1]).toContain("세션이 만료");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reconnects at once when a background tab is looked at again", () => {
    FakeSocket.instances = [];
    const stream = new RoomStream({
      baseUrl: "https://gw.example",
      roomId: "room-1",
      onMessage: () => undefined,
      onResync: () => undefined,
      onStatus: () => undefined,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      maxRetries: 0,
    });
    stream.connect(4);
    FakeSocket.instances[0]!.onopen?.();
    FakeSocket.instances[0]!.close(1008, "heartbeat_timeout");
    // maxRetries 0 means the scheduled reconnect gave up; a visible tab repairs it now.
    stream.ensureConnected();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1]!.url).toBe("wss://gw.example/v1/rooms/room-1/events?cursor=4");
    stream.close();
  });
});

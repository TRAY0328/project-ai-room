/**
 * Room Durable Object — spec 31.2, 35.1, 35.2, 35.4, E2E-06/07, S42, S47.
 *
 * Three responsibilities, and nothing else:
 *   1. the per-room `room_seq` (the only message ordering authority);
 *   2. the live socket fan-out, gated on D1 persistence;
 *   3. presence truth — a socket is "online" only while it is authenticated and
 *      heartbeating; a revoked permission or an expired ticket closes it now.
 *
 * It is explicitly *not* the durable message store. A seq that is reserved and
 * then lost appears as a gap, and the client repairs it over HTTPS with
 * `GET /rooms/{id}/events?cursor=` instead of guessing.
 */
import {
  planResync,
  toUtcIso,
  zClientFrame,
  zServerFrame,
  type ClientFrame,
  type ServerFrame,
  type WsTicketClaims,
} from "@ai-room/contracts";
import { verifyWsTicket } from "@ai-room/auth";

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface SocketLike {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface RoomMessageRow {
  readonly message_id: string;
  readonly room_seq: number;
  readonly author_kind: "owner" | "agent" | "system";
  readonly author_id: string;
  readonly revision: number;
}

export interface RoomBroadcast {
  readonly roomId: string;
  readonly frame: ServerFrame;
  readonly seq: number;
}

const MAX_BUFFERED_EVENTS = 500;
export const HEARTBEAT_TIMEOUT_MS = 45_000;

export class RoomCoordinator {
  protected readonly state: RoomSessionState;
  private readonly storage: DurableObjectStorageLike;

  constructor(roomId: string, storage: DurableObjectStorageLike) {
    this.state = { roomId, lastSeq: 0, persistedSeq: 0, sockets: new Set() };
    this.storage = storage;
  }

  async load(): Promise<void> {
    const saved = await this.storage.get<{ lastSeq: number; persistedSeq: number }>(`room:${this.state.roomId}`);
    if (saved !== undefined) {
      this.state.lastSeq = saved.lastSeq;
      this.state.persistedSeq = saved.persistedSeq;
    }
  }

  get roomId(): string {
    return this.state.roomId;
  }

  get latestSeq(): number {
    return this.state.persistedSeq;
  }

  /**
   * Reserves the next seq for a message that is about to be written to D1.
   * Idempotent by `idempotencyKey`: the same key returns the same seq, so a
   * retried send cannot create a second message.
   */
  async reserveSeq(idempotencyKey: string): Promise<{ seq: number; duplicate: boolean }> {
    const key = `idem:${this.state.roomId}:${idempotencyKey}`;
    const existing = await this.storage.get<number>(key);
    if (typeof existing === "number") return { seq: existing, duplicate: true };
    const seq = this.state.lastSeq + 1;
    this.state.lastSeq = seq;
    await this.storage.put(key, seq);
    await this.save();
    return { seq, duplicate: false };
  }

  /** Called only after D1 committed; this is what makes a message broadcastable. */
  async confirmPersisted(seq: number, row: RoomMessageRow): Promise<RoomBroadcast | null> {
    if (row.room_seq !== seq) throw new Error("seq mismatch between DO reservation and D1 row");
    if (seq <= this.state.persistedSeq) return null;
    this.state.persistedSeq = seq;
    await this.save();
    return {
      roomId: this.state.roomId,
      seq,
      frame: {
        type: "EVENT",
        event: {
          schema_version: 1,
          event_id: `evt_${row.message_id}`,
          type: "room.message.created",
          project_id: null,
          room_id: this.state.roomId,
          sequence: seq,
          correlation_id: row.message_id,
          occurred_at: toUtcIso(Date.now()),
          payload: {
            message_id: row.message_id,
            seq,
            author_kind: row.author_kind,
            author_id: row.author_id,
            revision: row.revision,
          },
        },
      },
    };
  }

  /** HELLO handling: replay or demand a snapshot, never an unbounded replay. */
  handleHello(ticket: WsTicketClaims, lastSeenSeq: number | null): ServerFrame {
    if (ticket.room_id !== this.state.roomId) {
      return { type: "CLOSE", reason: "revoked" };
    }
    const plan = planResync(lastSeenSeq, this.state.persistedSeq);
    if (plan.mode === "snapshot_required") {
      return { type: "SNAPSHOT_REQUIRED", reason: plan.reason === "replay" ? "no_cursor" : plan.reason, latest_seq: this.state.persistedSeq };
    }
    return {
      type: "HELLO_OK",
      session_id: `${this.state.roomId}:${lastSeenSeq ?? 0}`,
      resumed_from_seq: plan.fromSeq,
      latest_seq: this.state.persistedSeq,
      server_time: toUtcIso(Date.now()),
    };
  }

  /** Validates an inbound frame; returns the parsed frame or an ERROR frame. */
  parseClientFrame(raw: string, requestId: string): ClientFrame | ServerFrame {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { type: "ERROR", code: "VALIDATION_FAILED", retryable: false, request_id: requestId };
    }
    const result = zClientFrame.safeParse(parsed);
    if (!result.success) {
      return { type: "ERROR", code: "VALIDATION_FAILED", retryable: false, request_id: requestId };
    }
    return result.data;
  }

  /** A revoked permission must cut the socket now; cached events are not served. */
  revokeAll(reason: "revoked" | "expired" | "room_deleted" | "heartbeat_timeout"): void {
    const frame: ServerFrame = { type: "CLOSE", reason };
    for (const socket of this.state.sockets) {
      try {
        socket.send(JSON.stringify(frame));
      } finally {
        socket.close(1008, reason);
      }
    }
    this.state.sockets.clear();
  }

  protected async save(): Promise<void> {
    await this.storage.put(`room:${this.state.roomId}`, {
      lastSeq: this.state.lastSeq,
      persistedSeq: this.state.persistedSeq,
    });
  }
}

export interface RoomSessionState {
  readonly roomId: string;
  lastSeq: number;
  /** Highest seq that is confirmed persisted in D1. */
  persistedSeq: number;
  sockets: Set<SocketLike>;
}

interface SocketRecord {
  readonly socket: SocketLike;
  readonly socketId: string;
  claims: WsTicketClaims;
  lastSeenSeq: number;
  lastHeartbeatMs: number;
  ackedEventId: string | null;
}

export interface PresenceEntry {
  readonly socket_id: string;
  readonly subject_kind: "owner" | "agent";
  readonly subject_id: string;
  readonly connected_at: string;
  readonly last_seen_seq: number;
  readonly last_heartbeat_at: string;
}

/**
 * The production DO body. Wraps RoomCoordinator with ticket verification,
 * presence and the event ring buffer used for bounded replay.
 */
export class RoomLiveSession extends RoomCoordinator {
  private readonly records = new Map<string, SocketRecord>();
  private readonly buffer: { seq: number; frame: ServerFrame }[] = [];
  private readonly ticketKey: string;
  private aclRevision: number;

  constructor(roomId: string, storage: DurableObjectStorageLike, ticketSigningKey: string, aclRevision = 0) {
    super(roomId, storage);
    this.ticketKey = ticketSigningKey;
    this.aclRevision = aclRevision;
  }

  /** Upgrade requires a signed ticket; an unsigned upgrade is refused outright. */
  async accept(ticketToken: string, socket: SocketLike, socketId: string, nowMs = Date.now()): Promise<{ ok: boolean; frame: ServerFrame }> {
    const verification = await verifyWsTicket(ticketToken, this.ticketKey, nowMs);
    if (!verification.ok) {
      socket.close(1008, verification.reason === "expired" ? "expired" : "revoked");
      return { ok: false, frame: { type: "CLOSE", reason: verification.reason === "expired" ? "expired" : "revoked" } };
    }
    if (verification.ticket.room_id !== this.roomId) {
      socket.close(1008, "revoked");
      return { ok: false, frame: { type: "CLOSE", reason: "revoked" } };
    }
    const record: SocketRecord = {
      socket,
      socketId,
      claims: verification.ticket,
      lastSeenSeq: 0,
      lastHeartbeatMs: nowMs,
      ackedEventId: null,
    };
    this.records.set(socketId, record);
    this.state.sockets.add(socket);
    const hello = this.handleHello(verification.ticket, null);
    socket.send(JSON.stringify(hello));
    if (hello.type === "HELLO_OK" && hello.resumed_from_seq !== null) {
      for (const buffered of this.buffer.filter((entry) => entry.seq > hello.resumed_from_seq!)) {
        socket.send(JSON.stringify(buffered.frame));
      }
    }
    return { ok: true, frame: hello };
  }

  /** Client HELLO after reconnect: replay from the buffer when it is still there. */
  resume(socketId: string, lastSeenSeq: number): { frames: ServerFrame[]; snapshotRequired: boolean } {
    const record = this.records.get(socketId);
    if (record === undefined) return { frames: [{ type: "CLOSE", reason: "revoked" }], snapshotRequired: true };
    const plan = planResync(lastSeenSeq, this.latestSeq, MAX_BUFFERED_EVENTS);
    if (plan.mode === "snapshot_required") {
      return { frames: [{ type: "SNAPSHOT_REQUIRED", reason: plan.reason === "replay" ? "no_cursor" : plan.reason, latest_seq: this.latestSeq }], snapshotRequired: true };
    }
    const frames = this.buffer.filter((entry) => entry.seq > lastSeenSeq).map((entry) => entry.frame);
    if (frames.length !== this.latestSeq - lastSeenSeq) {
      // Something was evicted: the honest answer is a snapshot, not a silent hole.
      return { frames: [{ type: "SNAPSHOT_REQUIRED", reason: "gap_too_large", latest_seq: this.latestSeq }], snapshotRequired: true };
    }
    record.lastSeenSeq = lastSeenSeq;
    return { frames, snapshotRequired: false };
  }

  /** Persistence-confirmed broadcast; refuses to fan out an unpersisted seq. */
  async broadcastPersisted(seq: number, row: RoomMessageRow): Promise<number> {
    const broadcast = await this.confirmPersisted(seq, row);
    if (broadcast === null) return 0;
    this.buffer.push({ seq, frame: broadcast.frame });
    if (this.buffer.length > MAX_BUFFERED_EVENTS) this.buffer.shift();
    let delivered = 0;
    for (const record of this.records.values()) {
      record.socket.send(JSON.stringify(broadcast.frame));
      delivered += 1;
    }
    return delivered;
  }

  heartbeat(socketId: string, nowMs = Date.now()): ServerFrame {
    const record = this.records.get(socketId);
    if (record === undefined) return { type: "CLOSE", reason: "revoked" };
    record.lastHeartbeatMs = nowMs;
    return { type: "PONG", sent_at: toUtcIso(nowMs) };
  }

  ack(socketId: string, eventId: string, sequence: number): void {
    const record = this.records.get(socketId);
    if (record === undefined) return;
    record.ackedEventId = eventId;
    record.lastSeenSeq = Math.max(record.lastSeenSeq, sequence);
  }

  /** Any permission change (revocation or a new ACL revision) closes sockets. */
  async reauthorize(nextAclRevision: number): Promise<void> {
    if (nextAclRevision === this.aclRevision) return;
    this.aclRevision = nextAclRevision;
    await this.evictExpiredTickets();
    this.revokeAll("revoked");
  }

  async evictExpiredTickets(nowMs = Date.now()): Promise<number> {
    let evicted = 0;
    for (const [socketId, record] of this.records) {
      if (Date.parse(record.claims.expires_at) < nowMs) {
        record.socket.send(JSON.stringify({ type: "CLOSE", reason: "expired" } satisfies ServerFrame));
        record.socket.close(1008, "expired");
        this.records.delete(socketId);
        this.state.sockets.delete(record.socket);
        evicted += 1;
      }
    }
    return evicted;
  }

  async sweepHeartbeats(nowMs = Date.now(), timeoutMs = HEARTBEAT_TIMEOUT_MS): Promise<number> {
    let dropped = 0;
    for (const [socketId, record] of this.records) {
      if (nowMs - record.lastHeartbeatMs > timeoutMs) {
        record.socket.send(JSON.stringify({ type: "CLOSE", reason: "heartbeat_timeout" } satisfies ServerFrame));
        record.socket.close(1008, "heartbeat_timeout");
        this.records.delete(socketId);
        this.state.sockets.delete(record.socket);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Presence is derived from live authenticated sockets, never from a guess. */
  presence(nowMs = Date.now()): PresenceEntry[] {
    return [...this.records.values()]
      .filter((record) => nowMs - record.lastHeartbeatMs <= HEARTBEAT_TIMEOUT_MS)
      .map((record) => ({
        socket_id: record.socketId,
        subject_kind: record.claims.subject_kind,
        subject_id: record.claims.subject_id,
        connected_at: record.claims.issued_at,
        last_seen_seq: record.lastSeenSeq,
        last_heartbeat_at: toUtcIso(record.lastHeartbeatMs),
      }));
  }

  socketCount(): number {
    return this.records.size;
  }
}

/** Type-only check that the runtime emits only contract-legal frames. */
export function assertServerFrame(frame: unknown): ServerFrame {
  const result = zServerFrame.safeParse(frame);
  if (!result.success) throw new Error("illegal server frame");
  return result.data;
}

/**
 * Cloudflare Durable Object shell. Kept thin: the testable logic is above, and
 * this only wires `fetch` (upgrade) and `alarm` (heartbeat sweep) to it.
 */
export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike & { setAlarm?(at: number): Promise<void> };
  acceptWebSocket?(socket: unknown): void;
  readonly id?: { readonly name?: string; toString(): string };
}

export class RoomDurableObject {
  private readonly state: DurableObjectStateLike;
  private session: RoomLiveSession | null = null;
  private readonly roomId: string;
  private readonly ticketKey: string;

  constructor(state: DurableObjectStateLike, env: { WS_TICKET_SIGNING_KEY?: string; SESSION_SIGNING_KEY?: string }, roomId = "unknown") {
    this.state = state;
    this.roomId = state.id?.name ?? roomId;
    this.ticketKey = env.WS_TICKET_SIGNING_KEY ?? env.SESSION_SIGNING_KEY ?? "";
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ticket = url.searchParams.get("ticket") ?? "";
    if (ticket.length === 0) return new Response(JSON.stringify({ ok: false, code: "AUTH_REQUIRED" }), { status: 401 });
    this.session ??= new RoomLiveSession(this.roomId, this.state.storage, this.ticketKey);
    await this.session.load();
    const upgrade = request.headers.get("upgrade");
    if (upgrade !== "websocket") {
      return new Response(JSON.stringify({ ok: true, data: { presence: this.session.presence() } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const pair = (globalThis as unknown as { WebSocketPair?: new () => Record<string, unknown> }).WebSocketPair;
    if (pair === undefined) return new Response("websocket unavailable", { status: 501 });
    const sockets = new pair();
    const client = sockets["0"] as { accept(): void; send(data: string): void; close(code?: number, reason?: string): void };
    const server = sockets["1"] as { accept(): void };
    client.accept();
    if (this.state.acceptWebSocket === undefined) server.accept();
    const accepted = await this.session.accept(ticket, client, `sock_${Date.now()}`, Date.now());
    if (!accepted.ok) return new Response("unauthorized", { status: 401 });
    await this.state.storage.setAlarm?.(Date.now() + HEARTBEAT_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
  }

  async alarm(): Promise<void> {
    if (this.session === null) return;
    await this.session.sweepHeartbeats();
    await this.state.storage.setAlarm?.(Date.now() + HEARTBEAT_TIMEOUT_MS);
  }
}

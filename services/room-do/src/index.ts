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
  type WireEvent,
  type WsTicketClaims,
} from "@ai-room/contracts";
import { verifySessionToken, verifyWsTicket } from "@ai-room/auth";

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface SocketLike {
  send(data: string): void;
  close(code: number, reason: string): void;
  /** Present on a Cloudflare WebSocket; tests may omit it. */
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
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

  /** Verifies a signed room ticket without attaching a socket (used for broadcasts). */
  async authorize(ticketToken: string, nowMs = Date.now()): Promise<boolean> {
    const verification = await verifyWsTicket(ticketToken, this.ticketKey, nowMs);
    return verification.ok && verification.ticket.room_id === this.roomId;
  }

  /** Attaches a socket whose caller was already verified (ticket or session token). */
  attach(claims: WsTicketClaims, socket: SocketLike, socketId: string, nowMs = Date.now(), lastSeenSeq: number | null = null): ServerFrame {
    const record: SocketRecord = {
      socket,
      socketId,
      claims,
      lastSeenSeq: 0,
      lastHeartbeatMs: nowMs,
      ackedEventId: null,
    };
    this.records.set(socketId, record);
    this.state.sockets.add(socket);
    socket.addEventListener?.("message", (event) => this.onClientFrame(socketId, String(event.data)));
    const hello = this.handleHello(claims, lastSeenSeq);
    record.lastSeenSeq = hello.type === "HELLO_OK" ? (hello.resumed_from_seq ?? lastSeenSeq ?? 0) : (lastSeenSeq ?? 0);
    socket.send(JSON.stringify(hello));
    if (hello.type === "HELLO_OK" && hello.resumed_from_seq !== null) {
      for (const buffered of this.buffer.filter((entry) => entry.seq > hello.resumed_from_seq!)) {
        socket.send(JSON.stringify(buffered.frame));
      }
    }
    return hello;
  }

  /**
   * Fan-out of one D1-persisted message. The gateway sends exactly the event it
   * also serves over HTTPS, so a socket frame and a cursor resync cannot
   * disagree about what happened.
   */
  async publish(seq: number, row: RoomMessageRow, event: WireEvent): Promise<number> {
    if (row.room_seq !== seq) throw new Error("seq mismatch between broadcast and row");
    if (seq <= this.state.persistedSeq) return 0;
    this.state.persistedSeq = seq;
    await this.save();
    const frame: ServerFrame = { type: "EVENT", event };
    this.buffer.push({ seq, frame });
    if (this.buffer.length > MAX_BUFFERED_EVENTS) this.buffer.shift();
    let delivered = 0;
    for (const record of this.records.values()) {
      try {
        record.socket.send(JSON.stringify(frame));
        record.lastSeenSeq = Math.max(record.lastSeenSeq, seq);
        delivered += 1;
      } catch {
        // A dead socket is swept by the heartbeat alarm; one failure must not
        // stop delivery to the others.
      }
    }
    return delivered;
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
    const hello = this.attach(verification.ticket, socket, socketId, nowMs);
    return { ok: true, frame: hello };
  }

  /**
   * One inbound frame from a browser. A PING keeps the presence claim alive; a
   * HELLO asks for a bounded replay; anything invalid gets an ERROR frame rather
   * than silence, so a client never waits forever for an answer.
   */
  onClientFrame(socketId: string, raw: string): void {
    const record = this.records.get(socketId);
    if (record === undefined) return;
    record.lastHeartbeatMs = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      record.socket.send(JSON.stringify({ type: "ERROR", code: "VALIDATION_FAILED", retryable: false, request_id: `ws_${socketId}` } satisfies ServerFrame));
      return;
    }
    const result = zClientFrame.safeParse(parsed);
    if (!result.success) {
      record.socket.send(JSON.stringify({ type: "ERROR", code: "VALIDATION_FAILED", retryable: false, request_id: `ws_${socketId}` } satisfies ServerFrame));
      return;
    }
    const frame = result.data;
    if (frame.type === "PING") {
      record.socket.send(JSON.stringify({ type: "PONG", sent_at: toUtcIso(Date.now()) } satisfies ServerFrame));
      return;
    }
    if (frame.type === "ACK") {
      this.ack(socketId, frame.event_id, frame.sequence);
      return;
    }
    if (frame.type === "RESYNC_NEEDED") {
      record.socket.send(JSON.stringify({ type: "SNAPSHOT_REQUIRED", reason: "permission_changed", latest_seq: this.latestSeq } satisfies ServerFrame));
      return;
    }
    // HELLO: resume from the requested cursor, replaying only what the buffer holds.
    const resumed = this.resume(socketId, frame.last_seen_seq ?? 0);
    for (const outbound of resumed.frames) record.socket.send(JSON.stringify(outbound));
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

interface WebSocketLike extends SocketLike {
  accept(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export class RoomDurableObject {
  private readonly state: DurableObjectStateLike;
  private session: RoomLiveSession | null = null;
  private readonly roomId: string;
  private readonly ticketKey: string;
  private readonly sessionKey: string;

  constructor(state: DurableObjectStateLike, env: { WS_TICKET_SIGNING_KEY?: string; SESSION_SIGNING_KEY?: string }, roomId = "unknown") {
    this.state = state;
    this.roomId = state.id?.name ?? roomId;
    this.ticketKey = env.WS_TICKET_SIGNING_KEY ?? env.SESSION_SIGNING_KEY ?? "";
    this.sessionKey = env.SESSION_SIGNING_KEY ?? env.WS_TICKET_SIGNING_KEY ?? "";
  }

  /**
   * The upgrade is forwarded with the browser's own headers, so the session
   * arrives as the HttpOnly cookie the page already holds (or a bearer token
   * for API clients). The gateway has already checked room membership; this
   * check is about who is on the socket, not what they may read.
   */
  private async claimsFromRequest(request: Request, url: URL, nowMs: number): Promise<{ ok: true; claims: WsTicketClaims } | { ok: false; reason: string }> {
    const pathRoom = /\/rooms\/([^/]+)\/events/.exec(url.pathname)?.[1];
    if (pathRoom !== undefined && decodeURIComponent(pathRoom) !== this.roomId) return { ok: false, reason: "room_mismatch" };

    const ticket = url.searchParams.get("ticket") ?? "";
    if (ticket.length > 0) {
      const verified = await verifyWsTicket(ticket, this.ticketKey, nowMs);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      if (verified.ticket.room_id !== this.roomId) return { ok: false, reason: "room_mismatch" };
      return { ok: true, claims: verified.ticket };
    }

    const header = request.headers.get("authorization") ?? "";
    let token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token.length === 0) {
      for (const part of (request.headers.get("cookie") ?? "").split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name === "air_session") token = decodeURIComponent(rest.join("="));
      }
    }
    if (token.length === 0) return { ok: false, reason: "no_credential" };
    const session = await verifySessionToken(token, this.sessionKey, nowMs);
    if (!session.ok) return { ok: false, reason: session.reason };
    if (session.claims.sub_kind !== "owner" && session.claims.sub_kind !== "agent") return { ok: false, reason: "subject_kind" };
    return {
      ok: true,
      claims: {
        ticket_id: session.claims.session_id,
        subject_kind: session.claims.sub_kind,
        subject_id: session.claims.sub_id,
        room_id: this.roomId,
        project_id: null,
        permissions: ["ws.subscribe", "room.message.read", "room.message.create"],
        issued_at: session.claims.iat,
        expires_at: session.claims.exp,
        nonce: session.claims.jti.length >= 16 ? session.claims.jti : `${session.claims.jti}.session`.slice(-32),
      },
    };
  }

  private async liveSession(): Promise<RoomLiveSession> {
    this.session ??= new RoomLiveSession(this.roomId, this.state.storage, this.ticketKey);
    await this.session.load();
    return this.session;
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify({ ok: status < 400, data }), { status, headers: { "content-type": "application/json" } });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const session = await this.liveSession();

    // The gateway hands over a persisted message here so connected clients get
    // it without a reload. Internal to the Worker binding, but still ticketed.
    if (url.pathname.endsWith("/broadcast")) {
      const ticket = url.searchParams.get("ticket") ?? "";
      if (ticket.length === 0) return this.json({ code: "AUTH_REQUIRED" }, 401);
      if (!(await session.authorize(ticket))) return this.json({ code: "AUTH_REVOKED" }, 401);
      const body = (await request.json().catch(() => null)) as { row?: RoomMessageRow; event?: WireEvent } | null;
      if (body?.row === undefined || body.event === undefined) return this.json({ code: "VALIDATION_FAILED" }, 422);
      const delivered = await session.publish(body.row.room_seq, body.row, body.event);
      return this.json({ delivered });
    }

    const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase();
    if (upgrade !== "websocket") {
      return this.json({ presence: session.presence(), latest_seq: session.latestSeq });
    }

    // Verify before creating the socket: an unauthenticated upgrade must answer
    // with a plain 401, not a half-open connection that dies as code 1006.
    const nowMs = Date.now();
    const verified = await this.claimsFromRequest(request, url, nowMs);
    if (!verified.ok) return this.json({ code: "AUTH_REVOKED", reason: verified.reason }, 401);

    const pair = (globalThis as unknown as { WebSocketPair?: new () => Record<string, unknown> }).WebSocketPair;
    if (pair === undefined) return new Response("websocket unavailable", { status: 501 });
    const sockets = new pair();
    const client = sockets["0"] as WebSocketLike;
    const server = sockets["1"] as WebSocketLike;
    // Only the DO-held half is accepted here; the half returned in the 101 is
    // accepted by the runtime. Accepting both halves closes the pair at once
    // (the browser saw an immediate 1006).
    server.accept();
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = cursorRaw !== null && /^\d+$/.test(cursorRaw) ? Number.parseInt(cursorRaw, 10) : null;
    session.attach(verified.claims, server, `sock_${nowMs}`, nowMs, cursor);
    try {
      await this.state.storage.setAlarm?.(nowMs + HEARTBEAT_TIMEOUT_MS);
    } catch {
      // An alarm is housekeeping; losing it must not drop the live socket.
    }
    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
  }

  async alarm(): Promise<void> {
    if (this.session === null) return;
    await this.session.sweepHeartbeats();
    await this.state.storage.setAlarm?.(Date.now() + HEARTBEAT_TIMEOUT_MS);
  }
}

/**
 * Room realtime stream (spec 19.3).
 *
 * The Room Durable Object owns `room_seq`; this client never invents ordering.
 * If a gap appears, it resyncs over HTTPS instead of guessing — and it reports
 * the connection state honestly so the UI cannot show "live" while disconnected.
 */
import type { MessageDto } from "./types.js";

export type StreamStatus = "idle" | "connecting" | "live" | "reconnecting" | "closed" | "error";

export interface RoomStreamOptions {
  baseUrl: string;
  roomId: string;
  /** Called for each new/updated message event. */
  onMessage: (message: MessageDto, event: string) => void;
  /** Called when the server says the client must refetch (gap / unknown version). */
  onResync: (reason: string) => void;
  onStatus: (status: StreamStatus, detail?: string) => void;
  /**
   * Called once per disconnect before reconnecting when the close looks like an
   * expired session (1008 expired/revoked, 4401/4403, or an abnormal 1006 where
   * the upgrade was refused). Resolve true when the session was renewed.
   */
  onAuthExpired?: () => Promise<boolean>;
  /** Tests inject a WebSocket implementation. */
  WebSocketImpl?: typeof WebSocket;
  maxRetries?: number;
}

interface ServerEvent {
  type?: string;
  schema_version?: number;
  room_seq?: number;
  sequence?: number;
  message?: MessageDto;
  payload?: { message?: MessageDto; [key: string]: unknown };
  /** The Room DO wraps an event as `{ type: "EVENT", event: WireEvent }`. */
  event?: {
    type?: string;
    schema_version?: number;
    sequence?: number;
    room_seq?: number;
    payload?: { message?: MessageDto; [key: string]: unknown };
  };
  reason?: string;
}

export class RoomStream {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retries = 0;
  private lastSeq: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** One renewal attempt per outage: a live socket clears it again. */
  private renewTried = false;
  private renewing = false;
  private readonly options: RoomStreamOptions;
  private readonly WS: typeof WebSocket;

  constructor(options: RoomStreamOptions) {
    this.options = options;
    this.WS = options.WebSocketImpl ?? WebSocket;
  }

  get statusSeq(): number | null {
    return this.lastSeq;
  }

  connect(sinceSeq: number | null = null): void {
    if (this.ws) return;
    this.closedByUser = false;
    this.lastSeq = sinceSeq ?? this.lastSeq;
    this.options.onStatus(this.retries === 0 ? "connecting" : "reconnecting");
    const base = this.options.baseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
    const query = this.lastSeq === null ? "" : `?cursor=${this.lastSeq}`;
    const url = `${base}/v1/rooms/${encodeURIComponent(this.options.roomId)}/events${query}`;

    let socket: WebSocket;
    try {
      socket = new this.WS(url);
    } catch (error) {
      this.options.onStatus("error", error instanceof Error ? error.message : "WebSocket 생성 실패");
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.retries = 0;
      this.renewTried = false;
      this.options.onStatus("live");
      // Presence is kept alive by a real frame: the DO drops a socket that has
      // been silent past its heartbeat window, and an idle reader is not dead.
      this.stopPing();
      this.pingTimer = setInterval(() => {
        if (socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify({ type: "PING", sent_at: new Date().toISOString() }));
        } catch {
          /* the close handler will reconnect */
        }
      }, 20_000);
    };

    socket.onmessage = (event: MessageEvent) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(String(event.data)) as ServerEvent;
      } catch {
        return; // garbage frames are ignored, never rendered
      }
      // Two shapes reach the client: the bare event the contract tests use
      // (`{type:"room.message.created", message}`) and the clamped frame the Room
      // DO sends (`{type:"EVENT", event:{…}}`). Both are read here once.
      const envelope = parsed.event ?? parsed;
      if (envelope.schema_version !== undefined && envelope.schema_version > 1) {
        this.options.onResync(`unknown schema_version ${envelope.schema_version}`);
        return;
      }
      const type = envelope.type ?? "";
      const message = parsed.message ?? envelope.payload?.message;
      const seq = envelope.sequence ?? parsed.room_seq ?? envelope.room_seq ?? message?.room_seq ?? null;
      if (parsed.type === "SNAPSHOT_REQUIRED") {
        this.options.onResync(`server requested resync (${parsed.reason ?? "snapshot"})`);
        return;
      }
      if (parsed.type === "CLOSE") {
        this.options.onStatus("error", `서버가 연결을 닫았습니다(${parsed.reason ?? "closed"})`);
        return;
      }

      if (seq !== null && this.lastSeq !== null && seq > this.lastSeq + 1) {
        this.options.onResync(`gap: ${this.lastSeq} → ${seq}`);
        return;
      }
      if (seq !== null) this.lastSeq = seq;

      if (message && type.startsWith("room.message")) {
        this.options.onMessage(message, type);
      }
      if (type === "resync.required") {
        this.options.onResync("server requested resync");
      }
    };

    socket.onerror = () => {
      this.options.onStatus("error", "실시간 연결 오류");
    };

    socket.onclose = (event: CloseEvent) => {
      this.ws = null;
      this.stopPing();
      if (this.closedByUser) {
        this.options.onStatus("closed");
        return;
      }
      const reason = String(event.reason ?? "");
      const authClose =
        event.code === 4401 ||
        event.code === 4403 ||
        (event.code === 1008 && /expired|revoked/i.test(reason)) ||
        // A refused upgrade reaches the browser as an abnormal close, with no
        // handshake to read: that is exactly the "session died" case.
        event.code === 1006;
      if (authClose && !this.renewTried && this.options.onAuthExpired !== undefined) {
        this.renewTried = true;
        this.renewing = true;
        this.options.onStatus("reconnecting", "세션 연장 후 재연결 중");
        void this.renewThenReconnect();
        return;
      }
      if (event.code === 4401 || event.code === 4403) {
        this.options.onStatus("error", `인증 거부(code ${event.code})`);
        return;
      }
      const max = this.options.maxRetries ?? 8;
      if (this.retries >= max) {
        this.options.onStatus("error", `재연결 한도 초과(${max}회) — 새로고침이 필요합니다`);
        return;
      }
      const delay = Math.min(15000, 800 * 2 ** this.retries);
      this.retries += 1;
      this.options.onStatus("reconnecting", `${Math.round(delay / 100) / 10}초 후 재연결`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect(this.lastSeq);
      }, delay);
    };
  }

  private async renewThenReconnect(): Promise<void> {
    let renewed = false;
    try {
      renewed = (await this.options.onAuthExpired?.()) ?? false;
    } catch {
      renewed = false;
    }
    this.renewing = false;
    if (this.closedByUser) return;
    if (renewed) {
      // The new session cookie is already in the jar: reconnect at once, with the
      // same cursor, so nothing is re-read and no message is skipped.
      this.retries = 0;
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect(this.lastSeq);
      return;
    }
    this.options.onStatus("error", "세션이 만료되었습니다 — 다시 로그인하세요");
  }

  /**
   * Reconnect now if the socket is not live. A tab in the background is
   * throttled (its ping can miss the server's heartbeat window) and may be
   * frozen outright; both are repaired here the moment it is looked at again.
   */
  ensureConnected(): void {
    if (this.closedByUser || this.renewing) return;
    if (this.ws !== null && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retries = 0;
    this.connect(this.lastSeq);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close(): void {
    this.closedByUser = true;
    this.renewing = false;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, "client closed");
    this.ws = null;
    this.options.onStatus("closed");
  }
}

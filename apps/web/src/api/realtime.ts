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
  /** Tests inject a WebSocket implementation. */
  WebSocketImpl?: typeof WebSocket;
  maxRetries?: number;
}

interface ServerEvent {
  type?: string;
  schema_version?: number;
  room_seq?: number;
  message?: MessageDto;
  payload?: { message?: MessageDto };
}

export class RoomStream {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retries = 0;
  private lastSeq: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
      this.options.onStatus("live");
    };

    socket.onmessage = (event: MessageEvent) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(String(event.data)) as ServerEvent;
      } catch {
        return; // garbage frames are ignored, never rendered
      }
      if (parsed.schema_version !== undefined && parsed.schema_version > 1) {
        this.options.onResync(`unknown schema_version ${parsed.schema_version}`);
        return;
      }
      const type = parsed.type ?? "";
      const message = parsed.message ?? parsed.payload?.message;
      const seq = parsed.room_seq ?? message?.room_seq ?? null;

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
      if (this.closedByUser) {
        this.options.onStatus("closed");
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

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, "client closed");
    this.ws = null;
    this.options.onStatus("closed");
  }
}

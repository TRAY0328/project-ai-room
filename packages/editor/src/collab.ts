/**
 * Yjs WebSocket provider (sync + awareness) — the browser side of collab-do.
 *
 * Written here instead of pulling a full provider because we need two things a
 * generic provider hides:
 *   - an honest status machine (`connecting` → `synced` only after step 2), and
 *   - cookie-first auth, so no access token has to sit in a URL.
 *
 * Protocol (y-websocket compatible): message 0 = sync, message 1 = awareness,
 * message 9 = our auth/hello frame (ignored by servers that do not know it).
 */
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_HELLO = 9;

export type CollabStatus = "idle" | "connecting" | "synced" | "disconnected" | "error";

export interface CollabProviderOptions {
  url: string;
  room: string;
  doc: Y.Doc;
  /** Sent as a hello frame, never in the URL. Prefer cookie sessions. */
  token?: string;
  /** Reconnect rules; tests pass 0 to stay deterministic. */
  reconnect?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  onStatus?: (status: CollabStatus, detail?: string) => void;
}

export class CollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private ws: WebSocket | null = null;
  private readonly url: string;
  readonly room: string;
  private readonly token?: string;
  private readonly reconnectConfig: { attempts: number; baseDelayMs: number; maxDelayMs: number };
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private _status: CollabStatus = "idle";
  private detail?: string;
  private readonly onStatus?: CollabProviderOptions["onStatus"];

  constructor(options: CollabProviderOptions) {
    this.doc = options.doc;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.url = options.url;
    this.room = options.room;
    this.token = options.token;
    this.reconnectConfig = {
      attempts: options.reconnect?.attempts ?? 8,
      baseDelayMs: options.reconnect?.baseDelayMs ?? 600,
      maxDelayMs: options.reconnect?.maxDelayMs ?? 8000,
    };
    this.onStatus = options.onStatus;

    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
  }

  get status(): CollabStatus {
    return this._status;
  }

  get statusDetail(): string | undefined {
    return this.detail;
  }

  private setStatus(status: CollabStatus, detail?: string): void {
    this._status = status;
    this.detail = detail;
    this.onStatus?.(status, detail);
  }

  connect(): void {
    if (this.destroyed || this.ws) return;
    this.setStatus("connecting");
    const base = this.url.replace(/\/$/, "");
    const target = `${base.includes("/collab") ? base : `${base}/collab`}/${encodeURIComponent(this.room)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(target);
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : "WebSocket 생성 실패");
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      this.attempts = 0;
      if (this.token) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_HELLO);
        encoding.writeVarString(enc, this.token);
        ws.send(encoding.toUint8Array(enc));
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      ws.send(encoding.toUint8Array(encoder));
      // announce our own awareness (name/colour/cursor) right away
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys())),
      );
      ws.send(encoding.toUint8Array(awarenessEncoder));
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        const messageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (messageType === syncProtocol.messageYjsSyncStep2 && this._status !== "synced") {
          // Step 2 arrived: the server's state is now merged into this doc.
          this.setStatus("synced");
        }
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
      }
    };

    ws.onerror = () => {
      this.setStatus("error", "WebSocket 오류 — 서버 상태를 확인하세요");
    };

    ws.onclose = (event: CloseEvent) => {
      this.ws = null;
      if (this.destroyed) return;
      if (event.code === 4401 || event.code === 4403) {
        this.setStatus("error", `인증 거부(code ${event.code}) — 다시 로그인해야 합니다`);
        return;
      }
      this.setStatus("disconnected", `연결 종료(code ${event.code})`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.attempts >= this.reconnectConfig.attempts) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const delay = Math.min(this.reconnectConfig.maxDelayMs, this.reconnectConfig.baseDelayMs * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.ws.send(encoding.toUint8Array(encoder));
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const changed = [...added, ...updated, ...removed];
    if (changed.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    this.ws.send(encoding.toUint8Array(encoder));
  };

  private onOnline = () => {
    if (this._status !== "synced") this.connect();
  };

  private onOffline = () => {
    this.setStatus("disconnected", "네트워크 끊김 — 로컬 편집은 계속됩니다(서버 저장 아님)");
  };

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, "client disconnect");
    this.ws = null;
    this.setStatus("idle");
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    this.awareness.destroy();
  }
}

/** Peers currently present in the awareness map — the only source for cursors. */
export interface PeerPresence {
  clientId: number;
  name: string;
  color: string;
  isSelf: boolean;
}

export function listPeers(awareness: awarenessProtocol.Awareness, selfId: number): PeerPresence[] {
  const peers: PeerPresence[] = [];
  awareness.getStates().forEach((state, clientId) => {
    const user = (state as { user?: { name?: string; color?: string } }).user;
    peers.push({
      clientId,
      name: user?.name ?? `client ${clientId}`,
      color: user?.color ?? "#888888",
      isSelf: clientId === selfId,
    });
  });
  return peers;
}

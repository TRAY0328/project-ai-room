import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClient, newIdempotencyKey } from "../api/client.js";
import type { MessageDto, OwnerSessionDto } from "../api/types.js";

export type ConnectionState = "unconfigured" | "checking" | "ready" | "unauthenticated" | "unreachable" | "degraded";

export interface OutboxItem {
  id: string;
  idempotencyKey: string;
  roomId: string;
  blocks: MessageDto["blocks"];
  createdAt: string;
  state: "pending" | "sending" | "failed";
  attempts: number;
  lastError?: string;
  /** Set only after the server acknowledged the write. */
  serverMessageId?: string;
}

interface AppContextValue {
  client: ApiClient;
  gatewayUrl: string | null;
  setGatewayUrl: (url: string | null) => void;
  connection: { state: ConnectionState; detail: string; checkedAt: number | null };
  refreshConnection: () => Promise<void>;
  session: OwnerSessionDto | null;
  setSession: (session: OwnerSessionDto | null) => void;
  demoMode: boolean;
  setDemoMode: (on: boolean) => void;
  outbox: OutboxItem[];
  enqueueMessage: (roomId: string, blocks: MessageDto["blocks"]) => OutboxItem;
  flushOutbox: () => Promise<void>;
  retryOutbox: (id: string) => Promise<void>;
  discardOutbox: (id: string) => void;
  lastFlush: { at: number; sent: number; failed: number } | null;
}

const AppContext = createContext<AppContextValue | null>(null);

const GATEWAY_KEY = "air.gateway";
const DEMO_KEY = "air.demo";
const OUTBOX_KEY = "air.outbox";

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage may be blocked; UI still works in-memory */
  }
}

function loadOutbox(): OutboxItem[] {
  const raw = readStorage(OUTBOX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as OutboxItem[];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Application state: gateway configuration, honest connection status, owner
 * session, demo-mode flag and the offline outbox.
 *
 * The outbox is the only place a message can exist before the server has it,
 * and it says so (`state: pending`) instead of showing a fake "전송됨".
 */
export function AppStateProvider({ children, initialGateway = null }: { children: ReactNode; initialGateway?: string | null }) {
  const [gatewayUrl, setGatewayUrlState] = useState<string | null>(() => readStorage(GATEWAY_KEY) ?? initialGateway);
  const [demoMode, setDemoModeState] = useState<boolean>(() => readStorage(DEMO_KEY) === "1");
  const [session, setSession] = useState<OwnerSessionDto | null>(null);
  const [connection, setConnection] = useState<{ state: ConnectionState; detail: string; checkedAt: number | null }>({
    state: gatewayUrl ? "checking" : "unconfigured",
    detail: gatewayUrl ? "게이트웨이 확인 중" : "게이트웨이 URL이 설정되지 않았습니다",
    checkedAt: null,
  });
  const [outbox, setOutbox] = useState<OutboxItem[]>(() => loadOutbox());
  const [lastFlush, setLastFlush] = useState<{ at: number; sent: number; failed: number } | null>(null);
  const flushing = useRef(false);

  const client = useMemo(
    () => new ApiClient({ baseUrl: gatewayUrl, onUnauthorized: () => setConnection((prev) => (prev.state === "ready" ? { state: "unauthenticated", detail: "세션이 만료되었습니다 — 다시 로그인하세요", checkedAt: Date.now() } : prev)) }),
    [gatewayUrl],
  );

  const setGatewayUrl = useCallback((url: string | null) => {
    const clean = url?.trim().replace(/\/+$/, "") || null;
    setGatewayUrlState(clean);
    writeStorage(GATEWAY_KEY, clean);
    setConnection({ state: clean ? "checking" : "unconfigured", detail: clean ? "게이트웨이 확인 중" : "게이트웨이 URL이 설정되지 않았습니다", checkedAt: null });
  }, []);

  const setDemoMode = useCallback((on: boolean) => {
    setDemoModeState(on);
    writeStorage(DEMO_KEY, on ? "1" : "0");
  }, []);

  const refreshConnection = useCallback(async () => {
    if (!gatewayUrl) {
      setConnection({ state: "unconfigured", detail: "게이트웨이 URL이 설정되지 않았습니다", checkedAt: null });
      return;
    }
    setConnection((prev) => ({ ...prev, state: prev.state === "ready" ? "ready" : "checking", detail: "게이트웨이 확인 중" }));
    const health = await client.request<{ status?: string }>("GET", "/v1/health/ready");
    if (!health.ok) {
      if (health.status === 0) {
        setConnection({ state: "unreachable", detail: health.message, checkedAt: Date.now() });
        return;
      }
      setConnection({ state: "degraded", detail: `게이트웨이 응답 ${health.status}: ${health.message}`, checkedAt: Date.now() });
      return;
    }
    const auth = await client.request<unknown>("GET", "/v1/agents");
    if (auth.ok) {
      setConnection({ state: "ready", detail: "게이트웨이 정상 · 소유자 세션 유효", checkedAt: Date.now() });
    } else if (auth.status === 401) {
      setConnection({ state: "unauthenticated", detail: "게이트웨이 정상 · 로그인 필요", checkedAt: Date.now() });
    } else {
      setConnection({ state: "degraded", detail: `${auth.code}: ${auth.message}`, checkedAt: Date.now() });
    }
  }, [client, gatewayUrl]);

  useEffect(() => {
    void refreshConnection();
    const timer = setInterval(() => void refreshConnection(), 45000);
    return () => clearInterval(timer);
  }, [refreshConnection]);

  useEffect(() => {
    writeStorage(OUTBOX_KEY, JSON.stringify(outbox));
  }, [outbox]);

  const enqueueMessage = useCallback((roomId: string, blocks: MessageDto["blocks"]): OutboxItem => {
    const item: OutboxItem = {
      id: `out-${newIdempotencyKey("m").slice(6, 18)}`,
      idempotencyKey: newIdempotencyKey("msg"),
      roomId,
      blocks,
      createdAt: new Date().toISOString(),
      state: "pending",
      attempts: 0,
    };
    setOutbox((prev) => [...prev, item]);
    return item;
  }, []);

  const flushOutbox = useCallback(async () => {
    if (flushing.current) return;
    if (!gatewayUrl) return;
    flushing.current = true;
    let sent = 0;
    let failed = 0;
    try {
      const snapshot = outbox.filter((item) => item.state !== "sending");
      for (const item of snapshot) {
        setOutbox((prev) => prev.map((m) => (m.id === item.id ? { ...m, state: "sending", attempts: m.attempts + 1 } : m)));
        const result = await client.request<{ message_id?: string }>("POST", `/v1/rooms/${encodeURIComponent(item.roomId)}/messages`, {
          body: { blocks: item.blocks },
          idempotencyKey: item.idempotencyKey,
        });
        if (result.ok) {
          sent += 1;
          setOutbox((prev) => prev.filter((m) => m.id !== item.id));
        } else {
          failed += 1;
          setOutbox((prev) =>
            prev.map((m) =>
              m.id === item.id
                ? { ...m, state: result.retryable ? "pending" : "failed", lastError: `${result.code}: ${result.message}` }
                : m,
            ),
          );
          if (!result.retryable) break;
        }
      }
    } finally {
      flushing.current = false;
      setLastFlush({ at: Date.now(), sent, failed });
    }
  }, [client, gatewayUrl, outbox]);

  // Auto-flush when the gateway comes back and there is queued work.
  useEffect(() => {
    if (connection.state === "ready" && outbox.some((i) => i.state === "pending")) void flushOutbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.state]);

  const retryOutbox = useCallback(async (id: string) => {
    setOutbox((prev) => prev.map((m) => (m.id === id ? { ...m, state: "pending", lastError: undefined } : m)));
    await flushOutbox();
  }, [flushOutbox]);

  const discardOutbox = useCallback((id: string) => {
    setOutbox((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ client, gatewayUrl, setGatewayUrl, connection, refreshConnection, session, setSession, demoMode, setDemoMode, outbox, enqueueMessage, flushOutbox, retryOutbox, discardOutbox, lastFlush }),
    [client, gatewayUrl, setGatewayUrl, connection, refreshConnection, session, demoMode, setDemoMode, outbox, enqueueMessage, flushOutbox, retryOutbox, discardOutbox, lastFlush],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppStateProvider>");
  return ctx;
}

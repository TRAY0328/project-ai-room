import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClient, newIdempotencyKey } from "../api/client.js";
import { SessionKeeper, type RenewOutcome } from "../api/session.js";
import type { MessageDto, OwnerSessionDto } from "../api/types.js";
import type { WireMessage } from "../api/wire.js";

export type ConnectionState = "unconfigured" | "checking" | "ready" | "unauthenticated" | "unreachable" | "degraded";

/** What one flush actually did — the screen shows this instead of a guess. */
export interface FlushResult {
  sent: number;
  failed: number;
  /** Messages the server acknowledged, ready to render without a reload. */
  accepted: WireMessage[];
  lastError?: string;
  busy?: boolean;
}

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
  /**
   * Extends the cookie session in the background. The realtime stream calls it
   * before reconnecting after an auth close; 401s in the API client call it too.
   */
  renewSession: () => Promise<RenewOutcome>;
  /** Records when the access cookie dies, so the renewal timer aims at it. */
  noteSessionExpiry: (accessExpiresAt?: string | null) => void;
  session: OwnerSessionDto | null;
  setSession: (session: OwnerSessionDto | null) => void;
  /**
   * Who the browser is posting as. An owner comes from `session`; an AI that
   * joined by key has no owner session, so the name it registered with is kept
   * here (display only) and its own messages are signed with that name.
   */
  self: { actor_id: string; display_name: string; kind: "owner" | "agent" };
  setAgentSelf: (self: { agent_id: string; display_name: string } | null) => void;
  demoMode: boolean;
  setDemoMode: (on: boolean) => void;
  outbox: OutboxItem[];
  enqueueMessage: (roomId: string, blocks: MessageDto["blocks"]) => OutboxItem;
  flushOutbox: () => Promise<FlushResult>;
  retryOutbox: (id: string) => Promise<void>;
  discardOutbox: (id: string) => void;
  lastFlush: { at: number; sent: number; failed: number } | null;
}

const AppContext = createContext<AppContextValue | null>(null);

const GATEWAY_KEY = "air.gateway";
const DEMO_KEY = "air.demo";
const OUTBOX_KEY = "air.outbox";
/** Display-only owner hint (never a token): lets a reload show who is signed in. */
const OWNER_KEY = "air.owner";

/**
 * The deployed client is served by the gateway itself, so its own origin *is* the
 * API base. Without this a first visit on the real site says "게이트웨이 URL이
 * 설정되지 않았습니다" and login cannot run until someone types the URL by hand.
 * A local dev/preview origin is not the API, so it stays unconfigured.
 */
function defaultGateway(): string | null {
  if (typeof window === "undefined") return null;
  const { protocol, hostname, origin } = window.location;
  if (protocol !== "https:") return null;
  if (hostname === "localhost" || hostname === "127.0.0.1") return null;
  return origin;
}

function readOwnerHint(): OwnerSessionDto | null {
  const raw = readStorage(OWNER_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as OwnerSessionDto;
    return typeof parsed.owner_id === "string" && typeof parsed.display_name === "string" ? { ...parsed, role: "owner" } : null;
  } catch {
    return null;
  }
}

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
  const [gatewayUrl, setGatewayUrlState] = useState<string | null>(() => readStorage(GATEWAY_KEY) ?? initialGateway ?? defaultGateway());
  const [demoMode, setDemoModeState] = useState<boolean>(() => readStorage(DEMO_KEY) === "1");
  const [session, setSessionState] = useState<OwnerSessionDto | null>(() => readOwnerHint());
  const [connection, setConnection] = useState<{ state: ConnectionState; detail: string; checkedAt: number | null }>({
    state: gatewayUrl ? "checking" : "unconfigured",
    detail: gatewayUrl ? "게이트웨이 확인 중" : "게이트웨이 URL이 설정되지 않았습니다",
    checkedAt: null,
  });
  const [outbox, setOutboxState] = useState<OutboxItem[]>(() => loadOutbox());
  /**
   * The queue is read again the instant it changes. Without this, `send()` called
   * `flushOutbox()` in the same tick as `enqueueMessage()` and the flush saw the
   * previous array — the message stayed "전송 대기" even after the server stored it.
   */
  const outboxRef = useRef<OutboxItem[]>(outbox);
  const setOutbox = useCallback((update: (prev: OutboxItem[]) => OutboxItem[]) => {
    const next = update(outboxRef.current);
    outboxRef.current = next;
    setOutboxState(next);
  }, []);
  const [agentSelf, setAgentSelfState] = useState<{ agent_id: string; display_name: string } | null>(null);
  const [lastFlush, setLastFlush] = useState<{ at: number; sent: number; failed: number } | null>(null);
  const flushing = useRef(false);
  /** Read by the session keeper, which must not re-create on every render. */
  const connectionRef = useRef<{ state: ConnectionState; detail: string; checkedAt: number | null }>(connection);
  connectionRef.current = connection;
  const sessionRef = useRef<OwnerSessionDto | null>(session);
  sessionRef.current = session;

  const setSession = useCallback((next: OwnerSessionDto | null) => {
    setSessionState(next);
    writeStorage(OWNER_KEY, next === null ? null : JSON.stringify({ owner_id: next.owner_id, display_name: next.display_name, email: next.email ?? undefined, role: "owner" }));
  }, []);

  /**
   * One keeper per gateway. It renews the cookie session before it expires and
   * only reports "logged out" when the server itself refuses the renewal.
   */
  const keeper = useMemo(
    () =>
      new SessionKeeper({
        baseUrl: () => gatewayUrl,
        // Renew unless the app already knows the visitor is signed out. A tab
        // opened after the access token died has no local hint yet, so "checking"
        // must still be allowed to try once; a refused renewal then settles it.
        canRenew: () => sessionRef.current !== null || connectionRef.current.state !== "unauthenticated",
        onRenewed: () => setConnection((prev) => (prev.state === "ready" ? { ...prev, detail: "게이트웨이 정상 · 세션 자동 연장됨", checkedAt: Date.now() } : prev)),
        onExpired: (detail) => {
          setSessionState(null);
          writeStorage(OWNER_KEY, null);
          setConnection({ state: "unauthenticated", detail: `세션이 만료되었습니다 — 다시 로그인하세요 (${detail})`, checkedAt: Date.now() });
        },
      }),
    [gatewayUrl],
  );

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: gatewayUrl,
        renewSession: async () => (await keeper.renew("http-401")) === "renewed",
        onUnauthorized: () => setConnection((prev) => (prev.state === "ready" ? { state: "unauthenticated", detail: "세션이 만료되었습니다 — 다시 로그인하세요", checkedAt: Date.now() } : prev)),
      }),
    [gatewayUrl, keeper],
  );

  const setAgentSelf = useCallback((next: { agent_id: string; display_name: string } | null) => {
    setAgentSelfState(next);
  }, []);

  const self = useMemo<{ actor_id: string; display_name: string; kind: "owner" | "agent" }>(() => {
    if (session !== null) return { actor_id: session.owner_id, display_name: session.display_name, kind: "owner" };
    if (agentSelf !== null) return { actor_id: agentSelf.agent_id, display_name: agentSelf.display_name, kind: "agent" };
    return { actor_id: "self", display_name: "나 (이 브라우저)", kind: "agent" };
  }, [session, agentSelf]);

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
    const auth = await client.request<unknown>("GET", "/v1/rooms");
    if (auth.ok) {
      // The cookie session survived a reload: keep the display name, drop the
      // hint only when the server says the session is gone.
      // `/v1/rooms` is readable by an owner *and* by an agent (it lists the rooms
      // that identity belongs to), so an AI that joined from the browser sees a
      // ready connection instead of a false "로그인 필요".
      setConnection({ state: "ready", detail: "게이트웨이 정상 · 세션 유효", checkedAt: Date.now() });
    } else if (auth.status === 401) {
      setSessionState((prev) => {
        if (prev !== null) writeStorage(OWNER_KEY, null);
        return null;
      });
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

  // Renewal runs only while a session is actually known to be alive; a signed-out
  // visitor gets no refresh traffic.
  useEffect(() => {
    if (connection.state === "ready") {
      keeper.start();
      return () => keeper.stop();
    }
    keeper.stop();
    return undefined;
  }, [connection.state, keeper]);

  // A background tab is throttled or frozen, so its timer may simply be late.
  // Coming back into view (or back online) is the moment to catch up.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const wake = () => void keeper.renewIfStale();
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", wake);
    };
  }, [keeper]);

  const renewSession = useCallback(() => keeper.renew("client"), [keeper]);
  const noteSessionExpiry = useCallback((accessExpiresAt?: string | null) => keeper.noteLogin(accessExpiresAt), [keeper]);

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

  const flushOutbox = useCallback(async (): Promise<FlushResult> => {
    if (flushing.current) return { sent: 0, failed: 0, accepted: [], busy: true };
    if (!gatewayUrl) return { sent: 0, failed: 0, accepted: [], lastError: "게이트웨이 URL이 없습니다" };
    flushing.current = true;
    let sent = 0;
    let failed = 0;
    let lastError: string | undefined;
    const accepted: WireMessage[] = [];
    try {
      const snapshot = outboxRef.current.filter((item) => item.state !== "sending");
      for (const item of snapshot) {
        setOutbox((prev) => prev.map((m) => (m.id === item.id ? { ...m, state: "sending", attempts: m.attempts + 1 } : m)));
        const result = await client.request<{ message?: WireMessage }>("POST", `/v1/rooms/${encodeURIComponent(item.roomId)}/messages`, {
          body: { blocks: item.blocks },
          idempotencyKey: item.idempotencyKey,
        });
        if (result.ok) {
          sent += 1;
          if (result.data?.message) accepted.push(result.data.message);
          setOutbox((prev) => prev.filter((m) => m.id !== item.id));
        } else {
          failed += 1;
          lastError = `${result.code}: ${result.message}`;
          setOutbox((prev) =>
            prev.map((m) =>
              m.id === item.id
                ? { ...m, state: result.retryable ? "pending" : "failed", lastError: lastError }
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
    return { sent, failed, accepted, ...(lastError === undefined ? {} : { lastError }) };
  }, [client, gatewayUrl, setOutbox]);

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
    () => ({ client, gatewayUrl, setGatewayUrl, connection, refreshConnection, renewSession, noteSessionExpiry, session, setSession, self, setAgentSelf, demoMode, setDemoMode, outbox, enqueueMessage, flushOutbox, retryOutbox, discardOutbox, lastFlush }),
    [client, gatewayUrl, setGatewayUrl, connection, refreshConnection, renewSession, noteSessionExpiry, session, setSession, self, setAgentSelf, demoMode, setDemoMode, outbox, enqueueMessage, flushOutbox, retryOutbox, discardOutbox, lastFlush],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppStateProvider>");
  return ctx;
}

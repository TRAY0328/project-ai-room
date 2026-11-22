import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, Card, Dialog, Drawer, Field, Icon, IconButton, Reveal, SectionHeader, Tabs, TextArea, TextInput } from "@ai-room/design-system";
import { useApp } from "../state/AppState.js";
import { useResource, relativeTime, listOf } from "../api/hooks.js";
import { RoomStream, type StreamStatus } from "../api/realtime.js";
import { newIdempotencyKey } from "../api/client.js";
import type { AgentSummary, MemoryRecordDto, MessageDto, RoomSummary, SearchHitDto } from "../api/types.js";
import { demoAgents, demoMemory, demoMessages, demoRooms, demoSearchHits } from "../demo/fixtures.js";
import { normalizeWireMessage, type WireMessage } from "../api/wire.js";
import { readCachedMessages, readCachedRooms, readLastRoomId, rememberLastRoomId, writeCachedMessages, writeCachedRooms } from "../api/chat-cache.js";
import { Composer, EditHistoryDialog, MessageList, ThreadPanel, type ComposerSendMeta, type MessageActionHandlers } from "../components/chat/index.js";
import { DemoChip, DemoNote, EmptyHint, ResourceView, ScreenHeader, Section } from "../components/ui.js";
import { openAppNav } from "../lib/shell-nav.js";
import { chatTime, initialsOf } from "../lib/chat-format.js";
import type { ScreenId } from "../lib/router.js";

type Navigate = (id: ScreenId, params?: Record<string, string>) => void;

/** The gateway spells a room as `room_type` + `latest_seq`; a screen reads `kind` + a last activity. */
function normalizeRoom(raw: RoomSummary): RoomSummary {
  const record = raw as unknown as Record<string, unknown>;
  const type = typeof record["room_type"] === "string" ? record["room_type"] : typeof record["kind"] === "string" ? record["kind"] : "custom";
  const kind: RoomSummary["kind"] = type === "main" || type === "default" ? "default" : type === "project" ? "project" : "custom";
  return {
    room_id: raw.room_id,
    name: raw.name,
    kind,
    ...(typeof raw.member_count === "number" ? { member_count: raw.member_count } : {}),
    ...(typeof raw.unread_count === "number" ? { unread_count: raw.unread_count } : {}),
    ...(typeof record["updated_at"] === "string" ? { last_message_at: record["updated_at"] } : raw.last_message_at === undefined ? {} : { last_message_at: raw.last_message_at }),
    ...(raw.project_id === undefined || raw.project_id === null ? {} : { project_id: raw.project_id }),
    ...(typeof record["pinned"] === "boolean" ? { pinned: record["pinned"] } : kind === "default" ? { pinned: true } : {}),
    ...(raw.topic === undefined || raw.topic === null ? {} : { topic: raw.topic }),
  };
}

function useRooms() {
  const { client, gatewayUrl, demoMode } = useApp();
  const rooms = useResource<RoomSummary[]>(client, "/v1/rooms", { enabled: Boolean(gatewayUrl) && !demoMode, pollMs: 30000 });
  // The list this browser saw last time is drawn first, so the room name and the
  // default room do not wait for a request. The server answer replaces it.
  const cached = useMemo(() => readCachedRooms(), []);
  const live = useMemo(
    () => (rooms.state.kind === "ready" ? listOf<RoomSummary>(rooms.state.data).map(normalizeRoom) : null),
    [rooms.state],
  );
  useEffect(() => {
    if (live !== null && live.length > 0 && !demoMode) writeCachedRooms(live);
  }, [live, demoMode]);
  const list = demoMode ? demoRooms : live !== null && live.length > 0 ? live : cached;
  return { list, state: rooms.state, reload: rooms.reload };
}

function roomIcon(room: RoomSummary): "chat" | "project" | "rooms" {
  return room.kind === "default" ? "chat" : room.kind === "project" ? "project" : "rooms";
}

const LIVE_TEXT: Record<StreamStatus, string> = {
  idle: "실시간 연결 준비",
  connecting: "실시간 연결 중",
  live: "실시간 연결",
  reconnecting: "재연결 중",
  closed: "실시간 연결 종료",
  error: "실시간 연결 오류",
};

/** Newest messages drawn on entering a room; the rest follows the scroll. */
const INITIAL_PAGE = 40;
/** One older page per scroll-to-top. */
const OLDER_PAGE = 30;

/* ----------------------------------------------------------------- MAINCHAT */

export function MainChatScreen({ navigate }: { navigate: Navigate }) {
  const { client, gatewayUrl, demoMode, outbox, enqueueMessage, flushOutbox, connection, self, session, renewSession } = useApp();
  const rooms = useRooms();
  // The room this browser was last in is remembered, so the first message request
  // starts on mount instead of after the room list answers. Until the list
  // arrives there is nothing to contradict it; if the room is gone (or no longer
  // readable) the effect below moves to the first room the server lists.
  const rememberedRoomId = useMemo(() => readLastRoomId(), []);
  const [roomId, setRoomId] = useState<string>(rememberedRoomId ?? "");
  const agentsRes = useResource<AgentSummary[]>(client, "/v1/agents", { enabled: Boolean(gatewayUrl) && !demoMode });
  const messagesRes = useResource<{ room_id?: string; messages?: WireMessage[]; items?: WireMessage[]; latest_seq?: number }>(client, roomId === "" ? null : `/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
    enabled: Boolean(gatewayUrl) && !demoMode,
    // One screenful plus a little: the rest arrives when the reader scrolls up,
    // which keeps the first answer small and the first paint quick.
    query: { limit: INITIAL_PAGE },
  });

  // What this browser already had for the room, in the renderer's shape. It is a
  // first paint, not an answer: the server page replaces it by message_id.
  const [seeded, setSeeded] = useState<MessageDto[]>(() =>
    demoMode || session === null || rememberedRoomId === null ? [] : [...(readCachedMessages(rememberedRoomId)?.messages ?? [])],
  );
  const [older, setOlder] = useState<MessageDto[]>([]);
  const [olderState, setOlderState] = useState<{ loading: boolean; done: boolean; error: string | null }>({ loading: false, done: false, error: null });
  const loadingOlderRef = useRef(false);

  const agentList = demoMode ? demoAgents : agentsRes.state.kind === "ready" ? listOf<AgentSummary>(agentsRes.state.data) : [];
  const agentName = (id: string): string => agentList.find((a) => a.agent_id === id)?.display_name ?? (id === self.actor_id ? self.display_name : id);
  const serverMessages = useMemo<MessageDto[]>(() => {
    if (demoMode) return demoMessages.filter((m) => m.room_id === roomId);
    if (messagesRes.state.kind !== "ready") return [];
    const data = messagesRes.state.data;
    // The resource keeps its last answer while a new path loads; that answer can
    // belong to the room the reader just left. Drawing it into this room would
    // mix two conversations, so it is only used when it names this room.
    if (typeof data.room_id === "string" && data.room_id !== roomId) return [];
    const items = data.items ?? data.messages ?? [];
    return items.map((m) => normalizeWireMessage(m, agentName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, roomId, messagesRes.state, agentList, self.actor_id, self.display_name]);

  // Server rows win over the cache and over a page loaded by scrolling up; the
  // merge is by message_id so a message is never drawn twice.
  const baseMessages: MessageDto[] = useMemo(() => {
    if (demoMode) return serverMessages;
    const byId = new Map<string, MessageDto>();
    for (const message of seeded) byId.set(message.message_id, message);
    for (const message of older) byId.set(message.message_id, message);
    for (const message of serverMessages) byId.set(message.message_id, message);
    return [...byId.values()];
  }, [demoMode, serverMessages, seeded, older]);

  const [replyTo, setReplyTo] = useState<MessageDto | null>(null);
  const [threadRoot, setThreadRoot] = useState<MessageDto | null>(null);
  const [important, setImportant] = useState<Set<string>>(new Set());
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
  const [mineReactions, setMineReactions] = useState<Record<string, string[]>>({});
  const [reactions, setReactions] = useState<Record<string, Record<string, number>>>({});
  const [historyFor, setHistoryFor] = useState<MessageDto | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [threadNotify, setThreadNotify] = useState(true);
  const [live, setLive] = useState<{ status: StreamStatus; detail?: string; received: number }>({ status: "idle", received: 0 });
  const [realtimeMessages, setRealtimeMessages] = useState<MessageDto[]>([]);
  const streamRef = useRef<RoomStream | null>(null);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [creatingRoom, setCreatingRoom] = useState(false);

  const messages: MessageDto[] = useMemo(() => {
    const merged = [...baseMessages];
    for (const message of realtimeMessages) {
      if (!merged.some((m) => m.message_id === message.message_id)) merged.push(message);
    }
    // The server serves a page newest-first; a chat reads oldest-first, and
    // room_seq is the only ordering authority.
    return merged.sort((a, b) => (a.room_seq ?? Number.MAX_SAFE_INTEGER) - (b.room_seq ?? Number.MAX_SAFE_INTEGER));
  }, [baseMessages, realtimeMessages]);

  /** The newest `agentName`, readable from a timer without re-creating it. */
  const agentNameRef = useRef(agentName);
  agentNameRef.current = agentName;
  const messagesRef = useRef<MessageDto[]>(messages);
  messagesRef.current = messages;
  const reloadMessagesRef = useRef(messagesRes.reload);
  reloadMessagesRef.current = messagesRes.reload;
  /** Whether the first page of this room has arrived (used by the stream resync). */
  const pageReadyRef = useRef(messagesRes.state.kind === "ready");
  pageReadyRef.current = messagesRes.state.kind === "ready";

  // Entering (or switching) a room: the previous room's cache, older pages and
  // live rows do not belong to this one.
  useEffect(() => {
    if (roomId === "") return;
    rememberLastRoomId(roomId);
    loadingOlderRef.current = false;
    setOlder([]);
    setOlderState({ loading: false, done: false, error: null });
    setSeeded(demoMode || session === null ? [] : [...(readCachedMessages(roomId)?.messages ?? [])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Remember what is on screen, so the next visit paints before the network
  // answers. Throttled: a busy room must not write storage per message.
  const cachedAtRef = useRef(0);
  useEffect(() => {
    if (demoMode || roomId === "" || messages.length === 0) return;
    const now = Date.now();
    if (now - cachedAtRef.current < 1500) return;
    cachedAtRef.current = now;
    const state = messagesRes.state;
    const latest = state.kind === "ready" && (state.data.room_id === undefined || state.data.room_id === roomId) ? state.data.latest_seq ?? null : null;
    writeCachedMessages(roomId, messages, latest);
  }, [messages, roomId, demoMode, messagesRes.state]);

  /**
   * One older page, keyed by the oldest `room_seq` on screen. `done` is set when
   * the server returns fewer rows than asked for — the client cannot see
   * `page.has_more` (the envelope is unwrapped), and one short page is proof.
   */  const loadOlder = useCallback(async () => {
    if (demoMode || roomId === "" || !gatewayUrl || loadingOlderRef.current || olderState.done) return;
    const seqs = messagesRef.current.map((m) => m.room_seq).filter((seq): seq is number => typeof seq === "number");
    if (seqs.length === 0) return;
    const oldestSeq = Math.min(...seqs);
    if (oldestSeq <= 1) {
      setOlderState({ loading: false, done: true, error: null });
      return;
    }
    loadingOlderRef.current = true;
    setOlderState((prev) => ({ ...prev, loading: true, error: null }));
    const result = await client.request<{ items?: WireMessage[]; messages?: WireMessage[] }>(
      "GET",
      `/v1/rooms/${encodeURIComponent(roomId)}/messages?limit=${OLDER_PAGE}&cursor=${oldestSeq}`,
    );
    loadingOlderRef.current = false;
    if (!result.ok) {
      setOlderState({ loading: false, done: false, error: `${result.code}: ${result.message}` });
      return;
    }
    const wires = result.data.items ?? result.data.messages ?? [];
    const normalized = wires.map((wire) => normalizeWireMessage(wire, agentNameRef.current));
    setOlder((prev) => {
      const seen = new Set(prev.map((m) => m.message_id));
      return [...normalized.filter((m) => !seen.has(m.message_id)), ...prev];
    });
    setOlderState({ loading: false, done: wires.length < OLDER_PAGE, error: null });
  }, [client, demoMode, gatewayUrl, roomId, olderState.done]);

  // A first page shorter than the page size is the whole room: there is nothing
  // above it, so the "more" control and the scroll trigger must not appear.
  useEffect(() => {
    if (demoMode || messagesRes.state.kind !== "ready") return;
    const data = messagesRes.state.data;
    if (data.room_id !== undefined && data.room_id !== roomId) return;
    const count = (data.items ?? data.messages ?? []).length;
    if (count === 0 || count >= INITIAL_PAGE) return;
    setOlderState((prev) => (prev.done ? prev : { ...prev, done: true }));
  }, [messagesRes.state, roomId, demoMode]);

  // Without a live socket the page would go stale silently. A tail sync asks only
  // for messages after the newest one on screen (`after_seq`), so the safety net
  // is a few hundred bytes instead of the whole page.
  useEffect(() => {
    if (demoMode || !gatewayUrl || roomId === "" || live.status === "live") return;
    let cancelled = false;
    const sync = async () => {
      const seqs = messagesRef.current.map((m) => m.room_seq).filter((seq): seq is number => typeof seq === "number");
      const head = seqs.length === 0 ? 0 : Math.max(...seqs);
      const result = await client.request<{ items?: WireMessage[]; latest_seq?: number }>(
        "GET",
        `/v1/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${head}&limit=100`,
      );
      if (cancelled || !result.ok) return;
      const wires = result.data.items ?? [];
      if (wires.length > 0) {
        const normalized = wires.map((wire) => normalizeWireMessage(wire, agentNameRef.current));
        setRealtimeMessages((prev) => {
          const byId = new Map(prev.map((m) => [m.message_id, m]));
          for (const m of normalized) byId.set(m.message_id, m);
          return [...byId.values()];
        });
        return;
      }
      // Nothing after the head although the room moved on: something the reader
      // had went away. The full page is the honest repair.
      if (head > 0 && typeof result.data.latest_seq === "number" && result.data.latest_seq > head) reloadMessagesRef.current();
    };
    const timer = window.setInterval(() => void sync(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, demoMode, gatewayUrl, roomId, live.status]);

  // Realtime room stream: only when a gateway and a real room exist. Gaps trigger an HTTPS resync.
  const pageState = messagesRes.state.kind;
  useEffect(() => {
    if (!gatewayUrl || demoMode || !client.baseUrl || roomId === "") {
      setLive({ status: "idle", received: 0 });
      return;
    }
    // Subscribing before the first page is in hand means subscribing without a
    // cursor, and the server answers that with "send me a snapshot" — which made
    // the screen fetch the very page it was already waiting for. Waiting for the
    // page (a fraction of a second now) lets the socket start at a real cursor.
    if (pageState === "idle" || pageState === "loading") {
      setLive((prev) => (prev.status === "live" ? prev : { ...prev, status: "connecting" }));
      return;
    }
    const stream = new RoomStream({
      baseUrl: client.baseUrl,
      roomId,
      onStatus: (status, detail) => setLive((prev) => ({ ...prev, status, detail })),
      onMessage: (message) => {
        const normalized = normalizeWireMessage(message as unknown as WireMessage, (id) => agentName(id));
        setRealtimeMessages((prev) => (prev.some((m) => m.message_id === normalized.message_id) ? prev.map((m) => (m.message_id === normalized.message_id ? normalized : m)) : [...prev, normalized]));
        setLive((prev) => ({ ...prev, received: prev.received + 1 }));
      },
      onResync: (reason) => {
        // A first subscribe without a cursor is answered with "send me a snapshot".
        // The page request already in flight IS that snapshot: reloading here
        // would open a second identical request and make the reader wait twice.
        if (/no_cursor|snapshot/i.test(reason) && !pageReadyRef.current) return;
        messagesRes.reload();
        // A first subscribe has no cursor yet, so the server always asks for a
        // snapshot. That is the normal path, not a warning the user must read.
        if (!/no_cursor|snapshot/i.test(reason)) setToast(`실시간 순서 공백 감지(${reason}) — 서버에서 다시 불러왔습니다`);
      },
      // The socket dies with the session (or refuses the upgrade): extend the
      // session first and reconnect with the same cursor, instead of asking the
      // user to sign in again every 30 minutes.
      onAuthExpired: async () => (await renewSession()) === "renewed",
    });
    streamRef.current = stream;
    stream.connect(messages.at(-1)?.room_seq ?? null);
    return () => {
      stream.close();
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayUrl, demoMode, roomId, client, renewSession, pageState]);

  useEffect(() => {
    setRealtimeMessages([]);
  }, [roomId]);

  // A hidden tab is throttled (its ping can miss the server's 45 s heartbeat
  // window) or frozen outright. Returning to the tab repairs the socket at once
  // rather than after a backoff, so "실시간 수신" is honest when it is read.
  useEffect(() => {
    const wake = () => streamRef.current?.ensureConnected();
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", wake);
    };
  }, []);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const room = rooms.list.find((r) => r.room_id === roomId) ?? null;
  const roomReady = room !== null;
  const pendingHere = outbox.filter((o) => o.roomId === roomId && (o.state === "pending" || o.state === "failed"));
  const needsSignIn = !demoMode && !roomReady && (
    connection.state === "unauthenticated" ||
    messagesRes.state.kind === "unauthenticated" ||
    rooms.state.kind === "unauthenticated"
  );

  // The room list arrives after the first render: move to the real default room
  // once it exists instead of keeping the placeholder id forever.
  useEffect(() => {
    if (rooms.list.length > 0 && !rooms.list.some((r) => r.room_id === roomId)) {
      setRoomId(rooms.list[0]!.room_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms.list]);

  const send = async (blocks: MessageDto["blocks"], _plain: string, meta?: ComposerSendMeta) => {
    enqueueMessage(roomId, blocks, {
      ...(meta?.replyToId ? { replyToId: meta.replyToId } : {}),
      ...(meta?.mentionedIds && meta.mentionedIds.length > 0 ? { mentionedAgentIds: meta.mentionedIds } : {}),
    });
    if (connection.state !== "ready") {
      setToast("오프라인: 보관함에 저장했습니다 (서버 저장 아님)");
      setReplyTo(null);
      return;
    }
    const result = await flushOutbox();
    if (result.accepted.length > 0) {
      // The POST answer carries the stored message, so the screen shows it now —
      // without waiting for the socket or a refetch.
      setRealtimeMessages((prev) => {
        const next = [...prev];
        for (const wire of result.accepted) {
          const normalized = normalizeWireMessage(wire, (id) => agentName(id));
          if (!next.some((m) => m.message_id === normalized.message_id)) next.push(normalized);
        }
        return next;
      });
      messagesRes.reload();
      if (result.failed > 0) setToast(`${result.accepted.length}건 전송됨 · ${result.failed}건 실패 — ${result.lastError ?? "서버 응답 확인 필요"}`);
    } else if (result.failed > 0) {
      setToast(`전송 실패 — ${result.lastError ?? "서버가 거부했습니다"}`);
    } else if (result.busy) {
      setToast("전송 중입니다 — 진행 중인 전송이 끝나면 결과가 표시됩니다");
    } else {
      setToast("전송 요청이 남아 있습니다 — 보관함에서 다시 시도하세요");
    }
    setReplyTo(null);
  };

  /** Adds a reaction and keeps the server's aggregate; cancelling is local only (no DELETE route). */
  const react = async (message: MessageDto, emoji: string) => {
    const mine = mineReactions[message.message_id] ?? [];
    const already = mine.includes(emoji);
    const current = reactions[message.message_id] ?? message.reactions ?? {};
    const nextMine = already ? mine.filter((e) => e !== emoji) : [...mine, emoji];
    setMineReactions((prev) => ({ ...prev, [message.message_id]: nextMine }));
    setReactions((prev) => ({
      ...prev,
      [message.message_id]: { ...current, [emoji]: Math.max(0, (current[emoji] ?? 0) + (already ? -1 : 1)) },
    }));
    if (already) {
      setToast("반응을 이 화면에서 해제했습니다 — 서버는 반응 추가만 저장합니다");
      return;
    }
    if (demoMode || !gatewayUrl) return;
    const res = await client.request<{ reactions?: Array<{ emoji_key?: string; count?: number }> }>("POST", `/v1/messages/${encodeURIComponent(message.message_id)}/reactions`, {
      body: { emoji_key: emoji },
      idempotencyKey: newIdempotencyKey("reaction"),
    });
    if (res.ok) {
      const counts: Record<string, number> = {};
      for (const entry of res.data?.reactions ?? []) {
        if (typeof entry.emoji_key === "string" && typeof entry.count === "number") counts[entry.emoji_key] = entry.count;
      }
      if (Object.keys(counts).length > 0) setReactions((prev) => ({ ...prev, [message.message_id]: counts }));
    } else {
      // Put the optimistic count back: the server did not store it.
      setMineReactions((prev) => ({ ...prev, [message.message_id]: mine }));
      setReactions((prev) => ({ ...prev, [message.message_id]: current }));
      setToast(`반응을 저장하지 못했습니다 — ${res.code}: ${res.message}`);
    }
  };

  const copyText = (message: MessageDto) => {
    const text = message.blocks
      .map((b) => (typeof b.payload["markdown"] === "string" ? b.payload["markdown"] : typeof b.payload["text"] === "string" ? b.payload["text"] : ""))
      .filter(Boolean)
      .join("\n");
    void navigator.clipboard?.writeText(text);
    setToast("메시지를 복사했습니다");
  };

  const handlers: MessageActionHandlers = {
    onReply: (m) => setReplyTo(m),
    onCreateThread: (m) => setThreadRoot(m),
    onTogglePin: () => setToast("고정 요청 — 서버가 승인하면 방 상세에 표시됩니다"),
    onToggleBookmark: (m) => setBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(m.message_id)) next.delete(m.message_id);
      else next.add(m.message_id);
      return next;
    }),
    onCopyText: copyText,
    onShareReference: (m) => {
      void navigator.clipboard?.writeText(`${window.location.origin}${location.pathname}#/chat?m=${m.message_id}`);
      setToast("공유 참조 링크를 복사했습니다");
    },
    onCopyLink: (m) => {
      void navigator.clipboard?.writeText(`${window.location.origin}${location.pathname}#/chat?m=${m.message_id}`);
      setToast("링크 복사됨");
    },
    onToggleImportant: (m) => setImportant((prev) => {
      const next = new Set(prev);
      if (next.has(m.message_id)) next.delete(m.message_id);
      else next.add(m.message_id);
      return next;
    }),
    onOpenEditHistory: (m) => setHistoryFor(m),
    onToggleReaction: (m, emoji) => void react(m, emoji),
    onAddReaction: (m, emoji) => void react(m, emoji),
  };

  const createRoom = async () => {
    const name = newRoomName.trim();
    if (name.length === 0 || demoMode || !gatewayUrl) return;
    setCreatingRoom(true);
    const res = await client.request<{ room_id?: string }>("POST", "/v1/rooms", {
      body: { name, room_type: "custom" },
      idempotencyKey: newIdempotencyKey("room"),
    });
    setCreatingRoom(false);
    if (res.ok && typeof res.data?.room_id === "string") {
      await rooms.reload();
      setRoomId(res.data.room_id);
      setNewRoomOpen(false);
      setNewRoomName("");
      setRoomsOpen(false);
      setToast(`"${name}" 방을 만들었습니다`);
    } else if (!res.ok) {
      setToast(`방을 만들지 못했습니다 — ${res.code}: ${res.message}`);
    } else {
      setToast("방은 만들어졌지만 id를 받지 못했습니다 — 방 목록을 새로고침합니다");
      await rooms.reload();
    }
  };

  const memberCount = room?.member_count ?? agentList.length + 1;
  const liveTone = live.status === "live" ? "live" : live.status === "reconnecting" ? "warn" : live.status === "error" ? "error" : "idle";
  const liveLabel = live.status === "live"
    ? LIVE_TEXT.live
    : live.status === "reconnecting"
      ? LIVE_TEXT.reconnecting
      : live.status === "error"
        ? LIVE_TEXT.error
        : connection.state === "ready"
          ? "연결 준비"
          : "오프라인 · 초안 보관";

  return (
    <div className="air-chat-screen">
      <header className="air-chat-head">
        <button type="button" className="air-chat-head-btn" onClick={openAppNav} aria-label="메뉴 열기" data-testid="chat-open-nav">
          <Icon name="menu" size={18} />
        </button>

        <div className="air-chat-head-main">
          <button type="button" className="air-chat-room-btn" onClick={() => setRoomsOpen(true)} aria-haspopup="dialog" data-testid="chat-room-switch">
            <span className="air-chat-room-name air-truncate">{room?.name ?? (needsSignIn ? "단체 채팅" : "방 불러오는 중…")}</span>
            <Icon name="chevronDown" size={14} />
          </button>
          <div className="air-chat-subline">
            <span className="air-chat-live" data-state={liveTone} title={live.detail ?? liveLabel} data-testid="chat-live-state">
              <span className="air-chat-live-dot" data-state={liveTone} aria-hidden="true" />
              {liveLabel}
            </span>
            <span className="air-chat-dot">·</span>
            <button type="button" className="air-chat-members-link" onClick={() => setMembersOpen(true)}>
              <Icon name="user" size={12} /> {memberCount}명
            </button>
            {demoMode ? <DemoChip on /> : null}
          </div>
        </div>

        <div className="air-chat-head-actions">
          <button type="button" className="air-avatar-stack" onClick={() => setMembersOpen(true)} aria-label={`참여 멤버 ${memberCount}명 보기`} title="참여 멤버">
            {agentList.slice(0, 3).map((agent) => (
              <span key={agent.agent_id} className="air-avatar air-avatar-stack-item" title={agent.display_name}>{initialsOf(agent.display_name)}</span>
            ))}
            <span className="air-avatar air-avatar-stack-item" data-owner="true" title={self.display_name}>{initialsOf(self.display_name)}</span>
          </button>
          <button type="button" className="air-chat-head-btn" onClick={() => setNewRoomOpen(true)} aria-label="새 방 만들기" title="새 방 만들기" data-testid="chat-new-room">
            <Icon name="plus" size={18} />
          </button>
        </div>
      </header>

      {demoMode ? <div className="air-chat-demo"><DemoNote /></div> : null}
      {!demoMode && needsSignIn ? (
        <div className="air-chat-gate">
          <div className="air-chat-gate-card">
            <span className="air-chat-gate-icon" aria-hidden="true">💬</span>
            <h2>AI ROOM에 오신 것을 환영합니다</h2>
            <p>대화를 읽고 보내려면 소유자로 로그인하거나, AI를 초대해 이 방에 참여시키세요.</p>
            <div className="air-chat-gate-actions">
              <Button variant="primary" icon="lock" onClick={() => navigate("SIGNIN")}>소유자로 로그인</Button>
              <Button variant="ghost" icon="key" onClick={() => navigate("AIJOIN")}>AI 참여 포털</Button>
            </div>
            <span className="air-hint">처음이라면 AI 참여 포털에서 초대 코드로 AI를 등록할 수 있습니다.</span>
          </div>
        </div>
      ) : (
        <>
          {!demoMode && !roomReady && roomId === "" ? (
            <div className="air-chat-gate">
              <div className="air-chat-loading" role="status">
                <span className="air-chat-spinner" aria-hidden="true" />
                방 정보를 불러오는 중입니다…
              </div>
            </div>
          ) : null}

          {!demoMode && (messagesRes.state.kind === "unavailable" || messagesRes.state.kind === "error") ? (
            <div className="air-chat-note">
              <ResourceView state={messagesRes.state} onRetry={messagesRes.reload}>
                {() => null}
              </ResourceView>
            </div>
          ) : null}

          <div className="air-chat" data-thread={threadRoot ? "open" : undefined}>
            <div className="air-chat-main">
              {roomId !== "" || demoMode ? (
                <MessageList
                  messages={messages.map((m) => ({
                    ...m,
                    reactions: { ...(m.reactions ?? {}), ...(reactions[m.message_id] ?? {}) },
                  }))}
                  pending={pendingHere.map((item) => ({ item }))}
                  handlers={handlers}
                  self={self}
                  roomId={roomId}
                  nameOf={agentName}
                  onLoadOlder={() => void loadOlder()}
                  loadingOlder={olderState.loading}
                  hasOlder={!olderState.done}
                  olderError={olderState.error}
                />
              ) : null}

              <Composer
                roomId={roomId}
                agents={agentList.map((a) => ({ agent_id: a.agent_id, display_name: a.display_name, kind: a.kind ?? "agent" }))}
                onSend={(blocks, plain, meta) => void send(blocks, plain, meta)}
                disabled={!roomReady && !demoMode}
                replyTo={replyTo}
                replyToName={replyTo?.author.actor_id === self.actor_id ? self.display_name : replyTo ? agentName(replyTo.author.actor_id) : undefined}
                onCancelReply={() => setReplyTo(null)}
                typing={[]}
                onAttach={() => setToast("첨부는 파일 화면에서 업로드합니다 — 업로드 진행률과 SHA-256이 표시됩니다")}
              />
            </div>

            {threadRoot ? (
              <ThreadPanel
                root={threadRoot}
                replies={[]}
                onClose={() => setThreadRoot(null)}
                notifyEnabled={threadNotify}
                onNotifyToggle={() => setThreadNotify((v) => !v)}
                composer={<Composer roomId={roomId} agents={agentList.map((a) => ({ agent_id: a.agent_id, display_name: a.display_name, kind: a.kind ?? "agent" }))} onSend={(blocks, plain, meta) => void send(blocks, plain, meta)} />}
              />
            ) : null}
          </div>
        </>
      )}

      {/* Room switcher: a drawer on a phone, the same drawer on a desktop — one list, one behaviour. */}
      <Drawer open={roomsOpen} onClose={() => setRoomsOpen(false)} title="방" side="left">
        <div className="air-room-sheet" data-testid="chat-room-drawer">
          {rooms.list.length === 0 ? <span className="air-hint" style={{ padding: 10, display: "block" }}>방 정보를 불러오는 중입니다…</span> : null}
          {rooms.list.map((item) => (
            <button
              key={item.room_id}
              type="button"
              className="air-room-item"
              data-active={item.room_id === roomId || undefined}
              aria-current={item.room_id === roomId ? "true" : undefined}
              onClick={() => {
                setRoomId(item.room_id);
                setRoomsOpen(false);
              }}
            >
              <span className="air-room-icon"><Icon name={roomIcon(item)} size={15} /></span>
              <span className="air-room-text">
                <span className="air-room-name air-truncate">{item.name}{item.pinned ? <span className="air-room-pin">기본</span> : null}</span>
                <span className="air-room-meta">{item.member_count ?? "?"}명 · {item.last_message_at ? relativeTime(item.last_message_at) : "기록 없음"}</span>
              </span>
              {item.unread_count ? <span className="air-room-badge">{item.unread_count}</span> : null}
            </button>
          ))}
          <button type="button" className="air-room-add" onClick={() => { setRoomsOpen(false); setNewRoomOpen(true); }}>
            <Icon name="plus" size={14} /> 새 방 만들기
          </button>
          <div className="air-room-sheet-foot">
            <button type="button" className="air-btn" data-variant="ghost" data-size="sm" onClick={() => { setRoomsOpen(false); navigate("ROOMS"); }}>
              <Icon name="rooms" size={13} /> 방 관리 화면 열기
            </button>
          </div>
        </div>
      </Drawer>

      <Dialog open={membersOpen} onClose={() => setMembersOpen(false)} title={`참여 멤버 ${memberCount}명`} description="AI는 초대 코드로 참여하고, 이름 옆 표시는 검증 수준입니다">
        <div className="air-member-list" data-testid="chat-member-list">
          <div className="air-member-row">
            <span className="air-avatar" data-ring="verified">{initialsOf(self.display_name)}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="air-member-name">{self.display_name}</div>
              <div className="air-hint">나 · {self.kind === "owner" ? "소유자" : "AI 세션"}</div>
            </div>
            <Badge tone="ok">현재</Badge>
          </div>
          {agentList.map((agent) => (
            <div key={agent.agent_id} className="air-member-row">
              <span className="air-avatar">{initialsOf(agent.display_name)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="air-member-name">{agent.display_name}</div>
                <div className="air-hint">{agent.provider ? `${agent.provider} · ` : ""}{agent.attestation === "provider_verified" ? "공급자 검증" : "자체 신고"}</div>
              </div>
              <Badge tone="info">AI</Badge>
            </div>
          ))}
          {agentList.length === 0 ? <span className="air-hint">아직 참여한 AI가 없습니다 — AI 참여 포털에서 초대할 수 있습니다.</span> : null}
        </div>
      </Dialog>

      <Dialog
        open={newRoomOpen}
        onClose={() => setNewRoomOpen(false)}
        title="새 방 만들기"
        description="이름만 정하면 바로 만들어집니다"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewRoomOpen(false)}>취소</Button>
            <Button variant="primary" icon="plus" disabled={newRoomName.trim().length === 0 || demoMode || !gatewayUrl} busy={creatingRoom} onClick={() => void createRoom()}>
              {creatingRoom ? "만드는 중…" : "만들기"}
            </Button>
          </>
        }
      >
        <div style={{ display: "grid", gap: 10 }}>
          <Field label="방 이름" htmlFor="new-room-name" required hint="예: 콘텐츠 제작, 배포 점검">
            <TextInput
              id="new-room-name"
              value={newRoomName}
              maxLength={120}
              autoFocus
              placeholder="방 이름"
              onChange={(e) => setNewRoomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createRoom();
              }}
            />
          </Field>
          <Banner tone="info" icon="info">기본 단체방은 한 번만 만들 수 있습니다. 만든 사람에게 자동 권한 승격은 없습니다.</Banner>
        </div>
      </Dialog>

      {toast ? (
        <div className="air-toast air-toast-float" role="status">
          <Icon name="info" size={13} />
          <span style={{ flex: 1 }}>{toast}</span>
          <IconButton icon="close" label="닫기" onClick={() => setToast(null)} />
        </div>
      ) : null}

      <EditHistoryDialog message={historyFor} onClose={() => setHistoryFor(null)} />
    </div>
  );
}

/* -------------------------------------------------------------------- ROOMS */

export function RoomsScreen({ navigate }: { navigate: Navigate }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const rooms = useRooms();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"custom" | "project">("custom");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteRoom, setInviteRoom] = useState<RoomSummary | null>(null);
  const [inviteAgent, setInviteAgent] = useState("");

  const create = async () => {
    const clean = name.trim();
    if (clean.length === 0) return;
    setCreating(true);
    const res = await client.request<{ room_id?: string }>("POST", "/v1/rooms", {
      body: { name: clean, room_type: kind },
      idempotencyKey: newIdempotencyKey("room"),
    });
    setCreating(false);
    if (res.ok) {
      setOpen(false);
      setName("");
      setNotice(`"${clean}" 방을 만들었습니다`);
      rooms.reload();
    } else {
      setNotice(`방을 만들지 못했습니다 — ${res.code}: ${res.message}`);
    }
  };

  return (
    <div className="air-screen">
      <ScreenHeader
        title="방 목록"
        subtitle="기본 단체방 1개는 고정 · 추가 방 생성·초대·퇴장·프로젝트 연결"
        badges={<DemoChip on={demoMode} />}
        actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>방 만들기</Button>}
      />
      {demoMode ? <DemoNote /> : null}
      {notice ? <Banner tone="info" icon="check">{notice}</Banner> : null}
      <Card>
        <SectionHeader title="모든 방" sub={`${rooms.list.length}개`} />
        <div style={{ padding: 12, display: "grid", gap: 8 }} className="air-stagger">
          {rooms.list.length === 0 ? (
            <EmptyHint icon="rooms" title="방이 없습니다" detail="서버에서 방 목록을 받지 못했습니다. 기본 방은 서버가 생성합니다." />
          ) : null}
          {rooms.list.map((room) => (
            <div key={room.room_id} className="air-card" data-pad="sm" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Icon name={roomIcon(room)} size={15} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 12.5 }}>{room.name} {room.pinned ? <Badge tone="info" icon="pin">기본</Badge> : null}</div>
                <div className="air-hint">
                  {room.kind} · {room.member_count ?? "?"}명 · 최근 {room.last_message_at ? relativeTime(room.last_message_at) : "기록 없음"}
                  {room.project_id ? ` · ${room.project_id}` : ""}
                </div>
              </div>
              <span data-testid="room-unread">
                {room.unread_count ? <Badge tone="warn">읽지 않음 {room.unread_count}</Badge> : <Badge tone="neutral">모두 읽음</Badge>}
              </span>
              <Button size="sm" variant="ghost" icon="chat" onClick={() => navigate("MAINCHAT")}>열기</Button>
              <Button size="sm" variant="ghost" icon="user" onClick={() => setInviteRoom(room)}>초대</Button>
              <Button size="sm" variant="ghost" icon="rooms" onClick={() => navigate("ROOMDETAIL", { id: room.room_id })}>상세</Button>
            </div>
          ))}
        </div>
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="방 만들기"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>취소</Button><Button variant="primary" disabled={!name.trim() || !gatewayUrl || demoMode} busy={creating} onClick={() => void create()}>생성</Button></>}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <Field label="방 이름" htmlFor="room-name" required><TextInput id="room-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} /></Field>
          <Field label="종류" htmlFor="room-kind"><select id="room-kind" className="air-select" value={kind} onChange={(e) => setKind(e.target.value as never)}><option value="custom">커스텀</option><option value="project">프로젝트 연결</option></select></Field>
          <Banner tone="info" icon="info">기본 단체방은 중복 생성이 차단됩니다. 방 창설자에게 자동 권한 승격은 없습니다.</Banner>
        </div>
      </Dialog>

      <Dialog open={Boolean(inviteRoom)} onClose={() => setInviteRoom(null)} title={`초대 · ${inviteRoom?.name ?? ""}`} footer={<><Button variant="ghost" onClick={() => setInviteRoom(null)}>닫기</Button><Button variant="primary" disabled={!inviteAgent} onClick={() => setInviteRoom(null)}>초대</Button></>}>
        <Field label="AI 선택" htmlFor="invite-agent" hint="방 초대 권한이 있는 세션만 성공합니다">
          <select id="invite-agent" className="air-select" value={inviteAgent} onChange={(e) => setInviteAgent(e.target.value)}>
            <option value="">선택</option>
            {(demoMode ? demoAgents : []).map((a) => <option key={a.agent_id} value={a.agent_id}>{a.display_name}</option>)}
          </select>
        </Field>
      </Dialog>
    </div>
  );
}

/* --------------------------------------------------------------- ROOMDETAIL */

export function RoomDetailScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const roomId = params.id ?? "room-default";
  const roomRes = useResource<RoomSummary>(client, `/v1/rooms/${encodeURIComponent(roomId)}`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const room = demoMode ? demoRooms.find((r) => r.room_id === roomId) ?? demoRooms[0]! : roomRes.state.kind === "ready" ? roomRes.state.data : null;
  const [muted, setMuted] = useState(false);
  const [deleted, setDeleted] = useState<MessageDto | null>(null);

  const pins = demoMode ? demoMessages.slice(0, 2) : [];
  const media = demoMode ? ["ui-reference.png", "render-preview.mp4"] : [];

  return (
    <div className="air-screen">
      <ScreenHeader title={room?.name ?? "방 상세"} subtitle="구성원·핀·미디어·내보내기" badges={<><DemoChip on={demoMode} /><Badge tone="neutral">{roomId}</Badge></>} />
      <div className="air-grid-2">
        <Section title="구성원" sub={`${room?.member_count ?? "?"}명`}>
          <div style={{ display: "grid", gap: 6 }}>
            {(demoMode ? demoAgents : []).map((agent) => (
              <div key={agent.agent_id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="air-avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{Array.from(agent.display_name).slice(0, 1)}</span>
                <span style={{ flex: 1, fontSize: 12.5 }}>{agent.display_name}</span>
                <Badge tone="neutral">{agent.kind === "owner" ? "owner" : "AI"}</Badge>
              </div>
            ))}
            {!demoMode ? <span className="air-hint">서버 미연결 — 구성원 목록 없음</span> : null}
          </div>
        </Section>
        <Section title="알림·내보내기" sub="방 단위 설정">
          <div style={{ display: "grid", gap: 8 }}>
            <label className="air-check"><input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} /><span>이 방 알림 음소거</span></label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Button size="sm" icon="download">내보내기 요청 (JSON)</Button>
              <Button size="sm" variant="ghost" icon="lock">외부 유출 필터 확인</Button>
            </div>
            <Banner tone="info" icon="info">내보내기는 서버 작업 큐를 거치며, 권한 없는 첨부는 제외됩니다.</Banner>
          </div>
        </Section>
      </div>

      <Section title="고정 메시지" sub="핀은 방 상세에서만 표시" actions={<Badge tone="neutral">{pins.length}</Badge>}>
        <div style={{ display: "grid", gap: 8 }} data-testid="room-pin-list">
          {pins.length === 0 ? <span className="air-hint">고정된 메시지가 없습니다.</span> : null}
          {pins.map((message) => (
            <div key={message.message_id} className="air-card" data-pad="sm">
              <div className="air-hint">{message.author.display_name} · {new Date(message.created_at).toLocaleString()}</div>
              <div style={{ fontSize: 12.5 }}>{String((message.blocks[0]?.payload as { markdown?: string }).markdown ?? "").slice(0, 160)}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="미디어" sub="첨부 파일">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {media.length === 0 ? <span className="air-hint">미디어 없음(서버 미연결)</span> : media.map((m) => <Badge key={m} tone="neutral" icon="file">{m}</Badge>)}
        </div>
      </Section>

      <Section title="삭제된 메시지" sub="tombstone · 복원은 서버 정책 기간 내에만">
        <div style={{ display: "grid", gap: 6 }} data-testid="tombstone-restore">
          {demoMode ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Badge tone="neutral">삭제됨</Badge>
              <span className="air-hint">msg-5 · 2026-11-21</span>
              <Button size="sm" icon="refresh" onClick={() => setDeleted(demoMessages[4] ?? null)}>복원 요청</Button>
            </div>
          ) : (
            <span className="air-hint">삭제 메시지 정보 없음</span>
          )}
        </div>
      </Section>

      <Dialog open={Boolean(deleted)} onClose={() => setDeleted(null)} title="복원 요청" description="복원은 삭제 이력·파생 기억·색인까지 다시 반영합니다">
        <Banner tone="warn" icon="warning">복원 기간이 지난 메시지는 복원되지 않습니다. 요청 결과는 감사 로그에 남습니다.</Banner>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------- SEARCH */

export function SearchScreen({ navigate }: { navigate: Navigate }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>("all");
  const [room, setRoom] = useState<string>("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [localHits, setLocalHits] = useState<SearchHitDto[] | null>(null);
  const [serverHits, setServerHits] = useState<SearchHitDto[] | null>(null);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error" | "unauth">("idle");
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = async () => {
    if (!gatewayUrl || demoMode) {
      setServerHits(null);
      return;
    }
    setSearchState("loading");
    setSearchError(null);
    const result = await client.request<{ hits?: SearchHitDto[]; results?: SearchHitDto[] }>("POST", "/v1/search", {
      body: { q: query, kinds: kind === "all" ? undefined : [kind], room_id: room || undefined },
    });
    if (result.ok) {
      setServerHits(result.data.hits ?? result.data.results ?? []);
      setSearchState("idle");
    } else if (result.status === 401) {
      setSearchState("unauth");
      setSearchError(result.message);
    } else {
      setSearchState("error");
      setSearchError(`${result.code}: ${result.message}`);
    }
  };

  const hits = useMemo(() => {
    const base = localHits ?? (demoMode ? demoSearchHits : serverHits ?? []);
    return base.filter((hit) => (kind === "all" ? true : hit.kind === kind) && (room ? hit.room_id === room : true) && (onlyMine ? hit.title.includes("내") : true));
  }, [localHits, demoMode, serverHits, kind, room, onlyMine]);

  return (
    <div className="air-screen">
      <ScreenHeader title="통합 검색" subtitle="본문·코드·파일·기억 · ACL 필터 우선 적용" badges={<DemoChip on={demoMode} />} />
      <Card pad="md">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <TextInput aria-label="검색어" placeholder="검색어 또는 구문" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }} style={{ flex: 1, minWidth: 220 }} />
          <Button variant="primary" icon="search" onClick={() => void runSearch()} disabled={!query} busy={searchState === "loading"}>검색</Button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }} data-testid="search-filters">
          <select aria-label="종류 필터" className="air-select" style={{ width: 160 }} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">전체 종류</option>
            <option value="message">메시지</option>
            <option value="file">파일</option>
            <option value="code">코드</option>
            <option value="memory">기억</option>
            <option value="task">작업</option>
          </select>
          <select aria-label="방 필터" className="air-select" style={{ width: 180 }} value={room} onChange={(e) => setRoom(e.target.value)}>
            <option value="">모든 방</option>
            {(demoMode ? demoRooms : []).map((r) => <option key={r.room_id} value={r.room_id}>{r.name}</option>)}
          </select>
          <label className="air-check"><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /><span>내 항목만</span></label>
          <span className="air-hint">필터는 ACL 이후에 적용됩니다</span>
        </div>
      </Card>

      {searchState === "error" || searchState === "unauth" ? (
        <Banner tone={searchState === "unauth" ? "warn" : "danger"} icon="warning">{searchError}</Banner>
      ) : null}
      <Section title="결과" sub={`${hits.length}건`}>
        <div style={{ display: "grid", gap: 6 }}>
          {hits.length === 0 ? <span className="air-hint">결과 없음 — 검색어를 입력하고 검색을 누르세요.</span> : null}
          {hits.map((hit) => (
            <Reveal as="article" kind="rise" key={`${hit.kind}-${hit.id}`}>
              <div className="air-card" data-pad="sm" style={{ display: "grid", gap: 4 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge tone="info">{hit.kind}</Badge>
                  <strong style={{ fontSize: 12.5 }}>{hit.title}</strong>
                  <span style={{ flex: 1 }} />
                  <Button size="sm" variant="ghost" icon="external" data-testid="search-jump" onClick={() => navigate(hit.room_id ? "MAINCHAT" : hit.project_id ? "PROJECTOV" : "MAINCHAT", { id: hit.project_id ?? "demo-project" })}>이동</Button>
                </div>
                <div className="air-hint">{hit.excerpt}</div>
              </div>
            </Reveal>
          ))}
          <Button size="sm" variant="ghost" icon="filter" onClick={() => setLocalHits(demoSearchHits)}>데모 결과로 필터 동작 확인</Button>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------- MEMORY */

export function MemoryScreen() {
  const { client, gatewayUrl, demoMode } = useApp();
  const [scope, setScope] = useState<"all" | MemoryRecordDto["scope"]>("all");
  const projectId = "proj-ai-room";
  const res = useResource<{ memories?: MemoryRecordDto[]; items?: MemoryRecordDto[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/memories`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const list = demoMode ? demoMemory : res.state.kind === "ready" ? res.state.data.memories ?? res.state.data.items ?? [] : [];
  const filtered = scope === "all" ? list : list.filter((m) => m.scope === scope);
  const [draft, setDraft] = useState("");

  return (
    <div className="air-screen">
      <ScreenHeader title="기억 관리" subtitle="개인·방·프로젝트·공유 기억 · 사실/결정/가설 구분 · 출처 필수" badges={<DemoChip on={demoMode} />} />
      <Tabs
        label="기억 범위"
        value={scope}
        onChange={(id) => setScope(id as never)}
        items={[
          { id: "all", label: "전체", count: list.length },
          { id: "agent", label: "AI 개인" },
          { id: "room", label: "방" },
          { id: "project", label: "프로젝트" },
          { id: "shared", label: "공유" },
        ]}
      />
      <div className="air-grid-2">
        <Section title="기억 목록" sub={`${filtered.length}건`}>
          <div style={{ display: "grid", gap: 8 }}>
            {filtered.length === 0 ? <span className="air-hint">기억이 없습니다.</span> : null}
            {filtered.map((memory) => (
              <div key={memory.memory_id} className="air-card" data-pad="sm" style={{ display: "grid", gap: 4 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <Badge tone="info">{memory.scope}</Badge>
                  <Badge tone={memory.confidence_type === "fact" ? "ok" : memory.confidence_type === "decision" ? "accent" : "warn"} shape={memory.confidence_type === "hypothesis" ? "dashed" : "pill"}>
                    {memory.confidence_type === "fact" ? "사실" : memory.confidence_type === "decision" ? "결정" : "가설"}
                  </Badge>
                  <span className="air-mono air-hint">{memory.memory_id} · r{memory.revision}</span>
                  <span style={{ flex: 1 }} />
                  <span className="air-hint">{memory.author_actor_id}</span>
                </div>
                <div style={{ fontSize: 12.5 }}>{memory.text}</div>
                <div className="air-hint">출처: {memory.source_message_ids.length ? memory.source_message_ids.join(", ") : "없음 — 확정 사실로 취급하지 않음"}</div>
              </div>
            ))}
          </div>
        </Section>
        <Section title="기억 추가" sub="가설과 확정을 구분해 저장합니다">
          <div style={{ display: "grid", gap: 8 }}>
            <TextArea aria-label="기억 내용" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="프로젝트 결정·사실·가설" />
            <div style={{ display: "flex", gap: 6 }}>
              <Button size="sm" variant="primary" icon="check" disabled={!draft.trim()}>저장 요청</Button>
              <Button size="sm" variant="ghost" icon="history">버전 보기</Button>
            </div>
            <Banner tone="warn" icon="info">자동 기억은 추정과 확정을 구분하고 민감정보를 최소화합니다. “영구”는 무삭제를 뜻하지 않습니다.</Banner>
          </div>
        </Section>
      </div>
    </div>
  );
}

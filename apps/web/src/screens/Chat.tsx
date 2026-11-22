import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, Card, Dialog, Drawer, Field, Icon, IconButton, Reveal, SectionHeader, Tabs, TextArea, TextInput, useTheme } from "@ai-room/design-system";
import { useApp } from "../state/AppState.js";
import { useResource, relativeTime, listOf } from "../api/hooks.js";
import { RoomStream, type StreamStatus } from "../api/realtime.js";
import { newIdempotencyKey } from "../api/client.js";
import type { AgentSummary, MemoryRecordDto, MessageDto, RoomSummary, SearchHitDto } from "../api/types.js";
import { demoAgents, demoMemory, demoMessages, demoRooms, demoSearchHits } from "../demo/fixtures.js";
import { normalizeWireMessage, type WireMessage } from "../api/wire.js";
import { readCachedMessages, readCachedRooms, readLastRoomId, rememberLastRoomId, writeCachedMessages, writeCachedRooms } from "../api/chat-cache.js";
import { Composer, EditHistoryDialog, MessageList, ThreadPanel, insertIntoComposer, type ComposerSendMeta, type MessageActionHandlers } from "../components/chat/index.js";
import { ChatActionSheet, ChatSheet, SheetRow, type ChatAction } from "../components/chat/sheets.js";
import { AiJoinScreen, SignInScreen } from "./Start.js";
import { DemoChip, DemoNote, EmptyHint, ResourceView, ScreenHeader, Section } from "../components/ui.js";
import { openAppNav } from "../lib/shell-nav.js";
import { chatTime, excerptOf, initialsOf } from "../lib/chat-format.js";
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
  const { client, gatewayUrl, setGatewayUrl, demoMode, setDemoMode, outbox, enqueueMessage, flushOutbox, retryOutbox, connection, refreshConnection, self, session, renewSession } = useApp();
  const { theme, toggle: toggleTheme } = useTheme();
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
  /* Every one of these opens on top of the room — a sheet, a drawer or a
     dialog — so a conversation is never left for another page. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [signinOpen, setSigninOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<MessageDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [gatewayInput, setGatewayInput] = useState(gatewayUrl ?? "");

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
        : connection?.state === "ready"
          ? "연결 준비"
          : "오프라인 · 초안 보관";

  /* ------------------------------------------------- in-room sheets & actions */

  const copy = async (text: string, note: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setToast(note);
    } catch {
      setToast("복사할 수 없습니다 — 주소를 직접 선택해 복사하세요");
    }
  };

  const roomMessagesWithReactions = messages.map((m) => ({
    ...m,
    reactions: { ...(m.reactions ?? {}), ...(reactions[m.message_id] ?? {}) },
  }));

  const searchMatches = searchQuery.trim().length === 0
    ? messages.length
    : roomMessagesWithReactions.filter((m) => JSON.stringify(m.blocks).toLowerCase().includes(searchQuery.trim().toLowerCase())).length;

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  const openSearch = () => {
    setSearchOpen(true);
    setSearchQuery("");
  };

  const removeMessage = async (message: MessageDto) => {
    if (demoMode || !gatewayUrl) {
      setToast("데모에서는 삭제를 서버로 보내지 않습니다");
      return;
    }
    setDeleting(true);
    const res = await client.request<{ message_id?: string; deleted_at?: string }>(
      "DELETE",
      `/v1/rooms/${encodeURIComponent(message.room_id)}/messages/${encodeURIComponent(message.message_id)}`,
    );
    setDeleting(false);
    if (res.ok) {
      setRealtimeMessages((prev) => prev.filter((m) => m.message_id !== message.message_id));
      setSeeded((prev) => prev.filter((m) => m.message_id !== message.message_id));
      messagesRes.reload();
      setToast("메시지를 삭제했습니다 — 서버에 삭제 기록이 남습니다");
    } else {
      setToast(`삭제하지 못했습니다 — ${res.code}: ${res.message}`);
    }
  };

  const actionFor = actionsFor;
  const messageActions: ChatAction[] = actionFor === null ? [] : [
    { icon: "reply", label: "답장", onClick: () => setReplyTo(actionFor), testId: "msg-action-reply" },
    { icon: "copy", label: "복사", onClick: () => copyText(actionFor), testId: "msg-action-copy" },
    { icon: "thread", label: "스레드 열기", onClick: () => setThreadRoot(actionFor), testId: "msg-action-thread" },
    {
      icon: "bookmark",
      label: bookmarks.has(actionFor.message_id) ? "북마크 해제" : "북마크",
      onClick: () => setBookmarks((prev) => {
        const next = new Set(prev);
        if (next.has(actionFor.message_id)) next.delete(actionFor.message_id);
        else next.add(actionFor.message_id);
        return next;
      }),
      testId: "msg-action-bookmark",
    },
    {
      icon: "sparkles",
      label: important.has(actionFor.message_id) ? "중요 해제" : "중요 표시",
      onClick: () => setImportant((prev) => {
        const next = new Set(prev);
        if (next.has(actionFor.message_id)) next.delete(actionFor.message_id);
        else next.add(actionFor.message_id);
        return next;
      }),
      testId: "msg-action-important",
    },
    { icon: "external", label: "공유 참조 링크 복사", onClick: () => copy(`${window.location.origin}${location.pathname}#/chat?m=${actionFor.message_id}`, "공유 참조 링크를 복사했습니다"), testId: "msg-action-link" },
    ...(actionFor.edited_at
      ? [{ icon: "history" as const, label: "편집 기록", onClick: () => setHistoryFor(actionFor), testId: "msg-action-history" }]
      : []),
    ...(actionFor.deleted_at
      ? []
      : [{ icon: "trash" as const, label: "삭제", tone: "danger" as const, onClick: () => setDeleteTarget(actionFor), testId: "msg-action-delete" }]),
  ];

  const portalUrl = `${window.location.origin}${window.location.pathname}#/ai-join`;
  const invitePrompt = [
    "PROJECT AI ROOM에 AI로 참여해 주세요.",
    `1) 안내문: ${window.location.origin}/ai-portal.txt`,
    `2) 가입 폼: ${portalUrl}`,
    "3) 초대 코드와 이름을 넣고 등록하면 API 키가 1회 표시됩니다.",
    "4) 같은 화면에서 원클릭 로그인하면 이 채팅방에 들어옵니다.",
    "초대 코드는 소유자가 발급한 1회용 토큰입니다. 받은 코드를 그대로 넣으세요.",
  ].join("\n");

  return (
    <div className="air-chat-screen">
      <div className="air-chat-frame">
        <header className="air-chat-head">
          <button type="button" className="air-chat-head-btn" onClick={() => setRoomsOpen(true)} aria-label="방 목록" title="방 목록" data-testid="chat-room-list">
            <Icon name="rooms" size={19} />
          </button>

          <div className="air-chat-head-main">
            <button type="button" className="air-chat-room-btn" onClick={() => setMembersOpen(true)} aria-haspopup="dialog" data-testid="chat-room-switch">
              <span className="air-chat-room-name air-truncate">{room?.name ?? (needsSignIn ? "AI ROOM" : "AI ROOM")}</span>
              <Icon name="chevronDown" size={13} />
            </button>
            <div className="air-chat-subline">
              <button type="button" className="air-chat-members-link" onClick={() => setMembersOpen(true)}>
                {memberCount}명
              </button>
              <span className="air-chat-dot" aria-hidden="true">·</span>
              <span className="air-chat-live" data-state={liveTone} title={live.detail ?? liveLabel} data-testid="chat-live-state">
                <span className="air-chat-live-dot" data-state={liveTone} aria-hidden="true" />
                {liveLabel}
              </span>
              {demoMode ? <DemoChip on /> : null}
            </div>
          </div>

          <div className="air-chat-head-actions">
            <button
              type="button"
              className="air-chat-head-btn"
              onClick={() => (searchOpen ? closeSearch() : openSearch())}
              aria-label="대화 검색"
              aria-pressed={searchOpen}
              title="대화 검색"
              data-testid="chat-search-toggle"
            >
              <Icon name="search" size={18} />
            </button>
            <button
              type="button"
              className="air-chat-head-btn"
              onClick={() => setMenuOpen(true)}
              aria-label="톡서랍 열기"
              title="톡서랍"
              data-testid="chat-open-nav"
            >
              <Icon name="menu" size={19} />
            </button>
          </div>
        </header>

        {searchOpen ? (
          <div className="air-chat-search" role="search">
            <span className="air-chat-search-icon" aria-hidden="true"><Icon name="search" size={15} /></span>
            <input
              className="air-chat-search-input"
              type="search"
              value={searchQuery}
              autoFocus
              placeholder="이 방에서 메시지 찾기"
              aria-label="이 방에서 메시지 찾기"
              data-testid="chat-search-input"
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
            />
            <span className="air-chat-search-count" data-testid="chat-search-count">
              {searchQuery.trim().length === 0 ? "" : `${searchMatches}개`}
            </span>
            <button type="button" className="air-chat-search-close" onClick={closeSearch} aria-label="검색 닫기">
              <Icon name="close" size={15} />
            </button>
          </div>
        ) : null}

        {demoMode ? <div className="air-chat-demo"><DemoNote /></div> : null}

        <div className="air-chat" data-thread={threadRoot ? "open" : undefined}>
          <div className="air-chat-main">
            {!demoMode && !roomReady && roomId === "" && !needsSignIn ? (
              <div className="air-chat-loading" role="status">
                <span className="air-chat-spinner" aria-hidden="true" />
                방 정보를 불러오는 중입니다…
              </div>
            ) : null}

            {!demoMode && (messagesRes.state.kind === "unavailable" || messagesRes.state.kind === "error") ? (
              <div className="air-chat-note">
                <ResourceView state={messagesRes.state} onRetry={messagesRes.reload}>
                  {() => null}
                </ResourceView>
              </div>
            ) : null}

            {!demoMode && needsSignIn ? (
              /* The room stays, the conversation does not: a system notice in the
                 message column, the way a messenger asks to sign in. */
              <div className="air-chat-gate">
                <div className="air-chat-gate-card">
                  <span className="air-chat-gate-avatar" aria-hidden="true">💬</span>
                  <h2>대화를 읽으려면 로그인이 필요해요</h2>
                  <p>소유자로 로그인하거나, AI를 초대해 이 방에 참여시키세요. 어느 쪽이든 이 화면 위에서 바로 끝납니다.</p>
                  <div className="air-chat-gate-actions">
                    <Button variant="primary" icon="lock" onClick={() => setSigninOpen(true)} data-testid="chat-gate-signin">로그인</Button>
                    <Button variant="ghost" icon="sparkles" onClick={() => setJoinOpen(true)} data-testid="chat-gate-join">AI 가입 폼</Button>
                  </div>
                  <button type="button" className="air-chat-gate-link" onClick={() => setInviteOpen(true)}>
                    AI에게 보낼 초대 프롬프트 복사
                  </button>
                </div>
              </div>
            ) : (
              (roomId !== "" || demoMode) ? (
                <MessageList
                  messages={roomMessagesWithReactions}
                  pending={pendingHere.map((item) => ({ item }))}
                  handlers={handlers}
                  self={self}
                  roomId={roomId}
                  nameOf={agentName}
                  filter={searchOpen && searchQuery.trim().length > 0 ? searchQuery.trim() : undefined}
                  onLoadOlder={() => void loadOlder()}
                  loadingOlder={olderState.loading}
                  hasOlder={!olderState.done}
                  olderError={olderState.error}
                  onOpenActions={(message) => setActionsFor(message)}
                />
              ) : (
                <div className="air-chat-body" />
              )
            )}

            <Composer
              roomId={roomId}
              agents={agentList.map((a) => ({ agent_id: a.agent_id, display_name: a.display_name, kind: a.kind ?? "agent" }))}
              onSend={(blocks, plain, meta) => void send(blocks, plain, meta)}
              disabled={needsSignIn || (!roomReady && !demoMode)}
              replyTo={replyTo}
              replyToName={replyTo?.author.actor_id === self.actor_id ? self.display_name : replyTo ? agentName(replyTo.author.actor_id) : undefined}
              onCancelReply={() => setReplyTo(null)}
              typing={[]}
              onOpenPlus={() => setPlusOpen(true)}
              onAttach={(files) => {
                const names = files.map((f) => f.name).join(", ");
                setToast(files.length > 0
                  ? `첨부 ${files.length}개 선택됨 (${names}) — 파일 업로드는 서버 스토리지 활성화 후 가능합니다`
                  : "첨부할 파일을 고르지 않았습니다");
              }}
            />
          </div>

          {threadRoot ? (
            <ThreadPanel
              root={threadRoot}
              replies={[]}
              onClose={() => setThreadRoot(null)}
              notifyEnabled={threadNotify}
              onNotifyToggle={() => setThreadNotify((v) => !v)}
              composer={<Composer roomId={roomId} agents={agentList.map((a) => ({ agent_id: a.agent_id, display_name: a.display_name, kind: a.kind ?? "agent" }))} onSend={(blocks, plain, meta) => void send(blocks, plain, meta)} onOpenPlus={() => setPlusOpen(true)} />}
            />
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------------------------ sheets */}

      {/* `+` : attachments, snippets and the two AI paths, all above the room. */}
      <ChatSheet open={plusOpen} onClose={() => setPlusOpen(false)} title="첨부와 더보기" variant="compact" testId="chat-plus-sheet">
        <div className="air-plus-grid">
          <label className="air-plus-tile">
            <span className="air-plus-icon"><Icon name="file" size={20} /></span>
            <span>사진</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="air-plus-input"
              aria-label="사진 선택"
              data-testid="plus-photo"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                setPlusOpen(false);
                if (files.length > 0) setToast(`사진 ${files.length}장 선택됨 — 파일 업로드는 서버 스토리지 활성화 후 가능합니다`);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <label className="air-plus-tile">
            <span className="air-plus-icon"><Icon name="paperclip" size={20} /></span>
            <span>파일</span>
            <input
              type="file"
              multiple
              className="air-plus-input"
              aria-label="파일 선택"
              data-testid="plus-file"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                setPlusOpen(false);
                if (files.length > 0) setToast(`파일 ${files.length}개 선택됨 — 파일 업로드는 서버 스토리지 활성화 후 가능합니다`);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <button type="button" className="air-plus-tile" data-testid="plus-code" onClick={() => { setPlusOpen(false); insertIntoComposer("```\n\n```"); }}>
            <span className="air-plus-icon"><Icon name="code" size={20} /></span>
            <span>코드 블록</span>
          </button>
          <button type="button" className="air-plus-tile" data-testid="plus-task" onClick={() => { setPlusOpen(false); insertIntoComposer("- [ ] \n- [ ] "); }}>
            <span className="air-plus-icon"><Icon name="board" size={20} /></span>
            <span>작업 목록</span>
          </button>
          <button type="button" className="air-plus-tile" data-testid="plus-invite" onClick={() => { setPlusOpen(false); setInviteOpen(true); }}>
            <span className="air-plus-icon"><Icon name="key" size={20} /></span>
            <span>AI 초대</span>
          </button>
          <button type="button" className="air-plus-tile" data-testid="plus-join" onClick={() => { setPlusOpen(false); setJoinOpen(true); }}>
            <span className="air-plus-icon"><Icon name="sparkles" size={20} /></span>
            <span>AI 가입</span>
          </button>
        </div>
        <p className="air-sheet-note">
          코드 블록·작업 목록은 입력창에 초안으로 들어갑니다 — 보내기 전에 다듬을 수 있어요.
          파일 업로드는 서버 스토리지(R2)가 켜진 뒤에 전송됩니다.
        </p>
      </ChatSheet>

      {/* The right drawer: everything that is not the conversation itself. */}
      <ChatSheet open={menuOpen} onClose={() => setMenuOpen(false)} title="톡서랍" side="right" testId="chat-menu-drawer">
        <div className="air-drawer-self">
          <span className="air-avatar" data-ring={self.kind === "owner" ? "verified" : "none"}>{initialsOf(self.display_name)}</span>
          <div className="air-drawer-self-text">
            <span className="air-drawer-self-name">{self.display_name}</span>
            <span className="air-drawer-self-meta">
              {session ? `소유자 · ${session.owner_id}` : self.kind === "agent" ? "AI 세션" : "로그인하지 않음"}
            </span>
          </div>
          {session === null ? (
            <button type="button" className="air-drawer-login" onClick={() => { setMenuOpen(false); setSigninOpen(true); }} data-testid="drawer-signin">
              로그인
            </button>
          ) : (
            <span className="air-drawer-state" data-tone={connection?.state === "ready" ? "ok" : "warn"}>
              {connection?.state === "ready" ? "연결됨" : connection?.state === "unauthenticated" ? "세션 만료" : "확인 필요"}
            </span>
          )}
        </div>

        <div className="air-drawer-section">대화</div>
        <SheetRow icon="search" label="대화 검색" detail="이 방의 메시지에서 찾기" onClick={() => { setMenuOpen(false); openSearch(); }} testId="drawer-search" />
        <SheetRow icon="rooms" label="방 목록" detail={`${rooms.list.length}개 방`} onClick={() => { setMenuOpen(false); setRoomsOpen(true); }} testId="drawer-rooms" />
        <SheetRow icon="user" label="참여자" detail="AI·사람 목록과 상태" meta={`${memberCount}명`} onClick={() => { setMenuOpen(false); setMembersOpen(true); }} testId="drawer-members" />
        <SheetRow icon="plus" label="새 방 만들기" onClick={() => { setMenuOpen(false); setNewRoomOpen(true); }} testId="drawer-new-room" />
        {outbox.filter((o) => o.state === "pending" || o.state === "failed").length > 0 ? (
          <SheetRow
            icon="refresh"
            label="오프라인 보관함"
            detail="아직 서버에 저장되지 않은 메시지"
            meta={`대기 ${outbox.filter((o) => o.state === "pending").length} · 실패 ${outbox.filter((o) => o.state === "failed").length}`}
            onClick={() => {
              const failed = outbox.find((o) => o.state === "failed");
              if (failed) void retryOutbox(failed.id);
              else void flushOutbox();
            }}
            testId="drawer-outbox"
          />
        ) : null}

        <div className="air-drawer-section">AI</div>
        <SheetRow icon="key" label="AI 초대" detail="초대 프롬프트·가입 링크 복사" onClick={() => { setMenuOpen(false); setInviteOpen(true); }} testId="drawer-invite" />
        <SheetRow icon="sparkles" label="AI 가입 폼" detail="AI가 직접 쓰는 가입·로그인" onClick={() => { setMenuOpen(false); setJoinOpen(true); }} testId="drawer-join" />

        <div className="air-drawer-section">연결·설정</div>
        <div className="air-drawer-settings">
          <div className="air-drawer-setting-row">
            <span className="air-sheet-row-icon" aria-hidden="true"><Icon name="server" size={17} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="air-sheet-row-label">게이트웨이</div>
              <div className="air-sheet-row-detail">{gatewayUrl ?? "설정되지 않음"} · {connection?.state ?? "확인 전"}</div>
            </div>
            <button type="button" className="air-drawer-mini" onClick={() => void refreshConnection()} data-testid="drawer-recheck">확인</button>
          </div>
          <div className="air-gateway-form">
            <input
              className="air-input"
              value={gatewayInput}
              onChange={(e) => setGatewayInput(e.target.value)}
              placeholder="https://…workers.dev"
              aria-label="게이트웨이 URL"
              inputMode="url"
              data-testid="drawer-gateway-input"
            />
            <button
              type="button"
              className="air-drawer-mini"
              onClick={() => {
                setGatewayUrl(gatewayInput.trim() === "" ? null : gatewayInput.trim());
                void refreshConnection();
                setToast("게이트웨이 URL을 저장했습니다");
              }}
            >
              저장
            </button>
          </div>
        </div>
        <SheetRow
          icon="eye"
          label={demoMode ? "데모 끄기" : "데모 데이터로 보기"}
          detail="서버 없이 화면을 살펴보는 시연 모드"
          onClick={() => setDemoMode(!demoMode)}
          testId="drawer-demo"
        />
        <SheetRow
          icon={theme === "dark" ? "sun" : "moon"}
          label={theme === "dark" ? "라이트 테마" : "다크 테마"}
          onClick={toggleTheme}
          testId="drawer-theme"
        />
        <SheetRow icon="admin" label="관리자 화면 전체 열기" detail="승인·감사·백업·출시 게이트" onClick={() => { setMenuOpen(false); navigate("ADMIN"); }} testId="drawer-admin" />
        <SheetRow icon="menu" label="전체 화면 메뉴" detail="프로젝트·코드·거버넌스 화면" onClick={() => { setMenuOpen(false); openAppNav(); }} testId="drawer-all-screens" />

        <div className="air-drawer-foot">
          <span className="air-hint">방 안에서 끝나지 않는 작업은 이 메뉴에서만 열립니다.</span>
        </div>
      </ChatSheet>

      {/* Message actions: long press, right click or a tap on the bubble. */}
      <ChatActionSheet
        open={actionFor !== null && deleteTarget === null}
        onClose={() => setActionsFor(null)}
        title={actionFor === null ? "메시지" : `${actionFor.author.display_name}의 메시지`}
        actions={messageActions}
      />

      <ChatSheet
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="메시지 삭제"
        variant="compact"
        testId="chat-delete-confirm"
        footer={
          <div className="air-sheet-actions">
            <button type="button" className="air-sheet-cancel" onClick={() => setDeleteTarget(null)}>취소</button>
            <button
              type="button"
              className="air-sheet-confirm"
              data-tone="danger"
              disabled={deleting}
              onClick={async () => {
                if (deleteTarget === null) return;
                await removeMessage(deleteTarget);
                setDeleteTarget(null);
                setActionsFor(null);
              }}
            >
              {deleting ? "삭제 중…" : "삭제"}
            </button>
          </div>
        }
      >
        <p className="air-sheet-note">
          {deleteTarget === null ? "" : `“${excerptOf(deleteTarget, 80)}”\n\n삭제하면 대화에서 사라지고 서버에는 삭제 기록만 남습니다. 되돌릴 수 없습니다.`}
        </p>
      </ChatSheet>

      {/* AI invitation: the prompt an owner pastes into another AI's chat. */}
      <ChatSheet open={inviteOpen} onClose={() => setInviteOpen(false)} title="AI 초대" subtitle="프롬프트와 가입 링크를 복사해 AI에게 건네세요" testId="chat-invite-sheet">
        <pre className="air-invite-prompt" data-testid="invite-prompt">{invitePrompt}</pre>
        <div className="air-sheet-actions">
          <button type="button" className="air-sheet-cancel" onClick={() => copy(invitePrompt, "AI 초대 프롬프트를 복사했습니다")} data-testid="invite-copy-prompt">
            <Icon name="copy" size={14} /> 프롬프트 복사
          </button>
          <button type="button" className="air-sheet-confirm" onClick={() => copy(portalUrl, "AI 가입 링크를 복사했습니다")} data-testid="invite-copy-link">
            <Icon name="external" size={14} /> 가입 링크 복사
          </button>
        </div>
        <SheetRow icon="sparkles" label="AI 가입 폼 열기" detail="AI가 이 브라우저에서 직접 가입·로그인" onClick={() => { setInviteOpen(false); setJoinOpen(true); }} testId="invite-open-join" />
        <p className="air-sheet-note">
          초대 코드는 소유자 부트스트랩 때 1회 발급됩니다. 코드가 없다면 관리자 화면에서 초대를 발급한 뒤 같은 프롬프트로 전달하세요.
        </p>
      </ChatSheet>

      {/* AI join form: the real screen, mounted above the room instead of away from it. */}
      <ChatSheet open={joinOpen} onClose={() => setJoinOpen(false)} title="AI 가입 · 로그인" side="right" variant="tall" testId="chat-join-panel">
        <div className="air-embedded-screen">
          <AiJoinScreen navigate={(id) => { setJoinOpen(false); navigate(id); }} />
        </div>
      </ChatSheet>

      {/* Owner sign-in, also inside the room. */}
      <ChatSheet open={signinOpen} onClose={() => setSigninOpen(false)} title="소유자 로그인" side="right" variant="tall" testId="chat-signin-panel">
        <div className="air-embedded-screen">
          <SignInScreen navigate={(id) => { setSigninOpen(false); navigate(id); }} />
        </div>
      </ChatSheet>

      {/* Room switcher: the same list as a phone sheet. */}
      <ChatSheet open={roomsOpen} onClose={() => setRoomsOpen(false)} title="대화방" testId="chat-room-drawer">
        <div className="air-room-sheet">
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
        </div>
      </ChatSheet>

      <ChatSheet
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        title={`참여자 ${memberCount}명`}
        subtitle="AI는 초대 코드로 참여하고, 이름 옆 표시는 검증 수준입니다"
        testId="chat-member-sheet"
        footer={
          <button type="button" className="air-sheet-confirm" onClick={() => { setMembersOpen(false); setInviteOpen(true); }}>
            <Icon name="key" size={14} /> AI 초대하기
          </button>
        }
      >
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
          {agentList.length === 0 ? <span className="air-hint">아직 참여한 AI가 없습니다 — AI 초대에서 프롬프트를 복사해 전달하세요.</span> : null}
        </div>
      </ChatSheet>

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

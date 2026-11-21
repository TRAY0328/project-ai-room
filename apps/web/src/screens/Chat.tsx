import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, Card, Dialog, Field, Icon, IconButton, Reveal, SectionHeader, Tabs, TextArea, TextInput } from "@ai-room/design-system";
import { useApp } from "../state/AppState.js";
import { useResource, relativeTime, listOf } from "../api/hooks.js";
import { RoomStream, type StreamStatus } from "../api/realtime.js";
import { newIdempotencyKey } from "../api/client.js";
import type { AgentSummary, MemoryRecordDto, MessageDto, RoomSummary, SearchHitDto } from "../api/types.js";
import { demoAgents, demoMemory, demoMessages, demoRooms, demoSearchHits } from "../demo/fixtures.js";
import { normalizeWireMessage, type WireMessage } from "../api/wire.js";
import { Composer, EditHistoryDialog, MessageList, ThreadPanel, type MessageActionHandlers } from "../components/chat/index.js";
import { DemoChip, DemoNote, EmptyHint, ResourceView, ScreenHeader, Section } from "../components/ui.js";
import type { ScreenId } from "../lib/router.js";

type Navigate = (id: ScreenId, params?: Record<string, string>) => void;

function useRooms() {
  const { client, gatewayUrl, demoMode } = useApp();
  const rooms = useResource<RoomSummary[]>(client, "/v1/rooms", { enabled: Boolean(gatewayUrl) && !demoMode, pollMs: 30000 });
  const list = demoMode ? demoRooms : rooms.state.kind === "ready" ? listOf<RoomSummary>(rooms.state.data) : [];
  return { list, state: rooms.state, reload: rooms.reload };
}

/* ----------------------------------------------------------------- MAINCHAT */

export function MainChatScreen({ navigate }: { navigate: Navigate }) {
  const { client, gatewayUrl, demoMode, outbox, enqueueMessage, flushOutbox, connection, self } = useApp();
  const rooms = useRooms();
  // No placeholder room id: until the room list arrives there is nothing to
  // read or write, and guessing "room-default" only produced a 403 and a
  // message stuck in the outbox.
  const [roomId, setRoomId] = useState<string>(rooms.list[0]?.room_id ?? "");
  const agentsRes = useResource<AgentSummary[]>(client, "/v1/agents", { enabled: Boolean(gatewayUrl) && !demoMode });
  const messagesRes = useResource<{ messages?: WireMessage[]; items?: WireMessage[] }>(client, roomId === "" ? null : `/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
    enabled: Boolean(gatewayUrl) && !demoMode,
    query: { limit: 50 },
  });

  const agentList = demoMode ? demoAgents : agentsRes.state.kind === "ready" ? listOf<AgentSummary>(agentsRes.state.data) : [];
  const agentName = (id: string): string => agentList.find((a) => a.agent_id === id)?.display_name ?? id;
  const baseMessages: MessageDto[] = demoMode
    ? demoMessages.filter((m) => m.room_id === roomId)
    : messagesRes.state.kind === "ready"
      ? (messagesRes.state.data.messages ?? messagesRes.state.data.items ?? []).map((m) => normalizeWireMessage(m, agentName))
      : [];

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

  const messages: MessageDto[] = useMemo(() => {
    const merged = [...baseMessages];
    for (const message of realtimeMessages) {
      if (!merged.some((m) => m.message_id === message.message_id)) merged.push(message);
    }
    return merged;
  }, [baseMessages, realtimeMessages]);

  // Realtime room stream: only when a gateway and a real room exist. Gaps trigger an HTTPS resync.
  useEffect(() => {
    if (!gatewayUrl || demoMode || !client.baseUrl || roomId === "") {
      setLive({ status: "idle", received: 0 });
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
        messagesRes.reload();
        setToast(`실시간 순서 공백 감지(${reason}) — 서버에서 다시 불러왔습니다`);
      },
    });
    streamRef.current = stream;
    stream.connect(messages.at(-1)?.room_seq ?? null);
    return () => {
      stream.close();
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayUrl, demoMode, roomId, client]);

  useEffect(() => {
    setRealtimeMessages([]);
  }, [roomId]);

  const room = rooms.list.find((r) => r.room_id === roomId) ?? null;
  const roomReady = room !== null;
  const pendingHere = outbox.filter((o) => o.roomId === roomId && (o.state === "pending" || o.state === "failed"));

  // The room list arrives after the first render: move to the real default room
  // once it exists instead of keeping the placeholder id forever.
  useEffect(() => {
    if (rooms.list.length > 0 && !rooms.list.some((r) => r.room_id === roomId)) {
      setRoomId(rooms.list[0]!.room_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms.list]);

  const send = async (blocks: MessageDto["blocks"]) => {
    enqueueMessage(roomId, blocks);
    if (connection.state === "ready") {
      await flushOutbox();
      // The queued copy leaves the list the moment the server accepts it, so the
      // stored message is fetched again immediately — otherwise the message the
      // user just sent disappears until the next poll.
      messagesRes.reload();
      setToast("전송 요청됨 — 서버 확인 결과는 메시지 상태로 표시됩니다");
    } else {
      setToast("오프라인: 보관함에 저장했습니다 (서버 저장 아님)");
    }
    setReplyTo(null);
  };

  const toggleReaction = (message: MessageDto, emoji: string) => {
    setMineReactions((prev) => {
      const mine = prev[message.message_id] ?? [];
      const next = mine.includes(emoji) ? mine.filter((e) => e !== emoji) : [...mine, emoji];
      return { ...prev, [message.message_id]: next };
    });
    setReactions((prev) => {
      const current = prev[message.message_id] ?? message.reactions ?? {};
      const delta = (mineReactions[message.message_id] ?? []).includes(emoji) ? -1 : 1;
      const count = Math.max(0, (current[emoji] ?? 0) + delta);
      return { ...prev, [message.message_id]: { ...current, [emoji]: count } };
    });
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
  };

  return (
    <div className="air-chat-screen" style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "10px 16px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{room?.name ?? "단체 채팅"}</div>
        {room?.topic ? <span className="air-hint">{room.topic}</span> : null}
        <span style={{ flex: 1 }} />
        <Badge tone={live.status === "live" ? "ok" : live.status === "reconnecting" ? "warn" : "neutral"} shape={live.status === "live" ? "solid" : "dashed"} title={live.detail ?? undefined}>
          {live.status === "live"
            ? `실시간 수신 중 (+${live.received})`
            : live.status === "reconnecting"
              ? "재연결 중"
              : live.status === "error"
                ? "실시간 오류"
                : connection.state === "ready"
                  ? "실시간 연결 준비"
                  : "연결 없음 · 초안/보관함 사용"}
        </Badge>
        {demoMode ? <DemoChip on /> : null}
        <Button size="sm" variant="ghost" icon="rooms" onClick={() => navigate("ROOMS")}>방 목록</Button>
      </div>
      {demoMode ? <div style={{ padding: "8px 16px 0" }}><DemoNote /></div> : null}

      <div className="air-chat" data-thread={threadRoot ? "open" : undefined}>
        <aside className="air-chat-rooms" aria-label="방 목록">
          <div className="air-nav-group-label" style={{ padding: "4px 6px" }}>방</div>
          {rooms.list.length === 0 ? <div className="air-hint" style={{ padding: 8 }}>방 정보 없음</div> : null}
          {rooms.list.map((r) => (
            <button
              key={r.room_id}
              type="button"
              className="air-nav-item"
              aria-current={r.room_id === roomId ? "page" : undefined}
              onClick={() => setRoomId(r.room_id)}
              style={{ width: "100%", background: r.room_id === roomId ? undefined : "none", border: "1px solid transparent", textAlign: "left" }}
            >
              <Icon name={r.kind === "default" ? "chat" : r.kind === "project" ? "project" : "rooms"} size={14} />
              <span className="air-truncate" style={{ flex: 1 }}>{r.name}</span>
              {r.unread_count ? <span className="air-nav-count">{r.unread_count}</span> : null}
            </button>
          ))}
          <div style={{ padding: 8 }}>
            <Button size="sm" block variant="ghost" icon="plus" onClick={() => navigate("ROOMS")}>방 만들기</Button>
          </div>
        </aside>

        <div className="air-chat-main">
          <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--air-line)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Icon name="user" size={13} />
            <span className="air-hint">{room?.member_count ?? "?"}명 참여</span>
            <span className="air-hint">· 메시지 {messages.length}건</span>
            <span style={{ flex: 1 }} />
            <span className="air-hint">seq {messages.at(-1)?.room_seq ?? "—"}</span>
          </div>

          {!demoMode && (messagesRes.state.kind === "idle" || messagesRes.state.kind === "unauthenticated" || messagesRes.state.kind === "unavailable" || messagesRes.state.kind === "error") ? (
            <div style={{ padding: 16 }}>
              <ResourceView state={messagesRes.state} onRetry={messagesRes.reload}>
                {() => null}
              </ResourceView>
            </div>
          ) : null}

          <MessageList
            messages={messages.map((m) => ({
              ...m,
              reactions: { ...(m.reactions ?? {}), ...(reactions[m.message_id] ?? {}) },
            }))}
            pending={pendingHere.map((item) => ({ item }))}
            handlers={handlers}
            self={self}
          />

          <Composer
            roomId={roomId}
            agents={agentList.map((a) => ({ agent_id: a.agent_id, display_name: a.display_name, kind: a.kind ?? "agent" }))}
            onSend={(blocks) => void send(blocks)}
            disabled={!roomReady && !demoMode}
            replyTo={replyTo}
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
            composer={<Composer roomId={roomId} agents={agentList.map((a) => ({ agent_id: a.agent_id, display_name: a.display_name, kind: a.kind ?? "agent" }))} onSend={(blocks) => void send(blocks)} />}
          />
        ) : null}
      </div>

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
  const [inviteRoom, setInviteRoom] = useState<RoomSummary | null>(null);
  const [inviteAgent, setInviteAgent] = useState("");

  return (
    <div className="air-screen">
      <ScreenHeader
        title="방 목록"
        subtitle="기본 단체방 1개는 고정 · 추가 방 생성·초대·퇴장·프로젝트 연결"
        badges={<DemoChip on={demoMode} />}
        actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>방 만들기</Button>}
      />
      {demoMode ? <DemoNote /> : null}
      <Card>
        <SectionHeader title="모든 방" sub={`${rooms.list.length}개`} />
        <div style={{ padding: 12, display: "grid", gap: 8 }} className="air-stagger">
          {rooms.list.length === 0 ? (
            <EmptyHint icon="rooms" title="방이 없습니다" detail="서버에서 방 목록을 받지 못했습니다. 기본 방은 서버가 생성합니다." />
          ) : null}
          {rooms.list.map((room) => (
            <div key={room.room_id} className="air-card" data-pad="sm" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Icon name={room.kind === "default" ? "chat" : room.kind === "project" ? "project" : "rooms"} size={15} />
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
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>취소</Button><Button variant="primary" disabled={!name || !gatewayUrl || demoMode} onClick={() => setOpen(false)}>생성</Button></>}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <Field label="방 이름" htmlFor="room-name" required><TextInput id="room-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
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

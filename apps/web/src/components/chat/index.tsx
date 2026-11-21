import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  Icon,
  IconButton,
  Kbd,
  Reveal,
  Tabs,
  TextArea,
  TypingDots,
} from "@ai-room/design-system";
import { renderMessage, renderMarkdown, type MessageEnvelope } from "@ai-room/message-blocks";
import { MessageBody, VNodeView } from "@ai-room/message-blocks/react";
import type { MessageDto } from "../../api/types.js";
import { CodeActions } from "../files.js";

/* --------------------------------------------------------------- reactions */

const QUICK_EMOJI = ["👍", "🔥", "✅", "👀", "🚀"];

export interface ReactionsProps {
  reactions: Record<string, number>;
  mine?: string[];
  onToggle?: (emoji: string) => void;
  onAddCustom?: (emoji: string) => void;
  disabled?: boolean;
}

/**
 * Reactions (F-074..F-077): emoji, custom emoji, removal and aggregation.
 * Counts shown are only the ones the server returned for this message.
 */
export function Reactions({ reactions, mine = [], onToggle, onAddCustom, disabled }: ReactionsProps) {
  const [custom, setCustom] = useState("");
  const [open, setOpen] = useState(false);
  const entries = Object.entries(reactions).filter(([, count]) => count > 0);

  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }} data-testid="reaction-emoji">
      {entries.map(([emoji, count]) => {
        const selected = mine.includes(emoji);
        return (
          <button
            key={emoji}
            type="button"
            className="air-btn"
            data-size="sm"
            data-variant={selected ? "primary" : "default"}
            aria-pressed={selected}
            aria-label={`${emoji} 반응 ${count}개${selected ? ", 내 반응 취소" : ""}`}
            disabled={disabled}
            onClick={() => onToggle?.(emoji)}
            style={{ borderRadius: 999, padding: "1px 8px", minHeight: 22, gap: 4 }}
            data-testid="reaction-count"
          >
            <span>{emoji}</span>
            <span className="air-mono" style={{ fontSize: 10.5 }}>{count}</span>
          </button>
        );
      })}
      {entries.length > 0 && mine.length > 0 && onToggle ? (
        <button
          type="button"
          className="air-btn"
          data-size="sm"
          data-variant="ghost"
          onClick={() => mine.forEach((e) => onToggle(e))}
          data-testid="reaction-remove"
          title="내 반응 모두 취소"
        >
          <Icon name="x" size={11} /> 내 반응 취소
        </button>
      ) : null}
      <button
        type="button"
        className="air-btn"
        data-size="sm"
        data-variant="ghost"
        aria-label="사용자 정의 이모지 추가"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        data-testid="reaction-custom"
      >
        <Icon name="plus" size={11} />
      </button>
      {open ? (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          {QUICK_EMOJI.filter((e) => !reactions[e]).map((emoji) => (
            <button key={emoji} type="button" className="air-btn" data-size="sm" data-variant="ghost" onClick={() => onAddCustom?.(emoji)} aria-label={`${emoji} 추가`}>
              {emoji}
            </button>
          ))}
          <input
            aria-label="직접 입력한 이모지"
            className="air-input"
            style={{ width: 56, minHeight: 24, padding: "1px 6px", fontSize: 12 }}
            value={custom}
            maxLength={4}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom.trim()) {
                onAddCustom?.(custom.trim());
                setCustom("");
              }
            }}
            placeholder="🙂"
          />
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- message actions */

export interface MessageActionHandlers {
  onReply?: (message: MessageDto) => void;
  onCreateThread?: (message: MessageDto) => void;
  onTogglePin?: (message: MessageDto) => void;
  onToggleBookmark?: (message: MessageDto) => void;
  onShareReference?: (message: MessageDto) => void;
  onCopyLink?: (message: MessageDto) => void;
  onToggleImportant?: (message: MessageDto) => void;
  onRestore?: (message: MessageDto) => void;
  onOpenEditHistory?: (message: MessageDto) => void;
}

export function MessageActions({
  message,
  important,
  bookmarked,
  delivered,
  handlers,
}: {
  message: MessageDto;
  important?: boolean;
  bookmarked?: boolean;
  delivered?: boolean;
  handlers: MessageActionHandlers;
}) {
  const deleted = Boolean(message.deleted_at);
  return (
    <div className="air-msg-actions" role="toolbar" aria-label="메시지 작업">
      {!deleted ? (
        <>
          <IconButton icon="reply" label="답글" onClick={() => handlers.onReply?.(message)} data-testid="message-reply" />
          <IconButton icon="thread" label="스레드" onClick={() => handlers.onCreateThread?.(message)} data-testid="message-thread-create" />
          <IconButton icon="pin" label="고정" onClick={() => handlers.onTogglePin?.(message)} />
          <IconButton icon="bookmark" label="북마크" onClick={() => handlers.onToggleBookmark?.(message)} data-testid="message-bookmark" />
          <IconButton icon="sparkles" label={important ? "중요 해제" : "중요 표시"} onClick={() => handlers.onToggleImportant?.(message)} data-testid="message-important" />
          <IconButton icon="external" label="공유 참조" onClick={() => handlers.onShareReference?.(message)} data-testid="message-share-ref" />
          <IconButton icon="hash" label="링크 복사" onClick={() => handlers.onCopyLink?.(message)} data-testid="message-copy-link" />
          {message.edited_at ? <IconButton icon="history" label="편집 기록" onClick={() => handlers.onOpenEditHistory?.(message)} /> : null}
          {delivered ? (
            <span title="서버가 읽음 이벤트를 제공한 경우에만 표시됩니다" data-testid="message-read-receipt">
              <Badge tone="ok" icon="eye">읽음</Badge>
            </span>
          ) : null}
          {bookmarked ? <Badge tone="info" icon="bookmark">북마크</Badge> : null}
        </>
      ) : handlers.onRestore ? (
        <Button size="sm" icon="refresh" onClick={() => handlers.onRestore?.(message)}>복원 요청</Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- message card */

function toEnvelope(message: MessageDto, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: message.message_id,
    room_id: message.room_id,
    author: {
      actor_id: message.author.actor_id,
      kind: message.author.kind,
      display_name: message.author.display_name,
      attestation: (message.author.attestation as MessageEnvelope["author"]["attestation"]) ?? "unknown",
    },
    blocks: message.blocks,
    created_at: message.created_at,
    edited_at: message.edited_at ?? null,
    deleted_at: message.deleted_at ?? null,
    revision: message.revision,
    reply_count: message.reply_count,
    project_id: message.project_id ?? null,
    room_seq: message.room_seq,
    delivery: message.delivery,
    ...overrides,
  };
}

export function MessageCard({
  message,
  index = 0,
  important,
  bookmarked,
  delivered,
  mineReactions,
  onToggleReaction,
  onAddReaction,
  handlers,
  pendingDelivery,
  onDownloadCode,
}: {
  message: MessageDto;
  index?: number;
  important?: boolean;
  bookmarked?: boolean;
  delivered?: boolean;
  mineReactions?: string[];
  onToggleReaction?: (message: MessageDto, emoji: string) => void;
  onAddReaction?: (message: MessageDto, emoji: string) => void;
  handlers: MessageActionHandlers;
  pendingDelivery?: boolean;
  onDownloadCode?: (code: string, filename: string) => void;
}) {
  const rendered = useMemo(
    () => renderMessage(toEnvelope(message, pendingDelivery ? { delivery: "queued" } : {}), { now: Date.now() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message, pendingDelivery],
  );

  const firstCode = message.blocks.find((b) => b.type === "code");
  const codePayload = firstCode ? (firstCode.payload as { code?: string; filename?: string }) : null;

  return (
    <Reveal as="article" kind="rise" delay={Math.min(index, 6) * 28}>
      <div className="air-msg" data-important={important || undefined} data-pending={pendingDelivery || undefined}>
        <div aria-hidden="true" style={{ display: "grid", placeItems: "start" }}>
          <span className="air-avatar" data-ring={message.author.kind === "owner" ? "verified" : message.deleted_at ? "offline" : "none"} style={{ width: 30, height: 30, fontSize: 11 }}>
            {Array.from(message.author.display_name).slice(0, 2).join("")}
          </span>
        </div>
        <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
          <MessageBody message={rendered} />
          {codePayload?.code ? (
            <CodeActions code={codePayload.code} filename={codePayload.filename} onDownload={onDownloadCode} />
          ) : null}
          {rendered.warnings.length > 0 ? (
            <div className="air-hint" role="status">⚠ {rendered.warnings.join(" · ")}</div>
          ) : null}
          {message.reactions && Object.keys(message.reactions).length > 0 ? (
            <Reactions
              reactions={message.reactions}
              mine={mineReactions}
              onToggle={(emoji) => onToggleReaction?.(message, emoji)}
              onAddCustom={(emoji) => onAddReaction?.(message, emoji)}
              disabled={Boolean(message.deleted_at)}
            />
          ) : !message.deleted_at ? (
            <Reactions reactions={{}} mine={[]} onToggle={(emoji) => onAddReaction?.(message, emoji)} onAddCustom={(emoji) => onAddReaction?.(message, emoji)} />
          ) : null}
          <MessageActions message={message} important={important} bookmarked={bookmarked} delivered={delivered} handlers={handlers} />
        </div>
      </div>
    </Reveal>
  );
}

/* ----------------------------------------------------------------- composer */

export interface ComposerProps {
  roomId: string;
  agents: Array<{ agent_id: string; display_name: string; kind: string }>;
  onSend: (blocks: MessageDto["blocks"], plain: string) => void;
  disabled?: boolean;
  /** Real typing events only; an empty array means nobody is typing. */
  typing?: Array<{ name: string }>;
  replyTo?: MessageDto | null;
  onCancelReply?: () => void;
  onAttach?: (files: File[]) => void;
}

const DRAFT_PREFIX = "air.draft.";

/**
 * Composer (F-016, F-017, F-020..F-022, F-078, F-091).
 * Draft is stored per room in localStorage; duplicate submits inside 600ms are
 * ignored and reuse the same intent, so a double click cannot post twice.
 */
export function Composer({ roomId, agents, onSend, disabled, typing = [], replyTo, onCancelReply, onAttach }: ComposerProps) {
  const storageKey = `${DRAFT_PREFIX}${roomId}`;
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const lastSend = useRef<{ at: number; text: string } | null>(null);
  const [saved, setSaved] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (value) localStorage.setItem(storageKey, value);
        else localStorage.removeItem(storageKey);
        setSaved(value ? new Date().toLocaleTimeString() : "");
      } catch {
        setSaved("");
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [value, storageKey]);

  const send = useCallback(() => {
    const text = value.trim();
    if (!text || disabled) return;
    const now = Date.now();
    if (lastSend.current && now - lastSend.current.at < 600 && lastSend.current.text === text) return;
    lastSend.current = { at: now, text };
    const blocks: MessageDto["blocks"] = [{ type: "markdown", version: 1, payload: { markdown: text } }];
    onSend(blocks, text);
    setValue("");
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [value, disabled, onSend, storageKey]);

  const insertMention = (name: string) => {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(textareaRef.current?.selectionStart ?? value.length);
    const next = `${before}@${name} ${after}`;
    setValue(next);
    setMention(null);
    textareaRef.current?.focus();
  };

  const onChange = (next: string) => {
    setValue(next);
    const caret = textareaRef.current?.selectionStart ?? next.length;
    const upto = next.slice(0, caret);
    const match = /(^|\s)@([\p{L}\p{N}_-]{0,24})$/u.exec(upto);
    if (match) setMention({ query: match[2] ?? "", start: caret - (match[2]?.length ?? 0) - 1 });
    else setMention(null);
  };

  const suggestions = mention
    ? agents.filter((a) => a.display_name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : [];

  return (
    <div className="air-composer">
      {replyTo ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--air-text-muted)" }}>
          <Icon name="reply" size={12} /> {replyTo.author.display_name} 메시지에 답글
          <button type="button" className="air-btn" data-size="sm" data-variant="ghost" onClick={onCancelReply}>취소</button>
        </div>
      ) : null}
      <div className="air-composer-box" style={{ position: "relative" }}>
        <Tabs
          label="작성 모드"
          value={mode}
          onChange={(id) => setMode(id as "write" | "preview")}
          items={[{ id: "write", label: "작성" }, { id: "preview", label: "미리보기" }]}
        />
        {mode === "write" ? (
          <>
            <TextArea
              ref={textareaRef}
              aria-label="메시지 작성"
              placeholder={disabled ? "게이트웨이 연결 후 전송할 수 있습니다 (초안은 저장됩니다)" : "메시지 · @로 AI 멘션 · Markdown"}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") setMention(null);
                if (e.key === "Tab" && suggestions[0] && mention) {
                  e.preventDefault();
                  insertMention(suggestions[0].display_name);
                }
              }}
              style={{ border: 0, background: "transparent", minHeight: 66 }}
            />
            {mention && suggestions.length > 0 ? (
              <div className="air-mention-pop" role="listbox" aria-label="멘션 대상">
                {suggestions.map((agent, i) => (
                  <button
                    key={agent.agent_id}
                    type="button"
                    role="option"
                    aria-selected={i === 0}
                    className="air-mention-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(agent.display_name);
                    }}
                    data-testid={agent.kind === "agent" ? "composer-mention-ai" : "composer-mention-user"}
                  >
                    <span className="air-avatar" style={{ width: 20, height: 20, fontSize: 9 }}>{Array.from(agent.display_name).slice(0, 1).join("")}</span>
                    {agent.display_name}
                    <span className="air-hint">{agent.kind === "agent" ? "AI" : "사용자"}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div style={{ padding: "10px 12px", minHeight: 66 }} data-testid="composer-preview">
            {value.trim() ? (
              <div className="mb-markdown" style={{ fontSize: 13 }}>
                <VNodeView node={{ t: "el", tag: "div", children: renderMarkdown(value, { allowRemoteImages: false }).nodes }} />
                <div className="air-hint" style={{ marginTop: 6 }}>미리보기 · 원격 이미지 자동 로드 안 함</div>
              </div>
            ) : (
              <span className="air-hint">미리볼 내용이 없습니다</span>
            )}
          </div>
        )}
        <div className="air-composer-bar">
          <button type="button" className="air-btn" data-size="sm" data-variant="ghost" onClick={() => setMode(mode === "write" ? "preview" : "write")} data-testid="composer-source-toggle">
            <Icon name="code" size={12} /> {mode === "write" ? "미리보기" : "작성"}
          </button>
          <label className="air-btn" data-size="sm" data-variant="ghost" style={{ cursor: "pointer" }}>
            <Icon name="paperclip" size={12} /> 첨부
            <input
              type="file"
              multiple
              style={{ display: "none" }}
              aria-label="파일 첨부"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) onAttach?.(files);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <span data-testid="composer-draft-state" className="air-hint air-composer-bar-note">
            {saved ? `초안 저장됨 ${saved}` : value ? "초안 저장 중…" : "초안 없음"}
          </span>
          <span data-testid="typing-indicator" className="air-composer-bar-note" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {typing.length > 0 ? (
              <>
                <TypingDots label={`${typing.map((t) => t.name).join(", ")} 입력 중`} />
                <span className="air-hint">{typing.map((t) => t.name).join(", ")} 입력 중</span>
              </>
            ) : (
              <span className="air-hint">입력 중 표시는 실제 이벤트가 있을 때만 나타납니다</span>
            )}
          </span>
          <span style={{ flex: 1 }} />
          <span className="air-hint air-composer-bar-note" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <Kbd>⌘</Kbd>+<Kbd>Enter</Kbd>
          </span>
          <Button size="sm" variant="primary" icon="send" onClick={send} disabled={disabled || !value.trim()} data-testid="send-dedupe">전송</Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- thread panel */

export function ThreadPanel({
  root,
  replies,
  onClose,
  onNotifyToggle,
  notifyEnabled,
  composer,
}: {
  root: MessageDto | null;
  replies: readonly MessageDto[];
  onClose: () => void;
  onNotifyToggle?: () => void;
  notifyEnabled?: boolean;
  composer?: React.ReactNode;
}) {
  if (!root) return null;
  return (
    <aside style={{ borderLeft: "1px solid var(--air-line)", display: "grid", gridTemplateRows: "auto minmax(0,1fr) auto", minHeight: 0, background: "var(--air-surface)" }} aria-label="스레드">
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--air-line)" }}>
        <Icon name="thread" size={13} />
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>스레드</span>
        <span className="air-hint">{replies.length}개 답글</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="air-btn" data-size="sm" data-variant={notifyEnabled ? "primary" : "ghost"} onClick={onNotifyToggle} data-testid="thread-notify-toggle">
          <Icon name="bell" size={12} /> {notifyEnabled ? "알림 켜짐" : "알림"}
        </button>
        <IconButton icon="close" label="스레드 닫기" onClick={onClose} />
      </header>
      <div className="air-scroll" style={{ padding: 10, display: "grid", gap: 8 }}>
        <div className="air-card" data-pad="sm" style={{ opacity: 0.85 }}>
          <div className="air-hint">{root.author.display_name} · 원본</div>
          <div className="mb-blocks">
            <MessageBody message={renderMessage(toEnvelope(root))} />
          </div>
        </div>
        {replies.length === 0 ? <span className="air-hint">아직 답글이 없습니다.</span> : null}
        {replies.map((reply, i) => (
          <MessageCard key={reply.message_id} message={reply} index={i} handlers={{}} />
        ))}
      </div>
      {composer}
    </aside>
  );
}

export function MessageList({
  messages,
  pending = [],
  handlers,
  filter,
}: {
  messages: readonly MessageDto[];
  pending?: Array<{ item: { id: string; roomId: string; createdAt: string; blocks: MessageDto["blocks"]; state: string } }>;
  handlers: MessageActionHandlers;
  filter?: string;
}) {
  const visible = filter
    ? messages.filter((m) => JSON.stringify(m.blocks).toLowerCase().includes(filter.toLowerCase()))
    : messages;

  return (
    <div className="air-chat-scroll" role="log" aria-live="polite" aria-label="메시지 목록">
      {visible.map((message, index) => (
        <MessageCard key={message.message_id} message={message} index={index} handlers={handlers} />
      ))}
      {pending.map(({ item }) => (
        <MessageCard
          key={item.id}
          message={{
            message_id: item.id,
            room_id: item.roomId,
            room_seq: null,
            author: { actor_id: "owner", display_name: "천예준", kind: "owner" },
            blocks: item.blocks,
            created_at: item.createdAt,
            delivery: "queued",
          }}
          pendingDelivery
          handlers={{}}
        />
      ))}
      {visible.length === 0 && pending.length === 0 ? (
        <div style={{ display: "grid", placeItems: "center", padding: 40 }}>
          <span className="air-hint">메시지가 없습니다. 첫 메시지를 보내 보세요.</span>
        </div>
      ) : null}
    </div>
  );
}

export function EditHistoryDialog({ message, onClose }: { message: MessageDto | null; onClose: () => void }) {
  if (!message) return null;
  return (
    <Dialog open onClose={onClose} title="편집 기록" description="수정은 불변 revision으로 남습니다">
      <div className="air-kv">
        <dt>revision</dt>
        <dd className="air-mono">{message.revision ?? "미제공"}</dd>
        <dt>최초 작성</dt>
        <dd className="air-mono">{message.created_at}</dd>
        <dt>마지막 수정</dt>
        <dd className="air-mono">{message.edited_at ?? "없음"}</dd>
        <dt>버전 체인</dt>
        <dd>{message.edited_at ? "서버가 버전 목록을 제공하면 여기에 표시됩니다" : "수정된 메시지가 아닙니다"}</dd>
      </div>
    </Dialog>
  );
}

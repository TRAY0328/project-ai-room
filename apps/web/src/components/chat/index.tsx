import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Badge,
  Button,
  Dialog,
  Icon,
  IconButton,
  Kbd,
  TextArea,
  TypingDots,
} from "@ai-room/design-system";
import { renderMessage, renderMarkdown, type MessageEnvelope } from "@ai-room/message-blocks";
import { MessageBody, VNodeView } from "@ai-room/message-blocks/react";
import type { MessageDto } from "../../api/types.js";
import { CodeActions } from "../files.js";
import { chatTime, excerptOf, initialsOf, kakaoDayLabel, plainTextOf, sameDay } from "../../lib/chat-format.js";

/* --------------------------------------------------------------- reactions */

/** The one-click row a bubble offers: one tap, no picker. */
export const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "🔥"];

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
    <div className="air-reactions" data-testid="reaction-emoji">
      {entries.map(([emoji, count]) => {
        const selected = mine.includes(emoji);
        return (
          <button
            key={emoji}
            type="button"
            className="air-reaction"
            data-mine={selected || undefined}
            aria-pressed={selected}
            aria-label={`${emoji} 반응 ${count}개${selected ? ", 내 반응 취소" : ""}`}
            title={selected ? "내 반응 취소 (서버 취소는 이 화면에서만 반영)" : "반응 추가"}
            disabled={disabled}
            onClick={() => onToggle?.(emoji)}
            data-testid="reaction-count"
          >
            <span className="air-reaction-emoji">{emoji}</span>
            <span className="air-reaction-count">{count}</span>
          </button>
        );
      })}
      {entries.length > 0 && mine.length > 0 && onToggle ? (
        <button
          type="button"
          className="air-reaction air-reaction-more"
          onClick={() => mine.forEach((e) => onToggle(e))}
          data-testid="reaction-remove"
          title="내 반응 모두 취소 — 서버는 반응 추가만 저장합니다"
        >
          <Icon name="x" size={11} /> 내 반응 취소
        </button>
      ) : null}
      <button
        type="button"
        className="air-reaction air-reaction-more"
        aria-label="사용자 정의 이모지 추가"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        data-testid="reaction-custom"
      >
        <Icon name="plus" size={11} />
      </button>
      {open ? (
        <span className="air-reaction-picker">
          {QUICK_EMOJI.filter((e) => !reactions[e]).map((emoji) => (
            <button key={emoji} type="button" className="air-reaction-pick" onClick={() => onAddCustom?.(emoji)} aria-label={`${emoji} 추가`}>
              {emoji}
            </button>
          ))}
          <input
            aria-label="직접 입력한 이모지"
            className="air-input air-reaction-input"
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
  onCopyText?: (message: MessageDto) => void;
  onToggleImportant?: (message: MessageDto) => void;
  onRestore?: (message: MessageDto) => void;
  onOpenEditHistory?: (message: MessageDto) => void;
  /** Reaction add/toggle, so the list can wire it without another prop. */
  onToggleReaction?: (message: MessageDto, emoji: string) => void;
  onAddReaction?: (message: MessageDto, emoji: string) => void;
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
          <IconButton icon="reply" label="답글" title="답글" onClick={() => handlers.onReply?.(message)} data-testid="message-reply" />
          <IconButton icon="copy" label="텍스트 복사" title="텍스트 복사" onClick={() => handlers.onCopyText?.(message)} data-testid="message-copy-text" />
          <IconButton icon="thread" label="스레드" title="스레드" onClick={() => handlers.onCreateThread?.(message)} data-testid="message-thread-create" />
          <IconButton icon="pin" label="고정" title="고정" onClick={() => handlers.onTogglePin?.(message)} />
          <IconButton icon="bookmark" label="북마크" title="북마크" onClick={() => handlers.onToggleBookmark?.(message)} data-testid="message-bookmark" />
          <IconButton icon="sparkles" label={important ? "중요 해제" : "중요 표시"} title={important ? "중요 해제" : "중요 표시"} onClick={() => handlers.onToggleImportant?.(message)} data-testid="message-important" />
          <IconButton icon="external" label="공유 참조" title="공유 참조" onClick={() => handlers.onShareReference?.(message)} data-testid="message-share-ref" />
          <IconButton icon="hash" label="링크 복사" title="링크 복사" onClick={() => handlers.onCopyLink?.(message)} data-testid="message-copy-link" />
          {message.edited_at ? <IconButton icon="history" label="편집 기록" title="편집 기록" onClick={() => handlers.onOpenEditHistory?.(message)} /> : null}
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

/** The delivery states a chat reader needs to see; an acknowledged write is quiet. */
function deliveryNote(message: MessageDto): { label: string; tone: "warn" | "danger" | "neutral" } | null {
  if (message.delivery === "failed") return { label: "전송 실패", tone: "danger" };
  if (message.delivery === "queued") return { label: "전송 중", tone: "warn" };
  return null;
}

export interface ReplyTarget {
  message: MessageDto;
  /** Author name as the reader sees it (the room knows agent names). */
  name: string;
}

export function MessageCard({
  message,
  index = 0,
  important,
  bookmarked,
  delivered,
  mineReactions,
  mine,
  grouped,
  groupEnd = true,
  replyTo,
  onJumpToReply,
  onToggleReaction,
  onAddReaction,
  handlers,
  pendingDelivery,
  onDownloadCode,
  onOpenActions,
}: {
  message: MessageDto;
  index?: number;
  important?: boolean;
  bookmarked?: boolean;
  delivered?: boolean;
  mineReactions?: string[];
  /** Right-aligned, own bubble. Defaults to false: a caller that does not know the reader shows a peer message. */
  mine?: boolean;
  /** Same author, same minute as the message above: no repeated avatar or name. */
  grouped?: boolean;
  /** Last bubble of its group: this is where the clock belongs, the way KakaoTalk draws it. */
  groupEnd?: boolean;
  replyTo?: ReplyTarget | null;
  onJumpToReply?: (message: MessageDto) => void;
  onToggleReaction?: (message: MessageDto, emoji: string) => void;
  onAddReaction?: (message: MessageDto, emoji: string) => void;
  handlers: MessageActionHandlers;
  pendingDelivery?: boolean;
  onDownloadCode?: (code: string, filename: string) => void;
  /** A tap / long press / right click on the bubble asks the room for its action sheet. */
  onOpenActions?: (message: MessageDto) => void;
}) {
  const rendered = useMemo(
    () => renderMessage(toEnvelope(message, pendingDelivery ? { delivery: "queued" } : {}), { now: Date.now() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message, pendingDelivery],
  );

  const firstCode = message.blocks.find((b) => b.type === "code");
  const codePayload = firstCode ? (firstCode.payload as { code?: string; filename?: string }) : null;
  const note = pendingDelivery ? { label: "전송 중", tone: "warn" as const } : deliveryNote(message);
  const reactions = message.reactions ?? {};
  const hasReactions = Object.values(reactions).some((count) => count > 0);
  const delay = Math.min(index, 8) * 26;
  const deleted = Boolean(message.deleted_at);
  const showName = !mine && !grouped;
  /** A press that stays down is a long press; a finger that scrolls is not. */
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressFired = useRef(false);

  const openActions = () => {
    if (deleted || onOpenActions === undefined) return;
    // Selecting text is not a request for a menu.
    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (selection !== null && selection !== undefined && (selection.toString().length > 0)) return;
    onOpenActions(message);
  };

  const clearPress = () => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <article
      className="air-msg"
      data-mine={mine || undefined}
      data-grouped={grouped || undefined}
      data-group-end={groupEnd || undefined}
      data-important={important || undefined}
      data-pending={pendingDelivery || undefined}
      data-deleted={message.deleted_at ? "true" : undefined}
      style={{ "--air-msg-delay": `${delay}ms` } as CSSProperties}
    >
      <div className="air-msg-gutter" aria-hidden="true">
        {showName ? (
          <span className="air-avatar air-msg-avatar" data-ring={message.author.kind === "owner" ? "verified" : "none"}>
            {initialsOf(message.author.display_name)}
          </span>
        ) : null}
      </div>

      <div className="air-msg-col">
        {showName ? (
          <div className="air-msg-name-row">
            <span className="air-msg-name">{message.author.display_name}</span>
            {message.author.kind === "agent" ? <span className="air-msg-badge">AI</span> : null}
            {message.author.attestation === "provider_verified" ? <Icon name="shieldHalf" size={11} title="공급자 검증" /> : null}
          </div>
        ) : null}

        {replyTo ? (
          <button type="button" className="air-reply-quote" onClick={() => onJumpToReply?.(replyTo.message)} title="원문으로 이동">
            <span className="air-reply-quote-name">{replyTo.name}</span>
            <span className="air-reply-quote-text">{excerptOf(replyTo.message)}</span>
          </button>
        ) : null}

        <div className="air-msg-line">
          <div
            className="air-msg-bubble"
            tabIndex={0}
            aria-label={`${message.author.display_name} 메시지`}
            onClick={(event) => {
              if (pressFired.current) {
                pressFired.current = false;
                return;
              }
              const target = event.target as HTMLElement;
              // A link, a button or a code action inside the bubble keeps its own job.
              if (target.closest("a, button, input, textarea, select") !== null) return;
              openActions();
            }}
            onDoubleClick={openActions}
            onContextMenu={(event) => {
              if (onOpenActions === undefined || deleted) return;
              event.preventDefault();
              openActions();
            }}
            onPointerDown={(event) => {
              if (onOpenActions === undefined || deleted) return;
              if (event.pointerType === "mouse") return;
              clearPress();
              pressFired.current = false;
              pressTimer.current = setTimeout(() => {
                pressFired.current = true;
                pressTimer.current = null;
                onOpenActions(message);
              }, 520);
            }}
            onPointerUp={clearPress}
            onPointerLeave={clearPress}
            onPointerCancel={clearPress}
          >
            <MessageBody message={rendered} />
            {codePayload?.code ? (
              <CodeActions code={codePayload.code} filename={codePayload.filename} onDownload={onDownloadCode} />
            ) : null}
            {rendered.warnings.length > 0 ? (
              <div className="air-hint" role="status">⚠ {rendered.warnings.join(" · ")}</div>
            ) : null}
          </div>

          <div className="air-msg-side">
            {groupEnd ? (
              <time className="air-msg-time" dateTime={message.created_at} title={new Date(message.created_at).toISOString()}>
                {chatTime(message.created_at)}
              </time>
            ) : null}
            {note ? <span className="air-msg-delivery" data-tone={note.tone}>{note.label}</span> : null}
            {message.edited_at ? <span className="air-msg-edited">수정됨</span> : null}
            {message.delivery === "server_stored" && !pendingDelivery ? (
              <span className="air-msg-saved" title={`서버에 저장됨${message.room_seq != null ? ` · seq ${message.room_seq}` : ""}`}>
                <Icon name="check" size={11} /> 저장됨
              </span>
            ) : null}
          </div>
        </div>

        {hasReactions ? (
          <Reactions
            reactions={reactions}
            mine={mineReactions}
            onToggle={(emoji) => onToggleReaction?.(message, emoji)}
            onAddCustom={(emoji) => onAddReaction?.(message, emoji)}
            disabled={deleted}
          />
        ) : null}

        <div className="air-msg-tools">
          {!deleted ? (
            <>
              <div className="air-msg-quick" role="group" aria-label="빠른 반응">
                {QUICK_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="air-quick-emoji"
                    aria-label={`${emoji} 반응`}
                    data-testid="quick-reaction"
                    onClick={() => onAddReaction?.(message, emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              {onOpenActions ? (
                <button type="button" className="air-msg-more" onClick={() => onOpenActions(message)} data-testid="message-more">
                  <Icon name="menu" size={13} /> 더보기
                </button>
              ) : null}
            </>
          ) : null}
          <MessageActions message={message} important={important} bookmarked={bookmarked} delivered={delivered} handlers={handlers} />
        </div>
      </div>
    </article>
  );
}

/* ----------------------------------------------------------------- composer */

export interface ComposerSendMeta {
  replyToId?: string | null;
  mentionedIds?: string[];
}

export interface ComposerProps {
  roomId: string;
  agents: Array<{ agent_id: string; display_name: string; kind: string }>;
  onSend: (blocks: MessageDto["blocks"], plain: string, meta?: ComposerSendMeta) => void;
  disabled?: boolean;
  /** Real typing events only; an empty array means nobody is typing. */
  typing?: Array<{ name: string }>;
  replyTo?: MessageDto | null;
  replyToName?: string;
  onCancelReply?: () => void;
  onAttach?: (files: File[]) => void;
  /** Opens the `+` sheet that holds attachments, snippets and AI invitations. */
  onOpenPlus?: () => void;
}

const DRAFT_PREFIX = "air.draft.";

/** Ask the composer of the open room to take a snippet (the `+` sheet uses it). */
export const COMPOSER_INSERT_EVENT = "air:composer-insert";

export function insertIntoComposer(text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(COMPOSER_INSERT_EVENT, { detail: text }));
}

/**
 * Composer (F-016, F-017, F-020..F-022, F-078, F-091) in the shape a messenger
 * has: an empty field that grows, one round `+` on the left for attachments and
 * extras, and one yellow send button on the right that only lights up when there
 * is something to send.
 *
 * Draft is stored per room in localStorage; duplicate submits inside 600ms are
 * ignored and reuse the same intent, so a double click cannot post twice.
 * Enter sends, Shift+Enter breaks the line, and a Korean IME's own Enter (key
 * 229 / isComposing) never sends the syllable being composed.
 */
export function Composer({ roomId, agents, onSend, disabled, typing = [], replyTo, replyToName, onCancelReply, onAttach, onOpenPlus }: ComposerProps) {
  const storageKey = `${DRAFT_PREFIX}${roomId}`;
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [sent, setSent] = useState(false);
  const lastSend = useRef<{ at: number; text: string } | null>(null);
  const [saved, setSaved] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // The box grows with the text (up to a limit) instead of keeping a fixed
  // inner scrollbar, so a long message is still readable while typing.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(176, Math.max(24, el.scrollHeight))}px`;
  }, [value, mode]);

  useEffect(() => () => {
    if (sentTimer.current !== null) clearTimeout(sentTimer.current);
  }, []);

  // The `+` sheet hands a snippet to the composer instead of sending it: the
  // writer still decides the words around the code block.
  useEffect(() => {
    const onInsert = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (typeof text !== "string" || text.length === 0) return;
      setMode("write");
      setValue((prev) => (prev.trim().length === 0 ? text : `${prev.replace(/\s+$/, "")}\n${text}`));
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
  }, []);

  const send = useCallback(() => {
    const text = value.trim();
    if (!text || disabled) return;
    const now = Date.now();
    if (lastSend.current && now - lastSend.current.at < 600 && lastSend.current.text === text) return;
    lastSend.current = { at: now, text };
    const blocks: MessageDto["blocks"] = [{ type: "markdown", version: 1, payload: { markdown: text } }];
    const mentionedIds = agents
      .filter((agent) => new RegExp(`(^|\\s)@${agent.display_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$|[.,!?])`).test(text))
      .map((agent) => agent.agent_id);
    onSend(blocks, text, {
      ...(replyTo ? { replyToId: replyTo.message_id } : {}),
      ...(mentionedIds.length > 0 ? { mentionedIds } : {}),
    });
    setValue("");
    setMention(null);
    setSent(true);
    if (sentTimer.current !== null) clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setSent(false), 320);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [value, disabled, onSend, storageKey, agents, replyTo]);

  const insertMention = useCallback((name: string) => {
    setMention((current) => {
      if (current === null) return null;
      const before = value.slice(0, current.start);
      const after = value.slice(current.end);
      setValue(`${before}@${name} ${after}`);
      return null;
    });
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [value]);

  const onChange = (next: string) => {
    setValue(next);
    const caret = textareaRef.current?.selectionStart ?? next.length;
    const upto = next.slice(0, caret);
    const match = /(^|\s)@([\p{L}\p{N}_-]{0,24})$/u.exec(upto);
    if (match) {
      const query = match[2] ?? "";
      setMention({ query, start: caret - query.length - 1, end: caret });
      setMentionIndex(0);
    } else {
      setMention(null);
    }
  };

  const suggestions = mention
    ? agents.filter((a) => a.display_name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : [];
  const activeSuggestion = suggestions[Math.min(mentionIndex, Math.max(0, suggestions.length - 1))];

  /* The suggestion list lives beside the box, not inside it: the box clips its
     own contents, so a list inside it could only be painted over the line that
     is being typed. */
  const mentionList = mode === "write" && mention && suggestions.length > 0 ? (
    <div className="air-mention-pop" role="listbox" aria-label="멘션 대상">
      <div className="air-mention-head">멘션할 AI·사용자</div>
      {suggestions.map((agent, i) => (
        <button
          key={agent.agent_id}
          type="button"
          role="option"
          aria-selected={i === mentionIndex}
          className="air-mention-item"
          data-active={i === mentionIndex || undefined}
          onMouseEnter={() => setMentionIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            insertMention(agent.display_name);
          }}
          data-testid={agent.kind === "agent" ? "composer-mention-ai" : "composer-mention-user"}
        >
          <span className="air-avatar" style={{ width: 22, height: 22, fontSize: 9 }}>{initialsOf(agent.display_name)}</span>
          <span style={{ flex: 1, minWidth: 0 }} className="air-truncate">{agent.display_name}</span>
          <span className="air-hint">{agent.kind === "agent" ? "AI" : "사용자"}</span>
          {i === mentionIndex ? <Kbd>↵</Kbd> : null}
        </button>
      ))}
    </div>
  ) : null;

  const canSend = !disabled && value.trim().length > 0;

  return (
    <div className="air-composer" data-mode={mode}>
      {replyTo ? (
        <div className="air-composer-reply" role="status">
          <span className="air-composer-reply-bar" aria-hidden="true" />
          <Icon name="reply" size={13} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="air-composer-reply-name">{replyToName ?? replyTo.author.display_name}에게 답장</div>
            <div className="air-composer-reply-text">{excerptOf(replyTo, 70)}</div>
          </div>
          <button type="button" className="air-composer-reply-x" aria-label="답장 취소" onClick={onCancelReply}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}

      <div className="air-composer-row">
        <button
          type="button"
          className="air-composer-plus"
          aria-label="첨부와 더보기"
          title="첨부와 더보기"
          onClick={onOpenPlus}
          data-testid="composer-plus"
        >
          <Icon name="plus" size={21} />
        </button>

        <div className="air-composer-box" data-mode={mode} data-ready={canSend || undefined}>
          {mode === "write" ? (
            <TextArea
              ref={textareaRef}
              aria-label="메시지 작성"
              data-testid="composer-input"
              className="air-composer-input"
              placeholder={disabled ? "게이트웨이 연결 후 전송할 수 있습니다 (초안은 저장됩니다)" : "메시지를 입력하세요"}
              value={value}
              rows={1}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                const composing = e.nativeEvent.isComposing || e.keyCode === 229;
                if (mention && suggestions.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIndex((i) => (i + 1) % suggestions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
                    return;
                  }
                  if ((e.key === "Enter" || e.key === "Tab") && !composing) {
                    e.preventDefault();
                    if (activeSuggestion) insertMention(activeSuggestion.display_name);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  if (composing) return;
                  e.preventDefault();
                  send();
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          ) : (
            <div className="air-composer-preview" data-testid="composer-preview">
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

          {/* Tools stay one row under the field: folded away while writing so the
              bar is the messenger bar, unfolded when the field has the focus. */}
          <div className="air-composer-bar">
            <button
              type="button"
              className="air-composer-tool"
              onClick={() => setMode(mode === "write" ? "preview" : "write")}
              data-testid="composer-source-toggle"
              title={mode === "write" ? "Markdown 미리보기" : "작성으로 돌아가기"}
              aria-pressed={mode === "preview"}
            >
              <Icon name={mode === "write" ? "eye" : "edit"} size={14} />
              <span className="air-composer-tool-label">{mode === "write" ? "미리보기" : "작성"}</span>
            </button>
            <label className="air-composer-tool" style={{ cursor: "pointer" }} title="파일 첨부">
              <Icon name="paperclip" size={14} />
              <span className="air-composer-tool-label">첨부</span>
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
              ) : null}
            </span>
            <span style={{ flex: 1 }} />
            <span className="air-hint air-composer-bar-note air-composer-kbd">
              <Kbd>Enter</Kbd> 전송 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 줄바꿈
            </span>
          </div>
        </div>

        <button
          type="button"
          className="air-composer-send"
          data-sent={sent || undefined}
          onClick={send}
          disabled={!canSend}
          aria-label="전송"
          title="전송 (Enter)"
          data-testid="send-dedupe"
        >
          <Icon name="send" size={18} />
          <span className="air-send-label">전송</span>
        </button>
      </div>

      {mentionList}
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
    <aside className="air-thread" aria-label="스레드">
      <header className="air-thread-head">
        <Icon name="thread" size={13} />
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>스레드</span>
        <span className="air-hint">{replies.length}개 답글</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="air-btn" data-size="sm" data-variant={notifyEnabled ? "primary" : "ghost"} onClick={onNotifyToggle} data-testid="thread-notify-toggle">
          <Icon name="bell" size={12} /> {notifyEnabled ? "알림 켜짐" : "알림"}
        </button>
        <IconButton icon="close" label="스레드 닫기" onClick={onClose} />
      </header>
      <div className="air-thread-body">
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

/* ------------------------------------------------------------------ list */

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
}

export function MessageList({
  messages,
  pending = [],
  handlers,
  filter,
  self,
  roomId,
  nameOf,
  onLoadOlder,
  loadingOlder = false,
  hasOlder = false,
  olderError = null,
  onOpenActions,
}: {
  messages: readonly MessageDto[];
  pending?: Array<{ item: { id: string; roomId: string; createdAt: string; blocks: MessageDto["blocks"]; state: string } }>;
  handlers: MessageActionHandlers;
  filter?: string;
  /** Who wrote the queued items in this browser (never a hardcoded name). */
  self?: { actor_id: string; display_name: string; kind: "owner" | "agent" };
  roomId?: string;
  /** Display name for a message author id (agent names live in the room). */
  nameOf?: (id: string) => string;
  /** Ask the screen for the page before the oldest message on screen. */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  hasOlder?: boolean;
  olderError?: string | null;
  /** A tap on a bubble asks the room for the message's action sheet. */
  onOpenActions?: (message: MessageDto) => void;
}) {
  const visible = filter
    ? messages.filter((m) => JSON.stringify(m.blocks).toLowerCase().includes(filter.toLowerCase()))
    : messages;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const countRef = useRef(0);
  /** Previous scrollTop: only an upward move asks for history. */
  const lastTopRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);
  /** scroll height/top before an older page was asked for, to keep the reader's place. */
  const anchorRef = useRef<{ height: number; top: number; firstId: string | null } | null>(null);
  /** Set when older rows were inserted above; the growth effect must not call it news. */
  const restoringRef = useRef(false);

  const requestOlder = useCallback(() => {
    const el = scrollRef.current;
    if (el === null || onLoadOlder === undefined || loadingOlder || !hasOlder) return;
    anchorRef.current = { height: el.scrollHeight, top: el.scrollTop, firstId: visible[0]?.message_id ?? null };
    onLoadOlder();
  }, [onLoadOlder, loadingOlder, hasOlder, visible]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (el === null) return;
    // jsdom has no scrollTo; a real browser does. Falling back keeps tests quiet
    // without changing what the browser actually does.
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  }, []);

  // Entering a room starts at the newest message — the place a reader looks for.
  useEffect(() => {
    countRef.current = 0;
    atBottomRef.current = true;
    lastTopRef.current = 0;
    setAtBottom(true);
    setUnseen(0);
    anchorRef.current = null;
    const frame = requestAnimationFrame(() => scrollToBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [roomId, scrollToBottom]);

  // A message arriving while the reader is at the bottom stays in view; one that
  // arrives while they are reading history offers the floating jump instead. A
  // page that was loaded *above* is neither news nor a jump — the reader keeps
  // their place (the effect below restores it).
  useEffect(() => {
    const restored = restoringRef.current;
    restoringRef.current = false;
    const grew = visible.length > countRef.current;
    countRef.current = visible.length;
    if (!grew || restored) return;
    if (loadingOlder || anchorRef.current !== null) return;
    const last = visible.at(-1);
    const own = last !== undefined && self !== undefined && last.author.actor_id === self.actor_id;
    if (atBottomRef.current || own) {
      requestAnimationFrame(() => scrollToBottom("smooth"));
      return;
    }
    setUnseen((n) => n + 1);
  }, [visible, self, scrollToBottom, loadingOlder]);

  // Older rows only add height above the viewport: move the scroll offset by the
  // same amount, so the message the reader was looking at does not move. This is
  // a layout effect so the correction lands before paint — and the smooth scroll
  // is turned off for the assignment, because an animated scroll can be
  // interrupted by the browser's own scroll anchoring and land back at zero.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    const el = scrollRef.current;
    if (el === null) {
      anchorRef.current = null;
      return;
    }
    if (loadingOlder) return;
    if (visible[0]?.message_id === anchor.firstId) return;
    const added = el.scrollHeight - anchor.height;
    if (added > 0) {
      const previous = el.style.scrollBehavior;
      el.style.scrollBehavior = "auto";
      el.scrollTop = anchor.top + added;
      el.style.scrollBehavior = previous;
      restoringRef.current = true;
    }
    anchorRef.current = null;
  }, [visible, loadingOlder]);

  useEffect(() => {
    if (flashId === null) return;
    const timer = window.setTimeout(() => setFlashId(null), 1400);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  const jumpTo = (message: MessageDto) => {
    const root = scrollRef.current;
    if (root === null) return;
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(message.message_id) : message.message_id;
    const el = root.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`);
    if (el === null) return;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashId(message.message_id);
  };

  type Row =
    | { kind: "day"; key: string; label: string }
    | { kind: "message"; key: string; message: MessageDto; index: number; grouped: boolean; groupEnd: boolean; mine: boolean; dayBreak: boolean };

  const rows: Row[] = [];
  let messageIndex = 0;
  const GROUP_MS = 5 * 60_000;

  for (let i = 0; i < visible.length; i += 1) {
    const message = visible[i]!;
    const previous = visible[i - 1] ?? null;
    const next = visible[i + 1] ?? null;
    const dayBreak = previous === null || !sameDay(previous.created_at, message.created_at);
    // The day stands above the first message of that day, the way a reader scans it.
    if (dayBreak) rows.push({ kind: "day", key: `day-${message.message_id}`, label: kakaoDayLabel(message.created_at) });

    const sameAsPrevious =
      !dayBreak &&
      previous !== null &&
      previous.author.actor_id === message.author.actor_id &&
      Math.abs(new Date(message.created_at).getTime() - new Date(previous.created_at).getTime()) < GROUP_MS;

    // A group ends where the next bubble belongs to someone else (or another
    // day, or far enough later): that last bubble carries the clock.
    const sameAsNext =
      next !== null &&
      next.author.actor_id === message.author.actor_id &&
      sameDay(next.created_at, message.created_at) &&
      Math.abs(new Date(next.created_at).getTime() - new Date(message.created_at).getTime()) < GROUP_MS;

    rows.push({
      kind: "message",
      key: message.message_id,
      message,
      index: messageIndex,
      grouped: sameAsPrevious,
      groupEnd: !sameAsNext,
      mine: self !== undefined && message.author.actor_id === self.actor_id,
      dayBreak,
    });
    messageIndex += 1;
  }

  const byId = new Map(visible.map((m) => [m.message_id, m]));

  return (
    <div className="air-chat-body">
      <div
        className="air-chat-scroll"
        role="log"
        aria-live="polite"
        aria-label="메시지 목록"
        data-empty={visible.length === 0 && pending.length === 0 ? "true" : undefined}
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = isNearBottom(el);
          atBottomRef.current = near;
          setAtBottom(near);
          if (near) setUnseen(0);
          // History is requested only on a real upward move inside content that
          // can scroll: the container sits at 0 while the first page is still on
          // its way (and its height jitters by a few pixels as it settles), which
          // is not the reader asking for older messages.
          const previousTop = lastTopRef.current;
          lastTopRef.current = el.scrollTop;
          const scrollable = el.scrollHeight - el.clientHeight > 200;
          if (scrollable && previousTop > 150 && el.scrollTop < 96 && el.scrollTop < previousTop - 8) requestOlder();
        }}
      >
        {hasOlder || loadingOlder || olderError !== null ? (
          <div className="air-chat-older" data-testid="chat-older">
            {loadingOlder ? (
              <span className="air-hint">이전 메시지를 불러오는 중…</span>
            ) : olderError !== null ? (
              <button type="button" className="air-chat-older-btn" onClick={requestOlder}>
                이전 메시지를 불러오지 못했습니다 — 다시 시도
              </button>
            ) : (
              <button type="button" className="air-chat-older-btn" onClick={requestOlder} disabled={!hasOlder}>
                이전 메시지 더 보기
              </button>
            )}
          </div>
        ) : null}
        {visible.length === 0 && pending.length === 0 ? (
          <div className="air-chat-empty">
            <span className="air-chat-empty-icon" aria-hidden="true">💬</span>
            <strong>{filter ? "이 방에서 찾는 말이 없습니다" : "첫 메시지를 보내 보세요"}</strong>
            <span className="air-hint">{filter ? "다른 낱말로 찾아보세요" : "Enter로 전송 · Shift+Enter로 줄바꿈 · @로 AI를 부를 수 있습니다"}</span>
          </div>
        ) : null}

        {rows.map((row) => {
          if (row.kind === "day") {
            return (
              <div className="air-chat-day" key={row.key}>
                <span>{row.label}</span>
              </div>
            );
          }
          const parentId = row.message.thread_root_id ?? null;
          const parent = parentId !== null ? byId.get(parentId) ?? null : null;
          return (
            <div key={row.key} data-flash={flashId === row.message.message_id || undefined} className="air-msg-slot">
              <MessageCard
                message={row.message}
                index={row.index}
                mine={row.mine}
                grouped={row.grouped && parent === null}
                groupEnd={row.groupEnd}
                replyTo={parent === null ? null : { message: parent, name: parent.author.actor_id === (self?.actor_id ?? "") ? (self?.display_name ?? parent.author.display_name) : (nameOf?.(parent.author.actor_id) ?? parent.author.display_name) }}
                onJumpToReply={jumpTo}
                onToggleReaction={(message, emoji) => handlers.onToggleReaction?.(message, emoji)}
                onAddReaction={(message, emoji) => handlers.onAddReaction?.(message, emoji)}
                onOpenActions={onOpenActions}
                handlers={handlers}
              />
            </div>
          );
        })}

        {pending.map(({ item }) => (
          <div key={item.id} className="air-msg-slot">
            <MessageCard
              message={{
                message_id: item.id,
                room_id: item.roomId,
                room_seq: null,
                author: self ?? { actor_id: "self", display_name: "나 (이 브라우저)", kind: "agent" },
                blocks: item.blocks,
                created_at: item.createdAt,
                delivery: "queued",
              }}
              mine
              pendingDelivery
              handlers={{}}
            />
          </div>
        ))}
      </div>

      {(!atBottom || unseen > 0) && visible.length > 0 ? (
        <button type="button" className="air-new-msg" onClick={() => scrollToBottom("smooth")} data-testid="chat-jump-newest">
          <Icon name="chevronDown" size={14} />
          {unseen > 0 ? `${unseen}개 새 메시지` : "맨 아래로"}
        </button>
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
        <dt>서버 저장</dt>
        <dd>{message.delivery === "server_stored" ? `저장됨 · seq ${message.room_seq ?? "—"}` : message.delivery ?? "미확인"}</dd>
        <dt>버전 체인</dt>
        <dd>{message.edited_at ? "서버가 버전 목록을 제공하면 여기에 표시됩니다" : "수정된 메시지가 아닙니다"}</dd>
      </div>
    </Dialog>
  );
}

/** A one-line body preview reused by the room drawer and the reply bar. */
export function messagePreview(message: MessageDto): string {
  return plainTextOf(message);
}

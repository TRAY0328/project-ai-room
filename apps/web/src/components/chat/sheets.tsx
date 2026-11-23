/**
 * Chat sheets — every chat action happens on top of the conversation.
 *
 * A messenger is one screen. Opening the room list, the participant list, the
 * AI join form, the account panel or a message's actions must not navigate away
 * from the conversation: it rises from the bottom (a phone sheet) or slides in
 * from the right (the "talk drawer"), and the room stays behind it. Both
 * variants keep the element mounted through their exit animation, so closing
 * looks the same as opening instead of blinking out.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, IconButton, useFocusTrap, type IconName } from "@ai-room/design-system";

/** Long enough for the exit transition; a shorter number cuts the slide. */
const EXIT_MS = 300;

export interface ChatSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** `bottom` rises from the bottom edge; `right` slides in like a drawer. */
  side?: "bottom" | "right";
  children: ReactNode;
  footer?: ReactNode;
  /** Extra class on the panel (a tall sheet, a compact sheet…). */
  variant?: "auto" | "tall" | "compact";
  testId?: string;
  /** Hide the grabber on the right drawer, which keeps its own header. */
  labelledByTitle?: boolean;
}

export function ChatSheet({
  open,
  onClose,
  title,
  subtitle,
  side = "bottom",
  children,
  footer,
  variant = "auto",
  testId,
  labelledByTitle = true,
}: ChatSheetProps) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const panelRef = useFocusTrap(open, onClose);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      if (exitTimer.current !== null) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
      setMounted(true);
      // One frame mounted at the closed position, so the transition has a start.
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(frame);
    }
    setEntered(false);
    exitTimer.current = setTimeout(() => {
      setMounted(false);
      exitTimer.current = null;
    }, EXIT_MS);
    return () => {
      if (exitTimer.current !== null) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
  }, [open]);

  // The page behind a sheet does not scroll; on the phone that is what keeps the
  // conversation from drifting under the sheet while a thumb drags inside it.
  useEffect(() => {
    if (!mounted || typeof document === "undefined") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mounted]);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="air-sheet-layer" data-side={side} data-state={entered ? "open" : "closed"}>
      <div
        className="air-sheet-scrim"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <div
        ref={panelRef}
        className="air-sheet"
        data-side={side}
        data-variant={variant}
        data-state={entered ? "open" : "closed"}
        role="dialog"
        aria-modal="true"
        aria-label={labelledByTitle ? title : undefined}
        tabIndex={-1}
        data-testid={testId}
      >
        {side === "bottom" ? <span className="air-sheet-grabber" aria-hidden="true" /> : null}
        <header className="air-sheet-head">
          <div className="air-sheet-heading">
            <span className="air-sheet-title">{title}</span>
            {subtitle ? <span className="air-sheet-subtitle">{subtitle}</span> : null}
          </div>
          <IconButton icon="close" label={`${title} 닫기`} onClick={onClose} />
        </header>
        <div className="air-sheet-body">{children}</div>
        {footer ? <footer className="air-sheet-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------- one row */

export interface SheetRowProps {
  icon: IconName;
  label: string;
  detail?: string;
  /** A compact trailing value, e.g. a count or a state word. */
  meta?: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "accent" | "danger";
  testId?: string;
  /** Renders as a link instead of a button (external URL). */
  href?: string;
}

export function SheetRow({ icon, label, detail, meta, onClick, disabled, tone = "default", testId, href }: SheetRowProps) {
  const content = (
    <>
      <span className="air-sheet-row-icon" aria-hidden="true">
        <Icon name={icon} size={17} />
      </span>
      <span className="air-sheet-row-text">
        <span className="air-sheet-row-label">{label}</span>
        {detail ? <span className="air-sheet-row-detail">{detail}</span> : null}
      </span>
      {meta ? <span className="air-sheet-row-meta">{meta}</span> : null}
    </>
  );
  if (href !== undefined) {
    return (
      <a className="air-sheet-row" data-tone={tone} href={href} data-testid={testId}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" className="air-sheet-row" data-tone={tone} onClick={onClick} disabled={disabled} data-testid={testId}>
      {content}
    </button>
  );
}

/* ------------------------------------------------------------- action list */

export interface ChatAction {
  icon: IconName;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
  testId?: string;
}

/** The long-press sheet: a list of what can be done with one message. */
export function ChatActionSheet({
  open,
  onClose,
  title,
  actions,
  testId = "chat-action-sheet",
  quickReactions = [],
  mineReactions = [],
  onReact,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  actions: ChatAction[];
  testId?: string;
  /** One-tap reactions at the top of the sheet, the way KakaoTalk offers them. */
  quickReactions?: readonly string[];
  mineReactions?: readonly string[];
  onReact?: (emoji: string) => void;
}) {
  return (
    <ChatSheet open={open} onClose={onClose} title={title} variant="compact" testId={testId}>
      {quickReactions.length > 0 && onReact !== undefined ? (
        <div className="air-action-reactions" role="group" aria-label="빠른 반응">
          {quickReactions.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="air-action-reaction"
              data-mine={mineReactions.includes(emoji) || undefined}
              aria-pressed={mineReactions.includes(emoji)}
              aria-label={`${emoji} 반응`}
              data-testid="action-quick-reaction"
              onClick={() => {
                onClose();
                onReact(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
      <div className="air-action-list">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="air-action-row"
            data-tone={action.tone ?? "default"}
            data-testid={action.testId}
            onClick={() => {
              onClose();
              action.onClick();
            }}
          >
            <Icon name={action.icon} size={16} />
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </ChatSheet>
  );
}

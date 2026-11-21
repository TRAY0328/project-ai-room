import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./a11y.js";
import { IconButton } from "./primitives.js";

/* ------------------------------------------------------------------ Dialog */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Width in px; defaults to 560. */
  width?: number;
  /** Blocks Escape/overlay close for consequential actions. */
  dismissible?: boolean;
}

export function Dialog({ open, onClose, title, description, children, footer, width = 560, dismissible = true }: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const close = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);
  const ref = useFocusTrap(open, close);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="air-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="air-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        style={{ width: `min(${width}px, 100%)` }}
        ref={ref}
        tabIndex={-1}
      >
        <div className="air-dialog-head">
          <div>
            <div id={titleId} style={{ fontWeight: 650 }}>{title}</div>
            {description ? <div id={descId} className="air-hint">{description}</div> : null}
          </div>
          {dismissible ? <IconButton icon="close" label="닫기" onClick={onClose} /> : null}
        </div>
        <div className="air-dialog-body">{children}</div>
        {footer ? <div className="air-dialog-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ Drawer */

export function Drawer({ open, onClose, title, children, side = "left", footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; side?: "left" | "right"; footer?: ReactNode }) {
  const ref = useFocusTrap(open, onClose);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="air-scrim" style={{ justifyContent: side === "left" ? "flex-start" : "flex-end", padding: 0 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width: "min(320px, 88vw)", height: "100%", background: "var(--air-surface)", borderRight: side === "left" ? "1px solid var(--air-line)" : undefined, borderLeft: side === "right" ? "1px solid var(--air-line)" : undefined, display: "flex", flexDirection: "column" }}
      >
        <div className="air-dialog-head">
          <div style={{ fontWeight: 650 }}>{title}</div>
          <IconButton icon="close" label="닫기" onClick={onClose} />
        </div>
        <div className="air-scroll" style={{ flex: 1 }}>{children}</div>
        {footer ? <div style={{ flex: "none", paddingBottom: "env(safe-area-inset-bottom)" }}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ Toasts */

export type ToastTone = "neutral" | "ok" | "warn" | "danger";

export interface Toast {
  id: string;
  message: ReactNode;
  tone?: ToastTone;
  /** Milliseconds; 0 keeps it until dismissed. */
  ttl?: number;
}

interface ToastContextValue {
  push: (toast: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const push = useCallback((toast: Omit<Toast, "id"> & { id?: string }) => {
    const id = toast.id ?? `t-${Math.random().toString(36).slice(2, 9)}`;
    setToasts((prev) => [...prev.filter((t) => t.id !== id), { ...toast, id }]);
    const ttl = toast.ttl ?? 6000;
    if (ttl > 0) window.setTimeout(() => dismiss(id), ttl);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== "undefined"
        ? createPortal(
            <div className="air-toasts" aria-live="polite" aria-atomic="false">
              {toasts.map((t) => (
                <div key={t.id} className="air-toast" data-tone={t.tone ?? "neutral"} role="status">
                  <div style={{ flex: 1, minWidth: 0 }}>{t.message}</div>
                  <IconButton icon="close" label="알림 닫기" onClick={() => dismiss(t.id)} />
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

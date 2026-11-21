import { forwardRef, useId, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon, type IconName } from "./icons.js";
import { useRovingTabIndex } from "./a11y.js";

/* ------------------------------------------------------------------ Button */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  "data-testid"?: string;
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconAfter?: IconName;
  block?: boolean;
  /** Shows a busy state and blocks the duplicate submit (spec 17.3). */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon, iconAfter, block, busy, children, disabled, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      className={["air-btn", className].filter(Boolean).join(" ")}
      data-variant={variant}
      data-size={size}
      data-block={block ? "true" : undefined}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <Spinner size={13} /> : icon ? <Icon name={icon} size={size === "sm" ? 13 : 15} /> : null}
      {children}
      {iconAfter ? <Icon name={iconAfter} size={size === "sm" ? 13 : 15} /> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  icon: IconName;
  /** Required: the icon alone has no accessible name. */
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, label, title, ...rest }, ref) {
  return (
    <Button ref={ref} icon={icon} aria-label={label} title={title ?? label} variant={rest.variant ?? "ghost"} size={rest.size ?? "sm"} {...rest} />
  );
});

/* ------------------------------------------------------------------- Badge */

export type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

export interface BadgeProps {
  tone?: BadgeTone;
  shape?: "pill" | "dashed" | "solid";
  dot?: boolean;
  icon?: IconName;
  title?: string;
  children: ReactNode;
}

/** Status is a word + shape, never colour alone (spec 17.1). */
export function Badge({ tone = "neutral", shape = "pill", dot, icon, title, children }: BadgeProps) {
  return (
    <span className="air-badge" data-tone={tone} data-shape={shape} title={title}>
      {icon ? <Icon name={icon} size={11} /> : dot ? <span className="air-badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/**
 * Verification badge vocabulary from spec 17.1 / 07.3.
 * `self_declared` must never look like `provider_verified`.
 */
export type VerificationLevel = "provider_verified" | "discovery_verified" | "self_declared" | "expired" | "unknown";

const VERIFICATION: Record<VerificationLevel, { tone: BadgeTone; label: string; shape: BadgeProps["shape"]; icon: IconName }> = {
  provider_verified: { tone: "ok", label: "공급자 검증", shape: "solid", icon: "shieldHalf" },
  discovery_verified: { tone: "info", label: "발견 검증", shape: "solid", icon: "search" },
  self_declared: { tone: "warn", label: "자체 신고", shape: "dashed", icon: "user" },
  expired: { tone: "danger", label: "만료", shape: "solid", icon: "clock" },
  unknown: { tone: "neutral", label: "미검증", shape: "dashed", icon: "info" },
};

export function VerificationBadge({ level, title }: { level: VerificationLevel; title?: string }) {
  const v = VERIFICATION[level];
  return <Badge tone={v.tone} shape={v.shape} icon={v.icon} title={title}>{v.label}</Badge>;
}

export type RunState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "UNAVAILABLE" | "CANCELLED";

const RUN_TONE: Record<RunState, BadgeTone> = {
  QUEUED: "neutral",
  RUNNING: "info",
  SUCCEEDED: "ok",
  FAILED: "danger",
  BLOCKED: "warn",
  UNAVAILABLE: "neutral",
  CANCELLED: "neutral",
};

const RUN_LABEL: Record<RunState, string> = {
  QUEUED: "대기",
  RUNNING: "실행 중",
  SUCCEEDED: "성공",
  FAILED: "실패",
  BLOCKED: "차단",
  UNAVAILABLE: "데이터 없음",
  CANCELLED: "취소",
};

export function RunStateBadge({ state, title }: { state: RunState; title?: string }) {
  return (
    <Badge tone={RUN_TONE[state]} shape={state === "UNAVAILABLE" ? "dashed" : "pill"} dot title={title}>
      {state} · {RUN_LABEL[state]}
    </Badge>
  );
}

/* -------------------------------------------------------------------- Card */

export function Card({ children, pad = "none", className, as: As = "section", id, style, testId }: { children: ReactNode; pad?: "none" | "sm" | "md" | "lg"; className?: string; as?: "section" | "div" | "article" | "aside"; id?: string; style?: CSSProperties; testId?: string }) {
  return (
    <As className={["air-card", className].filter(Boolean).join(" ")} data-pad={pad === "none" ? undefined : pad} id={id} style={style} data-testid={testId}>
      {children}
    </As>
  );
}

export function SectionHeader({ title, sub, actions, id }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="air-section-head">
      <div style={{ minWidth: 0 }}>
        <div className="air-section-title" id={id}>{title}</div>
        {sub ? <div className="air-section-sub">{sub}</div> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- Forms */

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children?: ReactNode;
}

/** One field = label + control + hint + error, wired for screen readers. */
export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  return (
    <div className="air-field">
      <label className="air-label" htmlFor={htmlFor}>
        {label}
        {required ? <span aria-hidden="true" style={{ color: "var(--air-danger)" }}> *</span> : null}
      </label>
      {children}
      {hint && !error ? <div className="air-hint">{hint}</div> : null}
      {error ? (
        <div className="air-error" id={htmlFor ? `${htmlFor}-error` : undefined} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function TextInput({ invalid, className, ...rest }, ref) {
  return <input ref={ref} className={["air-input", className].filter(Boolean).join(" ")} aria-invalid={invalid || undefined} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function TextArea({ invalid, className, ...rest }, ref) {
  return <textarea ref={ref} className={["air-textarea", className].filter(Boolean).join(" ")} aria-invalid={invalid || undefined} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={["air-select", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </select>
  );
});

export function Checkbox({ label, description, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  const id = useId();
  return (
    <div className="air-check">
      <input id={rest.id ?? id} type="checkbox" {...rest} />
      <label htmlFor={rest.id ?? id}>
        {label}
        {description ? <span className="air-hint" style={{ display: "block" }}>{description}</span> : null}
      </label>
    </div>
  );
}

/* -------------------------------------------------------------------- Tabs */

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({ items, value, onChange, label }: { items: readonly TabItem[]; value: string; onChange: (id: string) => void; label: string }) {
  const index = Math.max(0, items.findIndex((i) => i.id === value));
  const roving = useRovingTabIndex({ length: items.length });

  return (
    <div className="air-tabs" role="tablist" aria-label={label} onKeyDown={(e) => {
      const key = e.key;
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(key)) return;
      e.preventDefault();
      let target = index;
      if (key === "ArrowRight") target = (index + 1) % items.length;
      if (key === "ArrowLeft") target = (index - 1 + items.length) % items.length;
      if (key === "Home") target = 0;
      if (key === "End") target = items.length - 1;
      onChange(items[target]!.id);
    }}>
      {items.map((item, i) => (
        <button
          key={item.id}
          ref={roving.setRef(i)}
          className="air-tab"
          role="tab"
          type="button"
          aria-selected={item.id === value}
          tabIndex={item.id === value ? 0 : -1}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {typeof item.count === "number" ? <span className="air-muted" style={{ marginLeft: 6, fontSize: 11 }}>{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- Misc */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="air-kbd">{children}</kbd>;
}

export function Banner({ tone = "neutral", icon, children, actions }: { tone?: "neutral" | "warn" | "danger" | "info"; icon?: IconName; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="air-banner" data-tone={tone} role={tone === "danger" ? "alert" : undefined}>
      {icon ? <Icon name={icon} size={15} style={{ flex: "none", marginTop: 1, color: tone === "danger" ? "var(--air-danger)" : tone === "warn" ? "var(--air-warn)" : tone === "info" ? "var(--air-info)" : "var(--air-text-muted)" }} /> : null}
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
      {actions ? <div style={{ display: "flex", gap: 6 }}>{actions}</div> : null}
    </div>
  );
}

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      style={{
        width: size,
        height: size,
        border: `2px solid var(--air-line-strong)`,
        borderTopColor: "var(--air-accent)",
        borderRadius: "50%",
        display: "inline-block",
        animation: "air-spin 700ms linear infinite",
        flex: "none",
      }}
    />
  );
}

export function Divider({ label }: { label?: string }) {
  if (!label) return <hr className="air-divider" />;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }} role="separator" aria-label={label}>
      <hr className="air-divider" style={{ flex: 1 }} />
      <span className="air-hint">{label}</span>
      <hr className="air-divider" style={{ flex: 1 }} />
    </div>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="air-mono" style={{ fontSize: 12 }} title={title}>{children}</span>;
}

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useReducedMotion } from "./theme.js";
import { Icon, type IconName } from "./icons.js";

/**
 * Motion primitives (product requirement: "생동감 있는 애니메이션", with
 * accessibility first). Every hook here checks `prefers-reduced-motion` and
 * degrades to an instant, still-correct result — never to a broken one.
 */

/** Eased count-up used by the 50+ metric cards. */
export function useCountUp(target: number | null, options: { duration?: number; decimals?: number } = {}): number | null {
  const reduced = useReducedMotion();
  const duration = options.duration ?? 900;
  const [value, setValue] = useState(target ?? 0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (target === null) {
      setValue(0);
      return;
    }
    if (reduced || duration <= 0) {
      setValue(target);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (target - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduced]);

  if (target === null) return null;
  const decimals = options.decimals ?? 0;
  return decimals === 0 ? Math.round(value) : Number(value.toFixed(decimals));
}

export interface RevealProps {
  children: ReactNode;
  /** "rise" = message bubble, "pop" = dialog/card, "left"/"right" = panels. */
  kind?: "rise" | "pop" | "left" | "right" | "flip";
  delay?: number;
  className?: string;
  as?: "div" | "li" | "section" | "article";
}

/** Entrance animation wrapper; content is visible even if JS never runs the animation. */
export function Reveal({ children, kind = "rise", delay = 0, className, as: As = "div" }: RevealProps) {
  const reduced = useReducedMotion();
  const style: CSSProperties = reduced ? {} : { animationDelay: `${delay}ms` };
  const anim = reduced ? "" : `air-anim-${kind}`;
  return <As className={[anim, className].filter(Boolean).join(" ")} style={style}>{children}</As>;
}

/** Container that staggers its direct children's entrance. */
export function Stagger({ children, className, as: As = "div" }: { children: ReactNode; className?: string; as?: "div" | "ul" | "section" }) {
  const reduced = useReducedMotion();
  return <As className={[reduced ? "" : "air-stagger", className].filter(Boolean).join(" ")}>{children}</As>;
}

export function Skeleton({ width = "100%", height = 12, radius = 6, style }: { width?: number | string; height?: number; radius?: number; style?: CSSProperties }) {
  return <span className="air-skeleton-line" aria-hidden="true" style={{ display: "block", width, height, borderRadius: radius, ...style }} />;
}

export function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div style={{ display: "grid", gap: 8, padding: 4 }} role="status" aria-label="불러오는 중">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={`${92 - i * 9}%`} />
      ))}
    </div>
  );
}

/** Live connection indicator: label + shape + motion, not colour alone. */
export function LiveIndicator({ state, label }: { state: "online" | "offline" | "connecting" | "error"; label?: string }) {
  const text = label ?? ({ online: "연결됨", offline: "연결 없음", connecting: "연결 중", error: "오류" } as const)[state];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: state === "error" ? "var(--air-danger)" : "var(--air-text-muted)" }}>
      <span className="air-live-dot" data-state={state} aria-hidden="true" />
      {text}
    </span>
  );
}

/** AI avatar with a real status ring (verified / thinking / offline). */
export function Avatar({ name, ring = "none", size = 32, title }: { name: string; ring?: "none" | "verified" | "thinking" | "offline"; size?: number; title?: string }) {
  const initials = Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "AI";
  return (
    <span
      className="air-avatar"
      data-ring={ring === "none" ? undefined : ring}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)), isolation: "isolate" }}
      aria-hidden="true"
      title={title ?? name}
    >
      {initials}
    </span>
  );
}

export function TypingDots({ label = "입력 중" }: { label?: string }) {
  return (
    <span className="air-typing" role="status" aria-label={label} title={label}>
      <span /><span /><span />
    </span>
  );
}

/** Card with a hover lift + optional glow sweep (approval cards, metric cards). */
export function AnimatedCard({ children, glow = false, className, testId }: { children: ReactNode; glow?: boolean; className?: string; testId?: string }) {
  return (
    <div className={["air-card", "air-hover-lift", glow ? "air-glow" : "", className].filter(Boolean).join(" ")} data-testid={testId}>
      {children}
    </div>
  );
}

export function EmptyIllustration({ icon = "sparkles", label }: { icon?: IconName; label: string }) {
  return (
    <div style={{ display: "grid", placeItems: "center", gap: 8, padding: 20 }}>
      <div style={{ width: 44, height: 44, borderRadius: 999, display: "grid", placeItems: "center", background: "var(--air-surface-2)", color: "var(--air-accent)", animation: "air-breathe 3.2s ease-in-out infinite" }}>
        <Icon name={icon} size={20} />
      </div>
      <div className="air-hint">{label}</div>
    </div>
  );
}

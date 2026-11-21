import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Spinner } from "./primitives.js";
import type { IconName } from "./icons.js";
import { Icon } from "./icons.js";

/**
 * Data states, kept apart on purpose (spec 12.3, 17.3):
 *   loading / empty / unavailable / blocked / ready
 * `unavailable` means "the source data does not exist or is not reachable" and
 * must never be rendered as 0 or as a success.
 */
export type DataState =
  | { kind: "loading"; label?: string }
  | { kind: "ready" }
  | { kind: "empty"; title: string; detail?: ReactNode; actionHref?: string; actionLabel?: string }
  | { kind: "unavailable"; title?: string; detail: ReactNode; reason?: string; retryHref?: string; retryLabel?: string }
  | { kind: "blocked"; title: string; detail: ReactNode; code?: string; action?: ReactNode }
  | { kind: "error"; title?: string; detail: ReactNode; onRetry?: () => void };

export function UnavailablePanel({
  title = "데이터 없음 (UNAVAILABLE)",
  detail,
  reason,
  onRetry,
  retryLabel = "다시 확인",
}: {
  title?: string;
  detail: ReactNode;
  reason?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div style={{ display: "grid", gap: 8, padding: "18px 16px", justifyItems: "start", border: "1px dashed var(--air-line-strong)", borderRadius: 12, background: "var(--air-surface)" }}>
      <Badge tone="neutral" shape="dashed" icon="info">{title}</Badge>
      <div style={{ fontSize: 12.5, color: "var(--air-text-muted)", maxWidth: 620 }}>{detail}</div>
      {reason ? <div className="air-hint" style={{ fontFamily: "var(--air-font-mono)" }}>{reason}</div> : null}
      {onRetry ? <Button size="sm" icon="refresh" onClick={onRetry}>{retryLabel}</Button> : null}
    </div>
  );
}

export function EmptyState({ icon = "sparkles", title, detail, action }: { icon?: IconName; title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8, padding: "28px 16px", justifyItems: "center", textAlign: "center" }}>
      <div style={{ color: "var(--air-text-muted)", display: "grid", placeItems: "center", width: 36, height: 36, borderRadius: 999, background: "var(--air-surface-2)" }}>
        <Icon name={icon} size={17} />
      </div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {detail ? <div className="air-hint" style={{ maxWidth: 460 }}>{detail}</div> : null}
      {action}
    </div>
  );
}

export function LoadingRows({ rows = 3, label = "불러오는 중" }: { rows?: number; label?: string }) {
  return (
    <div style={{ display: "grid", gap: 8, padding: 16 }} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ height: 14, width: `${88 - i * 12}%`, borderRadius: 6, background: "var(--air-surface-2)", animation: "air-fade 900ms ease-in-out infinite alternate" }} />
      ))}
    </div>
  );
}

/** Renders one of the states above; `children` is shown only when ready. */
export function StateView({ state, children }: { state: DataState; children: ReactNode }) {
  switch (state.kind) {
    case "loading":
      return <LoadingRows label={state.label} />;
    case "ready":
      return <>{children}</>;
    case "empty":
      return <EmptyState title={state.title} detail={state.detail} action={state.actionHref ? <a className="air-btn" data-size="sm" href={state.actionHref}>{state.actionLabel ?? "열기"}</a> : undefined} />;
    case "unavailable":
      return <UnavailablePanel title={state.title} detail={state.detail} reason={state.reason} />;
    case "blocked":
      return (
        <div style={{ display: "grid", gap: 8, padding: "18px 16px", border: "1px solid color-mix(in srgb, var(--air-warn) 45%, var(--air-line))", borderRadius: 12, background: "color-mix(in srgb, var(--air-warn) 7%, var(--air-surface))" }}>
          <Badge tone="warn" icon="lock">{state.code ?? "BLOCKED"}</Badge>
          <div style={{ fontWeight: 600 }}>{state.title}</div>
          <div style={{ fontSize: 12.5, color: "var(--air-text-muted)" }}>{state.detail}</div>
          {state.action}
        </div>
      );
    case "error":
      return (
        <div style={{ display: "grid", gap: 8, padding: "18px 16px", border: "1px solid color-mix(in srgb, var(--air-danger) 45%, var(--air-line))", borderRadius: 12 }} role="alert">
          <Badge tone="danger" icon="warning">{state.title ?? "오류"}</Badge>
          <div style={{ fontSize: 12.5 }}>{state.detail}</div>
          {state.onRetry ? <Button size="sm" icon="refresh" onClick={state.onRetry}>다시 시도</Button> : null}
        </div>
      );
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ metrics */

export interface MetricSource {
  /** Where the number came from, e.g. "D1 tasks (query ts=…)". */
  evidence: string;
  observedAt?: string;
  scope?: string;
}

export interface MetricCardProps {
  id: string;
  label: string;
  /** `null` renders UNAVAILABLE — never 0 (spec 12.3). */
  value: number | string | null;
  unit?: string;
  source?: MetricSource;
  unavailableReason?: string;
  trend?: "up" | "down" | "flat";
  hint?: string;
}

export function MetricCard({ id, label, value, unit, source, unavailableReason, trend, hint }: MetricCardProps) {
  const unavailable = value === null;
  return (
    <div className="air-card" data-pad="sm" style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span className="air-hint air-truncate" title={label}>{label}</span>
        <span className="air-hint air-mono" aria-hidden="true">{id}</span>
      </div>
      {unavailable ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Badge tone="neutral" shape="dashed">UNAVAILABLE</Badge>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.01em" }}>{value}</span>
          {unit ? <span className="air-hint">{unit}</span> : null}
          {trend ? <Icon name={trend === "up" ? "chevron" : trend === "down" ? "chevronDown" : "hash"} size={12} style={{ color: "var(--air-text-muted)", transform: trend === "up" ? "rotate(-90deg)" : "none" }} /> : null}
        </div>
      )}
      <div className="air-hint air-truncate" title={unavailable ? unavailableReason : source?.evidence}>
        {unavailable ? unavailableReason ?? "소스 데이터 없음" : source?.evidence}
      </div>
      {hint ? <div className="air-hint" style={{ opacity: 0.85 }}>{hint}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- progress */

/** Verified-only progress: the caller must pass counted evidence, not claims. */
export function ProgressBar({ value, max = 100, label, detail }: { value: number; max?: number; label: string; detail?: string }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div style={{ display: "grid", gap: 4 }} role="group" aria-label={label}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
        <span className="air-muted">{label}</span>
        <span className="air-mono">{value}/{max}</span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: "var(--air-surface-2)", overflow: "hidden" }} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--air-accent)", transition: "width 200ms var(--air-ease)" }} />
      </div>
      {detail ? <div className="air-hint">{detail}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------- table */

export interface Column<T> {
  key: string;
  header: string;
  width?: number | string;
  align?: "left" | "right" | "center";
  render: (row: T) => ReactNode;
  /** Sortable tables sort real values, not rendered strings. */
  sortValue?: (row: T) => string | number;
}

export function DataTable<T>({ columns, rows, getRowKey, caption, emptyLabel = "표시할 행이 없습니다", onRowClick, selectedKey }: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  getRowKey: (row: T) => string;
  caption: string;
  emptyLabel?: string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
}) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * (sort.dir === "asc" ? 1 : -1);
    });
    return copy;
  }, [rows, sort, columns]);

  return (
    <div className="air-scroll" style={{ maxWidth: "100%" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }} aria-label={caption}>
        <caption className="air-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                style={{ textAlign: col.align ?? "left", padding: "8px 10px", borderBottom: "1px solid var(--air-line)", whiteSpace: "nowrap", width: col.width, fontWeight: 600, color: "var(--air-text-muted)", position: "sticky", top: 0, background: "var(--air-surface)" }}
                aria-sort={sort?.key === col.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
              >
                {col.sortValue ? (
                  <button
                    type="button"
                    className="air-btn"
                    data-variant="ghost"
                    data-size="sm"
                    style={{ padding: 0, minHeight: 0, fontWeight: 600, color: "inherit" }}
                    onClick={() => setSort((prev) => (prev?.key === col.key ? { key: col.key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: "asc" }))}
                  >
                    {col.header}
                    {sort?.key === col.key ? <span aria-hidden="true">{sort.dir === "asc" ? " ↑" : " ↓"}</span> : null}
                  </button>
                ) : col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: 16, textAlign: "center", color: "var(--air-text-muted)" }}>{emptyLabel}</td>
            </tr>
          ) : sorted.map((row) => {
            const key = getRowKey(row);
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{ background: key === selectedKey ? "var(--air-accent-soft)" : undefined, cursor: onRowClick ? "pointer" : undefined }}
              >
                {columns.map((col) => (
                  <td key={col.key} style={{ padding: "7px 10px", borderBottom: "1px solid var(--air-line)", textAlign: col.align ?? "left", verticalAlign: "top" }}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------- virtual list */

/**
 * Windowed list for large messages / logs / file trees (spec 17.1).
 * Fixed row height keeps it dependency-free and honest about what is rendered.
 */
export function VirtualList<T>({ items, rowHeight, height, render, getKey, overscan = 6, label }: {
  items: readonly T[];
  rowHeight: number;
  height: number;
  render: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string;
  overscan?: number;
  label: string;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const total = items.length * rowHeight;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.max(1, Math.ceil(height / rowHeight)) + overscan * 2;
  const end = Math.min(items.length, start + visible);
  const slice = items.slice(start, end);

  useEffect(() => {
    // keep scroll offset valid when the list shrinks (e.g. filtered logs)
    if (scrollTop > total) setScrollTop(Math.max(0, total - rowHeight));
  }, [total, rowHeight, scrollTop]);

  return (
    <div
      ref={ref}
      className="air-scroll"
      style={{ height, position: "relative", overflowY: "auto" }}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      role="list"
      aria-label={label}
      aria-rowcount={items.length}
    >
      <div style={{ height: total, position: "relative" }}>
        {slice.map((item, i) => {
          const index = start + i;
          return (
            <div key={getKey(item, index)} role="listitem" style={{ position: "absolute", top: index * rowHeight, left: 0, right: 0, height: rowHeight, overflow: "hidden" }}>
              {render(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LiveSpinner({ label }: { label: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--air-text-muted)" }}>
      <Spinner size={12} /> {label}
    </span>
  );
}

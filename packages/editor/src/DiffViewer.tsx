import { useMemo, useState } from "react";
import { Badge, Button, Icon } from "@ai-room/design-system";
import { parseUnifiedDiff, type DiffRow } from "@ai-room/message-blocks";

export interface DiffAnchor {
  path: string;
  side: "new" | "old";
  line: number;
}

export interface DiffViewerProps {
  diff: string;
  /** Comment affordance is only offered for rows that exist in the patch. */
  onComment?: (anchor: DiffAnchor) => void;
  /** Highlight a row that an existing comment points at. */
  anchor?: DiffAnchor | null;
  maxRows?: number;
  emptyLabel?: string;
}

/**
 * Git diff viewer (spec 13.4).
 *
 * Reads the unified diff exactly as returned by the API: no reconstruction from
 * file contents, no invented line numbers. Truncation is stated, not hidden.
 */
export function DiffViewer({ diff, onComment, anchor, maxRows = 300, emptyLabel = "표시할 변경이 없습니다" }: DiffViewerProps) {
  const parsed = useMemo(() => parseUnifiedDiff(diff, { maxRows }), [diff, maxRows]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  if (!diff.trim()) {
    return (
      <div className="air-card" data-pad="md" style={{ borderStyle: "dashed" }}>
        <span className="air-hint">{emptyLabel}</span>
      </div>
    );
  }

  const files = groupByFile(parsed.rows);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Badge tone="ok" icon="check">+{parsed.stats.additions}</Badge>
        <Badge tone="danger" icon="x">−{parsed.stats.deletions}</Badge>
        <span className="air-hint">{parsed.stats.files}개 파일 · {parsed.stats.hunks} hunks</span>
        {parsed.stats.truncated ? <Badge tone="warn" shape="dashed">잘림 ({maxRows}행)</Badge> : null}
        {files.length > 1 ? (
          <Button size="sm" variant="ghost" icon="columns" onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(files.map((f) => f.path ?? "unknown")))}>
            {collapsed.size ? "모두 펼치기" : "모두 접기"}
          </Button>
        ) : null}
      </div>

      {files.map((file) => {
        const isCollapsed = collapsed.has(file.path ?? "unknown");
        const fileStats = file.rows.reduce(
          (acc, row) => ({ add: acc.add + (row.kind === "add" ? 1 : 0), del: acc.del + (row.kind === "del" ? 1 : 0) }),
          { add: 0, del: 0 },
        );
        return (
          <section key={file.path ?? "unknown"} className="air-card" style={{ overflow: "hidden", background: "var(--air-bg)" }}>
            <header
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--air-line)", background: "var(--air-surface)", cursor: "pointer" }}
              onClick={() => {
                const next = new Set(collapsed);
                if (next.has(file.path ?? "unknown")) next.delete(file.path ?? "unknown");
                else next.add(file.path ?? "unknown");
                setCollapsed(next);
              }}
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  const next = new Set(collapsed);
                  if (next.has(file.path ?? "unknown")) next.delete(file.path ?? "unknown");
                  else next.add(file.path ?? "unknown");
                  setCollapsed(next);
                }
              }}
            >
              <Icon name="chevronDown" size={12} style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform 180ms var(--air-ease)" }} />
              <span className="air-mono" style={{ fontSize: 12 }}>{file.path ?? "경로 미상"}</span>
              <span style={{ flex: 1 }} />
              <span className="air-mono" style={{ fontSize: 11, color: "var(--air-ok)" }}>+{fileStats.add}</span>
              <span className="air-mono" style={{ fontSize: 11, color: "var(--air-danger)" }}>−{fileStats.del}</span>
            </header>
            {!isCollapsed ? (
              <div className="air-scroll" style={{ maxHeight: 360 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--air-font-mono)" }} aria-label={`${file.path ?? "파일"} 변경`}>
                  <tbody>
                    {file.rows.map((row, index) => (
                      <DiffRowView key={`${row.kind}-${row.oldNo}-${row.newNo}-${index}`} row={row} anchor={anchor} onComment={onComment} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function DiffRowView({ row, anchor, onComment }: { row: DiffRow; anchor?: DiffAnchor | null; onComment?: (a: DiffAnchor) => void }) {
  if (row.kind === "hunk" || row.kind === "meta" || row.kind === "note" || row.kind === "file") {
    return (
      <tr>
        <td colSpan={4} style={{ padding: "3px 10px", color: "var(--air-text-muted)", background: "var(--air-surface-2)", borderBottom: "1px solid var(--air-line)", fontSize: 11 }}>
          {row.text}
        </td>
      </tr>
    );
  }
  const anchored = anchor && row.path === anchor.path && (anchor.side === "old" ? row.oldNo : row.newNo) === anchor.line;
  const background = row.kind === "add" ? "var(--air-add-bg)" : row.kind === "del" ? "var(--air-del-bg)" : undefined;
  const color = row.kind === "add" ? "var(--air-add-ink)" : row.kind === "del" ? "var(--air-del-ink)" : "var(--air-text)";
  const canComment = Boolean(onComment) && (row.kind === "add" || row.kind === "ctx" || row.kind === "del");

  return (
    <tr className="air-diff-row" style={{ background: anchored ? "var(--air-accent-soft)" : background, outline: anchored ? "2px solid var(--air-accent)" : undefined }}>
      <td style={{ width: 34, textAlign: "right", padding: "0 6px", color: "var(--air-text-muted)", userSelect: "none", fontSize: 10.5 }} aria-hidden="true">{row.oldNo ?? ""}</td>
      <td style={{ width: 34, textAlign: "right", padding: "0 6px", color: "var(--air-text-muted)", userSelect: "none", fontSize: 10.5 }} aria-hidden="true">{row.newNo ?? ""}</td>
      <td style={{ padding: "0 8px", color, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{row.text || "\u00a0"}</td>
      <td style={{ width: 30, padding: 0 }}>
        {canComment ? (
          <button
            type="button"
            data-testid="diff-line-comment"
            aria-label={`${row.path ?? "파일"} ${row.newNo ?? row.oldNo}행에 코멘트`}
            title="줄 코멘트"
            className="air-btn"
            data-variant="ghost"
            data-size="sm"
            style={{ minHeight: 18, padding: "0 4px", opacity: 0.7 }}
            onClick={() => onComment?.({ path: row.path ?? "", side: row.kind === "del" ? "old" : "new", line: row.kind === "del" ? row.oldNo ?? 0 : row.newNo ?? 0 })}
          >
            +
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function groupByFile(rows: DiffRow[]): Array<{ path: string | null; rows: DiffRow[] }> {
  const groups: Array<{ path: string | null; rows: DiffRow[] }> = [];
  for (const row of rows) {
    if (row.kind === "file" || groups.length === 0 || groups[groups.length - 1]!.path !== row.path) {
      groups.push({ path: row.path, rows: row.kind === "file" ? [] : [row] });
      continue;
    }
    groups[groups.length - 1]!.rows.push(row);
  }
  return groups.filter((g) => g.rows.length > 0 || groups.length === 1);
}

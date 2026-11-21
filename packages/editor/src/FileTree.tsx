import { useMemo, useRef, useState } from "react";
import { Badge, Icon, TextInput } from "@ai-room/design-system";

export interface TreeNode {
  /** Repo-relative POSIX path. Used as the identity — never a display name. */
  path: string;
  name: string;
  type: "dir" | "file";
  children?: TreeNode[];
  /** Git status for this path (as reported by the API, not guessed). */
  status?: "added" | "modified" | "deleted" | "untracked";
  size?: number;
}

interface FlatRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

function flatten(nodes: readonly TreeNode[], expanded: Set<string>, depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const node of nodes) {
    const isExpanded = expanded.has(node.path);
    out.push({ node, depth, expanded: isExpanded });
    if (node.type === "dir" && isExpanded && node.children) flatten(node.children, expanded, depth + 1, out);
  }
  return out;
}

const STATUS_DOT: Record<string, { color: string; label: string }> = {
  added: { color: "var(--air-ok)", label: "추가됨" },
  modified: { color: "var(--air-warn)", label: "수정됨" },
  deleted: { color: "var(--air-danger)", label: "삭제됨" },
  untracked: { color: "var(--air-info)", label: "추적 안 됨" },
};

/**
 * Accessible repository file tree (spec 13.1 / 17.3).
 * Keyboard: ↑↓ move, → expand, ← collapse, Enter open, type to filter.
 * Only paths that the API returned are shown — the tree never invents files.
 */
export function FileTree({
  nodes,
  activePath,
  onOpen,
  height = 360,
  title = "파일",
}: {
  nodes: readonly TreeNode[];
  activePath?: string | null;
  onOpen: (node: TreeNode) => void;
  height?: number;
  title?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["src"]));
  const [filter, setFilter] = useState("");
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    if (!filter.trim()) return nodes;
    const q = filter.toLowerCase();
    const prune = (list: readonly TreeNode[]): TreeNode[] =>
      list.flatMap((node) => {
        if (node.type === "file") return node.path.toLowerCase().includes(q) ? [node] : [];
        const children = node.children ? prune(node.children) : [];
        return children.length > 0 || node.path.toLowerCase().includes(q) ? [{ ...node, children }] : [];
      });
    return prune(nodes);
  }, [nodes, filter]);

  const rows = useMemo(() => flatten(filtered, filter ? new Set(collectDirs(filtered)) : expanded), [filtered, expanded, filter]);

  const toggle = (node: TreeNode) => {
    if (node.type !== "dir") return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const row = rows[Math.min(focusIndex, rows.length - 1)];
    if (!row) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.node.type === "dir" && !row.expanded) toggle(row.node);
      else if (row.node.type === "dir") setFocusIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.node.type === "dir" && row.expanded) toggle(row.node);
      else {
        const parentIndex = [...rows].reverse().findIndex((r, idx) => idx < rows.length - 1 - focusIndex && r.depth < row.depth);
        if (parentIndex >= 0) setFocusIndex(rows.length - 1 - parentIndex);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (row.node.type === "dir") toggle(row.node);
      else onOpen(row.node);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height, border: "1px solid var(--air-line)", borderRadius: 10, overflow: "hidden", background: "var(--air-surface)" }}>
      <div style={{ padding: 8, borderBottom: "1px solid var(--air-line)", display: "grid", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="air-section-title">{title}</span>
          <Badge tone="neutral">{countFiles(nodes)}개 파일</Badge>
        </div>
        <TextInput
          aria-label="파일 필터"
          placeholder="경로 필터…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setFocusIndex(0);
          }}
          style={{ fontSize: 12 }}
        />
      </div>
      <div
        ref={listRef}
        className="air-scroll"
        role="tree"
        aria-label="저장소 파일 트리"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => listRef.current?.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`)?.focus()}
        style={{ padding: 6 }}
      >
        {rows.length === 0 ? <div className="air-hint" style={{ padding: 8 }}>{filter ? "일치하는 파일이 없습니다" : "파일 목록 없음(서버 미연결 또는 빈 저장소)"}</div> : null}
        {rows.map((row, index) => {
          const isActive = row.node.path === activePath;
          const status = row.node.status ? STATUS_DOT[row.node.status] : null;
          return (
            <div
              key={row.node.path}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.node.type === "dir" ? row.expanded : undefined}
              aria-selected={isActive}
              data-index={index}
              tabIndex={index === focusIndex ? 0 : -1}
              className="air-tree-link"
              onFocus={() => setFocusIndex(index)}
              onClick={() => (row.node.type === "dir" ? toggle(row.node) : onOpen(row.node))}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 6px",
                paddingLeft: 6 + row.depth * 12,
                cursor: "pointer",
                background: isActive ? "var(--air-accent-soft)" : undefined,
                borderRadius: 6,
                fontSize: 12.5,
                border: "1px solid transparent",
                borderColor: isActive ? "color-mix(in srgb, var(--air-accent) 35%, transparent)" : "transparent",
                animation: "air-tree-open 160ms var(--air-ease) both",
              }}
            >
              <Icon name={row.node.type === "dir" ? "chevronDown" : "file"} size={12} style={{ opacity: row.node.type === "dir" && !row.expanded ? 0.45 : 0.8, transform: row.node.type === "dir" && !row.expanded ? "rotate(-90deg)" : "none", transition: "transform 160ms var(--air-ease)" }} />
              <span className="air-truncate" style={{ flex: 1 }}>{row.node.name}</span>
              {status ? (
                <span title={status.label} aria-label={status.label} style={{ width: 7, height: 7, borderRadius: 999, background: status.color, flex: "none" }} />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function collectDirs(nodes: readonly TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === "dir") {
      out.push(node.path);
      if (node.children) collectDirs(node.children, out);
    }
  }
  return out;
}

function countFiles(nodes: readonly TreeNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.type === "file" ? 1 : node.children ? countFiles(node.children) : 0), 0);
}

import { useMemo, useState } from "react";
import { Badge, Button, Card, Dialog, Icon, ProgressBar, Reveal } from "@ai-room/design-system";
import type { ApprovalDto, OwnerSessionDto, TaskDto } from "../api/types.js";

/* -------------------------------------------------------------------- kanban */

const COLUMNS: Array<{ id: TaskDto["status"]; label: string }> = [
  { id: "TODO", label: "대기" },
  { id: "READY", label: "준비" },
  { id: "RUNNING", label: "진행" },
  { id: "REVIEW", label: "리뷰" },
  { id: "DONE", label: "완료" },
  { id: "BLOCKED", label: "차단" },
];

export interface KanbanProps {
  tasks: readonly TaskDto[];
  onMove?: (task: TaskDto, status: TaskDto["status"]) => void;
  onReassign?: (task: TaskDto, agentId: string) => void;
  agents?: Array<{ agent_id: string; display_name: string }>;
  readOnly?: boolean;
}

/**
 * Task board with lease/risk emphasis (spec 12.2).
 * Drag & drop is a convenience over the same `onMove` call the buttons use, so
 * keyboard users can move a task without a mouse.
 */
export function Kanban({ tasks, onMove, onReassign, agents = [], readOnly }: KanbanProps) {
  const [dragging, setDragging] = useState<TaskDto | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [reassign, setReassign] = useState<TaskDto | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, TaskDto[]>();
    for (const col of COLUMNS) map.set(col.id, []);
    for (const task of tasks) {
      const list = map.get(task.status) ?? map.get("TODO")!;
      list.push(task);
    }
    return map;
  }, [tasks]);

  return (
    <>
      <div className="air-kanban" role="list" aria-label="작업 칸반">
        {COLUMNS.map((col) => {
          const items = grouped.get(col.id) ?? [];
          return (
            <section
              key={col.id}
              className="air-kanban-col"
              data-over={over === col.id || undefined}
              onDragOver={(e) => {
                if (readOnly) return;
                e.preventDefault();
                setOver(col.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (dragging && dragging.status !== col.id) onMove?.(dragging, col.id);
                setDragging(null);
              }}
              aria-label={`${col.label} ${items.length}개`}
            >
              <header className="air-kanban-col-head">
                <span>{col.label}</span>
                <Badge tone="neutral">{items.length}</Badge>
                <span style={{ flex: 1 }} />
                <span className="air-hint air-mono">{col.id}</span>
              </header>
              <div className="air-kanban-list">
                {items.length === 0 ? <span className="air-hint" style={{ padding: 6 }}>비어 있음</span> : null}
                {items.map((task, index) => (
                  <Reveal as="article" kind="rise" delay={index * 30} key={task.task_id}>
                    <div
                      className="air-task"
                      draggable={!readOnly}
                      onDragStart={() => setDragging(task)}
                      data-risk={task.risk_level}
                      data-leased={Boolean(task.lease_expires_at)}
                      tabIndex={0}
                      aria-label={`${task.title} · ${task.status}`}
                    >
                      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{task.title}</span>
                        <span className="air-mono air-hint">{task.task_id}</span>
                      </div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                        {task.owner_agent_id ? <Badge tone="info" icon="user">{task.owner_agent_id.replace("agent-", "")}</Badge> : <Badge tone="warn" shape="dashed">담당 미배정</Badge>}
                        {task.risk_level === "high" ? <Badge tone="danger">위험 높음</Badge> : null}
                        {task.lease_expires_at ? <Badge tone="neutral" icon="clock">lease</Badge> : null}
                        {task.dependencies && task.dependencies.length > 0 ? <Badge tone="neutral" icon="graph">선행 {task.dependencies.length}</Badge> : null}
                        {task.retry_count ? <Badge tone="danger">재시도 {task.retry_count}</Badge> : null}
                      </div>
                      {!readOnly ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          <select
                            aria-label={`${task.title} 상태 변경`}
                            className="air-select"
                            style={{ fontSize: 11, padding: "2px 6px", width: "auto" }}
                            value={task.status}
                            onChange={(e) => onMove?.(task, e.target.value as TaskDto["status"])}
                          >
                            {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                            <option value="FAILED">실패</option>
                          </select>
                          <Button size="sm" variant="ghost" icon="user" onClick={() => setReassign(task)} data-testid="task-reassign-suggest">담당 변경 제안</Button>
                        </div>
                      ) : null}
                      {task.evidence && task.evidence.length > 0 ? (
                        <div className="air-hint">증거 {task.evidence.length}건 · {task.evidence[0]!.label}</div>
                      ) : task.status === "DONE" ? (
                        <div className="air-hint" style={{ color: "var(--air-warn)" }}>증거 없음 — 실검증 완료로 집계되지 않습니다</div>
                      ) : null}
                    </div>
                  </Reveal>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <Dialog open={Boolean(reassign)} onClose={() => setReassign(null)} title="담당자 변경 제안" description="제안은 승인/댓글로 기록되며, 즉시 권한이 바뀌지 않습니다.">
        {reassign ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div className="air-hint">{reassign.task_id} · {reassign.title}</div>
            {agents.length === 0 ? <span className="air-hint">등록된 AI가 없습니다.</span> : null}
            {agents.map((agent) => (
              <div key={agent.agent_id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="air-avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{agent.display_name.slice(0, 1)}</span>
                <span style={{ flex: 1 }}>{agent.display_name}</span>
                <Button
                  size="sm"
                  onClick={() => {
                    onReassign?.(reassign, agent.agent_id);
                    setReassign(null);
                  }}
                >
                  제안
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/* --------------------------------------------------------------- dependency */

export interface DependencyNode {
  task_id: string;
  title: string;
  status: TaskDto["status"];
  depends_on: string[];
}

/** Cycles are detected here as well as server-side: a cycle is a data bug, not a UI state. */
export function findCycles(nodes: readonly DependencyNode[]): string[][] {
  const byId = new Map(nodes.map((n) => [n.task_id, n]));
  const state = new Map<string, 0 | 1 | 2>();
  const cycles: string[][] = [];
  const stack: string[] = [];

  const visit = (id: string) => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) if (byId.has(dep)) visit(dep);
    stack.pop();
    state.set(id, 2);
  };
  for (const node of nodes) visit(node.task_id);
  return cycles;
}

export function DependencyGraph({ nodes }: { nodes: readonly DependencyNode[] }) {
  const cycles = useMemo(() => findCycles(nodes), [nodes]);
  const levels = useMemo(() => {
    const level = new Map<string, number>();
    const byId = new Map(nodes.map((n) => [n.task_id, n]));
    const resolve = (id: string, seen: Set<string>): number => {
      if (level.has(id)) return level.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const deps = (byId.get(id)?.depends_on ?? []).filter((d) => byId.has(d));
      const value = deps.length === 0 ? 0 : Math.max(...deps.map((d) => resolve(d, seen) + 1));
      level.set(id, value);
      return value;
    };
    for (const node of nodes) resolve(node.task_id, new Set());
    return level;
  }, [nodes]);

  const columns = useMemo(() => {
    const max = Math.max(0, ...levels.values());
    return Array.from({ length: max + 1 }, (_, i) => nodes.filter((n) => (levels.get(n.task_id) ?? 0) === i));
  }, [levels, nodes]);

  const width = Math.max(320, columns.length * 210);
  const height = Math.max(120, Math.max(...columns.map((c) => c.length), 1) * 74);

  return (
    <div style={{ display: "grid", gap: 8 }} data-testid="dependency-graph">
      {cycles.length > 0 ? (
        <div className="air-banner" data-tone="danger" role="alert">
          <Icon name="warning" size={14} style={{ color: "var(--air-danger)" }} />
          <div>순환 의존 감지: {cycles.map((c) => c.join(" → ")).join(" / ")}</div>
        </div>
      ) : null}
      <div className="air-graph" style={{ padding: 12 }}>
        <svg width={width} height={height} role="img" aria-label="작업 의존성 그래프">
          <defs>
            <marker id="dep-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--air-line-strong)" />
            </marker>
          </defs>
          {columns.map((col, ci) =>
            col.map((node, ri) => {
              const x = ci * 210 + 10;
              const y = ri * 74 + 10;
              return (
                <g key={node.task_id} className="air-graph-node">
                  <rect x={x} y={y} width={186} height={56} rx={10} />
                  <text x={x + 10} y={y + 21} style={{ fontSize: 11, fill: "var(--air-text)" }}>{truncate(node.title, 24)}</text>
                  <text x={x + 10} y={y + 40} style={{ fontSize: 9.5, fill: "var(--air-text-muted)" }}>{node.task_id} · {node.status}</text>
                </g>
              );
            }),
          )}
          {columns.map((col, ci) =>
            col.flatMap((node, ri) => {
              const x = ci * 210 + 10;
              const y = ri * 74 + 10;
              return node.depends_on.map((dep) => {
                const depColIndex = columns.findIndex((c) => c.some((n) => n.task_id === dep));
                const depRowIndex = columns[depColIndex]?.findIndex((n) => n.task_id === dep) ?? -1;
                if (depColIndex < 0 || depRowIndex < 0) return null;
                const dx = depColIndex * 210 + 10;
                const dy = depRowIndex * 74 + 10;
                return (
                  <line
                    key={`${dep}->${node.task_id}`}
                    x1={dx + 186}
                    y1={dy + 28}
                    x2={x - 2}
                    y2={y + 28}
                    stroke="var(--air-line-strong)"
                    strokeWidth={1.2}
                    markerEnd="url(#dep-arrow)"
                  />
                );
              });
            }),
          )}
        </svg>
      </div>
      <div className="air-hint">{nodes.length}개 노드 · {nodes.reduce((s, n) => s + n.depends_on.length, 0)}개 간선 · 레벨 {columns.length}</div>
    </div>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/* ---------------------------------------------------------------- approval */

export function ApprovalCard({
  approval,
  session,
  onDecide,
  now = Date.now(),
}: {
  approval: ApprovalDto;
  session?: OwnerSessionDto | null;
  onDecide?: (approval: ApprovalDto, decision: "approve" | "reject", sha: string) => void;
  now?: number;
}) {
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const expiresIn = approval.expires_at ? new Date(approval.expires_at).getTime() - now : null;
  const expired = expiresIn !== null && expiresIn < 0;
  const pending = approval.status === "pending" && !expired;

  return (
    <Reveal as="article" kind="pop" delay={40}>
      <Card pad="md" className="air-hover-lift" as="article">
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <Badge tone={approval.risk === "high" ? "danger" : approval.risk === "medium" ? "warn" : "neutral"} icon="warning">
            위험 {approval.risk}
          </Badge>
          <Badge tone={approval.status === "approved" ? "ok" : approval.status === "rejected" ? "danger" : expired ? "warn" : "info"}>
            {approval.status === "pending" && expired ? "만료됨" : approval.status}
          </Badge>
          <span className="air-mono air-hint">{approval.approval_id}</span>
          <span style={{ flex: 1 }} />
          <span className="air-hint">{approval.requested_by} · {new Date(approval.requested_at).toLocaleString()}</span>
        </div>
        <div style={{ fontWeight: 650, marginTop: 6 }}>{approval.action}</div>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, color: "var(--air-text-muted)" }}>
          {approval.impact.map((impact) => <li key={impact}>{impact}</li>)}
        </ul>
        {approval.action_sha256 ? (
          <div style={{ marginTop: 8 }}>
            <div className="air-hint">작업 해시 (승인 대상)</div>
            <code className="air-code-inline" style={{ wordBreak: "break-all" }}>{approval.action_sha256}</code>
          </div>
        ) : (
          <div className="air-hint" style={{ marginTop: 8, color: "var(--air-warn)" }}>작업 해시 없음 — 내용이 바뀌어도 감지할 수 없습니다</div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          {pending ? (
            <>
              <Button size="sm" variant="primary" icon="check" onClick={() => setOpen(true)}>승인…</Button>
              <Button size="sm" variant="danger" icon="x" onClick={() => onDecide?.(approval, "reject", approval.action_sha256 ?? "")}>거절</Button>
            </>
          ) : (
            <span className="air-hint">{approval.decided_by ? `${approval.decided_by} 결정 · ${approval.decided_at}` : "결정 정보 없음"}</span>
          )}
          {expiresIn !== null ? (
            <span className="air-hint">{expired ? "만료됨" : `만료까지 ${Math.max(0, Math.round(expiresIn / 60000))}분`}</span>
          ) : null}
        </div>
      </Card>

      <Dialog
        open={open}
        onClose={() => { setOpen(false); setAck(false); }}
        title="승인 확인"
        description="승인은 되돌릴 수 없습니다. 대상 해시를 확인하세요."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>취소</Button>
            <Button
              variant="primary"
              icon="check"
              disabled={!ack || !approval.action_sha256 || !onDecide}
              onClick={() => {
                onDecide?.(approval, "approve", approval.action_sha256 ?? "");
                setOpen(false);
                setAck(false);
              }}
            >
              승인 확정
            </Button>
          </>
        }
      >
        <div style={{ display: "grid", gap: 10 }}>
          <div>{approval.action}</div>
          <div className="air-hint">승인자 {session?.display_name ?? "현재 세션"} · 대상 {approval.action_sha256?.slice(0, 16) ?? "해시 없음"}</div>
          <label className="air-check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>영향 범위를 확인했고, 이 해시에 대해 승인합니다.</span>
          </label>
          {approval.action_sha256 ? null : <div className="air-error">작업 해시가 없어 승인할 수 없습니다.</div>}
        </div>
      </Dialog>
    </Reveal>
  );
}

export function VerifiedProgress({ done, total, blocked }: { done: number; total: number; blocked?: number }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <ProgressBar value={done} max={total} label="검증 완료 요구사항" detail={blocked ? `차단 ${blocked}건` : "차단 없음"} />
    </div>
  );
}

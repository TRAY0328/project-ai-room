import { useState } from "react";
import { Badge, Banner, Button, Card, EmptyState, Icon, RunStateBadge, SectionHeader, Tabs, VirtualList, type RunState } from "@ai-room/design-system";

export interface CiArtifact {
  name: string;
  size: number;
  sha256: string | null;
  downloadUrl?: string;
  hashStatus?: "verified" | "unverified" | "mismatch";
}

export interface CiJob {
  id: string;
  name: string;
  status: RunState;
  conclusion: string | null;
  steps?: Array<{ name: string; status: RunState }>;
  logs: string[];
  artifacts: CiArtifact[];
}

export interface CiRun {
  id: string;
  workflow: string;
  event: string;
  headSha: string;
  status: RunState;
  conclusion: string | null;
  createdAt: string;
  durationMs: number | null;
  url?: string;
  jobs: CiJob[];
}

export interface CIPanelProps {
  runs: readonly CiRun[];
  /** True only when the API confirmed write permission for dispatch/rerun. */
  canWrite?: boolean;
  onDispatch?: (workflow: string) => void;
  onRerun?: (runId: string) => void;
  onCancel?: (runId: string) => void;
  workflows?: readonly string[];
}

/**
 * Build/test panel (spec 14.2, 13.5).
 * A run with no conclusion is not a success. A log that is not streamed is
 * labelled as a snapshot. Rerun/cancel exist only with confirmed permission.
 */
export function CIPanel({ runs, canWrite = false, onDispatch, onRerun, onCancel, workflows = ["verify.yml", "build-web.yml", "security.yml"] }: CIPanelProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runs[0]?.id ?? null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(runs[0]?.jobs[0]?.id ?? null);
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;
  const selectedJob = selectedRun?.jobs.find((j) => j.id === selectedJobId) ?? selectedRun?.jobs[0] ?? null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card>
        <SectionHeader
          title="빌드 · 테스트"
          sub="GitHub Actions 실제 실행 기록만 표시합니다"
          actions={
            canWrite ? (
              <div style={{ display: "flex", gap: 6 }}>
                {workflows.map((wf) => (
                  <Button key={wf} size="sm" icon="play" onClick={() => onDispatch?.(wf)}>{wf}</Button>
                ))}
              </div>
            ) : (
              <Badge tone="neutral" shape="dashed" icon="lock">실행 권한 미확인</Badge>
            )
          }
        />
        {runs.length === 0 ? (
          <EmptyState icon="ci" title="실행 기록 없음" detail="워크플로가 아직 실행되지 않았습니다. 실행 전 상태를 성공으로 표시하지 않습니다." />
        ) : (
          <div className="air-scroll" style={{ maxHeight: 240 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }} aria-label="Actions 실행 목록">
              <thead>
                <tr>
                  {["워크플로", "이벤트", "커밋", "상태", "소요", "시작"].map((h) => (
                    <th key={h} scope="col" style={{ textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--air-line)", color: "var(--air-text-muted)", fontWeight: 600, position: "sticky", top: 0, background: "var(--air-surface)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    onClick={() => {
                      setSelectedRunId(run.id);
                      setSelectedJobId(run.jobs[0]?.id ?? null);
                    }}
                    style={{ cursor: "pointer", background: run.id === selectedRunId ? "var(--air-accent-soft)" : undefined }}
                  >
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>{run.workflow}</td>
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>{run.event}</td>
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }} className="air-mono">{run.headSha.slice(0, 7)}</td>
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}><RunStateBadge state={run.status} /></td>
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>{run.durationMs === null ? "—" : `${Math.round(run.durationMs / 1000)}s`}</td>
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }} className="air-mono">{run.createdAt.slice(5, 16).replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedRun ? (
        <Card>
          <SectionHeader
            title={`${selectedRun.workflow} · ${selectedRun.id}`}
            sub={<span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><RunStateBadge state={selectedRun.status} />{selectedRun.conclusion ? <Badge tone="neutral">{selectedRun.conclusion}</Badge> : <Badge tone="warn" shape="dashed">결론 미기록</Badge>}</span>}
            actions={
              canWrite ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <Button size="sm" icon="refresh" onClick={() => onRerun?.(selectedRun.id)}>재실행</Button>
                  <Button size="sm" variant="danger" icon="pause" onClick={() => onCancel?.(selectedRun.id)} disabled={selectedRun.status !== "RUNNING" && selectedRun.status !== "QUEUED"}>취소</Button>
                </div>
              ) : null
            }
          />
          <div style={{ padding: 12, display: "grid", gap: 10 }}>
            {selectedRun.jobs.length === 0 ? <Banner tone="warn" icon="info">작업(job) 기록이 없습니다 — 실행이 시작되지 않았을 수 있습니다.</Banner> : null}
            {selectedRun.jobs.length > 0 ? (
              <>
                <Tabs
                  label="CI 작업 선택"
                  value={selectedJob?.id ?? ""}
                  onChange={setSelectedJobId}
                  items={selectedRun.jobs.map((job) => ({ id: job.id, label: job.name }))}
                />
                {selectedJob ? (
                  <>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <RunStateBadge state={selectedJob.status} />
                      {selectedJob.steps?.map((step) => (
                        <Badge key={step.name} tone="neutral" shape="pill">{step.name}</Badge>
                      ))}
                    </div>
                    <LogViewer lines={selectedJob.logs} />
                    <ArtifactList artifacts={selectedJob.artifacts} />
                  </>
                ) : null}
              </>
            ) : null}
            {selectedRun.url ? (
              <a className="air-btn" data-size="sm" href={selectedRun.url} target="_blank" rel="noopener noreferrer" style={{ justifySelf: "start" }}>
                <Icon name="external" size={13} /> GitHub에서 보기
              </a>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function LogViewer({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) {
    return <Banner tone="warn" icon="info">로그가 아직 없습니다 — 실행 중이거나 로그 보존 기간이 지났습니다.</Banner>;
  }
  return (
    <div style={{ border: "1px solid var(--air-line)", borderRadius: 10, overflow: "hidden", background: "var(--air-code-bg)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 10px", borderBottom: "1px solid var(--air-line)", fontSize: 11.5, color: "var(--air-text-muted)" }}>
        <span>실행 로그 (스냅샷 — 실시간 스트림 아님)</span>
        <span className="air-mono">{lines.length}줄</span>
      </div>
      <VirtualList
        items={lines}
        rowHeight={18}
        height={220}
        label="CI 로그"
        getKey={(_line, index) => String(index)}
        render={(line) => (
          <pre style={{ margin: 0, padding: "0 10px", fontFamily: "var(--air-font-mono)", fontSize: 11.5, lineHeight: "18px", whiteSpace: "pre-wrap", wordBreak: "break-word", color: /error|fail/i.test(line) ? "var(--air-danger)" : "var(--air-text)" }}>
            {line}
          </pre>
        )}
      />
    </div>
  );
}

function ArtifactList({ artifacts }: { artifacts: readonly CiArtifact[] }) {
  if (artifacts.length === 0) return <span className="air-hint">업로드된 아티팩트 없음</span>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {artifacts.map((artifact) => {
        const status = artifact.hashStatus ?? (artifact.sha256 ? "unverified" : "unverified");
        return (
          <div key={artifact.name} className="air-card" data-pad="sm" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Icon name="artifact" size={14} />
            <span className="air-mono" style={{ fontSize: 12 }}>{artifact.name}</span>
            <span className="air-hint">{formatSize(artifact.size)}</span>
            <Badge tone={status === "verified" ? "ok" : status === "mismatch" ? "danger" : "warn"} shape={status === "verified" ? "solid" : "dashed"}>
              {status === "verified" ? "해시 검증됨" : status === "mismatch" ? "해시 불일치" : "해시 미검증"}
            </Badge>
            {artifact.downloadUrl ? (
              <a className="air-btn" data-size="sm" data-variant="ghost" href={artifact.downloadUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="download" size={12} /> 다운로드
              </a>
            ) : (
              <span className="air-hint">다운로드 링크 없음</span>
            )}
            {artifact.sha256 ? <span className="air-mono air-hint">{artifact.sha256.slice(0, 16)}…</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

import { useState } from "react";
import { Badge, Banner, Button, Card, Icon, SectionHeader, TextInput, VirtualList } from "@ai-room/design-system";

export interface TerminalSession {
  id: string;
  jobId: string;
  runner: string;
  state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";
  /** True only for a runner that actually exposes an interactive PTY. */
  supportsPty: boolean;
  startedAt: string;
  lines: string[];
  blockedReason?: string;
}

export interface TerminalPanelProps {
  sessions: readonly TerminalSession[];
  /** Command allowlist enforced by the gateway, mirrored here for early feedback. */
  allowedCommands?: readonly string[];
  onSubmit?: (command: string) => void;
  canRun?: boolean;
}

const DEFAULT_ALLOWED = ["npm", "node", "npx", "pnpm", "git", "ls", "cat", "grep", "sed", "awk", "tsc", "vite", "pytest", "cargo", "gradle"];

/**
 * Terminal panel (spec 13.5).
 *
 * A Cloudflare Worker cannot run a shell. This panel submits an allowlisted
 * command to a GitHub Actions job and shows the job's log. It says so on screen:
 * a log snapshot is not a PTY, and it is never dressed up as one.
 */
export function TerminalPanel({ sessions, allowedCommands = DEFAULT_ALLOWED, onSubmit, canRun = false }: TerminalPanelProps) {
  const [command, setCommand] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(sessions[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;

  const submit = () => {
    const first = command.trim().split(/\s+/)[0] ?? "";
    if (!command.trim()) return;
    if (!allowedCommands.includes(first)) {
      setError(`허용목록에 없는 명령: ${first || "(빈 명령)"} — 실행하지 않았습니다`);
      return;
    }
    if (/rm\s+-rf\s+\/|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh/.test(command)) {
      setError("위험 패턴이 감지되어 실행 요청을 만들지 않았습니다");
      return;
    }
    setError(null);
    onSubmit?.(command.trim());
    setCommand("");
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card>
        <SectionHeader
          title="터미널 (Actions 러너)"
          sub="Cloudflare Worker에서 임의 셸 실행 없음 · 대화형 PTY 미지원은 그대로 표시"
          actions={<Badge tone="neutral" shape="dashed" icon="terminal">read-only log</Badge>}
        />
        <div style={{ padding: 12, display: "grid", gap: 8 }}>
          <Banner tone="info" icon="info">
            명령은 허용목록 검사를 거쳐 <strong>GitHub Actions 임시 러너</strong>에서 실행 요청으로 접수됩니다. 즉시 대화형 셸이 필요하면 이 화면은 그 요청을 충족하지 못합니다.
          </Banner>
          <div style={{ display: "flex", gap: 6 }}>
            <TextInput
              aria-label="실행할 명령"
              placeholder={canRun ? "예: npm test" : "명령 입력 (실행 권한 미확인 시 요청만 기록)"}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              className="air-mono"
            />
            <Button variant="primary" icon="play" onClick={submit} disabled={!onSubmit}>실행 요청</Button>
          </div>
          {error ? <div className="air-error" role="alert">{error}</div> : null}
          <div className="air-hint">허용: {allowedCommands.join(", ")}</div>
        </div>
      </Card>

      {sessions.length === 0 ? (
        <Card data-pad="md"><span className="air-hint">실행 세션이 없습니다.</span></Card>
      ) : (
        <Card>
          <SectionHeader
            title="세션"
            sub={selected ? `${selected.runner} · ${selected.jobId}` : undefined}
            actions={
              <select aria-label="세션 선택" className="air-select" style={{ width: 220, fontSize: 12 }} value={selected?.id ?? ""} onChange={(e) => setSelectedId(e.target.value)}>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.startedAt.slice(11, 19)} · {s.state}</option>
                ))}
              </select>
            }
          />
          {selected ? (
            <div style={{ padding: 12, display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <Badge tone={selected.state === "FAILED" ? "danger" : selected.state === "SUCCEEDED" ? "ok" : selected.state === "BLOCKED" ? "warn" : "info"}>{selected.state}</Badge>
                <Badge tone={selected.supportsPty ? "ok" : "neutral"} shape={selected.supportsPty ? "solid" : "dashed"}>
                  {selected.supportsPty ? "PTY 지원" : "PTY 미지원 · 로그 읽기 전용"}
                </Badge>
                <span className="air-mono air-hint">{selected.jobId}</span>
              </div>
              {selected.blockedReason ? <Banner tone="warn" icon="lock">{selected.blockedReason}</Banner> : null}
              {selected.lines.length === 0 ? (
                <span className="air-hint">로그 없음</span>
              ) : (
                <div style={{ border: "1px solid var(--air-line)", borderRadius: 10, overflow: "hidden", background: "var(--air-code-bg)" }}>
                  <VirtualList
                    items={selected.lines}
                    rowHeight={18}
                    height={240}
                    label="터미널 로그"
                    getKey={(_l, i) => String(i)}
                    render={(line) => (
                      <pre style={{ margin: 0, padding: "0 10px", fontSize: 11.5, lineHeight: "18px", fontFamily: "var(--air-font-mono)", whiteSpace: "pre-wrap", color: /error|fail/i.test(line) ? "var(--air-danger)" : "var(--air-text)" }}>{line}</pre>
                    )}
                  />
                </div>
              )}
              <div className="air-hint" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <Icon name="info" size={12} /> 입력(stdin) 전송은 지원되지 않습니다 — 필요한 경우 워크플로 입력값으로 전달하세요.
              </div>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}

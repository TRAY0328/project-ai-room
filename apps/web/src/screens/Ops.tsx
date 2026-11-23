import { useMemo, useState } from "react";
import { Badge, Banner, Button, Card, Icon, Reveal, SectionHeader, Select, VerificationBadge } from "@ai-room/design-system";
import { useApp } from "../state/AppState.js";
import { useResource } from "../api/hooks.js";
import { newIdempotencyKey } from "../api/client.js";
import type { AlertDto, ConnectionDto } from "../api/types.js";
import { demoAlerts, demoConnections } from "../demo/fixtures.js";
import { DemoChip, DemoNote, EmptyHint, ResourceView, ScreenHeader, Section } from "../components/ui.js";

/* --------------------------------------------------------------- CONNECTIONS */

const CAPABILITY_LABEL: Record<string, string> = {
  "message.receive": "메시지 수신",
  "message.send": "메시지 전송",
  "task.claim": "작업 인수",
  "task.execute": "작업 실행",
  "code.patch": "코드 패치",
  "git.pr.create": "PR 생성",
  "git.review": "리뷰",
  "artifact.read": "아티팩트 조회",
  "checkpoint.resume": "체크포인트 재개",
};

const CAPABILITIES = Object.keys(CAPABILITY_LABEL);
const PROVIDERS = ["Google Gemini", "OpenAI ChatGPT", "Anthropic Claude", "PICKLE", "Keyring", "VOOY", "MUSE", "CUE"];

function capTone(state?: string): { tone: "ok" | "warn" | "danger" | "neutral" | "info"; label: string } {
  switch (state) {
    case "verified": return { tone: "ok", label: "검증" };
    case "testing": return { tone: "info", label: "검증 중" };
    case "unsupported": return { tone: "neutral", label: "미지원" };
    case "failed": return { tone: "danger", label: "실패" };
    case "expired": return { tone: "warn", label: "만료" };
    default: return { tone: "neutral", label: "미확인" };
  }
}

/**
 * Provider capability matrix (spec 07.3, Q039).
 * A provider without a documented free unattended path stays BLOCKED here —
 * nothing is invented to make the matrix look green.
 */
export function ConnectionsScreen() {
  const { client, gatewayUrl, demoMode } = useApp();
  const res = useResource<{ connections?: ConnectionDto[] }>(client, "/v1/providers/connections", { enabled: Boolean(gatewayUrl) && !demoMode });
  const connections = demoMode ? demoConnections : res.state.kind === "ready" ? res.state.data.connections ?? [] : [];
  const [toast, setToast] = useState<string | null>(null);

  const rows = useMemo(() => {
    const byProvider = new Map(connections.map((c) => [c.provider, c]));
    return PROVIDERS.map((provider) => byProvider.get(provider) ?? null);
  }, [connections]);

  const verify = async (connection: ConnectionDto) => {
    if (!gatewayUrl || demoMode) {
      setToast("데모/미연결 모드 — 검증 요청을 서버로 보내지 않았습니다");
      return;
    }
    const result = await client.request("POST", `/v1/providers/${encodeURIComponent(connection.provider)}/verify`, { body: {}, idempotencyKey: newIdempotencyKey("provider-verify") });
    setToast(result.ok ? "검증 요청 전송 — 결과는 capability 증거로 갱신됩니다" : `${result.code}: ${result.message}`);
  };

  return (
    <div className="air-screen air-screen-wide">
      <ScreenHeader
        title="AI 연결 검사"
        subtitle="공급자별 공식 인증·capability evidence · 자체신고와 검증 분리"
        badges={<><DemoChip on={demoMode} /><Badge tone="warn" icon="lock">BLOCKED_EXTERNAL_DEPENDENCY</Badge></>}
      />
      {demoMode ? <DemoNote detail="연결 상태는 데모 값입니다. 실제 제공자 검증은 서버의 공식 인증 흐름에서만 일어납니다." /> : null}
      {!demoMode && res.state.kind !== "ready" ? <ResourceView state={res.state} onRetry={res.reload}>{() => null}</ResourceView> : null}
      {toast ? <Banner tone="info" icon="info">{toast}</Banner> : null}

      <Card>
        <SectionHeader title="능력 매트릭스" sub="verified 만 실제 사용 가능으로 집계" />
        <div className="air-table-wrap">
          <div className="air-table-hint">가로로 밀어서 전체 열을 볼 수 있습니다</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }} aria-label="제공자 능력 매트릭스">
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--air-line)", position: "sticky", left: 0, background: "var(--air-surface)" }}>제공자</th>
                <th scope="col" style={{ textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>상태</th>
                {CAPABILITIES.map((cap) => (
                  <th key={cap} scope="col" title={CAPABILITY_LABEL[cap]} style={{ padding: "6px 6px", borderBottom: "1px solid var(--air-line)", fontSize: 10.5, color: "var(--air-text-muted)", writingMode: "vertical-rl", textOrientation: "mixed" }}>
                    {CAPABILITY_LABEL[cap]}
                  </th>
                ))}
                <th scope="col" style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>동작</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((connection, index) => {
                const provider = PROVIDERS[index]!;
                return (
                  <tr key={provider}>
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)", position: "sticky", left: 0, background: "var(--air-bg)", whiteSpace: "nowrap" }}>{provider}</td>
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>
                      {connection ? (
                        <div style={{ display: "grid", gap: 2 }}>
                          <Badge tone={connection.state === "VERIFIED" ? "ok" : connection.state === "TOKEN_EXPIRED" ? "warn" : "neutral"} shape={connection.state === "VERIFIED" ? "solid" : "dashed"}>{connection.state}</Badge>
                          <VerificationBadge level={connection.attestation} />
                        </div>
                      ) : (
                        <Badge tone="neutral" shape="dashed">NOT_CONFIGURED</Badge>
                      )}
                    </td>
                    {CAPABILITIES.map((cap) => {
                      const state = connection?.capabilities?.[cap];
                      const info = capTone(state);
                      return (
                        <td key={cap} style={{ padding: "4px 6px", borderBottom: "1px solid var(--air-line)", textAlign: "center" }}>
                          <Badge tone={info.tone} shape={state === "verified" ? "solid" : "dashed"} title={`${provider} · ${CAPABILITY_LABEL[cap]}: ${info.label}`}>{info.label}</Badge>
                        </td>
                      );
                    })}
                    <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>
                      {connection ? (
                        <div style={{ display: "flex", gap: 4 }}>
                          <Button size="sm" icon="plug" onClick={() => void verify(connection)}>검증</Button>
                          {connection.evidence_url ? <a className="air-btn" data-size="sm" data-variant="ghost" href={connection.evidence_url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /></a> : null}
                        </div>
                      ) : (
                        <Button size="sm" variant="ghost" disabled>미설정</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Section title="차단 사유" sub="무료·무인·공식 경로 증거가 없는 제공자">
        <div style={{ display: "grid", gap: 6 }}>
          {connections.filter((c) => c.state !== "VERIFIED").map((c) => (
            <div key={c.connection_id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Badge tone="warn" icon="lock">BLOCKED_EXTERNAL_DEPENDENCY</Badge>
              <strong style={{ fontSize: 12.5 }}>{c.provider}</strong>
              <span className="air-hint">{reasonText(c.state)}</span>
              <span style={{ flex: 1 }} />
              <span className="air-hint">{c.last_checked_at ? new Date(c.last_checked_at).toLocaleString() : "확인 기록 없음"}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function reasonText(state: ConnectionDto["state"]): string {
  const map: Record<ConnectionDto["state"], string> = {
    NOT_CONFIGURED: "설정 없음",
    NO_OFFICIAL_EVIDENCE: "공식 문서상 무인 자동화 경로 증거 없음",
    TERMS_UNVERIFIED: "약관상 자동화 허용 미확인",
    AUTH_UNSUPPORTED: "공식 인증 방식 없음",
    AUTONOMY_UNSUPPORTED: "자율 실행 미지원",
    PAID_API_REQUIRED: "유료 API 필요",
    NO_FREE_CAPACITY: "무료 한도 없음",
    CAPABILITY_MISSING: "필수 능력 미지원",
    TOKEN_EXPIRED: "토큰 만료 — 재인증 필요",
    TEMPORARY_ERROR: "일시 오류 — 재시도 가능",
    VERIFIED: "검증됨",
  };
  return map[state];
}

/* -------------------------------------------------------------------- ALERTS */

export function AlertsScreen() {
  const { client, gatewayUrl, demoMode } = useApp();
  const res = useResource<{ alerts?: AlertDto[] }>(client, "/v1/admin/overview", { enabled: Boolean(gatewayUrl) && !demoMode, pollMs: 30000 });
  const base = demoMode ? demoAlerts : res.state.kind === "ready" ? res.state.data.alerts ?? [] : [];
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [priority, setPriority] = useState<Record<string, AlertDto["priority"]>>({});
  const [filter, setFilter] = useState("all");
  const [read, setRead] = useState<Set<string>>(new Set());

  const alerts = base
    .filter((a) => (filter === "all" ? true : filter === "unread" ? !read.has(a.alert_id) && !a.read : a.kind === filter))
    .map((a) => ({ ...a, muted: muted.has(a.alert_id) || a.muted, priority: priority[a.alert_id] ?? a.priority }));

  return (
    <div className="air-screen">
      <ScreenHeader
        title="실시간 알림"
        subtitle="감지된 이벤트만 · 읽음/음소거/우선도 · 타임라인"
        badges={<><DemoChip on={demoMode} /><Badge tone="info" icon="bell">{alerts.length}건</Badge></>}
        actions={
          <Select aria-label="알림 필터" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 160 }}>
            <option value="all">전체</option>
            <option value="unread">읽지 않음</option>
            <option value="approval">승인</option>
            <option value="provider">제공자</option>
            <option value="build">빌드</option>
            <option value="budget">예산</option>
          </Select>
        }
      />
      {demoMode ? <DemoNote detail="알림은 데모입니다. 실제 알림은 서버 감지 이벤트에서만 생성됩니다." /> : null}
      {!demoMode && res.state.kind !== "ready" ? <ResourceView state={res.state} onRetry={res.reload}>{() => null}</ResourceView> : null}

      <Card>
        <SectionHeader title="타임라인" sub="최신순" />
        <ul className="air-timeline" data-testid="alert-timeline" style={{ padding: "8px 14px 14px" }}>
          {alerts.map((alert) => (
            <Reveal as="li" kind="left" key={alert.alert_id} data-severity={alert.severity}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge tone={alert.severity === "critical" ? "danger" : alert.severity === "warn" ? "warn" : "info"}>{alert.severity}</Badge>
                  <Badge tone="neutral">{alert.kind}</Badge>
                  <strong style={{ fontSize: 12.5 }}>{alert.title}</strong>
                  {alert.muted ? <Badge tone="neutral" icon="lock">음소거</Badge> : null}
                  <span style={{ flex: 1 }} />
                  <span className="air-hint">{new Date(alert.created_at).toLocaleTimeString()}</span>
                </div>
                <div className="air-hint" style={{ marginTop: 2 }}>{alert.detail}</div>
                <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                  <Button size="sm" variant="ghost" icon={alert.muted ? "bell" : "lock"} data-testid="alert-mute" onClick={() => setMuted((prev) => { const next = new Set(prev); if (next.has(alert.alert_id)) next.delete(alert.alert_id); else next.add(alert.alert_id); return next; })}>
                    {alert.muted ? "음소거 해제" : "음소거"}
                  </Button>
                  <Select aria-label="우선도" value={alert.priority ?? "normal"} onChange={(e) => setPriority((prev) => ({ ...prev, [alert.alert_id]: e.target.value as AlertDto["priority"] }))} style={{ width: 110, fontSize: 11 }} data-testid="alert-priority">
                    <option value="low">낮음</option>
                    <option value="normal">보통</option>
                    <option value="high">높음</option>
                  </Select>
                  <Button size="sm" variant="ghost" icon="check" onClick={() => setRead((prev) => new Set(prev).add(alert.alert_id))}>읽음</Button>
                  {alert.link ? <a className="air-btn" data-size="sm" data-variant="ghost" href={alert.link}>열기</a> : null}
                </div>
              </div>
            </Reveal>
          ))}
        </ul>
        {alerts.length === 0 ? <EmptyHint icon="bell" title="알림이 없습니다" /> : null}
      </Card>
    </div>
  );
}

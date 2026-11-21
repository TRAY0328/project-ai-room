import { useMemo, useState } from "react";
import { Badge, Banner, Button, Card, Dialog, Field, Icon, Reveal, SectionHeader, Select, TextInput } from "@ai-room/design-system";
import { useApp } from "../state/AppState.js";
import { useResource } from "../api/hooks.js";
import type { ApprovalDto, AuditEntryDto, BackupDto, ReleaseGateDto, ReportDto } from "../api/types.js";
import { demoApprovals, demoAudit, demoBackups, demoReleaseGate, demoReports } from "../demo/fixtures.js";
import { ApprovalCard } from "../components/workspace.js";
import { DataTable } from "@ai-room/design-system";
import { DemoChip, DemoNote, EmptyHint, ResourceView, ScreenHeader, Section, StateChip } from "../components/ui.js";

/* ----------------------------------------------------------------- APPROVALS */

export function ApprovalsScreen() {
  const { client, gatewayUrl, demoMode, session } = useApp();
  const res = useResource<{ approvals?: ApprovalDto[] }>(client, "/v1/admin/overview", { enabled: Boolean(gatewayUrl) && !demoMode });
  const [decisions, setDecisions] = useState<Record<string, ApprovalDto["status"]>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [riskFilter, setRiskFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("pending");

  const all = demoMode ? demoApprovals : res.state.kind === "ready" ? res.state.data.approvals ?? [] : [];
  const list = all
    .map((a) => (decisions[a.approval_id] ? { ...a, status: decisions[a.approval_id]! } : a))
    .filter((a) => (riskFilter === "all" ? true : a.risk === riskFilter))
    .filter((a) => (statusFilter === "all" ? true : a.status === statusFilter));

  const decide = async (approval: ApprovalDto, decision: "approve" | "reject", sha: string) => {
    setDecisions((prev) => ({ ...prev, [approval.approval_id]: decision === "approve" ? "approved" : "rejected" }));
    if (gatewayUrl && !demoMode) {
      const result = await client.request("POST", `/v1/admin/approvals/${encodeURIComponent(approval.approval_id)}/resolve`, {
        body: { decision, action_sha256: sha },
      });
      setToast(result.ok ? "승인 결정이 서버에 기록되었습니다" : `${result.code}: ${result.message}`);
    } else {
      setToast("데모/미연결 모드 — 결정을 서버에 보내지 않았습니다(로컬 표시)");
    }
  };

  return (
    <div className="air-screen air-screen-wide">
      <ScreenHeader
        title="승인 센터"
        subtitle="위험 작업 · 변경 해시 확인 · 승인 후 내용이 바뀌면 재승인"
        badges={<><DemoChip on={demoMode} /><Badge tone="danger" icon="warning">OWNER ONLY</Badge></>}
        actions={
          <>
            <Select aria-label="위험도 필터" value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)} style={{ width: 140 }}>
              <option value="all">모든 위험도</option>
              <option value="high">높음</option>
              <option value="medium">중간</option>
              <option value="low">낮음</option>
            </Select>
            <Select aria-label="상태 필터" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 140 }}>
              <option value="pending">대기</option>
              <option value="approved">승인됨</option>
              <option value="all">전체</option>
            </Select>
          </>
        }
      />
      {demoMode ? <DemoNote detail="승인 카드의 영향 범위·해시는 데모 값입니다. 승인 확정은 서버 없이 전송되지 않습니다." /> : null}
      {!demoMode && res.state.kind !== "ready" ? <ResourceView state={res.state} onRetry={res.reload}>{() => null}</ResourceView> : null}
      {toast ? <Banner tone="info" icon="info">{toast}</Banner> : null}
      {session === null && !demoMode ? <Banner tone="warn" icon="lock">소유자 세션이 없습니다 — 승인 결정은 서버에서 403으로 거부됩니다.</Banner> : null}

      <div style={{ display: "grid", gap: 10 }}>
        {list.length === 0 ? <EmptyHint icon="approval" title="대기 중인 승인이 없습니다" detail="위험 작업이 생기면 여기에 나타납니다." /> : null}
        {list.map((approval) => (
          <ApprovalCard key={approval.approval_id} approval={approval} session={session} onDecide={(a, d, sha) => void decide(a, d, sha)} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- REPORTS */

export function ReportsScreen() {
  const { client, gatewayUrl, demoMode } = useApp();
  const res = useResource<{ reports?: ReportDto[] }>(client, "/v1/projects/proj-ai-room/reports", { enabled: Boolean(gatewayUrl) && !demoMode });
  const reports = demoMode ? demoReports : res.state.kind === "ready" ? res.state.data.reports ?? [] : [];
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  return (
    <div className="air-screen">
      <ScreenHeader title="보고서" subtitle="근거 링크가 있는 진행/차단 보고 · 증거 없는 완료 주장은 표시하지 않음" badges={<DemoChip on={demoMode} />} />
      <div style={{ display: "grid", gap: 10 }}>
        {reports.map((report) => (
          <Reveal as="article" kind="rise" key={report.report_id}>
            <Card pad="md" className="air-hover-lift">
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Badge tone={report.kind === "blocker" ? "warn" : report.kind === "completion" ? "ok" : "info"}>{report.kind}</Badge>
                <strong style={{ fontSize: 13 }}>{report.title}</strong>
                <span style={{ flex: 1 }} />
                <span className="air-hint">{new Date(report.created_at).toLocaleString()}</span>
              </div>
              <div style={{ fontSize: 12.5, marginTop: 6 }}>{report.summary}</div>
              <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
                {report.evidence.map((item) => (
                  <div key={item.label} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                    <Badge tone={verified[item.label] ?? item.verified ? "ok" : "warn"} shape={verified[item.label] ?? item.verified ? "solid" : "dashed"}>
                      {verified[item.label] ?? item.verified ? "검증됨" : "미검증"}
                    </Badge>
                    {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.label}</a> : <span>{item.label}</span>}
                    <span style={{ flex: 1 }} />
                    <Button size="sm" variant="ghost" icon="check" onClick={() => setVerified((prev) => ({ ...prev, [item.label]: true }))}>확인 표시</Button>
                  </div>
                ))}
              </div>
            </Card>
          </Reveal>
        ))}
        {reports.length === 0 ? <EmptyHint icon="report" title="보고서가 없습니다" /> : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- ADMIN */

export function AdminScreen() {
  const { client, gatewayUrl, setGatewayUrl, refreshConnection, demoMode, setDemoMode } = useApp();
  const [url, setUrl] = useState(gatewayUrl ?? "");
  const [budget, setBudget] = useState("2000");
  const [confirm, setConfirm] = useState<null | { title: string; body: string; action: () => void }>(null);
  const [toast, setToast] = useState<string | null>(null);

  return (
    <div className="air-screen">
      <ScreenHeader title="운영 설정" subtitle="AI 차단·키 회전·리소스 예산 · OWNER ONLY" badges={<Badge tone="danger" icon="lock">OWNER ONLY</Badge>} />
      <Section title="게이트웨이" sub="이 브라우저에만 저장됩니다">
        <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <Field label="게이트웨이 URL" htmlFor="admin-gateway"><TextInput id="admin-gateway" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…workers.dev" /></Field>
          <div style={{ display: "flex", gap: 6 }}>
            <Button icon="check" onClick={() => { setGatewayUrl(url || null); void refreshConnection(); }}>저장</Button>
            <Button variant="ghost" icon="eye" onClick={() => setDemoMode(!demoMode)}>{demoMode ? "데모 끄기" : "데모 켜기"}</Button>
          </div>
        </div>
      </Section>

      <div className="air-grid-2">
        <Section title="AI 차단·키" sub="차단 즉시 모든 세션 무효">
          <div style={{ display: "grid", gap: 8 }}>
            <Field label="AI 에이전트 ID" htmlFor="admin-agent"><TextInput id="admin-agent" placeholder="agent-…" /></Field>
            <div style={{ display: "flex", gap: 6 }}>
              <Button size="sm" variant="danger" icon="lock" onClick={() => setConfirm({ title: "AI 차단", body: "차단하면 진행 중인 lease도 종료됩니다. 계속할까요?", action: () => setToast("차단 요청 전송(서버 확인 필요)") })}>차단</Button>
              <Button size="sm" icon="refresh" onClick={() => setConfirm({ title: "키 회전", body: "기존 키는 즉시 무효화됩니다. AI가 새 키로 재로그인해야 합니다.", action: () => setToast("키 회전 요청 전송") })}>키 회전</Button>
            </div>
          </div>
        </Section>
        <Section title="리소스 예산" sub="측정값이 없으면 0으로 간주하지 않음">
          <div style={{ display: "grid", gap: 8 }}>
            <Field label="월 Actions 분 예산" htmlFor="admin-budget" hint="soft/hard 임계값은 서버가 강제">
              <TextInput id="admin-budget" value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="numeric" />
            </Field>
            <Button size="sm" icon="gauge" onClick={() => setToast("예산 설정 요청 전송")}>예산 저장</Button>
            <div className="air-hint">무료 한도 확인이 지연되면 보수적으로 제한합니다.</div>
          </div>
        </Section>
      </div>

      <Section title="위험 구역" sub="되돌릴 수 없는 작업">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="danger" icon="trash" onClick={() => setConfirm({ title: "데이터 삭제 준비", body: "삭제는 파생 기억·색인·백업까지 전파됩니다. 영향 범위를 확인하고 진행하세요.", action: () => void client.request("POST", "/v1/admin/data-deletion/prepare", { body: {} }) })}>데이터 삭제 준비</Button>
          <Button variant="danger" icon="backup" onClick={() => setConfirm({ title: "복원 준비", body: "복원은 현재 데이터를 덮어쓸 수 있습니다. 백업 체크섬과 범위를 확인하세요.", action: () => void client.request("POST", "/v1/admin/restores/prepare", { body: {} }) })}>복원 준비</Button>
        </div>
      </Section>

      {toast ? <Banner tone="info" icon="info">{toast}</Banner> : null}

      <Dialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title={confirm?.title ?? ""}
        description="영향 범위를 확인했습니다"
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>취소</Button><Button variant="danger" onClick={() => { confirm?.action(); setConfirm(null); }}>실행</Button></>}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <div>{confirm?.body}</div>
          <Banner tone="danger" icon="warning">이 작업은 되돌릴 수 없으며 감사 로그에 기록됩니다.</Banner>
        </div>
      </Dialog>
    </div>
  );
}

/* --------------------------------------------------------------------- AUDIT */

export function AuditScreen() {
  const { client, gatewayUrl, demoMode } = useApp();
  const res = useResource<{ entries?: AuditEntryDto[]; audit_events?: AuditEntryDto[] }>(client, "/v1/admin/audit-events", { enabled: Boolean(gatewayUrl) && !demoMode });
  const entries = demoMode ? demoAudit : res.state.kind === "ready" ? res.state.data.entries ?? res.state.data.audit_events ?? [] : [];
  const [actorKind, setActorKind] = useState("all");
  const filtered = entries.filter((e) => (actorKind === "all" ? true : e.actor_kind === actorKind));

  return (
    <div className="air-screen">
      <ScreenHeader title="감사 로그" subtitle="누가 무엇을 했는지 · 비밀/PII 마스킹" badges={<><DemoChip on={demoMode} /><Badge tone="neutral">{filtered.length}건</Badge></>} actions={
        <Select aria-label="행위자 필터" value={actorKind} onChange={(e) => setActorKind(e.target.value)} style={{ width: 150 }}>
          <option value="all">모든 행위자</option>
          <option value="owner">인간 소유자</option>
          <option value="agent">AI</option>
        </Select>
      } />
      {demoMode ? <DemoNote detail="감사 항목은 데모입니다. 실제 감사 로그는 서버에서만 발급됩니다." /> : null}
      <Card>
        <SectionHeader title="이벤트" sub="IP·토큰은 마스킹된 값만 표시" />
        <DataTable
          caption="감사 로그"
          rows={filtered}
          getRowKey={(row) => row.audit_id}
          columns={[
            { key: "at", header: "시각", render: (row) => <span className="air-mono">{new Date(row.at).toLocaleString()}</span>, sortValue: (row) => row.at },
            { key: "actor", header: "행위자", render: (row) => <span>{row.actor} <Badge tone={row.actor_kind === "owner" ? "info" : "neutral"}>{row.actor_kind}</Badge></span>, sortValue: (row) => row.actor },
            { key: "action", header: "동작", render: (row) => <code className="air-code-inline">{row.action}</code>, sortValue: (row) => row.action },
            { key: "target", header: "대상", render: (row) => <span className="air-mono">{row.target}</span> },
            { key: "ip", header: "IP", render: (row) => <span className="air-mono air-hint">{row.ip_masked ?? "—"}</span> },
            { key: "detail", header: "상세", render: (row) => <span className="air-hint">{row.detail ?? "—"}</span> },
          ]}
        />
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------- BACKUP */

export function BackupScreen() {
  const { client, gatewayUrl, demoMode } = useApp();
  const res = useResource<{ backups?: BackupDto[] }>(client, "/v1/admin/overview", { enabled: Boolean(gatewayUrl) && !demoMode });
  const backups = demoMode ? demoBackups : res.state.kind === "ready" ? res.state.data.backups ?? [] : [];
  const [dialog, setDialog] = useState<null | { kind: "restore" | "delete"; backup: BackupDto }>(null);

  return (
    <div className="air-screen">
      <ScreenHeader title="백업 · 복구" subtitle="체크섬·복원 시험·삭제 영향 확인" badges={<><DemoChip on={demoMode} /><Badge tone="danger" icon="lock">OWNER ONLY</Badge></>} />
      <Card>
        <SectionHeader title="백업 목록" sub={`${backups.length}건`} />
        <div style={{ padding: 12, display: "grid", gap: 8 }}>
          {backups.map((backup) => (
            <div key={backup.backup_id} className="air-card" data-pad="sm" style={{ display: "grid", gap: 6 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Icon name="backup" size={14} />
                <span className="air-mono">{backup.backup_id}</span>
                <span className="air-hint">{new Date(backup.created_at).toLocaleString()}</span>
                <span className="air-hint">{(backup.size / 1024 / 1024).toFixed(1)} MB</span>
                <Badge tone={backup.last_restore_test?.result === "pass" ? "ok" : backup.last_restore_test?.result === "fail" ? "danger" : "warn"} shape={backup.last_restore_test?.result === "pass" ? "solid" : "dashed"}>
                  복원 시험 {backup.last_restore_test?.result ?? "미실행"}
                </Badge>
                <span style={{ flex: 1 }} />
                <Button size="sm" icon="refresh" onClick={() => setDialog({ kind: "restore", backup })}>복원 시험</Button>
                <Button size="sm" variant="danger" icon="trash" onClick={() => setDialog({ kind: "delete", backup })}>삭제</Button>
              </div>
              <div className="air-hint" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <span>sha256 {backup.checksum.slice(0, 16)}…</span>
                <span>범위 {backup.scope.join(", ")}</span>
                {backup.last_restore_test?.detail ? <span>{backup.last_restore_test.detail}</span> : null}
              </div>
            </div>
          ))}
          {backups.length === 0 ? <span className="air-hint">백업 정보 없음(서버 미연결)</span> : null}
        </div>
      </Card>

      <Dialog
        open={Boolean(dialog)}
        onClose={() => setDialog(null)}
        title={dialog?.kind === "restore" ? "복원 시험" : "백업 삭제"}
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>취소</Button><Button variant="danger" onClick={() => {
          if (dialog?.kind === "restore" && gatewayUrl && !demoMode) void client.request("POST", "/v1/admin/restores/prepare", { body: { backup_id: dialog.backup.backup_id } });
          setDialog(null);
        }}>실행</Button></>}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <div>{dialog?.backup.backup_id} · 체크섬 {dialog?.backup.checksum.slice(0, 12)}…</div>
          <Banner tone="danger" icon="warning">
            {dialog?.kind === "restore" ? "복원은 현재 데이터를 덮어쓸 수 있습니다. 격리 환경에서 먼저 시험하세요." : "삭제는 되돌릴 수 없습니다. 영향 범위를 확인하고 승인해야 합니다."}
          </Banner>
        </div>
      </Dialog>
    </div>
  );
}

/* ----------------------------------------------------------------- REL_GATE */

export function ReleaseGateScreen() {
  const { client, gatewayUrl, demoMode } = useApp();
  const res = useResource<ReleaseGateDto>(client, "/v1/admin/release-gates", { enabled: Boolean(gatewayUrl) && !demoMode });
  const gate = demoMode ? demoReleaseGate : res.state.kind === "ready" ? res.state.data : null;
  const counts = useMemo(() => {
    const list = gate?.requirements ?? [];
    return {
      PASS: list.filter((r) => r.state === "PASS").length,
      FAIL: list.filter((r) => r.state === "FAIL").length,
      BLOCKED: list.filter((r) => r.state === "BLOCKED").length,
    };
  }, [gate]);

  return (
    <div className="air-screen">
      <ScreenHeader
        title="최종 출시 게이트"
        subtitle="Q001~Q041 PASS/FAIL/BLOCKED · 모든 AI 연결까지 필수"
        badges={<><DemoChip on={demoMode} /><Badge tone={gate?.overall === "RELEASE_READY" ? "ok" : "danger"} icon="gate">{gate?.overall ?? "데이터 없음"}</Badge></>}
      />
      {!gate ? (
        <EmptyHint icon="gate" title="게이트 결과 없음" detail="서버에서 게이트 결과를 받지 못했습니다." />
      ) : (
        <>
          <div className="air-grid-3">
            <Card pad="md"><div className="air-hint">PASS</div><div style={{ fontSize: 24, fontWeight: 700, color: "var(--air-ok)" }}>{counts.PASS}</div></Card>
            <Card pad="md"><div className="air-hint">FAIL</div><div style={{ fontSize: 24, fontWeight: 700, color: "var(--air-danger)" }}>{counts.FAIL}</div></Card>
            <Card pad="md"><div className="air-hint">BLOCKED</div><div style={{ fontSize: 24, fontWeight: 700, color: "var(--air-warn)" }}>{counts.BLOCKED}</div></Card>
          </div>
          <Card>
            <SectionHeader title="요구사항" sub={`생성 ${new Date(gate.generated_at).toLocaleString()}`} />
            <DataTable
              caption="출시 게이트 요구사항"
              rows={gate.requirements}
              getRowKey={(row) => row.id}
              columns={[
                { key: "id", header: "ID", render: (row) => <span className="air-mono">{row.id}</span>, sortValue: (row) => row.id },
                { key: "title", header: "요구사항", render: (row) => row.title },
                { key: "state", header: "상태", render: (row) => <StateChip state={row.state} /> },
                { key: "evidence", header: "근거", render: (row) => <span className="air-hint">{row.evidence ?? row.note ?? "근거 없음"}</span> },
              ]}
            />
          </Card>
          <Banner tone="danger" icon="warning">
            <strong>차단 사유</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{gate.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </Banner>
        </>
      )}
    </div>
  );
}

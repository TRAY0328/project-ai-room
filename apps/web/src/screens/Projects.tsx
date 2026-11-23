import { useMemo, useState } from "react";
import { Badge, Banner, Button, Card, Field, Icon, ProgressBar, Reveal, SectionHeader, Tabs, TextInput } from "@ai-room/design-system";
import { useApp } from "../state/AppState.js";
import { useResource, relativeTime } from "../api/hooks.js";
import { newIdempotencyKey } from "../api/client.js";
import type { ProjectSummary, TaskDto } from "../api/types.js";
import { demoAgents, demoMetrics, demoProjects, demoReports, demoTasks } from "../demo/fixtures.js";
import { Kanban, DependencyGraph, VerifiedProgress } from "../components/workspace.js";
import { MetricGrid } from "../components/MetricGrid.js";
import { DemoChip, DemoNote, EmptyHint, ResourceView, ScreenHeader, Section } from "../components/ui.js";
import type { ScreenId } from "../lib/router.js";

type Navigate = (id: ScreenId, params?: Record<string, string>) => void;

/* ------------------------------------------------------------- PROJECTLIST */

export function ProjectListScreen({ navigate }: { navigate: Navigate }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const res = useResource<{ projects?: ProjectSummary[]; items?: ProjectSummary[] }>(client, "/v1/projects", { enabled: Boolean(gatewayUrl) && !demoMode });
  const projects = demoMode ? demoProjects : res.state.kind === "ready" ? res.state.data.projects ?? res.state.data.items ?? [] : [];
  const [filter, setFilter] = useState("");

  const visible = projects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="air-screen">
      <ScreenHeader
        title="전체 프로젝트"
        subtitle="실검증 진행률만 표시 · AI 자가 보고 수치는 원본으로 쓰지 않음"
        badges={<><DemoChip on={demoMode} /><Badge tone="neutral">{projects.length}개</Badge></>}
        actions={<TextInput aria-label="프로젝트 필터" placeholder="이름으로 필터" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} />}
      />
      {demoMode ? <DemoNote /> : null}

      {!demoMode && res.state.kind !== "ready" ? (
        <ResourceView state={res.state} onRetry={res.reload}>{() => null}</ResourceView>
      ) : null}

      <div className="air-grid-auto air-stagger">
        {visible.map((project) => (
          <Reveal as="article" kind="pop" key={project.project_id}>
            <Card pad="md" className="air-hover-lift">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="air-avatar" data-ring={project.status === "active" ? "thinking" : "offline"} style={{ width: 30, height: 30, fontSize: 11 }}>
                  <Icon name="project" size={14} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 13 }}>{project.name}</div>
                  <div className="air-hint air-mono">{project.project_id}</div>
                </div>
                <Badge tone={project.status === "active" ? "ok" : project.status === "paused" ? "warn" : "neutral"}>{project.status}</Badge>
              </div>
              <div className="air-hint" style={{ margin: "8px 0" }}>{project.description ?? "설명 없음"}</div>
              {project.verified_progress ? (
                <VerifiedProgress done={project.verified_progress.done} total={project.verified_progress.total} blocked={project.verified_progress.blocked} />
              ) : (
                <span className="air-hint">진행률 데이터 없음 (UNAVAILABLE)</span>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                <Button size="sm" icon="board" onClick={() => navigate("TASKBOARD", { id: project.project_id })}>보드</Button>
                <Button size="sm" variant="ghost" icon="code" onClick={() => navigate("EDITOR", { id: project.project_id })}>IDE</Button>
                <Button size="sm" variant="ghost" icon="report" onClick={() => navigate("PROJECTOV", { id: project.project_id })}>개요</Button>
              </div>
              <div className="air-hint" style={{ marginTop: 6 }}>업데이트 {project.updated_at ? relativeTime(project.updated_at) : "기록 없음"}</div>
            </Card>
          </Reveal>
        ))}
        {visible.length === 0 ? <EmptyHint icon="project" title="프로젝트가 없습니다" detail="서버에서 프로젝트를 받지 못했거나 아직 생성되지 않았습니다." /> : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- PROJECTOV */

export function ProjectOverviewScreen({ params, navigate }: { params: Record<string, string>; navigate: Navigate }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const res = useResource<ProjectSummary>(client, `/v1/projects/${encodeURIComponent(projectId)}`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const project = demoMode ? demoProjects.find((p) => p.project_id === projectId) ?? demoProjects[0]! : res.state.kind === "ready" ? res.state.data : null;
  const [tab, setTab] = useState("overview");
  const tasks = demoMode ? demoTasks.filter((t) => t.project_id === projectId) : [];

  return (
    <div className="air-screen air-screen-wide">
      <ScreenHeader
        title={project?.name ?? "프로젝트 개요"}
        subtitle={project?.description ?? "서버에서 프로젝트를 불러오지 못했습니다"}
        badges={<><DemoChip on={demoMode} /><Badge tone="neutral">{projectId}</Badge>{project?.repo ? <Badge tone="info" icon="branch">{project.repo.owner}/{project.repo.name}</Badge> : null}</>}
        actions={
          <>
            <Button icon="board" onClick={() => navigate("TASKBOARD", { id: projectId })}>작업 보드</Button>
            <Button icon="graph" variant="ghost" onClick={() => navigate("DEPENDENCIES", { id: projectId })}>의존성</Button>
            <Button icon="ci" variant="ghost" onClick={() => navigate("CI", { id: projectId })}>빌드</Button>
          </>
        }
      />
      <Tabs
        label="프로젝트 화면"
        value={tab}
        onChange={setTab}
        items={[{ id: "overview", label: "개요" }, { id: "metrics", label: "지표" }, { id: "reports", label: "보고서" }]}
      />

      {tab === "overview" ? (
        <>
          <div className="air-grid-2">
            <Section title="목표·요구사항" sub="검증 상태는 근거가 있을 때만 완료로 집계">
              <div style={{ display: "grid", gap: 6 }}>
                {(demoMode ? ["Q001 웹·EXE·APK 산출물", "Q003 AI 제공자 실제 연결", "Q010 구조화 블록 108개", "Q034 Monaco+Yjs IDE", "Q039 미연결 AI 정직 표시"] : []).map((req) => (
                  <div key={req} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                    <Icon name="approval" size={13} style={{ opacity: 0.7 }} />
                    <span style={{ flex: 1 }}>{req}</span>
                    <Badge tone="neutral" shape="dashed">상태 미확인</Badge>
                  </div>
                ))}
                {!demoMode ? <span className="air-hint">요구사항 데이터 없음(서버 미연결)</span> : null}
              </div>
            </Section>
            <Section title="AI 배정" sub="이 프로젝트에 참여한 AI">
              <div style={{ display: "grid", gap: 6 }}>
                {(demoMode ? demoAgents.filter((a) => a.kind === "agent") : []).map((agent) => (
                  <div key={agent.agent_id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="air-avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{Array.from(agent.display_name).slice(0, 1)}</span>
                    <span style={{ flex: 1, fontSize: 12.5 }}>{agent.display_name}</span>
                    <Badge tone="neutral">작업 {tasks.filter((t) => t.owner_agent_id === agent.agent_id).length}</Badge>
                  </div>
                ))}
                {!demoMode ? <span className="air-hint">배정 정보 없음</span> : null}
              </div>
            </Section>
          </div>

          <Section title="작업 요약" sub={`${tasks.length}건 · 차단 ${tasks.filter((t) => t.status === "BLOCKED").length}건`}>
            <div className="air-grid-auto">
              {tasks.slice(0, 6).map((task) => (
                <Card key={task.task_id} pad="sm">
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{task.title}</div>
                  <div className="air-hint">{task.task_id} · {task.status}</div>
                </Card>
              ))}
              {tasks.length === 0 ? <span className="air-hint">작업 데이터 없음</span> : null}
            </div>
          </Section>
        </>
      ) : null}

      {tab === "metrics" ? (
        <Section title="50+ 지표" sub="소스 데이터가 없는 지표는 UNAVAILABLE로 표시됩니다">
          <MetricGrid values={demoMode ? demoMetrics : []} demo={demoMode} />
        </Section>
      ) : null}

      {tab === "reports" ? (
        <Section title="보고서" sub="근거 링크가 검증된 보고서">
          <div style={{ display: "grid", gap: 8 }}>
            {(demoMode ? demoReports.filter((r) => !r.project_id || r.project_id === projectId) : []).map((report) => (
              <div key={report.report_id} className="air-card" data-pad="sm">
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge tone={report.kind === "blocker" ? "warn" : "info"}>{report.kind}</Badge>
                  <strong style={{ fontSize: 12.5 }}>{report.title}</strong>
                  <span style={{ flex: 1 }} />
                  <span className="air-hint">{new Date(report.created_at).toLocaleString()}</span>
                </div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>{report.summary}</div>
                <div className="air-hint">증거 {report.evidence.length}건 · {report.evidence.filter((e) => e.verified).length}건 검증</div>
              </div>
            ))}
            {!demoMode ? <span className="air-hint">보고서 없음</span> : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- TASKBOARD */

export function TaskBoardScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const res = useResource<{ tasks?: TaskDto[]; items?: TaskDto[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/tasks`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const [local, setLocal] = useState<TaskDto[] | null>(null);
  const serverTasks = demoMode ? demoTasks.filter((t) => t.project_id === projectId) : res.state.kind === "ready" ? res.state.data.tasks ?? res.state.data.items ?? [] : [];
  const tasks = local ?? serverTasks;

  const move = (task: TaskDto, status: TaskDto["status"]) => {
    setLocal((prev) => (prev ?? serverTasks).map((t) => (t.task_id === task.task_id ? { ...t, status } : t)));
    if (gatewayUrl && !demoMode) {
      void client.request("PATCH", `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.task_id)}`, { body: { status }, idempotencyKey: newIdempotencyKey("task-status") });
    }
  };

  return (
    <div className="air-screen air-screen-wide">
      <ScreenHeader
        title="작업 보드"
        subtitle="AI 자율 배정 · 진행 · 인계 · lease 충돌 알림"
        badges={<><DemoChip on={demoMode} /><Badge tone="neutral">{tasks.length}개 작업</Badge>{local ? <Badge tone="warn" shape="dashed">로컬 변경(서버 미확인)</Badge> : null}</>}
      />
      {demoMode ? <DemoNote /> : null}
      {!demoMode && res.state.kind !== "ready" ? <ResourceView state={res.state} onRetry={res.reload}>{() => null}</ResourceView> : null}
      <Kanban
        tasks={tasks}
        onMove={move}
        agents={(demoMode ? demoAgents.filter((a) => a.kind === "agent") : []).map((a) => ({ agent_id: a.agent_id, display_name: a.display_name }))}
        onReassign={(task, agentId) => setLocal((prev) => (prev ?? serverTasks).map((t) => (t.task_id === task.task_id ? { ...t, owner_agent_id: agentId } : t)))}
      />
      <Banner tone="info" icon="info">드래그·선택 모두 같은 API를 호출합니다. 서버가 거부하면 원래 상태로 되돌리고 이유를 표시합니다(현재는 로컬 변경으로 표시).</Banner>
    </div>
  );
}

/* ------------------------------------------------------------- DEPENDENCIES */

export function DependenciesScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const res = useResource<{ tasks?: TaskDto[]; items?: TaskDto[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/tasks`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const tasks = demoMode ? demoTasks.filter((t) => t.project_id === projectId) : res.state.kind === "ready" ? res.state.data.tasks ?? res.state.data.items ?? [] : [];
  const nodes = useMemo(
    () => tasks.map((t) => ({ task_id: t.task_id, title: t.title, status: t.status, depends_on: t.dependencies ?? [] })),
    [tasks],
  );

  return (
    <div className="air-screen">
      <ScreenHeader title="의존성 그래프" subtitle="선행 작업과 지연 이유 · 순환 의존은 즉시 경고" badges={<DemoChip on={demoMode} />} />
      {nodes.length === 0 ? (
        <EmptyHint icon="graph" title="의존성 데이터 없음" detail="서버에서 작업 목록을 받지 못했습니다." />
      ) : (
        <DependencyGraph nodes={nodes} />
      )}
      <Section title="차단된 작업" sub="선행 조건이 남아 있는 작업">
        <div style={{ display: "grid", gap: 6 }}>
          {tasks.filter((t) => t.status === "BLOCKED").map((task) => (
            <div key={task.task_id} className="air-card" data-pad="sm" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Badge tone="warn">BLOCKED</Badge>
              <span style={{ flex: 1 }}>{task.title}</span>
              <span className="air-hint">선행 {task.dependencies?.length ?? 0}건</span>
            </div>
          ))}
          {tasks.filter((t) => t.status === "BLOCKED").length === 0 ? <span className="air-hint">차단된 작업 없음</span> : null}
        </div>
      </Section>
    </div>
  );
}

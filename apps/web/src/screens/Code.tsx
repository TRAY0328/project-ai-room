import { useCallback, useMemo, useState } from "react";
import { Badge, Banner, Button, Card, Dialog, Field, Icon, Reveal, SectionHeader, Tabs, TextArea, TextInput } from "@ai-room/design-system";
import { DiffViewer } from "@ai-room/editor/diff";
import { ReviewPanel, type ReviewState } from "@ai-room/editor/review";
import { CIPanel } from "@ai-room/editor/ci";
import { TerminalPanel } from "@ai-room/editor/terminal";
import type { CiRun } from "@ai-room/editor/ci";
import type { TerminalSession } from "@ai-room/editor/terminal";
import type { TreeNode } from "@ai-room/editor/tree";
import { parseUnifiedDiff } from "@ai-room/message-blocks";
import { useApp } from "../state/AppState.js";
import { useResource, relativeTime } from "../api/hooks.js";
import { uploadFile, type UploadProgress } from "../api/upload.js";
import type { ArtifactDto, BranchDto, FileDto, PullRequestDto } from "../api/types.js";
import { demoArtifacts, demoBranches, demoDiff, demoFileContent, demoFiles, demoPullRequests, demoTree } from "../demo/fixtures.js";
import { ArtifactTable, CodeActions, FileDropzone, FileList, FilePreviewDialog } from "../components/files.js";
import { DemoChip, DemoNote, EmptyHint, ResourceView, ScreenHeader, Section } from "../components/ui.js";

/* --------------------------------------------------------------- SOURCETREE */

export function SourceTreeScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const branchesRes = useResource<{ branches?: BranchDto[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/git/branches`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const branches = demoMode ? demoBranches : branchesRes.state.kind === "ready" ? branchesRes.state.data.branches ?? [] : [];
  const [branch, setBranch] = useState(branches[0]?.name ?? "main");

  return (
    <div className="air-screen">
      <ScreenHeader title="Git 탐색" subtitle="브랜치·파일·커밋 이력 — 서버 파일시스템 Git 의존 없음" badges={<DemoChip on={demoMode} />} />
      <div className="air-grid-2">
        <Section title="브랜치" sub={`${branches.length}개`}>
          <div style={{ display: "grid", gap: 6 }}>
            {branches.map((b) => (
              <button key={b.name} type="button" className="air-mention-item" aria-selected={b.name === branch} onClick={() => setBranch(b.name)} style={{ border: "1px solid var(--air-line)", borderRadius: 8 }}>
                <Icon name="branch" size={13} />
                <span style={{ flex: 1 }}>{b.name}</span>
                {b.protected ? <Badge tone="info">protected</Badge> : null}
                <span className="air-mono air-hint">{b.sha.slice(0, 8)}</span>
                {typeof b.ahead === "number" ? <Badge tone="neutral">ahead {b.ahead}</Badge> : null}
              </button>
            ))}
            {branches.length === 0 ? <span className="air-hint">브랜치 정보 없음</span> : null}
          </div>
        </Section>
        <Section title="선택한 브랜치" sub={branch}>
          <div className="air-hint">파일 트리는 IDE 화면에서 열 수 있습니다.</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <a className="air-btn" data-size="sm" href={`vscode://vscode.git/clone?url=${encodeURIComponent(`https://github.com/TRAY0328/project-ai-room`)}`}>
              <Icon name="external" size={12} /> VS Code에서 열기
            </a>
            <span className="air-hint" style={{ alignSelf: "center" }}>로컬 브리지 설치 불필요 · 선택적 호환</span>
          </div>
        </Section>
      </div>

      <Section title="최근 커밋" sub="브랜치 head 기준">
        <div style={{ display: "grid", gap: 6 }}>
          {demoMode ? (
            <>
              <div className="air-card" data-pad="sm" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="air-mono">{demoBranches[1]!.sha.slice(0, 8)}</span>
                <span style={{ flex: 1 }}>feat: 웹 IDE + Yjs 동시 편집</span>
                <Badge tone="neutral">agent-claude</Badge>
                <span className="air-hint">{relativeTime(new Date(Date.now() - 3600_000).toISOString())}</span>
              </div>
              <div className="air-card" data-pad="sm" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="air-mono">{demoBranches[0]!.sha.slice(0, 8)}</span>
                <span style={{ flex: 1 }}>fix: 프로토콜 상대 URL 차단</span>
                <Badge tone="neutral">agent-gemini</Badge>
                <span className="air-hint">{relativeTime(new Date(Date.now() - 7200_000).toISOString())}</span>
              </div>
            </>
          ) : (
            <span className="air-hint">커밋 목록은 서버 Git API에서만 가져옵니다.</span>
          )}
        </div>
      </Section>

      <Section title="변경 Diff" sub="통합 diff 원문 그대로 표시">
        <DiffViewer diff={demoMode ? demoDiff : ""} maxRows={400} />
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------- REVIEW */

export function ReviewScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const prRes = useResource<{ pull_requests?: PullRequestDto[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/git/pull-requests`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const prs = demoMode ? demoPullRequests : prRes.state.kind === "ready" ? prRes.state.data.pull_requests ?? [] : [];
  const [selected, setSelected] = useState<number | null>(prs[0]?.number ?? null);
  const pr = prs.find((p) => p.number === selected) ?? prs[0] ?? null;
  const [comments, setComments] = useState<ReviewState["comments"]>([]);
  const [approvals, setApprovals] = useState<ReviewState["approvals"]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const diff = demoMode && pr ? demoDiff : "";
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);

  const review: ReviewState | null = pr
    ? {
        number: pr.number,
        title: pr.title,
        headSha: pr.head_sha,
        baseSha: pr.base_sha,
        state: pr.state,
        checks: pr.checks,
        risk: pr.risk,
        comments,
        approvals,
        checklist: [
          { id: "c1", label: "필수 CI 성공 확인", done: pr.checks === "success", evidence: pr.checks === "success" ? "checks=success" : undefined },
          { id: "c2", label: "보안 영향 검토", done: comments.some((c) => /보안|security/i.test(c.body)), evidence: comments.some((c) => /보안|security/i.test(c.body)) ? "코멘트에 근거" : undefined },
          { id: "c3", label: "테스트 추가/갱신", done: parsed.rows.some((r) => (r.path ?? "").includes("test")), evidence: parsed.rows.some((r) => (r.path ?? "").includes("test")) ? "테스트 파일 변경" : undefined },
          { id: "c4", label: "문서 갱신", done: parsed.rows.some((r) => (r.path ?? "").endsWith(".md")), evidence: undefined },
        ],
      }
    : null;

  return (
    <div className="air-screen air-screen-wide">
      <ScreenHeader
        title="코드 리뷰"
        subtitle="Diff · 줄 코멘트 · SHA 고정 승인 · 위험 변경은 사람 승인"
        badges={<><DemoChip on={demoMode} /><Badge tone="neutral">{prs.length}개 PR</Badge></>}
      />
      <Section title="PR 목록" sub="open/draft/merged 상태">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {prs.map((item) => (
            <button key={item.number} type="button" className="air-btn" data-variant={item.number === selected ? "primary" : "default"} onClick={() => setSelected(item.number)}>
              #{item.number} {item.title}
            </button>
          ))}
          {prs.length === 0 ? <span className="air-hint">PR 정보 없음</span> : null}
        </div>
      </Section>

      {review ? (
        <div data-testid="review-checklist">
          <ReviewPanel
            review={review}
            diff={diff}
            onAddComment={(anchor, body) => {
              setComments((prev) => [...prev, { id: `c-${prev.length + 1}`, path: anchor.path, side: anchor.side, line: anchor.line, head_sha: review.headSha, author: "owner", body, created_at: new Date().toISOString() }]);
              if (gatewayUrl && !demoMode) {
                void client.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/git/reviews`, { body: { pr_number: review.number, path: anchor.path, side: anchor.side, line: anchor.line, body, head_sha: review.headSha } });
              }
              setToast("코멘트 추가됨(로컬 표시) — 서버 반영 여부는 응답으로 확인하세요");
            }}
            onApprove={(sha) => {
              setApprovals((prev) => [...prev.filter((a) => a.reviewer !== "owner"), { reviewer: "owner", sha, decision: "approved", at: new Date().toISOString() }]);
              setToast(`승인 기록: ${sha.slice(0, 8)} 에만 유효`);
            }}
            onRequestChanges={(sha) => {
              setApprovals((prev) => [...prev.filter((a) => a.reviewer !== "owner"), { reviewer: "owner", sha, decision: "changes_requested", at: new Date().toISOString() }]);
              setToast("변경 요청 기록됨");
            }}
            onMerge={(sha) => {
              if (gatewayUrl && !demoMode) void client.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/git/merge`, { body: { pr_number: review.number, head_sha: sha } });
              setToast("병합 요청 전송 — 결과는 PR 상태로 확인됩니다");
            }}
          />
        </div>
      ) : (
        <EmptyHint icon="review" title="PR이 없습니다" detail="서버에서 PR을 받지 못했습니다." />
      )}
      {toast ? <Banner tone="info" icon="info">{toast}</Banner> : null}
    </div>
  );
}

/* ----------------------------------------------------------------------- CI */

export function CiScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode, enqueueMessage, flushOutbox } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const runsRes = useResource<{ runs?: CiRun[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/dashboard`, { enabled: Boolean(gatewayUrl) && !demoMode, pollMs: 15000 });

  const demoRuns: CiRun[] = [
    {
      id: "run-2318",
      workflow: "verify.yml",
      event: "pull_request",
      headSha: "3a1f7c9d2b8e4f6a0c5d7e9f1b3a5c7d9e1f3b5a",
      status: "SUCCEEDED",
      conclusion: "success",
      createdAt: new Date(Date.now() - 300_000).toISOString(),
      durationMs: 42_000,
      jobs: [
        {
          id: "job-1",
          name: "verify (ubuntu-24.04)",
          status: "SUCCEEDED",
          conclusion: "success",
          steps: [{ name: "checkout", status: "SUCCEEDED" }, { name: "setup-node", status: "SUCCEEDED" }, { name: "typecheck", status: "SUCCEEDED" }, { name: "test", status: "SUCCEEDED" }],
          logs: ["$ npm ci", "added 181 packages", "$ npx tsc -p tsconfig.json --noEmit", "$ node --test test/*.test.mjs", "# tests 37", "# pass 36", "# fail 1", "1 failing check: app manifestation (expected before web tests)"],
          artifacts: [{ name: "web-dist.zip", size: 742_112, sha256: "a".repeat(64), hashStatus: "verified", downloadUrl: "https://example.com/a.zip" }],
        },
      ],
    },
    {
      id: "run-2319",
      workflow: "build-web.yml",
      event: "workflow_dispatch",
      headSha: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
      status: "RUNNING",
      conclusion: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: null,
      jobs: [{ id: "job-2", name: "build", status: "RUNNING", conclusion: null, logs: ["$ npm run build", "vite building…"], artifacts: [] }],
    },
    {
      id: "run-2320",
      workflow: "build-windows.yml",
      event: "workflow_dispatch",
      headSha: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
      status: "BLOCKED",
      conclusion: null,
      createdAt: new Date(Date.now() - 30_000).toISOString(),
      durationMs: null,
      jobs: [],
    },
  ];

  const runs = demoMode ? demoRuns : runsRes.state.kind === "ready" ? runsRes.state.data.runs ?? [] : [];

  const sessions: TerminalSession[] = demoMode
    ? [
        { id: "ts-1", jobId: "job-1", runner: "ubuntu-24.04 (GitHub-hosted)", state: "SUCCEEDED", supportsPty: false, startedAt: new Date(Date.now() - 300_000).toISOString(), lines: ["$ npm test", "PASS 37", "done"] },
        { id: "ts-2", jobId: "job-2", runner: "ubuntu-24.04 (GitHub-hosted)", state: "RUNNING", supportsPty: false, startedAt: new Date(Date.now() - 60_000).toISOString(), lines: ["$ npm run build", "vite v5.4.11 building for production..."] },
      ]
    : [];

  const undoMessage = async (runId: string) => {
    enqueueMessage("room-default", [{ type: "markdown", version: 1, payload: { markdown: `실행 취소 요청: \`${runId}\` — Actions 실행을 취소했습니다. 대체 실행이 필요하면 재실행을 요청하세요.` } }]);
    await flushOutbox();
  };

  return (
    <div className="air-screen air-screen-wide">
      <ScreenHeader
        title="빌드 · 테스트"
        subtitle="GitHub Actions 실제 실행 기록 · 실행 전 상태를 성공으로 표시하지 않음"
        badges={<><DemoChip on={demoMode} /><Badge tone="neutral">{runs.length}개 실행</Badge></>}
        actions={<Button size="sm" icon="terminal" onClick={() => void undoMessage(runs[0]?.id ?? "run")} data-testid="ci-undo-message">실행 취소 메시지 보내기</Button>}
      />
      {demoMode ? <DemoNote /> : null}
      {!demoMode && runsRes.state.kind !== "ready" ? <ResourceView state={runsRes.state} onRetry={runsRes.reload}>{() => null}</ResourceView> : null}
      <CIPanel
        runs={runs}
        canWrite={false}
        onDispatch={(wf) => void client.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/jobs`, { body: { workflow: wf } })}
      />
      <TerminalPanel sessions={sessions} onSubmit={(command) => void client.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/jobs`, { body: { command } })} />
    </div>
  );
}

/* -------------------------------------------------------------------- DEBUG */

export function DebugScreen() {
  const { demoMode } = useApp();
  return (
    <div className="air-screen">
      <ScreenHeader title="디버깅" subtitle="스택·로그·재현 테스트 · 지원 범위를 그대로 표시" badges={<><DemoChip on={demoMode} /><Badge tone="neutral" shape="dashed">라이브 브레이크포인트 미지원</Badge></>} />
      <Banner tone="warn" icon="warning">
        원격 디버그 프로토콜이 확보되지 않은 러너에서는 <strong>라이브 브레이크포인트/변수 조회를 제공하지 않습니다.</strong> 대신 스택 트레이스·로그·재현 테스트로 안내합니다.
      </Banner>
      <Card>
        <SectionHeader title="지원 매트릭스" sub="언어·러너별 실제 지원" />
        <div className="air-table-wrap">
        <div className="air-table-hint">가로로 밀어서 전체 열을 볼 수 있습니다</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }} aria-label="디버깅 지원 매트릭스">
          <thead><tr>{["언어", "브레이크포인트", "변수 조회", "스택/로그", "재현 테스트"].map((h) => <th key={h} scope="col" style={{ textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--air-line)", color: "var(--air-text-muted)" }}>{h}</th>)}</tr></thead>
          <tbody>
            {[
              ["TypeScript/Node", "미지원", "미지원", "지원", "지원"],
              ["Python", "미지원", "미지원", "지원", "지원"],
              ["Kotlin/Android", "미지원", "미지원", "지원(빌드 로그)", "부분"],
            ].map((row) => (
              <tr key={row[0]}>
                {row.map((cell, i) => <td key={i} style={{ padding: "6px 10px", borderBottom: "1px solid var(--air-line)" }}>{cell === "지원" ? <Badge tone="ok">지원</Badge> : cell === "미지원" ? <Badge tone="neutral" shape="dashed">미지원</Badge> : <Badge tone="warn">부분</Badge>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>
      <Section title="최근 실패 분석" sub="로그에서 추출한 스택 (데모)">
        {demoMode ? (
          <pre className="mb-code" style={{ border: "1px solid var(--air-line)", borderRadius: 10 }}>{`AssertionError [ERR_ASSERTION]: dangerous tag <script> survived
    at assertSafeTree (packages/message-blocks/test/security.test.mjs:41:11)
    at TestContext.<anonymous> (packages/message-blocks/test/security.test.mjs:99:5)
  — 재현: node --test test/security.test.mjs
  — 원인 후보: sanitize.ts 의 DROP_WITH_CONTENT 처리 순서`}</pre>
        ) : (
          <span className="air-hint">실패 로그 없음(서버 미연결)</span>
        )}
      </Section>
    </div>
  );
}

/* ---------------------------------------------------------------- ARTIFACTS */

export function ArtifactsScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const res = useResource<{ artifacts?: ArtifactDto[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/artifacts`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const artifacts = demoMode ? demoArtifacts : res.state.kind === "ready" ? res.state.data.artifacts ?? [] : [];
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="air-screen">
      <ScreenHeader title="산출물" subtitle="버전·SHA-256·검증 상태 · 없는 EXE/APK를 표시하지 않음" badges={<DemoChip on={demoMode} />} />
      {note ? <Banner tone="info" icon="info">{note}</Banner> : null}
      <Card>
        <SectionHeader title="아티팩트" sub={`${artifacts.length}건`} />
        <ArtifactTable
          artifacts={artifacts}
          onVerify={(artifact) => {
            if (gatewayUrl && !demoMode) {
              void client.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/verify`, { body: { sha256: artifact.sha256 } });
              setNote("해시 검증 요청 전송 — 결과는 서버 응답으로 갱신됩니다");
            } else {
              setNote("게이트웨이 미연결 — 해시 검증은 서버에서만 수행됩니다");
            }
          }}
          onDownload={(artifact) => {
            if (gatewayUrl && !demoMode) {
              void client.request<{ url: string }>("POST", `/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/download-intent`, { body: {} }).then((r) => {
                if (r.ok) window.open(r.data.url, "_blank", "noopener,noreferrer");
                else setNote(`${r.code}: ${r.message}`);
              });
            } else {
              setNote("데모/미연결 모드 — 실제 다운로드 링크를 만들지 않았습니다");
            }
          }}
        />
      </Card>
      <Banner tone="warn" icon="warning">서명 인증서가 없으면 미서명임을 표시하며 OS 경고를 숨기지 않습니다.</Banner>
    </div>
  );
}

/* -------------------------------------------------------------------- FILES */

export function FilesScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const res = useResource<{ files?: FileDto[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/files/tree`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const files = demoMode ? demoFiles : res.state.kind === "ready" ? res.state.data.files ?? [] : [];
  const [preview, setPreview] = useState<FileDto | null>(null);
  const [downloading, setDownloading] = useState<{ assetId: string; received: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const uploader = useCallback(
    async (file: File, onProgress: (p: UploadProgress) => void) => {
      if (!gatewayUrl || demoMode) return { ok: false, message: "게이트웨이 미연결 — 업로드를 보낼 수 없습니다" };
      const result = await uploadFile(client, file, { onProgress });
      return result.ok ? { ok: true, data: result.data } : { ok: false, message: `${result.code}: ${result.message}` };
    },
    [client, gatewayUrl, demoMode],
  );

  const download = async (file: FileDto) => {
    if (!gatewayUrl || demoMode) {
      setNote("데모/미연결 모드 — 다운로드 링크를 발급하지 않았습니다");
      return;
    }
    const intent = await client.request<{ url: string; size?: number }>("GET", `/v1/files/${encodeURIComponent(file.asset_id)}/download-intent`);
    if (!intent.ok) {
      setNote(`${intent.code}: ${intent.message}`);
      return;
    }
    const total = intent.data.size ?? file.size;
    setDownloading({ assetId: file.asset_id, received: 0, total });
    try {
      const response = await fetch(intent.data.url, { credentials: "include" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength;
          setDownloading({ assetId: file.asset_id, received, total });
        }
      }
      const blob = new Blob(chunks as BlobPart[], { type: file.mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      URL.revokeObjectURL(url);
      setNote(`다운로드 완료 · ${(received / 1024).toFixed(1)}KB`);
    } catch (error) {
      setNote(`다운로드 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="air-screen">
      <ScreenHeader title="프로젝트 파일" subtitle="업로드·안전 미리보기·권한형 다운로드 · MIME/격리 검사" badges={<DemoChip on={demoMode} />} />
      {note ? <Banner tone="info" icon="info">{note}</Banner> : null}
      <div className="air-grid-2">
        <Section title="업로드" sub="SHA-256 계산 후 완료 처리">
          <FileDropzone uploader={uploader} disabled={!gatewayUrl || demoMode} onUploaded={(outcome) => setNote(`업로드 완료 · ${outcome.asset_id} sha256 ${outcome.sha256.slice(0, 12)}…`)} />
        </Section>
        <Section title="권한 범위" sub="다운로드는 짧은 수명 링크">
          <div style={{ display: "grid", gap: 6 }}>
            <Badge tone="info">현재 세션: owner</Badge>
            <div className="air-hint">공유 범위를 넘는 파일은 링크가 발급되지 않습니다. 링크 만료 시간은 서버가 정합니다.</div>
            <CodeActions code={"# 샘플 스니펫"} filename="snippet.txt" />
          </div>
        </Section>
      </div>
      <Card>
        <SectionHeader title="파일 목록" sub={`${files.length}건`} />
        <div style={{ padding: 12 }}>
          <FileList files={files} onPreview={setPreview} onDownload={(file) => void download(file)} downloading={downloading} />
        </div>
      </Card>
      {preview ? (
        <Dialog open onClose={() => setPreview(null)} title="안전 미리보기" description="HTML/SVG/PDF는 실행·임베드하지 않습니다">
          <FilePreviewDialog file={preview} onClose={() => setPreview(null)} />
        </Dialog>
      ) : null}
    </div>
  );
}

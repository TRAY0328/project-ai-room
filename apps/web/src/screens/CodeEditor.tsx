import { useCallback, useState } from "react";
import { Badge, Button, Dialog, Field, Icon, SectionHeader, Tabs, TextArea, TextInput, Card, Banner } from "@ai-room/design-system";
import { FileTree, MonacoYjsEditor } from "@ai-room/editor";
import { useApp } from "../state/AppState.js";
import { useResource } from "../api/hooks.js";
import { newIdempotencyKey } from "../api/client.js";
import type { TreeNode } from "@ai-room/editor";
import { demoFileContent, demoTree } from "../demo/fixtures.js";
import { DemoChip, ScreenHeader } from "../components/ui.js";

type Navigate = (id: never, params?: Record<string, string>) => void;

/* ------------------------------------------------------------------- EDITOR */

export function EditorScreen({ params }: { params: Record<string, string> }) {
  const { client, gatewayUrl, demoMode, enqueueMessage, flushOutbox } = useApp();
  const projectId = params.id ?? "proj-ai-room";
  const treeRes = useResource<{ nodes?: TreeNode[]; items?: TreeNode[] }>(client, `/v1/projects/${encodeURIComponent(projectId)}/ide/tree`, { enabled: Boolean(gatewayUrl) && !demoMode });
  const tree = demoMode ? (demoTree as unknown as TreeNode[]) : treeRes.state.kind === "ready" ? treeRes.state.data.nodes ?? treeRes.state.data.items ?? [] : [];
  const [path, setPath] = useState("packages/editor/src/collab.ts");
  const [tab, setTab] = useState("chat");
  const [publishOpen, setPublishOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [publishResult, setPublishResult] = useState<string | null>(null);

  const content = demoMode ? demoFileContent[path] ?? `// ${path}\n// 데모 모드: 이 파일의 내용은 픽스처입니다.\n` : "";

  const publish = async () => {
    if (!gatewayUrl || demoMode) {
      setPublishResult("게이트웨이 미연결 또는 데모 모드 — 커밋을 생성하지 않았습니다.");
      return;
    }
    const res = await client.request<{ commit_sha?: string; pr_number?: number }>("POST", `/v1/projects/${encodeURIComponent(projectId)}/ide/publish`, {
      body: { doc_id: path, message, base_sha: null },
      idempotencyKey: newIdempotencyKey("publish"),
    });
    setPublishResult(res.ok ? `커밋 생성: ${res.data.commit_sha ?? "(SHA 미제공)"}` : `${res.code}: ${res.message}`);
  };

  return (
    <div className="air-screen air-screen-wide" style={{ height: "100%" }}>
      <ScreenHeader
        title="웹 IDE"
        subtitle="Monaco + Yjs CRDT · 실제 인증 사용자가 연결된 경우에만 커서 표시"
        badges={<><DemoChip on={demoMode} /><Badge tone="neutral" shape="dashed">{gatewayUrl ? "collab WS 사용 가능" : "로컬 편집 모드"}</Badge></>}
        actions={<Button icon="merge" onClick={() => setPublishOpen(true)}>커밋/PR</Button>}
      />

      <div className="air-ide-layout">
        <div style={{ display: "grid", gap: 10 }}>
          <FileTree
            nodes={tree}
            activePath={path}
            onOpen={(node) => setPath(node.path)}
            height={320}
            title="저장소"
          />
          <Card pad="sm">
            <div className="air-section-title" style={{ marginBottom: 6 }}>빠른 파일</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <Button size="sm" variant="ghost" onClick={() => setPath("packages/message-blocks/src/url.ts")}>url.ts</Button>
              <Button size="sm" variant="ghost" onClick={() => setPath("packages/editor/src/collab.ts")}>collab.ts</Button>
              <Button size="sm" variant="ghost" onClick={() => setPath("apps/web/src/main.tsx")}>main.tsx</Button>
            </div>
          </Card>
        </div>

        <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
          <MonacoYjsEditor
            docKey={`${projectId}:${path}`}
            path={path}
            initialValue={content}
            collabUrl={gatewayUrl && !demoMode ? client.wsUrl ?? undefined : undefined}
            height={520}
            onSaveRequest={(value) => {
              setMessage(`update ${path}`);
              void value;
              setPublishOpen(true);
            }}
          />
          <Card pad="sm">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Badge tone="neutral">Yjs 상태 병합만 보장</Badge>
              <span className="air-hint">의미 충돌·API 호환성·빌드 오류는 PR/CI에서 별도 검사합니다.</span>
            </div>
          </Card>
        </div>

        <Card>
          <Tabs
            label="IDE 보조 패널"
            value={tab}
            onChange={setTab}
            items={[{ id: "chat", label: "채팅" }, { id: "tasks", label: "작업" }, { id: "run", label: "실행" }]}
          />
          <div style={{ padding: 10, display: "grid", gap: 8, maxHeight: 520, overflow: "auto" }}>
            {tab === "chat" ? (
              <>
                <div className="air-hint">프로젝트 대화 스냅샷 · 실시간 스트림은 방 화면에서</div>
                <TextArea aria-label="IDE 메모 전송" placeholder="방으로 보낼 메모" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
                <Button size="sm" icon="send" onClick={async () => { if (!message.trim()) return; enqueueMessage("room-default", [{ type: "markdown", version: 1, payload: { markdown: `\`${path}\` · ${message}` } }]); await flushOutbox(); setMessage(""); }}>방에 공유</Button>
              </>
            ) : null}
            {tab === "tasks" ? <div className="air-hint">작업 보드에서 상세 관리 — 이 패널은 현재 작업 목록 API만 읽습니다.</div> : null}
            {tab === "run" ? (
              <div style={{ display: "grid", gap: 6 }}>
                <Badge tone="neutral" shape="dashed">터미널은 CI 화면에서</Badge>
                <div className="air-hint">Cloudflare Worker에서 셸 실행 없음 · Actions 러너 요청만 지원</div>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <Dialog
        open={publishOpen}
        onClose={() => { setPublishOpen(false); setPublishResult(null); }}
        title="커밋 / PR 생성"
        description="변경은 브랜치 → 커밋 → PR 순서로 만들어집니다"
        footer={<><Button variant="ghost" onClick={() => setPublishOpen(false)}>취소</Button><Button variant="primary" onClick={() => void publish()}>요청</Button></>}
      >
        <div style={{ display: "grid", gap: 10 }}>
          <Field label="커밋 메시지" htmlFor="commit-msg" required><TextInput id="commit-msg" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`update ${path}`} /></Field>
          <Banner tone="info" icon="info">base SHA 확인 → blob/tree/commit 생성 → fast-forward 검사. 409 충돌 시 덮어쓰지 않습니다.</Banner>
          {publishResult ? <Banner tone="warn" icon="info">{publishResult}</Banner> : null}
        </div>
      </Dialog>
    </div>
  );
}


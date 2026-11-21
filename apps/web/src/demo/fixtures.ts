/**
 * Demo fixtures — explicitly opt-in and labelled everywhere.
 *
 * Why this exists: the app must be demonstrable before a gateway deployment, and
 * an empty screen cannot show whether a panel works. Everything returned here is
 * tagged `source: "demo"`, the shell shows a persistent banner, and each value is
 * rendered with a DEMO chip. Nothing here is ever written back as if it came
 * from the server.
 */
import type {
  AgentSummary,
  AlertDto,
  ApprovalDto,
  ArtifactDto,
  AuditEntryDto,
  BackupDto,
  BranchDto,
  ConnectionDto,
  FileDto,
  MemoryRecordDto,
  MessageDto,
  MetricDto,
  ProjectSummary,
  PullRequestDto,
  ReleaseGateDto,
  ReportDto,
  RoomSummary,
  SearchHitDto,
  TaskDto,
} from "../api/types.js";

export const DEMO_SOURCE = "demo" as const;

const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const SHA_A = "3a1f7c9d2b8e4f6a0c5d7e9f1b3a5c7d9e1f3b5a7c9d1e3f5a7b9c1d3e5f7a9b";
const SHA_B = "9f8e7d6c5b4a39281706f5e4d3c2b1a0987654321fedcba9876543210fedcba";

export const demoAgents: AgentSummary[] = [
  { agent_id: "agent-chatgpt", display_name: "ChatGPT", kind: "agent", provider: "openai", attestation: "self_declared", status: "active", created_at: t(2400) },
  { agent_id: "agent-claude", display_name: "Claude", kind: "agent", provider: "anthropic", attestation: "self_declared", status: "active", created_at: t(2200) },
  { agent_id: "agent-gemini", display_name: "Gemini", kind: "agent", provider: "google", attestation: "provider_verified", status: "active", created_at: t(1200) },
  { agent_id: "owner", display_name: "천예준 (owner)", kind: "owner", attestation: "provider_verified", status: "active", created_at: t(5000) },
];

export const demoRooms: RoomSummary[] = [
  { room_id: "room-default", name: "기본 단체방", kind: "default", member_count: 4, unread_count: 3, last_message_at: t(4), pinned: true, topic: "모든 AI가 모이는 기본 방" },
  { room_id: "room-project-ai-room", name: "AI ROOM 개발", kind: "project", project_id: "proj-ai-room", member_count: 3, unread_count: 0, last_message_at: t(38) },
  { room_id: "room-content", name: "콘텐츠 제작", kind: "custom", member_count: 2, unread_count: 12, last_message_at: t(180) },
];

export const demoMessages: MessageDto[] = [
  {
    message_id: "msg-1",
    room_id: "room-default",
    room_seq: 101,
    author: { actor_id: "owner", display_name: "천예준", kind: "owner" },
    blocks: [
      { type: "markdown", version: 1, payload: { markdown: "**오늘 목표** — 웹 IDE와 승인 센터까지 끝내기.\n\n- [x] 메시지 블록 엔진\n- [ ] Yjs 동시 편집 실기기 확인\n- [ ] Actions 빌드 증거 첨부" } },
    ],
    created_at: t(52),
    delivery: "server_stored",
    reactions: { "👍": 2, "🚀": 1 },
  },
  {
    message_id: "msg-2",
    room_id: "room-default",
    room_seq: 102,
    author: { actor_id: "agent-gemini", display_name: "Gemini", kind: "agent", attestation: "provider_verified" },
    blocks: [
      { type: "markdown", version: 1, payload: { markdown: "동시 편집 바인딩은 `Y.Doc` → `Y.Text` → Monaco model 순서로 붙이면 커서 충돌이 줄어듭니다." } },
      { type: "code", version: 1, payload: { code: "const ydoc = new Y.Doc();\nconst ytext = ydoc.getText(\"content\");\nconst binding = new MonacoBinding(ytext, model, new Set([editor]), awareness);", language: "typescript", filename: "packages/editor/src/MonacoYjsEditor.tsx", start_line: 88 } },
    ],
    created_at: t(44),
    reactions: { "🔥": 3 },
    delivery: "delivered",
    thread_root_id: null,
    reply_count: 2,
  },
  {
    message_id: "msg-3",
    room_id: "room-default",
    room_seq: 103,
    author: { actor_id: "agent-chatgpt", display_name: "ChatGPT", kind: "agent", attestation: "self_declared" },
    blocks: [
      { type: "status", version: 1, payload: { state: "BLOCKED", label: "공식 API 연결 검증", level: "warn", detail: "무료·무인 자동화 경로 증거 없음" } },
      { type: "callout", version: 1, payload: { tone: "risk", title: "주의", body: "자체신고 배지는 **공급자 검증이 아닙니다.** 연결 검사 화면에서 증거를 확인하세요." } },
    ],
    created_at: t(36),
    delivery: "server_stored",
  },
  {
    message_id: "msg-4",
    room_id: "room-default",
    room_seq: 104,
    author: { actor_id: "agent-claude", display_name: "Claude", kind: "agent", attestation: "self_declared" },
    blocks: [
      { type: "test_result", version: 1, payload: { suite: "message-blocks XSS", passed: 37, failed: 0, skipped: 0, duration_ms: 168 } },
      { type: "diff", version: 1, payload: { path: "packages/message-blocks/src/url.ts", head_sha: SHA_A.slice(0, 40), diff: `diff --git a/packages/message-blocks/src/url.ts b/packages/message-blocks/src/url.ts\n--- a/packages/message-blocks/src/url.ts\n+++ b/packages/message-blocks/src/url.ts\n@@ -18,7 +18,8 @@\n-  if (isRelativeUrl(trimmed)) return { ok: true, url: trimmed };\n-  if (trimmed.startsWith("//")) return { ok: false, reason: "protocol_relative" };\n+  // protocol-relative URLs are external: reject before relative handling\n+  if (trimmed.startsWith("//")) return { ok: false, reason: "protocol_relative" };\n+  if (isRelativeUrl(trimmed)) return { ok: true, url: trimmed };\n` } },
    ],
    created_at: t(18),
    delivery: "server_stored",
    reactions: { "✅": 4 },
  },
  {
    message_id: "msg-5",
    room_id: "room-default",
    room_seq: 105,
    author: { actor_id: "owner", display_name: "천예준", kind: "owner" },
    blocks: [{ type: "text", version: 1, payload: { text: "이 메시지는 삭제되었습니다 (tombstone 예시)." } }],
    created_at: t(120),
    deleted_at: t(110),
    delivery: "server_stored",
  },
];

export const demoProjects: ProjectSummary[] = [
  { project_id: "proj-ai-room", name: "PROJECT AI ROOM", description: "AI가 스스로 가입·대화·개발하는 클라우드 전용 협업 공간", status: "active", verified_progress: { done: 27, total: 41, blocked: 9 }, updated_at: t(6), repo: { owner: "TRAY0328", name: "project-ai-room", default_branch: "main" } },
  { project_id: "proj-shorts", name: "TRAY 쇼츠 파이프라인", description: "대본 → 렌더 → 업로드 자동화", status: "active", verified_progress: { done: 14, total: 20, blocked: 2 }, updated_at: t(400) },
  { project_id: "proj-dsm", name: "대덕소마고 준비", description: "포트폴리오·백서·면접 자료", status: "paused", verified_progress: { done: 6, total: 12, blocked: 0 }, updated_at: t(2100) },
];

export const demoTasks: TaskDto[] = [
  { task_id: "task-101", project_id: "proj-ai-room", title: "Monaco+Yjs 바인딩 실기기 검증", status: "RUNNING", owner_agent_id: "agent-gemini", risk_level: "medium", dependencies: ["task-099"], updated_at: t(12), base_sha: SHA_A },
  { task_id: "task-102", project_id: "proj-ai-room", title: "승인 센터 SHA 무효화 규칙", status: "REVIEW", owner_agent_id: "agent-claude", risk_level: "high", dependencies: [], updated_at: t(30), base_sha: SHA_A },
  { task_id: "task-103", project_id: "proj-ai-room", title: "108개 콘텐츠 기능 증명", status: "DONE", owner_agent_id: "agent-chatgpt", risk_level: "low", dependencies: [], evidence: [{ kind: "test", label: "node --test 37 PASS" }], updated_at: t(60) },
  { task_id: "task-104", project_id: "proj-ai-room", title: "Q039 AI 7종 무료 연결 증거", status: "BLOCKED", risk_level: "high", dependencies: ["task-103"], updated_at: t(90) },
  { task_id: "task-105", project_id: "proj-ai-room", title: "Windows EXE 서명 방식 결정", status: "TODO", risk_level: "medium", dependencies: [] },
  { task_id: "task-099", project_id: "proj-ai-room", title: "collab-do 동기화 프로토콜", status: "DONE", owner_agent_id: "agent-gemini", risk_level: "medium", dependencies: [], updated_at: t(120) },
];

export const demoApprovals: ApprovalDto[] = [
  { approval_id: "ap-1", action: "main 브랜치에 PR #42 병합", risk: "high", status: "pending", requested_by: "agent-claude", requested_at: t(20), action_sha256: SHA_A, impact: ["인증 미들웨어 변경", "모든 AI 세션 재로그인 필요", "프로덕션 배포 트리거"], task_id: "task-102", project_id: "proj-ai-room", expires_at: t(-120) },
  { approval_id: "ap-2", action: "R2 버킷 정책 변경", risk: "medium", status: "pending", requested_by: "agent-gemini", requested_at: t(80), action_sha256: SHA_B, impact: ["공개 다운로드 링크 만료"], project_id: "proj-ai-room" },
  { approval_id: "ap-3", action: "워크플로 권한 상향(actions: write)", risk: "high", status: "approved", requested_by: "owner", requested_at: t(600), decided_by: "owner", decided_at: t(580), action_sha256: SHA_B, impact: ["CI가 아티팩트 업로드 가능"] },
];

export const demoArtifacts: ArtifactDto[] = [
  { artifact_id: "art-1", name: "ai-room-web-dist.zip", version: 3, size: 742_112, sha256: SHA_A, hash_status: "verified", platform: "web", created_at: t(45), download_url: "https://example.com/artifacts/web-dist.zip", task_id: "task-101" },
  { artifact_id: "art-2", name: "ai-room-windows-x64-setup.exe", version: 3, size: 9_842_688, sha256: SHA_B, hash_status: "verified", platform: "windows-x64", created_at: t(300) },
  { artifact_id: "art-3", name: "ai-room-android-debug.apk", version: 2, size: 12_884_901, sha256: null, hash_status: "unverified", platform: "android", created_at: t(400) },
];

export const demoFiles: FileDto[] = [
  { asset_id: "file-1", name: "spec-summary.md", mime: "text/markdown", size: 18_204, sha256: SHA_A, created_at: t(70), uploader: "agent-chatgpt", scan: { quarantine: "clean" } },
  { asset_id: "file-2", name: "ui-reference.png", mime: "image/png", size: 284_112, sha256: SHA_B, created_at: t(140), uploader: "owner", scan: { quarantine: "clean" } },
  { asset_id: "file-3", name: "dataset.csv", mime: "text/csv", size: 4_120_992, sha256: SHA_A, created_at: t(200), uploader: "agent-gemini", scan: { quarantine: "pending", detail: "바이러스 스캔 대기" } },
];

export const demoMemory: MemoryRecordDto[] = [
  { memory_id: "mem-1", scope: "shared", scope_id: "global", text: "모든 AI 연결은 공식 문서로 검증된 경로만 사용하고, 미검증은 BLOCKED_EXTERNAL_DEPENDENCY로 표시한다.", confidence_type: "decision", author_actor_id: "owner", source_message_ids: ["msg-1"], revision: 3, created_at: t(2400), updated_at: t(300) },
  { memory_id: "mem-2", scope: "project", scope_id: "proj-ai-room", text: "웹 IDE는 Cloudflare Worker에서 셸을 실행하지 않는다. 터미널은 Actions 러너 로그/요청으로만 구현한다.", confidence_type: "decision", author_actor_id: "agent-claude", source_message_ids: ["msg-2"], revision: 2, created_at: t(1800) },
  { memory_id: "mem-3", scope: "agent", scope_id: "agent-chatgpt", text: "무료 등급에서 자율 실행이 가능할 것으로 추정되나 실측 증거 없음.", confidence_type: "hypothesis", author_actor_id: "agent-chatgpt", source_message_ids: [], revision: 1, created_at: t(900) },
];

export const demoConnections: ConnectionDto[] = [
  { connection_id: "conn-1", provider: "Google Gemini", state: "VERIFIED", attestation: "provider_verified", capabilities: { "message.receive": "verified", "message.send": "verified", "task.claim": "unsupported", "task.execute": "unknown", "code.patch": "unsupported", "git.pr.create": "unsupported", "git.review": "unknown", "artifact.read": "verified", "checkpoint.resume": "unknown" }, evidence_url: "https://ai.google.dev/gemini-api/docs/rate-limits", last_checked_at: t(60) },
  { connection_id: "conn-2", provider: "OpenAI ChatGPT", state: "NO_OFFICIAL_EVIDENCE", attestation: "self_declared", capabilities: { "message.receive": "unknown", "message.send": "unknown", "task.claim": "unknown", "task.execute": "unknown", "code.patch": "unknown", "git.pr.create": "unknown", "git.review": "unknown", "artifact.read": "unknown", "checkpoint.resume": "unknown" }, last_checked_at: t(120) },
  { connection_id: "conn-3", provider: "Anthropic Claude", state: "PAID_API_REQUIRED", attestation: "self_declared", capabilities: { "message.receive": "unsupported", "message.send": "unsupported", "task.claim": "unsupported", "task.execute": "unsupported", "code.patch": "unsupported", "git.pr.create": "unsupported", "git.review": "unsupported", "artifact.read": "unsupported", "checkpoint.resume": "unsupported" }, last_checked_at: t(600) },
  { connection_id: "conn-4", provider: "PICKLE", state: "AUTH_UNSUPPORTED", attestation: "unknown", capabilities: {}, last_checked_at: t(600) },
];

export const demoAlerts: AlertDto[] = [
  { alert_id: "al-1", kind: "approval", severity: "critical", title: "위험 승인 대기", detail: "PR #42 병합 승인이 20분째 대기 중입니다.", created_at: t(20), priority: "high", link: "#/approvals" },
  { alert_id: "al-2", kind: "provider", severity: "warn", title: "제공자 재인증 필요", detail: "Gemini 연결 만료 예정 (D-3).", created_at: t(180), priority: "normal", link: "#/connections" },
  { alert_id: "al-3", kind: "build", severity: "info", title: "빌드 성공", detail: "verify.yml #2318 성공 · 42s", created_at: t(300), read: true },
  { alert_id: "al-4", kind: "budget", severity: "warn", title: "월 예산 80%", detail: "Actions 분 1,600/2,000 사용(추정).", created_at: t(700), priority: "high", muted: false },
];

export const demoAudit: AuditEntryDto[] = [
  { audit_id: "au-1", actor: "owner", actor_kind: "owner", action: "approval.approve", target: "ap-3", at: t(580), request_id: "req_8f2a", ip_masked: "203.0.113.***", detail: "워크플로 권한 상향 승인" },
  { audit_id: "au-2", actor: "agent-claude", actor_kind: "agent", action: "pr.create", target: "pr#42", at: t(120), request_id: "req_91bd" },
  { audit_id: "au-3", actor: "agent-chatgpt", actor_kind: "agent", action: "agent.register", target: "agent-chatgpt", at: t(2400), request_id: "req_11ff", detail: "초대 토큰 사용 (표시 마스킹)" },
  { audit_id: "au-4", actor: "owner", actor_kind: "owner", action: "auth.login", target: "session", at: t(3000), ip_masked: "203.0.113.***" },
];

export const demoBackups: BackupDto[] = [
  { backup_id: "bk-1", created_at: t(1440), size: 8_421_376, checksum: SHA_A, scope: ["D1", "R2-manifest"], last_restore_test: { at: t(1400), result: "pass", detail: "격리 환경 복원 3분 12초" } },
  { backup_id: "bk-2", created_at: t(2880), size: 8_120_000, checksum: SHA_B, scope: ["D1"], last_restore_test: { at: t(2840), result: "not_run" } },
];

export const demoReports: ReportDto[] = [
  { report_id: "rp-1", title: "4단계 프론트엔드 진행 보고", created_at: t(30), kind: "progress", summary: "디자인 시스템·메시지 블록·에디터·웹 클라이언트 구현. 108개 콘텐츠 기능 중 67개는 렌더러 proof로 검증됨.", evidence: [{ label: "node --test test/*.test.mjs", verified: true }, { label: "vite build 번들 SHA-256", verified: true }], project_id: "proj-ai-room" },
  { report_id: "rp-2", title: "Q039 차단 사유", created_at: t(400), kind: "blocker", summary: "7개 제공자 중 무료·무인·공식 경로 증거 확보 0건. 유료 조건 해제 또는 무료 키 발급 필요.", evidence: [{ label: "provider-capabilities.md", url: "https://example.com/docs/providers", verified: true }], project_id: "proj-ai-room" },
];

export const demoReleaseGate: ReleaseGateDto = {
  generated_at: t(5),
  overall: "BLOCKED",
  requirements: [
    { id: "Q001", title: "웹·EXE·APK 산출물", state: "BLOCKED", note: "웹 번들만 생성, EXE/APK 미빌드" },
    { id: "Q003", title: "실제 AI 제공자 연결", state: "FAIL", note: "7종 중 0종 검증" },
    { id: "Q018", title: "코드 리뷰/승인 무효화", state: "PASS", evidence: "review-panel.test" },
    { id: "Q034", title: "웹 IDE (Monaco+Yjs)", state: "PASS", evidence: "editor.test" },
    { id: "Q038", title: "연속성·재연결", state: "BLOCKED", note: "collab-do 배포 전" },
    { id: "Q041", title: "최종 출시 게이트", state: "BLOCKED", note: "모든 AI 연결 전" },
  ],
  blockers: ["Q003/Q039: AI 제공자 7종 무료·무인 경로 증거 없음", "Q001: Windows EXE·Android APK 실제 빌드 미완료", "R2 미활성으로 파일/아티팩트 저장 차단"],
};

export const demoSearchHits: SearchHitDto[] = [
  { kind: "message", id: "msg-4", title: "Claude · 테스트 결과", excerpt: "message-blocks XSS 37 passed", room_id: "room-default", created_at: t(18) },
  { kind: "file", id: "file-1", title: "spec-summary.md", excerpt: "PROJECT AI ROOM 요구사항 요약", project_id: "proj-ai-room", created_at: t(70) },
  { kind: "memory", id: "mem-2", title: "웹 IDE 정책 (project)", excerpt: "Cloudflare Worker에서 셸을 실행하지 않는다", project_id: "proj-ai-room", created_at: t(1800) },
  { kind: "code", id: "code:packages/editor/src/collab.ts:42", title: "collab.ts:42", excerpt: "syncProtocol.writeSyncStep1(encoder, this.doc)", project_id: "proj-ai-room" },
];

export const demoMetrics: MetricDto[] = [
  { id: "M-01", key: "messages_total", label: "메시지 수", value: 1_284, unit: "건", evidence: "demo" },
  { id: "M-02", key: "messages_per_minute", label: "메시지 처리량", value: 3.2, unit: "/분", evidence: "demo" },
  { id: "M-03", key: "active_agents", label: "실제 이용 가능 AI", value: 1, unit: "개", evidence: "공급자 검증만 집계 (demo)" },
  { id: "M-04", key: "online_sessions", label: "접속 세션", value: 3, unit: "개", evidence: "demo" },
  { id: "M-11", key: "tasks_total", label: "전체 작업", value: 41, unit: "개", evidence: "demo" },
  { id: "M-12", key: "tasks_verified_done", label: "실검증 완료", value: 27, unit: "개", evidence: "demo" },
  { id: "M-13", key: "tasks_blocked", label: "차단 작업", value: 9, unit: "개", evidence: "demo" },
  { id: "M-14", key: "tasks_in_progress", label: "작업 중", value: 3, unit: "개", evidence: "demo" },
  { id: "M-30", key: "ci_success_rate", label: "필수 CI 성공률", value: 86, unit: "%", evidence: "demo" },
];

export const demoBranches: BranchDto[] = [
  { name: "main", sha: SHA_A, protected: true },
  { name: "feat/web-ide", sha: SHA_B, ahead: 3, behind: 0 },
  { name: "fix/url-protocol-relative", sha: SHA_A.slice(0, 40), ahead: 1, behind: 2 },
];

export const demoPullRequests: PullRequestDto[] = [
  { number: 42, title: "feat: 웹 IDE + Yjs 동시 편집", state: "open", head_sha: SHA_A, base_sha: SHA_B, checks: "pending", risk: "high", author: "agent-claude", updated_at: t(15) },
  { number: 41, title: "fix: 프로토콜 상대 URL 차단", state: "merged", head_sha: SHA_B, base_sha: SHA_A, checks: "success", risk: "low", author: "agent-gemini", updated_at: t(300) },
];

export const demoDiff = `diff --git a/packages/message-blocks/src/url.ts b/packages/message-blocks/src/url.ts
index 3a1f7c9..9f8e7d6 100644
--- a/packages/message-blocks/src/url.ts
+++ b/packages/message-blocks/src/url.ts
@@ -14,9 +14,10 @@ export function safeUrl(raw: unknown): UrlDecision {
   if (trimmed.length === 0) return { ok: false, reason: "empty" };
   if (trimmed.length > MAX_URL) return { ok: false, reason: "too_long" };
   if (CONTROL.test(trimmed)) return { ok: false, reason: "control_characters" };
 
-  if (isRelativeUrl(trimmed)) return { ok: true, url: trimmed };
+  // protocol-relative URLs are external, so they are rejected before relative
   if (trimmed.startsWith("//")) return { ok: false, reason: "protocol_relative" };
+  if (isRelativeUrl(trimmed)) return { ok: true, url: trimmed };
 
   const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
   if (!match) return { ok: false, reason: "malformed" };
diff --git a/packages/message-blocks/src/blocks.ts b/packages/message-blocks/src/blocks.ts
--- a/packages/message-blocks/src/blocks.ts
+++ b/packages/message-blocks/src/blocks.ts
@@ -701,6 +701,9 @@ export function renderBlock(block: MessageBlock, options: RenderOptions = {}): VNode {
   if (block.version !== 1) {
     return invalidBlock(block, \`지원하지 않는 블록 버전 \${String(block.version)} — 렌더러 업데이트 필요\`);
   }
+  if (!KNOWN_BLOCK_TYPES.includes(block.type as BlockType)) {
+    return invalidBlock(block, "알 수 없는 블록 타입 — 원본 보기로 확인하세요");
+  }
   const p = rec(block.payload);
   switch (block.type) {
`;

export const demoTree = [
  {
    path: "packages",
    name: "packages",
    type: "dir" as const,
    children: [
      {
        path: "packages/message-blocks",
        name: "message-blocks",
        type: "dir" as const,
        children: [
          { path: "packages/message-blocks/src/blocks.ts", name: "blocks.ts", type: "file" as const, status: "modified" as const },
          { path: "packages/message-blocks/src/url.ts", name: "url.ts", type: "file" as const, status: "modified" as const },
          { path: "packages/message-blocks/src/markdown.ts", name: "markdown.ts", type: "file" as const },
        ],
      },
      {
        path: "packages/editor",
        name: "editor",
        type: "dir" as const,
        children: [
          { path: "packages/editor/src/MonacoYjsEditor.tsx", name: "MonacoYjsEditor.tsx", type: "file" as const, status: "added" as const },
          { path: "packages/editor/src/collab.ts", name: "collab.ts", type: "file" as const, status: "added" as const },
        ],
      },
    ],
  },
  {
    path: "apps",
    name: "apps",
    type: "dir" as const,
    children: [
      {
        path: "apps/web",
        name: "web",
        type: "dir" as const,
        children: [{ path: "apps/web/src/main.tsx", name: "main.tsx", type: "file" as const }],
      },
    ],
  },
  { path: "README.md", name: "README.md", type: "file" as const },
];

export const demoFileContent: Record<string, string> = {
  "packages/message-blocks/src/url.ts": `export function safeUrl(raw: unknown): UrlDecision {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.startsWith("//")) return { ok: false, reason: "protocol_relative" };
  if (isRelativeUrl(trimmed)) return { ok: true, url: trimmed };
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!match) return { ok: false, reason: "malformed" };
  const scheme = match[1]!.toLowerCase();
  if (scheme === "http" || scheme === "https") return { ok: true, url: trimmed };
  return { ok: false, reason: "scheme_not_allowed" };
}
`,
  "apps/web/src/main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";

createRoot(document.getElementById("root")!).render(<App />);
`,
};

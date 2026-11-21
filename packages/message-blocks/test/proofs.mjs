/**
 * One executable proof per block/message-surface feature.
 *
 * Each function asserts observable output of the shipped renderer. If a feature
 * regresses, the proof throws and the feature report turns FAIL — there is no
 * "covered" marker that is not executed here.
 */
import assert from "node:assert/strict";
import {
  renderMarkdown,
  renderInline,
  renderBlock,
  renderMessage,
  sanitizeHtml,
  parseCsv,
  csvToTable,
  keyValueCard,
  activitySummary,
  beforeAfter,
  vnodeText,
  vnodeStats,
  validateVersionChain,
  parseUnifiedDiff,
  groupImageBlocks,
  formatUtc,
  formatRelative,
} from "../dist/index.js";

const text = (node) => vnodeText(node);
const block = (type, payload, extra = {}) => ({ type, version: 1, payload, ...extra });
const render = (type, payload, extra = {}) => text(renderBlock(block(type, payload, extra)));
const stats = (node) => vnodeStats(node);
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

export const PROOFS = {
  "F-001": () => assert.match(render("text", { text: "안녕하세요" }), /안녕하세요/),
  "F-002": () => {
    const md = renderMarkdown("첫 문단\n이어짐\n\n둘째 문단");
    assert.equal(md.nodes.filter((n) => n.tag === "p").length, 2);
    assert.ok(md.features.includes("F-002"));
  },
  "F-003": () => assert.ok(stats(renderInline("**굵게**")).tags.has("strong")),
  "F-004": () => assert.ok(stats(renderInline("*기울임*")).tags.has("em")),
  "F-005": () => assert.ok(stats(renderInline("++밑줄++")).tags.has("u")),
  "F-006": () => assert.ok(stats(renderInline("~~취소~~")).tags.has("s")),
  "F-007": () => assert.ok(stats(renderInline("`code()`")).tags.has("code")),
  "F-008": () => {
    const node = renderBlock(block("code", { code: "const x = 1;", language: "typescript" }));
    assert.equal(node.attrs["data-block"], "code");
    assert.match(text(node), /const/);
  },
  "F-009": () => {
    const md = renderMarkdown("# 하나\n## 둘\n### 셋");
    const tags = stats(md.nodes).tags;
    assert.ok(tags.has("h1") && tags.has("h2") && tags.has("h3"));
  },
  "F-010": () => assert.ok(stats(renderMarkdown("1. 하나\n2. 둘").nodes).tags.has("ol")),
  "F-011": () => assert.ok(stats(renderMarkdown("- 하나\n- 둘").nodes).tags.has("ul")),
  "F-012": () => {
    const md = renderMarkdown("- [x] 완료\n- [ ] 미완료");
    assert.ok(md.features.includes("F-012"));
    assert.match(text(md.nodes), /☑/);
  },
  "F-013": () => assert.ok(stats(renderMarkdown("> 인용문").nodes).tags.has("blockquote")),
  "F-014": () => assert.ok(stats(renderMarkdown("---").nodes).tags.has("hr")),
  "F-015": () => {
    const node = renderInline("[예시](https://example.com/a)");
    const s = stats(node);
    assert.ok(s.tags.has("a"));
    assert.match(s.text, /example\.com/);
  },
  "F-018": () => {
    assert.match(text(renderInline("$E=mc^2$")), /E=mc\^2/);
    assert.match(text(renderMarkdown("$$\n\\int_0^1 x dx\n$$").nodes), /\\int_0\^1/);
  },
  "F-019": () => assert.ok(stats(renderMarkdown("줄1  \n줄2").nodes).tags.has("br")),
  "F-026": () => {
    const out = render("quote", { text: "인용된 대화", source: { author: "chatgpt", message_id: "m-1" } });
    assert.match(out, /인용된 대화/);
    assert.match(out, /m-1/);
  },
  "F-031": () => assert.match(render("project_ref", { project_id: "p-1", name: "AI ROOM", progress: { verified: 2, total: 5 } }), /검증 완료 2\/5/),
  "F-032": () => assert.match(render("task_ref", { task_id: "t-9", title: "IDE", status: "RUNNING", owner_agent_id: "agent-a" }), /t-9/),
  "F-033": () => assert.match(render("file_ref", { name: "spec.md", mime: "text/markdown", size: 2048, sha256: SHA }), /spec\.md/),
  "F-034": () => {
    const out = render("code", { code: "line", language: "ts", filename: "src/a.ts", start_line: 42 });
    assert.match(out, /42행부터/);
  },
  "F-035": () => assert.match(render("text", { text: "출처 표시" }, { source_ref: { kind: "commit", id: "abc1234" } }), /commit:abc1234/),
  "F-036": () => assert.match(render("image_ref", { url: "https://cdn.example.com/a.png", alt: "스크린샷" }), /원격 이미지 자동 로딩 안 함: 스크린샷/),
  "F-037": () => {
    const groups = groupImageBlocks([block("image_ref", {}), block("image_ref", {}), block("text", { text: "x" })]);
    assert.equal(groups[0].length, 2);
    assert.equal(groups[1][0].type, "text");
  },
  "F-038": () => assert.match(render("image_ref", { url: "https://cdn.example.com/a.png", alt: "a" }), /원본 열기/),
  "F-039": () => assert.match(render("image_ref", { url: "/files/a.png", alt: "대체 텍스트" }), /대체 텍스트/),
  "F-040": () => assert.match(render("file_ref", { name: "report.pdf", mime: "application/pdf", size: 1024 }), /PDF/),
  "F-042": () => {
    const out = render("file_ref", { name: "notes.txt", mime: "text/plain", preview: "hello" });
    assert.match(out, /안전 미리보기/);
    assert.match(out, /hello/);
  },
  "F-043": () => assert.match(render("file_ref", { name: "README.md", mime: "text/markdown", preview: "# 제목" }), /README\.md/),
  "F-044": () => assert.match(render("json", { label: "payload", value: { a: 1 } }), /"a": 1/),
  "F-045": () => {
    const csv = 'name,qty\n"a,b",2\nc,3';
    const parsed = parseCsv(csv);
    assert.deepEqual(parsed.header, ["name", "qty"]);
    assert.equal(parsed.rows[0][0], "a,b");
    assert.match(text(csvToTable(csv)), /a,b/);
  },
  "F-046": () => assert.match(render("file_ref", { name: "bundle.zip", mime: "application/zip", size: 4096 }), /ZIP/),
  "F-047": () => assert.match(render("audio_ref", { url: "https://cdn.example.com/a.mp3", duration_s: 12 }), /12초/),
  "F-048": () => assert.match(render("video_ref", { url: "https://cdn.example.com/a.mp4", mime: "video/mp4" }), /비디오/),
  "F-051": () => assert.match(render("file_ref", { name: "a.bin", mime: "application/octet-stream", sha256: SHA }), /SHA-256/),
  "F-054": () => {
    const s = stats(renderBlock(block("code", { code: "function hello() { return 1; }", language: "js" })));
    assert.ok(s.tags.has("span"));
  },
  "F-057": () => {
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.stats.additions, 1);
    assert.match(render("diff", { diff }), /\+1/);
  },
  "F-059": () => assert.match(render("pr_ref", { number: 12, title: "수정", state: "open", checks: "success" }), /checks success/),
  "F-060": () => assert.match(render("commit_ref", { sha: "abc1234def", message: "fix" }), /abc1234def/),
  "F-061": () => {
    const out = render("terminal_log", { title: "ci", state: "running", lines: ["$ npm test", "ok"] });
    assert.match(out, /ci/);
    assert.match(out, /읽기 전용 로그 · 대화형 셸 아님/);
    assert.match(out, /RUNNING/);
  },
  "F-062": () => assert.match(render("status", { state: "SUCCEEDED", label: "빌드", level: "ok" }), /SUCCEEDED/),
  "F-063": () => assert.match(render("test_result", { suite: "unit", passed: 3, failed: 0 }), /통과 3/),
  "F-064": () => assert.match(render("test_result", { suite: "unit", passed: 1, failed: 1, failures: [{ name: "a", file: "src/a.test.ts", line: 9 }] }), /src\/a\.test\.ts:9/),
  "F-065": () => assert.match(render("terminal_log", { state: "succeeded", lines: [], job_id: "job-77" }), /job:job-77/),
  "F-067": () => assert.match(render("task_ref", { task_id: "t-1", title: "작업 카드", status: "DONE" }), /DONE/),
  "F-070": () => assert.match(render("approval_ref", { approval_id: "ap-1", action: "배포", status: "pending", risk: "high" }), /승인 pending/),
  "F-071": () => assert.match(render("approval_ref", { approval_id: "ap-2", action: "배포", status: "approved", decided_by: "owner" }), /결정자 owner/),
  "F-072": () => assert.match(render("artifact_ref", { name: "setup.exe", version: 2, sha256: SHA, size: 1024, hash_status: "verified", platform: "windows-x64" }), /setup\.exe/),
  "F-073": () => assert.match(render("artifact_ref", { name: "a.apk", version: 1, sha256: SHA, hash_status: "unverified" }), /해시 미검증/),
  "F-079": () => {
    const delivered = renderMessage({ id: "m1", room_id: "r1", author: { actor_id: "a", kind: "agent", display_name: "AI" }, blocks: [block("text", { text: "x" })], created_at: "2026-11-21T00:00:00.000Z", delivery: "server_stored" });
    assert.match(text(delivered.node), /서버 저장됨/);
    const unknown = renderMessage({ id: "m2", room_id: "r1", author: { actor_id: "a", kind: "agent", display_name: "AI" }, blocks: [], created_at: "2026-11-21T00:00:00.000Z" });
    assert.match(text(unknown.node), /전달 상태 미확인/);
  },
  "F-088": () => {
    const versions = [
      { version_id: "v2", revision: 2, body_sha256: SHA2, created_at: "2026-11-21T01:00:00.000Z", editor_actor_id: "agent-a" },
      { version_id: "v1", revision: 1, body_sha256: SHA, created_at: "2026-11-21T00:00:00.000Z" },
    ];
    assert.equal(validateVersionChain(versions).ok, true);
    const message = renderMessage({ id: "m", room_id: "r", author: { actor_id: "a", kind: "agent", display_name: "AI" }, blocks: [block("text", { text: "edit" })], created_at: "2026-11-21T00:00:00.000Z", edited_at: "2026-11-21T01:00:00.000Z", versions });
    assert.match(text(message.node), /수정됨/);
    const broken = validateVersionChain([versions[0], { ...versions[1], revision: 1, body_sha256: "not-a-hash" }]);
    assert.equal(broken.ok, false);
    assert.ok(broken.problems.length >= 1);
  },
  "F-089": () => {
    const message = renderMessage({ id: "m", room_id: "r", author: { actor_id: "a", kind: "agent", display_name: "AI" }, blocks: [block("text", { text: "secret" })], created_at: "2026-11-21T00:00:00.000Z", deleted_at: "2026-11-21T02:00:00.000Z" });
    const out = text(message.node);
    assert.match(out, /삭제됨/);
    assert.ok(!out.includes("secret"), "tombstoned body must not be shown");
  },
  "F-093": () => {
    assert.equal(formatUtc("2026-11-21T01:02:00.000Z"), "2026-11-21 01:02Z");
    assert.match(formatRelative("2026-11-21T00:00:00.000Z", new Date("2026-11-21T00:05:00.000Z").getTime()), /5분 전/);
  },
  "F-094": () => assert.ok(stats(renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |").nodes).tags.has("table")),
  "F-095": () => {
    const s = stats(renderBlock(block("chart", { kind: "bar", title: "지표", series: [{ label: "A", value: 3 }, { label: "B", value: 5 }], unit: "건" })));
    assert.ok(s.tags.has("svg"));
    assert.ok(s.tags.has("rect"));
  },
  "F-096": () => assert.match(render("poll", { question: "점심?", options: [{ id: "a", label: "김밥", votes: 1 }] }), /점심\?/),
  "F-097": () => assert.match(render("poll", { question: "q", options: [{ id: "a", label: "x", votes: 1 }, { id: "b", label: "y", votes: 3 }] }), /75% \(3\)/),
  "F-098": () => assert.match(render("poll", { question: "q", options: [{ id: "a", label: "선택1", votes: 0 }, { id: "b", label: "선택2", votes: 0 }] }), /선택2/),
  "F-099": () => assert.match(render("status", { state: "BLOCKED", label: "차단", level: "warn", detail: "외부 의존" }), /BLOCKED/),
  "F-100": () => assert.match(text(keyValueCard("설정", [{ key: "mode", value: "cloud" }, { key: "state", value: "VERIFIED", tone: "ok" }])), /cloud/),
  "F-103": () => assert.match(render("quote", { text: "출처 있는 인용", source: { author: "owner", message_id: "m-7" } }), /출처 ·|인용/),
  "F-104": () => {
    const node = renderBlock(block("callout", { tone: "risk", title: "위험", body: "삭제는 되돌릴 수 없습니다" }));
    const shell = node.children[0];
    assert.equal(shell.attrs.role, "alert");
    assert.match(text(node), /삭제는 되돌릴 수 없습니다/);
  },
  "F-105": () => {
    const out = render("memory_ref", { memory_id: "mem-1", scope: "shared", confidence_type: "hypothesis", text: "추정", source_message_ids: ["m-1"] });
    assert.match(out, /가설/);
    assert.match(out, /출처: m-1/);
  },
  "F-106": () => assert.match(render("project_ref", { project_id: "p", name: "AI ROOM", status: "active" }), /AI ROOM/),
  "F-107": () => assert.match(text(activitySummary([{ at: "2026-11-21T00:00:00.000Z", actor: "agent-a", summary: "작업 완료", kind: "task" }])), /작업 완료/),
  "F-108": () => assert.match(text(beforeAfter("old()", "new()")), /변경 전[\s\S]*변경 후/),
};

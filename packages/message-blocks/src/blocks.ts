/**
 * Block renderers (spec 10.2) — 25 block types → view tree.
 *
 * Rules that repeat across every renderer:
 *  - payload is untrusted: every field is read through a typed accessor that
 *    degrades to a visible "invalid block" notice instead of throwing;
 *  - nothing is fetched automatically (no remote images, no embedded frames);
 *  - states that the platform cannot prove are labelled, not simulated
 *    (terminal = read-only log unless a verified PTY runner says otherwise).
 */
import { el, txt, type MessageBlock, type RenderOptions, type SourceRef, type VNode } from "./types.js";
import { renderMarkdown } from "./markdown.js";
import { highlightCode, isHighlightedLanguage, normalizeLanguage } from "./code.js";
import { parseUnifiedDiff, renderDiff } from "./diff.js";
import { formatBytes, formatUtc, isSha256, redactSecrets, truncate } from "./text.js";
import { linkAttrs, linkHost, safeUrl } from "./url.js";

/* ------------------------------------------------------------- accessors --- */

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const MAX_TEXT = 24000;

function invalidBlock(block: MessageBlock, reason: string): VNode {
  return el(
    "div",
    { class: "mb-block mb-block-invalid", role: "note" },
    el("span", { class: "mb-badge mb-badge-warn" }, txt(`블록 표시 불가 · ${block.type}`)),
    el("div", { class: "mb-muted" }, txt(reason)),
  );
}

function badge(label: string, tone: "ok" | "warn" | "danger" | "neutral" | "info", extra?: string): VNode {
  return el("span", { class: `mb-badge mb-badge-${tone}`, "data-tone": tone }, txt(label), extra ? txt(` · ${extra}`) : null);
}

function sourceFooter(ref: SourceRef | undefined, externalLinks: boolean): VNode | null {
  if (!ref) return null;
  const decision = ref.url ? safeUrl(ref.url) : { ok: false as const };
  const label = ref.label ?? `${ref.kind}:${ref.id}`;
  return el(
    "div",
    { class: "mb-source" },
    el("span", { class: "mb-muted" }, txt("출처 ")),
    decision.ok && decision.url
      ? el("a", { ...linkAttrs(decision.url, externalLinks), class: "mb-link" }, txt(label))
      : el("span", { class: "air-mono" }, txt(label)),
    ref.sha256 && isSha256(ref.sha256) ? el("span", { class: "air-mono mb-muted" }, txt(` sha256:${ref.sha256.slice(0, 12)}…`)) : null,
  );
}

function blockShell(block: MessageBlock, body: VNode, options: RenderOptions): VNode {
  return el(
    "div",
    { class: "mb-block", "data-block": block.type, "data-version": String(block.version) },
    body,
    sourceFooter(block.source_ref, options.externalLinks ?? true),
  );
}

/* ------------------------------------------------------------ code blocks -- */

function codeBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const code = str(p.code);
  if (!code) return invalidBlock(block, "payload.code 가 없습니다");
  const language = str(p.language, "text");
  const max = block.render_policy?.max_chars ?? options.policy?.max_chars ?? MAX_TEXT;
  const cut = truncate(code, max);
  const filename = str(p.filename);
  const startLine = num(p.start_line);

  return blockShell(
    block,
    el(
      "figure",
      { class: "mb-code-figure" },
      el(
        "figcaption",
        { class: "mb-code-head" },
        el("span", { class: "air-mono" }, txt(filename || (isHighlightedLanguage(language) ? normalizeLanguage(language) : language || "text"))),
        el("span", { class: "mb-muted mb-small" }, txt(startLine ? `${startLine}행부터 · 읽기 전용` : "읽기 전용 · 자동 실행 안 함")),
      ),
      el("pre", { class: "mb-code", "data-lang": normalizeLanguage(language) }, highlightCode(cut.text, language)),
      cut.truncated ? el("div", { class: "mb-muted mb-small" }, txt(`전체 ${code.length}자 중 ${max}자 표시`)) : null,
    ),
    options,
  );
}

function diffBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const raw = str(p.diff);
  if (!raw) return invalidBlock(block, "payload.diff 가 없습니다");
  const parsed = parseUnifiedDiff(raw, { maxRows: num(p.max_rows) ?? 3000 });
  return blockShell(
    block,
    el(
      "div",
      null,
      el(
        "div",
        { class: "mb-code-head" },
        el("span", null, txt(str(p.path, "diff"))),
        p.head_sha ? el("span", { class: "air-mono mb-muted mb-small" }, txt(`head ${str(p.head_sha).slice(0, 10)}`)) : null,
      ),
      renderDiff(parsed),
    ),
    options,
  );
}

const TERMINAL_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

function terminalBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const lines = arr(p.lines).map((l) => str(l));
  const state = oneOf(p.state, TERMINAL_STATES, "queued");
  const mode = oneOf(p.mode, ["read_only_log", "pty"] as const, "read_only_log");
  const ptyVerified = p.pty_verified === true && mode === "pty";
  const max = block.render_policy?.max_chars ?? 20000;
  const joined = redactSecrets(lines.join("\n"));
  const cut = truncate(joined, max);
  const stateTone = state === "failed" ? "danger" : state === "succeeded" ? "ok" : state === "running" ? "info" : "neutral";

  return blockShell(
    block,
    el(
      "figure",
      { class: "mb-terminal" },
      el(
        "figcaption",
        { class: "mb-code-head" },
        el("span", null, txt(str(p.title, "실행 로그"))),
        badge(state.toUpperCase(), stateTone as "ok" | "warn" | "danger" | "info" | "neutral"),
        el("span", { class: "mb-muted mb-small" }, txt(ptyVerified ? "PTY(검증된 러너)" : "읽기 전용 로그 · 대화형 셸 아님")),
        p.job_id ? el("span", { class: "air-mono mb-muted mb-small" }, txt(`job:${str(p.job_id)}`)) : null,
      ),
      el("pre", { class: "mb-terminal-body", "data-state": state }, txt(cut.text)),
      cut.truncated ? el("div", { class: "mb-muted mb-small" }, txt("로그가 길어 잘렸습니다 — 전체 로그는 원본 링크에서 확인")) : null,
      typeof p.actions_run_url === "string" ? renderSafeLink(str(p.actions_run_url), "GitHub Actions 실행 보기", options) : null,
    ),
    options,
  );
}

function renderSafeLink(url: string, label: string, options: RenderOptions, className = "mb-link"): VNode {
  const decision = safeUrl(url);
  if (!decision.ok || !decision.url) return el("span", { class: "mb-muted" }, txt(`${label} (링크 차단: ${decision.reason ?? "invalid"})`));
  const host = linkHost(decision.url);
  return el("a", { ...linkAttrs(decision.url, options.externalLinks ?? true), class: className }, txt(label), host ? el("span", { class: "mb-link-host" }, txt(` (${host})`)) : null);
}

function testResultBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const suite = str(p.suite, "tests");
  const passed = num(p.passed) ?? 0;
  const failed = num(p.failed) ?? 0;
  const skipped = num(p.skipped) ?? 0;
  const duration = num(p.duration_ms);
  const failures = arr(p.failures).map(rec);
  const total = passed + failed + skipped;
  const tone = failed > 0 ? "danger" : total === 0 ? "warn" : "ok";

  return blockShell(
    block,
    el(
      "div",
      { class: "mb-test" },
      el(
        "div",
        { class: "mb-code-head" },
        el("span", null, txt(suite)),
        badge(failed > 0 ? "FAIL" : total === 0 ? "NO TESTS" : "PASS", tone),
        el("span", { class: "mb-muted mb-small" }, txt(`통과 ${passed} · 실패 ${failed} · 건너뜀 ${skipped}${duration !== null ? ` · ${duration}ms` : ""}`)),
      ),
      total === 0
        ? el("div", { class: "mb-test-empty" }, txt("테스트가 0건입니다 — 통과로 표시하지 않습니다."))
        : el(
            "ul",
            { class: "mb-test-list" },
            ...failures.map((f) => {
              const file = str(f.file);
              const line = num(f.line);
              const name = str(f.name, "실패한 테스트");
              const linkable = file && line !== null ? safeUrl(`${file}#L${line}`) : { ok: false as const };
              return el(
                "li",
                null,
                el("span", { class: "mb-badge mb-badge-danger" }, txt("FAIL")),
                linkable.ok && linkable.url
                  ? el("a", { ...linkAttrs(linkable.url, false), class: "air-mono" }, txt(`${file}:${line}`))
                  : el("span", { class: "air-mono" }, txt(file ? `${file}${line ? `:${line}` : ""}` : "위치 미제공")),
                el("span", null, txt(` ${name}`)),
                str(f.message) ? el("pre", { class: "mb-test-msg" }, txt(truncate(redactSecrets(str(f.message)), 600).text)) : null,
              );
            }),
          ),
    ),
    options,
  );
}

/* -------------------------------------------------------------- file-ish --- */

const MIME_LABEL: Record<string, string> = {
  "image/png": "PNG 이미지", "image/jpeg": "JPEG 이미지", "image/webp": "WebP 이미지", "image/svg+xml": "SVG(다운로드 전용)",
  "application/pdf": "PDF", "text/plain": "텍스트", "text/markdown": "Markdown", "application/json": "JSON",
  "text/csv": "CSV", "application/zip": "ZIP", "audio/mpeg": "오디오(MP3)", "video/mp4": "비디오(MP4)",
};

function mimeLabel(mime: string): string {
  return MIME_LABEL[mime] ?? (mime || "종류 미상");
}

function hashRow(sha256: string): VNode {
  if (!isSha256(sha256)) return el("span", { class: "mb-muted mb-small" }, txt("해시 미제공"));
  return el(
    "span",
    { class: "mb-hash" },
    el("span", { class: "mb-badge mb-badge-ok" }, txt("SHA-256")),
    el("code", { class: "air-mono" }, txt(sha256)),
  );
}

function fileRefBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const name = str(p.name, "파일");
  const mime = str(p.mime, "application/octet-stream");
  const size = num(p.size);
  const sha = str(p.sha256);
  const url = str(p.url);
  const preview = str(p.preview);
  const previewText = preview ? truncate(redactSecrets(preview), 1200) : null;

  return blockShell(
    block,
    el(
      "div",
      { class: "mb-file" },
      el(
        "div",
        { class: "mb-file-head" },
        el("span", { class: "mb-file-icon", "aria-hidden": "true" }, txt(mime.startsWith("image/") ? "▧" : mime === "application/pdf" ? "PDF" : "▤")),
        el("div", { class: "mb-file-meta" },
          el("div", { class: "mb-file-name" }, txt(name)),
          el("div", { class: "mb-muted mb-small" }, txt(`${mimeLabel(mime)}${size !== null ? ` · ${formatBytes(size)}` : ""}`)),
          hashRow(sha),
        ),
        url ? renderSafeLink(url, "다운로드", options, "air-btn mb-file-download") : el("span", { class: "mb-muted mb-small" }, txt("다운로드 링크 없음")),
      ),
      previewText
        ? el("details", { class: "mb-file-preview" }, el("summary", null, txt("안전 미리보기 (${...})".replace("${...}", mimeLabel(mime)))), el("pre", null, txt(previewText.text)))
        : null,
    ),
    options,
  );
}

function imageBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const alt = str(p.alt, "첨부 이미지");
  const url = str(p.url);
  const remote = /^https?:/i.test(url);
  const allowRemote = block.render_policy?.allow_remote_images ?? options.policy?.allow_remote_images ?? false;
  const decision = safeUrl(url);

  const body = !decision.ok || !decision.url
    ? el("div", { class: "mb-image-placeholder" }, txt(`이미지 표시 불가: ${decision.reason ?? "invalid"} · ${alt}`))
    : remote && !allowRemote
      ? el(
          "div",
          { class: "mb-image-placeholder" },
          el("div", null, txt(`원격 이미지 자동 로딩 안 함: ${alt}`)),
          el("div", { class: "mb-small mb-muted" }, txt("추적 방지를 위해 독자가 직접 열 때만 로드됩니다.")),
          renderSafeLink(decision.url, "원본 열기", options),
        )
      : el(
          "figure",
          { class: "mb-image-figure" },
          // A chat photo is the picture, not a card about the picture: the alt
          // stays on the img (accessibility, and what the lightbox titles itself
          // with) and no hash row is drawn over it.
          el("img", { src: decision.url, alt, class: "mb-image", loading: "lazy", decoding: "async", draggable: "false" }),
        );

  return blockShell(block, el("div", { class: "mb-image" }, body), options);
}

function mediaBlock(block: MessageBlock, kind: "video" | "audio", options: RenderOptions): VNode {
  const p = rec(block.payload);
  const url = str(p.url);
  const mime = str(p.mime, kind === "video" ? "video/mp4" : "audio/mpeg");
  const duration = num(p.duration_s);
  const decision = safeUrl(url);
  const size = num(p.size);

  return blockShell(
    block,
    el(
      "div",
      { class: "mb-media" },
      el("span", { class: "mb-file-icon", "aria-hidden": "true" }, txt(kind === "video" ? "▶" : "♪")),
      el("div", { class: "mb-file-meta" },
        el("div", null, txt(`${kind === "video" ? "비디오" : "오디오"} · ${mimeLabel(mime)}`)),
        el("div", { class: "mb-muted mb-small" }, txt([duration !== null ? `${duration}초` : null, size !== null ? formatBytes(size) : null].filter(Boolean).join(" · ") || "길이 정보 없음")),
      ),
      decision.ok && decision.url
        ? renderSafeLink(decision.url, "열기", options)
        : el("span", { class: "mb-muted mb-small" }, txt("URL 차단 또는 없음")),
      el("div", { class: "mb-muted mb-small" }, txt("재생기는 사용자가 링크를 열 때만 동작합니다(자동 재생·자동 로드 없음).")),
    ),
    options,
  );
}

/* ---------------------------------------------------------------- data ----- */

function jsonBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  let pretty: string;
  try {
    pretty = JSON.stringify(p.value ?? p, null, 2);
  } catch {
    pretty = "[직렬화 불가]";
  }
  const cut = truncate(pretty, block.render_policy?.max_chars ?? 8000);
  return blockShell(
    block,
    el("figure", { class: "mb-code-figure" },
      el("figcaption", { class: "mb-code-head" }, el("span", { class: "air-mono" }, txt(str(p.label, "JSON"))), el("span", { class: "mb-muted mb-small" }, txt("미리보기 · 복사 전용"))),
      el("pre", { class: "mb-code", "data-lang": "json" }, highlightCode(cut.text, "json")),
    ),
    options,
  );
}

function tableBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const columns = arr(p.columns).map((c) => str(c));
  const rows = arr(p.rows).map((r) => arr(r).map((c) => (typeof c === "number" ? String(c) : str(c))));
  if (columns.length === 0) return invalidBlock(block, "payload.columns 가 없습니다");
  return blockShell(
    block,
    el(
      "div",
      { class: "mb-table-wrap" },
      el(
        "table",
        { class: "mb-table" },
        el("caption", { class: "mb-caption" }, txt(str(p.caption, "표"))),
        el("thead", null, el("tr", null, ...columns.map((c) => el("th", { scope: "col" }, txt(c))))),
        el("tbody", null, ...rows.map((cells) => el("tr", null, ...columns.map((_, idx) => el("td", null, txt(cells[idx] ?? "")))))),
      ),
      rows.length === 0 ? el("div", { class: "mb-muted mb-small" }, txt("행이 없습니다")) : null,
    ),
    options,
  );
}

function chartBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const kind = oneOf(p.kind, ["bar", "line"] as const, "bar");
  const series = arr(p.series).map((s) => ({ label: str(rec(s).label, "?"), value: num(rec(s).value) ?? 0 }));
  if (series.length === 0) return invalidBlock(block, "payload.series 가 비어 있습니다");
  const max = Math.max(...series.map((s) => s.value), 1);
  const width = 320;
  const height = 120;
  const barW = Math.max(4, Math.floor((width - 20) / series.length) - 6);
  const points = series
    .map((s, i) => `${10 + i * (barW + 6) + barW / 2},${height - 8 - (s.value / max) * (height - 28)}`)
    .join(" ");

  return blockShell(
    block,
    el(
      "figure",
      { class: "mb-chart" },
      el("figcaption", { class: "mb-code-head" }, txt(str(p.title, "차트")), el("span", { class: "mb-muted mb-small" }, txt(str(p.unit, "")))),
      el(
        "svg",
        { viewBox: `0 0 ${width} ${height}`, role: "img", class: "mb-chart-svg", "aria-label": `${str(p.title, "차트")}: ${series.map((s) => `${s.label} ${s.value}`).join(", ")}` },
        el("line", { x1: "8", y1: String(height - 8), x2: String(width - 8), y2: String(height - 8), stroke: "currentColor", "stroke-opacity": "0.25" }),
        ...(kind === "bar"
          ? series.map((s, i) => el("rect", { x: String(8 + i * (barW + 6)), y: String(height - 8 - (s.value / max) * (height - 28)), width: String(barW), height: String((s.value / max) * (height - 28)), rx: "3", fill: "currentColor", "fill-opacity": "0.75" }))
          : [el("polyline", { points, fill: "none", stroke: "currentColor", "stroke-width": "2" })]),
      ),
      el("ul", { class: "mb-chart-legend" }, ...series.map((s) => el("li", null, el("span", { class: "mb-muted" }, txt(s.label)), el("span", { class: "air-mono" }, txt(` ${s.value}${str(p.unit, "")}`))))),
    ),
    options,
  );
}

/* ------------------------------------------------------------- references -- */

function refCard(title: string, meta: Array<VNode | null>, options: RenderOptions, href?: string, className = "mb-ref"): VNode {
  return el(
    "div",
    { class: className },
    el("div", { class: "mb-ref-title" }, txt(title)),
    el("div", { class: "mb-ref-meta" }, ...meta),
    href ? renderSafeLink(href, "열기", options) : null,
  );
}

function taskRefBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const status = oneOf(p.status, ["TODO", "READY", "LEASED", "RUNNING", "REVIEW", "DONE", "BLOCKED", "FAILED"] as const, "TODO");
  const risk = oneOf(p.risk_level, ["low", "medium", "high"] as const, "low");
  return blockShell(
    block,
    refCard(
      str(p.title, "작업"),
      [
        el("span", { class: "air-mono" }, txt(str(p.task_id, "task?"))),
        badge(status, status === "DONE" ? "ok" : status === "BLOCKED" ? "warn" : status === "FAILED" ? "danger" : "neutral"),
        p.owner_agent_id ? el("span", { class: "mb-muted mb-small" }, txt(`담당 ${str(p.owner_agent_id)}`)) : el("span", { class: "mb-muted mb-small" }, txt("담당 미배정")),
        risk === "high" ? badge("위험 높음", "danger") : risk === "medium" ? badge("위험 중간", "warn") : null,
        Array.isArray(p.depends_on) ? el("span", { class: "mb-muted mb-small" }, txt(`선행 ${arr(p.depends_on).length}건`)) : null,
      ],
      options,
      typeof p.url === "string" ? p.url : undefined,
    ),
    options,
  );
}

function projectRefBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const progress = rec(p.progress);
  const verified = num(progress.verified);
  const total = num(progress.total);
  return blockShell(
    block,
    refCard(
      str(p.name, "프로젝트"),
      [
        el("span", { class: "air-mono" }, txt(str(p.project_id, "project?"))),
        el("span", { class: "mb-muted mb-small" }, txt(str(p.status, "상태 미상"))),
        verified !== null && total !== null
          ? el("span", { class: "mb-muted mb-small" }, txt(`검증 완료 ${verified}/${total}`))
          : badge("진행률 없음", "neutral"),
      ],
      options,
      typeof p.url === "string" ? p.url : undefined,
    ),
    options,
  );
}

function commitRefBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const sha = str(p.sha);
  const valid = /^[0-9a-f]{7,64}$/i.test(sha);
  return blockShell(
    block,
    refCard(
      str(p.message, "(커밋 메시지 없음)"),
      [
        el("code", { class: "air-mono" }, txt(valid ? sha.slice(0, 12) : "SHA 형식 오류")),
        p.repo ? el("span", { class: "mb-muted mb-small" }, txt(str(p.repo))) : null,
        p.committed_at ? el("time", { class: "mb-muted mb-small", datetime: str(p.committed_at) }, txt(formatUtc(str(p.committed_at)))) : null,
      ],
      options,
      typeof p.url === "string" ? p.url : undefined,
    ),
    options,
  );
}

function prRefBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const state = oneOf(p.state, ["open", "closed", "merged", "draft"] as const, "open");
  const checks = str(p.checks, "");
  return blockShell(
    block,
    refCard(
      `#${num(p.number) ?? "?"} ${str(p.title, "풀 리퀘스트")}`,
      [
        badge(state.toUpperCase(), state === "merged" ? "ok" : state === "closed" ? "danger" : state === "draft" ? "neutral" : "info"),
        checks ? badge(`checks ${checks}`, checks === "success" ? "ok" : checks === "failure" ? "danger" : "warn") : badge("checks 미확인", "neutral"),
        p.head_sha ? el("code", { class: "air-mono mb-small" }, txt(str(p.head_sha).slice(0, 10))) : null,
      ],
      options,
      typeof p.url === "string" ? p.url : undefined,
    ),
    options,
  );
}

function approvalRefBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const status = oneOf(p.status, ["pending", "approved", "rejected", "expired"] as const, "pending");
  const risk = oneOf(p.risk, ["low", "medium", "high"] as const, "medium");
  const sha = str(p.action_sha256);
  return blockShell(
    block,
    el(
      "div",
      { class: "mb-approval" },
      el("div", { class: "mb-ref-title" }, txt(str(p.action, "승인 요청"))),
      el("div", { class: "mb-ref-meta" },
        badge(`승인 ${status}`, status === "approved" ? "ok" : status === "pending" ? "warn" : "danger"),
        badge(`위험 ${risk}`, risk === "high" ? "danger" : risk === "medium" ? "warn" : "neutral"),
        el("span", { class: "air-mono" }, txt(str(p.approval_id, "approval?"))),
      ),
      el("div", { class: "mb-muted mb-small" },
        txt(`요청자 ${str(p.requested_by, "?")}${p.decided_by ? ` · 결정자 ${str(p.decided_by)}` : ""}${sha ? ` · 대상 해시 ${sha.slice(0, 12)}…` : ""}`),
      ),
      status === "pending"
        ? el("div", { class: "mb-small mb-muted" }, txt("승인은 승인 센터에서만 처리됩니다 — 메시지에서 즉시 실행되지 않습니다."))
        : null,
    ),
    options,
  );
}

function pollBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const optionsList = arr(p.options).map((o) => ({ id: str(rec(o).id), label: str(rec(o).label), votes: num(rec(o).votes) ?? 0 }));
  const total = optionsList.reduce((sum, o) => sum + o.votes, 0);
  const voted = str(p.voted_option_id);
  return blockShell(
    block,
    el(
      "div",
      { class: "mb-poll" },
      el("div", { class: "mb-ref-title" }, txt(str(p.question, "투표"))),
      el("ul", { class: "mb-poll-list" },
        ...optionsList.map((o) => {
          const pct = total === 0 ? 0 : Math.round((o.votes / total) * 100);
          return el(
            "li",
            { class: o.id === voted ? "mb-poll-voted" : undefined },
            el("div", { class: "mb-poll-row" },
              el("span", null, txt(o.label), o.id === voted ? el("span", { class: "mb-muted mb-small" }, txt(" · 내 선택")) : null),
              el("span", { class: "air-mono" }, txt(`${pct}% (${o.votes})`)),
            ),
            // Rendered as SVG (numeric attributes only) so the bar needs no inline
            // style — compatible with a strict `style-src` CSP.
            el("svg", { class: "mb-poll-bar", viewBox: "0 0 100 6", preserveAspectRatio: "none", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": `${o.label} ${pct}%` },
              el("rect", { x: "0", y: "0", width: "100", height: "6", rx: "3", fill: "currentColor", "fill-opacity": "0.15" }),
              el("rect", { x: "0", y: "0", width: String(pct), height: "6", rx: "3", fill: "currentColor", "fill-opacity": "0.8" }),
            ),
          );
        }),
      ),
      el("div", { class: "mb-muted mb-small" }, txt(p.closed === true ? `마감 · 총 ${total}표` : `진행 중 · 총 ${total}표`)),
    ),
    options,
  );
}

function statusBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const level = oneOf(p.level, ["ok", "warn", "danger", "info", "neutral"] as const, "neutral");
  const state = oneOf(p.state, ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "UNAVAILABLE"] as const, "UNAVAILABLE");
  return blockShell(
    block,
    el(
      "div",
      { class: "mb-status" },
      badge(`${state}`, level === "ok" ? "ok" : level === "danger" ? "danger" : level === "warn" ? "warn" : level === "info" ? "info" : "neutral"),
      el("span", null, txt(str(p.label, "상태"))),
      p.detail ? el("span", { class: "mb-muted mb-small" }, txt(str(p.detail))) : null,
    ),
    options,
  );
}

function linkPreviewBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const url = str(p.url);
  const decision = safeUrl(url);
  const host = linkHost(url);
  return blockShell(
    block,
    decision.ok && decision.url
      ? el(
          "div",
          { class: "mb-link-preview" },
          el("div", { class: "mb-ref-title" }, txt(str(p.title, host ?? url))),
          el("div", { class: "mb-muted mb-small" }, txt(str(p.description, ""))),
          el("div", { class: "mb-small" }, el("span", { class: "air-mono mb-muted" }, txt(host ?? ""))),
          el("div", { class: "mb-small mb-muted" }, txt("미리보기 이미지는 로드하지 않습니다(추적 방지).")),
          renderSafeLink(decision.url, "링크 열기", options),
        )
      : invalidBlock(block, `링크 미리보기 차단: ${decision.reason ?? "invalid"}`),
    options,
  );
}

function calloutBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const tone = oneOf(p.tone, ["info", "warn", "risk", "ok"] as const, "info");
  return blockShell(
    block,
    el(
      "div",
      { class: `mb-callout mb-callout-${tone}`, role: tone === "risk" ? "alert" : "note" },
      el("div", { class: "mb-callout-title" }, txt(str(p.title, tone === "risk" ? "위험 경고" : "안내"))),
      el("div", null, ...renderMarkdown(str(p.body)).nodes),
    ),
    options,
  );
}

function quoteBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const source = rec(p.source);
  const messageId = str(source.message_id);
  const deleted = source.deleted === true;
  return blockShell(
    block,
    el(
      "blockquote",
      { class: "mb-quote" },
      ...renderMarkdown(str(p.text)).nodes,
      el(
        "footer",
        { class: "mb-quote-source mb-muted mb-small" },
        txt(deleted ? "원본 삭제됨 · " : "인용 · "),
        source.author ? txt(`${str(source.author)}`) : null,
        messageId ? el("span", { class: "air-mono" }, txt(` ${messageId}`)) : null,
        deleted ? txt(" (원문은 삭제되어 더 이상 접근할 수 없습니다)") : null,
      ),
    ),
    options,
  );
}

function memoryRefBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const scope = oneOf(p.scope, ["agent", "room", "project", "shared"] as const, "room");
  const confidence = oneOf(p.confidence_type, ["fact", "decision", "hypothesis"] as const, "hypothesis");
  const sources = arr(p.source_message_ids).map((s) => str(s)).slice(0, 8);
  return blockShell(
    block,
    el(
      "div",
      { class: "mb-memory" },
      el("div", { class: "mb-ref-meta" },
        badge(`기억 ${scope}`, "info"),
        badge(confidence === "fact" ? "사실" : confidence === "decision" ? "결정" : "가설", confidence === "hypothesis" ? "warn" : confidence === "decision" ? "ok" : "neutral"),
        p.revision ? el("span", { class: "air-mono mb-small" }, txt(`r${String(p.revision)}`)) : null,
        el("span", { class: "air-mono mb-small" }, txt(str(p.memory_id, "memory?"))),
      ),
      el("div", null, ...renderMarkdown(str(p.text)).nodes),
      sources.length ? el("div", { class: "mb-muted mb-small" }, txt(`출처: ${sources.join(", ")}`)) : el("div", { class: "mb-muted mb-small" }, txt("출처 미기록 — 확정 사실로 취급하지 않습니다")),
    ),
    options,
  );
}

function artifactRefBlock(block: MessageBlock, options: RenderOptions): VNode {
  const p = rec(block.payload);
  const sha = str(p.sha256);
  const verifiedSha = isSha256(sha);
  const size = num(p.size);
  const verifiedStatus = oneOf(p.hash_status, ["verified", "unverified", "mismatch"] as const, verifiedSha ? "unverified" : "unverified");
  return blockShell(
    block,
    el(
      "div",
      { class: "mb-artifact" },
      el("div", { class: "mb-ref-title" }, txt(str(p.name, "아티팩트"))),
      el("div", { class: "mb-ref-meta" },
        el("span", { class: "air-mono mb-small" }, txt(`v${str(p.version, "?")}`)),
        size !== null ? el("span", { class: "mb-muted mb-small" }, txt(formatBytes(size))) : null,
        badge(
          verifiedStatus === "verified" ? "해시 검증됨" : verifiedStatus === "mismatch" ? "해시 불일치" : "해시 미검증",
          verifiedStatus === "verified" ? "ok" : verifiedStatus === "mismatch" ? "danger" : "warn",
        ),
        p.platform ? el("span", { class: "mb-muted mb-small" }, txt(str(p.platform))) : null,
      ),
      verifiedSha ? el("code", { class: "air-mono mb-small" }, txt(sha)) : el("span", { class: "mb-muted mb-small" }, txt("SHA-256 없음 — 다운로드 전 검증 불가")),
      typeof p.url === "string" ? renderSafeLink(p.url, "다운로드", options) : null,
      verifiedStatus !== "verified" && p.url ? el("div", { class: "mb-small mb-muted" }, txt("해시가 검증되지 않은 파일입니다. 실행 전 확인하세요.")) : null,
    ),
    options,
  );
}

/* ------------------------------------------------------------- dispatcher -- */

export function renderBlock(block: MessageBlock, options: RenderOptions = {}): VNode {
  if (!block || typeof block.type !== "string") {
    return invalidBlock({ type: "unknown", version: 0, payload: {} }, "블록 형식이 아닙니다");
  }
  if (block.version !== 1) {
    return invalidBlock(block, `지원하지 않는 블록 버전 ${String(block.version)} — 렌더러 업데이트 필요`);
  }
  const p = rec(block.payload);
  switch (block.type) {
    case "text": {
      const text = truncate(redactSecrets(str(p.text)), block.render_policy?.max_chars ?? options.policy?.max_chars ?? MAX_TEXT);
      return blockShell(block, el("div", { class: "mb-text" }, ...text.text.split("\n").flatMap((line, i) => (i === 0 ? [txt(line)] : [el("br", null), txt(line)]))), options);
    }
    case "markdown": {
      const source = str(p.markdown, str(p.text));
      const md = renderMarkdown(source, {
        allowRemoteImages: block.render_policy?.allow_remote_images ?? options.policy?.allow_remote_images ?? false,
        allowHtml: block.render_policy?.allow_html ?? options.policy?.allow_html ?? false,
        externalLinks: options.externalLinks ?? true,
        mathRenderer: block.render_policy?.math_renderer ?? options.policy?.math_renderer ?? "source_only",
      });
      return blockShell(block, el("div", { class: "mb-markdown" }, ...md.nodes), options);
    }
    case "code":
      return codeBlock(block, options);
    case "diff":
      return diffBlock(block, options);
    case "terminal_log":
      return terminalBlock(block, options);
    case "test_result":
      return testResultBlock(block, options);
    case "file_ref":
      return fileRefBlock(block, options);
    case "image_ref":
      return imageBlock(block, options);
    case "video_ref":
      return mediaBlock(block, "video", options);
    case "audio_ref":
      return mediaBlock(block, "audio", options);
    case "json":
      return jsonBlock(block, options);
    case "table":
      return tableBlock(block, options);
    case "chart":
      return chartBlock(block, options);
    case "task_ref":
      return taskRefBlock(block, options);
    case "project_ref":
      return projectRefBlock(block, options);
    case "commit_ref":
      return commitRefBlock(block, options);
    case "pr_ref":
      return prRefBlock(block, options);
    case "approval_ref":
      return approvalRefBlock(block, options);
    case "poll":
      return pollBlock(block, options);
    case "status":
      return statusBlock(block, options);
    case "link_preview":
      return linkPreviewBlock(block, options);
    case "callout":
      return calloutBlock(block, options);
    case "quote":
      return quoteBlock(block, options);
    case "memory_ref":
      return memoryRefBlock(block, options);
    case "artifact_ref":
      return artifactRefBlock(block, options);
    default:
      return invalidBlock(block, `알 수 없는 블록 타입 "${block.type}" (미래 버전일 수 있음) — 원본 보기로 확인하세요`);
  }
}

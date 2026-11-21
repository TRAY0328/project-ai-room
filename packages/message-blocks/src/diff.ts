/**
 * Unified-diff parsing and rendering (spec 10.2 `diff` block, spec 13.4 review).
 *
 * The parser is intentionally strict about line numbers: a review comment is
 * anchored to a real (file, side, line), so a mis-parsed hunk would attach a
 * comment to the wrong code. Anything unrecognised becomes `meta` and is shown
 * verbatim rather than silently dropped.
 */
import { el, txt, type VNode } from "./types.js";

export type DiffRowKind = "file" | "meta" | "hunk" | "ctx" | "add" | "del" | "note";

export interface DiffRow {
  kind: DiffRowKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** Display path of the file this row belongs to. */
  path: string | null;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  hunks: number;
  /** True when the patch was cut off by `maxRows`. */
  truncated: boolean;
}

export interface ParsedDiff {
  rows: DiffRow[];
  stats: DiffStats;
}

export function parseUnifiedDiff(raw: string, options: { maxRows?: number } = {}): ParsedDiff {
  const maxRows = options.maxRows ?? 4000;
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const rows: DiffRow[] = [];
  let path: string | null = null;
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  const files = new Set<string>();
  let truncated = false;

  for (const line of lines) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      path = m?.[2] ?? null;
      if (path) files.add(path);
      rows.push({ kind: "file", oldNo: null, newNo: null, text: path ?? line, path });
      oldNo = 0;
      newNo = 0;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      hunks += 1;
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line, path });
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity index") || line.startsWith("rename ")) {
      rows.push({ kind: "meta", oldNo: null, newNo: null, text: line, path });
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1), path });
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
      rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1), path });
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1), path });
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "note", oldNo: null, newNo: null, text: line, path });
      continue;
    }
    if (line === "" && rows.length > 0) {
      rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: "", path });
      continue;
    }
    rows.push({ kind: "meta", oldNo: null, newNo: null, text: line, path });
  }

  return { rows, stats: { files: files.size, additions, deletions, hunks, truncated } };
}

const SIGN: Record<DiffRowKind, string> = { file: "", meta: "", hunk: "", ctx: " ", add: "+", del: "-", note: "" };

export interface DiffRenderOptions {
  /** Highlight the row a review comment is attached to. */
  anchor?: { path: string; side: "old" | "new"; line: number } | null;
  /** Rows to render (virtualisation window); defaults to all. */
  start?: number;
  end?: number;
  maxChars?: number;
}

export function renderDiff(parsed: ParsedDiff, options: DiffRenderOptions = {}): VNode {
  const start = options.start ?? 0;
  const end = Math.min(parsed.rows.length, options.end ?? parsed.rows.length);
  const maxChars = options.maxChars ?? 4000;
  const visible = parsed.rows.slice(start, end);

  const rows = visible.map((row) => {
    const text = row.text.length > maxChars ? `${row.text.slice(0, maxChars)} … (${row.text.length}자 중 ${maxChars}자 표시)` : row.text;
    const anchored = options.anchor && row.path === options.anchor.path
      ? (options.anchor.side === "old" ? row.oldNo : row.newNo) === options.anchor.line
      : false;
    return el(
      "tr",
      { class: `mb-diff-row mb-diff-${row.kind}${anchored ? " mb-diff-anchor" : ""}`, "data-kind": row.kind },
      el("td", { class: "mb-diff-no", "aria-hidden": "true" }, txt(row.oldNo === null ? "" : String(row.oldNo))),
      el("td", { class: "mb-diff-no", "aria-hidden": "true" }, txt(row.newNo === null ? "" : String(row.newNo))),
      el("td", { class: "mb-diff-sign", "aria-hidden": "true" }, txt(SIGN[row.kind])),
      el("td", { class: "mb-diff-text" }, txt(text)),
    );
  });

  return el(
    "div",
    { class: "mb-diff" },
    el(
      "div",
      { class: "mb-diff-head" },
      el("span", null, txt(`+${parsed.stats.additions}`)),
      el("span", { class: "mb-diff-del-count" }, txt(`−${parsed.stats.deletions}`)),
      el("span", { class: "air-muted" }, txt(`${parsed.stats.files}개 파일 · ${parsed.stats.hunks}개 hunk`)),
      parsed.stats.truncated ? el("span", { class: "mb-truncated" }, txt("잘림(maxRows)")) : null,
    ),
    el(
      "div",
      { class: "mb-diff-scroll" },
      el(
        "table",
        { class: "mb-diff-table" },
        el("caption", { class: "air-sr-only" }, txt("통합 diff (읽기 전용)")),
        el("tbody", null, ...rows),
      ),
    ),
  );
}

/** Review comments are attached to (path, side, line) and become invalid when the SHA changes. */
export interface DiffComment {
  id: string;
  path: string;
  side: "old" | "new";
  line: number;
  head_sha: string;
  author: string;
  body: string;
  created_at: string;
}

export interface CommentValidity {
  comment: DiffComment;
  status: "valid" | "stale_sha" | "line_moved";
  detail: string;
}

export function validateDiffComments(comments: readonly DiffComment[], currentSha: string, parsed: ParsedDiff): CommentValidity[] {
  return comments.map((comment) => {
    if (comment.head_sha !== currentSha) {
      return { comment, status: "stale_sha", detail: `코멘트 기준 SHA ${comment.head_sha.slice(0, 7)} ≠ 현재 ${currentSha.slice(0, 7)} — 승인/코멘트 재확인 필요` };
    }
    const exists = parsed.rows.some((row) => row.path === comment.path && (comment.side === "old" ? row.oldNo : row.newNo) === comment.line);
    return exists
      ? { comment, status: "valid", detail: "줄이 현재 diff에 존재" }
      : { comment, status: "line_moved", detail: "해당 줄이 현재 diff에서 사라짐(코드 변경) — 위치 재확인" };
  });
}

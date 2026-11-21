/**
 * Structured data helpers that feed block renderers but are useful on their own:
 * CSV → table, key/value cards, activity summaries and before/after comparisons.
 * No parsing of untrusted formats beyond a tolerant CSV reader (quotes + commas).
 */
import { el, txt, type VNode } from "./types.js";

/** RFC4180-ish CSV reader: quoted fields, escaped quotes, CRLF, and a size cap. */
export function parseCsv(raw: string, options: { maxRows?: number; maxCols?: number } = {}): { header: string[]; rows: string[][]; truncated: boolean } {
  const maxRows = options.maxRows ?? 500;
  const maxCols = options.maxCols ?? 40;
  const text = raw.replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let i = 0;
  let truncated = false;

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      if (row.length > maxCols) row = row.slice(0, maxCols);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      if (rows.length >= maxRows + 1) {
        truncated = true;
        break;
      }
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > maxRows) {
    truncated = true;
    rows.length = maxRows;
  }
  const header = rows.shift() ?? [];
  return { header: header.slice(0, maxCols), rows, truncated };
}

export function csvToTable(csv: string, caption = "CSV"): VNode {
  const { header, rows, truncated } = parseCsv(csv);
  if (header.length === 0) {
    return el("div", { class: "mb-muted mb-small" }, txt("CSV 헤더가 없습니다"));
  }
  return el(
    "div",
    { class: "mb-table-wrap" },
    el(
      "table",
      { class: "mb-table" },
      el("caption", { class: "mb-caption" }, txt(`${caption}${truncated ? " (일부만 표시)" : ""}`)),
      el("thead", null, el("tr", null, ...header.map((h) => el("th", { scope: "col" }, txt(h))))),
      el(
        "tbody",
        null,
        ...rows.map((cells) => el("tr", null, ...header.map((_, idx) => el("td", null, txt(cells[idx] ?? ""))))),
      ),
    ),
    truncated ? el("div", { class: "mb-muted mb-small" }, txt("행이 많아 일부만 표시합니다 — 원본 파일을 내려받으세요.")) : null,
  );
}

export interface KeyValueItem {
  key: string;
  value: string;
  /** Optional emphasis for values that are states (e.g. VERIFIED). */
  tone?: "ok" | "warn" | "danger" | "neutral";
}

export function keyValueCard(title: string, items: readonly KeyValueItem[]): VNode {
  return el(
    "div",
    { class: "mb-kv" },
    el("div", { class: "mb-ref-title" }, txt(title)),
    el(
      "dl",
      null,
      ...items.flatMap((item) => [
        el("dt", null, txt(item.key)),
        el("dd", item.tone ? { class: `mb-tone-${item.tone}` } : null, txt(item.value)),
      ]),
    ),
  );
}

export interface ActivityItem {
  at: string;
  actor: string;
  summary: string;
  kind: "message" | "task" | "commit" | "pr" | "approval" | "build" | "memory";
}

const ACTIVITY_LABEL: Record<ActivityItem["kind"], string> = {
  message: "메시지",
  task: "작업",
  commit: "커밋",
  pr: "PR",
  approval: "승인",
  build: "빌드",
  memory: "기억",
};

export function activitySummary(items: readonly ActivityItem[], limit = 8): VNode {
  const visible = items.slice(0, limit);
  return el(
    "div",
    { class: "mb-activity" },
    el("div", { class: "mb-ref-title" }, txt("활동 요약")),
    el(
      "ul",
      { class: "mb-timeline" },
      ...visible.map((item) =>
        el(
          "li",
          null,
          el("time", { datetime: item.at, class: "air-mono mb-small" }, txt(item.at.replace("T", " ").replace(".000Z", "Z"))),
          el("span", { class: "mb-badge mb-badge-neutral" }, txt(ACTIVITY_LABEL[item.kind])),
          el("span", null, txt(` ${item.actor} · ${item.summary}`)),
        ),
      ),
    ),
    items.length > limit ? el("div", { class: "mb-muted mb-small" }, txt(`최근 ${limit}건 표시 · 전체 ${items.length}건`)) : null,
  );
}

/** Before/after comparison used by review blocks (spec 10.2 변경 전후 비교). */
export function beforeAfter(before: string, after: string, labels: { before?: string; after?: string } = {}): VNode {
  return el(
    "div",
    { class: "mb-beforeafter" },
    el("div", { class: "mb-ba-col" }, el("div", { class: "mb-ba-head" }, txt(labels.before ?? "변경 전")), el("pre", { class: "mb-code" }, txt(before))),
    el("div", { class: "mb-ba-col" }, el("div", { class: "mb-ba-head" }, txt(labels.after ?? "변경 후")), el("pre", { class: "mb-code" }, txt(after))),
  );
}

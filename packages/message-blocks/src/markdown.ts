/**
 * Markdown → view tree (spec 10.2 / 10.3).
 *
 * Deliberately a small, auditable parser instead of a large Markdown library:
 * the block vocabulary is fixed by the product, and every construct that could
 * carry a payload (links, images, raw HTML) is routed through an explicit
 * policy. Raw HTML is *never* interpreted: it degrades to visible text so a
 * reader can see what was sent without executing anything.
 */
import { el, txt, type El, type VNode } from "./types.js";
import { cleanText } from "./text.js";
import { linkAttrs, linkHost, safeUrl } from "./url.js";
import { highlightCode } from "./code.js";

export interface MarkdownOptions {
  allowHtml?: boolean;
  allowRemoteImages?: boolean;
  externalLinks?: boolean;
  mathRenderer?: "source_only" | "katex";
}

interface Ctx extends Required<Pick<MarkdownOptions, "allowHtml" | "allowRemoteImages" | "externalLinks">> {
  mathRenderer: "source_only" | "katex";
}

/* -------------------------------------------------------------- inline ---- */

function inlineCode(text: string): El {
  return el("code", { class: "mb-icode" }, txt(text));
}

function mathNode(tex: string): El {
  // No typesetter is bundled; labelling the source is the honest rendering.
  return el(
    "span",
    { class: "mb-math", "data-render": "source_only", title: "TeX 수식 (렌더러 미연결: 소스 표시)" },
    el("code", null, txt(tex)),
  );
}

function linkNode(label: VNode[], href: string, ctx: Ctx): VNode {
  const decision = safeUrl(href);
  if (!decision.ok || !decision.url) {
    return el(
      "span",
      { class: "mb-link-blocked", title: `차단된 링크: ${decision.reason ?? "invalid"}` },
      ...label,
      el("span", { class: "mb-link-blocked-note" }, txt(` (링크 차단: ${decision.reason ?? "invalid"})`)),
    );
  }
  const host = linkHost(decision.url);
  const attrs = linkAttrs(decision.url, ctx.externalLinks);
  return el(
    "a",
    { ...attrs, class: "mb-link" },
    ...label,
    host ? el("span", { class: "mb-link-host" }, txt(` (${host})`)) : null,
  );
}

function imageNode(alt: string, src: string, ctx: Ctx): VNode {
  const decision = safeUrl(src);
  if (!decision.ok || !decision.url) {
    return el("span", { class: "mb-image-blocked" }, txt(`[이미지 차단: ${alt || "대체 텍스트 없음"}]`));
  }
  const remote = /^https?:/i.test(decision.url);
  if (remote && !ctx.allowRemoteImages) {
    return el(
      "span",
      { class: "mb-image-blocked", "data-reason": "remote_image_blocked" },
      txt(`[원격 이미지 미표시: ${alt || "대체 텍스트 없음"}]`),
      el("span", { class: "mb-link-blocked-note" }, txt(" — 추적 방지를 위해 자동 로딩하지 않습니다")),
    );
  }
  return el("img", { src: decision.url, alt: alt || "첨부 이미지", loading: "lazy", class: "mb-image" });
}

/**
 * Inline scanner. Order matters: code spans win over emphasis, emphasis wins
 * over bare-word autolinks, and unmatched markers stay literal text.
 */
export function renderInline(source: string, options: MarkdownOptions = {}): VNode[] {
  const ctx: Ctx = {
    allowHtml: options.allowHtml ?? false,
    allowRemoteImages: options.allowRemoteImages ?? false,
    externalLinks: options.externalLinks ?? true,
    mathRenderer: options.mathRenderer ?? "source_only",
  };
  const input = cleanText(source);
  const out: VNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      out.push(txt(buffer));
      buffer = "";
    }
  };

  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);

    // code span
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      out.push(inlineCode(code[1]!));
      i += code[0].length;
      continue;
    }

    // inline math
    const math = /^\$([^$\n]{1,400})\$/.exec(rest);
    if (math) {
      flush();
      out.push(mathNode(math[1]!));
      i += math[0].length;
      continue;
    }

    // image ![alt](src)
    const image = /^!\[([^\]]{0,200})\]\(([^)\s]{1,2048})(?:\s+"[^"]*")?\)/.exec(rest);
    if (image) {
      flush();
      out.push(imageNode(image[1]!, image[2]!, ctx));
      i += image[0].length;
      continue;
    }

    // link [label](href)
    const link = /^\[([^\]]{0,400})\]\(([^)\s]{1,2048})(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      out.push(linkNode(renderInline(link[1]!, options), link[2]!, ctx));
      i += link[0].length;
      continue;
    }

    // bare URL autolink
    const auto = /^(https?:\/\/[^\s<>()]{4,2048})/.exec(rest);
    if (auto) {
      flush();
      out.push(linkNode([txt(auto[1]!)], auto[1]!, ctx));
      i += auto[0].length;
      continue;
    }

    // strong ** / __
    const strong = /^(\*\*|__)(?=\S)([\s\S]{1,2000}?)\1/.exec(rest);
    if (strong) {
      flush();
      out.push(el("strong", null, ...renderInline(strong[2]!, options)));
      i += strong[0].length;
      continue;
    }

    // strike ~~
    const strike = /^~~(?=\S)([\s\S]{1,2000}?)~~/.exec(rest);
    if (strike) {
      flush();
      out.push(el("s", null, ...renderInline(strike[1]!, options)));
      i += strike[0].length;
      continue;
    }

    // underline ++ (explicit extension; `__` stays bold to keep Markdown meaning)
    const underline = /^\+\+(?=\S)([\s\S]{1,2000}?)\+\+/.exec(rest);
    if (underline) {
      flush();
      out.push(el("u", null, ...renderInline(underline[1]!, options)));
      i += underline[0].length;
      continue;
    }

    // emphasis * / _
    const em = /^(\*|_)(?=\S)([\s\S]{1,2000}?)\1/.exec(rest);
    if (em) {
      flush();
      out.push(el("em", null, ...renderInline(em[2]!, options)));
      i += em[0].length;
      continue;
    }

    // highlight ==
    const mark = /^==(?=\S)([\s\S]{1,2000}?)==/.exec(rest);
    if (mark) {
      flush();
      out.push(el("mark", null, ...renderInline(mark[1]!, options)));
      i += mark[0].length;
      continue;
    }

    // line break marker
    if (rest.startsWith("  \n") || rest.startsWith("\\\n")) {
      flush();
      out.push(el("br", null));
      i += rest.startsWith("  \n") ? 3 : 2;
      continue;
    }

    buffer += input[i]!;
    i += 1;
  }
  flush();
  return out;
}

/** Raw HTML in markdown: shown as text, never parsed (allow_html is opt-in only). */
function htmlDegrade(html: string, ctx: Ctx): VNode {
  if (ctx.allowHtml) {
    // Even "allowed" HTML is not interpreted here — that would need a real sanitizer
    // with an allowlist per element. Surface it instead of pretending.
    return el("div", { class: "mb-html-flagged", "data-html": "unrendered" }, el("small", null, txt("HTML 블록 (미해석 표시)")), el("pre", null, txt(html)));
  }
  return el("span", { class: "mb-html-dropped", title: "원시 HTML은 실행되지 않습니다" }, el("code", null, txt(html)));
}

/* --------------------------------------------------------------- blocks ---- */

function heading(level: 1 | 2 | 3 | 4 | 5 | 6, text: string, options: MarkdownOptions): VNode {
  const tag = `h${level}` as const;
  return el(tag, { class: `mb-h${level}` }, ...renderInline(text, options));
}

function paragraph(lines: string[], options: MarkdownOptions): VNode {
  const parts: VNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) parts.push(el("br", null));
    parts.push(...renderInline(line, options));
  });
  return el("p", { class: "mb-p" }, ...parts);
}

function tableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function parseTable(lines: string[], options: MarkdownOptions): VNode {
  const header = tableRow(lines[0]!);
  const alignRow = tableRow(lines[1] ?? "");
  const aligns = alignRow.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
  const body = lines.slice(2).map(tableRow);
  return el(
    "table",
    { class: "mb-table" },
    el("caption", { class: "air-sr-only" }, txt("표")),
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        ...header.map((cell, idx) => el("th", { scope: "col", "data-align": aligns[idx] ?? "left" }, ...renderInline(cell, options))),
      ),
    ),
    el(
      "tbody",
      null,
      ...(body.length
        ? body.map((cells) =>
            el(
              "tr",
              null,
              ...cells.map((cell, idx) => el("td", { "data-align": aligns[idx] ?? "left" }, ...renderInline(cell, options))),
            ),
          )
        : []),
    ),
  );
}

function listBlock(lines: string[], ordered: boolean, start: number, options: MarkdownOptions): VNode {
  const items: El[] = [];
  let current: string[] | null = null;
  let checked: boolean | null = null;

  const push = () => {
    if (current === null) return;
    const text = current.join("\n");
    const marker = checked === null ? null : el("span", { class: "mb-check", "aria-hidden": "true", role: undefined }, txt(checked ? "☑" : "☐"));
    const label: VNode[] = [...renderInline(text, options)];
    items.push(el("li", { class: checked === null ? "mb-li" : "mb-li mb-li-check" }, marker, el("span", null, ...label)));
    current = null;
    checked = null;
  };

  for (const line of lines) {
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (task) {
      push();
      current = [task[2]!];
      checked = task[1]!.toLowerCase() === "x";
      continue;
    }
    if (item) {
      push();
      current = [item[1]!];
      checked = null;
      continue;
    }
    if (current) current.push(line.trim());
  }
  push();

  return el(ordered ? "ol" : "ul", ordered && start !== 1 ? { class: "mb-list", start } : { class: "mb-list" }, ...items);
}

export interface MarkdownResult {
  nodes: VNode[];
  /** Feature ids exercised by this parse, used by the feature-coverage test. */
  features: string[];
}

/**
 * Parses a Markdown document into block-level view nodes.
 * Supported: h1-h6, paragraphs, bold/italic/underline/strike/highlight, inline
 * and fenced code with highlighting, ordered/unordered/task lists, blockquote,
 * hr, links, images (policy-gated), tables, TeX source, raw HTML (flagged).
 */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): MarkdownResult {
  const ctx: Ctx = {
    allowHtml: options.allowHtml ?? false,
    allowRemoteImages: options.allowRemoteImages ?? false,
    externalLinks: options.externalLinks ?? true,
    mathRenderer: options.mathRenderer ?? "source_only",
  };
  const lines = cleanText(source).split("\n");
  const nodes: VNode[] = [];
  const features = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // fenced code
    const fence = /^\s*```([A-Za-z0-9_+-]{0,24})\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      nodes.push(el("pre", { class: "mb-code", "data-lang": lang || "text" }, highlightCode(body.join("\n"), lang)));
      features.add("F-008");
      continue;
    }

    // math block
    if (/^\s*\$\$/.test(line)) {
      const body: string[] = [];
      const first = line.replace(/^\s*\$\$\s*/, "");
      if (first.trim().endsWith("$$")) {
        body.push(first.trim().replace(/\$\$\s*$/, ""));
        i += 1;
      } else {
        if (first.trim()) body.push(first);
        i += 1;
        while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i]!)) {
          body.push(lines[i]!);
          i += 1;
        }
        i += 1;
      }
      nodes.push(el("div", { class: "mb-math-block", "data-render": "source_only" }, el("small", null, txt("TeX 수식 (소스)")), el("pre", null, txt(body.join("\n")))));
      features.add("F-018");
      continue;
    }

    // heading
    const atx = /^(#{1,6})\s+(.*)$/.exec(line);
    if (atx) {
      const level = Math.min(6, atx[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
      nodes.push(heading(level, atx[2]!, options));
      features.add("F-009");
      i += 1;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      nodes.push(el("hr", { class: "mb-hr" }));
      features.add("F-014");
      i += 1;
      continue;
    }

    // raw HTML block
    if (/^\s*<[A-Za-z!/]/.test(line)) {
      const html: string[] = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]!)) {
        html.push(lines[i]!);
        i += 1;
      }
      nodes.push(htmlDegrade(html.join("\n"), ctx));
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      const inner = renderMarkdown(quote.join("\n"), options);
      nodes.push(el("blockquote", { class: "mb-quote" }, ...inner.nodes));
      features.add("F-013");
      continue;
    }

    // table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]!)) {
      const table: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        table.push(lines[i]!);
        i += 1;
      }
      nodes.push(parseTable(table, options));
      features.add("F-094");
      continue;
    }

    // list
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const startMatch = /^\s*(\d+)[.)]/.exec(line);
      const listLines: string[] = [];
      while (i < lines.length && (/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && !/^\s*$/.test(lines[i]!)))) {
        listLines.push(lines[i]!);
        i += 1;
      }
      nodes.push(listBlock(listLines, ordered, startMatch ? Number(startMatch[1]) : 1, options));
      features.add(ordered ? "F-010" : "F-011");
      if (listLines.some((l) => /\[[ xX]\]/.test(l))) features.add("F-012");
      continue;
    }

    // paragraph
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]!) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]!) && !/^\s*```/.test(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!) && !/^\s*>/.test(lines[i]!)) {
      para.push(lines[i]!);
      i += 1;
    }
    if (para.length === 0) {
      para.push(lines[i]!);
      i += 1;
    }
    nodes.push(paragraph(para, options));
    features.add("F-001");
    if (para.length > 1) features.add("F-002");
  }

  return { nodes, features: [...features] };
}

export function markdownToPlainText(source: string): string {
  const { nodes } = renderMarkdown(source);
  const walk = (n: VNode): string => {
    if (n.t === "text") return n.v;
    const inner = (n.children ?? []).map(walk).join("");
    return ["p", "h1", "h2", "h3", "h4", "li", "blockquote", "tr", "pre"].includes(n.tag) ? `${inner}\n` : inner;
  };
  return nodes.map(walk).join("").replace(/\n{3,}/g, "\n\n").trim();
}

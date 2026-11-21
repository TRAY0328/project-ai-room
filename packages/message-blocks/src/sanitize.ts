/**
 * Inbound HTML sanitiser (spec 10.3).
 *
 * Inbound HTML is untrusted input. It is tokenised by hand, filtered against an
 * element/attribute allowlist, and rebuilt as a view tree — never re-emitted as
 * an HTML string, so a bypass in this file cannot become script execution, only
 * ugly markup. Anything not understood is dropped and summarised as a warning
 * the UI shows ("HTML 일부 제거됨").
 */
import { el, txt, type El, type Tag, type VNode } from "./types.js";
import { safeUrl, linkAttrs, linkHost } from "./url.js";

const ALLOWED_ELEMENTS = new Set<string>([
  "p", "br", "strong", "b", "em", "i", "u", "s", "del", "code", "pre", "kbd", "mark",
  "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
  "a", "span", "div", "hr", "small", "sub", "sup", "details", "summary", "time",
  "table", "caption", "thead", "tbody", "tr", "th", "td", "dl", "dt", "dd", "figure", "figcaption", "img",
]);

/** Elements whose *content* must disappear with them. */
const DROP_WITH_CONTENT = new Set(["script", "style", "template", "noscript", "object", "embed", "form", "input", "button", "select", "textarea", "meta", "link", "base"]);

/** Elements we keep as a visible placeholder instead of rendering. */
const PLACEHOLDER = new Set(["iframe", "svg", "math", "video", "audio", "canvas"]);

const ATTR_ALLOW: Record<string, Set<string>> = {
  a: new Set(["href", "title", "rel", "target"]),
  img: new Set(["src", "alt", "title", "width", "height", "loading"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  time: new Set(["datetime"]),
  ol: new Set(["start", "type"]),
  details: new Set(["open"]),
};

const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "meta", "link"]);

export interface SanitizeResult {
  node: VNode;
  removed: string[];
  kept: string[];
}

interface Token {
  kind: "text" | "open" | "close" | "self";
  name: string;
  attrs: Record<string, string>;
  text: string;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const lower = html.toLowerCase();
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ kind: "text", name: "", attrs: {}, text: html.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: "text", name: "", attrs: {}, text: html.slice(i, lt) });

    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      tokens.push({ kind: "text", name: "", attrs: {}, text: html.slice(lt) });
      break;
    }
    const raw = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!raw) continue;
    const closing = raw.startsWith("/");
    const body = closing ? raw.slice(1).trim() : raw;
    const selfClosing = body.endsWith("/");
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1]!.toLowerCase();
    const attrText = body.slice(nameMatch[0].length, selfClosing ? body.length - 1 : body.length).trim();

    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrText)) !== null) {
      const key = m[1]!.toLowerCase();
      const value = m[2] ?? m[3] ?? m[4] ?? "";
      // event handlers never make it into the map
      if (key.startsWith("on")) continue;
      attrs[key] = value;
    }
    tokens.push({ kind: closing ? "close" : selfClosing ? "self" : "open", name, attrs, text: "" });
  }
  return tokens;
}

/**
 * Sanitises an HTML fragment. Unknown elements are unwrapped (their text is
 * kept) except scripts/styles/embeds, whose content is removed entirely.
 */
export function sanitizeHtml(html: string, options: { allowRemoteImages?: boolean; externalLinks?: boolean } = {}): SanitizeResult {
  const allowRemoteImages = options.allowRemoteImages ?? false;
  const externalLinks = options.externalLinks ?? true;
  const removed: string[] = [];
  const kept: string[] = [];
  const root: VNode[] = [];
  const stack: Array<{ tag: Tag; attrs: Record<string, string>; children: VNode[] }> = [];

  const push = (node: VNode) => {
    if (stack.length > 0) stack[stack.length - 1]!.children.push(node);
    else root.push(node);
  };

  const tokens = tokenize(html);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "text") {
      if (token.text) push(txt(decodeEntities(token.text)));
      continue;
    }

    if (token.kind === "close") {
      // unwinds to the matching open tag if present; stray closers are ignored
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s]!.tag === (token.name as Tag)) {
          while (stack.length > s) {
            const frame = stack.pop()!;
            push(el(frame.tag, Object.keys(frame.attrs).length > 0 ? frame.attrs : null, ...frame.children));
          }
          break;
        }
      }
      continue;
    }

    if (DROP_WITH_CONTENT.has(token.name)) {
      removed.push(token.name);
      if (token.kind === "open") {
        // skip to the matching closing tag
        let depth = 1;
        while (index + 1 < tokens.length && depth > 0) {
          index += 1;
          const next = tokens[index]!;
          if (next.kind === "open" && next.name === token.name) depth += 1;
          if (next.kind === "close" && next.name === token.name) depth -= 1;
        }
      }
      continue;
    }

    if (PLACEHOLDER.has(token.name)) {
      removed.push(token.name);
      push(el("span", { class: "mb-html-removed" }, txt(`[${token.name} 제거됨 — 실행/임베드는 허용되지 않습니다]`)));
      if (token.kind === "open") {
        let depth = 1;
        while (index + 1 < tokens.length && depth > 0) {
          index += 1;
          const next = tokens[index]!;
          if (next.kind === "open" && next.name === token.name) depth += 1;
          if (next.kind === "close" && next.name === token.name) depth -= 1;
        }
      }
      continue;
    }

    if (!ALLOWED_ELEMENTS.has(token.name)) {
      removed.push(token.name);
      continue; // unwrap: content still flows into the parent
    }

    kept.push(token.name);
    const tag = (token.name === "b" ? "strong" : token.name === "i" ? "em" : token.name === "del" ? "s" : token.name) as Tag;
    const attrs: Record<string, string> = {};
    const allowed = ATTR_ALLOW[token.name];

    if (allowed) {
      for (const [key, value] of Object.entries(token.attrs)) {
        if (!allowed.has(key)) continue;
        if (key === "href") {
          const decision = safeUrl(value);
          if (!decision.ok || !decision.url) {
            removed.push(`href:${decision.reason ?? "invalid"}`);
            continue;
          }
          Object.assign(attrs, linkAttrs(decision.url, externalLinks));
          attrs["data-host"] = linkHost(decision.url) ?? "";
          continue;
        }
        if (key === "src") {
          const decision = safeUrl(value);
          const remote = /^https?:/i.test(decision.url ?? "");
          if (!decision.ok || !decision.url || (remote && !allowRemoteImages)) {
            removed.push(`img-src:${decision.reason ?? "remote_blocked"}`);
            continue;
          }
          attrs.src = decision.url;
          continue;
        }
        attrs[key] = value;
      }
    }

    if (tag === "img") {
      if (!attrs.src) {
        push(el("span", { class: "mb-image-blocked" }, txt(`[이미지 미표시: ${token.attrs.alt ?? "대체 텍스트 없음"}]`)));
        continue;
      }
      attrs.loading = attrs.loading ?? "lazy";
      attrs.alt = attrs.alt ?? "첨부 이미지";
      push(el("img", attrs));
      continue;
    }

    if (token.kind === "self" || VOID_ELEMENTS.has(token.name)) {
      push(el(tag, attrs));
      continue;
    }

    stack.push({ tag, attrs, children: [] });
  }

  // unclosed tags are closed at the end (their children stay visible)
  while (stack.length > 0) {
    const frame = stack.pop()!;
    push(el(frame.tag, Object.keys(frame.attrs).length > 0 ? frame.attrs : null, ...frame.children));
  }

  return { node: el("div", { class: "mb-html" }, ...root), removed: unique(removed), kept: unique(kept) };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "\ufffd";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "\ufffd";
  }
}

/** Convenience: plain text of a sanitised fragment (search indexing, previews). */
export function sanitizeHtmlToText(html: string): string {
  const { node } = sanitizeHtml(html, { allowRemoteImages: false });
  const walk = (n: VNode): string => (n.t === "text" ? n.v : (n.children ?? []).map(walk).join(""));
  return walk(node).replace(/\s+/g, " ").trim();
}

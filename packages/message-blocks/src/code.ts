/**
 * Small syntax highlighter (spec 10.3: code is rendered, never executed).
 *
 * Not a compiler front-end: it tokenises comments, strings, numbers, keywords
 * and call sites for a fixed language list. Unknown languages are shown plain
 * and labelled `data-highlight="none"` instead of being guessed at.
 */
import { el, txt, type VNode } from "./types.js";

interface LangSpec {
  lineComment?: string[];
  blockComment?: [string, string];
  strings?: Array<[string, string]>;
  keywords: string[];
  boolean?: string[];
}

const COMMON = ["return", "if", "else", "for", "while", "break", "continue", "const", "let", "var", "function", "class", "new", "try", "catch", "throw", "import", "export", "from", "as", "async", "await", "yield", "switch", "case", "default", "delete", "in", "of", "instanceof", "typeof", "void"];

export const LANGUAGE_SPECS: Record<string, LangSpec> = {
  typescript: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: [["`", "`"], ['"', '"'], ["'", "'"]], keywords: [...COMMON, "interface", "type", "enum", "implements", "extends", "readonly", "public", "private", "protected", "declare", "namespace", "satisfies", "never", "unknown", "any", "string", "number", "boolean"], boolean: ["true", "false", "null", "undefined"] },
  javascript: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: [["`", "`"], ['"', '"'], ["'", "'"]], keywords: [...COMMON, "this", "super", "extends"], boolean: ["true", "false", "null", "undefined"] },
  json: { strings: [['"', '"']], keywords: [], boolean: ["true", "false", "null"] },
  python: { lineComment: ["#"], strings: [['"""', '"""'], ["'''", "'''"], ['"', '"'], ["'", "'"]], keywords: ["def", "class", "import", "from", "as", "return", "if", "elif", "else", "for", "while", "try", "except", "finally", "with", "lambda", "yield", "async", "await", "pass", "raise", "global", "nonlocal", "assert", "del", "in", "is", "not", "and", "or", "self"], boolean: ["True", "False", "None"] },
  shell: { lineComment: ["#"], strings: [['"', '"'], ["'", "'"]], keywords: ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "return", "export", "local", "set", "unset", "cd", "echo", "exit"] },
  sql: { lineComment: ["--"], blockComment: ["/*", "*/"], strings: [["'", "'"]], keywords: ["select", "from", "where", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "insert", "into", "values", "update", "set", "delete", "create", "table", "index", "alter", "drop", "primary", "key", "foreign", "references", "not", "null", "default", "with", "as", "union", "all", "distinct"], boolean: ["true", "false", "null"] },
  yaml: { lineComment: ["#"], strings: [['"', '"'], ["'", "'"]], keywords: [], boolean: ["true", "false", "null", "yes", "no"] },
  html: { blockComment: ["<!--", "-->"], strings: [['"', '"'], ["'", "'"]], keywords: [] },
  css: { blockComment: ["/*", "*/"], strings: [['"', '"'], ["'", "'"]], keywords: [] },
  kotlin: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: [['"""', '"""'], ['"', '"']], keywords: [...COMMON, "fun", "val", "object", "data", "sealed", "when", "is", "companion", "override", "suspend", "lateinit"], boolean: ["true", "false", "null"] },
  rust: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: [['"', '"']], keywords: [...COMMON, "fn", "let", "mut", "impl", "trait", "struct", "enum", "match", "pub", "use", "mod", "crate", "where", "unsafe"], boolean: ["true", "false", "None", "Some"] },
  go: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: [["`", "`"], ['"', '"']], keywords: [...COMMON, "func", "package", "type", "struct", "interface", "go", "defer", "chan", "select", "map", "range"], boolean: ["true", "false", "nil"] },
};

const ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", sh: "shell", bash: "shell", zsh: "shell", yml: "yaml", kt: "kotlin", rs: "rust", golang: "go", htm: "html",
};

export const SUPPORTED_LANGUAGES: readonly string[] = Object.freeze(Object.keys(LANGUAGE_SPECS));

export function normalizeLanguage(lang: string): string {
  const lower = (lang || "").toLowerCase().trim();
  return ALIASES[lower] ?? lower;
}

export function isHighlightedLanguage(lang: string): boolean {
  return normalizeLanguage(lang) in LANGUAGE_SPECS;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Multi-character delimiters first so `"""` is not read as an empty string. */
function stringAlternative(spec: LangSpec): string {
  const pairs = [...(spec.strings ?? [])].sort((a, b) => b[0].length - a[0].length);
  return pairs
    .map(([open, close]) => `${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(close)}`)
    .join("|");
}

interface TokenRule {
  kind: "comment" | "string" | "number" | "identifier";
  pattern: string;
}

export function rulesFor(spec: LangSpec): TokenRule[] {
  const rules: TokenRule[] = [];
  if (spec.blockComment) rules.push({ kind: "comment", pattern: `${escapeRegExp(spec.blockComment[0])}[\\s\\S]*?${escapeRegExp(spec.blockComment[1])}` });
  if (spec.lineComment?.length) rules.push({ kind: "comment", pattern: `(?:${spec.lineComment.map(escapeRegExp).join("|")})[^\\n]*` });
  if (spec.strings?.length) rules.push({ kind: "string", pattern: stringAlternative(spec) });
  rules.push({ kind: "number", pattern: "\\d+(?:\\.\\d+)?" });
  rules.push({ kind: "identifier", pattern: "[A-Za-z_$][A-Za-z0-9_$]*" });
  return rules;
}

/** Token stream → VNodes; every value is a text node, so nothing can inject markup. */
export function highlightCode(code: string, language: string): VNode {
  const lang = normalizeLanguage(language);
  const spec = LANGUAGE_SPECS[lang];
  if (!spec || !code) {
    return el("code", { class: "mb-code-inner", "data-highlight": "none" }, txt(code));
  }

  const rules = rulesFor(spec);
  const combined = new RegExp(rules.map((r) => `(${r.pattern})`).join("|"), "g");
  const keywords = new Set(spec.keywords);
  const bools = new Set(spec.boolean ?? []);
  const parts: VNode[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = combined.exec(code)) !== null) {
    if (match.index > lastEnd) parts.push(txt(code.slice(lastEnd, match.index)));
    const groupIndex = match.slice(1).findIndex((g) => g !== undefined);
    const rule = rules[groupIndex];
    const token = match[0];
    lastEnd = combined.lastIndex;

    if (!rule) {
      parts.push(txt(token));
      continue;
    }
    switch (rule.kind) {
      case "comment":
        parts.push(el("span", { class: "hl-com" }, txt(token)));
        break;
      case "string":
        parts.push(el("span", { class: "hl-str" }, txt(token)));
        break;
      case "number":
        parts.push(el("span", { class: "hl-num" }, txt(token)));
        break;
      case "identifier": {
        const isCall = code.charAt(combined.lastIndex) === "(";
        if (keywords.has(token)) parts.push(el("span", { class: "hl-kw" }, txt(token)));
        else if (bools.has(token)) parts.push(el("span", { class: "hl-bool" }, txt(token)));
        else if (isCall) parts.push(el("span", { class: "hl-fn" }, txt(token)));
        else if (/^[A-Z]/.test(token)) parts.push(el("span", { class: "hl-type" }, txt(token)));
        else parts.push(txt(token));
        break;
      }
      default:
        parts.push(txt(token));
    }
  }
  if (lastEnd < code.length) parts.push(txt(code.slice(lastEnd)));

  return el("code", { class: "mb-code-inner", "data-highlight": lang }, ...parts);
}

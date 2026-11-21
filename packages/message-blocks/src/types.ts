/**
 * Structured message block model (spec 10.2).
 *
 * Every message is a common envelope plus `blocks[]`. A block carries
 * `type`, `version`, `payload`, optional `source_ref` and `render_policy`.
 *
 * Rendering never produces an HTML string. It produces a closed-set view tree
 * (`VNode`) whose tags come from `TAG_ALLOWLIST` and whose attributes are
 * written only by this package. React renders that tree element-by-element, so
 * untrusted text can never become markup — there is no innerHTML anywhere in
 * the chat path.
 */

export const TAG_ALLOWLIST = [
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code", "a", "strong", "em", "u", "s", "mark",
  "hr", "br", "table", "caption", "thead", "tbody", "tr", "th", "td",
  "figure", "figcaption", "img", "svg", "g", "path", "text", "rect", "line", "polyline", "circle",
  "details", "summary", "dl", "dt", "dd", "section", "header", "footer", "aside", "time", "small", "abbr",
  "article", "nav", "main",
] as const;

export type Tag = (typeof TAG_ALLOWLIST)[number];

export interface AttrValue {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface El {
  readonly t: "el";
  readonly tag: Tag;
  readonly attrs?: AttrValue;
  readonly children?: readonly VNode[];
}

export interface Txt {
  readonly t: "text";
  readonly v: string;
}

export type VNode = El | Txt;

export type BlockType =
  | "text"
  | "markdown"
  | "code"
  | "diff"
  | "terminal_log"
  | "test_result"
  | "file_ref"
  | "image_ref"
  | "video_ref"
  | "audio_ref"
  | "json"
  | "table"
  | "chart"
  | "task_ref"
  | "project_ref"
  | "commit_ref"
  | "pr_ref"
  | "approval_ref"
  | "poll"
  | "status"
  | "link_preview"
  | "callout"
  | "quote"
  | "memory_ref"
  | "artifact_ref";

export const KNOWN_BLOCK_TYPES: readonly BlockType[] = Object.freeze([
  "text", "markdown", "code", "diff", "terminal_log", "test_result", "file_ref", "image_ref",
  "video_ref", "audio_ref", "json", "table", "chart", "task_ref", "project_ref", "commit_ref",
  "pr_ref", "approval_ref", "poll", "status", "link_preview", "callout", "quote", "memory_ref", "artifact_ref",
]);

export interface SourceRef {
  /** e.g. "message", "file", "commit", "pr", "memory", "artifact", "github_actions_run" */
  kind: string;
  id: string;
  url?: string;
  sha256?: string;
  label?: string;
}

export interface RenderPolicy {
  /** Remote images stay off by default: they leak the reader to a third party. */
  allow_remote_images?: boolean;
  /** Raw HTML inside markdown is dropped unless explicitly allowed. */
  allow_html?: boolean;
  /** Hard cap on rendered characters per block (large logs are truncated). */
  max_chars?: number;
  /** Show LaTeX source instead of pretending to typeset without a renderer. */
  math_renderer?: "source_only" | "katex";
}

export interface MessageBlock {
  type: string;
  version: number;
  payload: Record<string, unknown>;
  source_ref?: SourceRef;
  render_policy?: RenderPolicy;
}

export interface MessageVersionRef {
  version_id: string;
  revision: number;
  body_sha256: string;
  created_at: string;
  editor_actor_id?: string;
}

export interface MessageEnvelope {
  id: string;
  room_id: string;
  author: {
    actor_id: string;
    kind: "agent" | "owner";
    display_name: string;
    /** Display-only; capability proof lives in the provider record, not here. */
    attestation?: "provider_verified" | "discovery_verified" | "self_declared" | "unknown";
    avatar_url?: string;
  };
  blocks: MessageBlock[];
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  revision?: number;
  versions?: MessageVersionRef[];
  thread_root_id?: string | null;
  reply_count?: number;
  project_id?: string | null;
  /** Server-assigned room ordering authority; null when unknown. */
  room_seq?: number | null;
  delivery?: "queued" | "server_stored" | "delivered" | "read" | "failed";
}

export interface RenderOptions {
  policy?: RenderPolicy;
  /** Deterministic clock for tests; defaults to Date.now(). */
  now?: number;
  /** Whether the current reader may open external links. */
  externalLinks?: boolean;
}

/* ------------------------------------------------------------------ builders */

export function txt(v: string): Txt {
  return { t: "text", v };
}

export function el(tag: Tag, attrs: AttrValue | null, ...children: Array<VNode | string | null | undefined | false>): El {
  const clean: VNode[] = [];
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    clean.push(typeof child === "string" ? txt(child) : child);
  }
  return attrs ? { t: "el", tag, attrs, children: clean } : { t: "el", tag, children: clean };
}

/** Flattens a nested tree into plain text (used by search indexing / tests). */
export function vnodeText(node: VNode | readonly VNode[]): string {
  if (Array.isArray(node)) return (node as readonly VNode[]).map(vnodeText).join("");
  const n = node as VNode;
  if (n.t === "text") return n.v;
  return (n.children ?? []).map(vnodeText).join("");
}

/** Collects every tag / attribute name used, for security assertions. */
export function vnodeStats(node: VNode | readonly VNode[]): { tags: Set<string>; attrs: Set<string>; text: string } {
  const tags = new Set<string>();
  const attrs = new Set<string>();
  const walk = (n: VNode) => {
    if (n.t === "text") return;
    tags.add(n.tag);
    for (const key of Object.keys(n.attrs ?? {})) attrs.add(key);
    for (const child of n.children ?? []) walk(child);
  };
  if (Array.isArray(node)) (node as readonly VNode[]).forEach(walk);
  else walk(node as VNode);
  return { tags, attrs, text: vnodeText(node) };
}

/** JSON-safe form of a view tree (virtual DOM debugging / fixtures). */
export function toJSON(node: VNode | readonly VNode[]): unknown {
  if (Array.isArray(node)) return (node as readonly VNode[]).map(toJSON);
  const n = node as VNode;
  return n.t === "text" ? { text: n.v } : { tag: n.tag, attrs: n.attrs ?? {}, children: (n.children ?? []).map(toJSON) };
}

/**
 * @ai-room/message-blocks — safe structured message rendering core.
 *
 * Pure, dependency-free and environment-agnostic: parse Markdown, sanitise
 * untrusted payloads into a closed-set view tree, render all 25 block types,
 * parse diffs, highlight code. React binding lives in `./react`.
 */
export * from "./types.js";
export * from "./url.js";
export * from "./text.js";
export * from "./code.js";
export * from "./markdown.js";
export * from "./diff.js";
export * from "./blocks.js";
export * from "./data.js";
export * from "./message.js";
export * from "./features.js";
export * from "./sanitize.js";

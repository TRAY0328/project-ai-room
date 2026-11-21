import { createElement, Fragment, type CSSProperties, type ReactNode } from "react";
import type { VNode } from "./types.js";
import type { RenderedMessage } from "./message.js";

/**
 * React binding for the closed-set view tree.
 *
 * Elements are created with `createElement`; no `dangerouslySetInnerHTML` exists
 * in this path, so even a malformed attribute can only produce a broken prop,
 * never markup injection. Attribute names are mapped explicitly.
 */
const ATTR_MAP: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  colspan: "colSpan",
  rowspan: "rowSpan",
  viewbox: "viewBox",
  "stroke-width": "strokeWidth",
  "stroke-opacity": "strokeOpacity",
  "fill-opacity": "fillOpacity",
  "aria-valuenow": "aria-valuenow",
  "aria-valuemin": "aria-valuemin",
  "aria-valuemax": "aria-valuemax",
  "aria-valuetext": "aria-valuetext",
  datetime: "dateTime",
  tabindex: "tabIndex",
  "data-lang": "data-lang",
};

const PASSTHROUGH = new Set([
  "href", "rel", "target", "src", "alt", "title", "dir", "lang", "loading", "decoding",
  "scope", "start", "type", "colSpan", "rowSpan", "open", "role", "id", "style",
]);

function propsFor(attrs: Record<string, string | number | boolean | undefined> | undefined, key: string): Record<string, unknown> {
  if (!attrs) return { key };
  const out: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const mapped = ATTR_MAP[name] ?? name;
    // `class` → `className` is the one mapped attribute React would otherwise
    // drop: without it every block rendered unstyled and the message header
    // (author · time · delivery · seq) collapsed into one run of text.
    if (mapped === "className") {
      out.className = String(value);
      continue;
    }
    const isData = mapped.startsWith("data-") || mapped.startsWith("aria-");
    if (!isData && !PASSTHROUGH.has(mapped)) continue;
    if (mapped === "style" && typeof value === "string") {
      out.style = parseStyle(value);
      continue;
    }
    out[mapped] = value;
  }
  return out;
}

/** Only `prop: value;` pairs from our own builders; no url() or expression(). */
function parseStyle(value: string): CSSProperties {
  const style: Record<string, string> = {};
  for (const part of value.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!/^[a-zA-Z-]+$/.test(prop) || /url\s*\(|expression\s*\(|javascript:/i.test(val)) continue;
    style[prop] = val;
  }
  return style as CSSProperties;
}

export function vnodeToReact(node: VNode, index = 0): ReactNode {
  if (node.t === "text") return node.v;
  const children = (node.children ?? []).map((child, i) => vnodeToReact(child, i));
  return createElement(node.tag, propsFor(node.attrs, `n${index}`), children.length > 0 ? children : undefined);
}

export function VNodeView({ node, className }: { node: VNode; className?: string }): JSX.Element {
  return <Fragment>{className ? <div className={className}>{vnodeToReact(node)}</div> : vnodeToReact(node)}</Fragment>;
}

export function MessageBody({ message }: { message: RenderedMessage }): JSX.Element {
  return <Fragment>{vnodeToReact(message.node)}</Fragment>;
}

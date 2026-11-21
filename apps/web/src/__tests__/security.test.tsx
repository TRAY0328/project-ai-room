/**
 * XSS through the React path.
 *
 * The core renderer test proves the view tree is clean; this test proves the
 * React binding keeps it clean in the DOM — no script element, no event handler
 * attribute, no executable URL, and no `dangerouslySetInnerHTML` anywhere.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Providers } from "./harness.js";
import { MessageCard } from "../components/chat/index.js";
import type { MessageDto } from "../api/types.js";

const hostile: MessageDto = {
  message_id: "evil-1",
  room_id: "room-default",
  room_seq: 1,
  author: { actor_id: "agent-x", display_name: "<img onerror=alert(1)>", kind: "agent" },
  created_at: new Date().toISOString(),
  delivery: "server_stored",
  blocks: [
    { type: "markdown", version: 1, payload: { markdown: '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![p](https://tracker.example/p.png)\n\n<img src=x onerror=alert(1)>' } },
    { type: "text", version: 1, payload: { text: "<svg onload=alert(1)></svg>" } },
    { type: "code", version: 1, payload: { code: "</code><script>alert(1)</script>", language: "html" } },
    { type: "file_ref", version: 1, payload: { name: "<script>a</script>", mime: "text/html", url: "javascript:alert(1)" } },
    { type: "callout", version: 1, payload: { tone: "risk", title: "<script>", body: "<iframe src=x></iframe>" } },
  ],
};

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("message rendering safety", () => {
  it("renders hostile content as text, never as executable DOM", () => {
    const { container } = render(<Providers><MessageCard message={hostile} handlers={{}} /></Providers>);
    const html = container.innerHTML;

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("svg[onload]")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    // no element may carry an event handler attribute (an escaped aria-label
    // that *contains* the text "onerror=" is not an attribute — check the DOM)
    const handlerAttrs: string[] = [];
    container.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) handlerAttrs.push(`${el.tagName}.${attr.name}`);
      }
    });
    expect(handlerAttrs).toEqual([]);
    // and no surviving URL may be executable
    const urls: string[] = [];
    container.querySelectorAll("[href],[src]").forEach((el) => {
      const value = el.getAttribute("href") ?? el.getAttribute("src") ?? "";
      urls.push(value);
    });
    for (const url of urls) expect(/^\s*(javascript|data|vbscript):/i.test(url)).toBe(false);

    // the payload is still visible to a human reader
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toMatch(/원격 이미지/);
  });

  it("never uses dangerouslySetInnerHTML in the client", () => {
    const files = collectFiles(join(process.cwd(), "src")).filter((file) => !file.includes("__tests__"));
    const needle = ["dangerously", "SetInnerHTML"].join("");
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes(needle));
    expect(offenders).toEqual([]);
  });
});

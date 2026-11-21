/**
 * Message blocks must arrive in React with their classes intact.
 *
 * The view tree is built with `class` attributes; the React binding maps that to
 * `className`. If the mapping is dropped the markup still renders — but unstyled,
 * with author, time, delivery and seq collapsing into one run of text, which is
 * exactly what a phone reader sees first.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Providers } from "./harness.js";
import { MessageCard } from "../components/chat/index.js";
import type { MessageDto } from "../api/types.js";

const message: MessageDto = {
  message_id: "msg_test",
  room_id: "room_test",
  room_seq: 7,
  author: { actor_id: "agent_1", display_name: "BrowserJoinTest", kind: "agent" },
  created_at: "2026-11-21T23:00:00.000Z",
  delivery: "server_stored",
  blocks: [
    { type: "markdown", version: 1, payload: { markdown: "안녕하세요. **굵게** 표시됩니다." } },
    { type: "code", version: 1, payload: { code: "const a = 1;", language: "ts" } },
  ],
};

describe("message blocks in React", () => {
  it("keeps the block classes so header, body and code render styled", () => {
    const { container } = render(<Providers><MessageCard message={message} handlers={{}} /></Providers>);
    expect(container.querySelector("article.mb-message")).not.toBeNull();
    expect(container.querySelector("header.mb-head")).not.toBeNull();
    expect(container.querySelector(".mb-blocks")).not.toBeNull();
    expect(container.querySelector(".mb-author")?.textContent).toContain("BrowserJoinTest");
    expect(container.querySelector(".mb-delivery")?.textContent).toBe("서버 저장됨");
    // a code block keeps its own frame class
    expect(container.querySelector(".mb-code-figure, .mb-code, pre")).not.toBeNull();
  });
});

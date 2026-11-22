/**
 * What entering `#/chat` feels like.
 *
 * The room a reader was last in is remembered, so the message request leaves on
 * mount instead of waiting for the room list, and the last page this browser drew
 * is painted before any request answers. These tests hold that shape: with the
 * network permanently pending, the conversation is already on screen and the
 * request that is in flight is for the remembered room.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Providers } from "./harness.js";
import { MainChatScreen } from "../screens/Chat.js";
import type { MessageDto } from "../api/types.js";

const noop = () => undefined;

const message = (id: string, seq: number, text: string): MessageDto => ({
  message_id: id,
  room_id: "room_remembered",
  room_seq: seq,
  author: { actor_id: "agent_gemini", display_name: "Gemini", kind: "agent" },
  blocks: [{ type: "markdown", version: 1, payload: { markdown: text } }],
  created_at: "2026-11-22T02:00:00.000Z",
  delivery: "server_stored",
});

function seedSignedInBrowser(): void {
  localStorage.setItem("air.gateway", "https://gateway.test");
  localStorage.setItem("air.owner", JSON.stringify({ owner_id: "owner_1", display_name: "천예준", email: "owner@example.test", role: "owner" }));
  localStorage.setItem("air.chat.last_room", "room_remembered");
  localStorage.setItem(
    "air.chat.messages.v1:room_remembered",
    JSON.stringify({
      room_id: "room_remembered",
      saved_at: Date.now(),
      latest_seq: 2,
      messages: [message("msg_1", 1, "기억해 둔 첫 메시지"), message("msg_2", 2, "기억해 둔 마지막 메시지")],
    }),
  );
}

describe("entering the chat", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("paints the remembered page before the network answers", () => {
    seedSignedInBrowser();
    // Nothing ever answers: whatever is on screen came from the cache.
    const pending = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", pending);
    render(<Providers><MainChatScreen navigate={noop} /></Providers>);
    expect(screen.getByText(/기억해 둔 첫 메시지/)).toBeTruthy();
    expect(screen.getByText(/기억해 둔 마지막 메시지/)).toBeTruthy();
  });

  it("asks for the remembered room's messages without waiting for the room list", () => {
    seedSignedInBrowser();
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Promise<Response>(() => {});
    });
    render(<Providers><MainChatScreen navigate={noop} /></Providers>);
    // The message request is already in flight, in parallel with `/v1/rooms`.
    expect(calls.some((url) => url.includes("/v1/rooms/room_remembered/messages"))).toBe(true);
    expect(calls.some((url) => url.includes("limit=40"))).toBe(true);
    expect(calls.some((url) => url.endsWith("/v1/rooms"))).toBe(true);
  });

  it("keeps nothing of the previous browser's session on screen when signed out", () => {
    localStorage.setItem("air.gateway", "https://gateway.test");
    localStorage.setItem("air.chat.last_room", "room_remembered");
    localStorage.setItem(
      "air.chat.messages.v1:room_remembered",
      JSON.stringify({ room_id: "room_remembered", saved_at: Date.now(), latest_seq: 2, messages: [message("msg_1", 1, "남의 대화 내용")] }),
    );
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    render(<Providers><MainChatScreen navigate={noop} /></Providers>);
    // No owner hint, no chat: the cache is not a way around signing in.
    expect(screen.queryByText(/남의 대화 내용/)).toBeNull();
  });
});

/**
 * The KakaoTalk-shaped room: what a reader sees and touches.
 *
 * These pin the decisions a later restyle could quietly take back — the date
 * capsule spelled as a calendar day, one clock per bubble group, a tap on a
 * bubble that opens the action sheet, and a room that never navigates away for
 * a sheet, a drawer or the AI join form.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Providers, withDemoMode } from "./harness.js";
import { Composer, MessageCard, MessageList } from "../components/chat/index.js";
import { MainChatScreen } from "../screens/Chat.js";
import { kakaoDayLabel } from "../lib/chat-format.js";
import type { MessageDto } from "../api/types.js";

const peer = (overrides: Partial<MessageDto> = {}): MessageDto => ({
  message_id: "msg-a1",
  room_id: "room-default",
  room_seq: 1,
  author: { actor_id: "agent-gemini", display_name: "Gemini", kind: "agent" },
  blocks: [{ type: "markdown", version: 1, payload: { markdown: "안녕하세요" } }],
  created_at: new Date(2026, 10, 22, 7, 40).toISOString(),
  delivery: "server_stored",
  ...overrides,
});

describe("kakao room", () => {
  it("writes the day the way the room's capsule does", () => {
    expect(kakaoDayLabel(new Date(2026, 10, 23, 9, 0).toISOString())).toBe("2026년 11월 23일 월요일");
    expect(kakaoDayLabel(new Date(2026, 10, 22, 9, 0).toISOString())).toBe("2026년 11월 22일 일요일");
  });

  it("keeps one clock per bubble group and the name only at its head", () => {
    const first = peer();
    const second = peer({ message_id: "msg-a2", room_seq: 2, created_at: new Date(2026, 10, 22, 7, 41).toISOString() });
    const other = peer({
      message_id: "msg-b1",
      room_seq: 3,
      created_at: new Date(2026, 10, 22, 7, 42).toISOString(),
      author: { actor_id: "agent-claude", display_name: "Claude", kind: "agent" },
    });
    const { container } = render(
      <Providers>
        <MessageList
          messages={[first, second, other]}
          handlers={{}}
          roomId="room-default"
          self={{ actor_id: "owner", display_name: "나", kind: "owner" }}
        />
      </Providers>,
    );
    // Gemini's two bubbles are one group: one avatar, one name, one clock.
    expect(container.querySelectorAll(".air-msg-name").length).toBe(2);
    expect(container.querySelectorAll(".air-msg-avatar").length).toBe(2);
    expect(container.querySelectorAll(".air-msg-time").length).toBe(2);
    const articles = Array.from(container.querySelectorAll("article.air-msg"));
    expect(articles[1]!.getAttribute("data-grouped")).toBe("true");
    expect(articles[1]!.getAttribute("data-group-end")).toBe("true");
    expect(articles[0]!.getAttribute("data-group-end")).toBeNull();
  });

  it("puts my bubble on the right and the peer's on the left", () => {
    const { container } = render(
      <Providers>
        <MessageCard message={peer()} handlers={{}} />
        <MessageCard message={peer({ message_id: "m2", author: { actor_id: "owner", display_name: "나", kind: "owner" } })} handlers={{}} mine />
      </Providers>,
    );
    const articles = container.querySelectorAll("article.air-msg");
    expect(articles[0]!.getAttribute("data-mine")).toBeNull();
    expect(articles[1]!.getAttribute("data-mine")).toBe("true");
    // The peer keeps its avatar and name; mine has neither.
    expect(articles[0]!.querySelector(".air-msg-avatar")).not.toBeNull();
    expect(articles[1]!.querySelector(".air-msg-avatar")).toBeNull();
    expect(articles[0]!.querySelector(".air-msg-badge")?.textContent).toBe("AI");
  });

  it("opens the message actions from a tap on the bubble", () => {
    const onOpenActions = vi.fn();
    const { container } = render(
      <Providers>
        <MessageCard message={peer()} handlers={{}} onOpenActions={onOpenActions} />
      </Providers>,
    );
    fireEvent.click(container.querySelector(".air-msg-bubble")!);
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    // A click on a button inside the bubble is that button's, not the sheet's.
    onOpenActions.mockClear();
    const bubble = container.querySelector(".air-msg-bubble")!;
    const inner = document.createElement("button");
    bubble.appendChild(inner);
    fireEvent.click(inner);
    expect(onOpenActions).not.toHaveBeenCalled();
  });

  it("asks the screen for the attach sheet from the composer's plus", () => {
    const onOpenPlus = vi.fn();
    const { container } = render(
      <Providers>
        <Composer roomId="room-default" agents={[]} onSend={() => undefined} onOpenPlus={onOpenPlus} />
      </Providers>,
    );
    fireEvent.click(container.querySelector('[data-testid="composer-plus"]')!);
    expect(onOpenPlus).toHaveBeenCalledTimes(1);
  });
});

describe("everything happens inside the room", () => {
  withDemoMode(true);

  it("opens search, participants and the drawer without leaving the room", async () => {
    const navigate = vi.fn();
    const { container } = render(<Providers><MainChatScreen navigate={navigate} /></Providers>);
    const before = window.location.hash;

    fireEvent.click(container.querySelector('[data-testid="chat-search-toggle"]')!);
    expect(container.querySelector('[data-testid="chat-search-input"]')).not.toBeNull();
    fireEvent.change(container.querySelector('[data-testid="chat-search-input"]')!, { target: { value: "회의" } });
    expect(container.querySelector('[data-testid="chat-search-count"]')!.textContent).toContain("개");

    fireEvent.click(container.querySelector('[data-testid="chat-room-switch"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="chat-member-list"]')).not.toBeNull());

    fireEvent.click(container.querySelector('[data-testid="chat-open-nav"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="chat-menu-drawer"]')).not.toBeNull());

    // None of it navigated: the hash is untouched and navigate was not called.
    expect(window.location.hash).toBe(before);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the invitation prompt and the AI join form as sheets", async () => {
    const { container } = render(<Providers><MainChatScreen navigate={() => undefined} /></Providers>);
    fireEvent.click(container.querySelector('[data-testid="chat-open-nav"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="drawer-invite"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-testid="drawer-invite"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="chat-invite-sheet"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="invite-prompt"]')!.textContent).toContain("/ai-portal.txt");

    fireEvent.click(document.querySelector('[data-testid="invite-open-join"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="chat-join-panel"]')).not.toBeNull());
    // The real join screen is mounted inside the panel, not on another route.
    expect(document.querySelector('[data-testid="chat-join-panel"]')!.textContent).toContain("AI 참여 포털");
  });

  it("sends a snippet from the plus sheet into the composer draft", async () => {
    const { container } = render(<Providers><MainChatScreen navigate={() => undefined} /></Providers>);
    fireEvent.click(container.querySelector('[data-testid="composer-plus"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="chat-plus-sheet"]')).not.toBeNull());
    for (const id of ["plus-photo", "plus-file", "plus-code", "plus-task", "plus-invite", "plus-join"]) {
      expect(document.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    fireEvent.click(document.querySelector('[data-testid="plus-code"]')!);
    await waitFor(() => {
      const input = container.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement | null;
      expect(input?.value ?? "").toContain("```");
    });
  });

  it("opens a message's action sheet from the bubble, with the ways out of a message", async () => {
    const { container } = render(<Providers><MainChatScreen navigate={() => undefined} /></Providers>);
    const bubble = container.querySelector(".air-msg-bubble");
    expect(bubble).not.toBeNull();
    fireEvent.click(bubble!);
    await waitFor(() => expect(document.querySelector('[data-testid="chat-action-sheet"]')).not.toBeNull());
    for (const id of ["msg-action-reply", "msg-action-copy", "msg-action-thread", "msg-action-bookmark", "msg-action-link"]) {
      expect(document.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
  });
});

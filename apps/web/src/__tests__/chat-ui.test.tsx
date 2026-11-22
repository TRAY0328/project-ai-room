/**
 * Chat surface behaviour: the parts a reader feels rather than reads.
 *
 * Send keys, the Korean IME guard, mention keyboard selection, own/peer bubble
 * sides and the natural Korean clock are all decisions the UI makes; each one is
 * pinned here so a later restyle cannot quietly take them back.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Providers } from "./harness.js";
import { Composer, MessageCard, MessageList, type ComposerSendMeta } from "../components/chat/index.js";
import { chatTime, dayLabel, plainTextOf } from "../lib/chat-format.js";
import type { MessageDto } from "../api/types.js";

const agents = [
  { agent_id: "agent-gemini", display_name: "Gemini", kind: "agent" },
  { agent_id: "owner", display_name: "천예준", kind: "owner" },
];

const message = (overrides: Partial<MessageDto> = {}): MessageDto => ({
  message_id: "msg-1",
  room_id: "room-default",
  room_seq: 11,
  author: { actor_id: "agent-gemini", display_name: "Gemini", kind: "agent" },
  blocks: [{ type: "markdown", version: 1, payload: { markdown: "안녕하세요 **Gemini**입니다." } }],
  created_at: "2026-11-22T02:43:00.000Z",
  delivery: "server_stored",
  ...overrides,
});

function renderComposer(onSend: (blocks: MessageDto["blocks"], plain: string, meta?: ComposerSendMeta) => void) {
  const utils = render(
    <Providers>
      <Composer roomId="room-default" agents={agents} onSend={onSend} />
    </Providers>,
  );
  const textarea = utils.container.querySelector("textarea") as HTMLTextAreaElement;
  return { ...utils, textarea };
}

describe("composer keys", () => {
  it("sends on Enter", () => {
    const onSend = vi.fn();
    const { textarea } = renderComposer(onSend);
    fireEvent.change(textarea, { target: { value: "안녕" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![1]).toBe("안녕");
  });

  it("keeps Shift+Enter as a line break", () => {
    const onSend = vi.fn();
    const { textarea } = renderComposer(onSend);
    fireEvent.change(textarea, { target: { value: "첫 줄" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("never sends the Enter that a Korean IME uses to commit a syllable", () => {
    const onSend = vi.fn();
    const { textarea } = renderComposer(onSend);
    fireEvent.change(textarea, { target: { value: "안" } });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("selects a mention with the arrow keys and inserts it", () => {
    const onSend = vi.fn();
    const { textarea } = renderComposer(onSend);
    fireEvent.change(textarea, { target: { value: "@" } });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
    // The first row is already active, so one ArrowDown lands on the next one.
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("@천예준 ");
  });

  it("sends the reply target and the mentioned agent ids with the message", () => {
    const onSend = vi.fn();
    const parent = message();
    render(
      <Providers>
        <Composer roomId="room-default" agents={agents} onSend={onSend} replyTo={parent} replyToName="Gemini" />
      </Providers>,
    );
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    // A trailing space closes the mention popup, so Enter is a send again.
    fireEvent.change(textarea, { target: { value: "고마워 @Gemini 님" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    const meta = onSend.mock.calls[0]![2] as ComposerSendMeta;
    expect(meta.replyToId).toBe("msg-1");
    expect(meta.mentionedIds).toEqual(["agent-gemini"]);
  });
});

describe("bubbles", () => {
  it("puts my message on its own side and keeps the peer name", () => {
    const { container } = render(
      <Providers>
        <MessageCard message={message()} handlers={{}} />
        <MessageCard message={message({ message_id: "msg-2", author: { actor_id: "owner", display_name: "천예준", kind: "owner" } })} handlers={{}} mine />
      </Providers>,
    );
    const bubbles = container.querySelectorAll("article.air-msg");
    expect(bubbles[0]!.getAttribute("data-mine")).toBeNull();
    expect(bubbles[1]!.getAttribute("data-mine")).toBe("true");
    expect(container.textContent).toContain("Gemini");
  });

  it("drops the repeated name for a grouped message", () => {
    const { container, rerender } = render(<Providers><MessageCard message={message()} handlers={{}} /></Providers>);
    expect(container.querySelector(".air-msg-name")).not.toBeNull();
    rerender(<Providers><MessageCard message={message({ message_id: "msg-2" })} handlers={{}} grouped /></Providers>);
    expect(container.querySelector(".air-msg-name")).toBeNull();
  });

  it("shows developer evidence only as a hover hint", () => {
    const { container } = render(<Providers><MessageCard message={message()} handlers={{}} /></Providers>);
    const saved = container.querySelector(".air-msg-saved");
    expect(saved?.textContent).toContain("저장됨");
    expect(saved?.getAttribute("title")).toContain("seq 11");
  });

  it("renders the message list oldest-first with a day break", () => {
    const older = message({ message_id: "msg-0", room_seq: 10, created_at: "2026-11-21T02:43:00.000Z" });
    const { container } = render(
      <Providers>
        <MessageList messages={[older, message()]} handlers={{}} roomId="room-default" self={{ actor_id: "owner", display_name: "천예준", kind: "owner" }} />
      </Providers>,
    );
    const ids = Array.from(container.querySelectorAll("[data-message-id]")).map((el) => el.getAttribute("data-message-id"));
    expect(ids).toEqual(["msg-0", "msg-1"]);
    expect(container.querySelectorAll(".air-chat-day").length).toBe(2);
    // Each day label stands above the first message of that day, not under it.
    const order = Array.from(container.querySelectorAll(".air-chat-scroll > *")).map((el) =>
      el.classList.contains("air-chat-day") ? "day" : "msg",
    );
    expect(order).toEqual(["day", "msg", "day", "msg"]);
  });
});

describe("chat formatting", () => {
  it("says the clock the way a messenger does", () => {
    const morning = new Date(2026, 10, 22, 8, 43).toISOString();
    const evening = new Date(2026, 10, 22, 20, 5).toISOString();
    expect(chatTime(morning)).toBe("오전 8:43");
    expect(chatTime(evening)).toBe("오후 8:05");
  });

  it("labels today and an earlier day", () => {
    const now = new Date(2026, 10, 22, 12, 0);
    expect(dayLabel(now.toISOString(), now)).toBe("오늘");
    expect(dayLabel(new Date(2026, 10, 21, 12, 0).toISOString(), now)).toBe("어제");
    expect(dayLabel(new Date(2026, 10, 20, 12, 0).toISOString(), now)).toContain("11월 20일");
  });

  it("copies readable text, not block JSON", () => {
    expect(plainTextOf(message())).toBe("안녕하세요 **Gemini**입니다.");
  });
});

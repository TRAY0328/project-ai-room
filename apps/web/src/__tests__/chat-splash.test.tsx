/**
 * The splash: a loading screen that watches the room's real work.
 *
 * The steps are pinned to the actual states — the gateway probe, the room list,
 * the first message page, the realtime channel — and the bar closes only when
 * they have all answered, then hands the room over with an exit.
 */
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { Providers, withDemoMode } from "./harness.js";
import { MainChatScreen } from "../screens/Chat.js";
import { splashProgress, splashStageIndex, splashTarget, SPLASH_STAGES, SPLASH_DONE_LABEL } from "../components/chat/splash.js";

describe("splash progress rules", () => {
  it("counts every stage pending until its request answers", () => {
    const nothing = splashProgress({ demoMode: false, connectionState: "checking", roomsState: "loading", messagesState: "loading", streamState: "idle" });
    expect(nothing.settled).toEqual([false, false, false, false]);
    expect(nothing.finished).toBe(false);
    expect(splashTarget(nothing)).toBe(0);
    expect(splashStageIndex(nothing)).toBe(0);
  });

  it("moves the target stage by stage and never past an unsettled one", () => {
    const first = splashProgress({ demoMode: false, connectionState: "ready", roomsState: "loading", messagesState: "loading", streamState: "idle" });
    expect(splashTarget(first)).toBe(SPLASH_STAGES[0]!.weight);
    expect(splashStageIndex(first)).toBe(1);
    const second = splashProgress({ demoMode: false, connectionState: "ready", roomsState: "ready", messagesState: "loading", streamState: "connecting" });
    expect(splashTarget(second)).toBe(SPLASH_STAGES[0]!.weight + SPLASH_STAGES[1]!.weight);
    expect(splashStageIndex(second)).toBe(2);
  });

  it("accepts any answer, including a refused one, as loaded", () => {
    const refused = splashProgress({ demoMode: false, connectionState: "unauthenticated", roomsState: "unauthenticated", messagesState: "unauthenticated", streamState: "idle" });
    expect(refused.finished).toBe(true);
    expect(splashTarget(refused)).toBe(100);
    expect(splashStageIndex(refused)).toBe(SPLASH_STAGES.length);
  });

  it("finishes in demo mode without pretending a server answered", () => {
    const demo = splashProgress({ demoMode: true, connectionState: "unconfigured", roomsState: "loading", messagesState: "loading", streamState: "idle" });
    expect(demo.finished).toBe(true);
  });

  it("waits for the realtime channel only while a live session could have one", () => {
    const waiting = splashProgress({ demoMode: false, connectionState: "ready", roomsState: "ready", messagesState: "ready", streamState: "connecting" });
    expect(waiting.finished).toBe(false);
    const live = splashProgress({ demoMode: false, connectionState: "ready", roomsState: "ready", messagesState: "ready", streamState: "live" });
    expect(live.finished).toBe(true);
  });
});

describe("splash on entry", () => {
  withDemoMode(true);

  it("shows the loading screen first and then hands over to the room", async () => {
    const { container } = render(<Providers><MainChatScreen navigate={() => undefined} /></Providers>);
    expect(container.querySelector(".air-splash")).not.toBeNull();
    expect(container.querySelector(".air-splash-percent-value")?.textContent).toBeTruthy();
    // The room is already mounted underneath, so the handover is a reveal.
    expect(container.querySelector(".air-chat-scroll")).not.toBeNull();
    await waitFor(
      () => expect(container.querySelector(".air-splash")).toBeNull(),
      { timeout: 5000 },
    );
  }, 15000);

  it("names the final step as the room being ready", () => {
    const done = splashProgress({ demoMode: true, connectionState: "ready", roomsState: "ready", messagesState: "ready", streamState: "live" });
    expect(splashStageIndex(done)).toBe(SPLASH_STAGES.length);
    expect(SPLASH_DONE_LABEL).toContain("준비 완료");
  });
});

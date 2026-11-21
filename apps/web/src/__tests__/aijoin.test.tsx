/**
 * AI join screen: the browser-only path must actually reach the server.
 *
 * The register POST is the one call the catalog marks as needing an
 * Idempotency-Key; without it every browser registration answered 400. This
 * test pins the header, the optional avatar, the one-click login and the hop to
 * the default room — the three things an AI that cannot run curl depends on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AiJoinScreen } from "../screens/Start.js";
import { Providers } from "./harness.js";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "x-request-id" ? "req_test" : null) },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("AI join screen (browser-only path)", () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    localStorage.setItem("air.gateway", "https://gateway.example");
    localStorage.setItem("air.demo", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        if (url.endsWith("/v1/health/ready")) return fakeResponse({ ok: true, data: { status: "ready" } });
        if (url.endsWith("/v1/agents/register")) {
          return fakeResponse(
            {
              ok: true,
              data: {
                agent: { agent_id: "agent_test", display_name: "TestBot", avatar_url: "https://gateway.example/avatars/default.svg" },
                credential: { agent_key: "airo_sk_test_only" },
                session: { access_token: "tok" },
              },
            },
            201,
          );
        }
        if (url.endsWith("/v1/agents/login")) {
          return fakeResponse({ ok: true, data: { agent_id: "agent_test", session: { access_token: "tok" } } });
        }
        if (url.endsWith("/v1/agents")) {
          return fakeResponse({ ok: false, error: { code: "AUTH_REQUIRED", message: "session required" } }, 401);
        }
        return fakeResponse({ ok: true, data: {} });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("registers with an idempotency key, then logs in and enters the chat", async () => {
    const navigate = vi.fn();
    render(<Providers><AiJoinScreen navigate={navigate} /></Providers>);

    fireEvent.change(screen.getByLabelText(/등록 비밀/), { target: { value: "inv_test" } });
    fireEvent.change(screen.getByLabelText(/AI 표시 이름/), { target: { value: "TestBot" } });
    fireEvent.click(screen.getByRole("button", { name: /등록하고 키 받기/ }));

    await waitFor(() => expect(document.querySelector(".air-secret-once")?.textContent).toBe("airo_sk_test_only"));

    console.log("CALLS", calls.map((c) => c.url));
    const register = calls.find((c) => c.url.endsWith("/v1/agents/register"));
    expect(register).toBeDefined();
    const headers = register!.init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(/^register-/);
    // the avatar field arrives pre-filled with the deployment's own default
    const body = JSON.parse(String(register!.init.body)) as Record<string, unknown>;
    expect(String(body["avatar_url"])).toContain("/avatars/default.svg");

    fireEvent.click(screen.getByRole("button", { name: /원클릭 로그인 후 단체 채팅방으로/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("MAINCHAT"));

    const login = calls.find((c) => c.url.endsWith("/v1/agents/login"));
    expect(login).toBeDefined();
    expect(JSON.parse(String(login!.init.body))).toEqual({ agent_key: "airo_sk_test_only" });
  });

  it("keeps the avatar optional (a cleared field is simply left out)", async () => {
    render(<Providers><AiJoinScreen navigate={() => undefined} /></Providers>);
    fireEvent.change(screen.getByLabelText(/등록 비밀/), { target: { value: "inv_test" } });
    fireEvent.change(screen.getByLabelText(/AI 표시 이름/), { target: { value: "NoAvatarBot" } });
    fireEvent.change(screen.getByLabelText(/아바타 이미지 URL/), { target: { value: "" } });
    const button = screen.getByRole("button", { name: /등록하고 키 받기/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector(".air-secret-once")).not.toBeNull());
    const register = calls.find((c) => c.url.endsWith("/v1/agents/register"));
    const body = JSON.parse(String(register!.init.body)) as Record<string, unknown>;
    expect(body["avatar_url"]).toBeUndefined();
  });
});

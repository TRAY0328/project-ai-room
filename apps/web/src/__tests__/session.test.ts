/**
 * Session renewal (spec 19.1). The access cookie lives 30 minutes and the
 * browser cannot read the HttpOnly refresh cookie, so the only way to stay
 * signed in is for the page to ask the server to renew — once, and not twice.
 *
 * What is proven here: one renewal per burst of failures, a renewal that rotates
 * the pair is adopted, a network failure is not a logout, a refusal by the server
 * is, and a renewal another tab just did is not repeated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionKeeper } from "../api/session.js";
import { ApiClient } from "../api/client.js";

const BASE = "https://gw.example";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("session keeper", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("sends one empty-body renewal to the refresh endpoint and adopts the new expiry", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const renewed: Array<string | null> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, { ok: true, data: { session: { access_expires_at: "2026-11-22T10:30:00.000Z" } } });
    }) as unknown as typeof fetch;
    const keeper = new SessionKeeper({
      baseUrl: () => BASE,
      fetchImpl,
      crossTab: false,
      onRenewed: (expiry) => renewed.push(expiry),
    });

    const outcome = await keeper.renew("test");
    expect(outcome).toBe("renewed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/refresh`);
    expect(calls[0]!.init.method).toBe("POST");
    // The refresh token is the HttpOnly cookie: the body must not try to carry it.
    expect(calls[0]!.init.body).toBe("{}");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(renewed).toEqual(["2026-11-22T10:30:00.000Z"]);
  });

  it("coalesces parallel 401s into a single rotation", async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl: fetchImpl as unknown as typeof fetch, crossTab: false });

    const first = keeper.renew("http-401");
    const second = keeper.renew("http-401");
    const third = keeper.renew("ws");
    expect(resolveFetch).not.toBeNull();
    resolveFetch!(jsonResponse(200, { ok: true, data: { session: { access_expires_at: "2026-11-22T10:30:00.000Z" } } }));

    await expect(Promise.all([first, second, third])).resolves.toEqual(["renewed", "renewed", "renewed"]);
    // One rotation: a second presentation of an old token would be read as theft.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a refusal as a real logout and says so once", async () => {
    const expired: string[] = [];
    const fetchImpl = (async () => jsonResponse(401, { ok: false, error: { code: "AUTH_REVOKED" } })) as unknown as typeof fetch;
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, crossTab: false, onExpired: (detail) => expired.push(detail) });

    await expect(keeper.renew("timer")).resolves.toBe("expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatch(/401/);
  });

  it("keeps the session when the network fails, because that proves nothing", async () => {
    const expired: string[] = [];
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, crossTab: false, onExpired: (detail) => expired.push(detail) });

    await expect(keeper.renew("timer")).resolves.toBe("unavailable");
    expect(expired).toHaveLength(0);
  });

  it("does not renew when there is no session to renew", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, crossTab: false, canRenew: () => false });
    await expect(keeper.renew("http-401")).resolves.toBe("skipped");
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("skips a rotation another tab just finished, because the cookie jar is shared", async () => {
    const now = Date.parse("2026-11-22T10:00:00.000Z");
    localStorage.setItem("air.session.renewed", String(now - 2000));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, now: () => now });

    await expect(keeper.renew("timer")).resolves.toBe("renewed");
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("renews nothing when the session was renewed within the staleness window", async () => {
    const now = Date.parse("2026-11-22T10:00:00.000Z");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, crossTab: false, now: () => now });
    keeper.noteLogin("2026-11-22T10:30:00.000Z");

    await expect(keeper.renewIfStale()).resolves.toBe("skipped");
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("catches up when a background tab wakes after the access token died", async () => {
    const start = Date.parse("2026-11-22T10:00:00.000Z");
    let now = start;
    const fetchImpl = (async () => jsonResponse(200, { ok: true, data: { session: { access_expires_at: new Date(now + 30 * 60_000).toISOString() } } })) as unknown as typeof fetch;
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, crossTab: false, now: () => now });
    keeper.noteLogin("2026-11-22T10:30:00.000Z");
    now = start + 50 * 60_000; // the tab was hidden past the expiry

    await expect(keeper.renewIfStale()).resolves.toBe("renewed");
    expect(keeper.successfulRenewals).toBe(1);
  });

  it("schedules the next renewal before the access token expires, not after", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-11-22T10:00:00.000Z");
      vi.setSystemTime(now);
      const fetchImpl = (async () => jsonResponse(200, { ok: true, data: { session: { access_expires_at: new Date(now + 30 * 60_000).toISOString() } } })) as unknown as typeof fetch;
      const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, crossTab: false });
      keeper.noteLogin("2026-11-22T10:30:00.000Z");
      keeper.start();

      // 24 minutes in: the timer (30 min − 6 min) fired, the token itself did not die.
      await vi.advanceTimersByTimeAsync(24 * 60_000 + 500);
      expect(keeper.successfulRenewals).toBe(1);
      keeper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("api client renewal", () => {
  it("retries a 401 once after the session is renewed", async () => {
    const seen: string[] = [];
    let roomsCalls = 0;
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      if (String(url).endsWith("/v1/auth/refresh")) {
        return jsonResponse(200, { ok: true, data: { session: { access_expires_at: "2026-11-22T10:30:00.000Z" } } });
      }
      roomsCalls += 1;
      if (roomsCalls === 1) return jsonResponse(401, { ok: false, error: { code: "AUTH_EXPIRED" } });
      return jsonResponse(200, { ok: true, data: { items: [] } });
    }) as unknown as typeof fetch;
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, crossTab: false });
    let unauthorized = 0;
    const client = new ApiClient({
      baseUrl: BASE,
      fetchImpl,
      renewSession: async () => (await keeper.renew("http-401")) === "renewed",
      onUnauthorized: () => (unauthorized += 1),
    });

    const result = await client.request<{ items: unknown[] }>("GET", "/v1/rooms");
    expect(result.ok).toBe(true);
    expect(roomsCalls).toBe(2);
    expect(seen).toContain(`${BASE}/v1/auth/refresh`);
    expect(unauthorized).toBe(0);
  });

  it("reports the caller unauthenticated when the renewal itself is refused", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/v1/auth/refresh")) return jsonResponse(401, { ok: false, error: { code: "AUTH_REVOKED" } });
      return jsonResponse(401, { ok: false, error: { code: "AUTH_EXPIRED" } });
    }) as unknown as typeof fetch;
    const keeper = new SessionKeeper({ baseUrl: () => BASE, fetchImpl, crossTab: false });
    let unauthorized = 0;
    const client = new ApiClient({
      baseUrl: BASE,
      fetchImpl,
      renewSession: async () => (await keeper.renew("http-401")) === "renewed",
      onUnauthorized: () => (unauthorized += 1),
    });

    const result = await client.request("GET", "/v1/rooms");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("AUTH_EXPIRED");
    expect(unauthorized).toBe(1);
  });
});

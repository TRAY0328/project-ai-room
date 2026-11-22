/**
 * Background session keeper (spec 19.1 — session renewal).
 *
 * The owner's access cookie lives 30 minutes and the refresh cookie 30 days.
 * Until this existed the page simply lost its session after 30 minutes: the
 * browser cannot read the HttpOnly refresh token, so nothing renewed it.
 *
 * Rules kept here, in one place:
 *  - renew on a timer that fires *before* the access token expires, not after a
 *    request has already failed;
 *  - renew once when a request answers 401 (the API client calls `renew`);
 *  - never run two renewals at once — the server rotates the refresh token on
 *    every use and treats a second presentation of an old token as theft, which
 *    revokes the whole session family;
 *  - coordinate across tabs of the same origin, because they share one cookie
 *    jar: a renewal another tab just finished means ours is fresh already;
 *  - treat only a refusal by the server (`401`) as "logged out". A network
 *    failure keeps the session and retries, because it proves nothing.
 */

export type RenewOutcome = "renewed" | "expired" | "unavailable" | "skipped";

export interface SessionKeeperOptions {
  /** The gateway base URL at call time (not captured once). */
  baseUrl: () => string | null;
  /** Tests inject a fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Whether a renewal attempt makes sense at all. Without a session there is
   * nothing to renew, and a signed-out visitor should not be answered with a
   * stream of refresh attempts.
   */
  canRenew?: () => boolean;
  /** Called after the server issued a new pair (or another tab did). */
  onRenewed?: (accessExpiresAt: string | null) => void;
  /** Called when the server refuses the renewal: the session is really gone. */
  onExpired?: (detail: string) => void;
  now?: () => number;
  /** Renew this long before the access token expires. */
  renewBeforeMs?: number;
  /** Cadence before any expiry is known (login response not seen yet). */
  fallbackIntervalMs?: number;
  /** A renewal this recent by another tab means the shared cookie is fresh. */
  crossTabFreshMs?: number;
  /** Visibility of the cross-tab coordination (tests turn it off). */
  crossTab?: boolean;
}

/** How often a failed renewal may retry while the page stays open. */
const RETRY_AFTER_FAILURE_MS = 60_000;
/** Never schedule further out than this, whatever the clock says. */
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** Never spin: a renewal that keeps firing is worse than a late one. */
const MIN_DELAY_MS = 15_000;
const CHANNEL_NAME = "air.session";
const MARKER_KEY = "air.session.renewed";

function parseIso(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export class SessionKeeper {
  private readonly options: SessionKeeperOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private inflight: Promise<RenewOutcome> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  private storageListener: ((event: StorageEvent) => void) | null = null;
  private running = false;
  private accessExpiresAt: number | null = null;
  private lastRenewAt: number | null = null;
  private renewCount = 0;

  constructor(options: SessionKeeperOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => Date.now());
  }

  /** What the last successful renewal learned, for an honest status line. */
  get lastRenewedAt(): number | null {
    return this.lastRenewAt;
  }

  get successfulRenewals(): number {
    return this.renewCount;
  }

  /**
   * A login (or the first ready probe) tells us when the access token dies, so
   * the timer can aim at the right moment instead of guessing.
   */
  noteLogin(accessExpiresAt?: string | null): void {
    this.accessExpiresAt = parseIso(accessExpiresAt);
    this.lastRenewAt = this.now();
    this.renewCount = 0;
    this.writeMarker(this.lastRenewAt);
    this.schedule();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.listen();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.unlisten();
  }

  /**
   * Renew once unless another tab just did. Used when the page comes back into
   * view or the network returns: a background tab's timers are throttled, so the
   * scheduled renewal may simply have been late.
   */
  async renewIfStale(staleMs = 15 * 60 * 1000): Promise<RenewOutcome> {
    if (!this.canRenew()) return "skipped";
    if (this.lastRenewAt !== null && this.now() - this.lastRenewAt < staleMs) return "skipped";
    return this.renew("wake");
  }

  /**
   * One renewal, at most one in flight. Callers get the same promise, so ten
   * parallel 401s produce one rotation and not ten (the second presentation of
   * an already-rotated token would revoke the session).
   */
  async renew(reason = "manual"): Promise<RenewOutcome> {
    if (!this.canRenew()) return "skipped";
    if (this.inflight !== null) return this.inflight;
    const run = this.serialized(reason);
    this.inflight = run;
    try {
      return await run;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }

  /**
   * Tabs of one origin share a cookie jar and therefore share one refresh token.
   * The Web Locks API (held across tabs) makes the second tab wait for the first
   * instead of racing it — a race would present a token that was just rotated,
   * which the server correctly reads as theft and revokes the whole session.
   */
  private async serialized(reason: string): Promise<RenewOutcome> {
    const lockManager = this.options.crossTab === false ? undefined : typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (lockManager === undefined || lockManager === null) return this.renewBehindMarker(reason);
    // The DOM typing of `request` flattens the callback's own promise type, so the
    // returned value is awaited explicitly instead of trusted.
    const held = lockManager.request("air.session.renew", () => this.renewBehindMarker(reason)) as unknown as Promise<RenewOutcome | Promise<RenewOutcome>>;
    return await held;
  }

  /** Inside the lock: another tab may have renewed while we waited. */
  private async renewBehindMarker(reason: string): Promise<RenewOutcome> {
    const shared = this.readMarker();
    if (shared !== null && this.now() - shared < this.crossTabFreshMs()) {
      // Another tab of this origin rotated the shared cookies moments ago.
      this.lastRenewAt = shared;
      this.options.onRenewed?.(null);
      this.schedule();
      return "renewed";
    }
    const base = this.options.baseUrl();
    if (base === null || base.length === 0) return "unavailable";
    return this.perform(base, reason);
  }

  private canRenew(): boolean {
    return this.options.canRenew === undefined ? true : this.options.canRenew();
  }

  private crossTabFreshMs(): number {
    return this.options.crossTabFreshMs ?? 10_000;
  }

  private async perform(base: string, reason: string): Promise<RenewOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${base.replace(/\/+$/, "")}/v1/auth/refresh`, {
        method: "POST",
        // An empty body is the point: the refresh token is the HttpOnly cookie,
        // which the page can neither read nor put in a body.
        headers: { accept: "application/json", "content-type": "application/json" },
        body: "{}",
        credentials: "include",
        mode: "cors",
        cache: "no-store",
      });
    } catch {
      // Offline or a gateway that is down proves nothing about the session.
      this.scheduleRetry();
      return "unavailable";
    }
    if (response.status === 401) {
      this.running = false;
      this.clearTimer();
      this.options.onExpired?.(`세션 연장 거부(401, ${reason})`);
      return "expired";
    }
    if (!response.ok) {
      this.scheduleRetry();
      return "unavailable";
    }
    let accessExpiresAt: string | null = null;
    try {
      const body = (await response.json()) as { data?: { session?: { access_expires_at?: unknown } } } | null;
      const value = body?.data?.session?.access_expires_at;
      if (typeof value === "string") accessExpiresAt = value;
    } catch {
      /* a 200 without a readable body still extended the cookie; the timer falls back */
    }
    this.accessExpiresAt = parseIso(accessExpiresAt);
    this.lastRenewAt = this.now();
    this.renewCount += 1;
    this.writeMarker(this.lastRenewAt);
    this.broadcast(this.lastRenewAt, accessExpiresAt);
    this.options.onRenewed?.(accessExpiresAt);
    this.schedule();
    return "renewed";
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.running) return;
    const now = this.now();
    const renewBefore = this.options.renewBeforeMs ?? 6 * 60 * 1000;
    const fallback = this.options.fallbackIntervalMs ?? 20 * 60 * 1000;
    const raw = this.accessExpiresAt === null ? fallback : Math.max(this.accessExpiresAt - renewBefore - now, MIN_DELAY_MS);
    const delay = Math.min(raw, MAX_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.renew("timer");
    }, delay);
  }

  private scheduleRetry(): void {
    this.clearTimer();
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.renew("retry");
    }, RETRY_AFTER_FAILURE_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private listen(): void {
    if (this.options.crossTab === false || this.channel !== null) return;
    const Ctor = typeof BroadcastChannel === "function" ? BroadcastChannel : null;
    if (Ctor !== null) {
      try {
        this.channel = new Ctor(CHANNEL_NAME);
        this.channel.onmessage = (event: MessageEvent) => this.absorb(event.data as unknown);
      } catch {
        this.channel = null;
      }
    }
    // `storage` is the fallback for a browser without BroadcastChannel (and for
    // the case where a tab was asleep when the message was posted).
    if (typeof window !== "undefined" && this.storageListener === null) {
      this.storageListener = (event: StorageEvent) => {
        if (event.key !== MARKER_KEY) return;
        const at = Number(event.newValue);
        if (!Number.isFinite(at) || at <= 0) return;
        this.absorb({ type: "renewed", at, access_expires_at: null });
      };
      window.addEventListener("storage", this.storageListener);
    }
  }

  private unlisten(): void {
    if (this.channel !== null) {
      try {
        this.channel.close();
      } catch {
        /* a closed channel is already gone */
      }
      this.channel = null;
    }
    if (this.storageListener !== null && typeof window !== "undefined") {
      window.removeEventListener("storage", this.storageListener);
      this.storageListener = null;
    }
  }

  /** Another tab renewed: our cookies are the same cookie jar, so adopt its result. */
  private absorb(data: unknown): void {
    if (data === null || typeof data !== "object") return;
    const message = data as { type?: unknown; at?: unknown; access_expires_at?: unknown };
    if (message.type !== "renewed" || typeof message.at !== "number") return;
    if (message.at <= (this.lastRenewAt ?? 0)) return;
    this.lastRenewAt = message.at;
    const expires = typeof message.access_expires_at === "string" ? message.access_expires_at : null;
    if (expires !== null) this.accessExpiresAt = parseIso(expires);
    this.options.onRenewed?.(expires);
    this.schedule();
  }

  private broadcast(at: number, accessExpiresAt: string | null): void {
    if (this.channel === null) return;
    try {
      this.channel.postMessage({ type: "renewed", at, access_expires_at: accessExpiresAt });
    } catch {
      /* coordination is an optimisation, never a correctness requirement */
    }
  }

  private readMarker(): number | null {
    if (this.options.crossTab === false) return null;
    try {
      if (typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(MARKER_KEY);
      if (raw === null) return null;
      const at = Number(raw);
      return Number.isFinite(at) && at > 0 ? at : null;
    } catch {
      return null;
    }
  }

  private writeMarker(at: number): void {
    if (this.options.crossTab === false) return;
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(MARKER_KEY, String(at));
    } catch {
      /* storage may be blocked; the in-memory timer still works */
    }
  }
}

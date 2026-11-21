/**
 * HTTP client for the single gateway API (spec 19).
 *
 * Rules:
 *  - cookie session only; no token is ever put in a URL or localStorage;
 *  - CSRF header is read from the `air_csrf` cookie the server sets;
 *  - POST carries an Idempotency-Key so a retry cannot duplicate a message;
 *  - failures are typed results, never thrown into render.
 */

export interface ApiSuccess<T> {
  ok: true;
  status: number;
  data: T;
  requestId: string | null;
}

export interface ApiFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  requestId: string | null;
  retryable: boolean;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface ApiClientOptions {
  baseUrl: string | null;
  /** Tests inject a fetch; the browser uses the global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUnauthorized?: () => void;
}

export class ApiClient {
  private readonly explicitBase: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onUnauthorized?: () => void;

  constructor(options: ApiClientOptions) {
    this.explicitBase = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.onUnauthorized = options.onUnauthorized;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  get baseUrl(): string | null {
    const raw = this.explicitBase ?? (typeof import.meta !== "undefined" ? (import.meta.env?.VITE_GATEWAY_URL as string | undefined) ?? null : null);
    if (!raw) return null;
    return raw.replace(/\/+$/, "");
  }

  /** WS base derives from the HTTP base (https→wss). */
  get wsUrl(): string | null {
    const base = this.baseUrl;
    if (!base) return null;
    try {
      const url = new URL(base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  async request<T>(method: string, path: string, options: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
    const base = this.baseUrl;
    if (!base) {
      return { ok: false, status: 0, code: "GATEWAY_NOT_CONFIGURED", message: "게이트웨이 URL이 설정되지 않았습니다 (운영 설정 → 게이트웨이 URL).", requestId: null, retryable: false };
    }
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      ...this.csrfHeader(method),
      ...options.headers,
    };

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        credentials: "include",
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal ?? controller.signal,
        mode: "cors",
      });
      const requestId = response.headers.get("x-request-id");
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text.slice(0, 500) };
        }
      }
      if (!response.ok) {
        if (response.status === 401) this.onUnauthorized?.();
        const envelope = extractError(payload);
        return {
          ok: false,
          status: response.status,
          code: envelope.code ?? `HTTP_${response.status}`,
          message: envelope.message ?? describeStatus(response.status),
          requestId,
          retryable: response.status === 429 || response.status >= 500,
        };
      }
      return { ok: true, status: response.status, data: unwrapEnvelope(payload) as T, requestId };
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      return {
        ok: false,
        status: 0,
        code: aborted ? "TIMEOUT" : "NETWORK_UNREACHABLE",
        message: aborted ? `${this.timeoutMs}ms 안에 응답이 없습니다.` : "네트워크로 게이트웨이에 닿지 못했습니다. 오프라인일 수 있습니다.",
        requestId: null,
        retryable: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private csrfHeader(method: string): Record<string, string> {
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase())) return {};
    const token = readCookie("air_csrf");
    return token ? { "x-csrf-token": token } : {};
  }

  /** Reachability probe that distinguishes "no server" from "not signed in". */
  async probe(): Promise<{ reachable: boolean; authenticated: boolean; detail: string }> {
    const result = await this.request<unknown>("GET", "/v1/agents");
    if (result.ok) return { reachable: true, authenticated: true, detail: "게이트웨이 응답 · 세션 유효" };
    if (result.status === 401) return { reachable: true, authenticated: false, detail: "게이트웨이는 응답하지만 로그인 세션이 없습니다" };
    if (result.status === 0) return { reachable: false, authenticated: false, detail: result.message };
    return { reachable: true, authenticated: false, detail: `${result.code}: ${result.message}` };
  }
}

/**
 * Every API answer is `{ ok: true, data, request_id, … }`. Callers consume the
 * payload inside `data`, so the envelope is removed here — once — instead of in
 * every screen. An unwrapped body (a proxy or a test fixture) passes through.
 */
function unwrapEnvelope(payload: unknown): unknown {
  if (payload !== null && typeof payload === "object") {
    const envelope = payload as { ok?: unknown; data?: unknown };
    if (envelope.ok === true && "data" in envelope) return envelope.data;
  }
  return payload;
}

function extractError(payload: unknown): { code?: string; message?: string } {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const inner = obj.error;
    if (inner && typeof inner === "object") {
      const e = inner as Record<string, unknown>;
      return { code: typeof e.code === "string" ? e.code : undefined, message: typeof e.message === "string" ? e.message : undefined };
    }
    return {
      code: typeof obj.code === "string" ? obj.code : undefined,
      message: typeof obj.message === "string" ? obj.message : undefined,
    };
  }
  return {};
}

function describeStatus(status: number): string {
  if (status === 401) return "로그인이 필요합니다.";
  if (status === 403) return "권한이 없습니다.";
  if (status === 404) return "대상을 찾을 수 없습니다.";
  if (status === 409) return "충돌: 최신 revision을 다시 확인하세요.";
  if (status === 429) return "요청 한도를 초과했습니다.";
  if (status >= 500) return "서버 오류입니다.";
  return `HTTP ${status}`;
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Deterministic idempotency key for one user intent (retries reuse it). */
export function newIdempotencyKey(prefix = "idem"): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

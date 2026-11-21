import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, ApiResult } from "./client.js";

export type ResourceState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: T; fetchedAt: number }
  | { kind: "unauthenticated"; detail: string }
  | { kind: "unavailable"; detail: string; code: string; retryable: boolean }
  | { kind: "error"; detail: string; code: string };

export interface UseResourceOptions {
  /** Skip the request entirely (no base URL, demo mode, not signed in). */
  enabled?: boolean;
  /** Re-fetch interval in ms; 0 disables polling. */
  pollMs?: number;
  /** Add ?… params to the path. */
  query?: Record<string, string | number | boolean | undefined>;
}

function withQuery(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

/**
 * GET resource hook. Nothing is invented: every non-ready state maps to a
 * distinct UI state (`unauthenticated`, `unavailable`, `error`), and a failed
 * fetch never leaves stale data looking fresh.
 */
export function useResource<T>(client: ApiClient, path: string | null, options: UseResourceOptions = {}) {
  const { enabled = true, pollMs = 0, query } = options;
  const [state, setState] = useState<ResourceState<T>>({ kind: "idle" });
  const mounted = useRef(true);
  const requestSeq = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!path || !enabled) {
        setState({ kind: "idle" });
        return;
      }
      const seq = ++requestSeq.current;
      setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
      const result = await client.request<T>("GET", withQuery(path, query), { signal });
      if (!mounted.current || seq !== requestSeq.current) return;
      applyResult(result, setState);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, path, enabled, JSON.stringify(query ?? {})],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    let timer: ReturnType<typeof setInterval> | null = null;
    if (pollMs > 0 && enabled) {
      timer = setInterval(() => void load(), pollMs);
    }
    return () => {
      mounted.current = false;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [load, pollMs, enabled]);

  return { state, reload: () => void load() };
}

function applyResult<T>(result: ApiResult<T>, setState: (s: ResourceState<T>) => void): void {
  if (result.ok) {
    setState({ kind: "ready", data: result.data, fetchedAt: Date.now() });
    return;
  }
  if (result.status === 401) {
    setState({ kind: "unauthenticated", detail: "로그인 세션이 필요합니다 (소유자 로그인 또는 AI 키)." });
    return;
  }
  if (result.status === 0) {
    setState({ kind: "unavailable", detail: result.message, code: result.code, retryable: result.retryable });
    return;
  }
  setState({ kind: "error", detail: result.message, code: result.code });
}

/** Mutation hook: returns the last result and a busy flag; no optimistic success. */
export function useMutation<TBody, TResult>(client: ApiClient, method: "POST" | "PATCH" | "DELETE", path: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<TResult> | null>(null);
  const run = useCallback(
    async (body?: TBody, options: { idempotencyKey?: string } = {}) => {
      setBusy(true);
      const res = await client.request<TResult>(method, path, { body, idempotencyKey: options.idempotencyKey });
      setResult(res);
      setBusy(false);
      return res;
    },
    [client, method, path],
  );
  return { run, busy, result, reset: () => setResult(null) };
}

/**
 * A list endpoint answers `{ items: […] }` (sometimes `{ rooms: […] }`); this
 * reads either shape so a screen never receives an object where it expects an
 * array and silently renders zero rows.
 */
export function listOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data !== null && typeof data === "object") {
    const obj = data as { items?: unknown; data?: unknown };
    if (Array.isArray(obj.items)) return obj.items as T[];
    if (Array.isArray(obj.data)) return obj.data as T[];
  }
  return [];
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((now - t) / 1000);
  if (Math.abs(diff) < 45) return "방금";
  if (diff > 0 && diff < 3600) return `${Math.round(diff / 60)}분 전`;
  if (diff > 0 && diff < 86400) return `${Math.round(diff / 3600)}시간 전`;
  if (diff > 0) return `${Math.round(diff / 86400)}일 전`;
  return "방금";
}

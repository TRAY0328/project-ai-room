/**
 * Time policy — spec 05.1, 31.3, 35.2
 *
 *  - Server writes every timestamp as UTC ISO 8601 with milliseconds and a `Z`
 *    suffix ("2026-11-21T00:00:00.000Z"). A local offset ("+09:00") is a client
 *    rendering concern and is rejected at the wire boundary.
 *  - Four different moments are kept apart and never collapsed into one field:
 *      created_at / updated_at      — server-side write time
 *      observed_at                  — when the *subject* says it happened
 *      provider_timestamp           — what an external provider reported
 *      server_received_at           — when our server accepted the payload
 *  - A client clock is never audit evidence; only server_received_at is.
 */
import { z } from "zod";

declare const utcBrand: unique symbol;
export type UtcIsoMillis = string & { readonly [utcBrand]: "utc-iso-ms" };

/** `YYYY-MM-DDTHH:mm:ss.sssZ` — milliseconds are required, no offset allowed. */
export const UTC_ISO_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Same shape but for date-only values (retention cutoffs, birthdays). */
export const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function toUtcIso(ms: number): UtcIsoMillis {
  if (!Number.isFinite(ms)) throw new RangeError("timestamp must be finite");
  const iso = new Date(ms).toISOString();
  if (!UTC_ISO_MILLIS_PATTERN.test(iso)) throw new RangeError(`not a UTC iso string: ${iso}`);
  return iso as UtcIsoMillis;
}

/** Current server time. The only source of `created_at`/`updated_at`. */
export function nowUtc(): UtcIsoMillis {
  return toUtcIso(Date.now());
}

export function parseUtcIso(value: unknown): number | null {
  if (typeof value !== "string" || !UTC_ISO_MILLIS_PATTERN.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  // Reject calendar overflow such as 2026-02-31T00:00:00.000Z
  if (new Date(ms).toISOString() !== value) return null;
  return ms;
}

export function isUtcIsoMillis(value: unknown): value is UtcIsoMillis {
  return parseUtcIso(value) !== null;
}

export class TimeContractError extends Error {
  constructor(value: unknown) {
    super(`expected a UTC ISO-8601 millisecond timestamp, received ${typeof value === "string" ? JSON.stringify(value) : typeof value}`);
    this.name = "TimeContractError";
  }
}

export function assertUtcIsoMillis(value: unknown): UtcIsoMillis {
  if (!isUtcIsoMillis(value)) throw new TimeContractError(value);
  return value;
}

export const zUtcIsoMillis = z.string().regex(UTC_ISO_MILLIS_PATTERN).refine(isUtcIsoMillis, {
  message: "must be a real UTC ISO-8601 millisecond timestamp (e.g. 2026-11-21T00:00:00.000Z)",
});

export const zUtcDate = z.string().regex(UTC_DATE_PATTERN);

/** Server-assigned write timestamps for a mutable row. */
export interface WriteTimestamps {
  readonly createdAt: UtcIsoMillis;
  readonly updatedAt: UtcIsoMillis;
}

export interface ObservationTimestamps {
  /** Server clock when the row was written. */
  readonly serverReceivedAt: UtcIsoMillis;
  /** When the subject claims it happened (may be absent). */
  readonly observedAt?: UtcIsoMillis;
  /** Timestamp reported by an external provider (may be absent). */
  readonly providerTimestamp?: UtcIsoMillis;
}

export function writeTimestamps(at: UtcIsoMillis = nowUtc()): WriteTimestamps {
  return { createdAt: at, updatedAt: at };
}

/** Monotonic guard: an update may never move `updated_at` backwards. */
export function assertMonotonicUpdate(previous: UtcIsoMillis, next: UtcIsoMillis): void {
  const before = parseUtcIso(previous);
  const after = parseUtcIso(next);
  if (before === null || after === null) throw new TimeContractError(previous);
  if (after < before) throw new TimeContractError(next);
}

/**
 * Freshness check used by nonce challenges and signed download links:
 * `value` must be no older than `ttlMs` and not in the future beyond `skewMs`.
 */
export function isFresh(
  value: unknown,
  ttlMs: number,
  options: { nowMs?: number; skewMs?: number } = {},
): boolean {
  const ms = parseUtcIso(value);
  if (ms === null) return false;
  const now = options.nowMs ?? Date.now();
  const skew = options.skewMs ?? 5_000;
  if (ms > now + skew) return false;
  return now - ms <= ttlMs;
}

export function addMillis(value: UtcIsoMillis, deltaMs: number): UtcIsoMillis {
  const ms = parseUtcIso(value);
  if (ms === null) throw new TimeContractError(value);
  return toUtcIso(ms + deltaMs);
}

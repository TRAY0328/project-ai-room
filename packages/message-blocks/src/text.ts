/**
 * Text helpers shared by markdown, code, diff and log blocks.
 * All of these are pure functions so the tests can pin exact behaviour.
 */

/** Collapses a raw text chunk into a single safe text node value. Nothing is escaped here:
 * escaping is unnecessary because the value never becomes HTML — but we still strip
 * NUL and other invisible control characters that confuse terminals and diff views. */
export function cleanText(input: string): string {
  return input.replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
}

export function truncate(input: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: "", truncated: input.length > 0 };
  if (input.length <= max) return { text: input, truncated: false };
  return { text: input.slice(0, max), truncated: true };
}

/** Masks credential-looking substrings before they are shown or logged. */
export function redactSecrets(input: string): string {
  return input
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted-key]")
    .replace(/\b(ghp_[A-Za-z0-9]{10,})\b/g, "[redacted-token]")
    .replace(/\b(cfat_[A-Za-z0-9_-]{10,})\b/g, "[redacted-cloudflare-token]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|secret|password|passwd|token)(\s*[:=]\s*)([^\s"',;]{6,})/gi, "$1$2[redacted]");
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Always UTC, always explicit: a client-local guess must never look authoritative. */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
}

export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((now - t) / 1000);
  if (diff < 45) return "방금";
  if (diff < 90) return "1분 전";
  if (diff < 3600) return `${Math.round(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.round(diff / 3600)}시간 전`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}일 전`;
  return formatUtc(iso).slice(0, 10);
}

/** Counts user-perceived characters without pulling in Intl.Segmenter assumptions. */
export function charCount(input: string): number {
  return Array.from(input).length;
}

export function shortSha(sha: string, length = 7): string {
  const clean = sha.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(clean) ? clean.slice(0, length) : clean.slice(0, length);
}

export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

/** Deterministic pseudo-hash used only for local UI ids (never for integrity claims). */
export function localHash(input: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0");
}

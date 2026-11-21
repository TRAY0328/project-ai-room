/**
 * URL policy for everything a message can link to (spec 10.3).
 *
 * Only http(s), mailto and same-origin relative links survive. Anything with a
 * control character inside the scheme, a `data:` payload, an SVG data URL or a
 * protocol-relative `//host` is rejected — and rejection is visible in the UI
 * (the label stays, the link is not clickable).
 */

export interface UrlDecision {
  ok: boolean;
  url?: string;
  reason?: "scheme_not_allowed" | "control_characters" | "protocol_relative" | "too_long" | "empty" | "malformed";
}

const MAX_URL = 2048;
const CONTROL = /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029]/;

export function isRelativeUrl(raw: string): boolean {
  return raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("#") || raw.startsWith("?");
}

export function safeUrl(raw: unknown): UrlDecision {
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_URL) return { ok: false, reason: "too_long" };
  if (CONTROL.test(trimmed)) return { ok: false, reason: "control_characters" };

  if (trimmed.startsWith("//")) return { ok: false, reason: "protocol_relative" };
  if (isRelativeUrl(trimmed)) return { ok: true, url: trimmed };

  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!match) return { ok: false, reason: "malformed" };
  const scheme = match[1]!.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname || parsed.hostname.includes(" ")) return { ok: false, reason: "malformed" };
      return { ok: true, url: parsed.toString() };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }
  if (scheme === "mailto") {
    return /^mailto:[^@\s]+@[^@\s]+$/i.test(trimmed) ? { ok: true, url: trimmed } : { ok: false, reason: "malformed" };
  }
  return { ok: false, reason: "scheme_not_allowed" };
}

/** True when a URL points off-site (used for link-warning UI). */
export function isExternal(raw: string): boolean {
  return /^https?:/i.test(raw.trim()) && !isRelativeUrl(raw.trim());
}

/** Host shown next to an external link so the reader sees where it goes. */
export function linkHost(raw: string): string | null {
  const decision = safeUrl(raw);
  if (!decision.ok || !decision.url) return null;
  if (isRelativeUrl(decision.url)) return null;
  try {
    return new URL(decision.url).host;
  } catch {
    return null;
  }
}

/** Applies rel/target only after safeUrl() approved the value. */
export function linkAttrs(url: string, externalLinks = true): Record<string, string | undefined> {
  const external = isExternal(url);
  if (!external) return { href: url };
  if (!externalLinks) return {};
  return { href: url, rel: "noopener noreferrer nofollow", target: "_blank" };
}

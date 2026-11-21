/**
 * Short-lived, signed credentials — spec 06.2 #4, 33.1 #5, 19.3.
 *
 * Two token families exist and they are deliberately different:
 *  - Session tokens (`sess_...` row + signed bearer) authenticate a person or an
 *    AI over HTTPS. The signature proves integrity; the DB row proves the
 *    session was not revoked, so logout and key rotation take effect at once.
 *  - WebSocket tickets are single-use, expire in ~60 s, and name one room. A
 *    socket therefore cannot outlive the permission decision that opened it.
 *
 * Token layout: `v1.<base64url(payload)>.<base64url(hmac-sha256)>`. No password,
 * key or refresh token is ever inside a signed payload.
 */
import { z } from "zod";
import { zUtcIsoMillis } from "@ai-room/contracts";
import { base64UrlDecode, base64UrlEncode, hmacSha256, timingSafeEqualString, bytesToHex } from "./crypto.js";

export const SESSION_TOKEN_VERSION = "v1" as const;

/** Assurances a signed token may carry; `none` never reaches a token. */
export type TokenAssurance = "owner_ui" | "agent_key" | "ephemeral_ws_ticket" | "service";
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
export const OWNER_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const WS_TICKET_TTL_MS = 60 * 1000;

export const zSessionTokenClaims = z.object({
  v: z.literal(SESSION_TOKEN_VERSION),
  sub_kind: z.enum(["owner", "agent"]),
  sub_id: z.string().min(1),
  session_id: z.string().min(1),
  assurance: z.enum(["owner_ui", "agent_key", "ephemeral_ws_ticket", "service"]),
  iat: zUtcIsoMillis,
  exp: zUtcIsoMillis,
  jti: z.string().min(1),
});

export type SessionTokenClaims = z.infer<typeof zSessionTokenClaims>;

function signingMessage(payloadSegment: string): string {
  return `${SESSION_TOKEN_VERSION}.${payloadSegment}`;
}

export async function signSessionToken(claims: SessionTokenClaims, signingKey: string): Promise<string> {
  if (signingKey.length < 16) throw new TypeError("session signing key is too short");
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await hmacSha256(signingKey, signingMessage(payload));
  return `${SESSION_TOKEN_VERSION}.${payload}.${base64UrlEncode(signature)}`;
}

export type TokenVerification =
  | { readonly ok: true; readonly claims: SessionTokenClaims }
  | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" | "not_yet_valid" };

export async function verifySessionToken(
  token: string,
  signingKey: string,
  nowMs: number = Date.now(),
  clockSkewMs: number = 5_000,
): Promise<TokenVerification> {
  const segments = token.split(".");
  if (segments.length !== 3 || segments[0] !== SESSION_TOKEN_VERSION) return { ok: false, reason: "malformed" };
  const [, payloadSegment, signatureSegment] = segments;
  if (payloadSegment === undefined || signatureSegment === undefined) return { ok: false, reason: "malformed" };
  const expected = await hmacSha256(signingKey, signingMessage(payloadSegment));
  if (!timingSafeEqualString(bytesToHex(expected), bytesToHex(base64UrlDecode(signatureSegment)))) {
    return { ok: false, reason: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadSegment)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const result = zSessionTokenClaims.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "malformed" };
  const expMs = Date.parse(result.data.exp);
  const iatMs = Date.parse(result.data.iat);
  if (expMs + clockSkewMs < nowMs) return { ok: false, reason: "expired" };
  if (iatMs - clockSkewMs > nowMs) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims: result.data };
}

export const zWsTicket = z.object({
  v: z.literal(SESSION_TOKEN_VERSION),
  ticket_id: z.string().min(1),
  subject_kind: z.enum(["owner", "agent"]),
  subject_id: z.string().min(1),
  room_id: z.string().min(1),
  project_id: z.string().min(1).nullable(),
  permissions: z.array(z.string().min(1)).min(1),
  issued_at: zUtcIsoMillis,
  expires_at: zUtcIsoMillis,
  nonce: z.string().min(16),
  /** Room ACL revision at issue time; a newer revocation closes the socket. */
  acl_revision: z.number().int().nonnegative(),
});

export type WsTicket = z.infer<typeof zWsTicket>;

export async function signWsTicket(ticket: WsTicket, signingKey: string): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify(ticket));
  const signature = await hmacSha256(signingKey, `ws.${payload}`);
  return `ws.${payload}.${base64UrlEncode(signature)}`;
}

export async function verifyWsTicket(
  token: string,
  signingKey: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true; ticket: WsTicket } | { ok: false; reason: "malformed" | "bad_signature" | "expired" }> {
  const segments = token.split(".");
  if (segments.length !== 3 || segments[0] !== "ws") return { ok: false, reason: "malformed" };
  const [, payloadSegment, signatureSegment] = segments;
  if (payloadSegment === undefined || signatureSegment === undefined) return { ok: false, reason: "malformed" };
  const expected = await hmacSha256(signingKey, `ws.${payloadSegment}`);
  if (!timingSafeEqualString(bytesToHex(expected), bytesToHex(base64UrlDecode(signatureSegment)))) {
    return { ok: false, reason: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadSegment)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const result = zWsTicket.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "malformed" };
  if (Date.parse(result.data.expires_at) + 2_000 < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, ticket: result.data };
}

/**
 * Download-intent links: a signed statement of (asset, actor, expiry, uses).
 * The signature is what makes the link safe to hand to a browser; the row in
 * `download_events` is what makes it revocable before it expires.
 */
export interface DownloadGrant {
  readonly grant_id: string;
  readonly target_kind: "file" | "artifact";
  readonly target_id: string;
  readonly actor_kind: "owner" | "agent";
  readonly actor_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly single_use: boolean;
}

export async function signDownloadGrant(grant: DownloadGrant, signingKey: string): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify(grant));
  const signature = await hmacSha256(signingKey, `dl.${payload}`);
  return `dl.${payload}.${base64UrlEncode(signature)}`;
}

export async function verifyDownloadGrant(
  token: string,
  signingKey: string,
  nowMs: number = Date.now(),
): Promise<{ ok: true; grant: DownloadGrant } | { ok: false; reason: "malformed" | "bad_signature" | "expired" }> {
  const segments = token.split(".");
  if (segments.length !== 3 || segments[0] !== "dl") return { ok: false, reason: "malformed" };
  const [, payloadSegment, signatureSegment] = segments;
  if (payloadSegment === undefined || signatureSegment === undefined) return { ok: false, reason: "malformed" };
  const expected = await hmacSha256(signingKey, `dl.${payloadSegment}`);
  if (!timingSafeEqualString(bytesToHex(expected), bytesToHex(base64UrlDecode(signatureSegment)))) {
    return { ok: false, reason: "bad_signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadSegment)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const grant = parsed as DownloadGrant;
  if (typeof grant.target_id !== "string" || typeof grant.expires_at !== "string") return { ok: false, reason: "malformed" };
  if (Date.parse(grant.expires_at) < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, grant };
}

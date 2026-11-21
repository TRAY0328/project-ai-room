/**
 * Credential primitives — Web Crypto only (Workers + Node >= 19).
 *
 * Rules encoded here (spec 06.2, 20.2):
 *  - A password is stored as PBKDF2-SHA256 with a per-credential random salt and
 *    a high iteration count. The stored string is `pbkdf2$<iter>$<salt>$<hash>`.
 *  - An AI key, refresh token or WS ticket is a high-entropy random value; the
 *    server keeps only its SHA-256 verifier, so a D1 leak does not hand out keys.
 *  - Every comparison of a secret runs in constant time over equal-length
 *    byte strings; a fast mismatch is a timing oracle.
 *  - Signing keys never leave the Worker secret store and are never logged.
 */

const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new TypeError("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64_ALPHABET[(n >>> 18) & 63] ?? "";
    out += B64_ALPHABET[(n >>> 12) & 63] ?? "";
    out += B64_ALPHABET[(n >>> 6) & 63] ?? "";
    out += B64_ALPHABET[n & 63] ?? "";
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += B64_ALPHABET[(n >>> 18) & 63] ?? "";
    out += B64_ALPHABET[(n >>> 12) & 63] ?? "";
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64_ALPHABET[(n >>> 18) & 63] ?? "";
    out += B64_ALPHABET[(n >>> 12) & 63] ?? "";
    out += B64_ALPHABET[(n >>> 6) & 63] ?? "";
  }
  return out;
}

export function base64UrlDecode(value: string): Uint8Array {
  if (/[^A-Za-z0-9_-]/.test(value)) throw new TypeError("invalid base64url");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const index = B64_ALPHABET.indexOf(char);
    if (index < 0) throw new TypeError("invalid base64url");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Copies into a standalone ArrayBuffer so Web Crypto never sees a SharedArrayBuffer view. */
function toBuffer(input: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input;
  const out = new ArrayBuffer(input.length);
  new Uint8Array(out).set(input);
  return out;
}

function cryptoApi(): Crypto {
  const api = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (api === undefined || api.subtle === undefined) throw new Error("Web Crypto is required");
  return api;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

/** 256 bits of entropy by default; the prefix only helps operators read logs. */
export function randomToken(prefix = "", byteLength = 32): string {
  return `${prefix}${base64UrlEncode(randomBytes(byteLength))}`;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await cryptoApi().subtle.digest("SHA-256", toBuffer(data));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return cryptoApi().subtle.importKey("raw", toBuffer(encoder.encode(secret)), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const signature = await cryptoApi().subtle.sign("HMAC", await hmacKey(secret), toBuffer(encoder.encode(message)));
  return new Uint8Array(signature);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  return bytesToHex(await hmacSha256(secret, message));
}

/** Constant-time comparison over the byte representation; never `===` on a secret. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

// Cloudflare Workers' WebCrypto rejects PBKDF2 above 100,000 iterations
// ("iteration counts above 100000 are not supported"), so 100,000 is the
// highest value the deployed Worker can use. The iteration count is stored in
// the verifier string, so a verifier made elsewhere with another count still
// verifies.
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await cryptoApi().subtle.importKey("raw", toBuffer(encoder.encode(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await cryptoApi().subtle.deriveBits(
    { name: "PBKDF2", salt: toBuffer(salt), iterations, hash: "SHA-256" },
    base,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2$iterations$salt$hash`, all base64url. */
export async function hashPassword(password: string, iterations: number = PBKDF2_ITERATIONS): Promise<string> {
  if (password.length < 12) throw new TypeError("password must be at least 12 characters");
  const salt = randomBytes(SALT_BYTES);
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlDecode(parts[2] ?? "");
    expected = base64UrlDecode(parts[3] ?? "");
  } catch {
    return false;
  }
  const derived = await pbkdf2(password, salt, iterations);
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i += 1) diff |= (derived[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}

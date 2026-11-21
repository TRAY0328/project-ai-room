/**
 * ID policy — Q001..Q041 / spec 05.1, 31.3
 *
 * Rules implemented here:
 *  - Every public resource id is an opaque, collision-resistant id with a
 *    typed prefix (owner_, agent_, room_, ...), so an id from one aggregate can
 *    never be silently accepted where another is expected.
 *  - The id body is a UUIDv7 encoded in Crockford base32 (26 chars): 48-bit
 *    unix-ms timestamp first, then random bits. It is time-sortable for humans
 *    and index locality, but ordering of *messages* is still the server
 *    `room_seq` from the Room Durable Object, never the id.
 *  - Ids are minted server-side only. Clients propose `idempotency_key`; they
 *    never propose an `id`, an `actor`, or a `revision`.
 */
export const ID_PREFIXES = {
  owner: "owner",
  agent: "agent",
  credential: "cred",
  session: "sess",
  connection: "conn",
  room: "room",
  project: "proj",
  task: "task",
  attempt: "att",
  message: "msg",
  revision: "rev",
  job: "job",
  artifact: "art",
  file: "file",
  document: "doc",
  repository: "repo",
  pullRequest: "pr",
  review: "rvw",
  evidence: "evd",
  ciRun: "ci",
  memory: "mem",
  approval: "apr",
  event: "evt",
  request: "req",
  correlation: "corr",
  installation: "inst",
  webhook: "hook",
  workflow: "wf",
  run: "run",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

declare const idBrand: unique symbol;
/** A string that the compiler treats as a specific kind of id. */
export type BrandedId<K extends IdKind> = string & { readonly [idBrand]: K };

export type OwnerId = BrandedId<"owner">;
export type AgentId = BrandedId<"agent">;
export type RoomId = BrandedId<"room">;
export type ProjectId = BrandedId<"project">;
export type TaskId = BrandedId<"task">;
export type MessageId = BrandedId<"message">;
export type RevisionId = BrandedId<"revision">;
export type JobId = BrandedId<"job">;
export type ArtifactId = BrandedId<"artifact">;
export type FileId = BrandedId<"file">;
export type EventId = BrandedId<"event">;
export type RequestId = BrandedId<"request">;
export type CorrelationId = BrandedId<"correlation">;

export type AnyId = BrandedId<IdKind>;

/**
 * Web Crypto is available in both Cloudflare Workers and Node >= 19, so the
 * shared contract stays runtime-agnostic (no node:crypto import).
 */
interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}
function randomSource(): RandomSource {
  const source = (globalThis as unknown as { crypto?: RandomSource }).crypto;
  if (source === undefined || typeof source.getRandomValues !== "function") {
    throw new Error("Web Crypto (globalThis.crypto.getRandomValues) is required to mint ids");
  }
  return source;
}

/** Crockford base32: no I, L, O, U — unambiguous when read aloud or typed. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 16 bytes -> 26 base32 chars (130 bits used, 2 bits padding). */
export const ID_BODY_LENGTH = 26;

const PREFIX_BY_KIND: Record<IdKind, string> = ID_PREFIXES;
const KIND_BY_PREFIX: ReadonlyMap<string, IdKind> = new Map(
  (Object.entries(ID_PREFIXES) as Array<[IdKind, string]>).map(([kind, prefix]) => [prefix, kind]),
);

const BODY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ParsedId {
  readonly kind: IdKind;
  readonly prefix: IdPrefix;
  readonly body: string;
  /** Unix epoch milliseconds encoded in the UUIDv7 body (informational only). */
  readonly mintedAtMs: number;
}

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function decodeCrockford(body: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of body) {
    const index = CROCKFORD_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid crockford character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
    value &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/**
 * RFC 9562 UUIDv7 as raw bytes: 48-bit big-endian unix ms, version nibble 7,
 * 12 random bits, variant 10, 62 random bits.
 */
export function uuidV7Bytes(nowMs: number = Date.now()): Uint8Array {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 0xffffffffffff) {
    throw new RangeError("uuidv7 timestamp out of range");
  }
  const bytes = new Uint8Array(16);
  let ts = Math.floor(nowMs);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  const rand = new Uint8Array(10);
  randomSource().getRandomValues(rand);
  bytes[6] = 0x70 | ((rand[0] ?? 0) & 0x0f);
  bytes[7] = rand[1] ?? 0;
  bytes[8] = 0x80 | ((rand[2] ?? 0) & 0x3f);
  for (let i = 0; i < 7; i += 1) bytes[9 + i] = rand[3 + i] ?? 0;
  return bytes;
}

/** Mint a new prefixed id for the given aggregate kind. Server-side only. */
export function mintId<K extends IdKind>(kind: K, nowMs: number = Date.now()): BrandedId<K> {
  const prefix = PREFIX_BY_KIND[kind];
  const body = encodeCrockford(uuidV7Bytes(nowMs));
  return `${prefix}_${body}` as BrandedId<K>;
}

/** Convenience minters used by the gateway/DO contracts and tests. */
export const newOwnerId = (nowMs?: number): OwnerId => mintId("owner", nowMs);
export const newAgentId = (nowMs?: number): AgentId => mintId("agent", nowMs);
export const newRoomId = (nowMs?: number): RoomId => mintId("room", nowMs);
export const newProjectId = (nowMs?: number): ProjectId => mintId("project", nowMs);
export const newTaskId = (nowMs?: number): TaskId => mintId("task", nowMs);
export const newMessageId = (nowMs?: number): MessageId => mintId("message", nowMs);
export const newJobId = (nowMs?: number): JobId => mintId("job", nowMs);
export const newArtifactId = (nowMs?: number): ArtifactId => mintId("artifact", nowMs);
export const newEventId = (nowMs?: number): EventId => mintId("event", nowMs);
export const newRequestId = (nowMs?: number): RequestId => mintId("request", nowMs);
export const newCorrelationId = (nowMs?: number): CorrelationId => mintId("correlation", nowMs);

export function parseId(value: unknown): ParsedId | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf("_");
  if (separator <= 0) return null;
  const prefix = value.slice(0, separator);
  const body = value.slice(separator + 1);
  const kind = KIND_BY_PREFIX.get(prefix);
  if (kind === undefined) return null;
  if (body.length !== ID_BODY_LENGTH || !BODY_PATTERN.test(body)) return null;
  const bytes = decodeCrockford(body);
  if (bytes.length < 6) return null;
  if ((bytes[6] ?? 0) >> 4 !== 0x7) return null; // version nibble must be 7
  if (((bytes[8] ?? 0) & 0xc0) !== 0x80) return null; // RFC variant
  let mintedAtMs = 0;
  for (let i = 0; i < 6; i += 1) mintedAtMs = mintedAtMs * 256 + (bytes[i] ?? 0);
  return { kind, prefix: prefix as IdPrefix, body, mintedAtMs };
}

/** True only when `value` is a well-formed id of exactly this aggregate kind. */
export function isIdOfKind<K extends IdKind>(value: unknown, kind: K): value is BrandedId<K> {
  const parsed = parseId(value);
  return parsed !== null && parsed.kind === kind;
}

export class IdContractError extends Error {
  readonly expectedKind: IdKind;
  constructor(expectedKind: IdKind, received: unknown) {
    super(`expected a ${expectedKind}_ id, received ${describe(received)}`);
    this.name = "IdContractError";
    this.expectedKind = expectedKind;
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 64 ? `${value.slice(0, 61)}...` : value);
  return typeof value;
}

/** Throws unless `value` is an id of the expected kind. Use at every boundary. */
export function assertIdOfKind<K extends IdKind>(value: unknown, kind: K): BrandedId<K> {
  if (!isIdOfKind(value, kind)) throw new IdContractError(kind, value);
  return value;
}

/**
 * A client may only ever send these; anything else id-shaped is rejected by the
 * gateway so an attacker cannot choose the primary key of a new row.
 */
export interface ClientSuppliedIdentifiers {
  readonly idempotencyKey: string;
  readonly expectedRevision?: number;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function assertIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new IdContractError("request", value);
  }
  return value;
}

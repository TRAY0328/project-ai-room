/**
 * Minimal D1 surface shared by every package in this track.
 *
 * It mirrors Cloudflare D1 (`prepare().bind().all()/first()/run()`, `batch`)
 * so the same code runs against a real binding in production and against a
 * node:sqlite shim in tests. Nothing here knows about SQLite specifics.
 *
 * Every statement is parameterised. There is no string interpolation helper on
 * purpose: an identifier that cannot be bound must be checked against a literal
 * allowlist by the caller (see packages/git for the same rule on paths).
 */
export interface D1Result<T> {
  readonly results: T[];
  readonly success: boolean;
  readonly meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface SqlDb {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<unknown>;
  batch?(statements: readonly D1PreparedStatement[]): Promise<unknown[]>;
}

export async function allRows<T>(db: SqlDb, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params).all<T>();
  return result.results;
}

export async function firstRow<T>(db: SqlDb, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export async function exec(db: SqlDb, sql: string, ...params: unknown[]): Promise<{ success: boolean; meta?: Record<string, unknown> }> {
  return db.prepare(sql).bind(...params).run();
}

/** Single scalar value from the first column of the first row. */
export async function scalar<T extends string | number | null>(db: SqlDb, sql: string, ...params: unknown[]): Promise<T | null> {
  const row = await firstRow<Record<string, T>>(db, sql, ...params);
  if (row === null) return null;
  const values = Object.values(row);
  return values.length === 0 ? null : (values[0] ?? null);
}

export interface BatchRead {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

/**
 * Several reads in ONE round trip.
 *
 * D1 charges a full network round trip per statement; a page of 40 messages used
 * to cost one round trip per message per relation. `batch()` sends the whole
 * list in a single request, so the page costs one round trip for the messages
 * and one for their relations. A caller that only has the per-statement fallback
 * (a shim without `batch`) gets the same rows, just slower.
 *
 * Only reads belong here: a batched write would hide which statement failed.
 */
export async function batchRows(db: SqlDb, reads: readonly BatchRead[]): Promise<Record<string, unknown>[][]> {
  if (reads.length === 0) return [];
  if (typeof db.batch === "function") {
    const results = (await db.batch(reads.map((read) => db.prepare(read.sql).bind(...(read.params ?? []))))) as
      | Array<{ results?: unknown } | undefined>
      | undefined;
    return reads.map((_read, index) => {
      const rows = results?.[index]?.results;
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    });
  }
  const out: Record<string, unknown>[][] = [];
  for (const read of reads) out.push(await allRows<Record<string, unknown>>(db, read.sql, ...(read.params ?? [])));
  return out;
}

/** `?,?,?` for an `IN (...)` list of the given length. */
export function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

export async function count(db: SqlDb, sql: string, ...params: unknown[]): Promise<number> {
  const value = await scalar<number>(db, sql, ...params);
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** ISO-8601 UTC with milliseconds — the only timestamp format D1 stores. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isoTtl(ms: number, from: number = Date.now()): string {
  return new Date(from + ms).toISOString();
}

/** 26-char Crockford body after a typed prefix: matches the D1 CHECK patterns. */
const ID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidId(value: unknown, prefix: string): boolean {
  if (typeof value !== "string" || !value.startsWith(`${prefix}_`)) return false;
  return ID_BODY.test(value.slice(prefix.length + 1));
}

/** A prefixed id from contracts (ids.ts) is accepted; anything else is not. */
export function requireId(value: unknown, prefix: string, label: string): string {
  if (!isValidId(value, prefix)) {
    throw new TypeError(`${label} must be a ${prefix}_ id`);
  }
  return value as string;
}

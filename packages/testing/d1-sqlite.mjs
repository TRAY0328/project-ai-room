// @ai-room/testing — test-only helpers. Plain ESM so it needs no build step.
//
// The D1 shim is deliberately behaviour-compatible with Cloudflare D1 for the
// surface this repo uses: prepare().bind().all()/first()/run(), exec(), batch().
// It is NOT a D1 emulator: no network, no replicas, no eventual consistency.
// Tests therefore prove the SQL and the handler logic, not D1's runtime.

import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "db/migrations");

function normalise(values) {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Uint8Array) return value;
    return value;
  });
}

class ShimStatement {
  #db;
  #sql;
  #params;
  constructor(db, sql, params = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }
  bind(...values) {
    return new ShimStatement(this.#db, this.#sql, normalise(values));
  }
  #statement() {
    const statement = this.#db.prepare(this.#sql);
    // node:sqlite refuses undefined; null must come from the caller explicitly.
    return statement;
  }
  async all() {
    const rows = this.#statement().all(...this.#params);
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }
  async first() {
    const row = this.#statement().get(...this.#params);
    return row === undefined ? null : row;
  }
  async run() {
    const info = this.#statement().run(...this.#params);
    return {
      success: true,
      meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
    };
  }
  /** Test-only: the raw SQL, for assertions about parameterisation. */
  get sql() {
    return this.#sql;
  }
}

class ShimDb {
  #db;
  /** Counts every statement so a test can assert a bounded number of queries. */
  stats = { prepared: 0, writes: 0, batches: 0 };
  constructor(raw) {
    this.#db = raw;
  }
  prepare(sql) {
    this.stats.prepared += 1;
    return new ShimStatement(this.#db, sql);
  }
  async exec(sql) {
    this.#db.exec(sql);
    return { success: true };
  }
  /**
   * D1's `batch()` answers one `D1Result` per statement, reads included, so a
   * caller can read rows back out of it. Returning `run()` metadata here would
   * silently drop every SELECT result and make a batched read look empty.
   */
  async batch(statements) {
    this.stats.batches += 1;
    const out = [];
    for (const statement of statements) {
      const { results } = await statement.all();
      out.push({ results, success: true, meta: { changes: 0, rows_read: results.length } });
    }
    return out;
  }
  get raw() {
    return this.#db;
  }
}

export async function applyMigrations(raw) {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) raw.exec(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
  return files;
}

/**
 * Fresh in-memory database with the real migration applied.
 * `db` is the D1-compatible facade; `raw` is node:sqlite for setup/assertions.
 */
export async function createTestDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  await applyMigrations(raw);
  const db = new ShimDb(raw);
  return {
    db,
    raw,
    close() {
      raw.close();
    },
  };
}

export const T0 = "2026-11-21T00:00:00.000Z";
export const SHA64 = "a".repeat(64);
export const SHA40 = "b".repeat(40);

export function isoAt(offsetMs = 0) {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/** A minimal but honest owner+room+agent fixture, used by integration tests. */
export function seedBase(raw) {
  raw.prepare("INSERT INTO owners (owner_id, display_name, email, created_at, updated_at) VALUES (?,?,?,?,?)").run(
    "owner_A1B2C3D4E5F6G7H8JKMNPQRS",
    "천예준",
    "owner@example.test",
    T0,
    T0,
  );
  raw
    .prepare("INSERT INTO rooms (room_id, room_type, name, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run("room_A1B2C3D4E5F6G7H8JKMNPQRS", "main", "AI ROOM", "owner_A1B2C3D4E5F6G7H8JKMNPQRS", T0, T0);
  raw
    .prepare("INSERT INTO room_acl (room_id, actor_kind, actor_id, role, granted_by, granted_at) VALUES (?,?,?,?,?,?)")
    .run("room_A1B2C3D4E5F6G7H8JKMNPQRS", "owner", "owner_A1B2C3D4E5F6G7H8JKMNPQRS", "owner", "system", T0);
  raw
    .prepare("INSERT INTO room_members (room_id, actor_kind, actor_id, joined_at, invited_by) VALUES (?,?,?,?,?)")
    .run("room_A1B2C3D4E5F6G7H8JKMNPQRS", "owner", "owner_A1B2C3D4E5F6G7H8JKMNPQRS", T0, "system");
}

/** In-memory R2 stand-in: put/get/delete/head with the same key semantics. */
export function createFakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options = {}) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      objects.set(key, { bytes, options });
      return { key, size: bytes.length, etag: `etag-${objects.size}` };
    },
    async get(key) {
      const found = objects.get(key);
      if (found === undefined) return null;
      return {
        key,
        size: found.bytes.length,
        body: found.bytes,
        async arrayBuffer() {
          return found.bytes.buffer.slice(found.bytes.byteOffset, found.bytes.byteOffset + found.bytes.length);
        },
        async text() {
          return new TextDecoder().decode(found.bytes);
        },
      };
    },
    async head(key) {
      const found = objects.get(key);
      return found === undefined ? null : { key, size: found.bytes.length };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** Request helper: one HTTP call into a worker handler, with envelope parsing. */
export function createCaller(handler, env) {
  let counter = 0;
  return async function call(method, path, options = {}) {
    counter += 1;
    const headers = new Headers(options.headers ?? {});
    headers.set("x-request-id", options.requestId ?? `req_TEST${String(counter).padStart(20, "0")}`);
    if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
    if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    } else if (options.rawBody !== undefined) {
      headers.set("content-type", options.contentType ?? "application/octet-stream");
      body = options.rawBody;
    }
    const request = new Request(`https://ai-room.test${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
    const response = await handler.fetch(request, env);
    const text = await response.text();
    let json;
    try {
      json = text.length === 0 ? null : JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: response.status, headers: response.headers, json, text };
  };
}

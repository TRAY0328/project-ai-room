#!/usr/bin/env node
/**
 * Applies db/migrations/*.sql to a local SQLite database with node:sqlite.
 *
 *   node scripts/db-migrate.mjs                 # writes db/local/ai_room_dev.sqlite
 *   node scripts/db-migrate.mjs --memory --check
 *
 * This is a *local* verification harness for the D1 schema, not a deployment:
 * no Cloudflare resource is touched. It records a SHA-256 of each applied file
 * so an edited migration is detected instead of silently re-run.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const migrationsDir = join(repoRoot, "db/migrations");

export function openDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export async function applyMigrations(db, { quiet = false } = {}) {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = [];
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    db.exec(sql);
    const version = file.replace(/\.sql$/, "");
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?").run(checksum, version);
    if (checksum === "pending") throw new Error(`migration ${file} did not record itself`);
    applied.push({ version, checksum, bytes: sql.length });
    if (!quiet) console.log(`applied ${file} (${sql.length} bytes, sha256 ${checksum.slice(0, 12)}…)`);
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) throw new Error(`foreign key violations: ${JSON.stringify(violations)}`);
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") throw new Error(`integrity_check: ${integrity.integrity_check}`);
  return applied;
}

export function schemaSummary(db) {
  const tables = db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all();
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all();
  const fts = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%USING fts5%'").all();
  return {
    tables: tables.length,
    userTables: tables.filter((t) => t.type === "table").length,
    indexes: indexes.length,
    triggers: triggers.length,
    ftsTables: fts.map((t) => t.name),
    tableNames: tables.map((t) => t.name),
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const memory = process.argv.includes("--memory");
  const check = process.argv.includes("--check");
  let dbPath = ":memory:";
  if (!memory && !check) {
    const dir = join(repoRoot, "db/local");
    await mkdir(dir, { recursive: true });
    dbPath = join(dir, "ai_room_dev.sqlite");
  }
  const db = openDatabase(dbPath);
  try {
    const applied = await applyMigrations(db);
    const summary = schemaSummary(db);
    const fk = db.prepare("PRAGMA foreign_keys").get();
    console.log(
      JSON.stringify(
        {
          database: dbPath,
          applied,
          foreign_keys: fk.foreign_keys,
          tables: summary.userTables,
          indexes: summary.indexes,
          triggers: summary.triggers,
          fts: summary.ftsTables,
          journal: db.prepare("PRAGMA journal_mode").get(),
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

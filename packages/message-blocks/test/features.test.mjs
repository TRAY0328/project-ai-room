/**
 * 108-feature coverage test.
 *
 * The catalog fixture is byte-identical to the spec pack copy (pinned by
 * CATALOG_SHA256). Every one of the 108 rows must be implemented somewhere and
 * proven:
 *   - blocks / message surfaces run the proof function right here;
 *   - app surfaces must be declared in apps/web/src/lib/app-feature-manifest.ts,
 *     where the web component tests prove them.
 * A missing proof fails the run — "covered" is never assumed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FEATURES, FEATURE_COUNT, CATALOG_SHA256, featuresBySurface } from "../dist/features.js";
import { PROOFS } from "./proofs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "content_feature_catalog.json");
const raw = readFileSync(fixturePath);
const catalog = JSON.parse(raw.toString("utf8"));
const catalogLabels = Object.entries(catalog).flatMap(([group, items]) => items.map((label) => ({ group, label })));

test("catalog fixture is the pinned spec-pack file", () => {
  const sha = createHash("sha256").update(raw).digest("hex");
  assert.equal(sha, CATALOG_SHA256, "catalog fixture changed — regenerate features.ts and record the new SHA");
});

test("catalog contains exactly 108 features", () => {
  assert.equal(catalogLabels.length, 108);
  assert.equal(FEATURE_COUNT, 108);
});

test("every catalog feature has exactly one registry row, in catalog order", () => {
  assert.equal(FEATURES.length, catalogLabels.length);
  const ids = new Set();
  FEATURES.forEach((row, index) => {
    const expected = catalogLabels[index];
    assert.equal(row.group, expected.group, `row ${index} group mismatch`);
    assert.equal(row.label, expected.label, `row ${index} label mismatch`);
    assert.match(row.id, /^F-\d{3}$/);
    assert.ok(!ids.has(row.id), `duplicate id ${row.id}`);
    ids.add(row.id);
  });
  assert.equal(ids.size, 108);
});

test("block + message surface proofs all execute and pass", () => {
  const rows = FEATURES.filter((f) => f.surface === "blocks" || f.surface === "message");
  assert.equal(rows.length, 67, "expected 67 renderer-proven features");
  const failures = [];
  for (const row of rows) {
    const proof = PROOFS[row.id];
    if (!proof) {
      failures.push(`${row.id} ${row.label}: proof 없음`);
      continue;
    }
    try {
      proof();
    } catch (error) {
      failures.push(`${row.id} ${row.label}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("app-surface features are declared in the web feature manifest", () => {
  const rows = featuresBySurface("app");
  assert.equal(rows.length, 41);

  const manifestPath = join(here, "..", "..", "..", "apps", "web", "src", "lib", "app-feature-manifest.ts");
  if (!existsSync(manifestPath)) {
    assert.fail(`apps/web manifest missing at ${manifestPath} — ${rows.length} app features unproven`);
  }
  const manifest = readFileSync(manifestPath, "utf8");
  const missing = rows.filter((row) => !manifest.includes(`"${row.id}"`));
  assert.deepEqual(missing.map((m) => `${m.id} ${m.label}`), [], "app features not declared in manifest");
});

test("surface split is 62 blocks / 5 message / 41 app", () => {
  assert.equal(featuresBySurface("blocks").length, 62);
  assert.equal(featuresBySurface("message").length, 5);
  assert.equal(featuresBySurface("app").length, 41);
});

test("no proof is orphaned (proof map has no unknown ids)", () => {
  const known = new Set(FEATURES.map((f) => f.id));
  const orphans = Object.keys(PROOFS).filter((id) => !known.has(id));
  assert.deepEqual(orphans, []);
});

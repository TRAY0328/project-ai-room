/**
 * Bundle report: real file sizes, gzip sizes and SHA-256 for the production build.
 *
 * Written to dist/BUILD_INFO.json so a release report can quote exactly what was
 * built, and printed as a table for the task log. Fails if index.html references
 * an asset that is not on disk (a broken build must not report success).
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const distDir = new URL("../dist/", import.meta.url).pathname;
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(distDir);

const assets = files
  .filter((f) => !f.endsWith("BUILD_INFO.json"))
  .map((f) => {
    const buf = readFileSync(f);
    return {
      path: relative(distDir, f).split("\\").join("/"),
      bytes: buf.length,
      gzipBytes: gzipSync(buf, { level: 9 }).length,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  })
  .sort((a, b) => b.bytes - a.bytes);

const html = readFileSync(join(distDir, "index.html"), "utf8");
const referenced = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
const missing = referenced.filter((ref) => !assets.some((a) => a.path === ref));

const total = assets.reduce((sum, a) => sum + a.bytes, 0);
const totalGzip = assets.reduce((sum, a) => sum + a.gzipBytes, 0);

const info = {
  generated_at: new Date().toISOString(),
  node: process.version,
  asset_count: assets.length,
  total_bytes: total,
  total_gzip_bytes: totalGzip,
  entry_html_sha256: createHash("sha256").update(readFileSync(join(distDir, "index.html"))).digest("hex"),
  assets,
  index_references: referenced,
  missing_referenced_assets: missing,
};

writeFileSync(join(distDir, "BUILD_INFO.json"), JSON.stringify(info, null, 2));

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log("path".padEnd(38), "raw".padStart(11), "gzip".padStart(11), "sha256");
for (const asset of assets) {
  console.log(asset.path.padEnd(38), kb(asset.bytes).padStart(11), kb(asset.gzipBytes).padStart(11), asset.sha256.slice(0, 16) + "…");
}
console.log("-".repeat(90));
console.log("total".padEnd(38), kb(total).padStart(11), kb(totalGzip).padStart(11));
if (missing.length > 0) {
  console.error("MISSING assets referenced by index.html:", missing.join(", "));
  process.exit(1);
}
if (assets.length === 0) {
  console.error("no assets found — build missing");
  process.exit(1);
}

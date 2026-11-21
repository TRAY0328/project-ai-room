/**
 * Acceptance tests — the API description itself (spec 19.2, 26.1) and the
 * documentation consistency the release report depends on (QA-103).
 *
 * The OpenAPI file is regenerated and compared, never trusted as text that
 * "looks right". The documentation check resolves every relative link.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./qa_matrix_runner.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SPEC_DIR = existsSync(resolve(ROOT, "spec/api_catalog.json")) ? resolve(ROOT, "spec") : resolve(ROOT, "../work/ai_room_pack/PROJECT_AI_ROOM");
const SPEC = resolve(SPEC_DIR, "api_catalog.json");
const OPENAPI = join(ROOT, "docs/api/openapi.json");

async function loadDoc() {
  return JSON.parse(await readFile(OPENAPI, "utf8"));
}

function catalogEndpoints(catalog) {
  const out = [];
  for (const [group, entries] of Object.entries(catalog)) {
    for (const entry of entries) out.push({ group, ...entry });
  }
  return out;
}

// ---------------------------------------------------------------------------
test("QA-103 출시 문서 정합성: 상대 링크·출시 보고서 라벨·OpenAPI 동기화", async () => {
  const checks = await runChecks(ROOT);
  const links = checks["docs-links"];
  assert.equal(links.status, "PASS", `깨진 문서 링크: ${links.detail}`);
  const labels = checks["release-report-labels"];
  assert.equal(labels.status, "PASS", `출시 보고서 라벨 누락: ${labels.detail}`);
  const openapi = checks["openapi-sync"];
  assert.equal(openapi.status, "PASS", `OpenAPI 동기화 실패: ${openapi.detail}`);
});

test("OpenAPI: 78개 엔드포인트가 api_catalog.json과 1:1로 일치한다", async () => {
  const doc = await loadDoc();
  const catalog = JSON.parse(await readFile(SPEC, "utf8"));
  const expected = catalogEndpoints(catalog);
  assert.equal(expected.length, 78);

  const actual = Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })));
  assert.equal(actual.length, 78);

  const key = (entry) => `${entry.method} ${entry.path}`;
  const actualKeys = new Set(actual.map(key));
  for (const entry of expected) assert.ok(actualKeys.has(key(entry)), `누락: ${key(entry)}`);
  const expectedKeys = new Set(expected.map(key));
  for (const entry of actual) assert.ok(expectedKeys.has(key(entry)), `카탈로그에 없는 경로: ${key(entry)}`);

  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc["x-ai-room-endpoint-count"], 78);
  assert.equal(new Set(actual.map((entry) => entry.operation.operationId)).size, 78);
});

test("OpenAPI: 모든 오퍼레이션에 권한 액션·수용 테스트 ID·보안 스킴이 있다", async () => {
  const doc = await loadDoc();
  const schemeNames = new Set(Object.keys(doc.components.securitySchemes));
  const qaIds = new Set();
  const matrix = JSON.parse(await readFile(resolve(SPEC_DIR, "qa_matrix.json"), "utf8"));
  for (const entries of Object.values(matrix)) for (const entry of entries) qaIds.add(entry.id);

  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const where = `${method.toUpperCase()} ${path}`;
      assert.ok(operation.operationId, `${where}: operationId 없음`);
      assert.notEqual(operation["x-ai-room-permission-action"], "UNMAPPED", `${where}: 권한 액션 미매핑`);
      assert.ok(Array.isArray(operation["x-ai-room-test-ids"]) && operation["x-ai-room-test-ids"].length > 0, `${where}: 수용 테스트 ID 없음`);
      for (const id of operation["x-ai-room-test-ids"]) assert.ok(qaIds.has(id), `${where}: QA 매트릭스에 없는 ID ${id}`);
      for (const requirement of operation.security ?? []) {
        for (const name of Object.keys(requirement)) assert.ok(schemeNames.has(name), `${where}: 선언되지 않은 보안 스킴 ${name}`);
      }
    }
  }
});

test("OpenAPI: 커밋된 문서가 생성기 출력과 같다(손으로 고치지 않았다)", () => {
  const result = spawnSync(process.execPath, [join("scripts", "gen-openapi.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OPENAPI IN SYNC/);
});

test("OpenAPI: 오류 26코드와 WebSocket 계약이 문서화돼 있다", async () => {
  const doc = await loadDoc();
  const codes = doc["x-ai-room-error-codes"];
  assert.ok(Array.isArray(codes));
  assert.equal(codes.length, 26);
  for (const required of ["AUTH_REQUIRED", "REVISION_CONFLICT", "APPROVAL_REQUIRED", "QUOTA_EXHAUSTED", "INTERNAL_ERROR"]) {
    assert.ok(codes.includes(required), `${required} 누락`);
  }
  assert.equal(doc.components.schemas.ErrorEnvelope.properties.ok.const, false);
  assert.equal(doc.components.schemas.ErrorObject.properties.retryable.type, "boolean");

  const ws = doc["x-ai-room-websocket"];
  assert.ok(ws, "WebSocket 확장 계약 누락");
  assert.ok(ws.delivery_rule.includes("D1"));
  assert.ok(ws.gap_recovery.includes("room_seq"));
  assert.ok(ws.permission_revocation.includes("즉시"));

  // Every relative $ref must resolve inside components.
  const serialized = JSON.stringify(doc);
  for (const match of serialized.matchAll(/"\$ref":"#\/components\/([a-z]+)\/([A-Za-z0-9_]+)"/g)) {
    const [, section, name] = match;
    assert.ok(doc.components[section]?.[name] !== undefined, `unresolved $ref ${section}/${name}`);
  }
});

test("문서 파일이 실제로 존재하고 비어 있지 않다", async () => {
  for (const file of [
    "docs/operator-guide/RUNBOOK.md",
    "docs/operator-guide/BACKUP_RESTORE.md",
    "docs/operator-guide/DEPLOYMENT.md",
    "docs/user-guide/OWNER_GUIDE.md",
    "docs/user-guide/AI_BROWSER_PORTAL_GUIDE.md",
    "docs/security/SECURITY_CONTROLS.md",
  ]) {
    assert.ok(existsSync(join(ROOT, file)), `${file} 없음`);
    const text = await readFile(join(ROOT, file), "utf8");
    assert.ok(text.length > 1000, `${file} 내용이 너무 짧다 (${text.length} bytes)`);
  }
});

#!/usr/bin/env node
/**
 * Contract/runtime cross-check.
 *
 *   node scripts/verify-contracts.mjs
 *
 * Fails (exit 1) when:
 *   - the generated API catalog is out of sync with the spec pack's 78 endpoints,
 *   - any endpoint lacks an operationId, a unique path, or a permission mapping,
 *   - the provider registry and the frozen required roster disagree,
 *   - the other spec catalogs (QA, metrics, content, security, UI) are missing.
 *
 * It reads the spec pack only for verification; the build itself does not.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packDir = process.env.AI_ROOM_PACK ?? resolve(repoRoot, "../work/ai_room_pack/PROJECT_AI_ROOM");

const failures = [];
const notes = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const contracts = await import(resolve(repoRoot, "packages/contracts/dist/index.js"));
const providers = await import(resolve(repoRoot, "services/provider-adapters/dist/index.js"));

const apiCatalog = JSON.parse(await readFile(resolve(packDir, "api_catalog.json"), "utf8"));
const specEndpoints = Object.entries(apiCatalog).flatMap(([group, entries]) =>
  entries.map((entry) => ({ group, method: entry.method, path: entry.path, contract: entry.contract })),
);

// 1. endpoint count and identity
check(specEndpoints.length === 78, `spec pack has ${specEndpoints.length} endpoints, expected 78`);
check(contracts.API_CATALOG.length === specEndpoints.length, `generated catalog has ${contracts.API_CATALOG.length}`);
const specSet = new Set(specEndpoints.map((e) => `${e.method} ${e.path}`));
const codeSet = new Set(contracts.API_CATALOG.map((e) => `${e.method} ${e.path}`));
for (const key of specSet) check(codeSet.has(key), `missing endpoint in code: ${key}`);
for (const key of codeSet) check(specSet.has(key), `endpoint in code not in spec: ${key}`);

// 2. operationId uniqueness and required metadata
const operationIds = contracts.API_CATALOG.map((e) => e.operationId);
check(new Set(operationIds).size === operationIds.length, "duplicate operationId");
for (const endpoint of contracts.API_CATALOG) {
  check(endpoint.contract.length > 0, `${endpoint.operationId} has no contract text`);
  check(["public", "owner_bootstrap", "invite", "owner", "authenticated"].includes(endpoint.auth), `${endpoint.operationId} has unknown auth scope`);
  for (const param of endpoint.pathParams) {
    check(endpoint.path.includes(`{${param}}`), `${endpoint.operationId} pathParams mismatch`);
  }
}

// 3. the route matcher resolves every catalog path
for (const endpoint of contracts.API_CATALOG) {
  const concrete = endpoint.path.replace(/\{[A-Za-z0-9_]+\}/g, "x");
  const match = contracts.matchRoute(contracts.API_CATALOG, endpoint.method, concrete);
  check(match !== null && match.endpoint.operationId === endpoint.operationId, `route matcher failed for ${endpoint.operationId}`);
}

// 4. provider registry matches the frozen roster
const roster = JSON.parse(await readFile(resolve(packDir, "required_agents.example.json"), "utf8")).agents;
const registry = providers.buildProviderRegistry();
check(registry.size === roster.length, `registry has ${registry.size} providers, roster has ${roster.length}`);
for (const agent of roster) {
  const entry = registry.get(agent.provider_key);
  check(entry !== undefined, `registry missing provider ${agent.provider_key}`);
  if (entry !== undefined) {
    check(entry.evidence.official_doc_urls.length > 0, `${agent.provider_key} has no official doc url`);
    check(["VERIFIED", "PAID_API_REQUIRED", "NO_OFFICIAL_EVIDENCE", "CAPABILITY_MISSING", "NOT_CONFIGURED"].includes(entry.evidence.state), `${agent.provider_key} has unexpected state ${entry.evidence.state}`);
  }
}
const gate = providers.q039Gate();
check(gate.gate === "BLOCKED_EXTERNAL_DEPENDENCY", `Q039 gate should be blocked, got ${gate.gate}`);
check(gate.blockers.length === roster.length, `expected ${roster.length} blockers, got ${gate.blockers.length}`);

// 5. the rest of the spec catalogs are present and counted
const catalogs = [
  ["qa_matrix.json", "cases"],
  ["metrics_catalog.json", null],
  ["content_feature_catalog.json", null],
  ["security_cases.json", null],
  ["ui_screen_registry.json", null],
];
for (const [file] of catalogs) {
  try {
    const parsed = JSON.parse(await readFile(resolve(packDir, file), "utf8"));
    const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
    notes.push(`${file}: ${count} top-level entries`);
  } catch (error) {
    failures.push(`${file} could not be read: ${error.message}`);
  }
}

notes.push(`contract version ${contracts.CONTRACT_MANIFEST.contract_version}`);
notes.push(`endpoints ${contracts.CONTRACT_MANIFEST.api_endpoints}, error codes ${contracts.CONTRACT_MANIFEST.error_codes}, events ${contracts.CONTRACT_MANIFEST.event_types}, permissions ${contracts.CONTRACT_MANIFEST.permission_actions}`);
notes.push(`providers ${registry.size}, Q039 gate ${gate.gate} (${gate.blockers.length} blockers)`);

if (failures.length > 0) {
  console.error("CONTRACT VERIFICATION FAILED");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("CONTRACT VERIFICATION PASSED");
for (const note of notes) console.log(` - ${note}`);

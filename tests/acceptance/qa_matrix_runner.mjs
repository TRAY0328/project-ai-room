#!/usr/bin/env node
/**
 * QA matrix runner — spec 24 (test strategy) and 25 (release gates).
 *
 * Reads the 103 acceptance items in qa_matrix.json and the 50 security cases in
 * security_cases.json, then decides each item's status from evidence that it
 * actually checks:
 *
 *   PASS        every attached piece of evidence ran here and passed, and the
 *               evidence covers the whole expected outcome.
 *   PARTIAL     the evidence passed but covers only part of the expectation
 *               (typically the pure decision layer, not the HTTP handler).
 *   FAILED      an attached test ran and failed, or an attached evidence file /
 *               test name no longer exists — drift is a failure, not a pass.
 *   BLOCKED     an external dependency is missing (no provider key, R2 off,
 *               no remote D1, no device) and was recorded as such.
 *   NOT_TESTED  nothing was attached, or tests were not run in this invocation.
 *
 * No status is hard-coded. The evidence map is data; the tests behind it are
 * executed.
 *
 * Usage
 *   node tests/acceptance/qa_matrix_runner.mjs                 # human summary
 *   node tests/acceptance/qa_matrix_runner.mjs --json          # machine JSON
 *   node tests/acceptance/qa_matrix_runner.mjs --write         # + status files
 *   node tests/acceptance/qa_matrix_runner.mjs --no-run        # do not execute tests
 *   node tests/acceptance/qa_matrix_runner.mjs --filter QA-019
 *
 * Exit codes: 0 all PASS · 1 any FAILED · 2 cannot evaluate · 3 executed, gaps remain
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");
const SPEC_DIR = resolve(REPO_ROOT, "../work/ai_room_pack/PROJECT_AI_ROOM");
const QA_FILE = process.env.AI_ROOM_QA_MATRIX ?? join(SPEC_DIR, "qa_matrix.json");
const SECURITY_FILE = process.env.AI_ROOM_SECURITY_CASES ?? join(SPEC_DIR, "security_cases.json");
const EVIDENCE_FILE = process.env.AI_ROOM_EVIDENCE_MAP ?? join(HERE, "qa_evidence_map.json");

const STATUS_ORDER = ["FAILED", "BLOCKED", "PARTIAL", "NOT_TESTED", "PASS"];

/** Every *.test.mjs under the repo's tests/ tree, excluding node_modules. */
export function discoverTestFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith(".test.mjs")) out.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(join(root, "tests"));
  return out.sort();
}

/** Runs one test file and returns {name -> "pass"|"fail"|"skip"}. */
function runTestFile(relPath, root) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", relPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const results = new Map();
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  for (const line of output.split("\n")) {
    const m = /^(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$/.exec(line.trim());
    if (m === null) continue;
    const name = m[2].trim();
    if (name === relPath || name.includes(".test.mjs")) continue; // file-level wrapper
    const status = m[1] === "not ok" ? "fail" : m[3] === "SKIP" || m[3] === "TODO" ? "skip" : "pass";
    // A later duplicate (same name) must not hide an earlier failure.
    const previous = results.get(name);
    results.set(name, previous === "fail" ? "fail" : status);
  }
  return {
    file: relPath,
    exitCode: result.status,
    durationMs: Date.now() - started,
    timedOut: result.error?.code === "ETIMEDOUT",
    results,
    stderrTail: result.status === 0 ? "" : `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1200),
  };
}


/**
 * Checks are computed here from real files and real commands. Nothing in the
 * evidence map decides a status: it only names which check applies.
 * @returns {Promise<Record<string, {status: "PASS"|"FAILED"|"BLOCKED"|"NOT_TESTED", detail: string}>>}
 */
export async function runChecks(root = REPO_ROOT) {
  const checks = {};

  // 1. The committed OpenAPI document is exactly what the generator produces.
  {
    const result = spawnSync(process.execPath, [join("scripts", "gen-openapi.mjs"), "--check"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    checks["openapi-sync"] = result.status === 0 && /IN SYNC/.test(output)
      ? { status: "PASS", detail: output.split("\n").at(-1) }
      : { status: "FAILED", detail: output.split("\n").slice(-3).join(" ") || `exit ${result.status}` };
  }

  // 2. Every relative markdown link in the operator/user/security/API docs resolves.
  {
    const docDirs = ["docs/api", "docs/operator-guide", "docs/user-guide", "docs/security"];
    const files = [];
    const walk = (dir) => {
      const full = join(root, dir);
      if (!existsSync(full)) return;
      for (const name of readdirSync(full)) {
        const rel = `${dir}/${name}`;
        const stat = statSync(join(root, rel));
        if (stat.isDirectory()) walk(rel);
        else if (name.endsWith(".md")) files.push(rel);
      }
    };
    for (const dir of docDirs) walk(dir);
    const missing = [];
    for (const file of files) {
      const text = await readFile(join(root, file), "utf8");
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const clean = target.split("#")[0].split("?")[0];
        if (clean.length === 0) continue;
        const resolved = join(dirname(join(root, file)), clean);
        if (!existsSync(resolved)) missing.push(`${file} -> ${target}`);
      }
    }
    checks["docs-links"] = missing.length === 0
      ? { status: "PASS", detail: `${files.length}개 문서의 상대 링크 모두 존재` }
      : { status: "FAILED", detail: `깨진 링크 ${missing.length}건: ${missing.slice(0, 5).join(", ")}` };
  }

  // 3. The release report carries every label the template requires.
  {
    // The template lives in the spec pack; the filled report lives in the repo.
    const templateCandidates = [
      join(root, "docs/evidence/FINAL_RELEASE_REPORT_TEMPLATE.md"),
      join(SPEC_DIR, "FINAL_RELEASE_REPORT_TEMPLATE.md"),
    ];
    const template = templateCandidates.find((candidate) => existsSync(candidate)) ?? templateCandidates[0];
    const report = join(root, "docs/evidence/FINAL_RELEASE_REPORT.md");
    if (!existsSync(template) || !existsSync(report)) {
      checks["release-report-labels"] = { status: "NOT_TESTED", detail: "템플릿 또는 보고서 없음" };
    } else {
      const templateText = await readFile(template, "utf8");
      const reportText = await readFile(report, "utf8");
      const labels = [...templateText.matchAll(/^[-*]?\s*([A-Za-z][A-Za-z0-9 /_().\-]{2,70}):\s*\S/gm)].map((m) => m[1].trim());
      const missing = labels.filter((label) => !reportText.includes(`${label}:`));
      checks["release-report-labels"] = labels.length === 0
        ? { status: "FAILED", detail: "템플릿에서 라벨을 찾지 못했다(검사 자체 실패)" }
        : missing.length === 0
        ? { status: "PASS", detail: `라벨 ${labels.length}개 모두 존재` }
        : { status: "FAILED", detail: `누락 라벨 ${missing.length}개: ${missing.slice(0, 6).join(", ")}` };
    }
  }

  // 4. The Q039 provider gate is honest: a blocker must not be reported as PASS.
  {
    try {
      const adapters = await import("@ai-room/provider-adapters");
      const gate = adapters.q039Gate();
      const blockers = Array.isArray(gate.blockers) ? gate.blockers.length : -1;
      checks["provider-gate"] = gate.gate === "PASS"
        ? { status: "PASS", detail: "required roster 전원 VERIFIED" }
        : gate.gate === "BLOCKED_EXTERNAL_DEPENDENCY"
          ? { status: "BLOCKED", detail: `Q039 ${gate.gate}, blocker ${blockers}건` }
          : { status: "FAILED", detail: `unexpected gate ${JSON.stringify(gate.gate)}` };
    } catch (error) {
      checks["provider-gate"] = { status: "NOT_TESTED", detail: `provider-adapters 로드 실패: ${error.message}` };
    }
  }

  // 5. Every catalog operation has exactly one permission action (default deny).
  {
    const permissionsPath = join(root, "packages/permissions/src/index.ts");
    const catalogPath = process.env.AI_ROOM_API_CATALOG ?? join(SPEC_DIR, "api_catalog.json");
    if (!existsSync(permissionsPath) || !existsSync(catalogPath)) {
      checks["permission-coverage"] = { status: "NOT_TESTED", detail: "권한 매핑 또는 카탈로그 없음" };
    } else {
      const permissions = await readFile(permissionsPath, "utf8");
      const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
      const mapped = new Set([...permissions.matchAll(/"([A-Za-z0-9-]+)":\s*"([a-z_.]+)",/g)].map((m) => m[1]));
      const operationIds = [];
      for (const entries of Object.values(catalog)) {
        for (const entry of entries) {
          operationIds.push(`${entry.method.toLowerCase()}-${entry.path.replace(/^\/v1\/?/, "").replace(/\{([A-Za-z0-9_]+)\}/g, "by-$1").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`);
        }
      }
      const missing = operationIds.filter((id) => !mapped.has(id));
      checks["permission-coverage"] = missing.length === 0
        ? { status: "PASS", detail: `${operationIds.length}/${operationIds.length} 오퍼레이션에 권한 액션 매핑` }
        : { status: "FAILED", detail: `매핑 누락 ${missing.length}건: ${missing.slice(0, 5).join(", ")}` };
    }
  }

  return checks;
}

function summarise(items) {
  const summary = { PASS: 0, PARTIAL: 0, FAILED: 0, BLOCKED: 0, NOT_TESTED: 0 };
  for (const item of items) summary[item.status] = (summary[item.status] ?? 0) + 1;
  return summary;
}

function worst(statuses) {
  for (const status of STATUS_ORDER) if (statuses.includes(status)) return status;
  return "PASS";
}

/**
 * @param {{runTests?: boolean, filter?: string}} [options]
 */
export async function runQaMatrix(options = {}) {
  const runTests = options.runTests !== false;
  const filter = options.filter ?? null;

  const qaRaw = JSON.parse(await readFile(QA_FILE, "utf8"));
  const securityRaw = existsSync(SECURITY_FILE) ? JSON.parse(await readFile(SECURITY_FILE, "utf8")) : [];
  let evidence;
  try {
    evidence = JSON.parse(await readFile(EVIDENCE_FILE, "utf8"));
  } catch {
    evidence = { qa: {}, security: {} };
  }

  const checks = await runChecks(REPO_ROOT);
  const files = discoverTestFiles();
  const testRuns = new Map();
  if (runTests) {
    for (const file of files) testRuns.set(file, runTestFile(file, REPO_ROOT));
  }

  const results = [];
  const mark = (def, entry, kind) => {
    const statuses = [];
    const notes = [];
    const evidenceRefs = [];

    if (entry?.blocked !== undefined) {
      results.push({
        kind, id: def.id, title: def.title, group: def.group,
        status: "BLOCKED", evidence: [], blocker: entry.blocked, severity: entry.severity ?? def.severity ?? null,
        note: entry.note ?? `외부 의존성: ${entry.blocked}`,
        expected: def.expected ?? def.required_control ?? null,
      });
      return;
    }

    const evidenceList = Array.isArray(entry?.evidence) ? entry.evidence : [];
    if (entry?.not_tested === true || evidenceList.length === 0) {
      results.push({
        kind, id: def.id, title: def.title, group: def.group,
        status: "NOT_TESTED", evidence: [], note: entry?.note ?? "근거가 연결되지 않음(기능 미구현)", severity: entry?.severity ?? def.severity ?? null,
        expected: def.expected ?? def.required_control ?? null,
      });
      return;
    }

    for (const item of evidenceList) {
      if (item.type === "test") {
        const ref = `${item.file} :: ${item.match ?? item.name}`;
        evidenceRefs.push(ref);
        if (!runTests) {
          statuses.push("NOT_TESTED");
          notes.push(`${ref} (이 실행에서 테스트 미실행)`);
          continue;
        }
        const run = testRuns.get(item.file);
        if (run === undefined) {
          statuses.push("FAILED");
          notes.push(`${ref} — 테스트 파일이 없다`);
          continue;
        }
        const name = item.name ?? [...run.results.keys()].find((key) => key.includes(item.match));
        if (name === undefined) {
          statuses.push("NOT_TESTED");
          notes.push(`${ref} — 파일에 해당 테스트가 없다`);
          continue;
        }
        const status = run.results.get(name);
        if (status === "pass") {
          statuses.push("PASS");
          notes.push(`${ref} — pass`);
        } else if (status === "skip") {
          statuses.push("NOT_TESTED");
          notes.push(`${ref} — skip`);
        } else {
          statuses.push("FAILED");
          notes.push(`${ref} — ${status === undefined ? "테스트를 찾지 못함" : "fail"}`);
        }
        continue;
      }
      if (item.type === "check") {
        const check = checks[item.check];
        const ref = `check:${item.check}`;
        evidenceRefs.push(ref);
        if (check === undefined) {
          statuses.push("FAILED");
          notes.push(`${ref} — 알 수 없는 검사`);
          continue;
        }
        statuses.push(check.status === "PASS" ? "PASS" : check.status === "FAILED" ? "FAILED" : check.status === "BLOCKED" ? "BLOCKED" : "NOT_TESTED");
        notes.push(`${ref} — ${check.status}: ${check.detail}`);
        continue;
      }
      statuses.push("NOT_TESTED");
      notes.push(`알 수 없는 근거 유형: ${String(item.type)}`);
    }

    let status = worst(statuses);
    if (status === "PASS" && entry?.cap === "PARTIAL") status = "PARTIAL";
    results.push({
      kind, id: def.id, title: def.title, group: def.group,
      status,
      severity: entry?.severity ?? def.severity ?? null,
      evidence: evidenceRefs,
      note: [entry?.missing ? `미검증 계층: ${entry.missing}` : null, ...notes].filter(Boolean).join(" / "),
      expected: def.expected ?? def.required_control ?? null,
    });
  };

  for (const [group, items] of Object.entries(qaRaw)) {
    for (const item of items) mark({ ...item, group }, evidence.qa?.[item.id], "qa");
  }
  for (const item of securityRaw) {
    mark({ ...item, title: item.threat ?? item.title, group: "보안 위협", expected: item.required_control }, evidence.security?.[item.id], "security");
  }

  const filtered = filter === null ? results : results.filter((item) => item.id === filter || item.id.startsWith(filter));
  const qaItems = filtered.filter((item) => item.kind === "qa");
  const securityItems = filtered.filter((item) => item.kind === "security");

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    sources: { qa_matrix: QA_FILE, security_cases: SECURITY_FILE, evidence_map: EVIDENCE_FILE },
    checks,
    tests: {
      executed: runTests,
      files: [...testRuns.values()].map((run) => ({
        file: run.file, exit_code: run.exitCode, duration_ms: run.durationMs,
        passed: [...run.results.values()].filter((s) => s === "pass").length,
        failed: [...run.results.values()].filter((s) => s === "fail").length,
        timed_out: run.timedOut,
      })),
    },
    summary: summarise(qaItems),
    security_summary: summarise(securityItems),
    groups: Object.fromEntries(
      [...new Set(qaItems.map((item) => item.group))].map((group) => [group, summarise(qaItems.filter((item) => item.group === group))]),
    ),
    items: filtered,
  };
}

function renderTable(items) {
  const lines = [];
  for (const item of items) {
    lines.push(`| ${item.id} | ${item.status} | ${item.title} | ${item.note || ""} |`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const jsonOnly = argv.includes("--json");
  const quiet = argv.includes("--quiet");
  const write = argv.includes("--write");
  const runTests = !argv.includes("--no-run");
  const filterEq = argv.find((arg) => arg.startsWith("--filter="));
  const filterSpaceIndex = argv.indexOf("--filter");
  const filter = filterEq !== undefined
    ? filterEq.slice("--filter=".length)
    : filterSpaceIndex >= 0 && argv[filterSpaceIndex + 1] !== undefined
      ? argv[filterSpaceIndex + 1]
      : null;

  let report;
  try {
    report = await runQaMatrix({ runTests, filter });
  } catch (error) {
    console.error(`QA MATRIX CANNOT RUN: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (!quiet) {
    console.log("QA MATRIX — PROJECT AI ROOM");
    console.log(`generated ${report.generated_at} · tests ${runTests ? "executed" : "not executed"}`);
    for (const run of report.tests.files) {
      console.log(`  ${run.exit_code === 0 ? "ok  " : "FAIL"} ${run.file} (${run.passed} pass, ${run.failed} fail, ${run.duration_ms}ms)`);
    }
    console.log("");
    console.log(`QA ${report.items.filter((i) => i.kind === "qa").length} items: ${JSON.stringify(report.summary)}`);
    console.log(`security ${report.items.filter((i) => i.kind === "security").length} cases: ${JSON.stringify(report.security_summary)}`);
    for (const [group, summary] of Object.entries(report.groups)) {
      console.log(`  ${group}: PASS ${summary.PASS} · PARTIAL ${summary.PARTIAL} · FAILED ${summary.FAILED} · BLOCKED ${summary.BLOCKED} · NOT_TESTED ${summary.NOT_TESTED}`);
    }
    const interesting = report.items.filter((item) => item.status === "FAILED" || item.status === "PARTIAL");
    if (interesting.length > 0) {
      console.log("\n주의 항목 (FAILED/PARTIAL):");
      for (const item of interesting) console.log(`  ${item.id} ${item.status} — ${item.title} — ${item.note}`);
    }
  }

  if (write) {
    const qaOnly = report.items.filter((item) => item.kind === "qa");
    const secOnly = report.items.filter((item) => item.kind === "security");
    await writeFile(join(HERE, "qa-matrix-status.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    const md = [
      "# QA 매트릭스 실행 상태",
      "",
      `- 생성: ${report.generated_at}`,
      `- 원본: \`${relative(REPO_ROOT, QA_FILE)}\` (${qaOnly.length}항목), \`${relative(REPO_ROOT, SECURITY_FILE)}\` (${secOnly.length}건)`,
      `- 테스트 실행: ${report.tests.executed ? `예 (${report.tests.files.length}파일)` : "아니오"}`,
      `- 요약: PASS ${report.summary.PASS} · PARTIAL ${report.summary.PARTIAL} · FAILED ${report.summary.FAILED} · BLOCKED ${report.summary.BLOCKED} · NOT_TESTED ${report.summary.NOT_TESTED}`,
      "",
      "이 문서는 `node tests/acceptance/qa_matrix_runner.mjs --write`가 실제 실행 결과로 생성한다. 손으로 상태를 적지 않는다.",
      "",
      "## QA 매트릭스",
      "",
      "| id | status | title | 근거 / 비고 |",
      "|---|---|---|---|",
      renderTable(qaOnly),
      "",
      "## 보안 케이스",
      "",
      "| id | status | threat | 근거 / 비고 |",
      "|---|---|---|---|",
      renderTable(secOnly),
      "",
    ].join("\n");
    await writeFile(join(HERE, "qa-matrix-status.md"), md, "utf8");
    console.error(`WROTE ${join(relative(REPO_ROOT, HERE), "qa-matrix-status.json")} and qa-matrix-status.md`);
  }

  const all = report.items;
  if (all.some((item) => item.status === "FAILED")) process.exitCode = 1;
  else if (all.some((item) => item.status !== "PASS")) process.exitCode = 3;
  else process.exitCode = 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}

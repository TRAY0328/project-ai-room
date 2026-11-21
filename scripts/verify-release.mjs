#!/usr/bin/env node
/**
 * Release gate verifier — spec 25 (Q041 gates G-01..G-12) and spec 26.3.
 *
 * Every gate is decided by something this script can look at: executed tests,
 * generated artifacts, the provider gate's own output, the OpenAPI document, and
 * (for runtime evidence such as a real CI run or an installed APK) a reviewed
 * evidence ledger whose referenced files must exist. A gate is never marked PASS
 * because someone wrote PASS somewhere.
 *
 * Usage
 *   node scripts/verify-release.mjs             # table + writes the two status files
 *   node scripts/verify-release.mjs --json      # machine readable
 *   node scripts/verify-release.mjs --no-tests  # skip the test suite (structural only)
 *
 * Exit codes: 0 COMPLETE · 1 NOT_RELEASE_READY / INCOMPLETE / BLOCKED_EXTERNAL_DEPENDENCY · 2 cannot evaluate
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
const QA_RUNNER = join(REPO_ROOT, "tests/acceptance/qa_matrix_runner.mjs");
const LEDGER_PATH = process.env.AI_ROOM_RELEASE_EVIDENCE ?? join(REPO_ROOT, "docs/evidence/release-evidence.json");

/** Documents G-12 requires; each must exist and carry real content. */
const REQUIRED_DOCS = [
  "docs/api/openapi.json",
  "docs/api/README.md",
  "docs/operator-guide/RUNBOOK.md",
  "docs/operator-guide/BACKUP_RESTORE.md",
  "docs/operator-guide/DEPLOYMENT.md",
  "docs/user-guide/OWNER_GUIDE.md",
  "docs/user-guide/AI_BROWSER_PORTAL_GUIDE.md",
  "docs/security/SECURITY_CONTROLS.md",
  "docs/security/THREAT_MODEL.md",
  "scripts/gen-openapi.mjs",
  "scripts/verify-release.mjs",
  "tests/acceptance/qa_matrix_runner.mjs",
  "tests/acceptance/qa_evidence_map.json",
];

const GATE_TITLES = {
  "G-01": "Q001–Q041 추적표 전 항목 구현 및 테스트",
  "G-02": "지정 모든 실제 AI의 공식 연결·자율성·코드 능력",
  "G-03": "다중 실제 AI의 상호 작업 종단간 시연",
  "G-04": "GitHub PR, Actions 빌드/테스트, 검증 병합",
  "G-05": "웹 앱 실제 로그인·대화·프로젝트·IDE",
  "G-06": "Windows EXE 및 설치 파일 생성·설치·실행",
  "G-07": "Android APK 생성·서명 상태·실기기 설치",
  "G-08": "보안(인증·ACL·CI·파일·비밀·인젝션)",
  "G-09": "장애·재접속·인계·중복 방지",
  "G-10": "메시지·기억·파일·코드·백업 무결성",
  "G-11": "무료 운영·사용량·자동 과금 방지",
  "G-12": "운영 문서·테스트·결과물·보고서",
};

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// ---------------------------------------------------------------------------
// Pure aggregation (unit-tested in tests/acceptance/release_gates.test.mjs)
// ---------------------------------------------------------------------------
/** A gate passes only if every check underneath it passed. */
export function gateStatusFromChecks(checks) {
  if (checks.length === 0) return "NOT_TESTED";
  const statuses = checks.map((check) => check.status);
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("PARTIAL")) return "PARTIAL";
  if (statuses.includes("NOT_TESTED")) return "NOT_TESTED";
  return "PASS";
}

/**
 * Spec 25: one gate that is FAILED, BLOCKED or NOT_TESTED keeps the release at
 * NOT_RELEASE_READY. When the only thing in the way is an unreachable external
 * dependency the status is BLOCKED_EXTERNAL_DEPENDENCY; when work is simply not
 * finished it is INCOMPLETE.
 */
export function releaseStatusFromGates(gates) {
  const statuses = gates.map((gate) => gate.status);
  if (statuses.every((status) => status === "PASS")) return "COMPLETE";
  if (statuses.includes("FAILED")) return "NOT_RELEASE_READY";
  const remaining = statuses.filter((status) => status !== "PASS");
  if (remaining.every((status) => status === "BLOCKED")) return "BLOCKED_EXTERNAL_DEPENDENCY";
  return "INCOMPLETE";
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------
async function readLedger() {
  if (!existsSync(LEDGER_PATH)) return null;
  try {
    return JSON.parse(await readFile(LEDGER_PATH, "utf8"));
  } catch (error) {
    return { __parse_error: error.message };
  }
}

/**
 * A ledger entry only counts when it names evidence that exists. A ledger that
 * points at a missing file is a failed gate, not a pass with a nicer story.
 */
function ledgerCheck(ledger, gateId) {
  if (ledger === null) {
    return { name: `ledger:${gateId}`, status: "NOT_TESTED", detail: `증거 원장 없음: ${relative(REPO_ROOT, LEDGER_PATH)} (형식은 docs/operator-guide/RUNBOOK.md §8)` };
  }
  if (ledger.__parse_error !== undefined) {
    return { name: `ledger:${gateId}`, status: "FAILED", detail: `증거 원장 JSON 파손: ${ledger.__parse_error}` };
  }
  const entry = ledger.gates?.[gateId];
  if (entry === undefined) {
    return { name: `ledger:${gateId}`, status: "NOT_TESTED", detail: "이 게이트의 증거 기록 없음" };
  }
  const allowed = ["PASS", "FAILED", "BLOCKED", "NOT_TESTED", "PARTIAL"];
  if (!allowed.includes(entry.status)) {
    return { name: `ledger:${gateId}`, status: "FAILED", detail: `알 수 없는 상태: ${JSON.stringify(entry.status)}` };
  }
  const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
  if (entry.status === "PASS" && (evidence.length === 0 || typeof entry.verified_by !== "string")) {
    return { name: `ledger:${gateId}`, status: "FAILED", detail: "PASS 기록에 증거·검증자 없음(원장 신뢰 거부)" };
  }
  const missing = [];
  for (const ref of evidence) {
    if (typeof ref !== "string") { missing.push(String(ref)); continue; }
    if (/^(https?:|github:)/.test(ref) || /^(ci|pr|commit|run):/.test(ref)) continue;
    if (!existsSync(join(REPO_ROOT, ref))) missing.push(ref);
  }
  if (missing.length > 0) return { name: `ledger:${gateId}`, status: "FAILED", detail: `원장 증거 파일 없음: ${missing.slice(0, 4).join(", ")}` };
  return { name: `ledger:${gateId}`, status: entry.status, detail: `${evidence.length}개 증거 · ${entry.verified_by ?? "검증자 미기록"}${entry.note ? ` · ${entry.note}` : ""}` };
}

function findArtifacts(root, dir, extensions) {
  const out = [];
  const walk = (current) => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (extensions.some((ext) => name.toLowerCase().endsWith(ext))) out.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(join(root, dir));
  return out;
}

function qaItemsFor(qa, ids) {
  return ids.map((id) => qa.items.find((item) => item.id === id)).filter((item) => item !== undefined);
}

/** Aggregate a group of QA items the way a gate reads them. */
function aggregateQa(items, label) {
  if (items.length === 0) return { name: label, status: "NOT_TESTED", detail: `${label}: 연결된 QA 항목 없음` };
  const statuses = items.map((item) => item.status);
  const status = gateStatusFromChecks([{ status: statuses.includes("FAILED") ? "FAILED" : statuses.includes("BLOCKED") ? "BLOCKED" : statuses.includes("PARTIAL") ? "PARTIAL" : statuses.includes("NOT_TESTED") ? "NOT_TESTED" : "PASS" }]);
  const counts = {};
  for (const item of statuses) counts[item] = (counts[item] ?? 0) + 1;
  return { name: label, status, detail: `${label}: ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(", ")} (${items.length}항목)` };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
export async function evaluateRelease(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const runTests = options.runTests !== false;
  const ledger = await readLedger();

  // The QA matrix is the single source for G-01 and the gate subsets below.
  let qa = null;
  let qaError = "";
  try {
    const mod = await import(pathToFileURL(QA_RUNNER).href);
    qa = await mod.runQaMatrix({ runTests });
  } catch (error) {
    qaError = error.message;
  }

  const gates = [];
  const addGate = (id, checks) => {
    gates.push({ id, title: GATE_TITLES[id], status: gateStatusFromChecks(checks), checks });
  };

  // G-01 — every QA item, decided by the runner.
  if (qa === null) {
    addGate("G-01", [{ name: "qa-matrix", status: "FAILED", detail: `QA 러너 실행 실패: ${qaError}` }]);
  } else {
    addGate("G-01", [aggregateQa(qa.items.filter((item) => item.kind === "qa"), "QA 103항목")]);
  }

  // G-02 — the provider roster's own gate plus the required roster file.
  {
    const checks = [];
    const providerCheck = qa?.checks?.["provider-gate"];
    checks.push({ name: "provider-gate", status: providerCheck?.status ?? "NOT_TESTED", detail: providerCheck?.detail ?? "provider gate 결과 없음" });
    const rosterPath = join(root, "docs/evidence/required_agents.json");
    const vendoredRoster = join(root, "spec/required_agents.example.json");
    const examplePath = existsSync(vendoredRoster) ? vendoredRoster : join(root, "../work/ai_room_pack/PROJECT_AI_ROOM/required_agents.example.json");
    const roster = existsSync(rosterPath) ? rosterPath : existsSync(examplePath) ? examplePath : null;
    if (roster === null) {
      checks.push({ name: "required-roster", status: "NOT_TESTED", detail: "required_agents 정의 없음" });
    } else {
      const entries = JSON.parse(await readFile(roster, "utf8"));
      const required = (Array.isArray(entries) ? entries : entries.agents ?? []).filter((entry) => entry.required !== false);
      checks.push({ name: "required-roster", status: required.length > 0 ? "PASS" : "FAILED", detail: `${relative(root, roster)}: 필수 ${required.length}종` });
    }
    addGate("G-02", checks);
  }

  // G-03, G-04 — real multi-AI and real GitHub runs can only come from a ledger.
  addGate("G-03", [ledgerCheck(ledger, "G-03")]);
  addGate("G-04", [ledgerCheck(ledger, "G-04")]);

  // G-05 — a web build must exist on disk; the login walkthrough comes from the ledger.
  {
    const dist = join(root, "apps/web/dist");
    const files = existsSync(dist) ? readdirSync(dist) : [];
    const checks = [
      files.length === 0
        ? { name: "web-build", status: "NOT_TESTED", detail: "apps/web/dist 없음(웹 빌드 미실행)" }
        : { name: "web-build", status: files.includes("index.html") ? "PASS" : "FAILED", detail: `apps/web/dist 파일 ${files.length}개` },
      ledgerCheck(ledger, "G-05"),
    ];
    addGate("G-05", checks);
  }

  // G-06 / G-07 — the installer and the APK must exist, and the ledger must carry their hash.
  {
    const exe = findArtifacts(root, "apps/desktop", [".exe", ".msi"]);
    addGate("G-06", [
      exe.length === 0
        ? { name: "windows-artifact", status: "NOT_TESTED", detail: "apps/desktop 아래 .exe/.msi 없음" }
        : { name: "windows-artifact", status: "PASS", detail: exe.join(", ") },
      ledgerCheck(ledger, "G-06"),
    ]);
    const apk = findArtifacts(root, "apps/android", [".apk", ".aab"]);
    addGate("G-07", [
      apk.length === 0
        ? { name: "android-artifact", status: "NOT_TESTED", detail: "apps/android 아래 .apk/.aab 없음" }
        : { name: "android-artifact", status: "PASS", detail: apk.join(", ") },
      ledgerCheck(ledger, "G-07"),
    ]);
  }

  // G-08 — critical/high security cases decide the gate.
  if (qa === null) {
    addGate("G-08", [{ name: "security-cases", status: "FAILED", detail: "보안 케이스 평가 불가" }]);
  } else {
    const security = qa.items.filter((item) => item.kind === "security");
    const critical = security.filter((item) => (SEVERITY_RANK[item.severity] ?? 9) <= SEVERITY_RANK.high);
    const failed = critical.filter((item) => item.status === "FAILED");
    const passed = critical.filter((item) => item.status === "PASS");
    const status = critical.length === 0 ? "NOT_TESTED" : failed.length > 0 ? "FAILED" : passed.length === critical.length ? "PASS" : critical.some((item) => item.status === "BLOCKED") ? "BLOCKED" : "PARTIAL";
    addGate("G-08", [{
      name: "security-cases",
      status,
      detail: `Critical/High ${critical.length}건 중 PASS ${passed.length} · FAILED ${failed.length} · 전체 50건 ${JSON.stringify({
        PASS: security.filter((i) => i.status === "PASS").length,
        PARTIAL: security.filter((i) => i.status === "PARTIAL").length,
        FAILED: security.filter((i) => i.status === "FAILED").length,
        BLOCKED: security.filter((i) => i.status === "BLOCKED").length,
        NOT_TESTED: security.filter((i) => i.status === "NOT_TESTED").length,
      })}`,
    }]);
  }

  // G-09 — failure, reconnect, handoff, duplicate suppression.
  addGate("G-09", qa === null
    ? [{ name: "qa-subset", status: "FAILED", detail: "평가 불가" }]
    : [aggregateQa(qaItemsFor(qa, ["QA-027", "QA-028", "QA-058", "QA-059", "QA-060", "QA-061", "QA-063", "QA-077", "QA-078"]), "장애·복구 항목")]);

  // G-10 — data integrity, including the remote-D1 question (B-05).
  {
    const checks = [];
    checks.push(qa === null
      ? { name: "qa-subset", status: "FAILED", detail: "평가 불가" }
      : aggregateQa(qaItemsFor(qa, ["QA-019", "QA-020", "QA-024", "QA-025", "QA-032", "QA-037", "QA-041", "QA-047", "QA-048", "QA-049", "QA-050"]), "무결성 항목"));
    const dbTests = qa?.tests?.files?.filter((run) => run.file.startsWith("tests/integration/")) ?? [];
    checks.push(dbTests.length === 0
      ? { name: "db-integrity-suite", status: "NOT_TESTED", detail: "통합 DB 테스트 미실행" }
      : { name: "db-integrity-suite", status: dbTests.every((run) => run.failed === 0 && run.exit_code === 0) ? "PASS" : "FAILED", detail: dbTests.map((run) => `${run.file}: ${run.passed} pass/${run.failed} fail`).join(", ") });
    checks.push(ledgerCheck(ledger, "G-10"));
    addGate("G-10", checks);
  }

  // G-11 — free operation and no possible automatic charge.
  {
    const checks = [];
    checks.push(qa === null
      ? { name: "qa-subset", status: "FAILED", detail: "평가 불가" }
      : aggregateQa(qaItemsFor(qa, ["QA-013", "QA-064", "QA-083", "QA-098"]), "사용량·과금 항목"));
    checks.push(ledgerCheck(ledger, "G-11"));
    addGate("G-11", checks);
  }

  // G-12 — documentation, tests, artifacts, report.
  {
    const checks = [];
    const missing = REQUIRED_DOCS.filter((file) => {
      const full = join(root, file);
      if (!existsSync(full)) return true;
      return statSync(full).size < 200;
    });
    checks.push(missing.length === 0
      ? { name: "required-docs", status: "PASS", detail: `${REQUIRED_DOCS.length}개 문서 존재(200바이트 이상)` }
      : { name: "required-docs", status: "FAILED", detail: `없거나 빈 파일: ${missing.join(", ")}` });
    const labels = qa?.checks?.["release-report-labels"];
    checks.push({ name: "release-report", status: labels?.status ?? "NOT_TESTED", detail: labels?.detail ?? "보고서 라벨 검사 없음" });
    const openapi = qa?.checks?.["openapi-sync"];
    checks.push({ name: "openapi-sync", status: openapi?.status ?? "NOT_TESTED", detail: openapi?.detail ?? "OpenAPI 동기화 검사 없음" });
    const testFiles = qa?.tests?.files ?? [];
    checks.push(testFiles.length === 0
      ? { name: "test-suite", status: "NOT_TESTED", detail: "테스트 미실행(--no-tests)" }
      : { name: "test-suite", status: testFiles.some((run) => run.failed > 0 || run.exit_code !== 0) ? "FAILED" : "PASS", detail: `${testFiles.length}파일 · ${testFiles.reduce((n, run) => n + run.passed, 0)} pass` });
    const webArtifacts = findArtifacts(root, "apps/web/dist", [".js", ".html"]);
    const windowsArtifacts = findArtifacts(root, "apps/desktop", [".exe", ".msi"]);
    const androidArtifacts = findArtifacts(root, "apps/android", [".apk"]);
    const missingGroups = [
      webArtifacts.length === 0 ? "웹" : null,
      windowsArtifacts.length === 0 ? "Windows EXE" : null,
      androidArtifacts.length === 0 ? "Android APK" : null,
    ].filter(Boolean);
    checks.push({
      name: "release-artifacts",
      status: missingGroups.length === 0 ? "PASS" : missingGroups.length === 3 ? "NOT_TESTED" : "PARTIAL",
      detail: missingGroups.length === 0
        ? `웹 ${webArtifacts.length} · EXE ${windowsArtifacts.length} · APK ${androidArtifacts.length}`
        : `누락: ${missingGroups.join(", ")} (보고서 26.2 미충족)`,
    });
    addGate("G-12", checks);
  }

  const releaseStatus = releaseStatusFromGates(gates);
  return {
    schema_version: 1,
    evaluated_at: new Date().toISOString(),
    release_status: releaseStatus,
    ledger: ledger === null ? null : relative(root, LEDGER_PATH),
    qa_summary: qa?.summary ?? null,
    tests: qa?.tests ?? { executed: false, files: [] },
    gates,
    blockers: gates.filter((gate) => gate.status !== "PASS").map((gate) => ({
      id: gate.id, status: gate.status, reasons: gate.checks.filter((check) => check.status !== "PASS").map((check) => `${check.name}: ${check.detail}`),
    })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function renderMarkdown(report) {
  const lines = [
    "# 릴리스 게이트 검증 결과 (자동 생성)",
    "",
    `- 실행: ${report.evaluated_at}`,
    `- 판정: **${report.release_status}**`,
    `- 증거 원장: ${report.ledger ?? "없음"}`,
    "",
    "| Gate | 상태 | 내용 | 근거 |",
    "|---|---|---|---|",
  ];
  for (const gate of report.gates) {
    const detail = gate.checks.map((check) => `${check.name}=${check.status} (${check.detail})`).join("; ");
    lines.push(`| ${gate.id} | ${gate.status} | ${gate.title} | ${detail.replace(/\|/g, "/")} |`);
  }
  if (report.blockers.length > 0) {
    lines.push("", "## 차단 사유", "");
    for (const blocker of report.blockers) {
      lines.push(`- **${blocker.id} ${blocker.status}**`);
      for (const reason of blocker.reasons) lines.push(`  - ${reason}`);
    }
  }
  lines.push("", "이 파일은 `node scripts/verify-release.mjs`가 실제 검사 결과로 생성한다. 손으로 고치지 않는다.", "");
  return lines.join("\n");
}

async function main(argv) {
  const jsonOnly = argv.includes("--json");
  const runTests = !argv.includes("--no-tests");

  let report;
  try {
    report = await evaluateRelease({ runTests });
  } catch (error) {
    console.error(`RELEASE VERIFICATION CANNOT RUN: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const outJson = join(REPO_ROOT, "tests/acceptance/release-verification.json");
  const outMd = join(REPO_ROOT, "tests/acceptance/release-verification.md");
  await writeFile(outJson, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(outMd, renderMarkdown(report), "utf8");

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log("PROJECT AI ROOM — RELEASE GATES (G-01..G-12)");
    console.log(`evaluated ${report.evaluated_at} · tests ${report.tests.executed ? "executed" : "not executed"}`);
    for (const gate of report.gates) {
      console.log(`${gate.status.padEnd(10)} ${gate.id}  ${gate.title}`);
      for (const check of gate.checks) console.log(`           - ${check.name}: ${check.status} — ${check.detail}`);
    }
    console.log("");
    console.log(`RELEASE STATUS: ${report.release_status}`);
    if (report.qa_summary !== null) {
      console.log(`QA: PASS ${report.qa_summary.PASS} · PARTIAL ${report.qa_summary.PARTIAL} · FAILED ${report.qa_summary.FAILED} · BLOCKED ${report.qa_summary.BLOCKED} · NOT_TESTED ${report.qa_summary.NOT_TESTED}`);
    }
    console.log(`WROTE ${relative(REPO_ROOT, outJson)} and ${relative(REPO_ROOT, outMd)}`);
  }

  process.exitCode = report.release_status === "COMPLETE" ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}

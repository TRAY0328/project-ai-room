/**
 * Acceptance tests — Q041 release gate aggregation (spec 25).
 *
 * The point of QA-102 is that a single failing gate must stop a "release ready"
 * claim. These tests exercise that rule directly on the aggregator the release
 * script uses, including the external-dependency and incomplete cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gateStatusFromChecks, releaseStatusFromGates } from "../../scripts/verify-release.mjs";

const PASS = { status: "PASS", detail: "" };
const FAILED = { status: "FAILED", detail: "boom" };
const BLOCKED = { status: "BLOCKED", detail: "external" };
const NOT_TESTED = { status: "NOT_TESTED", detail: "not run" };
const PARTIAL = { status: "PARTIAL", detail: "layer" };

test("QA-102 Q041 게이트: 하나라도 FAILED/BLOCKED/NOT_TESTED면 RELEASE_READY가 아니다", () => {
  const allPass = Array.from({ length: 12 }, (_, index) => ({ id: `G-${String(index + 1).padStart(2, "0")}`, status: "PASS" }));
  assert.equal(releaseStatusFromGates(allPass), "COMPLETE");

  for (const bad of ["FAILED", "BLOCKED", "NOT_TESTED", "PARTIAL"]) {
    const gates = allPass.map((gate, index) => (index === 6 ? { ...gate, status: bad } : gate));
    const status = releaseStatusFromGates(gates);
    assert.notEqual(status, "COMPLETE", `${bad} 게이트 하나로 COMPLETE가 나오면 안 된다`);
    if (bad === "FAILED") assert.equal(status, "NOT_RELEASE_READY");
    if (bad === "BLOCKED") assert.equal(status, "BLOCKED_EXTERNAL_DEPENDENCY");
    if (bad === "NOT_TESTED" || bad === "PARTIAL") assert.equal(status, "INCOMPLETE");
  }

  // A single hard failure outranks a pile of external blockers.
  const mixed = allPass.map((gate, index) =>
    index === 0 ? { ...gate, status: "BLOCKED" } : index === 1 ? { ...gate, status: "FAILED" } : gate);
  assert.equal(releaseStatusFromGates(mixed), "NOT_RELEASE_READY");
});

test("게이트 집계: 아래 검사 중 하나라도 실패하면 게이트는 PASS가 아니다", () => {
  assert.equal(gateStatusFromChecks([PASS, PASS]), "PASS");
  assert.equal(gateStatusFromChecks([PASS, FAILED]), "FAILED");
  assert.equal(gateStatusFromChecks([PASS, BLOCKED]), "BLOCKED");
  assert.equal(gateStatusFromChecks([PASS, PARTIAL]), "PARTIAL");
  assert.equal(gateStatusFromChecks([PASS, NOT_TESTED]), "NOT_TESTED");
  assert.equal(gateStatusFromChecks([BLOCKED, NOT_TESTED]), "BLOCKED");
  assert.equal(gateStatusFromChecks([FAILED, BLOCKED]), "FAILED");
  assert.equal(gateStatusFromChecks([]), "NOT_TESTED", "검사가 없으면 통과가 아니라 미검증");
});

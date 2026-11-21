#!/usr/bin/env node
/**
 * 워크플로 정적 검사 — security.yml의 한 단계로 실행된다.
 *
 * 검사 항목(모두 실패 시 CI를 실패시킨다):
 *  1) 필수 워크플로 5종이 존재한다.
 *  2) `pull_request_target`을 쓰지 않는다(외부 PR 코드 + 시크릿 조합 금지).
 *  3) 모든 `uses:`는 40자 커밋 SHA로 고정한다(공급망 위험).
 *  4) 모든 워크플로에 `permissions:`가 있고 쓰기 권한을 주지 않는다.
 *  5) 모든 job에 `timeout-minutes`가 있다(무한 실행·비용 방지).
 *  6) `run:` 안에서 시크릿을 직접 echo하지 않는다.
 *
 * 로컬에서도 같은 스크립트를 돌릴 수 있다: node .github/workflows/_policy_check.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_DIR = dirname(fileURLToPath(import.meta.url));
const REQUIRED = ["verify.yml", "build-web.yml", "build-windows.yml", "build-android.yml", "security.yml"];

/** 쓰기 권한이 정당한 예외(현재는 사용하지 않는다). 비어 있으면 모든 write가 실패다. */
const ALLOWED_WRITE = new Set([]);

const errors = [];
const notes = [];

const present = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name)).sort();
for (const name of REQUIRED) {
  if (!present.includes(name)) errors.push(`누락된 워크플로: ${name}`);
}
for (const name of present) {
  if (!REQUIRED.includes(name)) notes.push(`추가 워크플로(검사는 동일 적용): ${name}`);
}

for (const name of present) {
  const text = readFileSync(join(WORKFLOW_DIR, name), "utf8");
  const lines = text.split("\n");

  if (/^\s*pull_request_target\s*:/m.test(text)) {
    errors.push(`${name}: pull_request_target 사용 금지(외부 PR 코드와 시크릿 격리)`);
  }

  // 3) uses pinning
  const usesRe = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)['"]?/gm;
  let match;
  while ((match = usesRe.exec(text)) !== null) {
    const target = match[1];
    if (target.startsWith("./")) continue;
    if (!/^[^@\s]+@[0-9a-f]{40}$/.test(target)) {
      errors.push(`${name}: uses가 40자 SHA로 고정되지 않음 -> ${target}`);
    }
  }

  // 4) permissions
  if (!/^permissions\s*:/m.test(text)) {
    errors.push(`${name}: permissions 블록이 없다`);
  }
  const permRe = /^\s+([a-z-]+):\s*(read|write|none)\s*$/gm;
  let perm;
  while ((perm = permRe.exec(text)) !== null) {
    if (perm[2] === "write" && !ALLOWED_WRITE.has(`${name}:${perm[1]}`)) {
      errors.push(`${name}: 쓰기 권한 '${perm[1]}: write'는 허용 목록에 없다`);
    }
  }

  // 5) timeouts vs jobs
  const jobCount = (text.match(/^\s{2}[A-Za-z0-9_-]+:\s*$/gm) ?? []).length;
  const runsOnCount = (text.match(/^\s+runs-on:/gm) ?? []).length;
  const timeoutCount = (text.match(/^\s+timeout-minutes:/gm) ?? []).length;
  if (runsOnCount === 0) errors.push(`${name}: runs-on이 없다`);
  if (timeoutCount < runsOnCount) {
    errors.push(`${name}: job ${runsOnCount}개 중 timeout-minutes는 ${timeoutCount}개뿐이다`);
  }
  if (jobCount === 0) notes.push(`${name}: job 카운트를 읽지 못함(참고)`);

  // 6) secrets in shell
  for (const line of lines) {
    if (line.trimStart().startsWith("#")) continue;
    if (/\$\{\{\s*secrets\./.test(line) && /\becho\b/i.test(line)) {
      errors.push(`${name}: run에서 시크릿을 echo하는 줄이 있다 -> ${line.trim()}`);
    }
  }

  // 7) 무음 통과 금지
  if (/continue-on-error:\s*true/.test(text)) {
    errors.push(`${name}: continue-on-error: true는 필수 검증을 조용히 통과시킨다`);
  }
  if (/--if-present/.test(text)) {
    errors.push(`${name}: --if-present는 없는 테스트를 통과로 만든다`);
  }
}

for (const note of notes) console.log(`note: ${note}`);

if (errors.length > 0) {
  console.error(`워크플로 정적 검사 실패 ${errors.length}건:`);
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

console.log(`워크플로 정적 검사 통과: ${present.length}개 파일 (${present.join(", ")})`);

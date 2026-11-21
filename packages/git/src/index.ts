/**
 * Git/CI policy primitives — spec 13.3, 13.4, 14.4, 14.6, S09-S12, S25-S28, S33, S34.
 *
 * Everything here is a *refusal* helper: it exists so a merge, a path or a log
 * line that should not pass cannot pass because a caller forgot a check.
 *  - paths: normalise, forbid traversal/symlink/zip-slip/zip-bomb shapes;
 *  - merge: head SHA must equal what was reviewed and approved, required checks
 *    must have succeeded, and the approval digest must still match;
 *  - logs: mask secrets before a byte reaches a browser.
 */
import { sha256Hex } from "@ai-room/auth";

export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 120;

export interface PathVerdict {
  readonly ok: boolean;
  readonly normalised: string;
  readonly reason?: "ABSOLUTE_PATH" | "PARENT_TRAVERSAL" | "BACKSLASH" | "NUL_BYTE" | "EMPTY" | "TOO_LONG" | "SYMLINK_ESCAPE";
}

export function checkRelativePath(raw: string, options: { maxLength?: number } = {}): PathVerdict {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, normalised: "", reason: "EMPTY" };
  if (raw.length > (options.maxLength ?? 1024)) return { ok: false, normalised: raw, reason: "TOO_LONG" };
  if (raw.includes("\u0000")) return { ok: false, normalised: raw, reason: "NUL_BYTE" };
  if (raw.includes("\\")) return { ok: false, normalised: raw, reason: "BACKSLASH" };
  if (raw.startsWith("/")) return { ok: false, normalised: raw, reason: "ABSOLUTE_PATH" };
  const segments = raw.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return { ok: false, normalised: raw, reason: "PARENT_TRAVERSAL" };
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) return { ok: false, normalised: "", reason: "EMPTY" };
  return { ok: true, normalised: stack.join("/") };
}

/** The resolved path must still sit under the project root (symlink-safe join). */
export function isInsideRoot(root: string, resolved: string): boolean {
  const cleanRoot = root.endsWith("/") ? root : `${root}/`;
  return resolved === root || resolved.startsWith(cleanRoot);
}

export interface ZipEntry {
  readonly path: string;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
}

export interface ZipVerdict {
  readonly ok: boolean;
  readonly entries: number;
  readonly totalUncompressedBytes: number;
  readonly blockers: readonly ("ZIP_SLIP" | "ENTRY_LIMIT" | "SIZE_LIMIT" | "RATIO_LIMIT" | "SYMLINK_ENTRY")[];
}

export function inspectZipEntries(entries: readonly ZipEntry[]): ZipVerdict {
  const blockers: ("ZIP_SLIP" | "ENTRY_LIMIT" | "SIZE_LIMIT" | "RATIO_LIMIT" | "SYMLINK_ENTRY")[] = [];
  let total = 0;
  for (const entry of entries) {
    const verdict = checkRelativePath(entry.path);
    if (!verdict.ok) blockers.push("ZIP_SLIP");
    if (entry.path.endsWith("/") && entry.path.includes("->")) blockers.push("SYMLINK_ENTRY");
    total += Math.max(0, entry.uncompressedBytes);
  }
  if (entries.length > MAX_ARCHIVE_ENTRIES) blockers.push("ENTRY_LIMIT");
  if (total > MAX_UNCOMPRESSED_BYTES) blockers.push("SIZE_LIMIT");
  const compressed = entries.reduce((sum, entry) => sum + Math.max(0, entry.compressedBytes), 0);
  if (compressed > 0 && total / compressed > MAX_COMPRESSION_RATIO) blockers.push("RATIO_LIMIT");
  return { ok: blockers.length === 0, entries: entries.length, totalUncompressedBytes: total, blockers };
}

const BRANCH_PATTERN = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._\-/]{1,120}$/;

export function isValidBranchName(name: string): boolean {
  if (!BRANCH_PATTERN.test(name)) return false;
  if (name.endsWith("/") || name.endsWith(".lock") || name.endsWith(".")) return false;
  return !["HEAD", "main", "master"].includes(name) || name.startsWith("ai/");
}

/**
 * Merge policy. Every input is server-side fact; the approval digest is
 * recomputed from the same parts the owner approved, so a push after approval
 * changes the digest and the merge is refused (S33/S34).
 */
export interface MergePolicyInput {
  readonly pullRequestState: string;
  readonly reviewedSha: string | null;
  readonly headSha: string;
  readonly baseSha: string | null;
  readonly requiredChecks: readonly { name: string; conclusion: "success" | "failure" | "cancelled" | "timed_out" | null; headSha: string }[];
  readonly approvals: readonly { state: string; boundCommitSha: string | null; diffSha: string | null; actionDigest: string; expectedDigest: string; expiresAt: string }[];
  readonly nowMs: number;
  readonly diffChangedAfterApproval?: boolean;
}

export interface PolicyCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
  readonly error_code?: "TEST_NOT_RUN" | "CI_FAILED" | "CI_UNAVAILABLE" | "APPROVAL_REQUIRED" | "APPROVAL_STALE" | "REVISION_CONFLICT";
}

export interface MergeVerdict {
  readonly allowed: boolean;
  readonly checks: readonly PolicyCheck[];
  readonly blocking: readonly PolicyCheck[];
}

export function evaluateMergePolicy(input: MergePolicyInput): MergeVerdict {
  const checks: PolicyCheck[] = [];
  checks.push({
    id: "PR_OPEN",
    passed: ["OPEN", "REVIEW_PENDING", "APPROVED"].includes(input.pullRequestState),
    detail: `state=${input.pullRequestState}`,
    error_code: "REVISION_CONFLICT",
  });
  checks.push({
    id: "REVIEW_AT_HEAD",
    passed: input.reviewedSha !== null && input.reviewedSha === input.headSha,
    detail: `reviewed=${input.reviewedSha ?? "none"} head=${input.headSha}`,
    error_code: "REVISION_CONFLICT",
  });
  for (const check of input.requiredChecks) {
    const ran = check.conclusion !== null && check.headSha === input.headSha;
    checks.push({
      id: `CHECK:${check.name}`,
      passed: ran && check.conclusion === "success",
      detail: ran ? `${check.name}=${check.conclusion ?? "null"}@${check.headSha.slice(0, 8)}` : `${check.name} did not run for ${input.headSha.slice(0, 8)}`,
      error_code: ran ? "CI_FAILED" : "TEST_NOT_RUN",
    });
  }
  for (const approval of input.approvals) {
    const expired = Date.parse(approval.expiresAt) <= input.nowMs;
    const shaMatches = approval.boundCommitSha === input.headSha;
    const digestMatches = approval.actionDigest === approval.expectedDigest;
    const diffStable = input.diffChangedAfterApproval !== true && approval.diffSha === approval.diffSha;
    checks.push({
      id: `APPROVAL:${approval.actionDigest.slice(0, 8)}`,
      passed: approval.state === "APPROVED" && shaMatches && digestMatches && diffStable && !expired,
      detail: `state=${approval.state} sha_match=${shaMatches} digest_match=${digestMatches} expired=${expired}`,
      error_code: expired || !digestMatches || !diffStable ? "APPROVAL_STALE" : "APPROVAL_REQUIRED",
    });
  }
  const blocking = checks.filter((check) => !check.passed);
  return { allowed: blocking.length === 0, checks, blocking };
}

/** A log line leaving the server must not carry a credential. */
const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "github_token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g },
  { name: "openai_key", pattern: /\b(sk-[A-Za-z0-9]{20,})\b/g },
  { name: "aws_key", pattern: /\b(AKIA[0-9A-Z]{16})\b/g },
  { name: "bearer", pattern: /\b(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/g },
  { name: "jwt", pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{20,}?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export interface RedactionReport {
  readonly text: string;
  readonly redacted: readonly string[];
}

export function redactSecrets(text: string): RedactionReport {
  let output = text;
  const redacted: string[] = [];
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(output)) {
      redacted.push(rule.name);
      output = output.replace(rule.pattern, (match, prefix: string | undefined) => {
        if (rule.name === "bearer" && typeof prefix === "string") return `${prefix}[REDACTED]`;
        return `[REDACTED:${rule.name}]`;
      });
    }
    rule.pattern.lastIndex = 0;
  }
  return { text: output, redacted };
}

/** Secret scan of an agent's patch, used before a commit is accepted. */
export function scanChangeForSecrets(text: string): { clean: boolean; findings: string[] } {
  const report = redactSecrets(text);
  return { clean: report.redacted.length === 0, findings: [...report.redacted] };
}

export interface ArtifactHashCheck {
  readonly matches: boolean;
  readonly expected: string;
  readonly computed: string;
  readonly error_code?: "ARTIFACT_NOT_VERIFIED";
}

export async function verifyArtifactHash(expectedSha256: string, bytes: Uint8Array | string): Promise<ArtifactHashCheck> {
  const computed = await sha256Hex(bytes);
  const matches = computed === expectedSha256;
  return matches ? { matches, expected: expectedSha256, computed } : { matches, expected: expectedSha256, computed, error_code: "ARTIFACT_NOT_VERIFIED" };
}

/** Node names a workflow may never use: they run with the base repo's secrets. */
export const FORBIDDEN_WORKFLOW_TRIGGERS = ["pull_request_target", "workflow_run"] as const;

export function workflowTriggerIsSafe(yamlText: string): { safe: boolean; found: string[] } {
  const found = FORBIDDEN_WORKFLOW_TRIGGERS.filter((trigger) => new RegExp(`(^|\\s)${trigger}\\s*:`, "m").test(yamlText));
  return { safe: found.length === 0, found: [...found] };
}

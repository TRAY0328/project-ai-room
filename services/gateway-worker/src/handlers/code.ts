/**
 * IDE, Git, CI and artifacts — catalog group "IDE·Git·CI·결과물" (16 of 78).
 *
 * Honesty rules implemented here:
 *  - With no GitHub App installation, every Git/CI action answers
 *    `BLOCKED_EXTERNAL_DEPENDENCY` with the missing binding named. A job row is
 *    created in `BLOCKED_EXTERNAL_DEPENDENCY`, never in `SUCCEEDED`.
 *  - A merge is a policy evaluation, not a button: PR state, review at the exact
 *    head SHA, a successful run for that SHA, and an approval whose digest still
 *    matches. Any mismatch is a 412/409, not a warning.
 *  - Logs are masked before they leave the server.
 */
import { ApiError, canTransitionJob, mintId, reconcileJobCancel, type JobState } from "@ai-room/contracts";
import { allRows, count, firstRow, sha256Hex } from "@ai-room/auth";
import { evaluateMergePolicy, isValidBranchName, redactSecrets, verifyArtifactHash } from "@ai-room/git";
import { signDownloadGrant } from "@ai-room/auth";
import type { Handler } from "../domain.js";
import { blocked, getProject, isEmergencyStopped, notFoundOrHidden, optionalString, recordProjectEvent } from "../domain.js";

interface RepoRow {
  readonly repo_id: string;
  readonly project_id: string;
  readonly repo_full_name: string;
  readonly default_branch: string;
  readonly github_installation_id: string;
}

async function getRepo(ctx: Parameters<Handler>[0], projectId: string): Promise<RepoRow> {
  const repo = await firstRow<RepoRow>(ctx.db, "SELECT * FROM git_repositories WHERE project_id = ? AND enabled = 1", projectId);
  if (repo === null) {
    throw blocked(ctx.requestId, "GITHUB_REPOSITORY_NOT_CONNECTED", {
      detail: "이 프로젝트에 연결된 GitHub 저장소가 없습니다. GitHub App 설치와 저장소 연결이 먼저 필요합니다.",
    });
  }
  return repo;
}

function github(ctx: Parameters<Handler>[0]) {
  if (ctx.env.GITHUB === undefined) {
    throw blocked(ctx.requestId, "GITHUB_APP_NOT_CONFIGURED", {
      detail: "GitHub App 설치/토큰이 이 환경에 구성되지 않았습니다.",
    });
  }
  return ctx.env.GITHUB;
}

function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (owner === undefined || repo === undefined) throw new Error("invalid repo full name");
  return { owner, repo };
}

export const codeHandlers: Record<string, Handler> = {
  "get-projects-by-projectId-ide-tree": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const documents = await allRows<{ document_id: string; path: string; language: string; revision: number; updated_at: string }>(
      ctx.db,
      "SELECT document_id, path, language, revision, updated_at FROM documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY path ASC",
      project.project_id,
    );
    const repo = await firstRow<{ repo_full_name: string; default_branch: string }>(ctx.db, "SELECT repo_full_name, default_branch FROM git_repositories WHERE project_id = ? AND enabled = 1", project.project_id);
    return {
      status: 200,
      data: {
        project_id: project.project_id,
        base: repo === null ? { kind: "snapshot_only", commit_sha: null } : { kind: "github", repo_full_name: repo.repo_full_name, branch: repo.default_branch },
        items: documents,
      },
    };
  },

  "get-projects-by-projectId-ide-documents-by-docId": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const document = await firstRow<{ document_id: string; project_id: string; path: string; language: string; revision: number; updated_at: string }>(
      ctx.db,
      "SELECT * FROM documents WHERE document_id = ? AND project_id = ? AND deleted_at IS NULL",
      ctx.params["docId"] ?? "",
      project.project_id,
    );
    if (document === null) throw notFoundOrHidden(ctx.requestId, "document", ctx.params["docId"] ?? "");
    const snapshot = await firstRow<{ snapshot_id: string; revision: number; r2_key: string; sha256: string; base_commit_sha: string | null; created_at: string }>(
      ctx.db,
      "SELECT * FROM document_snapshots WHERE document_id = ? ORDER BY revision DESC LIMIT 1",
      document.document_id,
    );
    let content: string | null = null;
    if (snapshot !== null && ctx.env.R2 !== undefined) {
      const object = await ctx.env.R2.get(snapshot.r2_key);
      content = object === null ? null : await object.text();
    }
    return {
      status: 200,
      data: {
        document,
        snapshot: snapshot === null ? null : { ...snapshot, content_available: content !== null },
        content,
        content_state: content === null ? (snapshot === null ? "NO_SNAPSHOT" : "R2_NOT_READABLE") : "AVAILABLE",
      },
    };
  },

  "post-projects-by-projectId-ide-publish": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const repo = await getRepo(ctx, project.project_id);
    const client = github(ctx);
    const document = await firstRow<{ document_id: string; path: string }>(ctx.db, "SELECT document_id, path FROM documents WHERE document_id = ? AND project_id = ?", String(ctx.body["document_id"]), project.project_id);
    if (document === null) throw notFoundOrHidden(ctx.requestId, "document", String(ctx.body["document_id"]));
    const snapshot = await firstRow<{ r2_key: string; sha256: string }>(ctx.db, "SELECT r2_key, sha256 FROM document_snapshots WHERE document_id = ? ORDER BY revision DESC LIMIT 1", document.document_id);
    if (snapshot === null || ctx.env.R2 === undefined) {
      throw blocked(ctx.requestId, "R2_NOT_ENABLED", { detail: "Yjs 스냅샷 본문이 R2에 없어 커밋할 내용을 만들 수 없습니다." });
    }
    const object = await ctx.env.R2.get(snapshot.r2_key);
    if (object === null) throw blocked(ctx.requestId, "SNAPSHOT_MISSING");
    const content = await object.text();
    const { owner, repo: repoName } = splitRepo(repo.repo_full_name);
    const branches = await client.listBranches({ owner, repo: repoName });
    const remote = branches.find((branch) => branch.name === repo.default_branch);
    if (remote === undefined || remote.sha !== String(ctx.body["base_commit_sha"])) {
      throw new ApiError({
        code: "REVISION_CONFLICT",
        requestId: ctx.requestId,
        message: "원격 기준 브랜치가 이동했습니다. 최신 SHA로 다시 시도하세요.",
        details: { remote_head_sha: remote?.sha ?? null, requested_base: ctx.body["base_commit_sha"] },
      });
    }
    const commit = await client.createCommit({
      owner,
      repo: repoName,
      branch: repo.default_branch,
      path: document.path,
      content,
      message: String(ctx.body["commit_message"]),
      baseSha: remote.sha,
    });
    const revisionId = mintId("revision");
    await ctx.db
      .prepare("INSERT INTO git_revisions (revision_id, repo_id, commit_sha, parent_sha, branch, author_kind, author_id, message, committed_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(revisionId, repo.repo_id, commit.commit_sha, remote.sha, repo.default_branch, ctx.principal.subject.kind, ctx.principal.subject.id, String(ctx.body["commit_message"]), ctx.now)
      .run();
    await ctx.db
      .prepare("INSERT INTO file_operations (operation_id, project_id, document_id, operation, actor_kind, actor_id, base_commit_sha, result_commit_sha, outcome, created_at) VALUES (?,?,?,'publish',?,?,?,?,'applied',?)")
      .bind(mintId("event"), project.project_id, document.document_id, ctx.principal.subject.kind, ctx.principal.subject.id, remote.sha, commit.commit_sha, ctx.now)
      .run();
    return { status: 201, data: { document_id: document.document_id, commit_sha: commit.commit_sha, parent_sha: remote.sha, blob_sha: commit.blob_sha, branch: repo.default_branch } };
  },

  "get-projects-by-projectId-git-branches": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const repo = await getRepo(ctx, project.project_id);
    const client = github(ctx);
    const { owner, repo: repoName } = splitRepo(repo.repo_full_name);
    const branches = await client.listBranches({ owner, repo: repoName });
    return { status: 200, data: { project_id: project.project_id, repo_full_name: repo.repo_full_name, default_branch: repo.default_branch, items: branches } };
  },

  "post-projects-by-projectId-git-branches": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const repo = await getRepo(ctx, project.project_id);
    const client = github(ctx);
    const name = String(ctx.body["name"]);
    if (!isValidBranchName(name) && !name.startsWith("ai/")) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "허용되지 않는 브랜치 이름입니다.", details: { field: "name" } });
    }
    const { owner, repo: repoName } = splitRepo(repo.repo_full_name);
    const created = await client.createBranch({ owner, repo: repoName, branch: name, fromSha: String(ctx.body["from_sha"]) });
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "git.branch.created",
      aggregateType: "repository",
      aggregateId: repo.repo_id,
      subject: ctx.principal.subject,
      payload: { branch: created.ref, sha: created.sha },
    });
    return { status: 201, data: { ref: created.ref, sha: created.sha } };
  },

  "post-projects-by-projectId-git-pull-requests": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const repo = await getRepo(ctx, project.project_id);
    const client = github(ctx);
    const { owner, repo: repoName } = splitRepo(repo.repo_full_name);
    const pr = await client.openPullRequest({
      owner,
      repo: repoName,
      head: String(ctx.body["head"]),
      base: String(ctx.body["base"]),
      title: String(ctx.body["title"]),
      body: String(ctx.body["body"] ?? ""),
    });
    if (pr.head_sha !== String(ctx.body["head_sha"])) {
      throw new ApiError({
        code: "REVISION_CONFLICT",
        requestId: ctx.requestId,
        message: "PR head SHA가 요청과 다릅니다. 원격 상태를 먼저 확인하세요.",
        details: { remote_head_sha: pr.head_sha, requested_head_sha: ctx.body["head_sha"] },
      });
    }
    const pullRequestId = mintId("pullRequest");
    await ctx.db
      .prepare("INSERT INTO git_pull_requests (pull_request_id, repo_id, github_pr_number, task_id, attempt_id, head_sha, base_sha, status, last_synced_at) VALUES (?,?,?,?,?,?,?,'OPEN',?)")
      .bind(pullRequestId, repo.repo_id, pr.number, optionalString(ctx.body, "task_id"), optionalString(ctx.body, "attempt_id"), pr.head_sha, pr.base_sha, ctx.now)
      .run();
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "git.pull_request.opened",
      aggregateType: "pull_request",
      aggregateId: pullRequestId,
      subject: ctx.principal.subject,
      payload: { number: pr.number, url: pr.url, head_sha: pr.head_sha },
    });
    return { status: 201, data: { pull_request_id: pullRequestId, number: pr.number, url: pr.url, head_sha: pr.head_sha, base_sha: pr.base_sha, state: "OPEN" } };
  },

  "post-projects-by-projectId-git-reviews": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const pr = await firstRow<{ pull_request_id: string; repo_id: string; github_pr_number: number; head_sha: string }>(
      ctx.db,
      `SELECT p.pull_request_id, p.repo_id, p.github_pr_number, p.head_sha FROM git_pull_requests p
       JOIN git_repositories r ON r.repo_id = p.repo_id WHERE p.pull_request_id = ? AND r.project_id = ?`,
      String(ctx.body["pull_request_id"]),
      project.project_id,
    );
    if (pr === null) throw notFoundOrHidden(ctx.requestId, "pull_request", String(ctx.body["pull_request_id"]));
    const reviewId = mintId("review");
    await ctx.db
      .prepare("INSERT INTO code_reviews (review_id, pull_request_id, reviewer_kind, reviewer_id, reviewed_sha, verdict, attestation, created_at) VALUES (?,?,?,?,?,?,'self_declared',?)")
      .bind(reviewId, pr.pull_request_id, ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, String(ctx.body["commit_sha"]), String(ctx.body["verdict"]), ctx.now)
      .run();
    const comments = (ctx.body["comments"] as { file_path: string; line_number?: number | null; body: string }[] | undefined) ?? [];
    for (const comment of comments) {
      await ctx.db
        .prepare("INSERT INTO review_comments (comment_id, review_id, file_path, line_number, body_md, created_at) VALUES (?,?,?,?,?,?)")
        .bind(mintId("event"), reviewId, comment.file_path, comment.line_number ?? null, comment.body, ctx.now)
        .run();
    }
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "git.review.submitted",
      aggregateType: "pull_request",
      aggregateId: pr.pull_request_id,
      subject: ctx.principal.subject,
      payload: { review_id: reviewId, reviewed_sha: ctx.body["commit_sha"], verdict: ctx.body["verdict"], comments: comments.length },
    });
    return {
      status: 201,
      data: {
        review_id: reviewId,
        reviewed_sha: ctx.body["commit_sha"],
        head_sha: pr.head_sha,
        at_head: pr.head_sha === ctx.body["commit_sha"],
        verdict: ctx.body["verdict"],
        attestation: "self_declared",
        comments: comments.length,
      },
    };
  },

  "post-projects-by-projectId-git-merge": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const pr = await firstRow<{ pull_request_id: string; repo_id: string; github_pr_number: number; head_sha: string; base_sha: string | null; status: string }>(
      ctx.db,
      `SELECT p.* FROM git_pull_requests p JOIN git_repositories r ON r.repo_id = p.repo_id WHERE p.pull_request_id = ? AND r.project_id = ?`,
      String(ctx.body["pull_request_id"]),
      project.project_id,
    );
    if (pr === null) throw notFoundOrHidden(ctx.requestId, "pull_request", String(ctx.body["pull_request_id"]));
    const expectedHead = String(ctx.body["expected_head_sha"]);
    if (expectedHead !== pr.head_sha) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, message: "PR head SHA가 바뀌었습니다.", details: { head_sha: pr.head_sha } });
    }
    const reviews = await allRows<{ reviewed_sha: string; verdict: string; reviewer_id: string }>(ctx.db, "SELECT reviewed_sha, verdict, reviewer_id FROM code_reviews WHERE pull_request_id = ?", pr.pull_request_id);
    const runs = await allRows<{ workflow_name: string | null; conclusion: string | null; head_sha: string; github_run_id: string }>(ctx.db, "SELECT * FROM ci_runs WHERE pr_id = ?", pr.pull_request_id);
    const approvals = await allRows<{ approval_id: string; state: string; bound_commit_sha: string | null; action_digest: string; expires_at: string; diff_sha: string | null }>(
      ctx.db,
      "SELECT approval_id, state, bound_commit_sha, action_digest, expires_at, diff_sha FROM approvals WHERE target_type = 'pull_request' AND target_id = ?",
      pr.pull_request_id,
    );
    const { computeActionDigest } = await import("@ai-room/permissions");
    const expectedDigest = await computeActionDigest({
      target_type: "pull_request",
      target_id: pr.pull_request_id,
      project_id: project.project_id,
      bound_commit_sha: expectedHead,
      diff_sha: null,
    });
    const approveReviews = reviews.filter((review) => review.verdict === "APPROVE" && review.reviewed_sha === expectedHead);
    const verdict = evaluateMergePolicy({
      pullRequestState: pr.status,
      reviewedSha: approveReviews[0]?.reviewed_sha ?? null,
      headSha: expectedHead,
      baseSha: pr.base_sha,
      requiredChecks:
        runs.length === 0
          ? [{ name: "required-ci", conclusion: null, headSha: expectedHead }]
          : runs.map((run) => ({ name: run.workflow_name ?? "ci", conclusion: (run.conclusion ?? null) as "success" | "failure" | "cancelled" | "timed_out" | null, headSha: run.head_sha })),
      approvals: approvals.map((approval) => ({
        state: approval.state,
        boundCommitSha: approval.bound_commit_sha,
        diffSha: approval.diff_sha,
        actionDigest: approval.action_digest,
        expectedDigest,
        expiresAt: approval.expires_at,
      })),
      nowMs: ctx.nowMs,
    });
    if (!verdict.allowed) {
      const first = verdict.blocking[0];
      const code = first?.error_code ?? "APPROVAL_REQUIRED";
      await ctx.auth.audit("git.merge.blocked", ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, "pull_request", pr.pull_request_id, "deny", ctx.requestId, {
        checks: verdict.blocking.map((check) => check.id),
      });
      throw new ApiError({ code, requestId: ctx.requestId, details: { checks: verdict.checks, blocking: verdict.blocking.map((check) => check.id) } });
    }
    const repo = await getRepo(ctx, project.project_id);
    const client = github(ctx);
    const { owner, repo: repoName } = splitRepo(repo.repo_full_name);
    const merged = await client.mergePullRequest({ owner, repo: repoName, number: pr.github_pr_number, expectedHeadSha: expectedHead, method: String(ctx.body["method"] ?? "squash") as "squash" | "merge" | "rebase" });
    if (!merged.merged) {
      throw new ApiError({ code: "CI_FAILED", requestId: ctx.requestId, message: "원격 병합이 거부되었습니다.", details: { provider_message: merged.message } });
    }
    await ctx.db.prepare("UPDATE git_pull_requests SET status = 'MERGED', last_synced_at = ? WHERE pull_request_id = ?").bind(ctx.now, pr.pull_request_id).run();
    await ctx.db
      .prepare("INSERT INTO merge_requests (merge_request_id, pull_request_id, expected_head_sha, approval_id, ci_run_id, state, requested_by_kind, requested_by_id, requested_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(mintId("event"), pr.pull_request_id, expectedHead, optionalString(ctx.body, "approval_id"), runs[0]?.github_run_id ?? null, "MERGED", ctx.principal.subject.kind, ctx.principal.subject.id, ctx.now, ctx.now)
      .run();
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "git.pull_request.merged",
      aggregateType: "pull_request",
      aggregateId: pr.pull_request_id,
      subject: ctx.principal.subject,
      payload: { head_sha: expectedHead, merge_sha: merged.merge_sha, checks: verdict.checks.length },
    });
    return {
      status: 200,
      data: {
        pull_request_id: pr.pull_request_id,
        merged: true,
        merge_sha: merged.merge_sha,
        expected_head_sha: expectedHead,
        checks_passed: verdict.checks.map((check) => check.id),
      },
    };
  },

  "post-projects-by-projectId-jobs": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    if (await isEmergencyStopped(ctx.db)) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "EMERGENCY_STOP_ENGAGED" } });
    }
    const budget = await firstRow<{ hard_limit_value: number; observed_value: number | null; observation_state: string }>(
      ctx.db,
      "SELECT hard_limit_value, observed_value, observation_state FROM usage_budgets WHERE provider = 'github' AND resource_kind = 'workflow_dispatch'",
    );
    if (budget !== null && budget.observed_value !== null && budget.observed_value >= budget.hard_limit_value) {
      throw new ApiError({ code: "QUOTA_EXHAUSTED", requestId: ctx.requestId, details: { provider: "github", resource_kind: "workflow_dispatch", hard_limit: budget.hard_limit_value } });
    }
    const jobId = mintId("job");
    const now = ctx.now;
    const repo = await firstRow<{ repo_id: string; repo_full_name: string }>(ctx.db, "SELECT repo_id, repo_full_name FROM git_repositories WHERE project_id = ? AND enabled = 1", project.project_id);
    const canDispatch = repo !== null && ctx.env.GITHUB !== undefined;
    await ctx.db
      .prepare(
        "INSERT INTO jobs (job_id, project_id, task_id, job_kind, state, requested_by_kind, requested_by_id, workflow_ref, commit_sha, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)",
      )
      .bind(
        jobId,
        project.project_id,
        optionalString(ctx.body, "task_id"),
        String(ctx.body["job_kind"]),
        canDispatch ? "DISPATCH_REQUESTED" : "BLOCKED_EXTERNAL_DEPENDENCY",
        ctx.principal.subject.kind,
        ctx.principal.subject.id,
        String(ctx.body["workflow_ref"]),
        String(ctx.body["commit_sha"]),
        now,
        now,
      )
      .run();
    if (!canDispatch) {
      await recordProjectEvent({
        db: ctx.db,
        projectId: project.project_id,
        eventType: "job.queued",
        aggregateType: "job",
        aggregateId: jobId,
        subject: ctx.principal.subject,
        payload: { state: "BLOCKED_EXTERNAL_DEPENDENCY", reason: repo === null ? "GITHUB_REPOSITORY_NOT_CONNECTED" : "GITHUB_APP_NOT_CONFIGURED" },
      });
      return {
        status: 202,
        data: {
          job_id: jobId,
          state: "BLOCKED_EXTERNAL_DEPENDENCY",
          reason: repo === null ? "GITHUB_REPOSITORY_NOT_CONNECTED" : "GITHUB_APP_NOT_CONFIGURED",
          note: "실행 요청은 기록했지만 실행기는 없습니다. SUCCEEDED로 표시하지 않습니다.",
        },
      };
    }
    const client = github(ctx);
    const { owner, repo: repoName } = splitRepo(repo.repo_full_name);
    const dispatch = await client.dispatchWorkflow({
      owner,
      repo: repoName,
      workflowFile: String(ctx.body["workflow_ref"]),
      ref: String(ctx.body["ref"]),
      inputs: { project_id: project.project_id, job_id: jobId, commit_sha: String(ctx.body["commit_sha"]) },
    });
    await ctx.db.prepare("UPDATE jobs SET state = ?, revision = revision + 1, updated_at = ? WHERE job_id = ?").bind(dispatch.run_id === null ? "DISPATCH_REQUESTED" : "DISPATCHED", ctx.now, jobId).run();
    await ctx.db
      .prepare("INSERT INTO job_attempts (job_attempt_id, job_id, attempt_number, github_total_count, started_at, outcome) VALUES (?,?,1,?,?, 'RUNNING')")
      .bind(mintId("attempt"), jobId, dispatch.run_id, ctx.now)
      .run();
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "job.queued",
      aggregateType: "job",
      aggregateId: jobId,
      subject: ctx.principal.subject,
      payload: { state: dispatch.run_id === null ? "DISPATCH_REQUESTED" : "DISPATCHED", run_id: dispatch.run_id },
    });
    return {
      status: 202,
      data: {
        job_id: jobId,
        state: dispatch.run_id === null ? "DISPATCH_REQUESTED" : "DISPATCHED",
        run_id: dispatch.run_id,
        note: "요청이 접수되었습니다. 실행 시작과 성공은 Actions 상태로 확인해야 합니다.",
      },
    };
  },

  "get-projects-by-projectId-jobs-by-jobId": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const job = await firstRow<{ job_id: string; state: string; job_kind: string; commit_sha: string | null; workflow_ref: string | null; revision: number; created_at: string; updated_at: string }>(
      ctx.db,
      "SELECT job_id, state, job_kind, commit_sha, workflow_ref, revision, created_at, updated_at FROM jobs WHERE job_id = ? AND project_id = ?",
      ctx.params["jobId"] ?? "",
      project.project_id,
    );
    if (job === null) throw notFoundOrHidden(ctx.requestId, "job", ctx.params["jobId"] ?? "");
    const attempts = await allRows<{ job_attempt_id: string; attempt_number: number; github_total_count: number | null; outcome: string; started_at: string | null; ended_at: string | null }>(
      ctx.db,
      "SELECT job_attempt_id, attempt_number, github_total_count, outcome, started_at, ended_at FROM job_attempts WHERE job_id = ? ORDER BY attempt_number DESC",
      job.job_id,
    );
    return { status: 200, data: { ...job, attempts, is_terminal: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.state) } };
  },

  "post-projects-by-projectId-jobs-by-jobId-cancel": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const job = await firstRow<{ job_id: string; state: JobState; created_at: string }>(ctx.db, "SELECT job_id, state, created_at FROM jobs WHERE job_id = ? AND project_id = ?", ctx.params["jobId"] ?? "", project.project_id);
    if (job === null) throw notFoundOrHidden(ctx.requestId, "job", ctx.params["jobId"] ?? "");
    if (!canTransitionJob(job.state, "CANCEL_REQUESTED")) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { state: job.state, reason: "CANCEL_NOT_APPLICABLE" } });
    }
    await ctx.db.prepare("UPDATE jobs SET state = 'CANCEL_REQUESTED', revision = revision + 1, updated_at = ? WHERE job_id = ?").bind(ctx.now, job.job_id).run();
    const attempt = await firstRow<{ github_total_count: number | null }>(ctx.db, "SELECT github_total_count FROM job_attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1", job.job_id);
    let providerCancelled = false;
    if (attempt?.github_total_count !== null && attempt?.github_total_count !== undefined && ctx.env.GITHUB !== undefined) {
      const repo = await firstRow<{ repo_full_name: string }>(ctx.db, "SELECT repo_full_name FROM git_repositories WHERE project_id = ?", project.project_id);
      if (repo !== null) {
        const { owner, repo: repoName } = splitRepo(repo.repo_full_name);
        const result = await ctx.env.GITHUB.cancelRun({ owner, repo: repoName, runId: attempt.github_total_count });
        providerCancelled = result.cancelled;
      }
    }
    const reconciledState = providerCancelled ? "CANCELLED" : "CANCEL_REQUESTED";
    if (providerCancelled) {
      await ctx.db.prepare("UPDATE jobs SET state = 'CANCELLED', revision = revision + 1, updated_at = ? WHERE job_id = ?").bind(ctx.now, job.job_id).run();
    }
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "job.cancelled",
      aggregateType: "job",
      aggregateId: job.job_id,
      subject: ctx.principal.subject,
      payload: { requested: true, provider_cancelled: providerCancelled, state: reconciledState },
    });
    return {
      status: 202,
      data: {
        job_id: job.job_id,
        state: reconciledState,
        requested: true,
        provider_confirmed: providerCancelled,
        note: providerCancelled ? "실행기가 취소를 확인했습니다." : "취소 요청만 접수되었습니다. 실행 상태 재조정이 필요합니다.",
      },
    };
  },

  "get-projects-by-projectId-jobs-by-jobId-logs": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const job = await firstRow<{ job_id: string }>(ctx.db, "SELECT job_id FROM jobs WHERE job_id = ? AND project_id = ?", ctx.params["jobId"] ?? "", project.project_id);
    if (job === null) throw notFoundOrHidden(ctx.requestId, "job", ctx.params["jobId"] ?? "");
    const repo = await getRepo(ctx, project.project_id);
    const client = github(ctx);
    const attempt = await firstRow<{ github_total_count: number | null }>(ctx.db, "SELECT github_total_count FROM job_attempts WHERE job_id = ? ORDER BY attempt_number DESC LIMIT 1", job.job_id);
    if (attempt?.github_total_count === null || attempt?.github_total_count === undefined) {
      throw blocked(ctx.requestId, "NO_PROVIDER_RUN", { detail: "실제 실행 ID가 없어 로그를 가져올 수 없습니다." });
    }
    const { owner, repo: repoName } = splitRepo(repo.repo_full_name);
    const logs = await client.getRunLogs({ owner, repo: repoName, runId: attempt.github_total_count });
    const redacted = redactSecrets(logs.log.slice(0, 200_000));
    return { status: 200, data: { job_id: job.job_id, run_id: attempt.github_total_count, log: redacted.text, redacted: redacted.redacted, truncated: logs.log.length > 200_000 } };
  },

  "get-projects-by-projectId-artifacts": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const rows = await allRows<{ artifact_id: string; artifact_type: string; version: string; sha256: string; size_bytes: number; verification_state: string; source_commit_sha: string | null; created_at: string }>(
      ctx.db,
      "SELECT artifact_id, artifact_type, version, sha256, size_bytes, verification_state, source_commit_sha, created_at FROM artifacts WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
      project.project_id,
    );
    const items = [];
    for (const row of rows) {
      const manifest = await firstRow<{ manifest_sha256: string }>(ctx.db, "SELECT manifest_sha256 FROM artifact_manifests WHERE artifact_id = ?", row.artifact_id);
      const files = await count(ctx.db, "SELECT COUNT(*) AS n FROM artifact_files WHERE artifact_id = ?", row.artifact_id);
      items.push({ ...row, manifest_sha256: manifest?.manifest_sha256 ?? null, file_count: files, download_allowed: row.verification_state === "VERIFIED" });
    }
    return { status: 200, data: { project_id: project.project_id, items } };
  },

  "post-projects-by-projectId-artifacts-by-artifactId-verify": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const artifact = await firstRow<{ artifact_id: string; sha256: string; r2_key: string; verification_state: string }>(
      ctx.db,
      "SELECT artifact_id, sha256, r2_key, verification_state FROM artifacts WHERE artifact_id = ? AND project_id = ? AND deleted_at IS NULL",
      ctx.params["artifactId"] ?? "",
      project.project_id,
    );
    if (artifact === null) throw notFoundOrHidden(ctx.requestId, "artifact", ctx.params["artifactId"] ?? "");
    if (ctx.env.R2 === undefined) {
      throw blocked(ctx.requestId, "R2_NOT_ENABLED", { detail: "산출물 본문이 R2에 없어 해시를 재계산할 수 없습니다." });
    }
    const object = await ctx.env.R2.get(artifact.r2_key);
    if (object === null) throw blocked(ctx.requestId, "ARTIFACT_OBJECT_MISSING", { artifact_id: artifact.artifact_id });
    const bytes = new Uint8Array(await object.arrayBuffer());
    const check = await verifyArtifactHash(artifact.sha256, bytes);
    await ctx.db
      .prepare("INSERT INTO artifact_verifications (verification_id, artifact_id, computed_sha256, expected_commit_sha, result, byte_count, verified_at, verifier_kind) VALUES (?,?,?,?,?,?,?,?)")
      .bind(mintId("event"), artifact.artifact_id, check.computed, null, check.matches ? "verified" : "mismatch", bytes.length, ctx.now, ctx.principal.subject.kind === "owner" ? "owner" : "agent")
      .run();
    await ctx.db
      .prepare("UPDATE artifacts SET verification_state = ? WHERE artifact_id = ?")
      .bind(check.matches ? "VERIFIED" : "MISMATCH", artifact.artifact_id)
      .run();
    if (!check.matches) {
      throw new ApiError({ code: "ARTIFACT_NOT_VERIFIED", requestId: ctx.requestId, message: "산출물 해시가 일치하지 않습니다.", details: { expected: check.expected, computed: check.computed } });
    }
    return { status: 200, data: { artifact_id: artifact.artifact_id, verification_state: "VERIFIED", computed_sha256: check.computed, byte_count: bytes.length } };
  },

  "post-projects-by-projectId-artifacts-by-artifactId-download-intent": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const artifact = await firstRow<{ artifact_id: string; sha256: string; verification_state: string; r2_key: string }>(
      ctx.db,
      "SELECT artifact_id, sha256, verification_state, r2_key FROM artifacts WHERE artifact_id = ? AND project_id = ? AND deleted_at IS NULL",
      ctx.params["artifactId"] ?? "",
      project.project_id,
    );
    if (artifact === null) throw notFoundOrHidden(ctx.requestId, "artifact", ctx.params["artifactId"] ?? "");
    if (artifact.verification_state !== "VERIFIED") {
      throw new ApiError({ code: "ARTIFACT_NOT_VERIFIED", requestId: ctx.requestId, details: { verification_state: artifact.verification_state } });
    }
    if (ctx.env.R2 === undefined) throw blocked(ctx.requestId, "R2_NOT_ENABLED");
    const signingKey = ctx.env.SESSION_SIGNING_KEY;
    if (signingKey === undefined) throw blocked(ctx.requestId, "DOWNLOAD_SIGNING_KEY_MISSING");
    const expiresAt = new Date(ctx.nowMs + Number(ctx.body["ttl_seconds"] ?? 300) * 1000).toISOString();
    const grant = await signDownloadGrant(
      {
        grant_id: mintId("event"),
        target_kind: "artifact",
        target_id: artifact.artifact_id,
        actor_kind: ctx.principal.subject.kind === "owner" ? "owner" : "agent",
        actor_id: ctx.principal.subject.id,
        issued_at: ctx.now,
        expires_at: expiresAt,
        single_use: false,
      },
      signingKey,
    );
    await ctx.db
      .prepare("INSERT INTO download_events (download_id, file_id, artifact_id, actor_kind, actor_id, issued_at, expires_at) VALUES (?,NULL,?,?,?,?,?)")
      .bind(mintId("event"), artifact.artifact_id, ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, ctx.now, expiresAt)
      .run();
    return {
      status: 200,
      data: {
        artifact_id: artifact.artifact_id,
        sha256: artifact.sha256,
        download_url: `/api/v1/artifacts/${artifact.artifact_id}/content?grant=${encodeURIComponent(grant)}`,
        expires_at: expiresAt,
      },
    };
  },

  "get-projects-by-projectId-reports": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const rows = await allRows<{ report_id: string; report_kind: string; body_md: string; evidence_refs_json: string; created_by_kind: string; created_by_id: string; created_at: string }>(
      ctx.db,
      "SELECT report_id, report_kind, body_md, evidence_refs_json, created_by_kind, created_by_id, created_at FROM project_reports WHERE project_id = ? ORDER BY created_at DESC",
      project.project_id,
    );
    return {
      status: 200,
      data: {
        project_id: project.project_id,
        items: rows.map((row) => ({ ...row, evidence_refs: JSON.parse(row.evidence_refs_json) as string[] })),
      },
    };
  },
};

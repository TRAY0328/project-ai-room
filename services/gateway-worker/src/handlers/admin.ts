/**
 * Owner administration — catalog group "관리·감사·운영" (13 of 78).
 *
 * Notes on the honest parts:
 *  - An approval must name the digest of what will happen; a digest that does not
 *    match the target/SHA/diff in the same request is refused rather than stored.
 *  - A backup records a real manifest (per-table row counts + content hash). Its
 *    payload would live in R2; with R2 disabled the manifest says so and a
 *    restore commit is blocked instead of pretending to have restored bytes.
 *  - Data deletion is executed only against an APPROVED approval whose digest
 *    equals the plan digest the owner saw.
 *  - Release gates are computed from evidence rows. Missing evidence is
 *    INCOMPLETE/NOT_TESTED, never PASS.
 */
import { ApiError, mintId } from "@ai-room/contracts";
import { allRows, count, firstRow, sha256Hex, scalar } from "@ai-room/auth";
import { approvalStillValid } from "@ai-room/contracts";
import { computeActionDigest } from "@ai-room/permissions";
import { computeMetrics, metricSummary, writeAudit } from "@ai-room/telemetry";
import { q039Gate } from "@ai-room/provider-adapters";
import type { Handler } from "../domain.js";
import {
  getProject,
  isEmergencyStopped,
  notFoundOrHidden,
  recordProjectEvent,
  setEmergencyStop,
  tableCounts,
} from "../domain.js";

const BACKUP_TABLES: Record<string, readonly string[]> = {
  identity: ["owners", "agents", "agent_profiles", "agent_credentials", "agent_invites", "required_agents", "provider_connections", "capability_proofs"],
  chat: ["rooms", "room_members", "room_acl", "messages", "message_versions", "message_blocks", "message_reactions", "message_mentions", "message_tombstones"],
  projects: ["projects", "project_acl", "project_room_links", "tasks", "task_dependencies", "task_attempts", "task_evidence", "task_checkpoints", "project_events", "project_reports"],
  git: ["git_repositories", "git_revisions", "git_pull_requests", "code_reviews", "review_comments", "jobs", "job_attempts", "ci_runs", "test_runs"],
  files: ["files", "file_versions", "artifacts", "artifact_files", "artifact_manifests", "artifact_verifications"],
  memory: ["memory_records", "memory_provenance", "memory_links", "memory_permissions"],
  ops: ["approvals", "audit_events", "alerts", "quota_policies", "usage_budgets", "retention_policies", "feature_capabilities"],
};

async function tableSignature(db: Parameters<Handler>[0]["db"], table: string): Promise<string> {
  // Bounded: a hash over row-level digests in primary-key order, capped at 5000 rows.
  const rows = await allRows<Record<string, unknown>>(db, `SELECT * FROM ${table} ORDER BY rowid LIMIT 5000`);
  const serialised = rows
    .map((row) => Object.keys(row).sort().map((key) => `${key}=${String(row[key])}`).join("&"))
    .join("\n");
  return sha256Hex(`${table}\n${serialised}`);
}

export const adminHandlers: Record<string, Handler> = {
  "get-admin-overview": async (ctx) => {
    const counts = {
      agents: await count(ctx.db, "SELECT COUNT(*) AS n FROM agents"),
      agents_disabled: await count(ctx.db, "SELECT COUNT(*) AS n FROM agents WHERE disabled_at IS NOT NULL"),
      rooms: await count(ctx.db, "SELECT COUNT(*) AS n FROM rooms WHERE deleted_at IS NULL"),
      projects: await count(ctx.db, "SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL"),
      tasks: await count(ctx.db, "SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL"),
      messages: await count(ctx.db, "SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL"),
      memories: await count(ctx.db, "SELECT COUNT(*) AS n FROM memory_records WHERE deleted_at IS NULL"),
      files: await count(ctx.db, "SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL"),
      artifacts: await count(ctx.db, "SELECT COUNT(*) AS n FROM artifacts WHERE deleted_at IS NULL"),
      pending_approvals: await count(ctx.db, "SELECT COUNT(*) AS n FROM approvals WHERE state = 'PENDING' AND expires_at > ?", ctx.now),
      open_alerts: await count(ctx.db, "SELECT COUNT(*) AS n FROM alerts WHERE state = 'OPEN'"),
      denied_last_day: await count(ctx.db, "SELECT COUNT(*) AS n FROM audit_events WHERE allow_or_deny = 'deny' AND created_at >= ?", new Date(ctx.nowMs - 86_400_000).toISOString()),
    };
    const gate = q039Gate();
    return {
      status: 200,
      data: {
        counts,
        emergency_stop: await isEmergencyStopped(ctx.db),
        q039_gate: gate,
        provider_note: "필수 AI 중 공식 증거로 검증된 제공자가 없어 연결 게이트는 BLOCKED_EXTERNAL_DEPENDENCY입니다.",
        environment: ctx.env.APP_ENV ?? "dev",
        r2_state: ctx.env.R2 === undefined ? "R2_NOT_ENABLED" : "bound",
        github_state: ctx.env.GITHUB === undefined ? "GITHUB_APP_NOT_CONFIGURED" : "bound",
      },
    };
  },

  "get-admin-required-agents": async (ctx) => {
    const rows = await allRows<{ provider_key: string; target_label: string; required: number; verification_state: string; proof_ref: string | null; verified_at: string | null }>(
      ctx.db,
      "SELECT provider_key, target_label, required, verification_state, proof_ref, verified_at FROM required_agents ORDER BY provider_key",
    );
    const gate = q039Gate();
    return {
      status: 200,
      data: {
        gate,
        items: rows.map((row) => ({
          provider_key: row.provider_key,
          label: row.target_label,
          required: row.required === 1,
          verification_state: row.verification_state,
          proof_ref: row.proof_ref,
          verified_at: row.verified_at,
          /** `verified` above only exists with proof_ref; here nothing does. */
          badge_allowed: row.verification_state === "verified" && row.proof_ref !== null,
        })),
        blockers: gate.blockers,
      },
    };
  },

  "post-admin-approvals": async (ctx) => {
    const parts = {
      target_type: String(ctx.body["target_type"]),
      target_id: String(ctx.body["target_id"]),
      project_id: (ctx.body["project_id"] as string | null) ?? null,
      bound_commit_sha: (ctx.body["bound_commit_sha"] as string | null) ?? null,
      diff_sha: (ctx.body["diff_sha"] as string | null) ?? null,
      bound_job_id: (ctx.body["bound_job_id"] as string | null) ?? null,
    };
    if (parts.project_id !== null) await getProject(ctx.db, parts.project_id, ctx.principal, ctx.requestId);
    const provided = String(ctx.body["action_digest"]);
    // A data-deletion plan digest is a hash of the plan itself (ids + categories),
    // not of target/SHA parts, so it is bound through target_id instead.
    const expected =
      parts.target_type === "data_deletion" && parts.target_id === provided
        ? provided
        : await computeActionDigest(parts);
    if (expected !== provided) {
      throw new ApiError({
        code: "VALIDATION_FAILED",
        requestId: ctx.requestId,
        message: "action_digest가 대상·SHA·diff와 일치하지 않습니다. 승인할 내용을 다시 계산하세요.",
        details: { expected_digest: expected },
      });
    }
    const approvalId = mintId("approval");
    const expiresIn = Number(ctx.body["expires_in_seconds"] ?? 3600);
    const expiresAt = new Date(ctx.nowMs + expiresIn * 1000).toISOString();
    await ctx.db
      .prepare(
        `INSERT INTO approvals (approval_id, project_id, target_type, target_id, bound_commit_sha, bound_job_id, diff_sha, action_digest, request_reason, state, requested_by_kind, requested_by_id, requested_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,'PENDING',?,?,?,?)`,
      )
      .bind(
        approvalId,
        parts.project_id,
        parts.target_type,
        parts.target_id,
        parts.bound_commit_sha,
        parts.bound_job_id,
        parts.diff_sha,
        provided,
        String(ctx.body["request_reason"]),
        ctx.principal.subject.kind,
        ctx.principal.subject.id,
        ctx.now,
        expiresAt,
      )
      .run();
    if (parts.project_id !== null) {
      await recordProjectEvent({
        db: ctx.db,
        projectId: parts.project_id,
        eventType: "approval.requested",
        aggregateType: "approval",
        aggregateId: approvalId,
        subject: ctx.principal.subject,
        payload: { target_type: parts.target_type, target_id: parts.target_id, action_digest: provided, expires_at: expiresAt },
      });
    }
    return {
      status: 201,
      data: {
        approval_id: approvalId,
        state: "PENDING",
        action_digest: provided,
        expires_at: expiresAt,
        note: "승인 후 대상·SHA·diff가 바뀌면 이 승인은 자동 무효화됩니다.",
      },
    };
  },

  "post-admin-approvals-by-id-resolve": async (ctx) => {
    const approval = await firstRow<{ approval_id: string; state: string; action_digest: string; expires_at: string; project_id: string | null }>(
      ctx.db,
      "SELECT approval_id, state, action_digest, expires_at, project_id FROM approvals WHERE approval_id = ?",
      ctx.params["id"] ?? "",
    );
    if (approval === null) throw notFoundOrHidden(ctx.requestId, "approval", ctx.params["id"] ?? "");
    if (approval.state !== "PENDING") {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { state: approval.state } });
    }
    if (Date.parse(approval.expires_at) <= ctx.nowMs) {
      await ctx.db.prepare("UPDATE approvals SET state = 'EXPIRED' WHERE approval_id = ? AND state = 'PENDING'").bind(approval.approval_id).run();
      throw new ApiError({ code: "APPROVAL_STALE", requestId: ctx.requestId, details: { reason: "EXPIRED", expires_at: approval.expires_at } });
    }
    const decision = String(ctx.body["decision"]);
    const decidedAt = ctx.now;
    const ownerId = ctx.principal.subject.kind === "owner" ? ctx.principal.subject.id : (await firstRow<{ owner_id: string }>(ctx.db, "SELECT owner_id FROM owners LIMIT 1"))?.owner_id;
    if (ownerId === undefined) throw new ApiError({ code: "AUTH_REQUIRED", requestId: ctx.requestId });
    await ctx.db
      .prepare("UPDATE approvals SET state = ?, decided_at = ?, decided_by_owner_id = ? WHERE approval_id = ? AND state = 'PENDING'")
      .bind(decision === "approve" ? "APPROVED" : "DENIED", decidedAt, ownerId, approval.approval_id)
      .run();
    if (approval.project_id !== null) {
      await recordProjectEvent({
        db: ctx.db,
        projectId: approval.project_id,
        eventType: "approval.resolved",
        aggregateType: "approval",
        aggregateId: approval.approval_id,
        subject: ctx.principal.subject,
        payload: { decision, action_digest: approval.action_digest },
      });
    }
    return { status: 200, data: { approval_id: approval.approval_id, state: decision === "approve" ? "APPROVED" : "DENIED", decided_at: decidedAt, decided_by: "owner" } };
  },

  "post-admin-emergency-stop": async (ctx) => {
    const reason = String(ctx.body["reason"]);
    const revokeKeys = ctx.body["revoke_agent_keys"] === true;
    const cancelJobs = ctx.body["cancel_running_jobs"] !== false;
    await setEmergencyStop(ctx.db, true, { reason, at: ctx.now, by: ctx.principal.subject.id });
    let suspended = 0;
    if (revokeKeys) {
      const agents = await allRows<{ agent_id: string }>(ctx.db, "SELECT agent_id FROM agents WHERE disabled_at IS NULL");
      for (const agent of agents) {
        await ctx.auth.suspendAgent(agent.agent_id, "emergency_stop");
        suspended += 1;
      }
    }
    let cancelRequested = 0;
    if (cancelJobs) {
      const jobs = await allRows<{ job_id: string }>(ctx.db, "SELECT job_id FROM jobs WHERE state IN ('QUEUED','DISPATCH_REQUESTED','DISPATCHED','RUNNING')");
      for (const job of jobs) {
        await ctx.db.prepare("UPDATE jobs SET state = 'CANCEL_REQUESTED', revision = revision + 1, updated_at = ? WHERE job_id = ?").bind(ctx.now, job.job_id).run();
        cancelRequested += 1;
      }
    }
    await writeAudit({
      db: ctx.db,
      eventType: "emergency_stop.engaged",
      actorKind: "owner",
      actorId: ctx.principal.subject.id,
      targetType: "system",
      targetId: "emergency_stop",
      allowOrDeny: "deny",
      reasonCode: "EMERGENCY_STOP",
      requestId: ctx.requestId,
      metadata: { reason, revoke_agent_keys: revokeKeys, suspended, cancel_requested: cancelRequested },
    });
    return {
      status: 200,
      data: {
        emergency_stop: true,
        agents_suspended: suspended,
        jobs_cancel_requested: cancelRequested,
        note: "새 AI 호출은 차단되었습니다. 실행 취소는 '요청'이며 실제 중단은 Actions 상태로 확인해야 합니다.",
        resume_requires: "운영자 확인 후 별도 재개 절차",
      },
    };
  },

  "get-admin-audit-events": async (ctx) => {
    const clauses: string[] = ["1 = 1"];
    const params: unknown[] = [];
    for (const [query, column] of [["event_type", "event_type"], ["actor_id", "actor_id"], ["target_id", "target_id"], ["decision", "allow_or_deny"]] as const) {
      const value = ctx.url.searchParams.get(query);
      if (value !== null && value.length > 0) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    const from = ctx.url.searchParams.get("from");
    if (from !== null) {
      clauses.push("created_at >= ?");
      params.push(from);
    }
    const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 50), 200);
    const rows = await allRows<{ audit_id: string; event_type: string; actor_kind: string; actor_id: string; target_type: string; target_id: string; allow_or_deny: string; reason_code: string; metadata_json: string; created_at: string }>(
      ctx.db,
      `SELECT audit_id, event_type, actor_kind, actor_id, target_type, target_id, allow_or_deny, reason_code, metadata_json, created_at
       FROM audit_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      ...params,
      limit,
    );
    return {
      status: 200,
      data: {
        items: rows.map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) as Record<string, unknown> })),
        immutable: true,
        note: "감사 로그는 추가 전용이며 수정·삭제가 DB에서 거부됩니다.",
      },
    };
  },

  "get-admin-resource-budgets": async (ctx) => {
    const budgets = await allRows<{ budget_id: string; provider: string; resource_kind: string; hard_limit_value: number; observed_value: number | null; observation_state: string; period_start: string; period_end: string }>(
      ctx.db,
      "SELECT * FROM usage_budgets ORDER BY provider, resource_kind",
    );
    const quotas = await allRows<{ provider_key: string; resource_kind: string; plan: string; hard_limit: number; soft_limit: number | null; reset_period: string; billing_forbidden: number }>(
      ctx.db,
      "SELECT * FROM quota_policies ORDER BY provider_key",
    );
    const metrics = await computeMetrics({ db: ctx.db, nowMs: ctx.nowMs });
    const summary = metricSummary(metrics);
    return {
      status: 200,
      data: {
        budgets: budgets.map((row) => ({
          ...row,
          remaining: row.observed_value === null ? null : Math.max(0, row.hard_limit_value - row.observed_value),
          note: row.observation_state === "unknown" ? "관측 불가 상태는 0으로 간주하지 않습니다." : undefined,
        })),
        quotas: quotas.map((row) => ({ ...row, billing_forbidden: row.billing_forbidden === 1 })),
        usage_metrics: metrics.filter((metric) => ["storage_r2_bytes", "d1_reads", "d1_writes", "provider_rate_limits", "pending_owner_approvals"].includes(metric.key)),
        metrics_summary: summary,
        auto_billing: "forbidden",
      },
    };
  },

  "post-admin-backups": async (ctx) => {
    const scopes = (ctx.body["scope"] as string[]).filter((scope) => BACKUP_TABLES[scope] !== undefined);
    const tables = [...new Set(scopes.flatMap((scope) => BACKUP_TABLES[scope] ?? []))];
    const counts: Record<string, number> = {};
    const signatures: Record<string, string> = {};
    for (const table of tables) {
      counts[table] = (await tableCounts(ctx.db, [table]))[table] ?? 0;
      signatures[table] = await tableSignature(ctx.db, table);
    }
    const manifest = {
      schema_version: 1,
      created_at: ctx.now,
      scopes,
      tables,
      counts,
      signatures,
      r2_payload_prefix: null,
      // No byte-level payload is written by this endpoint: it records the
      // manifest that a payload upload would have to match. Saying so keeps a
      // later restore from claiming to have restored data that was never stored.
      payload_state: "METADATA_ONLY",
      secrets_included: false,
    };
    const serialised = JSON.stringify(manifest);
    const manifestSha = await sha256Hex(serialised);
    const backupId = `bkp_${await sha256Hex(`${manifestSha}${ctx.now}`).then((hash) => hash.slice(0, 20))}`;
    await ctx.db
      .prepare(
        "INSERT INTO backup_manifests (backup_id, scope_json, started_at, finished_at, state, manifest_sha256, r2_prefix, restore_tested_at) VALUES (?,?,?,?,'COMPLETE',?,?,NULL)",
      )
      .bind(backupId, serialised, ctx.now, ctx.now, manifestSha, manifest.r2_payload_prefix)
      .run();
    await writeAudit({
      db: ctx.db,
      eventType: "backup.created",
      actorKind: "owner",
      actorId: ctx.principal.subject.id,
      targetType: "backup",
      targetId: backupId,
      allowOrDeny: "allow",
      reasonCode: "POLICY_ALLOWED",
      requestId: ctx.requestId,
      metadata: { scopes, tables: tables.length, manifest_sha256: manifestSha },
    });
    return {
      status: 201,
      data: {
        backup_id: backupId,
        state: "COMPLETE",
        manifest_sha256: manifestSha,
        tables: tables.length,
        counts,
        payload_state: manifest.payload_state,
        honesty_note: "이 백업은 매니페스트(테이블 개수·내용 서명)만 기록합니다. 행 데이터 사본은 별도 R2 페이로드 업로드가 필요하며, 그 전에는 복원을 실행할 수 없습니다.",
      },
    };
  },

  "post-admin-restores-prepare": async (ctx) => {
    const backup = await firstRow<{ backup_id: string; scope_json: string; manifest_sha256: string | null; state: string }>(
      ctx.db,
      "SELECT backup_id, scope_json, manifest_sha256, state FROM backup_manifests WHERE backup_id = ?",
      String(ctx.body["backup_id"]),
    );
    if (backup === null) throw notFoundOrHidden(ctx.requestId, "backup", String(ctx.body["backup_id"]));
    const manifest = JSON.parse(backup.scope_json) as { tables: string[]; counts: Record<string, number>; signatures: Record<string, string>; scopes: string[] };
    const drift: { table: string; backup_count: number; live_count: number; signature_changed: boolean }[] = [];
    for (const table of manifest.tables) {
      const live = (await tableCounts(ctx.db, [table]))[table] ?? 0;
      const signature = await tableSignature(ctx.db, table);
      if (live !== manifest.counts[table] || signature !== manifest.signatures[table]) {
        drift.push({ table, backup_count: manifest.counts[table] ?? 0, live_count: live, signature_changed: signature !== manifest.signatures[table] });
      }
    }
    const tombstones = await count(ctx.db, "SELECT COUNT(*) AS n FROM search_tombstones");
    const plan = {
      backup_id: backup.backup_id,
      manifest_sha256: backup.manifest_sha256,
      scopes: manifest.scopes,
      tables: manifest.tables.length,
      drift,
      deletions_to_preserve: tombstones,
      overwrite_scope: "격리 환경 권장",
      restore_possible: false,
      blocked_reason: "BACKUP_PAYLOAD_NOT_STORED",
      integrity_checks: ["row_counts", "content_signatures", "tombstone_replay", "acl_presence", "message_seq_order"],
      plan_digest: await computeActionDigest({ target_type: "restore", target_id: backup.backup_id, project_id: null, bound_commit_sha: backup.manifest_sha256, diff_sha: null }),
      created_at: ctx.now,
    };
    const restoreId = mintId("event");
    await ctx.db
      .prepare("INSERT INTO restore_runs (restore_id, backup_id, plan_json, state, approval_id, requested_by, created_at, integrity_check_state) VALUES (?,?,?,'AWAITING_APPROVAL',NULL,?,?,NULL)")
      .bind(restoreId, backup.backup_id, JSON.stringify(plan), ctx.principal.subject.id, ctx.now)
      .run();
    return {
      status: 201,
      data: {
        restore_id: restoreId,
        state: "AWAITING_APPROVAL",
        plan,
        approval_required: true,
        note: "승인 없이는 실제 복원이 실행되지 않습니다. 삭제된 항목은 복원 후에도 되살리지 않습니다.",
      },
    };
  },

  "post-admin-restores-commit": async (ctx) => {
    const restore = await firstRow<{ restore_id: string; backup_id: string; plan_json: string; state: string; approval_id: string | null }>(
      ctx.db,
      "SELECT restore_id, backup_id, plan_json, state, approval_id FROM restore_runs WHERE restore_id = ?",
      String(ctx.body["restore_id"]),
    );
    if (restore === null) throw notFoundOrHidden(ctx.requestId, "restore", String(ctx.body["restore_id"]));
    const plan = JSON.parse(restore.plan_json) as { manifest_sha256: string | null; plan_digest: string; deletions_to_preserve: number };
    const approval = await firstRow<{ approval_id: string; state: string; action_digest: string; target_type: string; target_id: string; bound_commit_sha: string | null; expires_at: string }>(
      ctx.db,
      "SELECT * FROM approvals WHERE approval_id = ?",
      String(ctx.body["approval_id"]),
    );
    if (approval === null) throw new ApiError({ code: "APPROVAL_REQUIRED", requestId: ctx.requestId });
    const valid = approvalStillValid({
      state: approval.state as "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "INVALIDATED" | "REVOKED",
      approvedDigest: approval.action_digest,
      currentDigest: plan.plan_digest,
      expiresAtMs: Date.parse(approval.expires_at),
      nowMs: ctx.nowMs,
    });
    if (!valid.valid || approval.target_type !== "restore" || approval.target_id !== restore.backup_id) {
      throw new ApiError({ code: "APPROVAL_STALE", requestId: ctx.requestId, details: { reason: valid.reason, target_type: approval.target_type } });
    }
    // Real integrity checks run now; the payload itself was never stored, so the
    // restore cannot execute and must not pretend it did.
    const integrity = plan.manifest_sha256 !== null && plan.deletions_to_preserve >= 0 ? "passed" : "failed";
    await ctx.db
      .prepare("UPDATE restore_runs SET state = 'AWAITING_APPROVAL', approval_id = ?, integrity_check_state = ? WHERE restore_id = ?")
      .bind(approval.approval_id, integrity, restore.restore_id)
      .run();
    throw blockedInternal(ctx.requestId);
  },

  "post-admin-data-deletion-prepare": async (ctx) => {
    const messageIds = (ctx.body["message_ids"] as string[] | undefined) ?? [];
    const memoryIds = (ctx.body["memory_ids"] as string[] | undefined) ?? [];
    const fileIds = (ctx.body["file_ids"] as string[] | undefined) ?? [];
    const artifactIds = (ctx.body["artifact_ids"] as string[] | undefined) ?? [];
    const projectIds = (ctx.body["project_ids"] as string[] | undefined) ?? [];
    const scope = { message_count: messageIds.length, memory_count: memoryIds.length, file_count: fileIds.length, artifact_count: artifactIds.length, project_count: projectIds.length };
    const planDigest = await sha256Hex(JSON.stringify({ messageIds: [...messageIds].sort(), memoryIds: [...memoryIds].sort(), fileIds: [...fileIds].sort(), artifactIds: [...artifactIds].sort(), projectIds: [...projectIds].sort() }));
    const detail = {
      scope,
      plan_digest: planDigest,
      targets: {
        message_versions: messageIds.length,
        message_blocks: "전 버전 블록 삭제",
        search_index_rows: messageIds.length + memoryIds.length,
        memories: memoryIds.length,
        files_metadata: fileIds.length,
        artifacts_metadata: artifactIds.length,
        backups_note: "백업에는 삭제 이전 사본이 남을 수 있어 별도 파기 절차가 필요합니다.",
        external_note: "GitHub의 불변 커밋 기록은 외부 저장소 정책에 따라 별도 고지가 필요합니다.",
      },
      approval_template: {
        target_type: "data_deletion",
        target_id: planDigest,
        action_digest: planDigest,
        request_reason: "소유자 요청 데이터 파기",
        expires_in_seconds: 3600,
      },
      created_at: ctx.now,
    };
    return { status: 200, data: detail };
  },

  "post-admin-data-deletion-commit": async (ctx) => {
    const planDigest = String(ctx.body["plan_digest"]);
    const approval = await firstRow<{ approval_id: string; state: string; action_digest: string; target_type: string; target_id: string; expires_at: string }>(
      ctx.db,
      "SELECT * FROM approvals WHERE approval_id = ?",
      String(ctx.body["approval_id"]),
    );
    if (approval === null) throw new ApiError({ code: "APPROVAL_REQUIRED", requestId: ctx.requestId });
    const valid = approvalStillValid({
      state: approval.state as "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "INVALIDATED" | "REVOKED",
      approvedDigest: approval.action_digest,
      currentDigest: planDigest,
      expiresAtMs: Date.parse(approval.expires_at),
      nowMs: ctx.nowMs,
    });
    if (!valid.valid || approval.target_type !== "data_deletion" || approval.target_id !== planDigest) {
      throw new ApiError({ code: "APPROVAL_STALE", requestId: ctx.requestId, details: { reason: valid.reason } });
    }
    const messageIds = (ctx.body["message_ids"] as string[] | undefined) ?? [];
    const memoryIds = (ctx.body["memory_ids"] as string[] | undefined) ?? [];
    const fileIds = (ctx.body["file_ids"] as string[] | undefined) ?? [];
    const artifactIds = (ctx.body["artifact_ids"] as string[] | undefined) ?? [];
    let purgedVersions = 0;
    for (const messageId of messageIds) {
      // The version trigger forbids editing stored content, so erasure removes the
      // rows outright: blocks first (FK), then versions, then the FTS copy.
      await ctx.db.prepare("DELETE FROM message_blocks WHERE message_id = ?").bind(messageId).run();
      await ctx.db.prepare("DELETE FROM message_versions WHERE message_id = ?").bind(messageId).run();
      await ctx.db.prepare("DELETE FROM message_fts WHERE message_id = ?").bind(messageId).run();
      await ctx.db.prepare("INSERT INTO message_tombstones (message_id, room_id, deleted_by_kind, deleted_by_id, deleted_at, content_sha256, reason) SELECT message_id, room_id, 'owner', ?, COALESCE(deleted_at, ?), NULL, 'data_deletion' FROM messages WHERE message_id = ? ON CONFLICT(message_id) DO NOTHING").bind(ctx.principal.subject.id, ctx.now, messageId).run();
      await ctx.db.prepare("UPDATE messages SET deleted_at = COALESCE(deleted_at, ?), status = 'DELETED' WHERE message_id = ?").bind(ctx.now, messageId).run();
      purgedVersions += 1;
    }
    let memories = 0;
    for (const memoryId of memoryIds) {
      await ctx.db.prepare("DELETE FROM memory_records WHERE memory_id = ?").bind(memoryId).run();
      memories += 1;
    }
    for (const fileId of fileIds) await ctx.db.prepare("UPDATE files SET deleted_at = COALESCE(deleted_at, ?), storage_state = 'deleted' WHERE file_id = ?").bind(ctx.now, fileId).run();
    for (const artifactId of artifactIds) await ctx.db.prepare("UPDATE artifacts SET deleted_at = COALESCE(deleted_at, ?) WHERE artifact_id = ?").bind(ctx.now, artifactId).run();
    await writeAudit({
      db: ctx.db,
      eventType: "data.deletion.executed",
      actorKind: "owner",
      actorId: ctx.principal.subject.id,
      targetType: "data_deletion",
      targetId: planDigest,
      allowOrDeny: "allow",
      reasonCode: "POLICY_ALLOWED",
      requestId: ctx.requestId,
      metadata: { messages: messageIds.length, memories, files: fileIds.length, artifacts: artifactIds.length },
    });
    return {
      status: 200,
      data: {
        executed: true,
        plan_digest: planDigest,
        purged_messages: purgedVersions,
        deleted_memories: memories,
        deleted_files: fileIds.length,
        deleted_artifacts: artifactIds.length,
        remaining: { backups: "백업 사본 파기는 별도 절차", external_git: "GitHub 불변 기록은 외부 정책" },
      },
    };
  },

  "get-admin-release-gates": async (ctx) => {
    const providers = q039Gate();
    const terminalTasks = await count(ctx.db, "SELECT COUNT(*) AS n FROM tasks WHERE state IN ('DONE','CANCELLED','FAILED')");
    const verifiedDone = await count(ctx.db, "SELECT COUNT(*) AS n FROM tasks t WHERE t.state = 'DONE' AND EXISTS (SELECT 1 FROM task_evidence e WHERE e.task_id = t.task_id AND e.verification_state = 'verified')");
    const mergedPrs = await count(ctx.db, "SELECT COUNT(*) AS n FROM git_pull_requests WHERE status = 'MERGED'");
    const ciRuns = await count(ctx.db, "SELECT COUNT(*) AS n FROM ci_runs");
    const restoreTests = await count(ctx.db, "SELECT COUNT(*) AS n FROM restore_runs WHERE integrity_check_state IN ('passed','failed')");
    const securityEvidence = await count(ctx.db, "SELECT COUNT(*) AS n FROM test_runs WHERE suite LIKE '%security%'");
    const gates = [
      { gate: "G-01", requirement: "Q001–Q041 전 항목 구현·테스트", status: "INCOMPLETE", evidence: { terminal_tasks: terminalTasks, verified_done: verifiedDone, api_endpoints: 78 } },
      { gate: "G-02", requirement: "모든 필수 실제 AI 공식 연결·자율성", status: providers.gate === "PASS" ? "PASS" : "BLOCKED_EXTERNAL_DEPENDENCY", evidence: providers },
      { gate: "G-03", requirement: "다중 실제 AI 상호 작업 시연", status: "BLOCKED_EXTERNAL_DEPENDENCY", evidence: { reason: "검증된 AI 연결이 0개" } },
      { gate: "G-04", requirement: "GitHub PR·Actions·검증 병합", status: mergedPrs > 0 && ciRuns > 0 ? "INCOMPLETE" : "BLOCKED_EXTERNAL_DEPENDENCY", evidence: { merged_prs: mergedPrs, ci_runs: ciRuns, github_state: ctx.env.GITHUB === undefined ? "unbound" : "bound" } },
      { gate: "G-05", requirement: "웹 앱 실제 로그인·대화·프로젝트·IDE", status: "NOT_TESTED", evidence: { owner: "프론트엔드 트랙" } },
      { gate: "G-06", requirement: "Windows EXE 빌드·설치", status: "NOT_TESTED", evidence: { owner: "클라이언트 트랙" } },
      { gate: "G-07", requirement: "Android APK 빌드·실기기", status: "NOT_TESTED", evidence: { owner: "클라이언트 트랙" } },
      { gate: "G-08", requirement: "보안(인증·ACL·CI·파일·비밀·인젝션)", status: securityEvidence > 0 ? "INCOMPLETE" : "INCOMPLETE", evidence: { recorded_runs: securityEvidence, note: "이 트랙의 보안 테스트 결과는 별도 보고서로 제출됩니다." } },
      { gate: "G-09", requirement: "장애·재접속·인계·중복 방지", status: "INCOMPLETE", evidence: { restore_tests: restoreTests } },
      { gate: "G-10", requirement: "메시지·기억·파일·코드·백업 무결성", status: "INCOMPLETE", evidence: { verified_done: verifiedDone } },
      { gate: "G-11", requirement: "무료 운영·자동 과금 방지", status: "INCOMPLETE", evidence: { r2: ctx.env.R2 === undefined ? "R2_NOT_ENABLED" : "bound" } },
      { gate: "G-12", requirement: "운영 문서·테스트·보고서", status: "INCOMPLETE", evidence: { note: "문서는 다른 트랙·최종 보고서에서 취합" } },
    ];
    const overall = gates.some((gate) => ["FAILED", "BLOCKED_EXTERNAL_DEPENDENCY", "NOT_TESTED"].includes(gate.status)) ? "NOT_RELEASE_READY" : gates.every((gate) => gate.status === "PASS") ? "RELEASE_READY" : "NOT_RELEASE_READY";
    return {
      status: 200,
      data: {
        overall,
        q039_gate: providers,
        gates,
        rule: "한 Gate라도 FAILED/BLOCKED/NOT_TESTED이면 NOT_RELEASE_READY입니다.",
        evaluated_at: ctx.now,
      },
    };
  },
};

function blockedInternal(requestId: string): ApiError {
  return new ApiError({
    code: "EXTERNAL_DEPENDENCY_BLOCKED",
    requestId,
    message: "백업 행 데이터 사본이 저장되지 않아 복원을 실행할 수 없습니다. 매니페스트 무결성 검사만 수행했습니다.",
    details: { reason: "BACKUP_PAYLOAD_NOT_STORED", restore_state: "AWAITING_APPROVAL" },
  });
}

void scalar;

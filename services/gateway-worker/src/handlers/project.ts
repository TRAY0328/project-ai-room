/**
 * Projects, tasks, memory and dashboard — catalog group "프로젝트·기억·작업" (17 of 78).
 *
 * The task engine refuses three lies here:
 *   1. a transition that the 18-state machine does not allow (409 + audit);
 *   2. DONE without verified evidence (the DB trigger is the second lock);
 *   3. a late result from an expired lease (fencing generation must match).
 * A handoff stops the old attempt first and only then grants the new one.
 */
import { ApiError, evaluateTaskTransition, mintId, type TaskState } from "@ai-room/contracts";
import { allRows, count, firstRow, sha256Hex, scalar } from "@ai-room/auth";
import { MemoryService } from "@ai-room/memory";
import { computeMetrics, metricSummary, recordProjectMetric } from "@ai-room/telemetry";
import type { Handler } from "../domain.js";
import {
  getProject,
  getRoom,
  notFoundOrHidden,
  optionalString,
  recordProjectEvent,
} from "../domain.js";

const TASK_WEIGHT: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

async function getTask(ctx: Parameters<Handler>[0], taskId: string): Promise<{ task_id: string; project_id: string; title: string; description: string; state: TaskState; owner_agent_id: string | null; revision: number; risk_level: string; created_at: string; updated_at: string }> {
  const task = await firstRow<{ task_id: string; project_id: string; title: string; description: string; state: TaskState; owner_agent_id: string | null; revision: number; risk_level: string; created_at: string; updated_at: string }>(
    ctx.db,
    "SELECT task_id, project_id, title, description, state, owner_agent_id, revision, risk_level, created_at, updated_at FROM tasks WHERE task_id = ? AND deleted_at IS NULL",
    taskId,
  );
  if (task === null) throw notFoundOrHidden(ctx.requestId, "task", taskId);
  await getProject(ctx.db, task.project_id, ctx.principal, ctx.requestId);
  return task;
}

async function dependenciesDone(ctx: Parameters<Handler>[0], taskId: string): Promise<boolean> {
  const pending = await count(
    ctx.db,
    `SELECT COUNT(*) AS n FROM task_dependencies d JOIN tasks t ON t.task_id = d.depends_on_task_id
     WHERE d.task_id = ? AND t.state <> 'DONE'`,
    taskId,
  );
  return pending === 0;
}

async function detectCycle(ctx: Parameters<Handler>[0], taskId: string, dependencyIds: readonly string[], projectId: string): Promise<string[]> {
  const cycles: string[] = [];
  for (const dependencyId of dependencyIds) {
    if (dependencyId === taskId) {
      cycles.push(dependencyId);
      continue;
    }
    const rows = await allRows<{ depends_on_task_id: string }>(
      ctx.db,
      `WITH RECURSIVE chain(id) AS (
         SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
         UNION
         SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain c ON d.task_id = c.id
       ) SELECT id AS depends_on_task_id FROM chain`,
      dependencyId,
    );
    if (rows.some((row) => row.depends_on_task_id === taskId)) cycles.push(dependencyId);
  }
  const foreign = await allRows<{ task_id: string; project_id: string }>(
    ctx.db,
    `SELECT task_id, project_id FROM tasks WHERE task_id IN (${dependencyIds.map(() => "?").join(",") || "''"})`,
    ...dependencyIds,
  );
  for (const dep of foreign) if (dep.project_id !== projectId) cycles.push(dep.task_id);
  return cycles;
}

export const projectHandlers: Record<string, Handler> = {
  "get-projects": async (ctx) => {
    const rows =
      ctx.principal.subject.kind === "owner"
        ? await allRows<{ project_id: string; name: string; description: string; status: string; revision: number; created_at: string; updated_at: string }>(
            ctx.db,
            "SELECT project_id, name, description, status, revision, created_at, updated_at FROM projects WHERE deleted_at IS NULL AND status <> 'deleted' ORDER BY updated_at DESC",
          )
        : await allRows<{ project_id: string; name: string; description: string; status: string; revision: number; created_at: string; updated_at: string }>(
            ctx.db,
            `SELECT p.project_id, p.name, p.description, p.status, p.revision, p.created_at, p.updated_at
             FROM projects p JOIN project_acl a ON a.project_id = p.project_id
             WHERE a.actor_kind = 'agent' AND a.actor_id = ? AND a.revoked_at IS NULL
               AND p.deleted_at IS NULL AND p.status <> 'deleted' ORDER BY p.updated_at DESC`,
            ctx.principal.subject.id,
          );
    const items = [];
    for (const row of rows) {
      const total = await count(ctx.db, "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND deleted_at IS NULL", row.project_id);
      const done = await count(
        ctx.db,
        `SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND t.state = 'DONE' AND t.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM task_evidence e WHERE e.task_id = t.task_id AND e.verification_state = 'verified')`,
        row.project_id,
      );
      items.push({ ...row, role: ctx.principal.roles.projects.get(row.project_id) ?? (ctx.principal.subject.kind === "owner" ? "owner" : "viewer"), tasks_total: total, tasks_verified_done: done });
    }
    return { status: 200, data: { items } };
  },

  "post-projects": async (ctx) => {
    const projectId = mintId("project");
    const now = ctx.now;
    const name = String(ctx.body["name"]);
    const description = String(ctx.body["description"] ?? "");
    await ctx.db
      .prepare("INSERT INTO projects (project_id, name, description, status, revision, created_at, updated_at) VALUES (?,?,?,'active',1,?,?)")
      .bind(projectId, name, description, now, now)
      .run();
    await ctx.db
      .prepare("INSERT INTO project_acl (project_id, actor_kind, actor_id, role, granted_by, granted_at) VALUES (?,?,?,'owner',?,?)")
      .bind(projectId, ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, ctx.principal.subject.id, now)
      .run();
    const roomIds = (ctx.body["room_ids"] as string[] | undefined) ?? [];
    for (const roomId of roomIds) {
      await getRoom(ctx.db, roomId, ctx.principal, ctx.requestId);
      await ctx.db
        .prepare("INSERT OR IGNORE INTO project_room_links (project_id, room_id, linked_at, linked_by) VALUES (?,?,?,?)")
        .bind(projectId, roomId, now, ctx.principal.subject.id)
        .run();
    }
    await recordProjectEvent({
      db: ctx.db,
      projectId,
      eventType: "project.created",
      aggregateType: "project",
      aggregateId: projectId,
      subject: ctx.principal.subject,
      payload: { name, room_ids: roomIds },
    });
    return { status: 201, data: { project_id: projectId, name, description, status: "active", revision: 1, created_at: now, linked_room_ids: roomIds } };
  },

  "get-projects-by-projectId": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const rooms = await allRows<{ room_id: string }>(ctx.db, "SELECT room_id FROM project_room_links WHERE project_id = ?", project.project_id);
    const memberCount = await count(ctx.db, "SELECT COUNT(*) AS n FROM project_acl WHERE project_id = ? AND revoked_at IS NULL", project.project_id);
    const tasksByState = await allRows<{ state: string; n: number }>(ctx.db, "SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? AND deleted_at IS NULL GROUP BY state", project.project_id);
    return {
      status: 200,
      data: {
        ...project,
        role: ctx.principal.roles.projects.get(project.project_id) ?? (ctx.principal.subject.kind === "owner" ? "owner" : "viewer"),
        room_ids: rooms.map((row) => row.room_id),
        member_count: memberCount,
        task_states: Object.fromEntries(tasksByState.map((row) => [row.state, row.n])),
      },
    };
  },

  "patch-projects-by-projectId": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const expected = Number(ctx.body["expected_revision"]);
    if (expected !== project.revision) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { current_revision: project.revision } });
    }
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const field of ["name", "description", "status"] as const) {
      const value = ctx.body[field];
      if (typeof value === "string") {
        assignments.push(`${field} = ?`);
        values.push(value);
      }
    }
    if (assignments.length === 0) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "변경할 필드가 없습니다.", details: {} });
    }
    const result = await ctx.db
      .prepare(`UPDATE projects SET ${assignments.join(", ")}, revision = revision + 1, updated_at = ? WHERE project_id = ? AND revision = ?`)
      .bind(...values, ctx.now, project.project_id, expected)
      .run();
    if (Number(result.meta?.["changes"] ?? 0) === 0) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { current_revision: project.revision } });
    }
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "project.updated",
      aggregateType: "project",
      aggregateId: project.project_id,
      subject: ctx.principal.subject,
      payload: { fields: Object.keys(ctx.body).filter((key) => key !== "expected_revision") },
    });
    return { status: 200, data: { project_id: project.project_id, revision: expected + 1, updated_at: ctx.now } };
  },

  "post-projects-by-projectId-rooms-link": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const room = await getRoom(ctx.db, String(ctx.body["room_id"]), ctx.principal, ctx.requestId);
    await ctx.db
      .prepare("INSERT OR IGNORE INTO project_room_links (project_id, room_id, linked_at, linked_by) VALUES (?,?,?,?)")
      .bind(project.project_id, room.room_id, ctx.now, ctx.principal.subject.id)
      .run();
    return { status: 200, data: { project_id: project.project_id, room_id: room.room_id, linked: true, linked_at: ctx.now } };
  },

  "get-projects-by-projectId-tasks": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const rows = await allRows<{
      task_id: string;
      title: string;
      description: string;
      state: string;
      owner_agent_id: string | null;
      revision: number;
      risk_level: string;
      created_at: string;
      updated_at: string;
    }>(
      ctx.db,
      "SELECT task_id, title, description, state, owner_agent_id, revision, risk_level, created_at, updated_at FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
      project.project_id,
    );
    const edges = await allRows<{ task_id: string; depends_on_task_id: string }>(
      ctx.db,
      `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d JOIN tasks t ON t.task_id = d.task_id WHERE t.project_id = ?`,
      project.project_id,
    );
    const evidence = await allRows<{ task_id: string; n: number }>(
      ctx.db,
      `SELECT e.task_id, COUNT(*) AS n FROM task_evidence e JOIN tasks t ON t.task_id = e.task_id
       WHERE t.project_id = ? AND e.verification_state = 'verified' GROUP BY e.task_id`,
      project.project_id,
    );
    const evidenceByTask = new Map(evidence.map((row) => [row.task_id, row.n]));
    return {
      status: 200,
      data: {
        project_id: project.project_id,
        items: rows.map((row) => ({
          ...row,
          verified_evidence: evidenceByTask.get(row.task_id) ?? 0,
          dependencies: edges.filter((edge) => edge.task_id === row.task_id).map((edge) => edge.depends_on_task_id),
        })),
        graph: { edges: edges.map((edge) => ({ from: edge.depends_on_task_id, to: edge.task_id })) },
      },
    };
  },

  "post-projects-by-projectId-tasks": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const taskId = mintId("task");
    const now = ctx.now;
    const dependencies = (ctx.body["dependencies"] as string[] | undefined) ?? [];
    if (dependencies.length > 0) {
      const known = await allRows<{ task_id: string; project_id: string }>(
        ctx.db,
        `SELECT task_id, project_id FROM tasks WHERE task_id IN (${dependencies.map(() => "?").join(",")}) AND deleted_at IS NULL`,
        ...dependencies,
      );
      const missing = dependencies.filter((id) => !known.some((row) => row.task_id === id));
      const foreign = known.filter((row) => row.project_id !== project.project_id);
      if (missing.length > 0 || foreign.length > 0) {
        throw new ApiError({
          code: "VALIDATION_FAILED",
          requestId: ctx.requestId,
          message: "의존 작업은 같은 프로젝트의 기존 작업이어야 합니다.",
          details: { missing, foreign_project: foreign.map((row) => row.task_id) },
        });
      }
    }
    const cycles = await detectCycle(ctx, taskId, dependencies, project.project_id);
    if (cycles.length > 0) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "의존성 순환이 있습니다.", details: { cycle: [...new Set(cycles)] } });
    }
    const meta = {
      requirements: ctx.body["requirements"] ?? [],
      acceptance_criteria: ctx.body["acceptance_criteria"] ?? [],
      repo_ref: ctx.body["repo_ref"] ?? null,
      base_sha: ctx.body["base_sha"] ?? null,
    };
    const description = `${String(ctx.body["description"] ?? "")}\n\n<!-- structured\n${JSON.stringify(meta)}\n-->`.slice(0, 20_000);
    await ctx.db
      .prepare(
        "INSERT INTO tasks (task_id, project_id, title, description, state, owner_agent_id, revision, risk_level, created_at, updated_at) VALUES (?,?,?,?,'PROPOSED',?,1,?,?,?)",
      )
      .bind(taskId, project.project_id, String(ctx.body["title"]), description, optionalString(ctx.body, "owner_agent_id"), String(ctx.body["risk_level"] ?? "low"), now, now)
      .run();
    for (const dependencyId of dependencies) {
      await ctx.db
        .prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?,?,?)")
        .bind(taskId, dependencyId, now)
        .run();
    }
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "task.created",
      aggregateType: "task",
      aggregateId: taskId,
      subject: ctx.principal.subject,
      payload: { title: ctx.body["title"], dependencies, risk_level: ctx.body["risk_level"] ?? "low" },
    });
    return { status: 201, data: { task_id: taskId, project_id: project.project_id, state: "PROPOSED", revision: 1, dependencies, created_at: now } };
  },

  "post-tasks-by-taskId-claim-proposals": async (ctx) => {
    const task = await getTask(ctx, ctx.params["taskId"] ?? "");
    if (ctx.principal.subject.kind !== "agent") {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, details: { reason_code: "AGENT_ONLY" } });
    }
    if (!["OPEN_FOR_CLAIM", "SPECIFIED", "CLAIM_PROPOSED"].includes(task.state)) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { state: task.state, reason: "NOT_CLAIMABLE" } });
    }
    const evidenceIds = ctx.body["evidence_message_ids"] as string[];
    const evidence = await allRows<{ message_id: string; author_id: string }>(ctx.db, `SELECT message_id, author_id FROM messages WHERE message_id IN (${evidenceIds.map(() => "?").join(",")}) AND deleted_at IS NULL`, ...evidenceIds);
    if (evidence.length !== evidenceIds.length || evidence.some((row) => row.author_id !== ctx.principal.subject.id)) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "근거 메시지는 본인이 작성한 실제 메시지여야 합니다.", details: { field: "evidence_message_ids" } });
    }
    const eventId = await recordProjectEvent({
      db: ctx.db,
      projectId: task.project_id,
      eventType: "task.claim.proposed",
      aggregateType: "task",
      aggregateId: task.task_id,
      subject: ctx.principal.subject,
      payload: { agent_id: ctx.principal.subject.id, evidence_message_ids: evidenceIds, reason: ctx.body["reason"] },
    });
    if (task.state === "OPEN_FOR_CLAIM" || task.state === "SPECIFIED") {
      await ctx.db
        .prepare("UPDATE tasks SET state = 'CLAIM_PROPOSED', revision = revision + 1, updated_at = ? WHERE task_id = ? AND revision = ?")
        .bind(ctx.now, task.task_id, task.revision)
        .run();
    }
    return { status: 201, data: { task_id: task.task_id, proposal_event_id: eventId, state: "CLAIM_PROPOSED", evidence_message_ids: evidenceIds } };
  },

  "post-tasks-by-taskId-claims-accept": async (ctx) => {
    const task = await getTask(ctx, ctx.params["taskId"] ?? "");
    const proposal = await firstRow<{ event_id: string; payload_json: string; actor_id: string }>(
      ctx.db,
      "SELECT event_id, payload_json, actor_id FROM project_events WHERE event_id = ? AND event_type = 'task.claim.proposed' AND aggregate_id = ?",
      String(ctx.body["proposal_event_id"]),
      task.task_id,
    );
    if (proposal === null) {
      throw new ApiError({ code: "VALIDATION_FAILED", requestId: ctx.requestId, message: "이 작업의 제안 이벤트가 아닙니다.", details: { field: "proposal_event_id" } });
    }
    if (ctx.principal.subject.kind === "agent" && proposal.actor_id === ctx.principal.subject.id) {
      throw new ApiError({ code: "PERMISSION_DENIED", requestId: ctx.requestId, message: "자신의 제안을 스스로 수락할 수 없습니다.", details: { reason_code: "SELF_ACCEPT_FORBIDDEN" } });
    }
    if (!["CLAIM_PROPOSED", "OPEN_FOR_CLAIM"].includes(task.state)) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { state: task.state } });
    }
    const payload = JSON.parse(proposal.payload_json) as { agent_id: string };
    const now = ctx.now;
    const attemptId = mintId("attempt");
    await ctx.db
      .prepare("INSERT INTO task_attempts (attempt_id, task_id, assigned_agent_id, lease_until, fencing_generation, status, started_at) VALUES (?,?,?,?,1,'GRANTED',?)")
      .bind(attemptId, task.task_id, payload.agent_id, new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(), now)
      .run();
    await ctx.db
      .prepare("UPDATE tasks SET state = 'CLAIM_ACCEPTED', owner_agent_id = ?, revision = revision + 1, updated_at = ? WHERE task_id = ? AND revision = ?")
      .bind(payload.agent_id, now, task.task_id, task.revision)
      .run();
    await recordProjectEvent({
      db: ctx.db,
      projectId: task.project_id,
      eventType: "task.claimed",
      aggregateType: "task",
      aggregateId: task.task_id,
      subject: ctx.principal.subject,
      payload: { assigned_agent_id: payload.agent_id, attempt_id: attemptId, evidence_message_ids: ctx.body["evidence_message_ids"], proposal_event_id: proposal.event_id },
    });
    return { status: 200, data: { task_id: task.task_id, state: "CLAIM_ACCEPTED", owner_agent_id: payload.agent_id, attempt_id: attemptId, fencing_generation: 1 } };
  },

  "post-tasks-by-taskId-transition": async (ctx) => {
    const task = await getTask(ctx, ctx.params["taskId"] ?? "");
    const expected = Number(ctx.body["expected_revision"]);
    if (expected !== task.revision) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { current_revision: task.revision } });
    }
    const toState = ctx.body["to_state"] as TaskState;
    const evidenceIds = (ctx.body["evidence_ids"] as string[] | undefined) ?? [];
    const verifiedEvidence = evidenceIds.length > 0
      ? await count(ctx.db, `SELECT COUNT(*) AS n FROM task_evidence WHERE task_id = ? AND verification_state = 'verified' AND evidence_id IN (${evidenceIds.map(() => "?").join(",")})`, task.task_id, ...evidenceIds)
      : await count(ctx.db, "SELECT COUNT(*) AS n FROM task_evidence WHERE task_id = ? AND verification_state = 'verified'", task.task_id);
    const attemptId = optionalString(ctx.body, "attempt_id");
    const fencing = typeof ctx.body["fencing_generation"] === "number" ? ctx.body["fencing_generation"] : null;
    const attempt = attemptId !== null
      ? await firstRow<{ attempt_id: string; fencing_generation: number; status: string; lease_until: string | null }>(ctx.db, "SELECT attempt_id, fencing_generation, status, lease_until FROM task_attempts WHERE attempt_id = ? AND task_id = ?", attemptId, task.task_id)
      : await firstRow<{ attempt_id: string; fencing_generation: number; status: string; lease_until: string | null }>(
          ctx.db,
          "SELECT attempt_id, fencing_generation, status, lease_until FROM task_attempts WHERE task_id = ? ORDER BY fencing_generation DESC LIMIT 1",
          task.task_id,
        );
    const holdsLease =
      attempt !== null &&
      ["GRANTED", "RUNNING"].includes(attempt.status) &&
      attempt.lease_until !== null &&
      Date.parse(attempt.lease_until) > ctx.nowMs &&
      (fencing === null || fencing === attempt.fencing_generation);
    const depsDone = await dependenciesDone(ctx, task.task_id);
    const verdict = evaluateTaskTransition({
      from: task.state,
      to: toState,
      hasVerifiedEvidence: verifiedEvidence > 0,
      dependenciesDone: depsDone,
      holdsCurrentLease: holdsLease,
    });
    if (!verdict.ok) {
      await ctx.auth.audit("task.transition.rejected", ctx.principal.subject.kind === "owner" ? "owner" : "agent", ctx.principal.subject.id, "task", task.task_id, "deny", ctx.requestId, {
        from: task.state,
        to: toState,
        code: verdict.code,
      });
      const code = verdict.code === "TASK_DONE_REQUIRES_EVIDENCE" ? "TEST_NOT_RUN" : "REVISION_CONFLICT";
      throw new ApiError({ code, requestId: ctx.requestId, details: { reason_code: verdict.code, detail: verdict.detail } });
    }
    const now = ctx.now;
    const updated = await ctx.db
      .prepare("UPDATE tasks SET state = ?, revision = revision + 1, updated_at = ? WHERE task_id = ? AND revision = ?")
      .bind(toState, now, task.task_id, expected)
      .run();
    if (Number(updated.meta?.["changes"] ?? 0) === 0) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { current_revision: task.revision } });
    }
    if (attempt !== null) {
      if (toState === "RUNNING") {
        await ctx.db.prepare("UPDATE task_attempts SET status = 'RUNNING', started_at = COALESCE(started_at, ?) WHERE attempt_id = ?").bind(now, attempt.attempt_id).run();
      } else if (toState === "DONE") {
        await ctx.db.prepare("UPDATE task_attempts SET status = 'SUCCEEDED', ended_at = ? WHERE attempt_id = ?").bind(now, attempt.attempt_id).run();
      } else if (toState === "FAILED") {
        await ctx.db.prepare("UPDATE task_attempts SET status = 'FAILED', ended_at = ? WHERE attempt_id = ?").bind(now, attempt.attempt_id).run();
      }
    }
    await recordProjectEvent({
      db: ctx.db,
      projectId: task.project_id,
      eventType: toState === "DONE" ? "task.completed" : "task.status.changed",
      aggregateType: "task",
      aggregateId: task.task_id,
      subject: ctx.principal.subject,
      payload: { from: task.state, to: toState, evidence_ids: evidenceIds, attempt_id: attempt?.attempt_id ?? null, fencing_generation: attempt?.fencing_generation ?? null },
    });
    if (toState === "DONE") {
      await recordProjectMetric(ctx.db, { projectId: task.project_id, key: "task_cycle_hours", value: Math.round(((Date.parse(now) - Date.parse(task.created_at)) / 3_600_000) * 100) / 100, unit: "hours", periodStart: ctx.now.slice(0, 10) + "T00:00:00.000Z" });
    }
    return {
      status: 200,
      data: {
        task_id: task.task_id,
        from: task.state,
        state: toState,
        revision: expected + 1,
        verified_evidence: verifiedEvidence,
        attempt: attempt === null ? null : { attempt_id: attempt.attempt_id, fencing_generation: attempt.fencing_generation },
      },
    };
  },

  "post-tasks-by-taskId-handoff": async (ctx) => {
    const task = await getTask(ctx, ctx.params["taskId"] ?? "");
    const toAgentId = String(ctx.body["to_agent_id"]);
    const target = await firstRow<{ agent_id: string; disabled_at: string | null }>(ctx.db, "SELECT agent_id, disabled_at FROM agents WHERE agent_id = ?", toAgentId);
    if (target === null || target.disabled_at !== null) throw notFoundOrHidden(ctx.requestId, "agent", toAgentId);
    const checkpointId = optionalString(ctx.body, "checkpoint_id");
    const checkpoint = checkpointId !== null
      ? await firstRow<{ checkpoint_id: string; valid_until: string | null }>(ctx.db, "SELECT checkpoint_id, valid_until FROM task_checkpoints WHERE checkpoint_id = ? AND task_id = ?", checkpointId, task.task_id)
      : await firstRow<{ checkpoint_id: string; valid_until: string | null }>(ctx.db, "SELECT checkpoint_id, valid_until FROM task_checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", task.task_id);
    if (checkpoint === null) {
      throw new ApiError({
        code: "REVISION_CONFLICT",
        requestId: ctx.requestId,
        message: "체크포인트 없이는 인계할 수 없습니다.",
        details: { reason_code: "CHECKPOINT_REQUIRED" },
      });
    }
    if (checkpoint.valid_until !== null && Date.parse(checkpoint.valid_until) <= ctx.nowMs) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { reason_code: "CHECKPOINT_EXPIRED" } });
    }
    const current = await firstRow<{ attempt_id: string; fencing_generation: number }>(
      ctx.db,
      "SELECT attempt_id, fencing_generation FROM task_attempts WHERE task_id = ? ORDER BY fencing_generation DESC LIMIT 1",
      task.task_id,
    );
    const nextGeneration = (current?.fencing_generation ?? 0) + 1;
    const now = ctx.now;
    if (current !== null) {
      await ctx.db.prepare("UPDATE task_attempts SET status = 'SUPERSEDED', ended_at = ? WHERE attempt_id = ?").bind(now, current.attempt_id).run();
    }
    const newAttempt = mintId("attempt");
    await ctx.db
      .prepare("INSERT INTO task_attempts (attempt_id, task_id, assigned_agent_id, lease_until, fencing_generation, status, started_at) VALUES (?,?,?,?,?,'GRANTED',?)")
      .bind(newAttempt, task.task_id, toAgentId, new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(), nextGeneration, now)
      .run();
    await ctx.db
      .prepare("UPDATE tasks SET owner_agent_id = ?, state = 'HANDOFF_ACCEPTED', revision = revision + 1, updated_at = ? WHERE task_id = ? AND revision = ?")
      .bind(toAgentId, now, task.task_id, task.revision)
      .run();
    await recordProjectEvent({
      db: ctx.db,
      projectId: task.project_id,
      eventType: "task.handoff.completed",
      aggregateType: "task",
      aggregateId: task.task_id,
      subject: ctx.principal.subject,
      payload: {
        from_agent_id: task.owner_agent_id,
        to_agent_id: toAgentId,
        checkpoint_id: checkpoint.checkpoint_id,
        new_attempt_id: newAttempt,
        fencing_generation: nextGeneration,
        previous_attempt_superseded: current?.attempt_id ?? null,
      },
    });
    return {
      status: 200,
      data: {
        task_id: task.task_id,
        state: "HANDOFF_ACCEPTED",
        to_agent_id: toAgentId,
        attempt_id: newAttempt,
        fencing_generation: nextGeneration,
        checkpoint_id: checkpoint.checkpoint_id,
        previous_attempt: current === null ? null : { attempt_id: current.attempt_id, status: "SUPERSEDED" },
        context_note: "인증정보가 아닌 작업 컨텍스트만 전달됩니다.",
      },
    };
  },

  "post-tasks-by-taskId-checkpoint": async (ctx) => {
    const task = await getTask(ctx, ctx.params["taskId"] ?? "");
    const attemptId = String(ctx.body["attempt_id"]);
    const attempt = await firstRow<{ attempt_id: string; fencing_generation: number; status: string }>(ctx.db, "SELECT attempt_id, fencing_generation, status FROM task_attempts WHERE attempt_id = ? AND task_id = ?", attemptId, task.task_id);
    if (attempt === null) throw notFoundOrHidden(ctx.requestId, "attempt", attemptId);
    if (attempt.fencing_generation !== Number(ctx.body["fencing_generation"]) || !["GRANTED", "RUNNING"].includes(attempt.status)) {
      throw new ApiError({ code: "REVISION_CONFLICT", requestId: ctx.requestId, details: { reason_code: "TASK_LEASE_NOT_HELD", current_generation: attempt.fencing_generation } });
    }
    const checkpoint = ctx.body["checkpoint"] as Record<string, unknown>;
    const serialised = JSON.stringify(checkpoint);
    if (serialised.length > 200_000) throw new ApiError({ code: "CONTENT_TOO_LARGE", requestId: ctx.requestId });
    const checkpointId = mintId("event");
    await ctx.db
      .prepare("INSERT INTO task_checkpoints (checkpoint_id, task_id, attempt_id, checkpoint_json, checkpoint_sha256, valid_until, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(
        checkpointId,
        task.task_id,
        attemptId,
        serialised,
        await sha256Hex(serialised),
        new Date(ctx.nowMs + Number(ctx.body["valid_for_seconds"] ?? 3600) * 1000).toISOString(),
        ctx.now,
      )
      .run();
    await recordProjectEvent({
      db: ctx.db,
      projectId: task.project_id,
      eventType: "task.checkpoint.created",
      aggregateType: "task",
      aggregateId: task.task_id,
      subject: ctx.principal.subject,
      payload: { checkpoint_id: checkpointId, attempt_id: attemptId, fencing_generation: attempt.fencing_generation },
    });
    return {
      status: 201,
      data: { checkpoint_id: checkpointId, task_id: task.task_id, attempt_id: attemptId, checkpoint_sha256: await sha256Hex(serialised), secrets_stored: false },
    };
  },

  "get-projects-by-projectId-memories": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const service = new MemoryService(ctx.db);
    const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 25), 100);
    const result = await service.list({
      access: { subject: ctx.principal.subject, roomIds: ctx.principal.membership.roomIds, projectIds: ctx.principal.membership.projectIds },
      projectId: project.project_id,
      ...(ctx.url.searchParams.get("scope") !== null ? { scope: ctx.url.searchParams.get("scope") as "agent_private" | "room" | "project" | "shared" } : {}),
      limit,
      ...(ctx.url.searchParams.get("cursor") !== null ? { cursor: ctx.url.searchParams.get("cursor") as string } : {}),
    });
    return {
      status: 200,
      data: { project_id: project.project_id, items: result.items, layers: ["agent_private", "room", "project", "shared"] },
      page: { next_cursor: result.nextCursor, has_more: result.nextCursor !== null, order: "desc", total_estimate: null },
    };
  },

  "post-projects-by-projectId-memories": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const service = new MemoryService(ctx.db);
    const scope = String(ctx.body["scope"]) as "agent_private" | "room" | "project" | "shared";
    const scopeId = optionalString(ctx.body, "scope_id") ?? (scope === "project" ? project.project_id : scope === "room" ? (await firstRow<{ room_id: string }>(ctx.db, "SELECT room_id FROM project_room_links WHERE project_id = ? LIMIT 1", project.project_id))?.room_id ?? "" : ctx.principal.subject.id);
    const memory = await service.create({
      subject: ctx.principal.subject,
      access: { subject: ctx.principal.subject, roomIds: ctx.principal.membership.roomIds, projectIds: ctx.principal.membership.projectIds },
      scope,
      scopeId,
      projectId: scope === "agent_private" ? null : project.project_id,
      kind: String(ctx.body["kind"]) as "fact" | "decision" | "hypothesis" | "note" | "task_result",
      body: String(ctx.body["body"]),
      ...(typeof ctx.body["trust"] === "string" ? { trust: ctx.body["trust"] as "unverified" | "corroborated" | "disputed" } : {}),
      sources: ctx.body["sources"] as { source_kind: "message" | "file" | "artifact" | "job" | "manual" | "provider"; source_id: string; quote?: string }[],
      requestId: ctx.requestId,
    });
    await recordProjectEvent({
      db: ctx.db,
      projectId: project.project_id,
      eventType: "memory.created",
      aggregateType: "memory",
      aggregateId: memory.memory_id,
      subject: ctx.principal.subject,
      payload: { scope, kind: memory.memory_kind, trust: memory.trust_state, sources: memory.sources.map((source) => source.source_id) },
    });
    return { status: 201, data: { memory, note: "기억은 지속 컨텍스트이며 모델 학습이 아닙니다." } };
  },

  "post-projects-by-projectId-memories-search": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const service = new MemoryService(ctx.db);
    const result = await service.search({
      access: { subject: ctx.principal.subject, roomIds: ctx.principal.membership.roomIds, projectIds: ctx.principal.membership.projectIds },
      projectId: project.project_id,
      query: String(ctx.body["query"]),
      limit: Number(ctx.body["limit"] ?? 20),
    });
    return { status: 200, data: { project_id: project.project_id, ...result } };
  },

  "post-projects-by-projectId-shares": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const service = new MemoryService(ctx.db);
    const access = { subject: ctx.principal.subject, roomIds: ctx.principal.membership.roomIds, projectIds: ctx.principal.membership.projectIds };
    const share = await service.shareToProject({
      memoryId: String(ctx.body["memory_id"]),
      sourceProjectId: project.project_id,
      targetProjectId: String(ctx.body["target_project_id"]),
      access,
      requestId: ctx.requestId,
      ...(typeof ctx.body["note"] === "string" ? { note: ctx.body["note"] } : {}),
    });
    return { status: 201, data: { ...share, authority: "source_project", note: "버전 고정 참조이며 복사본이 아닙니다. 원본 삭제 시 접근이 끊깁니다." } };
  },

  "get-projects-by-projectId-dashboard": async (ctx) => {
    const project = await getProject(ctx.db, ctx.params["projectId"] ?? "", ctx.principal, ctx.requestId);
    const byState = await allRows<{ state: string; n: number }>(ctx.db, "SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? AND deleted_at IS NULL GROUP BY state", project.project_id);
    const verifiedDone = await count(
      ctx.db,
      `SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND t.state = 'DONE' AND t.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM task_evidence e WHERE e.task_id = t.task_id AND e.verification_state = 'verified')`,
      project.project_id,
    );
    const total = byState.reduce((sum, row) => sum + row.n, 0);
    const weightTotal = await allRows<{ risk_level: string; n: number }>(ctx.db, "SELECT risk_level, COUNT(*) AS n FROM tasks WHERE project_id = ? AND deleted_at IS NULL GROUP BY risk_level", project.project_id);
    const weighted = weightTotal.reduce((sum, row) => sum + TASK_WEIGHT[row.risk_level]! * row.n, 0);
    const memories = await count(ctx.db, "SELECT COUNT(*) AS n FROM memory_records WHERE project_id = ? AND deleted_at IS NULL", project.project_id);
    const artifacts = await count(ctx.db, "SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND deleted_at IS NULL", project.project_id);
    const events = await allRows<{ event_id: string; event_type: string; occurred_at: string; actor_id: string }>(
      ctx.db,
      "SELECT event_id, event_type, occurred_at, actor_id FROM project_events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 20",
      project.project_id,
    );
    const metrics = await computeMetrics({ db: ctx.db, projectId: project.project_id, nowMs: ctx.nowMs });
    return {
      status: 200,
      data: {
        project,
        tasks: { total, by_state: Object.fromEntries(byState.map((row) => [row.state, row.n])), verified_done: verifiedDone, risk_weight_total: weighted },
        memories,
        artifacts,
        recent_events: events,
        metrics,
        metrics_summary: metricSummary(metrics),
        progress_note: "진행률은 검증된 완료 작업의 위험도 가중치로 계산하며 AI 자기신고 수치는 사용하지 않습니다.",
      },
    };
  },
};

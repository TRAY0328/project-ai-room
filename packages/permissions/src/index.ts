/**
 * Authorization layer — spec 06.1, 31.1, 33.3, 19.2, Q019.
 *
 * `contracts/permissions.ts` holds the pure decision function. This package
 * supplies the part it cannot: the server-side facts (room/project membership,
 * approval state, resource ownership) and the endpoint -> action mapping.
 *
 * Principles:
 *  - The mapping is exhaustive over the API catalog; an endpoint with no rule is
 *    a programming error at startup, not a silent allow.
 *  - A resource that the caller may not see is reported exactly like a missing
 *    one (403), so an id cannot be probed for existence.
 *  - High-risk mutations require an APPROVED approval bound to the exact digest
 *    of what is about to happen; a stale or mismatched approval is a denial.
 */
import { sha256Hex } from "@ai-room/auth";
import {
  ApiError,
  assertAuthorized,
  evaluate,
  type AuthorizationDecision,
  type MembershipScope,
  type PermissionAction,
  type ResourceRef,
  type SessionAssurance,
  type Subject,
} from "@ai-room/contracts";
import { allRows, firstRow, type SqlDb } from "@ai-room/auth";

export interface Principal {
  readonly subject: Subject;
  readonly assurance: SessionAssurance;
  readonly sessionId: string;
  readonly membership: MembershipScope;
  readonly roles: {
    readonly rooms: ReadonlyMap<string, "owner" | "contributor" | "viewer">;
    readonly projects: ReadonlyMap<string, "owner" | "contributor" | "viewer">;
  };
}

export interface ApprovalRecord {
  readonly approval_id: string;
  readonly state: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "INVALIDATED" | "REVOKED";
  readonly action_digest: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly bound_commit_sha: string | null;
  readonly diff_sha: string | null;
  readonly expires_at: string;
}

export async function loadPrincipal(db: SqlDb, input: { subject: Subject; assurance: SessionAssurance; sessionId?: string; session_id?: string }): Promise<Principal> {
  const { subject } = input;
  const actorKind = subject.kind === "owner" ? "owner" : "agent";
  const roomAcl = await allRows<{ room_id: string; role: "owner" | "contributor" | "viewer" }>(
    db,
    "SELECT room_id, role FROM room_acl WHERE actor_kind = ? AND actor_id = ? AND revoked_at IS NULL",
    actorKind,
    subject.id,
  );
  const projectAcl = await allRows<{ project_id: string; role: "owner" | "contributor" | "viewer" }>(
    db,
    "SELECT project_id, role FROM project_acl WHERE actor_kind = ? AND actor_id = ? AND revoked_at IS NULL",
    actorKind,
    subject.id,
  );
  const roomMemberships = await allRows<{ room_id: string }>(
    db,
    "SELECT room_id FROM room_members WHERE actor_kind = ? AND actor_id = ? AND left_at IS NULL",
    actorKind,
    subject.id,
  );
  const roomIds = new Set<string>([...roomAcl.map((row) => row.room_id), ...roomMemberships.map((row) => row.room_id)]);
  const projectIds = new Set<string>(projectAcl.map((row) => row.project_id));
  return {
    subject,
    assurance: input.assurance,
    sessionId: input.sessionId ?? input.session_id ?? "service",
    membership: { projectIds: [...projectIds], roomIds: [...roomIds] },
    roles: {
      rooms: new Map(roomAcl.map((row) => [row.room_id, row.role])),
      projects: new Map(projectAcl.map((row) => [row.project_id, row.role])),
    },
  };
}

export async function loadApproval(db: SqlDb, approvalId: string): Promise<ApprovalRecord | null> {
  return firstRow<ApprovalRecord>(db, "SELECT * FROM approvals WHERE approval_id = ?", approvalId);
}

/**
 * Canonical digest of exactly what an approval covers. Any material change to
 * the target, SHA, diff or job changes this string, which invalidates a prior
 * approval (spec 05.3 #9, S33, S34).
 */
export async function computeActionDigest(parts: {
  readonly target_type: string;
  readonly target_id: string;
  readonly project_id?: string | null;
  readonly bound_commit_sha?: string | null;
  readonly diff_sha?: string | null;
  readonly bound_job_id?: string | null;
}): Promise<string> {
  const canonical = [
    `target_type=${parts.target_type}`,
    `target_id=${parts.target_id}`,
    `project_id=${parts.project_id ?? ""}`,
    `commit=${parts.bound_commit_sha ?? ""}`,
    `diff=${parts.diff_sha ?? ""}`,
    `job=${parts.bound_job_id ?? ""}`,
  ].join("\n");
  return sha256Hex(canonical);
}

export interface AuthorizeInput {
  readonly principal: Principal;
  readonly action: PermissionAction;
  readonly resource: ResourceRef;
  readonly approval?: ApprovalRecord | null;
  readonly attemptedActionDigest?: string;
  readonly approvalStale?: boolean;
  readonly nowMs?: number;
}

export function authorize(input: AuthorizeInput, requestId: string): AuthorizationDecision {
  const approval = input.approval ?? null;
  const expired = approval !== null && Date.parse(approval.expires_at) <= (input.nowMs ?? Date.now());
  const decision = evaluate({
    subject: input.principal.subject,
    action: input.action,
    resource: input.resource,
    membership: input.principal.membership,
    sessionAssurance: input.principal.assurance,
    ...(approval === null
      ? {}
      : {
          approval: {
            approvalId: approval.approval_id,
            state: approval.state === "APPROVED" ? "approved" : approval.state === "PENDING" ? "pending" : approval.state === "DENIED" ? "denied" : approval.state === "EXPIRED" || expired ? "expired" : approval.state === "INVALIDATED" ? "invalidated" : "revoked",
            actionDigest: approval.action_digest,
          },
        }),
    ...(input.attemptedActionDigest === undefined ? {} : { attemptedActionDigest: input.attemptedActionDigest }),
    ...(input.approvalStale === undefined ? {} : { approvalStale: input.approvalStale }),
  });
  void requestId;
  return decision;
}

export async function requireAuthorized(input: AuthorizeInput, requestId: string): Promise<AuthorizationDecision> {
  const decision = authorize(input, requestId);
  if (!decision.allowed) {
    assertAuthorized(
      {
        subject: input.principal.subject,
        action: input.action,
        resource: input.resource,
        membership: input.principal.membership,
        sessionAssurance: input.principal.assurance,
        ...(input.approval === null || input.approval === undefined
          ? {}
          : {
              approval: {
                approvalId: input.approval.approval_id,
                state: input.approval.state === "APPROVED" ? "approved" : "pending",
                actionDigest: input.approval.action_digest,
              },
            }),
        ...(input.attemptedActionDigest === undefined ? {} : { attemptedActionDigest: input.attemptedActionDigest }),
        ...(input.approvalStale === undefined ? {} : { approvalStale: input.approvalStale }),
      },
      requestId,
    );
  }
  return decision;
}

/** Room access for a read or a write, with the ACL facts already loaded. */
export function assertRoomAccess(principal: Principal, roomId: string, requestId: string): void {
  if (principal.subject.kind === "owner") return;
  if (!principal.membership.roomIds.includes(roomId)) {
    throw new ApiError({ code: "ROOM_ACCESS_DENIED", requestId, details: { reason_code: "NOT_ROOM_MEMBER" } });
  }
}

export function assertProjectAccess(principal: Principal, projectId: string, requestId: string, write = false): void {
  if (principal.subject.kind === "owner") return;
  if (!principal.membership.projectIds.includes(projectId)) {
    // Same answer as "missing": nothing to probe.
    throw new ApiError({ code: "PERMISSION_DENIED", requestId, details: { reason_code: "NOT_PROJECT_MEMBER" } });
  }
  const role = principal.roles.projects.get(projectId);
  if (write && role === "viewer") {
    throw new ApiError({ code: "PERMISSION_DENIED", requestId, details: { reason_code: "READ_ONLY_ROLE" } });
  }
}

export function assertMessageAuthor(principal: Principal, authorKind: string, authorId: string, requestId: string): void {
  if (principal.subject.kind === "owner") return;
  if (authorKind !== "agent" || authorId !== principal.subject.id) {
    throw new ApiError({ code: "PERMISSION_DENIED", requestId, details: { reason_code: "SELF_ONLY" } });
  }
}

/**
 * Endpoint -> permission action. Every catalog operationId appears exactly once;
 * `assertEndpointCoverage` fails the build when the catalog grows and this map
 * does not.
 */
export const ENDPOINT_ACTIONS: Readonly<Record<string, PermissionAction>> = {
  "post-owner-bootstrap": "owner.bootstrap",
  "post-auth-login": "owner.bootstrap",
  "post-auth-logout": "owner.bootstrap",
  "post-auth-refresh": "owner.bootstrap",
  "post-agents-register": "agent.register",
  "post-agents-login": "agent.read",
  "post-agents-rekey": "agent.credentials.rotate.self",
  "get-agents": "agent.read",
  "get-agents-by-agentId": "agent.read",
  "patch-agents-by-agentId": "agent.profile.write.self",
  "post-providers-by-provider-connect": "provider.connect",
  "post-providers-by-provider-callback": "provider.connect",
  "post-providers-by-provider-verify": "provider.verify",
  "get-providers-connections": "provider.connect",
  "post-providers-connections-by-id-revoke": "provider.revoke",
  "get-rooms": "room.read",
  "post-rooms": "room.write",
  "get-rooms-by-roomId": "room.read",
  "patch-rooms-by-roomId": "room.write",
  "post-rooms-by-roomId-members": "room.member.write",
  "delete-rooms-by-roomId-members-by-actorId": "room.member.write",
  "get-rooms-by-roomId-messages": "room.message.read",
  "post-rooms-by-roomId-messages": "room.message.create",
  "patch-rooms-by-roomId-messages-by-messageId": "room.message.edit.own",
  "delete-rooms-by-roomId-messages-by-messageId": "room.message.delete",
  "post-messages-by-messageId-reactions": "room.reaction.write",
  "get-messages-by-messageId-versions": "room.message.read",
  "post-files-upload-intents": "file.upload",
  "post-files-uploads-by-uploadId-complete": "file.upload",
  "get-files-by-assetId-download-intent": "file.download",
  "post-search": "search.query",
  "get-search-saved": "search.query",
  "get-projects": "project.read",
  "post-projects": "project.write",
  "get-projects-by-projectId": "project.read",
  "patch-projects-by-projectId": "project.write",
  "post-projects-by-projectId-rooms-link": "project.write",
  "get-projects-by-projectId-tasks": "project.task.read",
  "post-projects-by-projectId-tasks": "project.task.write",
  "post-tasks-by-taskId-claim-proposals": "project.task.claim",
  "post-tasks-by-taskId-claims-accept": "project.task.claim",
  "post-tasks-by-taskId-transition": "project.task.write",
  "post-tasks-by-taskId-handoff": "project.task.handoff",
  "post-tasks-by-taskId-checkpoint": "project.task.write",
  "get-projects-by-projectId-memories": "project.memory.read",
  "post-projects-by-projectId-memories": "project.memory.write",
  "post-projects-by-projectId-memories-search": "project.memory.read",
  "post-projects-by-projectId-shares": "project.memory.write",
  "get-projects-by-projectId-dashboard": "project.metrics.read",
  "get-projects-by-projectId-ide-tree": "file.read",
  "get-projects-by-projectId-ide-documents-by-docId": "file.read",
  "post-projects-by-projectId-ide-publish": "git.commit.write",
  "get-projects-by-projectId-git-branches": "git.repository.read",
  "post-projects-by-projectId-git-branches": "git.branch.write",
  "post-projects-by-projectId-git-pull-requests": "git.pr.create",
  "post-projects-by-projectId-git-reviews": "git.review.write",
  "post-projects-by-projectId-git-merge": "git.merge",
  "post-projects-by-projectId-jobs": "job.dispatch",
  "get-projects-by-projectId-jobs-by-jobId": "job.log.read",
  "post-projects-by-projectId-jobs-by-jobId-cancel": "job.cancel",
  "get-projects-by-projectId-jobs-by-jobId-logs": "job.log.read",
  "get-projects-by-projectId-artifacts": "artifact.read",
  "post-projects-by-projectId-artifacts-by-artifactId-verify": "artifact.verify",
  "post-projects-by-projectId-artifacts-by-artifactId-download-intent": "artifact.download",
  "get-projects-by-projectId-reports": "project.report.read",
  "get-admin-overview": "owner.admin.read",
  "get-admin-required-agents": "owner.admin.read",
  "post-admin-approvals": "approval.request",
  "post-admin-approvals-by-id-resolve": "approval.decide",
  "post-admin-emergency-stop": "owner.admin.emergency_stop",
  "get-admin-audit-events": "owner.admin.audit.read",
  "get-admin-resource-budgets": "owner.admin.read",
  "post-admin-backups": "owner.admin.backup",
  "post-admin-restores-prepare": "owner.admin.restore",
  "post-admin-restores-commit": "owner.admin.restore",
  "post-admin-data-deletion-prepare": "owner.admin.data_deletion",
  "post-admin-data-deletion-commit": "owner.admin.data_deletion",
  "get-admin-release-gates": "owner.admin.read",
};

export function actionForOperation(operationId: string): PermissionAction {
  const action = ENDPOINT_ACTIONS[operationId];
  if (action === undefined) {
    throw new Error(`no permission action mapped for ${operationId}: refusing to default-allow`);
  }
  return action;
}

export function assertEndpointCoverage(operationIds: readonly string[]): void {
  const missing = operationIds.filter((id) => ENDPOINT_ACTIONS[id] === undefined);
  if (missing.length > 0) throw new Error(`endpoints without a permission mapping: ${missing.join(", ")}`);
}

/** Agent profile edits: allowlist in, immutable fields rejected (S05). */
export function filterAgentProfilePatch(patch: Record<string, unknown>, requestId: string): Record<string, unknown> {
  const allowed = new Set(["display_name", "avatar_asset_id", "description", "model_name", "company", "pronouns"]);
  const forbidden = Object.keys(patch).filter((key) => !allowed.has(key));
  if (forbidden.length > 0) {
    throw new ApiError({
      code: "VALIDATION_FAILED",
      requestId,
      message: "수정할 수 없는 필드가 포함되어 있습니다.",
      details: { rejected_fields: forbidden, allowed_fields: [...allowed] },
    });
  }
  return patch;
}

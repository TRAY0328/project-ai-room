/**
 * RBAC + ABAC permission model — spec 06.1, 31.1, 33.3, Q019
 *
 * Design decisions:
 *  - Default deny. `evaluate()` returns `allowed:false` for anything it does
 *    not explicitly prove, so a new endpoint that forgets a rule fails closed.
 *  - `platform_admin` belongs to the single human OWNER only. An AI agent can
 *    never hold it, and no agent may act on another agent's profile.
 *  - Every AI has the *same baseline rights* as any other AI; what differs is
 *    project/room membership, the installed tools, and what the provider
 *    officially supports. Capability is checked separately (provider.ts).
 *  - The same function must be called by the HTTP API, the WebSocket upgrade,
 *    the R2 signed-download issuer and any GitHub dispatch path, so a decision
 *    cannot be "true over HTTP, false over WS".
 *  - High-risk actions need an owner approval bound to the exact target and
 *    digest; a stale approval is a denial, never a warning.
 */
import { ApiError } from "./errors.js";
import type { AgentId, OwnerId } from "./ids.js";

export const POLICY_VERSION = "2026-11-21.1" as const;

export const ACTOR_KINDS = ["owner", "agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const PERMISSION_ACTIONS = [
  // identity / registration
  "owner.bootstrap",
  "agent.register",
  "agent.read",
  "agent.profile.write.self",
  "agent.credentials.rotate.self",
  "provider.connect",
  "provider.verify",
  "provider.revoke",
  // rooms & messages
  "room.read",
  "room.write",
  "room.member.write",
  "room.message.read",
  "room.message.create",
  "room.message.edit.own",
  "room.message.delete",
  "room.message.restore",
  "room.reaction.write",
  "ws.subscribe",
  // projects, tasks, memory
  "project.read",
  "project.write",
  "project.member.write",
  "project.task.read",
  "project.task.write",
  "project.task.claim",
  "project.task.complete",
  "project.task.handoff",
  "project.memory.read",
  "project.memory.write",
  "project.metrics.read",
  "project.report.read",
  // code, git, CI, artifacts
  "git.repository.read",
  "git.repository.connect",
  "git.branch.write",
  "git.commit.write",
  "git.pr.create",
  "git.review.write",
  "git.merge",
  "job.dispatch",
  "job.cancel",
  "job.log.read",
  "artifact.read",
  "artifact.download",
  "artifact.verify",
  // files & search
  "file.upload",
  "file.read",
  "file.download",
  "file.delete",
  "search.query",
  // approvals & owner admin
  "approval.request",
  "approval.decide",
  "owner.admin.read",
  "owner.admin.policy.write",
  "owner.admin.audit.read",
  "owner.admin.emergency_stop",
  "owner.admin.backup",
  "owner.admin.restore",
  "owner.admin.data_deletion",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
const ACTION_SET: ReadonlySet<string> = new Set(PERMISSION_ACTIONS);

/** Actions that only the human owner can ever perform. */
const OWNER_ONLY: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  "owner.bootstrap",
  "approval.decide",
  "owner.admin.read",
  "owner.admin.policy.write",
  "owner.admin.audit.read",
  "owner.admin.emergency_stop",
  "owner.admin.backup",
  "owner.admin.restore",
  "owner.admin.data_deletion",
]);

/** Actions an AI may perform only while a live owner approval covers them. */
const HIGH_RISK: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  "git.merge",
  "job.dispatch",
  "provider.connect",
  "file.delete",
  "git.repository.connect",
]);

/** Actions allowed for the internal `system` actor (DO alarms, cron, workers). */
const SYSTEM_ALLOWED: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  "room.message.create",
  "room.read",
  "room.message.read",
  "ws.subscribe",
  "project.task.write",
  "job.dispatch",
  "job.cancel",
  "artifact.read",
  "approval.request",
  "search.query",
]);

/** Field allowlist for an agent editing its own profile (spec 33.3). */
export const AGENT_PROFILE_EDITABLE_FIELDS = [
  "display_name",
  "avatar_asset_id",
  "description",
] as const;

export const AGENT_PROFILE_IMMUTABLE_FIELDS = [
  "provider_verification",
  "verification_state",
  "system_role",
  "platform_admin",
  "credential_hash",
  "owner_id",
  "agent_id",
  "profile_revision",
] as const;

export type ResourceType =
  | "owner"
  | "agent"
  | "room"
  | "message"
  | "project"
  | "task"
  | "memory"
  | "file"
  | "artifact"
  | "repository"
  | "pull_request"
  | "job"
  | "approval"
  | "provider_connection"
  | "ws_ticket"
  | "system";

export interface ResourceRef {
  readonly type: ResourceType;
  readonly id: string;
  readonly projectId?: string;
  readonly roomId?: string;
  readonly ownerId?: string;
  /** For agent-scoped resources: which agent the row belongs to. */
  readonly agentId?: string;
}

export type SessionAssurance =
  | "none"
  | "owner_ui"
  | "agent_key"
  | "ephemeral_ws_ticket"
  | "service";

export interface Subject {
  readonly kind: ActorKind;
  readonly id: string;
  /** Only ever true for the single human owner account. */
  readonly platformAdmin: boolean;
  readonly ownerId?: OwnerId;
  readonly agentId?: AgentId;
  /** provider evidence state backing this agent's claimed identity. */
  readonly verificationState?: "self_declared" | "discovery_verified" | "provider_verified";
  readonly disabled?: boolean;
}

export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "invalidated" | "revoked";

export interface MembershipScope {
  readonly projectIds: readonly string[];
  readonly roomIds: readonly string[];
}

export interface AuthorizationContext {
  readonly subject: Subject;
  readonly action: PermissionAction | string;
  readonly resource: ResourceRef;
  readonly membership?: MembershipScope;
  readonly sessionAssurance: SessionAssurance;
  readonly requestOrigin?: string;
  /** Present when the call carries an approval; its state must be `approved`. */
  readonly approval?: {
    readonly approvalId: string;
    readonly state: ApprovalState;
    /** Digest of exactly what the owner approved (target + diff + sha + job). */
    readonly actionDigest: string;
  };
  /** Digest the caller is about to perform; must match the approval's. */
  readonly attemptedActionDigest?: string;
  /** Set when the target row was modified after approval was granted. */
  readonly approvalStale?: boolean;
}

export type ReasonCode =
  | "POLICY_ALLOWED"
  | "DEFAULT_DENY"
  | "UNKNOWN_ACTION"
  | "SUBJECT_DISABLED"
  | "SESSION_ASSURANCE_INSUFFICIENT"
  | "PLATFORM_ADMIN_EXCLUSIVE"
  | "SELF_ONLY"
  | "NOT_ROOM_MEMBER"
  | "NOT_PROJECT_MEMBER"
  | "CROSS_PROJECT_DENIED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_STALE"
  | "APPROVAL_NOT_APPROVED"
  | "APPROVAL_DIGEST_MISMATCH"
  | "RESOURCE_OWNER_MISMATCH";

export interface PolicyConstraints {
  readonly allowedFields?: readonly string[];
  readonly immutableFields?: readonly string[];
  readonly requireApproval?: boolean;
  readonly requireVerifiedProvider?: boolean;
  readonly requireEvidence?: boolean;
  readonly fileScanState?: "ready";
  readonly maxPageSize?: number;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason_code: ReasonCode;
  readonly policy_version: typeof POLICY_VERSION;
  readonly constraints: PolicyConstraints;
}

const ALLOW = (constraints: PolicyConstraints = {}): AuthorizationDecision => ({
  allowed: true,
  reason_code: "POLICY_ALLOWED",
  policy_version: POLICY_VERSION,
  constraints,
});

const DENY = (reason: ReasonCode): AuthorizationDecision => ({
  allowed: false,
  reason_code: reason,
  policy_version: POLICY_VERSION,
  constraints: {},
});

function isMember(scope: MembershipScope | undefined, id: string | undefined): boolean {
  if (id === undefined) return false;
  return scope !== undefined && (scope.projectIds.includes(id) || scope.roomIds.includes(id));
}

function roomAction(action: PermissionAction): boolean {
  return action.startsWith("room.") || action === "ws.subscribe";
}

function projectAction(action: PermissionAction): boolean {
  return action.startsWith("project.") || action.startsWith("git.") || action.startsWith("job.") ||
    action.startsWith("artifact.") || action.startsWith("file.") || action === "search.query";
}

function checkApproval(ctx: AuthorizationContext, action: PermissionAction): AuthorizationDecision | null {
  if (!HIGH_RISK.has(action)) return null;
  const approval = ctx.approval;
  if (approval === undefined) return DENY("APPROVAL_REQUIRED");
  if (ctx.approvalStale === true) return DENY("APPROVAL_STALE");
  if (approval.state !== "approved") return DENY("APPROVAL_NOT_APPROVED");
  if (
    ctx.attemptedActionDigest !== undefined &&
    ctx.attemptedActionDigest !== approval.actionDigest
  ) {
    return DENY("APPROVAL_DIGEST_MISMATCH");
  }
  return null;
}

/**
 * The single authorization decision point. Pure, deterministic, no I/O.
 * `reason_code` is safe to log and to return to the client.
 */
export function evaluate(ctx: AuthorizationContext): AuthorizationDecision {
  const { subject, action, resource } = ctx;

  if (typeof action !== "string" || !ACTION_SET.has(action)) return DENY("UNKNOWN_ACTION");
  const permission = action as PermissionAction;

  if (subject.disabled === true) return DENY("SUBJECT_DISABLED");
  if (ctx.sessionAssurance === "none") return DENY("SESSION_ASSURANCE_INSUFFICIENT");

  // --- internal system actor -------------------------------------------------
  if (subject.kind === "system") {
    if (ctx.sessionAssurance !== "service") return DENY("SESSION_ASSURANCE_INSUFFICIENT");
    if (OWNER_ONLY.has(permission)) return DENY("PLATFORM_ADMIN_EXCLUSIVE");
    return SYSTEM_ALLOWED.has(permission) ? ALLOW() : DENY("DEFAULT_DENY");
  }

  // --- human owner -----------------------------------------------------------
  if (subject.kind === "owner") {
    if (ctx.sessionAssurance !== "owner_ui" && ctx.sessionAssurance !== "service") {
      return DENY("SESSION_ASSURANCE_INSUFFICIENT");
    }
    if (OWNER_ONLY.has(permission) && !subject.platformAdmin) {
      return DENY("PLATFORM_ADMIN_EXCLUSIVE");
    }
    if (resource.ownerId !== undefined && resource.ownerId !== subject.id) {
      return DENY("RESOURCE_OWNER_MISMATCH");
    }
    if (permission === "approval.decide") {
      if (ctx.approval !== undefined && ctx.approvalStale === true) return DENY("APPROVAL_STALE");
      return ALLOW();
    }
    return ALLOW();
  }

  // --- AI agent --------------------------------------------------------------
  if (subject.kind === "agent") {
    if (ctx.sessionAssurance !== "agent_key" && ctx.sessionAssurance !== "ephemeral_ws_ticket") {
      return DENY("SESSION_ASSURANCE_INSUFFICIENT");
    }
    // Never an admin, never someone else's profile, never a credential hash.
    if (subject.platformAdmin) return DENY("PLATFORM_ADMIN_EXCLUSIVE");
    if (OWNER_ONLY.has(permission)) return DENY("PLATFORM_ADMIN_EXCLUSIVE");

    if (permission === "agent.profile.write.self" || permission === "agent.credentials.rotate.self") {
      if (resource.agentId !== undefined && resource.agentId !== subject.id) return DENY("SELF_ONLY");
      return ALLOW({
        allowedFields: [...AGENT_PROFILE_EDITABLE_FIELDS],
        immutableFields: [...AGENT_PROFILE_IMMUTABLE_FIELDS],
      });
    }
    if (permission === "agent.read") {
      return resource.agentId !== undefined && resource.agentId !== subject.id && !isMember(ctx.membership, resource.projectId)
        ? DENY("NOT_PROJECT_MEMBER")
        : ALLOW();
    }

    // Room scope: participation is what grants reading, never a display name.
    if (roomAction(permission)) {
      const roomId = resource.roomId ?? (resource.type === "room" ? resource.id : undefined);
      if (roomId === undefined) return DENY("DEFAULT_DENY");
      if (!isMember(ctx.membership, roomId)) return DENY("NOT_ROOM_MEMBER");
    }

    // Project scope: no membership means no file, git, memory or job access.
    if (projectAction(permission)) {
      if (resource.projectId === undefined) return DENY("DEFAULT_DENY");
      if (!isMember(ctx.membership, resource.projectId)) return DENY("NOT_PROJECT_MEMBER");
    }

    if (permission === "project.memory.read" || permission === "project.memory.write") {
      if (resource.projectId === undefined) {
        // Agent-private memory needs no project, but nothing else may leak.
        return resource.type === "memory" && resource.agentId === subject.id
          ? ALLOW()
          : DENY("CROSS_PROJECT_DENIED");
      }
    }

    const approvalDecision = checkApproval(ctx, permission);
    if (approvalDecision !== null) return approvalDecision;

    const constraints: { fileScanState?: "ready"; requireEvidence?: boolean } = {};
    if (permission === "file.download" || permission === "file.read") {
      constraints.fileScanState = "ready";
    }
    if (permission === "project.task.complete") {
      constraints.requireEvidence = true;
    }
    return ALLOW(constraints);
  }

  return DENY("DEFAULT_DENY");
}

/** Throwing wrapper for service code. Maps denial to API errors. */
export function assertAuthorized(ctx: AuthorizationContext, requestId: string): AuthorizationDecision {
  const decision = evaluate(ctx);
  if (decision.allowed) return decision;
  const code =
    decision.reason_code === "APPROVAL_REQUIRED" || decision.reason_code === "APPROVAL_NOT_APPROVED"
      ? "APPROVAL_REQUIRED"
      : decision.reason_code === "APPROVAL_STALE" || decision.reason_code === "APPROVAL_DIGEST_MISMATCH"
        ? "APPROVAL_STALE"
        : decision.reason_code === "NOT_ROOM_MEMBER"
          ? "ROOM_ACCESS_DENIED"
          : decision.reason_code === "NOT_PROJECT_MEMBER" || decision.reason_code === "CROSS_PROJECT_DENIED"
            ? "PERMISSION_DENIED"
            : "PERMISSION_DENIED";
  throw new ApiError({ code, requestId, details: { reason_code: decision.reason_code } });
}

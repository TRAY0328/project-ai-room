/**
 * Per-endpoint request validation — spec 19.1 ("허용 필드 명시적 검증"), S18, S19.
 *
 * One schema per mutating endpoint, all `.strict()`: an unexpected field is a
 * 400, not something a handler silently ignores. Lengths are bounded so a
 * request cannot become a regex/scan DoS vector, and no field lets a client set
 * `actor`, `revision`, `platform_admin` or a verification state.
 */
import { z } from "zod";
import { zUtcIsoMillis } from "@ai-room/contracts";

const id = z.string().min(3).max(64);
const shortText = z.string().min(1).max(400);
const longText = z.string().max(100_000);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const sha = z.string().regex(/^[0-9a-f]{40,64}$/);

export const zBlockType = z.enum([
  "text",
  "markdown",
  "code",
  "diff",
  "file",
  "image",
  /* The web client's renderer spells attachments `file_ref`/`image_ref`; both
     spellings normalize to the stored `file`/`image` below, so a client can
     send the shape it renders without a second vocabulary. */
  "file_ref",
  "image_ref",
  "quote",
  "task_ref",
  "commit_ref",
  "pr_ref",
  "artifact_ref",
  "chart",
  "table",
  "callout",
]);

export type BlockTypeName = z.infer<typeof zBlockType>;

/** A block id is only an identifier; the server accepts the client's or mints one. */
function newBlockId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random()}`.replace(/\D/g, "");
  return `blk_${random.slice(0, 24)}`;
}

/**
 * One message block. Two equivalent spellings are accepted so that a client can
 * send the same object it renders (the client block model is
 * `{ type, version, payload }`) and an API client can send the stored spelling
 * (`{ block_id, block_type, payload }`). Both normalize to the stored shape, so
 * a block never fails because of which name for the same field was used.
 */
export const zBlock = z
  .object({
    block_id: z.string().min(1).max(64).optional(),
    block_type: zBlockType.optional(),
    type: zBlockType.optional(),
    version: z.number().int().min(1).max(20).optional(),
    payload: z.record(z.string(), z.unknown()),
    source_ref: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.block_type === undefined && block.type === undefined) {
      ctx.addIssue({ code: "custom", path: ["block_type"], message: "block_type(또는 type)이 필요합니다." });
    }
    if (block.block_type !== undefined && block.type !== undefined && block.block_type !== block.type) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "block_type과 type이 서로 다릅니다." });
    }
  })
  .transform((block) => ({
    block_id: block.block_id ?? newBlockId(),
    block_type: (block.block_type ?? block.type) as BlockTypeName,
    version: block.version ?? 1,
    payload: block.payload,
    ...(block.source_ref === undefined ? {} : { source_ref: block.source_ref }),
  }))
  .transform((block) => ({
    ...block,
    // The stored (and re-served) spelling of an attachment is `file`/`image`;
    // the payload keeps whichever renderer keys the client sent.
    block_type: (block.block_type === "file_ref" ? "file" : block.block_type === "image_ref" ? "image" : block.block_type) as BlockTypeName,
  }));

export type NormalizedBlock = z.infer<typeof zBlock>;

const zTaskState = z.enum([
  "PROPOSED",
  "SPECIFIED",
  "OPEN_FOR_CLAIM",
  "CLAIM_PROPOSED",
  "CLAIM_ACCEPTED",
  "WAITING_DEPENDENCY",
  "READY",
  "LEASED",
  "RUNNING",
  "VERIFYING",
  "RETRY_WAIT",
  "HANDOFF_REQUESTED",
  "HANDOFF_ACCEPTED",
  "BLOCKED",
  "CANCELLED",
  "FAILED",
  "DONE",
  "REOPENED",
]);

export const BODY_SCHEMAS = {
  "post-owner-bootstrap": z
    .object({
      display_name: z.string().min(1).max(120),
      email: z.string().email().max(254),
      password: z.string().min(12).max(256),
      bootstrap_secret: z.string().min(16).max(256),
    })
    .strict(),
  "post-auth-login": z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict(),
  "post-auth-logout": z.object({ refresh_token: z.string().min(8).max(512).optional() }).strict(),
  // A browser holds the refresh token in the HttpOnly `air_refresh` cookie and
  // cannot read it, so the body is optional: the handler falls back to the cookie.
  "post-auth-refresh": z.object({ refresh_token: z.string().min(8).max(512).optional() }).strict(),
  "post-agents-register": z
    .object({
      invite_secret: z.string().min(8).max(256),
      display_name: z.string().min(1).max(120),
      /** Uploaded asset id. Optional: an AI without R2 can send `avatar_url` instead. */
      avatar_asset_id: id.optional(),
      /** Public https image URL — the documented alternative to an uploaded asset. */
      avatar_url: z.string().url().max(1024).optional(),
      claimed_provider: z.string().min(1).max(64).nullable().optional(),
      /** Documented spelling of `claimed_provider`; a claim is never a proof. */
      provider_claim: z.string().min(1).max(64).nullable().optional(),
      provider_verified: z.boolean().optional(),
      description: z.string().max(4000).optional(),
      /** Documented spelling of `description`. */
      bio: z.string().max(4000).optional(),
      model_name: z.string().max(120).nullable().optional(),
      idempotency_key: z.string().min(8).max(128).optional(),
    })
    .strict(),
  "post-agents-login": z.object({ agent_key: z.string().min(16).max(256) }).strict(),
  "post-agents-rekey": z.object({}).strict(),
  "patch-agents-by-agentId": z
    .object({
      display_name: z.string().min(1).max(120).optional(),
      avatar_asset_id: id.optional(),
      description: z.string().max(4000).optional(),
      model_name: z.string().max(120).nullable().optional(),
      company: z.string().max(120).nullable().optional(),
      pronouns: z.string().max(40).nullable().optional(),
      expected_profile_revision: z.number().int().min(1).optional(),
    })
    .strict(),
  "post-providers-by-provider-connect": z
    .object({
      agent_id: id.optional(),
      redirect_uri: z.string().url().max(512).optional(),
      requested_capabilities: z.array(z.string().max(64)).max(9).optional(),
    })
    .strict(),
  "post-providers-by-provider-callback": z
    .object({
      agent_id: id.optional(),
      code: z.string().min(1).max(512).optional(),
      state: z.string().min(16).max(512).optional(),
      code_verifier: z.string().min(20).max(256).optional(),
    })
    .strict(),
  "post-providers-by-provider-verify": z.object({ agent_id: id.optional(), capability: z.string().max(64).optional() }).strict(),
  "post-providers-connections-by-id-revoke": z.object({ reason: z.string().max(400).optional() }).strict(),
  "post-rooms": z
    .object({ name: z.string().min(1).max(120), room_type: z.enum(["custom", "project"]).default("custom"), project_id: id.optional() })
    .strict(),
  "patch-rooms-by-roomId": z.object({ name: z.string().min(1).max(120), expected_revision: z.number().int().min(1) }).strict(),
  "post-rooms-by-roomId-members": z.object({ actor_kind: z.enum(["owner", "agent"]), actor_id: id }).strict(),
  "delete-rooms-by-roomId-members-by-actorId": z.object({}).strict(),
  "post-rooms-by-roomId-messages": z
    .object({
      blocks: z.array(zBlock).min(1).max(200),
      body_plain_text: z.string().max(100_000).default(""),
      reply_to_id: id.nullable().default(null),
      mentioned_agent_ids: z.array(id).max(50).default([]),
      /** Optional: the Idempotency-Key header is the documented way to send it. */
      idempotency_key: z.string().min(8).max(128).optional(),
    })
    .strict(),
  "patch-rooms-by-roomId-messages-by-messageId": z
    .object({ blocks: z.array(zBlock).min(1).max(200), body_plain_text: z.string().max(100_000).default(""), expected_revision: z.number().int().min(1) })
    .strict(),
  "delete-rooms-by-roomId-messages-by-messageId": z.object({ expected_revision: z.number().int().min(1), reason: z.string().max(400).optional() }).strict(),
  "post-messages-by-messageId-reactions": z.object({ emoji_key: z.string().min(1).max(64) }).strict(),
  "post-files-upload-intents": z
    .object({
      filename: z.string().min(1).max(255),
      mime_type: z.string().min(3).max(200),
      size_bytes: z.number().int().min(0).max(50 * 1024 * 1024),
      sha256,
      project_id: id.nullable().optional(),
    })
    .strict(),
  "post-files-uploads-by-uploadId-complete": z
    .object({
      parts: z.array(z.object({ part_number: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200), size_bytes: z.number().int().min(0) }).strict()).max(10_000),
      sha256,
      byte_count: z.number().int().min(0),
    })
    .strict(),
  "post-search": z
    .object({
      query: z.string().min(1).max(200),
      project_id: id.nullable().optional(),
      room_id: id.nullable().optional(),
      kinds: z.array(z.enum(["message", "memory", "task", "document", "project"])).max(5).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      author: id.nullable().optional(),
      from: zUtcIsoMillis.nullable().optional(),
      to: zUtcIsoMillis.nullable().optional(),
    })
    .strict(),
  "post-projects": z
    .object({ name: z.string().min(1).max(200), description: z.string().max(4000).default(""), room_ids: z.array(id).max(20).default([]) })
    .strict(),
  "patch-projects-by-projectId": z
    .object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(4000).optional(),
      status: z.enum(["active", "paused", "archived"]).optional(),
      expected_revision: z.number().int().min(1),
    })
    .strict(),
  "post-projects-by-projectId-rooms-link": z.object({ room_id: id }).strict(),
  "post-projects-by-projectId-tasks": z
    .object({
      title: z.string().min(1).max(300),
      description: z.string().max(20_000).default(""),
      requirements: z.array(z.string().max(500)).max(50).default([]),
      acceptance_criteria: z.array(z.string().max(500)).max(50).default([]),
      risk_level: z.enum(["low", "medium", "high", "critical"]).default("low"),
      dependencies: z.array(id).max(50).default([]),
      repo_ref: z.string().max(200).nullable().optional(),
      base_sha: sha.nullable().optional(),
      owner_agent_id: id.nullable().optional(),
    })
    .strict(),
  "post-tasks-by-taskId-claim-proposals": z
    .object({ reason: shortText, evidence_message_ids: z.array(id).min(1).max(20) })
    .strict(),
  "post-tasks-by-taskId-claims-accept": z
    .object({ proposal_event_id: z.string().min(3).max(80), evidence_message_ids: z.array(id).min(1).max(20) })
    .strict(),
  "post-tasks-by-taskId-transition": z
    .object({
      to_state: zTaskState,
      expected_revision: z.number().int().min(1),
      evidence_ids: z.array(id).max(50).default([]),
      attempt_id: id.optional(),
      fencing_generation: z.number().int().min(1).optional(),
    })
    .strict(),
  "post-tasks-by-taskId-handoff": z
    .object({ to_agent_id: id, checkpoint_id: z.string().min(3).max(80).nullable().optional(), reason: shortText })
    .strict(),
  "post-tasks-by-taskId-checkpoint": z
    .object({
      attempt_id: id,
      fencing_generation: z.number().int().min(1),
      checkpoint: z.record(z.string(), z.unknown()),
      valid_for_seconds: z.number().int().min(60).max(86_400).default(3600),
    })
    .strict(),
  "get-projects-by-projectId-memories": z.object({}).strict(),
  "post-projects-by-projectId-memories": z
    .object({
      scope: z.enum(["agent_private", "room", "project", "shared"]),
      scope_id: id.optional(),
      kind: z.enum(["fact", "decision", "hypothesis", "note", "task_result"]),
      body: z.string().min(1).max(20_000),
      trust: z.enum(["unverified", "corroborated", "disputed"]).optional(),
      sources: z
        .array(
          z
            .object({
              source_kind: z.enum(["message", "file", "artifact", "job", "manual", "provider"]),
              source_id: z.string().min(1).max(120),
              quote: z.string().max(1000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  "post-projects-by-projectId-memories-search": z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }).strict(),
  "post-projects-by-projectId-shares": z
    .object({ memory_id: id, target_project_id: id, note: z.string().max(500).optional() })
    .strict(),
  "post-projects-by-projectId-ide-publish": z
    .object({ document_id: id, base_commit_sha: sha, commit_message: z.string().min(1).max(400) })
    .strict(),
  "post-projects-by-projectId-git-branches": z
    .object({ name: z.string().min(1).max(120), from_sha: sha })
    .strict(),
  "post-projects-by-projectId-git-pull-requests": z
    .object({
      title: z.string().min(1).max(300),
      body: z.string().max(20_000).default(""),
      head: z.string().min(1).max(120),
      base: z.string().min(1).max(120),
      head_sha: sha,
      task_id: id.nullable().optional(),
      attempt_id: id.nullable().optional(),
    })
    .strict(),
  "post-projects-by-projectId-git-reviews": z
    .object({
      pull_request_id: id,
      commit_sha: sha,
      verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      body: z.string().max(20_000).default(""),
      comments: z.array(z.object({ file_path: z.string().min(1).max(1024), line_number: z.number().int().min(1).nullable().optional(), body: z.string().min(1).max(4000) }).strict()).max(200).default([]),
    })
    .strict(),
  "post-projects-by-projectId-git-merge": z
    .object({
      pull_request_id: id,
      expected_head_sha: sha,
      method: z.enum(["squash", "merge", "rebase"]).default("squash"),
      approval_id: id.nullable().optional(),
    })
    .strict(),
  "post-projects-by-projectId-jobs": z
    .object({
      job_kind: z.enum(["ci_build", "ci_test", "package_web", "package_windows", "package_android", "security_scan", "custom"]),
      workflow_ref: z.string().min(1).max(300),
      commit_sha: sha,
      ref: z.string().min(1).max(200),
      task_id: id.nullable().optional(),
    })
    .strict(),
  "post-projects-by-projectId-jobs-by-jobId-cancel": z.object({ reason: z.string().max(400).optional() }).strict(),
  "post-projects-by-projectId-artifacts-by-artifactId-verify": z.object({ expected_sha256: sha256.optional() }).strict(),
  "post-projects-by-projectId-artifacts-by-artifactId-download-intent": z.object({ ttl_seconds: z.number().int().min(30).max(900).default(300) }).strict(),
  "post-admin-approvals": z
    .object({
      project_id: id.nullable().default(null),
      target_type: z.enum(["pull_request", "job", "deployment", "data_deletion", "restore", "provider_connection"]),
      target_id: z.string().min(1).max(200),
      action_digest: sha256,
      request_reason: z.string().min(1).max(2000),
      expires_in_seconds: z.number().int().min(60).max(86_400).default(3600),
      bound_commit_sha: sha.nullable().optional(),
      diff_sha: sha256.nullable().optional(),
      bound_job_id: id.nullable().optional(),
    })
    .strict(),
  "post-admin-approvals-by-id-resolve": z
    .object({ decision: z.enum(["approve", "deny"]), reason: z.string().max(400).optional() })
    .strict(),
  "post-admin-emergency-stop": z
    .object({ reason: z.string().min(1).max(400), revoke_agent_keys: z.boolean().default(false), cancel_running_jobs: z.boolean().default(true) })
    .strict(),
  "post-admin-backups": z.object({ scope: z.array(z.enum(["identity", "chat", "projects", "git", "files", "memory", "ops"])).min(1).max(7) }).strict(),
  "post-admin-restores-prepare": z.object({ backup_id: z.string().min(1).max(80) }).strict(),
  "post-admin-restores-commit": z.object({ restore_id: z.string().min(1).max(80), approval_id: id }).strict(),
  "post-admin-data-deletion-prepare": z
    .object({
      message_ids: z.array(id).max(500).default([]),
      memory_ids: z.array(id).max(500).default([]),
      file_ids: z.array(id).max(500).default([]),
      artifact_ids: z.array(id).max(500).default([]),
      project_ids: z.array(id).max(50).default([]),
    })
    .strict(),
  "post-admin-data-deletion-commit": z
    .object({
      plan_digest: sha256,
      approval_id: id,
      message_ids: z.array(id).max(500).default([]),
      memory_ids: z.array(id).max(500).default([]),
      file_ids: z.array(id).max(500).default([]),
      artifact_ids: z.array(id).max(500).default([]),
      project_ids: z.array(id).max(50).default([]),
    })
    .strict(),
} as const satisfies Record<string, z.ZodType>;

export type ValidatedOperation = keyof typeof BODY_SCHEMAS;

#!/usr/bin/env node
/**
 * OpenAPI 3.1.0 generator for PROJECT AI ROOM — spec 19.1, 19.2, 19.3, 19.4, 26.1.
 *
 * Source of truth: work/ai_room_pack/PROJECT_AI_ROOM/api_catalog.json (78 endpoints).
 * Output:          docs/api/openapi.json (committed; --check asserts it is in sync)
 *
 * Design rules
 *  - Nothing is invented: methods, paths and the contract sentence come from the
 *    catalog. Auth class, mutability, idempotency and permission action are the
 *    same derivations the shared contract (`scripts/gen-api-contracts.mjs`,
 *    `packages/permissions`) uses, and generation fails if the two disagree.
 *  - Request/response schemas are declared per endpoint family in SCHEMAS_BY_ENDPOINT
 *    below. An endpoint that has no explicit mapping fails generation, so a new
 *    catalog entry cannot silently ship without a schema.
 *  - Every operation carries the QA matrix ids it is accepted by
 *    (`x-ai-room-test-ids`), so an endpoint with no acceptance test is visible.
 *  - The document is validated before it is written (structure, $ref resolution,
 *    path parameters, security schemes, catalog coverage).
 *
 * Usage
 *   node scripts/gen-openapi.mjs            # write docs/api/openapi.json
 *   node scripts/gen-openapi.mjs --check    # fail if the committed file differs
 *   node scripts/gen-openapi.mjs --print    # print to stdout, write nothing
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..");
const SPEC_DIR = resolve(REPO_ROOT, "../work/ai_room_pack/PROJECT_AI_ROOM");
const DEFAULT_CATALOG = resolve(SPEC_DIR, "api_catalog.json");
const DEFAULT_OUT = resolve(REPO_ROOT, "docs/api/openapi.json");
const CONTRACTS_INDEX = resolve(REPO_ROOT, "packages/contracts/src/index.ts");
const GENERATED_CATALOG = resolve(REPO_ROOT, "packages/contracts/src/api-catalog.generated.ts");
const PERMISSIONS_SRC = resolve(REPO_ROOT, "packages/permissions/src/index.ts");

// ---------------------------------------------------------------------------
// Derivations shared with the contract generator (must stay identical)
// ---------------------------------------------------------------------------
const IDEMPOTENT_HINTS = ["/register", "/bootstrap", "/claim", "/jobs", "/messages", "/upload", "/commit"];

/** @param {string} path */
export function pathParamsOf(path) {
  return [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
}

/** @param {string} method @param {string} path */
export function operationIdOf(method, path) {
  const slug = path
    .replace(/^\/v1\/?/, "")
    .replace(/\{([A-Za-z0-9_]+)\}/g, "by-$1")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${method.toLowerCase()}-${slug}`;
}

/** @param {string} path */
export function authOf(path) {
  if (path.startsWith("/v1/health/")) return "public";
  if (path === "/v1/owner/bootstrap") return "owner_bootstrap";
  if (path === "/v1/agents/register") return "invite";
  if (path.startsWith("/v1/auth/")) return "public";
  if (path.startsWith("/v1/admin/") || path.startsWith("/v1/providers/")) return "owner";
  return "authenticated";
}

/** @param {string} method */
export function isMutating(method) {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

/** @param {string} path */
function requiresIdempotencyKey(path) {
  return IDEMPOTENT_HINTS.some((hint) => path.includes(hint));
}

// ---------------------------------------------------------------------------
// Endpoint -> request/response schema and acceptance-test ids
// ---------------------------------------------------------------------------
/**
 * `request` is the body schema name (null for no body).
 * `response` is the success data schema name; `collection: true` wraps it in an array.
 * `page: true` adds the pagination query parameters and the `page` field.
 * `tests` are QA matrix ids from qa_matrix.json — never free text.
 */
const SCHEMAS_BY_ENDPOINT = {
  "POST /v1/owner/bootstrap": { request: "OwnerBootstrapInput", response: "OwnerBootstrapResult", tests: ["QA-016"] },
  "POST /v1/auth/login": { request: "OwnerLoginInput", response: "SessionBundle", tests: ["QA-008"] },
  "POST /v1/auth/logout": { request: "LogoutInput", response: "LogoutResult", tests: ["QA-008"] },
  "POST /v1/auth/refresh": { request: "RefreshInput", response: "SessionBundle", tests: ["QA-008"] },
  "POST /v1/agents/register": { request: "AgentRegisterInput", response: "AgentRegistration", success: 201, tests: ["QA-001", "QA-002", "QA-003", "QA-004", "QA-010"] },
  "POST /v1/agents/login": { request: "AgentLoginInput", response: "AgentSession", tests: ["QA-001", "QA-008"] },
  "POST /v1/agents/rekey": { request: "AgentRekeyInput", response: "AgentKeyBundle", tests: ["QA-007"] },
  "GET /v1/agents": { response: "Agent", collection: true, page: true, tests: ["QA-010"] },
  "GET /v1/agents/{agentId}": { response: "Agent", tests: ["QA-010", "QA-015"] },
  "PATCH /v1/agents/{agentId}": { request: "AgentProfilePatch", response: "Agent", revisionGuard: true, tests: ["QA-005"] },
  "POST /v1/providers/{provider}/connect": { request: "ProviderConnectInput", response: "ProviderConnectChallenge", tests: ["QA-009"] },
  "POST /v1/providers/{provider}/callback": { request: "ProviderCallbackInput", response: "ProviderConnection", tests: ["QA-009", "QA-014"] },
  "POST /v1/providers/{provider}/verify": { request: "ProviderVerifyInput", response: "CapabilityProof", tests: ["QA-009", "QA-014", "QA-015"] },
  "GET /v1/providers/connections": { response: "ProviderConnection", collection: true, tests: ["QA-009"] },
  "POST /v1/providers/connections/{id}/revoke": { request: "ProviderRevokeInput", response: "ProviderConnection", tests: ["QA-014"] },

  "GET /v1/rooms": { response: "Room", collection: true, tests: ["QA-016"] },
  "POST /v1/rooms": { request: "RoomCreateInput", response: "Room", success: 201, tests: ["QA-016", "QA-017"] },
  "GET /v1/rooms/{roomId}": { response: "Room", tests: ["QA-017", "QA-028"] },
  "PATCH /v1/rooms/{roomId}": { request: "RoomPatchInput", response: "Room", revisionGuard: true, tests: ["QA-017"] },
  "POST /v1/rooms/{roomId}/members": { request: "RoomMemberInput", response: "RoomMember", success: 201, tests: ["QA-017", "QA-028"] },
  "DELETE /v1/rooms/{roomId}/members/{actorId}": { response: null, success: 204, tests: ["QA-028"] },
  "GET /v1/rooms/{roomId}/messages": { response: "Message", collection: true, page: true, tests: ["QA-018", "QA-031"] },
  "POST /v1/rooms/{roomId}/messages": { request: "MessageSendInput", response: "Message", success: 201, tests: ["QA-018", "QA-019", "QA-020", "QA-021", "QA-022"] },
  "PATCH /v1/rooms/{roomId}/messages/{messageId}": { request: "MessagePatchInput", response: "Message", revisionGuard: true, tests: ["QA-024"] },
  "DELETE /v1/rooms/{roomId}/messages/{messageId}": { request: "MessageDeleteInput", response: "Message", revisionGuard: true, tests: ["QA-025"] },
  "POST /v1/messages/{messageId}/reactions": { request: "ReactionInput", response: "Reaction", success: 201, tests: ["QA-018"] },
  "GET /v1/messages/{messageId}/versions": { response: "MessageVersion", collection: true, tests: ["QA-024"] },
  "POST /v1/files/upload-intents": { request: "UploadIntentInput", response: "UploadIntent", success: 201, tests: ["QA-034", "QA-036"] },
  "POST /v1/files/uploads/{uploadId}/complete": { request: "UploadCompleteInput", response: "FileAsset", tests: ["QA-035", "QA-036", "QA-037", "QA-038"] },
  "GET /v1/files/{assetId}/download-intent": { response: "DownloadIntent", tests: ["QA-039", "QA-040", "QA-041"] },
  "POST /v1/search": { request: "SearchInput", response: "SearchHit", collection: true, page: true, tests: ["QA-031", "QA-032", "QA-033"] },
  "GET /v1/search/saved": { response: "SavedSearch", collection: true, tests: ["QA-031"] },

  "GET /v1/projects": { response: "Project", collection: true, page: true, tests: ["QA-051"] },
  "POST /v1/projects": { request: "ProjectCreateInput", response: "Project", success: 201, tests: ["QA-051", "QA-053"] },
  "GET /v1/projects/{projectId}": { response: "Project", tests: ["QA-051", "QA-053"] },
  "PATCH /v1/projects/{projectId}": { request: "ProjectPatchInput", response: "Project", revisionGuard: true, tests: ["QA-051"] },
  "POST /v1/projects/{projectId}/rooms/link": { request: "RoomLinkInput", response: "ProjectRoomLink", success: 201, tests: ["QA-052", "QA-053"] },
  "GET /v1/projects/{projectId}/tasks": { response: "Task", collection: true, tests: ["QA-056"] },
  "POST /v1/projects/{projectId}/tasks": { request: "TaskCreateInput", response: "Task", success: 201, tests: ["QA-054", "QA-056", "QA-057"] },
  "POST /v1/tasks/{taskId}/claim-proposals": { request: "ClaimProposalInput", response: "ClaimProposal", success: 201, tests: ["QA-054", "QA-055"] },
  "POST /v1/tasks/{taskId}/claims/accept": { request: "ClaimAcceptInput", response: "Task", conflict: 409, tests: ["QA-054", "QA-058"] },
  "POST /v1/tasks/{taskId}/transition": { request: "TaskTransitionInput", response: "Task", conflict: 409, tests: ["QA-056", "QA-059", "QA-065"] },
  "POST /v1/tasks/{taskId}/handoff": { request: "TaskHandoffInput", response: "Task", tests: ["QA-060"] },
  "POST /v1/tasks/{taskId}/checkpoint": { request: "CheckpointInput", response: "TaskCheckpoint", success: 201, tests: ["QA-060"] },
  "GET /v1/projects/{projectId}/memories": { response: "MemoryRecord", collection: true, page: true, tests: ["QA-043", "QA-045", "QA-046"] },
  "POST /v1/projects/{projectId}/memories": { request: "MemoryCreateInput", response: "MemoryRecord", success: 201, tests: ["QA-043", "QA-044"] },
  "POST /v1/projects/{projectId}/memories/search": { request: "MemorySearchInput", response: "SearchHit", collection: true, page: true, tests: ["QA-031", "QA-043"] },
  "POST /v1/projects/{projectId}/shares": { request: "ShareInput", response: "ShareGrant", success: 201, tests: ["QA-045", "QA-046"] },
  "GET /v1/projects/{projectId}/dashboard": { response: "ProjectDashboard", tests: ["QA-094"] },

  "GET /v1/projects/{projectId}/ide/tree": { response: "FileTreeNode", collection: true, tests: ["QA-066"] },
  "GET /v1/projects/{projectId}/ide/documents/{docId}": { response: "Document", tests: ["QA-066"] },
  "POST /v1/projects/{projectId}/ide/publish": { request: "DocumentPublishInput", response: "PublishResult", conflict: 409, tests: ["QA-067", "QA-070"] },
  "GET /v1/projects/{projectId}/git/branches": { response: "Branch", collection: true, tests: ["QA-069"] },
  "POST /v1/projects/{projectId}/git/branches": { request: "BranchCreateInput", response: "Branch", success: 201, tests: ["QA-069", "QA-070"] },
  "POST /v1/projects/{projectId}/git/pull-requests": { request: "PullRequestCreateInput", response: "PullRequest", success: 201, tests: ["QA-071"] },
  "POST /v1/projects/{projectId}/git/reviews": { request: "ReviewInput", response: "Review", success: 201, tests: ["QA-071", "QA-079"] },
  "POST /v1/projects/{projectId}/git/merge": { request: "MergeInput", response: "MergeResult", tests: ["QA-079", "QA-080", "QA-081"] },
  "POST /v1/projects/{projectId}/jobs": { request: "JobDispatchInput", response: "Job", success: 201, tests: ["QA-072", "QA-073", "QA-083"] },
  "GET /v1/projects/{projectId}/jobs/{jobId}": { response: "Job", tests: ["QA-072", "QA-078"] },
  "POST /v1/projects/{projectId}/jobs/{jobId}/cancel": { request: "JobCancelInput", response: "Job", tests: ["QA-072", "QA-097"] },
  "GET /v1/projects/{projectId}/jobs/{jobId}/logs": { response: "JobLogChunk", collection: true, page: true, tests: ["QA-082"] },
  "GET /v1/projects/{projectId}/artifacts": { response: "Artifact", collection: true, tests: ["QA-084", "QA-085", "QA-086"] },
  "POST /v1/projects/{projectId}/artifacts/{artifactId}/verify": { request: "ArtifactVerifyInput", response: "Artifact", tests: ["QA-084", "QA-085"] },
  "POST /v1/projects/{projectId}/artifacts/{artifactId}/download-intent": { request: "ArtifactDownloadInput", response: "DownloadIntent", tests: ["QA-040"] },
  "GET /v1/projects/{projectId}/reports": { response: "ProjectReport", collection: true, tests: ["QA-103"] },

  "GET /v1/admin/overview": { response: "AdminOverview", tests: ["QA-098"] },
  "GET /v1/admin/required-agents": { response: "RequiredAgentsStatus", tests: ["QA-101"] },
  "POST /v1/admin/approvals": { request: "ApprovalRequestInput", response: "Approval", success: 201, tests: ["QA-065", "QA-096"] },
  "POST /v1/admin/approvals/{id}/resolve": { request: "ApprovalResolveInput", response: "Approval", tests: ["QA-065", "QA-096"] },
  "POST /v1/admin/emergency-stop": { request: "EmergencyStopInput", response: "EmergencyStopResult", tests: ["QA-097"] },
  "GET /v1/admin/audit-events": { response: "AuditEvent", collection: true, page: true, tests: ["QA-006"] },
  "GET /v1/admin/resource-budgets": { response: "UsageBudget", collection: true, tests: ["QA-098", "QA-064"] },
  "POST /v1/admin/backups": { request: "BackupInput", response: "BackupManifest", success: 201, tests: ["QA-048", "QA-100"] },
  "POST /v1/admin/restores/prepare": { request: "RestorePrepareInput", response: "RestorePlan", tests: ["QA-049", "QA-100"] },
  "POST /v1/admin/restores/commit": { request: "RestoreCommitInput", response: "RestoreRun", tests: ["QA-049", "QA-050"] },
  "POST /v1/admin/data-deletion/prepare": { request: "DataDeletionPrepareInput", response: "DataDeletionPlan", tests: ["QA-099"] },
  "POST /v1/admin/data-deletion/commit": { request: "DataDeletionCommitInput", response: "DataDeletionRun", tests: ["QA-099"] },
  "GET /v1/admin/release-gates": { response: "ReleaseGates", tests: ["QA-102"] },
};

// Spec 19.2 also names GET /v1/health/live and /ready. They are NOT in
// api_catalog.json (78), so this document deliberately stays at 78/78 and the
// gap is recorded in docs/api/README.md instead of being papered over with
// invented endpoints.

const GROUP_TAGS = {
  "신원·등록·세션": "소유자 부트스트랩·세션, AI 초대/등록/키, 제공자 연결 검증",
  "채팅·파일·검색": "방·메시지·리액션, 파일 업로드/다운로드, 검색",
  "프로젝트·기억·작업": "프로젝트·방 연결, 작업 상태 머신·자율 배정·인계, 3계층 기억",
  "IDE·Git·CI·결과물": "웹 IDE 스냅샷, 브랜치/PR/리뷰/병합, Actions 작업과 산출물",
  "관리·감사·운영": "운영 대시보드, 승인, 비상 정지, 감사, 예산, 백업/복원/삭제, 릴리스 게이트",
};

// ---------------------------------------------------------------------------
// Component schemas
// ---------------------------------------------------------------------------
const S = (properties, required = Object.keys(properties), description) => ({
  type: "object",
  ...(description === undefined ? {} : { description }),
  properties,
  required,
  additionalProperties: false,
});
const str = (description, extra = {}) => ({ type: "string", ...(description ? { description } : {}), ...extra });
const int = (description, extra = {}) => ({ type: "integer", ...(description ? { description } : {}), ...extra });
const bool = (description) => ({ type: "boolean", ...(description ? { description } : {}) });
const arr = (items, description) => ({ type: "array", ...(description ? { description } : {}), items });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const oneOfRefs = (...names) => ({ oneOf: names.map(ref) });
const nullableStr = (description) => ({ type: ["string", "null"], ...(description ? { description } : {}) });

const UTC = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", description: "UTC ISO-8601, millisecond precision" };
const ID = (kind) => ({ type: "string", pattern: `^${kind}_[0-9A-HJKMNP-TV-Z]{26}$`, description: `${kind}_ + UUIDv7 (Crockford base32), server-minted only` });

/** Field lists follow db/migrations/0001_initial.sql and packages/contracts. */
const SCHEMAS = {
  RequestMeta: S({
    request_id: str("Correlation id; echoed on the response"),
    idempotency_key: str("Required on mutating endpoints that create work; replays return the first result"),
    client_time: UTC,
  }, ["request_id"]),
  PageInfo: S({
    next_cursor: { type: ["string", "null"] },
    has_more: bool(),
    order: { type: "string", enum: ["asc", "desc"] },
    total_estimate: { type: ["integer", "null"], minimum: 0 },
  }),
  ErrorObject: S({
    code: { type: "string", description: "Stable machine code (see x-ai-room-error-codes)" },
    message: str("Human message in the product language; never an internal detail"),
    retryable: bool(),
    details: { type: "object", additionalProperties: true, description: "Field-level, non-secret context" },
  }),
  ErrorEnvelope: S({
    ok: { const: false },
    error: ref("ErrorObject"),
    request_id: str(),
  }),
  SuccessEnvelope: S({
    ok: { const: true },
    data: { description: "Endpoint payload; replaced per operation via allOf" },
    request_id: str(),
    server_time: UTC,
    page: ref("PageInfo"),
  }, ["ok", "data", "request_id", "server_time"]),
  HealthStatus: S({
    status: { type: "string", enum: ["ok", "degraded", "down"] },
    checks: { type: "array", items: S({ name: str(), status: { type: "string", enum: ["ok", "degraded", "down", "unknown"] }, observed_at: UTC }, ["name", "status"]) },
    build: S({ version: str(), commit: nullableStr() }, ["version", "commit"]),
  }, ["status", "checks", "build"]),

  OwnerBootstrapInput: S({
    display_name: str(),
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 12, description: "Hashed with PBKDF2-SHA256 on the server; never stored in D1" },
    bootstrap_secret: { type: "string", minLength: 16, description: "Matches OWNER_BOOTSTRAP_SECRET; constant-time compare" },
    request_id: str(),
  }, ["display_name", "email", "password", "bootstrap_secret", "request_id"]),
  OwnerBootstrapResult: S({
    owner_id: ID("owner"),
    display_name: str(),
    password_verifier: str("Set this as the OWNER_PASSWORD_VERIFIER Worker secret — shown once"),
    invite_secret: str("First agent invite secret — shown once"),
    invite_id: ID("inst"),
    next_step: str(),
  }),
  OwnerLoginInput: S({ email: { type: "string", format: "email" }, password: str(), request_id: str() }, ["email", "password", "request_id"]),
  SessionBundle: S({
    session_id: ID("sess"),
    subject_kind: { type: "string", enum: ["owner", "agent"] },
    subject_id: str(),
    assurance: { type: "string", enum: ["owner_ui", "agent_key", "service", "none"] },
    access_token: str(),
    access_expires_at: UTC,
    refresh_token: str("Rotating; reuse is refused"),
    refresh_expires_at: UTC,
  }),
  AgentSession: {
    allOf: [ref("SessionBundle"), S({ agent_id: ID("agent") }, ["agent_id"])],
  },
  LogoutInput: S({ refresh_token: str(), request_id: str() }, ["request_id"]),
  LogoutResult: S({ revoked_sessions: int() }, ["revoked_sessions"]),
  RefreshInput: S({ refresh_token: str(), request_id: str() }, ["refresh_token", "request_id"]),
  AgentRegisterInput: S({
    display_name: str(),
    avatar_asset_id: str("Uploaded art_/file_ asset — required, no default avatar"),
    claimed_provider: nullableStr("Free-text self-claim; never a verification badge"),
    description: str(),
    model_name: nullableStr(),
    invite_secret: str("Passed as X-Agent-Invite-Secret or here; single use"),
    request_id: str(),
    idempotency_key: str(),
  }, ["display_name", "avatar_asset_id", "invite_secret", "request_id"]),
  AgentRegistration: S({
    agent: ref("Agent"),
    credential: ref("AgentKeyBundle"),
    session: ref("SessionBundle"),
    identity: S({
      verification_state: { const: "self_declared" },
      provider_verified: { const: false },
      note: str(),
    }),
  }),
  AgentLoginInput: S({ agent_key: str(), request_id: str() }, ["agent_key", "request_id"]),
  AgentRekeyInput: S({ expected_credential_id: str(), request_id: str() }, ["expected_credential_id", "request_id"]),
  AgentKeyBundle: S({
    agent_id: ID("agent"),
    credential_id: ID("cred"),
    agent_key: str("Plaintext key, returned exactly once"),
    key_prefix: str(),
  }),
  AgentProfilePatch: S({
    display_name: str(),
    avatar_asset_id: str(),
    description: str(),
    model_name: { type: ["string", "null"] },
    company: str(),
    pronouns: str(),
    request_id: str(),
  }, ["request_id"], "Allowlist only; immutable fields are rejected with VALIDATION_FAILED"),
  Agent: S({
    agent_id: ID("agent"),
    display_name: str(),
    avatar_asset_id: str(),
    claimed_provider: nullableStr(),
    description: nullableStr(),
    model_name: nullableStr(),
    identity: S({
      verification_state: { type: "string", enum: ["self_declared", "provider_verified", "disputed", "revoked"] },
      provider_verified: bool(),
    }),
    capabilities: arr(ref("CapabilityProof")),
    connection_state: { type: "string", enum: ["none", "pending", "connected", "expired", "revoked", "blocked"] },
    created_at: UTC,
    updated_at: UTC,
  }),
  ProviderConnectInput: S({ agent_id: ID("agent"), redirect_uri: str(), request_id: str() }, ["agent_id", "request_id"]),
  ProviderConnectChallenge: S({ state: str(), nonce: str(), pkce_challenge: str(), authorize_url: str(), expires_at: UTC }),
  ProviderCallbackInput: S({ code: str(), state: str(), nonce: str(), pkce_verifier: str(), request_id: str() }, ["code", "state", "request_id"]),
  ProviderVerifyInput: S({ capability: { type: "string", enum: ["message.send", "code.patch", "review.read", "tool.call"] }, request_id: str() }, ["capability", "request_id"]),
  ProviderRevokeInput: S({ reason: str(), request_id: str() }, ["request_id"]),
  ProviderConnection: S({
    connection_id: ID("conn"),
    agent_id: ID("agent"),
    provider_key: str(),
    auth_method: { type: "string", enum: ["api_key", "oauth", "app_installation", "none"] },
    state: { type: "string", enum: ["pending", "connected", "expired", "revoked", "blocked"] },
    evidence_ref: nullableStr(),
    expires_at: nullableStr(),
    updated_at: UTC,
  }),
  CapabilityProof: S({
    capability: str(),
    state: { type: "string", enum: ["unverified", "verified", "unsupported", "expired"] },
    provider_response_id: nullableStr("Required for verified: a self-claim cannot verify"),
    attestation: { type: "string", enum: ["self_declared", "provider_verified"] },
    verified_at: nullableStr(),
  }),

  RoomCreateInput: S({
    name: str(null, {}),
    room_type: { type: "string", enum: ["project", "custom"] },
    project_id: nullableStr(),
    request_id: str(),
  }, ["name", "request_id", "room_type"]),
  RoomPatchInput: S({ name: str(), request_id: str(), expected_revision: int(null, { minimum: 1 }) }, ["request_id", "expected_revision"]),
  Room: S({
    room_id: ID("room"),
    room_type: { type: "string", enum: ["main", "project", "custom"] },
    name: str(),
    project_id: nullableStr(),
    revision: int(null, { minimum: 1 }),
    member_count: int(),
    created_at: UTC,
    updated_at: UTC,
  }),
  RoomMemberInput: S({
    actor_kind: { type: "string", enum: ["agent", "owner"] },
    actor_id: str(),
    role: { type: "string", enum: ["owner", "contributor", "viewer"] },
    request_id: str(),
  }, ["actor_kind", "actor_id", "role", "request_id"]),
  RoomMember: S({ room_id: ID("room"), actor_kind: str(), actor_id: str(), role: str(), joined_at: UTC, left_at: nullableStr() }),
  MessageSendInput: S({
    blocks: arr(ref("MessageBlock"), "Structured content; never raw HTML"),
    client_nonce: str("Idempotency for the sender"),
    reply_to_message_id: nullableStr(),
    mentioned_agent_ids: arr(str()),
    request_id: str(),
  }, ["blocks", "request_id"]),
  MessagePatchInput: S({
    blocks: arr(ref("MessageBlock")),
    expected_revision: int(null, { minimum: 1 }),
    request_id: str(),
  }, ["blocks", "expected_revision", "request_id"]),
  MessageDeleteInput: S({ expected_revision: int(null, { minimum: 1 }), request_id: str() }, ["expected_revision", "request_id"]),
  Message: S({
    message_id: ID("msg"),
    room_id: ID("room"),
    room_seq: int("Server-assigned per-room sequence from the Room DO"),
    author_kind: { type: "string", enum: ["owner", "agent", "system"] },
    author_id: str(),
    revision: int(null, { minimum: 1 }),
    blocks: arr(ref("MessageBlock")),
    body_plain_text: str(),
    reply_to_message_id: nullableStr(),
    delivery_state: { type: "string", enum: ["stored", "acknowledged", "read_unknown", "dead_letter"] },
    created_at: UTC,
    edited_at: nullableStr(),
    deleted_at: nullableStr(),
  }),
  MessageBlock: S({
    block_id: str(),
    block_type: { type: "string", enum: ["text", "markdown", "code", "diff", "file", "image", "quote", "task_ref", "commit_ref", "pr_ref", "artifact_ref", "chart", "table", "callout"] },
    payload: { type: "object", additionalProperties: true, description: "Rendering data only; never trusted as HTML" },
  }),
  MessageVersion: S({
    message_id: ID("msg"),
    revision: int(),
    blocks: arr(ref("MessageBlock")),
    body_plain_text: str(),
    content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    editor_kind: str(),
    editor_id: str(),
    created_at: UTC,
  }),
  ReactionInput: S({ emoji: str(null, { maxLength: 32 }), request_id: str() }, ["emoji", "request_id"]),
  Reaction: S({ message_id: ID("msg"), actor_kind: str(), actor_id: str(), emoji: str(), created_at: UTC }),

  UploadIntentInput: S({
    filename: str(null, { maxLength: 255 }),
    mime_declared: str(),
    size_bytes: int(null, { minimum: 0 }),
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    project_id: nullableStr(),
    room_id: nullableStr(),
    request_id: str(),
  }, ["filename", "mime_declared", "size_bytes", "request_id"]),
  UploadIntent: S({
    upload_id: str(),
    asset_id: str(),
    upload_url: str(),
    part_size_bytes: int(),
    max_parts: int(),
    expires_at: UTC,
  }),
  UploadCompleteInput: S({
    parts: arr(S({ part_number: int(), etag: str() }, ["part_number", "etag"])),
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    request_id: str(),
  }, ["parts", "sha256", "request_id"]),
  FileAsset: S({
    asset_id: str(),
    filename: str(),
    mime_declared: str(),
    mime_detected: nullableStr(),
    size_bytes: int(),
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    storage_state: { type: "string", enum: ["pending", "ready", "quarantined", "deleted", "failed"] },
    scan_state: { type: "string", enum: ["pending", "clean", "infected", "skipped"] },
    created_at: UTC,
  }),
  DownloadIntent: S({
    url: str("Short-lived signed URL"),
    expires_at: UTC,
    single_use: bool(),
    sha256: nullishSha(),
  }),

  SearchInput: S({
    query: str(null, { maxLength: 200 }),
    kinds: arr({ type: "string", enum: ["message", "memory", "task", "document", "project"] }),
    project_id: nullableStr(),
    room_id: nullableStr(),
    limit: int(null, { maximum: 100 }),
    cursor: nullableStr(),
    request_id: str(),
  }, ["query", "request_id"]),
  SearchHit: S({
    kind: { type: "string", enum: ["message", "memory", "task", "document", "project"] },
    id: str(),
    title: str(),
    snippet: str(),
    project_id: nullableStr(),
    room_id: nullableStr(),
    source_refs: arr(str()),
    score: { type: "number", description: "FTS rank; not comparable across queries" },
  }),
  SearchAccess: S({ project_ids: arr(str()), room_ids: arr(str()) }),
  SavedSearch: S({ saved_search_id: str(), name: str(), query: str(), filters: { type: "object", additionalProperties: true }, created_at: UTC }),

  ProjectCreateInput: S({ name: str(null, { maxLength: 120 }), description: str(), request_id: str() }, ["name", "request_id"]),
  ProjectPatchInput: S({ name: str(), description: str(), expected_revision: int(null, { minimum: 1 }), request_id: str() }, ["expected_revision", "request_id"]),
  Project: S({
    project_id: ID("proj"),
    name: str(),
    description: nullableStr(),
    revision: int(),
    task_counts: { type: "object", additionalProperties: int() },
    created_at: UTC,
    updated_at: UTC,
  }),
  RoomLinkInput: S({ room_id: ID("room"), allow_shared_memory: bool(), request_id: str() }, ["room_id", "request_id"]),
  ProjectRoomLink: S({ project_id: ID("proj"), room_id: ID("room"), linked_at: UTC, linked_by: str() }),

  TaskCreateInput: S({
    title: str(),
    description: str(),
    requirement_ids: arr(str(), "Q001..Q041 ids this task serves"),
    dependency_task_ids: arr(str()),
    request_id: str(),
  }, ["title", "request_id"]),
  Task: S({
    task_id: ID("task"),
    project_id: ID("proj"),
    title: str(),
    description: nullableStr(),
    state: { type: "string", enum: ["DRAFT", "SPECIFIED", "PROPOSED", "CLAIM_ACCEPTED", "READY", "LEASED", "RUNNING", "REVIEW_PENDING", "VERIFYING", "DONE", "BLOCKED", "CANCELLED", "FAILED"] },
    revision: int(),
    dependencies: arr(str()),
    assignee_agent_id: nullableStr(),
    lease: { oneOf: [ref("TaskLease"), { type: "null" }] },
    requirement_ids: arr(str()),
    created_at: UTC,
    updated_at: UTC,
  }),
  TaskLease: S({ attempt_id: ID("att"), agent_id: ID("agent"), fencing_generation: int(), expires_at: UTC }),
  ClaimProposalInput: S({ rationale: str(), capability_evidence_ids: arr(str()), proposed_transition: str(), request_id: str() }, ["rationale", "request_id"]),
  ClaimProposal: S({ proposal_id: str(), task_id: ID("task"), agent_id: ID("agent"), rationale: str(), state: { type: "string", enum: ["open", "accepted", "rejected"] }, created_at: UTC }),
  ClaimAcceptInput: S({ proposal_id: str(), accepted_by_agent_ids: arr(str()), expected_revision: int(null, { minimum: 1 }), request_id: str() }, ["proposal_id", "expected_revision", "request_id"]),
  TaskTransitionInput: S({
    expected_revision: int(null, { minimum: 1 }),
    to_status: { type: "string", description: "Target task state; DONE requires verified evidence" },
    evidence_ids: arr(str()),
    note: str(),
    request_id: str(),
  }, ["expected_revision", "to_status", "request_id"]),
  TaskHandoffInput: S({ to_agent_id: ID("agent"), last_checkpoint_id: nullableStr(), reason: str(), request_id: str() }, ["to_agent_id", "reason", "request_id"]),
  CheckpointInput: S({ attempt_id: ID("att"), state_json: { type: "object", additionalProperties: true }, request_id: str() }, ["attempt_id", "state_json", "request_id"]),
  TaskCheckpoint: S({ checkpoint_id: str(), task_id: ID("task"), attempt_id: ID("att"), created_at: UTC }),

  MemoryCreateInput: S({
    scope: { type: "string", enum: ["agent_private", "room", "project", "shared"] },
    memory_kind: { type: "string", enum: ["fact", "decision", "hypothesis", "note", "task_result"] },
    body: str(),
    sources: arr(ref("MemorySource"), "At least one; a fact with no source is refused"),
    trust: { type: "string", enum: ["unverified", "corroborated", "disputed"] },
    request_id: str(),
  }, ["scope", "memory_kind", "body", "sources", "request_id"]),
  MemorySource: S({ source_kind: { type: "string", enum: ["message", "file", "task", "commit", "external_url", "owner_statement", "agent_inference"] }, source_id: str(), quote: nullableStr() }, ["source_kind", "source_id"]),
  MemoryRecord: S({
    memory_id: ID("mem"),
    memory_scope: { type: "string", enum: ["agent_private", "room", "project", "shared"] },
    scope_id: str(),
    project_id: nullableStr(),
    memory_kind: str(),
    body_text: str(),
    trust_state: { type: "string", enum: ["unverified", "corroborated", "disputed"] },
    sources: arr(ref("MemorySource")),
    conflict_group_id: nullableStr("Set when two records contradict; neither silently overwrites the other"),
    revision: int(),
    created_at: UTC,
    updated_at: UTC,
    deleted_at: nullableStr(),
  }),
  MemorySearchInput: S({ query: str(null, { maxLength: 200 }), limit: int(null, { maximum: 100 }), cursor: nullableStr(), include_shared: bool(), request_id: str() }, ["query", "request_id"]),
  ShareInput: S({ target_project_id: ID("proj"), memory_ids: arr(str()), scope: { type: "string", enum: ["read", "read_write"] }, expires_at: nullableStr(), request_id: str() }, ["target_project_id", "memory_ids", "scope", "request_id"]),
  ShareGrant: S({ share_id: str(), source_project_id: ID("proj"), target_project_id: ID("proj"), memory_ids: arr(str()), scope: str(), expires_at: nullableStr(), created_at: UTC }),
  ProjectDashboard: S({
    project_id: ID("proj"),
    metrics: arr(ref("MetricValue"), "50 metrics; unavailable is never reported as 0"),
    alerts: arr(S({ alert_id: str(), severity: str(), message: str(), raised_at: UTC })),
    generated_at: UTC,
  }),
  MetricValue: S({
    metric_key: str(),
    value: { type: ["number", "null"] },
    unit: nullableStr(),
    source: { type: "string", enum: ["measured", "estimated", "unavailable"] },
    observed_at: nullableStr(),
  }),

  FileTreeNode: S({ path: str(), kind: { type: "string", enum: ["file", "directory", "symlink"] }, size_bytes: { type: ["integer", "null"] }, sha256: nullishSha() }),
  Document: S({ doc_id: ID("doc"), project_id: ID("proj"), path: str(), head_sha: nullableStr(), snapshot_sha: nullableStr(), revision: int(), updated_at: UTC }),
  DocumentPublishInput: S({ doc_id: ID("doc"), base_sha: nullableStr(), commit_message: str(null, { maxLength: 200 }), request_id: str() }, ["doc_id", "commit_message", "request_id"]),
  PublishResult: S({ status: { type: "string", enum: ["PUBLISHED", "CONFLICT", "UNSUPPORTED"] }, commit_sha: nullableStr(), remote_head_sha: nullableStr(), reason: nullableStr() }),
  Branch: S({ name: str(), head_sha: nullishSha(), protected: bool(), updated_at: UTC }),
  BranchCreateInput: S({ name: str(), from_sha: str(), request_id: str() }, ["name", "from_sha", "request_id"]),
  PullRequestCreateInput: S({ title: str(), head_branch: str(), base_branch: str(), body: str(), draft: bool(), request_id: str() }, ["title", "head_branch", "base_branch", "request_id"]),
  PullRequest: S({
    pr_id: ID("pr"),
    number: int(),
    title: str(),
    head_sha: nullishSha(),
    base_sha: nullishSha(),
    reviewed_sha: nullableStr(),
    state: { type: "string", enum: ["OPEN", "REVIEW_PENDING", "APPROVED", "MERGED", "CLOSED"] },
    url: str(),
    ci_state: { type: "string", enum: ["unknown", "pending", "success", "failure", "cancelled"] },
  }),
  ReviewInput: S({ pr_id: ID("pr"), reviewed_sha: str(), verdict: { type: "string", enum: ["approve", "request_changes", "comment"] }, comments: arr(S({ path: str(), line: int(), body: str() }, ["path", "body"])), request_id: str() }, ["pr_id", "reviewed_sha", "verdict", "request_id"]),
  Review: S({ review_id: ID("rvw"), pr_id: ID("pr"), reviewed_sha: str(), verdict: str(), author_agent_id: str(), submitted_at: UTC }),
  MergeInput: S({ pr_id: ID("pr"), expected_head_sha: str(), approval_id: nullableStr(), merge_method: { type: "string", enum: ["merge", "squash", "rebase"] }, request_id: str() }, ["pr_id", "expected_head_sha", "request_id"]),
  MergeResult: S({ merged: bool(), merge_commit_sha: nullableStr(), blocking: arr(S({ id: str(), detail: str(), error_code: nullableStr() }, ["id", "detail"])) }),

  JobDispatchInput: S({ kind: { type: "string", enum: ["build", "test", "package_web", "package_windows", "package_android"] }, workflow_ref: str(), ref_sha: str(), approval_id: nullableStr(), request_id: str() }, ["kind", "workflow_ref", "ref_sha", "request_id"]),
  JobCancelInput: S({ reason: str(), request_id: str() }, ["request_id"]),
  Job: S({
    job_id: ID("job"),
    project_id: ID("proj"),
    kind: str(),
    state: { type: "string", enum: ["QUEUED", "DISPATCH_REQUESTED", "DISPATCHED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "CANCEL_REQUESTED", "BLOCKED"] },
    head_sha: nullishSha(),
    ci_run_id: nullableStr("GitHub Actions run id; never invented"),
    conclusion: { type: "string", enum: ["success", "failure", "cancelled", "timed_out", "skipped", "unknown"] },
    started_at: nullableStr(),
    finished_at: nullableStr(),
  }),
  JobLogChunk: S({ job_id: ID("job"), seq: int(), lines: arr(str()), redacted: bool(), truncated: bool() }),
  Artifact: S({
    artifact_id: ID("art"),
    project_id: ID("proj"),
    artifact_type: { type: "string", enum: ["web", "windows_exe", "android_apk", "report", "log_bundle", "other"] },
    version: str(),
    sha256: nullishSha(),
    size_bytes: { type: ["integer", "null"] },
    verification_state: { type: "string", enum: ["unverified", "verified", "mismatch", "quarantined"] },
    manifest: { type: "object", additionalProperties: true },
    created_at: UTC,
  }),
  ArtifactVerifyInput: S({ computed_sha256: str(), expected_git_sha: nullableStr(), request_id: str() }, ["computed_sha256", "request_id"]),
  ArtifactDownloadInput: S({ request_id: str(), ttl_seconds: int(null, { maximum: 900 }) }, ["request_id"]),
  ProjectReport: S({ report_id: str(), project_id: ID("proj"), status: str(), evidence_refs: arr(str()), generated_at: UTC, caveats: arr(str()) }),

  AdminOverview: S({
    gate_status: str(),
    emergency_stop: oneOfRefs("EmergencyStopState", "NullValue"),
    quotas: arr(ref("UsageBudget")),
    active_jobs: int(),
    alerts: arr(str()),
  }),
  RequiredAgentsStatus: S({
    gate: { type: "string", enum: ["PASS", "BLOCKED_EXTERNAL_DEPENDENCY", "FAILED"] },
    required: arr(S({ provider_key: str(), display_label: str(), required: bool(), state: str(), evidence_ref: nullableStr() }, ["provider_key", "display_label", "required", "state"])),
    blockers: arr(S({ provider_key: str(), state: str(), reason: str() }, ["provider_key", "state", "reason"])),
  }, ["gate", "required", "blockers"]),
  ApprovalRequestInput: S({
    project_id: nullableStr(),
    target_type: { type: "string", enum: ["pull_request", "job", "artifact", "deletion", "restore", "policy"] },
    target_id: str(),
    request_reason: str(),
    bound_commit_sha: nullableStr(),
    diff_sha: nullableStr(),
    ttl_ms: int(null, { minimum: 60_000, maximum: 86_400_000 }),
    request_id: str(),
  }, ["target_type", "target_id", "request_reason", "request_id"]),
  ApprovalResolveInput: S({ decision: { type: "string", enum: ["approve", "reject"] }, note: str(), action_digest: str("Must equal the requested digest; the server recomputes it"), request_id: str() }, ["decision", "action_digest", "request_id"]),
  Approval: S({
    approval_id: ID("apr"),
    project_id: nullableStr(),
    target_type: str(),
    target_id: str(),
    action_digest: str(),
    bound_commit_sha: nullableStr(),
    state: { type: "string", enum: ["PENDING", "APPROVED", "DENIED", "EXPIRED", "INVALIDATED", "REVOKED"] },
    requested_by: S({ kind: str(), id: str() }, ["kind", "id"]),
    requested_at: UTC,
    decided_at: nullableStr(),
    expires_at: UTC,
  }),
  EmergencyStopInput: S({ reason: str(), scope: { type: "string", enum: ["all", "project"] }, project_id: nullableStr(), request_id: str() }, ["reason", "scope", "request_id"]),
  EmergencyStopResult: S({ engaged_at: UTC, scope: str(), dispatch_blocked: bool(), cancel_requested_jobs: arr(str()) }),
  EmergencyStopState: S({ engaged: bool(), engaged_at: nullableStr(), reason: nullableStr() }),
  AuditEvent: S({ audit_id: ID("evt"), event_type: str(), actor_kind: str(), actor_id: str(), target_type: str(), target_id: str(), allow_or_deny: { type: "string", enum: ["allow", "deny"] }, reason_code: nullableStr(), created_at: UTC }),
  UsageBudget: S({
    budget_id: str(),
    provider: str(),
    resource_kind: str(),
    hard_limit_value: { type: ["number", "null"] },
    observed_value: { type: ["number", "null"], description: "null when unmeasured — never coerced to 0" },
    observation_state: { type: "string", enum: ["measured", "estimated", "unknown"] },
    period_start: UTC,
    period_end: UTC,
  }),
  BackupInput: S({ scope: { type: "string", enum: ["db", "db_and_manifests", "full"] }, note: str(), request_id: str() }, ["scope", "request_id"]),
  BackupManifest: S({ backup_id: str(), created_at: UTC, db_checksum: str(), object_count: int(), schema_version: str(), encrypted: bool(), restore_tested_at: nullableStr() }),
  RestorePrepareInput: S({ backup_id: str(), target_time: nullableStr(), overwrite_scope: { type: "string", enum: ["none", "project", "all"] }, project_id: nullableStr(), request_id: str() }, ["backup_id", "overwrite_scope", "request_id"]),
  RestorePlan: S({ restore_id: str(), backup_id: str(), target_time: nullableStr(), overwrite_scope: str(), risks: arr(str()), missing_objects: arr(str()), requires_approval: bool(), dry_run: bool() }),
  RestoreCommitInput: S({ restore_id: str(), approval_id: str(), confirm_phrase: str(), request_id: str() }, ["restore_id", "approval_id", "confirm_phrase", "request_id"]),
  RestoreRun: S({ restore_id: str(), state: { type: "string", enum: ["QUEUED", "RUNNING", "VERIFIED", "FAILED", "ABORTED"] }, integrity: { type: "object", additionalProperties: true }, started_at: UTC, finished_at: nullableStr() }),
  DataDeletionPrepareInput: S({ scope: { type: "string", enum: ["project", "room", "agent", "memory"] }, target_id: str(), include_backups: bool(), request_id: str() }, ["scope", "target_id", "request_id"]),
  DataDeletionPlan: S({ deletion_id: str(), scope: str(), affected: { type: "object", additionalProperties: int() }, irreversible_limits: arr(str()), requires_approval: bool() }),
  DataDeletionCommitInput: S({ deletion_id: str(), approval_id: str(), plan_digest: str(), request_id: str() }, ["deletion_id", "approval_id", "plan_digest", "request_id"]),
  DataDeletionRun: S({ deletion_id: str(), state: { type: "string", enum: ["QUEUED", "RUNNING", "DONE", "PARTIAL", "FAILED"] }, propagated: arr(str()), failed_targets: arr(str()) }),
  ReleaseGates: S({
    release_status: { type: "string", enum: ["COMPLETE", "NOT_RELEASE_READY", "BLOCKED_EXTERNAL_DEPENDENCY", "INCOMPLETE", "NOT_PRODUCED", "NOT_AUTHORIZED", "UNSUPPORTED"] },
    gates: arr(S({ id: str(), status: { type: "string", enum: ["PASS", "FAILED", "BLOCKED", "NOT_TESTED", "PARTIAL"] }, evidence: arr(str()) }, ["id", "status"])),
    evaluated_at: UTC,
  }),
  NullValue: { type: "null" },
  EventEnvelope: S({
    schema_version: { const: 1 },
    event_id: ID("evt"),
    event_type: str(),
    occurred_at: UTC,
    actor: S({ type: { type: "string", enum: ["owner", "agent", "system"] }, id: str() }, ["type", "id"]),
    aggregate: S({ type: str(), id: str(), revision: int() }, ["type", "id", "revision"]),
    scope: S({ room_id: nullableStr(), project_id: nullableStr() }, ["room_id", "project_id"]),
    correlation_id: str(),
    payload: { type: "object", additionalProperties: true },
  }),
  ClientFrame: S({
    type: { type: "string", enum: ["HELLO", "SEND_MESSAGE", "PING", "ACK"] },
    ticket_id: str(),
    last_seen_seq: int(null, { minimum: 0 }),
    client_capabilities: arr(str()),
  }),
};

/** `nullishSha` is declared after use above for readability; defined here once. */
function nullishSha() {
  return { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" };
}

// ---------------------------------------------------------------------------
// Response components
// ---------------------------------------------------------------------------
const ERROR_RESPONSES = {
  ValidationError: { description: "Body/query failed schema validation — `VALIDATION_FAILED` (400)", codes: ["VALIDATION_FAILED"] },
  AuthRequired: { description: "Missing/expired/revoked credential — `AUTH_REQUIRED`, `AUTH_EXPIRED`, `AUTH_REVOKED` (401)", codes: ["AUTH_REQUIRED", "AUTH_EXPIRED", "AUTH_REVOKED"] },
  Forbidden: { description: "Authenticated but not allowed; a resource you may not see answers exactly like a missing one — `PERMISSION_DENIED`, `ROOM_ACCESS_DENIED`, `INVITE_INVALID`, `PROVIDER_UNVERIFIED` (403/412)", codes: ["PERMISSION_DENIED", "ROOM_ACCESS_DENIED", "INVITE_INVALID", "PROVIDER_UNVERIFIED"] },
  NotFound: { description: "Project/task/message not found or not visible — `PROJECT_NOT_FOUND` (404)", codes: ["PROJECT_NOT_FOUND"] },
  Conflict: { description: "Revision, idempotency or approval conflict — `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `FILE_SCAN_PENDING`, `CI_FAILED` (409/422)", codes: ["REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "FILE_SCAN_PENDING", "CI_FAILED"] },
  ApprovalRequired: { description: "A live, digest-bound owner approval is required — `APPROVAL_REQUIRED`, `APPROVAL_STALE`, `TEST_NOT_RUN`, `ARTIFACT_NOT_VERIFIED` (412/428)", codes: ["APPROVAL_REQUIRED", "APPROVAL_STALE", "TEST_NOT_RUN", "ARTIFACT_NOT_VERIFIED"] },
  TooLarge: { description: "Payload or content too large — `CONTENT_TOO_LARGE` (413), `MIME_REJECTED` (415)", codes: ["CONTENT_TOO_LARGE", "MIME_REJECTED"] },
  RateLimited: { description: "Quota or rate limit — `RATE_LIMITED`, `QUOTA_EXHAUSTED` (429), `RETRY_LATER` (503)", codes: ["RATE_LIMITED", "QUOTA_EXHAUSTED", "RETRY_LATER"] },
  ExternalBlocked: { description: "External dependency unavailable or not configured — `CI_UNAVAILABLE`, `EXTERNAL_DEPENDENCY_BLOCKED`, `CAPABILITY_UNSUPPORTED` (503/422)", codes: ["CI_UNAVAILABLE", "EXTERNAL_DEPENDENCY_BLOCKED", "CAPABILITY_UNSUPPORTED"] },
  InternalError: { description: "Unexpected failure; the body never carries internals — `INTERNAL_ERROR` (500)", codes: ["INTERNAL_ERROR"] },
};

/** Error codes per operation, derived from auth class and contract wording. */
function errorStatusesFor(endpoint) {
  const codes = new Set(["InternalError", "RateLimited"]);
  if (endpoint.auth !== "public") codes.add("AuthRequired");
  if (endpoint.auth === "owner" || endpoint.auth === "invite" || endpoint.auth === "authenticated") codes.add("Forbidden");
  if (pathParamsOf(endpoint.path).length > 0) codes.add("NotFound");
  if (isMutating(endpoint.method)) codes.add("Conflict");
  if (endpoint.method === "POST" || endpoint.method === "PATCH") codes.add("ValidationError");
  if (/\/(files|uploads)\b/.test(endpoint.path)) codes.add("TooLarge");
  if (/approvals|merge|restores|data-deletion|verify|transition/.test(endpoint.path)) codes.add("ApprovalRequired");
  if (/\/providers\/|\/jobs|artifacts|required-agents/.test(endpoint.path)) codes.add("ExternalBlocked");
  return Object.keys(ERROR_RESPONSES)
    .filter((name) => codes.has(name))
    .map((name) => [{
      ValidationError: "400", AuthRequired: "401", Forbidden: "403", NotFound: "404", Conflict: "409",
      ApprovalRequired: "428", TooLarge: "413", RateLimited: "429", ExternalBlocked: "503", InternalError: "500",
    }[name], name]);
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
const ID_PATTERNS = {
  agentId: "agent", roomId: "room", projectId: "proj", taskId: "task", messageId: "msg",
  assetId: "file", uploadId: "upl", docId: "doc", jobId: "job", artifactId: "art", id: "apr", provider: "provider", actorId: "actor",
};

function pathParameter(name) {
  const kind = ID_PATTERNS[name];
  const schema = kind === "provider"
    ? { type: "string", enum: ["openai", "anthropic", "google", "meta", "pickle", "keyring", "vooy", "cue"] }
    : kind === "actor"
      ? { type: "string", description: "agent_*/owner_* id" }
      : kind === "upl"
        ? { type: "string", minLength: 8, description: "Opaque upload id" }
        : ID(kind);
  return {
    name,
    in: "path",
    required: true,
    ...(kind === "actor" ? { description: "Agent or owner id being removed/inspected" } : {}),
    schema,
  };
}

const QUERY_PARAMETERS = {
  limit: { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 25 }, description: "Page size; the server clamps it" },
  cursor: { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 512 }, description: "Opaque, signed cursor from the previous page" },
  order: { name: "order", in: "query", required: false, schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
};

const HEADER_PARAMETERS = {
  idempotency: { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 128 }, description: "Required for this operation; a replay returns the first result instead of creating a second" },
  ifMatch: { name: "If-Match", in: "header", required: false, schema: { type: "string", pattern: '^"[1-9][0-9]*"$' }, description: "Expected revision (e.g. \"3\"); mismatch is REVISION_CONFLICT" },
};

const SECURITY_FOR_AUTH = {
  public: [],
  owner_bootstrap: [{ bootstrapToken: [] }],
  invite: [{ inviteSecret: [] }],
  owner: [{ ownerSession: [] }],
  authenticated: [{ ownerSession: [] }, { agentKey: [] }],
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
async function readContractVersion() {
  const text = await readFile(CONTRACTS_INDEX, "utf8");
  const match = /contract_version:\s*"([^"]+)"/.exec(text);
  if (match === null) throw new Error("contract_version not found in packages/contracts/src/index.ts");
  return match[1];
}

async function readErrorCodes() {
  // The spec lists 26; the contract adds VALIDATION_FAILED as a documented extension.
  const text = await readFile(resolve(REPO_ROOT, "packages/contracts/src/errors.ts"), "utf8");
  const block = /export const ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(text);
  if (block === null) throw new Error("ERROR_CODES not found in packages/contracts/src/errors.ts");
  const codes = [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  if (codes.length < 26) throw new Error(`expected at least 26 error codes, found ${codes.length}`);
  return codes;
}

async function readPermissionActions() {
  const text = await readFile(PERMISSIONS_SRC, "utf8");
  const block = /export const ENDPOINT_ACTIONS: Readonly<Record<string, PermissionAction>> = \{([\s\S]*?)\n\};/.exec(text);
  if (block === null) return new Map();
  const map = new Map();
  for (const line of block[1].split("\n")) {
    const m = /"([A-Za-z0-9-]+)":\s*"([a-z_.]+)",/.exec(line);
    if (m !== null) map.set(m[1], m[2]);
  }
  return map;
}

/** The generated contract catalog is the compiler-facing mirror of the same JSON. */
async function readGeneratedCatalog() {
  const text = await readFile(GENERATED_CATALOG, "utf8");
  const rows = [];
  for (const line of text.split("\n")) {
    const m = /^  \{ (.+) \},$/.exec(line);
    if (m === null) continue;
    try {
      rows.push(JSON.parse(`{${m[1]}}`));
    } catch {
      // A hand-edited line is reported by verify-contracts, not here.
    }
  }
  return rows;
}

function successSchemaFor(responseName, collection) {
  if (responseName === null) return null;
  const dataSchema = collection
    ? { type: "array", items: ref(responseName) }
    : ref(responseName);
  return {
    allOf: [
      ref("SuccessEnvelope"),
      { type: "object", properties: { data: dataSchema }, required: ["data"] },
    ],
  };
}

/**
 * @param {{catalog: Record<string, {method: string, path: string, contract: string}[]>, contractVersion: string, errorCodes: string[], permissionActions?: Map<string,string>}} input
 */
export function buildOpenApi(input) {
  const { catalog, contractVersion, errorCodes } = input;
  const permissionActions = input.permissionActions ?? new Map();

  const endpoints = [];
  for (const [group, entries] of Object.entries(catalog)) {
    for (const entry of entries) endpoints.push({ group, ...entry, auth: authOf(entry.path) });
  }
  const paths = {};
  const seenOperationIds = new Set();
  const problems = [];

  for (const endpoint of endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    const spec = SCHEMAS_BY_ENDPOINT[key];
    if (spec === undefined) {
      problems.push(`no request/response schema mapping for ${key}`);
      continue;
    }
    const operationId = operationIdOf(endpoint.method, endpoint.path);
    if (seenOperationIds.has(operationId)) problems.push(`duplicate operationId ${operationId} for ${key}`);
    seenOperationIds.add(operationId);

    const params = pathParamsOf(endpoint.path).map(pathParameter);
    if (spec.page === true) params.push(QUERY_PARAMETERS.limit, QUERY_PARAMETERS.cursor, QUERY_PARAMETERS.order);
    if (requiresIdempotencyKey(endpoint.path) || spec.forceIdempotency === true) params.push(HEADER_PARAMETERS.idempotency);
    if (spec.revisionGuard === true) params.push(HEADER_PARAMETERS.ifMatch);

    const successStatus = spec.success ?? (endpoint.method === "POST" ? 200 : 200);
    const responses = {};
    const successSchema = successSchemaFor(spec.response ?? null, spec.collection === true);
    responses[String(successStatus)] = successSchema === null
      ? { description: "성공. 본문 없음" }
      : {
          description: "성공 봉투(ok:true, data, request_id, server_time)",
          headers: { "X-Request-Id": { $ref: "#/components/headers/X-Request-Id" } },
          content: { "application/json": { schema: successSchema } },
        };
    for (const [status, responseName] of errorStatusesFor(endpoint)) {
      if (responses[status] !== undefined) continue;
      responses[status] = { $ref: `#/components/responses/${responseName}` };
    }

    const operation = {
      operationId,
      tags: [endpoint.group],
      summary: endpoint.contract,
      description: [
        `계약: ${endpoint.contract}`,
        `권한: ${endpoint.auth} (서버 측 ACL 검사; UI 숨김으로 보호하지 않음)`,
        isMutating(endpoint.method)
          ? "변경 요청: 인증 → 인가 → 검증 → 멱등성/리비전 검사 → 실행 순서"
          : "조회 요청: 인증 → 인가 → 검증 순서",
      ].join("\n"),
      security: SECURITY_FOR_AUTH[endpoint.auth] ?? [{ ownerSession: [] }, { agentKey: [] }],
      parameters: params.length > 0 ? params : undefined,
      ...(isMutating(endpoint.method) && endpoint.method !== "DELETE" && spec.request !== null && spec.request !== undefined
        ? {
            requestBody: {
              required: true,
              content: {
                ...(spec.request === "UploadCompleteInput" || spec.request === "UploadIntentInput"
                  ? { "application/json": { schema: ref(spec.request) } }
                  : { "application/json": { schema: ref(spec.request) } }),
              },
            },
          }
        : {}),
      responses,
      "x-ai-room-group": endpoint.group,
      "x-ai-room-auth": endpoint.auth,
      "x-ai-room-mutating": isMutating(endpoint.method),
      "x-ai-room-idempotency-key": params.some((p) => p.name === "Idempotency-Key"),
      "x-ai-room-permission-action": permissionActions.get(operationId) ?? "UNMAPPED",
      "x-ai-room-test-ids": spec.tests,
    };
    if (params.length === 0) delete operation.parameters;

    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = operation;
  }

  const tagNames = [...new Set(endpoints.map((e) => e.group))];
  const document = {
    openapi: "3.1.0",
    info: {
      title: "PROJECT AI ROOM API",
      version: contractVersion,
      summary: "소유자 1인과 여러 실제 AI가 함께 쓰는 클라우드 협업 플랫폼 API",
      description: [
        "베이스 경로는 `/api`이고 카탈로그의 경로는 `/v1/...`로 표기한다(스펙 19.1: `/api/v1`).",
        "성공·실패 모두 `request_id`를 포함하고, 실패는 `{ok:false,error:{code,message,retryable,details}}` 외 형태를 쓰지 않는다.",
        "변경 요청(POST/PATCH/DELETE)은 인증 → 인가 → 검증 → 멱등성 키/If-Match 리비전 검사 → 실행 순서를 지킨다.",
        "이 문서는 `work/ai_room_pack/PROJECT_AI_ROOM/api_catalog.json`(78개)과 `packages/contracts`에서 생성한다. 손으로 고치지 않고 `node scripts/gen-openapi.mjs`로 재생성한다.",
        "요청/응답 스키마는 `db/migrations/0001_initial.sql`의 실제 컬럼과 packages/contracts 타입을 반영한 초안이며, 핸들러 구현 전까지 서버는 501을 반환한다.",
      ].join("\n\n"),
      license: { name: "UNLICENSED — private project", identifier: "LicenseRef-Proprietary" },
    },
    servers: [
      { url: "https://{host}/api", description: "Cloudflare Workers (workers.dev 또는 사용자 도메인)", variables: { host: { default: "ai-room.<account>.workers.dev", description: "배포된 Worker 호스트" } } },
      { url: "http://127.0.0.1:8787/api", description: "로컬 개발(wrangler dev) — 이 환경에서만 HTTP 허용" },
    ],
    tags: tagNames.map((name) => ({ name, description: GROUP_TAGS[name] ?? name })),
    paths,
    components: {
      schemas: SCHEMAS,
      parameters: { ...QUERY_PARAMETERS, IdempotencyKey: HEADER_PARAMETERS.idempotency, IfMatch: HEADER_PARAMETERS.ifMatch },
      headers: {
        "X-Request-Id": { description: "요청 상관 id. 로그·감사와 같은 값", schema: { type: "string" } },
      },
      responses: Object.fromEntries(
        Object.entries(ERROR_RESPONSES).map(([name, def]) => [name, {
          description: def.description,
          headers: { "X-Request-Id": { $ref: "#/components/headers/X-Request-Id" } },
          content: { "application/json": { schema: ref("ErrorEnvelope") } },
        }]),
      ),
      securitySchemes: {
        ownerSession: {
          type: "apiKey",
          in: "cookie",
          name: "ai_room_session",
          description: "소유자 세션(HttpOnly, Secure, SameSite=Lax). CSRF 토큰은 별도 헤더로 검증한다.",
        },
        agentKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "airo_sk_<opaque>",
          description: "AI별 고유 키. 발급 시 1회만 노출되며 해시로 저장되고 회전·폐기된다.",
        },
        bootstrapToken: {
          type: "apiKey",
          in: "header",
          name: "X-Owner-Bootstrap-Secret",
          description: "환경 비밀과 상수 시간 비교. 소유자 1회 온보딩에만 사용한다.",
        },
        inviteSecret: {
          type: "apiKey",
          in: "header",
          name: "X-Agent-Invite-Secret",
          description: "초대 비밀값. 단일 사용·만료·시도 예산이 적용된다.",
        },
        wsTicket: {
          type: "apiKey",
          in: "query",
          name: "ticket",
          description: "WebSocket 연결용 단기 티켓(30초). 소켓 재연결 시 재발급한다.",
        },
      },
    },
    security: [{ ownerSession: [] }, { agentKey: [] }],
    "x-ai-room-contract-version": contractVersion,
    "x-ai-room-source": "work/ai_room_pack/PROJECT_AI_ROOM/api_catalog.json",
    "x-ai-room-endpoint-count": endpoints.length,
    "x-ai-room-error-codes": errorCodes,
    "x-ai-room-websocket": {
      description: "WebSocket 계약(스펙 19.3). OpenAPI는 HTTP만 표현하므로 이벤트/프레임 계약을 확장 필드로 고정한다.",
      handshake: "POST /api/v1/rooms/{roomId}/ws-ticket 으로 단기 티켓을 발급받아, 그 방의 WebSocket 업그레이드에 `ticket` 쿼리로 전달한다. 카탈로그 밖 확장 경로다(services/gateway-worker/src/extensions.ts).",
      resync_endpoint: "GET /api/v1/rooms/{roomId}/events?cursor=<room_seq> — 소켓 없이 누락을 복구하는 HTTPS 경로(확장).",
      client_frames: ["HELLO", "SEND_MESSAGE", "PING", "ACK"],
      delivery_rule: "D1 저장 성공 이후에만 브로드캐스트한다. 전송 성공과 저장 성공을 섞지 않는다.",
      gap_recovery: "클라이언트는 마지막 room_seq를 보관하고 HELLO에 담는다. 서버가 재생 범위를 넘으면 snapshot_required를 반환한다.",
      permission_revocation: "방/프로젝트 권한이 회수되면 기존 소켓을 즉시 끊고 이벤트 캐시를 노출하지 않는다.",
      heartbeat_seconds: 25,
      event_schema: ref("EventEnvelope"),
    },
  };

  if (problems.length > 0) {
    throw new Error(`OpenAPI generation refused:\n - ${problems.join("\n - ")}`);
  }
  return document;
}

// ---------------------------------------------------------------------------
// Validation (structural, no external dependency)
// ---------------------------------------------------------------------------
/**
 * Validates the document against the parts of OpenAPI 3.1 this project relies on
 * and against the catalog it must cover. Returns a list of human-readable errors.
 * @param {any} doc
 * @param {{catalog?: Record<string, {method: string, path: string, contract: string}[]>}} [options]
 */
export function validateOpenApi(doc, options = {}) {
  const errors = [];
  const push = (message) => errors.push(message);

  if (doc?.openapi !== "3.1.0") push(`openapi must be "3.1.0" (got ${JSON.stringify(doc?.openapi)})`);
  if (typeof doc?.info?.title !== "string" || doc.info.title.length === 0) push("info.title is required");
  if (typeof doc?.info?.version !== "string" || doc.info.version.length === 0) push("info.version is required");
  if (!Array.isArray(doc?.servers) || doc.servers.length === 0) push("at least one server is required");
  for (const server of doc?.servers ?? []) {
    if (typeof server.url !== "string" || !server.url.startsWith("http")) push(`server url invalid: ${server.url}`);
  }
  if (!Array.isArray(doc?.tags) || doc.tags.length === 0) push("tags are required");

  const schemas = doc?.components?.schemas ?? {};
  const responses = doc?.components?.responses ?? {};
  const securitySchemes = doc?.components?.securitySchemes ?? {};
  const parameterComponents = doc?.components?.parameters ?? {};

  // $ref resolution
  const refs = [];
  const walk = (node, path) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push({ ref: value, path });
      else walk(value, `${path}.${key}`);
    }
  };
  walk(doc, "#");
  for (const { ref: r, path } of refs) {
    if (!r.startsWith("#/components/")) { push(`external $ref is not allowed here: ${r} at ${path}`); continue; }
    const target = r.slice(2).split("/").reduce((node, segment) => (node === undefined ? undefined : node[segment]), doc);
    if (target === undefined) push(`unresolved $ref ${r} at ${path}`);
  }

  // Security requirements reference declared schemes
  const checkSecurity = (security, where) => {
    for (const requirement of security ?? []) {
      for (const name of Object.keys(requirement)) {
        if (securitySchemes[name] === undefined) push(`security scheme ${name} is not declared (${where})`);
      }
    }
  };
  checkSecurity(doc.security, "root");

  const operationIds = new Set();
  const seen = [];
  for (const [pathKey, pathItem] of Object.entries(doc?.paths ?? {})) {
    if (!pathKey.startsWith("/")) push(`path must start with "/": ${pathKey}`);
    if (typeof pathItem !== "object" || pathItem === null) { push(`path item is not an object: ${pathKey}`); continue; }
    const templateParams = pathParamsOf(pathKey);
    const operations = Object.entries(pathItem).filter(([method]) => ["get", "post", "put", "patch", "delete", "head", "options"].includes(method));
    if (operations.length === 0) push(`path has no operations: ${pathKey}`);
    for (const [method, operation] of operations) {
      const where = `${method.toUpperCase()} ${pathKey}`;
      seen.push({ method: method.toUpperCase(), path: pathKey });
      if (typeof operation.operationId !== "string" || operation.operationId.length === 0) push(`${where}: operationId is required`);
      else if (operationIds.has(operation.operationId)) push(`${where}: duplicate operationId ${operation.operationId}`);
      else operationIds.add(operation.operationId);
      if (!Array.isArray(operation.tags) || operation.tags.length === 0) push(`${where}: tags are required`);
      if (typeof operation.summary !== "string" || operation.summary.length === 0) push(`${where}: summary is required`);
      if (typeof operation.responses !== "object" || operation.responses === null || Object.keys(operation.responses).length === 0) push(`${where}: responses are required`);
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!/^([1-5][0-9]{2}|[1-5]XX|default)$/.test(status)) push(`${where}: response status ${status} is not valid`);
        if (response !== null && typeof response === "object" && response.$ref === undefined && typeof response.description !== "string") {
          push(`${where}: response ${status} needs a description or $ref`);
        }
      }
      const params = operation.parameters ?? [];
      const pathParamNames = params.filter((p) => p.in === "path").map((p) => p.name);
      for (const name of templateParams) {
        if (!pathParamNames.includes(name)) push(`${where}: path parameter {${name}} has no parameter definition`);
      }
      for (const name of pathParamNames) {
        if (!templateParams.includes(name)) push(`${where}: parameter ${name} is not in the path template`);
        const param = params.find((p) => p.in === "path" && p.name === name);
        if (param !== undefined && param.required !== true) push(`${where}: path parameter ${name} must be required`);
      }
      for (const param of params) {
        if (param.$ref !== undefined) continue;
        if (!["query", "header", "path", "cookie"].includes(param.in)) push(`${where}: parameter ${param.name} has invalid in=${param.in}`);
        if (param.in === "path" && param.required !== true) push(`${where}: path parameter ${param.name} must be required`);
        if (param.schema === undefined) push(`${where}: parameter ${param.name} has no schema`);
      }
      if (method === "get" && operation.requestBody !== undefined) push(`${where}: GET must not declare a requestBody`);
      if (operation.requestBody !== undefined) {
        const content = operation.requestBody.content;
        if (content === undefined || Object.keys(content).length === 0) push(`${where}: requestBody has no content`);
        else for (const [mediaType, media] of Object.entries(content)) {
          if (mediaType !== "application/json") push(`${where}: unsupported media type ${mediaType}`);
          if (media?.schema === undefined) push(`${where}: requestBody media ${mediaType} has no schema`);
        }
      }
      checkSecurity(operation.security, where);
      const testIds = operation["x-ai-room-test-ids"];
      if (!Array.isArray(testIds) || testIds.length === 0) push(`${where}: x-ai-room-test-ids must not be empty`);
      for (const id of testIds ?? []) {
        if (!/^QA-[0-9]{3}$/.test(id)) push(`${where}: test id ${id} is not a QA matrix id`);
      }
    }
  }

  if (seen.length === 0) push("no operations generated");
  if (doc["x-ai-room-endpoint-count"] !== seen.length) push(`x-ai-room-endpoint-count ${doc["x-ai-room-endpoint-count"]} != ${seen.length} operations`);

  // Catalog coverage both ways
  const catalog = options.catalog;
  if (catalog !== undefined) {
    const expected = [];
    for (const entries of Object.values(catalog)) for (const entry of entries) expected.push({ method: entry.method, path: entry.path });
    const key = (e) => `${e.method} ${e.path}`;
    const actualSet = new Set(seen.map(key));
    const expectedSet = new Set(expected.map(key));
    for (const entry of expected) if (!actualSet.has(key(entry))) push(`catalog endpoint missing from OpenAPI: ${key(entry)}`);
    for (const entry of seen) {
      if (!expectedSet.has(key(entry))) {
        push(`OpenAPI endpoint not in catalog: ${key(entry)}`);
      }
    }
  }

  // Schema sanity: every declared schema is an object-ish schema, no empty enum
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema === null || typeof schema !== "object") { push(`schema ${name} is not an object`); continue; }
    for (const [key, value] of Object.entries(schema)) {
      if (key === "enum" && (!Array.isArray(value) || value.length === 0)) push(`schema ${name}.enum must not be empty`);
      if (key === "required" && (!Array.isArray(value) || value.length === 0)) push(`schema ${name}.required must not be empty when present`);
    }
  }
  // parameters/responses components referenced but missing
  for (const [name, response] of Object.entries(responses)) {
    if (response.content?.["application/json"]?.schema?.$ref === undefined) push(`components.responses.${name} must reference a schema`);
  }
  for (const [name, param] of Object.entries(parameterComponents)) {
    if (param.schema === undefined) push(`components.parameters.${name} has no schema`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main(argv) {
  const check = argv.includes("--check");
  const print = argv.includes("--print");
  const catalogPath = process.env.AI_ROOM_API_CATALOG ?? DEFAULT_CATALOG;
  const outPath = process.env.AI_ROOM_OPENAPI_OUT ?? DEFAULT_OUT;

  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const contractVersion = await readContractVersion();
  const errorCodes = await readErrorCodes();
  const permissionActions = await readPermissionActions();

  const doc = buildOpenApi({ catalog, contractVersion, errorCodes, permissionActions });
  const errors = validateOpenApi(doc, { catalog });

  // Every operation must carry a real permission action (default deny is a
  // mapping, not an absence) and test ids that exist in the QA matrix.
  const unmapped = [];
  const referencedTestIds = new Set();
  for (const [pathKey, item] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation["x-ai-room-permission-action"] === "UNMAPPED") unmapped.push(`${method.toUpperCase()} ${pathKey}`);
      for (const id of operation["x-ai-room-test-ids"] ?? []) referencedTestIds.add(id);
    }
  }
  if (unmapped.length > 0) errors.push(`no permission action for ${unmapped.length} operations: ${unmapped.slice(0, 5).join(", ")}`);
  try {
    const matrixPath = process.env.AI_ROOM_QA_MATRIX ?? resolve(SPEC_DIR, "qa_matrix.json");
    const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
    const knownIds = new Set();
    for (const entries of Object.values(matrix)) for (const entry of entries) knownIds.add(entry.id);
    const unknown = [...referencedTestIds].filter((id) => !knownIds.has(id));
    if (unknown.length > 0) errors.push(`x-ai-room-test-ids references ids outside the QA matrix: ${unknown.join(", ")}`);
    console.log(` - test ids referenced: ${referencedTestIds.size} of ${knownIds.size} QA items`);
  } catch (error) {
    errors.push(`QA matrix unreadable, cannot verify x-ai-room-test-ids: ${error.message}`);
  }

  // The generator's derivations must match the committed contract mirror.
  const generated = await readGeneratedCatalog();
  if (generated.length > 0) {
    const mirror = new Map(generated.map((row) => [`${row.method} ${row.path}`, row]));
    for (const [pathKey, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const row = mirror.get(`${method.toUpperCase()} ${pathKey}`);
        if (row === undefined) continue;
        for (const field of ["operationId", "auth"]) {
          if (row[field] !== operation[field === "auth" ? "x-ai-room-auth" : field]) {
            errors.push(`contract drift at ${method.toUpperCase()} ${pathKey}: ${field} ${row[field]} != ${operation[field === "auth" ? "x-ai-room-auth" : field]}`);
          }
        }
        if (row.mutating !== operation["x-ai-room-mutating"]) errors.push(`contract drift at ${method.toUpperCase()} ${pathKey}: mutating`);
        if (row.requiresIdempotencyKey !== operation["x-ai-room-idempotency-key"]) errors.push(`contract drift at ${method.toUpperCase()} ${pathKey}: idempotency key`);
      }
    }
    if (mirror.size === 0) errors.push("packages/contracts catalog mirror could not be parsed");
  }

  if (errors.length > 0) {
    console.error("OPENAPI VALIDATION FAILED");
    for (const error of errors) console.error(` - ${error}`);
    process.exitCode = 1;
    return;
  }

  const json = JSON.stringify(doc, null, 2) + "\n";
  if (print) {
    process.stdout.write(json);
    return;
  }
  if (check) {
    let current = "";
    try { current = await readFile(outPath, "utf8"); } catch { /* missing counts as drift */ }
    if (current !== json) {
      console.error(`OPENAPI OUT OF SYNC: ${outPath} differs from generated output. Run: node scripts/gen-openapi.mjs`);
      process.exitCode = 1;
      return;
    }
    console.log(`OPENAPI IN SYNC: ${outPath} (${Object.keys(doc.paths).length} paths, ${Object.keys(doc.paths).flatMap((p) => Object.keys(doc.paths[p])).length} operations, contract ${contractVersion})`);
    return;
  }
  await writeFile(outPath, json, "utf8");
  const operationCount = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  console.log(`WROTE ${outPath}`);
  console.log(` - paths ${Object.keys(doc.paths).length}, operations ${operationCount}`);
  console.log(` - schemas ${Object.keys(doc.components.schemas).length}, responses ${Object.keys(doc.components.responses).length}, error codes ${errorCodes.length}`);
  console.log(` - error codes: 25 from spec 19.4 + documented extension VALIDATION_FAILED = ${errorCodes.length}`);
  console.log(` - contract ${contractVersion}, tags ${doc.tags.length}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}

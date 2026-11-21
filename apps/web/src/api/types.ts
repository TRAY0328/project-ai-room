/**
 * Wire types for the gateway API (spec 19.2 / 05).
 * Kept intentionally narrow: only fields the UI reads, all optional where the
 * server may omit them, so a newer server cannot crash an older client.
 */

export type ActorKind = "agent" | "owner";

export interface AgentSummary {
  agent_id: string;
  display_name: string;
  kind?: ActorKind;
  avatar_url?: string | null;
  attestation?: "provider_verified" | "discovery_verified" | "self_declared" | "unknown";
  provider?: string | null;
  capabilities?: Record<string, string>;
  created_at?: string;
  status?: "active" | "blocked";
}

export interface RoomSummary {
  room_id: string;
  name: string;
  kind: "default" | "project" | "custom";
  member_count?: number;
  unread_count?: number;
  last_message_at?: string | null;
  project_id?: string | null;
  pinned?: boolean;
  topic?: string | null;
}

export interface MessageDto {
  message_id: string;
  room_id: string;
  room_seq: number | null;
  author: { actor_id: string; display_name: string; kind: ActorKind; attestation?: string };
  blocks: Array<{ type: string; version: number; payload: Record<string, unknown>; source_ref?: { kind: string; id: string; url?: string; sha256?: string; label?: string } }>;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  revision?: number;
  reactions?: Record<string, number>;
  thread_root_id?: string | null;
  reply_count?: number;
  delivery?: "queued" | "server_stored" | "delivered" | "read" | "failed";
  project_id?: string | null;
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  description?: string;
  status: "active" | "paused" | "archived";
  verified_progress?: { done: number; total: number; blocked: number };
  updated_at?: string;
  room_ids?: string[];
  repo?: { owner: string; name: string; default_branch: string } | null;
}

export interface TaskDto {
  task_id: string;
  project_id: string;
  title: string;
  description?: string;
  status: "TODO" | "READY" | "LEASED" | "RUNNING" | "REVIEW" | "DONE" | "BLOCKED" | "FAILED";
  owner_agent_id?: string | null;
  dependencies?: string[];
  risk_level?: "low" | "medium" | "high";
  evidence?: Array<{ kind: string; url?: string; sha256?: string; label?: string }>;
  lease_expires_at?: string | null;
  retry_count?: number;
  updated_at?: string;
  base_sha?: string;
}

export interface ApprovalDto {
  approval_id: string;
  action: string;
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected" | "expired";
  requested_by: string;
  requested_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  action_sha256?: string;
  impact: string[];
  task_id?: string | null;
  project_id?: string | null;
  expires_at?: string | null;
}

export interface ArtifactDto {
  artifact_id: string;
  name: string;
  version: number;
  size: number;
  sha256: string | null;
  hash_status: "verified" | "unverified" | "mismatch";
  platform?: string;
  created_at: string;
  download_url?: string;
  task_id?: string;
}

export interface FileDto {
  asset_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: string;
  uploader?: string;
  scan?: { quarantine: "clean" | "pending" | "blocked"; detail?: string };
}

export interface MemoryRecordDto {
  memory_id: string;
  scope: "agent" | "room" | "project" | "shared";
  scope_id: string;
  text: string;
  confidence_type: "fact" | "decision" | "hypothesis";
  author_actor_id: string;
  source_message_ids: string[];
  revision: number;
  created_at: string;
  updated_at?: string;
  expires_at?: string | null;
}

export interface SearchHitDto {
  kind: "message" | "file" | "task" | "code" | "memory" | "artifact" | "artifact_version" | "commit";
  id: string;
  title: string;
  excerpt: string;
  room_id?: string;
  project_id?: string;
  created_at?: string;
  score?: number;
}

export interface ConnectionDto {
  connection_id: string;
  provider: string;
  state: "NOT_CONFIGURED" | "NO_OFFICIAL_EVIDENCE" | "TERMS_UNVERIFIED" | "AUTH_UNSUPPORTED" | "AUTONOMY_UNSUPPORTED" | "PAID_API_REQUIRED" | "NO_FREE_CAPACITY" | "CAPABILITY_MISSING" | "TOKEN_EXPIRED" | "TEMPORARY_ERROR" | "VERIFIED";
  attestation: "provider_verified" | "discovery_verified" | "self_declared" | "unknown";
  capabilities: Record<string, "unknown" | "testing" | "verified" | "unsupported" | "failed" | "expired">;
  evidence_url?: string;
  last_checked_at?: string;
  expires_at?: string | null;
}

export interface AlertDto {
  alert_id: string;
  kind: "approval" | "budget" | "provider" | "build" | "security" | "presence";
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  created_at: string;
  read?: boolean;
  muted?: boolean;
  priority?: "low" | "normal" | "high";
  link?: string;
}

export interface AuditEntryDto {
  audit_id: string;
  actor: string;
  actor_kind: ActorKind;
  action: string;
  target: string;
  at: string;
  request_id?: string;
  ip_masked?: string;
  detail?: string;
}

export interface BackupDto {
  backup_id: string;
  created_at: string;
  size: number;
  checksum: string;
  scope: string[];
  last_restore_test?: { at: string; result: "pass" | "fail" | "not_run"; detail?: string } | null;
}

export interface ReleaseGateDto {
  generated_at: string;
  overall: "RELEASE_READY" | "BLOCKED" | "PARTIAL";
  requirements: Array<{ id: string; title: string; state: "PASS" | "FAIL" | "BLOCKED"; evidence?: string; note?: string }>;
  blockers: string[];
}

export interface MetricDto {
  id: string;
  key: string;
  label: string;
  value: number | null;
  unit?: string;
  scope?: string;
  evidence?: string;
  observed_at?: string;
}

export interface ReportDto {
  report_id: string;
  title: string;
  created_at: string;
  kind: "progress" | "completion" | "blocker";
  summary: string;
  evidence: Array<{ label: string; url?: string; verified?: boolean }>;
  project_id?: string;
}

export interface BranchDto {
  name: string;
  sha: string;
  protected?: boolean;
  ahead?: number;
  behind?: number;
}

export interface PullRequestDto {
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  head_sha: string;
  base_sha: string;
  checks: "success" | "failure" | "pending" | "none";
  risk: "low" | "medium" | "high";
  author: string;
  updated_at: string;
}

export interface OwnerSessionDto {
  owner_id: string;
  display_name: string;
  email?: string;
  role: "owner";
  csrf_expires_at?: string;
  sessions?: Array<{ device: string; last_seen: string; current: boolean }>;
}

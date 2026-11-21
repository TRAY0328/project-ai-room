-- PROJECT AI ROOM Q001-Q041 / contract-only D1 schema (implementation starting point)
-- Execute in a disposable SQLite/D1 environment; test before deploying.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS owners (
  owner_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  avatar_asset_id TEXT NOT NULL,
  claimed_provider TEXT,
  verification_state TEXT NOT NULL DEFAULT 'self_declared',
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK(profile_revision >= 1),
  created_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_credentials (
  credential_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  verifier_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','rotated','revoked')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_credentials_agent ON agent_credentials(agent_id,status);
CREATE TABLE IF NOT EXISTS required_agents (
  requirement_id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL,
  target_label TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(agent_id),
  required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0,1)),
  verification_state TEXT NOT NULL DEFAULT 'unknown',
  proof_ref TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_connections (
  connection_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  provider_key TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  credential_secret_ref TEXT,
  actual_identity_state TEXT NOT NULL DEFAULT 'unverified',
  connection_state TEXT NOT NULL DEFAULT 'disconnected',
  policy_evidence_ref TEXT,
  last_success_at TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connections_agent ON provider_connections(agent_id,connection_state);
CREATE TABLE IF NOT EXISTS capability_proofs (
  proof_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(connection_id),
  capability TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('unknown','testing','verified','failed','unsupported','expired')),
  provider_request_ref TEXT,
  evidence_asset_id TEXT,
  verified_at TEXT,
  expires_at TEXT,
  UNIQUE(connection_id,capability)
);
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  room_type TEXT NOT NULL CHECK(room_type IN ('main','project','custom')),
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_main_room ON rooms(room_type) WHERE room_type='main' AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY(room_id,actor_kind,actor_id)
);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS project_room_links (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY(project_id,room_id)
);
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  author_kind TEXT NOT NULL CHECK(author_kind IN ('owner','agent','system')),
  author_id TEXT NOT NULL,
  reply_to_id TEXT REFERENCES messages(message_id),
  room_seq INTEGER NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'persisted',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  deleted_at TEXT,
  UNIQUE(room_id,room_seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id,room_seq DESC);
CREATE TABLE IF NOT EXISTS message_versions (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  revision INTEGER NOT NULL,
  blocks_json TEXT NOT NULL CHECK(json_valid(blocks_json)),
  body_plain_text TEXT NOT NULL DEFAULT '',
  content_sha256 TEXT NOT NULL,
  editor_kind TEXT NOT NULL,
  editor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  purged_at TEXT,
  PRIMARY KEY(message_id,revision)
);
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(message_id,actor_kind,actor_id,emoji_key)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(scope_key,idempotency_key)
);
CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(project_id),
  creator_kind TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_declared TEXT NOT NULL,
  mime_detected TEXT,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  storage_state TEXT NOT NULL CHECK(storage_state IN ('uploading','quarantined','ready','delete_pending','deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id,created_at);
CREATE TABLE IF NOT EXISTS message_files (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  file_id TEXT NOT NULL REFERENCES files(file_id),
  PRIMARY KEY(message_id,file_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'proposed',
  owner_agent_id TEXT REFERENCES agents(agent_id),
  revision INTEGER NOT NULL DEFAULT 1,
  risk_level TEXT NOT NULL DEFAULT 'low',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_state ON tasks(project_id,state);
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  PRIMARY KEY(task_id,depends_on_task_id),
  CHECK(task_id != depends_on_task_id)
);
CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  assigned_agent_id TEXT REFERENCES agents(agent_id),
  lease_until TEXT,
  fencing_generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  github_run_id TEXT,
  commit_sha TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_task_gen ON task_attempts(task_id,fencing_generation DESC);
CREATE TABLE IF NOT EXISTS task_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)),
  checkpoint_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS git_repositories (
  repo_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  github_installation_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL UNIQUE,
  repo_full_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  connected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS git_pull_requests (
  pull_request_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES git_repositories(repo_id),
  github_pr_number INTEGER NOT NULL,
  task_id TEXT REFERENCES tasks(task_id),
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  status TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  UNIQUE(repo_id,github_pr_number)
);
CREATE TABLE IF NOT EXISTS ci_runs (
  ci_run_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES git_repositories(repo_id),
  pr_id TEXT REFERENCES git_pull_requests(pull_request_id),
  github_run_id TEXT NOT NULL,
  github_run_attempt INTEGER NOT NULL DEFAULT 1,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  created_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  UNIQUE(repo_id,github_run_id,github_run_attempt)
);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(project_id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  request_reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','expired','invalidated','revoked')),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  owner_id TEXT REFERENCES owners(owner_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_commit_sha TEXT,
  ci_run_id TEXT REFERENCES ci_runs(ci_run_id),
  artifact_type TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  r2_key TEXT NOT NULL UNIQUE,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(project_id,artifact_type,version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY,
  memory_scope TEXT NOT NULL CHECK(memory_scope IN ('agent_private','room','shared','project')),
  scope_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(project_id),
  memory_kind TEXT NOT NULL CHECK(memory_kind IN ('fact','decision','hypothesis','note','task_result')),
  body_text TEXT NOT NULL,
  trust_state TEXT NOT NULL DEFAULT 'unverified',
  source_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(memory_scope,scope_id,created_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, body_text, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS usage_budgets (
  budget_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  hard_limit_value REAL NOT NULL CHECK(hard_limit_value >= 0),
  observed_value REAL,
  observation_state TEXT NOT NULL DEFAULT 'unknown',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  correlation_id TEXT,
  allow_or_deny TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_kind,actor_id,created_at DESC);

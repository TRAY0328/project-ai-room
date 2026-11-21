-- PROJECT AI ROOM — 0001_initial.sql
-- Target: Cloudflare D1 (SQLite). Local verification: node:sqlite (SQLite 3.50.4).
--
-- Conventions used throughout:
--   * Ids are the typed prefixed ids from packages/contracts/src/ids.ts and are
--     re-checked here with LIKE patterns, so a wrong-aggregate id cannot be
--     stored even if application code regresses.
--   * Timestamps are UTC ISO-8601 with milliseconds and a trailing Z. The GLOB
--     check rejects local offsets and second precision at the storage layer.
--   * Every mutable aggregate has `revision`; triggers require it to increase by
--     exactly one per UPDATE, so a silent last-writer-wins overwrite is impossible.
--   * Triggers carry the invariants that a plain schema cannot state:
--     message author immutability, DONE-needs-evidence, artifact verification,
--     approval invalidation, tombstone propagation into search.
--   * Binary bodies live in R2; this database stores keys, hashes and metadata.
--
-- The migration is idempotent (IF NOT EXISTS) so `wrangler d1 migrations apply`
-- can be retried, but it is still a one-way migration: destructive changes need
-- a new file plus an owner approval (spec 22.3).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL CHECK (applied_at GLOB '????-??-??T??:??:??.???Z'),
  checksum TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- ===========================================================================
-- 1. Identity, access and audit
-- ===========================================================================

CREATE TABLE IF NOT EXISTS owners (
  owner_id TEXT PRIMARY KEY CHECK (owner_id LIKE 'owner!_%' ESCAPE '!'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  email TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  disabled_at TEXT
);

-- Exactly one owner account exists (spec 06.1). A second row is refused.
CREATE TRIGGER IF NOT EXISTS trg_single_owner
BEFORE INSERT ON owners
WHEN EXISTS (SELECT 1 FROM owners)
BEGIN
  SELECT RAISE(ABORT, 'OWNER_SINGLETON_VIOLATION');
END;

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY CHECK (agent_id LIKE 'agent!_%' ESCAPE '!'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  avatar_asset_id TEXT NOT NULL,
  claimed_provider TEXT,
  -- self_declared is the default: a typed name is not provider proof.
  verification_state TEXT NOT NULL DEFAULT 'self_declared'
    CHECK (verification_state IN ('self_declared','discovery_verified','provider_verified')),
  -- Only the human owner holds this; see trg_agent_never_platform_admin.
  platform_admin INTEGER NOT NULL DEFAULT 0 CHECK (platform_admin IN (0,1)),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  disabled_at TEXT
);

CREATE TRIGGER IF NOT EXISTS trg_agent_never_platform_admin
BEFORE INSERT ON agents
WHEN NEW.platform_admin <> 0
BEGIN
  SELECT RAISE(ABORT, 'AGENT_PLATFORM_ADMIN_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_never_platform_admin_update
BEFORE UPDATE OF platform_admin ON agents
WHEN NEW.platform_admin <> 0
BEGIN
  SELECT RAISE(ABORT, 'AGENT_PLATFORM_ADMIN_FORBIDDEN');
END;

CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  model_name TEXT,
  company TEXT,
  pronouns TEXT,
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision >= 1),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE IF NOT EXISTS agent_credentials (
  credential_id TEXT PRIMARY KEY CHECK (credential_id LIKE 'cred!_%' ESCAPE '!'),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  -- Only a verifier hash is stored; the plaintext key exists once, at issuance.
  verifier_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked','suspended')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  last_used_at TEXT,
  rotated_at TEXT,
  revoked_at TEXT,
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_credentials_agent ON agent_credentials(agent_id, status);

CREATE TABLE IF NOT EXISTS agent_invites (
  invite_id TEXT PRIMARY KEY CHECK (invite_id LIKE 'inst!_%' ESCAPE '!'),
  secret_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES owners(owner_id),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_agent_id TEXT REFERENCES agents(agent_id),
  revoked_at TEXT,
  CHECK (used_at IS NULL OR used_by_agent_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id LIKE 'sess!_%' ESCAPE '!'),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('owner','agent')),
  subject_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  session_assurance TEXT NOT NULL CHECK (session_assurance IN ('owner_ui','agent_key','ephemeral_ws_ticket','service')),
  issued_at TEXT NOT NULL CHECK (issued_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  user_agent_hash TEXT,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS idx_sessions_subject ON auth_sessions(subject_kind, subject_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS required_agents (
  requirement_id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL UNIQUE,
  target_label TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(agent_id),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  verification_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (verification_state IN ('unknown','testing','verified','unsupported','blocked','expired')),
  proof_ref TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  -- A "verified" row must name the evidence that proves it.
  CHECK (verification_state <> 'verified' OR (proof_ref IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS provider_connections (
  connection_id TEXT PRIMARY KEY CHECK (connection_id LIKE 'conn!_%' ESCAPE '!'),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  provider_key TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('oauth2','api_key','app_installation','signed_webhook','none_documented')),
  credential_secret_ref TEXT,
  actual_identity_state TEXT NOT NULL DEFAULT 'unverified'
    CHECK (actual_identity_state IN ('unverified','self_declared','discovery_verified','provider_verified')),
  connection_state TEXT NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (connection_state IN ('DISCONNECTED','AUTHENTICATING','CONNECTED','DEGRADED','EXPIRED','REVOKED','BLOCKED')),
  policy_evidence_ref TEXT,
  last_success_at TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  -- provider_verified needs an actual identity label from the provider.
  CHECK (actual_identity_state <> 'provider_verified' OR credential_secret_ref IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_connections_agent ON provider_connections(agent_id, connection_state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_unique ON provider_connections(agent_id, provider_key);

CREATE TABLE IF NOT EXISTS capability_proofs (
  proof_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(connection_id),
  capability TEXT NOT NULL CHECK (capability IN (
    'message.receive','message.send','task.claim','task.execute','code.patch',
    'git.pr.create','git.review','artifact.read','checkpoint.resume')),
  state TEXT NOT NULL CHECK (state IN ('unknown','testing','verified','unsupported','failed','expired')),
  provider_request_ref TEXT,
  provider_response_id TEXT,
  challenge_nonce TEXT,
  evidence_asset_id TEXT,
  attestation TEXT NOT NULL DEFAULT 'self_declared'
    CHECK (attestation IN ('self_declared','discovery_verified','provider_verified')),
  verified_at TEXT,
  expires_at TEXT,
  -- "verified" is only storable with a real provider response and a non-self claim.
  CHECK (state <> 'verified' OR (
    provider_response_id IS NOT NULL AND verified_at IS NOT NULL
    AND attestation IN ('discovery_verified','provider_verified')
  )),
  UNIQUE (connection_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_capability_state ON capability_proofs(capability, state);

CREATE TABLE IF NOT EXISTS project_acl (
  project_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','contributor','viewer')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??.???Z'),
  revoked_at TEXT,
  PRIMARY KEY (project_id, actor_kind, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_project_acl_actor ON project_acl(actor_kind, actor_id, project_id);

CREATE TABLE IF NOT EXISTS room_acl (
  room_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','contributor','viewer')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??.???Z'),
  revoked_at TEXT,
  PRIMARY KEY (room_id, actor_kind, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_room_acl_actor ON room_acl(actor_kind, actor_id, room_id);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY CHECK (audit_id LIKE 'evt!_%' ESCAPE '!'),
  event_type TEXT NOT NULL CHECK (event_type GLOB '*.*'),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  actor_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  correlation_id TEXT,
  request_id TEXT,
  allow_or_deny TEXT NOT NULL CHECK (allow_or_deny IN ('allow','deny')),
  reason_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_kind, actor_id, created_at DESC);

-- Audit rows are append-only: no updates, no deletes.
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

-- ===========================================================================
-- 2. Rooms, messages, delivery
-- ===========================================================================

CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY CHECK (room_id LIKE 'room!_%' ESCAPE '!'),
  room_type TEXT NOT NULL CHECK (room_type IN ('main','project','custom')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

-- The single default room stays logically unique while its id stays random.
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_main_room
  ON rooms(room_type) WHERE room_type = 'main' AND deleted_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_room_revision
BEFORE UPDATE OF name, room_type ON rooms
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'ROOM_REVISION_MUST_INCREMENT');
END;

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  joined_at TEXT NOT NULL CHECK (joined_at GLOB '????-??-??T??:??:??.???Z'),
  left_at TEXT,
  invited_by TEXT,
  PRIMARY KEY (room_id, actor_kind, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_actor ON room_members(actor_kind, actor_id, room_id);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY CHECK (message_id LIKE 'msg!_%' ESCAPE '!'),
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner','agent','system')),
  author_id TEXT NOT NULL,
  reply_to_id TEXT REFERENCES messages(message_id),
  -- room_seq comes from the Room Durable Object; it is the ordering authority.
  room_seq INTEGER NOT NULL CHECK (room_seq > 0),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  status TEXT NOT NULL DEFAULT 'PERSISTED'
    CHECK (status IN ('DRAFT','VALIDATING','ACCEPTED','PERSISTED','DISTRIBUTING','CONFIRMED','REJECTED','RETRYABLE','DEAD_LETTER','CANCELLED','DELETED')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT,
  deleted_at TEXT,
  UNIQUE (room_id, room_seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, room_seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_kind, author_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotent
  ON messages(room_id, author_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- author_id is immutable; a different author means a different message.
CREATE TRIGGER IF NOT EXISTS trg_message_author_immutable
BEFORE UPDATE OF author_id, author_kind, room_id ON messages
WHEN NEW.author_id <> OLD.author_id OR NEW.author_kind <> OLD.author_kind OR NEW.room_id <> OLD.room_id
BEGIN
  SELECT RAISE(ABORT, 'MESSAGE_AUTHOR_IMMUTABLE');
END;

-- Content changes are new revisions, never in-place edits.
CREATE TRIGGER IF NOT EXISTS trg_message_revision
BEFORE UPDATE OF current_revision ON messages
WHEN NEW.current_revision <> OLD.current_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'MESSAGE_REVISION_MUST_INCREMENT');
END;

CREATE TRIGGER IF NOT EXISTS trg_message_no_hard_delete
BEFORE DELETE ON messages
BEGIN
  SELECT RAISE(ABORT, 'MESSAGE_SOFT_DELETE_ONLY');
END;

CREATE TABLE IF NOT EXISTS message_versions (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json)),
  body_plain_text TEXT NOT NULL DEFAULT '',
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  editor_kind TEXT NOT NULL CHECK (editor_kind IN ('owner','agent','system')),
  editor_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  purged_at TEXT,
  PRIMARY KEY (message_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_message_versions_created ON message_versions(created_at DESC);

-- A stored version's content never changes; only purging may touch it.
CREATE TRIGGER IF NOT EXISTS trg_message_version_immutable
BEFORE UPDATE OF blocks_json, body_plain_text, content_sha256 ON message_versions
WHEN NEW.blocks_json <> OLD.blocks_json
  OR NEW.body_plain_text <> OLD.body_plain_text
  OR NEW.content_sha256 <> OLD.content_sha256
BEGIN
  SELECT RAISE(ABORT, 'MESSAGE_VERSION_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS message_blocks (
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  block_index INTEGER NOT NULL CHECK (block_index >= 0),
  block_id TEXT NOT NULL,
  block_type TEXT NOT NULL CHECK (block_type IN (
    'text','markdown','code','diff','file','image','quote','task_ref','commit_ref',
    'pr_ref','artifact_ref','chart','table','callout')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (message_id, revision, block_index),
  FOREIGN KEY (message_id, revision) REFERENCES message_versions(message_id, revision)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL CHECK (length(emoji_key) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (message_id, actor_kind, actor_id, emoji_key)
);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('owner','agent')),
  recipient_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'QUEUED','SENT','DELIVERED','ACKNOWLEDGED_BY_AGENT','READ_CONFIRMED','FAILED','UNSUPPORTED')),
  provider_ref TEXT,
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (message_id, recipient_kind, recipient_id),
  -- READ/DELIVERED require a provider reference as evidence.
  CHECK (state NOT IN ('DELIVERED','ACKNOWLEDGED_BY_AGENT','READ_CONFIRMED') OR provider_ref IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  mentioned_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  PRIMARY KEY (message_id, mentioned_agent_id)
);

-- Tombstones make deletion visible to search, memory and download links.
CREATE TABLE IF NOT EXISTS message_tombstones (
  message_id TEXT PRIMARY KEY REFERENCES messages(message_id),
  room_id TEXT NOT NULL,
  deleted_by_kind TEXT NOT NULL CHECK (deleted_by_kind IN ('owner','agent','system')),
  deleted_by_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL CHECK (deleted_at GLOB '????-??-??T??:??:??.???Z'),
  content_sha256 TEXT,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS delivery_outbox (
  delivery_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  channel TEXT NOT NULL CHECK (channel IN ('room_ws','provider_adapter','email','none')),
  target_ref TEXT,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','SENT','DELIVERED','ACKNOWLEDGED_BY_AGENT','FAILED','UNSUPPORTED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON delivery_outbox(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS delivery_ack (
  delivery_id TEXT PRIMARY KEY REFERENCES delivery_outbox(delivery_id),
  acknowledged_at TEXT NOT NULL CHECK (acknowledged_at GLOB '????-??-??T??:??:??.???Z'),
  acknowledged_by_kind TEXT NOT NULL CHECK (acknowledged_by_kind IN ('owner','agent','provider')),
  acknowledged_by_id TEXT NOT NULL,
  provider_evidence_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);

-- ===========================================================================
-- 3. Projects, tasks, evidence
-- ===========================================================================

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY CHECK (project_id LIKE 'proj!_%' ESCAPE '!'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived','deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS project_room_links (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  linked_at TEXT NOT NULL CHECK (linked_at GLOB '????-??-??T??:??:??.???Z'),
  linked_by TEXT NOT NULL,
  PRIMARY KEY (project_id, room_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY CHECK (task_id LIKE 'task!_%' ESCAPE '!'),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (state IN (
    'PROPOSED','SPECIFIED','OPEN_FOR_CLAIM','CLAIM_PROPOSED','CLAIM_ACCEPTED',
    'WAITING_DEPENDENCY','READY','LEASED','RUNNING','VERIFYING','RETRY_WAIT',
    'HANDOFF_REQUESTED','HANDOFF_ACCEPTED','BLOCKED','CANCELLED','FAILED','DONE','REOPENED')),
  owner_agent_id TEXT REFERENCES agents(agent_id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high','critical')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_state ON tasks(project_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_agent_id, state);

CREATE TRIGGER IF NOT EXISTS trg_task_revision
BEFORE UPDATE ON tasks
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'TASK_REVISION_MUST_INCREMENT');
END;

-- DONE is decided by verified evidence, never by a message that says so.
CREATE TRIGGER IF NOT EXISTS trg_task_done_requires_evidence
BEFORE UPDATE OF state ON tasks
WHEN NEW.state = 'DONE' AND NOT EXISTS (
  SELECT 1 FROM task_evidence e
  WHERE e.task_id = NEW.task_id AND e.verification_state = 'verified'
)
BEGIN
  SELECT RAISE(ABORT, 'TASK_DONE_REQUIRES_VERIFIED_EVIDENCE');
END;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (attempt_id LIKE 'att!_%' ESCAPE '!'),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  assigned_agent_id TEXT REFERENCES agents(agent_id),
  lease_until TEXT,
  fencing_generation INTEGER NOT NULL DEFAULT 1 CHECK (fencing_generation >= 1),
  status TEXT NOT NULL CHECK (status IN ('GRANTED','RUNNING','SUCCEEDED','FAILED','ABANDONED','SUPERSEDED')),
  github_run_id TEXT,
  commit_sha TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (task_id, fencing_generation)
);

CREATE INDEX IF NOT EXISTS idx_attempts_task_gen ON task_attempts(task_id, fencing_generation DESC);

CREATE TABLE IF NOT EXISTS task_evidence (
  evidence_id TEXT PRIMARY KEY CHECK (
    evidence_id LIKE 'att!_%' ESCAPE '!' OR evidence_id LIKE 'art!_%' ESCAPE '!'
    OR evidence_id LIKE 'ci!_%' ESCAPE '!' OR evidence_id LIKE 'evd!_%' ESCAPE '!'),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('test_run','ci_run','artifact','review','screenshot','log','commit','manual_note')),
  ref_id TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'pending' CHECK (verification_state IN ('pending','verified','rejected')),
  verified_by_kind TEXT CHECK (verified_by_kind IN ('owner','agent','system')),
  verified_by_id TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (verification_state <> 'verified' OR (verified_by_kind IS NOT NULL AND verified_by_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_task_evidence_task ON task_evidence(task_id, verification_state);

CREATE TABLE IF NOT EXISTS task_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
  checkpoint_sha256 TEXT NOT NULL CHECK (length(checkpoint_sha256) = 64),
  valid_until TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_events (
  event_id TEXT PRIMARY KEY CHECK (event_id LIKE 'evt!_%' ESCAPE '!'),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  event_type TEXT NOT NULL CHECK (event_type GLOB '*.*'),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  actor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (project_id, sequence)
);

CREATE TABLE IF NOT EXISTS project_metrics (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  metric_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  value REAL,
  unit TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('measured','estimated')),
  computed_at TEXT NOT NULL CHECK (computed_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (project_id, metric_key, period_start),
  -- An estimate is never stored as a measurement (spec 44).
  CHECK (source <> 'measured' OR value IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS project_reports (
  report_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  report_kind TEXT NOT NULL CHECK (report_kind IN ('status','metrics','release','incident')),
  body_md TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json)),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('owner','agent','system')),
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_reports_project ON project_reports(project_id, created_at DESC);

-- ===========================================================================
-- 4. IDE, Git and review
-- ===========================================================================

CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY CHECK (document_id LIKE 'doc!_%' ESCAPE '!'),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  language TEXT NOT NULL DEFAULT 'plaintext',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT,
  UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS document_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(document_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  base_commit_sha TEXT,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (document_id, revision)
);

CREATE TABLE IF NOT EXISTS document_update_refs (
  update_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(document_id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  r2_key TEXT NOT NULL,
  origin_session_id TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_document_updates ON document_update_refs(document_id, revision);

CREATE TABLE IF NOT EXISTS file_operations (
  operation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  document_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('create','update','rename','delete','publish')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent','system')),
  actor_id TEXT NOT NULL,
  base_commit_sha TEXT,
  result_commit_sha TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','conflict','rejected')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id TEXT PRIMARY KEY CHECK (installation_id LIKE 'inst!_%' ESCAPE '!'),
  github_installation_id TEXT NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  repository_selection TEXT NOT NULL DEFAULT 'selected' CHECK (repository_selection IN ('all','selected')),
  permissions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permissions_json)),
  installed_at TEXT NOT NULL CHECK (installed_at GLOB '????-??-??T??:??:??.???Z'),
  suspended_at TEXT
);

CREATE TABLE IF NOT EXISTS git_repositories (
  repo_id TEXT PRIMARY KEY CHECK (repo_id LIKE 'repo!_%' ESCAPE '!'),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  github_installation_id TEXT NOT NULL,
  github_repository_id TEXT NOT NULL UNIQUE,
  repo_full_name TEXT NOT NULL CHECK (repo_full_name GLOB '*/*'),
  default_branch TEXT NOT NULL DEFAULT 'main',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  connected_at TEXT NOT NULL CHECK (connected_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (project_id, github_repository_id)
);

CREATE TABLE IF NOT EXISTS git_revisions (
  revision_id TEXT PRIMARY KEY CHECK (revision_id LIKE 'rev!_%' ESCAPE '!'),
  repo_id TEXT NOT NULL REFERENCES git_repositories(repo_id),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) BETWEEN 40 AND 64),
  parent_sha TEXT,
  branch TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner','agent','system')),
  author_id TEXT NOT NULL,
  provider_attestation_id TEXT,
  message TEXT NOT NULL DEFAULT '',
  committed_at TEXT NOT NULL CHECK (committed_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (repo_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_git_revisions_repo ON git_revisions(repo_id, committed_at DESC);

CREATE TABLE IF NOT EXISTS git_pull_requests (
  pull_request_id TEXT PRIMARY KEY CHECK (pull_request_id LIKE 'pr!_%' ESCAPE '!'),
  repo_id TEXT NOT NULL REFERENCES git_repositories(repo_id),
  github_pr_number INTEGER NOT NULL CHECK (github_pr_number > 0),
  task_id TEXT REFERENCES tasks(task_id),
  attempt_id TEXT REFERENCES task_attempts(attempt_id),
  provider_invocation_id TEXT,
  head_sha TEXT NOT NULL CHECK (length(head_sha) BETWEEN 40 AND 64),
  base_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','OPEN','REVIEW_PENDING','CHANGES_REQUESTED','APPROVED','MERGING','MERGED','CLOSED','CONFLICT')),
  approval_id TEXT,
  last_synced_at TEXT NOT NULL CHECK (last_synced_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (repo_id, github_pr_number)
);

CREATE INDEX IF NOT EXISTS idx_pr_task ON git_pull_requests(task_id);

CREATE TABLE IF NOT EXISTS merge_requests (
  merge_request_id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES git_pull_requests(pull_request_id),
  expected_head_sha TEXT NOT NULL,
  approval_id TEXT,
  ci_run_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('REQUESTED','BLOCKED_CI','BLOCKED_APPROVAL','MERGED','CLOSED')),
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('owner','agent')),
  requested_by_id TEXT NOT NULL,
  requested_at TEXT NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??.???Z'),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS code_reviews (
  review_id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES git_pull_requests(pull_request_id),
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('owner','agent')),
  reviewer_id TEXT NOT NULL,
  reviewed_sha TEXT NOT NULL CHECK (length(reviewed_sha) BETWEEN 40 AND 64),
  verdict TEXT NOT NULL CHECK (verdict IN ('APPROVE','REQUEST_CHANGES','COMMENT')),
  attestation TEXT NOT NULL DEFAULT 'self_declared' CHECK (attestation IN ('self_declared','discovery_verified','provider_verified')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (pull_request_id, reviewer_kind, reviewer_id, reviewed_sha)
);

CREATE TABLE IF NOT EXISTS review_comments (
  comment_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES code_reviews(review_id),
  file_path TEXT NOT NULL,
  line_number INTEGER CHECK (line_number IS NULL OR line_number > 0),
  body_md TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

-- ===========================================================================
-- 5. Execution: jobs, leases, CI, artifacts verification
-- ===========================================================================

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY CHECK (job_id LIKE 'job!_%' ESCAPE '!'),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  task_id TEXT REFERENCES tasks(task_id),
  job_kind TEXT NOT NULL CHECK (job_kind IN ('ci_build','ci_test','package_web','package_windows','package_android','security_scan','custom')),
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED','DISPATCH_REQUESTED','DISPATCHED','RUNNING','SUCCEEDED','FAILED',
    'CANCEL_REQUESTED','CANCELLED','TIMED_OUT','BLOCKED_EXTERNAL_DEPENDENCY')),
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('owner','agent','system')),
  requested_by_id TEXT NOT NULL,
  approval_id TEXT,
  workflow_ref TEXT,
  commit_sha TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_jobs_project_state ON jobs(project_id, state, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_job_revision
BEFORE UPDATE ON jobs
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'JOB_REVISION_MUST_INCREMENT');
END;

-- A success or a cancel is recorded only with a real platform run behind it.
CREATE TABLE IF NOT EXISTS job_attempts (
  job_attempt_id TEXT PRIMARY KEY CHECK (job_attempt_id LIKE 'att!_%' ESCAPE '!'),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  github_total_count INTEGER CHECK (github_total_count IS NULL OR github_total_count > 0),
  started_at TEXT,
  ended_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'RUNNING' CHECK (outcome IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','ABANDONED')),
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS job_leases (
  lease_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  lease_owner_kind TEXT NOT NULL CHECK (lease_owner_kind IN ('agent','system')),
  lease_owner_id TEXT NOT NULL,
  fencing_generation INTEGER NOT NULL CHECK (fencing_generation >= 1),
  granted_at TEXT NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL,
  released_at TEXT,
  CHECK (expires_at > granted_at),
  UNIQUE (job_id, fencing_generation)
);

CREATE INDEX IF NOT EXISTS idx_leases_active ON job_leases(job_id, expires_at);

CREATE TABLE IF NOT EXISTS job_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
  checkpoint_sha256 TEXT NOT NULL CHECK (length(checkpoint_sha256) = 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE IF NOT EXISTS github_webhooks (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.???Z'),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  processed_state TEXT NOT NULL DEFAULT 'received' CHECK (processed_state IN ('received','processed','ignored','failed')),
  processed_at TEXT,
  -- A redelivery is stored once; processing is made idempotent on this id.
  CHECK (processed_state <> 'processed' OR processed_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ci_runs (
  ci_run_id TEXT PRIMARY KEY CHECK (ci_run_id LIKE 'ci!_%' ESCAPE '!'),
  repo_id TEXT NOT NULL REFERENCES git_repositories(repo_id),
  pr_id TEXT REFERENCES git_pull_requests(pull_request_id),
  job_id TEXT REFERENCES jobs(job_id),
  github_run_id TEXT NOT NULL,
  github_run_attempt INTEGER NOT NULL DEFAULT 1 CHECK (github_run_attempt >= 1),
  workflow_name TEXT,
  head_sha TEXT NOT NULL CHECK (length(head_sha) BETWEEN 40 AND 64),
  status TEXT NOT NULL CHECK (status IN ('queued','in_progress','completed','requested','waiting','unknown')),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('success','failure','cancelled','timed_out','startup_failure','action_required','neutral','skipped','stale')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  last_synced_at TEXT NOT NULL CHECK (last_synced_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (repo_id, github_run_id, github_run_attempt),
  -- A conclusion may only exist for a completed run.
  CHECK (conclusion IS NULL OR status = 'completed')
);

CREATE INDEX IF NOT EXISTS idx_ci_runs_pr ON ci_runs(pr_id, created_at DESC);

CREATE TABLE IF NOT EXISTS test_runs (
  test_run_id TEXT PRIMARY KEY,
  ci_run_id TEXT REFERENCES ci_runs(ci_run_id),
  suite TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  passed INTEGER NOT NULL DEFAULT 0 CHECK (passed >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  report_r2_key TEXT,
  report_sha256 TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK (passed + failed + skipped <= total)
);

CREATE TABLE IF NOT EXISTS execution_evidence (
  evidence_id TEXT PRIMARY KEY CHECK (
    evidence_id LIKE 'att!_%' ESCAPE '!' OR evidence_id LIKE 'art!_%' ESCAPE '!'
    OR evidence_id LIKE 'ci!_%' ESCAPE '!' OR evidence_id LIKE 'evt!_%' ESCAPE '!' OR evidence_id LIKE 'evd!_%' ESCAPE '!'),
  job_id TEXT REFERENCES jobs(job_id),
  task_id TEXT REFERENCES tasks(task_id),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('workflow_run','test_report','build_log','artifact','screenshot','signature')),
  ref_id TEXT NOT NULL,
  sha256 TEXT,
  captured_at TEXT NOT NULL CHECK (captured_at GLOB '????-??-??T??:??:??.???Z'),
  redaction_state TEXT NOT NULL DEFAULT 'none' CHECK (redaction_state IN ('none','masked','restricted'))
);

CREATE INDEX IF NOT EXISTS idx_execution_evidence_job ON execution_evidence(job_id, captured_at DESC);

-- ===========================================================================
-- 6. Memory and search (FTS5)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY CHECK (memory_id LIKE 'mem!_%' ESCAPE '!'),
  memory_scope TEXT NOT NULL CHECK (memory_scope IN ('agent_private','room','shared','project')),
  scope_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(project_id),
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('fact','decision','hypothesis','note','task_result')),
  body_text TEXT NOT NULL CHECK (length(body_text) BETWEEN 1 AND 20000),
  trust_state TEXT NOT NULL DEFAULT 'unverified' CHECK (trust_state IN ('unverified','corroborated','disputed')),
  source_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT,
  -- project-scoped memory must name its project; private memory must not leak one.
  CHECK (memory_scope <> 'project' OR project_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(memory_scope, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_records(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_provenance (
  provenance_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_records(memory_id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message','file','artifact','job','manual','provider')),
  source_id TEXT NOT NULL,
  quote TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_provenance_memory ON memory_provenance(memory_id);

CREATE TABLE IF NOT EXISTS memory_links (
  from_memory_id TEXT NOT NULL REFERENCES memory_records(memory_id),
  to_memory_id TEXT NOT NULL REFERENCES memory_records(memory_id),
  link_kind TEXT NOT NULL CHECK (link_kind IN ('supports','contradicts','derived_from','mentions')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (from_memory_id, to_memory_id, link_kind),
  CHECK (from_memory_id <> to_memory_id)
);

CREATE TABLE IF NOT EXISTS memory_permissions (
  memory_id TEXT NOT NULL REFERENCES memory_records(memory_id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read','write')),
  granted_at TEXT NOT NULL CHECK (granted_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (memory_id, actor_kind, actor_id, access)
);

-- Full-text index. External-content FTS keeps the text in one place.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  body_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_memory_fts_insert
AFTER INSERT ON memory_records
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO memory_fts(memory_id, body_text) VALUES (NEW.memory_id, NEW.body_text);
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_fts_update
AFTER UPDATE OF body_text, deleted_at ON memory_records
BEGIN
  DELETE FROM memory_fts WHERE memory_id = OLD.memory_id;
  INSERT INTO memory_fts(memory_id, body_text)
  SELECT NEW.memory_id, NEW.body_text WHERE NEW.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_fts_delete
AFTER DELETE ON memory_records
BEGIN
  DELETE FROM memory_fts WHERE memory_id = OLD.memory_id;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  room_id UNINDEXED,
  body_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Only the newest revision is indexed; older revisions stay queryable in D1.
CREATE TRIGGER IF NOT EXISTS trg_message_fts_insert
AFTER INSERT ON message_versions
BEGIN
  DELETE FROM message_fts WHERE message_id = NEW.message_id;
  INSERT INTO message_fts(message_id, room_id, body_text)
  SELECT NEW.message_id, m.room_id, NEW.body_plain_text
  FROM messages m
  WHERE m.message_id = NEW.message_id AND m.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_message_fts_tombstone
AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM message_fts WHERE message_id = NEW.message_id;
END;

CREATE TABLE IF NOT EXISTS search_index_tasks (
  task_id TEXT PRIMARY KEY CHECK (task_id LIKE 'task!_%' ESCAPE '!'),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('message','memory','file','artifact','document')),
  target_id TEXT NOT NULL,
  project_id TEXT,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','DONE','FAILED','CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS search_tombstones (
  target_kind TEXT NOT NULL CHECK (target_kind IN ('message','memory','file','artifact','document')),
  target_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL CHECK (deleted_at GLOB '????-??-??T??:??:??.???Z'),
  propagated_at TEXT,
  PRIMARY KEY (target_kind, target_id)
);

-- Deleting a memory row records a tombstone so caches and derived indexes drop it.
CREATE TRIGGER IF NOT EXISTS trg_memory_tombstone
AFTER UPDATE OF deleted_at ON memory_records
WHEN NEW.deleted_at IS NOT NULL
BEGIN
  INSERT INTO search_tombstones(target_kind, target_id, deleted_at)
  VALUES ('memory', NEW.memory_id, NEW.deleted_at)
  ON CONFLICT(target_kind, target_id) DO UPDATE SET deleted_at = excluded.deleted_at;
END;

-- ===========================================================================
-- 7. Files and artifacts (bodies in R2, metadata here)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY CHECK (file_id LIKE 'file!_%' ESCAPE '!'),
  project_id TEXT REFERENCES projects(project_id),
  creator_kind TEXT NOT NULL CHECK (creator_kind IN ('owner','agent','system')),
  creator_id TEXT NOT NULL,
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_declared TEXT NOT NULL,
  mime_detected TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  r2_key TEXT NOT NULL UNIQUE,
  storage_state TEXT NOT NULL CHECK (storage_state IN ('uploading','quarantined','scanning','ready','restricted','delete_pending','deleted')),
  scan_state TEXT NOT NULL DEFAULT 'pending' CHECK (scan_state IN ('pending','clean','infected','error','not_required')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT,
  -- A chat message may only reference a scanned/clean file (spec 35.5).
  CHECK (storage_state NOT IN ('ready') OR scan_state IN ('clean','not_required'))
);

CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_scan ON files(scan_state, storage_state);

CREATE TABLE IF NOT EXISTS message_files (
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  file_id TEXT NOT NULL REFERENCES files(file_id),
  PRIMARY KEY (message_id, file_id)
);

CREATE TABLE IF NOT EXISTS file_versions (
  file_id TEXT NOT NULL REFERENCES files(file_id),
  version INTEGER NOT NULL CHECK (version >= 1),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (file_id, version)
);

CREATE TABLE IF NOT EXISTS file_links (
  file_id TEXT NOT NULL REFERENCES files(file_id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('message','task','project','artifact','document')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (file_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY CHECK (artifact_id LIKE 'art!_%' ESCAPE '!'),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_commit_sha TEXT,
  ci_run_id TEXT REFERENCES ci_runs(ci_run_id),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('web','windows_installer','android_apk','source_archive','report','sbom','other')),
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  r2_key TEXT NOT NULL UNIQUE,
  verification_state TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_state IN ('UNVERIFIED','PENDING','VERIFIED','MISMATCH')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT,
  UNIQUE (project_id, artifact_type, version)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id, created_at DESC);

-- VERIFIED requires a verification row whose hash equals the stored hash.
CREATE TRIGGER IF NOT EXISTS trg_artifact_verified_needs_proof
BEFORE UPDATE OF verification_state ON artifacts
WHEN NEW.verification_state = 'VERIFIED' AND NOT EXISTS (
  SELECT 1 FROM artifact_verifications v
  WHERE v.artifact_id = NEW.artifact_id
    AND v.result = 'verified'
    AND v.computed_sha256 = NEW.sha256
)
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_VERIFICATION_REQUIRED');
END;

CREATE TABLE IF NOT EXISTS artifact_files (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  relative_path TEXT NOT NULL,
  file_id TEXT REFERENCES files(file_id),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (artifact_id, relative_path)
);

CREATE TABLE IF NOT EXISTS artifact_manifests (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE IF NOT EXISTS artifact_verifications (
  verification_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  computed_sha256 TEXT NOT NULL CHECK (length(computed_sha256) = 64),
  expected_commit_sha TEXT,
  result TEXT NOT NULL CHECK (result IN ('verified','mismatch','failed')),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  verified_at TEXT NOT NULL CHECK (verified_at GLOB '????-??-??T??:??:??.???Z'),
  verifier_kind TEXT NOT NULL CHECK (verifier_kind IN ('system','owner','agent'))
);

CREATE INDEX IF NOT EXISTS idx_artifact_verifications ON artifact_verifications(artifact_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS download_events (
  download_id TEXT PRIMARY KEY,
  file_id TEXT REFERENCES files(file_id),
  artifact_id TEXT REFERENCES artifacts(artifact_id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  issued_at TEXT NOT NULL CHECK (issued_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  client_hash TEXT,
  CHECK (file_id IS NOT NULL OR artifact_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_download_events_actor ON download_events(actor_kind, actor_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS retention_policies (
  policy_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('message','memory','file','artifact','log','backup')),
  retain_days INTEGER NOT NULL CHECK (retain_days >= 0),
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0,1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (scope)
);

CREATE TABLE IF NOT EXISTS backup_manifests (
  backup_id TEXT PRIMARY KEY,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??.???Z'),
  finished_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('RUNNING','COMPLETE','FAILED')),
  manifest_sha256 TEXT,
  r2_prefix TEXT,
  restore_tested_at TEXT,
  CHECK (state <> 'COMPLETE' OR (finished_at IS NOT NULL AND manifest_sha256 IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS restore_runs (
  restore_id TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL REFERENCES backup_manifests(backup_id),
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  state TEXT NOT NULL CHECK (state IN ('PLANNED','AWAITING_APPROVAL','EXECUTING','DONE','FAILED','CANCELLED')),
  approval_id TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  executed_at TEXT,
  integrity_check_state TEXT CHECK (integrity_check_state IS NULL OR integrity_check_state IN ('passed','failed','skipped')),
  -- Execution needs an approval reference; planning does not.
  CHECK (state NOT IN ('EXECUTING','DONE') OR approval_id IS NOT NULL)
);

-- ===========================================================================
-- 8. Approvals, usage and operations
-- ===========================================================================

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY CHECK (approval_id LIKE 'apr!_%' ESCAPE '!'),
  project_id TEXT REFERENCES projects(project_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('pull_request','job','deployment','data_deletion','restore','provider_connection','workflow_dispatch')),
  target_id TEXT NOT NULL,
  bound_commit_sha TEXT,
  bound_job_id TEXT,
  diff_sha TEXT,
  action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
  request_reason TEXT NOT NULL CHECK (length(request_reason) BETWEEN 1 AND 2000),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','DENIED','EXPIRED','INVALIDATED','REVOKED')),
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('owner','agent','system')),
  requested_by_id TEXT NOT NULL,
  requested_at TEXT NOT NULL CHECK (requested_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (expires_at > requested_at),
  decided_at TEXT,
  decided_by_owner_id TEXT REFERENCES owners(owner_id),
  CHECK (state NOT IN ('APPROVED','DENIED') OR (decided_at IS NOT NULL AND decided_by_owner_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_approvals_target ON approvals(target_type, target_id);

-- The owner cannot approve something that already expired.
CREATE TRIGGER IF NOT EXISTS trg_approval_no_late_approval
BEFORE UPDATE OF state ON approvals
WHEN NEW.state = 'APPROVED' AND NEW.decided_at IS NOT NULL AND NEW.decided_at >= NEW.expires_at
BEGIN
  SELECT RAISE(ABORT, 'APPROVAL_EXPIRED');
END;

-- Any material change after approval invalidates it automatically (spec 05.3 #9).
CREATE TRIGGER IF NOT EXISTS trg_approval_invalidate_on_change
AFTER UPDATE OF action_digest, bound_commit_sha, target_id, diff_sha ON approvals
WHEN NEW.state = 'APPROVED' AND (
  NEW.action_digest <> OLD.action_digest
  OR IFNULL(NEW.bound_commit_sha,'') <> IFNULL(OLD.bound_commit_sha,'')
  OR NEW.target_id <> OLD.target_id
  OR IFNULL(NEW.diff_sha,'') <> IFNULL(OLD.diff_sha,'')
)
BEGIN
  UPDATE approvals SET state = 'INVALIDATED' WHERE approval_id = NEW.approval_id;
  INSERT INTO audit_events (audit_id, event_type, actor_kind, actor_id, target_type, target_id, allow_or_deny, reason_code, metadata_json, created_at)
  VALUES ('evt_' || lower(hex(randomblob(12))), 'approval.invalidated', 'system', 'system',
          'approval', NEW.approval_id, 'deny', 'APPROVAL_STALE', '{}',
          strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TABLE IF NOT EXISTS provider_usage (
  usage_id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  value REAL NOT NULL CHECK (value >= 0),
  source TEXT NOT NULL CHECK (source IN ('measured','estimated')),
  evidence_ref TEXT,
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_provider_usage ON provider_usage(provider_key, metric, period_start DESC);

CREATE TABLE IF NOT EXISTS quota_policies (
  quota_id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  hard_limit REAL NOT NULL CHECK (hard_limit >= 0),
  soft_limit REAL CHECK (soft_limit IS NULL OR soft_limit >= 0),
  reset_period TEXT NOT NULL CHECK (reset_period IN ('daily','monthly','none')),
  billing_forbidden INTEGER NOT NULL DEFAULT 1 CHECK (billing_forbidden IN (0,1)),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (provider_key, resource_kind)
);

CREATE TABLE IF NOT EXISTS usage_budgets (
  budget_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  hard_limit_value REAL NOT NULL CHECK (hard_limit_value >= 0),
  observed_value REAL CHECK (observed_value IS NULL OR observed_value >= 0),
  observation_state TEXT NOT NULL DEFAULT 'unknown' CHECK (observation_state IN ('unknown','measured','estimated')),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  -- Unknown usage may not be treated as zero: measured needs a value.
  CHECK (observation_state <> 'measured' OR observed_value IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  event_id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('owner','agent','ip','invite')),
  subject_id TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  action_taken TEXT NOT NULL CHECK (action_taken IN ('allowed','throttled','blocked')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id TEXT PRIMARY KEY,
  metric_key TEXT NOT NULL,
  comparison TEXT NOT NULL CHECK (comparison IN ('gt','gte','lt','lte','eq')),
  threshold REAL NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES alert_rules(rule_id),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  raised_at TEXT NOT NULL CHECK (raised_at GLOB '????-??-??T??:??:??.???Z'),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(state, raised_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('owner','agent')),
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  read_at TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_kind, recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security_events (
  security_event_id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'auth_failure','invite_abuse','idor_attempt','path_traversal','csrf_blocked','cors_blocked',
    'secret_scan_hit','prompt_injection_attempt','rate_limit_blocked','permission_denied','anomaly')),
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  actor_kind TEXT,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  detail_redacted TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX IF NOT EXISTS idx_security_events ON security_events(severity, created_at DESC);

CREATE TABLE IF NOT EXISTS feature_capabilities (
  capability_id TEXT PRIMARY KEY,
  feature_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available','degraded','blocked','not_implemented')),
  requires_provider TEXT,
  evidence_ref TEXT,
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  UNIQUE (feature_key)
);

-- Record this migration. The checksum is filled by scripts/db-migrate.mjs so a
-- modified migration is detected instead of silently re-applied.
INSERT INTO schema_migrations (version, applied_at, checksum, note)
VALUES ('0001_initial', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', 'initial contract schema')
ON CONFLICT(version) DO NOTHING;

-- ===========================================================================
-- 9. Deletion propagation (spec 05.3 #10, 22.3, 35.5)
-- A soft delete must reach search, memory links and download links. These
-- triggers are the safety net; the service still writes actor-specific
-- tombstones itself so the audit trail names a real actor.
-- ===========================================================================

CREATE TRIGGER IF NOT EXISTS trg_message_tombstone_on_delete
AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  INSERT INTO message_tombstones (message_id, room_id, deleted_by_kind, deleted_by_id, deleted_at, content_sha256)
  SELECT NEW.message_id, NEW.room_id, 'system', 'system', NEW.deleted_at,
         (SELECT v.content_sha256 FROM message_versions v
           WHERE v.message_id = NEW.message_id ORDER BY v.revision DESC LIMIT 1)
  WHERE NOT EXISTS (SELECT 1 FROM message_tombstones t WHERE t.message_id = NEW.message_id);

  INSERT INTO search_tombstones (target_kind, target_id, deleted_at)
  VALUES ('message', NEW.message_id, NEW.deleted_at)
  ON CONFLICT(target_kind, target_id) DO UPDATE SET deleted_at = excluded.deleted_at;

  UPDATE message_receipts SET state = 'FAILED' WHERE message_id = NEW.message_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_message_restore
AFTER UPDATE OF deleted_at ON messages
WHEN NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL
BEGIN
  DELETE FROM message_tombstones WHERE message_id = NEW.message_id;
  DELETE FROM search_tombstones WHERE target_kind = 'message' AND target_id = NEW.message_id;
  INSERT INTO message_fts (message_id, room_id, body_text)
  SELECT NEW.message_id, NEW.room_id, v.body_plain_text
  FROM message_versions v
  WHERE v.message_id = NEW.message_id
  ORDER BY v.revision DESC LIMIT 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_file_tombstone_on_delete
AFTER UPDATE OF deleted_at ON files
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  INSERT INTO search_tombstones (target_kind, target_id, deleted_at)
  VALUES ('file', NEW.file_id, NEW.deleted_at)
  ON CONFLICT(target_kind, target_id) DO UPDATE SET deleted_at = excluded.deleted_at;
  UPDATE download_events SET expires_at = NEW.deleted_at WHERE file_id = NEW.file_id AND used_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_artifact_tombstone_on_delete
AFTER UPDATE OF deleted_at ON artifacts
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  INSERT INTO search_tombstones (target_kind, target_id, deleted_at)
  VALUES ('artifact', NEW.artifact_id, NEW.deleted_at)
  ON CONFLICT(target_kind, target_id) DO UPDATE SET deleted_at = excluded.deleted_at;
  UPDATE download_events SET expires_at = NEW.deleted_at WHERE artifact_id = NEW.artifact_id AND used_at IS NULL;
END;

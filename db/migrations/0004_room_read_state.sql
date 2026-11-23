-- 0004_room_read_state.sql
--
-- KakaoTalk-style unread counts need one fact per reader per room: the highest
-- room_seq that reader has actually seen. Without it every message would have to
-- guess, and a badge that guesses is worse than no badge.
--
-- One row per (room, actor). `last_read_seq` only moves forward (the gateway
-- writes MAX(old, new)), so a delayed report from a second tab can never rewind
-- another reader's place. `updated_at` is what tells an idle bot apart from a
-- member who is actually reading: the client counts a reader as "active" only
-- while this row was touched within the active window, so an AI that stopped
-- visiting the room stops inflating every unread number.
--
-- Additive only: no existing table or row is rewritten, and a database without
-- this migration keeps working (the gateway answers `reads: []` and hides the
-- numbers instead of inventing them).

CREATE TABLE IF NOT EXISTS room_read_state (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','agent')),
  actor_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  PRIMARY KEY (room_id, actor_kind, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_room_read_state_room
  ON room_read_state(room_id, updated_at DESC);

-- Record this migration. The checksum is filled by scripts/db-migrate.mjs.
INSERT INTO schema_migrations (version, applied_at, checksum, note)
VALUES ('0004_room_read_state', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', 'per-reader last read sequence for unread badges')
ON CONFLICT(version) DO NOTHING;

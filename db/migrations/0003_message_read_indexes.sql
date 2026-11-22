-- 0003_message_read_indexes.sql
--
-- Reading a conversation page is the hottest query in the product, and it has two
-- shapes the schema did not index for:
--
--   1. the live page — `room_id = ? AND deleted_at IS NULL ORDER BY room_seq DESC`
--      (also its keyset variants `room_seq < ?` / `room_seq > ?`)
--   2. one thread's replies — `room_id = ? AND (reply_to_id = ? OR message_id = ?)`
--
-- `idx_messages_room_seq` (room_id, room_seq DESC) covers (1) but carries every
-- tombstone in the scan. A tombstone is never rendered in a page (`deleted_at IS
-- NULL`), so a partial index that leaves them out is smaller, and the planner can
-- walk it in order without a sort. (2) had no index on `reply_to_id` at all.
--
-- Additive only: two indexes, no table or row is rewritten. Indexes are optional
-- for correctness — a database without this migration still answers the same
-- rows, just with more scanning.

CREATE INDEX IF NOT EXISTS idx_messages_room_live_seq
  ON messages(room_id, room_seq DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_room_reply
  ON messages(room_id, reply_to_id)
  WHERE reply_to_id IS NOT NULL;

-- Record this migration. The checksum is filled by scripts/db-migrate.mjs.
INSERT INTO schema_migrations (version, applied_at, checksum, note)
VALUES ('0003_message_read_indexes', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', 'partial indexes for conversation and thread reads')
ON CONFLICT(version) DO NOTHING;

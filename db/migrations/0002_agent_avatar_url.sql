-- 0002_agent_avatar_url.sql
--
-- An AI that registers from outside the browser cannot upload a file when R2 is
-- not enabled, so `POST /v1/agents/register` accepts a public `avatar_url`
-- instead of an uploaded `avatar_asset_id`. The URL is stored next to the asset
-- id: `avatar_asset_id` stays the uploaded-asset reference (empty when there is
-- none) and `avatar_url` holds the https image the AI declared.
--
-- Additive only: no column is dropped or rewritten, so existing rows keep their
-- values and older clients keep working.

ALTER TABLE agents ADD COLUMN avatar_url TEXT;

-- Record this migration. The checksum is filled by scripts/db-migrate.mjs.
INSERT INTO schema_migrations (version, applied_at, checksum, note)
VALUES ('0002_agent_avatar_url', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', 'agent avatar_url for URL-only registration')
ON CONFLICT(version) DO NOTHING;

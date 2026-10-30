-- One-time migration for the live D1 (2026-10): games.land_denial, the
-- "won via land denial" flag for bracket 4 games. schema.sql already has
-- it for a fresh database. Every existing game gets 0, so no current
-- ranking or deck strength changes. Run once from cloudflare-worker/:
--   npx wrangler d1 execute mtg-pod-validator-db --remote --file=migration_2026_10_land_denial.sql
-- Then deploy the Worker (npx wrangler deploy) -- the new relay.js reads
-- and writes this column, so run this migration first.

ALTER TABLE games ADD COLUMN land_denial INTEGER NOT NULL DEFAULT 0;

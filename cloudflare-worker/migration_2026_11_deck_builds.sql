-- One-time migration for the live D1 (2026-11): deck_builds, Build a Deck's
-- saved results. schema.sql already has it for a fresh database. A new
-- table only, so nothing existing changes. Run once from cloudflare-worker/:
--   npx wrangler d1 execute mtg-pod-validator-db --remote --file=migration_2026_11_deck_builds.sql
-- Then deploy the Worker (npx wrangler deploy) -- the new relay.js reads
-- and writes this table, so run this migration first.

CREATE TABLE IF NOT EXISTS deck_builds (
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  commander TEXT NOT NULL,
  commander2 TEXT,
  bracket INTEGER NOT NULL CHECK (bracket BETWEEN 1 AND 5),
  options_json TEXT NOT NULL,
  cards_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deck_builds_player ON deck_builds(player_id, updated_at);

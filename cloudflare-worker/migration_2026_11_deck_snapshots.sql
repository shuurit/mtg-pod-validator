-- One-time migration for the live D1 (2026-11): deck_snapshots, the stored
-- copy of each Archidekt deck a player opens from the Decks tab, so a deck
-- opens at once instead of waiting on Archidekt and Scryfall. schema.sql
-- already has it for a fresh database. A new table only, so nothing
-- existing changes. Run once from cloudflare-worker/:
--   npx wrangler d1 execute mtg-pod-validator-db --remote --file=migration_2026_11_deck_snapshots.sql
-- Then deploy the Worker (npx wrangler deploy) -- the new relay.js reads
-- and writes this table, so run this migration first.

CREATE TABLE IF NOT EXISTS deck_snapshots (
  player_id INTEGER NOT NULL REFERENCES players(id),
  archidekt_deck_id INTEGER NOT NULL,
  -- The GET /my-decks/cards answer as it was read (name, commanders, every
  -- card with its Scryfall facts), as JSON.
  payload_json TEXT NOT NULL,
  -- The deck's own last edit on Archidekt when this copy was read; compared
  -- with the deck list's updatedAt to tell when the copy is out of date.
  archidekt_updated_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, archidekt_deck_id)
);
CREATE INDEX IF NOT EXISTS idx_deck_snapshots_fetched ON deck_snapshots(fetched_at);

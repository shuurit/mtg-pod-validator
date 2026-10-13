-- One-time migration for the live D1 (2026-10): more playgroup.gg data,
-- scoped to the league a game belongs to. schema.sql already has all of
-- this for a fresh database. Run once from cloudflare-worker/:
--   npx wrangler d1 execute mtg-pod-validator-db --remote --file=migration_2026_10_playgroup_season_data.sql
-- Then deploy the Worker (npx wrangler deploy), then fill the current
-- season's already-logged games with POST /achievements/backfill?force=true
-- (repeat while it answers remaining: true).

ALTER TABLE games ADD COLUMN duration_seconds INTEGER;
ALTER TABLE games ADD COLUMN total_rounds INTEGER;

ALTER TABLE game_results ADD COLUMN elo_rating INTEGER;
ALTER TABLE game_results ADD COLUMN elo_delta INTEGER;

ALTER TABLE game_event_stats ADD COLUMN life_lost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_event_stats ADD COLUMN poison_received INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_event_stats ADD COLUMN cards_milled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE decks ADD COLUMN commander_scryfall_id TEXT;
ALTER TABLE decks ADD COLUMN commander_art_url TEXT;
ALTER TABLE decks ADD COLUMN partner_name TEXT;
ALTER TABLE decks ADD COLUMN partner_art_url TEXT;
ALTER TABLE decks ADD COLUMN decklist_url TEXT;
ALTER TABLE decks ADD COLUMN playgroup_bracket INTEGER;

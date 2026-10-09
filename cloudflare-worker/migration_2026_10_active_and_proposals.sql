-- One-time migration for the live D1 (2026-10): players.active /
-- players.is_admin, then the Pod Proposals tables. schema.sql already has
-- all of this for a fresh database. Run once from cloudflare-worker/:
--   npx wrangler d1 execute mtg-pod-validator-db --remote --file=migration_2026_10_active_and_proposals.sql
-- The admin is set separately, once, by name (Shuurit's own player row):
--   npx wrangler d1 execute mtg-pod-validator-db --remote --command "UPDATE players SET is_admin = 1 WHERE name = '<your player name>'"
-- Then deploy the Worker (npx wrangler deploy) -- the new relay.js reads
-- these columns, so run this migration first.

ALTER TABLE players ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE players ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
UPDATE players SET active = 0 WHERE name IN ('Kristy', 'Joseph');

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rule', 'idea')),
  title TEXT NOT NULL,
  applies_to TEXT,
  anonymous INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'trial', 'adopted', 'shelved')),
  shelved_reason TEXT CHECK (shelved_reason IN ('majority_no', 'expired')),
  proposed_by_player_id INTEGER NOT NULL REFERENCES players(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voting_closes_at TEXT NOT NULL,
  decided_at TEXT,
  trial_games INTEGER NOT NULL DEFAULT 4,
  trial_after_game_id INTEGER,
  reopen_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE proposal_points (
  id INTEGER PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  side TEXT NOT NULL CHECK (side IN ('out', 'in', 'pro', 'con')),
  text TEXT NOT NULL,
  added_by_player_id INTEGER NOT NULL REFERENCES players(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_proposal_points_proposal ON proposal_points(proposal_id);

CREATE TABLE proposal_votes (
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  vote TEXT NOT NULL CHECK (vote IN ('yes', 'no')),
  voted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (proposal_id, player_id)
);

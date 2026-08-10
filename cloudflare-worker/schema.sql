-- D1 schema for mtg-pod-validator. See the migration plan for the full
-- rationale (Cloudflare Worker README / project plan doc). Mirrors
-- deck-strength.xlsx's Game Log / Current Deck Strength / Player Adjusted
-- Ranks / Deck Win Rates tabs -- Current Deck Strength's "current power",
-- Player Adjusted Win Rate, rankings, and Deck Win Rates are never stored
-- here; they're computed on read from game_results (see relay.js).

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE  -- "Season 3"
);

CREATE TABLE players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  playgroup_username TEXT UNIQUE  -- null for a player with no playgroup.gg account
);

CREATE TABLE decks (
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  name TEXT NOT NULL,
  baseline_power REAL NOT NULL,
  playgroup_deck_id TEXT,
  bracket INTEGER,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  game_num INTEGER NOT NULL,       -- scoped per season, matches today's Game Log
  played_at TEXT NOT NULL,
  pod_size INTEGER NOT NULL,
  playgroup_game_id TEXT UNIQUE,
  UNIQUE(season_id, game_num)
);

CREATE TABLE game_results (
  game_id INTEGER NOT NULL REFERENCES games(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  deck_id INTEGER NOT NULL REFERENCES decks(id),
  commander_strength REAL NOT NULL,
  result INTEGER NOT NULL,   -- 1=win, 0=loss
  place INTEGER NOT NULL,
  knockouts INTEGER NOT NULL,
  tov INTEGER NOT NULL,
  pop_off INTEGER NOT NULL,
  disruptions INTEGER NOT NULL,
  recoveries INTEGER NOT NULL,
  games_clearly_behind INTEGER NOT NULL,
  bracket INTEGER NOT NULL,
  -- j/k/l/m/n/o/q/u/x mirror computeGameRowFormulas' own {J,K,L,M,N,O,Q,U,X}
  -- return keys 1:1 -- computed once at write time, stored (not
  -- recomputed on every read), same as a spreadsheet's cached formula value.
  j REAL NOT NULL, k REAL NOT NULL, l REAL NOT NULL, m REAL NOT NULL,
  n REAL NOT NULL, o REAL NOT NULL, q REAL NOT NULL, u REAL NOT NULL,
  x REAL NOT NULL,  -- Game Calculated Deck Strength
  PRIMARY KEY (game_id, player_id)
);

CREATE INDEX idx_decks_player ON decks(player_id);
CREATE INDEX idx_games_season ON games(season_id);
CREATE INDEX idx_game_results_player ON game_results(player_id);
CREATE INDEX idx_game_results_deck ON game_results(deck_id);

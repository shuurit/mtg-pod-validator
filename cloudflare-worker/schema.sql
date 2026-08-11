-- D1 schema for mtg-pod-validator. See the migration plan for the full
-- rationale (Cloudflare Worker README / project plan doc). Mirrors
-- deck-strength.xlsx's Game Log / Current Deck Strength / Player Adjusted
-- Ranks / Deck Win Rates tabs -- Current Deck Strength's "current power",
-- Player Adjusted Win Rate, rankings, and Deck Win Rates are never stored
-- here; they're computed on read from game_results (see relay.js).

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,  -- "Season 3", or playgroup.gg's own league name once auto-created (see below)
  -- playgroup.gg's league id. NULL for seasons migrated from the spreadsheet
  -- (they predate this and have no clean 1:1 playgroup.gg league to point
  -- at). Populated automatically going forward: POST /games (Phase 3)
  -- resolves playgroup.gg's current active league at write time and looks
  -- it up here; if no season has that league_id yet, one is auto-created
  -- using the league's own name as the label -- so starting a new league in
  -- playgroup.gg is what starts a new season here too, no separate manual
  -- step. A plain UNIQUE column can't be added via ALTER TABLE in SQLite
  -- (confirmed the hard way), hence the separate unique index below --
  -- which also correctly allows multiple NULLs, unlike a UNIQUE column
  -- constraint would.
  playgroup_league_id TEXT
);
CREATE UNIQUE INDEX idx_seasons_league ON seasons(playgroup_league_id);

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
  -- playgroup.gg's own name for this deck (e.g. "Pizza Party!") -- distinct
  -- from `name` above, which is the tracked/commander-based name this app
  -- uses. Not surfaced in the app yet; captured so a deck's playgroup.gg
  -- identity is on record for things like spotting a commander swap that
  -- splits one physical deck into two playgroup.gg deck ids (see the
  -- Leonardo/Michelangelo case this column exists because of).
  playgroup_deck_name TEXT,
  bracket INTEGER,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  game_num INTEGER NOT NULL,       -- scoped per season, matches today's Game Log
  played_at TEXT NOT NULL,
  pod_size INTEGER NOT NULL,
  -- INTEGER, not TEXT -- a JS number bound into a TEXT-affinity column
  -- gets REAL-to-TEXT cast by SQLite regardless of whether it's whole
  -- (confirmed the hard way: two real games got stored as "944159.0" /
  -- "945272.0" the moment they were written through the live app, not
  -- just via the one-time migration script that originally introduced
  -- this for a couple of rows). INTEGER affinity converts a whole-valued
  -- REAL back to a clean integer on write, so this can't recur regardless
  -- of how a future write path binds the value.
  playgroup_game_id INTEGER UNIQUE,
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
  -- Computed once at write time and stored (not recomputed on every read),
  -- same as a spreadsheet's cached formula value. Named for what they are
  -- rather than the Game Log's column letters, so PRAGMA table_info (which
  -- shows no comments) is still self-explanatory to anyone querying this
  -- table directly. Names below map 1:1 to computeGameRowFormulas' own
  -- {J,K,L,M,N,O,Q,U,X} return keys in that order.
  adjusted_pod_size_score REAL NOT NULL,      -- J: Adjusted Pod Size Win/Loss Score
  knockout_score REAL NOT NULL,               -- K: Knockout Score
  deck_strength_differential REAL NOT NULL,   -- L: Deck Strength Comparison Differential
  win_probability REAL NOT NULL,              -- M: Win Probability based on Deck Strength
  player_score REAL NOT NULL,                 -- N: Player Score
  normalized_player_score REAL NOT NULL,      -- O: Normalized Player Score
  normalized_tov REAL NOT NULL,               -- Q: Normalized TOV
  deck_resilience_score REAL NOT NULL,        -- U: Deck Resilience Score
  game_calculated_deck_strength REAL NOT NULL, -- X: Game Calculated Deck Strength
  PRIMARY KEY (game_id, player_id)
);

CREATE INDEX idx_decks_player ON decks(player_id);
CREATE INDEX idx_games_season ON games(season_id);
CREATE INDEX idx_game_results_player ON game_results(player_id);
CREATE INDEX idx_game_results_deck ON game_results(deck_id);

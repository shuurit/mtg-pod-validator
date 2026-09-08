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
  playgroup_username TEXT UNIQUE,  -- null for a player with no playgroup.gg account
  -- playgroup.gg's stable numeric user id -- the actual identity key used
  -- for matching (getUserIdToPlayerMap), not playgroup_username above.
  -- Confirmed the hard way that a username is NOT stable: a real player
  -- renamed their playgroup.gg account mid-session, which silently broke
  -- every username-keyed lookup (stopped showing as tracked, decks
  -- disappeared from matching) with no error anywhere. playgroup_username
  -- is kept for display/lookup convenience, not identity. Added via
  -- ALTER TABLE + a separate unique index, same reason as
  -- seasons.playgroup_league_id -- SQLite rejects UNIQUE on ADD COLUMN.
  playgroup_user_id INTEGER,
  -- Discord's stable numeric user id -- the identity key for sign-in (see
  -- requireSession in relay.js). Linked manually, one UPDATE per player, not
  -- self-serve -- the group is small and stable enough that a "claim your
  -- account" flow isn't worth building. Same ALTER TABLE + separate unique
  -- index pattern as playgroup_user_id above, for the same reason (SQLite
  -- rejects UNIQUE on ADD COLUMN).
  discord_user_id TEXT
);
CREATE UNIQUE INDEX idx_players_pg_user_id ON players(playgroup_user_id);
CREATE UNIQUE INDEX idx_players_discord_user_id ON players(discord_user_id);

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
  archived INTEGER NOT NULL DEFAULT 0,
  -- Explicitly maintained, not inferred from game_results -- a deck with no
  -- logged games isn't reliably "brand new" (older decks' full history
  -- isn't guaranteed to be captured in D1), so this is asserted directly
  -- instead of guessed. Set to 1 by handleRosterWrite when a deck is
  -- pulled in via Update the App, cleared back to 0 by handleGamesWrite
  -- the moment any game actually gets logged for it. Set Up Pod exempts
  -- decks where this is 1 from the power-spread check (see
  -- computePlayersData/evaluatePod) -- baseline_power is an unconfirmed
  -- estimate until then.
  new_deck INTEGER NOT NULL DEFAULT 0,
  -- Manually curated, not inferred -- most decks could never have an early
  -- two-card combo, so this gates whether Games to Update even asks about
  -- it for a given deck (see game_results.early_two_card_combo below)
  -- rather than showing that checkbox for every deck in every game.
  potential_bracket_4 INTEGER NOT NULL DEFAULT 0,
  -- playgroup.gg's own color_identity array (e.g. ["G","U"]), collapsed to
  -- a plain string in WUBRG order (e.g. "UG") -- see toCanonicalColorString
  -- in relay.js. NULL means "never captured" (no playgroup_deck_id to match
  -- against, or not synced yet), distinct from "" which means a confirmed
  -- colorless deck -- the two need to render differently (no badge at all
  -- vs. a neutral one), not collapse into the same falsy check. Synced
  -- opportunistically off the same /users/{id}/decks read syncDecksFromPlaygroup
  -- already does for `archived`, and set directly at write time for a deck
  -- added fresh via Update the App -- never guessed or computed here.
  color_identity TEXT
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
  -- Who was actually signed in when this game was submitted -- nullable so
  -- games logged before sign-in existed (or a session that's since expired)
  -- aren't a problem. Purely for accountability now that writes require
  -- auth; nothing reads this back into any calculation.
  submitted_by_player_id INTEGER REFERENCES players(id),
  -- Both straight from playgroup.gg's own event log (game-level, not
  -- per-player) -- see computeAndStoreGameEventStats in relay.js. Nullable:
  -- backfilled for existing games same as game_event_stats itself, and
  -- win_con specifically can be null if a game ended without one ever
  -- being set. Power the Timmy/Johnny-award and "goes first" achievements
  -- (GET /achievements); neither feeds the power-spread math.
  win_con TEXT,
  starting_player_id INTEGER REFERENCES players(id),
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
  -- Only ever asked about (and meaningful) for a deck flagged
  -- decks.potential_bracket_4 -- 0 for every other deck's games, not a real
  -- "no" so much as "never asked". computePlayersData looks at each deck's
  -- 5 most recent games; 3+ with this set surfaces a "Bracket 4 pattern"
  -- badge (see app.js's buildComboBadge) -- read-time only, never writes
  -- decks.bracket and never resets power.
  early_two_card_combo INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, player_id)
);

CREATE INDEX idx_decks_player ON decks(player_id);
CREATE INDEX idx_games_season ON games(season_id);
CREATE INDEX idx_game_results_player ON game_results(player_id);
CREATE INDEX idx_game_results_deck ON game_results(deck_id);

-- Per-player, per-game stats summed from playgroup.gg's own event log
-- (normal_damage/commander_damage/healing/kill events) plus its
-- participations' self-reported fields -- see
-- computeAndStoreGameEventStats in relay.js. Computed once, either at
-- write time (handleGamesWrite, which already resolves playgroup_game_id)
-- or via the one-time POST /achievements/backfill pass for games logged
-- before this table existed -- same "compute once, store the result"
-- pattern game_results already uses for its own formula columns, never
-- recomputed live on every read. Added for the Seasonal Achievements
-- feature (GET /achievements); none of these columns feed the
-- power-spread math.
CREATE TABLE game_event_stats (
  game_id INTEGER NOT NULL REFERENCES games(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  damage_dealt INTEGER NOT NULL DEFAULT 0,
  healing_done INTEGER NOT NULL DEFAULT 0,
  knockouts INTEGER NOT NULL DEFAULT 0,
  -- Straight from playgroup.gg's participations array, not derived --
  -- self-reported per player per game. Nullable, not "0 means none":
  -- confirmed against a real game that mulligans_taken in particular is
  -- often null (not consistently recorded).
  fun_rating INTEGER,
  salt_rating INTEGER,
  mulligans_taken INTEGER,
  -- self_rating has no participations-level equivalent (unlike the three
  -- above) -- it only exists as its own event kind, so this is read from
  -- events directly, not the participations array. A distinct metric from
  -- fun_rating, confirmed against a real game where the same player's
  -- fun_rating and self_rating disagreed.
  self_rating INTEGER,
  -- Same normal_damage/commander_damage/healing events as damage_dealt/
  -- healing_done above, just summed by receiver_user_id instead of
  -- user_id -- what this player took/received rather than dealt out.
  damage_taken INTEGER NOT NULL DEFAULT 0,
  healing_received INTEGER NOT NULL DEFAULT 0,
  -- Derived, not a raw field: the game's life_amount (starting life total)
  -- minus damage_taken plus healing_received. Can go negative (a player
  -- eliminated well past zero) or above life_amount (healed past
  -- starting life, which real Commander games do allow) -- both are
  -- accurate, not errors.
  ending_life INTEGER,
  -- pause_start/pause_stop and undo events, both previously uncaptured.
  -- pauses_called counts pause_start events attributed to whoever called
  -- them; pause_seconds pairs each pause_start with the next pause_stop
  -- chronologically (not necessarily the same user_id -- anyone can
  -- resume) and sums the duration, still attributed to whoever called the
  -- pause. undos is a plain per-player event count.
  pauses_called INTEGER NOT NULL DEFAULT 0,
  pause_seconds INTEGER NOT NULL DEFAULT 0,
  undos INTEGER NOT NULL DEFAULT 0,
  -- Longest single pass_turn-to-pass_turn gap this player had in this
  -- game (seconds), raw wall-clock time, not pause-adjusted. Confirmed
  -- against a real ~7-hour game that a long turn usually means the whole
  -- table slowed down together late in a marathon session, not one player
  -- stalling -- a fun/quirky stat, not a rigorous one. 0 (not null) when
  -- the game has no start_game event to anchor the first turn from.
  longest_turn_seconds INTEGER NOT NULL DEFAULT 0,
  -- Shortest single pass_turn-to-pass_turn gap this player had in this
  -- game (seconds), same raw wall-clock measurement as longest_turn_seconds
  -- above. Nullable (not 0-as-sentinel like longest_turn_seconds): a real
  -- turn genuinely can take 0 seconds (nothing to do, pass immediately),
  -- so null is what means "no turn timing for this game" here, not 0.
  shortest_turn_seconds INTEGER,
  PRIMARY KEY (game_id, player_id)
);

-- One row per (achievement, player) who's voted on whether that achievement
-- (identified by its ACHIEVEMENTS id in relay.js, e.g. "most-damage" -- not
-- a table of its own, so no foreign key) should stay in the lineup or get
-- cut before the season ends. vote is 1 (keep) or -1 (cut), never both --
-- voting again just overwrites this player's prior vote (see
-- handleAchievementVote's ON CONFLICT), and retracting a vote entirely
-- deletes the row rather than storing a third "no opinion" value.
CREATE TABLE achievement_votes (
  achievement_id TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  vote INTEGER NOT NULL,
  PRIMARY KEY (achievement_id, player_id)
);

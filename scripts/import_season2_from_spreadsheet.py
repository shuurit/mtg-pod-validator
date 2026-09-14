"""
One-time backfill of Season 2's real game data from deck-strength.xlsx into
D1, so the trophy system has something to compute for season_id=2 (which
already exists as an empty shell -- 0 games -- created ahead of this).

Only touches `games` and `game_results`. No `decks` rows are created: every
(player, commander) pair in the "Game Log Season 2" sheet was checked
against the live decks table first and matches an existing deck exactly
(confirmed by hand before writing this) -- these are the same persistent
decks players still pilot today, not a separate Season 2 roster.

Deliberately does NOT touch `game_event_stats` (damage/healing/mulligans/
self-ratings/pauses/undos/turn timing) -- none of that was ever recorded
for Season 2, since playgroup.gg's live event tracking didn't exist yet.
Any trophy that reads from game_event_stats (most-damage, most-knockouts,
denial, longest-turn, etc.) will correctly show "not enough data" for
Season 2 after this runs -- that's accurate, not a bug to fix here.

The spreadsheet's J/K/L/M/N/O/Q/U/X columns are copied straight into
game_results' matching precomputed columns (adjusted_pod_size_score,
knockout_score, ...) rather than recomputed -- schema.sql's own comment on
those columns says they're "the same as a spreadsheet's cached formula
value", so this is the intended source, not a shortcut.

Usage:
    python scripts/import_season2_from_spreadsheet.py
Writes cloudflare-worker/season2_import.sql, then run it with:
    npx wrangler d1 execute mtg-pod-validator-db --remote --file=season2_import.sql
(from cloudflare-worker/) -- deliberately a separate manual step, not run
automatically from here, so the generated SQL can be read before it
touches the real database.
"""
import json
from pathlib import Path

import openpyxl

ROOT = Path(__file__).parent.parent
SPREADSHEET = ROOT / "deck-strength.xlsx"
OUT_SQL = ROOT / "cloudflare-worker" / "season2_import.sql"

SEASON_ID = 2

# Column indices (0-based) in "Game Log Season 2", per its own header row.
COL = {
    "date": 0, "game_num": 1, "player": 2, "commander": 3, "commander_strength": 4,
    "result": 5, "place": 6, "pod_size": 7, "knockouts": 8,
    "adjusted_pod_size_score": 9, "knockout_score": 10, "deck_strength_differential": 11,
    "win_probability": 12, "player_score": 13, "normalized_player_score": 14,
    "tov": 15, "normalized_tov": 16, "pop_off": 17, "disruptions": 18,
    "recoveries": 19, "deck_resilience_score": 20, "games_clearly_behind": 21,
    "bracket": 22, "game_calculated_deck_strength": 23,
}


def sql_str(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    wb = openpyxl.load_workbook(SPREADSHEET, data_only=True)
    ws = wb["Game Log Season 2"]
    rows = [r for r in ws.iter_rows(min_row=3, values_only=True) if r[0] is not None]
    print(f"Read {len(rows)} player-game rows from the spreadsheet.")

    # players/decks lookups -- must match the live DB, not be guessed, so
    # this refuses to run against stale/hand-typed data.
    players_path = ROOT / "cloudflare-worker" / "_season2_players.json"
    decks_path = ROOT / "cloudflare-worker" / "_season2_decks.json"
    if not players_path.exists() or not decks_path.exists():
        raise SystemExit(
            f"Missing {players_path.name}/{decks_path.name} -- generate them first with:\n"
            f'  npx wrangler d1 execute mtg-pod-validator-db --remote --command "SELECT id, name FROM players" --json > {players_path}\n'
            f'  npx wrangler d1 execute mtg-pod-validator-db --remote --command "SELECT id, player_id, name FROM decks" --json > {decks_path}'
        )
    players = json.loads(players_path.read_text())[0]["results"]
    decks = json.loads(decks_path.read_text())[0]["results"]
    player_id_by_name = {p["name"]: p["id"] for p in players}
    deck_id_by_key = {(d["player_id"], d["name"]): d["id"] for d in decks}

    # Group into games first, so each game is written once regardless of
    # how many players sat in it.
    games = {}
    for r in rows:
        gnum = r[COL["game_num"]]
        games.setdefault(gnum, {"date": r[COL["date"]], "pod_size": r[COL["pod_size"]]})

    statements = []
    statements.append(f"-- Season 2 import generated from deck-strength.xlsx, {len(games)} games / {len(rows)} player-rows.")
    statements.append("-- Idempotency: refuses to run twice via the guard below (season_id=2 already having any")
    statements.append("-- games would make every game_num collide against the UNIQUE(season_id, game_num) constraint,")
    statements.append("-- so a second run fails loudly on the first INSERT rather than silently duplicating).")
    statements.append("")

    for gnum in sorted(games):
        g = games[gnum]
        played_at = g["date"].date().isoformat()
        statements.append(
            f"INSERT INTO games (season_id, game_num, played_at, pod_size) "
            f"VALUES ({SEASON_ID}, {gnum}, {sql_str(played_at)}, {g['pod_size']});"
        )

    unmatched = []
    for r in rows:
        pname = r[COL["player"]]
        commander = r[COL["commander"]]
        pid = player_id_by_name.get(pname)
        if pid is None:
            unmatched.append(("unknown player", pname))
            continue
        deck_id = deck_id_by_key.get((pid, commander))
        if deck_id is None:
            unmatched.append(("unknown deck", pname, commander))
            continue

        gnum = r[COL["game_num"]]
        game_id_expr = f"(SELECT id FROM games WHERE season_id={SEASON_ID} AND game_num={gnum})"
        cols = [
            "game_id", "player_id", "deck_id", "commander_strength", "result", "place",
            "knockouts", "tov", "pop_off", "disruptions", "recoveries", "games_clearly_behind",
            "bracket", "adjusted_pod_size_score", "knockout_score", "deck_strength_differential",
            "win_probability", "player_score", "normalized_player_score", "normalized_tov",
            "deck_resilience_score", "game_calculated_deck_strength",
        ]
        values = [
            game_id_expr, str(pid), str(deck_id),
            str(r[COL["commander_strength"]]), str(int(r[COL["result"]])), str(r[COL["place"]]),
            str(r[COL["knockouts"]]), str(r[COL["tov"]]), str(r[COL["pop_off"]]),
            str(r[COL["disruptions"]]), str(r[COL["recoveries"]]), str(r[COL["games_clearly_behind"]]),
            str(r[COL["bracket"]]), str(r[COL["adjusted_pod_size_score"]]), str(r[COL["knockout_score"]]),
            str(r[COL["deck_strength_differential"]]), str(r[COL["win_probability"]]),
            str(r[COL["player_score"]]), str(r[COL["normalized_player_score"]]),
            str(r[COL["normalized_tov"]]), str(r[COL["deck_resilience_score"]]),
            str(r[COL["game_calculated_deck_strength"]]),
        ]
        statements.append(f"INSERT INTO game_results ({', '.join(cols)}) VALUES ({', '.join(values)});")

    if unmatched:
        raise SystemExit(f"Refusing to write SQL -- {len(unmatched)} unmatched rows: {unmatched[:10]}")

    OUT_SQL.write_text("\n".join(statements) + "\n", encoding="utf-8")
    print(f"Wrote {len(games)} games + {len(rows)} game_results rows to {OUT_SQL}")
    print("Review it, then run from cloudflare-worker/:")
    print(f"  npx wrangler d1 execute mtg-pod-validator-db --remote --file={OUT_SQL.name}")


if __name__ == "__main__":
    main()

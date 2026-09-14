"""
Enriches the already-imported Season 2 games with real playgroup.gg data
that the spreadsheet never had: win_con (per game) and fun_rating/
salt_rating/mulligans_taken (per player-game). Confirmed via
/debug/league-game-ids that playgroup.gg still holds 24 real games tagged
to league 997 ("Amass a Gathering Season 2") -- one fewer than the
spreadsheet's 25, since apparently one spreadsheet game was never actually
logged into playgroup.gg.

Deliberately does NOT touch damage/healing/pauses/undos/turn timing/
self-rating -- every one of the 24 confirmed games has an empty `events`
array (checked by hand), confirming live event tracking genuinely wasn't
running yet, not just unsynced.

Deliberately does NOT write anything for Kristy or Joseph -- they're
excluded from ever winning a trophy (see EXCLUDED_FROM_TROPHIES in
relay.js) and, unlike the other six players, were never linked to a
playgroup_username in D1, so identifying their rows with confidence isn't
worth doing for data that can never surface anyway. A game's OTHER known
participants are still enriched normally regardless of who else was at
the table.

Matching a raw playgroup.gg game to one of the 25 already-imported D1
games uses only the pod's *known* players (the 6 who have a
playgroup_username on file), not the full table, and requires an
UNAMBIGUOUS match on all of: pod size, date within 1 day (playgroup.gg
timestamps are UTC+2, spreadsheet dates were plain local dates -- confirmed
one real example is off by exactly one calendar day for that reason), and
every known player present in the playgroup.gg game must also appear in
the candidate D1 game. Refuses to write anything if any of the 24 doesn't
match exactly one D1 game, rather than guess.

Usage:
    python scripts/enrich_season2_from_playgroup.py
Reads the two JSON inputs (see paths below, both one-off dumps -- see the
README-style comments at each path for how to regenerate them), writes
cloudflare-worker/season2_enrich.sql. Review it, then run with:
    npx wrangler d1 execute mtg-pod-validator-db --remote --file=season2_enrich.sql
"""
import json
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).parent.parent
OUT_SQL = ROOT / "cloudflare-worker" / "season2_enrich.sql"

# Generate with:
#   npx wrangler d1 execute mtg-pod-validator-db --remote --command \
#     "SELECT g.id AS game_id, g.game_num, g.played_at, g.pod_size, gr.player_id, p.name, gr.result \
#      FROM games g JOIN game_results gr ON gr.game_id = g.id JOIN players p ON p.id = gr.player_id \
#      WHERE g.season_id = 2 ORDER BY g.game_num, gr.player_id" --json > cloudflare-worker/_s2_d1_games.json
D1_GAMES_PATH = ROOT / "cloudflare-worker" / "_s2_d1_games.json"

# One playgroup.gg game per line, fetched via GET /debug/game?id=<id> for
# each of the 24 ids GET /debug/league-game-ids?league_id=997&deck_ids=...
# returned (deck_ids gathered from a wide raw games-list pull covering the
# season's date range -- see the conversation this script came out of for
# exactly how those were sourced; not reproduced as code since it's a
# one-off lookup, not something to re-run).
PG_GAMES_PATH = ROOT / "cloudflare-worker" / "_s2_pg_games.ndjson"

# playgroup_username -> D1 player_id, straight from `players`. Kristy and
# Joseph deliberately excluded (see module docstring).
KNOWN_PLAYERS = {
    "Rebex": 1,      # Becca
    "Thoros": 2,     # Manny
    "shuurit": 3,    # Mateo
    "Ecthelion": 4,  # Ryan
    "Red": 7,
    "MLMyBelle": 8,  # Michelle
}


def sql_str(s):
    return "'" + str(s).replace("'", "''") + "'"


def load_d1_games():
    rows = json.loads(D1_GAMES_PATH.read_text(encoding="utf-8"))[0]["results"]
    games = {}
    for r in rows:
        g = games.setdefault(r["game_id"], {
            "game_id": r["game_id"], "game_num": r["game_num"],
            "played_at": datetime.strptime(r["played_at"], "%Y-%m-%d"),
            "pod_size": r["pod_size"], "players": set(), "winner": None,
        })
        g["players"].add(r["player_id"])
        if r["result"] == 1:
            g["winner"] = r["player_id"]
    return list(games.values())


def load_pg_games():
    games = []
    for line in PG_GAMES_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            games.append(json.loads(line))
    return games


def pg_winner_known_id(pg):
    """The known-player id who won this playgroup.gg game, or None if the
    winner wasn't one of the 6 known players (i.e. Kristy or Joseph)."""
    for p in pg["participations"]:
        if p.get("winner") and p.get("user_name") in KNOWN_PLAYERS:
            return KNOWN_PLAYERS[p["user_name"]]
    return None


def match_candidates(pg, d1_games):
    pg_date = datetime.strptime(pg["ended_at"][:10], "%Y-%m-%d")
    pg_pod_size = len(pg["participations"])
    known_here = {
        KNOWN_PLAYERS[p["user_name"]]: p
        for p in pg["participations"]
        if p.get("user_name") in KNOWN_PLAYERS
    }
    pg_winner = pg_winner_known_id(pg)

    candidates = [
        g for g in d1_games
        if g["pod_size"] == pg_pod_size
        and abs((g["played_at"] - pg_date).days) <= 1
        and set(known_here.keys()).issubset(g["players"])
    ]
    # Tiebreaker for same-day/same-pod/same-known-players collisions (two
    # separate games between the same subset of known players on one day,
    # confirmed a real case: Becca/Mateo/Ryan played twice on 2026-04-11).
    # If playgroup.gg's winner is one of the known players, the matching
    # D1 game must have that same player as its winner. If the winner was
    # Kristy or Joseph instead (not a known player), the matching D1 game's
    # winner must likewise be someone outside this game's known-player set
    # -- i.e. also not one of the six we can identify, consistent either
    # way rather than requiring an exact identity we don't have.
    if len(candidates) > 1:
        if pg_winner is not None:
            candidates = [g for g in candidates if g["winner"] == pg_winner]
        else:
            candidates = [g for g in candidates if g["winner"] not in known_here]

    return candidates, known_here


def main():
    d1_games = load_d1_games()
    pg_games = load_pg_games()
    print(f"{len(d1_games)} D1 season-2 games, {len(pg_games)} confirmed playgroup.gg games.")

    statements = [
        f"-- Season 2 enrichment from playgroup.gg's own real records for league 997, {len(pg_games)} games.",
        "-- win_con per game, fun_rating/salt_rating/mulligans_taken per known player-game.",
        "-- Kristy/Joseph deliberately have no rows written here -- see script docstring.",
        "",
    ]

    unmatched = []
    matched_d1_ids = set()
    for pg in pg_games:
        candidates, known_here = match_candidates(pg, d1_games)

        if len(candidates) != 1:
            unmatched.append((pg["id"], pg["ended_at"], len(pg["participations"]), sorted(known_here.keys()), len(candidates)))
            continue

        d1_game = candidates[0]
        matched_d1_ids.add(d1_game["game_id"])
        if pg.get("win_con"):
            statements.append(f"UPDATE games SET win_con = {sql_str(pg['win_con'])} WHERE id = {d1_game['game_id']};")
        for player_id, p in known_here.items():
            fields, values = [], []
            for col, key in [("fun_rating", "fun_rating"), ("salt_rating", "salt_rating"), ("mulligans_taken", "mulligans_taken")]:
                if p.get(key) is not None:
                    fields.append(col)
                    values.append(str(p[key]))
            if not fields:
                continue
            cols = ", ".join(["game_id", "player_id"] + fields)
            vals = ", ".join([str(d1_game["game_id"]), str(player_id)] + values)
            # INSERT OR REPLACE: a game_event_stats row may already exist
            # for this (game_id, player_id) with other columns at their
            # defaults from the spreadsheet import having created nothing
            # here at all (season 2 never had game_event_stats rows before
            # this script) -- REPLACE is safe and correct either way, but
            # OR IGNORE would be wrong if this script is ever re-run after
            # a partial failure, so REPLACE is deliberate, not a shortcut.
            statements.append(f"INSERT OR REPLACE INTO game_event_stats ({cols}) VALUES ({vals});")

    if unmatched:
        print(f"\nREFUSING TO WRITE -- {len(unmatched)} playgroup.gg game(s) didn't match exactly one D1 game:")
        for u in unmatched:
            print(f"  pg game {u[0]} ({u[1]}, pod {u[2]}, known players {u[3]}) -> {u[4]} candidate(s)")
        raise SystemExit(1)

    leftover = [g for g in d1_games if g["game_id"] not in matched_d1_ids]
    print(f"\nAll {len(pg_games)} playgroup.gg games matched exactly one D1 game.")
    print(f"{len(leftover)} D1 game(s) have no playgroup.gg match (expected: 1, the spreadsheet-only game):")
    for g in leftover:
        print(f"  game_num {g['game_num']} ({g['played_at'].date()}, pod {g['pod_size']}, players {sorted(g['players'])})")

    OUT_SQL.write_text("\n".join(statements) + "\n", encoding="utf-8")
    print(f"\nWrote {len(statements) - 4} statements to {OUT_SQL}")


if __name__ == "__main__":
    main()

"""
Follow-up to enrich_season2_from_playgroup.py, after discovering that
script's premise was wrong: the 24 confirmed Season 2 games do NOT have
empty event logs. That "empty events" reading came from two places that
never actually requested the event log in the first place -- /debug/
games-list has no include_events support at all, and the 24-game fetch
for the matcher hit /debug/game?id=<id> without &events=true. A direct
recheck (?events=true) on one of the 24 found 126 real events.

Real events means the existing computeAndStoreGameEventStats machinery
(built for Season 3's live games) can compute the FULL picture for Season
2 too -- damage, healing, knockouts, self-ratings, pauses, undos, turn
timing, ending life, and starting_player_id -- not just the four fields
enrich_season2_from_playgroup.py pulled from participations. That function
already does a proper INSERT ... ON CONFLICT DO UPDATE covering every
column, so re-running it over these games supersedes (not duplicates)
that script's partial fun/salt/mulligan/win_con writes.

This script only does the linking step: for each of the 24 confirmed
games, write games.playgroup_game_id so POST /achievements/backfill (an
existing endpoint, normally used for newly-logged live games) picks them
up. Reuses enrich_season2_from_playgroup's own matching logic rather than
reimplementing it, so both scripts agree on which pg game is which D1 game.

Usage:
    python scripts/link_season2_playgroup_game_ids.py
Reads the same two JSON inputs as enrich_season2_from_playgroup.py (see
that script's docstring for how to regenerate them), writes
cloudflare-worker/season2_link_playgroup_ids.sql. Review it, then:
    npx wrangler d1 execute mtg-pod-validator-db --remote --file=season2_link_playgroup_ids.sql
Then call POST /achievements/backfill?force=true (repeatedly, until its
`remaining` field is false -- MAX_EVENT_STATS_BACKFILL_PER_RUN caps each
call at 30 games, and this also touches Season 3's already-fine games
since force=true recomputes everything with a playgroup_game_id, not just
these 24 -- harmless and idempotent, just extra work).
"""
from pathlib import Path

from enrich_season2_from_playgroup import load_d1_games, load_pg_games, match_candidates

ROOT = Path(__file__).parent.parent
OUT_SQL = ROOT / "cloudflare-worker" / "season2_link_playgroup_ids.sql"


def main():
    d1_games = load_d1_games()
    pg_games = load_pg_games()

    statements = [
        f"-- Links each of {len(pg_games)} confirmed Season 2 playgroup.gg games to its D1 row,",
        "-- so POST /achievements/backfill picks them up and computes real event stats.",
        "",
    ]
    unmatched = []
    for pg in pg_games:
        candidates, known_here = match_candidates(pg, d1_games)
        if len(candidates) != 1:
            unmatched.append(pg["id"])
            continue
        statements.append(f"UPDATE games SET playgroup_game_id = {pg['id']} WHERE id = {candidates[0]['game_id']};")

    if unmatched:
        raise SystemExit(f"Refusing to write -- {len(unmatched)} unmatched: {unmatched}")

    OUT_SQL.write_text("\n".join(statements) + "\n", encoding="utf-8")
    print(f"Wrote {len(statements) - 3} UPDATE statements to {OUT_SQL}")


if __name__ == "__main__":
    main()

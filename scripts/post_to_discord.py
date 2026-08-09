"""
Posts four Discord messages after a game has been added and the
spreadsheet recalculated: a "Season N - Game M is in the books!"
announcement, then a screenshot each of the player rankings (with a
Trend column -- see compute_rank_trend in discord_report.py), the full
Current Deck Strength tab, and the full Deck Win Rates tab (see
discord_report.py for how those are built).

Before posting, deletes whatever this script posted for the *previous*
game (via discord_last_post.json, same mechanism delete_last_discord_post.py
uses) -- the channel is meant to show only the latest game's numbers, not
accumulate one full set of 4 messages per game forever. For a permanent,
never-deleted record of every game, see post_to_discord_archive.py.

Reads DISCORD_WEBHOOK_URL from the environment -- a GitHub repo secret
(SEASON_STAT_WEBHOOK, wired in via add-game.yml), set the same way as
GITHUB_TOKEN/PLAYGROUP_API_KEY (repo Settings -> Secrets and variables ->
Actions), not something this script or any committed file ever holds a
real value for.

Meant to run right after add_game.py's recalc() succeeds (see
add-game.yml) so every value read here reflects the just-added game.

Usage:
    python scripts/post_to_discord.py
"""
import json
import os
from pathlib import Path

import openpyxl

from discord_common import delete_messages
from discord_report import XLSX_PATH, get_season_and_game_info, post_report

# Message IDs from the most recent post, so delete_last_discord_post.py can
# find and remove them later. Committed alongside deck-strength.xlsx --
# see the "Commit Discord post tracking" step in add-game.yml.
LAST_POST_PATH = Path(__file__).parent.parent / "discord_last_post.json"


def main():
    webhook_url = os.environ["DISCORD_WEBHOOK_URL"]

    # The channel shows only the latest game's numbers -- delete whatever
    # this script posted last time before posting the new set. Silent
    # no-op the first time this runs (no tracking file yet).
    if LAST_POST_PATH.exists():
        previous = json.loads(LAST_POST_PATH.read_text(encoding="utf-8"))
        print(f"Deleting {len(previous['message_ids'])} message(s) from Season {previous['season']} Game {previous['game']}...")
        delete_messages(webhook_url, previous["message_ids"])
        LAST_POST_PATH.unlink()

    wb_formulas = openpyxl.load_workbook(XLSX_PATH, data_only=False)
    wb_values = openpyxl.load_workbook(XLSX_PATH, data_only=True)

    season_num, game_num, subtitle = get_season_and_game_info(wb_values)
    banner = (
        f"\U0001F3B2 **SEASON {season_num} · GAME {game_num} IS IN THE BOOKS!** \U0001F3B2\n"
        f"\U0001F4CA Rankings, deck strength, and win rates below \U0001F447"
    )

    message_ids = post_report(webhook_url, wb_formulas, wb_values, banner, subtitle, show_trend=True)

    LAST_POST_PATH.write_text(
        json.dumps({"season": season_num, "game": game_num, "message_ids": message_ids}, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Posted Season {season_num} Game {game_num} rankings, Current Deck Strength, and Deck Win Rates to Discord.")


if __name__ == "__main__":
    main()

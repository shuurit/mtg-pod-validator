"""
Posts four Discord messages after a game has been added and the
spreadsheet recalculated -- a permanent, never-deleted archive entry for
that game: a "Season N - Game M is now archived" announcement, then a
screenshot each of the player rankings, the full Current Deck Strength
tab, and the full Deck Win Rates tab (see discord_report.py for how those
are built). Same reports as post_to_discord.py, posted to a different
channel, with nothing ever deleted -- for the live, always-latest-game
channel that replaces its previous post, see post_to_discord.py instead.

Reads DISCORD_WEBHOOK_URL from the environment -- a GitHub repo secret
(SEASON_ARCHIVE_WEBHOOK, wired in via add-game.yml), set the same way as
GITHUB_TOKEN/PLAYGROUP_API_KEY (repo Settings -> Secrets and variables ->
Actions), not something this script or any committed file ever holds a
real value for.

Meant to run right after add_game.py's recalc() succeeds (see
add-game.yml) so every value read here reflects the just-added game.

Usage:
    python scripts/post_to_discord_archive.py
"""
import os

import openpyxl

from discord_report import XLSX_PATH, get_season_and_game_info, post_report


def main():
    webhook_url = os.environ["DISCORD_WEBHOOK_URL"]

    wb_formulas = openpyxl.load_workbook(XLSX_PATH, data_only=False)
    wb_values = openpyxl.load_workbook(XLSX_PATH, data_only=True)

    season_num, game_num, subtitle = get_season_and_game_info(wb_values)
    banner = (
        f"🗃️ **SEASON {season_num} · GAME {game_num} IS NOW ARCHIVED** 🗃️\n"
        f"📜 Rankings, deck strength, and win rates preserved for the record below 👇"
    )

    post_report(webhook_url, wb_formulas, wb_values, banner, subtitle)

    print(f"Archived Season {season_num} Game {game_num} rankings, Current Deck Strength, and Deck Win Rates to Discord.")


if __name__ == "__main__":
    main()

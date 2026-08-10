"""
Posts four Discord messages after a game has been added: a "Season N -
Game M is in the books!" announcement, then a screenshot each of the
player rankings (with a Trend column -- see compute_rank_trend in
discord_report.py), Current Deck Strength, and Deck Win Rates (see
discord_report.py for how those are built), all read live from the
relay's D1-backed endpoints.

Before posting, deletes whatever this script posted for the *previous*
game (via discord_last_post.json, same mechanism delete_last_discord_post.py
uses) -- the channel is meant to show only the latest game's numbers, not
accumulate one full set of 4 messages per game forever. For a permanent,
never-deleted record of every game, see post_to_discord_archive.py.

Reads DISCORD_WEBHOOK_URL from the environment -- a GitHub repo secret
(SEASON_STAT_WEBHOOK, wired in via post-discord-live.yml), set the same
way as GITHUB_TOKEN/PLAYGROUP_API_KEY (repo Settings -> Secrets and
variables -> Actions), not something this script or any committed file
ever holds a real value for.

Triggered by relay.js's handleGamesWrite firing a "post-discord"
repository_dispatch right after a successful POST /games write (see
post-discord-live.yml) -- so every value read here reflects the just-
added game moments after it landed in D1.

Usage:
    python scripts/post_to_discord.py
"""
import json
import os
from pathlib import Path

from discord_common import delete_messages
from discord_report import fetch_report_data, get_season_and_game_info, post_report

# Message IDs from the most recent post, so delete_last_discord_post.py can
# find and remove them later. Committed to the repo (small JSON file, no
# XLSX/D1 data of its own) -- see post-discord-live.yml's commit step.
LAST_POST_PATH = Path(__file__).parent.parent / "discord_last_post.json"


def main():
    webhook_url = os.environ["DISCORD_WEBHOOK_URL"]

    # The channel shows only the latest game's numbers -- delete whatever
    # this script posted last time before posting the new set. Silent
    # no-op the first time this runs (no tracking file yet).
    if LAST_POST_PATH.exists():
        previous = json.loads(LAST_POST_PATH.read_text(encoding="utf-8"))
        print(f"Deleting {len(previous['message_ids'])} message(s) from {previous['season']} Game {previous['game']}...")
        delete_messages(webhook_url, previous["message_ids"])
        LAST_POST_PATH.unlink()

    report_data = fetch_report_data()
    season_label, game_num, subtitle = get_season_and_game_info(report_data["season_games"])
    banner = (
        f"\U0001F3B2 **{season_label.upper()} · GAME {game_num} IS IN THE BOOKS!** \U0001F3B2\n"
        f"\U0001F4CA Rankings, deck strength, and win rates below \U0001F447"
    )

    message_ids = post_report(webhook_url, report_data, banner, subtitle, show_trend=True)

    LAST_POST_PATH.write_text(
        json.dumps({"season": season_label, "game": game_num, "message_ids": message_ids}, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Posted {season_label} Game {game_num} rankings, Current Deck Strength, and Deck Win Rates to Discord.")


if __name__ == "__main__":
    main()

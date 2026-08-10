"""
Posts four Discord messages after a game has been added -- a permanent,
never-deleted archive entry for that game: a "Season N - Game M is now
archived" announcement, then a screenshot each of the player rankings,
Current Deck Strength, and Deck Win Rates (see discord_report.py for how
those are built and read from the relay's D1-backed endpoints). Same
reports as post_to_discord.py, posted to a different channel, with
nothing ever deleted -- for the live, always-latest-game channel that
replaces its previous post, see post_to_discord.py instead.

Reads DISCORD_WEBHOOK_URL from the environment -- a GitHub repo secret
(SEASON_ARCHIVE_WEBHOOK, wired in via post-discord-live.yml), set the
same way as GITHUB_TOKEN/PLAYGROUP_API_KEY (repo Settings -> Secrets and
variables -> Actions), not something this script or any committed file
ever holds a real value for.

Triggered by relay.js's handleGamesWrite firing a "post-discord"
repository_dispatch right after a successful POST /games write (see
post-discord-live.yml) -- so every value read here reflects the just-
added game moments after it landed in D1.

Usage:
    python scripts/post_to_discord_archive.py
"""
import os

from discord_report import fetch_report_data, get_season_and_game_info, post_report


def main():
    webhook_url = os.environ["DISCORD_WEBHOOK_URL"]

    report_data = fetch_report_data()
    season_label, game_num, subtitle = get_season_and_game_info(report_data["season_games"])
    banner = (
        f"🗃️ **{season_label.upper()} · GAME {game_num} IS NOW ARCHIVED** 🗃️\n"
        f"📜 Rankings, deck strength, and win rates preserved for the record below 👇"
    )

    post_report(webhook_url, report_data, banner, subtitle)

    print(f"Archived {season_label} Game {game_num} rankings, Current Deck Strength, and Deck Win Rates to Discord.")


if __name__ == "__main__":
    main()

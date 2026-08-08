"""
Deletes the four Discord messages post_to_discord.py posted for the most
recent game (the announcement banner + the three table screenshots), using
the message IDs it saved to discord_last_post.json. A plain webhook can't
list or search channel history -- this only works because post_to_discord.py
captured each message's ID at post time (via ?wait=true) and committed them
to that file, so there's nothing to delete for any post made before that
tracking existed.

Reads DISCORD_WEBHOOK_URL from the environment, same as post_to_discord.py.

Usage:
    python scripts/delete_last_discord_post.py
"""
import json
import os
import time
from pathlib import Path

import requests

LAST_POST_PATH = Path(__file__).parent.parent / "discord_last_post.json"
DISCORD_HEADERS = {"User-Agent": "mtg-pod-validator-discord-bot"}


def main():
    webhook_url = os.environ["DISCORD_WEBHOOK_URL"]

    if not LAST_POST_PATH.exists():
        print("No discord_last_post.json found -- nothing tracked to delete.")
        return

    record = json.loads(LAST_POST_PATH.read_text(encoding="utf-8"))
    message_ids = record.get("message_ids", [])
    if not message_ids:
        print("discord_last_post.json has no message IDs -- nothing to delete.")
        return

    print(f"Deleting {len(message_ids)} message(s) from Season {record.get('season')} Game {record.get('game')}...")
    for message_id in message_ids:
        resp = requests.delete(f"{webhook_url}/messages/{message_id}", headers=DISCORD_HEADERS, timeout=15)
        # 404 means it's already gone (deleted by hand, or by a previous
        # run of this script) -- treat that as success, not a failure.
        if resp.status_code not in (204, 404):
            resp.raise_for_status()
        time.sleep(0.5)

    LAST_POST_PATH.unlink()
    print("Done. Cleared discord_last_post.json.")


if __name__ == "__main__":
    main()

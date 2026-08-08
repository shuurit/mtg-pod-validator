"""
Shared Discord webhook helpers used by post_to_discord.py and
delete_last_discord_post.py.
"""
import time

import requests

# Discord's API sits behind Cloudflare, which 403s the default User-Agent
# -- same issue this project already hit and fixed for the roster-diff
# fetches (see backfill_playgroup_ids.py). Anything normal-looking works.
DISCORD_HEADERS = {"User-Agent": "mtg-pod-validator-discord-bot"}


def delete_messages(webhook_url, message_ids):
    """Deletes each message ID via the webhook's own delete endpoint. A
    404 means it's already gone (deleted by hand, or by an earlier run) --
    treated as success, not a failure."""
    for message_id in message_ids:
        resp = requests.delete(f"{webhook_url}/messages/{message_id}", headers=DISCORD_HEADERS, timeout=15)
        if resp.status_code not in (204, 404):
            resp.raise_for_status()
        time.sleep(0.5)

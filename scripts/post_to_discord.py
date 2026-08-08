"""
Posts three Discord messages after a game has been added and the
spreadsheet recalculated:
  1. Player rankings: Player + Player Adjusted Win Rate (desc), from
     Player Adjusted Ranks.
  2. The full Current Deck Strength tab, all headers except "Baseline
     (used until a game is logged)" and "Playgroup Deck ID" -- the empty
     third column is labeled "Notes".
  3. The full Deck Win Rates tab.

Reads DISCORD_WEBHOOK_URL from the environment -- a GitHub repo secret,
set the same way as GITHUB_TOKEN/PLAYGROUP_API_KEY (repo Settings ->
Secrets and variables -> Actions), not something this script or any
committed file ever holds a real value for.

Meant to run right after add_game.py's recalc() succeeds (see
add-game.yml) so every value read here reflects the just-added game.

Usage:
    python scripts/post_to_discord.py
"""
import json
import os
import time
import urllib.request
from pathlib import Path

import openpyxl

XLSX_PATH = Path(__file__).parent.parent / "deck-strength.xlsx"

# Discord hard-caps message content at 2000 characters. This leaves
# headroom for the ``` fences, the header line, and newlines added when
# chunks get joined -- a message built right up to 2000 has been rejected
# by Discord's API in practice, so the budget is deliberately conservative.
CHUNK_BUDGET = 1850


def post_message(webhook_url, content):
    body = json.dumps({"content": content}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def post_chunks(webhook_url, lines, header):
    """Joins lines into one or more ```-fenced code-block messages, never
    splitting mid-line, staying under Discord's message limit. header is a
    plain, un-fenced line repeated at the top of every chunk this ends up
    split into, so each message is self-describing on its own."""
    chunk = []
    chunk_len = 0

    def flush():
        nonlocal chunk, chunk_len
        if not chunk:
            return
        body = "\n".join(chunk)
        post_message(webhook_url, f"{header}\n```\n{body}\n```")
        time.sleep(0.5)  # stay well clear of the webhook rate limit
        chunk, chunk_len = [], 0

    for line in lines:
        if chunk_len + len(line) + 1 > CHUNK_BUDGET:
            flush()
        chunk.append(line)
        chunk_len += len(line) + 1
    flush()


def format_power(v):
    return f"{v:.1f}" if isinstance(v, (int, float)) else ""


def format_pct(v):
    return f"{v * 100:.2f}%" if isinstance(v, (int, float)) else "--"


def post_player_rankings(webhook_url, wb_values):
    ws = wb_values["Player Adjusted Ranks"]
    rows = []
    for r in range(2, ws.max_row + 1):
        player = ws.cell(row=r, column=1).value
        if player is None:
            continue
        rate = ws.cell(row=r, column=2).value
        rows.append((player, rate if isinstance(rate, (int, float)) else 0))
    rows.sort(key=lambda x: x[1], reverse=True)

    name_width = max((len(p) for p, _ in rows), default=4)
    lines = [
        f"{i + 1:>2}. {player.ljust(name_width)}  {format_pct(rate)}"
        for i, (player, rate) in enumerate(rows)
    ]
    post_chunks(webhook_url, lines, header="**Player Rankings -- Player Adjusted Win Rate**")


def find_cds_header_rows(wb_formulas):
    """Row numbers that are player-header rows in Current Deck Strength,
    detected the same way the rest of this project's scripts do (see
    is_header_row in add_deck.py): a header row's column-B formula is
    AVERAGE(...); a deck row's is IFERROR(LOOKUP(...), D). Deck Win Rates
    is kept in exact row-number lockstep with Current Deck Strength
    (confirmed elsewhere in this project), so this same set of row numbers
    identifies header rows there too -- no separate detection needed.
    """
    ws = wb_formulas["Current Deck Strength"]
    headers = set()
    for r in range(2, ws.max_row + 1):
        v = ws.cell(row=r, column=2).value
        if isinstance(v, str) and v.startswith("=") and "AVERAGE(" in v:
            headers.add(r)
    return headers


def post_current_deck_strength(webhook_url, wb_values, header_rows):
    ws = wb_values["Current Deck Strength"]
    lines = []
    for r in range(2, ws.max_row + 1):
        name = ws.cell(row=r, column=1).value
        if name is None:
            continue
        if r in header_rows:
            lines.append(f"== {name} ==")
            continue
        power = format_power(ws.cell(row=r, column=2).value)
        note = ws.cell(row=r, column=3).value or ""
        line = f"  {name.ljust(45)} {power.rjust(5)}"
        if note:
            line += f"   {note}"
        lines.append(line)
    post_chunks(
        webhook_url, lines,
        header="**Current Deck Strength**  (Decks | Current Deck Strength | Notes)",
    )


def post_deck_win_rates(webhook_url, wb_values, header_rows):
    ws = wb_values["Deck Win Rates"]
    lines = []
    for r in range(2, ws.max_row + 1):
        name = ws.cell(row=r, column=1).value
        if name is None:
            continue
        if r in header_rows:
            lines.append(f"== {name} ==")
            continue
        games = ws.cell(row=r, column=2).value
        wins = ws.cell(row=r, column=3).value
        rate = format_pct(ws.cell(row=r, column=4).value)
        line = f"  {name.ljust(45)} {str(games).rjust(3)}  {str(wins).rjust(3)}  {rate.rjust(7)}"
        lines.append(line)
    post_chunks(
        webhook_url, lines,
        header="**Deck Win Rates**  (Player / Deck | Games Played | Wins | Win Rate)",
    )


def main():
    webhook_url = os.environ["DISCORD_WEBHOOK_URL"]

    wb_formulas = openpyxl.load_workbook(XLSX_PATH, data_only=False)
    wb_values = openpyxl.load_workbook(XLSX_PATH, data_only=True)

    post_player_rankings(webhook_url, wb_values)

    header_rows = find_cds_header_rows(wb_formulas)
    post_current_deck_strength(webhook_url, wb_values, header_rows)
    post_deck_win_rates(webhook_url, wb_values, header_rows)

    print("Posted player rankings, Current Deck Strength, and Deck Win Rates to Discord.")


if __name__ == "__main__":
    main()

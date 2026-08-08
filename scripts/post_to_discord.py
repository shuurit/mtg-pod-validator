"""
Posts four Discord messages after a game has been added and the
spreadsheet recalculated:
  0. A standalone "Season N - Game M is in the books!" announcement.
  1. Player rankings: Player + Player Adjusted Win Rate (desc), from
     Player Adjusted Ranks -- rendered as a table image (a code-block wall
     of text for ~74 rows was unreadable in practice, hence images).
  2. The full Current Deck Strength tab, all headers except "Baseline
     (used until a game is logged)" and "Playgroup Deck ID" -- the empty
     third column is labeled "Notes".
  3. The full Deck Win Rates tab.

Both Current Deck Strength and Deck Win Rates are grouped by player,
matching how the sheet itself is laid out (see find_cds_header_rows).

Reads DISCORD_WEBHOOK_URL from the environment -- a GitHub repo secret,
set the same way as GITHUB_TOKEN/PLAYGROUP_API_KEY (repo Settings ->
Secrets and variables -> Actions), not something this script or any
committed file ever holds a real value for.

Meant to run right after add_game.py's recalc() succeeds (see
add-game.yml) so every value read here reflects the just-added game.

Usage:
    python scripts/post_to_discord.py
"""
import io
import json
import os
import re
import time
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import openpyxl
import requests

from season_config import CURRENT_SEASON_SHEET

XLSX_PATH = Path(__file__).parent.parent / "deck-strength.xlsx"
# Message IDs from the most recent post, so delete_last_discord_post.py can
# find and remove them later. Committed alongside deck-strength.xlsx --
# see the "Commit Discord post tracking" step in add-game.yml.
LAST_POST_PATH = Path(__file__).parent.parent / "discord_last_post.json"

HEADER_BG = "#2b2d31"  # Discord's own dark blurple-gray, so the header reads native
HEADER_FG = "white"
SECTION_BG = "#e7e9ee"
ROW_BG_ALT = "#f6f7f9"
ROW_BG = "white"
BORDER = "#d3d6db"


def format_power(v):
    return f"{v:.1f}" if isinstance(v, (int, float)) else ""


def format_pct(v):
    return f"{v * 100:.2f}%" if isinstance(v, (int, float)) else "--"


def render_table_png(title, col_labels, rows, section_indices, fontsize=10, char_w=0.105):
    """Renders a styled table to PNG bytes. section_indices are row indices
    (0-based into `rows`) that are player-header/divider rows -- shown as a
    shaded, bold, full-width row instead of normal data cells.

    Column widths are sized off the longest actual string in each column
    (header included), not a fixed guessed ratio -- a fixed ratio clipped
    both the "Current Deck Strength" header and long deck/note text in an
    earlier pass. char_w is an empirical inches-per-character estimate for
    this fontsize, tuned by eye against real content, not a real font
    metric."""
    n_cols = len(col_labels)
    col_widths = []
    for j in range(n_cols):
        longest = max([len(str(col_labels[j]))] + [len(str(r[j])) for r in rows])
        col_widths.append(max(0.9, longest * char_w + 0.25))

    n_rows = len(rows) + 1
    fig_h = 0.34 * n_rows + 0.9
    fig_w = sum(col_widths)
    fig, ax = plt.subplots(figsize=(fig_w, fig_h))
    ax.axis("off")
    ax.set_title(title, fontsize=15, fontweight="bold", color="#1a1a1a", pad=14, loc="left", x=0.01)

    table = ax.table(cellText=rows, colLabels=col_labels, cellLoc="left", loc="upper left",
                      colWidths=[w / fig_w for w in col_widths])
    table.auto_set_font_size(False)
    table.set_fontsize(fontsize)
    table.scale(1, 1.55)

    for j in range(n_cols):
        cell = table[0, j]
        cell.set_facecolor(HEADER_BG)
        cell.set_text_props(color=HEADER_FG, fontweight="bold")
        cell.set_edgecolor(BORDER)

    data_row_counter = 0
    for i in range(len(rows)):
        is_section = i in section_indices
        for j in range(n_cols):
            cell = table[i + 1, j]
            cell.set_edgecolor(BORDER)
            if is_section:
                cell.set_facecolor(SECTION_BG)
                cell.set_text_props(fontweight="bold")
            else:
                cell.set_facecolor(ROW_BG_ALT if data_row_counter % 2 else ROW_BG)
        if not is_section:
            data_row_counter += 1

    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=170, bbox_inches="tight", facecolor="white", pad_inches=0.15)
    plt.close(fig)
    buf.seek(0)
    return buf


# Discord's API sits behind Cloudflare, which 403s the default User-Agent
# -- same issue this project already hit and fixed for the roster-diff
# fetches (see backfill_playgroup_ids.py). Anything normal-looking works.
DISCORD_HEADERS = {"User-Agent": "mtg-pod-validator-discord-bot"}


def post_message(webhook_url, content):
    # ?wait=true makes Discord return the created message (id included)
    # instead of an empty 204 -- needed so delete_last_discord_post.py can
    # find these messages again later.
    resp = requests.post(f"{webhook_url}?wait=true", json={"content": content}, headers=DISCORD_HEADERS, timeout=15)
    resp.raise_for_status()
    time.sleep(0.5)  # stay well clear of the webhook rate limit
    return resp.json()["id"]


def post_image(webhook_url, content, image_buf, filename):
    data = {"content": content} if content else {}
    files = {"file": (filename, image_buf, "image/png")}
    resp = requests.post(f"{webhook_url}?wait=true", data=data, files=files, headers=DISCORD_HEADERS, timeout=30)
    resp.raise_for_status()
    time.sleep(0.5)  # stay well clear of the webhook rate limit
    return resp.json()["id"]


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


def build_player_rankings_table(wb_values, subtitle):
    ws = wb_values["Player Adjusted Ranks"]
    ranks = []
    for r in range(2, ws.max_row + 1):
        player = ws.cell(row=r, column=1).value
        if player is None:
            continue
        rate = ws.cell(row=r, column=2).value
        ranks.append((player, rate if isinstance(rate, (int, float)) else 0))
    ranks.sort(key=lambda x: x[1], reverse=True)

    rows = [[str(i + 1), player, format_pct(rate)] for i, (player, rate) in enumerate(ranks)]
    return render_table_png(
        f"Player Rankings — Player Adjusted Win Rate  |  {subtitle}",
        ["#", "Player", "Win Rate"], rows, set(),
    )


def build_current_deck_strength_table(wb_values, header_rows, subtitle):
    ws = wb_values["Current Deck Strength"]
    rows = []
    section_indices = []
    for r in range(2, ws.max_row + 1):
        name = ws.cell(row=r, column=1).value
        if name is None:
            continue
        if r in header_rows:
            section_indices.append(len(rows))
            rows.append([name, "", ""])
            continue
        power = format_power(ws.cell(row=r, column=2).value)
        note = ws.cell(row=r, column=3).value or ""
        rows.append([f"    {name}", power, note])
    return render_table_png(
        f"Current Deck Strength  |  {subtitle}",
        ["Decks", "Current Deck Strength", "Notes"], rows, set(section_indices),
        fontsize=9,
    )


def build_deck_win_rates_table(wb_values, header_rows, subtitle):
    ws = wb_values["Deck Win Rates"]
    rows = []
    section_indices = []
    for r in range(2, ws.max_row + 1):
        name = ws.cell(row=r, column=1).value
        if name is None:
            continue
        if r in header_rows:
            section_indices.append(len(rows))
            rows.append([name, "", "", ""])
            continue
        games = ws.cell(row=r, column=2).value
        wins = ws.cell(row=r, column=3).value
        rate = format_pct(ws.cell(row=r, column=4).value)
        rows.append([f"    {name}", str(games), str(wins), rate])
    return render_table_png(
        f"Deck Win Rates  |  {subtitle}",
        ["Player / Deck", "Games", "Wins", "Win Rate"], rows, set(section_indices),
        fontsize=9,
    )


def main():
    webhook_url = os.environ["DISCORD_WEBHOOK_URL"]

    wb_formulas = openpyxl.load_workbook(XLSX_PATH, data_only=False)
    wb_values = openpyxl.load_workbook(XLSX_PATH, data_only=True)

    season_num = re.search(r"Season (\d+)", CURRENT_SEASON_SHEET).group(1)
    game_log = wb_values[CURRENT_SEASON_SHEET]
    game_num = max(
        (v for r in range(3, game_log.max_row + 1)
         if isinstance(v := game_log.cell(row=r, column=2).value, (int, float))),
        default="?",
    )
    subtitle = f"Season {season_num} · Game {game_num}"
    banner = (
        f"\U0001F3B2 **SEASON {season_num} · GAME {game_num} IS IN THE BOOKS!** \U0001F3B2\n"
        f"\U0001F4CA Rankings, deck strength, and win rates below \U0001F447"
    )

    # Standalone announcement first, then the three screenshots -- not
    # attached as caption text on the first image, so it reads as its own
    # "a game just happened" moment before the stats follow.
    message_ids = [post_message(webhook_url, banner)]

    header_rows = find_cds_header_rows(wb_formulas)

    rankings_png = build_player_rankings_table(wb_values, subtitle)
    message_ids.append(post_image(webhook_url, "", rankings_png, "player_rankings.png"))

    cds_png = build_current_deck_strength_table(wb_values, header_rows, subtitle)
    message_ids.append(post_image(webhook_url, "", cds_png, "current_deck_strength.png"))

    dwr_png = build_deck_win_rates_table(wb_values, header_rows, subtitle)
    message_ids.append(post_image(webhook_url, "", dwr_png, "deck_win_rates.png"))

    LAST_POST_PATH.write_text(
        json.dumps({"season": season_num, "game": game_num, "message_ids": message_ids}, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Posted Season {season_num} Game {game_num} rankings, Current Deck Strength, and Deck Win Rates to Discord.")


if __name__ == "__main__":
    main()

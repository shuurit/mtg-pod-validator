"""
Shared table-rendering and posting logic for post_to_discord.py (live
per-game stats, replaces the previous post) and post_to_discord_archive.py
(a permanent, never-deleted record of every game), so the two only differ
in their webhook, their banner text, and whether they delete anything
first.

Builds three table images from the current deck-strength.xlsx:
  1. Player rankings: Player + Player Adjusted Win Rate (desc), from
     Player Adjusted Ranks -- #1 place highlighted gold.
  2. The full Current Deck Strength tab, all headers except "Baseline
     (used until a game is logged)" and "Playgroup Deck ID" -- the empty
     third column is labeled "Notes".
  3. The full Deck Win Rates tab.

Both Current Deck Strength and Deck Win Rates are grouped by player,
matching how the sheet itself is laid out (see find_cds_header_rows).
"""
import io
import re
import time
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import requests

from discord_common import DISCORD_HEADERS
from season_config import CURRENT_SEASON_SHEET

XLSX_PATH = Path(__file__).parent.parent / "deck-strength.xlsx"

HEADER_BG = "#2b2d31"  # Discord's own dark blurple-gray, so the header reads native
HEADER_FG = "white"
SECTION_BG = "#e7e9ee"
ROW_BG_ALT = "#f6f7f9"
ROW_BG = "white"
BORDER = "#d3d6db"
GOLD_BG = "#ffe083"  # #1 place highlight in the rankings table


def format_power(v):
    return f"{v:.1f}" if isinstance(v, (int, float)) else ""


def format_pct(v):
    return f"{v * 100:.2f}%" if isinstance(v, (int, float)) else "--"


def get_season_and_game_info(wb_values):
    """(season_num, game_num, subtitle) for the current season sheet, e.g.
    ("3", 15, "Season 3 · Game 15")."""
    season_num = re.search(r"Season (\d+)", CURRENT_SEASON_SHEET).group(1)
    game_log = wb_values[CURRENT_SEASON_SHEET]
    game_num = max(
        (v for r in range(3, game_log.max_row + 1)
         if isinstance(v := game_log.cell(row=r, column=2).value, (int, float))),
        default="?",
    )
    return season_num, game_num, f"Season {season_num} · Game {game_num}"


def render_table_png(title, col_labels, rows, section_indices, fontsize=10, char_w=0.105, highlight_indices=frozenset(), cell_text_colors=None):
    """Renders a styled table to PNG bytes. section_indices are row indices
    (0-based into `rows`) that are player-header/divider rows -- shown as a
    shaded, bold, full-width row instead of normal data cells.
    highlight_indices are row indices given a gold background instead of
    the normal alternating one (used for the rankings table's #1 spot) --
    takes priority over the alternating stripe, but a row can't be both a
    section row and a highlighted row.
    cell_text_colors, if given, maps (row_index, col_index) -- both
    0-based into `rows`/`col_labels` -- to a text color for just that
    cell, layered on top of whatever background/weight the row already
    got (used for the rankings table's up/down trend arrows).

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
        is_highlight = i in highlight_indices and not is_section
        for j in range(n_cols):
            cell = table[i + 1, j]
            cell.set_edgecolor(BORDER)
            if is_section:
                cell.set_facecolor(SECTION_BG)
                cell.set_text_props(fontweight="bold")
            elif is_highlight:
                cell.set_facecolor(GOLD_BG)
                cell.set_text_props(fontweight="bold")
            else:
                cell.set_facecolor(ROW_BG_ALT if data_row_counter % 2 else ROW_BG)
            if cell_text_colors and (i, j) in cell_text_colors:
                cell.set_text_props(color=cell_text_colors[(i, j)], fontweight="bold")
        if not is_section:
            data_row_counter += 1

    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=170, bbox_inches="tight", facecolor="white", pad_inches=0.15)
    plt.close(fig)
    buf.seek(0)
    return buf


def post_message(webhook_url, content):
    # ?wait=true makes Discord return the created message (id included)
    # instead of an empty 204 -- needed by callers that track posted
    # message IDs (see post_to_discord.py / delete_last_discord_post.py).
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


TREND_UP = "▲"
TREND_DOWN = "▼"
TREND_STEADY = "–"
TREND_UP_COLOR = "#1a7f37"
TREND_DOWN_COLOR = "#d1242f"
TREND_STEADY_COLOR = "#6e7771"


def compute_player_rankings(wb_values):
    """[(player, win_rate), ...], sorted by win_rate descending. Reads the
    already-computed Player Adjusted Ranks tab directly -- exact by
    construction, no need to re-derive it."""
    ws = wb_values["Player Adjusted Ranks"]
    ranks = []
    for r in range(2, ws.max_row + 1):
        player = ws.cell(row=r, column=1).value
        if player is None:
            continue
        rate = ws.cell(row=r, column=2).value
        ranks.append((player, rate if isinstance(rate, (int, float)) else 0))
    ranks.sort(key=lambda x: x[1], reverse=True)
    return ranks


def compute_pawr_from_rows(player_rows):
    """Player Adjusted Win Rate computed directly from a list of that
    player's Game Log rows ({result, J, K, M}) -- a Python port of the
    Player Adjusted Ranks B column formula (see that sheet's B2/F2-L2),
    used to answer "what would the rankings have been without the latest
    game" since there's no sheet tab that stores a prior game's snapshot.
    Verified to reproduce the sheet's own cached values exactly when given
    every row for a player (not just a subset)."""
    wins = [r for r in player_rows if r["result"] == 1]
    losses = [r for r in player_rows if r["result"] == 0]
    C, D = len(wins), len(losses)
    F = sum(r["J"] for r in wins)
    avg_j_losses = sum(r["J"] for r in losses) / len(losses) if losses else None
    G = (1 - (avg_j_losses * -1)) * D if avg_j_losses is not None else 0
    H = F / (F + G) if (F + G) != 0 else 0
    I = (sum(r["K"] for r in player_rows) / len(player_rows)) if C != 0 and player_rows else 0
    avg_m_wins = sum(r["M"] for r in wins) / len(wins) if wins else None
    Jv = (1 - (avg_m_wins - 0.5)) * C if avg_m_wins is not None else 0
    avg_m_losses = sum(r["M"] for r in losses) / len(losses) if losses else None
    Kv = (1 + (avg_m_losses - 0.5)) * D if avg_m_losses is not None else 0
    L = Jv / (Jv + Kv) if (Jv + Kv) != 0 else 0
    return (H * 0.3) + (I * 0.2) + (L * 0.5)


def assign_ranks(ranked_list):
    """{player: rank} from a list already sorted descending by rate, with
    tied rates getting the same rank (competition-style: 1,1,3, not
    1,2,3) -- otherwise players who've never played (all tied at 0) would
    show spurious up/down movement purely from sort tie-breaking order."""
    ranks = {}
    for i, (player, rate) in enumerate(ranked_list):
        if i > 0 and abs(rate - ranked_list[i - 1][1]) < 1e-9:
            ranks[player] = ranks[ranked_list[i - 1][0]]
        else:
            ranks[player] = i + 1
    return ranks


def compute_rank_trend(wb_values, log_rows):
    """{player: 'up'/'down'/'steady'} -- whether each player's position in
    the rankings moved compared to standings without the most recent game.
    Rank-based (did someone get passed / pass someone), not raw score
    movement: this is a leaderboard table, and a player's raw Player
    Adjusted Win Rate can move for reasons (deck-strength-adjusted
    probabilities, pod-size weighting) that don't read as "better/worse"
    at a glance the way "moved up the leaderboard" does."""
    if not log_rows:
        return {}
    max_game = max(r["game"] for r in log_rows)

    current_ranks = assign_ranks(compute_player_rankings(wb_values))

    players = sorted(set(r["player"] for r in log_rows))
    previous_ranked = sorted(
        ((p, compute_pawr_from_rows([r for r in log_rows if r["player"] == p and r["game"] != max_game]))
         for p in players),
        key=lambda x: -x[1],
    )
    previous_ranks = assign_ranks(previous_ranked)

    trend = {}
    for p in players:
        if current_ranks[p] < previous_ranks[p]:
            trend[p] = "up"
        elif current_ranks[p] > previous_ranks[p]:
            trend[p] = "down"
        else:
            trend[p] = "steady"
    return trend


def read_game_log_rows_for_pawr(wb_values):
    """[{game, player, result, J, K, M}, ...] for every Game Log row --
    the raw inputs compute_pawr_from_rows/compute_rank_trend need."""
    ws = wb_values[CURRENT_SEASON_SHEET]
    rows = []
    for r in range(3, ws.max_row + 1):
        player = ws.cell(row=r, column=3).value
        if player is None:
            continue
        rows.append({
            "game": ws.cell(row=r, column=2).value,
            "player": player,
            "result": ws.cell(row=r, column=6).value,
            "J": ws.cell(row=r, column=10).value,
            "K": ws.cell(row=r, column=11).value,
            "M": ws.cell(row=r, column=13).value,
        })
    return rows


def build_player_rankings_table(wb_values, subtitle, show_trend=False):
    """show_trend adds a Trend column (▲/▼/–, colored) showing whether
    each player's rank moved compared to standings without the most
    recent game -- see compute_rank_trend."""
    ranks = compute_player_rankings(wb_values)

    if not show_trend:
        rows = [[str(i + 1), player, format_pct(rate)] for i, (player, rate) in enumerate(ranks)]
        return render_table_png(
            f"Player Rankings — Player Adjusted Win Rate  |  {subtitle}",
            ["#", "Player", "Win Rate"], rows, set(),
            highlight_indices={0} if rows else set(),
        )

    log_rows = read_game_log_rows_for_pawr(wb_values)
    trend_by_player = compute_rank_trend(wb_values, log_rows)
    trend_symbol = {"up": TREND_UP, "down": TREND_DOWN, "steady": TREND_STEADY}
    trend_color = {"up": TREND_UP_COLOR, "down": TREND_DOWN_COLOR, "steady": TREND_STEADY_COLOR}

    rows = []
    cell_text_colors = {}
    for i, (player, rate) in enumerate(ranks):
        direction = trend_by_player.get(player)
        trend = trend_symbol.get(direction, "")
        if direction:
            cell_text_colors[(i, 3)] = trend_color[direction]
        rows.append([str(i + 1), player, format_pct(rate), trend])

    return render_table_png(
        f"Player Rankings — Player Adjusted Win Rate  |  {subtitle}",
        ["#", "Player", "Win Rate", "Trend"], rows, set(),
        highlight_indices={0} if rows else set(),
        cell_text_colors=cell_text_colors,
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


def post_report(webhook_url, wb_formulas, wb_values, banner, subtitle, show_trend=False):
    """Posts the standalone banner, then the three table screenshots, in
    order. Returns the four message IDs, in post order. show_trend is
    forwarded to build_player_rankings_table -- see there for what it does."""
    message_ids = [post_message(webhook_url, banner)]

    header_rows = find_cds_header_rows(wb_formulas)

    rankings_png = build_player_rankings_table(wb_values, subtitle, show_trend)
    message_ids.append(post_image(webhook_url, "", rankings_png, "player_rankings.png"))

    cds_png = build_current_deck_strength_table(wb_values, header_rows, subtitle)
    message_ids.append(post_image(webhook_url, "", cds_png, "current_deck_strength.png"))

    dwr_png = build_deck_win_rates_table(wb_values, header_rows, subtitle)
    message_ids.append(post_image(webhook_url, "", dwr_png, "deck_win_rates.png"))

    return message_ids

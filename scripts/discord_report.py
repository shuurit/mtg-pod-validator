"""
Shared table-rendering and posting logic for post_to_discord.py (live
per-game stats, replaces the previous post) and post_to_discord_archive.py
(a permanent, never-deleted record of every game), so the two only differ
in their webhook, their banner text, and whether they delete anything
first.

Builds three table images from the relay's D1-backed read endpoints
(GET /players, /games, /deck-win-rates -- see cloudflare-worker/relay.js):
  1. Player rankings: Player + Player Adjusted Win Rate (desc), computed
     from this season's game_results the same way the old spreadsheet's
     Player Adjusted Ranks tab did (see compute_pawr_from_rows) --
     #1 place highlighted gold.
  2. Current Deck Strength: every player's decks and current power.
  3. Deck Win Rates: every player's decks, games/wins/win rate.

Both are grouped by player, one player-header row followed by their deck
rows, matching how the old sheet was laid out.
"""
import io
import time

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import requests

from discord_common import DISCORD_HEADERS

RELAY_BASE_URL = "https://mtg-pod-validator-relay.mattdomi18.workers.dev"
PLAYERS_URL = f"{RELAY_BASE_URL}/players"
GAMES_URL = f"{RELAY_BASE_URL}/games"
DECK_WIN_RATES_URL = f"{RELAY_BASE_URL}/deck-win-rates"

# Excluded from every table image posted to Discord -- Kristy and Joseph
# have gone inactive and will drop off the roster soon. Filtered here
# rather than at the relay, since GET /players etc. still need to return
# everyone for the app's own UI and D1 write paths; this only affects what
# shows up in the screenshots posted to Discord.
EXCLUDED_FROM_REPORTS = {"Kristy", "Joseph"}

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


def fetch_json(url):
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return resp.json()


def current_season_games(all_games):
    """Rows (one per player per game) from GET /games belonging to the
    most-recently-created season -- same "current season" scope app.js's
    gameLogRowsFromD1 already established (Player Adjusted Ranks has
    always been one-season-at-a-time, never combined across seasons, even
    though GET /games itself returns every season's history)."""
    if not all_games:
        return []
    current_season_id = max(g["seasonId"] for g in all_games)
    return [g for g in all_games if g["seasonId"] == current_season_id]


def to_pawr_rows(season_games):
    """[{game, player, result, J, K, M}, ...] -- the compact shape
    compute_pawr_from_rows/compute_rank_trend need, mapped from GET
    /games' field names. 'game' is the season-scoped game number
    (gameNum), matching the old Game Log's 'Game #' column -- unique
    within one season, all compute_rank_trend needs to tell games apart."""
    return [
        {"game": g["gameNum"], "player": g["player"], "result": g["result"],
         "J": g["adjustedPodSizeScore"], "K": g["knockoutScore"], "M": g["winProbability"]}
        for g in season_games
    ]


def fetch_report_data():
    """Fetches everything post_report needs from the relay in one place,
    so post_to_discord.py/post_to_discord_archive.py don't each need
    their own copy of this wiring."""
    players_data = fetch_json(PLAYERS_URL)
    games_data = fetch_json(GAMES_URL)
    deck_win_rates_data = fetch_json(DECK_WIN_RATES_URL)

    all_players = [p for p in players_data["players"] if p["name"] not in EXCLUDED_FROM_REPORTS]
    all_player_names = [p["name"] for p in all_players]
    deck_win_rates_data = {
        **deck_win_rates_data,
        "players": [p for p in deck_win_rates_data["players"] if p["player"] not in EXCLUDED_FROM_REPORTS],
    }
    season_games = current_season_games(games_data["games"])
    if not season_games:
        raise RuntimeError("No games logged yet in the current season -- nothing to report.")
    log_rows = [r for r in to_pawr_rows(season_games) if r["player"] not in EXCLUDED_FROM_REPORTS]

    return {
        "all_players": all_players,
        "all_player_names": all_player_names,
        "deck_win_rates": deck_win_rates_data,
        "season_games": season_games,
        "log_rows": log_rows,
    }


def get_season_and_game_info(season_games):
    """(season_label, game_num, subtitle) for the current season, e.g.
    ("Amass a Gathering Season 3", 17, "Amass a Gathering Season 3 · Game 17")."""
    season_label = season_games[0]["seasonLabel"]
    game_num = max(g["gameNum"] for g in season_games)
    return season_label, game_num, f"{season_label} · Game {game_num}"


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


TREND_UP = "▲"
TREND_DOWN = "▼"
TREND_STEADY = "–"
TREND_UP_COLOR = "#1a7f37"
TREND_DOWN_COLOR = "#d1242f"
TREND_STEADY_COLOR = "#6e7771"


def compute_pawr_from_rows(player_rows):
    """Player Adjusted Win Rate computed directly from a list of that
    player's Game Log rows ({result, J, K, M}) -- a Python port of the
    Player Adjusted Ranks B column formula (see that sheet's B2/F2-L2),
    verified to reproduce the sheet's own cached values exactly when
    given every row for a player (not just a subset). Now the only
    place this project computes it in Python -- discord_report.py used
    to read it back pre-computed from the sheet; there's no D1 table
    that stores it, only the per-game inputs it's derived from."""
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


def compute_player_rankings(all_player_names, log_rows):
    """[(player, win_rate), ...], sorted descending, one row per name in
    all_player_names -- including anyone with zero games logged this
    season (Player Adjusted Ranks always showed every roster player, 0%
    for anyone with nothing logged yet -- confirmed by direct inspection
    of the live sheet before this cutover: Kristy/Joseph/Red all had
    rows despite zero or few games)."""
    by_player = {}
    for r in log_rows:
        by_player.setdefault(r["player"], []).append(r)
    ranks = [(name, compute_pawr_from_rows(by_player.get(name, []))) for name in all_player_names]
    ranks.sort(key=lambda x: x[1], reverse=True)
    return ranks


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


def compute_rank_trend(all_player_names, log_rows):
    """{player: 'up'/'down'/'steady'} for every player with at least one
    game already logged this season (nothing to compare for someone with
    zero games) -- whether their position in the rankings moved compared
    to standings without the most recent game. Rank-based (did someone
    get passed / pass someone), not raw score movement: this is a
    leaderboard table, and a player's raw Player Adjusted Win Rate can
    move for reasons (deck-strength-adjusted probabilities, pod-size
    weighting) that don't read as "better/worse" at a glance the way
    "moved up the leaderboard" does."""
    if not log_rows:
        return {}
    max_game = max(r["game"] for r in log_rows)

    current_ranks = assign_ranks(compute_player_rankings(all_player_names, log_rows))

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


def build_player_rankings_table(all_player_names, log_rows, subtitle, show_trend=False):
    """show_trend adds a Trend column (▲/▼/–, colored) showing whether
    each player's rank moved compared to standings without the most
    recent game -- see compute_rank_trend."""
    ranks = compute_player_rankings(all_player_names, log_rows)

    if not show_trend:
        rows = [[str(i + 1), player, format_pct(rate)] for i, (player, rate) in enumerate(ranks)]
        return render_table_png(
            f"Player Rankings — Player Adjusted Win Rate  |  {subtitle}",
            ["#", "Player", "Win Rate"], rows, set(),
            highlight_indices={0} if rows else set(),
        )

    trend_by_player = compute_rank_trend(all_player_names, log_rows)
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


def build_current_deck_strength_table(all_players, subtitle):
    """all_players is GET /players' players list -- every player+deck in
    the roster, tracked or not, same scope the old spreadsheet's Current
    Deck Strength tab always had. Its third "Notes" column held free-text
    bracket notes (e.g. "*Bracket 3") that the one-time move to D1
    deliberately never carried over (no clean field to migrate into) --
    always blank here now."""
    rows = []
    section_indices = []
    for player in all_players:
        section_indices.append(len(rows))
        rows.append([player["name"], "", ""])
        for deck in player["decks"]:
            rows.append([f"    {deck['name']}", format_power(deck["power"]), ""])
    return render_table_png(
        f"Current Deck Strength  |  {subtitle}",
        ["Decks", "Current Deck Strength", "Notes"], rows, set(section_indices),
        fontsize=9,
    )


def build_deck_win_rates_table(deck_win_rates_data, subtitle):
    """deck_win_rates_data is GET /deck-win-rates' response -- already
    grouped by player and computed server-side, no local aggregation
    needed."""
    rows = []
    section_indices = []
    for player in deck_win_rates_data["players"]:
        section_indices.append(len(rows))
        rows.append([player["player"], "", "", ""])
        for deck in player["decks"]:
            rows.append([f"    {deck['deck']}", str(deck["gamesPlayed"]), str(deck["wins"]), format_pct(deck["winRate"])])
    return render_table_png(
        f"Deck Win Rates  |  {subtitle}",
        ["Player / Deck", "Games", "Wins", "Win Rate"], rows, set(section_indices),
        fontsize=9,
    )


def post_report(webhook_url, report_data, banner, subtitle, show_trend=False):
    """Posts the standalone banner, then the three table screenshots, in
    order. Returns the four message IDs, in post order. show_trend is
    forwarded to build_player_rankings_table -- see there for what it does."""
    message_ids = [post_message(webhook_url, banner)]

    rankings_png = build_player_rankings_table(report_data["all_player_names"], report_data["log_rows"], subtitle, show_trend)
    message_ids.append(post_image(webhook_url, "", rankings_png, "player_rankings.png"))

    cds_png = build_current_deck_strength_table(report_data["all_players"], subtitle)
    message_ids.append(post_image(webhook_url, "", cds_png, "current_deck_strength.png"))

    dwr_png = build_deck_win_rates_table(report_data["deck_win_rates"], subtitle)
    message_ids.append(post_image(webhook_url, "", dwr_png, "deck_win_rates.png"))

    return message_ids

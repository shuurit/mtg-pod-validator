"""
Adds a new player to deck-strength.xlsx: a new block in both Current Deck
Strength and Deck Win Rates (both share the same row-per-player-then-decks
layout, so they're extended together). Appends at the end of each sheet --
safe, since nothing else needs to shift.

Usage (manual/local testing only -- the automated "Update the App" pipeline
calls append_to_sheet/cds_rows_xml/dwr_rows_xml directly from
apply_roster_update.py, never this CLI entry point):
    python scripts/add_player.py '{"player": "Alex", "decks": [["Krenko, Mob Boss", 3.2, 744135], ["Meren of Clan Nel Toth", 2.8, null]]}'

Each deck is `[name, power, playgroup_deck_id]` -- the ID is optional (use
null, or omit the third element entirely) for decks with no playgroup.gg
account behind them. The power is a starting baseline -- Current Deck
Strength will switch to using each deck's latest Game Calculated Deck
Strength automatically once games get logged for it (falls back to this
baseline until then).

Style IDs (the s="N" on each cell) are read from an existing player row (2)
and deck row (3) at runtime rather than hardcoded -- LibreOffice renumbers
the whole cellXfs table on every save, so a fixed constant from one point
in time silently goes stale the next time the file is recalculated.

This only edits the spreadsheet. Two more steps to actually make the
player show up in the app:
  1. Add their playgroup.gg username to cloudflare-worker/relay.js's
     USERNAME_TO_PLAYER and redeploy the Worker (see that folder's README).
  2. Commit + push, then trigger the "Recalculate Spreadsheet" GitHub
     Actions workflow (workflow_dispatch) so real cached formula values
     replace the starting-baseline placeholders this script writes.
"""
import json
import re
import shutil
import sys
import zipfile

from add_deck import row_styles
from season_config import CURRENT_SEASON_SHEET, XLSX_PATH

CDS_SHEET_FILE = "xl/worksheets/sheet4.xml"  # Current Deck Strength
DWR_SHEET_FILE = "xl/worksheets/sheet5.xml"  # Deck Win Rates
LOG_SHEET = CURRENT_SEASON_SHEET
LOG_MAX_ROW = 1000


def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fmt_num(v):
    if isinstance(v, int) or (isinstance(v, float) and float(v).is_integer()):
        return repr(int(v))
    return repr(float(v))


def normalize_decks(raw_decks):
    """Accepts [name, power] or [name, power, playgroup_deck_id]."""
    decks = []
    for d in raw_decks:
        name, power = d[0], d[1]
        deck_id = d[2] if len(d) > 2 else None
        decks.append((name, power, deck_id))
    return decks


def last_row_of(sheet_xml):
    rows = [int(m) for m in re.findall(r'<row r="(\d+)"', sheet_xml)]
    return max(rows)


def existing_player_names(sheet_xml, shared_strings_unused=None):
    """Player header rows are identified the same way is_header_row does in
    add_deck.py: an AVERAGE( formula in column B."""
    names = []
    for m in re.finditer(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet_xml, re.DOTALL):
        row_num, inner = int(m.group(1)), m.group(2)
        if row_num == 1 or "AVERAGE(" not in inner:
            continue
        text_m = re.search(r'<is><t[^>]*>(.*?)</t></is>', inner, re.DOTALL)
        if text_m:
            names.append(text_m.group(1))
    return names


def cds_rows_xml(player, decks, start_row, player_style, deck_style):
    end_row = start_row + len(decks)
    header = (
        f'<row r="{start_row}" spans="1:5">'
        f'<c r="A{start_row}" s="{player_style["A"]}" t="inlineStr"><is><t>{xml_escape(player)}</t></is></c>'
        f'<c r="B{start_row}" s="{player_style["B"]}"><f>AVERAGE(B{start_row + 1}:B{end_row})</f>'
        f'<v>{fmt_num(sum(p for _, p, _ in decks) / len(decks))}</v></c>'
        f'<c r="C{start_row}" s="{player_style["C"]}"/>'
        f'</row>'
    )
    parts = [header]
    for i, (deck_name, power, deck_id) in enumerate(decks):
        r = start_row + 1 + i
        formula = (
            f"IFERROR(LOOKUP(2,1/(('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW}=\"{player}\")"
            f"*('{LOG_SHEET}'!$D$3:$D${LOG_MAX_ROW}=A{r})"
            f"*('{LOG_SHEET}'!$X$3:$X${LOG_MAX_ROW}<>\"\")),"
            f"'{LOG_SHEET}'!$X$3:$X${LOG_MAX_ROW}), D{r})"
        )
        e_cell = (
            f'<c r="E{r}" s="{deck_style["E"]}" t="inlineStr"><is><t>{xml_escape(str(deck_id))}</t></is></c>'
            if deck_id else f'<c r="E{r}" s="{deck_style["E"]}"/>'
        )
        parts.append(
            f'<row r="{r}" spans="1:5">'
            f'<c r="A{r}" s="{deck_style["A"]}" t="inlineStr"><is><t>{xml_escape(deck_name)}</t></is></c>'
            f'<c r="B{r}" s="{deck_style["B"]}"><f>{xml_escape(formula)}</f><v>{fmt_num(power)}</v></c>'
            f'<c r="C{r}" s="{deck_style["C"]}"/>'
            f'<c r="D{r}" s="{deck_style["D"]}"><v>{fmt_num(power)}</v></c>'
            f'{e_cell}'
            f'</row>'
        )
    return "".join(parts), end_row


def dwr_rows_xml(player, decks, start_row, player_style, deck_style):
    end_row = start_row + len(decks)
    b_formula = f"COUNTIFS('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW},A{start_row})"
    c_formula = (
        f"COUNTIFS('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW},A{start_row},"
        f"'{LOG_SHEET}'!$F$3:$F${LOG_MAX_ROW},1)"
    )
    d_formula = f"IFERROR(C{start_row}/B{start_row},0)"
    header = (
        f'<row r="{start_row}" spans="1:4">'
        f'<c r="A{start_row}" s="{player_style["A"]}" t="inlineStr"><is><t>{xml_escape(player)}</t></is></c>'
        f'<c r="B{start_row}" s="{player_style["B"]}"><f>{xml_escape(b_formula)}</f><v>0</v></c>'
        f'<c r="C{start_row}" s="{player_style["C"]}"><f>{xml_escape(c_formula)}</f><v>0</v></c>'
        f'<c r="D{start_row}" s="{player_style["D"]}"><f>{xml_escape(d_formula)}</f><v>0</v></c>'
        f'</row>'
    )
    parts = [header]
    for i, (deck_name, _power, _deck_id) in enumerate(decks):
        r = start_row + 1 + i
        b_formula = (
            f"COUNTIFS('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW},\"{player}\","
            f"'{LOG_SHEET}'!$D$3:$D${LOG_MAX_ROW},A{r})"
        )
        c_formula = (
            f"COUNTIFS('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW},\"{player}\","
            f"'{LOG_SHEET}'!$D$3:$D${LOG_MAX_ROW},A{r},"
            f"'{LOG_SHEET}'!$F$3:$F${LOG_MAX_ROW},1)"
        )
        d_formula = f"IFERROR(C{r}/B{r},0)"
        parts.append(
            f'<row r="{r}" spans="1:4">'
            f'<c r="A{r}" s="{deck_style["A"]}" t="inlineStr"><is><t>{xml_escape(deck_name)}</t></is></c>'
            f'<c r="B{r}" s="{deck_style["B"]}"><f>{xml_escape(b_formula)}</f><v>0</v></c>'
            f'<c r="C{r}" s="{deck_style["C"]}"><f>{xml_escape(c_formula)}</f><v>0</v></c>'
            f'<c r="D{r}" s="{deck_style["D"]}"><f>{xml_escape(d_formula)}</f><v>0</v></c>'
            f'</row>'
        )
    return "".join(parts), end_row


def append_to_sheet(sheet_xml, new_rows_xml, new_last_row, last_col):
    sheet_xml = re.sub(r'<dimension ref="A1:[A-Z]\d+"/>', f'<dimension ref="A1:{last_col}{new_last_row}"/>', sheet_xml)
    sheet_xml = sheet_xml.replace("</sheetData>", new_rows_xml + "</sheetData>")
    return sheet_xml


def main():
    payload = json.loads(sys.argv[1])
    player = payload["player"]
    decks = normalize_decks(payload["decks"])
    if not player or not decks:
        raise ValueError('payload needs a non-empty "player" and non-empty "decks"')

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    cds_xml = contents[CDS_SHEET_FILE].decode("utf-8")
    dwr_xml = contents[DWR_SHEET_FILE].decode("utf-8")

    existing = existing_player_names(cds_xml)
    if player in existing:
        raise ValueError(f'Player "{player}" already exists in Current Deck Strength -- use add_deck.py instead.')

    cds_start = last_row_of(cds_xml) + 1
    dwr_start = last_row_of(dwr_xml) + 1
    if cds_start != dwr_start:
        raise RuntimeError(
            f"Current Deck Strength (next row {cds_start}) and Deck Win Rates "
            f"(next row {dwr_start}) are out of sync -- fix that before appending."
        )

    cds_player_style = row_styles(cds_xml, 2, "ABC")
    cds_deck_style = row_styles(cds_xml, 3, "ABCDE")
    dwr_player_style = row_styles(dwr_xml, 2, "ABCD")
    dwr_deck_style = row_styles(dwr_xml, 3, "ABCD")

    cds_rows, cds_end = cds_rows_xml(player, decks, cds_start, cds_player_style, cds_deck_style)
    dwr_rows, dwr_end = dwr_rows_xml(player, decks, dwr_start, dwr_player_style, dwr_deck_style)

    contents[CDS_SHEET_FILE] = append_to_sheet(cds_xml, cds_rows, cds_end, "E").encode("utf-8")
    contents[DWR_SHEET_FILE] = append_to_sheet(dwr_xml, dwr_rows, dwr_end, "D").encode("utf-8")

    tmp_path = str(XLSX_PATH) + ".tmp"
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zout.writestr(i, contents[i.filename])
    shutil.move(tmp_path, XLSX_PATH)

    print(f"Added {player} with {len(decks)} deck(s) at rows {cds_start}-{cds_end}.")
    print("Next steps:")
    print("  1. Add their playgroup.gg username to cloudflare-worker/relay.js's USERNAME_TO_PLAYER and redeploy.")
    print('  2. Commit + push, then trigger the "Recalculate Spreadsheet" GitHub Actions workflow.')


if __name__ == "__main__":
    main()

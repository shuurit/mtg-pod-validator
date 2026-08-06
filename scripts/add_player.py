"""
Adds a new player to deck-strength.xlsx: a new block in both Current Deck
Strength and Deck Win Rates (both share the same row-per-player-then-decks
layout, so they're extended together). Appends at the end of each sheet --
safe, since nothing else needs to shift.

Usage:
    python scripts/add_player.py '{"player": "Alex", "decks": [["Krenko, Mob Boss", 3.2], ["Meren of Clan Nel Toth", 2.8]]}'

The "decks" powers are a starting baseline -- Current Deck Strength will
switch to using each deck's latest Game Calculated Deck Strength
automatically once games get logged for it (falls back to this baseline
until then).

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
from pathlib import Path

from season_config import CURRENT_SEASON_SHEET

XLSX_PATH = Path(__file__).parent.parent / "deck-strength.xlsx"
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


def last_row_of(sheet_xml):
    rows = [int(m) for m in re.findall(r'<row r="(\d+)"', sheet_xml)]
    return max(rows)


def row_styles(sheet_xml, rownum, columns):
    """{'A': style_id, 'B': style_id, ...} for an existing row, used as a template."""
    m = re.search(rf'<row r="{rownum}"[^>]*>(.*?)</row>', sheet_xml, re.DOTALL)
    if not m:
        raise RuntimeError(f"row {rownum} not found -- can't read style template")
    styles = {}
    for col in columns:
        cm = re.search(rf'<c r="{col}{rownum}" s="(\d+)"', m.group(1))
        if not cm:
            raise RuntimeError(f"cell {col}{rownum} not found -- can't read style template")
        styles[col] = cm.group(1)
    return styles


def cds_rows_xml(player, decks, start_row, player_style, deck_style):
    end_row = start_row + len(decks)
    header = (
        f'<row r="{start_row}" spans="1:4">'
        f'<c r="A{start_row}" s="{player_style["A"]}" t="inlineStr"><is><t>{xml_escape(player)}</t></is></c>'
        f'<c r="B{start_row}" s="{player_style["B"]}"><f>AVERAGE(B{start_row + 1}:B{end_row})</f>'
        f'<v>{fmt_num(sum(p for _, p in decks) / len(decks))}</v></c>'
        f'<c r="C{start_row}" s="{player_style["C"]}"/>'
        f'</row>'
    )
    parts = [header]
    for i, (deck_name, power) in enumerate(decks):
        r = start_row + 1 + i
        formula = (
            f"IFERROR(LOOKUP(2,1/(('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW}=\"{player}\")"
            f"*('{LOG_SHEET}'!$D$3:$D${LOG_MAX_ROW}=A{r})"
            f"*('{LOG_SHEET}'!$X$3:$X${LOG_MAX_ROW}<>\"\")),"
            f"'{LOG_SHEET}'!$X$3:$X${LOG_MAX_ROW}), D{r})"
        )
        parts.append(
            f'<row r="{r}" spans="1:4">'
            f'<c r="A{r}" s="{deck_style["A"]}" t="inlineStr"><is><t>{xml_escape(deck_name)}</t></is></c>'
            f'<c r="B{r}" s="{deck_style["B"]}"><f>{xml_escape(formula)}</f><v>{fmt_num(power)}</v></c>'
            f'<c r="C{r}" s="{deck_style["C"]}"/>'
            f'<c r="D{r}" s="{deck_style["D"]}"><v>{fmt_num(power)}</v></c>'
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
    for i, (deck_name, _power) in enumerate(decks):
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


def append_to_sheet(sheet_xml, new_rows_xml, new_last_row):
    sheet_xml = re.sub(r'<dimension ref="A1:D\d+"/>', f'<dimension ref="A1:D{new_last_row}"/>', sheet_xml)
    sheet_xml = sheet_xml.replace("</sheetData>", new_rows_xml + "</sheetData>")
    return sheet_xml


def main():
    payload = json.loads(sys.argv[1])
    player = payload["player"]
    decks = payload["decks"]
    if not player or not decks:
        raise ValueError('payload needs a non-empty "player" and non-empty "decks"')

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    cds_xml = contents[CDS_SHEET_FILE].decode("utf-8")
    dwr_xml = contents[DWR_SHEET_FILE].decode("utf-8")

    cds_start = last_row_of(cds_xml) + 1
    dwr_start = last_row_of(dwr_xml) + 1
    if cds_start != dwr_start:
        raise RuntimeError(
            f"Current Deck Strength (next row {cds_start}) and Deck Win Rates "
            f"(next row {dwr_start}) are out of sync -- fix that before appending."
        )

    cds_player_style = row_styles(cds_xml, 2, "ABC")
    cds_deck_style = row_styles(cds_xml, 3, "ABCD")
    dwr_player_style = row_styles(dwr_xml, 2, "ABCD")
    dwr_deck_style = row_styles(dwr_xml, 3, "ABCD")

    cds_rows, cds_end = cds_rows_xml(player, decks, cds_start, cds_player_style, cds_deck_style)
    dwr_rows, dwr_end = dwr_rows_xml(player, decks, dwr_start, dwr_player_style, dwr_deck_style)

    contents[CDS_SHEET_FILE] = append_to_sheet(cds_xml, cds_rows, cds_end).encode("utf-8")
    contents[DWR_SHEET_FILE] = append_to_sheet(dwr_xml, dwr_rows, dwr_end).encode("utf-8")

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

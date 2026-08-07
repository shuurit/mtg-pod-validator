"""
Removes an existing player's deck row from deck-strength.xlsx: the exact
inverse of add_deck.py -- deletes one row from that player's block in both
Current Deck Strength and Deck Win Rates (kept in sync, same layout), then
shifts every row below it up by one. For a deck that's been deleted or
merged into a different entry on playgroup.gg (e.g. a partner pairing split
into two standalone decks), where the old spreadsheet row no longer
corresponds to anything real.

Usage:
    python scripts/remove_deck.py '{"player": "Mateo", "deck": "Leonardo, the Balance/Michelangelo, the Heart"}'

Matches the deck by exact name within that player's block. Refuses to run
if the match isn't unique, or if it would remove a player's only deck (use
a player-removal tool for that instead -- not implemented here, since it
hasn't come up yet).

Row-shifting mirrors add_deck.py exactly, just in the opposite direction:
each row's own r="N" attribute, each cell's r="COLN" reference, and the
same small set of self-referential row numbers inside formulas this
project's own scripts write (A{N}, D{N}, B{N}/C{N}, and a player header's
AVERAGE(B{start}:B{end}) range).

This only edits the spreadsheet. Commit + push, then trigger the
"Recalculate Spreadsheet" GitHub Actions workflow (workflow_dispatch) so
real cached formula values replace whatever this script leaves behind for
shifted rows.
"""
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

from add_deck import (
    ROW_RE,
    cell_a_label,
    find_player_block,
    is_header_row,
    load_shared_strings,
)

XLSX_PATH = Path(__file__).parent.parent / "deck-strength.xlsx"
CDS_SHEET_FILE = "xl/worksheets/sheet4.xml"  # Current Deck Strength
DWR_SHEET_FILE = "xl/worksheets/sheet5.xml"  # Deck Win Rates


def find_deck_row(sheet_xml, player, deck, is_cds, shared_strings):
    header_row, first_deck_row, last_deck_row = find_player_block(sheet_xml, player, is_cds, shared_strings)
    matches = []
    for m in ROW_RE.finditer(sheet_xml):
        row_num = int(m.group(1))
        if not (first_deck_row <= row_num <= last_deck_row):
            continue
        if cell_a_label(m.group(3), row_num, shared_strings) == deck:
            matches.append(row_num)
    if not matches:
        raise ValueError(f'Deck "{deck}" not found in {player}\'s block (rows {first_deck_row}-{last_deck_row}).')
    if len(matches) > 1:
        raise ValueError(f'Deck "{deck}" matches multiple rows for {player}: {matches} -- not unique, refusing to guess.')
    if first_deck_row == last_deck_row:
        raise ValueError(f'"{deck}" is {player}\'s only deck -- removing it would leave an empty block, not handled here.')
    return header_row, first_deck_row, last_deck_row, matches[0]


def shift_cds_row_up(inner, old_row, new_row, is_player_header, avg_range=None):
    inner = re.sub(rf'r="([A-Z]+){old_row}"', rf'r="\g<1>{new_row}"', inner)
    if is_player_header:
        old_s, old_e = avg_range
        inner = inner.replace(f"AVERAGE(B{old_s}:B{old_e})", f"AVERAGE(B{old_s - 1}:B{old_e - 1})")
    else:
        inner = inner.replace(f"A{old_row})", f"A{new_row})")
        inner = inner.replace(f", D{old_row})", f", D{new_row})")
    return inner


def shift_dwr_row_up(inner, old_row, new_row):
    inner = re.sub(rf'r="([A-Z]+){old_row}"', rf'r="\g<1>{new_row}"', inner)
    inner = inner.replace(f"A{old_row})", f"A{new_row})")
    inner = inner.replace(f"A{old_row},", f"A{new_row},")
    inner = inner.replace(f"C{old_row}/B{old_row}", f"C{new_row}/B{new_row}")
    return inner


def process_cds(sheet_xml, player, deck, shared_strings):
    header_row, first_deck_row, last_deck_row, target_row = find_deck_row(sheet_xml, player, deck, True, shared_strings)

    rows_by_num = {}
    max_row = 0
    for m in ROW_RE.finditer(sheet_xml):
        row_num = int(m.group(1))
        attrs, inner = m.group(2), m.group(3)
        max_row = max(max_row, row_num)
        if row_num == target_row:
            continue  # dropped
        if row_num < target_row:
            if row_num == header_row:
                inner = inner.replace(
                    f"AVERAGE(B{first_deck_row}:B{last_deck_row})",
                    f"AVERAGE(B{first_deck_row}:B{last_deck_row - 1})",
                )
            rows_by_num[row_num] = f'<row r="{row_num}"{attrs}>{inner}</row>'
        else:
            new_row = row_num - 1
            is_header = is_header_row(inner, row_num, True)
            avg_range = None
            if is_header:
                rm = re.search(r"AVERAGE\(B(\d+):B(\d+)\)", inner)
                avg_range = (int(rm.group(1)), int(rm.group(2)))
            new_inner = shift_cds_row_up(inner, row_num, new_row, is_header, avg_range)
            rows_by_num[new_row] = f'<row r="{new_row}"{attrs}>{new_inner}</row>'

    new_last_row = max_row - 1
    new_sheet_data = "".join(rows_by_num[n] for n in sorted(rows_by_num))
    new_xml = re.sub(r'<dimension ref="A1:[A-Z]\d+"/>', f'<dimension ref="A1:E{new_last_row}"/>', sheet_xml)
    new_xml = re.sub(r"<sheetData>.*</sheetData>", f"<sheetData>{new_sheet_data}</sheetData>", new_xml, flags=re.DOTALL)
    return new_xml, target_row


def process_dwr(sheet_xml, player, deck, target_row, shared_strings):
    header_row, first_deck_row, last_deck_row, matched_row = find_deck_row(sheet_xml, player, deck, False, shared_strings)
    if matched_row != target_row:
        raise RuntimeError(
            f'Deck Win Rates has "{deck}" for {player} at row {matched_row}, but Current Deck Strength has it at '
            f"row {target_row} -- sheets are out of sync."
        )

    rows_by_num = {}
    max_row = 0
    for m in ROW_RE.finditer(sheet_xml):
        row_num = int(m.group(1))
        attrs, inner = m.group(2), m.group(3)
        max_row = max(max_row, row_num)
        if row_num == target_row:
            continue  # dropped
        if row_num < target_row:
            rows_by_num[row_num] = f'<row r="{row_num}"{attrs}>{inner}</row>'
        else:
            new_row = row_num - 1
            new_inner = shift_dwr_row_up(inner, row_num, new_row)
            rows_by_num[new_row] = f'<row r="{new_row}"{attrs}>{new_inner}</row>'

    new_last_row = max_row - 1
    new_sheet_data = "".join(rows_by_num[n] for n in sorted(rows_by_num))
    new_xml = re.sub(r'<dimension ref="A1:D\d+"/>', f'<dimension ref="A1:D{new_last_row}"/>', sheet_xml)
    new_xml = re.sub(r"<sheetData>.*</sheetData>", f"<sheetData>{new_sheet_data}</sheetData>", new_xml, flags=re.DOTALL)
    return new_xml


def main():
    payload = json.loads(sys.argv[1])
    player = payload["player"]
    deck = payload["deck"]

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    shared_strings = load_shared_strings(contents)
    cds_xml = contents[CDS_SHEET_FILE].decode("utf-8")
    dwr_xml = contents[DWR_SHEET_FILE].decode("utf-8")

    new_cds_xml, target_row = process_cds(cds_xml, player, deck, shared_strings)
    new_dwr_xml = process_dwr(dwr_xml, player, deck, target_row, shared_strings)

    contents[CDS_SHEET_FILE] = new_cds_xml.encode("utf-8")
    contents[DWR_SHEET_FILE] = new_dwr_xml.encode("utf-8")

    tmp_path = str(XLSX_PATH) + ".tmp"
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zout.writestr(i, contents[i.filename])
    shutil.move(tmp_path, XLSX_PATH)

    print(f'Removed "{deck}" for {player} (was row {target_row}; everything below shifted up by 1).')
    print('Commit + push, then trigger the "Recalculate Spreadsheet" GitHub Actions workflow.')


if __name__ == "__main__":
    main()

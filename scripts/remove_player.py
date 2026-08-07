"""
Removes an entire player's block from deck-strength.xlsx: the header row
and every deck row beneath it, in both Current Deck Strength and Deck Win
Rates, then shifts everything below up by the size of the removed block.
Also removes their entry from cloudflare-worker/relay.js's
USERNAME_TO_PLAYER, if present -- otherwise a future /roster-diff would
just detect them as "new" again and offer to re-add them.

Usage:
    python scripts/remove_player.py '{"player": "Hiccup_The_Hero"}'

Unlike remove_deck.py (drops one row, the block stays), this drops the
whole block -- header row through the block's last deck row -- and shifts
by that block's size rather than always 1. Reuses remove_deck.py's
per-row shift functions, which already take an arbitrary old_row/new_row
pair rather than assuming a shift of exactly 1.

This only edits the spreadsheet + relay.js. Commit + push, then trigger
the "Recalculate Spreadsheet" GitHub Actions workflow, and redeploy the
Worker (relay.js changed outside the roster-update flow, so nothing
redeploys it automatically here).
"""
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

from add_deck import ROW_RE, find_player_block, is_header_row, load_shared_strings
from remove_deck import shift_cds_row_up, shift_dwr_row_up

XLSX_PATH = Path(__file__).parent.parent / "deck-strength.xlsx"
RELAY_JS_PATH = Path(__file__).parent.parent / "cloudflare-worker" / "relay.js"
CDS_SHEET_FILE = "xl/worksheets/sheet4.xml"
DWR_SHEET_FILE = "xl/worksheets/sheet5.xml"


def remove_cds_block(sheet_xml, player, shared_strings):
    header_row, first_deck_row, last_deck_row = find_player_block(sheet_xml, player, True, shared_strings)
    return _remove_block(sheet_xml, header_row, last_deck_row, True, "E")


def remove_dwr_block(sheet_xml, player, shared_strings):
    header_row, first_deck_row, last_deck_row = find_player_block(sheet_xml, player, False, shared_strings)
    return _remove_block(sheet_xml, header_row, last_deck_row, False, "D")


def _remove_block(sheet_xml, block_start, block_end, is_cds, dim_col):
    block_size = block_end - block_start + 1

    rows_by_num = {}
    max_row = 0
    for m in ROW_RE.finditer(sheet_xml):
        row_num = int(m.group(1))
        attrs, inner = m.group(2), m.group(3)
        max_row = max(max_row, row_num)
        if block_start <= row_num <= block_end:
            continue  # dropped
        if row_num < block_start:
            rows_by_num[row_num] = f'<row r="{row_num}"{attrs}>{inner}</row>'
        else:
            new_row = row_num - block_size
            if is_cds:
                is_header = is_header_row(inner, row_num, True)
                avg_range = None
                if is_header:
                    rm = re.search(r"AVERAGE\(B(\d+):B(\d+)\)", inner)
                    avg_range = (int(rm.group(1)), int(rm.group(2)))
                new_inner = shift_cds_row_up(inner, row_num, new_row, is_header, avg_range)
            else:
                new_inner = shift_dwr_row_up(inner, row_num, new_row)
            rows_by_num[new_row] = f'<row r="{new_row}"{attrs}>{new_inner}</row>'

    new_last_row = max_row - block_size
    new_sheet_data = "".join(rows_by_num[n] for n in sorted(rows_by_num))
    new_xml = re.sub(r'<dimension ref="A1:[A-Z]\d+"/>', f'<dimension ref="A1:{dim_col}{new_last_row}"/>', sheet_xml)
    new_xml = re.sub(r"<sheetData>.*</sheetData>", f"<sheetData>{new_sheet_data}</sheetData>", new_xml, flags=re.DOTALL)
    return new_xml


def remove_from_relay_js(player):
    if not RELAY_JS_PATH.exists():
        return False
    relay_js = RELAY_JS_PATH.read_text(encoding="utf-8")
    pattern = re.compile(rf'\n  "[^"]+": "{re.escape(player)}",')
    new_relay_js, count = pattern.subn("", relay_js)
    if count == 0:
        return False
    if count > 1:
        raise RuntimeError(f'Multiple USERNAME_TO_PLAYER entries map to "{player}" -- not handled, edit manually.')
    RELAY_JS_PATH.write_text(new_relay_js, encoding="utf-8")
    return True


def main():
    payload = json.loads(sys.argv[1])
    player = payload["player"]

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    shared_strings = load_shared_strings(contents)
    cds_xml = contents[CDS_SHEET_FILE].decode("utf-8")
    dwr_xml = contents[DWR_SHEET_FILE].decode("utf-8")

    new_cds_xml = remove_cds_block(cds_xml, player, shared_strings)
    new_dwr_xml = remove_dwr_block(dwr_xml, player, shared_strings)

    contents[CDS_SHEET_FILE] = new_cds_xml.encode("utf-8")
    contents[DWR_SHEET_FILE] = new_dwr_xml.encode("utf-8")

    tmp_path = str(XLSX_PATH) + ".tmp"
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zout.writestr(i, contents[i.filename])
    shutil.move(tmp_path, XLSX_PATH)

    relay_changed = remove_from_relay_js(player)

    print(f'Removed player "{player}" and all their decks from both sheets.')
    if relay_changed:
        print(f'Removed "{player}" from relay.js\'s USERNAME_TO_PLAYER -- redeploy the Worker.')
    else:
        print(f'No USERNAME_TO_PLAYER entry found for "{player}" in relay.js -- nothing to change there.')
    print('Commit + push, then trigger the "Recalculate Spreadsheet" GitHub Actions workflow.')


if __name__ == "__main__":
    main()

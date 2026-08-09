"""
Edits an existing deck row in place: rename it, change its starting
baseline power, and/or set its bracket note -- whichever fields are given.
Column B's IFERROR(LOOKUP(...), D) formula falls back to the baseline (D)
automatically once recalculated, so changing power here is enough to fix
Current Deck Strength for a deck with no game history yet; for one that
already has games logged, B reflects real play and won't move just
because D changed (a deck like that diverging from playgroup.gg's own
rating is expected, not a bug -- see the audit this was built for).

Usage:
    python scripts/edit_deck.py '{"player": "Mateo", "deck": "Leonardo, the Balance", "new_name": "Leonardo, the Balance/Michelangelo, the Heart", "new_power": 2.6}'
    python scripts/edit_deck.py '{"player": "Becca", "deck": "Katara, the Fearless", "new_power": 2.0, "new_bracket": 2}'

new_name/new_power/new_bracket are all optional -- provide whichever
apply. Renames touch both Current Deck Strength and Deck Win Rates (kept
in sync, same layout); power and bracket only exist in Current Deck
Strength (bracket is a free-text note in column C, "*Bracket N", matching
the convention already used elsewhere in that column).

Cells are rewritten as inlineStr/plain numeric rather than touching the
shared string table, same reasoning as add_deck.py/add_player.py: safe
regardless of whether some other cell happens to share the same string
index, no risk of corrupting an unrelated row.
"""
import json
import re
import shutil
import sys
import zipfile

from add_deck import ROW_RE, load_shared_strings
from remove_deck import find_deck_row
from season_config import XLSX_PATH

CDS_SHEET_FILE = "xl/worksheets/sheet4.xml"
DWR_SHEET_FILE = "xl/worksheets/sheet5.xml"


def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fmt_num(v):
    if isinstance(v, int) or (isinstance(v, float) and float(v).is_integer()):
        return repr(int(v))
    return repr(float(v))


def cell_style(sheet_xml, row_num, col):
    m = re.search(rf'<c r="{col}{row_num}" s="(\d+)"', sheet_xml)
    if not m:
        raise RuntimeError(f"cell {col}{row_num} not found -- can't read style")
    return m.group(1)


def replace_cells_in_row(sheet_xml, target_row, new_cell_xml_by_col):
    def repl(m):
        row_num = int(m.group(1))
        if row_num != target_row:
            return m.group(0)
        attrs, inner = m.group(2), m.group(3)
        for col, new_cell_xml in new_cell_xml_by_col.items():
            inner = re.sub(rf'<c r="{col}{row_num}"[^>]*?(?:/>|>.*?</c>)', new_cell_xml, inner, count=1, flags=re.DOTALL)
        return f'<row r="{row_num}"{attrs}>{inner}</row>'
    return ROW_RE.sub(repl, sheet_xml)


def main():
    payload = json.loads(sys.argv[1])
    player = payload["player"]
    deck = payload["deck"]
    new_name = payload.get("new_name")
    new_power = payload.get("new_power")
    new_bracket = payload.get("new_bracket")
    if new_name is None and new_power is None and new_bracket is None:
        raise ValueError("Nothing to change -- provide new_name, new_power, and/or new_bracket.")

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    shared_strings = load_shared_strings(contents)
    cds_xml = contents[CDS_SHEET_FILE].decode("utf-8")
    dwr_xml = contents[DWR_SHEET_FILE].decode("utf-8")

    _, _, _, cds_row = find_deck_row(cds_xml, player, deck, True, shared_strings)
    _, _, _, dwr_row = find_deck_row(dwr_xml, player, deck, False, shared_strings)

    cds_updates = {}
    if new_name is not None:
        style_a = cell_style(cds_xml, cds_row, "A")
        cds_updates["A"] = f'<c r="A{cds_row}" s="{style_a}" t="inlineStr"><is><t>{xml_escape(new_name)}</t></is></c>'
    if new_power is not None:
        style_d = cell_style(cds_xml, cds_row, "D")
        cds_updates["D"] = f'<c r="D{cds_row}" s="{style_d}" t="n"><v>{fmt_num(new_power)}</v></c>'
    if new_bracket is not None:
        style_c = cell_style(cds_xml, cds_row, "C")
        cds_updates["C"] = f'<c r="C{cds_row}" s="{style_c}" t="inlineStr"><is><t>{xml_escape(f"*Bracket {new_bracket}")}</t></is></c>'
    if cds_updates:
        cds_xml = replace_cells_in_row(cds_xml, cds_row, cds_updates)

    if new_name is not None:
        style_a_dwr = cell_style(dwr_xml, dwr_row, "A")
        dwr_updates = {"A": f'<c r="A{dwr_row}" s="{style_a_dwr}" t="inlineStr"><is><t>{xml_escape(new_name)}</t></is></c>'}
        dwr_xml = replace_cells_in_row(dwr_xml, dwr_row, dwr_updates)

    contents[CDS_SHEET_FILE] = cds_xml.encode("utf-8")
    contents[DWR_SHEET_FILE] = dwr_xml.encode("utf-8")

    tmp_path = str(XLSX_PATH) + ".tmp"
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zout.writestr(i, contents[i.filename])
    shutil.move(tmp_path, XLSX_PATH)

    changes = []
    if new_name is not None:
        changes.append(f'name -> "{new_name}"')
    if new_power is not None:
        changes.append(f"power -> {new_power}")
    if new_bracket is not None:
        changes.append(f"bracket -> {new_bracket}")
    print(f'Updated "{deck}" for {player} (row {cds_row}): {", ".join(changes)}.')
    print('Commit + push, then trigger the "Recalculate Spreadsheet" GitHub Actions workflow.')


if __name__ == "__main__":
    main()

"""
Adds a new deck for an EXISTING player to deck-strength.xlsx: inserts one
row into that player's block in both Current Deck Strength and Deck Win
Rates (kept in sync, same layout). Unlike add_player.py, this can't just
append at the end -- the new row has to land inside the player's existing
block, which means every row below it shifts down by one.

Usage:
    python scripts/add_deck.py '{"player": "Manny", "deck": "Krenko, Mob Boss", "power": 3.2, "playgroupDeckId": 744135}'

"power" is a starting baseline -- Current Deck Strength switches to the
deck's latest Game Calculated Deck Strength automatically once games get
logged for it. "playgroupDeckId" is optional (omit or null for a deck
with no playgroup.gg account behind it).

Row-shifting only touches: the row's own r="N" attribute, each cell's
r="COLN" reference, and the small set of self-referential row numbers
inside the formulas this project's own scripts write (A{N}, D{N}, B{N}/
C{N}, and a player header's AVERAGE(B{start}:B{end}) range). Everything
else in a shifted row -- values, notes, styles -- is carried over
untouched, so this is safe even for rows with hand-added notes text.

This only edits the spreadsheet. Commit + push, then trigger the
"Recalculate Spreadsheet" GitHub Actions workflow (workflow_dispatch) so
real cached formula values replace the starting-baseline placeholder this
script writes for the new row.
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

ROW_RE = re.compile(r'<row r="(\d+)"([^>]*)>(.*?)</row>', re.DOTALL)


def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fmt_num(v):
    if isinstance(v, int) or (isinstance(v, float) and float(v).is_integer()):
        return repr(int(v))
    return repr(float(v))


def load_shared_strings(contents):
    xml = contents.get("xl/sharedStrings.xml")
    if not xml:
        return []
    xml = xml.decode("utf-8")
    # Each <si>...</si> may hold one <t>text</t>, or multiple <r><t>...</t></r>
    # runs (rich text) -- concatenate whichever is present.
    strings = []
    for si in re.findall(r"<si>(.*?)</si>", xml, re.DOTALL):
        texts = re.findall(r"<t[^>]*>(.*?)</t>", si, re.DOTALL)
        strings.append("".join(texts))
    return strings


def cell_a_label(inner, row_num, shared_strings):
    """Column A's text, whether stored inline or as a shared-string index."""
    m = re.search(rf'<c r="A{row_num}"[^>]*>(.*?)</c>', inner, re.DOTALL)
    if not m:
        return None
    cell_xml = m.group(1)
    is_m = re.search(r"<is><t[^>]*>(.*?)</t></is>", cell_xml, re.DOTALL)
    if is_m:
        return is_m.group(1)
    v_m = re.search(r"<v>(\d+)</v>", cell_xml)
    if v_m:
        idx = int(v_m.group(1))
        if idx < len(shared_strings):
            return shared_strings[idx]
    return None


def is_header_row(inner, row_num, is_cds):
    """CDS: unambiguous, only player rows use AVERAGE(...). DWR: both player
    and deck rows use COUNTIFS(...,A{row}) shaped formulas ending the same
    way, so comma-counting isn't reliable -- deck rows always embed a
    quoted player-name literal ("Manny") and player rows never do, so that's
    the real distinguishing signal."""
    if is_cds:
        return bool(re.search(r"<f[^>]*>AVERAGE\(", inner))
    if row_num == 1:
        return False
    b_m = re.search(r'<c r="B\d+"[^>]*><f[^>]*>(.*?)</f>', inner, re.DOTALL)
    if not b_m:
        return False
    b_formula = b_m.group(1)
    return "COUNTIFS(" in b_formula and "&quot;" not in b_formula


def find_player_block(sheet_xml, player, is_cds, shared_strings):
    """Returns (header_row, block_start_deck_row, block_end_deck_row) by
    walking rows in order and tracking whichever player header was most
    recently seen -- same convention app.js's own parser uses."""
    current_player_text = None
    header_row_of = {}
    block_rows = {}  # player -> [deck_row, ...]
    for m in ROW_RE.finditer(sheet_xml):
        row_num = int(m.group(1))
        inner = m.group(3)
        label = cell_a_label(inner, row_num, shared_strings)
        is_header = is_header_row(inner, row_num, is_cds)
        if is_header:
            current_player_text = label
            header_row_of[label] = row_num
            block_rows.setdefault(label, [])
        elif current_player_text is not None and row_num != 1:
            block_rows.setdefault(current_player_text, []).append(row_num)

    if player not in header_row_of:
        raise ValueError(f'Player "{player}" not found (looked at column A header rows).')
    header_row = header_row_of[player]
    decks = block_rows.get(player, [])
    if not decks:
        raise ValueError(f'Player "{player}" has a header row but no deck rows -- not handled, add manually.')
    return header_row, decks[0], decks[-1]


def shift_cds_row(inner, old_row, new_row, is_player_header, avg_range=None):
    inner = re.sub(rf'r="([A-Z]+){old_row}"', rf'r="\g<1>{new_row}"', inner)
    if is_player_header:
        old_s, old_e = avg_range
        inner = inner.replace(f"AVERAGE(B{old_s}:B{old_e})", f"AVERAGE(B{old_s + 1}:B{old_e + 1})")
    else:
        inner = inner.replace(f"A{old_row})", f"A{new_row})")
        inner = inner.replace(f", D{old_row})", f", D{new_row})")
    return inner


def shift_dwr_row(inner, old_row, new_row):
    inner = re.sub(rf'r="([A-Z]+){old_row}"', rf'r="\g<1>{new_row}"', inner)
    inner = inner.replace(f"A{old_row})", f"A{new_row})")
    inner = inner.replace(f"A{old_row},", f"A{new_row},")
    inner = inner.replace(f"C{old_row}/B{old_row}", f"C{new_row}/B{new_row}")
    return inner


def row_styles(sheet_xml, rownum, columns):
    m = re.search(rf'<row r="{rownum}"[^>]*>(.*?)</row>', sheet_xml, re.DOTALL)
    styles = {}
    for col in columns:
        cm = re.search(rf'<c r="{col}{rownum}" s="(\d+)"', m.group(1))
        if not cm:
            raise RuntimeError(f"cell {col}{rownum} not found -- can't read style template")
        styles[col] = cm.group(1)
    return styles


def process_cds(sheet_xml, player, deck, power, deck_id, shared_strings):
    header_row, first_deck_row, last_deck_row = find_player_block(sheet_xml, player, True, shared_strings)
    insertion_point = last_deck_row + 1
    deck_style = row_styles(sheet_xml, first_deck_row, "ABCDE")

    rows_by_num = {}
    max_row = 0
    for m in ROW_RE.finditer(sheet_xml):
        row_num = int(m.group(1))
        attrs, inner = m.group(2), m.group(3)
        max_row = max(max_row, row_num)
        if row_num < insertion_point:
            if row_num == header_row:
                inner = inner.replace(
                    f"AVERAGE(B{first_deck_row}:B{last_deck_row})",
                    f"AVERAGE(B{first_deck_row}:B{last_deck_row + 1})",
                )
            rows_by_num[row_num] = f'<row r="{row_num}"{attrs}>{inner}</row>'
        else:
            new_row = row_num + 1
            is_header = is_header_row(inner, row_num, True)
            avg_range = None
            if is_header:
                rm = re.search(r"AVERAGE\(B(\d+):B(\d+)\)", inner)
                avg_range = (int(rm.group(1)), int(rm.group(2)))
            new_inner = shift_cds_row(inner, row_num, new_row, is_header, avg_range)
            rows_by_num[new_row] = f'<row r="{new_row}"{attrs}>{new_inner}</row>'

    formula = (
        f"IFERROR(LOOKUP(2,1/(('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW}=\"{player}\")"
        f"*('{LOG_SHEET}'!$D$3:$D${LOG_MAX_ROW}=A{insertion_point})"
        f"*('{LOG_SHEET}'!$X$3:$X${LOG_MAX_ROW}<>\"\")),"
        f"'{LOG_SHEET}'!$X$3:$X${LOG_MAX_ROW}), D{insertion_point})"
    )
    e_cell = (
        f'<c r="E{insertion_point}" s="{deck_style["E"]}" t="inlineStr"><is><t>{xml_escape(str(deck_id))}</t></is></c>'
        if deck_id else f'<c r="E{insertion_point}" s="{deck_style["E"]}"/>'
    )
    rows_by_num[insertion_point] = (
        f'<row r="{insertion_point}" spans="1:5">'
        f'<c r="A{insertion_point}" s="{deck_style["A"]}" t="inlineStr"><is><t>{xml_escape(deck)}</t></is></c>'
        f'<c r="B{insertion_point}" s="{deck_style["B"]}"><f>{xml_escape(formula)}</f><v>{fmt_num(power)}</v></c>'
        f'<c r="C{insertion_point}" s="{deck_style["C"]}"/>'
        f'<c r="D{insertion_point}" s="{deck_style["D"]}"><v>{fmt_num(power)}</v></c>'
        f'{e_cell}'
        f'</row>'
    )

    new_last_row = max_row + 1
    new_sheet_data = "".join(rows_by_num[n] for n in sorted(rows_by_num))
    new_xml = re.sub(r'<dimension ref="A1:[A-Z]\d+"/>', f'<dimension ref="A1:E{new_last_row}"/>', sheet_xml)
    new_xml = re.sub(r"<sheetData>.*</sheetData>", f"<sheetData>{new_sheet_data}</sheetData>", new_xml, flags=re.DOTALL)
    return new_xml, insertion_point


def process_dwr(sheet_xml, player, deck, insertion_point, shared_strings):
    header_row, first_deck_row, last_deck_row = find_player_block(sheet_xml, player, False, shared_strings)
    if last_deck_row + 1 != insertion_point:
        raise RuntimeError(
            f"Deck Win Rates block for {player} ends at row {last_deck_row} (expected insertion at "
            f"{last_deck_row + 1}) but Current Deck Strength wants row {insertion_point} -- sheets are out of sync."
        )
    deck_style = row_styles(sheet_xml, first_deck_row, "ABCD")

    rows_by_num = {}
    max_row = 0
    for m in ROW_RE.finditer(sheet_xml):
        row_num = int(m.group(1))
        attrs, inner = m.group(2), m.group(3)
        max_row = max(max_row, row_num)
        if row_num < insertion_point:
            rows_by_num[row_num] = f'<row r="{row_num}"{attrs}>{inner}</row>'
        else:
            new_row = row_num + 1
            new_inner = shift_dwr_row(inner, row_num, new_row)
            rows_by_num[new_row] = f'<row r="{new_row}"{attrs}>{new_inner}</row>'

    b_formula = (
        f"COUNTIFS('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW},\"{player}\","
        f"'{LOG_SHEET}'!$D$3:$D${LOG_MAX_ROW},A{insertion_point})"
    )
    c_formula = (
        f"COUNTIFS('{LOG_SHEET}'!$C$3:$C${LOG_MAX_ROW},\"{player}\","
        f"'{LOG_SHEET}'!$D$3:$D${LOG_MAX_ROW},A{insertion_point},"
        f"'{LOG_SHEET}'!$F$3:$F${LOG_MAX_ROW},1)"
    )
    d_formula = f"IFERROR(C{insertion_point}/B{insertion_point},0)"
    rows_by_num[insertion_point] = (
        f'<row r="{insertion_point}" spans="1:4">'
        f'<c r="A{insertion_point}" s="{deck_style["A"]}" t="inlineStr"><is><t>{xml_escape(deck)}</t></is></c>'
        f'<c r="B{insertion_point}" s="{deck_style["B"]}"><f>{xml_escape(b_formula)}</f><v>0</v></c>'
        f'<c r="C{insertion_point}" s="{deck_style["C"]}"><f>{xml_escape(c_formula)}</f><v>0</v></c>'
        f'<c r="D{insertion_point}" s="{deck_style["D"]}"><f>{xml_escape(d_formula)}</f><v>0</v></c>'
        f'</row>'
    )

    new_last_row = max_row + 1
    new_sheet_data = "".join(rows_by_num[n] for n in sorted(rows_by_num))
    new_xml = re.sub(r'<dimension ref="A1:D\d+"/>', f'<dimension ref="A1:D{new_last_row}"/>', sheet_xml)
    new_xml = re.sub(r"<sheetData>.*</sheetData>", f"<sheetData>{new_sheet_data}</sheetData>", new_xml, flags=re.DOTALL)
    return new_xml


def main():
    payload = json.loads(sys.argv[1])
    player = payload["player"]
    deck = payload["deck"]
    power = payload["power"]
    deck_id = payload.get("playgroupDeckId")

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    shared_strings = load_shared_strings(contents)
    cds_xml = contents[CDS_SHEET_FILE].decode("utf-8")
    dwr_xml = contents[DWR_SHEET_FILE].decode("utf-8")

    new_cds_xml, insertion_point = process_cds(cds_xml, player, deck, power, deck_id, shared_strings)
    new_dwr_xml = process_dwr(dwr_xml, player, deck, insertion_point, shared_strings)

    contents[CDS_SHEET_FILE] = new_cds_xml.encode("utf-8")
    contents[DWR_SHEET_FILE] = new_dwr_xml.encode("utf-8")

    tmp_path = str(XLSX_PATH) + ".tmp"
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zout.writestr(i, contents[i.filename])
    shutil.move(tmp_path, XLSX_PATH)

    print(f'Added "{deck}" for {player} at row {insertion_point} (everything below shifted down by 1).')
    print('Commit + push, then trigger the "Recalculate Spreadsheet" GitHub Actions workflow.')


if __name__ == "__main__":
    main()

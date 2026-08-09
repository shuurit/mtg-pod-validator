"""
Rolls deck-strength.xlsx from the current season's Game Log tab to a new
one:

1. Clones the current Game Log tab's header (rows 1-2, column widths,
   merged header cells) into a new, empty Game Log tab for the new season
   -- registered in the workbook so it actually shows up as a real tab.
2. Current Deck Strength: snapshots each deck's current computed strength
   into its baseline column (column D) before repointing its formula at
   the new season's tab, so nothing regresses to a stale old estimate on
   day one of the new season -- it just carries forward until the deck
   gets played again.
3. Deck Win Rates and Player Adjusted Ranks: repointed at the new season's
   tab too. These intentionally reset toward 0 -- both are already scoped
   to "current season only" (not lifetime), matching how they behaved
   before this script ever touched them.
4. Updates app.js's CURRENT_SEASON_SHEET and scripts/season_config.py's
   CURRENT_SEASON_SHEET -- the only two places the season name is
   hardcoded in this project (relay.js needs nothing: it already discovers
   the active league dynamically from playgroup.gg).

Usage:
    python scripts/season_rollover.py "Game Log Season 4"

This only edits local files. Commit + push, then trigger the "Recalculate
Spreadsheet" GitHub Actions workflow (workflow_dispatch) so real cached
values replace the placeholders this script writes.
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path

from add_deck import ROW_RE, cell_a_label, is_header_row, load_shared_strings
from season_config import CURRENT_SEASON_SHEET, XLSX_PATH

REPO_ROOT = Path(__file__).parent.parent
APP_JS_PATH = REPO_ROOT / "app.js"
SEASON_CONFIG_PATH = Path(__file__).parent / "season_config.py"


def repoint_sheet_refs(xml_text, old_sheet, new_sheet):
    """Replace every 'OldSheet'! reference with 'NewSheet'!, whichever way
    the surrounding XML happens to have the quotes encoded. Formulas this
    project's own scripts just wrote use raw '...' (see xml_escape() in
    add_player.py/add_deck.py -- it only escapes &, <, > since raw " and '
    are legal in XML text content). But any sheet that's already been
    through a real LibreOffice recalc pass gets re-serialized with &apos;
    around sheet names instead -- both forms need handling, or a repoint
    silently replaces nothing on a sheet LibreOffice has already touched."""
    count = xml_text.count(f"'{old_sheet}'!") + xml_text.count(f"&apos;{old_sheet}&apos;!")
    xml_text = xml_text.replace(f"'{old_sheet}'!", f"'{new_sheet}'!")
    xml_text = xml_text.replace(f"&apos;{old_sheet}&apos;!", f"&apos;{new_sheet}&apos;!")
    return xml_text, count


def resolve_sheet_file(workbook_xml, rels_xml, sheet_name):
    m = re.search(rf'<sheet name="{re.escape(sheet_name)}"[^/]*r:id="(rId\d+)"', workbook_xml)
    if not m:
        raise ValueError(f'Sheet "{sheet_name}" not found in workbook.xml')
    rid = m.group(1)
    rm = re.search(rf'<Relationship Id="{rid}"[^>]*Target="([^"]+)"', rels_xml)
    if not rm:
        raise ValueError(f'Relationship {rid} not found in workbook.xml.rels')
    target = rm.group(1)
    return "xl/" + target if not target.startswith("xl/") else target


def next_sheet_file_number(contents):
    nums = [int(m) for f in contents for m in re.findall(r"xl/worksheets/sheet(\d+)\.xml$", f)]
    return max(nums) + 1


def next_sheet_id(workbook_xml):
    ids = [int(m) for m in re.findall(r'<sheet [^>]*sheetId="(\d+)"', workbook_xml)]
    return max(ids) + 1


def next_rid(rels_xml):
    ids = [int(m) for m in re.findall(r'<Relationship Id="rId(\d+)"', rels_xml)]
    return max(ids) + 1


def build_new_game_log_sheet(old_sheet_xml):
    """Same header (rows 1-2), formatting, and merged header cells; empty
    of data rows."""
    rows_xml = "".join(
        m.group(0) for m in ROW_RE.finditer(old_sheet_xml)
        if int(m.group(1)) <= 2
    )
    new_xml = re.sub(r"<sheetData>.*</sheetData>", f"<sheetData>{rows_xml}</sheetData>", old_sheet_xml, flags=re.DOTALL)
    new_xml = re.sub(r'<dimension ref="[^"]*"/>', '<dimension ref="A1:Y2"/>', new_xml)
    return new_xml


def snapshot_and_repoint_cds(cds_xml, old_sheet, new_sheet, shared_strings):
    """For every deck row, copy B's current cached value into D's cached
    value, THEN repoint every formula's sheet-name reference. Order doesn't
    matter for correctness (independent edits), but snapshotting reads B's
    value before anything else changes it."""
    total_count = 0

    def process_row(m):
        nonlocal total_count
        row_num, attrs, inner = int(m.group(1)), m.group(2), m.group(3)
        if row_num > 1 and not is_header_row(inner, row_num, True):
            b_m = re.search(r'<c r="B\d+"[^>]*><f[^>]*>.*?</f><v>([^<]*)</v></c>', inner, re.DOTALL)
            if b_m:
                current_value = b_m.group(1)
                inner = re.sub(
                    r'(<c r="D\d+"[^>]*><v>)[^<]*(</v></c>)',
                    rf"\g<1>{current_value}\g<2>",
                    inner,
                )
        inner, count = repoint_sheet_refs(inner, old_sheet, new_sheet)
        total_count += count
        return f'<row r="{row_num}"{attrs}>{inner}</row>'

    new_xml = ROW_RE.sub(process_row, cds_xml)
    return new_xml, total_count


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python scripts/season_rollover.py "Game Log Season 4"')
    new_sheet = sys.argv[1]
    old_sheet = CURRENT_SEASON_SHEET

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    workbook_xml = contents["xl/workbook.xml"].decode("utf-8")
    rels_xml = contents["xl/_rels/workbook.xml.rels"].decode("utf-8")
    shared_strings = load_shared_strings(contents)

    old_log_file = resolve_sheet_file(workbook_xml, rels_xml, old_sheet)
    cds_file = resolve_sheet_file(workbook_xml, rels_xml, "Current Deck Strength")
    dwr_file = resolve_sheet_file(workbook_xml, rels_xml, "Deck Win Rates")
    par_file = resolve_sheet_file(workbook_xml, rels_xml, "Player Adjusted Ranks")

    # ---- 1. clone the Game Log tab ----
    new_file_num = next_sheet_file_number(contents)
    new_log_file = f"xl/worksheets/sheet{new_file_num}.xml"
    new_sheet_id = next_sheet_id(workbook_xml)
    new_rid = f"rId{next_rid(rels_xml)}"

    old_log_xml = contents[old_log_file].decode("utf-8")
    contents[new_log_file] = build_new_game_log_sheet(old_log_xml).encode("utf-8")

    old_sheet_tag_m = re.search(rf'<sheet name="{re.escape(old_sheet)}"[^/]*/>', workbook_xml)
    if not old_sheet_tag_m:
        raise RuntimeError(f'Could not find a self-closing <sheet> tag for "{old_sheet}" in workbook.xml')
    new_sheet_tag = f'<sheet name="{new_sheet}" sheetId="{new_sheet_id}" r:id="{new_rid}"/>'
    workbook_xml = (
        workbook_xml[: old_sheet_tag_m.end()]
        + new_sheet_tag
        + workbook_xml[old_sheet_tag_m.end():]
    )

    rels_xml = rels_xml.replace(
        "</Relationships>",
        f'<Relationship Id="{new_rid}" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{new_file_num}.xml"/></Relationships>',
    )

    ct_xml = contents["[Content_Types].xml"].decode("utf-8")
    ct_xml = ct_xml.replace(
        "</Types>",
        f'<Override PartName="/xl/worksheets/sheet{new_file_num}.xml" '
        f'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    )
    contents["[Content_Types].xml"] = ct_xml.encode("utf-8")

    # ---- 2. Current Deck Strength: snapshot baselines, then repoint ----
    cds_xml = contents[cds_file].decode("utf-8")
    new_cds_xml, cds_replacements = snapshot_and_repoint_cds(cds_xml, old_sheet, new_sheet, shared_strings)
    contents[cds_file] = new_cds_xml.encode("utf-8")

    # ---- 3. Deck Win Rates + Player Adjusted Ranks: just repoint ----
    dwr_xml = contents[dwr_file].decode("utf-8")
    new_dwr_xml, dwr_replacements = repoint_sheet_refs(dwr_xml, old_sheet, new_sheet)
    contents[dwr_file] = new_dwr_xml.encode("utf-8")

    par_xml = contents[par_file].decode("utf-8")
    new_par_xml, par_replacements = repoint_sheet_refs(par_xml, old_sheet, new_sheet)
    contents[par_file] = new_par_xml.encode("utf-8")

    contents["xl/workbook.xml"] = workbook_xml.encode("utf-8")
    contents["xl/_rels/workbook.xml.rels"] = rels_xml.encode("utf-8")

    tmp_path = str(XLSX_PATH) + ".tmp"
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zout.writestr(i, contents[i.filename])
        zout.writestr(new_log_file, contents[new_log_file])
    shutil.move(tmp_path, XLSX_PATH)

    # ---- 4. update code constants ----
    app_js = APP_JS_PATH.read_text(encoding="utf-8")
    old_const = f'const CURRENT_SEASON_SHEET = "{old_sheet}";'
    new_const = f'const CURRENT_SEASON_SHEET = "{new_sheet}";'
    if old_const not in app_js:
        raise RuntimeError(f"Couldn't find {old_const!r} in app.js -- update it manually.")
    APP_JS_PATH.write_text(app_js.replace(old_const, new_const), encoding="utf-8")

    season_config = SEASON_CONFIG_PATH.read_text(encoding="utf-8")
    old_py_const = f'CURRENT_SEASON_SHEET = "{old_sheet}"'
    new_py_const = f'CURRENT_SEASON_SHEET = "{new_sheet}"'
    if old_py_const not in season_config:
        raise RuntimeError(f"Couldn't find {old_py_const!r} in season_config.py -- update it manually.")
    SEASON_CONFIG_PATH.write_text(season_config.replace(old_py_const, new_py_const), encoding="utf-8")

    print(f'Rolled over from "{old_sheet}" to "{new_sheet}".')
    print(f"  New Game Log tab: {new_log_file} (sheetId={new_sheet_id}, {new_rid})")
    print(f"  Current Deck Strength: {cds_replacements} formula(s) repointed")
    print(f"  Deck Win Rates: {dwr_replacements} formula(s) repointed")
    print(f"  Player Adjusted Ranks: {par_replacements} formula(s) repointed")
    print("  app.js and scripts/season_config.py updated.")
    print()
    print("Next: commit + push, then trigger the \"Recalculate Spreadsheet\" GitHub Actions workflow.")
    print("relay.js needs no change -- it already discovers the active league dynamically from playgroup.gg.")


if __name__ == "__main__":
    main()

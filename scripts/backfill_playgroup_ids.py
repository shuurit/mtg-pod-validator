"""
Backfills column E ("Playgroup Deck ID") onto every existing deck row in
Current Deck Strength, by matching each row against the real playgroup.gg
deck list. Fetched via the deployed Worker's GET /roster-diff endpoint
(which already resolves each member to a tracked player name using
relay.js's own USERNAME_TO_PLAYER) rather than calling playgroup.gg
directly -- this script has no PLAYGROUP_API_KEY of its own to do that.

Usage:
    python scripts/backfill_playgroup_ids.py                    # dry run, report only
    python scripts/backfill_playgroup_ids.py --apply             # write column E
    python scripts/backfill_playgroup_ids.py --apply --overrides overrides.json

Matching is scoped per player (so two different players' same-named decks,
like the two "Killian, Decisive Mentor" rows, never get compared against
each other) using the same name-normalization app.js's findDefaultStrength
already uses client-side: lowercase, split on [,/], take the first segment,
trim. More than one candidate at any tier is never guessed -- it's reported
as ambiguous and needs either an --overrides entry or manual review.

overrides.json shape: {"Player::Deck Row Label": 123456, ...}
"""
import argparse
import json
import re
import shutil
import sys
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

from add_deck import ROW_RE, cell_a_label, is_header_row, load_shared_strings

ROSTER_DIFF_URL = "https://mtg-pod-validator-relay.mattdomi18.workers.dev/roster-diff"
XLSX_PATH = Path(__file__).parent.parent / "deck-strength.xlsx"
CDS_SHEET_FILE = "xl/worksheets/sheet4.xml"


def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def strip_accents(s):
    # playgroup.gg stores some commander names with real accents (Eowyn ->
    # Éowyn, Kennerud -> Kennerüd) that the spreadsheet's plain-ASCII rows
    # don't have -- fold both sides to bare ASCII before comparing.
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def normalize(name):
    folded = strip_accents((name or "").lower())
    return re.split(r"[,/]", folded)[0].strip()


def fetch_roster_diff():
    # Cloudflare blocks urllib's default User-Agent (403) -- anything
    # normal-looking works fine, matching how curl already succeeds against
    # this same Worker elsewhere in this project's tooling.
    req = urllib.request.Request(ROSTER_DIFF_URL, headers={"User-Agent": "mtg-pod-validator-backfill-script"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def walk_player_blocks(sheet_xml, shared_strings):
    """{player_name: [(row_num, deck_label), ...]} for every deck row,
    grouped under whichever player header most recently preceded it."""
    blocks = {}
    current_player = None
    for m in ROW_RE.finditer(sheet_xml):
        row_num = int(m.group(1))
        inner = m.group(3)
        if row_num == 1:
            continue
        label = cell_a_label(inner, row_num, shared_strings)
        if is_header_row(inner, row_num, True):
            current_player = label
            blocks.setdefault(current_player, [])
        elif current_player is not None:
            blocks.setdefault(current_player, []).append((row_num, label))
    return blocks


def match_player_decks(player, sheet_rows, playgroup_decks, overrides):
    """Returns {row_num: (status, detail)} where status is one of
    'matched'/'ambiguous'/'unmatched', and detail is the ID (matched),
    a list of candidate IDs (ambiguous), or None (unmatched)."""
    # pool[normalized_commander] -> list of deck dicts still unclaimed
    pool = {}
    for deck in playgroup_decks:
        key = normalize(deck["commander_name"])
        pool.setdefault(key, []).append(deck)

    results = {}
    for row_num, label in sheet_rows:
        override_key = f"{player}::{label}"
        if override_key in overrides:
            results[row_num] = ("matched", overrides[override_key])
            continue

        norm_label = normalize(label)
        candidates = pool.get(norm_label, [])
        if not candidates:
            candidates = [
                d for decks in pool.values() for d in decks
                if normalize(d["commander_name"]).startswith(norm_label)
                or norm_label.startswith(normalize(d["commander_name"]))
            ]

        if len(candidates) > 1:
            # Not a guess: an archived deck is a deck the player explicitly
            # marked retired, so if exactly one candidate is still active,
            # that's a real signal, not an arbitrary tiebreak.
            active = [d for d in candidates if not d["archived"]]
            if len(active) == 1:
                candidates = active

        if len(candidates) == 1:
            deck = candidates[0]
            results[row_num] = ("matched", deck["id"])
            key = normalize(deck["commander_name"])
            pool[key] = [d for d in pool.get(key, []) if d["id"] != deck["id"]]
        elif len(candidates) > 1:
            results[row_num] = ("ambiguous", [d["id"] for d in candidates])
        else:
            results[row_num] = ("unmatched", None)

    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write column E (default is dry-run report only)")
    parser.add_argument("--overrides", type=str, default=None, help="path to a JSON overrides file")
    args = parser.parse_args()

    overrides = {}
    if args.overrides:
        overrides = json.loads(Path(args.overrides).read_text(encoding="utf-8"))

    print(f"Fetching roster + decks from {ROSTER_DIFF_URL} ...")
    roster = fetch_roster_diff()
    decks_by_username = roster["decks_by_username"]
    tracked_members = [m for m in roster["members"] if m["tracked"]]
    print(f"{len(tracked_members)} tracked player(s) found.\n")

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    shared_strings = load_shared_strings(contents)
    cds_xml = contents[CDS_SHEET_FILE].decode("utf-8")
    blocks = walk_player_blocks(cds_xml, shared_strings)

    all_results = {}  # row_num -> (status, detail, player, label)
    for member in tracked_members:
        player = member["mapped_player"]
        sheet_rows = blocks.get(player, [])
        playgroup_decks = decks_by_username.get(member["username"], [])
        results = match_player_decks(player, sheet_rows, playgroup_decks, overrides)
        for row_num, (status, detail) in results.items():
            label = dict(sheet_rows)[row_num]
            all_results[row_num] = (status, detail, player, label)

    matched = {r: v for r, v in all_results.items() if v[0] == "matched"}
    ambiguous = {r: v for r, v in all_results.items() if v[0] == "ambiguous"}
    unmatched = {r: v for r, v in all_results.items() if v[0] == "unmatched"}

    print(f"Matched:   {len(matched)}")
    print(f"Ambiguous: {len(ambiguous)}")
    print(f"Unmatched: {len(unmatched)}")
    print()

    if ambiguous:
        print("--- AMBIGUOUS (needs an --overrides entry, not guessed) ---")
        for row_num, (_, ids, player, label) in sorted(ambiguous.items()):
            print(f'  row {row_num}: {player} / "{label}" -> candidates {ids}')
        print()

    if unmatched:
        print("--- UNMATCHED (no playgroup deck found for this player+name) ---")
        for row_num, (_, _, player, label) in sorted(unmatched.items()):
            print(f'  row {row_num}: {player} / "{label}"')
        print()

    if not args.apply:
        print("Dry run only -- no changes written. Re-run with --apply once ambiguous/unmatched rows are resolved (or accepted as-is).")
        return

    # ---- apply: write column E ----
    a_style_m = re.search(r'<c r="A2"[^>]*s="(\d+)"', cds_xml)
    if not a_style_m:
        raise RuntimeError("Could not find A2's style id to reuse for column E")
    e_style = a_style_m.group(1)

    def add_e_cell(m):
        row_num = int(m.group(1))
        attrs, inner = m.group(2), m.group(3)
        if row_num == 1:
            new_inner = inner + f'<c r="E1" s="{e_style}" t="inlineStr"><is><t>Playgroup Deck ID</t></is></c>'
            new_attrs = attrs.replace('spans="1:4"', 'spans="1:5"')
            return f'<row r="1"{new_attrs}>{new_inner}</row>'
        if row_num in matched:
            deck_id = matched[row_num][1]
            new_inner = inner + f'<c r="E{row_num}" s="{e_style}" t="inlineStr"><is><t>{xml_escape(str(deck_id))}</t></is></c>'
            new_attrs = attrs.replace('spans="1:4"', 'spans="1:5"')
            return f'<row r="{row_num}"{new_attrs}>{new_inner}</row>'
        return m.group(0)

    new_cds_xml = ROW_RE.sub(add_e_cell, cds_xml)
    new_cds_xml = re.sub(r'<dimension ref="A1:D(\d+)"/>', r'<dimension ref="A1:E\1"/>', new_cds_xml)
    contents[CDS_SHEET_FILE] = new_cds_xml.encode("utf-8")

    tmp_path = str(XLSX_PATH) + ".tmp"
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zout.writestr(i, contents[i.filename])
    shutil.move(tmp_path, XLSX_PATH)

    print(f"Wrote {len(matched)} playgroup deck ID(s) into column E.")
    print("Ambiguous/unmatched rows were left blank -- safe, computeRosterDiff falls back to name matching for those.")


if __name__ == "__main__":
    main()

"""
Batch equivalent of add_game.py, for the "Update the App" roster flow: adds
any number of new players and/or new decks for existing players in one
pass, then recalculates once. Reuses add_player.py's and add_deck.py's own
row-building functions rather than reimplementing them -- this script is
just the batch/validation/orchestration layer on top.

Also updates cloudflare-worker/relay.js's USERNAME_TO_PLAYER for any new
players, since that's the only place a playgroup.gg username maps to a
tracked display name.

Expects the payload as JSON in the ROSTER_PAYLOAD environment variable:
{
  "newPlayers": [
    {"username": "Hiccup_The_Hero", "displayName": "Alex", "decks": [
      {"name": "Aragorn, the Uniter", "power": 3.2, "playgroupDeckId": 763457}
    ]}
  ],
  "newDecksForExisting": [
    {"player": "Manny", "name": "Krenko, Mob Boss", "power": 3.2, "playgroupDeckId": 744135}
  ]
}
Both arrays are optional (omit or empty if there's nothing of that kind in
this batch), but at least one must have something.
"""
import json
import os
import re
import zipfile
from pathlib import Path

from add_deck import load_shared_strings, process_cds as deck_process_cds, process_dwr as deck_process_dwr
from add_player import (
    append_to_sheet,
    cds_rows_xml,
    dwr_rows_xml,
    existing_player_names,
    last_row_of,
    normalize_decks,
    row_styles,
)
from xlsx_recalc import recalc

REPO_ROOT = Path(__file__).parent.parent
XLSX_PATH = REPO_ROOT / "deck-strength.xlsx"
RELAY_JS_PATH = REPO_ROOT / "cloudflare-worker" / "relay.js"
CDS_SHEET_FILE = "xl/worksheets/sheet4.xml"
DWR_SHEET_FILE = "xl/worksheets/sheet5.xml"

MIN_SANE_POWER = 0
MAX_SANE_POWER = 10


def validate_payload(payload, existing_players):
    new_players = payload.get("newPlayers", [])
    new_decks = payload.get("newDecksForExisting", [])
    if not new_players and not new_decks:
        raise ValueError("Payload has neither newPlayers nor newDecksForExisting -- nothing to do.")

    seen_display_names = set(existing_players)
    seen_usernames = set()
    for p in new_players:
        if not p.get("username") or not p.get("displayName"):
            raise ValueError(f"newPlayers entry missing username/displayName: {p}")
        if p["displayName"] in seen_display_names:
            raise ValueError(f'Display name "{p["displayName"]}" already exists (existing player or duplicate in this batch).')
        if p["username"] in seen_usernames:
            raise ValueError(f'Username "{p["username"]}" appears twice in this batch.')
        seen_display_names.add(p["displayName"])
        seen_usernames.add(p["username"])
        if not p.get("decks"):
            raise ValueError(f'New player "{p["displayName"]}" has no decks.')
        for d in p["decks"]:
            _validate_deck_entry(d, p["displayName"])

    for d in new_decks:
        if not d.get("player"):
            raise ValueError(f"newDecksForExisting entry missing player: {d}")
        _validate_deck_entry(d, d["player"])

    return new_players, new_decks


def _validate_deck_entry(d, player_label):
    if not d.get("name"):
        raise ValueError(f'Deck for {player_label} missing a name: {d}')
    power = d.get("power")
    if not isinstance(power, (int, float)) or not (MIN_SANE_POWER <= power <= MAX_SANE_POWER):
        raise ValueError(f'Deck "{d.get("name")}" for {player_label} has an invalid power value: {power!r}')


def apply_new_players(cds_xml, dwr_xml, new_players):
    for p in new_players:
        decks = normalize_decks([[d["name"], d["power"], d.get("playgroupDeckId")] for d in p["decks"]])
        cds_start = last_row_of(cds_xml) + 1
        dwr_start = last_row_of(dwr_xml) + 1
        if cds_start != dwr_start:
            raise RuntimeError("Current Deck Strength and Deck Win Rates are out of sync mid-batch.")

        cds_player_style = row_styles(cds_xml, 2, "ABC")
        cds_deck_style = row_styles(cds_xml, 3, "ABCDE")
        dwr_player_style = row_styles(dwr_xml, 2, "ABCD")
        dwr_deck_style = row_styles(dwr_xml, 3, "ABCD")

        cds_rows, cds_end = cds_rows_xml(p["displayName"], decks, cds_start, cds_player_style, cds_deck_style)
        dwr_rows, dwr_end = dwr_rows_xml(p["displayName"], decks, dwr_start, dwr_player_style, dwr_deck_style)

        cds_xml = append_to_sheet(cds_xml, cds_rows, cds_end, "E")
        dwr_xml = append_to_sheet(dwr_xml, dwr_rows, dwr_end, "D")
        print(f'  + player {p["displayName"]} ({len(decks)} deck(s)) at rows {cds_start}-{cds_end}')
    return cds_xml, dwr_xml


def apply_new_decks(cds_xml, dwr_xml, new_decks, shared_strings):
    for d in new_decks:
        cds_xml, insertion_point = deck_process_cds(
            cds_xml, d["player"], d["name"], d["power"], d.get("playgroupDeckId"), shared_strings
        )
        dwr_xml = deck_process_dwr(dwr_xml, d["player"], d["name"], insertion_point, shared_strings)
        print(f'  + deck "{d["name"]}" for {d["player"]} at row {insertion_point}')
    return cds_xml, dwr_xml


def update_relay_js(new_players):
    if not new_players:
        return False
    relay_js = RELAY_JS_PATH.read_text(encoding="utf-8")
    map_m = re.search(r"(const USERNAME_TO_PLAYER = \{)(.*?)(\n\};)", relay_js, re.DOTALL)
    if not map_m:
        raise RuntimeError("Could not find USERNAME_TO_PLAYER in relay.js -- update it manually.")
    existing_body = map_m.group(2)

    new_lines = []
    for p in new_players:
        username_js = p["username"].replace("\\", "\\\\").replace('"', '\\"')
        display_js = p["displayName"].replace("\\", "\\\\").replace('"', '\\"')
        if f'"{username_js}"' in existing_body:
            raise ValueError(f'Username "{p["username"]}" is already in USERNAME_TO_PLAYER.')
        new_lines.append(f'  "{username_js}": "{display_js}",')

    updated_body = existing_body.rstrip() + "\n" + "\n".join(new_lines)
    new_relay_js = relay_js[: map_m.start()] + map_m.group(1) + updated_body + map_m.group(3) + relay_js[map_m.end():]

    if new_relay_js.count("{") != new_relay_js.count("}"):
        raise RuntimeError("Brace count mismatch after editing relay.js -- aborting without writing.")

    RELAY_JS_PATH.write_text(new_relay_js, encoding="utf-8")
    return True


def main():
    payload = json.loads(os.environ["ROSTER_PAYLOAD"])

    with zipfile.ZipFile(XLSX_PATH) as zin:
        items = zin.infolist()
        contents = {i.filename: zin.read(i.filename) for i in items}

    shared_strings = load_shared_strings(contents)
    cds_xml = contents[CDS_SHEET_FILE].decode("utf-8")
    dwr_xml = contents[DWR_SHEET_FILE].decode("utf-8")

    existing_players = existing_player_names(cds_xml)
    new_players, new_decks = validate_payload(payload, existing_players)

    print(f"Applying {len(new_players)} new player(s) and {len(new_decks)} new deck(s) for existing players...")
    cds_xml, dwr_xml = apply_new_players(cds_xml, dwr_xml, new_players)
    cds_xml, dwr_xml = apply_new_decks(cds_xml, dwr_xml, new_decks, shared_strings)

    contents[CDS_SHEET_FILE] = cds_xml.encode("utf-8")
    contents[DWR_SHEET_FILE] = dwr_xml.encode("utf-8")

    tmp_path = str(XLSX_PATH) + ".tmp"
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zout.writestr(i, contents[i.filename])
    os.replace(tmp_path, XLSX_PATH)

    relay_changed = update_relay_js(new_players)
    if relay_changed:
        print("Updated cloudflare-worker/relay.js's USERNAME_TO_PLAYER.")

    recalc(XLSX_PATH)


if __name__ == "__main__":
    main()

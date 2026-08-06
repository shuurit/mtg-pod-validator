"""
Standalone recalculation pass over deck-strength.xlsx -- no game payload,
just forces LibreOffice to recompute every formula and refresh every pivot
table, then re-saves. Triggered manually (workflow_dispatch) after any
change made via direct XML surgery (add_player.py, add_deck.py,
season_rollover.py), since those never get a real recalc pass on their own.
"""
import os

from xlsx_recalc import recalc

XLSX_PATH = os.path.join(os.path.dirname(__file__), "..", "deck-strength.xlsx")

if __name__ == "__main__":
    recalc(XLSX_PATH)

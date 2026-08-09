"""
The one place every script needs to know which season is current, and
where the spreadsheet itself lives. Update CURRENT_SEASON_SHEET when
deck-strength.xlsx rolls to a new Game Log tab (see season_rollover.py) --
every script that touches the workbook imports both constants from here,
so nothing drifts out of sync with the others or with app.js's own
CURRENT_SEASON_SHEET constant.
"""
from pathlib import Path

CURRENT_SEASON_SHEET = "Game Log Season 3"
XLSX_PATH = Path(__file__).parent.parent / "deck-strength.xlsx"

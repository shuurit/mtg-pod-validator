"""
The one place every script needs to know which season is current. Update
this single constant when deck-strength.xlsx rolls to a new Game Log tab
(see season_rollover.py) -- add_game.py, add_player.py, and add_deck.py all
import it, so nothing drifts out of sync with the others or with app.js's
own CURRENT_SEASON_SHEET constant.
"""
CURRENT_SEASON_SHEET = "Game Log Season 4"

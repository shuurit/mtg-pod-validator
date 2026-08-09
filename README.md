# Amass a Gathering - App Edition

A small web app for the **Amass a Gathering** Commander/EDH playgroup: check a
pod's power-level spread before a game, and keep the group's tracking
spreadsheet in sync with [playgroup.gg](https://playgroup.gg/tracker) with as
little manual data entry as possible.

**Live app:** https://shuurit.github.io/mtg-pod-validator/

No login, no build step — it's a static site that reads `deck-strength.xlsx`
straight out of this repo and talks to playgroup.gg through a small Cloudflare
Worker relay. Works great "Added to Home Screen" on a phone or tablet.

## The four tabs

- **Deck Strength Validator** — pick who's playing, pick each player's deck,
  and see the pod's power-level spread at a glance before you sit down to
  play. Read-only, synced live from the spreadsheet.
- **Games to Update** — games playgroup.gg knows about that aren't logged in
  the spreadsheet's Game Log yet. Playgroup.gg supplies Player/Commander/
  Result automatically, and now also pre-fills Place/KOs/TOV straight from
  its own event log (still fully editable) — decks strength, pop-off,
  disruptions, recoveries, and "clearly behind" are the only real manual
  entry left.
- **Update the App** — new playgroup.gg members and new decks for existing
  players, detected live and independent of whether a game's been played
  with them yet. Review, set a starting power for anything new, and submit
  once to add it to the spreadsheet. The tab button shows a badge when
  something's pending.
- **Player Win Rates** — playgroup.gg's tracked win rate side-by-side with
  the spreadsheet's own calculated Player Adjusted Win Rate.

## How it fits together

```
playgroup.gg  <--->  Cloudflare Worker relay  <--->  app.js (this site)
                            |
                            v
                  GitHub Actions (on submit)
                            |
                            v
                  deck-strength.xlsx (committed to this repo)
```

- **`deck-strength.xlsx`** is the source of truth for every deck's tracked
  power, win rates, and the full Game Log. The app only ever *reads* it
  directly — every write goes through GitHub Actions instead, so there's
  always a real LibreOffice recalculation pass and a commit history for
  every change.
- **The Cloudflare Worker** (`cloudflare-worker/relay.js`) holds the
  playgroup.gg API key and a GitHub token server-side, so the browser never
  sees either. It reads playgroup.gg live for the app, and fires a
  `repository_dispatch` event at this repo when something needs to be
  written. See `cloudflare-worker/README.md` for endpoint details and setup.
- **GitHub Actions** (`.github/workflows/`) does the actual spreadsheet
  edits — `add-game.yml` for a logged game, `roster-update.yml` for a new
  player/deck, `recalculate.yml` to force a fresh LibreOffice pass. Each one
  runs the matching script in `scripts/` against the `.xlsx` directly (zip +
  XML surgery, not a library resave, since that would strip every cached
  formula value workbook-wide). `post-discord-update.yml` and
  `delete-last-discord-post.yml` are two more, manually-triggered workflows
  for the Discord posting integration below.
- **Discord posting** — `add-game.yml` posts a rankings/deck-strength/
  win-rates summary to Discord (as images, via `scripts/post_to_discord.py`
  and `scripts/discord_report.py`) after every logged game, plus a permanent
  copy to a separate archive channel (`scripts/post_to_discord_archive.py`).
  `discord_last_post.json` tracks the live channel's most recent post so the
  next one can delete-then-repost instead of piling up. See the docstrings
  in `scripts/post_to_discord.py` and `scripts/post_to_discord_archive.py`
  for the two channels' exact behavior.

## Repo layout

- `index.html`, `app.js`, `style.css` — the app itself.
- `deck-strength.xlsx` — the tracked spreadsheet (Game Log, Current Deck
  Strength, Deck Win Rates, Player Adjusted Ranks).
- `cloudflare-worker/` — the relay Worker + its own README.
- `scripts/` — Python scripts that edit `deck-strength.xlsx` directly
  (adding/removing a player or deck, applying a roster-update batch,
  rolling over to a new season, backfilling ID columns on older rows) plus
  the Discord-posting scripts (`discord_report.py`, `discord_common.py`,
  `post_to_discord*.py`, `delete_last_discord_post.py`).
- `.github/workflows/` — `add-game.yml`/`roster-update.yml` run on a
  `repository_dispatch`; `recalculate.yml`, `post-discord-update.yml`, and
  `delete-last-discord-post.yml` are triggered manually
  (`workflow_dispatch`).
- `manifest.json`, `icon-*.png`, `apple-touch-icon.png`,
  `scripts/generate_icons.py` — home-screen icon for "Add to Home Screen"
  on iOS/Android. Rerun the script after swapping `icon-source.png`.
- `bg-*.webp` — one background image per tab, cross-faded on tab switch
  (see the `.tab-bg` rules in `style.css` and `initTabs()` in `app.js`).

## Making changes to the spreadsheet directly

Every script in `scripts/` follows the same pattern: back up
`deck-strength.xlsx` first, run the script, diff the result cell-by-cell
against the backup to confirm only the intended cells changed, then push and
trigger `recalculate.yml` to validate with a real LibreOffice pass before
trusting it. None of them use openpyxl's `.save()` on a live file — that
strips every cached formula value in the whole workbook, not just the
touched cells.

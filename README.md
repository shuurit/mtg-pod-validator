# Amass a Gathering - App Edition

A small web app for the **Amass a Gathering** Commander/EDH playgroup: check a
pod's power-level spread before a game, and keep the group's tracked player/
deck/game data in sync with [playgroup.gg](https://playgroup.gg/tracker) with
as little manual data entry as possible.

**Live app:** https://shuurit.github.io/mtg-pod-validator/

No login, no build step — it's a static site that reads live data through a
small Cloudflare Worker relay backed by a Cloudflare D1 database. Works great
"Added to Home Screen" on a phone or tablet.

## The four tabs

- **Deck Strength Validator** — pick who's playing, pick each player's deck,
  and see the pod's power-level spread at a glance before you sit down to
  play. Read-only, synced live from the database.
- **Games to Update** — games playgroup.gg knows about that aren't logged
  yet. Playgroup.gg supplies Player/Commander/Result automatically, and also
  pre-fills Place/KOs/TOV straight from its own event log (still fully
  editable) — deck strength, pop-off, disruptions, recoveries, and "clearly
  behind" are the only real manual entry left.
- **New Players/Decks** — new playgroup.gg members and new decks for existing
  players, detected live and independent of whether a game's been played
  with them yet. Review, pick a bracket (1–5) for anything new, and submit
  once to add it all. The tab button shows a badge when something's pending.
- **Player Win Rates** — playgroup.gg's tracked win rate side-by-side with
  the app's own calculated Player Adjusted Win Rate.

## How it fits together

```
playgroup.gg  <--->  Cloudflare Worker relay  <--->  app.js (this site)
                            |
                            v
                    Cloudflare D1 database
```

- **Cloudflare D1** (`cloudflare-worker/schema.sql`) is the source of truth
  for every player, deck, game, and game result. Writes land directly —
  submitting a game or adding a player/deck through the app is a normal
  request/response, not a background job; there's no separate recalculation
  step because every computed value is derived either on write (per-game
  formulas) or on read (aggregates like win rates), never cached stale.
- **The Cloudflare Worker** (`cloudflare-worker/relay.js`) holds the
  playgroup.gg API key and a GitHub token server-side, so the browser never
  sees either. It reads and writes D1 directly for the app, reads
  playgroup.gg live, and fires one `repository_dispatch` event (after a
  game is added) to trigger the Discord-posting workflow below — that's the
  only thing GitHub Actions still does for this app. See
  `cloudflare-worker/README.md` for endpoint details and setup.
- **Discord posting** — after a game is submitted, the relay triggers
  `post-discord-live.yml`, which posts a rankings/deck-strength/win-rates
  summary to Discord (as images, via `scripts/post_to_discord.py` and
  `scripts/discord_report.py`, reading live from D1 through the relay),
  plus a permanent copy to a separate archive channel
  (`scripts/post_to_discord_archive.py`). `discord_last_post.json` tracks
  the live channel's most recent post so the next one can delete-then-
  repost instead of piling up. See the docstrings in
  `scripts/post_to_discord.py` and `scripts/post_to_discord_archive.py`
  for the two channels' exact behavior.

## Repo layout

- `index.html`, `app.js`, `style.css` — the app itself.
- `cloudflare-worker/` — the relay Worker, its D1 schema, and its own
  README.
- `deck-strength.xlsx` — the pre-D1 spreadsheet, kept as a frozen
  historical record (see History below). Nothing reads or writes it.
- `scripts/` — the Discord-posting scripts (`discord_report.py`,
  `discord_common.py`, `post_to_discord*.py`, `delete_last_discord_post.py`)
  plus `generate_icons.py` for the home-screen icon.
- `.github/workflows/` — `post-discord-live.yml` runs on a
  `repository_dispatch` fired by the relay after a game is added;
  `post-discord-update.yml` and `delete-last-discord-post.yml` are
  triggered manually (`workflow_dispatch`).
- `manifest.json`, `icon-*.png`, `apple-touch-icon.png`,
  `scripts/generate_icons.py` — home-screen icon for "Add to Home Screen"
  on iOS/Android. Rerun the script after swapping `icon-source.png`.
- `bg-*.webp` — one background image per tab, cross-faded on tab switch
  (see the `.tab-bg` rules in `style.css` and `initTabs()` in `app.js`).

## History

This app originally ran on `deck-strength.xlsx`, edited via GitHub Actions
doing direct XML surgery on the `.xlsx` file (never a library resave, since
that stripped every cached formula value workbook-wide). That pipeline —
and the scripts/workflows it depended on — is gone, fully replaced by the
D1 database above; see git history before this migration if you need them
for reference. `deck-strength.xlsx` itself stays in the repo, untouched, as
a frozen historical record — nothing reads or writes it anymore.

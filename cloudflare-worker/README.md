# mtg-pod-validator relay

This Worker holds two write/read credentials server-side so the browser
never sees either of them, and reads/writes the app's Cloudflare D1
database directly:

- **GITHUB_TOKEN** — fires a `repository_dispatch` event at the repo after
  a game is submitted (`POST /games`), to trigger the Discord-posting
  workflow. Nothing else uses this token; it never touches repo contents
  directly.
- **PLAYGROUP_API_KEY** — reads playgroup.gg live (games, active-league
  membership, and full member/deck rosters) so the app doesn't need a
  manually-regenerated static file.

It also uses a **KV namespace** (`DECK_CACHE`, no secret involved — just
storage), for:

- Remembering which games have already been confirmed as part of the
  active league, so each `/playgroup-games` run only has to check decks
  from games it hasn't classified yet. A game within 3 days of being
  played gets periodically re-verified (at most once per 10 min) instead
  of trusted forever right away, since a human can still reassign or
  remove its league on playgroup.gg after the fact — confirmed both
  directions the hard way. `?recheck=<game_id>` forces one specific game
  to go through classification again immediately.
- Caching playgroup.gg's *active league* itself for 60 seconds
  (`getActiveLeagueId`) — the two playgroup.gg calls this takes measured
  ~1.6s combined in production, and it's called by `/playgroup-games`,
  `/roster-diff`, and `POST /games`' season resolution. The active league
  only actually changes when a season rolls over, weeks apart, so a 60s
  cache window is effectively free correctness-wise for a real ~1.6s
  latency cut on every request that lands within it of another. (60s, not
  a shorter value — Workers KV rejects any `expirationTtl` below 60.)

Neither `/playgroup-games` nor `/roster-diff` cache their *response* at
all (`Cache-Control: no-store`) — both exist specifically to answer "what's
true on playgroup.gg right now," so a cached answer would defeat the
point. The KV caching above is a different thing: it's caching
*expensive-to-derive* data (league classification, the active league
itself), not the response.

## Rate limiting

Every request (any method, any path, before routing) is checked against a
per-IP budget — 20 requests per 15 seconds, tracked via the Cache API
(`caches.default`), not KV, so the limiter itself never eats into the KV
budget it exists to protect. Past the budget, the Worker returns `429` with
a `Retry-After` header instead of doing any work.

This exists because a single client hitting `/playgroup-games` and
`/roster-diff` many times per second — confirmed via Cloudflare's request
log, one IP, sub-second bursts — is enough to blow the KV daily write cap
in minutes even though each individual call is cheap. It's a budget, not a
one-at-a-time lock, so a few players refreshing at once from the same home
network never trips it.

## Endpoints

- `GET /playgroup-games` — live active-league games. Always fresh.
- `GET /roster-diff` — every playgroup member (tracked or not) and their
  full deck list, independent of games played. Powers the "Update the
  App" tab's detection. Always fresh.
- `GET /debug/game?id=<game_id>[&events=true]` — raw pass-through of one
  game exactly as playgroup.gg returns it (no filtering or
  classification). Not used by the main data endpoints above, but *is*
  used by the app's Games to Update tab to pre-fill Place/KOs/TOV from the
  event log — otherwise purely a manual debugging aid.
- `GET /players` — every player and their decks, with each deck's current
  power (most recent logged game's calculated strength, falling back to
  its baseline). What app.js's Deck Strength Validator and Games to Update
  read.
- `GET /games` — one row per player per game, every season's full history,
  every stored formula value. What app.js's Games to Update/Player Win
  Rates read (scoped client-side to the current season).
- `GET /rankings` — Player Adjusted Win Rate per player, scoped to the
  current season. Not currently used by anything (app.js computes it
  client-side instead, since it also needs the same formula for a live
  pre-submit preview) — kept for any future consumer that wants it
  precomputed.
- `GET /deck-win-rates` — games/wins/win-rate per deck, and per player
  (subtotal). Used by the Discord scripts (`scripts/discord_report.py`).
- `POST /games` — logs a game: resolves the season from playgroup.gg's
  *current* active league (never trusted from the client, auto-creating a
  season the first time a league is seen), resolves each participant's
  player/deck by exact name match, computes and stores every per-game
  formula value, then fires the `post-discord` dispatch (fire-and-forget)
  described below.
- `POST /roster` — adds a new player (with their starting decks) and/or
  new decks for existing players, in one combined write.

## Updating an already-deployed Worker (new code only, no new bindings)

1. Go to https://dash.cloudflare.com → **Workers & Pages** → your Worker
   (`mtg-pod-validator-relay`) → **Edit code**
2. Replace everything with the current contents of `relay.js` from this
   folder → **Deploy**

Or from the command line, from this folder: `npx wrangler deploy`.

That's it for any change that's just new endpoint logic — no new secrets,
no new bindings, same `DECK_CACHE`/`DB` bindings as before.

## Fresh setup (if starting from scratch)

1. **GitHub token**: https://github.com/settings/personal-access-tokens/new
   → Resource owner: your account → Repository access: only
   `mtg-pod-validator` → Permissions → Contents: Read and write → Generate.
2. **playgroup.gg token**: playgroup.gg → Account Settings → API keys →
   create one.
3. **Deploy**: Cloudflare dashboard → Workers & Pages → Create → Worker →
   Start with Hello World → paste in `relay.js` → Deploy.
4. **Secrets**: Worker → Settings → Variables and Secrets → add both
   `GITHUB_TOKEN` and `PLAYGROUP_API_KEY`.
5. **KV namespace**: **Workers & Pages** → **KV** → **Create a namespace**
   (e.g. `mtg-pod-validator-cache`) → bind it to the Worker under
   **Settings** → **Bindings**, variable name exactly `DECK_CACHE`.
6. **D1 database**: `npx wrangler d1 create mtg-pod-validator-db`, bind it
   under **Settings** → **Bindings** as a D1 database, variable name
   exactly `DB`, then apply the schema:
   `npx wrangler d1 execute mtg-pod-validator-db --remote --file=schema.sql`.
7. Copy the Worker's `workers.dev` URL and hand it back so it can be wired
   into `app.js` (`RELAY_BASE_URL`).

## Discord posting after a game is added

`POST /games` fires a `post-discord` `repository_dispatch` after a
successful write (fire-and-forget via `ctx.waitUntil` — it doesn't block
the response, and a dispatch failure doesn't undo the already-written
game). That triggers `.github/workflows/post-discord-live.yml`, which posts
four messages to Discord: a "Season N · Game M" announcement, then a
screenshot each of the player rankings, Current Deck Strength, and Deck
Win Rates (see `scripts/post_to_discord.py` — rendered as images with
matplotlib, not plain text, since a ~74-row wall of text was unreadable in
practice; data read live from this Worker's `/players`, `/games`, and
`/deck-win-rates`, not from a file). Needs one GitHub repo secret:
`SEASON_STAT_WEBHOOK` (Discord: channel → Edit Channel → Integrations →
Webhooks → New Webhook → Copy Webhook URL). Without it, the game still
gets logged either way — only the Discord post fails, silently (logged via
`console.error`, not surfaced to the client).

The channel is meant to always show only the latest game: before posting,
`post_to_discord.py` deletes whatever it posted last time (using the
message IDs saved to `discord_last_post.json`, committed to the repo by
the workflow), then posts the new set and saves their IDs the same way.
To clear the channel entirely without posting a replacement (e.g. to
remove a bad/test post, or tidy up at the end of a season), run the
"Delete Last Discord Post" workflow by hand (Actions tab → select it →
Run workflow, or `gh workflow run delete-last-discord-post.yml`) — it
deletes those four messages and clears the tracking file. A webhook can't
list channel history, so this only works for a post made after this
tracking existed; anything older has to be deleted by hand in Discord.

To (re-)post the current numbers without adding a game (e.g. to refresh
the channel, or recover after the automatic post got interrupted), run the
"Post Discord Update" workflow by hand the same way (`gh workflow run
post-discord-update.yml`) — it runs `post_to_discord.py` directly, which
still deletes whatever was posted last time first.

Every time the live webhook (`SEASON_STAT_WEBHOOK`) gets posted to --
from either workflow -- a second, permanent copy also goes to a separate
archive channel: a "Season N · Game M is now archived" banner and the
same three screenshots, via `scripts/post_to_discord_archive.py`. Nothing
here is ever deleted, so the channel builds up one full record per game
over time. Needs its own secret, `SEASON_ARCHIVE_WEBHOOK`, set up the
same way as `SEASON_STAT_WEBHOOK` but pointed at whichever channel should
hold the archive. Both scripts share their table-building/posting logic
in `scripts/discord_report.py` — they only differ in webhook, banner
text, and whether anything gets deleted first.

The rankings screenshot in the live channel also shows a ▲/▼/– trend
column: whether each player's *rank position* moved compared to what the
standings would be without the most recent game (someone passed them, or
they passed someone) -- not raw score movement, since a player's Player
Adjusted Win Rate can shift for reasons (deck-strength-adjusted
probabilities, pod-size weighting) that don't read as "better/worse" the
way a leaderboard position does. Computed fresh from `GET /games` every
time (see `compute_rank_trend` in `scripts/discord_report.py`) by
re-deriving the Player Adjusted Win Rate formula in Python for every game
except the latest one -- no snapshot file, so re-running the same post
twice never falsely shows everyone as "steady." Live-only; the archive
channel is a permanent per-game record where "since last post" isn't a
meaningful thing to show, so its rankings table has no Trend column.

## Notes on scope

- GitHub doesn't offer a narrower permission than "Contents: write" for
  triggering `repository_dispatch`, so that token technically *could* also
  write files directly via GitHub's API. This Worker's own code only ever
  calls the dispatch endpoint. GitHub Apps support finer-grained
  installation tokens than personal access tokens if you want to shrink
  this further later.
- The playgroup.gg key is scoped by playgroup.gg's own account-level API
  key system — it can read whatever your account can read there.

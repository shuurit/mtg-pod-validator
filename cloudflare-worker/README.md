# mtg-pod-validator relay

This Worker holds two write/read credentials server-side so the browser
never sees either of them:

- **GITHUB_TOKEN** — fires a `repository_dispatch` event at the repo when
  a game is submitted, or when a roster update (new player/deck) is
  submitted. The actual spreadsheet edit runs in GitHub Actions using
  GitHub's own auto-issued token, not this one.
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
- A short-lived dedupe key for `/apply-roster-update` submissions, so an
  accidental double-click or reload within a couple minutes doesn't fire
  the same GitHub Action run twice.

Neither `/playgroup-games` nor `/roster-diff` cache their *response* at
all (`Cache-Control: no-store`) — both exist specifically to answer "what's
true on playgroup.gg right now," so a cached answer would defeat the
point. The KV caching above is a different thing: it's caching the
*expensive-to-derive* league classification, not the response itself.

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
- `POST /` — add-game dispatch (from Games to Update).
- `POST /apply-roster-update` — new-player/new-deck dispatch (from Update
  the App).

## Updating an already-deployed Worker (new code only, no new bindings)

1. Go to https://dash.cloudflare.com → **Workers & Pages** → your Worker
   (`mtg-pod-validator-relay`) → **Edit code**
2. Replace everything with the current contents of `relay.js` from this
   folder → **Deploy**

That's it for any change that's just new endpoint logic — no new secrets,
no new bindings, same `DECK_CACHE` binding as before.

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
6. Copy the Worker's `workers.dev` URL and hand it back so it can be wired
   into `app.js` (`RELAY_BASE_URL`).

## Optional: automatic redeploy when a new player is added

Adding a new player through the "Update the App" tab edits this Worker's
own `USERNAME_TO_PLAYER` map (via `scripts/apply_roster_update.py`), which
means the *deployed* Worker needs to pick up that change too — otherwise
the new player's spreadsheet data is correct but the Worker still won't
recognize their playgroup.gg account. Two ways to handle that:

- **Manual (default until set up)**: after adding a new player, redeploy
  once by hand using the steps above. Everything else about the update
  (spreadsheet rows, IDs) already happened automatically; this is the one
  remaining manual step.
- **Automatic**: `.github/workflows/roster-update.yml` has a conditional
  `wrangler deploy` step that only runs when `relay.js` actually changed
  (i.e. a new player was part of the batch). To make it work:
  1. Get this Worker's real KV namespace ID (dashboard → **KV** → click
     the namespace → copy its ID, or `wrangler kv namespace list` with a
     token) and fill it into `id = ""` in `wrangler.toml`.
  2. Add `account_id = "..."` to `wrangler.toml` (found on the Cloudflare
     dashboard's right sidebar on most pages).
  3. Add two GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (scoped to
     Workers Scripts:Edit + Workers KV Storage:Edit for this account) and
     `CLOUDFLARE_ACCOUNT_ID`.
  4. Do one manual `wrangler deploy` first (locally, with a throwaway
     token) to confirm it doesn't touch the two existing secrets and that
     the KV binding survives — then CI deploys are safe to trust.

## Optional: Discord posting after a game is added

`.github/workflows/add-game.yml` posts four messages to Discord right
after a game is added and the spreadsheet recalculates: a "Season N · Game
M" announcement, then a screenshot each of the player rankings, the full
Current Deck Strength tab, and the full Deck Win Rates tab (see
`scripts/post_to_discord.py` — rendered as images with matplotlib, not
plain text, since a ~74-row wall of text was unreadable in practice).
Needs one GitHub repo secret: `SEASON_STAT_WEBHOOK` (Discord: channel →
Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL).
Without it, the game still gets added and committed either way — only
that last step fails.

The channel is meant to always show only the latest game: before posting,
`post_to_discord.py` deletes whatever it posted last time (using the
message IDs saved to `discord_last_post.json`, committed alongside the
spreadsheet), then posts the new set and saves their IDs the same way.
To clear the channel entirely without posting a replacement (e.g. to
remove a bad/test post, or tidy up at the end of a season), run the
"Delete Last Discord Post" workflow by hand (Actions tab → select it →
Run workflow, or `gh workflow run delete-last-discord-post.yml`) — it
deletes those four messages and clears the tracking file. A webhook can't
list channel history, so this only works for a post made after this
tracking existed; anything older has to be deleted by hand in Discord.

To (re-)post the current numbers without adding a game (e.g. after a
manual spreadsheet edit, or just to refresh the channel), run the
"Post Discord Update" workflow by hand the same way (`gh workflow run
post-discord-update.yml`) — it runs `post_to_discord.py` directly, which
still deletes whatever was posted last time first.

The same step also posts a second, permanent copy to a separate archive
channel — a "Season N · Game M is now archived" banner and the same three
screenshots, via `scripts/post_to_discord_archive.py`. Nothing here is
ever deleted, so the channel builds up one full record per game over
time. Needs its own secret, `SEASON_ARCHIVE_WEBHOOK`, set up the same way
as `SEASON_STAT_WEBHOOK` but pointed at whichever channel should hold the
archive. Both scripts share their table-building/posting logic in
`scripts/discord_report.py` — they only differ in webhook, banner text,
and whether anything gets deleted first.

The rankings screenshot in the live channel also shows a ▲/▼/– trend
column, comparing each player's Player Adjusted Win Rate against
`discord_rankings_snapshot.json` (the numbers as of the last live post,
also committed alongside the spreadsheet). Only `post_to_discord.py`
reads/writes it — the archive channel is a permanent per-game record, so
a "since last post" trend isn't a meaningful thing to show there, and its
rankings table has no Trend column.

## Notes on scope

- GitHub doesn't offer a narrower permission than "Contents: write" for
  triggering `repository_dispatch`, so that token technically *could* also
  write files directly via GitHub's API. This Worker's own code only ever
  calls the dispatch endpoint. GitHub Apps support finer-grained
  installation tokens than personal access tokens if you want to shrink
  this further later.
- The playgroup.gg key is scoped by playgroup.gg's own account-level API
  key system — it can read whatever your account can read there.

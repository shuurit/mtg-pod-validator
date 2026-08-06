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
storage), for two things:

- Remembering which games have already been confirmed as part of the
  active league, so each `/playgroup-games` run only has to check decks
  from *new* games instead of re-checking the whole season's history.
- A short-lived dedupe key for `/apply-roster-update` submissions, so an
  accidental double-click or reload within a couple minutes doesn't fire
  the same GitHub Action run twice.

## Endpoints

- `GET /playgroup-games` — live active-league games, cached 5 minutes.
- `GET /roster-diff` — every playgroup member (tracked or not) and their
  full deck list, independent of games played. Powers the "Update the
  App" tab's detection. Cached 15 minutes (roster changes are rare).
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

## Notes on scope

- GitHub doesn't offer a narrower permission than "Contents: write" for
  triggering `repository_dispatch`, so that token technically *could* also
  write files directly via GitHub's API. This Worker's own code only ever
  calls the dispatch endpoint. GitHub Apps support finer-grained
  installation tokens than personal access tokens if you want to shrink
  this further later.
- The playgroup.gg key is scoped by playgroup.gg's own account-level API
  key system — it can read whatever your account can read there.

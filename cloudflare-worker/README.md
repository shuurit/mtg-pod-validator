# mtg-pod-validator relay

This Worker holds two write/read credentials server-side so the browser
never sees either of them:

- **GITHUB_TOKEN** — fires a `repository_dispatch` event at the repo when
  a game is submitted. The actual spreadsheet edit runs in GitHub Actions
  using GitHub's own auto-issued token, not this one.
- **PLAYGROUP_API_KEY** — reads playgroup.gg live (games + active-league
  membership) so the app doesn't need a manually-regenerated static file.
  Responses are cached for 5 minutes.

It also uses a **KV namespace** (`DECK_CACHE`, no secret involved — just
storage) to remember which games have already been confirmed as part of
the active league, so each run only has to check decks from *new* games
instead of re-checking the whole season's history every time.

## Updating an already-deployed Worker (new code, new KV binding)

You already have this Worker running with both secrets set. To pick up
the incremental caching fix:

1. Go to https://dash.cloudflare.com → **Workers & Pages** → your Worker
   (`mtg-pod-validator-relay`) → **Edit code**
2. Replace everything with the current contents of `relay.js` from this
   folder → **Deploy**
3. Create the KV namespace (one-time): **Workers & Pages** → **KV** (left
   sidebar) → **Create a namespace** → name it e.g.
   `mtg-pod-validator-cache` → **Add**
4. Bind it to the Worker: your Worker → **Settings** → **Bindings** →
   **Add** → **KV Namespace**
   - Variable name: exactly `DECK_CACHE`
   - KV namespace: the one you just created
   - Save (this redeploys the Worker with the binding attached)
5. That's it — no URL change, no app changes, no new secret. The first
   request after this may be slightly slower (or show a smaller "Games to
   Update" list than expected) while it classifies the season's existing
   games for the first time; after that it stays fast since it's only
   ever checking what's new.

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
5. **KV namespace**: follow steps 3-4 under "Updating an already-deployed
   Worker" above to create and bind `DECK_CACHE`.
6. Copy the Worker's `workers.dev` URL and hand it back so it can be wired
   into `app.js` (`RELAY_BASE_URL`).

## Notes on scope

- GitHub doesn't offer a narrower permission than "Contents: write" for
  triggering `repository_dispatch`, so that token technically *could* also
  write files directly via GitHub's API. This Worker's own code only ever
  calls the dispatch endpoint. GitHub Apps support finer-grained
  installation tokens than personal access tokens if you want to shrink
  this further later.
- The playgroup.gg key is scoped by playgroup.gg's own account-level API
  key system — it can read whatever your account can read there.

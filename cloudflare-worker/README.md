# mtg-pod-validator relay

This Worker holds two write/read credentials server-side so the browser
never sees either of them:

- **GITHUB_TOKEN** — fires a `repository_dispatch` event at the repo when
  a game is submitted. The actual spreadsheet edit runs in GitHub Actions
  using GitHub's own auto-issued token, not this one.
- **PLAYGROUP_API_KEY** — reads playgroup.gg live (games + active-league
  membership) so the app doesn't need a manually-regenerated static file.
  Responses are cached for 5 minutes.

## Updating an already-deployed Worker (new code, new secret)

You already have this Worker running with `GITHUB_TOKEN` set. To add live
playgroup.gg data:

1. Go to https://dash.cloudflare.com → **Workers & Pages** → your Worker
   (`mtg-pod-validator-relay`) → **Edit code**
2. Replace everything with the current contents of `relay.js` from this
   folder → **Deploy**
3. Go to **Settings** → **Variables and Secrets** → **Add**
   - Name: exactly `PLAYGROUP_API_KEY`
   - Type: **Secret**
   - Value: your playgroup.gg API key (Account Settings → API keys on
     playgroup.gg — reuse the one you already generated, or make a new
     one if you don't have it handy anymore)
   - Save
4. That's it — no URL change, no app changes needed on your end. The
   existing `GITHUB_TOKEN` secret is untouched.

## Fresh setup (if starting from scratch)

1. **GitHub token**: https://github.com/settings/personal-access-tokens/new
   → Resource owner: your account → Repository access: only
   `mtg-pod-validator` → Permissions → Contents: Read and write → Generate.
2. **playgroup.gg token**: playgroup.gg → Account Settings → API keys →
   create one.
3. **Deploy**: Cloudflare dashboard → Workers & Pages → Create → Worker →
   Start with Hello World → paste in `relay.js` → Deploy.
4. **Secrets**: Worker → Settings → Variables and Secrets → add both
   `GITHUB_TOKEN` and `PLAYGROUP_API_KEY` as above.
5. Copy the Worker's `workers.dev` URL and hand it back so it can be wired
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

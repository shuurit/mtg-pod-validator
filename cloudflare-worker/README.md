# Games to Update relay

This Worker is the only piece of this pipeline that touches a GitHub write
credential. It does one thing: takes a game payload from the app and fires
a `repository_dispatch` event at the repo. The actual spreadsheet edit runs
in GitHub Actions using GitHub's own auto-issued token, not this one.

## 1. Create the GitHub token

1. Go to https://github.com/settings/personal-access-tokens/new
2. **Resource owner**: your account
3. **Repository access**: "Only select repositories" → `mtg-pod-validator`
4. **Permissions** → Repository permissions → **Contents**: Read and write
   (this is the permission GitHub requires to fire a `repository_dispatch`
   event — it's scoped to this one repo only, not your whole account)
5. Generate, copy the token (starts with `github_pat_...`) — you won't see
   it again.

## 2. Deploy the Worker

From this folder:

```bash
npx wrangler login       # opens a browser to authorize your Cloudflare account
npx wrangler deploy
```

This publishes the Worker and prints its URL, something like:
`https://mtg-pod-validator-relay.<your-subdomain>.workers.dev`

## 3. Set the secret

```bash
npx wrangler secret put GITHUB_TOKEN
```

Paste the token from step 1 when prompted. It's stored encrypted by
Cloudflare and is never visible in the Worker's source or in any client
request — the browser never sees it.

## 4. Give the Worker URL back

The app needs the Worker's URL to know where to POST. Once deployed, hand
the printed `workers.dev` URL over so it can be wired into `app.js`.

## Note on scope

GitHub doesn't offer a narrower permission than "Contents: write" for
triggering `repository_dispatch`, so this token technically *could* also
write files directly via GitHub's API. In practice this Worker's own code
only ever calls the dispatch endpoint — but if you want to shrink the blast
radius further later, GitHub Apps support finer-grained installation tokens
than personal access tokens do.

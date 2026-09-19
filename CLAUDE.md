# CLAUDE.md

## Merging to master does not deploy the relay Worker

There is no CI that deploys `cloudflare-worker/relay.js` on push/merge to
`master`. A PR merged on GitHub only updates the repo — the live Cloudflare
Worker (`mtg-pod-validator-relay`) keeps running whatever was last deployed
by hand, however old that is, until someone actually runs the deploy step.

Confirmed the hard way on 2026-09-19: PR #8 (scoping `/deck-win-rates` to
the current season, merged 2026-09-19) sat merged for 5 days without being
deployed — the Worker's last deploy before that was 2026-09-14 — so the bug
it fixed kept reproducing live the whole time even though the fix was
sitting right there in `master`. Checked and ruled out first before
re-debugging the actual query logic; check this first next time too,
`npx wrangler deployments list` from `cloudflare-worker/` shows the real
deploy history regardless of what git says.

**After merging any change to `cloudflare-worker/relay.js` (your own or a
PR from elsewhere), deploy it for real:**

```bash
cd cloudflare-worker
npx wrangler deploy
```

Verify the deploy actually landed with `npx wrangler deployments list`
(the top entry's timestamp should be recent) before considering a fix
"live" — a successful `git merge`/`git pull` is not evidence of that.

See `cloudflare-worker/README.md`'s "Updating an already-deployed Worker"
section for the full deploy instructions, including the dashboard-based
alternative.

/**
 * Relay Worker for mtg-pod-validator.
 *
 * Two secrets, each used for exactly one thing:
 *
 * - GET  /playgroup-games -> PLAYGROUP_API_KEY: reads playgroup.gg on the
 *   app's behalf. playgroup.gg has no league field on a game, so active-
 *   league membership is only knowable via a deck's league-scoped ELO
 *   history. Checking every deck ever played (40-70+ and growing every
 *   season) would blow Workers' 50-subrequest limit, and a pure date
 *   cutoff is NOT safe -- confirmed the hard way: casual pickup games with
 *   no league at all can fall inside the season's date range.
 *
 *   So a game's classification (in the active league, or not) is cached in
 *   Workers KV under the active league's ID -- old games are trusted
 *   forever once classified, but a game within RECLASSIFY_WINDOW_MS of
 *   being played gets periodically re-verified (see computePlaygroupGames),
 *   since a human can still reassign or remove its league on playgroup.gg
 *   after the fact. Every run only has to classify/re-verify games in that
 *   small recent set, which after the first few runs is normally just
 *   "whatever was played or corrected since the last check" (usually
 *   0-a few games), not the whole season's history. A hard per-run cap
 *   still protects the subrequest limit during the initial catch-up (or if
 *   a lot happened at once) -- anything left over just gets classified on
 *   the next run.
 *
 *   Commander names (not present on the game/participation payload) are
 *   cached the same way, with a soft expiry, since a deck's commander can
 *   change over time in a way league membership never does.
 *
 *   "Which playgroup.gg accounts map to which tracked player" is read live
 *   from D1's players.playgroup_user_id column (getUserIdToPlayerMap) --
 *   keyed by playgroup.gg's numeric user id, not username, since a
 *   username can change (confirmed the hard way -- a real rename broke
 *   every username-keyed lookup silently). A player written via
 *   POST /roster is picked up on the very next request here, no separate
 *   manual step or redeploy needed. The response's known_players field
 *   carries that out to app.js, so nothing else needs a matching code
 *   change.
 *
 * - GET  /roster-diff -> PLAYGROUP_API_KEY: returns every playgroup member
 *   (not just tracked ones) and every member's full deck list, independent
 *   of games played -- lets the app detect a new player or new deck the
 *   moment it exists on playgroup.gg, not just after a game gets logged.
 *   This Worker doesn't diff anything itself -- same division of labor as
 *   /playgroup-games: raw playgroup.gg data here, comparison against
 *   what's already in D1 happens client-side in app.js.
 *
 * - GET  /debug/game?id=<game_id>[&events=true] -> PLAYGROUP_API_KEY: raw
 *   pass-through of one game exactly as playgroup.gg returns it, no
 *   filtering or classification. Not used by the app -- a manual
 *   debugging aid for inspecting a specific game.
 *
 * - GET  /players, /games, /rankings, /deck-win-rates -> DB (D1): reads
 *   from the D1 database that replaced deck-strength.xlsx as this app's
 *   source of truth (see cloudflare-worker/schema.sql). app.js reads
 *   /players and /games directly; /rankings and /deck-win-rates exist for
 *   other consumers (Discord scripts use /deck-win-rates; /rankings is
 *   currently unused -- and unlike the others, unscoped by season, so
 *   don't reach for it without fixing that first if something ever does).
 *
 * - POST /games, POST /roster -> DB (D1) + GITHUB_TOKEN: app.js's actual
 *   submit paths (Games to Update / Update the App) -- writes straight to
 *   D1, no GitHub Actions round trip. (An earlier version of this Worker
 *   wrote by dispatching a repository_dispatch event to GitHub Actions,
 *   which edited deck-strength.xlsx directly; that whole pipeline, and
 *   the scripts/workflows it depended on, is gone -- see git history if
 *   you need it.) POST /games resolves the season from playgroup.gg's
 *   *current* active league itself (never trusted from the client),
 *   auto-creating one the first time a league is seen -- starting a new
 *   league in playgroup.gg is what starts a new season here, the moment
 *   its first game is submitted, no separate manual step. After a
 *   successful write, it also fires a "post-discord" repository_dispatch
 *   (best-effort, see dispatchGithubEvent) that triggers
 *   post-discord-live.yml, which reads the new game straight back out of
 *   D1 and posts the rankings/deck-strength/win-rate screenshots -- see
 *   scripts/discord_report.py.
 *
 * - POST /seasons/close, on an actual (non-idempotent-repeat) close, also
 *   best-effort fires a "Season X Winners" Discord announcement -- see
 *   announceSeasonWinners. Rather than holding its own copy of a Discord
 *   bot token, this Worker calls a narrow, shared-secret-gated endpoint
 *   (SEASON_ANNOUNCE_API_KEY) on the separate archidekt-trading-app
 *   Worker, which already owns the real bot token ("Tonk Tonk").
 *
 * - Every route requires a valid Discord session (see requireSession)
 *   except the three that manage the session itself: GET
 *   /auth/discord/callback -> DISCORD_CLIENT_SECRET completes the OAuth
 *   handshake app.js starts by sending the browser to Discord's own
 *   /oauth2/authorize (see DISCORD_CLIENT_ID) -- exchanges the returned
 *   code for a Discord identity, matches it against players.discord_user_id
 *   (linked manually per player, not self-serve), and mints a session
 *   token in DECK_CACHE; POST /auth/logout invalidates one; GET /auth/me
 *   lets app.js confirm a stored token's still good. This is checked once
 *   in the fetch handler's dispatcher, not per-route, so a signed-out
 *   request never reaches any handler -- including reads (GET /players,
 *   /games, etc.), not just writes. A signed-in pod member can write any
 *   of the five write endpoints for any deck/player, not just their own;
 *   there's no per-owner restriction on shared pod data. The one
 *   own-player-only write is POST /trophy-case/pins, which only ever sets
 *   the caller's own pinned trophies. One narrow exception: GET
 *   /players, /games, and /deck-win-rates also accept an X-Internal-Key
 *   header matching INTERNAL_API_KEY in place of a session -- that's
 *   scripts/discord_report.py calling in from GitHub Actions
 *   (post-discord-live.yml), which has no Discord account of its own.
 *
 * Deploy with: wrangler deploy
 * Secrets:     wrangler secret put GITHUB_TOKEN
 *              wrangler secret put PLAYGROUP_API_KEY
 *              wrangler secret put DISCORD_CLIENT_SECRET
 *              wrangler secret put INTERNAL_API_KEY
 *              wrangler secret put SEASON_ANNOUNCE_API_KEY
 * Bindings:    KV namespace bound as DECK_CACHE
 *              D1 database bound as DB
 */

const GITHUB_OWNER = "shuurit";
const GITHUB_REPO = "mtg-pod-validator";
const ALLOWED_ORIGIN = "https://shuurit.github.io";

// Base URL for the separate archidekt-trading-app Worker's Tonk Tonk bot --
// see announceSeasonWinners below. Cross-Worker call, not a shared bot
// token: keeps DISCORD_BOT_TOKEN in exactly one place (that repo's own
// Worker) and grants this app only a narrow "post this one message"
// capability via SEASON_ANNOUNCE_API_KEY -- same reasoning INTERNAL_API_KEY
// already established for the opposite direction (scripts/discord_report.py
// calling into *this* Worker).
const ARCHIDEKT_TRADING_APP_BASE_URL = "https://archidekt-trading-app.pages.dev";

// A single misbehaving client (confirmed via Cloudflare's request log: one
// IP firing /playgroup-games and /roster-diff repeatedly within the same
// second) can blow the KV daily write budget in minutes even though those
// endpoints are cheap individually -- see computePlaygroupGames. This is a
// per-IP budget, not a "one request at a time" lock, so a few players
// refreshing at once from the same home network never trips it; it only
// stops the kind of many-requests-per-second burst a script produces.
// Cache API (not KV) on purpose -- it doesn't count against the same daily
// operation budget this exists to protect.
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_WINDOW_SECONDS = 15;

const PLAYGROUP_ID = 51996;
const PLAYGROUP_API_BASE = "https://playgroup.gg/api/public/v1";
// Hard per-run caps so a cold cache (or a big backlog) can never exceed
// Workers' 50-subrequest limit. Fixed overhead is 3 calls (/me, playgroups,
// games list), so these two caps must sum to well under 47.
const MAX_DECK_CHECKS_PER_RUN = 32;
const MAX_COMMANDER_LOOKUPS_PER_RUN = 12;
const COMMANDER_NAME_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000; // 21 days

// POST /achievements/backfill's own per-run cap, same reasoning as the two
// above -- each game backfilled is one pgFetch call, well under Workers'
// 50-subrequest limit even on its own, but capped so this stays callable
// again rather than assuming the whole historical backlog always fits in
// one run.
const MAX_EVENT_STATS_BACKFILL_PER_RUN = 30;

// See computePlaygroupGames -- a game's league classification is trusted
// forever once it's older than this, but stays open to correction while
// still within it (re-verified at most once per RECLASSIFY_MIN_INTERVAL_MS).
const RECLASSIFY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const RECLASSIFY_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// /roster-diff: one call for the member list, one more per member for their
// deck list -- unlike league classification this isn't expensive to derive
// (no per-game history needed), just a generous cap. Deliberately
// uncached (see handleRosterDiff) -- this endpoint exists specifically to
// answer "is there anything new on playgroup.gg right now," so a cached
// answer defeats its own purpose. A small playgroup (a handful of members)
// makes this cheap enough to run fresh on every request.
const MAX_MEMBER_DECK_LOOKUPS_PER_RUN = 40;

// getActiveLeagueId's two sequential playgroup.gg calls (/me, then
// /users/{id}/playgroups) measured ~1.6s combined in production --
// dominating the total time of every endpoint that calls it
// (/playgroup-games, /roster-diff, POST /games' resolveSeasonId). The
// active league only actually changes when a season rolls over on
// playgroup.gg's end, weeks apart -- a cache window this short is
// effectively free correctness-wise, while cutting that 1.6s to ~0 for
// any request that lands within it of another. 60s, not the 45s
// originally intended -- Workers KV rejects any expirationTtl below 60
// (confirmed the hard way: every write 400'd, which took down every
// endpoint that calls getActiveLeagueId until this was caught).
const ACTIVE_LEAGUE_CACHE_KEY = "active_league";
const ACTIVE_LEAGUE_CACHE_TTL_SECONDS = 60;

// Discord OAuth sign-in -- see requireSession below. Client ID is public
// (it's part of the login URL app.js sends users to), so it's a plain
// constant here same as PLAYGROUP_ID; the Client Secret never appears in
// this file, only as the DISCORD_CLIENT_SECRET Worker secret, since only
// the token-exchange step (handleDiscordCallback) needs it.
const DISCORD_CLIENT_ID = "1539751888294256721";
const DISCORD_REDIRECT_URI = "https://mtg-pod-validator-relay.mattdomi18.workers.dev/auth/discord/callback";
const APP_URL = "https://shuurit.github.io/mtg-pod-validator/";
// Long-lived on purpose -- this is a small trusted playgroup signing in on
// their own devices, not a public app; the tradeoff is convenience (no
// re-auth every few days) against a stolen/leaked token staying valid
// longer, which is an acceptable trade here. Stored in the same DECK_CACHE
// KV namespace as everything else (see requireSession), just a different
// key prefix -- no new binding needed.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Authorization added alongside Content-Type once write requests
    // started carrying a session bearer token (see requireSession) -- a
    // browser's CORS preflight rejects any request header not explicitly
    // listed here, silently blocking every authenticated write client-side
    // even though the exact same request works fine via curl (which skips
    // CORS preflight entirely -- confirmed the hard way testing this).
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

function pgFetch(path, env) {
  return fetch(`${PLAYGROUP_API_BASE}${path}`, {
    headers: {
      "Authorization": `Bearer ${env.PLAYGROUP_API_KEY}`,
      "User-Agent": "mtg-pod-validator-relay",
    },
  });
}

// Fixed-window counter per client IP, stored in the edge Cache API (keyed
// by a synthetic same-colo URL, never a real route) instead of KV. Not
// perfectly precise -- read-then-write has a small race under concurrent
// requests, and the cache is per-colo rather than globally consistent --
// but neither matters for what this defends against: it only needs to
// notice "way more requests than any real usage pattern, from one IP,
// fast" and start returning 429s, not enforce an exact global count.
//
// The cache key includes the current time bucket (Date.now() divided into
// RATE_LIMIT_WINDOW_SECONDS-wide slots), not just the IP -- an earlier
// version keyed on IP alone and refreshed that single entry's max-age on
// every write, which meant a real, continuously-active client (a person
// actually using the app, or the app's own background refreshes) kept
// re-arming its own TTL faster than it could ever expire, turning a
// 15-second window into an effectively permanent lockout the moment
// traffic ever crossed the threshold once (confirmed the hard way: this
// tripped for a normal deck submission, not a burst). Bucketing by time
// guarantees every IP's count actually returns to 0 at each window
// boundary regardless of how much traffic keeps arriving.
//
// Cloudflare's Cache API only works on Workers reachable through a custom
// domain -- on a plain *.workers.dev deployment like this one currently
// is, cache operations are documented to have no effect, which likely
// means this never actually rate-limits anything right now (fails open
// silently, not something visible in a deploy or a normal request). Fails
// open on an explicit error too, same reasoning as the no-op case: a
// broken or unsupported limiter should never take real traffic down with
// it, it should just stop limiting until a custom domain (or another
// mechanism) restores it.
async function isRateLimited(request, ctx) {
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
    const cache = caches.default;
    const cacheKey = new Request(`https://rate-limit.internal/${ip}/${bucket}`);

    const cached = await cache.match(cacheKey);
    const count = cached ? (await cached.json()).count : 0;

    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify({ count: count + 1 }), {
          headers: { "Cache-Control": `max-age=${RATE_LIMIT_WINDOW_SECONDS}` },
        })
      ).catch(() => {})
    );

    return count + 1 > RATE_LIMIT_MAX_REQUESTS;
  } catch {
    return false;
  }
}

async function kvGetJson(env, key, fallback) {
  const raw = await env.DECK_CACHE.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Every write endpoint's identity check -- reads `Authorization: Bearer
// <token>`, looks up `session:<token>` in the same DECK_CACHE KV namespace
// handleDiscordCallback wrote it into, and returns the stored
// {playerId, discordUserId, username}, or null if the header's missing or
// the token doesn't resolve to anything (never set, or expired past
// SESSION_TTL_SECONDS -- KV's own expirationTtl handles that, nothing here
// needs to check an expiry itself). username here is the Discord display
// name captured at sign-in time (see handleDiscordCallback), not
// players.name -- only playerId is ever used to attribute a write.
async function requireSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return null;
  return kvGetJson(env, `session:${match[1]}`, null);
}

// Fires a GitHub repository_dispatch event. Only one caller now
// (handleGamesWrite's "post-discord" dispatch) -- this used to also
// back the add-game/roster-update GitHub-dispatch endpoints, removed in
// the D1 migration's decommission pass along with the workflows/scripts
// they triggered. Returns null on success, or an error string on
// failure; post-discord treats that as best-effort (see its own
// comment) rather than failing the request.
async function dispatchGithubEvent(env, eventType, payload) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "mtg-pod-validator-relay",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload || {} }),
    }
  );
  if (res.status !== 204) {
    return await res.text();
  }
  return null;
}

// isValidGamePayload/isValidRosterUpdatePayload validate POST /games and
// POST /roster below -- the GitHub-dispatch endpoints these originally
// validated for (POST / and POST /apply-roster-update) are gone (see the
// D1 migration; nothing has called them since app.js's Phase 4 cutover),
// but the D1 write endpoints reuse the same payload shapes app.js already
// builds, so the validators moved over with them rather than being
// duplicated.

function isValidGamePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.date !== "string") return false;
  if (typeof payload.podSize !== "number") return false;
  if (!Array.isArray(payload.participants)) return false;
  if (payload.participants.length !== payload.podSize) return false;
  const requiredFields = [
    "player", "commander", "strength", "result", "place", "knockouts",
    "tov", "popOff", "disruptions", "recoveries", "gamesClearlyBehind", "bracket",
  ];
  return payload.participants.every(p =>
    p && typeof p === "object" && requiredFields.every(f => f in p)
  );
}

function isValidRosterUpdatePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const newPlayers = payload.newPlayers || [];
  const newDecks = payload.newDecksForExisting || [];
  if (!Array.isArray(newPlayers) || !Array.isArray(newDecks)) return false;
  if (newPlayers.length === 0 && newDecks.length === 0) return false;

  const validDeck = d =>
    d && typeof d === "object" && typeof d.name === "string" && d.name && typeof d.power === "number" &&
    (d.potentialBracket4 === undefined || typeof d.potentialBracket4 === "boolean") &&
    (d.colorIdentity === undefined || d.colorIdentity === null || typeof d.colorIdentity === "string");

  const validNewPlayer = p =>
    p && typeof p === "object" &&
    typeof p.username === "string" && p.username &&
    typeof p.displayName === "string" && p.displayName &&
    Array.isArray(p.decks) && p.decks.length > 0 && p.decks.every(validDeck);

  const validExistingDeck = d =>
    d && typeof d === "object" && typeof d.player === "string" && d.player && validDeck(d);

  return newPlayers.every(validNewPlayer) && newDecks.every(validExistingDeck);
}

function isValidBracketPayload(payload) {
  return !!payload && typeof payload === "object" &&
    typeof payload.deckId === "number" &&
    (payload.bracket === null || (Number.isInteger(payload.bracket) && payload.bracket >= 1 && payload.bracket <= 5));
}

function isValidPotentialBracket4Payload(payload) {
  return !!payload && typeof payload === "object" &&
    typeof payload.deckId === "number" && typeof payload.potentialBracket4 === "boolean";
}

// ---------- GET /auth/discord/callback, POST /auth/logout, GET /auth/me ----------
// See requireSession above for how every write endpoint consumes the
// session this mints. app.js never talks to Discord directly beyond
// sending the user to Discord's own /oauth2/authorize URL (public
// client_id, no secret needed for that step) -- everything below is what
// happens when Discord redirects back here with a one-time code.

// Exchanges the one-time `code` Discord just redirected back with for an
// access token (needs DISCORD_CLIENT_SECRET, so this has to happen here,
// never in the browser), looks up that Discord account's id in `players`,
// and either mints a session or reports that no player is linked yet.
// Discord's CDN URL for a user's avatar -- their own upload if they have
// one, else one of Discord's 6 default avatars, deterministically chosen
// per account (never random) so the same signed-out account always shows
// the same default. Two different formulas depending on whether the
// account is on Discord's newer username system (discriminator "0", no
// legacy #1234 tag) or not -- both documented behavior, not a guess.
function discordAvatarUrl(discordUser) {
  if (discordUser.avatar) {
    return `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`;
  }
  const index = discordUser.discriminator && discordUser.discriminator !== "0"
    ? Number(discordUser.discriminator) % 5
    : Number(BigInt(discordUser.id) >> 22n) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// Always redirects back to the app -- there's no useful JSON response to
// give a browser mid-OAuth-redirect, and app.js reads the outcome out of
// the URL fragment on load either way.
async function handleDiscordCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return Response.redirect(`${APP_URL}#auth_error=no_code`, 302);
  }

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) {
    return Response.redirect(`${APP_URL}#auth_error=discord_token_exchange_failed`, 302);
  }
  const { access_token } = await tokenRes.json();

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { "Authorization": `Bearer ${access_token}` },
  });
  if (!meRes.ok) {
    return Response.redirect(`${APP_URL}#auth_error=discord_profile_lookup_failed`, 302);
  }
  const discordUser = await meRes.json();

  const player = await env.DB.prepare("SELECT id, name FROM players WHERE discord_user_id = ?")
    .bind(discordUser.id).first();
  if (!player) {
    // Deliberately not auto-created -- see schema.sql's discord_user_id
    // comment: linking is a manual one-time step for this small, stable
    // group, not self-serve. Someone whose Discord isn't linked yet sees a
    // clear "not linked" state in the app rather than a confusing failure.
    return Response.redirect(`${APP_URL}#auth_error=not_linked`, 302);
  }

  const token = crypto.randomUUID();
  await env.DECK_CACHE.put(
    `session:${token}`,
    JSON.stringify({
      playerId: player.id,
      discordUserId: discordUser.id,
      // The Discord identity, not the tracked app name (player.name) --
      // "Signed in as X" should read as "it's really you," which a Discord
      // display name confirms more directly than the roster name someone
      // else could just as easily be signed in under. global_name is
      // Discord's newer display name, null for accounts that never set
      // one; username (the unique handle) always exists as a fallback.
      username: discordUser.global_name || discordUser.username,
      avatarUrl: discordAvatarUrl(discordUser),
    }),
    { expirationTtl: SESSION_TTL_SECONDS }
  );

  // The fragment (#...), not a query string -- a browser never sends the
  // URL fragment back to any server on subsequent requests, so the session
  // token never ends up in a server access log (GitHub Pages' or anyone
  // else's) the way a ?session=... query param would. app.js reads
  // location.hash once on load and immediately strips it.
  return Response.redirect(`${APP_URL}#session=${token}`, 302);
}

async function handleAuthLogout(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (match) {
    await env.DECK_CACHE.delete(`session:${match[1]}`);
  }
  return jsonResponse({ ok: true }, 200);
}

// Lets app.js confirm a token from localStorage is still good (and show
// "Signed in as X") on load, without waiting for a write to fail with a
// 401 first.
async function handleAuthMe(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ error: "Not signed in" }, 401);
  }
  return jsonResponse({ playerId: session.playerId, username: session.username, avatarUrl: session.avatarUrl }, 200);
}

// ---------- POST /games, POST /roster : D1 writes ----------
// app.js's actual submit paths (Games to Update / Update the App) --
// POST / and POST /apply-roster-update above still exist but nothing
// calls them anymore. See the migration plan doc for the full rationale.

// Direct port of computeGameRowFormulas in app.js -- verified exact
// against the spreadsheet's own cached values earlier this session.
function computeGameRowFormulas({ commanderStrength, otherStrengths, result, podSize, knockouts, place, tov, popOff, disruptions, recoveries, gamesClearlyBehind, bracket }) {
  const J = result - (1 / podSize);
  const K = ((knockouts - ((podSize - 1) / podSize)) - (-5 / 6)) / 5;
  const otherAvg = otherStrengths.length ? otherStrengths.reduce((a, b) => a + b, 0) / (podSize - 1) : 0;
  const L = commanderStrength - otherAvg;
  const M = 0.5 + (L * 0.09);
  const N = ((podSize - (place - 1)) / podSize) * (knockouts !== 0 ? (knockouts + podSize) / podSize : 1);
  const O = (N - (1 / 6)) / (10 / 6);
  const Q = result === 1
    ? (((1 - ((tov - 3) / 15)) * 0.5) + 0.5)
    : ((tov / 18) * 0.5);
  const U = disruptions === 0 ? 1 : (recoveries / disruptions);
  const X = (O * 0.3) + (Q * 0.175) + (popOff * 0.175) + (U * 0.175) + ((1 - gamesClearlyBehind) * 0.175) + bracket;
  return { J, K, L, M, N, O, Q, U, X };
}

// Same normalization as normalizeCommanderName/stripAccents in app.js.
// Ported server-side deliberately, not just trusted from the client: this
// is a write path with real referential-integrity consequences (picking
// the wrong deck_id misattributes a real game's stats forever), and the
// accented-commander LOOKUP mismatch found earlier this session happened
// specifically because nothing enforced this at write time.
function stripAccentsForMatch(s) {
  return (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}
function normalizeCommanderForMatch(s) {
  return stripAccentsForMatch(s || "").toLowerCase().split(/[,/]/)[0].trim();
}

// Resolves which season a new game belongs to, from playgroup.gg's
// *current* active league -- never trusted from the client (see the
// migration plan's Phase 3 season-resolution design). Auto-creates a
// season the first time a league is seen, using the league's own name as
// the label.
async function resolveSeasonId(env) {
  const activeLeague = await getActiveLeagueId(env);
  const leagueId = String(activeLeague.id);

  let row = await env.DB.prepare("SELECT id FROM seasons WHERE playgroup_league_id = ?").bind(leagueId).first();
  if (row) return row.id;

  // INSERT OR IGNORE + re-SELECT rather than a plain INSERT: two
  // near-simultaneous first-games-of-a-new-league would otherwise race to
  // create two season rows. The unique index on playgroup_league_id makes
  // the loser of that race a no-op instead of an error, and both requests
  // resolve to the same season either way.
  await env.DB.prepare("INSERT OR IGNORE INTO seasons (label, playgroup_league_id) VALUES (?, ?)")
    .bind(activeLeague.name, leagueId).run();
  row = await env.DB.prepare("SELECT id FROM seasons WHERE playgroup_league_id = ?").bind(leagueId).first();
  if (row) return row.id;

  // Still no row for this league_id -- the INSERT OR IGNORE didn't no-op
  // on the playgroup_league_id race it was built for, it silently no-op'd
  // on seasons.label instead: label is ALSO unique (see schema.sql), and
  // playgroup.gg's league name is human-chosen free text, so a different
  // league reusing an old name is possible. Not safe to guess through --
  // fail loud with enough detail to actually fix it.
  const labelClash = await env.DB.prepare("SELECT id, playgroup_league_id FROM seasons WHERE label = ?")
    .bind(activeLeague.name).first();
  if (labelClash) {
    throw new Error(
      `playgroup.gg's active league is named "${activeLeague.name}", which already exists as a season here ` +
      `(id ${labelClash.id}) attached to a different league (${labelClash.playgroup_league_id ?? "none"}). ` +
      `Rename the league on playgroup.gg, or resolve this by hand in D1.`
    );
  }
  throw new Error(`Failed to resolve or create a season for league ${leagueId} ("${activeLeague.name}").`);
}

// Manually ends the CURRENT season on demand, so the group can have the
// Closing Ceremony whenever THEY decide the season is over, not only when
// playgroup.gg's own active league happens to change. Takes no body and no
// client-supplied season id: "the current season" is resolved the exact
// same way resolveSeasonId resolves it for POST /games, so a stale tab
// holding an old seasonId can never close the wrong one. Idempotent --
// closing an already-closed season is a no-op 200, not an error. No
// permission check beyond the router's blanket requireSession gate, same
// "any signed-in pod member can do anything" philosophy as every other
// write endpoint.
async function handleSeasonClose(request, env, ctx, session) {
  let seasonId;
  try {
    seasonId = await resolveSeasonId(env);
  } catch (err) {
    return jsonResponse({ error: "Failed to resolve current season from playgroup.gg", detail: err.message }, 502);
  }

  const row = await env.DB.prepare("SELECT closed_at FROM seasons WHERE id = ?").bind(seasonId).first();
  if (row.closed_at) {
    return jsonResponse({ ok: true, seasonId, alreadyClosed: true, closedAt: row.closed_at }, 200);
  }

  const closedAt = new Date().toISOString();
  await env.DB.prepare("UPDATE seasons SET closed_at = ?, closed_by_player_id = ? WHERE id = ?")
    .bind(closedAt, session.playerId, seasonId).run();

  // Lock in the season's trophies now, on the request path, rather than on
  // whoever's first read of the finished season. Awaited so the client's
  // follow-up GET /achievements finds them already minted -- otherwise that
  // read could lazily mint before the missing-stats backfill below runs,
  // freezing a season that's missing its last game. On failure the lazy
  // mint in handleAchievements still happens on first read, just without
  // the backfill. (achievementCtx, not ctx: ctx here is the Workers
  // ExecutionContext.)
  let precomputed = null;
  try {
    await backfillMissingEventStats(env, seasonId);
    precomputed = await computeAndMintSeason(env, seasonId);
  } catch (err) {
    console.error(`Minting season ${seasonId} at close failed; the first read will mint it instead:`, err);
  }

  // Fire-and-forget, same pattern as handleGamesWrite's post-discord
  // dispatch below -- the season is already durably closed above; a
  // failure reaching archidekt-trading-app (down, bad shared key, no
  // #season_winners channel found, Discord API hiccup) must never fail or
  // delay this response. Logged only (visible via `wrangler tail`).
  ctx.waitUntil(
    announceSeasonWinners(env, seasonId, precomputed).catch(err => {
      console.error(`Season winners announcement failed for season ${seasonId}:`, err);
    })
  );

  return jsonResponse({ ok: true, seasonId, alreadyClosed: false, closedAt }, 200);
}

async function handleGamesWrite(request, env, ctx, session) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!isValidGamePayload(payload)) {
    return jsonResponse({ error: "Payload missing required fields" }, 400);
  }

  let seasonId;
  try {
    seasonId = await resolveSeasonId(env);
  } catch (err) {
    return jsonResponse({ error: "Failed to resolve current season from playgroup.gg", detail: err.message }, 502);
  }

  // A manually-closed season (see POST /seasons/close) stays matched to
  // playgroup.gg's still-live league until a new league actually starts --
  // resolveSeasonId would otherwise silently reuse and re-open an
  // already-minted, permanently-frozen season.
  const closedSeasonRow = await env.DB.prepare("SELECT closed_at FROM seasons WHERE id = ?").bind(seasonId).first();
  if (closedSeasonRow && closedSeasonRow.closed_at) {
    return jsonResponse({ error: `Season ${seasonId} is closed -- games can't be logged for it until a new playgroup.gg league starts.` }, 409);
  }

  // Resolve every participant's player_id/deck_id up front, before writing
  // anything -- a game should fail whole, not land half-written with a
  // missing or misattributed participant. Deliberately stricter than the
  // client-side default-suggestion matching in app.js (exact normalized
  // match only, no startsWith fallback tier): that logic is just
  // pre-filling a field a human reviews before submitting, this is what
  // actually gets persisted.
  const resolved = [];
  for (const p of payload.participants) {
    const player = await env.DB.prepare("SELECT id FROM players WHERE name = ?").bind(p.player).first();
    if (!player) {
      return jsonResponse({ error: `Unknown player: ${p.player}` }, 400);
    }
    const target = normalizeCommanderForMatch(p.commander);
    const { results: decks } = await env.DB.prepare("SELECT id, name FROM decks WHERE player_id = ?").bind(player.id).all();
    const matches = decks.filter(d => normalizeCommanderForMatch(d.name) === target);
    if (matches.length === 0) {
      return jsonResponse({ error: `No deck found for ${p.player} matching commander "${p.commander}" -- add the deck first via Update the App.` }, 400);
    }
    if (matches.length > 1) {
      return jsonResponse({ error: `Ambiguous deck match for ${p.player} / "${p.commander}" (${matches.length} candidates) -- can't resolve safely.` }, 400);
    }
    resolved.push({ ...p, playerId: player.id, deckId: matches[0].id });
  }

  const nextRow = await env.DB.prepare("SELECT COALESCE(MAX(game_num), 0) + 1 AS next FROM games WHERE season_id = ?")
    .bind(seasonId).first();
  let gameNum = nextRow.next;

  // Two UNIQUE constraints can fail here (playgroup_game_id, and
  // (season_id, game_num)) and they mean different things -- a genuine
  // duplicate submission of the same real game, vs. two DIFFERENT games
  // racing for the same game_num (gameNum was computed from a snapshot
  // a moment ago; another request can insert in between). SQLite's error
  // message names the column(s) involved, so check specifically rather
  // than treating any UNIQUE failure as "already logged" -- that was
  // actively misleading for a numbering race, and silently uncaught
  // (raw 500) for a game with no playgroupGameId at all. The numbering
  // race is retried a few times (recomputing gameNum each time) since
  // it's transient by nature; a genuine duplicate isn't retried.
  let gameId;
  for (let attempt = 1; ; attempt++) {
    try {
      const insertResult = await env.DB.prepare(
        "INSERT INTO games (season_id, game_num, played_at, pod_size, playgroup_game_id, submitted_by_player_id) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(seasonId, gameNum, payload.date, payload.podSize, payload.playgroupGameId ?? null, session.playerId).run();
      gameId = insertResult.meta.last_row_id;
      break;
    } catch (err) {
      const msg = String(err.message);
      if (!msg.includes("UNIQUE")) throw err;

      if (msg.includes("playgroup_game_id")) {
        return jsonResponse({ error: `This game (playgroup_game_id=${payload.playgroupGameId}) has already been logged.` }, 409);
      }
      if (msg.includes("game_num") && attempt < 3) {
        const retryRow = await env.DB.prepare("SELECT COALESCE(MAX(game_num), 0) + 1 AS next FROM games WHERE season_id = ?")
          .bind(seasonId).first();
        gameNum = retryRow.next;
        continue;
      }
      return jsonResponse({ error: "Couldn't assign a game number (too many concurrent submissions) -- please try submitting again." }, 409);
    }
  }

  // The game_results rows are batched together (one atomic transaction),
  // but not atomic with the games insert above -- D1 needs games.id
  // (auto-generated) to build these statements, so it can't be known
  // before that first insert runs. A crash in between would leave an
  // orphan game row with zero results, which is rare, obviously visible
  // (it'd break the aggregates), and recoverable by hand -- an acceptable
  // tradeoff for a small low-traffic app, not a financial system.
  const strengths = resolved.map(p => p.strength);
  const responseResults = [];
  const gameResultStmts = resolved.map((p, i) => {
    const otherStrengths = strengths.filter((_, j) => j !== i);
    const result = p.result === "win" ? 1 : 0;
    const f = computeGameRowFormulas({
      commanderStrength: p.strength,
      otherStrengths,
      result,
      podSize: payload.podSize,
      knockouts: p.knockouts,
      place: p.place,
      tov: p.tov,
      popOff: p.popOff,
      disruptions: p.disruptions,
      recoveries: p.recoveries,
      gamesClearlyBehind: p.gamesClearlyBehind,
      bracket: p.bracket,
    });
    // A bracket change is only ever "unconfirmed" BEFORE it's actually
    // played -- that's what decks.bracket's manual override + bracketPending
    // (computePlayersData) already show as a dashed floor value ahead of
    // time. Once a game is actually logged at the new bracket, it's real
    // data and gets trusted like any other game's result: full f.X,
    // performance fraction included, never floored. (This game's X used to
    // be clamped to the bare bracket number here too, discarding a real
    // win/loss's performance -- see the fix for Manny's Kruphix deck after
    // game 17, where a win still read as flat 3.0.)
    const X = f.X;
    responseResults.push({ player: p.player, commander: p.commander, result: p.result, gameCalculatedDeckStrength: X });
    // Only ever meaningful (and only ever shown as a checkbox in Games to
    // Update) for a deck flagged decks.potential_bracket_4 -- 0/false for
    // every other deck's games, not a real "no" so much as "never asked".
    const earlyTwoCardCombo = p.earlyTwoCardCombo ? 1 : 0;
    return env.DB.prepare(`
      INSERT INTO game_results (
        game_id, player_id, deck_id, commander_strength, result, place, knockouts, tov,
        pop_off, disruptions, recoveries, games_clearly_behind, bracket,
        adjusted_pod_size_score, knockout_score, deck_strength_differential, win_probability,
        player_score, normalized_player_score, normalized_tov, deck_resilience_score,
        game_calculated_deck_strength, early_two_card_combo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      gameId, p.playerId, p.deckId, p.strength, result, p.place, p.knockouts, p.tov,
      p.popOff, p.disruptions, p.recoveries, p.gamesClearlyBehind, p.bracket,
      f.J, f.K, f.L, f.M, f.N, f.O, f.Q, f.U, X, earlyTwoCardCombo
    );
  });

  // A deck stops being "new" the moment it's actually played, regardless
  // of what its new_deck flag was before this -- idempotent (no-op if
  // already 0), so no need to check first.
  const clearNewDeckStmts = resolved.map(p =>
    env.DB.prepare("UPDATE decks SET new_deck = 0 WHERE id = ? AND new_deck = 1").bind(p.deckId)
  );

  await env.DB.batch([...gameResultStmts, ...clearNewDeckStmts]);

  // Fires post-discord-live.yml, which reads the just-written game back
  // out of D1 (via GET /players, /games, /deck-win-rates -- see
  // discord_report.py) and posts the rankings/deck-strength/win-rate
  // screenshots. Fire-and-forget via ctx.waitUntil (same pattern
  // isRateLimited already uses for its own KV-adjacent write below) --
  // the game itself is already durably written above, and app.js's
  // submit-and-wait UX is built on D1 writes landing in ~100-300ms
  // (see the comment above its fetch to this endpoint); awaiting an
  // extra GitHub API round trip here before responding would quietly
  // break that. A dispatch failure (GitHub down, token expired) has
  // nothing left to undo -- it's logged, not surfaced to the client.
  ctx.waitUntil(
    dispatchGithubEvent(env, "post-discord", {}).then(err => {
      if (err) console.error("post-discord dispatch failed:", err);
    })
  );

  // Fire-and-forget, same reasoning as the Discord dispatch above -- a
  // failed/slow playgroup.gg event-log fetch here should never block or
  // fail the actual game submission, since none of game_event_stats feeds
  // the power-spread math (see schema.sql).
  ctx.waitUntil(
    computeAndStoreGameEventStats(env, gameId, payload.playgroupGameId ?? null).catch(err => {
      console.error(`Failed to compute event stats for game ${gameId}:`, err);
    })
  );

  return jsonResponse({ ok: true, gameId, seasonId, gameNum, results: responseResults }, 201);
}

// Fetches one game's full event log from playgroup.gg and sums each
// player's damage_dealt (normal_damage + commander_damage events),
// healing_done, and knockouts (kill events), then stores one row per
// participant in game_event_stats -- see that table's comment in
// schema.sql for why this is computed once and stored rather than
// re-summed on every /achievements read. Matches event.user_id and
// participation.user_id (playgroup.gg's own ids) back to a player_id via
// getUserIdToPlayerIdMap; a participant with no linked playgroup_user_id
// (shouldn't happen for anyone this app tracks, but not asserted) is
// silently skipped rather than failing the whole game's stats.
// ON CONFLICT so this is safe to rerun -- both the backfill pass and a
// resubmitted/corrected game rely on that.
function emptyEventTotals() {
  return {
    damage_dealt: 0, healing_done: 0, knockouts: 0, damage_taken: 0, healing_received: 0, self_rating: null,
    pauses_called: 0, pause_seconds: 0, undos: 0, longest_turn_seconds: 0, shortest_turn_seconds: null,
    turn_count: 0, total_turn_seconds: 0,
  };
}

async function computeAndStoreGameEventStats(env, gameId, playgroupGameId) {
  if (!playgroupGameId) return;

  const res = await pgFetch(`/playgroups/${PLAYGROUP_ID}/games/${playgroupGameId}?include_events=true`, env);
  if (!res.ok) {
    console.error(`event-stats fetch failed for game ${playgroupGameId}: HTTP ${res.status}`);
    return;
  }
  const raw = await res.json();
  const userIdToPlayerId = await getUserIdToPlayerIdMap(env);

  const totals = {}; // playerId -> emptyEventTotals()
  const get = playerId => (totals[playerId] || (totals[playerId] = emptyEventTotals()));

  // playgroup.gg logs multiple "kill" events for a single real elimination
  // (confirmed against a real game: one player's 3 real KOs in a 4-player
  // pod showed up as 12 raw kill events, ~4 per receiver_user_id) -- a
  // plain per-event count over-counts, sometimes past what's even possible
  // in the pod. Dedupe per killer by distinct receiver_user_id instead;
  // finalized below once every event's been seen, not incremented inline
  // like the other totals, since "distinct" can only be known after the
  // fact.
  const knockoutReceiversByPlayer = {}; // playerId -> Set(receiver_user_id)

  let startingPlayerId = null;
  for (const e of raw.events || []) {
    const playerId = userIdToPlayerId[e.user_id];
    const receiverPlayerId = userIdToPlayerId[e.receiver_user_id];
    if (e.kind === "normal_damage" || e.kind === "commander_damage") {
      if (playerId) get(playerId).damage_dealt += e.amount || 0;
      if (receiverPlayerId) get(receiverPlayerId).damage_taken += e.amount || 0;
    } else if (e.kind === "healing") {
      if (playerId) get(playerId).healing_done += e.amount || 0;
      if (receiverPlayerId) get(receiverPlayerId).healing_received += e.amount || 0;
    } else if (e.kind === "kill") {
      if (playerId) {
        if (!knockoutReceiversByPlayer[playerId]) knockoutReceiversByPlayer[playerId] = new Set();
        knockoutReceiversByPlayer[playerId].add(e.receiver_user_id);
      }
    } else if (e.kind === "self_rating") {
      if (playerId) get(playerId).self_rating = e.amount ?? null;
    } else if (e.kind === "starting_player") {
      // First starting_player event wins -- confirmed against a real game
      // that an undo can re-fire this kind, so "first" (not "last") is the
      // one that actually reflects who started, same reasoning
      // deriveGameFieldsFromRawGame in app.js already applies to kill
      // events via happened_at ordering.
      if (startingPlayerId === null && playerId) startingPlayerId = playerId;
    } else if (e.kind === "undo") {
      if (playerId) get(playerId).undos += 1;
    } else if (e.kind === "pause_start") {
      if (playerId) get(playerId).pauses_called += 1;
    }
  }
  for (const [playerId, receivers] of Object.entries(knockoutReceiversByPlayer)) {
    get(playerId).knockouts = receivers.size;
  }

  // Pause duration needs strict chronological pairing (a pause_start's
  // matching pause_stop, whoever ends up resuming -- confirmed against a
  // real game that it's usually but not always the same user_id), so this
  // is its own pass over events sorted by happened_at rather than folded
  // into the single pass above. Attributed to whoever CALLED the pause,
  // not whoever ended it. An unmatched trailing pause_start (game data
  // exported mid-pause) contributes nothing rather than guessing an end.
  //
  // Turn duration rides the same sorted pass: each pass_turn marks the end
  // of the turn that started at the previous pass_turn (or start_game, for
  // the very first turn) -- attributed to whoever's pass_turn it is, since
  // that's whose turn just elapsed. Raw wall-clock time, not adjusted for
  // pauses -- confirmed against a real ~7-hour game that a long turn is
  // usually the whole table slowing down together late in a marathon
  // session, not one player stalling, so this is a fun/quirky stat like
  // Bio Break Champion, not a rigorous one. No start_game event at all
  // (shouldn't happen, not asserted) means no turn timing for this game
  // rather than guessing an anchor.
  const sortedEvents = [...(raw.events || [])].sort((a, b) => new Date(a.happened_at) - new Date(b.happened_at));
  let openPause = null;
  const startGameEvent = sortedEvents.find(e => e.kind === "start_game");
  let turnStartedAt = startGameEvent ? new Date(startGameEvent.happened_at) : null;
  for (const e of sortedEvents) {
    if (e.kind === "pause_start") {
      const playerId = userIdToPlayerId[e.user_id];
      openPause = { startedAt: new Date(e.happened_at), playerId };
    } else if (e.kind === "pause_stop" && openPause) {
      const seconds = Math.max(0, Math.round((new Date(e.happened_at) - openPause.startedAt) / 1000));
      if (openPause.playerId) get(openPause.playerId).pause_seconds += seconds;
      openPause = null;
    } else if (e.kind === "pass_turn" && turnStartedAt) {
      const happenedAt = new Date(e.happened_at);
      const seconds = Math.max(0, Math.round((happenedAt - turnStartedAt) / 1000));
      const playerId = userIdToPlayerId[e.user_id];
      if (playerId) {
        const t = get(playerId);
        if (seconds > t.longest_turn_seconds) t.longest_turn_seconds = seconds;
        if (t.shortest_turn_seconds === null || seconds < t.shortest_turn_seconds) t.shortest_turn_seconds = seconds;
        t.turn_count += 1;
        t.total_turn_seconds += seconds;
      }
      turnStartedAt = happenedAt;
    }
  }

  const stmts = [];
  for (const p of raw.participations || []) {
    const playerId = userIdToPlayerId[p.user_id];
    if (!playerId) continue;
    const t = get(playerId);
    const endingLife = typeof raw.life_amount === "number"
      ? raw.life_amount - t.damage_taken + t.healing_received
      : null;
    stmts.push(env.DB.prepare(`
      INSERT INTO game_event_stats (
        game_id, player_id, damage_dealt, healing_done, knockouts,
        fun_rating, salt_rating, mulligans_taken, self_rating,
        damage_taken, healing_received, ending_life,
        pauses_called, pause_seconds, undos, longest_turn_seconds, shortest_turn_seconds,
        turn_count, total_turn_seconds
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (game_id, player_id) DO UPDATE SET
        damage_dealt = excluded.damage_dealt, healing_done = excluded.healing_done, knockouts = excluded.knockouts,
        fun_rating = excluded.fun_rating, salt_rating = excluded.salt_rating, mulligans_taken = excluded.mulligans_taken,
        self_rating = excluded.self_rating, damage_taken = excluded.damage_taken,
        healing_received = excluded.healing_received, ending_life = excluded.ending_life,
        pauses_called = excluded.pauses_called, pause_seconds = excluded.pause_seconds, undos = excluded.undos,
        longest_turn_seconds = excluded.longest_turn_seconds, shortest_turn_seconds = excluded.shortest_turn_seconds,
        turn_count = excluded.turn_count, total_turn_seconds = excluded.total_turn_seconds
    `).bind(
      gameId, playerId, t.damage_dealt, t.healing_done, t.knockouts,
      p.fun_rating ?? null, p.salt_rating ?? null, p.mulligans_taken ?? null, t.self_rating,
      t.damage_taken, t.healing_received, endingLife,
      t.pauses_called, t.pause_seconds, t.undos, t.longest_turn_seconds, t.shortest_turn_seconds,
      t.turn_count, t.total_turn_seconds
    ));
  }

  // Game-level facts (not per-player) -- one UPDATE alongside the
  // per-participant INSERTs above, same batch/transaction.
  stmts.push(env.DB.prepare("UPDATE games SET win_con = ?, starting_player_id = ? WHERE id = ?")
    .bind(raw.win_con ?? null, startingPlayerId, gameId));

  if (stmts.length > 0) await env.DB.batch(stmts);
}

// New players + new decks for existing players, in one combined write --
// mirrors the existing single-submit-button UX in app.js's Update the App
// tab (renderRosterUpdateSubmit posts both newPlayers and
// newDecksForExisting together), unlike the plan doc's original "POST
// /players, POST /decks" split, which would have made the client
// orchestrate two calls and reconcile a partial failure between them.
//
// No KV dedupe guard, unlike the old GitHub-dispatch roster endpoint this
// replaced had -- that existed specifically because the GitHub Action
// round trip took 1-3 minutes, long enough for a second click to beat a
// disabled-button guard. A D1 write lands in ~100-300ms, far too narrow a
// window for that same concern to carry the same weight. A duplicate
// player name is still caught (see below); a duplicate deck name for
// the same player is not --
// decks have no uniqueness constraint yet, since nothing currently
// submits at high enough frequency or low enough supervision for that gap
// to matter in practice. Worth a real constraint if that ever changes.
async function handleRosterWrite(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!isValidRosterUpdatePayload(payload)) {
    return jsonResponse({ error: "Payload missing required fields" }, 400);
  }

  const createdPlayers = [];
  const createdDecks = [];

  for (const p of payload.newPlayers) {
    const existing = await env.DB.prepare("SELECT id FROM players WHERE name = ?").bind(p.displayName).first();
    if (existing) {
      return jsonResponse({ error: `A player named "${p.displayName}" already exists.` }, 409);
    }
    const insertPlayer = await env.DB.prepare("INSERT INTO players (name, playgroup_username, playgroup_user_id) VALUES (?, ?, ?)")
      .bind(p.displayName, p.username, p.userId ?? null).run();
    const playerId = insertPlayer.meta.last_row_id;
    createdPlayers.push({ id: playerId, name: p.displayName, username: p.username });

    if (p.decks.length) {
      const deckStmts = p.decks.map(d =>
        env.DB.prepare("INSERT INTO decks (player_id, name, baseline_power, playgroup_deck_id, playgroup_deck_name, new_deck, potential_bracket_4, color_identity) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
          .bind(playerId, d.name, d.power, d.playgroupDeckId != null ? String(d.playgroupDeckId) : null, d.playgroupDeckName ?? null, d.potentialBracket4 ? 1 : 0, d.colorIdentity ?? null)
      );
      await env.DB.batch(deckStmts);
    }
    createdDecks.push(...p.decks.map(d => ({ player: p.displayName, name: d.name })));
  }

  for (const d of payload.newDecksForExisting) {
    const player = await env.DB.prepare("SELECT id FROM players WHERE name = ?").bind(d.player).first();
    if (!player) {
      return jsonResponse({ error: `Unknown player: ${d.player}` }, 400);
    }
    await env.DB.prepare("INSERT INTO decks (player_id, name, baseline_power, playgroup_deck_id, playgroup_deck_name, new_deck, potential_bracket_4, color_identity) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
      .bind(player.id, d.name, d.power, d.playgroupDeckId != null ? String(d.playgroupDeckId) : null, d.playgroupDeckName ?? null, d.potentialBracket4 ? 1 : 0, d.colorIdentity ?? null).run();
    createdDecks.push({ player: d.player, name: d.name });
  }

  return jsonResponse({ ok: true, createdPlayers, createdDecks }, 201);
}

// Manually declares a deck's new bracket ahead of any game being logged
// there -- for a player who's upgraded a deck and wants Set Up Pod's power
// spread validation to reflect the new bracket's floor immediately, rather
// than waiting for the next real game to be logged (see computePlayersData
// for how this is applied). bracket: null clears a previously-set
// declaration. Deliberately only touches decks.bracket -- never writes
// game_results or baseline_power -- so it can't retroactively change any
// already-logged game's numbers.
async function handleDeckBracketWrite(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!isValidBracketPayload(payload)) {
    return jsonResponse({ error: "Payload must include deckId (number) and bracket (integer 1-5, or null to clear)" }, 400);
  }
  const deck = await env.DB.prepare("SELECT id FROM decks WHERE id = ?").bind(payload.deckId).first();
  if (!deck) {
    return jsonResponse({ error: `Unknown deck: ${payload.deckId}` }, 400);
  }
  await env.DB.prepare("UPDATE decks SET bracket = ? WHERE id = ?").bind(payload.bracket, payload.deckId).run();
  return jsonResponse({ ok: true, deckId: payload.deckId, bracket: payload.bracket });
}

// Curates which decks are even eligible for the early-two-card-combo
// checkbox in Games to Update (see isValidGamePayload/handleGamesWrite) --
// most decks never would be. Purely a manual flag, never touched by any
// other write path.
async function handleDeckPotentialBracket4Write(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (!isValidPotentialBracket4Payload(payload)) {
    return jsonResponse({ error: "Payload must include deckId (number) and potentialBracket4 (boolean)" }, 400);
  }
  const deck = await env.DB.prepare("SELECT id FROM decks WHERE id = ?").bind(payload.deckId).first();
  if (!deck) {
    return jsonResponse({ error: `Unknown deck: ${payload.deckId}` }, 400);
  }
  await env.DB.prepare("UPDATE decks SET potential_bracket_4 = ? WHERE id = ?")
    .bind(payload.potentialBracket4 ? 1 : 0, payload.deckId).run();
  return jsonResponse({ ok: true, deckId: payload.deckId, potentialBracket4: payload.potentialBracket4 });
}

// ---------- GET /playgroup-games : live playgroup.gg read ----------

async function getActiveLeagueId(env) {
  const cached = await kvGetJson(env, ACTIVE_LEAGUE_CACHE_KEY, null);
  if (cached) return cached;

  const meRes = await pgFetch("/me", env);
  if (!meRes.ok) throw new Error(`/me failed: HTTP ${meRes.status}`);
  const me = await meRes.json();

  const pgListRes = await pgFetch(`/users/${me.id}/playgroups`, env);
  if (!pgListRes.ok) throw new Error(`/users/${me.id}/playgroups failed: HTTP ${pgListRes.status}`);
  const playgroups = await pgListRes.json();

  const playgroup = playgroups.find(p => p.id === PLAYGROUP_ID);
  if (!playgroup) throw new Error(`Playgroup ${PLAYGROUP_ID} not found for this account`);
  const active = (playgroup.leagues || []).find(l => l.active);
  if (!active) throw new Error(`No active league found for playgroup ${PLAYGROUP_ID}`);

  await env.DECK_CACHE.put(ACTIVE_LEAGUE_CACHE_KEY, JSON.stringify(active), { expirationTtl: ACTIVE_LEAGUE_CACHE_TTL_SECONDS });
  return active;
}

// Fetches league-scoped ELO history for each deck ID in parallel and
// returns the set of confirmed active-league game IDs (the only ground
// truth playgroup.gg offers -- there's no league field on a game itself).
async function confirmGameIdsForDecks(deckIds, activeLeague, env) {
  const ids = new Set();
  await Promise.all(deckIds.map(async deckId => {
    const res = await pgFetch(
      `/decks/${deckId}/elo_history?playgroup_id=${PLAYGROUP_ID}&league_id=${activeLeague.id}`,
      env
    );
    if (!res.ok) return;
    const data = await res.json();
    for (const h of data.history || []) ids.add(h.game_id);
  }));
  return ids;
}

function deckIdsInGame(game) {
  const ids = new Set();
  for (const p of game.participations) {
    if (p.deck_id) ids.add(p.deck_id);
  }
  return ids;
}

// Which playgroup.gg accounts map to which tracked player -- read live
// from D1 instead of a hardcoded constant, so a player written via
// POST /roster is picked up immediately, no redeploy needed. Uncached and
// cheap, same reasoning as computePlayersData/handleRosterDiff already
// querying D1 fresh on every request. Participants whose user id isn't
// in this map (guests, other accounts) get dropped from the output, same
// as the old hardcoded map used to do.
//
// Keyed by playgroup_user_id (a stable numeric id), not
// playgroup_username -- confirmed the hard way that a username is NOT
// stable: a real player renamed their playgroup.gg account mid-session,
// which silently broke every username-keyed lookup (they stopped
// showing as tracked, and their decks disappeared from matching)
// without erroring anywhere. user_id is available both on roster-diff's
// member objects and on raw game participations, so this same map now
// covers both call sites below.
async function getUserIdToPlayerMap(env) {
  const { results } = await env.DB.prepare(
    "SELECT name, playgroup_user_id FROM players WHERE playgroup_user_id IS NOT NULL"
  ).all();
  const map = {};
  for (const row of results) map[row.playgroup_user_id] = row.name;
  return map;
}

// Same shape as getUserIdToPlayerMap above, but the D1 player id rather
// than the display name -- what computeAndStoreGameEventStats needs to
// write game_event_stats rows (player_id, not player name).
async function getUserIdToPlayerIdMap(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, playgroup_user_id FROM players WHERE playgroup_user_id IS NOT NULL"
  ).all();
  const map = {};
  for (const row of results) map[row.playgroup_user_id] = row.id;
  return map;
}

async function computePlaygroupGames(env, forceRecheckGameId) {
  if (!env.DECK_CACHE) {
    throw new Error("DECK_CACHE KV namespace is not bound to this Worker (Settings -> Bindings)");
  }

  const userIdToPlayer = await getUserIdToPlayerMap(env);
  const activeLeague = await getActiveLeagueId(env);

  const gamesRes = await pgFetch(`/playgroups/${PLAYGROUP_ID}/games?limit=100`, env);
  if (!gamesRes.ok) throw new Error(`games list failed: HTTP ${gamesRes.status}`);
  const allGames = await gamesRes.json();

  // ---- Per-game league classification ----
  // A game played weeks ago essentially never has its league membership
  // changed again, so classifying it once and trusting that forever is
  // safe and keeps this cheap. But it's NOT actually permanent: a human
  // can reassign or remove a game's league on playgroup.gg after the
  // fact (confirmed both directions -- a brand-new game's deck ELO
  // history can lag behind the game record being complete, reading as
  // "not in this league" before playgroup.gg finishes processing it; and
  // someone can deliberately un-league a game later). RECLASSIFY_WINDOW_MS
  // keeps recent games' classification on a short leash -- re-verified at
  // most once per RECLASSIFY_MIN_INTERVAL_MS -- so a correction on
  // playgroup.gg's end shows up here within one refresh cycle instead of
  // needing a manual ?recheck=<id>. Games older than the window are
  // treated as settled and never re-checked again, which is what keeps
  // this affordable.
  const classifiedKey = `classified_games:${activeLeague.id}`;
  const rawClassified = await kvGetJson(env, classifiedKey, {});
  const classified = {};
  for (const [id, raw] of Object.entries(rawClassified)) {
    // Old cache entries were a plain boolean with no timestamp -- treat as
    // "never checked under this scheme" so a still-recent one gets one
    // fresh verification pass instead of being trusted blindly forever.
    classified[id] = typeof raw === "boolean" ? { active: raw, checkedAt: 0 } : raw;
  }
  if (forceRecheckGameId != null && forceRecheckGameId in classified) {
    delete classified[forceRecheckGameId];
  }

  const now = Date.now();
  const needsClassification = g => {
    const entry = classified[g.id];
    if (!entry) return true;
    const gameAgeMs = now - new Date(g.started_at).getTime();
    if (gameAgeMs > RECLASSIFY_WINDOW_MS) return false; // old enough to trust permanently
    return (now - entry.checkedAt) > RECLASSIFY_MIN_INTERVAL_MS;
  };
  const unclassifiedGames = allGames.filter(needsClassification);

  const uncoveredDeckIds = new Set();
  for (const g of unclassifiedGames) {
    for (const id of deckIdsInGame(g)) uncoveredDeckIds.add(id);
  }
  const deckIdsToCheck = [...uncoveredDeckIds].slice(0, MAX_DECK_CHECKS_PER_RUN);
  const checkedDeckIdSet = new Set(deckIdsToCheck);

  let decksCheckedCount = 0;
  if (deckIdsToCheck.length > 0) {
    decksCheckedCount = deckIdsToCheck.length;
    const confirmedIds = await confirmGameIdsForDecks(deckIdsToCheck, activeLeague, env);

    let changed = false;
    for (const g of unclassifiedGames) {
      const gameDeckIds = deckIdsInGame(g);
      const allDecksChecked = [...gameDeckIds].every(id => checkedDeckIdSet.has(id));
      if (!allDecksChecked) continue; // retry this game next run once its remaining decks are checked
      classified[g.id] = { active: confirmedIds.has(g.id), checkedAt: now };
      changed = true;
    }
    if (changed) {
      await env.DECK_CACHE.put(classifiedKey, JSON.stringify(classified));
    }
  }

  const activeGames = allGames.filter(g => classified[g.id] && classified[g.id].active === true);

  // ---- Commander names, cached with a soft expiry ----
  // Not present on the games/participations payload, only on the deck
  // itself. Cached (unlike league membership) because a deck's commander
  // can legitimately change over time.
  const commanderCache = await kvGetJson(env, "commander_names", {});
  const activeDeckIds = new Set();
  for (const g of activeGames) {
    for (const id of deckIdsInGame(g)) activeDeckIds.add(id);
  }
  const staleOrMissing = [...activeDeckIds].filter(id => {
    const entry = commanderCache[id];
    return !entry || (now - entry.cachedAt) > COMMANDER_NAME_MAX_AGE_MS;
  });
  const deckIdsToLookUp = staleOrMissing.slice(0, MAX_COMMANDER_LOOKUPS_PER_RUN);

  if (deckIdsToLookUp.length > 0) {
    await Promise.all(deckIdsToLookUp.map(async deckId => {
      const res = await pgFetch(`/decks/${deckId}`, env);
      if (!res.ok) return;
      const deck = await res.json();
      commanderCache[deckId] = {
        name: deck.commander ? deck.commander.name : deck.name,
        cachedAt: now,
      };
    }));
    await env.DECK_CACHE.put("commander_names", JSON.stringify(commanderCache));
  }

  const games = [];
  for (const g of activeGames.sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    const participants = [];
    let untracked = 0;
    for (const p of g.participations) {
      const player = p.user_id ? userIdToPlayer[p.user_id] : null;
      if (!player) { untracked++; continue; }
      const cachedCommander = commanderCache[p.deck_id];
      participants.push({
        player,
        commander: (cachedCommander && cachedCommander.name) || p.deck_name,
        deck_name: p.deck_name,
        result: p.winner ? "win" : "loss",
      });
    }
    if (participants.length < 2) continue;
    const entry = {
      playgroup_game_id: g.id,
      date: g.started_at.slice(0, 10),
      pod_size: participants.length,
      participants,
    };
    if (untracked) {
      entry.note = `${untracked} additional participant(s) in this game are not tracked spreadsheet players and are excluded from pod_size and all participants below.`;
    }
    games.push(entry);
  }

  return {
    generated_at: new Date().toISOString(),
    league: activeLeague.name,
    note: "pod_size counts only tracked spreadsheet players (matches how the Game Log formulas treat pod size -- every slot needs a Commander Strength value). See per-game \"note\" if untracked participants were excluded.",
    // D1's players.playgroup_user_id is the one place a new playgroup.gg
    // member gets added (via POST /roster) -- everything downstream
    // (app.js's Pod Validator player list, this games list, commander
    // lookups) picks it up from here rather than keeping a second
    // hardcoded copy of "who's tracked."
    known_players: [...new Set(Object.values(userIdToPlayer))],
    games,
    debug: {
      all_time_games: allGames.length,
      games_already_classified: allGames.length - unclassifiedGames.length,
      games_needing_classification: unclassifiedGames.length,
      unique_decks_needing_check: uncoveredDeckIds.size,
      decks_checked_this_run: decksCheckedCount,
      decks_left_for_next_run: Math.max(0, uncoveredDeckIds.size - deckIdsToCheck.length),
      active_games: activeGames.length,
      active_unique_decks: activeDeckIds.size,
      commander_lookups_made: deckIdsToLookUp.length,
      commander_lookups_left: Math.max(0, staleOrMissing.length - deckIdsToLookUp.length),
      approx_subrequests: 3 + deckIdsToCheck.length + deckIdsToLookUp.length,
    },
  };
}

async function handlePlaygroupGames(env, ctx, request) {
  const forceRecheckGameId = new URL(request.url).searchParams.get("recheck");

  let data;
  try {
    data = await computePlaygroupGames(env, forceRecheckGameId);
  } catch (err) {
    return jsonResponse({ error: "Failed to read playgroup.gg", detail: err.message }, 502);
  }

  return jsonResponse(data, 200, { "Cache-Control": "no-store" });
}

// ---------- GET /debug/game : raw single-game passthrough ----------

// Straight pass-through of playgroup.gg's own GET
// /playgroups/{playgroup_id}/games/{game_id} -- none of /playgroup-games'
// filtering (tracked players only, reshaped fields) or league
// classification logic in the way. Not used by the app itself; purely a
// manual debugging aid for inspecting exactly what playgroup.gg returns
// for one specific game.
async function handleDebugGame(request, env) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("id");
  if (!gameId || !/^\d+$/.test(gameId)) {
    return jsonResponse({ error: "?id=<numeric game id> is required" }, 400);
  }
  const includeEvents = url.searchParams.get("events") === "true";

  const res = await pgFetch(
    `/playgroups/${PLAYGROUP_ID}/games/${gameId}${includeEvents ? "?include_events=true" : ""}`,
    env
  );
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Same reasoning as handleDebugGame above -- raw pass-through of one
// playgroup.gg user's deck list exactly as their API returns it, no
// filtering/reshaping. handleRosterDiff (below) calls this same
// playgroup.gg endpoint but whitelists specific fields onto its own
// response shape, so a new field playgroup.gg adds would be silently
// dropped there -- this route exists specifically so a new field is
// visible before deciding whether/how to surface it. Not used by the app.
async function handleDebugDecks(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  if (!userId || !/^\d+$/.test(userId)) {
    return jsonResponse({ error: "?user_id=<numeric playgroup.gg user id> is required" }, 400);
  }

  const res = await pgFetch(`/users/${userId}/decks?include_archived=true`, env);
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Same reasoning again -- raw pass-through of the playgroup's games list,
// unfiltered by /playgroup-games' own active-league classification (which
// a brand new game might not have been assigned yet) or handlePlaygroupGames'
// tracked-players-only reshaping. Sorted newest first so the most
// recently played game is always results[0], not used by the app.
async function handleDebugGamesList(request, env) {
  const url = new URL(request.url);
  const limit = url.searchParams.get("limit") || "10";

  const res = await pgFetch(`/playgroups/${PLAYGROUP_ID}/games?limit=${encodeURIComponent(limit)}`, env);
  const body = await res.text();
  let sorted = body;
  try {
    const games = JSON.parse(body);
    if (Array.isArray(games)) {
      sorted = JSON.stringify(games.sort((a, b) => b.started_at.localeCompare(a.started_at)));
    }
  } catch {
    // Fall through and return whatever playgroup.gg sent, unsorted --
    // an error here shouldn't hide the raw response from view.
  }
  return new Response(sorted, {
    status: res.status,
    headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Raw pass-through of every league on this playgroup and its own `active`
// flag -- unlike getActiveLeagueId (which only ever surfaces the first
// .find(active) match, the one resolveSeasonId/the achievements reveal
// check actually act on), this shows ALL of them. Confirmed the hard way
// that playgroup.gg allows more than one league active at once: reactivating
// an old season's league here does NOT deactivate the current one, and
// nothing in this app disambiguates between two simultaneously-active
// leagues -- it just silently keeps using whichever one is first in the
// array. Check this before reactivating an old league, not after.
async function handleDebugLeagues(env) {
  const meRes = await pgFetch("/me", env);
  const me = await meRes.json();
  const pgListRes = await pgFetch(`/users/${me.id}/playgroups`, env);
  const playgroups = await pgListRes.json();
  const playgroup = playgroups.find(p => p.id === PLAYGROUP_ID);
  return jsonResponse(
    { leagues: (playgroup && playgroup.leagues) || [] },
    200,
    { "Cache-Control": "no-store" }
  );
}

// Authoritative game-id membership for an arbitrary league, reusing
// confirmGameIdsForDecks (normally only ever called against whatever
// getActiveLeagueId resolves to) against a caller-supplied league_id +
// deck_ids list instead. Built to reconcile Season 2's real playgroup.gg
// membership (confirmed: exactly 24 games, matching the count playgroup.gg's
// own UI shows for that league) against a spreadsheet/date-range guess --
// kept around for the next time an old league needs the same treatment.
async function handleDebugLeagueGameIds(request, env) {
  const url = new URL(request.url);
  const leagueId = url.searchParams.get("league_id");
  const deckIdsParam = url.searchParams.get("deck_ids");
  if (!leagueId || !deckIdsParam) {
    return jsonResponse({ error: "?league_id=<id>&deck_ids=<comma-separated> required" }, 400);
  }
  const deckIds = deckIdsParam.split(",").map(s => Number(s.trim())).filter(Boolean);
  const ids = await confirmGameIdsForDecks(deckIds, { id: leagueId }, env);
  return jsonResponse({ leagueId, deckIdsChecked: deckIds.length, gameIds: [...ids].sort((a, b) => a - b), count: ids.size }, 200, { "Cache-Control": "no-store" });
}

// ---------- GET /roster-diff : who/what is on playgroup.gg but not yet tracked ----------

// playgroup.gg's Deck.color_identity is an unordered array (e.g. ["G","U"]) --
// collapsed to a plain string in a fixed WUBRG order (e.g. "UG") so it's
// directly usable as a stable sequence of wedges for the identity coin
// (buildIdentityCoin in app.js) without either side re-sorting. Empty array
// -> "" (a confirmed colorless deck), which decks.color_identity treats as
// meaningfully different from NULL ("never captured") -- see schema.sql.
const WUBRG_ORDER = ["W", "U", "B", "R", "G"];
function toCanonicalColorString(colors) {
  if (!Array.isArray(colors)) return null;
  return WUBRG_ORDER.filter(c => colors.includes(c)).join("");
}

// computeRosterDiff already fetches every tracked player's full deck list
// (including archived status and color identity) fresh from playgroup.gg on
// every call -- the cheapest possible way to keep decks.archived/
// decks.color_identity from drifting stale is to piggyback on that instead
// of a separate sync job. Fire-and-forget via ctx.waitUntil (same pattern as
// handleGamesWrite's post-discord dispatch): this is a GET endpoint, so a
// slow or failed write here should never affect the response app.js is
// waiting on. Only writes rows that actually changed, not a blind rewrite of
// every tracked deck on every request. Named for both fields now, not just
// the one it originally shipped for.
async function syncDecksFromPlaygroup(env, decksByUsername) {
  const { results: tracked } = await env.DB.prepare(
    "SELECT id, playgroup_deck_id, archived, color_identity FROM decks WHERE playgroup_deck_id IS NOT NULL"
  ).all();
  const byPgId = new Map(tracked.map(d => [d.playgroup_deck_id, d]));

  const stmts = [];
  for (const decks of Object.values(decksByUsername)) {
    for (const d of decks) {
      const row = byPgId.get(String(d.id));
      if (!row) continue;
      const liveArchived = d.archived ? 1 : 0;
      // d.color_identity here is already the canonical string (see
      // computeRosterDiff below) -- compared directly against the stored
      // value, no re-derivation.
      const archivedChanged = row.archived !== liveArchived;
      const colorChanged = d.color_identity !== null && d.color_identity !== row.color_identity;
      if (archivedChanged && colorChanged) {
        stmts.push(env.DB.prepare("UPDATE decks SET archived = ?, color_identity = ? WHERE id = ?").bind(liveArchived, d.color_identity, row.id));
      } else if (archivedChanged) {
        stmts.push(env.DB.prepare("UPDATE decks SET archived = ? WHERE id = ?").bind(liveArchived, row.id));
      } else if (colorChanged) {
        stmts.push(env.DB.prepare("UPDATE decks SET color_identity = ? WHERE id = ?").bind(d.color_identity, row.id));
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// Returns the raw "world according to playgroup.gg" -- every member (not
// just tracked ones, so the app can preview what a brand-new player would
// bring in) and every member's full deck list, independent of games played.
// This Worker doesn't attempt to diff anything itself -- same division of
// responsibility as /playgroup-games: Worker supplies the raw playgroup.gg
// data, app.js compares it against what's already in D1 (fetched via
// GET /players).
async function computeRosterDiff(env, ctx) {
  const userIdToPlayer = await getUserIdToPlayerMap(env);

  const membersRes = await pgFetch(`/playgroups/${PLAYGROUP_ID}/members`, env);
  if (!membersRes.ok) throw new Error(`playgroup members failed: HTTP ${membersRes.status}`);
  const rawMembers = await membersRes.json();

  const members = rawMembers.map(m => ({
    user_id: m.user_id,
    username: m.username,
    tracked: m.user_id in userIdToPlayer,
    mapped_player: userIdToPlayer[m.user_id] || null,
    joined_at: m.joined_at,
  }));

  const lookups = members.slice(0, MAX_MEMBER_DECK_LOOKUPS_PER_RUN);
  const decksByUsername = {};
  await Promise.all(lookups.map(async m => {
    const res = await pgFetch(`/users/${m.user_id}/decks?include_archived=true`, env);
    if (!res.ok) return;
    const decks = await res.json();
    decksByUsername[m.username] = decks.map(d => ({
      id: d.id,
      name: d.name,
      commander_name: d.commander ? d.commander.name : d.name,
      power_level: typeof d.power_level === "number" ? d.power_level : null,
      bracket: d.bracket ?? null,
      archived: !!d.archived,
      color_identity: toCanonicalColorString(d.color_identity),
    }));
  }));

  const syncPromise = syncDecksFromPlaygroup(env, decksByUsername)
    .catch(err => console.error("decks sync from playgroup.gg failed:", err));
  if (ctx) ctx.waitUntil(syncPromise); else await syncPromise;

  return {
    generated_at: new Date().toISOString(),
    known_players: [...new Set(Object.values(userIdToPlayer))],
    members,
    decks_by_username: decksByUsername,
    debug: {
      total_members: members.length,
      member_deck_lookups_made: lookups.length,
      member_deck_lookups_truncated: Math.max(0, members.length - lookups.length),
      approx_subrequests: 1 + lookups.length,
    },
  };
}

async function handleRosterDiff(env, ctx) {
  let data;
  try {
    data = await computeRosterDiff(env, ctx);
  } catch (err) {
    return jsonResponse({ error: "Failed to read playgroup.gg roster", detail: err.message }, 502);
  }

  return jsonResponse(data, 200, { "Cache-Control": "no-store" });
}

// ---------- GET /players, /games, /rankings, /deck-win-rates : D1 reads ----------
// app.js reads /players and /games directly; the Discord scripts read
// /deck-win-rates (see scripts/discord_report.py); /rankings is
// currently unused by anything. See cloudflare-worker/schema.sql for the
// table layout and the migration plan doc for the full rationale.

// A deck's "current power": the most recent logged game's calculated
// strength, falling back to its baseline -- same fallback behavior as
// Current Deck Strength's own IFERROR(LOOKUP(...), baseline) formula.
// "Most recent" is g.id DESC (insertion order), not game_num DESC, since
// game_num resets per season and isn't comparable across seasons.
//
// decks.bracket is a manual "this deck is now bracket N" declaration (set
// via POST /decks/bracket -- see handleDeckBracketWrite), for a deck that's
// moved brackets before any game has been logged there yet. It only takes
// over "power" while it disagrees with the most recently *logged* game's
// bracket -- the same reset-to-the-new-bracket's-floor rule
// handleGamesWrite already applies when a submitted game's bracket differs
// from the deck's previous one (see the comment there), just triggered
// here by a manual declaration instead of a new game. The moment a real
// game gets logged at that bracket, the two agree and the override quietly
// stops mattering -- real game data always wins over a manual guess.
async function computePlayersData(env) {
  const { results: playerRows } = await env.DB.prepare(
    "SELECT id, name, playgroup_username FROM players ORDER BY id"
  ).all();

  const { results: deckRows } = await env.DB.prepare(`
    SELECT d.id, d.player_id, d.name, d.playgroup_deck_id, d.archived, d.new_deck,
           d.potential_bracket_4, d.bracket AS bracket_override, d.color_identity,
           (SELECT gr.bracket FROM game_results gr JOIN games g ON g.id = gr.game_id
            WHERE gr.deck_id = d.id ORDER BY g.id DESC LIMIT 1) AS last_logged_bracket,
           COALESCE(
             (SELECT gr.game_calculated_deck_strength
              FROM game_results gr JOIN games g ON g.id = gr.game_id
              WHERE gr.deck_id = d.id
              ORDER BY g.id DESC LIMIT 1),
             d.baseline_power
           ) AS computed_power,
           -- Last 5 logged games (any season), most recent first -- see the
           -- comboFlagged comment below for what this feeds.
           (SELECT COUNT(*) FROM (
              SELECT gr.early_two_card_combo AS c FROM game_results gr JOIN games g ON g.id = gr.game_id
              WHERE gr.deck_id = d.id ORDER BY g.id DESC LIMIT 5
            )) AS combo_window_size,
           (SELECT COUNT(*) FROM (
              SELECT gr.early_two_card_combo AS c FROM game_results gr JOIN games g ON g.id = gr.game_id
              WHERE gr.deck_id = d.id ORDER BY g.id DESC LIMIT 5
            ) WHERE c = 1) AS combo_flagged_count,
           -- Total logged games (any season, no LIMIT) -- distinct from
           -- combo_window_size above, which is capped at 5. Feeds the
           -- Players & Decks nameplate's "Logged N games" subtitle.
           (SELECT COUNT(*) FROM game_results gr WHERE gr.deck_id = d.id) AS games_logged
    FROM decks d
    ORDER BY d.id
  `).all();

  const decksByPlayer = {};
  for (const d of deckRows) {
    const bracketPending = d.bracket_override != null && d.bracket_override !== d.last_logged_bracket;
    (decksByPlayer[d.player_id] ||= []).push({
      id: d.id,
      name: d.name,
      power: bracketPending ? d.bracket_override : d.computed_power,
      bracket: d.bracket_override,
      bracketPending,
      // Explicitly maintained (decks.new_deck), not inferred from
      // game_results -- see schema.sql. Set Up Pod exempts these from the
      // power-spread check (see evaluatePod in app.js): baseline_power is
      // an unconfirmed estimate until this deck's first game is logged.
      newDeck: !!d.new_deck,
      // Curated list of decks even eligible for the combo checkbox in
      // Games to Update (see isValidGamePayload/handleGamesWrite) -- most
      // decks never would be.
      potentialBracket4: !!d.potential_bracket_4,
      // Read-time-only signal, never written back to decks.bracket and
      // never resets power (see the reset-to-floor comment on
      // bracketChanged in handleGamesWrite for why that's deliberate) --
      // 3+ of the last 5 logged games flagged early_two_card_combo just
      // surfaces a badge in app.js. comboWindowSize lets the UI show "3/3"
      // honestly instead of "3/5" for a deck with fewer than 5 games yet.
      comboFlagged: d.combo_flagged_count >= 3,
      comboFlaggedCount: d.combo_flagged_count,
      comboWindowSize: d.combo_window_size,
      playgroupId: d.playgroup_deck_id,
      archived: !!d.archived,
      // NULL ("never captured") vs. "" (confirmed colorless) vs. a real
      // string of letters -- see schema.sql's color_identity comment.
      // Passed straight through, never derived here.
      colorIdentity: d.color_identity,
      gamesLogged: d.games_logged,
    });
  }

  // Pinned trophies, shown on the Player Win Rates tab. In their own
  // try/catch so a problem reading them can never take down /players, which
  // the whole app and scripts/discord_report.py depend on. Pins on a
  // since-retired achievement are skipped here rather than deleted.
  const pinsByPlayer = {};
  try {
    const { results: pinRows } = await env.DB.prepare(
      "SELECT player_id, achievement_id FROM trophy_pins ORDER BY player_id, position"
    ).all();
    for (const r of pinRows) {
      const a = ACHIEVEMENT_BY_ID.get(r.achievement_id);
      if (!a) continue;
      (pinsByPlayer[r.player_id] ||= []).push({ id: a.id, title: a.title, emblem: emblemUrl(a.emblem) });
    }
  } catch (err) {
    console.error("Failed to read trophy pins for /players:", err);
  }

  // Every player, unfiltered -- same split of responsibility as today's
  // players (all) vs podPlayers (playgroup-linked only) in app.js. This
  // endpoint hands back the raw truth; filtering stays client-side.
  const players = playerRows.map(p => ({
    id: p.id,
    name: p.name,
    playgroupUsername: p.playgroup_username,
    decks: decksByPlayer[p.id] || [],
    pinnedTrophies: pinsByPlayer[p.id] || [],
  }));

  return { generated_at: new Date().toISOString(), players };
}

async function handlePlayers(env) {
  let data;
  try {
    data = await computePlayersData(env);
  } catch (err) {
    return jsonResponse({ error: "Failed to read players from D1", detail: err.message }, 500);
  }
  return jsonResponse(data, 200, { "Cache-Control": "no-store" });
}

// One row per player per game, joined out to plain values -- the D1
// equivalent of today's gameLogSeason3Rows (extractGameLogFromWorkbook),
// but with every game_results column, not just the handful app.js
// currently reads.
async function computeGamesData(env) {
  const { results } = await env.DB.prepare(`
    SELECT g.id AS game_id, g.season_id, s.label AS season_label, g.game_num,
           g.played_at, g.pod_size, g.playgroup_game_id,
           p.name AS player, d.name AS commander,
           gr.commander_strength, gr.result, gr.place, gr.knockouts, gr.tov,
           gr.pop_off, gr.disruptions, gr.recoveries, gr.games_clearly_behind,
           gr.bracket, gr.adjusted_pod_size_score, gr.knockout_score,
           gr.deck_strength_differential, gr.win_probability, gr.player_score,
           gr.normalized_player_score, gr.normalized_tov, gr.deck_resilience_score,
           gr.game_calculated_deck_strength
    FROM game_results gr
    JOIN games g ON g.id = gr.game_id
    JOIN seasons s ON s.id = g.season_id
    JOIN players p ON p.id = gr.player_id
    JOIN decks d ON d.id = gr.deck_id
    ORDER BY g.id, p.name
  `).all();

  const games = results.map(r => ({
    gameId: r.game_id,
    seasonId: r.season_id,
    seasonLabel: r.season_label,
    gameNum: r.game_num,
    date: r.played_at,
    podSize: r.pod_size,
    playgroupGameId: r.playgroup_game_id,
    player: r.player,
    commander: r.commander,
    commanderStrength: r.commander_strength,
    result: r.result,
    place: r.place,
    knockouts: r.knockouts,
    tov: r.tov,
    popOff: r.pop_off,
    disruptions: r.disruptions,
    recoveries: r.recoveries,
    gamesClearlyBehind: r.games_clearly_behind,
    bracket: r.bracket,
    adjustedPodSizeScore: r.adjusted_pod_size_score,
    knockoutScore: r.knockout_score,
    deckStrengthDifferential: r.deck_strength_differential,
    winProbability: r.win_probability,
    playerScore: r.player_score,
    normalizedPlayerScore: r.normalized_player_score,
    normalizedTov: r.normalized_tov,
    deckResilienceScore: r.deck_resilience_score,
    gameCalculatedDeckStrength: r.game_calculated_deck_strength,
  }));

  return { generated_at: new Date().toISOString(), games };
}

async function handleGames(env) {
  let data;
  try {
    data = await computeGamesData(env);
  } catch (err) {
    return jsonResponse({ error: "Failed to read games from D1", detail: err.message }, 500);
  }
  return jsonResponse(data, 200, { "Cache-Control": "no-store" });
}

// Direct port of computePlayerAdjustedWinRate in app.js -- verified exact
// against the spreadsheet's own cached Player Adjusted Ranks values
// earlier this session. j/k/m here are adjusted_pod_size_score/
// knockout_score/win_probability, kept short to stay visually close to
// the formula it mirrors.
function computePlayerAdjustedWinRate(rows) {
  const wins = rows.filter(g => g.result === 1);
  const losses = rows.filter(g => g.result === 0);
  const C = wins.length, D = losses.length;
  const F = wins.reduce((s, g) => s + g.j, 0);
  const avgJLosses = D ? losses.reduce((s, g) => s + g.j, 0) / D : 0;
  const G = (1 - (avgJLosses * -1)) * D;
  const H = (F + G) ? F / (F + G) : 0;
  const I = C ? rows.reduce((s, g) => s + g.k, 0) / rows.length : 0;
  const avgMWins = C ? wins.reduce((s, g) => s + g.m, 0) / C : 0;
  const Jagg = (1 - (avgMWins - 0.5)) * C;
  const avgMLosses = D ? losses.reduce((s, g) => s + g.m, 0) / D : 0;
  const Kagg = (1 + (avgMLosses - 0.5)) * D;
  const L = (Jagg + Kagg) ? Jagg / (Jagg + Kagg) : 0;
  const B = H * 0.3 + I * 0.2 + L * 0.5;
  return { rate: B, wins: C, losses: D };
}

// seasonId is required -- made season-selectable (rather than always
// MAX(season_id)) so GET /achievements can rank a specific past season
// too, same as every other achievement already supports via its own
// ?season= param. Same "one season at a time" rule app.js's
// gameLogRowsFromD1 and discord_report.py's current_season_games already
// established (Player Adjusted Ranks has never combined seasons).
async function computeRankingsData(env, seasonId) {
  const { results: playerRows } = await env.DB.prepare("SELECT id, name FROM players ORDER BY id").all();
  const { results: gameRows } = await env.DB.prepare(`
    SELECT p.name AS player, gr.result,
           gr.adjusted_pod_size_score AS j, gr.knockout_score AS k, gr.win_probability AS m
    FROM game_results gr
    JOIN players p ON p.id = gr.player_id
    JOIN games g ON g.id = gr.game_id
    WHERE g.season_id = ?
  `).bind(seasonId).all();

  const byPlayer = {};
  for (const row of gameRows) {
    (byPlayer[row.player] ||= []).push(row);
  }

  const rankings = playerRows
    .map(p => ({ playerId: p.id, player: p.name, ...computePlayerAdjustedWinRate(byPlayer[p.name] || []) }))
    .sort((a, b) => b.rate - a.rate);

  return { generated_at: new Date().toISOString(), rankings };
}

async function handleRankings(env) {
  let data;
  try {
    const latest = await env.DB.prepare("SELECT MAX(season_id) AS id FROM games").first();
    data = await computeRankingsData(env, latest.id);
  } catch (err) {
    return jsonResponse({ error: "Failed to compute rankings from D1", detail: err.message }, 500);
  }
  return jsonResponse(data, 200, { "Cache-Control": "no-store" });
}

// Deck Win Rates: plain COUNT/SUM grouped by deck, and separately by
// player for the subtotal rows -- confirmed via direct inspection that
// the spreadsheet's own version is exactly this (COUNTIFS/IFERROR), not a
// PivotTable as earlier assumed. Nested (player -> its decks) rather than
// the spreadsheet's flat "player row then indented deck rows" layout,
// since JSON has no reason to imitate that convention.
// seasonId scopes the games/wins counted to one season, same "current
// season, never combined across seasons" rule computeRankingsData already
// follows -- decks that carried over from a prior season used to have that
// season's game_results counted in here too (LEFT JOIN game_results with no
// games/season_id join at all), inflating the games/wins shown for the
// active season with the prior season's numbers mixed in.
async function computeDeckWinRatesData(env, seasonId) {
  const { results: deckRows } = await env.DB.prepare(`
    SELECT d.id AS deck_id, d.player_id, p.name AS player, d.name AS deck,
           COUNT(gr.result) AS games_played,
           COALESCE(SUM(CASE WHEN gr.result = 1 THEN 1 ELSE 0 END), 0) AS wins
    FROM decks d
    JOIN players p ON p.id = d.player_id
    LEFT JOIN game_results gr ON gr.deck_id = d.id
      AND gr.game_id IN (SELECT id FROM games WHERE season_id = ?)
    GROUP BY d.id
    ORDER BY d.id
  `).bind(seasonId).all();

  const { results: playerRows } = await env.DB.prepare(`
    SELECT p.id AS player_id, p.name AS player,
           COUNT(gr.result) AS games_played,
           COALESCE(SUM(CASE WHEN gr.result = 1 THEN 1 ELSE 0 END), 0) AS wins
    FROM players p
    LEFT JOIN game_results gr ON gr.player_id = p.id
      AND gr.game_id IN (SELECT id FROM games WHERE season_id = ?)
    GROUP BY p.id
    ORDER BY p.id
  `).bind(seasonId).all();

  const decksByPlayer = {};
  for (const d of deckRows) {
    (decksByPlayer[d.player_id] ||= []).push({
      deck: d.deck,
      gamesPlayed: d.games_played,
      wins: d.wins,
      winRate: d.games_played ? d.wins / d.games_played : 0,
    });
  }

  const players = playerRows.map(p => ({
    player: p.player,
    gamesPlayed: p.games_played,
    wins: p.wins,
    winRate: p.games_played ? p.wins / p.games_played : 0,
    decks: decksByPlayer[p.player_id] || [],
  }));

  return { generated_at: new Date().toISOString(), players };
}

async function handleDeckWinRates(env) {
  let data;
  try {
    const latest = await env.DB.prepare("SELECT MAX(season_id) AS id FROM games").first();
    data = await computeDeckWinRatesData(env, latest.id);
  } catch (err) {
    return jsonResponse({ error: "Failed to compute Deck Win Rates from D1", detail: err.message }, 500);
  }
  return jsonResponse(data, 200, { "Cache-Control": "no-store" });
}

// ---------- GET /achievements, POST /achievements/backfill ----------

// Shared helpers every ACHIEVEMENTS entry below builds on, so ranking/
// grouping logic lives in one place instead of being reimplemented per
// achievement. Rows from either query below (see gatherAchievementContext)
// all carry player_id/name, so these work against both.
function groupByPlayer(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.player_id)) map.set(r.player_id, { playerId: r.player_id, name: r.name, rows: [] });
    map.get(r.player_id).rows.push(r);
  }
  return [...map.values()];
}
function sumField(rows, field) {
  return rows.reduce((s, r) => s + (r[field] || 0), 0);
}

// Cache-busts the /emblems/*.png files the same way index.html's own
// ?v=N busts app.js/style.css -- unlike those two, the emblem PNGs have
// no build step to bump a version number in, so this is a plain constant
// bumped by hand whenever the underlying image content changes (confirmed
// the hard way that a phone which had already loaded an older crop just
// kept serving it from cache, since the filename itself never changed).
// Bump this any time /emblems/*.png files get new content, even though
// their filenames stay the same.
//
// v5: every achievement's art replaced in one pass, and the art itself
// changed shape -- it's plain circular art now, with no title/description
// baked in (see renderAchievements in app.js). That used to be baked into
// the image, which is exactly what went stale and wrong when "The Wrench"
// got renamed to "Punching Bag" (the old art still read THE WRENCH), and
// what let two real typos ("Mest wins ky...", "Most 2od-place...") ship
// silently in art nobody proofread as text. Real HTML text can't drift
// from the title/description above it or carry a typo an image can hide.
//
// v6: re-cropped the 32 badges that came from one shared grid image. Its
// spiky frames touch or overlap between adjacent badges (confirmed by
// measuring: some columns have literally 0-6px of separation), so the
// first pass's rigid per-cell rectangle sometimes grabbed a sliver of a
// neighboring badge's frame along with the real one. Re-cropped with a
// nearest-seed (watershed) split instead of a fixed grid, so a touching
// pixel is assigned to whichever badge it actually belongs to.
const EMBLEM_CACHE_BUST = "9";
function emblemUrl(path) {
  return path ? `${path}?v=${EMBLEM_CACHE_BUST}` : path;
}
function avgField(rows, field) {
  const vals = rows.map(r => r[field]).filter(v => v !== null && v !== undefined);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
// Ranks grouped-by-player entries by valueFn, dropping anyone below
// minGames or whose value comes back null/NaN (not enough data, not a
// real zero). ascending:true for "lowest wins" achievements (fewest
// mulligans, earliest exit).
function topPlayer(byPlayer, valueFn, { minGames = 1, ascending = false } = {}) {
  const scored = byPlayer
    .filter(p => p.rows.length >= minGames)
    .map(p => ({ playerId: p.playerId, name: p.name, value: valueFn(p.rows) }))
    .filter(p => p.value !== null && p.value !== undefined && !Number.isNaN(p.value));
  if (scored.length === 0) return null;
  scored.sort((a, b) => (ascending ? a.value - b.value : b.value - a.value));
  return scored[0];
}
// gameResults rows already carry win_con (see gatherAchievementContext) --
// this groups by player among wins matching `predicate(win_con)`, for the
// Timmy/Johnny awards below.
function winsByCondition(gameResults, predicate) {
  return groupByPlayer(gameResults.filter(r => r.result === 1 && predicate(r.win_con)));
}

// Below this, most achievements need at least a few games before a
// rate/average means anything -- a single lucky (or unlucky) game
// shouldn't win "saltiest player." Pure counting stats (most damage, most
// knockouts) deliberately don't use this; playing more games earning a
// higher total is the whole point of a season-long counting stat.
const MIN_GAMES_FOR_RATE = 3;

// A small, deliberately extensible list rather than one hardcoded query --
// adding another achievement means adding an entry here, not a redesign.
// `emblem` is a path (relative to the static site's own root, not this
// Worker) to a custom-illustrated badge PNG -- see renderAchievements in
// app.js and the /emblems directory. Cropped and chroma-keyed (black ->
// transparent) from one big AI-generated "badge grid" image, not drawn by
// hand -- replaced an earlier emoji-per-card version, which itself
// replaced a single repeated generic trophy icon. Each `compute(ctx)`
// returns
// {playerId, name, value, display} for the current season's winner, or
// null if there's not enough data yet (a genuine empty state, not an
// error). `display` is the exact string the frontend shows, computed here
// rather than assembled client-side from a generic {value, unit} pair,
// since these span plain counts, ratios, percentages, and averages that
// don't share one format.
const ACHIEVEMENTS = [
  {
    id: "season-champion",
    category: "standings",
    title: "Most Likely to Win",
    emblem: "emblems/season-champion.png",
    description: "Highest Player Adjusted Win Rate across the season.",
    compute(ctx) {
      const top = ctx.rankings[0];
      if (!top || top.wins + top.losses === 0) return null;
      return {
        playerId: top.playerId,
        name: top.player,
        value: top.rate,
        display: `${(top.rate * 100).toFixed(1)}% (${top.wins}-${top.losses})`,
      };
    },
  },
  {
    id: "second-place",
    category: "standings",
    title: "Silver Lining",
    emblem: "emblems/second-place.png",
    description: "2nd-highest Player Adjusted Win Rate across the season.",
    compute(ctx) {
      const second = ctx.rankings[1];
      if (!second || second.wins + second.losses === 0) return null;
      return {
        playerId: second.playerId,
        name: second.player,
        value: second.rate,
        display: `${(second.rate * 100).toFixed(1)}% (${second.wins}-${second.losses})`,
      };
    },
  },
  {
    id: "third-place",
    category: "standings",
    title: "Bronze Age",
    emblem: "emblems/third-place.png",
    description: "3rd-highest Player Adjusted Win Rate across the season.",
    compute(ctx) {
      const third = ctx.rankings[2];
      if (!third || third.wins + third.losses === 0) return null;
      return {
        playerId: third.playerId,
        name: third.player,
        value: third.rate,
        display: `${(third.rate * 100).toFixed(1)}% (${third.wins}-${third.losses})`,
      };
    },
  },
  {
    id: "most-damage",
    category: "combat",
    title: "I Hate My Friends",
    emblem: "emblems/most-damage.png",
    description: "Most total damage dealt across the season.",
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => sumField(rows, "damage_dealt"));
      return winner && winner.value > 0 ? { ...winner, display: `${winner.value.toLocaleString()} damage` } : null;
    },
  },
  {
    id: "most-damage-game",
    category: "combat",
    title: "Overkill",
    emblem: "emblems/most-damage-game.png",
    description: "Most damage dealt in a single game.",
    compute(ctx) {
      let best = null;
      for (const r of ctx.eventStats) {
        if (!best || r.damage_dealt > best.value) best = { playerId: r.player_id, name: r.name, value: r.damage_dealt };
      }
      return best && best.value > 0 ? { ...best, display: `${best.value.toLocaleString()} damage in one game` } : null;
    },
  },
  {
    id: "most-healing",
    category: "table",
    title: "The Medic",
    emblem: "emblems/most-healing.png",
    description: "Most total healing done across the season.",
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => sumField(rows, "healing_done"));
      return winner && winner.value > 0 ? { ...winner, display: `${winner.value.toLocaleString()} healing` } : null;
    },
  },
  {
    id: "healing-ratio",
    category: "table",
    title: "The Pacifist",
    emblem: "emblems/healing-ratio.png",
    description: "Most healing done per point of damage dealt.",
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => {
        const damage = sumField(rows, "damage_dealt");
        const healing = sumField(rows, "healing_done");
        if (damage === 0 && healing === 0) return null;
        return healing / Math.max(damage, 1);
      }, { minGames: MIN_GAMES_FOR_RATE });
      return winner && { ...winner, display: `${winner.value.toFixed(2)}× healing per damage dealt` };
    },
  },
  {
    id: "most-knockouts",
    category: "combat",
    title: "Grim Reaper",
    emblem: "emblems/most-knockouts.png",
    description: "Most knockouts across the season.",
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => sumField(rows, "knockouts"));
      return winner && winner.value > 0 ? { ...winner, display: `${winner.value.toLocaleString()} knockouts` } : null;
    },
  },
  {
    id: "most-knockouts-game",
    category: "combat",
    title: "One-Man Army",
    emblem: "emblems/most-knockouts-game.png",
    description: "Most knockouts in a single game.",
    compute(ctx) {
      let best = null;
      for (const r of ctx.eventStats) {
        if (!best || r.knockouts > best.value) best = { playerId: r.player_id, name: r.name, value: r.knockouts };
      }
      return best && best.value > 0 ? { ...best, display: `${best.value} knockout${best.value === 1 ? "" : "s"} in one game` } : null;
    },
  },
  {
    id: "most-fun",
    category: "table",
    title: "Life of the Party",
    emblem: "emblems/most-fun.png",
    description: "Highest average self-reported fun rating.",
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => avgField(rows, "fun_rating"), { minGames: MIN_GAMES_FOR_RATE });
      return winner && { ...winner, display: `${winner.value.toFixed(1)} avg fun rating` };
    },
  },
  {
    id: "saltiest",
    category: "table",
    title: "Tilted",
    emblem: "emblems/saltiest.png",
    description: "Highest average self-reported salt rating.",
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => avgField(rows, "salt_rating"), { minGames: MIN_GAMES_FOR_RATE });
      return winner && { ...winner, display: `${winner.value.toFixed(1)} avg salt rating` };
    },
  },
  {
    id: "most-mulligans",
    category: "tempo",
    title: "Bad Hands",
    emblem: "emblems/most-mulligans.png",
    description: "Most mulligans taken across the season.",
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => sumField(rows, "mulligans_taken"));
      return winner && winner.value > 0 ? { ...winner, display: `${winner.value} mulligan${winner.value === 1 ? "" : "s"}` } : null;
    },
  },
  {
    id: "fewest-mulligans",
    category: "tempo",
    title: "Lucky Draw",
    emblem: "emblems/fewest-mulligans.png",
    description: "Lowest average mulligans taken per game.",
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => avgField(rows, "mulligans_taken"), { minGames: MIN_GAMES_FOR_RATE, ascending: true });
      return winner && { ...winner, display: `${winner.value.toFixed(2)} avg mulligans` };
    },
  },
  {
    id: "combat-wins",
    category: "combat",
    title: "Timmy Award",
    emblem: "emblems/combat-wins.png",
    description: "Most wins by combat damage.",
    compute(ctx) {
      const winner = topPlayer(winsByCondition(ctx.gameResults, wc => wc === "combat"), rows => rows.length);
      return winner && { ...winner, display: `${winner.value} combat win${winner.value === 1 ? "" : "s"}` };
    },
  },
  {
    id: "altwin-wins",
    category: "playstyle",
    title: "Johnny Award",
    emblem: "emblems/altwin-wins.png",
    description: "Most wins by a non-combat win condition.",
    compute(ctx) {
      const winner = topPlayer(winsByCondition(ctx.gameResults, wc => !!wc && wc !== "combat"), rows => rows.length);
      return winner && { ...winner, display: `${winner.value} alt-win-con win${winner.value === 1 ? "" : "s"}` };
    },
  },
  {
    id: "front-runner",
    category: "playstyle",
    title: "Front Runner",
    emblem: "emblems/front-runner.png",
    description: "Best win rate in games they went first.",
    compute(ctx) {
      const wentFirst = groupByPlayer(ctx.gameResults.filter(r => r.starting_player_id === r.player_id));
      const winner = topPlayer(wentFirst, rows => sumField(rows, "result") / rows.length, { minGames: MIN_GAMES_FOR_RATE });
      if (!winner) return null;
      const games = wentFirst.find(p => p.playerId === winner.playerId).rows.length;
      return { ...winner, display: `${Math.round(winner.value * 100)}% win rate going first (${games} games)` };
    },
  },
  {
    id: "closest-call",
    category: "survival",
    title: "Nine Lives",
    emblem: "emblems/closest-call.png",
    description: "Won with the lowest life total remaining.",
    compute(ctx) {
      const resultByKey = new Map(ctx.gameResults.map(r => [`${r.game_id}:${r.player_id}`, r.result]));
      let best = null;
      for (const r of ctx.eventStats) {
        if (r.ending_life === null || r.ending_life === undefined) continue;
        if (resultByKey.get(`${r.game_id}:${r.player_id}`) !== 1) continue;
        if (!best || r.ending_life < best.value) best = { playerId: r.player_id, name: r.name, value: r.ending_life };
      }
      return best && { ...best, display: `Won with ${best.value} life left` };
    },
  },
  {
    id: "untouchable",
    category: "survival",
    title: "Untouchable",
    emblem: "emblems/untouchable.png",
    description: "Won with the highest life total remaining.",
    compute(ctx) {
      const resultByKey = new Map(ctx.gameResults.map(r => [`${r.game_id}:${r.player_id}`, r.result]));
      let best = null;
      for (const r of ctx.eventStats) {
        if (r.ending_life === null || r.ending_life === undefined) continue;
        if (resultByKey.get(`${r.game_id}:${r.player_id}`) !== 1) continue;
        if (!best || r.ending_life > best.value) best = { playerId: r.player_id, name: r.name, value: r.ending_life };
      }
      return best && { ...best, display: `Won with ${best.value} life left` };
    },
  },
  {
    id: "bridesmaid",
    category: "standings",
    title: "Bridesmaid",
    emblem: "emblems/bridesmaid.png",
    description: "Most 2nd-place finishes across the season.",
    compute(ctx) {
      const winner = topPlayer(groupByPlayer(ctx.gameResults.filter(r => r.place === 2)), rows => rows.length);
      return winner && { ...winner, display: `${winner.value} second-place finish${winner.value === 1 ? "" : "es"}` };
    },
  },
  {
    id: "wooden-spoon",
    category: "standings",
    title: "Wooden Spoon",
    emblem: "emblems/wooden-spoon.png",
    description: "Most last-place finishes across the season.",
    compute(ctx) {
      const winner = topPlayer(groupByPlayer(ctx.gameResults.filter(r => r.place === r.pod_size)), rows => rows.length);
      return winner && { ...winner, display: `${winner.value} last-place finish${winner.value === 1 ? "" : "es"}` };
    },
  },
  {
    id: "longest-survivor",
    category: "survival",
    title: "Last One Standing",
    emblem: "emblems/longest-survivor.png",
    description: "Highest average turn of elimination in games they lost.",
    compute(ctx) {
      const winner = topPlayer(groupByPlayer(ctx.gameResults.filter(r => r.result === 0)), rows => avgField(rows, "tov"), { minGames: MIN_GAMES_FOR_RATE });
      return winner && { ...winner, display: `Avg turn ${winner.value.toFixed(1)} when eliminated` };
    },
  },
  {
    id: "early-exit",
    category: "survival",
    title: "Early Exit",
    emblem: "emblems/early-exit.png",
    description: "Lowest average turn of elimination in games they lost.",
    compute(ctx) {
      const winner = topPlayer(groupByPlayer(ctx.gameResults.filter(r => r.result === 0)), rows => avgField(rows, "tov"), { minGames: MIN_GAMES_FOR_RATE, ascending: true });
      return winner && { ...winner, display: `Avg turn ${winner.value.toFixed(1)} when eliminated` };
    },
  },
  {
    id: "most-decks",
    category: "playstyle",
    title: "Brewmaster",
    emblem: "emblems/most-decks.png",
    description: "Most different decks piloted across the season.",
    compute(ctx) {
      const byPlayer = new Map();
      for (const r of ctx.gameResults) {
        if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, { playerId: r.player_id, name: r.name, decks: new Set() });
        byPlayer.get(r.player_id).decks.add(r.deck_id);
      }
      let best = null;
      for (const p of byPlayer.values()) {
        if (!best || p.decks.size > best.value) best = { playerId: p.playerId, name: p.name, value: p.decks.size };
      }
      return best && best.value > 0 ? { ...best, display: `${best.value} different deck${best.value === 1 ? "" : "s"}` } : null;
    },
  },
  {
    id: "most-popoffs",
    category: "playstyle",
    title: "Went Off",
    emblem: "emblems/most-popoffs.png",
    description: "Most pop-off turns across the season.",
    compute(ctx) {
      const winner = topPlayer(groupByPlayer(ctx.gameResults), rows => sumField(rows, "pop_off"));
      return winner && winner.value > 0 ? { ...winner, display: `${winner.value} pop-off${winner.value === 1 ? "" : "s"}` } : null;
    },
  },
  {
    id: "most-disruptions",
    category: "playstyle",
    title: "Punching Bag",
    emblem: "emblems/most-disruptions.png",
    description: "Most times disrupted across the season.",
    compute(ctx) {
      const winner = topPlayer(groupByPlayer(ctx.gameResults), rows => sumField(rows, "disruptions"));
      return winner && winner.value > 0 ? { ...winner, display: `Disrupted ${winner.value} time${winner.value === 1 ? "" : "s"}` } : null;
    },
  },
  {
    id: "best-recovery-rate",
    category: "playstyle",
    title: "Comeback Kid",
    emblem: "emblems/best-recovery-rate.png",
    description: "Best recovery rate after being disrupted.",
    compute(ctx) {
      const byPlayer = groupByPlayer(ctx.gameResults);
      const winner = topPlayer(byPlayer, rows => {
        const disruptions = sumField(rows, "disruptions");
        if (disruptions === 0) return null; // never disrupted -- nothing to recover from, not a perfect score
        return sumField(rows, "recoveries") / disruptions;
      }, { minGames: MIN_GAMES_FOR_RATE });
      if (!winner) return null;
      const rows = byPlayer.find(p => p.playerId === winner.playerId).rows;
      return { ...winner, display: `${Math.round(winner.value * 100)}% recovery rate (${sumField(rows, "disruptions")} disruptions)` };
    },
  },
  {
    id: "longest-turn",
    category: "tempo",
    title: "Analysis Paralysis",
    emblem: "emblems/longest-turn.png",
    description: "Longest single turn across the season.",
    compute(ctx) {
      let best = null;
      for (const r of ctx.eventStats) {
        if (!best || r.longest_turn_seconds > best.value) best = { playerId: r.player_id, name: r.name, value: r.longest_turn_seconds };
      }
      if (!best || best.value <= 0) return null;
      const minutes = Math.floor(best.value / 60);
      const seconds = best.value % 60;
      const display = minutes > 0 ? `${minutes}m ${seconds}s turn` : `${seconds}s turn`;
      return { ...best, display };
    },
  },
  {
    id: "shortest-turn",
    category: "tempo",
    title: "Speedrun",
    emblem: "emblems/shortest-turn.png",
    description: "Lowest average turn length across the season.",
    // Season-wide average (sum of every turn's seconds / total turns taken),
    // not a single fastest turn -- a single instant reading is too easily
    // one logging artifact (two pass_turn events landing in the same
    // wall-clock second) deciding the whole trophy; an average absorbs one
    // outlier instead of being defined by it. Same minGames gate as the
    // other rate-based achievements (fewest mulligans, etc.) so a player
    // with only one or two games can't win on a tiny sample.
    compute(ctx) {
      const winner = topPlayer(ctx.eventStatsByPlayer, rows => {
        const totalTurns = sumField(rows, "turn_count");
        return totalTurns > 0 ? sumField(rows, "total_turn_seconds") / totalTurns : null;
      }, { minGames: MIN_GAMES_FOR_RATE, ascending: true });
      if (!winner) return null;
      const rounded = Math.round(winner.value);
      const minutes = Math.floor(rounded / 60);
      const seconds = rounded % 60;
      const display = minutes > 0 ? `${minutes}m ${seconds}s avg turn` : `${seconds}s avg turn`;
      return { ...winner, display };
    },
  },
];

// Trophy Case shelf order and labels -- every ACHIEVEMENTS entry's
// `category` is one of these ids. Returned as-is by GET /trophy-case so the
// client never hardcodes the grouping.
const ACHIEVEMENT_CATEGORIES = [
  { id: "standings", label: "Standings" },
  { id: "combat", label: "Combat" },
  { id: "survival", label: "Survival" },
  { id: "playstyle", label: "Playstyle" },
  { id: "table", label: "Table" },
  { id: "tempo", label: "Draws & Tempo" },
];
// Current achievements only. season_awards still holds rows for retired
// ids (they were cut after Season 2 minted); every Trophy Case read goes
// through this map so those rows are ignored consistently.
const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map(a => [a.id, a]));
// New/Defending/Dethroned compare the two most recent minted seasons, so
// they stay off until there are two to compare.
const TROPHY_STATUS_MIN_MINTED_SEASONS = 2;
const MAX_TROPHY_PINS = 3;

// One season's worth of raw material every achievement above draws from --
// gathered once per request, not once per achievement, since several
// achievements share the same two row sets. eventStats comes from
// game_event_stats (the playgroup.gg event-log-derived table); gameResults
// comes from game_results (the submitted-game table, already carrying
// place/tov/win_con/starting_player_id via the joins below) -- see
// schema.sql for both.
// Same players and same reasoning as discord_report.py's
// EXCLUDED_FROM_REPORTS -- Kristy and Joseph are inactive and shouldn't be
// crowned a trophy winner. Deliberately scoped to achievements only, not
// applied at the SQL/schema level: /players, /rankings, /games etc. still
// need to return them (their historical games are real and still feed
// other players' own stats -- e.g. a game they lost still counts toward
// whoever beat them), this only ever removes them from being the *winner*
// shown for a trophy. Filtering once here, at the one place every
// achievement's compute() reads from, means every achievement is covered
// without each one needing its own exclusion check -- next-highest-ranked
// eligible player wins instead, same as if the excluded player had simply
// not played.
const EXCLUDED_FROM_TROPHIES = ["Kristy", "Joseph"];

async function gatherAchievementContext(env, seasonId) {
  const [eventStatsRes, gameResultsRes, rankingsData] = await Promise.all([
    env.DB.prepare(`
      SELECT s.game_id, s.player_id, p.name, s.damage_dealt, s.healing_done, s.knockouts,
             s.fun_rating, s.salt_rating, s.mulligans_taken, s.self_rating,
             s.damage_taken, s.healing_received, s.ending_life,
             s.pauses_called, s.pause_seconds, s.undos, s.longest_turn_seconds, s.shortest_turn_seconds,
             s.turn_count, s.total_turn_seconds
      FROM game_event_stats s
      JOIN games g ON g.id = s.game_id
      JOIN players p ON p.id = s.player_id
      WHERE g.season_id = ?
    `).bind(seasonId).all(),
    env.DB.prepare(`
      SELECT gr.game_id, gr.player_id, p.name, gr.place, gr.result, gr.tov, gr.deck_id,
             gr.pop_off, gr.disruptions, gr.recoveries, gr.games_clearly_behind,
             g.pod_size, g.win_con, g.starting_player_id
      FROM game_results gr
      JOIN games g ON g.id = gr.game_id
      JOIN players p ON p.id = gr.player_id
      WHERE g.season_id = ?
    `).bind(seasonId).all(),
    // Reuses the same Player Adjusted Win Rate formula the (currently
    // otherwise-unused) GET /rankings already computes -- verified exact
    // against the spreadsheet's own cached values, so "Season Champion"
    // below crowns the same player the Player Win Rates tab would call
    // #1, not a second, different opinion about who's winning.
    computeRankingsData(env, seasonId),
  ]);
  const eventStats = eventStatsRes.results.filter(r => !EXCLUDED_FROM_TROPHIES.includes(r.name));
  const gameResults = gameResultsRes.results.filter(r => !EXCLUDED_FROM_TROPHIES.includes(r.name));
  const rankings = rankingsData.rankings.filter(r => !EXCLUDED_FROM_TROPHIES.includes(r.player));
  return {
    eventStats, gameResults, rankings,
    eventStatsByPlayer: groupByPlayer(eventStats),
  };
}

// The same season context with one player's rows removed from every source
// a compute() can read. Every compute is a pure function of ctx, so running
// it again on this gives "the best result by anyone else" -- the runner-up.
// For the fixed-index ranking trophies that naturally means the next
// finisher down (Most Likely to Win -> 2nd place, Silver Lining -> 3rd,
// Bronze Age -> 4th); for single-game trophies it's the best game by a
// different player, not the winner's own second-best game.
function ctxWithoutPlayer(ctx, playerId) {
  const eventStats = ctx.eventStats.filter(r => r.player_id !== playerId);
  return {
    eventStats,
    gameResults: ctx.gameResults.filter(r => r.player_id !== playerId),
    rankings: ctx.rankings.filter(r => r.playerId !== playerId),
    eventStatsByPlayer: groupByPlayer(eventStats),
  };
}

// Winner and runner-up for every achievement, in ACHIEVEMENTS order. The
// filtered context is built once per distinct winner (one player can win
// a dozen trophies in a season).
function computeSeasonAchievements(ctx) {
  const withoutByPlayer = new Map();
  return ACHIEVEMENTS.map(a => {
    const winner = a.compute(ctx);
    if (!winner) return { id: a.id, winner: null, runnerUp: null };
    if (!withoutByPlayer.has(winner.playerId)) {
      withoutByPlayer.set(winner.playerId, ctxWithoutPlayer(ctx, winner.playerId));
    }
    return { id: a.id, winner, runnerUp: a.compute(withoutByPlayer.get(winner.playerId)) };
  });
}

// ---------- Season-close Discord announcement ----------

const PLACE_ORDINAL = { 1: "First", 2: "Second", 3: "Third" };
const PLACE_EMOJI = { 1: "🥇", 2: "🥈", 3: "🥉" };

// Picks a player's best deck for the season-winners announcement: highest
// win rate among decks with gamesPlayed >= MIN_GAMES_FOR_RATE (same floor
// used everywhere else a rate-based winner is picked -- see ACHIEVEMENTS).
// Falls back to whichever deck they played the most if nothing clears that
// floor, rather than omitting the line -- a real top-3 finisher always gets
// a best-deck callout.
function pickBestDeck(decks) {
  if (!decks.length) return null;
  const qualifying = decks.filter(d => d.gamesPlayed >= MIN_GAMES_FOR_RATE);
  if (qualifying.length) {
    return qualifying.slice().sort((a, b) => b.winRate - a.winRate || b.gamesPlayed - a.gamesPlayed)[0];
  }
  return decks.slice().sort((a, b) => b.gamesPlayed - a.gamesPlayed || b.winRate - a.winRate)[0];
}

// Gathers everything formatSeasonWinnersMessage needs. Reuses
// gatherAchievementContext's own rankings (same EXCLUDED_FROM_TROPHIES
// filter, same wins+losses===0 null guard as season-champion/second-place/
// third-place) so this can never disagree with the Trophy Case for this
// season -- deliberately not a second, different standings computation.
// players.discord_user_id may be null for a top-3 finisher never manually
// linked -- callers fall back to their plain name, never fail.
// `precomputed` is the { achievementCtx, computed } the close path already
// built while minting; without it (the debug route) this computes the same
// thing itself but never mints.
async function gatherSeasonWinnersData(env, seasonId, precomputed = null) {
  const [achievementCtx, deckWinRatesData, seasonRow] = await Promise.all([
    precomputed ? precomputed.achievementCtx : gatherAchievementContext(env, seasonId),
    computeDeckWinRatesData(env, seasonId),
    env.DB.prepare("SELECT label FROM seasons WHERE id = ?").bind(seasonId).first(),
  ]);
  const computed = precomputed ? precomputed.computed : computeSeasonAchievements(achievementCtx);

  const deckDataByPlayerName = new Map(deckWinRatesData.players.map(p => [p.player, p]));

  // Fixed index 0/1/2, exactly like season-champion/second-place/third-place's
  // own compute(ctx) -- not "skip empty slots and compact" -- so this always
  // agrees with the Trophy Case even in the same edge cases.
  const placements = [0, 1, 2].map(i => {
    const r = achievementCtx.rankings[i];
    if (!r || r.wins + r.losses === 0) return null;
    const deckData = deckDataByPlayerName.get(r.player);
    return {
      place: i + 1,
      playerId: r.playerId,
      playerName: r.player,
      winRate: r.rate,
      wins: r.wins,
      losses: r.losses,
      bestDeck: pickBestDeck(deckData ? deckData.decks : []),
      discordUserId: null, // filled in below
    };
  }).filter(Boolean);

  const haul = computeTrophyHaul(computed);

  const people = [...placements, ...(haul ? haul.players : [])];
  if (people.length) {
    const ids = [...new Set(people.map(p => p.playerId))];
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, discord_user_id FROM players WHERE id IN (${placeholders})`
    ).bind(...ids).all();
    const discordIdByPlayerId = Object.fromEntries(results.map(r => [r.id, r.discord_user_id]));
    for (const p of people) p.discordUserId = discordIdByPlayerId[p.playerId] || null;
  }

  return {
    seasonId,
    seasonLabel: seasonRow ? seasonRow.label : `Season ${seasonId}`,
    placements,
    haul,
  };
}

// Who won the most trophies in one season: every player tied at the top,
// alphabetical. `computed` comes from computeSeasonAchievements, so it only
// ever covers current achievements.
function computeTrophyHaul(computed) {
  const byPlayer = new Map();
  for (const c of computed) {
    if (!c.winner) continue;
    const entry = byPlayer.get(c.winner.playerId) || { playerId: c.winner.playerId, playerName: c.winner.name, count: 0 };
    entry.count++;
    byPlayer.set(c.winner.playerId, entry);
  }
  if (!byPlayer.size) return null;
  const top = Math.max(...[...byPlayer.values()].map(e => e.count));
  const players = [...byPlayer.values()]
    .filter(e => e.count === top)
    .sort((a, b) => a.playerName.localeCompare(b.playerName))
    .map(e => ({ playerId: e.playerId, playerName: e.playerName, discordUserId: null }));
  return { count: top, players };
}

// Discord-markdown announcement text in Tonk Tonk's established
// goblin-merchant voice (see archidekt-trading-app's _worker.js -- no shared
// voice module across repos, this is hand-matched). Win rate + W-L record
// matches the exact display format season-champion/second-place/third-place
// already use in-app, for consistency. A finisher with no linked Discord
// account gets their plain bolded name instead of an @mention.
function formatSeasonWinnersMessage(data) {
  const mention = p => (p.discordUserId ? `<@${p.discordUserId}>` : `**${p.playerName}**`);
  const lines = [
    `🔔 Tonk Tonk ring the big bell! **${data.seasonLabel} Winners** is in, come see who top the pod this time!`,
    "",
  ];
  for (const p of data.placements) {
    const pct = (p.winRate * 100).toFixed(1);
    const deckLine = p.bestDeck
      ? `best deck **${p.bestDeck.deck}** (${(p.bestDeck.winRate * 100).toFixed(1)}% over ${p.bestDeck.gamesPlayed} games)`
      : "no deck logged this season, hmm";
    lines.push(`${PLACE_EMOJI[p.place]} **${PLACE_ORDINAL[p.place]} Place** — ${mention(p)}, ${pct}% win rate (${p.wins}-${p.losses}), ${deckLine}!`);
  }
  if (data.haul) {
    const names = data.haul.players.map(mention);
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    const each = names.length > 1 ? " each" : "";
    const noun = data.haul.count === 1 ? "trophy" : "trophies";
    lines.push("", `🏆 Biggest haul: ${who}${each} walk away with **${data.haul.count} ${noun}**! Tonk Tonk need bigger shelf!`);
  }
  lines.push("", "🤑 Great season, everybody! Tonk Tonk already sharpening deals for the next one, come back soon!");
  return lines.join("\n");
}

// Best-effort: called only from handleSeasonClose's ctx.waitUntil, never
// awaited on the request/response path. Posts to archidekt-trading-app's
// shared-secret-gated relay endpoint rather than holding a copy of the real
// Discord bot token here. Throws on any failure -- the caller's
// ctx.waitUntil.catch() logs it; never surfaced to whoever closed the
// season, never retried, never undoes the close.
async function announceSeasonWinners(env, seasonId, precomputed = null) {
  const data = await gatherSeasonWinnersData(env, seasonId, precomputed);
  if (!data.placements.length) {
    console.log(`Season ${seasonId} closed with no eligible finishers -- skipping Discord announcement.`);
    return;
  }
  const content = formatSeasonWinnersMessage(data);
  const res = await fetch(`${ARCHIDEKT_TRADING_APP_BASE_URL}/api/internal/season-winners-announce`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Season-Announce-Key": env.SEASON_ANNOUNCE_API_KEY,
    },
    body: JSON.stringify({ channelName: "season_winners", content }),
  });
  if (!res.ok) {
    throw new Error(`archidekt-trading-app season-winners-announce failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
}

// Debug/verification aid ONLY -- computes and returns the exact data and
// exact message string announceSeasonWinners would fire, without ever
// calling archidekt-trading-app or Discord. ?season= optional (defaults to
// the current, possibly-still-open season via resolveSeasonId). Exists so
// the exact text can always be reviewed before a real season close, per the
// standing "never test-post to real Discord without sign-off" rule.
async function handleDebugSeasonWinners(request, env) {
  const url = new URL(request.url);
  const seasonParam = url.searchParams.get("season");
  let seasonId;
  try {
    seasonId = seasonParam ? Number(seasonParam) : await resolveSeasonId(env);
  } catch (err) {
    return jsonResponse({ error: "Failed to resolve current season from playgroup.gg", detail: err.message }, 502);
  }
  const data = await gatherSeasonWinnersData(env, seasonId);
  const message = data.placements.length ? formatSeasonWinnersMessage(data) : null;
  return jsonResponse({ seasonId, data, message }, 200, { "Cache-Control": "no-store" });
}

// Freezes a season's winners permanently the first time it's read as
// concluded (called from handleAchievements right after it computes real
// winners for an inactive season) -- see the Trophy Case feature. A
// COUNT short-circuit makes every read after the first one this season
// free, and doubles as the race guard: two near-simultaneous first-reads
// both pass this check, but the INSERT OR IGNORE + (season_id,
// achievement_id) PRIMARY KEY below makes the loser of that race a
// no-op per row rather than a duplicate or an error, same reasoning
// resolveSeasonId's own INSERT OR IGNORE already relies on. Takes the
// computeSeasonAchievements result this same request already built rather
// than recomputing anything. Written as one batch, so a season is either
// fully minted or not at all -- a failure part-way can never leave a
// partial season that the COUNT check would then treat as done. Once
// written, a row's winner is never updated or deleted, even if the
// underlying game data were ever corrected later -- what you won is what
// you won.
async function mintSeasonAwardsIfNeeded(env, seasonId, computed) {
  const { count } = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM season_awards WHERE season_id = ?"
  ).bind(seasonId).first();
  if (count > 0) return;

  const inserts = computed.filter(c => c.winner).map(c => env.DB.prepare(`
    INSERT OR IGNORE INTO season_awards
      (season_id, achievement_id, player_id, value, display, runner_up_player_id, runner_up_value, runner_up_display)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    seasonId, c.id, c.winner.playerId, c.winner.value ?? null, c.winner.display,
    c.runnerUp ? c.runnerUp.playerId : null,
    c.runnerUp ? c.runnerUp.value ?? null : null,
    c.runnerUp ? c.runnerUp.display : null,
  ));
  if (inserts.length) await env.DB.batch(inserts);
}

// Everything a season close needs, in one place: compute the context,
// every winner and runner-up, and mint them. Used by handleAchievements
// (lazy, on first read of a finished season) and handleSeasonClose (eager,
// at the moment of closing).
async function computeAndMintSeason(env, seasonId) {
  const achievementCtx = await gatherAchievementContext(env, seasonId);
  const computed = computeSeasonAchievements(achievementCtx);
  await mintSeasonAwardsIfNeeded(env, seasonId, computed);
  return { achievementCtx, computed };
}

// season query param defaults to the most recent season (highest id) --
// there's only ever one season active at a time in practice, so "most
// recent" and "current" agree today; this just avoids the client having
// to know a season id up front for the common case.
//
// Winners stay hidden while a season is still being played -- only the
// title/description/emblem go out, `winner` comes back null for every
// achievement -- and get revealed once playgroup.gg's active league moves
// on to a new one. Same "nothing revealed before it should be" spirit as
// pod validation masking deck identity/power until a pod actually passes.
// A season is "active" if its own playgroup_league_id matches the
// currently active league; legacy seasons (migrated from the old
// spreadsheet, no playgroup_league_id at all) and any other past season
// never match, so their winners always show. If the live league check
// itself fails, this fails toward HIDDEN, not revealed -- wrongly hiding
// a finished season's winners for a moment is a much smaller cost than
// spoiling an in-progress one.
async function handleAchievements(request, env, session) {
  const url = new URL(request.url);
  const seasonParam = url.searchParams.get("season");

  const { results: seasons } = await env.DB.prepare("SELECT id, label, playgroup_league_id, closed_at FROM seasons ORDER BY id").all();
  if (seasons.length === 0) {
    return jsonResponse({ seasons: [], seasonId: null, seasonActive: false, achievements: [] }, 200, { "Cache-Control": "no-store" });
  }

  const seasonId = seasonParam ? Number(seasonParam) : seasons[seasons.length - 1].id;
  const seasonRow = seasons.find(s => s.id === seasonId);
  if (!seasonRow) {
    return jsonResponse({ error: `Unknown season ${seasonId}` }, 400);
  }

  let seasonActive = true;
  if (seasonRow.closed_at) {
    // Manually closed (see POST /seasons/close) -- stays inactive regardless
    // of what playgroup.gg's active league is or becomes, and regardless of
    // whether playgroup.gg is even reachable right now.
    seasonActive = false;
  } else {
    try {
      const activeLeague = await getActiveLeagueId(env);
      seasonActive = !!seasonRow.playgroup_league_id && String(activeLeague.id) === String(seasonRow.playgroup_league_id);
    } catch (err) {
      console.error("Failed to resolve active league for achievements reveal check:", err);
    }
  }

  let achievements;
  if (seasonActive) {
    achievements = ACHIEVEMENTS.map(a => ({ id: a.id, title: a.title, emblem: emblemUrl(a.emblem), description: a.description, winner: null }));
  } else {
    const { computed } = await computeAndMintSeason(env, seasonId);
    achievements = ACHIEVEMENTS.map((a, i) => ({ id: a.id, title: a.title, emblem: emblemUrl(a.emblem), description: a.description, winner: computed[i].winner }));
  }

  return jsonResponse({
    seasons: seasons.map(({ id, label }) => ({ id, label })),
    seasonId,
    seasonActive,
    achievements,
  }, 200, { "Cache-Control": "no-store" });
}

// One player's full trophy history, aggregated across every closed
// season's minted season_awards rows -- distinct from GET /achievements,
// which only ever shows one season (live or minted) at a time. Includes
// every achievement id, not just the ones this player has won, so the
// client can render locked slots. `player` defaults to the caller's own
// id but is overridable to view anyone's case -- no extra permission
// check beyond the existing session requirement, matching every other
// stats view in this app (Player Win Rates, Games to Update) where any
// signed-in player can already see anyone's numbers. A player who's
// EXCLUDED_FROM_TROPHIES simply has no season_awards rows at all (that
// filter runs upstream, inside gatherAchievementContext, before minting
// ever sees their name) -- their case renders as all-locked with no
// extra filtering needed here.
//
// Per slot, on top of won/count/latest*: category (shelf), history (every
// season won), holders (distinct players who have ever won it -- rarity),
// runnerUp (locked slots only: the latest season this player finished
// second for it), status (new/defending/dethroned against the two most
// recent minted seasons, only once there are two), and pinned.
async function handleTrophyCase(request, env, session) {
  const url = new URL(request.url);
  const playerParam = url.searchParams.get("player");
  const playerId = playerParam ? Number(playerParam) : session.playerId;

  const [player, minted, pinsRes] = await Promise.all([
    env.DB.prepare("SELECT id, name FROM players WHERE id = ?").bind(playerId).first(),
    loadMintedAwards(env),
    env.DB.prepare("SELECT achievement_id FROM trophy_pins WHERE player_id = ? ORDER BY position").bind(playerId).all(),
  ]);
  if (!player) {
    return jsonResponse({ error: `Unknown player ${playerId}` }, 400);
  }

  const { mintedSeasons, rows } = minted;
  const pins = pinsRes.results.map(r => r.achievement_id).filter(id => ACHIEVEMENT_BY_ID.has(id));
  const pinned = new Set(pins);
  const statusTagsActive = mintedSeasons.length >= TROPHY_STATUS_MIN_MINTED_SEASONS;
  const latestSeasonId = mintedSeasons.length ? mintedSeasons[mintedSeasons.length - 1].id : null;
  const previousSeasonId = mintedSeasons.length >= 2 ? mintedSeasons[mintedSeasons.length - 2].id : null;

  // rows come back season-ascending, so each per-achievement list is too.
  const rowsByAchievement = new Map();
  for (const r of rows) {
    if (!rowsByAchievement.has(r.achievement_id)) rowsByAchievement.set(r.achievement_id, []);
    rowsByAchievement.get(r.achievement_id).push(r);
  }

  const slots = ACHIEVEMENTS.map(a => {
    const all = rowsByAchievement.get(a.id) || [];
    const mine = all.filter(r => r.player_id === player.id);
    const latest = mine[mine.length - 1];

    let status = null;
    if (statusTagsActive) {
      const wonLatest = mine.some(r => r.season_id === latestSeasonId);
      const wonPrevious = mine.some(r => r.season_id === previousSeasonId);
      const takenByOther = all.some(r => r.season_id === latestSeasonId && r.player_id !== player.id);
      if (wonLatest && wonPrevious) status = "defending";
      else if (wonLatest) status = "new";
      else if (wonPrevious && takenByOther) status = "dethroned";
    }

    let runnerUp = null;
    if (!mine.length) {
      const ru = [...all].reverse().find(r => r.runner_up_player_id === player.id);
      if (ru) {
        runnerUp = { seasonLabel: ru.season_label, display: ru.runner_up_display, winnerName: ru.winner_name, winnerDisplay: ru.display };
      }
    }

    return {
      id: a.id,
      title: a.title,
      description: a.description,
      emblem: emblemUrl(a.emblem),
      category: a.category,
      won: mine.length > 0,
      count: mine.length,
      latestSeasonLabel: latest ? latest.season_label : null,
      latestDisplay: latest ? latest.display : null,
      history: mine.map(r => ({ seasonId: r.season_id, seasonLabel: r.season_label, display: r.display })),
      holders: new Set(all.map(r => r.player_id)).size,
      status,
      runnerUp,
      pinned: pinned.has(a.id),
    };
  });

  return jsonResponse({
    playerId: player.id,
    playerName: player.name,
    totalSlots: ACHIEVEMENTS.length,
    mintedSeasonCount: mintedSeasons.length,
    mintedSeasons,
    statusTagsActive,
    categories: ACHIEVEMENT_CATEGORIES,
    pins,
    slots,
  }, 200, { "Cache-Control": "no-store" });
}

// Every minted season_awards row with its season label and winner name,
// season-ascending. mintedSeasons is every season with any rows at all;
// rows is filtered to current achievements, so retired ids never reach the
// Trophy Case, rarity counts or the leaderboard.
async function loadMintedAwards(env) {
  const { results } = await env.DB.prepare(`
    SELECT sa.season_id, s.label AS season_label, sa.achievement_id, sa.player_id,
           w.name AS winner_name, sa.display, sa.runner_up_player_id, sa.runner_up_display
    FROM season_awards sa
    JOIN seasons s ON s.id = sa.season_id
    JOIN players w ON w.id = sa.player_id
    ORDER BY sa.season_id ASC
  `).all();
  const seasonsById = new Map();
  for (const r of results) {
    if (!seasonsById.has(r.season_id)) seasonsById.set(r.season_id, { id: r.season_id, label: r.season_label });
  }
  return {
    mintedSeasons: [...seasonsById.values()],
    rows: results.filter(r => ACHIEVEMENT_BY_ID.has(r.achievement_id)),
  };
}

// GET /trophy-leaderboard -- "Most Decorated": every player (minus
// EXCLUDED_FROM_TROPHIES) ranked by distinct current trophies held across
// all minted seasons, then total wins (repeats count), then name. Equal
// trophies and total wins share a rank (1, 2, 3, 3, 3, 6).
async function handleTrophyLeaderboard(env) {
  const [minted, playersRes] = await Promise.all([
    loadMintedAwards(env),
    env.DB.prepare("SELECT id, name FROM players ORDER BY id").all(),
  ]);

  const countsByPlayer = new Map();
  for (const r of minted.rows) {
    if (!countsByPlayer.has(r.player_id)) countsByPlayer.set(r.player_id, new Map());
    const counts = countsByPlayer.get(r.player_id);
    counts.set(r.achievement_id, (counts.get(r.achievement_id) || 0) + 1);
  }

  const rows = playersRes.results
    .filter(p => !EXCLUDED_FROM_TROPHIES.includes(p.name))
    .map(p => {
      const counts = countsByPlayer.get(p.id) || new Map();
      return {
        playerId: p.id,
        name: p.name,
        trophies: counts.size,
        totalWins: [...counts.values()].reduce((sum, n) => sum + n, 0),
        emblems: ACHIEVEMENTS.filter(a => counts.has(a.id))
          .map(a => ({ id: a.id, title: a.title, emblem: emblemUrl(a.emblem), count: counts.get(a.id) })),
      };
    })
    .sort((a, b) => b.trophies - a.trophies || b.totalWins - a.totalWins || a.name.localeCompare(b.name));

  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && prev.trophies === r.trophies && prev.totalWins === r.totalWins ? prev.rank : i + 1;
  });

  return jsonResponse({
    totalSlots: ACHIEVEMENTS.length,
    mintedSeasonCount: minted.mintedSeasons.length,
    rows,
  }, 200, { "Cache-Control": "no-store" });
}

// POST /trophy-case/pins -- replaces the signed-in player's pinned
// trophies (shown next to their name on the Player Win Rates tab). This is
// the app's one own-player-only write: every other write endpoint edits
// shared pod data any member may fix, but pins are a personal choice, so
// this always writes session.playerId and ignores any player id in the
// body. Only trophies the caller has actually won can be pinned.
async function handleTrophyPinsWrite(request, env, session) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const ids = payload ? payload.achievementIds : undefined;
  if (!Array.isArray(ids)) {
    return jsonResponse({ error: "achievementIds must be an array" }, 400);
  }
  if (ids.length > MAX_TROPHY_PINS) {
    return jsonResponse({ error: `You can pin up to ${MAX_TROPHY_PINS} trophies.` }, 400);
  }
  if (ids.some(id => typeof id !== "string" || !ACHIEVEMENT_BY_ID.has(id))) {
    return jsonResponse({ error: "Unknown trophy." }, 400);
  }
  if (new Set(ids).size !== ids.length) {
    return jsonResponse({ error: "Each trophy can only be pinned once." }, 400);
  }

  const playerId = session.playerId;
  if (ids.length) {
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT achievement_id FROM season_awards WHERE player_id = ?"
    ).bind(playerId).all();
    const won = new Set(results.map(r => r.achievement_id));
    const notWon = ids.find(id => !won.has(id));
    if (notWon) {
      return jsonResponse({ error: `You haven't won ${ACHIEVEMENT_BY_ID.get(notWon).title} yet.` }, 403);
    }
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM trophy_pins WHERE player_id = ?").bind(playerId),
    ...ids.map((id, position) => env.DB.prepare(
      "INSERT INTO trophy_pins (player_id, achievement_id, position) VALUES (?, ?, ?)"
    ).bind(playerId, id, position)),
  ]);
  return jsonResponse({ ok: true, playerId, pins: ids }, 200);
}

// POST /achievements/backfill-runner-ups[?dryRun=true] -- fills the
// runner_up_* columns for rows minted before those columns existed (see
// schema.sql). Safe to rerun: only ever touches rows WHERE
// runner_up_player_id IS NULL, and never changes a winner. Before filling
// a row it recomputes the winner from today's data; if that no longer
// matches the stored winner (game data corrected since minting), the row
// is reported as winner-mismatch and skipped rather than guessed at. The
// runner-up always excludes the *stored* winner.
async function handleRunnerUpBackfill(env, dryRun) {
  const { results } = await env.DB.prepare(
    "SELECT season_id, achievement_id, player_id, runner_up_player_id FROM season_awards ORDER BY season_id"
  ).all();

  const bySeason = new Map();
  for (const r of results) {
    if (!ACHIEVEMENT_BY_ID.has(r.achievement_id)) continue;
    if (!bySeason.has(r.season_id)) bySeason.set(r.season_id, []);
    bySeason.get(r.season_id).push(r);
  }

  const report = [];
  const updates = [];
  for (const [seasonId, seasonRows] of bySeason) {
    const pending = seasonRows.filter(r => r.runner_up_player_id === null);
    for (const r of seasonRows) {
      if (r.runner_up_player_id !== null) report.push({ seasonId, achievementId: r.achievement_id, status: "already-filled" });
    }
    if (!pending.length) continue;

    const achievementCtx = await gatherAchievementContext(env, seasonId);
    const withoutByPlayer = new Map();
    for (const r of pending) {
      const a = ACHIEVEMENT_BY_ID.get(r.achievement_id);
      const recomputed = a.compute(achievementCtx);
      if (!recomputed || recomputed.playerId !== r.player_id) {
        report.push({ seasonId, achievementId: r.achievement_id, status: "winner-mismatch" });
        continue;
      }
      if (!withoutByPlayer.has(r.player_id)) withoutByPlayer.set(r.player_id, ctxWithoutPlayer(achievementCtx, r.player_id));
      const runnerUp = a.compute(withoutByPlayer.get(r.player_id));
      if (!runnerUp) {
        report.push({ seasonId, achievementId: r.achievement_id, status: "no-runner-up" });
        continue;
      }
      report.push({ seasonId, achievementId: r.achievement_id, status: "filled", runnerUpName: runnerUp.name, runnerUpDisplay: runnerUp.display });
      updates.push(env.DB.prepare(`
        UPDATE season_awards SET runner_up_player_id = ?, runner_up_value = ?, runner_up_display = ?
        WHERE season_id = ? AND achievement_id = ? AND runner_up_player_id IS NULL
      `).bind(runnerUp.playerId, runnerUp.value ?? null, runnerUp.display, seasonId, r.achievement_id));
    }
  }

  if (!dryRun && updates.length) await env.DB.batch(updates);
  return jsonResponse({ dryRun, updated: dryRun ? 0 : updates.length, report }, 200);
}

// One-time (or safe-to-rerun) pass for games logged before
// game_event_stats existed -- every game with a known playgroup_game_id
// that has no stats row yet, oldest first, capped per call (see
// MAX_EVENT_STATS_BACKFILL_PER_RUN). `remaining: true` means call this
// again to pick up where it left off. computeAndStoreGameEventStats's own
// ON CONFLICT makes this idempotent, so a partial failure just means the
// next call retries whatever's still missing.
// `force=true` reprocesses every game with a playgroup_game_id regardless
// of whether it already has a game_event_stats row -- needed the first
// time a new column gets added to what computeAndStoreGameEventStats
// captures (self_rating/damage_taken/healing_received/ending_life/
// win_con/starting_player_id/shortest_turn_seconds all arrived after the
// initial backfill), since
// the default NOT EXISTS check would otherwise skip every game that
// already ran once. Safe either way: computeAndStoreGameEventStats's own
// ON CONFLICT DO UPDATE overwrites in place, never duplicates.
async function handleAchievementsBackfill(env, force) {
  const { results: rows } = await env.DB.prepare(`
    SELECT g.id AS game_id, g.playgroup_game_id
    FROM games g
    WHERE g.playgroup_game_id IS NOT NULL
      ${force ? "" : "AND NOT EXISTS (SELECT 1 FROM game_event_stats s WHERE s.game_id = g.id)"}
    ORDER BY g.id
    LIMIT ?
  `).bind(MAX_EVENT_STATS_BACKFILL_PER_RUN).all();

  let processed = 0;
  const errors = [];
  for (const row of rows) {
    try {
      await computeAndStoreGameEventStats(env, row.game_id, row.playgroup_game_id);
      processed++;
    } catch (err) {
      errors.push({ gameId: row.game_id, error: String(err.message || err) });
    }
  }

  return jsonResponse({ processed, remaining: rows.length === MAX_EVENT_STATS_BACKFILL_PER_RUN, errors }, 200);
}

// Run just before a season's trophies are locked in at close: fetch event
// stats for any of its games that don't have them yet. POST /games computes
// those stats in ctx.waitUntil after it has already responded, so closing
// right after the last game could otherwise mint without that game.
// Same query as handleAchievementsBackfill, scoped to one season.
async function backfillMissingEventStats(env, seasonId) {
  const { results: rows } = await env.DB.prepare(`
    SELECT g.id AS game_id, g.playgroup_game_id
    FROM games g
    WHERE g.season_id = ? AND g.playgroup_game_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM game_event_stats s WHERE s.game_id = g.id)
    ORDER BY g.id
    LIMIT ?
  `).bind(seasonId, MAX_EVENT_STATS_BACKFILL_PER_RUN).all();
  for (const row of rows) {
    try {
      await computeAndStoreGameEventStats(env, row.game_id, row.playgroup_game_id);
    } catch (err) {
      console.error(`Event-stats backfill at season close failed for game ${row.game_id}:`, err);
    }
  }
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (await isRateLimited(request, ctx)) {
      return jsonResponse(
        { error: "Too many requests, slow down." },
        429,
        { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) }
      );
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/auth/discord/callback") {
      return handleDiscordCallback(request, env);
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      return handleAuthLogout(request, env);
    }

    if (request.method === "GET" && url.pathname === "/auth/me") {
      return handleAuthMe(request, env);
    }

    // Everything below requires a valid Discord session -- the whole app,
    // reads included, not just writes. Checked once here rather than
    // per-handler: a route added later can't accidentally ship
    // unauthenticated by someone forgetting its own guard, and it means
    // the three /auth/* routes above are the only ones ever reachable
    // signed out (there'd be no way to sign in otherwise) -- with one
    // narrow exception right below for scripts/discord_report.py, which
    // has no Discord account of its own to sign in with.
    //
    // INTERNAL_KEY_PATHS is that exception: GET /players, /games, and
    // /deck-win-rates are the exact three endpoints post-discord-live.yml
    // (GitHub Actions) calls directly to build the Discord report -- a
    // matching X-Internal-Key header unlocks only those, nothing else
    // (never a write, never /roster-diff or /playgroup-games either).
    // INTERNAL_API_KEY is a separate secret from DISCORD_CLIENT_SECRET,
    // not tied to any player, so it can't be revoked by unlinking
    // someone's Discord and doesn't expire like a session does.
    const internalKey = request.headers.get("X-Internal-Key");
    const isValidInternalKey = !!internalKey && !!env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY;
    const INTERNAL_KEY_PATHS = new Set(["/players", "/games", "/deck-win-rates"]);
    const usingInternalKey = isValidInternalKey && request.method === "GET" && INTERNAL_KEY_PATHS.has(url.pathname);

    let session = null;
    if (!usingInternalKey) {
      session = await requireSession(request, env);
      if (!session) {
        return jsonResponse({ error: "Sign in required" }, 401);
      }
    }

    if (request.method === "GET" && url.pathname === "/playgroup-games") {
      return handlePlaygroupGames(env, ctx, request);
    }

    if (request.method === "GET" && url.pathname === "/roster-diff") {
      return handleRosterDiff(env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/players") {
      return handlePlayers(env);
    }

    if (request.method === "GET" && url.pathname === "/games") {
      return handleGames(env);
    }

    if (request.method === "GET" && url.pathname === "/rankings") {
      return handleRankings(env);
    }

    if (request.method === "GET" && url.pathname === "/deck-win-rates") {
      return handleDeckWinRates(env);
    }

    if (request.method === "GET" && url.pathname === "/achievements") {
      return handleAchievements(request, env, session);
    }

    if (request.method === "POST" && url.pathname === "/achievements/backfill") {
      return handleAchievementsBackfill(env, url.searchParams.get("force") === "true");
    }

    if (request.method === "POST" && url.pathname === "/achievements/backfill-runner-ups") {
      return handleRunnerUpBackfill(env, url.searchParams.get("dryRun") === "true");
    }

    if (request.method === "GET" && url.pathname === "/trophy-case") {
      return handleTrophyCase(request, env, session);
    }

    if (request.method === "GET" && url.pathname === "/trophy-leaderboard") {
      return handleTrophyLeaderboard(env);
    }

    if (request.method === "POST" && url.pathname === "/trophy-case/pins") {
      return handleTrophyPinsWrite(request, env, session);
    }

    if (request.method === "POST" && url.pathname === "/seasons/close") {
      return handleSeasonClose(request, env, ctx, session);
    }

    if (request.method === "GET" && url.pathname === "/debug/season-winners") {
      return handleDebugSeasonWinners(request, env);
    }

    if (request.method === "GET" && url.pathname === "/debug/game") {
      return handleDebugGame(request, env);
    }

    if (request.method === "GET" && url.pathname === "/debug/decks") {
      return handleDebugDecks(request, env);
    }

    if (request.method === "GET" && url.pathname === "/debug/games-list") {
      return handleDebugGamesList(request, env);
    }

    if (request.method === "GET" && url.pathname === "/debug/leagues") {
      return handleDebugLeagues(env);
    }

    if (request.method === "GET" && url.pathname === "/debug/league-game-ids") {
      return handleDebugLeagueGameIds(request, env);
    }

    if (request.method === "POST" && url.pathname === "/games") {
      return handleGamesWrite(request, env, ctx, session);
    }

    if (request.method === "POST" && url.pathname === "/roster") {
      return handleRosterWrite(request, env);
    }

    if (request.method === "POST" && url.pathname === "/decks/bracket") {
      return handleDeckBracketWrite(request, env);
    }

    if (request.method === "POST" && url.pathname === "/decks/potential-bracket-4") {
      return handleDeckPotentialBracket4Write(request, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

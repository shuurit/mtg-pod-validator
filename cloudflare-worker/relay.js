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
 * - POST /games, POST /roster, POST /decks/bracket,
 *   POST /decks/potential-bracket-4 all require a valid session (see
 *   requireSession) -- a signed-in pod member can write any of these for
 *   any deck/player, not just their own; there's no per-owner restriction
 *   in v1. GET /auth/discord/callback -> DISCORD_CLIENT_SECRET: completes
 *   the OAuth handshake app.js starts by sending the browser to Discord's
 *   own /oauth2/authorize (see DISCORD_CLIENT_ID) -- exchanges the
 *   returned code for a Discord identity, matches it against
 *   players.discord_user_id (linked manually per player, not self-serve),
 *   and mints a session token in DECK_CACHE. POST /auth/logout invalidates
 *   one; GET /auth/me lets app.js confirm a stored token's still good.
 *
 * Deploy with: wrangler deploy
 * Secrets:     wrangler secret put GITHUB_TOKEN
 *              wrangler secret put PLAYGROUP_API_KEY
 *              wrangler secret put DISCORD_CLIENT_SECRET
 * Bindings:    KV namespace bound as DECK_CACHE
 *              D1 database bound as DB
 */

const GITHUB_OWNER = "shuurit";
const GITHUB_REPO = "mtg-pod-validator";
const ALLOWED_ORIGIN = "https://shuurit.github.io";

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
async function isRateLimited(request, ctx) {
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
    )
  );

  return count + 1 > RATE_LIMIT_MAX_REQUESTS;
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
    (d.potentialBracket4 === undefined || typeof d.potentialBracket4 === "boolean");

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
  return jsonResponse({ playerId: session.playerId, username: session.username }, 200);
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

async function handleGamesWrite(request, env, ctx) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ error: "Sign in required" }, 401);
  }

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

  return jsonResponse({ ok: true, gameId, seasonId, gameNum, results: responseResults }, 201);
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
  if (!(await requireSession(request, env))) {
    return jsonResponse({ error: "Sign in required" }, 401);
  }

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
        env.DB.prepare("INSERT INTO decks (player_id, name, baseline_power, playgroup_deck_id, playgroup_deck_name, new_deck, potential_bracket_4) VALUES (?, ?, ?, ?, ?, 1, ?)")
          .bind(playerId, d.name, d.power, d.playgroupDeckId != null ? String(d.playgroupDeckId) : null, d.playgroupDeckName ?? null, d.potentialBracket4 ? 1 : 0)
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
    await env.DB.prepare("INSERT INTO decks (player_id, name, baseline_power, playgroup_deck_id, playgroup_deck_name, new_deck, potential_bracket_4) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .bind(player.id, d.name, d.power, d.playgroupDeckId != null ? String(d.playgroupDeckId) : null, d.playgroupDeckName ?? null, d.potentialBracket4 ? 1 : 0).run();
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
  if (!(await requireSession(request, env))) {
    return jsonResponse({ error: "Sign in required" }, 401);
  }

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
  if (!(await requireSession(request, env))) {
    return jsonResponse({ error: "Sign in required" }, 401);
  }

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

// ---------- GET /roster-diff : who/what is on playgroup.gg but not yet tracked ----------

// computeRosterDiff already fetches every tracked player's full deck list
// (including archived status) fresh from playgroup.gg on every call -- the
// cheapest possible way to keep decks.archived from drifting stale is to
// piggyback on that instead of a separate sync job. Fire-and-forget via
// ctx.waitUntil (same pattern as handleGamesWrite's post-discord dispatch):
// this is a GET endpoint, so a slow or failed write here should never
// affect the response app.js is waiting on. Only writes rows that actually
// changed, not a blind rewrite of every tracked deck on every request.
async function syncArchivedStatus(env, decksByUsername) {
  const { results: tracked } = await env.DB.prepare(
    "SELECT id, playgroup_deck_id, archived FROM decks WHERE playgroup_deck_id IS NOT NULL"
  ).all();
  const byPgId = new Map(tracked.map(d => [d.playgroup_deck_id, d]));

  const stmts = [];
  for (const decks of Object.values(decksByUsername)) {
    for (const d of decks) {
      const row = byPgId.get(String(d.id));
      if (!row) continue;
      const liveArchived = d.archived ? 1 : 0;
      if (row.archived !== liveArchived) {
        stmts.push(env.DB.prepare("UPDATE decks SET archived = ? WHERE id = ?").bind(liveArchived, row.id));
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
    }));
  }));

  const syncPromise = syncArchivedStatus(env, decksByUsername)
    .catch(err => console.error("decks.archived sync failed:", err));
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
           d.potential_bracket_4, d.bracket AS bracket_override,
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
            ) WHERE c = 1) AS combo_flagged_count
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
    });
  }

  // Every player, unfiltered -- same split of responsibility as today's
  // players (all) vs podPlayers (playgroup-linked only) in app.js. This
  // endpoint hands back the raw truth; filtering stays client-side.
  const players = playerRows.map(p => ({
    id: p.id,
    name: p.name,
    playgroupUsername: p.playgroup_username,
    decks: decksByPlayer[p.id] || [],
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

async function computeRankingsData(env) {
  const { results: playerRows } = await env.DB.prepare("SELECT name FROM players ORDER BY id").all();
  // Scoped to the most-recently-created season only -- same "one season
  // at a time" rule app.js's gameLogRowsFromD1 and discord_report.py's
  // current_season_games already established (Player Adjusted Ranks has
  // never combined seasons). Previously unscoped, which happened to read
  // right only because D1 held just one season's worth of game_results;
  // fixed now so it stays correct once Season 4 exists alongside it.
  const { results: gameRows } = await env.DB.prepare(`
    SELECT p.name AS player, gr.result,
           gr.adjusted_pod_size_score AS j, gr.knockout_score AS k, gr.win_probability AS m
    FROM game_results gr
    JOIN players p ON p.id = gr.player_id
    JOIN games g ON g.id = gr.game_id
    WHERE g.season_id = (SELECT MAX(season_id) FROM games)
  `).all();

  const byPlayer = {};
  for (const row of gameRows) {
    (byPlayer[row.player] ||= []).push(row);
  }

  const rankings = playerRows
    .map(p => ({ player: p.name, ...computePlayerAdjustedWinRate(byPlayer[p.name] || []) }))
    .sort((a, b) => b.rate - a.rate);

  return { generated_at: new Date().toISOString(), rankings };
}

async function handleRankings(env) {
  let data;
  try {
    data = await computeRankingsData(env);
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
async function computeDeckWinRatesData(env) {
  const { results: deckRows } = await env.DB.prepare(`
    SELECT d.id AS deck_id, d.player_id, p.name AS player, d.name AS deck,
           COUNT(gr.result) AS games_played,
           COALESCE(SUM(CASE WHEN gr.result = 1 THEN 1 ELSE 0 END), 0) AS wins
    FROM decks d
    JOIN players p ON p.id = d.player_id
    LEFT JOIN game_results gr ON gr.deck_id = d.id
    GROUP BY d.id
    ORDER BY d.id
  `).all();

  const { results: playerRows } = await env.DB.prepare(`
    SELECT p.id AS player_id, p.name AS player,
           COUNT(gr.result) AS games_played,
           COALESCE(SUM(CASE WHEN gr.result = 1 THEN 1 ELSE 0 END), 0) AS wins
    FROM players p
    LEFT JOIN game_results gr ON gr.player_id = p.id
    GROUP BY p.id
    ORDER BY p.id
  `).all();

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
    data = await computeDeckWinRatesData(env);
  } catch (err) {
    return jsonResponse({ error: "Failed to compute Deck Win Rates from D1", detail: err.message }, 500);
  }
  return jsonResponse(data, 200, { "Cache-Control": "no-store" });
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

    if (request.method === "GET" && url.pathname === "/debug/game") {
      return handleDebugGame(request, env);
    }

    if (request.method === "POST" && url.pathname === "/games") {
      return handleGamesWrite(request, env, ctx);
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

    if (request.method === "GET" && url.pathname === "/auth/discord/callback") {
      return handleDiscordCallback(request, env);
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      return handleAuthLogout(request, env);
    }

    if (request.method === "GET" && url.pathname === "/auth/me") {
      return handleAuthMe(request, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

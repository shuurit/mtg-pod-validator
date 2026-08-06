/**
 * Relay Worker for mtg-pod-validator.
 *
 * Two jobs, two secrets, each used for exactly one thing:
 *
 * - POST /            -> GITHUB_TOKEN: fires a repository_dispatch event at
 *   the repo. Never touches repo contents directly -- the GitHub Actions
 *   workflow does the actual file edit, using GitHub's own auto-issued
 *   token for that run.
 *
 * - GET  /playgroup-games -> PLAYGROUP_API_KEY: reads playgroup.gg on the
 *   app's behalf (games list + active-league membership, determined by
 *   sampling one representative deck per tracked player's ELO history for
 *   a date cutoff, since playgroup.gg's API doesn't expose league on a
 *   game directly and checking every deck that's ever been played blows
 *   through Workers' subrequest limit). Cached for 5 minutes (Workers'
 *   built-in Cache API) so a burst of checks in one sitting doesn't redo
 *   the ~20-25 playgroup.gg calls every time.
 *
 * Deploy with: wrangler deploy
 * Secrets:     wrangler secret put GITHUB_TOKEN
 *              wrangler secret put PLAYGROUP_API_KEY
 */

const GITHUB_OWNER = "shuurit";
const GITHUB_REPO = "mtg-pod-validator";
const ALLOWED_ORIGIN = "https://shuurit.github.io";

const PLAYGROUP_ID = 51996;
const PLAYGROUP_API_BASE = "https://playgroup.gg/api/public/v1";
const CACHE_TTL_SECONDS = 300; // 5 minutes

// Only these usernames map to a tracked spreadsheet player. Participants
// outside this map (guests, other accounts) are dropped from the output,
// same as the static file used to do.
const USERNAME_TO_PLAYER = {
  "Rebecca Dominguez": "Becca",
  "Thoros": "Manny",
  "shuurit": "Mateo",
  "Ecthelion": "Ryan",
  "MLMyBelle": "Michelle",
  "Red": "Red",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

// ---------- POST / : add-game dispatch ----------

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

async function handleAddGame(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!isValidGamePayload(payload)) {
    return jsonResponse({ error: "Payload missing required fields" }, 400);
  }

  const dispatchRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "mtg-pod-validator-relay",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: "add-game", client_payload: payload }),
    }
  );

  if (dispatchRes.status !== 204) {
    const errText = await dispatchRes.text();
    return jsonResponse({ error: "GitHub dispatch failed", detail: errText }, 502);
  }

  return jsonResponse({ ok: true }, 202);
}

// ---------- GET /playgroup-games : live playgroup.gg read ----------

async function getActiveLeagueId(env) {
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
  return active;
}

async function computePlaygroupGames(env) {
  const activeLeague = await getActiveLeagueId(env);

  const gamesRes = await pgFetch(`/playgroups/${PLAYGROUP_ID}/games?limit=100`, env);
  if (!gamesRes.ok) throw new Error(`games list failed: HTTP ${gamesRes.status}`);
  const allGames = await gamesRes.json();

  // Which of these games are in the active league? playgroup.gg has no
  // league field on a game, and checking every unique deck's ELO history
  // (the only way to learn league membership) blew through Workers'
  // subrequest limit once there were 40+ decks in the all-time history.
  //
  // Instead: sample just each tracked player's single most-played deck
  // (one call each, so the count stays fixed regardless of how many decks
  // exist), read the earliest game date that shows up in THAT deck's
  // active-league history, and use the earliest date found across all
  // samples as a cutoff -- any game on or after it counts as active-league.
  // Sampling one deck per player (rather than one deck overall) means a
  // single player having a slow start to the season can't skew the cutoff
  // late and wrongly exclude other players' early games.
  const deckCountsByPlayer = {};
  for (const g of allGames) {
    for (const p of g.participations) {
      const player = p.user_name ? USERNAME_TO_PLAYER[p.user_name] : null;
      if (!player || !p.deck_id) continue;
      (deckCountsByPlayer[player] ||= {})[p.deck_id] = (deckCountsByPlayer[player]?.[p.deck_id] || 0) + 1;
    }
  }
  const sampleDeckIds = Object.values(deckCountsByPlayer).map(counts =>
    Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
  );

  let cutoffDate = null;
  await Promise.all(sampleDeckIds.map(async deckId => {
    const res = await pgFetch(
      `/decks/${deckId}/elo_history?playgroup_id=${PLAYGROUP_ID}&league_id=${activeLeague.id}`,
      env
    );
    if (!res.ok) return;
    const data = await res.json();
    for (const h of data.history || []) {
      if (!cutoffDate || h.played_at < cutoffDate) cutoffDate = h.played_at;
    }
  }));
  if (!cutoffDate) throw new Error("Could not determine the active league's date range from sampled decks");

  const activeGames = allGames.filter(g => g.started_at >= cutoffDate);

  // Commander names aren't in the games/participations payload, only on
  // the deck itself -- fetch details just for decks that actually appear
  // in an active-league game (a much smaller set than "every deck ever").
  // Hard-capped: fixed overhead so far is ~9 calls (me + playgroups + games
  // + up to 6 samples), so this can safely use most of what's left of the
  // 50-subrequest budget. Anything beyond the cap just falls back to
  // showing the deck's nickname instead of its real commander name.
  const MAX_DECK_DETAIL_CALLS = 35;
  const activeDeckIds = new Set();
  for (const g of activeGames) {
    for (const p of g.participations) {
      if (p.deck_id) activeDeckIds.add(p.deck_id);
    }
  }
  const deckIdsToLookUp = [...activeDeckIds].slice(0, MAX_DECK_DETAIL_CALLS);
  const deckCommander = {};
  await Promise.all(deckIdsToLookUp.map(async deckId => {
    const res = await pgFetch(`/decks/${deckId}`, env);
    if (!res.ok) return;
    const deck = await res.json();
    deckCommander[deckId] = deck.commander ? deck.commander.name : deck.name;
  }));

  const games = [];
  for (const g of activeGames.sort((a, b) => a.started_at.localeCompare(b.started_at))) {
    const participants = [];
    let untracked = 0;
    for (const p of g.participations) {
      const player = p.user_name ? USERNAME_TO_PLAYER[p.user_name] : null;
      if (!player) { untracked++; continue; }
      participants.push({
        player,
        commander: deckCommander[p.deck_id] || p.deck_name,
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
    games,
    debug: {
      all_time_games: allGames.length,
      sample_decks_checked: sampleDeckIds.length,
      cutoff_date: cutoffDate,
      active_games: activeGames.length,
      active_unique_decks: activeDeckIds.size,
      deck_detail_calls_made: deckIdsToLookUp.length,
      approx_subrequests: 2 + 1 + sampleDeckIds.length + deckIdsToLookUp.length,
    },
  };
}

async function handlePlaygroupGames(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/playgroup-games`);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let data;
  try {
    data = await computePlaygroupGames(env);
  } catch (err) {
    return jsonResponse({ error: "Failed to read playgroup.gg", detail: err.message }, 502);
  }

  const response = jsonResponse(data, 200, { "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/playgroup-games") {
      return handlePlaygroupGames(env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/") {
      return handleAddGame(request, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

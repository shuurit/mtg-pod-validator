/**
 * Relay Worker for mtg-pod-validator.
 *
 * Three jobs, two secrets, each used for exactly one thing:
 *
 * - POST /            -> GITHUB_TOKEN: fires a repository_dispatch event at
 *   the repo. Never touches repo contents directly -- the GitHub Actions
 *   workflow does the actual file edit, using GitHub's own auto-issued
 *   token for that run. Also used by POST /apply-roster-update below, same
 *   dispatch pattern, different event_type.
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
 *   USERNAME_TO_PLAYER below is the single source of truth for "which
 *   playgroup.gg accounts map to which tracked spreadsheet player." Adding
 *   a new player who joins the playgroup means one new line here -- the
 *   response's known_players field carries that out to app.js, so nothing
 *   else needs a matching code change.
 *
 * - GET  /roster-diff -> PLAYGROUP_API_KEY: returns every playgroup member
 *   (not just tracked ones) and every member's full deck list, independent
 *   of games played -- lets the app detect a new player or new deck the
 *   moment it exists on playgroup.gg, not just after a game gets logged.
 *   This Worker doesn't know what's already in deck-strength.xlsx, so it
 *   doesn't diff anything itself -- same division of labor as
 *   /playgroup-games: raw playgroup.gg data here, comparison against the
 *   synced workbook happens client-side in app.js.
 *
 * Deploy with: wrangler deploy
 * Secrets:     wrangler secret put GITHUB_TOKEN
 *              wrangler secret put PLAYGROUP_API_KEY
 * Bindings:    KV namespace bound as DECK_CACHE
 */

const GITHUB_OWNER = "shuurit";
const GITHUB_REPO = "mtg-pod-validator";
const ALLOWED_ORIGIN = "https://shuurit.github.io";

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

async function kvGetJson(env, key, fallback) {
  const raw = await env.DECK_CACHE.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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

// ---------- POST /apply-roster-update : new player / new deck dispatch ----------

function isValidRosterUpdatePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const newPlayers = payload.newPlayers || [];
  const newDecks = payload.newDecksForExisting || [];
  if (!Array.isArray(newPlayers) || !Array.isArray(newDecks)) return false;
  if (newPlayers.length === 0 && newDecks.length === 0) return false;

  const validDeck = d =>
    d && typeof d === "object" && typeof d.name === "string" && d.name && typeof d.power === "number";

  const validNewPlayer = p =>
    p && typeof p === "object" &&
    typeof p.username === "string" && p.username &&
    typeof p.displayName === "string" && p.displayName &&
    Array.isArray(p.decks) && p.decks.length > 0 && p.decks.every(validDeck);

  const validExistingDeck = d =>
    d && typeof d === "object" && typeof d.player === "string" && d.player && validDeck(d);

  return newPlayers.every(validNewPlayer) && newDecks.every(validExistingDeck);
}

async function hashPayload(payload) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleApplyRosterUpdate(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!isValidRosterUpdatePayload(payload)) {
    return jsonResponse({ error: "Payload missing required fields" }, 400);
  }

  // The GitHub Action this dispatches takes 1-3 minutes, long enough for a
  // second click or a page reload to beat a client-side disabled-button
  // guard -- reject an exact repeat of the same payload within a short
  // window using the KV binding this Worker already has for other reasons.
  if (env.DECK_CACHE) {
    const dedupeKey = `roster_update_submit:${await hashPayload(payload)}`;
    const alreadySubmitted = await env.DECK_CACHE.get(dedupeKey);
    if (alreadySubmitted) {
      return jsonResponse({ error: "This exact update was already submitted moments ago." }, 409);
    }
    await env.DECK_CACHE.put(dedupeKey, "1", { expirationTtl: 120 });
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
      body: JSON.stringify({ event_type: "roster-update", client_payload: payload }),
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

async function computePlaygroupGames(env, forceRecheckGameId) {
  if (!env.DECK_CACHE) {
    throw new Error("DECK_CACHE KV namespace is not bound to this Worker (Settings -> Bindings)");
  }

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
  const now = Date.now();
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
      const player = p.user_name ? USERNAME_TO_PLAYER[p.user_name] : null;
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
    // USERNAME_TO_PLAYER above is the one place a new playgroup.gg member
    // gets added -- everything downstream (app.js's Pod Validator player
    // list, this games list, commander lookups) picks it up from here
    // rather than keeping a second hardcoded copy of "who's tracked."
    known_players: [...new Set(Object.values(USERNAME_TO_PLAYER))],
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

// ---------- GET /roster-diff : who/what is on playgroup.gg but not yet tracked ----------

// Returns the raw "world according to playgroup.gg" -- every member (not
// just tracked ones, so the app can preview what a brand-new player would
// bring in) and every member's full deck list, independent of games played.
// This Worker doesn't know what's already in deck-strength.xlsx (only the
// app does, via the synced workbook), so it doesn't attempt to diff -- same
// division of responsibility as /playgroup-games: Worker supplies the raw
// playgroup.gg data, app.js compares it against what it already parsed.
async function computeRosterDiff(env) {
  const membersRes = await pgFetch(`/playgroups/${PLAYGROUP_ID}/members`, env);
  if (!membersRes.ok) throw new Error(`playgroup members failed: HTTP ${membersRes.status}`);
  const rawMembers = await membersRes.json();

  const members = rawMembers.map(m => ({
    user_id: m.user_id,
    username: m.username,
    tracked: m.username in USERNAME_TO_PLAYER,
    mapped_player: USERNAME_TO_PLAYER[m.username] || null,
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

  return {
    generated_at: new Date().toISOString(),
    known_players: [...new Set(Object.values(USERNAME_TO_PLAYER))],
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
    data = await computeRosterDiff(env);
  } catch (err) {
    return jsonResponse({ error: "Failed to read playgroup.gg roster", detail: err.message }, 502);
  }

  return jsonResponse(data, 200, { "Cache-Control": "no-store" });
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/playgroup-games") {
      return handlePlaygroupGames(env, ctx, request);
    }

    if (request.method === "GET" && url.pathname === "/roster-diff") {
      return handleRosterDiff(env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/") {
      return handleAddGame(request, env);
    }

    if (request.method === "POST" && url.pathname === "/apply-roster-update") {
      return handleApplyRosterUpdate(request, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

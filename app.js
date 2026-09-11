const RANGE_TOLERANCE = 1; // max power spread allowed within a pod
const PLAYGROUP_URL = "https://playgroup.gg/tracker";

// Cloudflare Worker relay. Set once the Worker is deployed (see
// cloudflare-worker/README.md). GAME_SUBMIT_RELAY_URL/ROSTER_UPDATE_RELAY_URL
// empty disables submission; PLAYGROUP_GAMES_RELAY_URL empty disables live
// playgroup.gg data (Games to Update and Player Win Rates show a "not
// configured" message instead).
//
// PLAYERS_RELAY_URL/GAMES_RELAY_URL read from the D1 database this app now
// runs on (see cloudflare-worker/schema.sql) -- deck-strength.xlsx is no
// longer read directly by the app at all. GAME_SUBMIT_RELAY_URL/
// ROSTER_UPDATE_RELAY_URL write there too now, replacing the old GitHub
// Actions dispatch path (POST // POST /apply-roster-update still exist on
// the Worker for now but nothing here calls them anymore).
const RELAY_BASE_URL = "https://mtg-pod-validator-relay.mattdomi18.workers.dev";
const PLAYERS_RELAY_URL = RELAY_BASE_URL + "/players";
const GAMES_RELAY_URL = RELAY_BASE_URL + "/games";
const GAME_SUBMIT_RELAY_URL = RELAY_BASE_URL + "/games";
const PLAYGROUP_GAMES_RELAY_URL = RELAY_BASE_URL + "/playgroup-games";
const ROSTER_DIFF_RELAY_URL = RELAY_BASE_URL + "/roster-diff";
const ROSTER_UPDATE_RELAY_URL = RELAY_BASE_URL + "/roster";
const DECK_BRACKET_RELAY_URL = RELAY_BASE_URL + "/decks/bracket";
const DECK_POTENTIAL_BRACKET4_RELAY_URL = RELAY_BASE_URL + "/decks/potential-bracket-4";
const AUTH_ME_RELAY_URL = RELAY_BASE_URL + "/auth/me";
const AUTH_LOGOUT_RELAY_URL = RELAY_BASE_URL + "/auth/logout";
const ACHIEVEMENTS_RELAY_URL = RELAY_BASE_URL + "/achievements";
const ACHIEVEMENT_VOTE_RELAY_URL = RELAY_BASE_URL + "/achievements/vote";
const ACHIEVEMENT_COMMENT_RELAY_URL = RELAY_BASE_URL + "/achievements/comment";

// Discord OAuth sign-in. Client ID is public (it's part of the login URL
// below), matches the constant of the same name in relay.js -- the Client
// Secret never appears anywhere client-side, only on the relay. Sending
// the browser here needs no relay involvement at all; Discord redirects
// back to the relay's own /auth/discord/callback (not this app directly),
// which is what actually mints the session -- see relay.js.
const DISCORD_CLIENT_ID = "1539751888294256721";
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize"
  + `?client_id=${DISCORD_CLIENT_ID}`
  + `&redirect_uri=${encodeURIComponent(RELAY_BASE_URL + "/auth/discord/callback")}`
  + "&response_type=code&scope=identify";

// Every write request's headers -- adds Authorization only when actually
// signed in, so a signed-out submit still reaches the relay and gets back
// its real {error: "Sign in required"} (surfaced via each form's existing
// body.error handling) rather than app.js guessing at that message itself.
function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  return headers;
}

// Fallback for knownPlaygroupPlayers below, used only until the Worker's
// first response arrives. relay.js's USERNAME_TO_PLAYER is the real source
// of truth -- keep this roughly in sync, but a brand-new player will still
// show up correctly once the live known_players field loads even if this
// list is stale.
const PLAYERS_WITH_PLAYGROUP_ACCOUNT = ["Becca", "Manny", "Mateo", "Ryan", "Michelle", "Red"];

// Fallback roster shown only if the D1-backed /players read fails entirely
// (e.g. offline, or the Worker's down). Real data always comes from D1.
const DEFAULT_ROSTER = [
  { name: "Becca", decks: [
    ["Ms. Bumbleflower", 2.4],
    ["Aminatou, Veil Piercer", 3.7],
    ["Killian, Decisive Mentor", 2.3],
    ["Eshki, Temur's Roar (Manny's)", 2.5],
  ]},
  { name: "Manny", decks: [
    ["Galadriel, Light of Valinor", 3.8],
    ["Atraxa, Praetor's Voice", 3.9],
    ["Athreos, God of Passage", 3.4],
    ["Fynn, the Fangbearer", 2.6],
    ["Frodo, Adventurous Hobbit/Sam, Loyal Attendant", 3.5],
    ["Zada, Hedron Grinder", 2.7],
    ["Ureni of the Unwritten", 2.6],
    ["Aragorn, the Uniter", 3.9],
    ["Kruphix, God of Horizons", 2.3],
    ["Avatar Aang", 3.5],
  ]},
  { name: "Mateo", decks: [
    ["High Perfect Morcant", 2.4],
    ["Leonardo, the Balance/Michelangelo, the Heart", 2.6],
    ["Zurgo Stormrender", 3.6],
    ["Fire Lord Azula", 3.6],
    ["Quintorius, History Chaser", 2.9],
    ["Auntie Ool, Cursewretch", 3.9],
    ["Killian, Decisive Mentor (Becca's)", 2.8],
    ["Noctis, Heir Apparent", 2.6],
    ["Yuna, Grand Summoner", 3.6],
    ["Ureni of the Unwritten", 3.9],
    ["Captain America, Team Leader", 3.7],
    ["Teval, the Balanced Scale", 4.0],
    ["Kratos, God of War", 2.9],
    ["Chatterfang, Squirrel General", 3.9],
  ]},
  { name: "Ryan", decks: [
    ["Eowyn, Shieldmaiden", 3.5],
    ["Ashling, The Limitless", 3.4],
    ["Cloud, Ex-SOLDIER", 3.7],
    ["Kratos, Stoic Father/Atreus, Impulsive Son", 2.6],
    ["Fire Lord Zuko", 3.8],
    ["Witherbloom, The Balancer", 2.6],
    ["Preston Garvey, Minuteman", 3.6],
    ["Giada, Font of Hope", 2.6],
    ["Rootha, Mastering the Moment", 3.6],
    ["Arna Kennerud, Skycaptain", 2.9],
    ["Namor the Sub-Mariner", 3.9],
  ]},
  { name: "Kristy", decks: [
    ["Edgar Markov", 3.6],
    ["Auntie Ool, Cursewretch", 3.3],
    ["Dina, Essence Brewer", 3.2],
    ["Niv-Mizzet, Parun", 3.9],
    ["Doctor Doom, King of Latveria", 2.4],
  ]},
  { name: "Joseph", decks: [
    ["Valgavoth, Harrower of Souls", 3.6],
    ["Zimone, Infinite Analyst", 3.8],
    ["Super Shredder", 2.7],
    ["Hei Bai, Forest Guardian", 3.3],
    ["Ultima, Origin of Oblivion", 3.7],
  ]},
  { name: "Red", decks: [
    ["Cloud, Ex-SOLDIER", 2.7],
    ["Squall, SeeD Mercenary", 3.4],
    ["Sanar, Innovative First-Year", 1.0],
  ]},
  { name: "Michelle", decks: [
    ["The Wise Mothman", 2.5],
    ["Szarel, Genesis Shepard", 2.2],
    ["Lucy MacLean, Positively Armed", 2.4],
  ]},
];

// Which tracked players show up in Deck Strength Validator and Player Win Rates
// (players with no playgroup.gg account, like Kristy/Joseph, are filtered
// out of both). Seeded from the hardcoded list as a fallback for the moment
// before the Worker's first response arrives; updated live from
// known_players once it does, so relay.js's USERNAME_TO_PLAYER is the only
// place a new member needs adding.
let knownPlaygroupPlayers = new Set(PLAYERS_WITH_PLAYGROUP_ACCOUNT);

// Discord sign-in. sessionToken persists across reloads (localStorage);
// currentUser doesn't -- it's re-derived from the token via GET /auth/me
// on every load (see checkAuthSession) so a revoked/expired token is
// caught immediately rather than trusting a stale cached identity.
let sessionToken = localStorage.getItem("sessionToken");
let currentUser = null; // { playerId, username } once confirmed, else null

let players = []; // everyone in Current Deck Strength, unfiltered
let podPlayers = []; // players filtered to knownPlaygroupPlayers -- used by Deck Strength Validator and Player Win Rates
let podCount = 4;
let podSelections = []; // { playerId, deckId, outOfRange } per slot
// The ceiling (floor + RANGE_TOLERANCE) from the last completed power-spread
// check, used to filter an out-of-range slot's deck options down to ones
// that would actually fix it -- see runValidation and refreshDeckOptions in
// renderPodSlots. Deliberately not reset when renderPodSlots re-renders --
// that also happens on every background data refresh, not just when the
// player count changes, and a slot's outOfRange flag (carried over the same
// way playerId/deckId already are) would be meaningless without it.
let lastCeiling = null;
// Which seat's player/deck picker is open in the round-table view of Set
// Up Pod (see buildDealRow) -- only one at a time, same single-open
// pattern as expandedPlayerId/bracketEditingDeckIds below. null means every
// seat is just showing its own (masked) state, nothing being edited. Reset
// whenever podCount changes out from under it (a stale index past the new
// seat count) or the pod itself resets.
let editingSeatIndex = null;
// Only one player's deck table shown at a time -- expanding one auto-
// collapses whichever other player was open, so the card's height stays
// bounded regardless of how many players get tracked over time. null means
// everyone's collapsed.
let expandedPlayerId = null;
let rosterDiffData = null; // raw playgroup.gg roster/decks from loadRosterDiff, used for the Playgroup Power comparison column too
let bracketEditingDeckIds = new Set(); // deck ids currently showing the inline "set new bracket" form instead of their power chip

// player.id -> { column, direction }. Deliberately per-player rather than
// one shared sort like winRatesSortColumn -- sorting Becca's 5 decks by
// Power shouldn't also reorder Mateo's 17 out from under him. No entry
// means unsorted (each player's decks in Current Deck Strength's own row
// order), the state before that player's ever had a header clicked.
const playerDeckSortState = new Map();
const PLAYER_DECK_COLUMNS = [
  { key: "deck", label: "Deck", defaultDir: "asc", numeric: false },
  { key: "power", label: "Power", defaultDir: "desc", numeric: true },
  { key: "pgPower", label: "Playgroup Power", defaultDir: "desc", numeric: true },
];

// ---------- deriving players/decks from source data ----------
// Current Deck Strength (deck-strength.xlsx) is the only source for this --
// nothing in the UI edits it. IDs are derived from the name text itself
// (not random) so a re-sync doesn't invalidate pod selections already made
// in this session.

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

function rosterToRows(roster) {
  return roster.flatMap(p => p.decks.map(([deck, power]) => ({ name: p.name, deck, power })));
}

function rowsToPlayers(rows) {
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.name)) byName.set(row.name, { id: slugify(row.name), name: row.name, decks: [] });
    const player = byName.get(row.name);
    player.decks.push({
      id: `${player.id}::${slugify(row.deck)}`,
      name: row.deck,
      power: row.power,
      playgroupId: row.playgroupId || null,
    });
  }
  return [...byName.values()];
}

// ---------- Tonight (home) ----------

// What Tonight's "needs you" list reads, fed from the same three places
// that used to feed tab badges -- so the home screen and the nav can
// never disagree about how much is outstanding. Standings come from
// renderWinRatesTable (see latestStandings there) rather than a second
// calculation of the same formula.
const tonightCounts = { comboWatch: 0, gamesToLog: 0, newDecks: 0 };
let latestStandings = null;

function tonightSvg(path) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// One actionable row on Tonight. `count` renders as the leading figure
// when there's something outstanding; a settled item shows a check
// instead and doesn't invite a tap.
function buildTonightItem({ count, label, tab, tone, done }) {
  const row = document.createElement(done ? "div" : "button");
  row.className = `tonight-item${done ? " tonight-item-done" : ""}`;
  if (!done) {
    row.type = "button";
    row.addEventListener("click", () => activateTab(tab));
  }

  const lead = document.createElement("span");
  lead.className = `tonight-item-lead tonight-item-lead-${tone || "accent"}`;
  if (done) {
    lead.innerHTML = tonightSvg('<path d="M20 6 9 17l-5-5"></path>');
  } else {
    lead.textContent = count;
  }
  row.appendChild(lead);

  const text = document.createElement("span");
  text.className = "tonight-item-label";
  text.textContent = label;
  row.appendChild(text);

  if (!done) {
    const chev = document.createElement("span");
    chev.className = "tonight-item-chevron";
    chev.innerHTML = tonightSvg('<path d="m9 18 6-6-6-6"></path>');
    row.appendChild(chev);
  }
  return row;
}

// The home screen: the one thing you're most likely here to do, your own
// standing, and whatever is outstanding. Everything on it is already
// loaded for other tabs -- this renders from that shared state rather
// than fetching anything of its own, so it costs no extra requests.
function renderTonight() {
  const host = document.getElementById("tonight-body");
  if (!host) return;
  host.innerHTML = "";

  // --- primary action ---
  const action = document.createElement("button");
  action.type = "button";
  action.className = "tonight-action";
  action.innerHTML = `
    <span class="tonight-action-icon">${tonightSvg('<path d="M12 2.6 21 12l-9 9.4L3 12z"></path><circle cx="12" cy="12" r="3.1"></circle>')}</span>
    <span class="tonight-action-text">
      <span class="tonight-action-title">Build a pod</span>
      <span class="tonight-action-sub">Check the power spread before you shuffle</span>
    </span>
    <span class="tonight-item-chevron">${tonightSvg('<path d="m9 18 6-6-6-6"></path>')}</span>`;
  action.addEventListener("click", () => activateTab("pod"));
  host.appendChild(action);

  // --- your season ---
  const myName = currentUser && players.length
    ? (players.find(p => p.id === currentUser.playerId) || {}).name
    : null;
  const myRow = myName && latestStandings
    ? latestStandings.rows.find(r => r.name === myName)
    : null;

  if (myRow && myRow.adjPct !== null) {
    const label = document.createElement("div");
    label.className = "tonight-label";
    label.textContent = "Your season";
    host.appendChild(label);

    const stats = document.createElement("div");
    stats.className = "tonight-stats";
    const rank = latestStandings.adjustedRankByName[myName];
    stats.innerHTML = `
      <div class="tonight-stat">
        <div class="tonight-stat-value tonight-stat-rank">${rank ? "#" + rank : "—"}</div>
        <div class="tonight-stat-label">Standing</div>
      </div>
      <div class="tonight-stat">
        <div class="tonight-stat-value">${myRow.adjPct.toFixed(1)}<span class="tonight-stat-unit">%</span></div>
        <div class="tonight-stat-label">Adjusted &middot; ${myRow.adjWins}&ndash;${myRow.adjLosses}</div>
      </div>`;
    host.appendChild(stats);
  }

  // --- needs you ---
  const label = document.createElement("div");
  label.className = "tonight-label";
  label.textContent = "Needs you";
  host.appendChild(label);

  const list = document.createElement("div");
  list.className = "tonight-list";

  list.appendChild(buildTonightItem({
    count: tonightCounts.gamesToLog,
    label: tonightCounts.gamesToLog === 1 ? "game to log" : "games to log",
    tab: "games-to-update",
    tone: "warn",
    done: tonightCounts.gamesToLog === 0,
  }));
  if (tonightCounts.gamesToLog === 0) {
    list.lastChild.querySelector(".tonight-item-label").textContent = "Every game is logged";
  }

  list.appendChild(buildTonightItem({
    count: tonightCounts.newDecks,
    label: tonightCounts.newDecks === 1 ? "new deck needs a bracket" : "new decks need a bracket",
    tab: "update-app",
    tone: "warn",
    done: tonightCounts.newDecks === 0,
  }));
  if (tonightCounts.newDecks === 0) {
    list.lastChild.querySelector(".tonight-item-label").textContent = "No new players or decks";
  }

  if (tonightCounts.comboWatch > 0) {
    list.appendChild(buildTonightItem({
      count: tonightCounts.comboWatch,
      label: tonightCounts.comboWatch === 1 ? "deck on combo watch" : "decks on combo watch",
      tab: "pod",
      tone: "bad",
    }));
  }

  host.appendChild(list);
}

// Updates both a tab badge's top-nav copy (#<baseId>) and its
// #bottom-tabs mirror (#<baseId>-bottom, see index.html) so the two bars
// never show different counts -- whichever one a given device isn't
// showing (see the (pointer: coarse) split in style.css) still has the
// right number ready if the viewport/pointer type ever changes mid-session.
function setTabBadge(baseId, count) {
  for (const id of [baseId, `${baseId}-bottom`]) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    if (count > 0) {
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }
}

// Shared tail of applying a freshly-built players array, regardless of
// where it came from (DEFAULT_ROSTER fallback, or a real D1 read).
// Same pattern as updateGamesToUpdateTabBadge/updateRosterUpdateTabBadge --
// hidden entirely at 0 so absence means "nothing flagged," not "not loaded
// yet." Scoped to podPlayers (playgroup-linked, tracked players), matching
// what Players & Decks itself shows.
function updateDeckStrengthValidatorTabBadge(count) {
  tonightCounts.comboWatch = count;
  setTabBadge("dsv-tab-badge", count);
  renderTonight();
}

function setPlayers(newPlayers) {
  players = newPlayers;
  podPlayers = players.filter(p => knownPlaygroupPlayers.has(p.name));
  const comboFlaggedCount = podPlayers.reduce(
    (n, p) => n + p.decks.filter(d => !d.archived && d.comboFlagged).length, 0
  );
  updateDeckStrengthValidatorTabBadge(comboFlaggedCount);
  renderPlayersTable();
  renderPodSlots();
}

// Called once with the DEFAULT_ROSTER fallback (so the UI isn't empty
// before the first fetch resolves) -- the real data source is
// applyPlayersFromD1 below, called every time syncFromD1 succeeds.
function applyDeckStrengthRows(rows) {
  setPlayers(rowsToPlayers(rows));
}

// GET /players already returns players grouped with their decks nested
// (unlike the old flat XLSX rows), so this bypasses rowsToPlayers entirely
// -- just reshapes field names to match what the rest of the app already
// expects. D1's real integer ids are used directly rather than slugified
// strings; every consumer of player.id/deck.id already treats them as
// opaque values (Map keys, dataset attributes, <option> values that
// stringify automatically), so the format never mattered, only stability
// across a re-sync -- which real database primary keys guarantee better
// than a name-derived slug ever did.
function applyPlayersFromD1(data) {
  setPlayers(data.players.map(p => ({
    id: p.id,
    name: p.name,
    decks: p.decks.map(d => ({
      id: d.id, name: d.name, power: d.power, playgroupId: d.playgroupId, archived: !!d.archived,
      bracket: d.bracket ?? null, bracketPending: !!d.bracketPending, newDeck: !!d.newDeck,
      potentialBracket4: !!d.potentialBracket4, comboFlagged: !!d.comboFlagged,
      comboFlaggedCount: d.comboFlaggedCount ?? 0, comboWindowSize: d.comboWindowSize ?? 0,
      // null/undefined ("never captured") vs. "" (confirmed colorless) vs. a
      // real string of letters -- see schema.sql's color_identity comment
      // and buildIdentityCoin, which renders each case differently.
      colorIdentity: d.colorIdentity ?? null,
      gamesLogged: d.gamesLogged ?? 0,
    })),
  })));
}

// Picks up known_players from a /playgroup-games response, if it changed
// the set of who's shown in Deck Strength Validator (e.g. a new player was added to
// relay.js's USERNAME_TO_PLAYER since this page loaded).
function applyKnownPlayers(data) {
  if (!Array.isArray(data.known_players) || data.known_players.length === 0) return;
  const incoming = new Set(data.known_players);
  const unchanged = incoming.size === knownPlaygroupPlayers.size &&
    [...incoming].every(n => knownPlaygroupPlayers.has(n));
  if (unchanged) return;
  knownPlaygroupPlayers = incoming;
  podPlayers = players.filter(p => knownPlaygroupPlayers.has(p.name));
  renderPlayersTable();
  renderPodSlots();
}

applyDeckStrengthRows(rosterToRows(DEFAULT_ROSTER));

// ---------- D1 sync ----------
// deck-strength.xlsx is no longer read by the app at all -- both of these
// come from the Worker's D1-backed read endpoints instead (see
// cloudflare-worker/schema.sql and relay.js's GET /players, GET /games).

// Rows for whichever season is currently active, read fresh on every sync.
// Named gameLogSeason3Rows for historical reasons (kept as-is rather than
// renamed across every call site in this file) -- it's no longer literally
// scoped to "Season 3", just whichever season is current. Used by the
// Games to Update tab to figure out which playgroup.gg games are missing,
// and to compute Player Adjusted Win Rate.
let gameLogSeason3Rows = [];

// GET /games returns every season's games, not just the current one (a
// season never gets deleted, so history stays queryable). Player Adjusted
// Win Rate/rankings have always been scoped to one season at a time --
// Player Adjusted Ranks' own formulas were hardcoded to a single Game Log
// tab, never combined across seasons -- so this filters down to just the
// most-recently-created season (the highest seasonId; seasons are always
// created in chronological order, whether from the original migration or
// auto-created on a new league's first game) before handing rows off to
// the rest of the app, matching that same one-season-at-a-time scope.
function gameLogRowsFromD1(data) {
  if (data.games.length === 0) return [];
  const currentSeasonId = Math.max(...data.games.map(g => g.seasonId));
  return data.games
    .filter(g => g.seasonId === currentSeasonId)
    .map(g => ({
      gameNum: g.gameNum,
      date: new Date(g.date),
      player: g.player,
      commander: g.commander,
      playgroupGameId: g.playgroupGameId,
      commanderStrength: g.commanderStrength,
      result: g.result,
      podSize: g.podSize,
      bracket: g.bracket,
      J: g.adjustedPodSizeScore,
      K: g.knockoutScore,
      M: g.winProbability,
    }));
}

async function syncFromD1() {
  const statusEl = document.getElementById("sync-status");
  try {
    const [playersRes, gamesRes] = await Promise.all([
      fetch(PLAYERS_RELAY_URL, { cache: "no-store", headers: authHeaders() }),
      fetch(GAMES_RELAY_URL, { cache: "no-store", headers: authHeaders() }),
    ]);
    if (!playersRes.ok) throw new Error(`/players failed: HTTP ${playersRes.status}`);
    if (!gamesRes.ok) throw new Error(`/games failed: HTTP ${gamesRes.status}`);
    const playersData = await playersRes.json();
    const gamesData = await gamesRes.json();
    if (playersData.players.length === 0) throw new Error("no players returned");

    applyPlayersFromD1(playersData);
    if (statusEl) {
      const deckCount = players.reduce((n, p) => n + p.decks.length, 0);
      statusEl.textContent = `Synced (${players.length} players, ${deckCount} decks; ${podPlayers.length} shown in Deck Strength Validator).`;
    }

    gameLogSeason3Rows = gameLogRowsFromD1(gamesData);
    renderGamesToUpdate();
    renderWinRatesTable(playgroupGamesData);
    // computeRosterDiff (inside renderUpdateAppTab) reads the `players`
    // array just rebuilt above by applyPlayersFromD1. refreshEverything()
    // runs this and loadRosterDiff() in parallel, and this fetch can
    // resolve after /roster-diff does, so loadRosterDiff() often renders
    // Update the App against the *previous* players array -- e.g. a
    // just-submitted new player not showing up in `players` yet, so they
    // still look untracked even though the submission fully landed.
    // Nothing else re-renders that tab once `players` catches up, so it
    // has to happen here too, not just in loadRosterDiff().
    if (!isEditingRosterUpdateForm()) renderUpdateAppTab();
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Using locally saved data — couldn't load live data (${err.message}).`;
    }
    const gtuStatus = document.getElementById("gtu-status");
    if (gtuStatus) gtuStatus.textContent = `Couldn't load live data — Games to Update needs it to know what's already logged.`;
  }
}

// ---------- Achievements ----------
// Season standings computed server-side (GET /achievements, relay.js) from
// playgroup.gg's own event log -- nothing here is computed client-side,
// unlike Player Win Rates' live formula preview, since there's no
// pre-submit case that needs one. selectedAchievementsSeasonId tracks
// the season <select>'s own current choice, not necessarily the server's
// default -- kept separate so switching seasons re-fetches that season
// specifically rather than always re-asking for "the latest."
let selectedAchievementsSeasonId = null;

async function loadAchievements() {
  const statusEl = document.getElementById("achievements-status");
  const listEl = document.getElementById("achievements-list");
  try {
    const url = selectedAchievementsSeasonId
      ? `${ACHIEVEMENTS_RELAY_URL}?season=${selectedAchievementsSeasonId}`
      : ACHIEVEMENTS_RELAY_URL;
    const res = await fetch(url, { cache: "no-store", headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    selectedAchievementsSeasonId = data.seasonId;
    renderAchievementsSeasonSelect(data.seasons, data.seasonId);
    renderAchievements(data.achievements, data.seasonActive, data.votingOpen);
    // Stated once, here, rather than repeated inside all 36 cards -- while
    // a season is live every winner is withheld for this one reason, so
    // it's a property of the season, not of each achievement.
    const revealNotice = document.getElementById("achievements-reveal-notice");
    if (revealNotice) revealNotice.hidden = !data.seasonActive;
    const closedNotice = document.getElementById("achievements-voting-closed-notice");
    if (closedNotice) closedNotice.hidden = data.votingOpen !== false;
    if (statusEl) statusEl.hidden = true;
  } catch (err) {
    if (listEl) listEl.innerHTML = "";
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = `Couldn't load achievements (${err.message}).`;
    }
  }
}

function renderAchievementsSeasonSelect(seasons, seasonId) {
  const sel = document.getElementById("achievements-season-select");
  if (!sel) return;
  sel.innerHTML = "";
  for (const season of seasons) {
    const opt = document.createElement("option");
    opt.value = season.id;
    opt.textContent = season.label;
    sel.appendChild(opt);
  }
  sel.value = seasonId;
}

// One trophy card per achievement -- see the ACHIEVEMENTS list in relay.js
// for the full 22 and what each one measures. `winner` is null when the
// season doesn't have enough data for that specific achievement yet (a
// brand-new season, an old one pre-dating the backfill, or just not enough
// qualifying games for a rate-based one like "saltiest player") -- a
// genuine empty state, not an error. `winner.display` is a fully-formatted
// string built server-side (see relay.js) since these span plain counts,
// ratios, percentages, and averages that don't share one format -- this
// function never does its own number formatting.
// seasonActive gates whether a null winner means "hidden until the season
// ends" (relay.js withholds every winner on purpose while a season is
// still being played, same reveal-at-the-end spirit as pod validation
// masking deck identity/power pre-reveal) vs. "genuinely no qualifying
// data yet" for an already-concluded season -- two different states that
// both arrive as winner: null, so the message has to come from
// seasonActive, not from the achievement itself.
function renderAchievements(achievements, seasonActive, votingOpen) {
  const container = document.getElementById("achievements-list");
  container.innerHTML = "";

  if (achievements.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No achievements defined yet.";
    container.appendChild(empty);
    return;
  }

  for (const achievement of achievements) {
    const card = document.createElement("div");
    card.className = "trophy-card";

    // The badge art is plain decoration now -- circle art only, no title
    // or description baked in (see ACHIEVEMENTS in relay.js and the
    // /emblems directory). It used to carry both as text painted into the
    // image, which is exactly what went stale and wrong when "The Wrench"
    // got renamed to "Punching Bag" (the art still read THE WRENCH), and
    // let two real typos ship silently in art nobody proofread as text.
    // Real HTML title/description below the art can't drift from it or
    // hide a typo, so every card renders them the same way regardless of
    // whether it has emblem art -- only the visual above them differs.
    const body = document.createElement("div");
    body.className = "trophy-body";

    if (achievement.emblem) {
      const img = document.createElement("img");
      img.className = "trophy-emblem";
      img.src = achievement.emblem;
      img.alt = "";
      card.appendChild(img);
    } else {
      // Drawn sigil rather than a trophy emoji: this stands in for missing
      // badge art, and an emoji reads as a different picture on every
      // platform right next to real illustrated emblems.
      const icon = document.createElement("span");
      icon.className = "trophy-icon";
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2 20 12l-8 8.8L4 12z"></path><path d="M12 7.6 16.2 12 12 16.4 7.8 12z"></path></svg>';
      card.appendChild(icon);
    }

    const title = document.createElement("div");
    title.className = "trophy-title";
    title.textContent = achievement.title;
    card.appendChild(title);
    const description = document.createElement("div");
    description.className = "trophy-description";
    description.textContent = achievement.description;
    body.appendChild(description);

    if (achievement.winner) {
      const winnerRow = document.createElement("div");
      winnerRow.className = "trophy-winner";
      const name = document.createElement("span");
      name.className = "trophy-winner-name";
      name.textContent = achievement.winner.name;
      const value = document.createElement("span");
      value.className = "trophy-winner-value";
      value.textContent = achievement.winner.display;
      winnerRow.appendChild(name);
      winnerRow.appendChild(value);
      body.appendChild(winnerRow);
    } else if (!seasonActive) {
      // Only a CONCLUDED season says anything here: "no data for this
      // achievement" is per-achievement and worth stating. While a season
      // is still running every card is withheld for the same one reason,
      // so that message is stated once above the grid (see the reveal
      // notice in loadAchievements) rather than 36 times inside it.
      const empty = document.createElement("div");
      empty.className = "trophy-empty";
      empty.textContent = "No data yet.";
      body.appendChild(empty);
    }

    // Keep/cut voting -- deciding which achievements are worth keeping
    // before the season ends, not tied to whether the winner's revealed
    // yet. Server is the source of truth for both tallies and this
    // player's own vote (achievement.votes, from GET /achievements), so a
    // click posts and re-renders from the response rather than guessing
    // the new counts locally. Once votingOpen is false (relay.js's
    // ACHIEVEMENT_VOTING_DEADLINE has passed), the tally is shown as plain
    // read-only text instead of buttons -- there's nothing left to click.
    // Sentiment bar -- the keep/cut split as one proportional line, so the
    // shape of the vote reads across the whole grid at a glance instead of
    // needing two numbers compared per card. Only drawn once someone has
    // actually voted; an all-zero bar would imply a tie nobody cast.
    const voteBar = buildVoteSentimentBar(achievement.votes);
    if (voteBar) body.appendChild(voteBar);

    if (votingOpen === false) {
      const finalTally = document.createElement("div");
      finalTally.className = "trophy-vote-final";
      const keepCount = document.createElement("span");
      keepCount.className = "vote-keep-count";
      keepCount.textContent = `Keep ${achievement.votes.keep}`;
      const cutCount = document.createElement("span");
      cutCount.className = "vote-cut-count";
      cutCount.textContent = `Cut ${achievement.votes.cut}`;
      finalTally.appendChild(keepCount);
      finalTally.appendChild(cutCount);
      body.appendChild(finalTally);
    } else {
      const voteRow = document.createElement("div");
      voteRow.className = "trophy-vote";
      const keepBtn = document.createElement("button");
      keepBtn.type = "button";
      keepBtn.className = "vote-btn vote-keep";
      const cutBtn = document.createElement("button");
      cutBtn.type = "button";
      cutBtn.className = "vote-btn vote-cut";
      applyVoteTally(keepBtn, cutBtn, achievement.votes);
      keepBtn.addEventListener("click", () => castAchievementVote(achievement.id, "keep", keepBtn, cutBtn));
      cutBtn.addEventListener("click", () => castAchievementVote(achievement.id, "cut", keepBtn, cutBtn));
      voteRow.appendChild(keepBtn);
      voteRow.appendChild(cutBtn);
      body.appendChild(voteRow);
    }

    card.appendChild(body);
    container.appendChild(card);
  }
}

// The keep/cut split as a single proportional bar. Returns null when
// nobody has voted on this achievement yet -- see the call site.
function buildVoteSentimentBar(votes) {
  const total = votes.keep + votes.cut;
  if (total === 0) return null;
  const bar = document.createElement("div");
  bar.className = "trophy-vote-bar";
  bar.title = `${votes.keep} keep, ${votes.cut} cut`;
  const keepFill = document.createElement("div");
  keepFill.className = "trophy-vote-bar-keep";
  keepFill.style.width = `${(votes.keep / total) * 100}%`;
  bar.appendChild(keepFill);
  return bar;
}

// Rebuilds both vote buttons in place from a fresh tally, and re-draws the
// sentiment bar beside them so the split and the counts never disagree.
function applyVoteTally(keepBtn, cutBtn, votes) {
  const body = keepBtn.closest(".trophy-body");
  if (body) {
    const existing = body.querySelector(".trophy-vote-bar");
    const replacement = buildVoteSentimentBar(votes);
    if (existing && replacement) existing.replaceWith(replacement);
    else if (existing) existing.remove();
    else if (replacement) body.insertBefore(replacement, keepBtn.parentElement);
  }
  keepBtn.textContent = `Keep ${votes.keep}`;
  cutBtn.textContent = `Cut ${votes.cut}`;
  keepBtn.classList.toggle("active", votes.mine === "keep");
  cutBtn.classList.toggle("active", votes.mine === "cut");
}

// Clicking a vote button toggles it off (vote: null) if it's already this
// player's vote, or casts/switches to it otherwise -- relay.js overwrites
// this player's prior vote rather than adding a second one either way.
async function castAchievementVote(achievementId, choice, keepBtn, cutBtn) {
  const alreadyThis = (choice === "keep" && keepBtn.classList.contains("active"))
    || (choice === "cut" && cutBtn.classList.contains("active"));
  const vote = alreadyThis ? null : choice;
  keepBtn.disabled = true;
  cutBtn.disabled = true;
  try {
    const res = await fetch(ACHIEVEMENT_VOTE_RELAY_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ achievementId, vote }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applyVoteTally(keepBtn, cutBtn, data.votes);
  } catch (err) {
    console.error("Failed to cast achievement vote:", err);
  } finally {
    keepBtn.disabled = false;
    cutBtn.disabled = false;
  }
}

function initAchievementsTab() {
  const sel = document.getElementById("achievements-season-select");
  if (sel) {
    sel.addEventListener("change", () => {
      selectedAchievementsSeasonId = sel.value ? Number(sel.value) : null;
      loadAchievements();
    });
  }

  const commentInput = document.getElementById("achievements-comment-input");
  const commentBtn = document.getElementById("achievements-comment-submit");
  const commentStatus = document.getElementById("achievements-comment-status");
  if (commentBtn && commentInput) {
    commentBtn.addEventListener("click", async () => {
      const comment = commentInput.value.trim();
      if (!comment) return;
      commentBtn.disabled = true;
      try {
        const res = await fetch(ACHIEVEMENT_COMMENT_RELAY_URL, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ comment }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        commentInput.value = "";
        if (commentStatus) {
          commentStatus.hidden = false;
          commentStatus.textContent = "Sent, thanks!";
        }
      } catch (err) {
        if (commentStatus) {
          commentStatus.hidden = false;
          commentStatus.textContent = `Couldn't send that (${err.message}).`;
        }
      } finally {
        commentBtn.disabled = false;
      }
    });
  }
}

// ---------- shared table building ----------

// Pale, correctly-shaped placeholder cards shown the moment sign-in is
// confirmed and the real fetches are still in flight, replacing a status
// line floating over an empty container with something that shows where
// content is actually about to land. Only ever a starting state: every
// real render function already clears its container with innerHTML = ""
// the moment it has something real (or a genuine empty/failed outcome) to
// show, which removes whatever skeleton was sitting there same as it
// would remove old real content on a re-render. Not used for Players &
// Decks -- that tab already renders the DEFAULT_ROSTER fallback
// synchronously before sign-in even resolves, so it's never actually
// empty the way the other three tabs are before their first fetch lands.
function renderSkeletonCards(container, count, lineWidths) {
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const card = document.createElement("div");
    card.className = "skeleton-card";
    for (const width of (lineWidths || ["medium", "short"])) {
      const line = document.createElement("div");
      line.className = "skeleton-line" + (width ? ` skeleton-line-${width}` : "");
      card.appendChild(line);
    }
    container.appendChild(card);
  }
}

// A row of plain clickable labels standing in for what used to be sortable
// <th>s, shared by Players & Decks' per-player deck list and Player Win
// Rates -- neither is a <table> anymore (see buildDeckPlate/the win-rates
// cards), but both still sort exactly the way their table version did.
// Purely a rendering helper: the actual sort state and re-render stay owned
// by the caller, handed back through onSelect(col).
function buildSortBar(columns, activeColumn, activeDirection, onSelect) {
  const bar = document.createElement("div");
  bar.className = "sort-bar";
  const label = document.createElement("span");
  label.className = "sort-bar-label";
  label.textContent = "Sort:";
  bar.appendChild(label);
  for (const col of columns) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sort-btn";
    const isActive = activeColumn === col.key;
    btn.textContent = col.label + (isActive ? (activeDirection === "desc" ? " ▾" : " ▴") : "");
    if (isActive) btn.classList.add("active");
    btn.addEventListener("click", () => onSelect(col));
    bar.appendChild(btn);
  }
  return bar;
}

// Builds a <table class="${className}"> purely via createElement/
// textContent/appendChild -- never innerHTML -- so untrusted text (player
// names, commander names, playgroup.gg usernames, all of which a playgroup
// member ultimately controls) can never break out of markup the way
// interpolating it into a template-literal-built <tr> could. Each cell in
// `rows` is either a plain string/number (rendered as escaped text) or an
// already-built DOM node (for interactive cells: inputs, checkboxes,
// buttons) -- callers needing a per-cell class (e.g. "num") pass
// {node, className} or {text, className} instead of the bare value.
// Returns {table, tbody} since most callers still need to reach into
// individual rows/cells afterward (pre-filling inputs, wiring listeners).
function buildTable(className, headers, rows) {
  const table = document.createElement("table");
  if (className) table.className = className;

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const cells of rows) {
    const tr = document.createElement("tr");
    for (const cell of cells) {
      const td = document.createElement("td");
      const isDescriptor = cell !== null && typeof cell === "object" && !(cell instanceof Node);
      const className = isDescriptor ? cell.className : undefined;
      const value = isDescriptor ? (cell.node !== undefined ? cell.node : cell.text) : cell;
      if (className) td.className = className;
      if (value instanceof Node) td.appendChild(value);
      else td.textContent = value ?? "";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return { table, tbody };
}

// ---------- players/decks display (read-only) ----------

function formatPower(power) {
  return power.toFixed(1);
}

// Same WUBRG order relay.js's toCanonicalColorString already collapsed a
// deck's colors into -- kept here too so a coin's wedges always read
// left-to-right in the same fixed sequence regardless of which deck.
const WUBRG_ORDER = ["W", "U", "B", "R", "G"];
const PIP_COLOR_VAR = { W: "--pip-w", U: "--pip-u", B: "--pip-b", R: "--pip-r", G: "--pip-g" };
const WUBRG_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };

// A deck's color identity as a single fixed-size coin -- see the design
// review this came out of: a row of one dot per color got wider (and
// messier) the more colors a deck had, which is backwards, so every deck
// gets the same 20px footprint whether it's mono-color or five. Returns
// null (no coin at all) for colorIdentity === null/undefined, i.e. never
// captured yet -- distinct from "" (confirmed colorless), which still
// renders, just as a plain neutral coin.
function buildIdentityCoin(colorIdentity) {
  if (colorIdentity === null || colorIdentity === undefined) return null;

  const coin = document.createElement("span");
  coin.className = "id-coin";

  const colors = WUBRG_ORDER.filter(c => colorIdentity.includes(c));
  // Previously aria-hidden with no fallback of any kind -- a deck's color
  // identity is real information (which colors, not just how many), and
  // hue alone doesn't carry it to a screen reader or a colorblind player.
  // The title is the same plain-letter shorthand ("WUBG") a Magic player
  // already reads on their own decklist; the aria-label spells the same
  // thing out in words for anyone a hover tooltip doesn't reach.
  coin.setAttribute("role", "img");
  coin.title = colors.length === 0 ? "Colorless" : colors.join("");
  coin.setAttribute(
    "aria-label",
    colors.length === 0 ? "Colorless" : `Color identity: ${colors.map(c => WUBRG_NAMES[c]).join(", ")}`
  );

  if (colors.length === 0) {
    coin.classList.add("id-coin-colorless");
    return coin;
  }
  if (colors.length === 1) {
    coin.style.background = `var(${PIP_COLOR_VAR[colors[0]]})`;
    return coin;
  }

  // Equal wedges with a thin dark seam baked into each boundary -- reads as
  // an actual pie chart instead of a blended blob once there are 3+ colors.
  const seam = 2; // degrees of dark divider on each side of a boundary
  const step = 360 / colors.length;
  const stops = [];
  colors.forEach((c, i) => {
    const start = i * step;
    const end = (i + 1) * step;
    stops.push(`var(${PIP_COLOR_VAR[c]}) ${start}deg ${end - seam}deg`);
    stops.push(`rgba(0,0,0,.4) ${end - seam}deg ${end}deg`);
  });
  coin.style.background = `conic-gradient(${stops.join(", ")})`;
  return coin;
}

// Illustrative-only thresholds (not a canonical scale defined anywhere else
// in this app) -- just enough to bucket a deck's power into a color so a
// player's whole pool reads visually at a glance instead of needing to
// parse a column of numbers. Reuses the existing good/warn/bad tokens
// already established for banners/result-rows elsewhere. Takes a prefix so
// both the power chip itself and the deck row's tier edge (see
// renderPlayersTable) share one set of thresholds instead of two copies
// silently drifting apart.
function powerTierClass(power, prefix = "power-chip") {
  if (power < 2.5) return `${prefix}-low`;
  if (power < 3.2) return `${prefix}-mid`;
  if (power < 3.7) return `${prefix}-high`;
  return `${prefix}-max`;
}

function buildPowerChip(power) {
  const chip = document.createElement("span");
  chip.className = `power-chip ${powerTierClass(power)}`;
  chip.textContent = formatPower(power);
  return chip;
}

// A single compact row above the per-player list itself (see
// renderPlayersTable) so the whole group's power spread reads at a glance
// without expanding every row -- expandedPlayerId stays deliberately
// single-open below for phone-friendly card heights, which otherwise means
// there's no way to eyeball everyone at once. One pill per player, one
// small dot per active deck inside it (reusing powerTierClass's thresholds,
// same as buildPowerChip) -- clicking a pill expands that player's own
// card and scrolls it into view rather than duplicating any deck detail
// here. Skipped entirely at 1 or fewer players: nothing to compare yet.
function buildPowerOverviewStrip() {
  if (podPlayers.length <= 1) return null;

  const strip = document.createElement("div");
  strip.className = "power-overview-strip";

  for (const player of podPlayers) {
    const activeDecks = player.decks.filter(d => !d.archived);
    if (activeDecks.length === 0) continue;

    const card = document.createElement("button");
    card.type = "button";
    card.className = "power-overview-card";
    card.addEventListener("click", () => {
      expandedPlayerId = player.id;
      renderPlayersTable();
      document.getElementById(`player-block-${player.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    const name = document.createElement("span");
    name.className = "power-overview-name";
    name.textContent = player.name;
    card.appendChild(name);

    // A range, not one dot per deck -- a player with a dozen decks (real
    // examples in this playgroup go into double digits) made the original
    // one-dot-per-deck version overflow its own card instead of staying
    // compact, defeating the whole point of an at-a-glance strip. Colored
    // by the average deck's tier, since a single hue can't honestly
    // represent a player whose decks span multiple tiers -- the average is
    // the least misleading single answer to "how strong is this player,"
    // and the printed range still shows the real spread as text.
    const powers = activeDecks.map(d => d.power);
    const min = Math.min(...powers);
    const max = Math.max(...powers);
    const avg = powers.reduce((a, b) => a + b, 0) / powers.length;
    const range = document.createElement("span");
    range.className = `power-overview-range ${powerTierClass(avg, "power-overview-dot")}`;
    range.textContent = min === max ? formatPower(min) : `${formatPower(min)}–${formatPower(max)}`;
    range.title = `${activeDecks.length} deck${activeDecks.length === 1 ? "" : "s"}`;
    card.appendChild(range);

    strip.appendChild(card);
  }

  return strip;
}

// POSTs decks.potential_bracket_4 (see schema.sql) and refreshes -- the
// curated flag that decides whether Games to Update ever shows this deck's
// early-combo checkbox at all. A rare, deliberate toggle, not a per-game
// input, so no confirm step beyond the click itself.
async function togglePotentialBracket4(deck) {
  if (!DECK_POTENTIAL_BRACKET4_RELAY_URL) return;
  try {
    const res = await fetch(DECK_POTENTIAL_BRACKET4_RELAY_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ deckId: deck.id, potentialBracket4: !deck.potentialBracket4 }),
    });
    // This button has no status element of its own (it's a quick toggle in
    // a table row, not a form) -- a 401 specifically gets a visible nudge
    // via the fixed auth control instead of vanishing into the console
    // like every other failure here does.
    if (res.status === 401) {
      showAuthStatusHint("Sign in with Discord to do this.");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await refreshEverything();
  } catch (err) {
    console.error(`Failed to toggle combo tracking for ${deck.name}:`, err);
  }
}

// Power cell in its normal (non-editing) state. Elements are built first,
// then appended in this exact left-to-right order (a deliberate design
// call, not derived from the "Power" column header's alignment): combo
// badge, flame toggle, chip, pencil.
//
// The chip is flagged with a dashed border + tooltip when it's a manual
// bracket declaration not yet backed by a logged game (see
// computePlayersData's bracketPending). The two de-emphasized buttons are
// the bracket-edit pencil (switches this cell into buildBracketEditRow
// below) and a flame toggle for decks.potential_bracket_4. The badge shows
// when the deck has hit the 3-of-5 combo pattern (see computePlayersData's
// comboFlagged). Playgroup Power stays its own table column (see
// PLAYER_DECK_COLUMNS), not folded in here.
// Small monochrome icons drawn inline rather than set as emoji glyphs.
// Emoji render as a different picture (and in full colour) on every
// platform, which reads as a sticker dropped into otherwise monochrome
// UI -- and these three sit right next to text they're meant to modify.
// Always aria-hidden: every caller already carries its own aria-label or
// title, so the icon is decoration on top of a named control.
const UI_ICON_PATHS = {
  pencil: '<path d="M4 20.2l4.4-1 10.9-10.9a2 2 0 0 0 0-2.8l-.8-.8a2 2 0 0 0-2.8 0L4.9 15.8 4 20.2z"></path><path d="m14.9 6.1 3 3"></path>',
  flame: '<path d="M12 22c3.8 0 6.4-2.5 6.4-5.9 0-4.1-3.5-6.3-4.7-10.2-.4-1.5-1.1-2.5-1.7-3.4-.3 2.2-1.6 3.5-3.1 5.3C7.4 9.7 6 11.5 6 16.1 6 19.5 8.2 22 12 22z"></path><path d="M12 22c1.8 0 3.1-1.2 3.1-3 0-2-1.6-2.9-2.3-5-.7 1.2-1.5 1.9-2.3 2.9-.9 1.1-1.6 1.4-1.6 2.1 0 1.8 1.3 3 3.1 3z"></path>',
  lock: '<rect x="5" y="10.2" width="14" height="10.3" rx="2"></rect><path d="M8.2 10.2V7.4a3.8 3.8 0 0 1 7.6 0v2.8"></path>',
};

function uiIcon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICON_PATHS[name]}</svg>`;
}

function buildPowerCell(deck) {
  const cell = document.createElement("span");
  cell.className = "power-cell";

  const editBtn = document.createElement("button");
  editBtn.className = "deck-edit-btn";
  editBtn.innerHTML = uiIcon("pencil");
  editBtn.setAttribute("aria-label", `Set ${deck.name}'s bracket`);
  editBtn.addEventListener("click", () => {
    bracketEditingDeckIds.add(deck.id);
    renderPlayersTable();
  });

  const comboToggleBtn = document.createElement("button");
  comboToggleBtn.className = "deck-edit-btn" + (deck.potentialBracket4 ? " deck-edit-btn-active" : "");
  comboToggleBtn.innerHTML = uiIcon("flame");
  comboToggleBtn.title = deck.potentialBracket4
    ? "Combo-tracked — click to stop asking about this deck's early combo each game"
    : "Not combo-tracked — click to start asking about this deck's early combo each game";
  comboToggleBtn.setAttribute("aria-label", `Toggle combo tracking for ${deck.name}`);
  // Turning tracking ON asks for confirmation first (see
  // showComboTrackConfirm); turning it back OFF stays instant.
  comboToggleBtn.addEventListener("click", () => {
    if (deck.potentialBracket4) togglePotentialBracket4(deck);
    else showComboTrackConfirm(deck);
  });

  let comboBadge = null;
  if (deck.comboFlagged) {
    comboBadge = document.createElement("span");
    comboBadge.className = "combo-badge";
    comboBadge.innerHTML = `${uiIcon("flame")}<span>${deck.comboFlaggedCount}/${deck.comboWindowSize}</span>`;
    comboBadge.title = `${deck.comboFlaggedCount} of this deck's last ${deck.comboWindowSize} logged games showed the early combo — consider marking Bracket 4.`;
  }

  const chip = buildPowerChip(deck.power);
  if (deck.bracketPending) {
    chip.classList.add("power-chip-pending");
    chip.title = `Manually set to Bracket ${deck.bracket} — not yet confirmed by a logged game.`;
  }

  if (comboBadge) cell.appendChild(comboBadge);
  cell.appendChild(comboToggleBtn);
  cell.appendChild(chip);
  cell.appendChild(editBtn);

  return cell;
}

// Inline "declare a new bracket" form, swapped in for buildPowerCell while
// a deck is in bracketEditingDeckIds -- see POST /decks/bracket in
// relay.js. "No override" (bracket: null) clears a previous declaration
// and falls back to whatever's actually been logged.
function buildBracketEditRow(deck) {
  const wrap = document.createElement("span");
  wrap.className = "bracket-edit";

  const select = document.createElement("select");
  const blankOpt = document.createElement("option");
  blankOpt.value = "";
  blankOpt.textContent = "No override";
  select.appendChild(blankOpt);
  for (let b = 1; b <= 5; b++) {
    const opt = document.createElement("option");
    opt.value = String(b);
    opt.textContent = `Bracket ${b}`;
    select.appendChild(opt);
  }
  select.value = deck.bracket != null ? String(deck.bracket) : "";

  const saveBtn = document.createElement("button");
  saveBtn.className = "icon-btn";
  saveBtn.textContent = "✓";
  saveBtn.setAttribute("aria-label", "Save bracket");

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "icon-btn";
  cancelBtn.textContent = "✕";
  cancelBtn.setAttribute("aria-label", "Cancel");

  const errEl = document.createElement("span");
  errEl.className = "hint bracket-edit-error";

  cancelBtn.addEventListener("click", () => {
    bracketEditingDeckIds.delete(deck.id);
    renderPlayersTable();
  });

  saveBtn.addEventListener("click", async () => {
    const bracket = select.value === "" ? null : parseInt(select.value, 10);
    if (!DECK_BRACKET_RELAY_URL) {
      errEl.textContent = "Not configured.";
      return;
    }
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    select.disabled = true;
    errEl.textContent = "";
    try {
      const res = await fetch(DECK_BRACKET_RELAY_URL, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ deckId: deck.id, bracket }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      bracketEditingDeckIds.delete(deck.id);
      await refreshEverything();
    } catch (err) {
      errEl.textContent = `Failed: ${err.message}`;
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      select.disabled = false;
    }
  });

  wrap.append(select, saveBtn, cancelBtn, errEl);
  return wrap;
}

// A deck's whole row in Players & Decks, as a card instead of a table row --
// the "nameplate" from the design review: a colored top edge keyed to the
// same power tier as the coin (powerTierClass), name + color identity coin
// on the left, Playgroup Power as a muted subtitle underneath it, and the
// exact same interactive right side a table cell used to hold (combo badge,
// flame toggle, power coin, bracket pencil -- see buildPowerCell/
// buildBracketEditRow, untouched, just relocated).
function buildDeckPlate(deck, pgPower) {
  const plate = document.createElement("div");
  plate.className = `deck-plate ${powerTierClass(deck.power, "deck-plate")}`;

  const left = document.createElement("div");
  left.className = "deck-plate-left";

  const nameLine = document.createElement("div");
  nameLine.className = "deck-plate-name";
  const coin = buildIdentityCoin(deck.colorIdentity);
  if (coin) nameLine.appendChild(coin);
  const nameText = document.createElement("span");
  nameText.className = "deck-plate-name-text";
  nameText.textContent = deck.name;
  nameLine.appendChild(nameText);
  left.appendChild(nameLine);

  // "New deck" and "Logged N games" are mutually exclusive by construction
  // -- decks.new_deck is cleared the moment a game actually gets logged for
  // it (see handleGamesWrite), so a deck is never both at once. Playgroup
  // Power sits alongside whichever of the two applies, not instead of it.
  const subParts = [];
  if (deck.newDeck) {
    subParts.push("New deck");
  } else if (deck.gamesLogged > 0) {
    subParts.push(`Logged ${deck.gamesLogged} game${deck.gamesLogged === 1 ? "" : "s"}`);
  }
  if (pgPower !== null) {
    subParts.push(`Playgroup Power: ${formatPower(pgPower)}`);
  }
  if (subParts.length > 0) {
    const sub = document.createElement("div");
    sub.className = "deck-plate-sub";
    sub.textContent = subParts.join(" · ");
    left.appendChild(sub);
  }

  plate.appendChild(left);

  const right = document.createElement("div");
  right.className = "deck-plate-right";
  right.appendChild(bracketEditingDeckIds.has(deck.id) ? buildBracketEditRow(deck) : buildPowerCell(deck));
  plate.appendChild(right);

  return plate;
}

// Looks up a deck's power_level as playgroup.gg itself has it rated, for
// comparison against our own tracked Power column. Matches by playgroup
// deck ID first (backfilled onto most rows via deck-strength.xlsx column
// E), falling back to normalized commander name the same way
// computeRosterDiff does for decks the ID backfill hasn't reached yet.
// Returns null if roster-diff data hasn't loaded, the player has no
// linked playgroup.gg account, or no matching deck is found there.
function findPlaygroupPowerLevel(playerName, deck) {
  if (!rosterDiffData) return null;
  const member = rosterDiffData.members.find(m => m.mapped_player === playerName);
  if (!member) return null;
  const pgDecks = (rosterDiffData.decks_by_username[member.username] || []).filter(d => !d.archived);
  let match = deck.playgroupId ? pgDecks.find(d => String(d.id) === deck.playgroupId) : null;
  if (!match) {
    const target = normalizeCommanderName(deck.name);
    match = pgDecks.find(d => normalizeCommanderName(d.commander_name) === target);
  }
  return match && typeof match.power_level === "number" ? match.power_level : null;
}

function renderPlayersTable() {
  const container = document.getElementById("players-table");
  container.innerHTML = "";

  if (podPlayers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No playgroup-linked players found in Current Deck Strength yet.";
    container.appendChild(empty);
    return;
  }

  const overviewStrip = buildPowerOverviewStrip();
  if (overviewStrip) container.appendChild(overviewStrip);

  for (const player of podPlayers) {
    const isExpanded = expandedPlayerId === player.id;
    // Archived on playgroup.gg means retired -- not shown here, and not
    // offered in Set Up Pod either (see renderPodSlots).
    const activeDecks = player.decks.filter(d => !d.archived);

    const block = document.createElement("div");
    block.className = "player-block";
    // Scroll target for buildPowerOverviewStrip's pills above.
    block.id = `player-block-${player.id}`;

    const header = document.createElement("div");
    header.className = "player-block-header";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "icon-btn toggle-btn";
    toggleBtn.textContent = isExpanded ? "▾" : "▸";
    toggleBtn.setAttribute("aria-label", isExpanded ? "Collapse" : "Expand");
    toggleBtn.addEventListener("click", () => {
      expandedPlayerId = isExpanded ? null : player.id;
      renderPlayersTable();
    });

    const nameSpan = document.createElement("span");
    nameSpan.className = "player-name-display";
    nameSpan.textContent = player.name;

    const deckCount = document.createElement("span");
    deckCount.className = "deck-count";
    deckCount.textContent = `${activeDecks.length} deck${activeDecks.length === 1 ? "" : "s"}`;
    deckCount.addEventListener("click", () => {
      expandedPlayerId = isExpanded ? null : player.id;
      renderPlayersTable();
    });

    const headerLeft = document.createElement("div");
    headerLeft.className = "player-block-header-left";
    headerLeft.appendChild(toggleBtn);
    headerLeft.appendChild(nameSpan);

    // Shown collapsed or expanded (header always renders) so a flagged
    // deck is noticeable without expanding every player to check -- same
    // pattern as the Games to Update / Update the App tab badges.
    const comboCount = activeDecks.filter(d => d.comboFlagged).length;
    if (comboCount > 0) {
      const comboBadge = document.createElement("span");
      comboBadge.className = "tab-badge";
      comboBadge.textContent = String(comboCount);
      comboBadge.title = `${comboCount} deck${comboCount === 1 ? "" : "s"} showing the Bracket 4 combo pattern — expand to see which.`;
      headerLeft.appendChild(comboBadge);
    }

    headerLeft.appendChild(deckCount);

    header.appendChild(headerLeft);
    block.appendChild(header);

    if (!isExpanded) {
      container.appendChild(block);
      continue;
    }

    // pgPower computed once up front (not inline during sort) so a sort by
    // that column doesn't re-look-it-up on every comparison.
    const deckRows = activeDecks.map(deck => ({ deck, pgPower: findPlaygroupPowerLevel(player.name, deck) }));

    const sortState = playerDeckSortState.get(player.id) || { column: null, direction: "asc" };
    if (sortState.column) {
      const dir = sortState.direction === "asc" ? 1 : -1;
      deckRows.sort((a, b) => {
        if (sortState.column === "deck") return a.deck.name.localeCompare(b.deck.name) * dir;
        const av = sortState.column === "power" ? a.deck.power : a.pgPower;
        const bv = sortState.column === "power" ? b.deck.power : b.pgPower;
        // Missing Playgroup Power always sorts last regardless of
        // direction, same reasoning as renderWinRatesTable's null
        // handling -- "unknown" isn't the same thing as "weakest."
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av === null ? 1 : -1;
        }
        return (av - bv) * dir;
      });
    }

    const sortBar = buildSortBar(PLAYER_DECK_COLUMNS, sortState.column, sortState.direction, col => {
      if (sortState.column === col.key) {
        playerDeckSortState.set(player.id, { column: col.key, direction: sortState.direction === "desc" ? "asc" : "desc" });
      } else {
        playerDeckSortState.set(player.id, { column: col.key, direction: col.defaultDir });
      }
      renderPlayersTable();
    });
    block.appendChild(sortBar);

    const plateList = document.createElement("div");
    plateList.className = "deck-plate-list";
    for (const { deck, pgPower } of deckRows) {
      plateList.appendChild(buildDeckPlate(deck, pgPower));
    }
    block.appendChild(plateList);
    container.appendChild(block);
  }
}

// ---------- pod setup UI ----------

function initPlayerCountSelect() {
  const sel = document.getElementById("player-count");
  sel.innerHTML = "";
  for (let n = 1; n <= 8; n++) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  }
  sel.value = podCount;
  sel.addEventListener("change", () => {
    podCount = parseInt(sel.value, 10);
    renderPodSlots();
  });
}

// Pull-to-refresh's own reset, on top of the usual data refetch -- a pull
// signals "we're done with this pod, starting fresh" (unlike the desktop
// refresh button, a background visibility-change refresh, or the refresh
// that follows a submission, none of which should blow away a pod someone's
// still setting up), so it also clears every slot's player/deck pick, pod
// size back to its initial default, and any stale pass/fail results from
// the last check.
function resetPodSetup() {
  podCount = 4;
  podSelections = [];
  lastCeiling = null;
  editingSeatIndex = null;
  const sel = document.getElementById("player-count");
  if (sel) sel.value = podCount;
  renderPodSlots();
  const resultsSection = document.getElementById("results-section");
  if (resultsSection) resultsSection.hidden = true;
}

// The player+deck picker for one slot -- shared by both the round-table
// seat editor and the plain linear list past 6 seats (see renderPodSlots),
// so the deck-masking/out-of-range-filtering logic that used to live
// inline in one big loop only exists once. `onChange`, if given, fires
// after either select actually changes the slot's state (not on the
// masked button's reveal-click, which changes nothing yet) -- the round
// table uses it to update a seat's own display live, without re-rendering
// the whole picker out from under whoever's mid-edit.
// The decks a seat may actually pick from. Archived on playgroup.gg means
// retired -- never offered, same reasoning as Players & Decks. A seat the
// last check flagged as over the pod's range only offers decks that would
// bring it back in range, so re-picking can't land on another
// incompatible deck; falls back to the full list when this player has
// nothing that low, rather than offering nothing pickable at all.
function decksAvailableForSlot(slot) {
  const player = podPlayers.find(p => String(p.id) === slot.playerId);
  if (!player) return [];
  const activeDecks = player.decks.filter(d => !d.archived);
  const restricted = slot.outOfRange && lastCeiling !== null
    ? activeDecks.filter(d => d.power <= lastCeiling)
    : null;
  return restricted && restricted.length > 0 ? restricted : activeDecks;
}

// Changing a pick after a check has run leaves the results card showing a
// verdict for a pod that no longer exists -- this flags the button and the
// affected row rather than letting it go quietly stale.
function markPodCheckStale(slot) {
  const resultsSection = document.getElementById("results-section");
  if (!resultsSection || resultsSection.hidden) return;
  document.getElementById("validate-btn").classList.add("glow");
  const staleRow = document.querySelector(`.result-row[data-player-id="${slot.playerId}"]`);
  if (staleRow) staleRow.classList.add("pending-recheck");
}

// The first seat still missing a player or a deck, or null when the pod's
// complete. Drives the deal cadence: finishing one seat opens the next.
function nextIncompleteSeat() {
  for (let i = 0; i < podSelections.length; i++) {
    if (!podSelections[i].playerId || !podSelections[i].deckId) return i;
  }
  return null;
}

// One seat, as a row. Collapsed it's a single line; the open one expands
// in place to whatever that seat still needs -- players to choose from, or
// that player's decks. Only one row is ever open (editingSeatIndex).
//
// A settled row shows the player and a lock, never the deck: the deck a
// player picked stays hidden from everyone including them, which is the
// same rule the round table enforced by masking its picker.
function buildDealRow(i) {
  const slot = podSelections[i];
  const player = podPlayers.find(p => String(p.id) === slot.playerId);
  const expanded = editingSeatIndex === i;
  const settled = !!(player && slot.deckId);

  const row = document.createElement("div");
  row.className = "deal-row";
  if (expanded) row.classList.add("deal-row-open");
  else if (slot.outOfRange) row.classList.add("deal-row-flagged");
  else if (settled) row.classList.add("deal-row-settled");

  const head = document.createElement("button");
  head.type = "button";
  head.className = "deal-head";
  head.addEventListener("click", () => {
    editingSeatIndex = expanded ? null : i;
    renderPodSlots();
  });

  const avatar = document.createElement("span");
  avatar.className = "deal-avatar";
  avatar.textContent = player ? player.name.charAt(0).toUpperCase() : "+";
  head.appendChild(avatar);

  const text = document.createElement("span");
  text.className = "deal-text";
  const nameEl = document.createElement("span");
  nameEl.className = "deal-name";
  nameEl.textContent = player ? player.name : `Seat ${i + 1}`;
  text.appendChild(nameEl);

  const stateEl = document.createElement("span");
  stateEl.className = "deal-state";
  if (!player) {
    stateEl.textContent = "Add a player";
  } else if (slot.outOfRange) {
    // outOfRange survives until the NEXT check (same as before this
    // layout), and a flagged seat always still holds the deck that failed
    // -- so "has a deck" can't be what distinguishes these two. repicked
    // is set the moment this seat's deck actually changes, which is when
    // the honest ask stops being "pick a new deck" and becomes "re-check".
    stateEl.textContent = slot.repicked ? "Re-check the spread" : "Pick a new deck";
  } else if (slot.deckId) {
    stateEl.innerHTML = `${uiIcon("lock")}<span>Deck locked in</span>`;
  } else {
    stateEl.textContent = "Pick a deck";
  }
  text.appendChild(stateEl);
  head.appendChild(text);

  const action = document.createElement("span");
  action.className = "deal-action";
  action.textContent = expanded ? "Done" : (settled ? "Change" : "");
  head.appendChild(action);

  row.appendChild(head);
  if (expanded) row.appendChild(buildDealBody(i, slot, player));
  return row;
}

function buildDealBody(i, slot, player) {
  const body = document.createElement("div");
  body.className = "deal-body";

  // --- no player yet: who's in this seat ---
  if (!player) {
    const chips = document.createElement("div");
    chips.className = "deal-chips";
    for (const p of podPlayers) {
      const seatedElsewhere = podSelections.some((s, j) => j !== i && s.playerId === String(p.id));
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "deal-chip" + (seatedElsewhere ? " deal-chip-taken" : "");
      chip.disabled = seatedElsewhere;

      const chipAvatar = document.createElement("span");
      chipAvatar.className = "deal-chip-avatar";
      chipAvatar.textContent = p.name.charAt(0).toUpperCase();
      chip.appendChild(chipAvatar);

      const chipName = document.createElement("span");
      chipName.textContent = p.name;
      chip.appendChild(chipName);

      if (seatedElsewhere) {
        const tag = document.createElement("span");
        tag.className = "deal-chip-tag";
        tag.textContent = "seated";
        chip.appendChild(tag);
      }

      chip.addEventListener("click", () => {
        slot.playerId = String(p.id);
        slot.deckId = "";
        renderPodSlots();
      });
      chips.appendChild(chip);
    }
    body.appendChild(chips);
    return body;
  }

  // --- player chosen: which of their decks ---
  const decks = decksAvailableForSlot(slot);
  const list = document.createElement("div");
  list.className = "deal-decks";
  for (const d of decks) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "deal-deck" + (String(d.id) === slot.deckId ? " deal-deck-current" : "");

    const name = document.createElement("span");
    name.className = "deal-deck-name";
    name.textContent = d.name;
    btn.appendChild(name);

    // Games logged, not power -- power is the thing this screen keeps
    // hidden, and how often a deck gets played is the one hint that
    // helps you find it in a 17-deck list without leaking anything.
    const games = document.createElement("span");
    games.className = "deal-deck-games";
    games.textContent = d.gamesLogged === 1 ? "1 game" : `${d.gamesLogged || 0} games`;
    btn.appendChild(games);

    btn.addEventListener("click", () => {
      const changed = slot.deckId !== String(d.id);
      slot.deckId = String(d.id);
      if (slot.outOfRange && changed) slot.repicked = true;
      markPodCheckStale(slot);
      // Finishing a seat deals the next one rather than leaving you on a
      // finished row -- and closes up entirely once the pod's full.
      editingSeatIndex = nextIncompleteSeat();
      renderPodSlots();
    });
    list.appendChild(btn);
  }
  body.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "deal-body-footer";

  const swap = document.createElement("button");
  swap.type = "button";
  swap.className = "deal-swap";
  swap.textContent = "Someone else in this seat";
  swap.addEventListener("click", () => {
    slot.playerId = "";
    slot.deckId = "";
    renderPodSlots();
  });
  footer.appendChild(swap);

  const note = document.createElement("span");
  note.className = "deal-note";
  note.innerHTML = `${uiIcon("lock")}<span>Hidden once you pick</span>`;
  footer.appendChild(note);

  body.appendChild(footer);
  return body;
}

// One segment per seat, filled as each one settles -- the at-a-glance
// version of the count, and the only thing at the top of this screen that
// isn't a seat.
function buildDealProgress() {
  const wrap = document.createElement("div");
  wrap.className = "deal-progress";

  const track = document.createElement("div");
  track.className = "deal-progress-track";
  let ready = 0;
  for (const slot of podSelections) {
    const seg = document.createElement("span");
    const settled = !!(slot.playerId && slot.deckId && !slot.outOfRange);
    if (settled) ready++;
    seg.className = "deal-seg" + (settled ? " deal-seg-on" : (slot.playerId ? " deal-seg-part" : ""));
    track.appendChild(seg);
  }
  wrap.appendChild(track);

  const label = document.createElement("span");
  label.className = "deal-progress-label";
  label.textContent = ready === podSelections.length ? "All seats ready" : `${ready} of ${podSelections.length}`;
  wrap.appendChild(label);

  return wrap;
}

// The pod builder: one row per seat, top to bottom, at every pod size.
// Replaces the round table that used to live here (and the separate plain
// list a pod of 7-8 fell back to) -- one layout to learn instead of two,
// the controls open inside the row you tapped rather than in a panel
// below the table, and the table itself is saved for the reveal.
function renderPodDealIn(container) {
  container.appendChild(buildDealProgress());

  const rows = document.createElement("div");
  rows.className = "deal-rows";
  for (let i = 0; i < podCount; i++) {
    rows.appendChild(buildDealRow(i));
  }
  container.appendChild(rows);
}

function renderPodSlots() {
  const container = document.getElementById("pod-slots");
  container.innerHTML = "";

  const prevSelections = podSelections;
  podSelections = [];
  for (let i = 0; i < podCount; i++) {
    const prev = prevSelections[i] || {};
    podSelections.push({ playerId: prev.playerId || "", deckId: prev.deckId || "", outOfRange: !!prev.outOfRange, repicked: !!prev.repicked });
  }
  // A seat that was open under the old count means nothing once the pod's
  // shrunk past it.
  if (editingSeatIndex !== null && editingSeatIndex >= podCount) editingSeatIndex = null;
  // Open the first seat on a pod nobody's touched yet, so the screen
  // starts mid-flow instead of asking for a tap to begin. Deliberately
  // only for a completely empty pod -- otherwise closing a row with Done
  // would just spring it (or another) straight back open.
  if (editingSeatIndex === null && podSelections.every(s => !s.playerId && !s.deckId)) {
    editingSeatIndex = 0;
  }

  renderPodDealIn(container);
}

// ---------- reveal modal (Scryfall commander art) ----------

const SCRYFALL_NAMED_URL = "https://api.scryfall.com/cards/named";
// cardName -> { imageUrl } | null (lookup failed) -- so re-opening the
// modal for the same commanders across pods/checks doesn't re-hit
// Scryfall every time.
const commanderArtCache = new Map();

// Our own disambiguation suffix for two players tracking the same
// commander (e.g. "Eshki, Temur's Roar (Manny's)") isn't part of the real
// card name and would break a Scryfall lookup -- strip it first.
function stripDeckDisambiguation(name) {
  return name.replace(/\s*\([^()]*'s\)\s*$/i, "").trim();
}

// Partner/background commanders are tracked as one deck name joined with
// "/" (e.g. "Leonardo, the Balance/Michelangelo, the Heart") -- split into
// the individual real card names Scryfall actually knows.
function splitCommanderNames(deckName) {
  return stripDeckDisambiguation(deckName).split("/").map(s => s.trim()).filter(Boolean);
}

// fuzzy= tolerates the kind of near-miss a hand-typed deck name is prone
// to (accents, minor punctuation) far better than an exact-name lookup.
async function fetchCommanderArt(cardName) {
  if (commanderArtCache.has(cardName)) return commanderArtCache.get(cardName);
  let result = null;
  try {
    const res = await fetch(`${SCRYFALL_NAMED_URL}?fuzzy=${encodeURIComponent(cardName)}`);
    if (res.ok) {
      const card = await res.json();
      // Double-faced/split cards have no top-level image_uris -- the front
      // face's is under card_faces[0] instead.
      const imageUrl = card.image_uris?.art_crop || card.card_faces?.[0]?.image_uris?.art_crop || null;
      if (imageUrl) result = { imageUrl };
    }
  } catch {
    // Network hiccup or Scryfall down -- falls through to the text
    // fallback in showRevealModal, never breaks the popup over one lookup.
  }
  commanderArtCache.set(cardName, result);
  return result;
}

// Popped open automatically once runValidation finds the whole pod in
// range. Each tile's art loads independently (no shared loading gate) so
// one slow or failed lookup never holds up the rest of the reveal.
function showRevealModal(evaluated) {
  const modal = document.getElementById("reveal-modal");
  const grid = document.getElementById("reveal-modal-grid");
  const goBtn = document.getElementById("reveal-modal-to-game");
  const colorStrip = document.getElementById("reveal-color-strip");
  if (!modal || !grid || !goBtn) return;

  goBtn.href = PLAYGROUP_URL;
  grid.innerHTML = "";

  // This pod's combined colors, deduped and in a fixed order -- the same
  // coin language as Players & Decks (see buildIdentityCoin), just as a
  // banner strip instead of a per-deck coin. Skips entries with no
  // captured color identity entirely rather than treating "unknown" as
  // "colorless" -- the two aren't the same claim. Naturally capped at 5
  // bars regardless of pod size, since there are only 5 colors to combine.
  if (colorStrip) {
    colorStrip.innerHTML = "";
    // Weighted by how many decks at the table actually play each colour,
    // not just which colours appear -- a pod where three decks are green
    // and one splashes red should look like that, which an even five-bar
    // strip couldn't show. Skips entries with no captured colour identity
    // entirely rather than treating "unknown" as "colorless" -- the two
    // aren't the same claim. Naturally capped at 5 bars regardless of pod
    // size, since there are only 5 colors to combine.
    const colorCounts = new Map();
    for (const entry of evaluated) {
      if (typeof entry.colorIdentity !== "string") continue;
      for (const c of new Set(entry.colorIdentity)) {
        colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
      }
    }
    const ordered = WUBRG_ORDER.filter(c => colorCounts.has(c));
    for (const c of ordered) {
      const count = colorCounts.get(c);
      const bar = document.createElement("span");
      bar.className = `reveal-strip-bar reveal-strip-bar-${c.toLowerCase()}`;
      bar.style.background = `var(${PIP_COLOR_VAR[c]})`;
      bar.style.flexGrow = String(count);
      bar.textContent = count > 1 ? `${c} ${count}` : c;
      colorStrip.appendChild(bar);
    }
    colorStrip.hidden = ordered.length === 0;
    colorStrip.setAttribute(
      "aria-label",
      ordered.length
        ? `Colours at this table: ${ordered.map(c => `${WUBRG_NAMES[c]} ${colorCounts.get(c)}`).join(", ")}`
        : ""
    );
  }

  // Post-reveal, so the spread is safe to state outright -- this is the
  // number the pod just passed on, and it's the whole reason the table
  // agreed to sit down. Scoped to judged (non-exempt) decks, same as the
  // banner on the results card.
  const revealSummary = document.getElementById("reveal-summary");
  if (revealSummary) {
    const judgedPowers = evaluated.filter(e => !e.newDeck).map(e => e.power);
    if (judgedPowers.length) {
      const lo = Math.min(...judgedPowers);
      const hi = Math.max(...judgedPowers);
      revealSummary.textContent =
        `Spread ${(hi - lo).toFixed(1)} · ${lo.toFixed(1)}–${hi.toFixed(1)} · ${evaluated.length} seat${evaluated.length === 1 ? "" : "s"}`;
      revealSummary.hidden = false;
    } else {
      revealSummary.hidden = true;
    }
  }

  // Sized so the whole popup fits the viewport with no scrolling, for any
  // pod size 1-8 -- capped at 4 columns (wraps to a 2nd row past 4
  // players), image height computed from whatever's left after the
  // title/button/padding chrome and however many rows that produces.
  const n = evaluated.length;
  const columns = Math.min(4, n) || 1;
  const rows = Math.ceil(n / columns);
  const modalMaxHeight = Math.min(window.innerHeight * 0.9, 640);
  const chromeHeight = 150; // title + button + padding, roughly
  const textHeight = 44;    // player name + deck name lines, per row
  const gapHeight = 12;
  const availableForImages = modalMaxHeight - chromeHeight - (rows * textHeight) - ((rows - 1) * gapHeight);
  // Capped at 260 -- a small pod (1-3 players, few rows) has plenty of
  // vertical room to spare, but a single giant image looks disproportionate
  // even though it'd technically still fit without scrolling.
  const imageHeight = Math.min(260, Math.max(70, Math.floor(availableForImages / rows)));

  grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  grid.style.setProperty("--reveal-img-height", `${imageHeight}px`);

  for (const entry of evaluated) {
    const tile = document.createElement("div");
    tile.className = "reveal-tile";

    const artSlot = document.createElement("div");
    artSlot.className = "reveal-tile-art-fallback";
    artSlot.textContent = "Painting the art…";
    tile.appendChild(artSlot);

    const playerLine = document.createElement("div");
    playerLine.className = "reveal-tile-player";
    playerLine.textContent = entry.playerName;
    tile.appendChild(playerLine);

    const deckLine = document.createElement("div");
    deckLine.className = "reveal-tile-deck";
    deckLine.textContent = entry.deckName;
    tile.appendChild(deckLine);

    grid.appendChild(tile);

    const cardNames = splitCommanderNames(entry.deckName);
    Promise.all(cardNames.map(fetchCommanderArt)).then(arts => {
      const found = arts.filter(Boolean);
      if (found.length === 0) {
        artSlot.textContent = "No card art found";
        return;
      }
      const pair = document.createElement("div");
      pair.className = "reveal-tile-art-pair";
      for (const art of found) {
        const img = document.createElement("img");
        img.className = "reveal-tile-art";
        img.src = art.imageUrl;
        img.alt = "";
        img.loading = "lazy";
        pair.appendChild(img);
      }
      artSlot.replaceWith(pair);
    });
  }

  modal.hidden = false;
}

function hideRevealModal() {
  const modal = document.getElementById("reveal-modal");
  if (modal) modal.hidden = true;
}

document.getElementById("reveal-modal-close")?.addEventListener("click", hideRevealModal);
document.getElementById("reveal-modal")?.addEventListener("click", e => {
  if (e.target.id === "reveal-modal") hideRevealModal();
});

function hideComboTrackModal() {
  const modal = document.getElementById("combo-track-modal");
  if (modal) modal.hidden = true;
}

// Only shown for turning tracking ON (see the flame toggle's click handler
// in buildPowerCell) -- turning it back off stays a plain, instant toggle,
// no confirmation needed.
function showComboTrackConfirm(deck) {
  const modal = document.getElementById("combo-track-modal");
  const body = document.getElementById("combo-track-modal-body");
  const confirmBtn = document.getElementById("combo-track-modal-confirm");
  if (!modal || !body || !confirmBtn) return;

  body.textContent = `From here on, every logged game for ${deck.name} asks one more question: did the early combo come online? Land it in 3 of its last 5 games and the deck earns the flame badge — a heads-up it might be playing more like Bracket 4 than Bracket 3. Pull it off watch anytime from the same flame icon.`;

  // Reassigning .onclick (not addEventListener) guarantees exactly one
  // handler is ever live, bound to whichever deck's confirm is currently
  // open -- addEventListener here would stack a new listener every time
  // the modal opens, firing every previously-confirmed deck's toggle too.
  confirmBtn.onclick = () => {
    hideComboTrackModal();
    togglePotentialBracket4(deck);
  };

  modal.hidden = false;
}

document.getElementById("combo-track-modal-close")?.addEventListener("click", hideComboTrackModal);
document.getElementById("combo-track-modal-cancel")?.addEventListener("click", hideComboTrackModal);
document.getElementById("combo-track-modal")?.addEventListener("click", e => {
  if (e.target.id === "combo-track-modal") hideComboTrackModal();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    hideRevealModal();
    hideComboTrackModal();
    hideAuthMenu();
  }
});

// ---------- validation ----------

function evaluatePod(entries) {
  // entries: [{ playerId, playerName, deckId, power, newDeck }]
  // A deck flagged newDeck (decks.new_deck, set when it's pulled in via
  // Update the App, cleared the moment it's actually played -- see
  // handleRosterWrite/handleGamesWrite in relay.js) is exempt: its power
  // is only baseline_power, an unconfirmed estimate, so it never enters
  // the floor/ceiling math and can't drag an otherwise-fine pod out of
  // range (or hide a real mismatch among everyone else behind its own
  // pass). Exempt entries are always compatible, regardless of power.
  const judged = entries.filter(e => !e.newDeck);

  // Nobody here has a confirmed power yet -- nothing to compare, so
  // there's nothing to validate. Every slot is exempt.
  if (judged.length === 0) {
    return entries.map(entry => ({ ...entry, compatible: true, overBy: 0, exempt: true }));
  }

  // The weakest judged deck sets the floor; anything more than
  // RANGE_TOLERANCE above it needs to come down. The weakest deck itself
  // is always compatible — it's never asked to get even weaker.
  const floor = Math.min(...judged.map(e => e.power));
  const ceiling = floor + RANGE_TOLERANCE;
  return entries.map(entry => {
    if (entry.newDeck) return { ...entry, compatible: true, overBy: 0, exempt: true };
    return {
      ...entry,
      compatible: entry.power <= ceiling,
      overBy: +Math.max(0, entry.power - ceiling).toFixed(2),
      exempt: false,
    };
  });
}

// Draws the exact floor/ceiling math evaluatePod already computes, so the
// spread reads as a shape instead of a sentence. Deliberately reveals
// nothing beyond what the banner/result rows already say out loud: marker
// position is relative to the floor (never an absolute power number), and
// the only number ever printed on a marker is the same "+X over" amount
// already shown per-row for anyone flagged out of range -- an in-range
// marker gets no number at all, matching how its row just says "In range."
function buildPowerGauge(judgedEntries, floor, ceiling) {
  const wrap = document.createElement("div");
  wrap.className = "gauge-wrap";
  const track = document.createElement("div");
  track.className = "gauge-track";

  // ceiling - floor is always exactly RANGE_TOLERANCE, but derived rather
  // than assumed in case that ever changes. The track extends past the
  // ceiling when someone's over it, so the good zone's width shrinks to
  // however much of the full (possibly-stretched) track it actually covers.
  const span = ceiling - floor;
  const maxPower = Math.max(ceiling, ...judgedEntries.map(e => e.power));
  const totalSpan = Math.max(span, maxPower - floor) || 1;

  const zone = document.createElement("div");
  zone.className = "gauge-zone";
  zone.style.width = `${Math.min(100, (span / totalSpan) * 100)}%`;
  track.appendChild(zone);

  for (const entry of judgedEntries) {
    const pct = Math.min(100, Math.max(0, ((entry.power - floor) / totalSpan) * 100));
    const marker = document.createElement("div");
    marker.className = "gauge-marker " + (entry.compatible ? "ok" : "over");
    marker.style.left = `${pct}%`;

    const label = document.createElement("span");
    label.className = "dot-label";
    label.textContent = entry.playerName;
    marker.appendChild(label);

    if (!entry.compatible) {
      const val = document.createElement("span");
      val.className = "dot-value";
      val.textContent = `+${formatPower(entry.overBy)}`;
      marker.appendChild(val);
    }
    track.appendChild(marker);
  }

  wrap.appendChild(track);
  return wrap;
}

function runValidation() {
  const resultsSection = document.getElementById("results-section");
  const resultsDiv = document.getElementById("results");
  document.getElementById("validate-btn").classList.remove("glow");
  resultsDiv.innerHTML = "";
  resultsSection.hidden = false;
  // Results render in a separate card below the seats -- on a phone that
  // card can easily start below the fold, so tapping the button did
  // something invisible until you scrolled down to check. Same pattern
  // openGameForm already uses for the same reason (see its own
  // scrollIntoView); "nearest" is a no-op if the section's already visible,
  // so re-checking while already looking at the results doesn't yank the
  // page around.
  resultsSection.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const incomplete = podSelections.some(s => !s.playerId || !s.deckId);
  if (incomplete) {
    const banner = document.createElement("div");
    banner.className = "banner bad";
    banner.textContent = "Select a player and a deck for every slot before checking.";
    resultsDiv.appendChild(banner);
    return;
  }

  const entries = podSelections.map(s => {
    const player = podPlayers.find(p => String(p.id) === s.playerId);
    const deck = player.decks.find(d => String(d.id) === s.deckId);
    return {
      playerId: player.id,
      playerName: player.name,
      deckId: deck.id,
      deckName: deck.name,
      power: deck.power,
      newDeck: !!deck.newDeck,
      colorIdentity: deck.colorIdentity,
    };
  });

  // Decks flagged newDeck are exempt from the power-spread check -- see
  // evaluatePod. The spread/floor/ceiling banner below is scoped to
  // "judged" (non-exempt) entries only; exempt ones are reported on
  // separately and never affect whether the pod passes.
  const judged = entries.filter(e => !e.newDeck);
  const exemptCount = entries.length - judged.length;
  const exemptNote = exemptCount > 0
    ? ` (${exemptCount} new deck${exemptCount === 1 ? "" : "s"} exempt — no games logged yet.)`
    : "";

  let allInRange;
  let gaugeFloor = null;
  if (judged.length === 0) {
    allInRange = true;
    lastCeiling = null;
    const banner = document.createElement("div");
    banner.className = "banner warn";
    banner.textContent = "Every deck here is new — nothing to validate yet. Go ahead and play!";
    resultsDiv.appendChild(banner);
  } else {
    const powers = judged.map(e => e.power);
    const max = Math.max(...powers);
    const min = Math.min(...powers);
    const spread = +(max - min).toFixed(2);
    allInRange = spread <= RANGE_TOLERANCE;

    const banner = document.createElement("div");
    banner.className = "banner " + (allInRange ? "good" : "bad");
    banner.textContent = (allInRange
      ? `All decks are within range (spread: ${formatPower(spread)}).`
      : `Spread is ${formatPower(spread)} — outside the ±${RANGE_TOLERANCE} target. Some decks need to change.`) + exemptNote;
    resultsDiv.appendChild(banner);

    // Feeds refreshDeckOptions in renderPodSlots: a slot flagged here only
    // offers decks at or under this ceiling the next time its picker reopens.
    lastCeiling = min + RANGE_TOLERANCE;
    gaugeFloor = min;
  }

  const evaluated = evaluatePod(entries);
  evaluated.forEach((entry, i) => {
    podSelections[i].outOfRange = !entry.compatible;
    // Every seat's verdict is fresh as of this check, so nothing is
    // "already re-picked" any more.
    podSelections[i].repicked = false;
  });

  // Re-render the seats against the outOfRange flags just set above --
  // without this a rejected pick kept reading as "Deck locked in", giving
  // no nudge that specifically that seat needs to change, and its deck
  // list wouldn't be narrowed to what actually fits (see
  // decksAvailableForSlot). Leaves whichever row is open open.
  renderPodSlots();

  // Drawn from the exact same evaluated data as the rows below -- see
  // buildPowerGauge for why this never shows more than the rows already do.
  if (gaugeFloor !== null) {
    resultsDiv.appendChild(buildPowerGauge(evaluated.filter(e => !e.exempt), gaugeFloor, gaugeFloor + RANGE_TOLERANCE));
  }

  for (const entry of evaluated) {
    const row = document.createElement("div");
    row.className = "result-row " + (entry.exempt ? "exempt" : (entry.compatible ? "ok" : "out"));
    row.dataset.playerId = entry.playerId;

    // Deck identity stays hidden while the pod might still change -- only
    // who it belongs to and whether their (unnamed) pick is in range. Once
    // the whole pod passes (allInRange), there's nothing left to hide:
    // everyone's committed, so the actual matchup is revealed here.
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.playerName;
    if (allInRange) {
      const deckNameSpan = document.createElement("span");
      deckNameSpan.className = "result-deck-name";
      deckNameSpan.textContent = ` — ${entry.deckName}`;
      name.appendChild(deckNameSpan);
    }

    // Power itself stays masked here too -- only the amount a deck is
    // over the pod's range is ever shown, never the raw power value.
    const power = document.createElement("span");
    power.className = "power";
    power.textContent = entry.exempt
      ? "🆕 New deck — exempt this game"
      : (entry.compatible ? "✓ In range" : `⚠ Over by ${formatPower(entry.overBy)}`);

    row.appendChild(name);
    row.appendChild(power);
    resultsDiv.appendChild(row);

    if (!entry.compatible && !entry.exempt) {
      const box = document.createElement("div");
      box.className = "suggestions";
      box.textContent = `Select a new deck for ${entry.playerName} above, then check the spread again.`;
      resultsDiv.appendChild(box);
    }
  }

  if (allInRange) {
    // "To the Game!" lives only in the reveal popup now, not duplicated
    // here inline -- see showRevealModal.
    showRevealModal(evaluated);
  }
}

document.getElementById("validate-btn").addEventListener("click", runValidation);

// ---------- tabs ----------

// Switches to a tab by name. Pulled out of initTabs' click handler so
// Tonight's action cards can route to Games to Update / New Players &
// Decks -- those two panels are no longer in either nav bar (see the nav
// comment in index.html), so this is the only way in.
//
// Panels that aren't nav destinations simply have no matching button;
// .active lands on nothing then, which is correct -- there's no tab to
// light up, and the panel's own back link returns to Tonight.
function activateTab(tabName) {
  const panel = document.getElementById(`tab-${tabName}`);
  if (!panel) return;
  document.querySelectorAll(".tab-btn, .bottom-tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(`[data-tab="${tabName}"]`).forEach(b => b.classList.add("active"));
  document.querySelectorAll(".tab-panel").forEach(p => { p.hidden = true; });
  panel.hidden = false;
  // Same id scheme as the tab panel (#bg-<tab> next to #tab-<tab>) --
  // opacity-transitions to the new one via the .active class, see the
  // .tab-bg rules in style.css for the actual crossfade.
  document.querySelectorAll(".tab-bg").forEach(bg => { bg.classList.remove("active"); });
  const bgEl = document.getElementById(`bg-${tabName}`);
  if (bgEl) bgEl.classList.add("active");
  window.scrollTo({ top: 0 });
}

function initTabs() {
  // .bottom-tab-btn is #bottom-tabs' touch-only mirror of the same 4
  // destinations (see index.html) -- both sets share data-tab values, so
  // one handler drives whichever bar is actually visible on this device
  // and keeps the other one's .active state in sync for free.
  document.querySelectorAll(".tab-btn, .bottom-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });
  document.querySelectorAll("[data-goto-tab]").forEach(el => {
    el.addEventListener("click", () => activateTab(el.dataset.gotoTab));
  });
}

// ---------- player win rates (read-only) ----------

function tallyPlaygroupWinRates(games) {
  const tally = {};
  for (const g of games) {
    for (const p of g.participants) {
      (tally[p.player] ||= { wins: 0, losses: 0 })[p.result === "win" ? "wins" : "losses"]++;
    }
  }
  return tally;
}

// Which column the Player Win Rates table is sorted by, and which
// direction -- persisted here (not local to renderWinRatesTable) so a
// re-render triggered by a data refresh doesn't reset a sort the user
// picked. Defaults to Player Adjusted Win Rate, highest first, since
// that's the group's own metric rather than playgroup.gg's raw rate.
let winRatesSortColumn = "adjusted"; // "adjusted" | "playgroup"
let winRatesSortDirection = "desc"; // "desc" | "asc"

// Column order left-to-right: the group's own metric (and its Trend)
// right next to Player, then playgroup.gg's raw rate further out.
const WINRATES_COLUMNS = [
  { key: "adjusted", label: "Player Adjusted Win Rate" },
  { key: "playgroup", label: "Win Rate (playgroup.gg)" },
];

// {name, rate} sorted descending -> {name: rank}, tied rates sharing a
// rank (competition-style: 1,1,3) so players tied at 0 don't show
// spurious movement purely from sort tie-breaking order. Mirrors
// assign_ranks in scripts/discord_report.py.
function assignRanks(rankedList) {
  const ranks = {};
  rankedList.forEach((item, i) => {
    if (i > 0 && Math.abs(item.rate - rankedList[i - 1].rate) < 1e-9) {
      ranks[item.name] = ranks[rankedList[i - 1].name];
    } else {
      ranks[item.name] = i + 1;
    }
  });
  return ranks;
}

// {player: 'up'/'down'/'steady'} -- whether each player's rank *position*
// in the Player Adjusted Win Rate standings moved compared to what the
// standings would be without the most recent logged game (someone passed
// them, or they passed someone). Rank-based rather than raw-score-based
// for the same reason as the Discord report: a raw rate can shift without
// reading as "better/worse" the way a leaderboard position does. Computed
// fresh from gameLogSeason3Rows every render -- no snapshot, so re-running
// never falsely shows everyone as steady. Mirrors compute_rank_trend in
// scripts/discord_report.py.
function computeWinRatesRankTrend() {
  const validRows = gameLogSeason3Rows.filter(r => typeof r.J === "number");
  if (!validRows.length) return {};
  const gameNums = validRows.map(r => r.gameNum).filter(g => typeof g === "number");
  if (!gameNums.length) return {};
  const maxGame = Math.max(...gameNums);

  const playerNames = [...new Set(validRows.map(r => r.player))];

  const rank = rowsForPlayer => {
    const ranked = playerNames
      .map(name => ({ name, rate: computePlayerAdjustedWinRate(rowsForPlayer(name)).B }))
      .sort((a, b) => b.rate - a.rate);
    return assignRanks(ranked);
  };

  const currentRanks = rank(name => validRows.filter(r => r.player === name));
  const previousRanks = rank(name => validRows.filter(r => r.player === name && r.gameNum !== maxGame));

  const trend = {};
  for (const name of playerNames) {
    if (currentRanks[name] < previousRanks[name]) trend[name] = "up";
    else if (currentRanks[name] > previousRanks[name]) trend[name] = "down";
    else trend[name] = "steady";
  }
  return trend;
}

const TREND_SYMBOL = { up: "▲", down: "▼", steady: "–" };
const TREND_CLASS = { up: "trend-up", down: "trend-down", steady: "trend-steady" };

// One player's row in Player Win Rates -- rank, name and trend lead, the
// sorted metric sets in the display face at the end of the same line, and
// the bar plus the other metric sit underneath. A row rather than the
// stacked card this used to be: six players of two numbers each was a
// screen and a half of scrolling, and the per-card metric labels repeated
// the sort control's own words six times over.
//
// One decimal, not three. The old .toFixed(3) implied precision the
// sample can't support -- at 22 games a single result moves the rate by
// more than a whole percentage point, so digits past the first were noise
// that made two close players look precisely different.
function buildWinRateCard(row, rank, sortKey, direction) {
  const card = document.createElement("div");
  card.className = "wr-card";

  const isAdjusted = sortKey === "adjPct";
  const primaryPct = isAdjusted ? row.adjPct : row.pgPct;
  const primaryWL = isAdjusted ? `${row.adjWins}-${row.adjLosses}` : `${row.pgWins}-${row.pgLosses}`;
  const primaryNa = isAdjusted ? "No games logged this season" : "No games in the active league yet";

  const header = document.createElement("div");
  header.className = "wr-card-header";

  const rankEl = document.createElement("span");
  rankEl.className = "wr-rank";
  rankEl.textContent = rank !== null ? rank : "—";
  header.appendChild(rankEl);

  const nameEl = document.createElement("span");
  nameEl.className = "wr-name";
  nameEl.textContent = row.name;
  header.appendChild(nameEl);

  if (row.adjPct !== null && direction) {
    const trendEl = document.createElement("span");
    trendEl.className = `wr-trend ${TREND_CLASS[direction]}`;
    trendEl.title = "Whether this player's rank in the Player Adjusted Win Rate standings moved compared to before their most recent logged game";
    trendEl.textContent = TREND_SYMBOL[direction];
    header.appendChild(trendEl);
  }

  const primaryValEl = document.createElement("span");
  primaryValEl.className = "wr-metric-value";
  primaryValEl.textContent = primaryPct !== null ? `${primaryPct.toFixed(1)}%` : "—";
  header.appendChild(primaryValEl);
  card.appendChild(header);

  const meter = document.createElement("div");
  meter.className = "wr-meter";
  if (primaryPct !== null) {
    const bar = document.createElement("div");
    bar.className = "wr-bar";
    const fill = document.createElement("div");
    fill.className = "wr-bar-fill";
    fill.style.width = `${Math.max(0, Math.min(100, primaryPct))}%`;
    bar.appendChild(fill);
    meter.appendChild(bar);

    const recordEl = document.createElement("span");
    recordEl.className = "wr-record";
    recordEl.textContent = primaryWL;
    meter.appendChild(recordEl);
  } else {
    const naEl = document.createElement("span");
    naEl.className = "wr-record wr-record-na";
    naEl.textContent = primaryNa;
    meter.appendChild(naEl);
  }
  card.appendChild(meter);

  // The metric that isn't sorted still shows, but abbreviated -- the sort
  // control above already names both in full, so repeating the whole label
  // on every row said nothing the reader didn't just read.
  const secondaryPct = isAdjusted ? row.pgPct : row.adjPct;
  const secondaryWL = isAdjusted ? `${row.pgWins}-${row.pgLosses}` : `${row.adjWins}-${row.adjLosses}`;
  const secondaryTag = isAdjusted ? "playgroup.gg" : "adjusted";
  const secondary = document.createElement("div");
  secondary.className = "wr-metric-secondary";
  secondary.textContent = secondaryPct !== null
    ? `${secondaryTag} ${secondaryPct.toFixed(1)}% (${secondaryWL})`
    : `${secondaryTag} —`;
  card.appendChild(secondary);

  return card;
}

// Renders the Player Win Rates table from an already-fetched
// /playgroup-games response -- see refreshPlaygroupGames below, which is
// the only place that actually fetches it. Called both from there and from
// syncFromD1 (a fresh gameLogSeason3Rows changes the Adjusted Win Rate
// column even when the playgroup.gg data itself hasn't changed). Safe to
// call with data === null (e.g. before the first fetch resolves) -- just
// leaves the status text as-is.
function renderWinRatesTable(data) {
  const statusEl = document.getElementById("winrates-sync-status");
  const noteEl = document.getElementById("winrates-note");
  const tableEl = document.getElementById("winrates-table");
  if (!statusEl || !noteEl || !tableEl) return;

  if (!PLAYGROUP_GAMES_RELAY_URL) {
    statusEl.textContent = "Live playgroup.gg data not configured.";
    return;
  }
  if (!data) return;

  const tally = tallyPlaygroupWinRates(data.games || []);

  // Compute both columns' values up front, per player, so they can be
  // sorted before any DOM gets built. `pct`/`adjPct` are null (rather than
  // 0) when there's no data -- those rows always sort to the bottom
  // regardless of direction, instead of looking like a 0% win rate.
  const rowData = podPlayers.map(player => {
    const name = player.name;
    const t = tally[name];
    const hasPlaygroup = !!t && (t.wins + t.losses) > 0;
    const pgPct = hasPlaygroup ? (t.wins / (t.wins + t.losses)) * 100 : null;

    const adjRows = gameLogSeason3Rows.filter(r => r.player === name && typeof r.J === "number");
    const hasAdjusted = adjRows.length > 0;
    const adj = hasAdjusted ? computePlayerAdjustedWinRate(adjRows) : null;

    return {
      name,
      pgPct, pgWins: t ? t.wins : 0, pgLosses: t ? t.losses : 0,
      adjPct: hasAdjusted ? adj.B * 100 : null, adjWins: hasAdjusted ? adj.wins : 0, adjLosses: hasAdjusted ? adj.losses : 0,
    };
  });

  const sortKey = winRatesSortColumn === "playgroup" ? "pgPct" : "adjPct";
  const dir = winRatesSortDirection === "asc" ? 1 : -1;
  rowData.sort((a, b) => {
    if (a[sortKey] === null && b[sortKey] === null) return 0;
    if (a[sortKey] === null) return 1;
    if (b[sortKey] === null) return -1;
    return (a[sortKey] - b[sortKey]) * dir;
  });

  const trendByPlayer = computeWinRatesRankTrend();

  // Competition-style ranks (ties share a rank) off whichever metric is
  // currently sorted -- same assignRanks used for the trend calculation,
  // so "who's #1" agrees with what computeWinRatesRankTrend already
  // considers #1. Computed from a fixed descending order regardless of
  // winRatesSortDirection: flipping the list to see the bottom of the
  // pack first shouldn't relabel the best performer as anything but #1.
  // Rows with no data for this metric never get a rank at all.
  const rankable = rowData.filter(r => r[sortKey] !== null).sort((a, b) => b[sortKey] - a[sortKey]);
  const rankByName = assignRanks(rankable.map(r => ({ name: r.name, rate: r[sortKey] })));

  // Tonight shows the signed-in player their own standing, and it should
  // be the same number this tab just computed rather than a second
  // calculation that could drift. Always the adjusted metric there, no
  // matter which column this tab happens to be sorted by.
  latestStandings = {
    rows: rowData,
    adjustedRankByName: assignRanks(
      rowData.filter(r => r.adjPct !== null)
        .sort((a, b) => b.adjPct - a.adjPct)
        .map(r => ({ name: r.name, rate: r.adjPct }))
    ),
  };
  renderTonight();

  tableEl.innerHTML = "";

  const sortBar = buildSortBar(WINRATES_COLUMNS, winRatesSortColumn, winRatesSortDirection, col => {
    if (winRatesSortColumn === col.key) {
      winRatesSortDirection = winRatesSortDirection === "desc" ? "asc" : "desc";
    } else {
      winRatesSortColumn = col.key;
      winRatesSortDirection = "desc";
    }
    renderWinRatesTable(playgroupGamesData);
  });
  tableEl.appendChild(sortBar);

  const list = document.createElement("div");
  list.className = "wr-card-list";
  for (const row of rowData) {
    list.appendChild(buildWinRateCard(row, rankByName[row.name] ?? null, sortKey, trendByPlayer[row.name]));
  }
  tableEl.appendChild(list);

  statusEl.textContent = `Live as of ${new Date(data.generated_at).toLocaleTimeString()} (playgroup.gg data may be cached up to 5 min).`;
  noteEl.innerHTML = "";
  const note = document.createElement("span");
  note.className = "note-line";
  note.textContent = `Scoped to the active league (${data.league || "unknown"}). Player Adjusted Win Rate is computed live from the current season's Game Log.`;
  noteEl.appendChild(note);
}

// ---------- games to update ----------

let playgroupGamesData = null;

// The one place /playgroup-games actually gets fetched. Games to Update and
// Player Win Rates used to each fetch it independently -- up to 3 calls to
// the same endpoint on a single page load (direct loadWinRates() call,
// loadWinRates() again via syncFromD1, and loadPlaygroupGames()) for data
// that's identical every time. Both now render from this single fetch
// instead.
async function refreshPlaygroupGames() {
  const gtuStatusEl = document.getElementById("gtu-status");
  const wrStatusEl = document.getElementById("winrates-sync-status");
  // Not configured, or the fetch genuinely failed, are both real terminal
  // outcomes -- unlike renderGamesToUpdate's own "still syncing the Game
  // Log" branch (which fires while this same fetch just hasn't landed
  // yet), there's nothing left to wait on here, so the skeleton comes
  // down in favor of the status text explaining why, same as a plain
  // empty container always has.
  if (!PLAYGROUP_GAMES_RELAY_URL) {
    if (gtuStatusEl) { gtuStatusEl.textContent = "Live playgroup.gg data not configured."; document.getElementById("gtu-game-list").innerHTML = ""; }
    if (wrStatusEl) { wrStatusEl.textContent = "Live playgroup.gg data not configured."; document.getElementById("winrates-table").innerHTML = ""; }
    return;
  }
  try {
    const res = await fetch(PLAYGROUP_GAMES_RELAY_URL, { cache: "no-store", headers: authHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    }
    playgroupGamesData = await res.json();
    applyKnownPlayers(playgroupGamesData);
    renderGamesToUpdate();
    renderWinRatesTable(playgroupGamesData);
  } catch (err) {
    if (gtuStatusEl) { gtuStatusEl.textContent = `Couldn't load live playgroup.gg data (${err.message}).`; document.getElementById("gtu-game-list").innerHTML = ""; }
    if (wrStatusEl) { wrStatusEl.textContent = `Couldn't load live win rates (${err.message}).`; document.getElementById("winrates-table").innerHTML = ""; }
  }
}

// Matches every currently-tracked playgroup.gg game against the Game Log's
// logged games, one-to-one. A row already carrying a Playgroup Game ID
// (set by POST /games at write time; NULL for older manually-entered
// games predating that) matches by exact ID, no inference needed. For
// everything else, a logged game and a playgroup.gg game are
// treated as the same real game if the same set of tracked players appears
// under a Game Log game number, within a day and a half of the
// playgroup.gg timestamp (playgroup.gg logs in UTC+2; the sheet's date can
// land a day off).
//
// This has to run as a single batch over every game, not per playgroup.gg
// game in isolation: the same pod commonly plays more than one real game
// in a sitting, so two distinct playgroup.gg games can share the exact
// same player set and land within the date tolerance of each other. Each
// logged game number can only satisfy one playgroup.gg game -- once
// claimed here it's removed from the pool -- otherwise a second, still-
// unlogged game with the same four players as an already-logged one reads
// as "already logged" too and silently never shows up as missing. Games
// are matched in chronological order and each picks the closest-dated
// still-unclaimed candidate, so pairing lines up with playgroup.gg's own
// game order rather than whichever candidate happens to be found first.
//
// Returns a Map from playgroup_game_id to the matched Game Log gameNum,
// for games that already have a match.
function computeLoggedMatches(pgGames) {
  const byGameNum = {};
  for (const row of gameLogSeason3Rows) {
    (byGameNum[row.gameNum] ||= []).push(row);
  }
  const loggedGames = Object.entries(byGameNum).map(([gameNum, rows]) => ({
    gameNum,
    players: new Set(rows.map(r => r.player)),
    commandersByPlayer: new Map(rows.map(r => [r.player, normalizeCommanderName(r.commander)])),
    date: rows[0].date instanceof Date ? rows[0].date : null,
    playgroupGameId: rows[0].playgroupGameId ? String(rows[0].playgroupGameId) : null,
    claimed: false,
  }));

  const matches = new Map();

  // A row already stamped with the real playgroup.gg game ID needs no
  // inference at all -- exact id equality, no heuristics, no ambiguity.
  // Handled first and removed from the pool so the heuristic loop below
  // only ever sees games that still need it (a manually-entered game, or
  // one predating playgroup.gg integration).
  const remainingPgGames = [];
  for (const pgGame of pgGames) {
    const idStr = String(pgGame.playgroup_game_id);
    const logged = loggedGames.find(lg => !lg.claimed && lg.playgroupGameId === idStr);
    if (logged) {
      logged.claimed = true;
      matches.set(pgGame.playgroup_game_id, logged.gameNum);
    } else {
      remainingPgGames.push(pgGame);
    }
  }

  const sortedPgGames = [...remainingPgGames].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const pgGame of sortedPgGames) {
    const pgPlayers = new Set(pgGame.participants.map(p => p.player));
    const pgDate = new Date(pgGame.date);

    // best: { logged, diffDays, commanderMatch }. diffDays is Infinity for
    // a date-less logged row, used only as a last resort.
    let best = null;
    for (const logged of loggedGames) {
      if (logged.claimed) continue;
      // Subset, not exact-size match: a logged game can include a player
      // with no mapped playgroup.gg account (e.g. Kristy), so playgroup.gg's
      // tracked participant set can legitimately be smaller than what's
      // logged for the same real game.
      if (![...pgPlayers].every(p => logged.players.has(p))) continue;

      let diffDays = Infinity;
      if (logged.date) {
        diffDays = Math.abs((logged.date - pgDate) / 86400000);
        if (diffDays > 1.5) continue;
      }
      // Whether every participant's commander lines up with what's logged
      // for that player -- decisive when the same pod plays several games
      // in a row under one batch-logged date, where date proximity alone
      // can't tell those games apart. Confirmed the hard way: four
      // Ryan/Manny/Mateo games logged 07-24/07-25 all fell within date
      // tolerance of three same-day playgroup.gg games, so the closest-date
      // tiebreak alone cascaded a wrong claim down the whole list and left
      // the real match for one of them with no candidate left at all.
      const commanderMatch = [...pgGame.participants].every(
        p => logged.commandersByPlayer.get(p.player) === normalizeCommanderName(p.commander)
      );
      if (
        best === null ||
        (commanderMatch && !best.commanderMatch) ||
        (commanderMatch === best.commanderMatch && diffDays < best.diffDays)
      ) {
        best = { logged, diffDays, commanderMatch };
      }
    }
    if (best) {
      best.logged.claimed = true;
      matches.set(pgGame.playgroup_game_id, best.logged.gameNum);
    }
  }
  return matches;
}

// playgroup.gg sometimes spells a commander with real diacritics (Eowyn ->
// Éowyn, Kennerud -> Kennerüd) that this app's own plain-ASCII deck names
// never have -- confirmed the hard way when Ryan's "Arna Kennerüd,
// Skycaptain" from a live game submission didn't exactly match his deck's
// stored "Arna Kennerud, Skycaptain", silently misattributing the game.
// Mirrors stripAccentsForMatch in cloudflare-worker/relay.js (the
// server-side deck-matching port -- see its own comment for why it's a
// separate copy, deliberately stricter, not just trusted from the client).
function stripAccents(s) {
  return (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// Shared by findDefaultStrength below and computeRosterDiff -- a deck name
// or commander name reduced to its first segment, case-insensitive and
// accent-folded, so small naming variations ("Ms. Bumbleflower" vs
// "Ms. Bumbleflower, Deck", or a playgroup.gg diacritic the spreadsheet
// doesn't have) still line up.
function normalizeCommanderName(s) {
  return stripAccents(s || "").toLowerCase().split(/[,/]/)[0].trim();
}

function findDefaultStrength(playerName, commanderName) {
  const player = players.find(p => p.name === playerName);
  if (!player) return null;
  const target = normalizeCommanderName(commanderName);
  let deck = player.decks.find(d => normalizeCommanderName(d.name) === target);
  if (!deck) {
    deck = player.decks.find(d =>
      normalizeCommanderName(d.name).startsWith(target) || target.startsWith(normalizeCommanderName(d.name))
    );
  }
  return deck ? deck.power : null;
}

// Bracket default: the most recent Game Log entry for this same
// player+commander, on the idea that a deck's bracket doesn't usually
// change game to game. Still editable in the form.
function findDefaultBracket(playerName, commanderName) {
  // A still-pending manual bracket declaration (the ✎ editor in Players &
  // Decks) wins over game history -- the whole point of setting one ahead
  // of a game is so the very next submission defaults to it, instead of
  // silently re-defaulting to the deck's old bracket and needing a manual
  // correction every time (which defeats the point of setting it early).
  // Once a game actually gets logged at that bracket it's no longer
  // "pending" (see bracketPending in applyPlayersFromD1) and this falls
  // through to the game-history lookup below like normal.
  const player = players.find(p => p.name === playerName);
  if (player) {
    const target = normalizeCommanderName(commanderName);
    let deck = player.decks.find(d => normalizeCommanderName(d.name) === target);
    if (!deck) {
      deck = player.decks.find(d =>
        normalizeCommanderName(d.name).startsWith(target) || target.startsWith(normalizeCommanderName(d.name))
      );
    }
    if (deck && deck.bracketPending) return deck.bracket;
  }

  const matches = gameLogSeason3Rows.filter(
    r => r.player === playerName && r.commander === commanderName && typeof r.bracket === "number"
  );
  if (matches.length === 0) return "";
  matches.sort((a, b) => (b.date instanceof Date ? b.date : 0) - (a.date instanceof Date ? a.date : 0));
  return matches[0].bracket;
}

// Whether openGameForm should even show the early-combo checkbox for this
// participant -- most decks never would be (see decks.potential_bracket_4
// in schema.sql). Same player+commander deck-matching as findDefaultBracket.
function findDeckPotentialBracket4(playerName, commanderName) {
  const player = players.find(p => p.name === playerName);
  if (!player) return false;
  const target = normalizeCommanderName(commanderName);
  let deck = player.decks.find(d => normalizeCommanderName(d.name) === target);
  if (!deck) {
    deck = player.decks.find(d =>
      normalizeCommanderName(d.name).startsWith(target) || target.startsWith(normalizeCommanderName(d.name))
    );
  }
  return !!(deck && deck.potentialBracket4);
}

// Mirrors updateRosterUpdateTabBadge's "Update the App" badge -- a count of
// games missing from the Game Log on the "Games to Update" tab button
// itself, hidden entirely at 0 so absence means "nothing to log," not "not
// loaded yet."
function updateGamesToUpdateTabBadge(count) {
  tonightCounts.gamesToLog = count;
  setTabBadge("tonight-tab-badge", tonightCounts.gamesToLog + tonightCounts.newDecks);
  renderTonight();
}

function renderGamesToUpdate() {
  const statusEl = document.getElementById("gtu-status");
  const listEl = document.getElementById("gtu-game-list");
  if (!playgroupGamesData || !statusEl || !listEl) return;
  if (gameLogSeason3Rows.length === 0) {
    // "the Game Log" -- not "deck-strength.xlsx", which this stopped
    // reading from back when the D1 migration landed; the string just
    // never got updated to match.
    statusEl.textContent = "Still syncing the Game Log…";
    updateGamesToUpdateTabBadge(0);
    return;
  }

  const loggedMatches = computeLoggedMatches(playgroupGamesData.games);
  const missing = playgroupGamesData.games.filter(g => !loggedMatches.has(g.playgroup_game_id));
  const liveAsOf = playgroupGamesData.generated_at ? new Date(playgroupGamesData.generated_at).toLocaleTimeString() : null;
  statusEl.textContent = `${liveAsOf ? `Live as of ${liveAsOf} — ` : ""}${missing.length} of ${playgroupGamesData.games.length} ${playgroupGamesData.league || ""} games aren't in the Game Log yet.`;
  updateGamesToUpdateTabBadge(missing.length);

  listEl.innerHTML = "";
  if (missing.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Nothing missing — every game's already on the books.";
    listEl.appendChild(p);
    return;
  }

  for (const g of missing) {
    const card = document.createElement("div");
    card.className = "gtu-game-card";

    // Built via createElement/textContent, not innerHTML -- player and
    // commander names come from playgroup.gg (ultimately editable by any
    // playgroup member), so interpolating them into a template-literal
    // innerHTML string would let one break out of markup. The date strong
    // tag is the only actual markup here, so it's the only thing built as
    // a real element; everything else is plain text nodes.
    const header = document.createElement("div");
    header.className = "gtu-game-summary";
    const dateStrong = document.createElement("strong");
    dateStrong.textContent = g.date;
    header.appendChild(dateStrong);
    const summary = g.participants.map(p => `${p.player} (${p.commander}${p.result === "win" ? " — won" : ""})`).join(", ");
    header.appendChild(document.createTextNode(` — ${summary}`));

    const fillBtn = document.createElement("button");
    fillBtn.textContent = "Fill in";
    fillBtn.addEventListener("click", () => openGameForm(g));

    card.appendChild(header);
    card.appendChild(fillBtn);
    if (g.note) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = g.note;
      card.appendChild(note);
    }
    listEl.appendChild(card);
  }
}

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

// Replicates the Player Adjusted Ranks tab's aggregate formulas exactly
// (verified against the sheet's own values earlier). newRow is optional —
// omit it to just report the player's current rate.
function computePlayerAdjustedWinRate(existingRows, newRow) {
  const all = newRow ? [...existingRows, newRow] : existingRows;
  const wins = all.filter(g => g.result === 1);
  const losses = all.filter(g => g.result === 0);
  const C = wins.length, D = losses.length;
  const F = wins.reduce((s, g) => s + g.J, 0);
  const avgJLosses = D ? losses.reduce((s, g) => s + g.J, 0) / D : 0;
  const G = (1 - (avgJLosses * -1)) * D;
  const H = (F + G) ? F / (F + G) : 0;
  // Guarded on win count (C), not on whether any games exist at all --
  // matches the sheet's =IF(C8<>0, AVERAGEIF(...), 0) exactly. A player
  // with zero wins gets I=0 regardless of their actual knockout average.
  const I = C ? all.reduce((s, g) => s + g.K, 0) / all.length : 0;
  const avgMWins = C ? wins.reduce((s, g) => s + g.M, 0) / C : 0;
  const Jagg = (1 - (avgMWins - 0.5)) * C;
  const avgMLosses = D ? losses.reduce((s, g) => s + g.M, 0) / D : 0;
  const Kagg = (1 + (avgMLosses - 0.5)) * D;
  const L = (Jagg + Kagg) ? Jagg / (Jagg + Kagg) : 0;
  const B = H * 0.3 + I * 0.2 + L * 0.5;
  return { B, wins: C, losses: D };
}

// Derives Place/KOs/TOV for every participant from playgroup.gg's raw
// per-game event log (kill-kind events specifically) -- verified against
// real already-logged games, not just the API docs: KOs is just a
// kill-event count per killer; Place ranks the winner first, then
// everyone else by elimination order (eliminated later = better place);
// TOV is the turn a player was eliminated, or the last turn seen in the
// event log for anyone never eliminated (the winner). Matches
// participants by deck_name, which both /debug/game's raw participations
// and /playgroup-games' transformed participants carry, and which is
// unique within a single game.
function deriveGameFieldsFromRawGame(rawGame) {
  // Sorted by happened_at rather than trusted to already be in order --
  // this is what makes same-turn tie-breaking below actually correct
  // instead of just usually-correct.
  const killEvents = (rawGame.events || [])
    .filter(e => e.kind === "kill")
    .sort((a, b) => new Date(a.happened_at) - new Date(b.happened_at));
  const deckNameByUserId = {};
  for (const p of rawGame.participations) deckNameByUserId[p.user_id] = p.deck_name;

  const kosByDeckName = {};
  for (const e of killEvents) {
    const deckName = deckNameByUserId[e.user_id];
    if (deckName) kosByDeckName[deckName] = (kosByDeckName[deckName] || 0) + 1;
  }

  // turn alone isn't fine-grained enough to order two eliminations that
  // happen in the same turn -- confirmed the hard way against a real game
  // where Ryan eliminated Manny, then Mateo eliminated Ryan, both turn 8:
  // sorting on turn alone ties them and falls back to array order, which
  // doesn't necessarily match what actually happened. seq (this event's
  // position among kill events in chronological order) breaks that tie
  // correctly: whoever was eliminated later, even within the same turn,
  // placed better.
  const eliminationByUserId = {};
  killEvents.forEach((e, seq) => {
    eliminationByUserId[e.receiver_user_id] = { turn: e.turn, seq };
  });

  // total_rounds has been seen to under-report the actual last turn
  // played (a real game's winner_declared/end_game events landed on turn
  // 9 while playgroup.gg's own total_rounds said 8) -- the highest turn
  // number actually seen in the event log is the more trustworthy source
  // for "what turn did the game end on."
  const maxTurn = Math.max(0, ...(rawGame.events || []).map(e => e.turn));

  const ranked = [...rawGame.participations].sort((a, b) => {
    if (a.winner !== b.winner) return a.winner ? -1 : 1;
    const aElim = eliminationByUserId[a.user_id];
    const bElim = eliminationByUserId[b.user_id];
    const aTurn = aElim ? aElim.turn : -1;
    const bTurn = bElim ? bElim.turn : -1;
    if (aTurn !== bTurn) return bTurn - aTurn;
    const aSeq = aElim ? aElim.seq : -1;
    const bSeq = bElim ? bElim.seq : -1;
    return bSeq - aSeq;
  });

  const byDeckName = {};
  ranked.forEach((p, i) => {
    const elim = eliminationByUserId[p.user_id];
    const tov = p.winner ? maxTurn : (elim ? elim.turn : null);
    byDeckName[p.deck_name] = {
      place: i + 1,
      kos: kosByDeckName[p.deck_name] || 0,
      tov: tov != null ? tov : null,
    };
  });
  return byDeckName;
}

// One <input class="gtu-in gtu-${suffix}" data-i="${i}"> per Games to
// Update input cell -- readInputs (in calculateGameToUpdate) and the
// playgroup.gg pre-fill below both look these up later by exactly that
// class+data-i combination, so the two need to stay in lockstep.
function makeGtuInput(type, suffix, i, attrs) {
  const el = document.createElement("input");
  el.type = type;
  el.className = `gtu-in ${suffix}`;
  el.dataset.i = i;
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value !== undefined && value !== null) el[key] = value;
  }
  return el;
}

// Flags a field as holding a guess rather than something typed in --
// Cmdr Strength/Bracket from this player's own deck history, Place from a
// simple win/loss heuristic, and (once the async playgroup.gg pre-fill in
// openGameForm lands) Place/KOs/TOV again from real event-log data. Every
// one of these fields was always fully editable; the only thing missing
// was a way to tell "the app guessed this" from "I typed this" once both
// look identical as a plain filled-in number. Idempotent and safe to call
// more than once on the same input -- the playgroup.gg pre-fill can mark
// a field already marked at creation (e.g. Place for a winner).
function markGtuPrefilled(input) {
  if (input.classList.contains("gtu-in-prefilled")) return;
  input.classList.add("gtu-in-prefilled");
  input.addEventListener("input", () => input.classList.remove("gtu-in-prefilled"), { once: true });
}

// One participant's card in the Games to Update form -- replaces a row in
// what used to be a 13-column input table (Player/Commander/Result plus 10
// input cells), which needed its own horizontal scroll to even fit on a
// phone. Every input is still built by the same makeGtuInput helper with
// the exact same class+data-i naming, so readInputs (calculateGameToUpdate)
// and the playgroup.gg pre-fill below both keep finding them the same way
// via querySelector -- only the surrounding markup changed, not how any
// value gets read out or filled in.
function buildGtuParticipantCard(p, i, pgGame) {
  const defaultStrength = findDefaultStrength(p.player, p.commander);
  const defaultPlace = p.result === "win" ? 1 : "";
  const defaultBracket = findDefaultBracket(p.player, p.commander);
  // Only decks flagged potential_bracket_4 even get asked -- everyone else
  // just gets no checkbox at all, not one that's always unchecked.
  const comboEligible = findDeckPotentialBracket4(p.player, p.commander);

  const card = document.createElement("div");
  card.className = "gtu-card";

  const header = document.createElement("div");
  header.className = "gtu-card-header";
  const nameEl = document.createElement("span");
  nameEl.className = "gtu-card-name";
  nameEl.textContent = p.player;
  const deckEl = document.createElement("span");
  deckEl.className = "gtu-card-deck";
  deckEl.textContent = p.commander;
  const resultEl = document.createElement("span");
  resultEl.className = "gtu-card-result" + (p.result === "win" ? " win" : "");
  resultEl.textContent = p.result === "win" ? "Win ✓" : "Loss";
  header.append(nameEl, deckEl, resultEl);
  card.appendChild(header);

  const field = (labelText, inputEl) => {
    const wrap = document.createElement("label");
    wrap.className = "gtu-field";
    const lbl = document.createElement("span");
    lbl.className = "gtu-field-label";
    lbl.textContent = labelText;
    wrap.append(lbl, inputEl);
    return wrap;
  };

  const strengthInput = makeGtuInput("number", "gtu-strength", i, { step: "0.1", min: "0", max: "5", value: defaultStrength ?? "" });
  if (defaultStrength !== null) markGtuPrefilled(strengthInput);

  const placeInput = makeGtuInput("number", "gtu-place", i, { min: "1", max: pgGame.pod_size, value: defaultPlace });
  if (defaultPlace) markGtuPrefilled(placeInput);

  const bracketInput = makeGtuInput("number", "gtu-bracket", i, { min: "1", max: "5", value: defaultBracket });
  if (defaultBracket !== "") markGtuPrefilled(bracketInput);

  const fields = document.createElement("div");
  fields.className = "gtu-card-fields";
  fields.append(
    field("Cmdr Strength", strengthInput),
    field("Place", placeInput),
    field("KOs", makeGtuInput("number", "gtu-knockouts", i, { min: "0", value: 0 })),
    field("TOV", makeGtuInput("number", "gtu-tov", i, { min: "1", value: "" })),
    field("Disruptions", makeGtuInput("number", "gtu-disruptions", i, { min: "0", value: 0 })),
    field("Recoveries", makeGtuInput("number", "gtu-recoveries", i, { min: "0", value: 0 })),
    field("Bracket", bracketInput),
  );
  card.appendChild(fields);

  const checkField = (labelText, inputEl) => {
    const wrap = document.createElement("label");
    wrap.className = "gtu-check-field";
    wrap.append(inputEl, document.createTextNode(labelText));
    return wrap;
  };
  const checks = document.createElement("div");
  checks.className = "gtu-card-checks";
  checks.append(
    checkField("Pop-Off", makeGtuInput("checkbox", "gtu-popoff", i)),
    checkField("Behind", makeGtuInput("checkbox", "gtu-behind", i)),
  );
  if (comboEligible) {
    checks.appendChild(checkField("Early combo?", makeGtuInput("checkbox", "gtu-combo", i)));
  }
  card.appendChild(checks);

  return card;
}

function openGameForm(pgGame) {
  const areaEl = document.getElementById("gtu-form-area");
  areaEl.innerHTML = "";

  const box = document.createElement("div");
  box.className = "gtu-form";

  const title = document.createElement("h3");
  title.textContent = `${pgGame.date} — ${pgGame.participants.map(p => p.player).join(", ")}`;
  box.appendChild(title);

  const derivedHint = document.createElement("p");
  derivedHint.className = "hint";
  if (pgGame.playgroup_game_id && RELAY_BASE_URL) {
    derivedHint.textContent = "Loading Place/KOs/TOV from playgroup.gg…";
    box.appendChild(derivedHint);
  }

  const cardList = document.createElement("div");
  cardList.className = "gtu-card-list";
  pgGame.participants.forEach((p, i) => cardList.appendChild(buildGtuParticipantCard(p, i, pgGame)));
  box.appendChild(cardList);

  // Fills in Place/KOs/TOV from playgroup.gg's raw per-game event log --
  // still fully editable, same as the Cmdr Strength/Bracket prefills
  // above. Fetched separately (not part of the regular /playgroup-games
  // response) since it needs the full event history for just this one
  // game, which is too expensive to pull for every pending game up front.
  if (pgGame.playgroup_game_id && RELAY_BASE_URL) {
    fetch(`${RELAY_BASE_URL}/debug/game?id=${pgGame.playgroup_game_id}&events=true`, { cache: "no-store", headers: authHeaders() })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(rawGame => {
        const derived = deriveGameFieldsFromRawGame(rawGame);
        pgGame.participants.forEach((p, i) => {
          const fields = derived[p.deck_name];
          if (!fields) return;
          const placeInput = cardList.querySelector(`.gtu-place[data-i="${i}"]`);
          const kosInput = cardList.querySelector(`.gtu-knockouts[data-i="${i}"]`);
          const tovInput = cardList.querySelector(`.gtu-tov[data-i="${i}"]`);
          if (placeInput) { placeInput.value = fields.place; markGtuPrefilled(placeInput); }
          if (kosInput) { kosInput.value = fields.kos; markGtuPrefilled(kosInput); }
          if (tovInput && fields.tov != null) { tovInput.value = fields.tov; markGtuPrefilled(tovInput); }
        });
        derivedHint.textContent = "Place/KOs/TOV pre-filled from playgroup.gg's game log — double check before submitting.";
      })
      .catch(err => {
        derivedHint.textContent = `Couldn't load Place/KOs/TOV from playgroup.gg (${err.message}) — fill in manually.`;
      });
  }

  const calcBtn = document.createElement("button");
  calcBtn.className = "primary";
  calcBtn.textContent = "Calculate";
  const resultsEl = document.createElement("div");
  resultsEl.className = "gtu-results";

  const runCalculation = () => calculateGameToUpdate(pgGame, box, resultsEl);
  calcBtn.addEventListener("click", runCalculation);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("gtu-in")) {
      e.preventDefault();
      runCalculation();
    }
  });

  box.appendChild(calcBtn);
  box.appendChild(resultsEl);
  areaEl.appendChild(box);
  areaEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function calculateGameToUpdate(pgGame, box, resultsEl) {
  const podSize = pgGame.pod_size;
  const readInputs = (i) => ({
    strength: parseFloat(box.querySelector(`.gtu-strength[data-i="${i}"]`).value),
    place: parseInt(box.querySelector(`.gtu-place[data-i="${i}"]`).value, 10),
    knockouts: parseInt(box.querySelector(`.gtu-knockouts[data-i="${i}"]`).value, 10) || 0,
    tov: parseInt(box.querySelector(`.gtu-tov[data-i="${i}"]`).value, 10),
    popOff: box.querySelector(`.gtu-popoff[data-i="${i}"]`).checked ? 1 : 0,
    disruptions: parseInt(box.querySelector(`.gtu-disruptions[data-i="${i}"]`).value, 10) || 0,
    recoveries: parseInt(box.querySelector(`.gtu-recoveries[data-i="${i}"]`).value, 10) || 0,
    behind: box.querySelector(`.gtu-behind[data-i="${i}"]`).checked ? 1 : 0,
    bracket: parseInt(box.querySelector(`.gtu-bracket[data-i="${i}"]`).value, 10),
    // No checkbox exists at all for a deck that isn't potentialBracket4 --
    // querySelector returns null, optional-chained to 0 (never asked, not
    // a real "no"). See findDeckPotentialBracket4 in openGameForm.
    earlyTwoCardCombo: box.querySelector(`.gtu-combo[data-i="${i}"]`)?.checked ? 1 : 0,
  });

  // stripAccents here (not just in normalizeCommanderName) matters: this
  // is the text that actually gets written to the Game Log, and it needs
  // to exactly match Current Deck Strength's plain-ASCII deck name for
  // the LOOKUP formula there to find it -- see stripAccents' own comment.
  const inputs = pgGame.participants.map((p, i) => ({ ...p, commander: stripAccents(p.commander), ...readInputs(i) }));
  const missingField = inputs.find(inp =>
    Number.isNaN(inp.strength) || Number.isNaN(inp.place) || Number.isNaN(inp.tov) || Number.isNaN(inp.bracket)
  );
  if (missingField) {
    resultsEl.innerHTML = "";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = `Fill in Commander Strength, Place, TOV, and Bracket for every player first (missing for ${missingField.player}).`;
    resultsEl.appendChild(p);
    return;
  }

  const strengths = inputs.map(inp => inp.strength);
  const rows = inputs.map((inp, i) => {
    const otherStrengths = strengths.filter((_, j) => j !== i);
    const formulas = computeGameRowFormulas({
      commanderStrength: inp.strength,
      otherStrengths,
      result: inp.result === "win" ? 1 : 0,
      podSize,
      knockouts: inp.knockouts,
      place: inp.place,
      tov: inp.tov,
      popOff: inp.popOff,
      disruptions: inp.disruptions,
      recoveries: inp.recoveries,
      gamesClearlyBehind: inp.behind,
      bracket: inp.bracket,
    });
    return { ...inp, ...formulas };
  });

  resultsEl.innerHTML = "";

  const tableRows = rows.map(row => {
    const existing = gameLogSeason3Rows.filter(r => r.player === row.player && typeof r.J === "number");
    const before = computePlayerAdjustedWinRate(existing);
    const after = computePlayerAdjustedWinRate(existing, { result: row.result === "win" ? 1 : 0, J: row.J, K: row.K, M: row.M });
    const delta = after.B - before.B;
    const deltaStr = `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}pt`;

    return [
      row.player,
      row.commander,
      row.result === "win" ? "Win" : "Loss",
      `${(before.B * 100).toFixed(2)}% (${before.wins}-${before.losses})`,
      `${(after.B * 100).toFixed(2)}% (${after.wins}-${after.losses}) — ${deltaStr}`,
    ];
  });

  const { table } = buildTable(
    "gtu-results-table",
    ["Player", "Commander", "Result", "Current PAWR", "PAWR w/ this game"],
    tableRows
  );
  resultsEl.appendChild(table);

  const submitBtn = document.createElement("button");
  submitBtn.className = "primary gtu-submit-btn";
  const statusEl = document.createElement("span");
  statusEl.className = "gtu-submit-status";

  if (!GAME_SUBMIT_RELAY_URL) {
    submitBtn.textContent = "Submit Game (not configured)";
    submitBtn.disabled = true;
  } else {
    submitBtn.textContent = "Submit Game";
    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting...";
      statusEl.textContent = "";
      const payload = {
        date: pgGame.date,
        podSize,
        playgroupGameId: pgGame.playgroup_game_id,
        participants: rows.map(row => ({
          player: row.player,
          commander: row.commander,
          strength: row.strength,
          result: row.result,
          place: row.place,
          knockouts: row.knockouts,
          tov: row.tov,
          popOff: row.popOff,
          disruptions: row.disruptions,
          recoveries: row.recoveries,
          gamesClearlyBehind: row.behind,
          bracket: row.bracket,
          earlyTwoCardCombo: row.earlyTwoCardCombo,
        })),
      };
      try {
        const res = await fetch(GAME_SUBMIT_RELAY_URL, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        submitBtn.textContent = "Submitted ✓";
        // D1 writes land in ~100-300ms (vs. the old GitHub Actions round
        // trip's 1-3 minutes), so this waits for a real refetch instead of
        // optimistically merging a guessed local copy -- the whole reason
        // that complexity existed before was papering over that slow wait.
        statusEl.textContent = "Refreshing…";
        await refreshEverything();
        statusEl.textContent = "Added — Games to Update, Player Win Rates, and Deck Strength Validator's deck power are all up to date.";
        // The submitted game is already gone from the missing-games list
        // above (refreshEverything just re-rendered it), but this filled-in
        // form otherwise just sits here forever -- confirmed the hard way,
        // it was still showing a "submitted" game's form as if still
        // pending after switching tabs and back. Leaves the confirmation
        // message up briefly so it's actually seen, then clears the form
        // area so the tab returns to a clean state.
        setTimeout(() => {
          const areaEl = box.parentElement;
          if (areaEl) areaEl.innerHTML = "";
        }, 1500);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit Game";
        statusEl.textContent = `Submission failed: ${err.message}`;
      }
    });
  }

  resultsEl.appendChild(submitBtn);
  resultsEl.appendChild(statusEl);
}

// ---------- update the app (new playgroup members / decks) ----------

// Persists user edits across every re-render of the Update the App tab --
// renderUpdateAppTab() runs on every poll (a fresh /roster-diff fetch, an
// optimistic re-render after a game/roster submission elsewhere) and used
// to rebuild every row from scratch each time, silently reverting whatever
// the user had already unchecked or typed. Keyed by playgroup deck ID
// (globally unique across the whole roster, not just per player) for deck
// rows, by playgroup.gg username for a new player's display name. These
// are the actual source of truth for what gets submitted -- rendering just
// reflects them, it never invents the checked/power values on its own.
const rosterUpdateDeckState = new Map(); // deckId (string) -> { checked, bracket }
const rosterUpdateNameState = new Map(); // username -> displayName
let rosterUpdateSelectedGroupKey = null; // which player's group the dropdown is showing, preserved across renders too
let rosterUpdateSubmitConfirmation = null; // message to show once, right after a successful submit -- see renderRosterUpdateConfirmationBanner

// Deliberately defaults to UNCHECKED. A deck often already has a valid
// power_level from playgroup.gg pre-filled the moment it's detected, so a
// checked-by-default box needs zero user action to become submit-ready --
// and with only one group visible at a time (the dropdown), a user
// reviewing one player's pending decks has no visual sign that every other
// pending group is also sitting there fully checked. That combination is
// exactly how a "select Becca's one deck" submission ended up including
// everyone else's pending decks too. Select All exists for the case where
// someone genuinely wants to submit everything at once -- that should be
// an explicit action, never an accident of what happened to be true by
// default in a group nobody looked at.
function ensureRosterUpdateDeckStateDefault(deck) {
  const key = String(deck.id);
  if (!rosterUpdateDeckState.has(key)) {
    // Left blank ("Select bracket…") rather than pre-filled from
    // playgroup.gg's rating -- the deck's actual baseline is the bracket
    // itself once picked (e.g. Bracket 3 -> baseline_power 3.0), so this
    // is a deliberate choice, not a suggestion, and shouldn't default to
    // one; see the submit handler in renderRosterUpdateSubmit.
    rosterUpdateDeckState.set(key, { checked: false, bracket: "", potentialBracket4: false });
  }
}

function ensureRosterUpdateNameStateDefault(newPlayer) {
  if (!rosterUpdateNameState.has(newPlayer.username)) {
    rosterUpdateNameState.set(newPlayer.username, newPlayer.suggestedDisplayName);
  }
}

// True while the user has focus somewhere inside the Update the App tab --
// used to skip a background re-render mid-edit so a periodic refresh never
// yanks focus out from under someone who's mid-keystroke. The state maps
// above mean no value would actually be lost either way, but rebuilding the
// DOM under an active cursor still feels broken, so this avoids it outright.
function isEditingRosterUpdateForm() {
  const panel = document.getElementById("tab-update-app");
  return !!(panel && document.activeElement && panel.contains(document.activeElement));
}

async function loadRosterDiff() {
  const statusEl = document.getElementById("uta-status");
  if (!ROSTER_DIFF_RELAY_URL) {
    if (statusEl) statusEl.textContent = "Live playgroup.gg data not configured.";
    document.getElementById("uta-list").innerHTML = "";
    return;
  }
  try {
    const res = await fetch(ROSTER_DIFF_RELAY_URL, { cache: "no-store", headers: authHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    }
    rosterDiffData = await res.json();
    renderPlayersTable();
    if (!isEditingRosterUpdateForm()) renderUpdateAppTab();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Couldn't load live playgroup.gg data (${err.message}).`;
    document.getElementById("uta-list").innerHTML = "";
  }
}

// Compares the Worker's raw playgroup.gg roster/decks against what's
// already in D1 (the `players` array -- same data source Deck Strength
// Validator and Player Win Rates already use). Matches by playgroup deck
// ID first; for a deck with no ID on file (added without one), falls back
// to the same name normalization findDefaultStrength uses, so a missing
// ID is never a hard requirement for correctness.
// Usernames submitted as a brand-new player this session. computeRosterDiff
// below has no way to know a submitted new player isn't "new" anymore
// other than this: member.tracked (and mapped_player) come straight from
// rosterDiffData, which is read fresh from D1 on every request (see
// relay.js's getUserIdToPlayerMap) -- correct almost immediately after
// POST /roster's write completes, but "almost immediately" still leaves
// a brief window, between that write finishing and refreshEverything's
// own subsequent GET /roster-diff landing, where a stale response could
// otherwise flash the just-added player back to "pending." Any of their
// decks left unsubmitted stay hidden until a real refresh actually shows
// them as new -- an acceptable, seconds-long gap, not an unbounded one.
const rosterUpdateOptimisticallyTrackedUsernames = new Set();

function computeRosterDiff(data) {
  const newPlayers = [];
  const newDecksForExisting = [];

  for (const member of data.members) {
    if (rosterUpdateOptimisticallyTrackedUsernames.has(member.username)) continue;
    const allDecks = (data.decks_by_username[member.username] || []).filter(d => !d.archived);
    if (allDecks.length === 0) continue;

    if (!member.tracked) {
      newPlayers.push({ username: member.username, userId: member.user_id, suggestedDisplayName: member.username, decks: allDecks });
      continue;
    }

    const player = players.find(p => p.name === member.mapped_player);
    const existingDecks = player ? player.decks : [];
    const existingById = new Map(existingDecks.filter(d => d.playgroupId).map(d => [String(d.playgroupId), d]));
    const existingNames = new Set(existingDecks.map(d => normalizeCommanderName(d.name)));

    const newDecks = [];
    for (const deck of allDecks) {
      const trackedAtSameId = existingById.get(String(deck.id));
      if (trackedAtSameId) {
        // Same playgroup.gg deck id, but its commander no longer matches
        // what we have on file -- a commander swap for the same physical
        // deck. Not an edit to the old deck's own numbers (its baseline/
        // history stay attached to the old commander) -- surfaced as a
        // new deck needing its own bracket placement, same as any other.
        // See playgroup_deck_name's comment in schema.sql for the
        // Leonardo/Michelangelo case this mirrors.
        if (normalizeCommanderName(trackedAtSameId.name) !== normalizeCommanderName(deck.commander_name)) {
          newDecks.push({ ...deck, replacesCommanderName: trackedAtSameId.name });
        }
        continue;
      }
      if (!existingNames.has(normalizeCommanderName(deck.commander_name))) {
        newDecks.push(deck);
      }
    }
    if (newDecks.length > 0) {
      newDecksForExisting.push({ player: member.mapped_player, decks: newDecks });
    }
  }

  return { newPlayers, newDecksForExisting };
}

// A deck row's three cells for the buildTable-based uta-deck-table below --
// built as real elements (not an innerHTML template) since deck.name/
// deck.commander_name are playgroup.gg data a playgroup member ultimately
// controls, and the name cell can hold two text pieces (commander name +
// an optional muted "(actual deck name)" aside).
// One pending deck's card in Update the App -- same fields a table row used
// to hold (checkbox, name, bracket select, Bracket-4 flame), just laid out
// as a card instead. wireRosterUpdateGroupInputs below still wires all of
// these up by class name, same as before -- the one place that actually
// cared about the old <tr> structure (the bracket-select handler's
// closest("tr") lookup for its sibling flame button) is updated alongside
// this to look for .uta-deck-card instead.
function buildUtaDeckCard(deck) {
  const state = rosterUpdateDeckState.get(String(deck.id));

  const card = document.createElement("div");
  card.className = "uta-deck-card";

  const checkboxWrap = document.createElement("label");
  checkboxWrap.className = "uta-deck-card-select";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "uta-deck-check";
  checkbox.dataset.deckId = deck.id;
  checkbox.checked = !!state.checked;
  checkboxWrap.appendChild(checkbox);
  card.appendChild(checkboxWrap);

  const info = document.createElement("div");
  info.className = "uta-deck-card-info";
  const nameLine = document.createElement("div");
  nameLine.className = "uta-deck-card-name";
  // Same identity coin as every other deck in the app -- color_identity
  // is already on this raw playgroup.gg deck object (see relay.js's
  // handleRosterDiff), it just wasn't rendered here before.
  const coin = buildIdentityCoin(deck.color_identity);
  if (coin) nameLine.appendChild(coin);
  const nameText = document.createElement("span");
  nameText.className = "uta-deck-card-name-text";
  nameText.appendChild(document.createTextNode(deck.commander_name));
  if (deck.name !== deck.commander_name) {
    nameText.appendChild(document.createTextNode(" "));
    const aside = document.createElement("span");
    aside.className = "hint";
    aside.textContent = `(${deck.name})`;
    nameText.appendChild(aside);
  }
  nameLine.appendChild(nameText);
  info.appendChild(nameLine);

  // Same "Playgroup Power" hint buildDeckPlate already shows for existing
  // decks -- playgroup.gg's own tracked power_level was already on this
  // object too (see handleRosterDiff), just unused here before. Gives a
  // data-informed starting point before picking a bracket, instead of a
  // cold guess.
  const subParts = [];
  if (typeof deck.power_level === "number") {
    subParts.push(`Playgroup Power: ${formatPower(deck.power_level)}`);
  }
  if (deck.replacesCommanderName) {
    subParts.push(`Commander swap — was ${deck.replacesCommanderName}`);
  }
  if (subParts.length > 0) {
    const sub = document.createElement("div");
    sub.className = "uta-deck-card-sub";
    sub.textContent = subParts.join(" · ");
    info.appendChild(sub);
  }
  card.appendChild(info);

  const controls = document.createElement("div");
  controls.className = "uta-deck-card-controls";

  const bracketSelect = document.createElement("select");
  bracketSelect.className = "uta-deck-bracket";
  bracketSelect.dataset.deckId = deck.id;
  const blankOpt = document.createElement("option");
  blankOpt.value = "";
  blankOpt.textContent = "Select bracket…";
  bracketSelect.appendChild(blankOpt);
  for (let b = 1; b <= 5; b++) {
    const opt = document.createElement("option");
    opt.value = String(b);
    opt.textContent = `Bracket ${b}`;
    bracketSelect.appendChild(opt);
  }
  bracketSelect.value = state.bracket;
  controls.appendChild(bracketSelect);

  const b4Btn = document.createElement("button");
  b4Btn.type = "button";
  b4Btn.className = "deck-edit-btn uta-deck-b4" + (state.potentialBracket4 ? " deck-edit-btn-active" : "");
  b4Btn.innerHTML = uiIcon("flame");
  b4Btn.title = "Flag this deck as a potential Bracket 4 (early two-card combo) from its very first game";
  b4Btn.setAttribute("aria-label", `Flag ${deck.commander_name} as potential Bracket 4`);
  b4Btn.dataset.deckId = deck.id;
  // Only meaningful for a deck actually being placed at Bracket 3 -- the
  // flag exists to catch a Bracket-3 deck that's secretly playing like a
  // 4. Kept in sync as the bracket choice changes by the bracket select's
  // own change listener below, not re-derived here on every render.
  b4Btn.hidden = state.bracket !== "3";
  controls.appendChild(b4Btn);

  card.appendChild(controls);
  return card;
}

// Wires up live state-capture on a just-rendered group's inputs, so every
// keystroke/click is saved to rosterUpdateDeckState/rosterUpdateNameState
// immediately -- by the time any re-render (or the final submit) happens,
// the maps already hold whatever the user last set, whether or not that
// group is even the one currently visible in the dropdown.
function wireRosterUpdateGroupInputs(container) {
  container.querySelectorAll(".uta-deck-check").forEach(el => {
    el.addEventListener("change", () => {
      rosterUpdateDeckState.set(el.dataset.deckId, { ...rosterUpdateDeckState.get(el.dataset.deckId), checked: el.checked });
      refreshRosterUpdateSubmitSummary();
    });
  });
  container.querySelectorAll(".uta-deck-bracket").forEach(el => {
    el.addEventListener("change", () => {
      const deckId = el.dataset.deckId;
      let next = { ...rosterUpdateDeckState.get(deckId), bracket: el.value };
      const b4Btn = el.closest(".uta-deck-card")?.querySelector(".uta-deck-b4");
      if (b4Btn) {
        const eligible = el.value === "3";
        b4Btn.hidden = !eligible;
        // Switching away from Bracket 3 clears any flag already set --
        // the flag shouldn't survive attached to a bracket it no longer
        // applies to.
        if (!eligible && next.potentialBracket4) {
          next = { ...next, potentialBracket4: false };
          b4Btn.classList.remove("deck-edit-btn-active");
        }
      }
      rosterUpdateDeckState.set(deckId, next);
    });
  });
  // A plain local toggle, not a live write like togglePotentialBracket4 --
  // this deck doesn't exist yet, so there's nothing to write to until the
  // whole row is submitted. No confirm modal either; picking a bracket and
  // hitting submit is already the deliberate, reviewed action here.
  container.querySelectorAll(".uta-deck-b4").forEach(el => {
    el.addEventListener("click", () => {
      const current = rosterUpdateDeckState.get(el.dataset.deckId);
      const next = !current?.potentialBracket4;
      rosterUpdateDeckState.set(el.dataset.deckId, { ...current, potentialBracket4: next });
      el.classList.toggle("deck-edit-btn-active", next);
    });
  });
  const nameInput = container.querySelector(".uta-display-name");
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      rosterUpdateNameState.set(nameInput.dataset.username, nameInput.value);
    });
  }
}

function renderRosterUpdateGroup(group) {
  const box = document.createElement("div");
  box.className = "uta-group";

  const header = document.createElement("div");
  header.className = "uta-group-header";

  if (group.kind === "new") {
    // Built via createElement, not an innerHTML template with p.username
    // interpolated into a value="..." attribute -- a username containing a
    // `"` would otherwise break out of that attribute entirely, not just
    // read oddly as text.
    const p = group.data;
    const title = document.createElement("div");
    title.className = "uta-group-title";
    const badge = document.createElement("span");
    badge.className = "uta-new-badge";
    badge.textContent = "New player";
    title.appendChild(badge);
    const code = document.createElement("code");
    code.textContent = p.username;
    title.appendChild(code);
    header.appendChild(title);

    const label = document.createElement("label");
    label.className = "uta-group-name-field";
    label.appendChild(document.createTextNode("Display name"));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "uta-display-name";
    nameInput.dataset.username = p.username;
    nameInput.value = rosterUpdateNameState.get(p.username);
    label.appendChild(nameInput);
    header.appendChild(label);
    box.appendChild(header);

    const cardList = document.createElement("div");
    cardList.className = "uta-deck-card-list";
    p.decks.map(buildUtaDeckCard).forEach(c => cardList.appendChild(c));
    box.appendChild(cardList);
  } else {
    const g = group.data;
    const title = document.createElement("div");
    title.className = "uta-group-title";
    const name = document.createElement("span");
    name.className = "player-name-display";
    name.textContent = g.player;
    title.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "hint";
    meta.textContent = `${g.decks.length} new deck${g.decks.length === 1 ? "" : "s"}`;
    title.appendChild(meta);
    header.appendChild(title);
    box.appendChild(header);

    const cardList = document.createElement("div");
    cardList.className = "uta-deck-card-list";
    g.decks.map(buildUtaDeckCard).forEach(c => cardList.appendChild(c));
    box.appendChild(cardList);
  }

  wireRosterUpdateGroupInputs(box);
  return box;
}

// Checks/unchecks every deck for the ONE group currently shown in the
// dropdown -- deliberately not every pending group. It used to be global,
// but that meant clicking Select All to grab one new player's decks
// silently swept up every other pending player's decks too, invisible
// since only one group is ever on screen at a time. That's the exact
// mechanism that turned "select Becca's one deck" into "submit everyone's
// pending decks" earlier -- scoping this to the visible group avoids
// reintroducing it via the opposite button.
function setAllRosterUpdateChecked(group, checked) {
  group.data.decks.forEach(d => {
    rosterUpdateDeckState.set(String(d.id), { ...rosterUpdateDeckState.get(String(d.id)), checked });
  });
  renderUpdateAppTab();
}

// A count of pending decks (new players' decks + existing players' new
// decks) on the "Update the App" tab button itself, so there's something
// pending is visible without opening the tab or checking manually. Hidden
// entirely at 0 -- absence of a badge means "nothing to review," not "not
// loaded yet" (loadRosterDiff only calls renderUpdateAppTab, which is the
// only caller of this, once rosterDiffData has actually loaded).
function updateRosterUpdateTabBadge(newPlayers, newDecksForExisting) {
  const count = newPlayers.reduce((n, p) => n + p.decks.length, 0) +
    newDecksForExisting.reduce((n, g) => n + g.decks.length, 0);
  tonightCounts.newDecks = count;
  setTabBadge("tonight-tab-badge", tonightCounts.gamesToLog + tonightCounts.newDecks);
  renderTonight();
}

// Shows rosterUpdateSubmitConfirmation once, then clears it -- a normal
// re-render (the next poll, switching groups, Select All) must NOT keep
// showing a stale success message from a submit that happened renders ago.
function renderRosterUpdateConfirmationBanner(listEl) {
  if (!rosterUpdateSubmitConfirmation) return;
  const banner = document.createElement("p");
  banner.className = "banner good";
  banner.textContent = rosterUpdateSubmitConfirmation;
  listEl.appendChild(banner);
  rosterUpdateSubmitConfirmation = null;
}

function renderUpdateAppTab() {
  const statusEl = document.getElementById("uta-status");
  const listEl = document.getElementById("uta-list");
  const formAreaEl = document.getElementById("uta-form-area");
  if (!listEl) return;

  formAreaEl.innerHTML = "";
  if (!rosterDiffData) {
    listEl.innerHTML = "";
    return;
  }

  const { newPlayers, newDecksForExisting } = computeRosterDiff(rosterDiffData);
  updateRosterUpdateTabBadge(newPlayers, newDecksForExisting);
  statusEl.textContent = `Live as of ${new Date(rosterDiffData.generated_at).toLocaleTimeString()} — ${newPlayers.length} new player(s), ${newDecksForExisting.reduce((n, g) => n + g.decks.length, 0)} new deck(s) for existing players found on playgroup.gg.`;

  listEl.innerHTML = "";
  renderRosterUpdateConfirmationBanner(listEl);

  if (newPlayers.length === 0 && newDecksForExisting.length === 0) {
    const nothingNewEl = document.createElement("p");
    nothingNewEl.className = "hint";
    nothingNewEl.textContent = "Bench is fully synced. Nothing left to draft.";
    listEl.appendChild(nothingNewEl);
    rosterUpdateSelectedGroupKey = null;
    return;
  }

  newPlayers.forEach(p => {
    ensureRosterUpdateNameStateDefault(p);
    p.decks.forEach(ensureRosterUpdateDeckStateDefault);
  });
  newDecksForExisting.forEach(g => g.decks.forEach(ensureRosterUpdateDeckStateDefault));

  const groups = [
    ...newPlayers.map(p => ({ key: `new:${p.username}`, kind: "new", label: `New player: ${p.username} (${p.decks.length})`, data: p })),
    ...newDecksForExisting.map(g => ({ key: `existing:${g.player}`, kind: "existing", label: `${g.player} (${g.decks.length} new deck${g.decks.length === 1 ? "" : "s"})`, data: g })),
  ];

  // Keep whatever the dropdown was already showing if it's still pending;
  // only fall back to the first group if that one got submitted/vanished.
  if (!groups.some(g => g.key === rosterUpdateSelectedGroupKey)) {
    rosterUpdateSelectedGroupKey = groups[0].key;
  }
  const activeGroup = groups.find(g => g.key === rosterUpdateSelectedGroupKey);

  const controls = document.createElement("div");
  controls.className = "uta-controls";

  const selectWrap = document.createElement("label");
  selectWrap.className = "uta-group-select-label";
  selectWrap.textContent = "Show: ";
  const select = document.createElement("select");
  select.className = "uta-group-select";
  groups.forEach(g => {
    const opt = document.createElement("option");
    opt.value = g.key;
    opt.textContent = g.label;
    if (g.key === rosterUpdateSelectedGroupKey) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    rosterUpdateSelectedGroupKey = select.value;
    renderUpdateAppTab();
  });
  selectWrap.appendChild(select);
  controls.appendChild(selectWrap);

  const selectAllBtn = document.createElement("button");
  selectAllBtn.type = "button";
  selectAllBtn.textContent = "Select All";
  selectAllBtn.title = "Checks every deck for the player shown below -- not every pending player.";
  selectAllBtn.addEventListener("click", () => setAllRosterUpdateChecked(activeGroup, true));

  const deselectAllBtn = document.createElement("button");
  deselectAllBtn.type = "button";
  deselectAllBtn.textContent = "Deselect All";
  deselectAllBtn.title = "Unchecks every deck for the player shown below -- not every pending player.";
  deselectAllBtn.addEventListener("click", () => setAllRosterUpdateChecked(activeGroup, false));

  controls.appendChild(selectAllBtn);
  controls.appendChild(deselectAllBtn);
  listEl.appendChild(controls);

  listEl.appendChild(renderRosterUpdateGroup(activeGroup));

  renderRosterUpdateSubmit(formAreaEl, newPlayers, newDecksForExisting);
}

// A count of what's actually about to be submitted, across every pending
// group -- not just the one currently visible in the dropdown. Exists
// because the dropdown hides other groups' checkbox state from view, so
// without an explicit running total there's no way to notice a
// stray-checked deck from a group you never looked at before hitting
// submit. Kept live via the checkbox change listener in
// wireRosterUpdateGroupInputs, not just re-render.
function describeRosterUpdateSelection(newPlayers, newDecksForExisting) {
  let deckCount = 0;
  const playerLabels = new Set();
  newPlayers.forEach(p => {
    p.decks.forEach(d => {
      const s = rosterUpdateDeckState.get(String(d.id));
      if (s && s.checked) {
        deckCount++;
        playerLabels.add(`${p.username} (new)`);
      }
    });
  });
  newDecksForExisting.forEach(g => {
    g.decks.forEach(d => {
      const s = rosterUpdateDeckState.get(String(d.id));
      if (s && s.checked) {
        deckCount++;
        playerLabels.add(g.player);
      }
    });
  });
  if (deckCount === 0) return "Nothing selected yet — check the box next to each deck you want to add.";
  return `Ready to submit: ${deckCount} deck${deckCount === 1 ? "" : "s"} for ${[...playerLabels].join(", ")}.`;
}

function refreshRosterUpdateSubmitSummary() {
  const summaryEl = document.getElementById("uta-submit-summary");
  if (!summaryEl || !rosterDiffData) return;
  const { newPlayers, newDecksForExisting } = computeRosterDiff(rosterDiffData);
  summaryEl.textContent = describeRosterUpdateSelection(newPlayers, newDecksForExisting);
}

function renderRosterUpdateSubmit(formAreaEl, newPlayers, newDecksForExisting) {
  const summaryEl = document.createElement("p");
  summaryEl.id = "uta-submit-summary";
  summaryEl.className = "hint";
  summaryEl.textContent = describeRosterUpdateSelection(newPlayers, newDecksForExisting);
  formAreaEl.appendChild(summaryEl);

  const submitBtn = document.createElement("button");
  submitBtn.className = "primary uta-submit-btn";
  const statusEl = document.createElement("span");
  statusEl.className = "uta-submit-status";

  if (!ROSTER_UPDATE_RELAY_URL) {
    submitBtn.textContent = "Add Player/Decks (not configured)";
    submitBtn.disabled = true;
  } else {
    submitBtn.textContent = "Add Player/Decks";
    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting...";
      statusEl.textContent = "";

      // Reads from rosterUpdateDeckState/rosterUpdateNameState, not the DOM
      // -- the dropdown only renders one group at a time, so a checked deck
      // in a group that isn't currently visible would never be found by a
      // DOM query. The state maps are kept live via wireRosterUpdateGroupInputs
      // regardless of which group is on screen, so they're the only
      // complete source of "what's actually checked right now."
      const payload = { newPlayers: [], newDecksForExisting: [] };
      const submittedDeckIds = [];
      const submittedUsernames = [];

      newPlayers.forEach(p => {
        const displayName = (rosterUpdateNameState.get(p.username) || "").trim();
        const decks = [];
        p.decks.forEach(d => {
          const state = rosterUpdateDeckState.get(String(d.id));
          if (!state || !state.checked) return;
          // The bracket itself is the baseline (e.g. Bracket 3 -> 3.0) --
          // same reset-to-the-floor rule as everywhere else a deck's
          // bracket is set, applied here since a brand-new deck has no
          // game history to earn a fraction from yet. Sent as `power` to
          // match handleRosterWrite's existing baseline_power column --
          // no relay.js change needed, an integer is just as valid a
          // number there as the decimal it replaces.
          const bracket = parseInt(state.bracket, 10);
          if (!Number.isInteger(bracket) || bracket < 1 || bracket > 5) return;
          decks.push({ name: d.commander_name, power: bracket, playgroupDeckId: d.id, playgroupDeckName: d.name, potentialBracket4: !!state.potentialBracket4, colorIdentity: d.color_identity ?? null });
          submittedDeckIds.push(String(d.id));
        });
        if (displayName && decks.length > 0) {
          payload.newPlayers.push({ username: p.username, userId: p.userId, displayName, decks });
          submittedUsernames.push(p.username);
        }
      });

      newDecksForExisting.forEach(g => {
        g.decks.forEach(d => {
          const state = rosterUpdateDeckState.get(String(d.id));
          if (!state || !state.checked) return;
          const bracket = parseInt(state.bracket, 10);
          if (!Number.isInteger(bracket) || bracket < 1 || bracket > 5) return;
          payload.newDecksForExisting.push({ player: g.player, name: d.commander_name, power: bracket, playgroupDeckId: d.id, playgroupDeckName: d.name, potentialBracket4: !!state.potentialBracket4, colorIdentity: d.color_identity ?? null });
          submittedDeckIds.push(String(d.id));
        });
      });

      if (payload.newPlayers.length === 0 && payload.newDecksForExisting.length === 0) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Add Player/Decks";
        statusEl.textContent = "Nothing selected (or missing a bracket) — check the boxes and pick a bracket above.";
        return;
      }

      try {
        const res = await fetch(ROSTER_UPDATE_RELAY_URL, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

        submittedDeckIds.forEach(id => rosterUpdateDeckState.delete(id));
        submittedUsernames.forEach(u => {
          rosterUpdateNameState.delete(u);
          rosterUpdateOptimisticallyTrackedUsernames.add(u);
        });

        // Names the submit actually covered, so the banner stays specific
        // even after the group it came from disappears from the list below.
        const deckCountsByExistingPlayer = payload.newDecksForExisting.reduce((acc, d) => {
          acc[d.player] = (acc[d.player] || 0) + 1;
          return acc;
        }, {});
        const submittedLabels = [
          ...payload.newPlayers.map(p => `${p.displayName} (${p.decks.length} deck${p.decks.length === 1 ? "" : "s"})`),
          ...Object.entries(deckCountsByExistingPlayer).map(([player, n]) => `${player} (${n} deck${n === 1 ? "" : "s"})`),
        ];
        // Set before refreshing, not after -- renderUpdateAppTab (called
        // below) is what actually displays this, via
        // renderRosterUpdateConfirmationBanner reading it and clearing it.
        rosterUpdateSubmitConfirmation = `✓ Added ${submittedLabels.join(", ")}.`;

        submitBtn.textContent = "Submitted ✓";
        // D1 writes land in ~100-300ms (vs. the old GitHub Actions round
        // trip's 1-3 minutes), so this waits for a real refetch instead of
        // optimistically merging a guessed local copy.
        await refreshEverything();
        // refreshEverything's own internal renders skip Update the App
        // while focus is inside it (isEditingRosterUpdateForm), so a
        // background poll never yanks focus out from under someone
        // mid-keystroke elsewhere in this tab -- but focus is on this
        // submit button right now, itself inside that same guarded panel,
        // so that guard would otherwise suppress the very render meant to
        // show the confirmation banner just set above. Force it
        // unconditionally, same as the optimistic-update code this
        // replaces already had to do for the same reason.
        renderUpdateAppTab();
        return;
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Add Player/Decks";
        statusEl.textContent = `Submission failed: ${err.message}`;
      }
    });
  }

  formAreaEl.appendChild(submitBtn);
  formAreaEl.appendChild(statusEl);
}

// ---------- Discord sign-in ----------

// Discord redirects back here with #session=<token> or #auth_error=<code>
// in the URL fragment, never a query string -- a fragment never gets sent
// to any server on a later request, so the token can't end up in a server
// access log the way a ?session=... param would (see relay.js's
// handleDiscordCallback). Must run before anything else touches
// sessionToken, and strips the hash immediately after reading it so a
// page refresh doesn't try to "consume" it a second time.
function consumeAuthRedirect() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const token = params.get("session");
  const error = params.get("auth_error");
  if (token) {
    sessionToken = token;
    localStorage.setItem("sessionToken", token);
  } else if (error) {
    const messages = {
      not_linked: "That Discord account isn't linked to a player yet — ask an admin to link it.",
      no_code: "Sign-in was cancelled or didn't complete.",
      discord_token_exchange_failed: "Discord sign-in failed — please try again.",
      discord_profile_lookup_failed: "Discord sign-in failed — please try again.",
    };
    showAuthStatusHint(messages[error] || `Sign-in failed (${error}).`);
  }
  if (token || error) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

// Writes to whichever status element is actually visible right now --
// #auth-status lives in the corner control (shown once signed in),
// #signin-gate-status lives in the full-page gate (shown until then). An
// auth error can happen in either state (e.g. "not_linked" comes back
// while still gated, mid sign-in attempt), so both get the message;
// only the one that's actually on screen is ever seen.
function showAuthStatusHint(message) {
  for (const id of ["auth-status", "signin-gate-status"]) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = message;
      el.hidden = false;
    }
  }
}

// Confirms a stored token is still good and fetches the signed-in player's
// display name -- re-derived from the token on every load rather than
// trusted from a stale cached value, so a revoked/expired session (or one
// signed out from another device) is caught immediately instead of
// showing a name that's no longer actually valid.
async function checkAuthSession() {
  if (!sessionToken) {
    renderAuthControl();
    renderAuthGate();
    return;
  }
  try {
    const res = await fetch(AUTH_ME_RELAY_URL, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    currentUser = await res.json();
  } catch {
    sessionToken = null;
    currentUser = null;
    localStorage.removeItem("sessionToken");
  }
  renderAuthControl();
  renderAuthGate();
}

function renderAuthControl() {
  const avatarImg = document.getElementById("auth-avatar-img");
  if (!avatarImg) return;
  if (currentUser) {
    avatarImg.src = currentUser.avatarUrl || "";
    avatarImg.alt = `Signed in as ${currentUser.username}`;
  } else {
    // #auth-control is hidden whenever this is true (see renderAuthGate),
    // so this is just keeping the <img> from holding onto a stale avatar
    // between sessions -- never actually visible itself.
    avatarImg.removeAttribute("src");
    hideAuthMenu();
  }
}

function hideAuthMenu() {
  const menu = document.getElementById("auth-menu");
  const btn = document.getElementById("auth-avatar-btn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

// The whole-app gate -- nothing else on the page is shown, and no live
// data is fetched (see the init section below), until this confirms
// currentUser. Every relay route except the three /auth/* ones now
// requires a session server-side too (see relay.js's dispatcher), so
// this is real access control, not just a client-side nicety -- but
// gating the UI here still matters on its own, so a signed-out visitor
// never even sees a flash of stale/empty tables before every fetch
// comes back 401.
function renderAuthGate() {
  const gate = document.getElementById("signin-gate");
  const wrap = document.querySelector(".wrap");
  const authControl = document.getElementById("auth-control");
  const signedIn = !!currentUser;
  if (gate) gate.hidden = signedIn;
  if (wrap) wrap.hidden = !signedIn;
  if (authControl) authControl.hidden = !signedIn;
}

function wireAuthControl() {
  // A full-page redirect, not a fetch -- Discord's authorize page has to
  // be top-level navigation (it can't be loaded in an iframe/XHR), and
  // client_id/redirect_uri are both public so no relay round trip is
  // needed just to send the browser there. See DISCORD_AUTHORIZE_URL.
  const gateSigninBtn = document.getElementById("signin-gate-btn");
  if (gateSigninBtn) {
    gateSigninBtn.addEventListener("click", () => { window.location.href = DISCORD_AUTHORIZE_URL; });
  }

  // Click the avatar to reveal "Sign out" -- click anywhere else (or the
  // menu item itself) to close it. Same click-to-reveal pattern as every
  // other menu/modal in this app, not hover, so it behaves the same on
  // touch as it does with a mouse.
  const avatarBtn = document.getElementById("auth-avatar-btn");
  const menu = document.getElementById("auth-menu");
  if (avatarBtn && menu) {
    avatarBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = menu.hidden;
      menu.hidden = !opening;
      avatarBtn.setAttribute("aria-expanded", String(opening));
    });
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== avatarBtn) {
        hideAuthMenu();
      }
    });
  }

  const signoutBtn = document.getElementById("auth-signout-btn");
  if (signoutBtn) {
    signoutBtn.addEventListener("click", async () => {
      hideAuthMenu();
      if (sessionToken) {
        try {
          await fetch(AUTH_LOGOUT_RELAY_URL, { method: "POST", headers: authHeaders() });
        } catch {
          // Best-effort -- the token still gets forgotten locally below
          // regardless of whether the relay's own delete succeeded.
        }
      }
      sessionToken = null;
      currentUser = null;
      localStorage.removeItem("sessionToken");
      const statusEl = document.getElementById("auth-status");
      if (statusEl) statusEl.hidden = true;
      renderAuthControl();
      renderAuthGate();
    });
  }
}

// ---------- theme ----------
// Explicit override on top of the system (prefers-color-scheme) theme
// style.css already had before this existed -- "auto" means "no override,"
// i.e. removing data-theme and going back to following the OS setting, not
// a third palette of its own. See the :root[data-theme="dark"] block and
// the :not([data-theme="light"]) guard on the dark media query in
// style.css for the other half of this.
function applyTheme(choice) {
  if (choice === "light" || choice === "dark") {
    document.documentElement.setAttribute("data-theme", choice);
  } else {
    document.documentElement.removeAttribute("data-theme");
    choice = "auto";
  }
  document.querySelectorAll(".theme-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.themeChoice === choice);
  });
  return choice;
}

// ---------- viewport height (mobile browser chrome) ----------
// CSS min-height: 100dvh on .wrap (see style.css) is supposed to keep the
// page at least one real visual viewport tall on every tab, so a short
// tab (Tonight) doesn't leave mobile Safari/Chrome's own address bar
// parked on screen the way a non-scrollable page does -- which is what
// pushes the fixed bottom nav to sit above that chrome instead of the
// true screen edge. Confirmed on a real phone that dvh alone isn't
// enough, though: it's right on a fresh reflow (switch tabs and back
// fixes it) but wrong on cold load, meaning some browsers -- especially
// in installed/standalone PWA mode, which this app supports -- compute
// dvh once against a transient viewport before their own chrome has
// settled, and never re-evaluate it without an explicit trigger.
//
// Same fix as before this app had a real dvh to fall back on: measure the
// actual viewport in JS and write it to a custom property .wrap's
// min-height can reference, ahead of the plain dvh fallback in the
// cascade (see style.css) so a browser that gets dvh right still gets it,
// and one that doesn't gets this instead. window.visualViewport (not
// plain window.innerHeight) is what actually tracks the on-screen
// keyboard and chrome show/hide live where it's available; innerHeight
// is the fallback for the handful of browsers without it.
function syncViewportHeight() {
  const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-vh", `${height}px`);
}

function initViewportHeight() {
  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportHeight);
  }
}

// TEMPORARY -- diagnosing the bottom-nav-floats-on-real-iPhone report.
// Two theory-based fixes (dvh/--app-vh, then translateZ(0) on
// .bottom-tabs) both missed, so this reads the actual numbers on the
// device showing it instead of guessing a third time. Remove this whole
// block, its call at the bottom of this file, and #debug-viewport in
// index.html once the real cause is confirmed fixed.
function updateDebugViewport() {
  const el = document.getElementById("debug-viewport");
  if (!el) return;
  const bar = document.getElementById("bottom-tabs");
  const barRect = bar ? bar.getBoundingClientRect() : null;
  const marker = document.getElementById("debug-floor");
  const markerRect = marker ? marker.getBoundingClientRect() : null;
  const cs = getComputedStyle(document.documentElement);
  const standalone = window.navigator.standalone === true
    || window.matchMedia("(display-mode: standalone)").matches;
  const lines = [
    `standalone: ${standalone}`,
    `screen: ${window.screen.width}x${window.screen.height}`,
    `innerHeight: ${window.innerHeight}`,
    `visualVp.height: ${window.visualViewport ? Math.round(window.visualViewport.height) : "n/a"}`,
    `visualVp.offsetTop: ${window.visualViewport ? Math.round(window.visualViewport.offsetTop) : "n/a"}`,
    `--app-vh: ${cs.getPropertyValue("--app-vh")}`,
    `docScrollHeight: ${document.documentElement.scrollHeight}`,
    `scrollY: ${window.scrollY}`,
    `bar top/bottom: ${barRect ? `${Math.round(barRect.top)}/${Math.round(barRect.bottom)}` : "n/a"}`,
    `dpr: ${window.devicePixelRatio}`,
    // Real env() readings now (see the :root custom properties in
    // style.css) -- the previous line here always read 0px regardless of
    // the actual device value, because it referenced a custom property
    // that was never set anywhere.
    `safe-top/bottom: ${cs.getPropertyValue("--debug-safe-top").trim()}/${cs.getPropertyValue("--debug-safe-bottom").trim()}`,
    // #debug-floor is a lime strip pinned to the literal CSS bottom:0 with
    // NO safe-area padding at all -- ground truth for where the browser
    // thinks "the bottom of the viewport" is. If it lines up with the
    // true physical screen edge in a screenshot, the viewport height the
    // page is given really is the full screen and something else is
    // going on; if it sits well above the true edge (matching where the
    // reported gap starts), the page is being handed a shorter usable
    // area than the physical screen, full stop -- not a rendering quirk.
    `floor marker top: ${markerRect ? Math.round(markerRect.top) : "n/a"}`,
  ];
  el.textContent = lines.join("\n");
}

function initDebugViewport() {
  const el = document.getElementById("debug-viewport");
  if (!el) return;
  updateDebugViewport();
  window.addEventListener("resize", updateDebugViewport);
  window.addEventListener("scroll", updateDebugViewport, { passive: true });
  window.addEventListener("orientationchange", updateDebugViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateDebugViewport);
    window.visualViewport.addEventListener("scroll", updateDebugViewport);
  }
  setInterval(updateDebugViewport, 1000);
}

function initTheme() {
  applyTheme(localStorage.getItem("themePreference"));
  document.querySelectorAll(".theme-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const choice = applyTheme(btn.dataset.themeChoice);
      localStorage.setItem("themePreference", choice);
    });
  });
}

// ---------- pull-to-refresh (touch) ----------
// The only manual refresh control left -- the old fixed desktop button next
// to the avatar was removed once this covered every device that matters
// for this app (used at the table, on phones). A pure-mouse desktop visit
// still gets a fresh read automatically on every tab focus (see the
// visibilitychange listener below) or a plain browser reload; there's just
// no dedicated in-app button for it anymore.
function initPullToRefresh() {
  const indicator = document.getElementById("pull-refresh");
  if (!indicator) return;

  const THRESHOLD = 70; // px pulled before a release actually triggers a refresh
  const MAX_PULL = 100; // px -- caps how far the indicator grows regardless of how far the finger travels
  let startY = null;
  let pulling = false; // true only once a real downward pull-at-the-top has been confirmed, not just any touch
  let refreshing = false;

  document.addEventListener("touchstart", (e) => {
    // Only ever the start of a pull if there's something to refresh
    // (signed in -- refreshEverything no-ops otherwise anyway) and nothing
    // above to scroll past. Re-checked on every touchstart, not cached,
    // since sign-in state and scroll position both change between pulls.
    if (refreshing || !currentUser || (window.scrollY || document.documentElement.scrollTop) > 0) {
      startY = null;
      return;
    }
    startY = e.touches[0].clientY;
    pulling = false;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (startY == null || refreshing) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0 || (window.scrollY || document.documentElement.scrollTop) > 0) {
      // Finger moved up, or the page scrolled out from under a pull
      // already in progress (e.g. content grew) -- bail rather than keep
      // tracking a gesture that no longer means "pull to refresh".
      startY = null;
      indicator.classList.remove("pulling");
      indicator.style.height = "0px";
      return;
    }
    pulling = true;
    // Damped (0.5x), not 1:1 with the finger -- matches the resistance
    // feel of a native pull-to-refresh instead of the indicator just
    // following the touch point exactly.
    const pull = Math.min(delta * 0.5, MAX_PULL);
    indicator.classList.remove("settling");
    indicator.style.height = `${pull}px`;
    // preventDefault only once a pull is confirmed -- doing this
    // unconditionally on every touchmove would also block normal
    // scrolling anywhere else on the page.
    e.preventDefault();
  }, { passive: false });

  document.addEventListener("touchend", async () => {
    if (!pulling) {
      startY = null;
      return;
    }
    const pulledEnough = parseFloat(indicator.style.height || "0") >= THRESHOLD;
    pulling = false;
    startY = null;
    indicator.classList.add("settling");
    if (pulledEnough) {
      refreshing = true;
      indicator.classList.add("refreshing");
      indicator.style.height = "48px";
      try {
        resetPodSetup();
        await refreshEverything();
      } finally {
        indicator.classList.remove("refreshing");
        indicator.style.height = "0px";
        refreshing = false;
      }
    } else {
      indicator.style.height = "0px";
    }
  });
}

// ---------- init ----------

const gtuIntroEl = document.getElementById("gtu-intro");
if (gtuIntroEl) {
  gtuIntroEl.textContent = "Games from playgroup.gg that aren't logged yet. Fill in what playgroup.gg can't supply, then submit.";
}

// Runs before anything else in this section, same reasoning as initTheme
// right below it -- .wrap's min-height needs --app-vh in place before the
// sign-in gate (the very first thing painted) ever renders, not just
// before the app content behind it.
initViewportHeight();

// TEMPORARY -- see updateDebugViewport above.
initDebugViewport();

// Runs before anything else in this section so there's no flash of the
// wrong theme after a stored explicit choice -- see initTheme/applyTheme.
initTheme();

// Must run before checkAuthSession -- consumes a just-completed Discord
// redirect (if any) so sessionToken is set before the very first /auth/me
// check uses it.
consumeAuthRedirect();
wireAuthControl();
initPullToRefresh();

// Registers unconditionally (not gated behind sign-in) -- installability
// is a property of the page shell itself. See sw.js for what it actually
// caches (just the shell, network-first).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.error("Service worker registration failed:", err));
}

// Every relay route except sign-in itself now requires a session (see
// relay.js), so there's no point calling any of these -- let alone
// showing the tables/forms they populate -- until checkAuthSession
// actually confirms one. initTabs() is just wiring click listeners on
// elements that exist either way, harmless to run regardless, but the
// live-data fetches would only come back 401 while gated.
checkAuthSession().then(() => {
  initTabs();
  if (currentUser) {
    initPlayerCountSelect();
    // Shaped placeholders instead of a status line over empty tabs, for
    // the moment between the gate opening and each fetch below actually
    // landing. See renderSkeletonCards for why Players & Decks isn't here.
    renderSkeletonCards(document.getElementById("gtu-game-list"), 2, ["medium", "short"]);
    renderSkeletonCards(document.getElementById("uta-list"), 2, ["medium", "short"]);
    renderSkeletonCards(document.getElementById("winrates-table"), 4, ["short", "medium"]);
    renderSkeletonCards(document.getElementById("achievements-list"), 6, ["medium", "short"]);
    initAchievementsTab();
    syncFromD1();
    refreshPlaygroupGames();
    loadRosterDiff();
    loadAchievements();
  }
});

// Re-fetches everything derived from either data source: syncFromD1
// re-reads the D1 database (also re-runs renderWinRatesTable as part of
// it), refreshPlaygroupGames re-fetches the live playgroup.gg games list
// that both Games to Update and Player Win Rates depend on, loadRosterDiff
// re-fetches the live roster/deck list that Update the App depends on.
// Nothing here is cached anywhere (client or Worker), so every call is
// truly live -- the only question is how often it runs, not how fresh the
// result is. Deliberately NOT on a timer: /playgroup-games touches Workers
// KV on every single call, and a continuous 60s poll from every open tab
// added up fast against the free tier's daily read/write budget for
// basically no benefit, since nothing here needs sub-minute freshness the
// way a user's own submit already gets by awaiting this same function
// directly after a successful submit (see calculateGameToUpdate and
// renderRosterUpdateSubmit). Triggered by: the pull-to-refresh gesture, the
// visibility-change listener right below (so opening/returning to the app
// never shows stale data), once on initial page load, and once right
// after a game or roster submission.
async function refreshEverything() {
  // Guards the visibility-change listener below -- it fires on any
  // tab-focus regardless of sign-in state, and would otherwise fire off
  // three now-guaranteed-401 requests every time a signed-out visitor
  // switches back to the tab.
  if (!currentUser) return;
  await Promise.all([syncFromD1(), refreshPlaygroupGames(), loadRosterDiff(), loadAchievements()]);
}

// Only fires on an actual open/return to the app, not a timer -- catches
// up the instant it's looked at again instead of leaving stale data on
// screen, without polling in the background the rest of the time.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshEverything();
});

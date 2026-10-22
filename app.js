const RANGE_TOLERANCE = 1; // max power spread allowed within a pod
// The one shared reduced-motion check for JS-driven motion (CSS motion has
// its own @media blocks). Read .matches at play time, never cached.
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
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
const TROPHY_CASE_RELAY_URL = RELAY_BASE_URL + "/trophy-case";
const TROPHY_PINS_RELAY_URL = RELAY_BASE_URL + "/trophy-case/pins";
const TROPHY_LEADERBOARD_RELAY_URL = RELAY_BASE_URL + "/trophy-leaderboard";
const SEASON_CLOSE_RELAY_URL = RELAY_BASE_URL + "/seasons/close";
// The shared Set Up Pod table -- see applyLiveTable.
const TABLE_RELAY_URL = RELAY_BASE_URL + "/table";
const PROPOSALS_RELAY_URL = RELAY_BASE_URL + "/proposals";
const PLAYER_ACTIVE_RELAY_URL = RELAY_BASE_URL + "/players/active";

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
let currentUser = null; // { playerId, username, isAdmin } once confirmed, else null
// Admin-only: players switched off with players.active, kept out of
// `players` entirely (see applyPlayersFromD1).
let inactivePlayers = [];
// The last GET /proposals response (see loadProposals). Declared up here,
// not with the rest of the proposals code, because renderTonight reads it
// and already runs at script load.
let proposalsData = null;
// True when the last /auth/me check couldn't reach the relay at all (as
// opposed to the relay saying the token is invalid) -- see checkAuthSession.
let authUnreachable = false;

let players = []; // everyone in Current Deck Strength, unfiltered
let podPlayers = []; // players filtered to knownPlaygroupPlayers -- used by Deck Strength Validator and Player Win Rates
// One entry per seat at the table, in seat order, as last read from the
// relay's shared table (see applyLiveTable) -- every phone at the table
// sees and edits the same one. deckId is only filled in where this phone is
// allowed to know it (its own seat, a seat it picked for, or everyone's
// once the pod passes); sealed says a deck is in either way.
let podCount = 0;
let podSelections = []; // { playerId, deckId, sealed, pickedBy, outOfRange, repicked } per seat
// The table renders nothing until the signed-in init has run (see
// initLiveTable) -- the load-time render setPlayers triggers comes before
// the consts the table code needs, and before there's a session to ask with.
let podTableReady = false;
// The ceiling (floor + RANGE_TOLERANCE) from the table's last check, used to
// narrow an out-of-range seat's deck options to ones that would fix it --
// see decksAvailableForSlot. Comes from the relay with everything else.
let lastCeiling = null;
// Whose deck panel is open under the table on THIS phone -- tracked by
// player rather than seat number, since another phone can add or remove a
// seat and shift the numbers while it's open. editingSeatIndex is that
// player's current seat, recomputed on every render. null = no panel.
let podEditingPlayerId = null;
let editingSeatIndex = null;
// True once the last check passed and nothing has changed since: each
// command zone's deck box shows its commander and colours. Any change to the
// pod (a seat added, removed or re-decked, on any phone) masks it again.
let podRevealed = false;
// The mat's DOM, built once by buildPodTable and reused on every render so
// zones can glide between places instead of being rebuilt.
let podUi = null;
// Only one player's deck table shown at a time -- expanding one auto-
// collapses whichever other player was open, so the card's height stays
// bounded regardless of how many players get tracked over time. null means
// everyone's collapsed.
let expandedPlayerId = null;

// Set by a player row's own tap and consumed by the very next render, so
// only that tap plays the chevron turn and the decks dealing in -- a data
// refresh re-rendering an already-open player plays nothing
// (web-animation rule 7).
let playerBlockToggle = null; // { id, opening }
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
// gamesToLog/newDecks are null until their data has actually loaded and
// "error" if the fetch behind them failed -- starting them at 0 made Tonight
// say "Every game is logged" while it was still loading, and keep saying it
// after a failed /playgroup-games or /roster-diff.
const tonightCounts = { comboWatch: 0, gamesToLog: null, newDecks: null };

function knownCount(value) {
  return typeof value === "number" ? value : 0;
}

function updateTonightTabBadge() {
  setTabBadge("tonight-tab-badge", knownCount(tonightCounts.gamesToLog) + knownCount(tonightCounts.newDecks));
}
let latestStandings = null;
// True once /games has loaded at least once -- "no rows" is only "still
// syncing" before that. A season with no games yet (a new one) is a normal,
// loaded, empty state. Declared up here, not with the Game Log rows below,
// because renderTonight reads it and first runs while this file is still
// loading.
let gameLogLoaded = false;

function tonightSvg(path) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// One actionable row on Tonight. `count` renders as the leading figure
// when there's something outstanding; a settled item shows a check
// instead and doesn't invite a tap.
function buildTonightItem({ count, label, tab, tone, done, loading, onRetry }) {
  const inert = done || loading;
  const row = document.createElement(inert ? "div" : "button");
  row.className = `tonight-item${done ? " tonight-item-done" : ""}${loading ? " tonight-item-loading" : ""}`;
  if (!inert) {
    row.type = "button";
    row.addEventListener("click", () => (onRetry ? onRetry() : activateTab(tab)));
  }

  const lead = document.createElement("span");
  lead.className = `tonight-item-lead tonight-item-lead-${tone || "accent"}`;
  if (done) {
    lead.innerHTML = tonightSvg('<path d="M20 6 9 17l-5-5"></path>');
  } else if (loading) {
    lead.textContent = "…";
  } else if (tab) {
    rollText(lead, count, `tonight:${tab}`);
  } else {
    lead.textContent = count;
  }
  row.appendChild(lead);

  const text = document.createElement("span");
  text.className = "tonight-item-label";
  text.textContent = label;
  row.appendChild(text);

  if (!inert) {
    const chev = document.createElement("span");
    chev.className = "tonight-item-chevron";
    chev.innerHTML = tonightSvg('<path d="m9 18 6-6-6-6"></path>');
    row.appendChild(chev);
  }
  return row;
}

// One of Tonight's counted items in whichever of its four states it's in:
// still loading, couldn't be checked, nothing outstanding, or N to do. Only
// the last two are claims about the data; the first two say so plainly.
function buildTonightCountItem(value, labels) {
  if (value === null) {
    return buildTonightItem({ label: labels.loading, tone: "muted", loading: true });
  }
  if (value === "error") {
    return buildTonightItem({
      count: "!",
      label: labels.error,
      tone: "bad",
      onRetry: () => {
        if (tonightCounts.gamesToLog === "error") tonightCounts.gamesToLog = null;
        if (tonightCounts.newDecks === "error") tonightCounts.newDecks = null;
        renderTonight();
        refreshEverything();
      },
    });
  }
  const row = buildTonightItem({
    count: value,
    label: value === 1 ? labels.one : labels.many,
    tab: labels.tab,
    tone: "warn",
    done: value === 0,
  });
  if (value === 0) row.querySelector(".tonight-item-label").textContent = labels.done;
  return row;
}

// The home screen: the one thing you're most likely here to do, your own
// standing, and whatever is outstanding. Everything on it is already
// loaded for other tabs -- this renders from that shared state rather
// than fetching anything of its own, so it costs no extra requests.
// Tonight's main card, from the shared table (see applyLiveTable). Guarded
// on podTableReady first: renderTonight also runs at script load, before
// the table's state exists.
function tonightTableCopy() {
  const fallback = { title: "Build a pod", sub: "Check the power spread before you shuffle" };
  if (!podTableReady || !liveTableLoaded || podSelections.length === 0) return fallback;
  const n = podSelections.length;
  const me = myPodPlayerId();
  const mine = podSelections.find(s => s.playerId === me);
  const waiting = podSelections.filter(s => !s.sealed || podSeatState(s) === "flagged");
  const names = list => podNameList(list);
  if (podRevealed) return { title: "Ready to play", sub: `The pod passed. ${n} decks revealed.` };
  if (!mine) {
    const others = names(podSelections);
    return { title: n >= POD_MAX_SEATS ? "The table is full" : "Take your seat", sub: `${n} at the table: ${others}` };
  }
  const myState = podSeatState(mine);
  if (myState === "waiting") return { title: "Pick your deck", sub: `You're at the table. ${n - waiting.length} of ${n} decks sealed.` };
  if (myState === "flagged") return { title: "Pick a new deck", sub: "Yours is over this pod's range." };
  if (waiting.length) return { title: "At the table", sub: `Waiting on ${names(waiting)}` };
  return { title: "Ready to check", sub: `All ${n} decks sealed` };
}

// ---------- Game night ----------
// Tonight follows the evening: before the game (the pod forming), during it
// (the pod passed: who's playing what, and for how long), and after (each
// of tonight's games, logged or waiting for its debrief).

// When this phone first saw each passing check, by check id: the game
// clock's start. The relay doesn't timestamp a check, and every phone polls
// within a few seconds of the pass, so they agree to within a poll. Opening
// the app onto a pod that already passed starts the clock then.
const POD_LIVE_KEY = "podLiveSince";
function podLiveSince(checkId) {
  try {
    const all = JSON.parse(localStorage.getItem(POD_LIVE_KEY) || "{}");
    return typeof all[checkId] === "number" ? all[checkId] : null;
  } catch { return null; }
}
function notePodLive(checkId) {
  try {
    const all = JSON.parse(localStorage.getItem(POD_LIVE_KEY) || "{}");
    if (typeof all[checkId] === "number") return;
    all[checkId] = Date.now();
    // Only the last few nights matter.
    const keep = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 10);
    localStorage.setItem(POD_LIVE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* storage blocked -- the clock just won't show */ }
}

function formatGameClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// Today's local calendar day as playgroup.gg writes a game's date.
function tonightDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Tonight's playgroup.gg games, oldest first, each with whether the Game
// Log has it yet. Empty until the Game Log has loaded: logged-or-not needs
// it, and (as with buildTonightRecentGames) checking gameLogLoaded first
// keeps this from touching data declared further down the file during the
// load-time render.
function tonightPlaygroupGames() {
  if (!gameLogLoaded || !playgroupGamesData) return [];
  const day = tonightDay();
  const games = playgroupGamesData.games
    .filter(g => String(g.date || "").slice(0, 10) === day)
    .sort((a, b) => Number(a.playgroup_game_id) - Number(b.playgroup_game_id));
  const logged = computeLoggedMatches(games);
  return games.map(g => ({ game: g, logged: logged.has(g.playgroup_game_id) }));
}

// Straight into a game's debrief (the Games to Update form, one player at
// a time -- see buildGtuDebrief).
function openGameDebrief(pgGame) {
  activateTab("games-to-update");
  openGameForm(pgGame);
}

let tonightClockTimer = 0;
function tickTonightClock() {
  const el = document.querySelector(".tonight-live-clock");
  const since = el ? Number(el.dataset.since) : 0;
  if (!el || !since) { clearInterval(tonightClockTimer); tonightClockTimer = 0; return; }
  el.textContent = formatGameClock(Date.now() - since);
}

// The pod passed: the game is on. Who's at the table with what, who goes
// first, how long it's been running, and the way to its debrief.
function buildTonightLive() {
  const live = document.createElement("section");
  live.className = "tonight-live";
  live.setAttribute("aria-label", "Game in play");
  const gameNo = tonightPlaygroupGames().length + 1;
  const since = liveTableCheck ? podLiveSince(liveTableCheck.id) : null;

  const head = document.createElement("div");
  head.className = "tonight-live-head";
  const tag = document.createElement("span");
  tag.className = "tonight-live-tag";
  tag.innerHTML = '<span class="tonight-live-dot" aria-hidden="true"></span>';
  tag.append(`Game ${gameNo} in play`);
  head.appendChild(tag);
  if (since) {
    const clock = document.createElement("span");
    clock.className = "tonight-live-clock";
    clock.dataset.since = String(since);
    clock.textContent = formatGameClock(Date.now() - since);
    clock.title = "Time since the pod passed";
    head.appendChild(clock);
  }
  live.appendChild(head);

  const first = podFirstPlayer();
  const seats = document.createElement("ul");
  seats.className = "tonight-live-seats";
  for (const slot of podSelections) {
    const deck = podDeckOf(slot);
    const li = document.createElement("li");
    li.className = "tonight-live-seat";
    li.style.setProperty("--sleeve", podSleeveOf(slot.playerId));
    const isFirst = !!first && first.playerId === slot.playerId;
    li.classList.toggle("is-first", isFirst);
    const name = document.createElement("span");
    name.className = "tonight-live-name";
    name.textContent = isFirst ? `${podNameOf(slot)} · 1st` : podNameOf(slot);
    const what = document.createElement("span");
    what.className = "tonight-live-deck";
    what.textContent = deck ? podShortDeckName(deck.name) : "";
    if (deck) li.title = deck.name;
    li.append(name, what);
    seats.appendChild(li);
  }
  live.appendChild(seats);

  const note = document.createElement("p");
  note.className = "tonight-live-note";
  note.hidden = true;

  const actions = document.createElement("div");
  actions.className = "tonight-live-actions";
  const over = document.createElement("button");
  over.type = "button";
  over.className = "primary";
  over.textContent = "Game over: debrief it";
  over.addEventListener("click", () => {
    const pending = tonightPlaygroupGames().filter(e => !e.logged);
    if (pending.length) { openGameDebrief(pending[pending.length - 1].game); return; }
    // The debrief needs the game on playgroup.gg first (Place, KOs and
    // turn come from its event log).
    note.textContent = "";
    note.append("playgroup.gg hasn't got this game yet. Record it there and it'll be right here to debrief. ");
    const link = document.createElement("a");
    link.href = PLAYGROUP_URL;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open playgroup.gg";
    note.appendChild(link);
    note.hidden = false;
  });
  const pod = document.createElement("button");
  pod.type = "button";
  pod.textContent = "Open the pod";
  pod.addEventListener("click", () => activateTab("pod"));
  actions.append(over, pod);
  live.append(actions, note);
  return live;
}

// Each of tonight's games: who won with what, and either logged or a
// Debrief button straight into it.
function buildTonightGames(entries) {
  const list = document.createElement("div");
  list.className = "tonight-games";
  entries.forEach(({ game, logged }, i) => {
    const item = document.createElement("div");
    item.className = "tonight-game";
    const num = document.createElement("span");
    num.className = "tonight-game-date tonight-game-num";
    num.textContent = `Game ${i + 1}`;
    const what = document.createElement("span");
    what.className = "tonight-game-text";
    const winner = game.participants.find(p => p.result === "win");
    const who = document.createElement("strong");
    who.textContent = winner ? winner.player : "No winner yet";
    what.appendChild(who);
    if (winner) what.appendChild(document.createTextNode(` won with ${stripDeckDisambiguation(winner.commander)}`));
    item.append(num, what);
    if (logged) {
      const done = document.createElement("span");
      done.className = "tonight-game-logged";
      done.innerHTML = tonightSvg('<path d="M5 12.5 10 17 19 7"></path>');
      done.setAttribute("role", "img");
      done.setAttribute("aria-label", "Logged");
      item.appendChild(done);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tonight-game-debrief";
      btn.textContent = "Debrief";
      btn.setAttribute("aria-label", `Debrief game ${i + 1}`);
      btn.addEventListener("click", () => openGameDebrief(game));
      item.appendChild(btn);
    }
    list.appendChild(item);
  });
  return list;
}

function renderTonight() {
  const host = document.getElementById("tonight-body");
  if (!host) return;
  host.innerHTML = "";

  // --- during the game ---
  // Once the pod passes, the evening's main card is the game itself.
  if (podTableReady && podRevealed && podSelections.length) {
    if (liveTableCheck) notePodLive(liveTableCheck.id);
    host.appendChild(buildTonightLive());
    if (!tonightClockTimer && document.querySelector(".tonight-live-clock")) {
      tonightClockTimer = setInterval(tickTonightClock, 1000);
    }
  }

  // --- primary action ---
  // Follows the shared table once it's loaded: an empty table invites you
  // to build a pod, a seated one tells you what it needs from you.
  const tableCopy = tonightTableCopy();
  const action = document.createElement("button");
  action.type = "button";
  action.className = "tonight-action";
  action.innerHTML = `
    <span class="tonight-action-icon">${tonightSvg('<path d="M12 2.6 21 12l-9 9.4L3 12z"></path><circle cx="12" cy="12" r="3.1"></circle>')}</span>
    <span class="tonight-action-text">
      <span class="tonight-action-title"></span>
      <span class="tonight-action-sub"></span>
    </span>
    <span class="tonight-item-chevron">${tonightSvg('<path d="m9 18 6-6-6-6"></path>')}</span>`;
  action.querySelector(".tonight-action-title").textContent = tableCopy.title;
  action.querySelector(".tonight-action-sub").textContent = tableCopy.sub;
  action.addEventListener("click", () => activateTab("pod"));
  if (!host.querySelector(".tonight-live")) host.appendChild(action);

  // --- tonight's games ---
  const tonightGames = tonightPlaygroupGames();
  if (tonightGames.length) {
    const gamesLabel = document.createElement("div");
    gamesLabel.className = "tonight-label";
    gamesLabel.textContent = "Tonight's games";
    host.appendChild(gamesLabel);
    host.appendChild(buildTonightGames(tonightGames));
  }

  // --- needs you ---
  // Straight after the main action: these are the only other things on
  // this screen that ask for a tap, so they shouldn't sit below the fold
  // under read-only stats.
  const label = document.createElement("div");
  label.className = "tonight-label";
  label.textContent = "Needs you";
  host.appendChild(label);

  const list = document.createElement("div");
  list.className = "tonight-list";

  list.appendChild(buildTonightCountItem(tonightCounts.gamesToLog, {
    one: "game to debrief",
    many: "games to debrief",
    done: "Every game is logged",
    loading: "Checking for unlogged games…",
    error: "Couldn't check for unlogged games — tap to retry",
    tab: "games-to-update",
  }));
  list.appendChild(buildTonightCountItem(tonightCounts.newDecks, {
    one: "new deck needs a bracket",
    many: "new decks need a bracket",
    done: "No new players or decks",
    loading: "Checking for new players and decks…",
    error: "Couldn't check for new players or decks — tap to retry",
    tab: "update-app",
  }));

  if (tonightCounts.comboWatch > 0) {
    list.appendChild(buildTonightItem({
      count: tonightCounts.comboWatch,
      label: tonightCounts.comboWatch === 1 ? "deck on combo watch" : "decks on combo watch",
      tab: "pod",
      tone: "bad",
    }));
  }

  // Only once /proposals has answered, and only when there's something to
  // do -- an empty board isn't a task.
  if (proposalsData) {
    const toVote = proposalsAwaitingMyVote();
    if (toVote > 0) {
      list.appendChild(buildTonightItem({
        count: toVote,
        label: toVote === 1 ? "proposal to vote on" : "proposals to vote on",
        onRetry: () => openProposalsTab("active"),
      }));
    }
  }

  host.appendChild(list);

  // Rules on trial are in effect at the table tonight, so they're named
  // here rather than only on the Proposals tab.
  const trials = proposalsData ? proposalsData.proposals.filter(p => p.status === "trial") : [];
  if (trials.length) {
    const trialLabel = document.createElement("div");
    trialLabel.className = "tonight-label";
    trialLabel.textContent = "On trial tonight";
    host.appendChild(trialLabel);
    const trialList = document.createElement("div");
    trialList.className = "tonight-list";
    for (const p of trials) {
      trialList.appendChild(buildTonightItem({
        count: `${p.trialGamesPlayed ?? 0}/${p.trialGames}`,
        label: p.title,
        tone: "warn",
        onRetry: () => openProposalsTab("active"),
      }));
    }
    host.appendChild(trialList);
  }

  // --- your season ---
  const myName = currentUser && players.length
    ? (players.find(p => p.id === currentUser.playerId) || {}).name
    : null;
  const myRow = myName && latestStandings
    ? latestStandings.rows.find(r => r.name === myName)
    : null;

  // --- your night ---
  // Only once you've played tonight: games and wins from tonight's
  // playgroup.gg games, logged or not.
  const mine = myName ? tonightGames.filter(({ game }) => game.participants.some(p => p.player === myName)) : [];
  if (mine.length) {
    const nightLabel = document.createElement("div");
    nightLabel.className = "tonight-label";
    nightLabel.textContent = "Your night";
    host.appendChild(nightLabel);
    const wins = mine.filter(({ game }) => game.participants.some(p => p.player === myName && p.result === "win")).length;
    const night = document.createElement("div");
    night.className = "tonight-stats";
    night.innerHTML = `
      <div class="tonight-stat">
        <div class="tonight-stat-value">${mine.length}</div>
        <div class="tonight-stat-label">${mine.length === 1 ? "Game" : "Games"}</div>
      </div>
      <div class="tonight-stat">
        <div class="tonight-stat-value">${wins}</div>
        <div class="tonight-stat-label">${wins === 1 ? "Win" : "Wins"}</div>
      </div>`;
    host.appendChild(night);
  }

  const leaders = buildTonightLeaders(myName);
  const hasMyStats = !!myRow && myRow.adjPct !== null;
  if (hasMyStats || leaders) {
    const seasonLabel = document.createElement("div");
    seasonLabel.className = "tonight-label";
    seasonLabel.textContent = hasMyStats ? "Your season" : "This season";
    host.appendChild(seasonLabel);
  }

  if (hasMyStats) {
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

  if (leaders) {
    if (!hasMyStats) leaders.classList.add("is-first");
    host.appendChild(leaders);
  }

  const recent = buildTonightRecentGames();
  if (recent) {
    const recentLabel = document.createElement("div");
    recentLabel.className = "tonight-label";
    recentLabel.textContent = "Last games";
    host.appendChild(recentLabel);
    host.appendChild(recent);
  }
}

// Top of the current season's standings, plus your own row if you're not
// already in it -- the same latestStandings Player Win Rates just
// computed, so the two can never disagree. The whole list is one tap
// through to the full table.
const TONIGHT_LEADER_COUNT = 3;
function buildTonightLeaders(myName) {
  if (!latestStandings) return null;
  const ranked = latestStandings.rows
    .filter(r => r.adjPct !== null)
    .sort((a, b) => b.adjPct - a.adjPct);
  if (ranked.length === 0) return null;
  const shown = ranked.slice(0, TONIGHT_LEADER_COUNT);
  const mine = ranked.find(r => r.name === myName);
  if (mine && !shown.includes(mine)) shown.push(mine);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tonight-board";
  btn.setAttribute("aria-label", "Season standings: open the full table");
  btn.addEventListener("click", () => activateTab("winrates"));

  shown.forEach((r, i) => {
    const row = document.createElement("span");
    row.className = "tonight-board-row";
    if (r.name === myName) row.classList.add("is-me");
    // A gap in rank (you at #5 under the top three) gets a divider so the
    // jump reads as a jump, not as the next place down.
    if (i === TONIGHT_LEADER_COUNT && r === mine) row.classList.add("is-detached");
    const rank = document.createElement("span");
    rank.className = "tonight-board-rank";
    rank.textContent = latestStandings.adjustedRankByName[r.name] ?? "—";
    const name = document.createElement("span");
    name.className = "tonight-board-name";
    name.textContent = r.name === myName ? `${r.name} (you)` : r.name;
    const pct = document.createElement("span");
    pct.className = "tonight-board-pct";
    pct.textContent = `${r.adjPct.toFixed(1)}%`;
    row.append(rank, name, pct);
    btn.appendChild(row);
  });

  const more = document.createElement("span");
  more.className = "tonight-board-more";
  more.innerHTML = `Full standings ${tonightSvg('<path d="m9 18 6-6-6-6"></path>')}`;
  btn.appendChild(more);
  return btn;
}

// The current season's last few logged games, newest first: who won and
// with what. Read from the same Game Log rows the rest of the app already
// loaded -- nothing fetched for this.
const TONIGHT_RECENT_GAMES = 3;
function buildTonightRecentGames() {
  if (!gameLogLoaded || gameLogSeason3Rows.length === 0) return null;
  const byGame = new Map();
  for (const r of gameLogSeason3Rows) {
    if (!byGame.has(r.gameNum)) byGame.set(r.gameNum, []);
    byGame.get(r.gameNum).push(r);
  }
  const games = [...byGame.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, TONIGHT_RECENT_GAMES);

  const list = document.createElement("div");
  list.className = "tonight-games";
  for (const [, rows] of games) {
    const winner = rows.find(r => r.result === 1);
    const item = document.createElement("div");
    item.className = "tonight-game";
    const when = document.createElement("span");
    when.className = "tonight-game-date";
    // Game Log dates are plain calendar days ("2026-06-26") parsed as UTC
    // midnight -- formatted in UTC too, or anyone west of Greenwich sees
    // the day before.
    const d = rows[0].date;
    when.textContent = d instanceof Date && !isNaN(d)
      ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
      : "";
    const what = document.createElement("span");
    what.className = "tonight-game-text";
    const who = document.createElement("strong");
    who.textContent = winner ? winner.player : "No winner logged";
    what.appendChild(who);
    if (winner) {
      what.appendChild(document.createTextNode(` won with ${stripDeckDisambiguation(winner.commander)}`));
    }
    const pod = document.createElement("span");
    pod.className = "tonight-game-pod";
    pod.textContent = `${rows.length}p`;
    pod.setAttribute("aria-label", `${rows.length} players`);
    item.append(when, what, pod);
    list.appendChild(item);
  }
  return list;
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
      rollText(badge, String(count), id);
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
  renderActivePlayersAdmin();
  renderPodSlots();
  // The table can land before the player list does; its results card names
  // players from this list, so redraw it now rather than leave "A player".
  // Guarded: setPlayers also runs at script load, before the table code's
  // state exists.
  if (podTableReady) renderPodCheckResults();
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
  // /players only includes inactive players for the admin (see
  // computePlayersData in relay.js), and only so the Active switches below
  // Players & Decks can list them. They never reach `players`, so nothing
  // else in the app -- Set Up Pod, Standings, Trophies -- ever shows them.
  inactivePlayers = data.players.filter(p => p.active === false).map(p => ({ id: p.id, name: p.name }));
  setPlayers(data.players.filter(p => p.active !== false).map(p => ({
    id: p.id,
    name: p.name,
    // Up to 3 trophies shown next to the name on Player Win Rates -- see
    // buildWinRateCard and POST /trophy-case/pins.
    pinnedTrophies: p.pinnedTrophies || [],
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
function gameRowFromD1(g) {
  return {
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
  };
}

// The relay says which season is current (currentSeasonId: the one for
// playgroup.gg's active league, even if it has no games yet). That's what
// makes a new season start clean -- picking "the highest season among these
// rows" can't move until a game exists, so the old season kept showing.
// The max-over-rows fallback is only for an older relay that doesn't send it.
function gameLogRowsFromD1(data) {
  const currentSeasonId = data.currentSeasonId ?? (data.games.length ? Math.max(...data.games.map(g => g.seasonId)) : null);
  if (currentSeasonId == null) return [];
  return data.games.filter(g => g.seasonId === currentSeasonId).map(gameRowFromD1);
}

// Every season's rows, for lookups that should carry over between seasons
// (a deck's last bracket) rather than start clean.
let gameLogAllRows = [];

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
      // Counts only. This used to add "N shown in Deck Strength Validator",
      // which named a tab that no longer exists and read 0 on every load:
      // that number comes from /playgroup-games, which lands after this.
      statusEl.textContent = `Synced: ${players.length} players, ${deckCount} decks.`;
    }

    gameLogSeason3Rows = gameLogRowsFromD1(gamesData);
    gameLogAllRows = gamesData.games.map(gameRowFromD1);
    gameLogLoaded = true;
    renderGamesToUpdate();
    renderWinRatesTable(playgroupGamesData);
    // Tonight's "Last games" reads these rows. renderWinRatesTable redraws
    // Tonight too, but bails before that while playgroup.gg hasn't
    // answered, and these rows don't depend on it.
    renderTonight();
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
    // Only when there's no earlier Game Log to fall back on: a failed
    // refresh after a good load keeps the last known count instead.
    if (!gameLogLoaded) {
      const gtuList = document.getElementById("gtu-game-list");
      if (gtuList) gtuList.innerHTML = "";
      tonightCounts.gamesToLog = "error";
      updateTonightTabBadge();
      renderTonight();
    }
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

// "trophies" = the existing one-season standings view; "case" = a single
// player's history aggregated across every closed season; "leaderboard" =
// Most Decorated. Three views of the same tab, not three tabs -- see
// initAchievementsTab and the #achievements-view-toggle wiring below.
let achievementsView = "trophies";
let selectedTrophyCasePlayerId = null;
let compareTrophyCasePlayerId = null;
// Last GET /trophy-case responses on screen (the open case, and the
// compare player's when one is picked). The detail modal, pins and the
// case card all read from these rather than refetching.
let trophyCaseData = null;
let compareTrophyCaseData = null;
let trophyLeaderboardData = null;
let trophyCaseRequestSeq = 0;
let caseCardDrawSeq = 0;

// The exact achievements array last rendered by loadAchievements(), kept
// around purely so the Closing Ceremony button can hand it to
// showClosingCeremonyModal without a second fetch -- it's the same data
// already on screen, just walked through one card at a time instead of
// all at once.
let lastAchievementsData = null;

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
    lastAchievementsData = data;
    selectedAchievementsSeasonId = data.seasonId;
    renderAchievementsSeasonSelect(data.seasons, data.seasonId);
    renderAchievements(data.achievements, data.seasonActive);
    // Stated once, here, rather than repeated inside all 36 cards -- while
    // a season is live every winner is withheld for this one reason, so
    // it's a property of the season, not of each achievement.
    const revealNotice = document.getElementById("achievements-reveal-notice");
    if (revealNotice) revealNotice.hidden = !data.seasonActive;
    // The ceremony only ever makes sense for a season that's actually
    // done -- same seasonActive condition already gating the reveal
    // notice above, since "no live winners yet" and "nothing to walk
    // through in a closing ceremony" are the same state.
    const ceremonyBtn = document.getElementById("ceremony-btn");
    if (ceremonyBtn) ceremonyBtn.hidden = data.seasonActive;
    // Closing a season only makes sense for the CURRENT one -- offering it
    // on a past season the viewer happens to have selected would either
    // no-op (already closed) or, worse, resolve to whatever season is
    // actually live right now instead of the one on screen.
    const isLatestSeason = data.seasons.length > 0 && data.seasonId === data.seasons[data.seasons.length - 1].id;
    const closeSeasonBtn = document.getElementById("close-season-btn");
    if (closeSeasonBtn) closeSeasonBtn.hidden = !(isLatestSeason && data.seasonActive);
    if (statusEl) statusEl.hidden = true;
  } catch (err) {
    if (listEl) listEl.innerHTML = "";
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = `Couldn't load achievements (${err.message}).`;
    }
  }
}

// ---------- Trophy Case ----------

// Finishing second on one of these is a lucky escape, not a near miss, so
// the runner-up box reads "Dodged it" instead of "So close".
const ROAST_TROPHY_IDS = new Set(["wooden-spoon", "saltiest", "early-exit", "most-mulligans", "most-disruptions", "longest-turn"]);
const TROPHY_PIN_LIMIT = 3;
const TROPHY_STATUS_LABEL = { new: "New", defending: "Defending", dethroned: "Dethroned" };
const TROPHY_FALLBACK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2 20 12l-8 8.8L4 12z"></path><path d="M12 7.6 16.2 12 12 16.4 7.8 12z"></path></svg>';
const PIN_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"></path><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"></path></svg>';

function tcEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function isOwnTrophyCase(d) {
  return !!(currentUser && d && currentUser.playerId === d.playerId);
}

function trophyEmblemNode(slot) {
  if (!slot.emblem) {
    const icon = tcEl("span", "trophy-icon");
    icon.innerHTML = TROPHY_FALLBACK_ICON_SVG;
    return icon;
  }
  const img = tcEl("img", "trophy-emblem");
  img.loading = "lazy";
  img.decoding = "async";
  img.src = slot.emblem;
  img.alt = "";
  return img;
}

// 0 = plain frame, 2 = silver (won twice), 3 = gold foil (three or more).
function trophyPrestigeTier(count) {
  if (count >= 3) return 3;
  if (count === 2) return 2;
  return 0;
}
function trophyTierLabel(count) {
  return count >= 3 ? `Gold Foil · ${count} wins` : "Silver · 2 wins";
}

// holders = distinct players who have ever won this trophy, across every
// closed season (see handleTrophyCase in relay.js).
function trophyRarity(slot, d) {
  const n = slot.holders;
  if (n === 0) return { tier: "unclaimed", label: "Unclaimed" };
  if (n === 1) {
    if (!slot.won) return { tier: "rare", label: "Rare · 1 holder" };
    return { tier: "rare", label: isOwnTrophyCase(d) ? "Rare · only you" : `Rare · only ${d.playerName}` };
  }
  if (n <= 3) return { tier: "uncommon", label: `Uncommon · ${n} holders` };
  return { tier: "common", label: `Common · ${n} holders` };
}

async function fetchTrophyCase(playerId) {
  const res = await fetch(`${TROPHY_CASE_RELAY_URL}?player=${playerId}`, { cache: "no-store", headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Fetches one player's full trophy history (every achievement, won or
// locked), plus the compare player's when one is picked, and renders the
// whole Trophy Case view. playerId defaults to whoever's picked in the
// player <select>, falling back to the signed-in player themselves the
// first time this view is opened. The sequence number drops a response
// that arrives after a newer request (quick switching between players).
async function loadTrophyCase(playerId) {
  const statusEl = document.getElementById("achievements-status");
  const targetPlayerId = playerId ?? selectedTrophyCasePlayerId ?? (currentUser ? currentUser.playerId : null);
  if (!targetPlayerId) return;
  selectedTrophyCasePlayerId = targetPlayerId;
  if (compareTrophyCasePlayerId === targetPlayerId) compareTrophyCasePlayerId = null;
  const seq = ++trophyCaseRequestSeq;
  try {
    const [data, compareData] = await Promise.all([
      fetchTrophyCase(targetPlayerId),
      compareTrophyCasePlayerId ? fetchTrophyCase(compareTrophyCasePlayerId) : Promise.resolve(null),
    ]);
    if (seq !== trophyCaseRequestSeq) return;
    trophyCaseData = data;
    compareTrophyCaseData = compareData;
    learnTrophyCategories(data);
    renderTrophyCasePlayerSelect(data.playerId);
    renderTrophyCaseCompareSelect();
    renderTrophyCaseView();
    if (statusEl) statusEl.hidden = true;
  } catch (err) {
    if (seq !== trophyCaseRequestSeq) return;
    trophyCaseData = null;
    for (const id of ["trophy-case-summary", "trophy-case-compare", "trophy-case-list"]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    }
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = `Couldn't load the trophy case (${err.message}).`;
    }
  }
}

function renderTrophyCaseView() {
  if (!trophyCaseData) return;
  renderTrophyCaseSummary(trophyCaseData);
  renderTrophyCompare(trophyCaseData, compareTrophyCaseData);
  renderTrophyCaseShelves(trophyCaseData);
}

function renderTrophyCaseSummary(d) {
  const root = document.getElementById("trophy-case-summary");
  if (!root) return;
  root.innerHTML = "";
  root.className = "tc-summary";
  const held = d.slots.filter(s => s.won).length;
  const totalWins = d.slots.reduce((sum, s) => sum + s.count, 0);

  const head = tcEl("div", "tc-summary-head");
  const nameBlock = tcEl("div", "tc-summary-name-block");
  nameBlock.appendChild(tcEl("div", "tc-summary-name", d.playerName));
  const count = tcEl("div", "tc-summary-count");
  count.appendChild(tcEl("span", "tc-summary-count-n", String(held)));
  count.appendChild(tcEl("span", "tc-summary-count-of", ` / ${d.totalSlots} trophies`));
  nameBlock.appendChild(count);
  head.appendChild(nameBlock);
  const shareBtn = tcEl("button", "tc-share-btn", "Share card");
  shareBtn.type = "button";
  shareBtn.addEventListener("click", showCaseCardModal);
  head.appendChild(shareBtn);
  root.appendChild(head);

  const bar = tcEl("div", "tc-progress");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${held} of ${d.totalSlots} trophies`);
  const fill = tcEl("div", "tc-progress-fill");
  fill.style.width = `${d.totalSlots ? (held / d.totalSlots) * 100 : 0}%`;
  bar.appendChild(fill);
  root.appendChild(bar);

  const stats = tcEl("div", "tc-stats");
  const seasonsLabel = d.mintedSeasonCount === 1 ? "season closed" : "seasons closed";
  for (const [n, label] of [[held, "trophies held"], [totalWins, "total wins"], [d.mintedSeasonCount, seasonsLabel]]) {
    const stat = tcEl("div", "tc-stat");
    stat.appendChild(tcEl("div", "tc-stat-n", String(n)));
    stat.appendChild(tcEl("div", "tc-stat-k", label));
    stats.appendChild(stat);
  }
  root.appendChild(stats);

  const milestones = tcEl("div", "tc-milestones");
  for (const m of computeTrophyMilestones(d)) {
    const chip = tcEl("div", "tc-milestone" + (m.done ? " tc-milestone-done" : ""));
    chip.title = m.description;
    chip.appendChild(tcEl("span", "tc-milestone-name", m.name));
    chip.appendChild(tcEl("span", "tc-milestone-progress", m.progress));
    milestones.appendChild(chip);
  }
  root.appendChild(milestones);
}

// Badges for the collection itself. Full Shelf names the closest shelf
// (fewest trophies missing) when none is complete yet.
function computeTrophyMilestones(d) {
  const held = d.slots.filter(s => s.won).length;
  const shelves = d.categories.map(c => {
    const slots = d.slots.filter(s => s.category === c.id);
    return { label: c.label, won: slots.filter(s => s.won).length, total: slots.length };
  }).filter(s => s.total > 0);
  const full = shelves.find(s => s.won === s.total);
  const closest = [...shelves].sort((a, b) => (a.total - a.won) - (b.total - b.won) || b.won / b.total - a.won / a.total)[0];
  const done = n => (held >= n ? "✓" : `${held}/${n}`);
  return [
    { name: "First Trophy", description: "Win any trophy.", done: held >= 1, progress: done(1) },
    { name: "Collector", description: "Hold 10 different trophies.", done: held >= 10, progress: done(10) },
    full
      ? { name: "Full Shelf", description: `Every ${full.label} trophy.`, done: true, progress: full.label }
      : { name: "Full Shelf", description: "Hold every trophy in one category.", done: false, progress: closest ? `${closest.label} ${closest.won}/${closest.total}` : "" },
    { name: "Completionist", description: `Hold all ${d.totalSlots} trophies.`, done: held >= d.totalSlots, progress: done(d.totalSlots) },
  ];
}

function renderTrophyCompare(a, b) {
  const root = document.getElementById("trophy-case-compare");
  if (!root) return;
  root.innerHTML = "";
  if (!b) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const aWon = new Set(a.slots.filter(s => s.won).map(s => s.id));
  const bWon = new Set(b.slots.filter(s => s.won).map(s => s.id));
  const columns = [
    { title: `${a.playerName} only`, slots: a.slots.filter(s => aWon.has(s.id) && !bWon.has(s.id)) },
    { title: "Both", slots: a.slots.filter(s => aWon.has(s.id) && bWon.has(s.id)) },
    { title: `${b.playerName} only`, slots: b.slots.filter(s => bWon.has(s.id) && !aWon.has(s.id)) },
  ];
  root.appendChild(tcEl("div", "tc-compare-title", `${a.playerName} vs ${b.playerName}`));
  const grid = tcEl("div", "tc-compare-grid");
  for (const col of columns) {
    const colEl = tcEl("div", "tc-compare-col");
    const head = tcEl("div", "tc-compare-head");
    head.appendChild(tcEl("span", null, col.title));
    head.appendChild(tcEl("span", "tc-compare-count", String(col.slots.length)));
    colEl.appendChild(head);
    const emblems = tcEl("div", "tc-compare-emblems");
    if (!col.slots.length) emblems.appendChild(tcEl("span", "tc-compare-empty", "None"));
    for (const s of col.slots) {
      const img = tcEl("img", "tc-mini-emblem");
      img.loading = "lazy";
      img.decoding = "async";
      img.src = s.emblem;
      img.alt = s.title;
      img.title = s.title;
      emblems.appendChild(img);
    }
    colEl.appendChild(emblems);
    grid.appendChild(colEl);
  }
  root.appendChild(grid);
}

// One binder page per category, in the order relay.js sends them.
function renderTrophyCaseShelves(d) {
  const root = document.getElementById("trophy-case-list");
  if (!root) return;
  root.innerHTML = "";
  const total = String(d.slots.length).padStart(3, "0");
  for (const cat of d.categories) {
    const slots = d.slots.filter(s => s.category === cat.id);
    if (!slots.length) continue;
    const won = slots.filter(s => s.won).length;
    const cards = slots.map(slot => buildTrophyCaseCard(slot, d, `${String(d.slots.indexOf(slot) + 1).padStart(3, "0")}/${total}`));
    root.appendChild(buildBinderPage(cat.label, { text: `${won}/${slots.length}`, full: won === slots.length }, cards));
  }
}

// The flavor line: when and with what they won it, or how close they came.
function trophyCaseFlavor(slot, d) {
  if (slot.won) return `${slot.latestSeasonLabel}: ${slot.latestDisplay}`;
  const ru = slot.runnerUp;
  if (!ru) return null;
  const heading = ROAST_TROPHY_IDS.has(slot.id) ? "Dodged it" : "So close";
  return `${heading}, ${ru.seasonLabel}: ${isOwnTrophyCase(d) ? "you" : d.playerName} ${ru.display}, ${ru.winnerName} won with ${ru.winnerDisplay}.`;
}

function trophyCaseCardData(slot, d, collector) {
  return {
    id: slot.id,
    title: slot.title,
    description: slot.description,
    emblem: slot.emblem,
    category: slot.category,
    flavor: trophyCaseFlavor(slot, d),
    holder: slot.won ? (isOwnTrophyCase(d) ? "Yours" : d.playerName) : null,
    rarity: trophyRarity(slot, d),
    count: slot.count,
    held: slot.won,
    locked: !slot.won,
    prestige: trophyPrestigeTier(slot.count),
    status: slot.status,
    pinned: slot.pinned,
    collector,
  };
}

// The slot as a card in its pocket. Opens showTrophyDetailModal via the
// delegated handler in initAchievementsTab.
function buildTrophyCaseCard(slot, d, collector) {
  const card = buildMtgCard(trophyCaseCardData(slot, d, collector));
  card.classList.add("tc-card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${slot.title}, ${slot.won ? "won" : "locked"}. Show details.`);
  return card;
}

function buildRunnerUpBox(slot, d) {
  const ru = slot.runnerUp;
  const tied = ru.display === ru.winnerDisplay;
  const heading = ROAST_TROPHY_IDS.has(slot.id) ? "Dodged it" : "So close";
  const box = tcEl("div", "tc-runner-up");
  box.appendChild(tcEl("span", "tc-runner-up-k", `${heading} · ${ru.seasonLabel}${tied ? " (tied)" : ""}`));
  box.appendChild(tcEl("span", "tc-runner-up-v", `${isOwnTrophyCase(d) ? "You" : d.playerName}: ${ru.display}`));
  box.appendChild(tcEl("span", "tc-runner-up-by", `${ru.winnerName} won with ${ru.winnerDisplay}`));
  return box;
}

function showTrophyDetailModal(id) {
  const d = trophyCaseData;
  const slot = d && d.slots.find(s => s.id === id);
  const modal = document.getElementById("trophy-detail-modal");
  const body = document.getElementById("trophy-detail-body");
  if (!slot || !modal || !body) return;
  body.innerHTML = "";

  const tier = trophyPrestigeTier(slot.count);
  const art = tcEl("div", "tc-detail-art");
  const big = buildMtgCard(trophyCaseCardData(slot, d, document.querySelector(`#trophy-case-list .tc-card[data-id="${CSS.escape(slot.id)}"] .mtg-footer span`)?.textContent || ""));
  big.classList.add("is-inspected");
  art.appendChild(big);
  body.appendChild(art);
  // The card above already carries the rules text; the heading names
  // the sheet.
  body.appendChild(tcEl("h2", null, slot.title));

  const chips = tcEl("div", "tc-detail-chips");
  const rarity = trophyRarity(slot, d);
  chips.appendChild(tcEl("span", `tc-rarity tc-rarity-${rarity.tier}`, rarity.label));
  if (slot.status) chips.appendChild(tcEl("span", `tc-status tc-status-${slot.status}`, TROPHY_STATUS_LABEL[slot.status]));
  if (tier) chips.appendChild(tcEl("span", "tc-tier-label", trophyTierLabel(slot.count)));
  body.appendChild(chips);
  const holdersText = slot.holders === 0 ? "Nobody has won this yet."
    : slot.holders === 1 ? "Held by 1 player." : `Held by ${slot.holders} players.`;
  body.appendChild(tcEl("p", "tc-detail-holders", holdersText));

  body.appendChild(tcEl("h3", "tc-detail-subhead", isOwnTrophyCase(d) ? "Your wins" : `${d.playerName}'s wins`));
  if (slot.history.length) {
    const list = tcEl("ol", "tc-history");
    for (const h of slot.history) {
      const li = tcEl("li");
      li.appendChild(tcEl("span", null, h.seasonLabel));
      li.appendChild(tcEl("b", null, h.display));
      list.appendChild(li);
    }
    body.appendChild(list);
  } else {
    body.appendChild(tcEl("p", "tc-detail-empty", "Not won yet."));
  }
  if (!slot.won && slot.runnerUp) body.appendChild(buildRunnerUpBox(slot, d));
  if (isOwnTrophyCase(d) && slot.won) body.appendChild(buildPinControls(slot, d));

  const opening = modal.hidden;
  presentModal(modal);
  if (opening) zoomTrophyDetail(modal, id, document.querySelector(`#trophy-case-list .tc-card[data-id="${CSS.escape(String(id))}"]`));
}

function hideTrophyDetailModal() {
  const modal = document.getElementById("trophy-detail-modal");
  dismissModal(modal);
}

function buildPinControls(slot, d) {
  const wrap = tcEl("div", "tc-pin-controls");
  const btn = tcEl("button", "tc-pin-btn" + (slot.pinned ? "" : " primary"), slot.pinned ? "Unpin" : "Pin to Player Win Rates");
  btn.type = "button";
  const hint = tcEl("span", "tc-pin-hint", `${d.pins.length} of ${TROPHY_PIN_LIMIT} pinned. Pinned trophies show next to your name on Player Win Rates.`);
  if (!slot.pinned && d.pins.length >= TROPHY_PIN_LIMIT) {
    btn.disabled = true;
    hint.textContent = `You've pinned ${TROPHY_PIN_LIMIT}. Unpin one first.`;
  }
  btn.addEventListener("click", async () => {
    const next = slot.pinned ? d.pins.filter(id => id !== slot.id) : [...d.pins, slot.id];
    btn.disabled = true;
    hint.textContent = "Saving…";
    const error = await saveTrophyPins(next);
    if (error) {
      hint.textContent = error;
      btn.disabled = false;
      return;
    }
    showTrophyDetailModal(slot.id);
  });
  wrap.appendChild(btn);
  wrap.appendChild(hint);
  return wrap;
}

// Returns null on success, or a message to show. Updates the open case,
// your own entry in `players`, and the Player Win Rates cards in place, so
// the pin shows everywhere without a refetch.
async function saveTrophyPins(ids) {
  try {
    const res = await fetch(TROPHY_PINS_RELAY_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ achievementIds: ids }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 401) {
      showAuthStatusHint("Sign in with Discord to do this.");
      return "Sign in to pin trophies.";
    }
    if (!res.ok) return body?.error || `Couldn't save (HTTP ${res.status}).`;
    const pins = body.pins;
    if (isOwnTrophyCase(trophyCaseData)) {
      trophyCaseData.pins = pins;
      for (const s of trophyCaseData.slots) s.pinned = pins.includes(s.id);
      renderTrophyCaseView();
    }
    const me = currentUser ? players.find(p => p.id === currentUser.playerId) : null;
    if (me && trophyCaseData) {
      me.pinnedTrophies = pins
        .map(id => trophyCaseData.slots.find(s => s.id === id))
        .filter(Boolean)
        .map(s => ({ id: s.id, title: s.title, emblem: s.emblem }));
      renderWinRatesTable(playgroupGamesData);
    }
    return null;
  } catch (err) {
    return `Couldn't save (${err.message}).`;
  }
}

// ---------- Most Decorated ----------

async function loadTrophyLeaderboard() {
  const statusEl = document.getElementById("achievements-status");
  const listEl = document.getElementById("trophy-leaderboard-list");
  try {
    const res = await fetch(TROPHY_LEADERBOARD_RELAY_URL, { cache: "no-store", headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    trophyLeaderboardData = await res.json();
    renderTrophyLeaderboard(trophyLeaderboardData);
    if (statusEl) statusEl.hidden = true;
  } catch (err) {
    if (listEl) listEl.innerHTML = "";
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = `Couldn't load Most Decorated (${err.message}).`;
    }
  }
}

// Same ruled-row anatomy as the Player Win Rates cards (see
// buildWinRateCard): rank, name, count out of 28, a bar, then the trophies
// themselves. Rows open that player's Trophy Case via the delegated handler
// in initAchievementsTab.
function renderTrophyLeaderboard(d) {
  const root = document.getElementById("trophy-leaderboard-list");
  if (!root) return;
  root.innerHTML = "";
  const seasons = d.mintedSeasonCount === 1 ? "1 closed season" : `${d.mintedSeasonCount} closed seasons`;
  root.appendChild(tcEl("p", "hint tl-hint", `Trophies held across ${seasons}. Tap a player to open their Trophy Case.`));
  const list = tcEl("div", "wr-card-list tl-list");
  for (const row of d.rows) {
    const card = tcEl("div", "wr-card tl-row" + (row.trophies ? "" : " tl-row-empty"));
    card.dataset.playerId = row.playerId;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `${row.name}, ${row.trophies} of ${d.totalSlots} trophies. Open Trophy Case.`);

    const header = tcEl("div", "wr-card-header");
    header.appendChild(tcEl("span", "wr-rank", String(row.rank)));
    header.appendChild(tcEl("span", "wr-name", row.name));
    header.appendChild(tcEl("span", "wr-metric-value", `${row.trophies} / ${d.totalSlots}`));
    card.appendChild(header);

    const meter = tcEl("div", "wr-meter");
    const bar = tcEl("div", "wr-bar");
    const fill = tcEl("div", "wr-bar-fill");
    fill.style.width = `${d.totalSlots ? (row.trophies / d.totalSlots) * 100 : 0}%`;
    bar.appendChild(fill);
    meter.appendChild(bar);
    meter.appendChild(tcEl("span", "wr-record", row.totalWins === 1 ? "1 win" : `${row.totalWins} wins`));
    card.appendChild(meter);

    if (row.emblems.length) {
      const emblems = tcEl("div", "tl-emblems");
      for (const e of row.emblems) {
        const img = tcEl("img", "tl-emblem");
        img.loading = "lazy";
        img.decoding = "async";
        img.src = e.emblem;
        img.alt = e.title;
        img.title = e.count > 1 ? `${e.title} ×${e.count}` : e.title;
        emblems.appendChild(img);
      }
      card.appendChild(emblems);
    }
    list.appendChild(card);
  }
  root.appendChild(list);
}

// ---------- Trophy Case card (downloadable image) ----------

function loadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function showCaseCardModal() {
  const modal = document.getElementById("case-card-modal");
  if (!modal || !trophyCaseData) return;
  presentModal(modal);
  drawTrophyCaseCard(document.getElementById("case-card-canvas"), trophyCaseData);
}

function hideCaseCardModal() {
  const modal = document.getElementById("case-card-modal");
  dismissModal(modal);
}

// 1080x1350 portrait, in the current theme's colors -- same getComputedStyle
// approach as drawRecapCard. Unlike the recap card this one draws the
// emblem art: the images are same-origin (emblems/*.png), so the canvas
// stays exportable. An emblem that fails to load is skipped, its title is
// still drawn. caseCardDrawSeq drops a draw that a newer one has replaced.
async function drawTrophyCaseCard(canvas, d) {
  const status = document.getElementById("case-card-status");
  const downloadRow = document.getElementById("case-card-download-row");
  const link = document.getElementById("case-card-download");
  if (!canvas) return;
  const seq = ++caseCardDrawSeq;
  if (status) status.textContent = "Drawing the card…";
  if (downloadRow) downloadRow.hidden = true;

  const won = d.slots.filter(s => s.won);
  try {
    await document.fonts.load('700 56px "Saira Condensed"');
  } catch {
    // Falls back to the stack below; the card still draws.
  }
  const images = await Promise.all(won.map(s => loadImage(s.emblem)));
  if (seq !== caseCardDrawSeq) return;

  const width = 1080;
  const height = 1350;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const styles = getComputedStyle(document.documentElement);
  const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const bg = color("--bg", "#0b0a10");
  const ink = color("--ink", "#f2efe9");
  const muted = color("--muted", "#9e97ac");
  const accent = color("--accent", "#a48bff");
  const border = color("--border", "#241f30");
  const foil = color("--foil", "#c9a13f");
  const silver = color("--silver", "#aeb6c2");
  const displayFont = '"Saira Condensed", "Arial Narrow", sans-serif';
  const bodyFont = '"IBM Plex Sans", "Segoe UI", sans-serif';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = accent;
  ctx.font = `700 30px ${displayFont}`;
  ctx.fillText("AMASS A GATHERING · TROPHY CASE", 60, 100);
  ctx.fillStyle = ink;
  ctx.font = `700 96px ${displayFont}`;
  ctx.fillText(d.playerName.toUpperCase(), 60, 200);
  ctx.fillStyle = muted;
  ctx.font = `600 34px ${displayFont}`;
  ctx.fillText(`${won.length} OF ${d.totalSlots} TROPHIES`, 60, 252);

  ctx.fillStyle = border;
  ctx.fillRect(60, 280, width - 120, 10);
  ctx.fillStyle = accent;
  ctx.fillRect(60, 280, (width - 120) * (d.totalSlots ? won.length / d.totalSlots : 0), 10);

  if (!won.length) {
    ctx.fillStyle = muted;
    ctx.font = `600 44px ${displayFont}`;
    ctx.textAlign = "center";
    ctx.fillText("The shelf awaits.", width / 2, 760);
    ctx.textAlign = "left";
  } else {
    const cols = won.length <= 9 ? 3 : won.length <= 16 ? 4 : 5;
    const rows = Math.ceil(won.length / cols);
    const gridTop = 340;
    const gridHeight = 900;
    const cellW = (width - 120) / cols;
    const cellH = Math.min(gridHeight / rows, cellW + 50);
    const titleSize = cols >= 5 ? 18 : 22;
    won.forEach((slot, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = 60 + cellW * col + cellW / 2;
      const top = gridTop + cellH * row;
      const boxW = cellW - 24;
      const boxH = cellH - titleSize - 34;
      const img = images[i];
      if (img) {
        const scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, cx - w / 2, top + (boxH - h) / 2, w, h);
      }
      const tier = trophyPrestigeTier(slot.count);
      if (tier) {
        ctx.strokeStyle = tier === 3 ? foil : silver;
        ctx.lineWidth = 5;
        ctx.strokeRect(cx - boxW / 2, top, boxW, boxH);
      }
      ctx.fillStyle = ink;
      ctx.font = `600 ${titleSize}px ${bodyFont}`;
      ctx.textAlign = "center";
      ctx.fillText(slot.title + (slot.count > 1 ? ` ×${slot.count}` : ""), cx, top + boxH + titleSize + 8, cellW - 8);
      ctx.textAlign = "left";
    });
  }

  const latest = d.mintedSeasons.length ? d.mintedSeasons[d.mintedSeasons.length - 1].label : "";
  ctx.fillStyle = muted;
  ctx.font = `400 24px ${bodyFont}`;
  if (latest) ctx.fillText(`Through ${latest}`, 60, 1310);
  ctx.textAlign = "right";
  ctx.fillText(d.mintedSeasonCount === 1 ? "1 season closed" : `${d.mintedSeasonCount} seasons closed`, width - 60, 1310);
  ctx.textAlign = "left";

  try {
    if (link) {
      link.href = canvas.toDataURL("image/png");
      link.download = `trophy-case-${d.playerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`;
    }
    if (downloadRow) downloadRow.hidden = false;
    if (status) status.textContent = "Saves as a PNG you can post anywhere.";
  } catch (err) {
    if (status) status.textContent = `Couldn't render the card (${err.message}).`;
  }
}

// Builds the player <select> from the roster app.js already has loaded
// (see syncFromD1/setPlayers -- populated in parallel with achievements at
// init, same "don't re-fetch data already in hand" reasoning
// renderAchievementsSeasonSelect follows for its own dropdown).
function renderTrophyCasePlayerSelect(playerId) {
  const sel = document.getElementById("trophy-case-player-select");
  if (!sel) return;
  sel.innerHTML = "";
  for (const p of players) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = playerId;
}

// "No one" plus everyone except the player whose case is open.
function renderTrophyCaseCompareSelect() {
  const sel = document.getElementById("trophy-case-compare-select");
  if (!sel) return;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No one";
  sel.appendChild(none);
  for (const p of players) {
    if (p.id === selectedTrophyCasePlayerId) continue;
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.value = compareTrophyCasePlayerId ?? "";
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
// ---------- The Binder: trophies as Magic cards ----------
// Every trophy is drawn as a card in the modern frame: name and cost in the
// title bar, the emblem as the art, a type line with a set symbol in the
// trophy's rarity, rules text, flavor text naming who holds it, and a
// collector line. Built in HTML/CSS (see .mtg-card in style.css), not from
// Wizards' own frame artwork. Small in the binder's pockets; the full card
// opens on a tap.

// Frame colour per trophy category, the way a card's colour says what it
// does: Standings in white, Combat in red, Survival in green, Playstyle in
// blue, Table in black, Draws & Tempo in multicolour gold. Presentation
// only -- which trophy sits in which category still comes from relay.js.
const MTG_FRAME_BY_CATEGORY = {
  standings: "w", combat: "r", survival: "g", playstyle: "u", table: "b", tempo: "m",
};
const MTG_PIP_VAR = { w: "--pip-w", u: "--pip-u", b: "--pip-b", r: "--pip-r", g: "--pip-g" };
// The set symbol: a little trophy, filled in its rarity's colour.
const MTG_SET_SYMBOL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v4.5a6 6 0 0 1-4.5 5.8V16h3v2.5H7.5V16h3v-2.7A6 6 0 0 1 6 7.5z"></path><path d="M3 4.5h3v3.2A3 3 0 0 1 3 4.5zM21 4.5h-3v3.2a3 3 0 0 0 3-3.2z"></path><rect x="5.5" y="19.5" width="13" height="2.5" rx="1"></rect></svg>';
// id -> category, learned from any Trophy Case response (the season list
// from GET /achievements doesn't carry categories).
const trophyCategoryById = new Map();
let trophyCategoryFetch = null;

function learnTrophyCategories(d) {
  if (!d || !Array.isArray(d.slots)) return;
  for (const s of d.slots) if (s.category) trophyCategoryById.set(s.id, s.category);
  if (Array.isArray(d.categories)) trophyCategoryLabels = d.categories;
}
let trophyCategoryLabels = [];

// The Season view needs categories for its frames. One Trophy Case read
// (the signed-in player's) teaches them all; without a session the cards
// keep the colourless artifact frame.
function ensureTrophyCategories() {
  if (trophyCategoryById.size || trophyCategoryFetch || !currentUser) return trophyCategoryFetch;
  trophyCategoryFetch = fetchTrophyCase(currentUser.playerId)
    .then(d => { learnTrophyCategories(d); return true; })
    .catch(() => { trophyCategoryFetch = null; return false; });
  return trophyCategoryFetch;
}

function categoryLabel(id) {
  const c = trophyCategoryLabels.find(x => x.id === id);
  return c ? c.label : null;
}

// card: { id, title, description, emblem, category, flavor, rarity
//   ({tier,label}|null), count, held (foil: it's yours), locked, sealed,
//   collector, prestige (0/2/3), status, pinned }
function buildMtgCard(card) {
  const frame = MTG_FRAME_BY_CATEGORY[card.category] || "c";
  const el = tcEl("div", `mtg-card frame-${frame}`);
  if (card.held) el.classList.add("is-foil");
  if (card.locked) el.classList.add("is-locked");
  if (card.prestige) el.classList.add(`border-${card.prestige === 3 ? "gold" : "silver"}`);
  el.dataset.id = card.id;

  const face = tcEl("div", "mtg-face");

  const titleBar = tcEl("div", "mtg-titlebar");
  titleBar.appendChild(tcEl("span", "mtg-name", card.title));
  const cost = tcEl("span", "mtg-cost");
  cost.setAttribute("aria-hidden", "true");
  if (card.count >= 2) cost.appendChild(tcEl("span", "mtg-mana mtg-mana-generic", String(card.count)));
  const pips = frame === "m" ? ["r", "u"] : MTG_PIP_VAR[frame] ? [frame] : [];
  for (const p of pips) {
    const pip = tcEl("span", `mtg-mana mtg-mana-${p}`);
    pip.style.setProperty("--pip", `var(${MTG_PIP_VAR[p]})`);
    cost.appendChild(pip);
  }
  if (!pips.length && card.count < 2) cost.appendChild(tcEl("span", "mtg-mana mtg-mana-generic", "0"));
  titleBar.appendChild(cost);
  face.appendChild(titleBar);

  const art = tcEl("div", "mtg-art");
  art.appendChild(trophyEmblemNode(card));
  if (card.status) art.appendChild(tcEl("span", `tc-status tc-status-${card.status}`, TROPHY_STATUS_LABEL[card.status]));
  if (card.pinned) {
    const pin = tcEl("span", "tc-pin-marker");
    pin.title = "Pinned to Standings";
    pin.innerHTML = PIN_ICON_SVG;
    art.appendChild(pin);
  }
  face.appendChild(art);

  const typeLine = tcEl("div", "mtg-typeline");
  const label = categoryLabel(card.category);
  typeLine.appendChild(tcEl("span", "mtg-type", label ? `Trophy — ${label}` : "Trophy"));
  const set = tcEl("span", `mtg-set rarity-${card.rarity ? card.rarity.tier : "none"}`);
  set.innerHTML = MTG_SET_SYMBOL_SVG;
  if (card.rarity) set.title = card.rarity.label;
  typeLine.appendChild(set);
  face.appendChild(typeLine);

  const text = tcEl("div", "mtg-textbox");
  text.appendChild(tcEl("p", "mtg-rules", card.description));
  if (card.flavor) text.appendChild(tcEl("p", "mtg-flavor", card.flavor));
  // The holder's name stands in for the text box on the pocket-sized
  // card, where rules text is too small to read (see .mtg-card in
  // style.css).
  text.appendChild(tcEl("div", "mtg-holder", card.holder || (card.locked ? "Not yet held" : card.sealed ? "Sealed" : "")));

  face.appendChild(text);
  if (card.count >= 2) face.appendChild(tcEl("div", "mtg-pt", `×${card.count}`));
  el.appendChild(face);

  const footer = tcEl("div", "mtg-footer");
  footer.appendChild(tcEl("span", null, card.collector || ""));
  footer.appendChild(tcEl("span", null, "Amass a Gathering"));
  el.appendChild(footer);
  return el;
}

// A binder page: up to nine pockets, three by three, like the real thing.
function buildBinderPage(title, count, cards) {
  const page = tcEl("section", "binder-page");
  if (title) {
    const head = tcEl("div", "binder-page-head");
    head.appendChild(tcEl("h3", "binder-page-title", title));
    if (count) head.appendChild(tcEl("span", "binder-page-count" + (count.full ? " is-full" : ""), count.text));
    page.appendChild(head);
  }
  const pockets = tcEl("div", "binder-pockets");
  for (const c of cards) {
    const pocket = tcEl("div", "binder-pocket");
    pocket.appendChild(c);
    pockets.appendChild(pocket);
  }
  // Empty sleeves fill out the last row, so the page still reads as a page.
  const empties = (3 - (cards.length % 3)) % 3;
  for (let i = 0; i < empties; i++) pockets.appendChild(tcEl("div", "binder-pocket is-empty"));
  page.appendChild(pockets);
  return page;
}

// A tap on any card in the binder opens it full size. Season cards have no
// Trophy Case detail behind them, so they open this: just the card.
function showBinderCardModal(cardEl) {
  const modal = document.getElementById("trophy-detail-modal");
  const body = document.getElementById("trophy-detail-body");
  if (!modal || !body || !cardEl) return;
  body.innerHTML = "";
  const big = cardEl.cloneNode(true);
  big.classList.add("is-inspected");
  big.removeAttribute("tabindex");
  big.removeAttribute("role");
  big.removeAttribute("aria-label");
  big.style.transform = "";
  const title = tcEl("h2", "visually-hidden", cardEl.querySelector(".mtg-name")?.textContent || "Trophy");
  body.append(title, big);
  const opening = modal.hidden;
  presentModal(modal);
  if (opening) zoomTrophyDetail(modal, cardEl.dataset.id, cardEl);
}

// The season's trophies as binder pages, one page per category (in the
// order relay.js gives them) once categories are known, otherwise nine to
// a page in list order. Before the season closes every card is sealed:
// rules text, no holder.
function renderAchievements(achievements, seasonActive) {
  const container = document.getElementById("achievements-list");
  container.innerHTML = "";
  container.classList.remove("is-sealed");

  if (achievements.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No achievements defined yet.";
    container.appendChild(empty);
    return;
  }

  const myId = currentUser ? currentUser.playerId : null;
  const season = lastAchievementsData && lastAchievementsData.seasons
    ? lastAchievementsData.seasons.find(x => x.id === lastAchievementsData.seasonId)
    : null;
  const setCode = season ? season.label : "";
  const total = String(achievements.length).padStart(3, "0");
  const cardFor = (a, i) => {
    const winner = a.winner;
    const el = buildMtgCard({
      id: a.id,
      title: a.title,
      description: a.description,
      emblem: a.emblem,
      category: trophyCategoryById.get(a.id),
      flavor: winner ? `${winner.name}, ${winner.display}` : seasonActive ? "Revealed when the season ends." : "No data yet.",
      holder: winner ? (winner.playerId === myId ? "You" : winner.name) : null,
      sealed: !winner && seasonActive,
      locked: !winner && !seasonActive,
      held: !!winner && winner.playerId === myId,
      collector: `${setCode ? setCode + " · " : ""}${String(i + 1).padStart(3, "0")}/${total}`,
    });
    el.classList.add("tc-card");
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${a.title}${winner ? `, held by ${winner.name}` : ""}. Show the card.`);
    return el;
  };

  const cards = achievements.map((a, i) => ({ a, el: cardFor(a, i) }));
  const known = trophyCategoryLabels.filter(c => cards.some(({ a }) => trophyCategoryById.get(a.id) === c.id));
  if (known.length) {
    for (const cat of known) {
      const inCat = cards.filter(({ a }) => trophyCategoryById.get(a.id) === cat.id);
      const held = inCat.filter(({ a }) => a.winner).length;
      container.appendChild(buildBinderPage(cat.label, seasonActive ? null : { text: `${held}/${inCat.length}` }, inCat.map(c => c.el)));
    }
    const rest = cards.filter(({ a }) => !known.some(c => c.id === trophyCategoryById.get(a.id)));
    if (rest.length) container.appendChild(buildBinderPage("More", null, rest.map(c => c.el)));
  } else {
    for (let i = 0; i < cards.length; i += 9) {
      container.appendChild(buildBinderPage(null, null, cards.slice(i, i + 9).map(c => c.el)));
    }
    // Learn the categories once, then lay the pages out by them.
    const pending = ensureTrophyCategories();
    if (pending) pending.then(learned => {
      if (learned && trophyCategoryById.size && lastAchievementsData && lastAchievementsData.achievements === achievements) {
        renderAchievements(achievements, seasonActive);
      }
    });
  }
}

// Swaps which of the three views is visible/loaded. Each view's controls
// and containers only mean something in that view, so everything else is
// hidden -- including the season-only reveal notice and ceremony/close
// buttons, which used to stay visible in the Trophy Case view.
function setAchievementsView(view) {
  achievementsView = view;
  const show = {
    "achievements-season-row": view === "trophies",
    "season-view-controls": view === "trophies",
    "achievements-list": view === "trophies",
    "season-close-row": view === "trophies",
    "trophy-case-player-row": view === "case",
    "trophy-case-view": view === "case",
    "trophy-leaderboard-list": view === "leaderboard",
  };
  for (const [id, visible] of Object.entries(show)) {
    const el = document.getElementById(id);
    if (el) el.hidden = !visible;
  }
  // Only the Trophies switch's own buttons (data-view): the Proposals and
  // Pod switches share the class, and this used to flip theirs too.
  document.querySelectorAll(".view-toggle-btn[data-view]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  refreshAchievementsView();
}

// Reloads whichever Trophies view is showing (also used by refreshEverything).
function refreshAchievementsView() {
  if (achievementsView === "case") return loadTrophyCase();
  if (achievementsView === "leaderboard") return loadTrophyLeaderboard();
  return loadAchievements();
}

function openTrophyCaseFor(playerId) {
  selectedTrophyCasePlayerId = playerId;
  setAchievementsView("case");
}

// Enter/Space on a role="button" card behaves like a click.
function onCardKey(e, handler) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    handler();
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

  document.querySelectorAll(".view-toggle-btn[data-view]").forEach(btn => {
    btn.addEventListener("click", () => setAchievementsView(btn.dataset.view));
  });

  const casePlayerSel = document.getElementById("trophy-case-player-select");
  if (casePlayerSel) {
    casePlayerSel.addEventListener("change", () => {
      loadTrophyCase(casePlayerSel.value ? Number(casePlayerSel.value) : null);
    });
  }

  const compareSel = document.getElementById("trophy-case-compare-select");
  if (compareSel) {
    compareSel.addEventListener("change", () => {
      compareTrophyCasePlayerId = compareSel.value ? Number(compareSel.value) : null;
      loadTrophyCase();
    });
  }

  const seasonList = document.getElementById("achievements-list");
  if (seasonList) {
    const openCard = target => {
      const card = target.closest(".tc-card");
      if (card) showBinderCardModal(card);
    };
    seasonList.addEventListener("click", e => openCard(e.target));
    seasonList.addEventListener("keydown", e => onCardKey(e, () => openCard(e.target)));
  }

  // Delegated, so re-rendering the shelves never stacks listeners.
  const caseList = document.getElementById("trophy-case-list");
  if (caseList) {
    const openCard = target => {
      const card = target.closest(".tc-card");
      if (card) showTrophyDetailModal(card.dataset.id);
    };
    caseList.addEventListener("click", e => openCard(e.target));
    caseList.addEventListener("keydown", e => onCardKey(e, () => openCard(e.target)));
  }

  const leaderboardList = document.getElementById("trophy-leaderboard-list");
  if (leaderboardList) {
    const openRow = target => {
      const row = target.closest(".tl-row");
      if (row) openTrophyCaseFor(Number(row.dataset.playerId));
    };
    leaderboardList.addEventListener("click", e => openRow(e.target));
    leaderboardList.addEventListener("keydown", e => onCardKey(e, () => openRow(e.target)));
  }

  document.getElementById("trophy-detail-modal-close")?.addEventListener("click", hideTrophyDetailModal);
  document.getElementById("trophy-detail-modal")?.addEventListener("click", e => {
    if (e.target.id === "trophy-detail-modal") hideTrophyDetailModal();
  });
  document.getElementById("case-card-modal-close")?.addEventListener("click", hideCaseCardModal);
  document.getElementById("case-card-modal")?.addEventListener("click", e => {
    if (e.target.id === "case-card-modal") hideCaseCardModal();
  });

  const ceremonyBtn = document.getElementById("ceremony-btn");
  if (ceremonyBtn) {
    ceremonyBtn.addEventListener("click", () => {
      if (!lastAchievementsData) return;
      const season = lastAchievementsData.seasons.find(s => s.id === lastAchievementsData.seasonId);
      showClosingCeremonyModal(lastAchievementsData.achievements, season ? season.label : "", lastAchievementsData.seasonId);
    });
  }

  document.getElementById("close-season-btn")?.addEventListener("click", showCloseSeasonConfirm);
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
  watchSkeletonArrival(container);
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
// One player's power range as a pill (e.g. "2.4–3.9"), shown on their row
// in Players & Decks. A range, not one dot per deck -- a player with a
// dozen decks (real examples in this playgroup go into double digits)
// would otherwise overflow the row. Colored by the average deck's tier,
// since a single hue can't honestly represent a player whose decks span
// multiple tiers -- the average is the least misleading single answer to
// "how strong is this player," and the printed range still shows the real
// spread as text. This used to be a separate strip of pills above the
// list, one per player, which repeated every name the list below already
// showed; it lives on the row itself now.
function buildPowerRangePill(activeDecks) {
  if (activeDecks.length === 0) return null;
  const powers = activeDecks.map(d => d.power);
  const min = Math.min(...powers);
  const max = Math.max(...powers);
  const avg = powers.reduce((a, b) => a + b, 0) / powers.length;
  const range = document.createElement("span");
  range.className = `power-overview-range ${powerTierClass(avg, "power-overview-dot")}`;
  range.textContent = min === max ? formatPower(min) : `${formatPower(min)}–${formatPower(max)}`;
  return range;
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
// UI -- and these sit right next to text they're meant to modify.
// Always aria-hidden: every caller already carries its own aria-label or
// title, so the icon is decoration on top of a named control.
const UI_ICON_PATHS = {
  pencil: '<path d="M4 20.2l4.4-1 10.9-10.9a2 2 0 0 0 0-2.8l-.8-.8a2 2 0 0 0-2.8 0L4.9 15.8 4 20.2z"></path><path d="m14.9 6.1 3 3"></path>',
  flame: '<path d="M12 22c3.8 0 6.4-2.5 6.4-5.9 0-4.1-3.5-6.3-4.7-10.2-.4-1.5-1.1-2.5-1.7-3.4-.3 2.2-1.6 3.5-3.1 5.3C7.4 9.7 6 11.5 6 16.1 6 19.5 8.2 22 12 22z"></path><path d="M12 22c1.8 0 3.1-1.2 3.1-3 0-2-1.6-2.9-2.3-5-.7 1.2-1.5 1.9-2.3 2.9-.9 1.1-1.6 1.4-1.6 2.1 0 1.8 1.3 3 3.1 3z"></path>',
  lock: '<rect x="5" y="10.2" width="14" height="10.3" rx="2"></rect><path d="M8.2 10.2V7.4a3.8 3.8 0 0 1 7.6 0v2.8"></path>',
  rotate: '<path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9L20.5 8.5"></path><path d="M20.5 3.5v5h-5"></path><path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3.5 15.5"></path><path d="M3.5 20.5v-5h5"></path>',
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
  plate.dataset.flipKey = String(deck.id);

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
  const toggle = playerBlockToggle;
  playerBlockToggle = null;

  if (podPlayers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No players linked to playgroup.gg yet.";
    container.appendChild(empty);
    return;
  }

  for (const player of podPlayers) {
    const isExpanded = expandedPlayerId === player.id;
    // Archived on playgroup.gg means retired -- not shown here, and not
    // offered in Set Up Pod either (see renderPodSlots).
    const activeDecks = player.decks.filter(d => !d.archived);

    const block = document.createElement("div");
    block.className = "player-block";
    block.id = `player-block-${player.id}`;

    // The whole row is the expand control. It used to be a 22px arrow plus
    // the deck-count pill, with the player's name itself doing nothing when
    // tapped -- the name is exactly where a thumb goes.
    const header = document.createElement("button");
    header.type = "button";
    header.className = "player-block-header";
    header.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    header.addEventListener("click", () => {
      playerBlockToggle = { id: player.id, opening: !isExpanded };
      expandedPlayerId = isExpanded ? null : player.id;
      renderPlayersTable();
    });
    // The header is rebuilt on every render, so the chevron's own
    // transition never sees a "before" -- these replay the turn from where
    // it was instead.
    if (toggle && toggle.id === player.id) {
      header.classList.add(toggle.opening ? "is-opening" : "is-closing");
    }

    const chevron = document.createElement("span");
    chevron.className = "player-block-chevron";
    chevron.innerHTML = tonightSvg('<path d="m9 18 6-6-6-6"></path>');
    header.appendChild(chevron);

    const nameSpan = document.createElement("span");
    nameSpan.className = "player-name-display";
    nameSpan.textContent = player.name;
    header.appendChild(nameSpan);

    // Shown collapsed or expanded (header always renders) so a flagged
    // deck is noticeable without expanding every player to check -- same
    // pattern as the Games to Update / Update the App tab badges.
    const comboCount = activeDecks.filter(d => d.comboFlagged).length;
    if (comboCount > 0) {
      const comboBadge = document.createElement("span");
      comboBadge.className = "tab-badge";
      comboBadge.textContent = String(comboCount);
      comboBadge.title = `${comboCount} deck${comboCount === 1 ? "" : "s"} showing the Bracket 4 combo pattern — expand to see which.`;
      header.appendChild(comboBadge);
    }

    const meta = document.createElement("span");
    meta.className = "player-block-meta";
    const deckCount = document.createElement("span");
    deckCount.className = "deck-count";
    deckCount.textContent = `${activeDecks.length} deck${activeDecks.length === 1 ? "" : "s"}`;
    meta.appendChild(deckCount);
    const rangePill = buildPowerRangePill(activeDecks);
    if (rangePill) meta.appendChild(rangePill);
    header.appendChild(meta);

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
      glideReorder(container, renderPlayersTable);
    });
    block.appendChild(sortBar);

    const plateList = document.createElement("div");
    plateList.className = "deck-plate-list";
    deckRows.forEach(({ deck, pgPower }, i) => {
      const plate = buildDeckPlate(deck, pgPower);
      plate.style.setProperty("--deal-index", String(Math.min(i, 8)));
      plateList.appendChild(plate);
    });
    // Decks deal in under the row that was just opened, top to bottom.
    if (toggle && toggle.id === player.id && toggle.opening) block.classList.add("is-dealing");
    block.appendChild(plateList);
    container.appendChild(block);
  }
}

// ---------- pod setup UI ----------

// ---------- Set Up Pod: the shared live table ----------
// The pod lives on the relay (GET/POST /table), not on one phone: people
// seat themselves and pick their own decks on their own phones, and every
// phone shows the same table. Each phone polls every few seconds while the
// Pod tab is open; an unchanged table answers 204, so a quiet poll is
// nearly free. The relay masks other people's decks and runs the power
// check itself, so no phone is ever told a deck it isn't allowed to see.

const TABLE_POLL_MS = 3000;
let liveTableVersion = null; // last version applied, for ?v= and ordering
let liveTableLoaded = false; // false until the first read lands
let liveTableCheck = null; // the relay's last check (see renderPodCheckResults)
let liveTableStale = false; // the pod changed after that check
let liveTableSeenCheckId = null; // the check whose reveal this phone already played
let podPollInFlight = false;
let podStatusError = null;
let podStatusTone = "error"; // "error" (red) or "note" (an explanation, not a failure)
let podStatusErrorTimer = null;
// What this phone is waiting on the relay for. A round trip is a few hundred
// milliseconds, and with nothing changing on screen in that gap a tap felt
// ignored (reported as a delay when validating) -- these drive the instant
// feedback instead: the button reads "Checking...", a chip shows pressed,
// a seat reads "Sealing...".
let podPendingCheck = false;
const podPendingSeats = new Set();
const podPendingPicks = new Set();
// Seats this phone has taken off the table but the relay hasn't confirmed
// yet. They leave the screen on the tap (see removePodSeat), so a poll that
// still lists them mustn't put them back.
const podPendingRemovals = new Set();

function myPodPlayerId() {
  return currentUser ? String(currentUser.playerId) : null;
}

async function tableRequest(method, body, query = "") {
  const res = await fetch(`${TABLE_RELAY_URL}${query}`, {
    method,
    cache: "no-store",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The table didn't answer (HTTP ${res.status}).`);
  return data;
}

// Takes a table view from the relay (a poll or a write's reply) and renders
// it. Views carry a version; an older one than what's on screen -- a poll
// that left before this phone's own write but landed after it -- is dropped.
function applyLiveTable(view) {
  if (!view) return;
  if (liveTableVersion !== null && view.version < liveTableVersion) return;
  const firstLoad = !liveTableLoaded;
  const seatedBefore = new Set(podSelections.map(s => s.playerId));
  const prevCheckId = liveTableCheck ? liveTableCheck.id : null;

  liveTableVersion = view.version;
  podSelections = view.seats.map(s => ({
    playerId: String(s.playerId),
    deckId: s.deckId != null ? String(s.deckId) : "",
    sealed: !!s.sealed,
    pickedBy: s.pickedBy != null ? String(s.pickedBy) : "",
    outOfRange: !!s.outOfRange,
    repicked: !!s.repicked,
  })).filter(s => !podPendingRemovals.has(s.playerId));
  podRevealed = !!view.revealed;
  lastCeiling = view.ceiling ?? null;
  liveTableStale = !!view.stale;
  liveTableCheck = view.check || null;
  liveTableLoaded = true;

  // Someone joining on any phone fades their zone in on every phone -- but
  // opening the app onto a table that's already seated shouldn't replay it.
  if (!firstLoad) {
    for (const s of podSelections) if (!seatedBefore.has(s.playerId)) podSeatsEntering.add(s.playerId);
  }
  renderPodSlots();
  renderPodCheckResults();
  renderTonight();

  const check = liveTableCheck;
  if (firstLoad) {
    liveTableSeenCheckId = check ? check.id : null;
  } else if (check && check.id !== prevCheckId && check.id !== liveTableSeenCheckId) {
    liveTableSeenCheckId = check.id;
    if (check.passed && podRevealed) schedulePodReveal(check.id);
    else shakeFlaggedZones();
  }
}

async function pollLiveTable(force) {
  if (!podTableReady || !currentUser || podPollInFlight) return;
  // Polls while the Pod tab or Tonight (which shows the table's state on
  // its main card) is open; anywhere else, nothing.
  const watching = !document.getElementById("tab-pod")?.hidden || !document.getElementById("tab-tonight")?.hidden;
  if (!force && (document.hidden || !watching)) return;
  podPollInFlight = true;
  try {
    applyLiveTable(await tableRequest("GET", null, liveTableVersion !== null ? `?v=${liveTableVersion}` : ""));
  } catch {
    // A missed poll just waits for the next one; nothing to tell anyone.
  } finally {
    podPollInFlight = false;
  }
}

// One table write. The reply is the fresh table, applied straight away so
// the phone that acted never waits on a poll. undoMessage offers the relay's
// undo (unseat, clear) in the usual toast.
async function tableOp(body, undoMessage) {
  try {
    const view = await tableRequest("POST", body);
    applyLiveTable(view);
    if (undoMessage && view && view.undoToken) {
      showUndoToast(undoMessage, () => tableOp({ op: "undo", token: view.undoToken }));
    }
    return view;
  } catch (err) {
    showPodError(err instanceof TypeError ? "Couldn't reach the table. Check your connection." : err.message);
    pollLiveTable(true);
    return null;
  }
}

function showPodError(message, tone = "error") {
  podStatusError = message;
  podStatusTone = tone;
  clearTimeout(podStatusErrorTimer);
  podStatusErrorTimer = setTimeout(() => {
    podStatusError = null;
    if (podUi) renderPodStatus();
  }, 5000);
  if (podUi) renderPodStatus();
}

// Signed-in start-up: first read of the table, then the poll. The poll only
// does anything while the Pod tab is open and the app is in front.
// Only the visible tab background renders now (see .tab-bg in style.css),
// so the others would otherwise first download on the tap that shows them.
// Fetched into the cache once the app has settled instead.
function warmTabBackgrounds() {
  const urls = ["bg-validator.webp", "bg-games-to-update.webp", "bg-update-app.webp", "bg-winrates.webp"];
  const warm = () => urls.forEach(u => { new Image().src = u; });
  if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 5000 });
  else setTimeout(warm, 2500);
}

function initLiveTable() {
  podTableReady = true;
  // The pod used to be saved on the phone itself; the relay holds it now.
  try { localStorage.removeItem("podState"); } catch { /* storage blocked -- nothing to clean */ }
  renderPodSlots();
  pollLiveTable(true);
  setInterval(pollLiveTable, TABLE_POLL_MS);
  warmTabBackgrounds();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollLiveTable(); });
}

// A short-lived "X · Undo" bar above the bottom tabs. Only one at a time;
// showing another replaces it.
let undoToastTimer = null;
function showUndoToast(message, onUndo) {
  const toast = document.getElementById("undo-toast");
  if (!toast) return;
  document.getElementById("undo-toast-text").textContent = message;
  const btn = document.getElementById("undo-toast-btn");
  btn.onclick = () => {
    hideUndoToast();
    onUndo();
  };
  resetUndoToastSwipe();
  toast.hidden = false;
  clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(hideUndoToast, 8000);
}

// Flick the toast away -- sideways or down -- instead of waiting out its
// timer, like a notification. X and Y are separate springs (one spring on
// the 2D distance drifts off-line when the two velocities differ). Up
// rubber-bands: there's nowhere to go that way. While a finger or a spring
// is driving it, its CSS enter/exit transition is switched off so the two
// don't fight; resetUndoToastSwipe hands it back.
let undoSwipeX = 0;
let undoSwipeY = 0;
const renderUndoToastSwipe = () => {
  const toast = document.getElementById("undo-toast");
  if (!toast) return;
  toast.style.transition = "none";
  toast.style.transform = `translate3d(calc(-50% + ${undoSwipeX}px), ${undoSwipeY}px, 0)`;
  toast.style.opacity = String(Math.max(0, 1 - Math.max(Math.abs(undoSwipeX) / 220, undoSwipeY / 90)));
};
// Created on first use: Spring is defined further down this file.
let undoSprings = null;
function undoSpring(axis) {
  undoSprings ||= {
    x: new Spring(0, v => { undoSwipeX = v; renderUndoToastSwipe(); }),
    y: new Spring(0, v => { undoSwipeY = v; renderUndoToastSwipe(); }),
  };
  return undoSprings[axis];
}

function resetUndoToastSwipe() {
  undoSpring("x").stop();
  undoSpring("y").stop();
  undoSwipeX = 0;
  undoSwipeY = 0;
  const toast = document.getElementById("undo-toast");
  if (!toast) return;
  toast.style.transition = "";
  toast.style.transform = "";
  toast.style.opacity = "";
}

function wireUndoToastSwipe() {
  const toast = document.getElementById("undo-toast");
  if (!toast) return;
  const trackX = createVelocityTracker();
  const trackY = createVelocityTracker();
  let start = null;
  let tracking = false;
  let suppressClickUntil = 0;

  toast.addEventListener("touchstart", (e) => {
    start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: undoSwipeX, oy: undoSwipeY } : null;
    tracking = false;
  }, { passive: true });

  toast.addEventListener("touchmove", (e) => {
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!tracking) {
      if (Math.hypot(dx, dy) < 10) return;
      tracking = true;
      undoSpring("x").stop();
      undoSpring("y").stop();
      // Holding it keeps it: the auto-hide waits until it's let go.
      clearTimeout(undoToastTimer);
      start = { x: t.clientX, y: t.clientY, ox: undoSwipeX, oy: undoSwipeY };
      trackX.reset();
      trackY.reset();
    }
    e.preventDefault();
    const rawY = start.oy + (t.clientY - start.y);
    undoSwipeX = start.ox + (t.clientX - start.x);
    undoSwipeY = rawY >= 0 ? rawY : -rubberband(-rawY, 120);
    trackX.add(t.clientX, e.timeStamp);
    trackY.add(t.clientY, e.timeStamp);
    renderUndoToastSwipe();
  }, { passive: false });

  const release = () => {
    start = null;
    if (!tracking) return;
    tracking = false;
    suppressClickUntil = performance.now() + 350;
    const vx = trackX.velocity();
    const vy = trackY.velocity();
    const landX = undoSwipeX + projectMomentum(vx);
    const landY = undoSwipeY + projectMomentum(vy);
    undoSpring("x").value = undoSwipeX;
    undoSpring("y").value = undoSwipeY;
    if (Math.abs(landX) > 90 || landY > 50) {
      // Leaves the way it was thrown; whichever spring is actually
      // travelling decides when it's gone.
      const sideways = Math.abs(landX) > 90 && Math.abs(landX) >= landY;
      const gone = () => { hideUndoToast(); resetUndoToastSwipe(); };
      undoSpring("x").to(sideways ? Math.sign(landX) * window.innerWidth : undoSwipeX, { response: 0.3, velocity: vx, onRest: sideways ? gone : null });
      undoSpring("y").to(sideways ? undoSwipeY : 160, { response: 0.3, velocity: vy, onRest: sideways ? null : gone });
    } else {
      const bounce = REDUCED_MOTION.matches ? 1 : 0.8;
      undoSpring("x").to(0, { dampingRatio: bounce, response: 0.32, velocity: vx });
      undoSpring("y").to(0, { dampingRatio: bounce, response: 0.32, velocity: vy, onRest: resetUndoToastSwipe });
      undoToastTimer = setTimeout(hideUndoToast, 4000);
    }
  };
  toast.addEventListener("touchend", release);
  toast.addEventListener("touchcancel", release);
  // A drag that ends on Undo isn't a tap on Undo.
  toast.addEventListener("click", (e) => {
    if (performance.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}
wireUndoToastSwipe();

function hideUndoToast() {
  const toast = document.getElementById("undo-toast");
  if (toast) toast.hidden = true;
  clearTimeout(undoToastTimer);
}

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

// ---------- Set Up Pod: the command zone mat ----------
// The pod as a printed playmat: one command zone per seat round the edge,
// a d20 in the middle. Your own seat is always the zone nearest you (the
// bottom); everyone else follows clockwise. A seat's zone carries its whole
// state (see podSeatState):
//   waiting  -- seated, no deck yet: an empty dashed zone
//   sealed   -- deck picked and hidden: a deck box in that player's sleeve
//               colour, identical in every way that could give it away
//   flagged  -- over the last check's range: red zone, "Over by 0.4"
//   revealed -- the pod passed: each box shows its commander and colours
// Each zone carries that seat's range gauge. It stays hidden until a
// check, then a marker lands on it: the gold half is in range, the red half
// is over. Same relative numbers the gauge under the mat draws -- never a
// deck's own power. A line runs from the d20 to every zone, lit gold or
// red by the same check.
//
// "Lay flat" turns every zone to face its own edge, for a phone or tablet
// lying in the middle of the real table. Only this phone's view changes.
//
// Everything below runs only after initLiveTable (renderPodSlots bails
// until then): these consts sit far below the load-time render that
// setPlayers triggers, and the pod tab is behind the sign-in gate anyway.

const POD_MAX_SEATS = 8;
// Deck-box sleeve colours, one per player (by id, so a player keeps theirs
// from pod to pod). Fixed material like the pips: card sleeves, not theme.
// Deliberately not derived from the deck: a sealed box mustn't hint at
// which deck is inside it.
const POD_SLEEVES = ["#7a2e2e", "#24486e", "#2f5e40", "#5c3d6e", "#7a5a22", "#2d5a5e", "#6e2f55", "#4a4f57"];
// Zone size on the mat, px. Seven or eight seats use the narrow zone so
// neighbours round the curve don't overlap.
const POD_ZONE = { w: 108, h: 80 };
const POD_ZONE_DENSE = { w: 84, h: 74 };
// The d20's radius, px: where every range track starts.
const POD_HUB_R = 48;

// playerId -> { zone, name, box, boxText, range, marker, track } per seat.
const podSeatEls = new Map();
// Player ids whose zone should fade in on the next render. Only a member
// tapped onto the table (or an undo) gets an entrance -- a restored pod or a
// background data refresh just shows the zones where they already are.
const podSeatsEntering = new Set();
let podPanelWasOpen = false;

function podPlayerOf(slot) {
  return podPlayers.find(p => String(p.id) === slot.playerId) || null;
}

function podDeckOf(slot) {
  const player = podPlayerOf(slot);
  return player && slot.deckId ? player.decks.find(d => String(d.id) === slot.deckId) || null : null;
}

// A seat its own player picked for, on their own phone, is theirs: this
// phone can't open, re-pick or unseat it (the relay refuses too -- see
// isSelfSealed in relay.js). Waiting seats and fill-ins stay open.
function podSeatLocked(slot) {
  return slot.sealed && !!slot.pickedBy && slot.pickedBy === slot.playerId && slot.playerId !== myPodPlayerId();
}

// sealed (not deckId) decides it: this phone often isn't told which deck a
// seat holds, only that one is in.
function podSeatState(slot) {
  if (podRevealed && slot.sealed) return "revealed";
  if (slot.outOfRange && !slot.repicked) return "flagged";
  if (slot.sealed) return "sealed";
  return "waiting";
}

// Partner/disambiguated names shortened to the first commander's first name
// for a deck box ("Atraxa", "Eshki"); the full name rides in the tooltip.
function podShortDeckName(name) {
  return stripDeckDisambiguation(name).split(/[,/]/)[0].trim();
}

function podSleeveOf(playerId) {
  return POD_SLEEVES[Math.abs(Number(playerId) || 0) % POD_SLEEVES.length];
}

// The last check's line for this seat, while it still describes the pod.
function podCheckEntry(playerId) {
  if (!liveTableCheck || liveTableStale) return null;
  return liveTableCheck.entries.find(e => String(e.playerId) === playerId) || null;
}

// One seeded d20 per seat, from the passing check's id, so every phone at
// the table rolls the same numbers without the relay storing a roll.
// FNV-1a over "checkId:playerId:round".
function podD20(checkId, playerId, round) {
  let h = 2166136261;
  for (const ch of `${checkId}:${playerId}:${round}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 20) + 1;
}

// Who goes first once the pod passes: highest d20, ties re-roll among the
// tied. null until the pod is revealed.
function podFirstPlayer() {
  if (!podRevealed || !liveTableCheck || podSelections.length === 0) return null;
  let contenders = podSelections.map(s => s.playerId);
  let winnerRoll = null;
  for (let round = 0; round < 8; round++) {
    const rolls = contenders.map(id => [id, podD20(liveTableCheck.id, id, round)]);
    const top = Math.max(...rolls.map(r => r[1]));
    if (round === 0) winnerRoll = top;
    contenders = rolls.filter(r => r[1] === top).map(r => r[0]);
    if (contenders.length === 1) break;
  }
  return { playerId: contenders[0], roll: winnerRoll };
}

const POD_D20_SVG =
  '<svg class="mat-die-svg" viewBox="0 0 40 40" aria-hidden="true">' +
  '<path class="mat-die-body" d="M20 2 L36 11 L36 29 L20 38 L4 29 L4 11 Z"/>' +
  '<path class="mat-die-facets" d="M20 2 L28 16 L12 16 Z M12 16 L20 30 L28 16 M4 11 L12 16 L4 29 M36 11 L28 16 L36 29 M20 38 L20 30"/></svg>';

function podMatFlatSaved() {
  try { return localStorage.getItem("podMatFlat") === "1"; } catch { return false; }
}

function buildPodTable(container) {
  const ui = {};

  const mat = document.createElement("div");
  mat.className = "mat";
  mat.classList.toggle("is-flat", podMatFlatSaved());
  mat.innerHTML = `
    <span class="mat-ring" aria-hidden="true"></span>
    <div class="mat-tracks" aria-hidden="true"></div>
    <div class="mat-zones"></div>
    <div class="mat-hub">
      <button type="button" class="mat-die">${POD_D20_SVG}<span class="mat-die-face"></span></button>
      <span class="mat-hub-label"></span>
    </div>
    <p class="mat-empty">Tap a member below to pull up a seat.</p>`;

  // "Whole mat" / "My corner" -- only while you're seated (renderPodCorner).
  ui.viewToggle = document.createElement("div");
  ui.viewToggle.className = "view-toggle pod-view-toggle";
  ui.viewToggle.setAttribute("role", "group");
  ui.viewToggle.setAttribute("aria-label", "Pod view");
  ui.viewToggle.hidden = true;
  for (const [view, label] of [["mat", "Whole mat"], ["corner", "My corner"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "view-toggle-btn";
    btn.dataset.podView = view;
    btn.textContent = label;
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => choosePodView(view));
    ui.viewToggle.appendChild(btn);
  }
  container.appendChild(ui.viewToggle);
  attachSelectionIndicator(ui.viewToggle, { itemSelector: ".view-toggle-btn", className: "segment-thumb" });

  ui.corner = buildPodCorner();
  container.appendChild(ui.corner);
  container.appendChild(mat);

  ui.mat = mat;
  ui.tracks = mat.querySelector(".mat-tracks");
  ui.zones = mat.querySelector(".mat-zones");
  ui.die = mat.querySelector(".mat-die");
  ui.dieFace = mat.querySelector(".mat-die-face");
  ui.hubLabel = mat.querySelector(".mat-hub-label");
  ui.empty = mat.querySelector(".mat-empty");
  // Beside the card's heading rather than on the mat, where a seven- or
  // eight-seat pod has a zone in every corner.
  ui.flatBtn = document.createElement("button");
  ui.flatBtn.type = "button";
  ui.flatBtn.className = "mat-flat-btn";
  ui.flatBtn.innerHTML = `${uiIcon("rotate")}<span>Lay flat</span>`;
  ui.flatBtn.title = "Turn every seat to face its own edge, for a device lying in the middle of the table";
  (container.parentElement.querySelector(".pod-head") || container).appendChild(ui.flatBtn);
  ui.flatBtn.setAttribute("aria-pressed", String(mat.classList.contains("is-flat")));
  ui.flatBtn.addEventListener("click", () => {
    const flat = !mat.classList.contains("is-flat");
    mat.classList.toggle("is-flat", flat);
    ui.flatBtn.setAttribute("aria-pressed", String(flat));
    try { localStorage.setItem("podMatFlat", flat ? "1" : "0"); } catch { /* storage blocked -- flat just won't be remembered */ }
    layoutPodMat();
  });
  ui.die.addEventListener("click", () => { if (ui.dieAction) ui.dieAction(); });

  // role=status, one atomic message: what the table means right now.
  ui.status = document.createElement("p");
  ui.status.className = "pod-status";
  ui.status.setAttribute("role", "status");
  ui.status.setAttribute("aria-atomic", "true");
  container.appendChild(ui.status);

  ui.railLabel = document.createElement("p");
  ui.railLabel.className = "pod-rail-label";
  ui.railLabel.id = "pod-rail-label";
  ui.railLabel.textContent = "Members";
  container.appendChild(ui.railLabel);

  ui.roster = document.createElement("div");
  ui.roster.className = "pod-roster";
  ui.roster.setAttribute("role", "group");
  ui.roster.setAttribute("aria-labelledby", "pod-rail-label");
  container.appendChild(ui.roster);

  ui.panel = document.createElement("div");
  ui.panel.className = "pod-panel";
  ui.panel.hidden = true;
  container.appendChild(ui.panel);

  // Zones are placed in px off the mat's size, so re-place them when it
  // changes -- including the hidden-to-shown switch to the Pod tab, which
  // this sees as a resize from nothing.
  if ("ResizeObserver" in window) new ResizeObserver(() => layoutPodMat()).observe(mat);
  return ui;
}

// ---- My corner: your own seat, up close ----
// The mockup's "your corner of the mat": a mini map of the table, your
// command zone large, and your decks as a shelf of deck boxes to tap into
// it. It shows on its own while it's your move -- you're seated and need a
// deck, or yours came back over range -- and the whole mat comes back once
// your deck is sealed. Seating others and picking for someone without
// their phone stay on the whole mat. Only this phone ever sees your
// corner, so your own decks' names and colours are safe to show here.
//
// null = automatic; "mat" or "corner" when picked on the switch, until
// your seat's state changes (podViewChoiceKey), then automatic again.
let podViewChoice = null;
let podViewChoiceKey = null;

function myPodSlot() {
  const me = myPodPlayerId();
  return me ? podSelections.find(s => s.playerId === me) || null : null;
}

function podCornerVisible() {
  const mine = myPodSlot();
  if (!mine) return false;
  const key = podSeatState(mine);
  if (podViewChoice && podViewChoiceKey !== key) podViewChoice = null;
  if (podViewChoice) return podViewChoice === "corner";
  return key === "waiting" || key === "flagged";
}

function choosePodView(view) {
  const mine = myPodSlot();
  if (!mine) return;
  podViewChoice = view;
  podViewChoiceKey = podSeatState(mine);
  renderPodSlots();
}

function buildPodCorner() {
  const corner = document.createElement("div");
  corner.className = "corner";
  corner.hidden = true;
  corner.innerHTML = `
    <div class="corner-top">
      <span class="corner-map" role="img"></span>
      <div class="corner-titles">
        <h3 class="corner-title">Your corner</h3>
        <p class="corner-sub"></p>
      </div>
    </div>
    <div class="corner-toward" aria-hidden="true">${tonightSvg('<path d="m6 15 6-6 6 6"></path>')}<span>Toward the table</span></div>
    <div class="corner-zone">
      <span class="corner-zone-label"></span>
      <span class="mat-box"><span class="mat-box-text"></span></span>
      <span class="mat-range" aria-hidden="true"><span class="mat-marker"></span></span>
      <span class="corner-zone-note"></span>
    </div>
    <p class="corner-shelf-label" id="corner-shelf-label">Your deck boxes</p>
    <p class="corner-range-note" hidden>Showing only decks that fit this pod's range.</p>
    <div class="corner-shelf" role="group" aria-labelledby="corner-shelf-label"></div>
    <div class="corner-foot">
      <button type="button" class="pod-leave">Leave the table</button>
      <span class="pod-note">${uiIcon("lock")}<span>Hidden from the table once sealed</span></span>
    </div>`;
  corner.querySelector(".pod-leave").addEventListener("click", () => {
    const me = myPodPlayerId();
    if (me) removePodSeat(me);
  });
  wireCornerDrag(corner);
  return corner;
}

// Drag a deck box from the shelf up into your zone to seal it -- the same
// pick as tapping it, for anyone who'd rather put the box down. On touch a
// box lifts only after a short hold, so a quick swipe across the shelf
// still scrolls the page; with a mouse it lifts as soon as it moves. A
// floating copy follows the finger 1:1; let go over the zone and it drops
// in, anywhere else and it springs back to the shelf with the release's
// velocity. Tapping is untouched (a drag swallows only its own click).
let podCornerDragging = false;
function wireCornerDrag(corner) {
  const shelf = corner.querySelector(".corner-shelf");
  const zone = corner.querySelector(".corner-zone");
  const HOLD_MS = 160;
  const SLOP = 8;
  let press = null; // { box, id, x, y, pointerId, touch, timer }
  let drag = null; // { box, ghost, originX, originY, x, y }
  let suppressClickUntil = 0;
  const trackX = createVelocityTracker();
  const trackY = createVelocityTracker();

  const overZone = (x, y) => {
    const r = zone.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const lift = () => {
    const { box, x, y, pointerId } = press;
    clearTimeout(press.timer);
    const r = box.getBoundingClientRect();
    const ghost = box.cloneNode(true);
    ghost.classList.add("corner-ghost");
    ghost.removeAttribute("id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);
    box.classList.add("is-lifted");
    zone.classList.add("is-dropzone");
    try { box.setPointerCapture(pointerId); } catch { /* pointer already gone -- release handles it */ }
    drag = { box, ghost, id: press.id, startX: x, startY: y, dx: 0, dy: 0 };
    podCornerDragging = true;
    trackX.reset();
    trackY.reset();
    haptic(8);
  };

  // Takes the drag it's drawing, not the shared `drag`: the two return
  // springs can tick once more after the other has already finished.
  const place = d => {
    const lifted = REDUCED_MOTION.matches ? "" : " scale(1.06) rotate(-2deg)";
    d.ghost.style.transform = `translate3d(${d.dx}px, ${d.dy}px, 0)${lifted}`;
  };

  const finish = () => {
    if (!drag) return;
    drag.springs?.forEach(s => s.stop());
    drag.ghost.remove();
    drag.box.classList.remove("is-lifted");
    zone.classList.remove("is-dropzone", "is-target");
    drag = null;
    podCornerDragging = false;
  };

  const release = (e, cancelled) => {
    if (press) { clearTimeout(press.timer); press = null; }
    if (!drag) return;
    suppressClickUntil = performance.now() + 400;
    const me = myPodPlayerId();
    const d = drag;
    if (!cancelled && overZone(e.clientX, e.clientY) && me) {
      // Into the zone: the copy shrinks into the box already there while
      // the pick goes off; the end state never waits on it (rule 2).
      const zr = zone.querySelector(".mat-box").getBoundingClientRect();
      const gr = d.ghost.getBoundingClientRect();
      d.ghost.style.transition = REDUCED_MOTION.matches ? "none" : "transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s ease";
      d.ghost.style.transform = `translate3d(${d.dx + (zr.left + zr.width / 2) - (gr.left + gr.width / 2)}px, ${d.dy + (zr.top + zr.height / 2) - (gr.top + gr.height / 2)}px, 0) scale(0.4)`;
      d.ghost.style.opacity = "0";
      setTimeout(finish, REDUCED_MOTION.matches ? 0 : 220);
      haptic(12);
      if (!podPendingPicks.has(me)) pickPodDeck(me, d.id);
      return;
    }
    if (REDUCED_MOTION.matches) { finish(); return; }
    // Back to the shelf, carrying the release's speed into the spring.
    const sx = new Spring(d.dx, v => { d.dx = v; place(d); });
    const sy = new Spring(d.dy, v => { d.dy = v; place(d); });
    d.springs = [sx, sy];
    zone.classList.remove("is-target");
    sx.to(0, { dampingRatio: 0.8, response: 0.3, velocity: trackX.velocity() });
    sy.to(0, { dampingRatio: 0.8, response: 0.3, velocity: trackY.velocity(), onRest: finish });
  };

  shelf.addEventListener("pointerdown", e => {
    const box = e.target.closest(".corner-deck");
    if (!box || drag || e.button > 0 || box.getAttribute("aria-busy") === "true") return;
    const touch = e.pointerType !== "mouse";
    press = { box, id: box.dataset.deckId, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch, timer: 0 };
    if (touch) press.timer = setTimeout(() => { if (press) lift(); }, HOLD_MS);
  });
  shelf.addEventListener("pointermove", e => {
    if (drag) {
      drag.dx = e.clientX - drag.startX;
      drag.dy = e.clientY - drag.startY;
      trackX.add(drag.dx, e.timeStamp);
      trackY.add(drag.dy, e.timeStamp);
      place(drag);
      zone.classList.toggle("is-target", overZone(e.clientX, e.clientY));
      return;
    }
    if (!press || e.pointerId !== press.pointerId) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (moved < SLOP) return;
    // Moved before the hold: on touch that's a scroll, so let it be one.
    if (press.touch) { clearTimeout(press.timer); press = null; return; }
    lift();
  });
  shelf.addEventListener("pointerup", e => release(e, false));
  shelf.addEventListener("pointercancel", e => release(e, true));
  // Once a box is lifted the page mustn't scroll under the finger. Touch
  // events, not pointer events, are the only ones that can stop it.
  shelf.addEventListener("touchmove", e => { if (drag) e.preventDefault(); }, { passive: false });
  // A long-press on a box would otherwise open the iOS callout or the
  // context menu under the finger.
  shelf.addEventListener("contextmenu", e => { if (press || drag) e.preventDefault(); });
  // The drag's own click (fired on release) isn't a tap on the box.
  shelf.addEventListener("click", e => {
    if (performance.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

function renderPodCorner() {
  const mine = myPodSlot();
  const show = podCornerVisible();
  podUi.viewToggle.hidden = !mine;
  podUi.viewToggle.querySelectorAll(".view-toggle-btn").forEach(btn => {
    const on = btn.dataset.podView === (show ? "corner" : "mat");
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  podUi.corner.hidden = !show;
  podUi.mat.hidden = show;
  podUi.flatBtn.hidden = show;
  if (!show) return;
  // The rail and the deck panel are for the whole table; your corner has
  // its own shelf.
  podUi.railLabel.hidden = true;
  podUi.roster.hidden = true;
  podUi.panel.hidden = true;

  const corner = podUi.corner;
  const n = podSelections.length;
  const me = mine.playerId;
  const state = podSeatState(mine);
  const deck = podDeckOf(mine);
  const check = podCheckEntry(me);
  const pending = podPendingPicks.has(me);
  const sealed = podSelections.filter(s => s.sealed && podSeatState(s) !== "flagged").length;

  // Mini map: the same spots the whole mat uses, you at the bottom.
  const map = corner.querySelector(".corner-map");
  const mapSize = { w: 16, h: 11 };
  const spots = podMatSpots(n, 72, 80, mapSize);
  const mineIdx = podSelections.indexOf(mine);
  map.innerHTML = '<span class="corner-map-die"></span>';
  podSelections.forEach((slot, i) => {
    const spot = spots[(((i - mineIdx) % n) + n) % n];
    const seat = document.createElement("span");
    seat.className = `corner-map-seat is-${podSeatState(slot)}${slot === mine ? " is-mine" : ""}`;
    seat.style.setProperty("--sleeve", podSleeveOf(slot.playerId));
    seat.style.left = `${(36 + spot.x - mapSize.w / 2).toFixed(1)}px`;
    seat.style.top = `${(40 + spot.y - mapSize.h / 2).toFixed(1)}px`;
    map.appendChild(seat);
  });
  map.setAttribute("aria-label", `The table: ${sealed} of ${n} decks sealed`);
  corner.querySelector(".corner-sub").textContent =
    `${n} at the table · ${sealed} of ${n} decks sealed`;

  // Your zone, large.
  const zone = corner.querySelector(".corner-zone");
  zone.className = `corner-zone is-${state}`;
  zone.style.setProperty("--sleeve", podSleeveOf(me));
  const player = podPlayerOf(mine);
  corner.querySelector(".corner-zone-label").textContent = `Command zone · ${player ? player.name : "You"}`;
  const box = zone.querySelector(".mat-box");
  const boxText = zone.querySelector(".mat-box-text");
  box.querySelector(".id-coin, .ui-icon")?.remove();
  const note = corner.querySelector(".corner-zone-note");
  if (pending) {
    boxText.textContent = "Sealing…";
    note.textContent = "Sliding it into your zone.";
  } else if (state === "waiting") {
    boxText.textContent = "Empty";
    note.textContent = "Tap a deck box below, or drag one up into this zone, to seal it. Only you will see which until the pod passes.";
  } else if (state === "flagged") {
    boxText.textContent = check && check.overBy > 0 ? `Over by ${formatPower(check.overBy)}` : "Over range";
    note.textContent = "Your deck is over this pod's range. Tap or drag another in from the shelf.";
  } else {
    boxText.textContent = deck ? podShortDeckName(deck.name) : "Sealed";
    const coin = state === "revealed" && deck ? buildIdentityCoin(deck.colorIdentity) : null;
    if (coin) box.prepend(coin);
    else box.insertAdjacentHTML("afterbegin", uiIcon("lock"));
    note.textContent = state === "revealed" ? "The pod passed. Everyone can see it now." : "Sealed. Only you can see which deck this is.";
  }
  const range = zone.querySelector(".mat-range");
  const measured = !!check && !check.exempt && check.rel !== null;
  range.classList.toggle("is-measured", measured);
  range.classList.toggle("is-over", measured && check.overBy > 0);
  if (measured) range.firstElementChild.style.setProperty("--m", `${(Math.min(2, check.rel) * 50).toFixed(1)}%`);

  // The shelf. Rebuilt only when what it shows changed: a poll landing
  // mid-tap mustn't swap the boxes out from under a finger.
  const decks = decksAvailableForSlot(mine);
  const shelf = corner.querySelector(".corner-shelf");
  const signature = JSON.stringify([me, decks.map(d => d.id), mine.deckId, pending]);
  // Never under a box that's being dragged: it would vanish mid-gesture.
  if (shelf.dataset.signature !== signature && !podCornerDragging) {
    shelf.dataset.signature = signature;
    const focusedId = shelf.contains(document.activeElement) ? document.activeElement.dataset.deckId : null;
    shelf.innerHTML = "";
    for (const d of decks) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "corner-deck";
      btn.dataset.deckId = String(d.id);
      // A colour per deck box (by id), so the shelf reads as separate boxes.
      btn.style.setProperty("--sleeve", POD_SLEEVES[Math.abs(Number(d.id) || 0) % POD_SLEEVES.length]);
      const current = String(d.id) === mine.deckId;
      btn.setAttribute("aria-pressed", String(current));
      if (pending) btn.setAttribute("aria-busy", "true");
      btn.title = d.name;
      const name = document.createElement("span");
      name.className = "corner-deck-name";
      name.textContent = podShortDeckName(d.name);
      btn.appendChild(name);
      const foot = document.createElement("span");
      foot.className = "corner-deck-foot";
      const coin = buildIdentityCoin(d.colorIdentity);
      if (coin) foot.appendChild(coin);
      const meta = document.createElement("span");
      // Games logged, not power -- the same hint the deck panel gives.
      if (d.comboFlagged) {
        meta.className = "corner-deck-combo";
        meta.textContent = "Combo watch";
      } else {
        meta.textContent = d.gamesLogged === 1 ? "1 game" : `${d.gamesLogged || 0} games`;
      }
      foot.appendChild(meta);
      btn.appendChild(foot);
      btn.setAttribute("aria-label", `${d.name}${current ? ", sealed in your zone" : ""}${d.comboFlagged ? ", on combo watch" : ""}`);
      btn.addEventListener("click", () => { if (!podPendingPicks.has(me)) pickPodDeck(me, String(d.id)); });
      shelf.appendChild(btn);
    }
    if (focusedId) shelf.querySelector(`[data-deck-id="${focusedId}"]`)?.focus({ preventScroll: true });
  }
  const activeCount = player ? player.decks.filter(d => !d.archived).length : decks.length;
  corner.querySelector(".corner-range-note").hidden = !(mine.outOfRange && lastCeiling !== null && decks.length < activeCount);
}

function buildPodZone(playerId) {
  const zone = document.createElement("button");
  zone.type = "button";
  zone.className = "mat-zone";
  zone.style.setProperty("--sleeve", podSleeveOf(playerId));
  zone.innerHTML =
    '<span class="mat-zone-name"></span>' +
    '<span class="mat-box"><span class="mat-box-text"></span></span>' +
    '<span class="mat-range" aria-hidden="true"><span class="mat-marker"></span></span>';
  zone.addEventListener("click", () => tapPodSeat(playerId));
  const track = document.createElement("span");
  track.className = "mat-track";
  return {
    zone, track,
    name: zone.querySelector(".mat-zone-name"),
    box: zone.querySelector(".mat-box"),
    boxText: zone.querySelector(".mat-box-text"),
    range: zone.querySelector(".mat-range"),
    marker: zone.querySelector(".mat-marker"),
  };
}

function updatePodZone(entry, slot, i) {
  const { zone, box, boxText, range, track, marker } = entry;
  const state = podSeatState(slot);
  const player = podPlayerOf(slot);
  const deck = podDeckOf(slot);
  const locked = podSeatLocked(slot);
  const check = podCheckEntry(slot.playerId);
  const first = podFirstPlayer();
  const isFirst = !!first && first.playerId === slot.playerId;

  zone.classList.remove("is-waiting", "is-sealed", "is-flagged", "is-revealed");
  zone.classList.add(`is-${state}`);
  zone.classList.toggle("is-focus", editingSeatIndex === i);
  zone.classList.toggle("is-locked", locked);
  zone.classList.toggle("is-first", isFirst);
  // Not `disabled`: a disabled button swallows the tap silently, which read
  // as being locked out with no reason given. aria-disabled keeps it
  // focusable and announced, and tapPodSeat explains the lock.
  if (locked) zone.setAttribute("aria-disabled", "true");
  else zone.removeAttribute("aria-disabled");

  const name = player ? player.name : "…";
  entry.name.textContent = isFirst ? `${name} · 1st` : name;
  zone.removeAttribute("title");
  box.querySelector(".id-coin, .ui-icon")?.remove();
  let spoken;
  if (podPendingPicks.has(slot.playerId)) {
    boxText.textContent = "Sealing…";
    spoken = "sealing a deck";
  } else if (state === "waiting") {
    // The narrow zone of a seven- or eight-seat mat fits one word.
    boxText.textContent = podSelections.length >= 7 ? "Pick" : "Pick a deck";
    spoken = "empty command zone, no deck yet";
  } else if (state === "flagged") {
    const over = check && check.overBy > 0 ? ` by ${formatPower(check.overBy)}` : "";
    boxText.textContent = `Over${over}`;
    spoken = `deck over this pod's range${over}`;
  } else if (state === "sealed") {
    boxText.textContent = slot.outOfRange && slot.repicked ? "Re-check" : "Sealed";
    box.insertAdjacentHTML("afterbegin", uiIcon("lock"));
    spoken = slot.outOfRange && slot.repicked ? "new deck sealed, check again" : "deck sealed";
  } else {
    boxText.textContent = deck ? podShortDeckName(deck.name) : "Revealed";
    const coin = deck ? buildIdentityCoin(deck.colorIdentity) : null;
    if (coin) box.prepend(coin);
    if (deck) zone.title = deck.name;
    spoken = deck ? deck.name : "deck revealed";
  }
  if (isFirst) spoken += `, goes first (rolled ${first.roll})`;
  zone.setAttribute("aria-label", `${name}'s command zone, ${spoken}${locked ? `. Only ${name} can change this seat.` : ""}`);

  // The marker lands only on a check that still describes this pod. New
  // decks are exempt: no marker (the gauge under the mat says why).
  const measured = !!check && !check.exempt && check.rel !== null;
  const over = measured && check.overBy > 0;
  for (const el of [range, track]) {
    el.classList.toggle("is-measured", measured);
    el.classList.toggle("is-over", over);
  }
  if (measured) {
    // 0% is the pod's lightest deck; each point of relative power walks the
    // marker half the gauge. Past the halfway line is over the range.
    marker.style.setProperty("--m", `${(Math.min(2, check.rel) * 50).toFixed(1)}%`);
  }
}

// Where each seat goes: evenly spaced (by distance, not angle) round a
// rectangle inset from the mat's edge, starting from the bottom centre and
// running clockwise. An ellipse spaced by angle bunched seven or eight
// zones into each other at the top and bottom of a phone-shaped mat.
// Returns centre offsets from the mat's middle plus the edge each seat sits
// on (0 bottom, 1 left, 2 top, 3 right), which "Lay flat" turns it to face.
function podMatSpots(n, w, h, size) {
  const hw = w / 2 - size.w / 2 - 12;
  const hh = h / 2 - size.h / 2 - 12;
  // The path, clockwise from bottom centre: bottom-left run, left side,
  // top, right side, bottom-right run back to the start.
  const legs = [
    [hw, 0, [0, hh], [-hw, hh]],
    [2 * hh, 1, [-hw, hh], [-hw, -hh]],
    [2 * hw, 2, [-hw, -hh], [hw, -hh]],
    [2 * hh, 3, [hw, -hh], [hw, hh]],
    [hw, 0, [hw, hh], [0, hh]],
  ];
  const total = 4 * hw + 4 * hh;
  return Array.from({ length: n }, (_, k) => {
    let d = (k * total) / n;
    for (const [len, edge, [x1, y1], [x2, y2]] of legs) {
      if (d <= len + 1e-6) {
        const f = len ? Math.min(1, d / len) : 0;
        return { x: x1 + (x2 - x1) * f, y: y1 + (y2 - y1) * f, edge };
      }
      d -= len;
    }
    return { x: 0, y: hh, edge: 0 };
  });
}

// Distance from a zone's centre to its edge along the unit direction
// (ux, uy) -- so each track stops short of its own zone whichever side of
// the zone it arrives at.
function podZoneEntry(ux, uy, size) {
  return 1 / Math.max(Math.abs(ux) / (size.w / 2), Math.abs(uy) / (size.h / 2), 1e-6);
}

// Places every zone and track. Pure layout: reads the mat's size once, then
// writes custom properties only (all transforms).
function layoutPodMat() {
  if (!podUi) return;
  const n = podSelections.length;
  // Taller mat for bigger pods, so zones keep their spacing (see .mat.is-*).
  podUi.mat.classList.toggle("is-tall", n >= 5 && n <= 6);
  podUi.mat.classList.toggle("is-dense", n >= 7);
  const w = podUi.mat.clientWidth;
  const h = podUi.mat.clientHeight;
  if (w === 0) return; // pod tab hidden; the ResizeObserver re-runs this on show
  const size = n >= 7 ? POD_ZONE_DENSE : POD_ZONE;
  const flat = podUi.mat.classList.contains("is-flat");
  const mine = podSelections.findIndex(s => s.playerId === myPodPlayerId());
  const spots = podMatSpots(n, w, h, size);
  podSelections.forEach((slot, i) => {
    const entry = podSeatEls.get(slot.playerId);
    if (!entry) return;
    // Your own seat is always spot 0, the zone nearest you.
    const spot = spots[(((i - Math.max(0, mine)) % n) + n) % n];
    entry.zone.style.setProperty("--x", `${(w / 2 + spot.x).toFixed(1)}px`);
    entry.zone.style.setProperty("--y", `${(h / 2 + spot.y).toFixed(1)}px`);
    entry.zone.style.setProperty("--r", flat ? `${spot.edge * 90}deg` : "0deg");
    const dist = Math.hypot(spot.x, spot.y);
    const a = (Math.atan2(spot.y, spot.x) * 180) / Math.PI;
    // From the d20's edge to the zone's: the line runs under the zone, so
    // stopping at its edge just keeps it from showing through the border.
    const end = dist - podZoneEntry(spot.x / dist, spot.y / dist, size);
    entry.track.style.setProperty("--a", `${a.toFixed(1)}deg`);
    entry.track.style.setProperty("--len", `${Math.max(0, end - POD_HUB_R).toFixed(1)}px`);
  });
}

function renderPodZones() {
  const n = podSelections.length;
  const seated = new Set(podSelections.map(s => s.playerId));
  for (const [id, entry] of podSeatEls) {
    if (!seated.has(id)) removePodZone(id, entry);
  }
  podSelections.forEach((slot, i) => {
    let entry = podSeatEls.get(slot.playerId);
    if (!entry) {
      entry = buildPodZone(slot.playerId);
      // In seat order so the zones' tab order matches the table.
      const next = podSelections.slice(i + 1).map(s => podSeatEls.get(s.playerId)).find(Boolean);
      podUi.zones.insertBefore(entry.zone, next ? next.zone : null);
      podUi.tracks.appendChild(entry.track);
      podSeatEls.set(slot.playerId, entry);
      if (podSeatsEntering.has(slot.playerId) && !REDUCED_MOTION.matches) {
        entry.zone.classList.add("entering");
        setTimeout(() => entry.zone.classList.remove("entering"), 320);
      }
    }
    updatePodZone(entry, slot, i);
  });
  podSeatsEntering.clear();
  podUi.mat.classList.toggle("has-focus", editingSeatIndex !== null);
  layoutPodMat();
  podUi.empty.hidden = n > 0 || !liveTableLoaded;
}

function removePodZone(id, entry) {
  podSeatEls.delete(id);
  entry.track.remove();
  const { zone } = entry;
  zone.classList.add("leaving");
  let done = false;
  const finish = () => { if (!done) { done = true; zone.remove(); } };
  zone.addEventListener("animationend", finish);
  // Safety net: animationend never fires if the tab is hidden mid-exit,
  // or under reduced motion, where there's no animation at all.
  setTimeout(finish, REDUCED_MOTION.matches ? 0 : 220);
}

// The d20 in the middle: a count while decks go in, the check itself once
// every deck is sealed (same action as the button under the mat), and who
// goes first once the pod passes.
function renderPodHub() {
  const n = podSelections.length;
  const die = podUi.die;
  const sealed = podSelections.filter(s => s.sealed && podSeatState(s) !== "flagged").length;
  const first = podFirstPlayer();
  const ready = n > 0 && !podRevealed && sealed === n && !podPendingCheck && (!liveTableCheck || liveTableStale || !liveTableCheck.passed);
  let face, label, action = null, aria;
  if (first) {
    const who = podSelections.find(s => s.playerId === first.playerId);
    face = String(first.roll);
    label = `${who ? podNameOf(who) : "Someone"} goes first`;
    aria = `d20: ${label}, rolled ${first.roll}`;
  } else if (podPendingCheck) {
    face = "…";
    label = "Checking the spread";
    aria = label;
  } else if (ready) {
    face = "20";
    label = "Tap to shuffle up";
    action = runPodCheck;
    aria = "Shuffle up: check the deck power spread";
  } else {
    face = n ? `${sealed}/${n}` : "20";
    label = n ? "Decks sealed" : "No seats yet";
    aria = n ? `${sealed} of ${n} decks sealed` : label;
  }
  podUi.dieFace.textContent = face;
  podUi.hubLabel.textContent = label;
  podUi.dieAction = action;
  die.setAttribute("aria-label", aria);
  die.classList.toggle("is-ready", ready);
  die.classList.toggle("is-rolled", !!first);
  die.setAttribute("aria-disabled", action ? "false" : "true");
  die.classList.toggle("is-checking", podPendingCheck);

  // The roll plays once per passing check, when it lands on this phone --
  // not when the app opens onto a table that already passed.
  const rollKey = first ? liveTableCheck.id : null;
  if (podUi.rolledFor === undefined) podUi.rolledFor = rollKey;
  else if (rollKey && podUi.rolledFor !== rollKey) {
    podUi.rolledFor = rollKey;
    if (!REDUCED_MOTION.matches) {
      die.classList.remove("is-rolling");
      void die.offsetWidth;
      die.classList.add("is-rolling");
      setTimeout(() => die.classList.remove("is-rolling"), 900);
    }
  } else if (!rollKey) podUi.rolledFor = null;
}

function renderPodRoster() {
  const roster = podUi.roster;
  const full = podSelections.length >= POD_MAX_SEATS;
  // Rebuilt only when something a chip shows actually changed: every render
  // (a poll, a pick, a check) used to tear down and re-lay out every chip.
  const signature = JSON.stringify([full, podPlayers.map(p => {
    const id = String(p.id);
    const idx = podSelections.findIndex(s => s.playerId === id);
    return [id, p.name, idx, podPendingSeats.has(id), idx >= 0 && podSeatLocked(podSelections[idx])];
  })]);
  if (roster.dataset.signature === signature) return;
  roster.dataset.signature = signature;
  // Keep focus on the chip that had it -- rebuilding drops it otherwise.
  const focusedId = roster.contains(document.activeElement) ? document.activeElement.dataset.playerId : null;
  roster.innerHTML = "";
  for (const p of podPlayers) {
    const idx = podSelections.findIndex(s => s.playerId === String(p.id));
    const seated = idx >= 0;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pod-chip";
    chip.setAttribute("aria-pressed", seated ? "true" : "false");
    const pending = podPendingSeats.has(String(p.id));
    const locked = seated && podSeatLocked(podSelections[idx]);
    // Pressed the instant it's tapped (see addPodSeat), not after the relay.
    chip.setAttribute("aria-pressed", seated || pending ? "true" : "false");
    if (pending) chip.setAttribute("aria-busy", "true");
    chip.disabled = !seated && !pending && full;
    chip.classList.toggle("is-locked", locked);
    if (locked) chip.setAttribute("aria-disabled", "true");
    if (chip.disabled) chip.title = `The table seats ${POD_MAX_SEATS}`;

    // A seated member's avatar shows their seat number instead of their
    // initial. Deliberately not an extra "Seat 2" tag: that widened the
    // chip, reflowed the rail, and put the next member under a finger that
    // was already on its way to tap them (confirmed in testing).
    const avatar = document.createElement("span");
    avatar.className = "pod-chip-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = seated ? String(idx + 1) : p.name.charAt(0).toUpperCase();
    chip.appendChild(avatar);
    const nameEl = document.createElement("span");
    nameEl.textContent = p.name;
    chip.appendChild(nameEl);
    if (locked) chip.setAttribute("aria-label", `${p.name}, seat ${idx + 1}. Locked in their own deck.`);
    else if (seated) chip.setAttribute("aria-label", `${p.name}, seat ${idx + 1}. Pick their deck.`);
    // Tapping a seated member used to take them off the table -- easy to do
    // by accident when you meant to pick their deck. It opens their deck
    // list instead; leaving the table lives in that list, with Undo.
    chip.addEventListener("click", () => (seated ? tapPodSeat(String(p.id)) : addPodSeat(String(p.id))));
    chip.dataset.playerId = String(p.id);
    roster.appendChild(chip);
  }
  if (focusedId) roster.querySelector(`[data-player-id="${focusedId}"]`)?.focus({ preventScroll: true });
}

function podNameOf(slot) {
  return podPlayerOf(slot)?.name || "Someone";
}

// "Becca", "Becca and Ryan", "Becca, Ryan and 2 more".
function podNameList(slots) {
  const names = slots.map(podNameOf);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function renderPodStatus() {
  const el = podUi.status;
  const n = podSelections.length;
  podUi.empty.hidden = n > 0 || !liveTableLoaded;
  el.classList.toggle("pod-status-error", !!podStatusError && podStatusTone === "error");
  el.classList.toggle("pod-status-note", !!podStatusError && podStatusTone === "note");
  if (podStatusError) { el.textContent = podStatusError; return; }
  if (podPendingCheck) { el.textContent = "Checking the spread…"; return; }
  if (!liveTableLoaded) { el.textContent = "Finding the table…"; return; }
  if (n === 0) { el.textContent = "No one at the table yet."; return; }
  if (podRevealed) { el.innerHTML = `<strong>Pod passes.</strong> ${n} ${n === 1 ? "deck" : "decks"} revealed. Ready to play.`; return; }

  const strongThen = (lead, rest) => {
    const strong = document.createElement("strong");
    strong.textContent = lead;
    el.textContent = "";
    el.appendChild(strong);
    if (rest) el.appendChild(document.createTextNode(` ${rest}`));
  };
  const flagged = podSelections.filter(s => podSeatState(s) === "flagged");
  if (flagged.length) {
    strongThen(`${podNameList(flagged)} ${flagged.length > 1 ? "are" : "is"} over this pod's range.`, "Pick a lower deck, then check again.");
    return;
  }
  const waiting = podSelections.filter(s => !s.sealed);
  if (waiting.length) {
    el.textContent = `${n - waiting.length} of ${n} decks sealed. Waiting on ${podNameList(waiting)}. ` +
      "Tap a seat to pick for someone without their phone.";
    return;
  }
  if (liveTableStale) { strongThen("The pod changed after the check.", "Check the spread again."); return; }
  el.textContent = `All ${n} decks sealed. Ready to check the spread.`;
}

function renderPodPanel() {
  const panel = podUi.panel;
  const open = editingSeatIndex !== null;
  panel.hidden = !open;
  podUi.railLabel.hidden = open;
  podUi.roster.hidden = open;
  const validateRow = document.getElementById("pod-validate-row");
  if (validateRow) validateRow.hidden = open;
  if (!open) {
    podPanelWasOpen = false;
    delete panel.dataset.signature;
    return;
  }

  const i = editingSeatIndex;
  const slot = podSelections[i];
  const player = podPlayerOf(slot);
  const decks = decksAvailableForSlot(slot);
  const me = myPodPlayerId();
  const mine = slot.playerId === me;
  // Another phone's change re-renders this one; rebuilding an unchanged
  // panel would reset the deck list's scroll and focus under someone's
  // finger, so only rebuild when something in it actually changed.
  const signature = JSON.stringify([slot.playerId, i, podSelections.length, slot.deckId, slot.sealed, slot.outOfRange, lastCeiling, decks.map(d => d.id), !!player]);
  if (panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;
  panel.innerHTML = "";

  const head = document.createElement("div");
  head.className = "pod-panel-head";
  const avatar = document.createElement("span");
  avatar.className = "pod-panel-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = player ? player.name.charAt(0).toUpperCase() : "?";
  head.appendChild(avatar);
  const titles = document.createElement("div");
  titles.className = "pod-panel-titles";
  const title = document.createElement("h3");
  title.className = "pod-panel-title";
  title.textContent = mine ? "Your deck" : (player ? player.name : "…");
  titles.appendChild(title);
  const sub = document.createElement("p");
  sub.className = "pod-panel-sub";
  const name = player ? player.name : "this player";
  if (mine) sub.textContent = `Seat ${i + 1} of ${podSelections.length}. Only you will see it until the pod passes.`;
  else if (slot.sealed && !slot.deckId) sub.textContent = `${name}'s deck is already sealed. Picking replaces it.`;
  else sub.textContent = `Picking for ${name}. Only you and ${name} will see it until the pod passes.`;
  titles.appendChild(sub);
  head.appendChild(titles);
  const done = document.createElement("button");
  done.type = "button";
  done.className = "pod-panel-done";
  done.textContent = "Done";
  done.addEventListener("click", closePodPanel);
  head.appendChild(done);
  panel.appendChild(head);

  if (slot.outOfRange && lastCeiling !== null && player && decks.length < player.decks.filter(d => !d.archived).length) {
    const range = document.createElement("p");
    range.className = "pod-panel-range";
    range.textContent = "Showing only decks that fit this pod's range.";
    panel.appendChild(range);
  }

  const list = document.createElement("div");
  list.className = "pod-decks";
  for (const d of decks) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pod-deck" + (String(d.id) === slot.deckId ? " pod-deck-current" : "");
    const deckName = document.createElement("span");
    deckName.className = "pod-deck-name";
    deckName.textContent = d.name;
    btn.appendChild(deckName);
    // Games logged, not power -- power is the thing this screen keeps
    // hidden, and how often a deck gets played is the one hint that
    // helps you find it in a 17-deck list without leaking anything.
    const games = document.createElement("span");
    games.className = "pod-deck-games";
    games.textContent = d.gamesLogged === 1 ? "1 game" : `${d.gamesLogged || 0} games`;
    btn.appendChild(games);
    btn.addEventListener("click", () => pickPodDeck(slot.playerId, String(d.id)));
    list.appendChild(btn);
  }
  panel.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "pod-panel-footer";
  const leave = document.createElement("button");
  leave.type = "button";
  leave.className = "pod-leave";
  leave.textContent = mine ? "Leave the table" : `Take ${name} off the table`;
  leave.addEventListener("click", () => removePodSeat(slot.playerId));
  footer.appendChild(leave);
  const note = document.createElement("span");
  note.className = "pod-note";
  note.innerHTML = `${uiIcon("lock")}<span>Hidden from the table once picked</span>`;
  footer.appendChild(note);
  panel.appendChild(footer);

  // Entrance only when the panel opens, not on every re-render.
  if (!podPanelWasOpen) {
    panel.classList.remove("opening");
    void panel.offsetWidth;
    panel.classList.add("opening");
    setTimeout(() => panel.classList.remove("opening"), 300);
  }
  podPanelWasOpen = true;
}

// The one button under the table, self-serve first: take your seat, pick
// your deck, then check once everyone's in. What it does is whatever its
// label says (podCtaAction).
let podCtaAction = null;
function renderPodCta() {
  const btn = document.getElementById("validate-btn");
  if (!btn) return;
  const n = podSelections.length;
  const me = myPodPlayerId();
  const mineIdx = podSelections.findIndex(s => s.playerId === me);
  const canSit = !!me && podPlayers.some(p => String(p.id) === me);
  const set = (label, action, { primary = true, glow = false, busy = false } = {}) => {
    btn.textContent = label;
    btn.disabled = !action;
    btn.classList.toggle("primary", primary);
    btn.classList.toggle("glow", glow);
    btn.classList.toggle("is-busy", busy);
    if (busy) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
    podCtaAction = action;
  };

  if (!liveTableLoaded) return set("Finding the table…", null);
  if (podPendingCheck) return set("Checking the spread…", null, { busy: true });
  if (podRevealed) return set("Clear the table", clearPodTable, { primary: false });
  if (mineIdx < 0 && canSit) {
    return n >= POD_MAX_SEATS ? set("The table is full", null) : set("Take a seat", () => addPodSeat(me));
  }
  if (mineIdx >= 0 && podCornerVisible()) {
    const state = podSeatState(podSelections[mineIdx]);
    if (podPendingPicks.has(me)) return set("Sealing your deck…", null, { busy: true });
    if (state === "waiting" || state === "flagged") return set("Tap a deck box above", null);
  }
  if (mineIdx >= 0) {
    const state = podSeatState(podSelections[mineIdx]);
    if (state === "waiting") return set("Pick your deck", () => openPodSeat(me));
    if (state === "flagged") return set("Pick a new deck", () => openPodSeat(me));
  }
  if (n === 0) return set("Seat someone to start", null);
  const needs = podSelections.filter(s => !s.sealed || podSeatState(s) === "flagged");
  if (needs.length) return set(`Waiting on ${podNameList(needs)}`, null);
  set("Check Deck Power Spread", runPodCheck, { glow: liveTableStale && !!liveTableCheck });
}

function handlePodCta() {
  if (podCtaAction) podCtaAction();
}

// Selecting a member seats them and opens their deck list -- picking a deck
// is what selecting someone is for. (Seating others who'll pick on their
// own phones is one "Done" each.) The chip shows pressed the moment it's
// tapped, before the relay answers.
async function addPodSeat(playerId) {
  if (podSelections.some(s => s.playerId === playerId) || podPendingSeats.has(playerId)) return;
  podPendingSeats.add(playerId);
  renderPodRoster();
  const view = await tableOp({ op: "seat", playerId: Number(playerId) });
  podPendingSeats.delete(playerId);
  renderPodRoster();
  if (view && podSelections.some(s => s.playerId === playerId)) openPodSeat(playerId);
}

// The seat leaves the table on the tap; the relay catches up behind it.
// Waiting for its reply (a few hundred milliseconds) before anything moved
// read as lag. Mirrors what the relay does to the pod: any earlier check is
// now stale and nothing is revealed. If the write fails, the table is read
// back fresh and the seat returns.
async function removePodSeat(playerId) {
  const slot = podSelections.find(s => s.playerId === playerId);
  if (!slot || podPendingRemovals.has(playerId)) return;
  const name = podNameOf(slot);
  if (podEditingPlayerId === playerId) podEditingPlayerId = null;
  const leaving = playerId === myPodPlayerId() ? "You left the table" : `${name} left the table`;

  podPendingRemovals.add(playerId);
  podSelections = podSelections.filter(s => s.playerId !== playerId);
  if (liveTableCheck) liveTableStale = true;
  podRevealed = false;
  renderPodSlots();
  renderPodCheckResults();
  renderTonight();

  const view = await tableOp({ op: "unseat", playerId: Number(playerId) }, leaving);
  podPendingRemovals.delete(playerId);
  if (!view) {
    const fresh = await tableRequest("GET").catch(() => null);
    if (fresh) applyLiveTable(fresh);
  }
}

function clearPodTable() {
  podEditingPlayerId = null;
  tableOp({ op: "clear" }, "Table cleared");
}

async function runPodCheck() {
  if (podPendingCheck) return;
  podPendingCheck = true;
  renderPodCta();
  renderPodStatus();
  if (podUi) renderPodHub();
  await tableOp({ op: "check" });
  podPendingCheck = false;
  renderPodCta();
  renderPodStatus();
  if (podUi) renderPodHub();
}

function explainPodLock(slot) {
  const name = podNameOf(slot);
  showPodError(`${name} locked in their own deck. Only ${name} can change it.`, "note");
}

function tapPodSeat(playerId) {
  const slot = podSelections.find(s => s.playerId === playerId);
  if (!slot) return;
  if (podSeatLocked(slot)) { explainPodLock(slot); return; }
  if (podEditingPlayerId === playerId) closePodPanel();
  else openPodSeat(playerId);
}

function openPodSeat(playerId) {
  const i = podSelections.findIndex(s => s.playerId === playerId);
  if (i < 0 || podSeatLocked(podSelections[i])) return;
  const wasOpen = podEditingPlayerId !== null;
  podEditingPlayerId = playerId;
  renderPodSlots();
  if (wasOpen && !REDUCED_MOTION.matches) {
    podUi.panel.querySelector(".pod-decks")?.animate(
      [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
      { duration: 180, easing: "ease-out" }
    );
  }
  podUi.panel.querySelector(".pod-deck")?.focus({ preventScroll: true });
}

function closePodPanel() {
  if (podEditingPlayerId === null) return;
  const playerId = podEditingPlayerId;
  podEditingPlayerId = null;
  renderPodSlots();
  podSeatEls.get(playerId)?.zone.focus({ preventScroll: true });
}

// Seals a deck on the shared table. Closes the panel straight away -- the
// pick lands on every phone within a poll -- and settles a deck box into
// this seat's zone once the relay confirms it.
async function pickPodDeck(playerId, deckId) {
  const slot = podSelections.find(s => s.playerId === playerId);
  if (!slot) return;
  if (podEditingPlayerId === playerId) podEditingPlayerId = null;
  podPendingPicks.add(playerId);
  renderPodSlots();
  const view = await tableOp({ op: "pick", playerId: Number(playerId), deckId: Number(deckId) });
  podPendingPicks.delete(playerId);
  renderPodSlots();
  const box = view ? podSeatEls.get(playerId)?.box : null;
  if (box && !REDUCED_MOTION.matches) {
    box.animate([{ transform: "translateY(-10px) scale(1.08)", opacity: 0.4 }, { transform: "none", opacity: 1 }],
      { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }
}

function shakeFlaggedZones() {
  if (REDUCED_MOTION.matches) return;
  podSelections.forEach(slot => {
    if (podSeatState(slot) !== "flagged") return;
    podSeatEls.get(slot.playerId)?.box.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-3px)" }, { transform: "translateX(3px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(0)" }],
      { duration: 360, easing: "ease-out" }
    );
  });
}

function renderPodSlots() {
  // Not before initLiveTable: see the note above POD_MAX_SEATS.
  if (!podTableReady) return;
  const container = document.getElementById("pod-slots");
  if (!container) return;
  if (!podUi) podUi = buildPodTable(container);

  podCount = podSelections.length;
  const editIdx = podEditingPlayerId === null ? -1 : podSelections.findIndex(s => s.playerId === podEditingPlayerId);
  // The seat whose panel was open left the table, or its player just locked
  // in their own deck on their phone -- either way it's not ours to edit.
  if (editIdx < 0 || podSeatLocked(podSelections[editIdx])) podEditingPlayerId = null;
  editingSeatIndex = podEditingPlayerId === null ? null : editIdx;

  // Your own deck is picked on your corner's shelf while it shows, not in
  // the deck panel (addPodSeat opens that panel for whoever just sat).
  if (podEditingPlayerId !== null && podEditingPlayerId === myPodPlayerId() && podCornerVisible()) {
    podEditingPlayerId = null;
    editingSeatIndex = null;
  }

  renderPodZones();
  renderPodHub();
  renderPodRoster();
  renderPodStatus();
  renderPodPanel();
  renderPodCta();
  renderPodCorner();
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

// Popped open automatically once the table's check finds the whole pod in
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
  // title + button + padding, roughly -- plus the home-indicator inset a
  // bottom sheet adds under its button on touch (see .modal-card there).
  const card = modal.querySelector(".modal-card");
  const sheetInset = card ? Math.max(0, parseFloat(getComputedStyle(card).paddingBottom) - 24) : 0;
  const chromeHeight = 150 + sheetInset;
  const textHeight = 44;    // player name + deck name lines, per row
  const gapHeight = 12;
  const availableForImages = modalMaxHeight - chromeHeight - (rows * textHeight) - ((rows - 1) * gapHeight);
  // Capped at 260 -- a small pod (1-3 players, few rows) has plenty of
  // vertical room to spare, but a single giant image looks disproportionate
  // even though it'd technically still fit without scrolling.
  const imageHeight = Math.min(260, Math.max(70, Math.floor(availableForImages / rows)));

  grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  grid.style.setProperty("--reveal-img-height", `${imageHeight}px`);

  evaluated.forEach((entry, tileIndex) => {
    const tile = document.createElement("div");
    tile.className = "reveal-tile";
    // Dealt face-down, then turned over one after another (see
    // .reveal-tile's flip in style.css).
    tile.style.setProperty("--flip-index", String(Math.min(tileIndex, 8)));

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
  });

  // The pod passing is the moment worth a buzz -- only on the way in, not
  // when an already-open reveal re-renders.
  if (modal.hidden) haptic([10, 60, 16]);
  presentModal(modal);
}

function hideRevealModal() {
  const modal = document.getElementById("reveal-modal");
  dismissModal(modal);
}

document.getElementById("reveal-modal-close")?.addEventListener("click", hideRevealModal);
document.getElementById("reveal-modal")?.addEventListener("click", e => {
  if (e.target.id === "reveal-modal") hideRevealModal();
});

// ---------- closing ceremony ----------
// A paced, one-trophy-at-a-time walk through a concluded season's real
// winners, ending on a downloadable recap card. Deliberately a separate
// modal from #reveal-modal rather than a variant of it -- that one reveals
// every tile at once, independently; this one is tap/arrow-key-paced by
// design (see index.html's comment on #ceremony-modal), which isn't
// something to bolt onto the existing function without conditionals
// threaded through it.

let ceremonySteps = []; // achievements with a real winner, this season only
let ceremonyIndex = 0;

// Rendered recap videos (made with season-video/, compressed and committed
// under videos/), keyed by season id. A season listed here opens its
// ceremony on the video, with the paced steps one button away; any other
// season opens straight on the steps, same as before.
const CEREMONY_VIDEOS = {
  3: { src: "videos/season-3.mp4", poster: "videos/season-3.jpg" },
};

// "film" shows the video; "steps" shows the paced trophy walk-through.
function setCeremonyMode(mode) {
  const film = document.getElementById("ceremony-film");
  const video = document.getElementById("ceremony-video");
  const showFilm = mode === "film";
  if (film) film.hidden = !showFilm;
  if (!showFilm && video) video.pause();
  for (const id of ["ceremony-counter", "ceremony-nav"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = showFilm;
  }
  const filmRow = document.getElementById("ceremony-film-row");
  if (filmRow) filmRow.hidden = showFilm || !video?.getAttribute("src");
  if (showFilm) {
    document.getElementById("ceremony-step").hidden = true;
    document.getElementById("ceremony-recap").hidden = true;
  } else {
    renderCeremonyStep(ceremonyIndex);
  }
}

function isCeremonyFilmShowing() {
  const film = document.getElementById("ceremony-film");
  return !!film && !film.hidden;
}

// achievements: the same array loadAchievements() already rendered (see
// lastAchievementsData) -- no separate fetch. Skips any achievement with
// no winner: this is meant to feel like a celebration, not another list of
// "no data yet" cards.
function showClosingCeremonyModal(achievements, seasonLabel, seasonId) {
  const modal = document.getElementById("ceremony-modal");
  if (!modal) return;
  ceremonySteps = achievements.filter(a => a.winner);
  ceremonyIndex = 0;
  const title = document.getElementById("ceremony-title");
  if (title) title.textContent = `${seasonLabel} Closing Ceremony`;
  ceremonyTransitionTarget = null;
  const film = CEREMONY_VIDEOS[seasonId];
  const video = document.getElementById("ceremony-video");
  if (video) {
    // Only touch src when the season changes, so reopening the same
    // season's ceremony keeps the buffered video instead of refetching it.
    if (film && video.getAttribute("src") !== film.src) {
      video.src = film.src;
      video.poster = film.poster;
    } else if (!film && video.getAttribute("src")) {
      video.removeAttribute("src");
      video.removeAttribute("poster");
      video.load();
    }
  }
  setCeremonyMode(film ? "film" : "steps");
  ceremonySpring().jump(0);
  // Closing the sheet any way at all (X, backdrop, Escape, drag-down) must
  // stop the soundtrack, or it keeps playing behind the app.
  modal._beforeDismiss = () => video?.pause();
  presentModal(modal);
}

function hideClosingCeremonyModal() {
  const modal = document.getElementById("ceremony-modal");
  dismissModal(modal);
}

// index === ceremonySteps.length (one past the last trophy) renders the
// recap card instead of a trophy step -- see drawRecapCard.
function renderCeremonyStep(index) {
  ceremonyIndex = Math.max(0, Math.min(index, ceremonySteps.length));
  const counter = document.getElementById("ceremony-counter");
  const step = document.getElementById("ceremony-step");
  const recap = document.getElementById("ceremony-recap");
  const prevBtn = document.getElementById("ceremony-prev");
  const nextBtn = document.getElementById("ceremony-next");
  if (!step || !recap) return;

  prevBtn && (prevBtn.disabled = ceremonyIndex === 0);

  if (ceremonyIndex === ceremonySteps.length) {
    if (counter) counter.textContent = "Season Recap";
    step.hidden = true;
    step.innerHTML = "";
    recap.hidden = false;
    nextBtn && (nextBtn.hidden = true);
    const canvas = document.getElementById("ceremony-recap-canvas");
    const title = document.getElementById("ceremony-title");
    if (canvas) drawRecapCard(canvas, ceremonySteps, title ? title.textContent : "Season Recap");
    return;
  }

  nextBtn && (nextBtn.hidden = false);
  recap.hidden = true;
  step.hidden = false;
  step.innerHTML = "";
  if (counter) counter.textContent = `${ceremonyIndex + 1} / ${ceremonySteps.length}`;

  const achievement = ceremonySteps[ceremonyIndex];

  // Same foil-rimmed treatment as the pod reveal's art tiles (see
  // .reveal-tile-art-pair in style.css) for visual continuity with the
  // app's one other "big reveal" moment, wrapped around the emblem
  // instead of card art.
  const artWrap = document.createElement("div");
  artWrap.className = "reveal-tile-art-pair ceremony-art";
  if (achievement.emblem) {
    const img = document.createElement("img");
    img.className = "reveal-tile-art ceremony-emblem";
    img.src = achievement.emblem;
    img.alt = "";
    artWrap.appendChild(img);
  }
  step.appendChild(artWrap);

  const title = document.createElement("div");
  title.className = "trophy-title ceremony-trophy-title";
  title.textContent = achievement.title;
  step.appendChild(title);

  const winnerRow = document.createElement("div");
  winnerRow.className = "trophy-winner ceremony-winner";
  const name = document.createElement("span");
  name.className = "trophy-winner-name";
  name.textContent = achievement.winner.name;
  const value = document.createElement("span");
  value.className = "trophy-winner-value";
  value.textContent = achievement.winner.display;
  winnerRow.appendChild(name);
  winnerRow.appendChild(value);
  step.appendChild(winnerRow);
}

// Steps slide like pages: forward leaves to the left and the next trophy
// arrives from the right, back does the mirror image, whether that was a
// swipe, a tap, Next/Previous or an arrow key -- one spatial model for
// all of them. A swipe hands its release velocity to the slide so the
// page carries on at the finger's speed.
let ceremonyTransitionTarget = null; // set while the old step slides out
// Created on first use: Spring is defined further down this file.
let ceremonySpringInstance = null;
function ceremonySpring() {
  return ceremonySpringInstance ||= new Spring(0, x => renderCeremonyOffset(x));
}

// The step or the recap, whichever is showing.
function ceremonyPane() {
  const step = document.getElementById("ceremony-step");
  return step && !step.hidden ? step : document.getElementById("ceremony-recap");
}

function renderCeremonyOffset(x) {
  const pane = ceremonyPane();
  if (!pane) return;
  if (!x) {
    pane.style.transform = "";
    pane.style.opacity = "";
    return;
  }
  // Fades as it travels, gone by the time it's swapped for the next step,
  // so the swap itself is never seen.
  const fadeDistance = (pane.offsetWidth || 300) * 0.6;
  // Turns on its vertical axis as it goes, like a card being flipped past
  // -- the leading edge swings away in the direction of travel.
  const turn = -x / (pane.offsetWidth || 300) * 30;
  pane.style.transform = `perspective(900px) translate3d(${x}px, 0, 0) rotateY(${turn}deg)`;
  pane.style.opacity = String(Math.max(0, 1 - Math.abs(x) / fadeDistance));
}

function clearCeremonyOffsets() {
  for (const id of ["ceremony-step", "ceremony-recap"]) {
    const el = document.getElementById(id);
    if (el) { el.style.transform = ""; el.style.opacity = ""; }
  }
}

// A slide already under way lands at once, so the next one starts from a
// settled step rather than chaining onto a half-finished one.
function finishCeremonyTransition() {
  if (ceremonyTransitionTarget === null) return;
  const target = ceremonyTransitionTarget;
  ceremonyTransitionTarget = null;
  clearCeremonyOffsets();
  renderCeremonyStep(target);
  ceremonySpring().jump(0);
}

function advanceCeremony(delta, velocity = 0) {
  finishCeremonyTransition();
  const next = Math.max(0, Math.min(ceremonyIndex + delta, ceremonySteps.length));
  if (next === ceremonyIndex) {
    // Nothing further this way: settle back to rest.
    ceremonySpring().to(0, { response: 0.3, velocity });
    return;
  }
  const pane = ceremonyPane();
  if (REDUCED_MOTION.matches || !pane) {
    renderCeremonyStep(next);
    ceremonySpring().jump(0);
    return;
  }
  const direction = Math.sign(delta);
  const travel = pane.offsetWidth * 0.6;
  ceremonyTransitionTarget = next;
  ceremonySpring().to(-direction * travel, {
    response: 0.24,
    velocity,
    onRest: () => {
      if (ceremonyTransitionTarget !== next) return;
      ceremonyTransitionTarget = null;
      clearCeremonyOffsets();
      renderCeremonyStep(next);
      ceremonySpring().jump(direction * travel);
      ceremonySpring().to(0, { response: 0.38 });
    },
  });
}

// Swipe between trophies: the step follows the finger 1:1 once the drag is
// clearly sideways (a vertical drag belongs to the sheet), resists at the
// first trophy and the recap, and on release the flick's projected landing
// point -- not where the finger let go -- decides whether to turn the page.
function wireCeremonySwipe() {
  const tracker = createVelocityTracker();
  let start = null;
  let tracking = false;
  let grabX = 0;
  let grabOffset = 0;
  let suppressClickUntil = 0;

  for (const pane of [document.getElementById("ceremony-step"), document.getElementById("ceremony-recap")]) {
    if (!pane) continue;
    pane.addEventListener("touchstart", (e) => {
      start = null;
      if (e.touches.length !== 1) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      tracking = false;
    }, { passive: true });

    pane.addEventListener("touchmove", (e) => {
      if (!start) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!tracking) {
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { start = null; return; }
        if (Math.abs(dx) < 10) return;
        tracking = true;
        finishCeremonyTransition();
        ceremonySpring().stop();
        grabX = t.clientX;
        grabOffset = ceremonySpring().value;
        tracker.reset();
      }
      e.preventDefault();
      const raw = grabOffset + (t.clientX - grabX);
      const width = ceremonyPane()?.offsetWidth || 300;
      const atStart = ceremonyIndex === 0 && raw > 0;
      const atEnd = ceremonyIndex === ceremonySteps.length && raw < 0;
      const x = atStart || atEnd ? Math.sign(raw) * rubberband(Math.abs(raw), width) : raw;
      tracker.add(t.clientX, e.timeStamp);
      ceremonySpring().set(x);
    }, { passive: false });

    const release = () => {
      start = null;
      if (!tracking) return;
      tracking = false;
      suppressClickUntil = performance.now() + 350;
      const velocity = tracker.velocity();
      const width = ceremonyPane()?.offsetWidth || 300;
      const projected = ceremonySpring().value + projectMomentum(velocity);
      if (projected < -width * 0.25) advanceCeremony(1, velocity);
      else if (projected > width * 0.25) advanceCeremony(-1, velocity);
      else ceremonySpring().to(0, { dampingRatio: REDUCED_MOTION.matches ? 1 : 0.8, response: 0.3, velocity });
    };
    pane.addEventListener("touchend", release);
    pane.addEventListener("touchcancel", release);
  }
  return () => performance.now() < suppressClickUntil;
}

// One layout, used both for the on-screen preview (drawn straight into
// #ceremony-recap-canvas) and the download -- no separate HTML version to
// keep in sync. Text-only, no emblem thumbnails, deliberately: rasterizing
// same-origin emblem PNGs onto a canvas is very likely fine (no CORS
// taint), but doing that reliably across this app's real devices (it's a
// PWA, including on mobile Safari) is a bigger, separate thing to get
// right than the recap itself -- worth adding once this text-only version
// is confirmed working, not bundled into it speculatively.
function drawRecapCard(canvas, wonAchievements, seasonLabel) {
  const width = 1080;
  const startY = 230;
  const bottomPadding = 60;
  // Fixed per-row height (title line + detail line + breathing room),
  // not a fixed canvas height divided by row count -- with up to 36 rows,
  // dividing a fixed height produced rows too short for two lines of text
  // to fit without overlapping (confirmed the hard way on Season 2's real
  // 34-row recap). The canvas grows to fit instead, so a row is never
  // cramped regardless of how many trophies a season handed out.
  const rowHeight = 52;
  const height = startY + rowHeight * Math.max(wonAchievements.length, 1) + bottomPadding;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue("--bg").trim() || "#0b0a10";
  const ink = styles.getPropertyValue("--ink").trim() || "#f2efe9";
  const muted = styles.getPropertyValue("--muted").trim() || "#9e97ac";
  const accent = styles.getPropertyValue("--accent").trim() || "#a48bff";
  const displayFont = "Saira Condensed, Arial Narrow, sans-serif";
  const bodyFont = "IBM Plex Sans, Segoe UI, sans-serif";

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = accent;
  ctx.font = `700 34px ${displayFont}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(seasonLabel.toUpperCase(), 60, 90);

  ctx.fillStyle = ink;
  ctx.font = `700 56px ${displayFont}`;
  ctx.fillText("TROPHY RECAP", 60, 150);

  let y = startY;
  for (const a of wonAchievements) {
    ctx.fillStyle = ink;
    ctx.font = `600 28px ${displayFont}`;
    ctx.fillText(a.title, 60, y);

    ctx.fillStyle = accent;
    ctx.font = `600 24px ${bodyFont}`;
    ctx.textAlign = "right";
    ctx.fillText(a.winner.name, width - 60, y);
    ctx.textAlign = "left";

    ctx.fillStyle = muted;
    ctx.font = `400 18px ${bodyFont}`;
    ctx.fillText(a.winner.display, 60, y + 26);

    y += rowHeight;
  }

  const downloadLink = document.getElementById("ceremony-recap-download");
  if (downloadLink) downloadLink.href = canvas.toDataURL("image/png");
}

document.getElementById("ceremony-modal-close")?.addEventListener("click", hideClosingCeremonyModal);
document.getElementById("ceremony-modal")?.addEventListener("click", e => {
  if (e.target.id === "ceremony-modal") hideClosingCeremonyModal();
});
document.getElementById("ceremony-step-through")?.addEventListener("click", () => setCeremonyMode("steps"));
document.getElementById("ceremony-watch-film")?.addEventListener("click", () => setCeremonyMode("film"));
document.getElementById("ceremony-prev")?.addEventListener("click", () => advanceCeremony(-1));
document.getElementById("ceremony-next")?.addEventListener("click", () => advanceCeremony(1));
// Tap-to-advance anywhere on the step itself, not just the Next button --
// this is meant to be flicked through at a table, one thumb.
const ceremonyJustSwiped = wireCeremonySwipe();
document.getElementById("ceremony-step")?.addEventListener("click", () => {
  if (!ceremonyJustSwiped()) advanceCeremony(1);
});

function hideComboTrackModal() {
  const modal = document.getElementById("combo-track-modal");
  dismissModal(modal);
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

  presentModal(modal);
}

document.getElementById("combo-track-modal-close")?.addEventListener("click", hideComboTrackModal);
document.getElementById("combo-track-modal-cancel")?.addEventListener("click", hideComboTrackModal);
document.getElementById("combo-track-modal")?.addEventListener("click", e => {
  if (e.target.id === "combo-track-modal") hideComboTrackModal();
});

function hideCloseSeasonModal() {
  const modal = document.getElementById("close-season-modal");
  dismissModal(modal);
}

function showCloseSeasonConfirm() {
  const modal = document.getElementById("close-season-modal");
  const confirmBtn = document.getElementById("close-season-modal-confirm");
  if (!modal || !confirmBtn) return;

  // Reassigning .onclick (not addEventListener) guarantees exactly one
  // handler is ever live -- same reasoning as showComboTrackConfirm above.
  confirmBtn.onclick = async () => {
    hideCloseSeasonModal();
    await closeSeason();
  };

  presentModal(modal);
}

async function closeSeason() {
  const statusEl = document.getElementById("achievements-status");
  try {
    const res = await fetch(SEASON_CLOSE_RELAY_URL, { method: "POST", headers: authHeaders() });
    if (res.status === 401) {
      showAuthStatusHint("Sign in with Discord to do this.");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadAchievements(); // immediately reflects the now-closed state
  } catch (err) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = `Couldn't close the season (${err.message}).`;
    }
  }
}

document.getElementById("close-season-modal-close")?.addEventListener("click", hideCloseSeasonModal);
document.getElementById("close-season-modal-cancel")?.addEventListener("click", hideCloseSeasonModal);
document.getElementById("close-season-modal")?.addEventListener("click", e => {
  if (e.target.id === "close-season-modal") hideCloseSeasonModal();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closePodPanel();
    hideRevealModal();
    hideComboTrackModal();
    hideClosingCeremonyModal();
    hideCloseSeasonModal();
    hideTrophyDetailModal();
    hideCaseCardModal();
    hideAuthMenu();
  }
  // Guarded on the modal actually being open so these never hijack arrow
  // keys anywhere else in the app (e.g. a select box, a number input).
  const ceremonyModal = document.getElementById("ceremony-modal");
  // Not while the video is showing: there the arrows belong to the
  // player's own seek controls.
  if (isModalOpen(ceremonyModal) && !isCeremonyFilmShowing()) {
    if (e.key === "ArrowRight") advanceCeremony(1);
    else if (e.key === "ArrowLeft") advanceCeremony(-1);
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

  // Decks close together used to print their names on top of each other
  // ("Red Becca Mate Michelle"). Each label takes the lowest row where it
  // clears the label before it; GAUGE_LABEL_GAP is roughly one short name's
  // width as a share of a phone-width track.
  const GAUGE_LABEL_GAP = 18;
  const GAUGE_ROW_PX = 16;
  const placed = judgedEntries
    .map(entry => ({ entry, pct: Math.min(100, Math.max(0, ((entry.power - floor) / totalSpan) * 100)) }))
    .sort((a, b) => a.pct - b.pct);
  const rowEnds = [];
  for (const p of placed) {
    let row = rowEnds.findIndex(end => p.pct - end >= GAUGE_LABEL_GAP);
    if (row === -1) row = rowEnds.length < 3 ? rowEnds.length : rowEnds.indexOf(Math.min(...rowEnds));
    rowEnds[row] = p.pct;
    p.row = row;
  }
  const rows = Math.max(1, rowEnds.length);
  wrap.style.paddingTop = `${34 + GAUGE_ROW_PX * (rows - 1)}px`;
  if (placed.some(p => !p.entry.compatible)) wrap.style.paddingBottom = `${GAUGE_ROW_PX * rows}px`;

  for (const { entry, pct, row } of placed) {
    const marker = document.createElement("div");
    marker.className = "gauge-marker " + (entry.compatible ? "ok" : "over");
    marker.style.left = `${pct}%`;
    // Labels at either end lean inward instead of hanging off the card.
    const shift = pct < 10 ? "-20%" : pct > 90 ? "-80%" : "-50%";

    const label = document.createElement("span");
    label.className = "dot-label";
    label.textContent = entry.playerName;
    label.style.top = `${-26 - GAUGE_ROW_PX * row}px`;
    label.style.transform = `translateX(${shift})`;
    marker.appendChild(label);

    if (!entry.compatible) {
      const val = document.createElement("span");
      val.className = "dot-value";
      val.textContent = `+${formatPower(entry.overBy)}`;
      val.style.bottom = `${-20 - GAUGE_ROW_PX * row}px`;
      val.style.transform = `translateX(${shift})`;
      marker.appendChild(val);
    }
    track.appendChild(marker);
  }

  wrap.appendChild(track);
  return wrap;
}

// The results card under the table, drawn from the relay's last check so
// every phone shows the same verdict. Same masking as ever: until the pod
// passes it names players and whether they're in range, never their decks
// or raw power -- the gauge plots each deck's distance above the floor
// (the relay's `rel`), which is all the gauge ever showed.
function renderPodCheckResults() {
  const resultsSection = document.getElementById("results-section");
  const resultsDiv = document.getElementById("results");
  if (!resultsSection || !resultsDiv) return;
  const check = liveTableCheck;
  // Rebuilt only when the verdict, its staleness or what it may name has
  // changed -- not on every poll and pick, which re-laid it all out.
  const revealedDecks = podRevealed ? podSelections.map(s => s.deckId).join(",") : "";
  const signature = JSON.stringify([check ? check.id : null, liveTableStale, podRevealed, revealedDecks, podPlayers.length]);
  if (resultsDiv.dataset.signature === signature) return;
  resultsDiv.dataset.signature = signature;
  resultsDiv.innerHTML = "";
  resultsSection.hidden = !check;
  if (!check) return;

  const banner = document.createElement("div");
  if (check.allExempt) {
    banner.className = "banner warn";
    banner.textContent = "Every deck here is new — nothing to validate yet. Go ahead and play!";
  } else {
    const exemptNote = check.exemptCount > 0
      ? ` (${check.exemptCount} new deck${check.exemptCount === 1 ? "" : "s"} exempt — no games logged yet.)`
      : "";
    banner.className = "banner " + (check.passed ? "good" : "bad");
    banner.textContent = (check.passed
      ? `All decks are within range (spread: ${formatPower(check.spread)}).`
      : `Spread is ${formatPower(check.spread)} — outside the ±${check.tolerance} target. Some decks need to change.`) + exemptNote;
  }
  resultsDiv.appendChild(banner);

  const nameOf = id => podPlayers.find(p => String(p.id) === String(id))?.name || "A player";
  const entries = check.entries.map(e => ({ ...e, playerName: nameOf(e.playerId) }));
  const judged = entries.filter(e => !e.exempt).map(e => ({ ...e, power: e.rel }));
  if (judged.length > 0) resultsDiv.appendChild(buildPowerGauge(judged, 0, check.tolerance));

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "result-row " + (entry.exempt ? "exempt" : (entry.compatible ? "ok" : "out"));
    row.dataset.playerId = entry.playerId;
    // A check the pod has since moved on from (someone joined, left or
    // re-picked) reads as pending until someone checks again.
    if (liveTableStale) row.classList.add("pending-recheck");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.playerName;
    // Decks are only named once the whole pod has passed -- the same moment
    // the relay starts telling every phone which deck each seat holds.
    const slot = podSelections.find(s => s.playerId === String(entry.playerId));
    const deck = podRevealed && slot ? podDeckOf(slot) : null;
    if (deck) {
      const deckNameSpan = document.createElement("span");
      deckNameSpan.className = "result-deck-name";
      deckNameSpan.textContent = ` — ${deck.name}`;
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
      box.textContent = `${entry.playerName} needs a new deck, then check the spread again.`;
      resultsDiv.appendChild(box);
    }
  }
}

// A pass on any phone plays the reveal on every phone: the deck boxes open
// and the d20 rolls first, then "To the Game!" opens over it. A timer, not
// an animation event, so it opens even if the animation is skipped; dropped
// if the pod changes before it fires.
function schedulePodReveal(checkId) {
  // Long enough for the d20 to start rolling, not to finish: a longer
  // wait read as the check itself being slow.
  const delay = REDUCED_MOTION.matches ? 0 : Math.min(800, 300 + podSelections.length * 60);
  setTimeout(() => {
    if (!podRevealed || !liveTableCheck || liveTableCheck.id !== checkId) return;
    const evaluated = podSelections.map(slot => {
      const player = podPlayerOf(slot);
      const deck = podDeckOf(slot);
      if (!player || !deck) return null;
      return {
        playerId: player.id, playerName: player.name, deckId: deck.id, deckName: deck.name,
        power: deck.power, newDeck: !!deck.newDeck, colorIdentity: deck.colorIdentity,
      };
    }).filter(Boolean);
    if (evaluated.length > 0) showRevealModal(evaluated);
  }, delay);
}

// The button under the table does whatever the pod needs next -- take a
// seat, pick your deck, check the spread, or clear the table. See
// renderPodCta for its label.
document.getElementById("validate-btn").addEventListener("click", handlePodCta);

// ---------- fluid motion: springs, momentum, haptics ----------
// Anything a finger can grab (sheets, pull-to-refresh) or that slides
// between places (the tab and segmented-control indicators) runs on these
// instead of CSS transitions. A CSS transition restarts from its target
// when interrupted; a spring re-targeted mid-flight keeps its current value
// AND velocity, so it can be grabbed, reversed or redirected at any moment
// without a jump. Hand-rolled rather than a library (web-animation rule 9).
//
// Tuned in Apple's two designer-facing terms rather than mass/stiffness:
// dampingRatio 1 settles with no overshoot, below 1 overshoots (keep that
// for releases that carried momentum, e.g. a flicked sheet); response is
// roughly how long it takes to get there, in seconds -- not a duration.
class Spring {
  constructor(value, onUpdate, precision = 0.25) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.onUpdate = onUpdate;
    this.precision = precision; // "close enough to rest", in value units
    this.raf = 0;
    this.safety = 0;
    this.onRest = null;
  }

  to(target, { dampingRatio = 1, response = 0.35, velocity, onRest = null } = {}) {
    this.stop();
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    this.onRest = onRest;
    const stiffness = (2 * Math.PI / response) ** 2;
    const damping = 4 * Math.PI * dampingRatio / response;
    let last = performance.now();
    const tick = (now) => {
      // Clamped: a long frame (or the first one, whose timestamp can
      // predate `last`) shouldn't fling the integrator.
      const dt = Math.min(Math.max(0, now - last) / 1000, 1 / 30);
      last = now;
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const accel = -stiffness * (this.value - this.target) - damping * this.velocity;
        this.velocity += accel * (dt / steps);
        this.value += this.velocity * (dt / steps);
      }
      if (Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 10) {
        this.settle();
        return;
      }
      this.onUpdate(this.value);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    // rAF stops in a background tab, and nothing may wait on a spring
    // landing (web-animation rule 2) -- by 2.5x response even an
    // under-damped spring is within a fraction of a pixel, so land it.
    this.safety = setTimeout(() => this.settle(), (response * 2.5 + 0.2) * 1000);
  }

  // Follow a finger: no physics, just the value. Keeps the last velocity so
  // a later to() can be handed the release velocity explicitly.
  set(value) {
    this.stop();
    this.value = value;
    this.target = value;
    this.onUpdate(value);
  }

  jump(value) {
    this.set(value);
    this.velocity = 0;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.safety);
    this.raf = 0;
    this.safety = 0;
  }

  settle() {
    this.stop();
    this.value = this.target;
    this.velocity = 0;
    this.onUpdate(this.value);
    const done = this.onRest;
    this.onRest = null;
    if (done) done();
  }
}

// Release velocity from the last ~100ms of a drag, in px/s. Just the last
// two events would be noisy; the whole gesture would lag a late flick.
function createVelocityTracker() {
  const samples = [];
  return {
    reset() { samples.length = 0; },
    add(pos, time) {
      samples.push({ pos, time });
      while (samples.length > 2 && time - samples[0].time > 100) samples.shift();
    },
    velocity() {
      if (samples.length < 2) return 0;
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = (b.time - a.time) / 1000;
      return dt > 0 ? (b.pos - a.pos) / dt : 0;
    },
  };
}

// Where a flick would coast to under scroll-like deceleration -- Apple's
// own projection (Designing Fluid Interfaces), not v^2/2a. Deciding from
// the projected point rather than the release point is what lets a short,
// fast flick dismiss a sheet that's barely moved.
function projectMomentum(velocity, decelerationRate = 0.998) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

// Past a boundary the element follows less and less the further it's
// pulled, instead of stopping dead -- "responsive, but nothing more here".
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// Android only in practice (iOS Safari has no Vibration API), and only on
// the few commit moments that earn it: a pull crossing the refresh
// threshold, and a pod passing. Fired on the same frame as the visual.
function haptic(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    // Blocked without a prior user gesture -- the visual still lands.
  }
}

// ---------- selection indicators ----------
// One highlight that slides from the old choice to the new one, instead of
// the old one switching off and a new one switching on somewhere else --
// the eye follows it, so where you went is never in doubt. Used for both
// tab bars and every segmented control (.view-toggle, .theme-toggle).
//
// Whoever owns the control keeps toggling .active exactly as before; a
// MutationObserver notices and moves the indicator, so no call site had to
// change. Resizes and the first showing (a control inside a hidden panel
// measures as nothing) jump straight to place rather than animating.
function attachSelectionIndicator(group, { itemSelector, className, stretch = false, scrub = null }) {
  const indicator = document.createElement("span");
  indicator.className = className;
  indicator.setAttribute("aria-hidden", "true");
  group.appendChild(indicator);
  group.classList.add("has-indicator");

  let x = 0;
  let width = 0;
  let visible = false;
  const render = () => {
    // stretch: a thin bar whose width follows the item (top tab underline,
    // items differ in width) -- scaleX of a 1px box, so it stays a
    // transform. Otherwise items are equal width, so only x moves.
    indicator.style.transform = stretch
      ? `translate3d(${x}px, 0, 0) scaleX(${width})`
      : `translate3d(${x}px, 0, 0)`;
    if (!stretch) indicator.style.width = `${width}px`;
  };
  const xSpring = new Spring(0, v => { x = v; render(); });
  const wSpring = new Spring(0, v => { width = v; render(); });

  const update = (animate) => {
    const active = group.querySelector(`${itemSelector}.active`);
    if (!active || !active.offsetWidth) {
      if (visible) indicator.style.opacity = "0";
      visible = false;
      return;
    }
    const nextX = active.offsetLeft;
    const nextW = active.offsetWidth;
    if (!stretch) {
      indicator.style.top = `${active.offsetTop}px`;
      indicator.style.height = `${active.offsetHeight}px`;
    }
    if (!animate || !visible || REDUCED_MOTION.matches) {
      xSpring.jump(nextX);
      wSpring.jump(nextW);
    } else {
      xSpring.to(nextX, { response: 0.38 });
      if (stretch) wSpring.to(nextW, { response: 0.38 });
      else wSpring.jump(nextW);
    }
    if (!visible) indicator.style.opacity = "1";
    visible = true;
  };

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    // Batched to the next frame: one tab switch flips .active on several
    // buttons, which should read as one move, not a tug-of-war.
    requestAnimationFrame(() => { queued = false; update(true); });
  }).observe(group, { subtree: true, attributes: true, attributeFilter: ["class"] });
  if ("ResizeObserver" in window) new ResizeObserver(() => update(false)).observe(group);
  update(false);
  if (scrub) wireIndicatorScrub(group, itemSelector, xSpring, () => visible, scrub);
}

// Press and slide along the bar: the capsule leaves its tab and follows the
// thumb 1:1, the tab under it lights up with a tick each time it crosses
// into a new one, and letting go snaps it to the nearest tab -- with a
// little of the flick's momentum, so a quick throw carries one tab further
// -- and switches there. Pulling past either end rubber-bands. A plain tap
// is untouched: the scrub only starts once a drag is clearly sideways.
function wireIndicatorScrub(group, itemSelector, xSpring, isVisible, onPick) {
  const tracker = createVelocityTracker();
  let start = null;
  let tracking = false;
  let grabX = 0;
  let fromX = 0;
  let under = null;
  let suppressClickUntil = 0;
  const items = () => [...group.querySelectorAll(itemSelector)];
  const nearest = (x) => {
    let best = null;
    let bestDistance = Infinity;
    for (const item of items()) {
      const distance = Math.abs(item.offsetLeft - x);
      if (distance < bestDistance) { best = item; bestDistance = distance; }
    }
    return best;
  };
  const setUnder = (item) => {
    if (item === under) return;
    if (under) under.classList.remove("is-under");
    if (item) item.classList.add("is-under");
    if (under && item) haptic(4); // a detent each time it crosses into the next tab
    under = item;
  };

  group.addEventListener("touchstart", (e) => {
    start = e.touches.length === 1 && isVisible() ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    tracking = false;
  }, { passive: true });

  group.addEventListener("touchmove", (e) => {
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!tracking) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { start = null; return; }
      if (Math.abs(dx) < 10) return;
      tracking = true;
      xSpring.stop();
      fromX = xSpring.value;
      grabX = t.clientX;
      group.classList.add("is-scrubbing");
      tracker.reset();
    }
    e.preventDefault();
    const list = items();
    const min = list[0].offsetLeft;
    const max = list[list.length - 1].offsetLeft;
    let x = fromX + (t.clientX - grabX);
    if (x < min) x = min - rubberband(min - x, group.offsetWidth);
    else if (x > max) x = max + rubberband(x - max, group.offsetWidth);
    tracker.add(t.clientX, e.timeStamp);
    xSpring.set(x);
    setUnder(nearest(x));
  }, { passive: false });

  const end = () => {
    start = null;
    if (!tracking) return;
    tracking = false;
    group.classList.remove("is-scrubbing");
    setUnder(null);
    suppressClickUntil = performance.now() + 350;
    const velocity = tracker.velocity();
    // A fraction of the full projection: the tabs sit close together, and
    // a scroll-strength coast would fling it to the end of the bar.
    const target = nearest(xSpring.value + projectMomentum(velocity) * 0.3);
    xSpring.to(target.offsetLeft, { dampingRatio: REDUCED_MOTION.matches ? 1 : 0.8, response: 0.32, velocity });
    if (!target.classList.contains("active")) onPick(target);
  };
  group.addEventListener("touchend", end);
  group.addEventListener("touchcancel", end);
  // Lifting the finger over a tab mustn't also count as tapping it.
  group.addEventListener("click", (e) => {
    if (performance.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

function initSelectionIndicators() {
  const topTabs = document.getElementById("main-tabs");
  if (topTabs) attachSelectionIndicator(topTabs, { itemSelector: ".tab-btn", className: "tab-indicator", stretch: true });
  const bottomTabs = document.getElementById("bottom-tabs");
  if (bottomTabs) {
    attachSelectionIndicator(bottomTabs, {
      itemSelector: ".bottom-tab-btn",
      className: "bottom-tab-indicator",
      scrub: item => activateTab(item.dataset.tab),
    });
  }
  document.querySelectorAll(".view-toggle").forEach(group => {
    attachSelectionIndicator(group, { itemSelector: ".view-toggle-btn", className: "segment-thumb" });
  });
  document.querySelectorAll(".theme-toggle").forEach(group => {
    attachSelectionIndicator(group, { itemSelector: ".theme-toggle-btn", className: "segment-thumb" });
  });
  // Saira Condensed arriving (display=swap) re-measures every tab label.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => window.dispatchEvent(new Event("resize")));
  }
}

// ---------- sheets (every .modal-overlay) ----------
// On touch every modal is a bottom sheet: it rises from the bottom edge
// and leaves the same way (enter and exit along one path), and it can be
// dragged down to dismiss -- 1:1 with the finger from wherever it was
// grabbed, rubber-banding if pushed up, and on release it projects the
// flick's momentum to decide between closing and snapping back, then hands
// the finger's velocity to the spring so there's no seam. A closing sheet
// can be grabbed again mid-flight. With a mouse it stays a centred dialog
// that grows from the control that opened it and shrinks back into it.
//
// Every show*/hide* modal function goes through presentModal/dismissModal
// instead of flipping [hidden] itself. The end state never waits on the
// animation: dismissModal's [hidden] lands from the spring's own safety
// timeout even if rAF never runs (web-animation rule 2).
const SHEET_LAYOUT = window.matchMedia("(pointer: coarse)");
const sheetStates = new Map();

function sheetFor(overlay) {
  let s = sheetStates.get(overlay);
  if (s) return s;
  const card = overlay.querySelector(".modal-card");
  s = { overlay, card, open: false, dragging: false, opener: null, height: 1, suppressClickUntil: 0 };
  s.spring = new Spring(0, p => renderSheet(s, p), 0.0005);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.tabIndex = -1;
  wireSheetDrag(s);
  sheetStates.set(overlay, s);
  return s;
}

function renderSheet(s, p) {
  const { overlay, card } = s;
  const shown = Math.min(1, Math.max(0, p));
  overlay.style.setProperty("--scrim-opacity", String(shown));
  if (p === 1 && !s.dragging) {
    card.style.transform = "";
    card.style.opacity = "";
    return;
  }
  if (REDUCED_MOTION.matches) {
    // A cross-fade, not a slide: no vestibular motion, same timing.
    card.style.transform = "";
    card.style.opacity = String(shown);
  } else if (SHEET_LAYOUT.matches) {
    card.style.opacity = "";
    card.style.transform = `translate3d(0, ${(1 - p) * s.height}px, 0)`;
  } else {
    card.style.opacity = String(shown);
    card.style.transform = `scale(${0.9 + 0.1 * p})`;
  }
}

function isModalOpen(overlay) {
  const s = overlay && sheetStates.get(overlay);
  return !!overlay && !overlay.hidden && (!s || s.open);
}

function presentModal(overlay) {
  if (!overlay) return;
  const s = sheetFor(overlay);
  const wasHidden = overlay.hidden;
  if (!s.open && (wasHidden || !s.opener)) s.opener = document.activeElement;
  s.open = true;
  overlay.hidden = false;
  syncModalInert();
  const heading = s.card.querySelector("h2");
  if (heading) {
    if (!heading.id) heading.id = `${overlay.id}-title`;
    s.card.setAttribute("aria-labelledby", heading.id);
  }
  if (wasHidden) {
    s.card.style.transform = "";
    s.height = s.card.offsetHeight || 1;
    // Grow out of whatever opened it (dialog layout only -- a sheet always
    // comes from the bottom edge).
    const opener = s.opener instanceof Element && s.opener !== document.body ? s.opener.getBoundingClientRect() : null;
    const card = s.card.getBoundingClientRect();
    s.card.style.transformOrigin = opener && opener.width
      ? `${opener.left + opener.width / 2 - card.left}px ${opener.top + opener.height / 2 - card.top}px`
      : "";
    s.spring.jump(0);
    s.card.focus({ preventScroll: true });
  }
  s.spring.to(1, { dampingRatio: 1, response: SHEET_LAYOUT.matches ? 0.42 : 0.3 });
}

function dismissModal(overlay, { velocity = 0 } = {}) {
  if (!overlay || overlay.hidden) return;
  const s = sheetStates.get(overlay);
  if (!s) { overlay.hidden = true; return; }
  if (!s.open) return;
  s.open = false;
  // A modal that borrowed something from the page (the trophy zoom) hands
  // it back on its way out, however it was closed.
  if (overlay._beforeDismiss) overlay._beforeDismiss();
  s.spring.to(0, {
    dampingRatio: 1,
    response: SHEET_LAYOUT.matches ? 0.36 : 0.22,
    velocity,
    onRest: () => {
      if (s.open) return; // grabbed again and re-opened mid-flight
      overlay.hidden = true;
      s.card.style.transform = "";
      s.card.style.opacity = "";
      syncModalInert();
      const opener = s.opener;
      s.opener = null;
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    },
  });
}

// While any modal is up, the page behind it can't be tabbed into or read
// out -- the focus containment aria-modal promises. Derived from the DOM
// every time rather than counted, so it can't drift out of step.
function syncModalInert() {
  const anyOpen = [...document.querySelectorAll(".modal-overlay")].some(o => !o.hidden);
  for (const el of [document.querySelector(".wrap"), document.getElementById("bottom-tabs")]) {
    if (el) el.inert = anyOpen;
  }
}

function wireSheetDrag(s) {
  const { card, overlay } = s;
  const tracker = createVelocityTracker();
  let start = null;
  let tracking = false;
  let grabY = 0;
  let grabOffset = 0;

  const offsetFromValue = () => (1 - s.spring.value) * s.height;

  card.addEventListener("touchstart", (e) => {
    start = null;
    if (!SHEET_LAYOUT.matches || e.touches.length !== 1 || overlay.hidden) return;
    if (e.target.closest("input, select, textarea")) return;
    // Content scrolled down inside the sheet: this drag scrolls it back up
    // first. Only once it's at the top does dragging down move the sheet.
    for (let el = e.target; el && el !== overlay; el = el.parentElement) {
      if (el.scrollTop > 0) return;
    }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    tracking = false;
  }, { passive: true });

  card.addEventListener("touchmove", (e) => {
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!tracking) {
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        // Up or sideways: not a dismiss. Hand it back to native scrolling
        // once it's clearly meant (10px), not on the first jitter.
        if (Math.hypot(dx, dy) > 10) start = null;
        return;
      }
      // Downward at the top of the sheet: nothing native to lose (it would
      // only overscroll), so claim it now and commit after 10px.
      e.preventDefault();
      if (dy < 10) return;
      tracking = true;
      s.dragging = true;
      s.spring.stop();
      s.height = s.card.offsetHeight || 1;
      // Respect where it was grabbed -- including a sheet caught halfway
      // through closing.
      grabY = t.clientY;
      grabOffset = offsetFromValue();
      tracker.reset();
    }
    e.preventDefault();
    const raw = grabOffset + (t.clientY - grabY);
    const offset = raw >= 0 ? raw : -rubberband(-raw, s.height);
    tracker.add(t.clientY, e.timeStamp);
    s.spring.set(1 - offset / s.height);
  }, { passive: false });

  const release = () => {
    start = null;
    if (!tracking) return;
    tracking = false;
    s.dragging = false;
    s.suppressClickUntil = performance.now() + 350;
    const velocity = tracker.velocity(); // px/s, + is downward
    const offset = offsetFromValue();
    const projected = offset + projectMomentum(velocity);
    // The spring works in "fraction open", so velocity converts the same way.
    const springVelocity = -velocity / s.height;
    if (projected > s.height * 0.5) {
      s.open = true; // so dismissModal doesn't treat it as already closing
      dismissModal(overlay, { velocity: springVelocity });
    } else {
      s.open = true;
      overlay.hidden = false;
      // Settles back with a little give -- the release carried momentum.
      s.spring.to(1, { dampingRatio: REDUCED_MOTION.matches ? 1 : 0.8, response: 0.32, velocity: springVelocity });
    }
  };
  card.addEventListener("touchend", release);
  card.addEventListener("touchcancel", release);

  // A drag that ends over a button (or the ceremony's tap-to-advance step)
  // mustn't also count as a tap on it.
  card.addEventListener("click", (e) => {
    if (performance.now() < s.suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

// ---------- scroll edge ----------
// Content scrolls up under the iOS status bar (viewport-fit=cover). Once it
// does, a soft frosted band fades in behind the clock so the two never
// collide -- only where floating chrome actually overlaps content, and
// only while it does, instead of a permanent bar. Zero height (inert)
// wherever there's no top safe area.
function initScrollEdge() {
  let queued = false;
  const sync = () => {
    queued = false;
    document.documentElement.classList.toggle("is-scrolled", (window.scrollY || document.documentElement.scrollTop) > 4);
  };
  window.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sync);
  }, { passive: true });
  sync();
}

// ---------- re-sorts (FLIP) ----------
// A sort re-renders the list from scratch, so every row used to jump to its
// new place and the eye lost track of who moved where. glideReorder wraps
// that re-render: it notes where each keyed row ([data-flip-key]) is on
// screen, lets the render happen, then starts each row at its old spot and
// springs it home -- reading the old spot from the live layout, so a second
// sort mid-glide starts from wherever the rows actually are. Bars
// ([data-flip-bar], a fill with a % width) stretch from their old length
// to the new one the same way. Only for sorts the user asked for; a data
// refresh re-renders in place (web-animation rule 7).
function glideReorder(container, render) {
  if (!container || REDUCED_MOTION.matches) { render(); return; }
  const before = new Map();
  container.querySelectorAll("[data-flip-key]").forEach(el => {
    const fill = el.querySelector("[data-flip-bar]");
    before.set(el.dataset.flipKey, {
      top: el.getBoundingClientRect().top,
      bar: fill ? fill.getBoundingClientRect().width : null,
    });
  });
  render();
  container.querySelectorAll("[data-flip-key]").forEach(el => {
    const was = before.get(el.dataset.flipKey);
    if (!was) return;
    const dy = was.top - el.getBoundingClientRect().top;
    if (Math.abs(dy) >= 1) {
      // Rows crossing paths would pile up as unreadable overlapping text,
      // so a travelling row dims toward the middle of its trip and is
      // fully solid again at both ends (1 - 0.6 * 4p(1-p), p = progress).
      new Spring(dy, v => {
        const p = Math.min(1, Math.max(0, 1 - Math.abs(v / dy)));
        el.style.transform = v ? `translate3d(0, ${v}px, 0)` : "";
        el.style.opacity = v ? String(1 - 2.4 * p * (1 - p)) : "";
      }).to(0, { response: 0.4 });
    }
    const fill = el.querySelector("[data-flip-bar]");
    const now = fill ? fill.getBoundingClientRect().width : 0;
    if (fill && was.bar !== null && now > 0 && Math.abs(was.bar - now) >= 1) {
      fill.style.transformOrigin = "left center";
      new Spring(was.bar / now, v => { fill.style.transform = v === 1 ? "" : `scaleX(${v})`; }, 0.002).to(1, { response: 0.45 });
    }
  });
}

// "No" -- the head-shake a Mac login window gives a wrong password: a
// spring kicked sideways with nowhere to go but back, under-damped so it
// shudders a couple of times and stops. Paired with a buzz on the same
// frame; reduced motion keeps the buzz and the message, drops the shake.
function shakeNo(el) {
  haptic([18, 50, 18]);
  if (!el || REDUCED_MOTION.matches) return;
  const spring = el._shakeSpring ||= new Spring(0, v => { el.style.transform = Math.abs(v) < 0.1 ? "" : `translate3d(${v}px, 0, 0)`; });
  // A button's own transform transition would smear the shake into a slow
  // wobble; the spring is the only animator while it runs.
  el.style.transition = "none";
  spring.to(0, { dampingRatio: 0.22, response: 0.16, velocity: -650, onRest: () => { el.style.transition = ""; } });
}

// ---------- numeric text transitions ----------
// A count or percentage that changes rolls to its new value -- up when it
// grew, down when it shrank -- instead of the digits silently flipping, so
// a change is noticed and its direction read at a glance (what iOS calls a
// numeric content transition). Keyed, because most of these elements are
// rebuilt on every render: the key remembers what was on screen last time.
// The first showing, an unchanged value, or anything non-numeric just sets
// the text. The final text never waits on the animation (rule 2).
const rolledValues = new Map();

function rollText(el, text, key = el) {
  text = String(text);
  const previous = rolledValues.get(key);
  rolledValues.set(key, text);
  const from = parseFloat(previous);
  const to = parseFloat(text);
  if (previous === undefined || previous === text || Number.isNaN(from) || Number.isNaN(to) || from === to || REDUCED_MOTION.matches || !el.animate) {
    el.textContent = text;
    return;
  }
  const direction = to > from ? 1 : -1;
  const box = document.createElement("span");
  box.className = "roll";
  const out = document.createElement("span");
  out.textContent = previous;
  out.setAttribute("aria-hidden", "true");
  const into = document.createElement("span");
  into.textContent = text;
  box.append(out, into);
  el.replaceChildren(box);
  const timing = { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "both" };
  out.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${-direction * 70}%)`, opacity: 0 }], timing);
  into.animate([{ transform: `translateY(${direction * 70}%)`, opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], timing);
  const settle = () => { if (rolledValues.get(key) === text && el.firstChild === box) el.textContent = text; };
  setTimeout(settle, 380);
}

// ---------- completion ----------
// A submit that landed draws a check on the button that sent it, with a
// success buzz on the same frame -- the moment is tied to the control you
// pressed, not just a status line further down. Only a `from` frame on the
// stroke, so if the animation never runs the check is simply there.
function celebrateButton(button, label) {
  if (!button) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("done-check");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
  path.setAttribute("pathLength", "1");
  svg.appendChild(path);
  const text = document.createElement("span");
  text.textContent = label;
  button.replaceChildren(svg, text);
  button.classList.add("is-done");
  haptic([10, 40, 22]);
}

// ---------- first load: skeleton -> content ----------
// The shaped placeholders (renderSkeletonCards) used to be swapped for the
// real list in one frame. The first time real content replaces them, it
// settles in instead. Only that first arrival -- later refreshes re-render
// in place (rule 7), and a container is only watched while it holds
// skeletons.
const skeletonWatchers = new WeakSet();

function watchSkeletonArrival(container) {
  container.dataset.skeleton = "1";
  if (skeletonWatchers.has(container)) return;
  skeletonWatchers.add(container);
  new MutationObserver(() => {
    if (container.dataset.skeleton !== "1" || container.querySelector(".skeleton-card")) return;
    delete container.dataset.skeleton;
    if (REDUCED_MOTION.matches || !container.children.length) return;
    container.classList.add("content-arriving");
    setTimeout(() => container.classList.remove("content-arriving"), 450);
  }).observe(container, { childList: true });
}

// ---------- compact title bar ----------
// iOS large titles: once a tab's own heading has scrolled up out of view,
// a slim frosted bar slides in at the top with the tab's name, so "where
// am I?" always has an answer. Tapping the name glides back to the top
// (the web has no tappable status bar); on a page reached from Tonight it
// also carries a back chevron. Hidden (and inert) whenever the heading
// itself is on screen.
function activePanel() {
  return [...document.querySelectorAll(".tab-panel")].find(p => !p.hidden) || null;
}

// Where "back" goes from the open panel, or null when it's a top-level tab.
function backTargetFor(panel) {
  if (!panel) return null;
  const link = panel.querySelector("[data-goto-tab]");
  if (link) return link.dataset.gotoTab;
  return panel.id === "tab-proposals" ? "tonight" : null;
}

function panelTitle(panel) {
  const name = panel.id.replace(/^tab-/, "");
  const tabBtn = document.querySelector(`.bottom-tab-btn[data-tab="${name}"] .bottom-tab-label`);
  if (tabBtn) return tabBtn.textContent.trim();
  const h2 = panel.querySelector(".card h2");
  return h2 ? h2.textContent.trim() : "";
}

function syncCompactBar() {
  const bar = document.getElementById("compact-bar");
  const wrap = document.querySelector(".wrap");
  if (!bar || !wrap) return;
  const panel = activePanel();
  // The heading that names this screen: the tab's own card title, or the
  // app title on Tonight, which has none.
  const heading = panel && (panel.querySelector(".card h2") || document.querySelector("header h1"));
  // Scroll-linked rather than a switch: the bar fades in over the ~28px the
  // heading takes to slide under it, so scrolling slowly scrubs the
  // handover and scrolling back reverses it exactly.
  const barHeight = bar.offsetHeight;
  const progress = !wrap.hidden && heading
    ? Math.min(1, Math.max(0, (barHeight + 8 - heading.getBoundingClientRect().bottom) / 28))
    : 0;
  const show = progress > 0;
  bar.style.opacity = show ? String(progress) : "";
  bar.style.transform = show && !REDUCED_MOTION.matches ? `translate3d(0, ${(1 - progress) * -10}px, 0)` : "";
  if (show) {
    document.getElementById("compact-bar-title").textContent = panelTitle(panel);
    const back = backTargetFor(panel);
    const backBtn = document.getElementById("compact-bar-back");
    backBtn.hidden = !back;
    backBtn.dataset.target = back || "";
  }
  bar.classList.toggle("is-shown", show);
  bar.inert = !show;
  bar.setAttribute("aria-hidden", String(!show));
}

function initCompactBar() {
  const bar = document.getElementById("compact-bar");
  if (!bar) return;
  document.getElementById("compact-bar-title").addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: REDUCED_MOTION.matches ? "auto" : "smooth" });
  });
  document.getElementById("compact-bar-back").addEventListener("click", (e) => {
    const target = e.currentTarget.dataset.target;
    if (target) activateTab(target);
  });
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncCompactBar(); });
  };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  queue();
}

// ---------- edge swipe back ----------
// Installed to the home screen, iOS gives a web app no back gesture at all;
// the only way out of Games to Update, New Players/Decks or Proposals was
// the small back link at the top. A swipe in from the left edge now does
// it: a back arrow follows the thumb out of the edge (rubber-banding past
// its reach), fills in and ticks once letting go will go back, and the
// release projects the flick's momentum before deciding. Only in the
// installed app -- in a browser tab, that same edge swipe is the browser's
// own history-back, and the two must not both fire.
const EDGE_ZONE = 24; // px from the left edge a back swipe must start in
const EDGE_BACK_ENABLED = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

function edgeBackTarget() {
  if (!EDGE_BACK_ENABLED || document.querySelector(".modal-overlay:not([hidden])")) return null;
  return backTargetFor(activePanel());
}

// Whether a touch starting here belongs to the back swipe -- the pull-to-
// refresh gesture defers to it, so a diagonal thumb can't trigger both.
function edgeBackClaims(x) {
  return x < EDGE_ZONE && !!edgeBackTarget();
}

function initEdgeBack() {
  if (!EDGE_BACK_ENABLED) return;
  const arrow = document.createElement("div");
  arrow.className = "edge-back";
  arrow.setAttribute("aria-hidden", "true");
  arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg>';
  document.body.appendChild(arrow);

  const REACH = 64; // px the arrow travels out before it starts resisting
  const ARM_AT = 96; // px of finger travel that arms the back
  const tracker = createVelocityTracker();
  let start = null;
  let tracking = false;
  let armed = false;
  let target = null;
  const render = (x) => {
    const shown = Math.max(0, x);
    arrow.style.opacity = String(Math.min(1, shown / 24));
    arrow.style.transform = `translate3d(${shown - 52}px, -50%, 0) scale(${0.7 + 0.3 * Math.min(1, shown / REACH)})`;
  };
  const spring = new Spring(0, render);
  render(0);

  document.addEventListener("touchstart", (e) => {
    start = null;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!edgeBackClaims(t.clientX)) return;
    start = { x: t.clientX, y: t.clientY };
    target = edgeBackTarget();
    tracking = false;
    armed = false;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!tracking) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { start = null; return; }
      if (dx < 10) return;
      tracking = true;
      spring.stop();
      arrow.style.top = `${t.clientY}px`;
      tracker.reset();
    }
    e.preventDefault();
    tracker.add(t.clientX, e.timeStamp);
    const x = dx <= REACH ? dx : REACH + rubberband(dx - REACH, 120);
    spring.set(x);
    const nowArmed = dx >= ARM_AT;
    if (nowArmed !== armed) {
      armed = nowArmed;
      arrow.classList.toggle("armed", armed);
      if (armed) haptic(8);
    }
  }, { passive: false });

  const release = () => {
    if (!start || !tracking) { start = null; return; }
    const dx = spring.value;
    const velocity = tracker.velocity();
    start = null;
    tracking = false;
    const go = armed || (dx + projectMomentum(velocity) > ARM_AT * 1.4 && velocity > 0);
    armed = false;
    arrow.classList.remove("armed");
    spring.to(0, { response: 0.3, velocity: -Math.abs(velocity) * 0.2 });
    if (go && target) activateTab(target);
  };
  document.addEventListener("touchend", release);
  document.addEventListener("touchcancel", release);
}

// ---------- trophy tilt (mouse) ----------
// With a mouse, a Trophy Case card leans toward the pointer and a soft
// light follows it across the face, like a foil card turned in the hand
// (or a tvOS poster under focus). X and Y tilt are separate springs, so it
// tracks smoothly and settles flat when the pointer leaves. Mouse only:
// on touch the card just presses in. Off under reduced motion.
function initTrophyTilt() {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const MAX_TILT = 7; // degrees
  let current = null;
  const springsFor = (card) => {
    if (card._tilt) return card._tilt;
    const state = { rx: 0, ry: 0 };
    const render = () => {
      card.style.transform = Math.abs(state.rx) < 0.02 && Math.abs(state.ry) < 0.02
        ? ""
        : `perspective(700px) rotateX(${state.rx}deg) rotateY(${state.ry}deg)`;
    };
    card._tilt = {
      x: new Spring(0, v => { state.rx = v; render(); }, 0.02),
      y: new Spring(0, v => { state.ry = v; render(); }, 0.02),
    };
    return card._tilt;
  };
  const release = (card) => {
    if (!card) return;
    card.classList.remove("is-tilting");
    const s = springsFor(card);
    s.x.to(0, { response: 0.45 });
    s.y.to(0, { response: 0.45 });
  };
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || REDUCED_MOTION.matches) return;
    const card = e.target instanceof Element ? e.target.closest(".tc-card") : null;
    if (card !== current) {
      release(current);
      current = card;
    }
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    card.classList.add("is-tilting");
    card.style.setProperty("--sheen-x", `${((nx + 1) / 2) * 100}%`);
    card.style.setProperty("--sheen-y", `${((ny + 1) / 2) * 100}%`);
    const s = springsFor(card);
    s.x.to(-ny * MAX_TILT, { response: 0.3 });
    s.y.to(nx * MAX_TILT, { response: 0.3 });
  });
  document.addEventListener("pointerleave", () => { release(current); current = null; });
}

// ---------- shared-element zoom ----------
// Opening a trophy's detail flies its emblem out of the card you tapped
// and into the sheet, landing exactly where the sheet's own emblem sits;
// closing flies it back into the card -- however the sheet is closed,
// including a drag. A stand-in copy does the flying while both real
// emblems are hidden, so neither is ever seen twice. It homes in on the
// destination's live position every frame, so it tracks the sheet as it
// rises or falls rather than aiming at where it will end up. Lands from
// the spring's own safety timeout too, so neither emblem can stay hidden.
function flyElement(from, to, { onLand } = {}) {
  if (!from || !to || REDUCED_MOTION.matches || !from.isConnected || !to.isConnected) {
    if (onLand) onLand();
    return;
  }
  const start = from.getBoundingClientRect();
  if (!start.width || !start.height) { if (onLand) onLand(); return; }
  const ghost = from.cloneNode(true);
  ghost.removeAttribute("id");
  ghost.classList.add("flying-ghost");
  Object.assign(ghost.style, {
    visibility: "visible", // the original may already be hidden by its owner
    left: `${start.left}px`,
    top: `${start.top}px`,
    width: `${start.width}px`,
    height: `${start.height}px`,
  });
  document.body.appendChild(ghost);
  from.style.visibility = "hidden";
  to.style.visibility = "hidden";
  const place = (q) => {
    const end = to.getBoundingClientRect();
    const x = (end.left - start.left) * q;
    const y = (end.top - start.top) * q;
    const sx = 1 + ((end.width || start.width) / start.width - 1) * q;
    const sy = 1 + ((end.height || start.height) / start.height - 1) * q;
    ghost.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`;
  };
  const spring = new Spring(0, place, 0.001);
  spring.to(1, {
    response: 0.46,
    onRest: () => {
      ghost.remove();
      to.style.visibility = "";
      from.style.visibility = "";
      if (onLand) onLand();
    },
  });
}

function trophyEmblemIn(root) {
  return root ? root.querySelector(".trophy-emblem, .trophy-icon") : null;
}

// Wired by showTrophyDetailModal on a fresh open from a card.
function zoomTrophyDetail(modal, id, from) {
  const card = from || document.querySelector(`.tc-card[data-id="${CSS.escape(String(id))}"]`);
  const source = trophyEmblemIn(card);
  const detailEmblem = () => trophyEmblemIn(document.querySelector("#trophy-detail-body .mtg-card.is-inspected"));
  if (!source || !detailEmblem()) return;
  // While the detail is open the card's emblem is "in" the sheet.
  source.style.visibility = "hidden";
  flyElement(source, detailEmblem(), { onLand: () => {
    if (isModalOpen(modal)) source.style.visibility = "hidden";
  } });
  modal._beforeDismiss = () => {
    modal._beforeDismiss = null;
    const back = detailEmblem();
    if (source.isConnected && back) flyElement(back, source);
    else source.style.visibility = "";
  };
}

// ---------- pointer hover highlight (mouse) ----------
// With a mouse, one soft highlight glides from item to item as the pointer
// moves along the top tabs or down the avatar menu -- the iPadOS pointer
// "lifting" whatever it's over -- instead of each item lighting up and
// going dark on its own. Fades in where the pointer enters, fades out when
// it leaves the group. Mouse only; jumps under reduced motion.
function attachHoverHighlight(group, itemSelector) {
  const pill = document.createElement("span");
  pill.className = "hover-pill";
  pill.setAttribute("aria-hidden", "true");
  group.appendChild(pill);
  group.classList.add("has-hover-pill");
  const box = { x: 0, y: 0, w: 0, h: 0 };
  const render = () => {
    pill.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
    pill.style.width = `${box.w}px`;
    pill.style.height = `${box.h}px`;
  };
  const springs = {};
  for (const k of ["x", "y", "w", "h"]) springs[k] = new Spring(0, v => { box[k] = v; render(); });
  let shown = false;
  group.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const item = e.target instanceof Element ? e.target.closest(itemSelector) : null;
    if (!item || !group.contains(item)) return;
    const target = { x: item.offsetLeft, y: item.offsetTop, w: item.offsetWidth, h: item.offsetHeight };
    for (const k of Object.keys(springs)) {
      if (!shown || REDUCED_MOTION.matches) springs[k].jump(target[k]);
      else springs[k].to(target[k], { response: 0.28 });
    }
    shown = true;
    pill.classList.add("is-shown");
  });
  group.addEventListener("pointerleave", () => {
    shown = false;
    pill.classList.remove("is-shown");
  });
}

function initHoverHighlights() {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  const tabs = document.getElementById("main-tabs");
  if (tabs) attachHoverHighlight(tabs, ".tab-btn");
  const menu = document.getElementById("auth-menu");
  if (menu) attachHoverHighlight(menu, ".auth-menu-item");
}

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
  const switching = panel.hidden;
  const previous = [...document.querySelectorAll(".tab-panel")].find(p => !p.hidden);
  document.querySelectorAll(".tab-btn, .bottom-tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(`[data-tab="${tabName}"]`).forEach(b => b.classList.add("active"));
  document.querySelectorAll(".tab-panel").forEach(p => { p.hidden = true; });
  panel.hidden = false;
  // Same id scheme as the tab panel (#bg-<tab> next to #tab-<tab>).
  const bgEl = document.getElementById(`bg-${tabName}`);
  crossfadeTabBackground(bgEl);
  // Re-tapping the tab you're already on glides back to the top, as every
  // iOS tab bar does; an actual switch lands there instantly.
  window.scrollTo({ top: 0, behavior: switching || REDUCED_MOTION.matches ? "auto" : "smooth" });
  if (switching) playTabEnter(panel, previous);
  if (tabName === "pod") pollLiveTable(true);
  if (tabName === "tonight") pollLiveTable(true);
  // Standings always opens on the league; a dossier is somewhere you go
  // from there, not somewhere the tab remembers.
  if (tabName === "winrates" && switching) {
    if (dossierPlayerName) {
      dossierPlayerName = null;
      document.getElementById("winrates-dossier").hidden = true;
      document.getElementById("winrates-league").hidden = false;
    }
    drawLeagueRace();
  }
  syncCompactBar();
}

// Swaps the active .tab-bg. The new layer shows instantly underneath and
// only the old one fades out on top -- never two layers fading at once,
// which is what glitched in Brave (see the .tab-bg comment in style.css).
// The end state never waits on the animation: the old layer is cleared on
// animationend or after a timeout, whichever comes first.
function crossfadeTabBackground(bgEl) {
  const previous = document.querySelector(".tab-bg.active");
  document.querySelectorAll(".tab-bg.tab-bg-leaving").forEach(bg => bg.classList.remove("tab-bg-leaving"));
  document.querySelectorAll(".tab-bg").forEach(bg => bg.classList.remove("active"));
  if (bgEl) bgEl.classList.add("active");
  if (!previous || previous === bgEl || REDUCED_MOTION.matches) return;
  previous.classList.add("tab-bg-leaving");
  const finish = () => previous.classList.remove("tab-bg-leaving");
  previous.addEventListener("animationend", finish, { once: true });
  setTimeout(finish, 400);
}

// The new tab's content settles in (see .tab-entering in style.css). Only
// on a real switch -- re-tapping the current tab, or a data refresh
// re-rendering it, plays nothing (web-animation rule 7).
// Left-to-right in the order the tab bar shows them. Panels reached from
// another one (Tonight's to-dos, the avatar menu's Proposals) sit just
// past their way in, so opening one reads as going forward and the back
// link as coming back.
const TAB_SEQUENCE = { tonight: 0, "games-to-update": 0.5, "update-app": 0.5, pod: 1, winrates: 2, achievements: 3, proposals: 4 };

function playTabEnter(panel, previous) {
  if (REDUCED_MOTION.matches) return;
  // Content arrives from the side of the tab you tapped -- the same way
  // the indicator under the tab bar just moved -- rather than always
  // rising from below. Same 0.2s, same small distance.
  const from = previous ? TAB_SEQUENCE[previous.id.replace(/^tab-/, "")] : undefined;
  const to = TAB_SEQUENCE[panel.id.replace(/^tab-/, "")];
  const direction = from === undefined || to === undefined || from === to ? 0 : Math.sign(to - from);
  panel.style.setProperty("--tab-enter-x", `${direction * 18}px`);
  panel.style.setProperty("--tab-enter-y", direction ? "0px" : "6px");
  panel.classList.remove("tab-entering");
  void panel.offsetWidth; // restart the animation if switched back quickly
  panel.classList.add("tab-entering");
  clearTimeout(panel._enterTimer);
  panel._enterTimer = setTimeout(() => panel.classList.remove("tab-entering"), 300);
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
  // Short enough to sit on one line at phone width; the tab's intro line
  // says what each one is.
  { key: "adjusted", label: "Adjusted" },
  { key: "playgroup", label: "playgroup.gg" },
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
//
// The whole row is a button into that player's dossier (openDossier).
function buildWinRateCard(row, rank, sortKey, direction, race) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "wr-card";
  card.dataset.flipKey = row.name;
  card.addEventListener("click", () => openDossier(row.name, card));

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
  // Pinned trophies sit inside the name so .wr-name's flex:1 still owns
  // the row's free space. Rows are keyed by name, not id (see
  // renderWinRatesTable), hence the name lookup.
  const pins = players.find(p => p.name === row.name)?.pinnedTrophies || [];
  if (pins.length) {
    const pinsEl = document.createElement("span");
    pinsEl.className = "wr-pins";
    for (const t of pins) {
      const img = document.createElement("img");
      img.className = "wr-pin";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = t.emblem;
      img.alt = t.title;
      img.title = t.title;
      pinsEl.appendChild(img);
    }
    nameEl.appendChild(pinsEl);
  }
  // How the night's race went for them (raceCaption), under the name.
  const caption = isAdjusted ? raceCaption(race, row.name) : null;
  if (caption) {
    const nameBlock = document.createElement("span");
    nameBlock.className = "wr-name-block";
    const captionEl = document.createElement("span");
    captionEl.className = `wr-caption ${caption.tone}`;
    captionEl.textContent = caption.text;
    nameBlock.append(nameEl, captionEl);
    header.appendChild(nameBlock);
  } else {
    header.appendChild(nameEl);
  }

  // The caption already says which way they moved, over a whole night.
  if (row.adjPct !== null && direction && !caption) {
    const trendEl = document.createElement("span");
    trendEl.className = `wr-trend ${TREND_CLASS[direction]}`;
    trendEl.title = "Whether this player's rank in the Player Adjusted Win Rate standings moved compared to before their most recent logged game";
    trendEl.textContent = TREND_SYMBOL[direction];
    header.appendChild(trendEl);
  }

  const primaryValEl = document.createElement("span");
  primaryValEl.className = "wr-metric-value";
  rollText(primaryValEl, primaryPct !== null ? `${primaryPct.toFixed(1)}%` : "—", `wr:${row.name}`);
  header.appendChild(primaryValEl);
  const go = document.createElement("span");
  go.className = "wr-go";
  go.innerHTML = tonightSvg('<path d="m9 18 6-6-6-6"></path>');
  header.appendChild(go);
  card.appendChild(header);

  const meter = document.createElement("div");
  meter.className = "wr-meter";
  if (primaryPct !== null) {
    const bar = document.createElement("div");
    bar.className = "wr-bar";
    const fill = document.createElement("div");
    fill.className = "wr-bar-fill";
    fill.dataset.flipBar = "";
    fill.style.width = `${Math.max(0, Math.min(100, primaryPct))}%`;
    bar.appendChild(fill);
    meter.appendChild(bar);

    const form = buildFormStrip(row.name);
    if (form) meter.appendChild(form);

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
  const race = computeLeagueRace();

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
    glideReorder(tableEl, () => renderWinRatesTable(playgroupGamesData));
  });
  tableEl.appendChild(sortBar);

  const list = document.createElement("div");
  list.className = "wr-card-list";
  for (const row of rowData) {
    list.appendChild(buildWinRateCard(row, rankByName[row.name] ?? null, sortKey, trendByPlayer[row.name], race));
  }
  tableEl.appendChild(list);

  const raceEl = document.getElementById("winrates-race");
  if (raceEl) {
    raceEl.innerHTML = "";
    const chart = buildLeagueRace(race);
    if (chart) raceEl.appendChild(chart);
  }
  if (dossierPlayerName) renderDossier();

  statusEl.textContent = `Live as of ${new Date(data.generated_at).toLocaleTimeString()} (playgroup.gg data may be cached up to 5 min).`;
  noteEl.innerHTML = "";
  const note = document.createElement("span");
  note.className = "note-line";
  note.textContent = `Scoped to the active league (${data.league || "unknown"}). Player Adjusted Win Rate is computed live from the current season's Game Log.`;
  noteEl.appendChild(note);
}

// ---------- dossiers ----------
// Standings tell the season's story: the league race above the table is
// everyone's adjusted rank game night by game night, and each row opens a
// dossier on that player -- their rivals, their decks, their rank by night
// and their pinned trophies. All of it from the same current-season Game
// Log rows the table already reads; nothing new is fetched.

// The newest nights the race draws. More than this and eight lines get too
// tangled to follow on a phone.
const RACE_NIGHTS = 8;
// Whose dossier is open, by name (the table is keyed by name too).
let dossierPlayerName = null;
// The row that opened it, to hand focus back to on the way out.
let dossierOpener = null;

function signedInPlayerName() {
  return currentUser && players.length
    ? (players.find(p => p.id === currentUser.playerId) || {}).name || null
    : null;
}

// A game night is a calendar day, in this phone's time zone.
function gameNightKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatNightKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function ordinal(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return `${n}${suffix}`;
}

// Every standings player's position after each of the last RACE_NIGHTS game
// nights, counting every game up to and including that night. Positions,
// not the table's competition ranks: a line needs a row of its own, so a
// tie breaks by name. null before a player's first game of the season.
// -> { nights: ["2026-10-01", ...], ranks: { name: [pos|null, ...] } }
function computeLeagueRace() {
  const tracked = new Set(podPlayers.map(p => p.name));
  const rows = gameLogSeason3Rows.filter(r => typeof r.J === "number" && tracked.has(r.player) && gameNightKey(r.date));
  const nights = [...new Set(rows.map(r => gameNightKey(r.date)))].sort().slice(-RACE_NIGHTS);
  const names = [...new Set(rows.map(r => r.player))];
  const ranks = Object.fromEntries(names.map(n => [n, []]));
  for (const night of nights) {
    const upTo = rows.filter(r => gameNightKey(r.date) <= night);
    const rated = names
      .map(name => {
        const own = upTo.filter(r => r.player === name);
        return own.length ? { name, rate: computePlayerAdjustedWinRate(own).B } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.rate - a.rate || a.name.localeCompare(b.name));
    const pos = Object.fromEntries(rated.map((r, i) => [r.name, i + 1]));
    for (const name of names) ranks[name].push(pos[name] ?? null);
  }
  return { nights, ranks };
}

// One line under a player's name in the table: how the last game night
// moved them. The leader gets how long they've held it instead.
function raceCaption(race, name) {
  const line = race && race.ranks[name];
  if (!line || race.nights.length < 2) return null;
  const now = line[line.length - 1];
  const before = line[line.length - 2];
  if (now === null) return null;
  if (now === 1) {
    let held = 0;
    for (let i = line.length - 1; i >= 0 && line[i] === 1; i--) held++;
    if (held >= 2) return { text: `1st for ${held} nights`, tone: "trend-up" };
  }
  if (before === null) return { text: "New on the board", tone: "trend-steady" };
  if (now < before) return { text: `Up ${before - now} last night`, tone: "trend-up" };
  if (now > before) return { text: `Down ${now - before} last night`, tone: "trend-down" };
  return { text: `Held ${ordinal(now)} last night`, tone: "trend-steady" };
}

// Last five results, oldest first so the newest sits nearest the rate.
function buildFormStrip(name) {
  const results = gameLogSeason3Rows
    .filter(r => r.player === name && typeof r.J === "number")
    .sort((a, b) => a.gameNum - b.gameNum)
    .slice(-5)
    .map(r => r.result === 1);
  if (!results.length) return null;
  const strip = document.createElement("span");
  strip.className = "wr-form";
  strip.setAttribute("role", "img");
  strip.setAttribute("aria-label", `Last ${results.length === 1 ? "game" : results.length + " games"}: ${results.map(w => (w ? "win" : "loss")).join(", ")}`);
  for (const won of results) {
    const pip = document.createElement("span");
    pip.className = won ? "wr-form-pip is-win" : "wr-form-pip";
    strip.appendChild(pip);
  }
  return strip;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

// The league race: a bump chart on the playmat, one line per player in
// their sleeve colour, yours in gold and drawn last so it's never buried.
// Needs two nights to be a race at all.
function buildLeagueRace(race) {
  if (!race || race.nights.length < 2) return null;
  const names = Object.keys(race.ranks).filter(n => race.ranks[n].some(r => r !== null));
  if (names.length < 2) return null;
  const me = signedInPlayerName();
  const rowGap = 26, top = 16, left = 30, right = 62, width = 340;
  const height = top + (names.length - 1) * rowGap + 34;
  const stepX = (width - left - right) / (race.nights.length - 1);
  const x = i => left + i * stepX;
  const y = pos => top + (pos - 1) * rowGap;

  const wrap = document.createElement("div");
  wrap.className = "race";
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", role: "img" });

  const finalOrder = names
    .map(n => ({ name: n, pos: race.ranks[n][race.ranks[n].length - 1] }))
    .sort((a, b) => a.pos - b.pos);
  svg.setAttribute("aria-label",
    `Adjusted rank after each of the last ${race.nights.length} game nights, ${formatNightKey(race.nights[0])} to ${formatNightKey(race.nights[race.nights.length - 1])}. ` +
    `Now: ${finalOrder.map(r => `${ordinal(r.pos)} ${r.name}`).join(", ")}.`);

  const grid = svgEl("g", { class: "race-grid" });
  for (let pos = 1; pos <= names.length; pos++) {
    grid.appendChild(svgEl("path", { d: `M${left - 4} ${y(pos)}H${width - right + 4}` }));
    const label = svgEl("text", { x: 0, y: y(pos) + 3, class: "race-axis" });
    label.textContent = ordinal(pos);
    grid.appendChild(label);
  }
  race.nights.forEach((night, i) => {
    const label = svgEl("text", { x: x(i), y: height - 6, "text-anchor": "middle", class: "race-axis" });
    // Every night labelled gets crowded past five; first, last and every
    // other one between.
    const every = race.nights.length > 5 ? 2 : 1;
    if (i === 0 || i === race.nights.length - 1 || (i % every === 0 && i < race.nights.length - 2)) {
      label.textContent = formatNightKey(night);
      grid.appendChild(label);
    }
  });
  svg.appendChild(grid);

  const ordered = [...names.filter(n => n !== me), ...names.filter(n => n === me)];
  for (const name of ordered) {
    const line = race.ranks[name];
    const points = line.map((pos, i) => (pos === null ? null : `${x(i)},${y(pos)}`)).filter(Boolean);
    const player = podPlayers.find(p => p.name === name);
    const g = svgEl("g", { class: name === me ? "race-line is-me" : "race-line" });
    if (name !== me && player) g.style.setProperty("--line", podSleeveOf(player.id));
    g.appendChild(svgEl("polyline", { points: points.join(" "), pathLength: 1 }));
    const last = line[line.length - 1];
    g.appendChild(svgEl("circle", { cx: x(line.length - 1), cy: y(last), r: name === me ? 5 : 4.5 }));
    const label = svgEl("text", { x: x(line.length - 1) + 10, y: y(last) + 4, class: "race-name" });
    label.textContent = name === me ? "You" : name;
    g.appendChild(label);
    svg.appendChild(g);
  }
  wrap.appendChild(svg);
  return wrap;
}

// The lines draw themselves in left to right when you arrive on Standings
// -- a real tab switch only, never on a data refresh (rule 7). The chart
// is complete without it: the class only adds the reveal on top.
function drawLeagueRace() {
  const race = document.querySelector("#winrates-race .race");
  if (!race || REDUCED_MOTION.matches) return;
  race.classList.remove("is-drawing");
  void race.offsetWidth;
  race.classList.add("is-drawing");
  clearTimeout(race._drawTimer);
  race._drawTimer = setTimeout(() => race.classList.remove("is-drawing"), 1400);
}

// Head-to-head over shared pods this season. Nemesis: whoever won the most
// pods this player sat in. Favourite prey: whoever sat in the most pods
// this player won. Ties go to the higher share of shared pods.
function computeRivals(name) {
  const byGame = new Map();
  for (const r of gameLogSeason3Rows) {
    if (typeof r.gameNum !== "number") continue;
    if (!byGame.has(r.gameNum)) byGame.set(r.gameNum, []);
    byGame.get(r.gameNum).push(r);
  }
  const tracked = new Set(podPlayers.map(p => p.name));
  const vs = {};
  for (const rows of byGame.values()) {
    if (!rows.some(r => r.player === name)) continue;
    const winner = (rows.find(r => r.result === 1) || {}).player;
    for (const r of rows) {
      if (r.player === name || !tracked.has(r.player)) continue;
      const v = vs[r.player] ||= { name: r.player, shared: 0, theyWon: 0, iWon: 0 };
      v.shared++;
      if (winner === r.player) v.theyWon++;
      if (winner === name) v.iWon++;
    }
  }
  const pick = key => Object.values(vs)
    .filter(v => v[key] > 0)
    .sort((a, b) => b[key] - a[key] || b[key] / b.shared - a[key] / a.shared || a.name.localeCompare(b.name))[0] || null;
  return { nemesis: pick("theyWon"), prey: pick("iWon") };
}

// This season's decks for a player, most played first, from the Game Log's
// commander column, matched back to their deck list for colours and the
// combo watch.
function computeDossierDecks(name) {
  const player = podPlayers.find(p => p.name === name);
  const byDeck = new Map();
  for (const r of gameLogSeason3Rows) {
    if (r.player !== name || !r.commander) continue;
    const d = byDeck.get(r.commander) || { name: r.commander, games: 0, wins: 0 };
    d.games++;
    if (r.result === 1) d.wins++;
    byDeck.set(r.commander, d);
  }
  const decks = [...byDeck.values()].sort((a, b) => b.games - a.games || b.wins - a.wins);
  for (const d of decks) {
    d.deck = player ? player.decks.find(x => x.name === d.name || stripDeckDisambiguation(x.name) === stripDeckDisambiguation(d.name)) || null : null;
  }
  const best = decks.filter(d => d.wins > 0).sort((a, b) => b.wins - a.wins || b.wins / b.games - a.wins / a.games)[0];
  if (best) best.best = true;
  return decks;
}

function openDossier(name, opener) {
  dossierPlayerName = name;
  dossierOpener = opener || null;
  renderDossier();
  const league = document.getElementById("winrates-league");
  const dossier = document.getElementById("winrates-dossier");
  league.hidden = true;
  dossier.hidden = false;
  window.scrollTo({ top: 0, behavior: "auto" });
  if (!REDUCED_MOTION.matches) {
    dossier.classList.remove("is-entering");
    void dossier.offsetWidth;
    dossier.classList.add("is-entering");
    clearTimeout(dossier._enterTimer);
    dossier._enterTimer = setTimeout(() => dossier.classList.remove("is-entering"), 400);
  }
  const heading = dossier.querySelector(".dossier-name");
  if (heading) heading.focus({ preventScroll: true });
}

function closeDossier() {
  if (!dossierPlayerName) return;
  const name = dossierPlayerName;
  dossierPlayerName = null;
  document.getElementById("winrates-dossier").hidden = true;
  document.getElementById("winrates-league").hidden = false;
  // The opener is usually gone (the table re-renders), so find the row
  // again by name.
  const row = [...document.querySelectorAll("#winrates-table .wr-card")].find(el => el.dataset.flipKey === name)
    || (dossierOpener && dossierOpener.isConnected ? dossierOpener : null);
  dossierOpener = null;
  if (row) {
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "center" });
  }
}

function dossierSection(title) {
  const label = document.createElement("h3");
  label.className = "dossier-label";
  label.textContent = title;
  return label;
}

function buildRivalCard(kind, rival, name) {
  const card = document.createElement("div");
  card.className = `dossier-rival is-${kind}`;
  const tag = document.createElement("span");
  tag.className = "dossier-rival-tag";
  tag.textContent = kind === "nemesis" ? "Nemesis" : "Favourite prey";
  const who = document.createElement("span");
  who.className = "dossier-rival-name";
  const how = document.createElement("span");
  how.className = "dossier-rival-how";
  if (rival) {
    who.textContent = rival.name;
    how.textContent = kind === "nemesis"
      ? `beat ${name} in ${rival.theyWon} of ${rival.shared} shared ${rival.shared === 1 ? "pod" : "pods"}`
      : `${name} won ${rival.iWon} of ${rival.shared} shared ${rival.shared === 1 ? "pod" : "pods"}`;
  } else {
    who.textContent = "None yet";
    how.textContent = kind === "nemesis" ? "Nobody has beaten them yet" : "No wins to count yet";
  }
  card.append(tag, who, how);
  return card;
}

function renderDossier() {
  const host = document.getElementById("winrates-dossier");
  const name = dossierPlayerName;
  if (!host || !name) return;
  const player = podPlayers.find(p => p.name === name) || players.find(p => p.name === name);
  const row = latestStandings ? latestStandings.rows.find(r => r.name === name) : null;
  const rank = latestStandings ? latestStandings.adjustedRankByName[name] : null;
  const isMe = name === signedInPlayerName();
  host.innerHTML = "";
  host.style.setProperty("--sleeve", player ? podSleeveOf(player.id) : "var(--border)");

  const band = document.createElement("div");
  band.className = "dossier-band";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "dossier-back";
  back.innerHTML = `${tonightSvg('<path d="m15 18-6-6 6-6"></path>')}<span>Standings</span>`;
  back.addEventListener("click", closeDossier);
  band.appendChild(back);

  const title = document.createElement("div");
  title.className = "dossier-title";
  const nameEl = document.createElement("h2");
  nameEl.className = "dossier-name";
  nameEl.tabIndex = -1;
  nameEl.textContent = name;
  title.appendChild(nameEl);
  const place = document.createElement("div");
  place.className = "dossier-place";
  const placeRank = document.createElement("span");
  placeRank.className = "dossier-rank";
  placeRank.textContent = rank ? ordinal(rank) : "Unranked";
  const placeLine = document.createElement("span");
  placeLine.className = "dossier-rate";
  placeLine.textContent = row && row.adjPct !== null
    ? `${row.adjPct.toFixed(1)}% adjusted · ${row.adjWins}–${row.adjLosses}`
    : "No games logged this season";
  place.append(placeRank, placeLine);
  title.appendChild(place);
  band.appendChild(title);
  if (isMe) {
    const you = document.createElement("span");
    you.className = "dossier-you";
    you.textContent = "Your dossier";
    band.appendChild(you);
  }
  host.appendChild(band);

  const body = document.createElement("div");
  body.className = "dossier-body";

  const rivals = computeRivals(name);
  const rivalGrid = document.createElement("div");
  rivalGrid.className = "dossier-rivals";
  rivalGrid.append(buildRivalCard("nemesis", rivals.nemesis, name), buildRivalCard("prey", rivals.prey, name));
  body.appendChild(rivalGrid);

  const decks = computeDossierDecks(name);
  body.appendChild(dossierSection(`${name}'s decks this season`));
  if (decks.length) {
    const grid = document.createElement("div");
    grid.className = "dossier-decks";
    for (const d of decks) {
      const tile = document.createElement("div");
      tile.className = d.best ? "dossier-deck is-best" : "dossier-deck";
      const deckName = document.createElement("span");
      deckName.className = "dossier-deck-name";
      deckName.textContent = podShortDeckName(d.name);
      deckName.title = d.name;
      // The coin sits with the record, not beside the name, so a long
      // commander gets the tile's whole width.
      const coin = d.deck ? buildIdentityCoin(d.deck.colorIdentity) : null;
      const meta = document.createElement("span");
      meta.className = "dossier-deck-meta";
      const record = document.createElement("span");
      record.textContent = `${d.best ? "Best · " : ""}${d.wins} ${d.wins === 1 ? "win" : "wins"} in ${d.games}`;
      if (d.best) record.className = "dossier-deck-best";
      if (coin) meta.appendChild(coin);
      meta.appendChild(record);
      if (d.deck && d.deck.comboFlagged) {
        const combo = document.createElement("span");
        combo.className = "dossier-deck-combo";
        combo.textContent = "Combo watch";
        meta.appendChild(combo);
      }
      tile.append(deckName, meta);
      grid.appendChild(tile);
    }
    body.appendChild(grid);
  } else {
    const none = document.createElement("p");
    none.className = "hint";
    none.textContent = "No games logged this season yet.";
    body.appendChild(none);
  }

  const race = computeLeagueRace();
  const line = race.ranks[name];
  if (line && race.nights.length >= 2 && line.filter(r => r !== null).length >= 2) {
    body.appendChild(dossierSection("Rank by night"));
    body.appendChild(buildRankSpark(race, line, name));
  }

  const pins = (player && player.pinnedTrophies) || [];
  if (pins.length) {
    body.appendChild(dossierSection("Pinned trophies"));
    const shelf = document.createElement("div");
    shelf.className = "dossier-trophies";
    for (const t of pins) {
      const item = document.createElement("span");
      item.className = "dossier-trophy";
      const img = document.createElement("img");
      img.src = t.emblem;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      const label = document.createElement("span");
      label.textContent = t.title;
      item.append(img, label);
      shelf.appendChild(item);
    }
    body.appendChild(shelf);
  }
  host.appendChild(body);
}

// One player's line from the race, on its own, with every night's place.
function buildRankSpark(race, line, name) {
  const positions = line.filter(r => r !== null);
  const worst = Math.max(...positions), best = Math.min(...positions);
  const span = Math.max(1, worst - best);
  const width = 330, height = 84, left = 22, right = 14, top = 14, bottom = 22;
  const stepX = (width - left - right) / (line.length - 1);
  const x = i => left + i * stepX;
  const y = pos => top + ((pos - best) / span) * (height - top - bottom);
  const wrap = document.createElement("div");
  wrap.className = "dossier-spark";
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", role: "img" });
  svg.setAttribute("aria-label", `${name}'s rank after each game night: ${line.map((pos, i) => `${formatNightKey(race.nights[i])} ${pos === null ? "no games yet" : ordinal(pos)}`).join(", ")}`);
  const g = svgEl("g", { class: "race-grid" });
  for (const pos of new Set([best, worst])) {
    g.appendChild(svgEl("path", { d: `M${left - 4} ${y(pos)}H${width - right + 4}` }));
    const t = svgEl("text", { x: 0, y: y(pos) + 3, class: "race-axis" });
    t.textContent = ordinal(pos);
    g.appendChild(t);
  }
  svg.appendChild(g);
  const points = line.map((pos, i) => (pos === null ? null : `${x(i)},${y(pos)}`)).filter(Boolean);
  svg.appendChild(svgEl("polyline", { points: points.join(" "), class: "dossier-spark-line" }));
  line.forEach((pos, i) => {
    if (pos === null) return;
    svg.appendChild(svgEl("circle", { cx: x(i), cy: y(pos), r: i === line.length - 1 ? 4.5 : 2.5, class: "dossier-spark-dot" }));
  });
  const first = svgEl("text", { x: x(0), y: height - 4, "text-anchor": "start", class: "race-axis" });
  first.textContent = formatNightKey(race.nights[0]);
  const lastLabel = svgEl("text", { x: x(line.length - 1), y: height - 4, "text-anchor": "end", class: "race-axis" });
  lastLabel.textContent = formatNightKey(race.nights[race.nights.length - 1]);
  svg.append(first, lastLabel);
  wrap.appendChild(svg);
  return wrap;
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
    if (!playgroupGamesData) {
      tonightCounts.gamesToLog = "error";
      updateTonightTabBadge();
      renderTonight();
    }
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

  // Any season, not just the current one: a deck's bracket carries over, so
  // its first game of a new season defaults to where it last played.
  const matches = gameLogAllRows.filter(
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
  updateTonightTabBadge();
  renderTonight();
}

function renderGamesToUpdate() {
  const statusEl = document.getElementById("gtu-status");
  const listEl = document.getElementById("gtu-game-list");
  if (!playgroupGamesData || !statusEl || !listEl) return;
  if (!gameLogLoaded) {
    // "the Game Log" -- not "deck-strength.xlsx", which this stopped
    // reading from back when the D1 migration landed; the string just
    // never got updated to match.
    statusEl.textContent = "Still syncing the Game Log…";
    // Unknown, not zero -- and a Game Log load that already failed stays
    // reported as failed rather than reverting to "checking".
    if (tonightCounts.gamesToLog !== "error") updateGamesToUpdateTabBadge(null);
    return;
  }

  const loggedMatches = computeLoggedMatches(playgroupGamesData.games);
  const missing = playgroupGamesData.games.filter(g => !loggedMatches.has(g.playgroup_game_id));
  const liveAsOf = playgroupGamesData.generated_at ? new Date(playgroupGamesData.generated_at).toLocaleTimeString() : null;
  const league = playgroupGamesData.league ? ` from ${playgroupGamesData.league}` : "";
  statusEl.textContent = `${missing.length} of ${playgroupGamesData.games.length} games${league} still need logging.${liveAsOf ? ` Checked ${liveAsOf}.` : ""}`;
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
    card.dataset.gameId = g.playgroup_game_id;

    // Built via createElement/textContent, not innerHTML -- player and
    // commander names come from playgroup.gg (ultimately editable by any
    // playgroup member), so interpolating them into a template-literal
    // innerHTML string would let one break out of markup.
    const header = document.createElement("div");
    header.className = "gtu-game-summary";
    const dateStrong = document.createElement("strong");
    dateStrong.textContent = formatGameDay(g.date);
    const size = document.createElement("span");
    size.className = "gtu-game-size";
    size.textContent = `${g.participants.length} players`;
    header.append(dateStrong, size);

    // One line per player, winner first, instead of a single run-on
    // sentence of "Name (Commander — won), Name (Commander)…" that was
    // hard to scan for who was even in the game.
    const roster = document.createElement("ul");
    roster.className = "gtu-game-players";
    const ordered = [...g.participants].sort((a, b) => (b.result === "win") - (a.result === "win"));
    for (const p of ordered) {
      const li = document.createElement("li");
      const who = document.createElement("span");
      who.className = "gtu-game-player";
      who.textContent = p.player;
      const deck = document.createElement("span");
      deck.className = "gtu-game-deck";
      deck.textContent = p.commander;
      li.append(who, deck);
      if (p.result === "win") {
        li.classList.add("is-winner");
        const won = document.createElement("span");
        won.className = "gtu-game-won";
        won.textContent = "Won";
        li.appendChild(won);
      }
      roster.appendChild(li);
    }

    const fillBtn = document.createElement("button");
    fillBtn.type = "button";
    fillBtn.className = "gtu-fill-btn";
    fillBtn.textContent = "Fill in";
    fillBtn.addEventListener("click", () => openGameForm(g));

    card.append(header, roster, fillBtn);
    if (g.note) {
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = g.note;
      card.appendChild(note);
    }
    listEl.appendChild(card);
  }
  markOpenGtuCard();
}

// "Fri, Oct 2" from playgroup.gg's plain "2026-10-02" day. Formatted in
// UTC because that's how a bare date parses -- local time would show the
// day before for anyone west of Greenwich.
function formatGameDay(isoDay) {
  const d = new Date(isoDay);
  if (isNaN(d)) return isoDay;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// Which pending game's form is open below the list, so its card says so
// instead of offering "Fill in" for the game you're already filling in.
let openGtuGameId = null;
function markOpenGtuCard() {
  document.querySelectorAll("#gtu-game-list .gtu-game-card").forEach(card => {
    const open = openGtuGameId !== null && card.dataset.gameId === String(openGtuGameId);
    card.classList.toggle("is-open", open);
    const btn = card.querySelector(".gtu-fill-btn");
    if (btn) btn.textContent = open ? "Filling in below" : "Fill in";
  });
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
// real already-logged games, not just the API docs: KOs is the count of
// distinct opponents a player eliminated (see kosByDeckName below); Place
// ranks the winner first, then everyone else by elimination order
// (eliminated later = better place); TOV is the turn a player was
// eliminated, or the last turn seen in the event log for anyone never
// eliminated (the winner). Matches participants by deck_name, which both
// /debug/game's raw participations and /playgroup-games' transformed
// participants carry, and which is unique within a single game.
function deriveGameFieldsFromRawGame(rawGame) {
  // Sorted by happened_at rather than trusted to already be in order --
  // this is what makes same-turn tie-breaking below actually correct
  // instead of just usually-correct.
  const killEvents = (rawGame.events || [])
    .filter(e => e.kind === "kill")
    .sort((a, b) => new Date(a.happened_at) - new Date(b.happened_at));
  const deckNameByUserId = {};
  for (const p of rawGame.participations) deckNameByUserId[p.user_id] = p.deck_name;

  // playgroup.gg logs multiple "kill" events for a single real elimination
  // (confirmed against a real game: 3 actual knockouts showed up as 12 raw
  // kill events, ~4 per receiver_user_id) -- same bug and same fix as
  // relay.js's computeAndStoreGameEventStats. A plain per-event count
  // over-counts, so KOs is the number of distinct opponents (by
  // receiver_user_id) a killer actually eliminated, not the raw event count.
  const knockoutReceiversByDeckName = {};
  for (const e of killEvents) {
    const deckName = deckNameByUserId[e.user_id];
    if (!deckName) continue;
    if (!knockoutReceiversByDeckName[deckName]) knockoutReceiversByDeckName[deckName] = new Set();
    knockoutReceiversByDeckName[deckName].add(e.receiver_user_id);
  }
  const kosByDeckName = {};
  for (const [deckName, receivers] of Object.entries(knockoutReceiversByDeckName)) {
    kosByDeckName[deckName] = receivers.size;
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
// The exact prefilled power while the field still shows its rounded
// version (see buildGtuParticipantCard); whatever was typed otherwise.
function readGtuStrength(input) {
  if (input.dataset.exact && input.value === input.dataset.shown) return parseFloat(input.dataset.exact);
  return parseFloat(input.value);
}

// −/+ around a whole-number field, so a count at the table is a tap or
// two instead of summoning the keyboard. The <input> stays the source of
// truth (and stays typeable): every step writes its value and fires a
// bubbling "input" event, so drafts, the stale-preview check and the
// prefilled marker all see it exactly as if it had been typed.
//
// Responds on press, not release; holding repeats, speeding up the longer
// it's held. At min/max the field bumps against the limit (a short spring
// kick toward the wall) instead of silently doing nothing.
function buildGtuStepper(input, labelText) {
  const wrap = document.createElement("div");
  wrap.className = "gtu-stepper";
  const button = (delta, glyph, verb) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gtu-step";
    b.tabIndex = -1; // the field itself takes arrow keys; one tab stop per field
    b.textContent = glyph;
    b.setAttribute("aria-label", `${verb} ${labelText}`);
    let timer = null;
    let pressed = false; // a pointer press already stepped; its click mustn't step again
    const stop = () => { clearTimeout(timer); timer = null; };
    const repeat = (wait) => {
      timer = setTimeout(() => {
        if (stepGtuField(input, delta)) repeat(Math.max(45, wait * 0.8));
        else stop();
      }, wait);
    };
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // no focus steal, no keyboard, no text selection
      pressed = true;
      b.setPointerCapture?.(e.pointerId);
      stepGtuField(input, delta);
      stop();
      repeat(420);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(type, stop);
    // Keyboard and assistive-tech activation arrive as a click with no
    // pointer press before it. (A tap's own click can't be told apart by
    // e.detail -- touch-generated clicks report 0 too -- hence the flag.)
    b.addEventListener("click", () => {
      if (pressed) { pressed = false; return; }
      stepGtuField(input, delta);
    });
    return b;
  };
  input.classList.add("gtu-stepper-input");
  input.inputMode = "numeric";
  wrap.append(button(-1, "−", "Decrease"), input, button(1, "+", "Increase"));
  return wrap;
}

// Returns whether the value actually moved, so a held button stops
// repeating once it reaches the limit.
function stepGtuField(input, delta) {
  const min = input.min === "" ? -Infinity : Number(input.min);
  const max = input.max === "" ? Infinity : Number(input.max);
  const current = input.value === "" ? null : Number(input.value);
  let next;
  if (current === null || Number.isNaN(current)) next = delta > 0 ? (Number.isFinite(min) ? min : 0) : null;
  else next = Math.min(max, Math.max(min, Math.round(current) + delta));
  if (next === null || next === current) {
    bumpGtuField(input, delta);
    return false;
  }
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  haptic(5);
  return true;
}

function bumpGtuField(input, direction) {
  haptic(14);
  if (REDUCED_MOTION.matches) return;
  const spring = input._bumpSpring ||= new Spring(0, v => { input.style.transform = Math.abs(v) < 0.1 ? "" : `translate3d(${v}px, 0, 0)`; });
  spring.to(0, { dampingRatio: 0.45, response: 0.2, velocity: direction * 160 });
}

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
  // Not a wrapping <label> like field(): a label with no `for` labels its
  // first labelable child, which here would be the − button -- tapping
  // the caption would decrement. Points at the input by id instead.
  const stepperField = (labelText, inputEl) => {
    const wrap = document.createElement("div");
    wrap.className = "gtu-field";
    inputEl.id = `gtu-${gtuFieldName(inputEl)}-${i}`;
    const lbl = document.createElement("label");
    lbl.className = "gtu-field-label";
    lbl.htmlFor = inputEl.id;
    lbl.textContent = labelText;
    wrap.append(lbl, buildGtuStepper(inputEl, labelText));
    return wrap;
  };

  // Shown to 2 decimals: a deck's computed power carries a long tail
  // ("2.32333333") that overflowed the field on a phone. The exact value
  // is kept on the input and used unless someone actually edits the
  // number (readGtuStrength), so the calculation doesn't change.
  const shownStrength = defaultStrength === null ? "" : String(Math.round(defaultStrength * 100) / 100);
  const strengthInput = makeGtuInput("number", "gtu-strength", i, { step: "0.1", min: "0", max: "5", value: shownStrength });
  if (defaultStrength !== null) {
    strengthInput.dataset.exact = String(defaultStrength);
    strengthInput.dataset.shown = shownStrength;
    markGtuPrefilled(strengthInput);
  }

  const placeInput = makeGtuInput("number", "gtu-place", i, { min: "1", max: pgGame.pod_size, value: defaultPlace });
  if (defaultPlace) markGtuPrefilled(placeInput);

  const bracketInput = makeGtuInput("number", "gtu-bracket", i, { min: "1", max: "5", value: defaultBracket });
  if (defaultBracket !== "") markGtuPrefilled(bracketInput);

  const fields = document.createElement("div");
  fields.className = "gtu-card-fields";
  fields.append(
    field("Cmdr Strength", strengthInput),
    stepperField("Place", placeInput),
    stepperField("KOs", makeGtuInput("number", "gtu-knockouts", i, { min: "0", value: 0 })),
    stepperField("TOV", makeGtuInput("number", "gtu-tov", i, { min: "1", value: "" })),
    stepperField("Disruptions", makeGtuInput("number", "gtu-disruptions", i, { min: "0", value: 0 })),
    stepperField("Recoveries", makeGtuInput("number", "gtu-recoveries", i, { min: "0", value: 0 })),
    stepperField("Bracket", bracketInput),
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

// Drafts of the Games to Update form, keyed per game, so a half-typed form
// survives a reload or iOS unloading the app. Only fields someone actually
// edited are stored (data-touched); prefills still come from live data.
const GTU_DRAFTS_KEY = "gtuDrafts";
const GTU_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function gtuDraftKey(pgGame) {
  return String(pgGame.playgroup_game_id ?? `${pgGame.date}|${pgGame.participants.map(p => p.player).join(",")}`);
}

function readGtuDrafts() {
  try {
    const all = JSON.parse(localStorage.getItem(GTU_DRAFTS_KEY) || "{}") || {};
    const now = Date.now();
    for (const key of Object.keys(all)) {
      if (!all[key] || !(now - all[key].savedAt < GTU_DRAFT_MAX_AGE_MS)) delete all[key];
    }
    return all;
  } catch {
    return {};
  }
}

function writeGtuDrafts(all) {
  try {
    localStorage.setItem(GTU_DRAFTS_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked -- the form still works, it just won't survive a reload.
  }
}

// The field's own class (e.g. "gtu-tov"), as set by makeGtuInput.
function gtuFieldName(input) {
  return [...input.classList].find(c => c.startsWith("gtu-") && c !== "gtu-in" && c !== "gtu-in-prefilled");
}

function saveGtuDraft(key, container) {
  const values = {};
  container.querySelectorAll(".gtu-in").forEach(input => {
    if (input.dataset.touched !== "1") return;
    values[`${gtuFieldName(input)}:${input.dataset.i}`] = input.type === "checkbox" ? input.checked : input.value;
  });
  const all = readGtuDrafts();
  all[key] = { savedAt: Date.now(), values };
  writeGtuDrafts(all);
}

function restoreGtuDraft(key, container) {
  const draft = readGtuDrafts()[key];
  if (!draft) return false;
  let restored = 0;
  for (const [id, value] of Object.entries(draft.values || {})) {
    const [field, i] = id.split(":");
    if (!/^gtu-[a-z0-9-]+$/.test(field) || !/^\d+$/.test(i)) continue;
    const input = container.querySelector(`.${field}[data-i="${i}"]`);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = !!value;
    else input.value = value;
    input.classList.remove("gtu-in-prefilled");
    input.dataset.touched = "1";
    restored++;
  }
  return restored > 0;
}

function clearGtuDraft(key) {
  const all = readGtuDrafts();
  delete all[key];
  writeGtuDrafts(all);
}

// Called on any edit once a preview exists: Submit is disabled until
// Calculate runs again, so what gets logged is always what was previewed.
// calculateGameToUpdate rebuilds resultsEl from scratch, which clears this.
function markGtuPreviewStale(resultsEl, calcBtn) {
  const submitBtn = resultsEl.querySelector(".gtu-submit-btn");
  if (!submitBtn || submitBtn.disabled || resultsEl.querySelector(".gtu-stale-note")) return;
  submitBtn.disabled = true;
  const note = document.createElement("p");
  note.className = "hint gtu-stale-note";
  note.textContent = "You've changed something since calculating — tap Calculate again to update the preview, then submit.";
  resultsEl.prepend(note);
  calcBtn.classList.add("glow");
}

function openGameForm(pgGame) {
  const areaEl = document.getElementById("gtu-form-area");
  areaEl.innerHTML = "";

  const box = document.createElement("div");
  box.className = "gtu-form";

  const title = document.createElement("h3");
  title.textContent = `${formatGameDay(pgGame.date)}: ${pgGame.participants.map(p => p.player).join(", ")}`;
  box.appendChild(title);
  openGtuGameId = pgGame.playgroup_game_id;
  markOpenGtuCard();

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

  const draftKey = gtuDraftKey(pgGame);
  if (restoreGtuDraft(draftKey, cardList)) {
    const restoredHint = document.createElement("p");
    restoredHint.className = "hint";
    restoredHint.textContent = "Restored what you'd already entered for this game.";
    box.insertBefore(restoredHint, cardList);
  }

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
          // Never over a field the person has already typed in (or that a
          // saved draft restored) -- this lands whenever the fetch does.
          const untouched = el => el && el.dataset.touched !== "1";
          if (untouched(placeInput)) { placeInput.value = fields.place; markGtuPrefilled(placeInput); }
          if (untouched(kosInput)) { kosInput.value = fields.kos; markGtuPrefilled(kosInput); }
          if (untouched(tovInput) && fields.tov != null) { tovInput.value = fields.tov; markGtuPrefilled(tovInput); }
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

  const runCalculation = () => {
    calcBtn.classList.remove("glow");
    calculateGameToUpdate(pgGame, box, resultsEl);
  };
  calcBtn.addEventListener("click", runCalculation);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("gtu-in")) {
      e.preventDefault();
      runCalculation();
    }
  });
  // Every edit is saved as a draft, and makes an existing preview stale:
  // Submit sends the values Calculate captured, so letting it submit after
  // an edit used to log the old numbers.
  const onEdit = (e) => {
    if (!e.target.classList.contains("gtu-in")) return;
    e.target.dataset.touched = "1";
    saveGtuDraft(draftKey, cardList);
    markGtuPreviewStale(resultsEl, calcBtn);
  };
  box.addEventListener("input", onEdit);
  box.addEventListener("change", onEdit);

  box.appendChild(calcBtn);
  box.appendChild(resultsEl);
  buildGtuDebrief(box, cardList, calcBtn, pgGame);
  areaEl.appendChild(box);
  // "start", not "nearest": the form opens below every pending game, and
  // on a phone "nearest" only nudged its top edge into view, leaving the
  // tap looking like it did nothing.
  box.scrollIntoView({ behavior: REDUCED_MOTION.matches ? "auto" : "smooth", block: "start" });
}

// The debrief: the same form, one player at a time. Player chips across the
// top (tap to jump), Back / "Next: Kai" under the card, and Calculate only
// on the last player. Every card stays in the DOM, just hidden, so drafts,
// the playgroup.gg pre-fill and calculateGameToUpdate (which all find
// inputs by class + data-i) work exactly as before. "Everyone at once"
// brings back the full list, remembered per phone.
const GTU_LIST_KEY = "gtuDebriefList";
function buildGtuDebrief(box, cardList, calcBtn, pgGame) {
  const cards = [...cardList.children];
  if (cards.length < 2) return;
  cards.forEach((c, i) => {
    c.tabIndex = -1;
    c.setAttribute("aria-label", `${pgGame.participants[i].player}, player ${i + 1} of ${cards.length}`);
  });
  let at = 0;
  let listMode = false;
  try { listMode = localStorage.getItem(GTU_LIST_KEY) === "1"; } catch { /* storage blocked -- one at a time */ }

  const steps = document.createElement("div");
  steps.className = "gtu-debrief-steps";
  steps.setAttribute("role", "group");
  steps.setAttribute("aria-label", "Players in this game");
  const chips = pgGame.participants.map((p, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "gtu-debrief-step";
    chip.textContent = p.player;
    chip.addEventListener("click", () => show(i, true));
    steps.appendChild(chip);
    return chip;
  });

  const mode = document.createElement("button");
  mode.type = "button";
  mode.className = "gtu-debrief-mode";
  mode.addEventListener("click", () => {
    listMode = !listMode;
    try { localStorage.setItem(GTU_LIST_KEY, listMode ? "1" : "0"); } catch { /* not remembered */ }
    show(at, false);
  });

  const controls = document.createElement("div");
  controls.className = "gtu-debrief-controls";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Back";
  back.addEventListener("click", () => show(at - 1, true));
  const next = document.createElement("button");
  next.type = "button";
  next.className = "primary";
  next.addEventListener("click", () => show(at + 1, true));
  controls.append(back, next, calcBtn);

  const visited = new Set([0]);
  function show(i, move) {
    at = Math.max(0, Math.min(cards.length - 1, i));
    visited.add(at);
    const last = at === cards.length - 1;
    box.classList.toggle("is-debrief", !listMode);
    cards.forEach((c, j) => { c.hidden = !listMode && j !== at; });
    chips.forEach((chip, j) => {
      chip.classList.toggle("is-visited", visited.has(j) && j !== at);
      if (!listMode && j === at) chip.setAttribute("aria-current", "step");
      else chip.removeAttribute("aria-current");
    });
    steps.hidden = listMode;
    back.hidden = listMode || at === 0;
    next.hidden = listMode || last;
    next.textContent = last ? "" : `Next: ${pgGame.participants[at + 1].player}`;
    calcBtn.hidden = !listMode && !last;
    mode.textContent = listMode ? "One player at a time" : "Everyone at once";
    if (move && !listMode) {
      cards[at].scrollIntoView({ behavior: REDUCED_MOTION.matches ? "auto" : "smooth", block: "nearest" });
      // The card, not its first field: focusing a number input would open
      // the phone's keyboard on every step.
      cards[at].focus({ preventScroll: true });
    }
  }

  cardList.before(steps);
  cardList.after(controls);
  controls.after(mode);
  show(0, false);
}

function calculateGameToUpdate(pgGame, box, resultsEl) {
  const podSize = pgGame.pod_size;
  const readInputs = (i) => ({
    strength: readGtuStrength(box.querySelector(`.gtu-strength[data-i="${i}"]`)),
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
        celebrateButton(submitBtn, "Submitted");
        clearGtuDraft(gtuDraftKey(pgGame));
        // D1 writes land in ~100-300ms (vs. the old GitHub Actions round
        // trip's 1-3 minutes), so this waits for a real refetch instead of
        // optimistically merging a guessed local copy -- the whole reason
        // that complexity existed before was papering over that slow wait.
        statusEl.textContent = "Refreshing…";
        await refreshEverything();
        statusEl.textContent = "Added. Standings and deck power are up to date.";
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
          openGtuGameId = null;
          markOpenGtuCard();
        }, 1500);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.classList.remove("is-done");
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
    if (!rosterDiffData) {
      tonightCounts.newDecks = "error";
      updateTonightTabBadge();
      renderTonight();
    }
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
      const bracketSel = el.closest(".uta-deck-card")?.querySelector(".uta-deck-bracket");
      if (!bracketSel || bracketSel.value !== "3") return;
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

const UTA_STACK_MAX = 3;

// Select All / Deselect All for one group's decks only (see
// setAllRosterUpdateChecked for why never every group at once).
function buildUtaSelectButtons(group) {
  const wrap = document.createElement("div");
  wrap.className = "uta-select-btns";
  const selectAllBtn = document.createElement("button");
  selectAllBtn.type = "button";
  selectAllBtn.textContent = "Select All";
  selectAllBtn.title = "Checks every deck in this group -- not every pending player.";
  selectAllBtn.addEventListener("click", () => setAllRosterUpdateChecked(group, true));
  const deselectAllBtn = document.createElement("button");
  deselectAllBtn.type = "button";
  deselectAllBtn.textContent = "Deselect All";
  deselectAllBtn.title = "Unchecks every deck in this group -- not every pending player.";
  deselectAllBtn.addEventListener("click", () => setAllRosterUpdateChecked(group, false));
  wrap.append(selectAllBtn, deselectAllBtn);
  return wrap;
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
  updateTonightTabBadge();
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
  const newDeckCount = newDecksForExisting.reduce((n, g) => n + g.decks.length, 0);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  statusEl.textContent = `Found ${plural(newPlayers.length, "new player")} and ${plural(newDeckCount, "new deck")} for existing players. Checked ${new Date(rosterDiffData.generated_at).toLocaleTimeString()}.`;

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

  // A typical night turns up one or two of these. Hiding all but one behind
  // a dropdown meant a second pending player went unnoticed, so up to
  // UTA_STACK_MAX groups are simply listed, each with its own Select All;
  // the dropdown is kept for a genuinely long backlog.
  if (groups.length <= UTA_STACK_MAX) {
    rosterUpdateSelectedGroupKey = null;
    for (const group of groups) {
      const box = renderRosterUpdateGroup(group);
      // Select All on a one-deck group is just its checkbox again.
      if (group.data.decks.length > 1) box.querySelector(".uta-group-header")?.appendChild(buildUtaSelectButtons(group));
      listEl.appendChild(box);
    }
    renderRosterUpdateSubmit(formAreaEl, newPlayers, newDecksForExisting);
    return;
  }

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
  controls.appendChild(buildUtaSelectButtons(activeGroup));
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
          // The flag only means anything on a Bracket 3 deck -- never sent
          // for any other bracket, whatever the button state says.
          decks.push({ name: d.commander_name, power: bracket, playgroupDeckId: d.id, playgroupDeckName: d.name, potentialBracket4: bracket === 3 && !!state.potentialBracket4, colorIdentity: d.color_identity ?? null });
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
          payload.newDecksForExisting.push({ player: g.player, name: d.commander_name, power: bracket, playgroupDeckId: d.id, playgroupDeckName: d.name, potentialBracket4: bracket === 3 && !!state.potentialBracket4, colorIdentity: d.color_identity ?? null });
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

        celebrateButton(submitBtn, "Submitted");
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
        submitBtn.classList.remove("is-done");
        submitBtn.textContent = "Add Player/Decks";
        statusEl.textContent = `Submission failed: ${err.message}`;
      }
    });
  }

  formAreaEl.appendChild(submitBtn);
  formAreaEl.appendChild(statusEl);
}

// ---------- Active players (admin) ----------
// The admin's switches under Players & Decks. Turning a player off hides
// them from the whole app (players.active -- see schema.sql); their past
// games are never touched. Everyone but the admin never sees this section.
function renderActivePlayersAdmin() {
  const host = document.getElementById("active-players-admin");
  if (!host) return;
  host.hidden = !(currentUser && currentUser.isAdmin);
  if (host.hidden) return;
  host.innerHTML = "";

  const heading = document.createElement("h3");
  heading.className = "active-admin-title";
  heading.textContent = "Active players";
  host.appendChild(heading);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Only you see this. A player switched off disappears from the app; their games still count.";
  host.appendChild(hint);

  const rows = [
    ...podPlayers.map(p => ({ id: p.id, name: p.name, active: true })),
    ...inactivePlayers.map(p => ({ id: p.id, name: p.name, active: false })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const list = document.createElement("div");
  list.className = "active-admin-list";
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = `active-admin-row${row.active ? "" : " is-inactive"}`;
    const name = document.createElement("span");
    name.className = "active-admin-name";
    name.textContent = row.name;
    const state = document.createElement("span");
    state.className = "active-admin-state";
    state.textContent = row.active ? "Active" : "Not active";
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(row.active));
    sw.setAttribute("aria-label", `${row.name} active`);
    const isMe = currentUser && row.id === currentUser.playerId;
    // The relay refuses this too -- switching yourself off would hide the
    // very list this switch lives in.
    if (isMe) {
      sw.disabled = true;
      sw.title = "You can't switch yourself off";
    }
    sw.addEventListener("click", () => setPlayerActive(row, !row.active, sw, state));
    item.append(name, state, sw);
    list.appendChild(item);
  }
  host.appendChild(list);

  const status = document.createElement("p");
  status.className = "hint active-admin-status";
  status.id = "active-admin-status";
  status.setAttribute("role", "status");
  host.appendChild(status);
}

async function setPlayerActive(row, active, sw, stateEl) {
  const status = document.getElementById("active-admin-status");
  sw.disabled = true;
  stateEl.textContent = active ? "Turning on…" : "Turning off…";
  try {
    const res = await fetch(PLAYER_ACTIVE_RELAY_URL, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ playerId: row.id, active }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    // Who counts changes the majority on every proposal too.
    await Promise.all([syncFromD1(), loadProposals()]);
    const after = document.getElementById("active-admin-status");
    if (after) after.textContent = `${row.name} is now ${active ? "active" : "not active"}.`;
  } catch (err) {
    sw.disabled = false;
    stateEl.textContent = row.active ? "Active" : "Not active";
    if (status) status.textContent = `Couldn't change ${row.name}: ${err.message}`;
  }
}

// ---------- Pod Proposals ----------
// House rules and ideas the pod votes on (GET/POST /proposals in
// relay.js). The relay decides every outcome -- a majority of active
// players moves a proposal to trial or shelves it, and a finished trial
// adopts it -- and answers every write with the whole settled board, so
// nothing here guesses at a result. Rule changes read as Out -> In, ideas
// as Pros & Cons; the layout toggle only changes how the same bullets show.

const proposalsUi = {
  view: "auto",       // "auto" | "inout" | "procon"
  filter: "active",   // "active" | "adopted" | "shelved"
  formKind: "rule",
  busy: false,
  // Set for one render after this viewer's own vote passed a proposal, so
  // its card gets the foil pass once -- see .proposal-card.is-passing.
  justPassed: new Set(),
  // Fades the bullet columns only on a layout switch, never when a vote
  // re-renders the list (web-animation rule 7).
  swapping: false,
  addingPoint: null,  // { id, side } while a pro/con input is open
};

const PROPOSAL_POINT_LIMIT = 8;
const PROPOSAL_EMPTY = {
  active: ["No open proposals", "Propose a rule change or an idea and the pod can vote on it."],
  adopted: ["No house rules yet", "A proposal becomes a house rule once it passes its trial."],
  shelved: ["Nothing shelved", "Proposals that get a majority No, or no majority in 14 days, land here and can be reopened."],
};

function proposalsAwaitingMyVote() {
  if (!proposalsData) return 0;
  return proposalsData.proposals.filter(p => p.status === "open" && !p.myVote).length;
}

function openProposalsTab(filter) {
  proposalsUi.filter = filter;
  activateTab("proposals");
  renderProposals();
}

async function loadProposals() {
  if (!currentUser) return;
  const status = document.getElementById("proposals-status");
  try {
    const res = await fetch(PROPOSALS_RELAY_URL, { cache: "no-store", headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    applyProposalsData(body);
  } catch (err) {
    if (status) {
      status.hidden = false;
      status.textContent = `Couldn't load proposals (${err.message}). Pull down to try again.`;
    }
  }
}

function applyProposalsData(data) {
  const before = new Map((proposalsData ? proposalsData.proposals : []).map(p => [p.id, p.status]));
  proposalsData = data;
  for (const p of data.proposals) {
    if (before.get(p.id) === "open" && p.status === "trial") proposalsUi.justPassed.add(p.id);
  }
  renderProposals();
  renderProposalsBadge();
  renderTonight();
}

// The menu's count and the gold dot on the avatar: proposals still
// waiting on this viewer's vote. The avatar's label says it in words too,
// so the dot is never the only signal.
function renderProposalsBadge() {
  const n = proposalsAwaitingMyVote();
  const count = document.getElementById("auth-proposals-count");
  if (count) {
    count.hidden = n === 0;
    count.textContent = `${n} to vote`;
  }
  const dot = document.getElementById("auth-avatar-dot");
  if (dot) dot.hidden = n === 0;
  const btn = document.getElementById("auth-avatar-btn");
  if (btn) btn.setAttribute("aria-label", n ? `Account menu, ${n} proposal${n === 1 ? "" : "s"} to vote on` : "Account menu");
}

// "2025-10-23 18:04:11" (SQLite datetime('now'), UTC) -> Date.
function parseProposalTime(s) {
  return s ? new Date(s.replace(" ", "T") + "Z") : null;
}

function formatProposalDate(s) {
  const d = parseProposalTime(s);
  return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

function proposalTimeline(p) {
  if (p.status === "open") {
    const closes = parseProposalTime(p.votingClosesAt);
    const days = closes ? Math.ceil((closes - Date.now()) / 86400000) : null;
    const left = days === null ? "" : days <= 1 ? "last day to vote" : `${days} days left`;
    return p.reopenCount ? `Reopened · ${left}` : left;
  }
  if (p.status === "trial") return `Trial since ${formatProposalDate(p.decidedAt)}`;
  if (p.status === "adopted") return `Adopted ${formatProposalDate(p.decidedAt)}`;
  if (p.shelvedReason === "expired") return `Expired ${formatProposalDate(p.decidedAt)} · no majority`;
  return `Shelved ${formatProposalDate(p.decidedAt)} · majority no`;
}

function proposalStatusChip(p) {
  const chip = document.createElement("span");
  chip.className = `proposal-chip proposal-chip-${p.status}`;
  chip.textContent = {
    open: "Voting",
    trial: `Trial · ${p.trialGamesPlayed ?? 0} of ${p.trialGames} games`,
    adopted: "House rule",
    shelved: p.shelvedReason === "expired" ? "Expired" : "Shelved",
  }[p.status];
  return chip;
}

function buildProposalColumn(side, title, items, showWho) {
  const col = document.createElement("div");
  col.className = `proposal-col proposal-col-${side}`;
  const h = document.createElement("h4");
  h.textContent = title;
  col.appendChild(h);
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "proposal-col-empty";
    empty.textContent = side === "pro" || side === "con" ? "None yet" : "Nothing listed";
    col.appendChild(empty);
    return col;
  }
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item.text;
    if (showWho) {
      const who = document.createElement("span");
      who.className = "proposal-who";
      who.textContent = `added by ${item.addedBy}`;
      li.appendChild(who);
    }
    ul.appendChild(li);
  }
  col.appendChild(ul);
  return col;
}

// Shape carries the vote and colour backs it up: filled = yes, crossed
// ring = no, dashed ring = not voted yet. Anonymous proposals get counts
// only, sorted, so a dot's position can't be matched to a name.
function buildProposalTally(p) {
  const wrap = document.createElement("div");
  wrap.className = "proposal-tally";
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label",
    `${p.tally.yes} yes, ${p.tally.no} no, ${p.tally.waiting} not voted${p.anonymous ? ", anonymous" : ""}`);
  const dots = p.voters
    ? p.voters.map(v => ({ vote: v.vote, title: `${v.name}: ${v.vote || "not voted"}` }))
    : [
      ...Array(p.tally.yes).fill({ vote: "yes" }),
      ...Array(p.tally.no).fill({ vote: "no" }),
      ...Array(p.tally.waiting).fill({ vote: null }),
    ];
  for (const d of dots) {
    const dot = document.createElement("i");
    dot.className = `proposal-dot${d.vote === "yes" ? " is-yes" : d.vote === "no" ? " is-no" : ""}`;
    if (d.title) dot.title = d.title;
    wrap.appendChild(dot);
  }
  const text = document.createElement("span");
  text.className = "proposal-tally-text";
  text.textContent = p.status === "open"
    ? `${p.tally.yes} yes · ${p.tally.no} no · ${proposalsData.majority} decides`
    : `${p.tally.yes} yes · ${p.tally.no} no`;
  wrap.appendChild(text);
  return wrap;
}

function buildProposalCard(p) {
  const card = document.createElement("article");
  card.className = `proposal-card is-${p.status}`;
  if (proposalsUi.justPassed.has(p.id)) card.classList.add("is-passing");

  const top = document.createElement("div");
  top.className = "proposal-top";
  const head = document.createElement("div");
  head.className = "proposal-head";
  const title = document.createElement("h3");
  title.className = "proposal-title";
  title.textContent = p.title;
  const meta = document.createElement("p");
  meta.className = "proposal-meta";
  const kind = document.createElement("span");
  kind.className = "proposal-kind";
  kind.textContent = p.kind === "rule" ? "Rule change" : "Idea";
  meta.appendChild(kind);
  const bits = [p.proposedBy.name, proposalTimeline(p), p.appliesTo].filter(Boolean);
  meta.appendChild(document.createTextNode(bits.join(" · ")));
  if (p.anonymous) {
    const anon = document.createElement("span");
    anon.className = "proposal-anon";
    anon.textContent = "Anonymous";
    meta.appendChild(anon);
  }
  head.append(title, meta);
  top.append(head, proposalStatusChip(p));
  card.appendChild(top);

  const useInOut = proposalsUi.view === "inout" || (proposalsUi.view === "auto" && p.kind === "rule");
  const cols = document.createElement("div");
  cols.className = `proposal-cols${proposalsUi.swapping ? " is-swapping" : ""}`;
  if (useInOut) {
    cols.append(buildProposalColumn("out", "Out", p.points.out, false), buildProposalColumn("in", "In", p.points.in, false));
  } else {
    cols.append(buildProposalColumn("pro", "Pros", p.points.pro, true), buildProposalColumn("con", "Cons", p.points.con, true));
  }
  card.appendChild(cols);

  if (p.status === "open") card.appendChild(buildProposalPointAdder(p));
  if (currentUser && currentUser.isAdmin && (p.status === "open" || p.status === "trial")) {
    card.appendChild(buildProposalTrialControl(p));
  }

  const foot = document.createElement("div");
  foot.className = "proposal-foot";
  foot.appendChild(buildProposalTally(p));
  if (p.status === "open") {
    const votes = document.createElement("div");
    votes.className = "proposal-votes";
    for (const v of ["yes", "no"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `proposal-vote proposal-vote-${v}`;
      b.textContent = v === "yes" ? "Yes" : "No";
      b.setAttribute("aria-pressed", String(p.myVote === v));
      b.disabled = proposalsUi.busy;
      // Tapping your current vote again takes it back.
      b.addEventListener("click", () => proposalWrite("/vote", { proposalId: p.id, vote: p.myVote === v ? null : v }));
      votes.appendChild(b);
    }
    foot.appendChild(votes);
  } else if (p.canReopen) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "proposal-reopen";
    b.textContent = "Reopen for a new vote";
    b.disabled = proposalsUi.busy;
    b.addEventListener("click", async () => {
      const ok = await proposalWrite("/reopen", { proposalId: p.id });
      if (ok) { proposalsUi.filter = "active"; renderProposals(); }
    });
    foot.appendChild(b);
  }
  card.appendChild(foot);
  return card;
}

// "+ Pro" / "+ Con" under an open proposal. Only pros and cons can be
// added after posting -- the Out/In rule itself stays as it was voted on.
function buildProposalPointAdder(p) {
  const wrap = document.createElement("div");
  wrap.className = "proposal-adder";
  const open = proposalsUi.addingPoint && proposalsUi.addingPoint.id === p.id ? proposalsUi.addingPoint.side : null;
  if (!open) {
    for (const side of ["pro", "con"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "proposal-adder-btn";
      b.textContent = side === "pro" ? "+ Pro" : "+ Con";
      b.addEventListener("click", () => {
        proposalsUi.addingPoint = { id: p.id, side };
        renderProposals();
        const input = document.getElementById(`proposal-point-${p.id}`);
        if (input) input.focus();
      });
      wrap.appendChild(b);
    }
    return wrap;
  }
  const form = document.createElement("form");
  form.className = "proposal-adder-form";
  const input = document.createElement("input");
  input.type = "text";
  input.id = `proposal-point-${p.id}`;
  input.maxLength = 200;
  input.placeholder = open === "pro" ? "A reason for it" : "A reason against it";
  input.setAttribute("aria-label", open === "pro" ? "New pro" : "New con");
  const add = document.createElement("button");
  add.type = "submit";
  add.className = "primary";
  add.textContent = open === "pro" ? "Add pro" : "Add con";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => { proposalsUi.addingPoint = null; renderProposals(); });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    const ok = await proposalWrite("/points", { proposalId: p.id, side: open, text });
    if (ok) { proposalsUi.addingPoint = null; renderProposals(); }
  });
  form.append(input, add, cancel);
  wrap.appendChild(form);
  return wrap;
}

// Admin only: how many games a trial runs before it becomes a house rule.
function buildProposalTrialControl(p) {
  const form = document.createElement("form");
  form.className = "proposal-trial";
  const label = document.createElement("label");
  label.htmlFor = `proposal-trial-${p.id}`;
  label.textContent = "Trial length (games)";
  const input = document.createElement("input");
  input.type = "number";
  input.id = `proposal-trial-${p.id}`;
  input.min = "1";
  input.max = "20";
  input.value = String(p.trialGames);
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save";
  form.addEventListener("submit", e => {
    e.preventDefault();
    const n = parseInt(input.value, 10);
    proposalWrite("/trial", { proposalId: p.id, trialGames: n });
  });
  form.append(label, input, save);
  return form;
}

// One write path for every proposal action. Returns true on success.
async function proposalWrite(path, payload) {
  if (proposalsUi.busy) return false;
  proposalsUi.busy = true;
  const status = document.getElementById("proposals-status");
  renderProposals();
  try {
    const res = await fetch(PROPOSALS_RELAY_URL + path, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    proposalsUi.busy = false;
    applyProposalsData(body);
    return true;
  } catch (err) {
    proposalsUi.busy = false;
    renderProposals();
    if (status) {
      status.hidden = false;
      status.textContent = err.message;
    }
    return false;
  }
}

function renderProposals() {
  const list = document.getElementById("proposals-list");
  if (!list) return;
  const heading = document.getElementById("proposals-heading");
  if (heading) heading.textContent = proposalsUi.filter === "adopted" ? "House Rules" : "Pod Proposals";

  document.querySelectorAll("[data-proposals-view]").forEach(b => {
    const on = b.dataset.proposalsView === proposalsUi.view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll("[data-proposals-filter]").forEach(b => {
    const on = b.dataset.proposalsFilter === proposalsUi.filter;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });

  const status = document.getElementById("proposals-status");
  if (!proposalsData) return;
  if (status && !proposalsUi.busy) {
    const n = proposalsAwaitingMyVote();
    status.hidden = false;
    status.textContent = `${proposalsData.activeCount} active players · ${proposalsData.majority} decides · `
      + (n ? `${n} waiting on your vote` : "you're all caught up");
  }

  list.innerHTML = "";
  const shown = proposalsData.proposals.filter(p => proposalsUi.filter === "active"
    ? p.status === "open" || p.status === "trial"
    : p.status === proposalsUi.filter);
  if (!shown.length) {
    const [title, body] = PROPOSAL_EMPTY[proposalsUi.filter];
    const empty = document.createElement("div");
    empty.className = "proposals-empty";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = body;
    empty.append(strong, span);
    list.appendChild(empty);
  } else {
    for (const p of shown) list.appendChild(buildProposalCard(p));
  }
  // The foil pass plays on the render where the vote passed and never again.
  proposalsUi.justPassed.clear();
}

// ---- the New proposal form ----

function proposalFormSides() {
  return proposalsUi.formKind === "rule"
    ? [["out", "What's out", "OUT", "The rule as it is now"], ["in", "What's in", "IN", "The new rule"]]
    : [["pro", "Pros", "PRO", "A reason for it"], ["con", "Cons", "CON", "A reason against it"]];
}

function addProposalBulletInput(listEl, side, tag, placeholder, value) {
  const inputs = listEl.querySelectorAll("input");
  if (inputs.length >= PROPOSAL_POINT_LIMIT) return null;
  const row = document.createElement("div");
  row.className = "proposal-bullet-row";
  const label = document.createElement("span");
  label.className = `proposal-tag proposal-tag-${side}`;
  label.textContent = tag;
  label.setAttribute("aria-hidden", "true");
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 200;
  input.placeholder = placeholder;
  input.dataset.side = side;
  input.id = `proposal-${side}-${inputs.length}`;
  input.setAttribute("aria-label", `${tag} bullet ${inputs.length + 1}`);
  if (value) input.value = value;
  row.append(label, input);
  listEl.appendChild(row);
  return input;
}

function renderProposalFormLists() {
  const host = document.getElementById("proposal-bullet-lists");
  if (!host) return;
  host.innerHTML = "";
  for (const [side, title, tag, placeholder] of proposalFormSides()) {
    const group = document.createElement("div");
    group.className = "proposal-field";
    const label = document.createElement("span");
    label.textContent = title;
    const list = document.createElement("div");
    list.className = "proposal-bullet-list";
    addProposalBulletInput(list, side, tag, placeholder);
    const more = document.createElement("button");
    more.type = "button";
    more.className = "proposal-add-bullet";
    more.textContent = "+ Add bullet";
    more.addEventListener("click", () => {
      const input = addProposalBulletInput(list, side, tag, placeholder);
      if (input) input.focus();
      if (list.querySelectorAll("input").length >= PROPOSAL_POINT_LIMIT) more.hidden = true;
    });
    group.append(label, list, more);
    host.appendChild(group);
  }
  const hint = document.getElementById("proposal-kind-hint");
  if (hint) {
    hint.textContent = proposalsUi.formKind === "rule"
      ? "What stops being the rule, and what replaces it."
      : "Something new to try. Give reasons for and against.";
  }
  document.querySelectorAll("[data-proposal-kind]").forEach(b => {
    const on = b.dataset.proposalKind === proposalsUi.formKind;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

function showProposalForm(show) {
  const form = document.getElementById("proposal-form");
  const newBtn = document.getElementById("proposals-new-btn");
  if (!form) return;
  form.hidden = !show;
  if (newBtn) newBtn.closest(".row").hidden = show;
  if (show) {
    form.reset();
    proposalsUi.formKind = "rule";
    renderProposalFormLists();
    const err = document.getElementById("proposal-form-error");
    if (err) err.hidden = true;
    document.getElementById("proposal-title").focus();
  }
}

// What the form still needs before it can be posted, or null when it's
// ready. Shared by the submit and by the live re-check as you type.
function proposalFormPayload() {
  const payload = {
    kind: proposalsUi.formKind,
    title: document.getElementById("proposal-title").value.trim(),
    appliesTo: document.getElementById("proposal-applies").value.trim(),
    anonymous: document.getElementById("proposal-anonymous").checked,
    out: [], in: [], pro: [], con: [],
  };
  document.querySelectorAll("#proposal-bullet-lists input").forEach(input => {
    const text = input.value.trim();
    if (text) payload[input.dataset.side].push(text);
  });
  let problem = null;
  if (!payload.title) problem = "Give it a title.";
  else if (payload.kind === "rule" && (!payload.out.length || !payload.in.length)) {
    problem = "A rule change needs at least one Out bullet and one In bullet.";
  } else if (payload.kind === "idea" && !payload.pro.length && !payload.con.length) {
    problem = "An idea needs at least one pro or con.";
  }
  return { payload, problem };
}

// Once a submit has said what's missing, the message follows the form as
// it's edited -- it updates to the next thing still needed and disappears
// the moment the form is complete, instead of lingering until the next
// submit. Never shown before a first submit: no scolding mid-sentence.
function recheckProposalForm() {
  const err = document.getElementById("proposal-form-error");
  if (!err || err.hidden || err.dataset.source !== "validation") return;
  const { problem } = proposalFormPayload();
  if (problem) err.textContent = problem;
  else err.hidden = true;
}

async function submitProposalForm(e) {
  e.preventDefault();
  const err = document.getElementById("proposal-form-error");
  const submit = document.getElementById("proposal-submit");
  const fail = (msg, source) => {
    err.textContent = msg;
    err.dataset.source = source;
    err.hidden = false;
    shakeNo(submit);
  };
  const { payload, problem } = proposalFormPayload();
  if (problem) return fail(problem, "validation");
  submit.disabled = true;
  submit.textContent = "Posting…";
  const ok = await proposalWrite("", payload);
  submit.disabled = false;
  submit.textContent = "Post to the pod";
  if (ok) {
    haptic([10, 40, 22]);
    showProposalForm(false);
    proposalsUi.filter = "active";
    renderProposals();
  } else {
    fail(document.getElementById("proposals-status").textContent, "server");
  }
}

function initProposals() {
  document.querySelectorAll("[data-proposals-view]").forEach(b => b.addEventListener("click", () => {
    if (proposalsUi.view === b.dataset.proposalsView) return;
    proposalsUi.view = b.dataset.proposalsView;
    proposalsUi.swapping = !REDUCED_MOTION.matches;
    renderProposals();
    proposalsUi.swapping = false;
  }));
  document.querySelectorAll("[data-proposals-filter]").forEach(b => b.addEventListener("click", () => {
    proposalsUi.filter = b.dataset.proposalsFilter;
    renderProposals();
  }));
  document.querySelectorAll("[data-proposal-kind]").forEach(b => b.addEventListener("click", () => {
    proposalsUi.formKind = b.dataset.proposalKind;
    renderProposalFormLists();
    recheckProposalForm();
  }));
  const newBtn = document.getElementById("proposals-new-btn");
  if (newBtn) newBtn.addEventListener("click", () => showProposalForm(true));
  const cancel = document.getElementById("proposal-cancel");
  if (cancel) cancel.addEventListener("click", () => showProposalForm(false));
  const form = document.getElementById("proposal-form");
  if (form) {
    form.addEventListener("submit", submitProposalForm);
    form.addEventListener("input", recheckProposalForm);
  }
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
  authUnreachable = false;
  try {
    const res = await fetch(AUTH_ME_RELAY_URL, { headers: authHeaders() });
    // Only a 401 means the relay looked this token up and it's gone. Any
    // other failure (offline, a timeout, a relay 5xx) says nothing about the
    // token -- forgetting it there used to send someone with one bad bar of
    // signal at the table back through Discord sign-in.
    if (res.status === 401) {
      sessionToken = null;
      currentUser = null;
      localStorage.removeItem("sessionToken");
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      currentUser = await res.json();
    }
  } catch {
    currentUser = null;
    authUnreachable = true;
    showAuthStatusHint("Couldn't reach the server. You're still signed in — check your connection and try again.");
  }
  renderAuthControl();
  renderAuthGate();
}

function renderAuthControl() {
  const avatarImg = document.getElementById("auth-avatar-img");
  if (!avatarImg) return;
  const initialEl = document.getElementById("auth-avatar-initial");
  // A missing or broken avatar used to show its alt text squeezed into the
  // circle; the initial stands in instead.
  const showInitial = on => {
    avatarImg.hidden = on;
    if (initialEl) initialEl.hidden = !on;
  };
  if (currentUser) {
    avatarImg.alt = `Signed in as ${currentUser.username}`;
    if (initialEl) initialEl.textContent = (currentUser.username || "?").charAt(0).toUpperCase();
    avatarImg.onerror = () => showInitial(true);
    if (currentUser.avatarUrl) {
      showInitial(false);
      avatarImg.src = currentUser.avatarUrl;
    } else {
      avatarImg.removeAttribute("src");
      showInitial(true);
    }
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
  const gateBtn = document.getElementById("signin-gate-btn");
  if (gateBtn) gateBtn.textContent = authUnreachable ? "Try again" : "Sign in with Discord";
  const gateLead = document.getElementById("signin-gate-lead");
  if (gateLead) gateLead.hidden = authUnreachable;
}

function wireAuthControl() {
  // A full-page redirect, not a fetch -- Discord's authorize page has to
  // be top-level navigation (it can't be loaded in an iframe/XHR), and
  // client_id/redirect_uri are both public so no relay round trip is
  // needed just to send the browser there. See DISCORD_AUTHORIZE_URL.
  const gateSigninBtn = document.getElementById("signin-gate-btn");
  if (gateSigninBtn) {
    gateSigninBtn.addEventListener("click", () => {
      // The token is still stored when the server was merely unreachable,
      // so a plain reload re-runs the session check rather than starting
      // a fresh Discord sign-in.
      if (authUnreachable) { location.reload(); return; }
      window.location.href = DISCORD_AUTHORIZE_URL;
    });
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

  // The menu is Proposals' only way in -- it has no tab-bar button.
  const proposalsBtn = document.getElementById("auth-proposals-btn");
  if (proposalsBtn) proposalsBtn.addEventListener("click", () => { hideAuthMenu(); openProposalsTab("active"); });
  const houseRulesBtn = document.getElementById("auth-house-rules-btn");
  if (houseRulesBtn) houseRulesBtn.addEventListener("click", () => { hideAuthMenu(); openProposalsTab("adopted"); });

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
// Confirmed from two real-device screenshots of this exact bug, same
// phone, same load, different tabs: both reported the true physical
// screen as 393x852, but window.innerHeight/visualViewport.height read
// 793 on Tonight (short, nothing to scroll) and the correct 852 on Pod
// (tall, genuinely scrollable) -- 793 is exactly 852 minus this device's
// own safe-area-inset-top (59px). Not a measurement this app's CSS could
// ever get right by reading it more carefully or more often: iOS itself
// is computing visualViewport/innerHeight differently depending on
// whether the DOCUMENT happens to be scrollable, which the spec doesn't
// say should matter at all. Two earlier fixes both trusted that
// measurement at face value and just tried to apply it more forcefully
// (min-height cascade, then a GPU compositing layer on the bar) --
// neither could work, because the number they were building on was
// itself wrong on exactly the tab that needed it most.
//
// A first fix tried forcing the document tall (min-height: 4000px) and
// reading visualViewport.height back synchronously, on the theory that
// "genuinely scrollable" was the condition that mattered -- confirmed
// wrong by a second real-device screenshot showing no change at all
// (still 793). visualViewport.height isn't a synchronous layout
// property the way offsetHeight is; resizing the DOM under it doesn't
// make the browser recompute it on the spot.
//
// What actually reads correctly is a real scroll -- which is what
// activateTab's own window.scrollTo(0) was already incidentally doing
// on every tab switch, and is the entire reason switching tabs and back
// was the original workaround. So: make the page tall enough to have
// somewhere to scroll, perform a real (1px, invisible) scroll away and
// back, and wait for the browser to actually tell us it's done
// recomputing (a visualViewport resize event) rather than assuming any
// fixed delay is long enough -- with a timeout fallback in case this
// browser doesn't fire one at all, so a short page still ends up with
// SOME value instead of hanging forever.
//
// That scroll trick is only ever safe at the very top of the page, though:
// its scrollTo(0, 0) is "invisible" there, but anywhere else it throws the
// user back to the top. And this runs on every resize, not just on load --
// including the on-screen keyboard opening and closing, which is a
// visualViewport resize. Confirmed the hard way on Games to Update: tapping
// any field partway down the game form (Disruptions, KOs...) opened the
// keyboard, which yanked the page to the top and left the field being
// typed into ~1900px off-screen, again on every field. Hence the two
// early-outs below: a keyboard resize is ignored outright (the keyboard-
// shrunk height is the wrong value for --app-vh anyway -- it's meant to be
// the full screen), and a page that's already scrolled just gets read
// directly -- it's genuinely scrollable and a real scroll has already
// happened, the exact state the trick exists to force, so there's nothing
// to fix up and no reason to move the page.
const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image", "hidden"]);
function isTextEntryFocused() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !NON_TEXT_INPUT_TYPES.has(el.type);
}

function readViewportHeight() {
  return window.visualViewport ? window.visualViewport.height : window.innerHeight;
}

let syncingViewportHeight = false;
function syncViewportHeight() {
  if (syncingViewportHeight) return; // guards against a resize this itself triggers
  if (isTextEntryFocused()) return;

  const root = document.documentElement;
  if ((window.scrollY || root.scrollTop) > 0) {
    syncedViewportHeight = readViewportHeight();
    root.style.setProperty("--app-vh", `${syncedViewportHeight}px`);
    return;
  }

  syncingViewportHeight = true;
  let finished = false;
  const finish = () => {
    if (finished) return; // the resize listener and the safety-net timeout below can both fire
    finished = true;
    syncedViewportHeight = readViewportHeight();
    root.style.setProperty("--app-vh", `${syncedViewportHeight}px`);
    root.style.minHeight = "";
    syncingViewportHeight = false;
  };

  root.style.minHeight = "4000px";
  // Both scrollTo calls back to back, no requestAnimationFrame between
  // them -- rAF doesn't reliably fire for a tab that isn't actively
  // visible/foregrounded (confirmed the hard way: the previous version
  // of this left min-height stuck at 4000px and --app-vh never set at
  // all, a real regression, worse than the bug it was fixing).
  window.scrollTo(0, 1);
  window.scrollTo(0, 0);

  if (window.visualViewport) {
    const onResize = () => {
      window.visualViewport.removeEventListener("resize", onResize);
      finish();
    };
    window.visualViewport.addEventListener("resize", onResize);
  }
  // Unconditional safety net, independent of whether a resize event (or
  // anything else above) ever actually fires -- guarantees this always
  // finishes and cleans up min-height within half a second no matter
  // what, rather than risking getting stuck again.
  setTimeout(finish, 500);
}

// Only a change in height re-syncs. On a desktop with classic scrollbars,
// the 4000px stretch above makes a scrollbar appear, which narrows the
// visual viewport and fires its resize; the stretch ending removes the
// scrollbar and fires it again -- which, before this check, started the
// next stretch, forever. On any page short enough to fit the window that
// flipped the scrollbar on and off every frame and shook the whole page
// sideways (seen on two PCs, Oct 2026; phones overlay their scrollbars,
// so they never showed it). --app-vh only cares about height anyway.
let syncedViewportHeight = null;
function onViewportResize() {
  if (readViewportHeight() === syncedViewportHeight) return;
  syncViewportHeight();
}

function initViewportHeight() {
  syncViewportHeight();
  window.addEventListener("resize", onViewportResize);
  window.addEventListener("orientationchange", onViewportResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportResize);
  }
}

// Fades the palette across instead of swapping it in one frame (see
// html.theme-easing in style.css). The class only has to be present when
// the new colours land; it's taken off again once the fade is done so
// nothing else ever transitions the tokens.
let themeEaseTimer = null;
function easeThemeChange(change) {
  const root = document.documentElement;
  root.classList.add("theme-easing");
  if (change) change();
  clearTimeout(themeEaseTimer);
  themeEaseTimer = setTimeout(() => root.classList.remove("theme-easing"), 600);
}

function initTheme() {
  applyTheme(localStorage.getItem("themePreference"));
  document.querySelectorAll(".theme-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      easeThemeChange(() => {
        const choice = applyTheme(btn.dataset.themeChoice);
        localStorage.setItem("themePreference", choice);
      });
    });
  });
  // On Auto, the OS flipping at sunset fades too, rather than snapping
  // the whole screen dark mid-game.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => easeThemeChange());
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
  const icon = document.getElementById("pull-refresh-icon");
  if (!indicator) return;

  const THRESHOLD = 64; // px of indicator before a release actually triggers a refresh
  const MAX_PULL = 110; // px -- the asymptote the indicator approaches, never reaches
  const REST = 48; // px held open while refreshing
  let startY = null;
  let pulling = false; // true only once a real downward pull-at-the-top has been confirmed, not just any touch
  let refreshing = false;
  let armed = false; // past THRESHOLD right now -- a release here refreshes
  const tracker = createVelocityTracker();

  // Height, not a transform: the cards below have to move down with it,
  // and translating them would recompute their backdrop blur every frame
  // (web-animation rule 5). It's a strip at the very top, so only the
  // page below it reflows -- what the old 0.2s height transition did too.
  const title = document.querySelector("header h1");
  const render = (h) => {
    const height = Math.max(0, h);
    indicator.style.height = `${height}px`;
    // The big title stretches a little as the page is pulled past its top,
    // like an iOS large title -- the pull visibly has hold of the page.
    if (title) title.style.transform = height > 0.5 ? `scale(${1 + height / 700})` : "";
    if (refreshing) return;
    // The arrow winds round as the pull grows and points the way it's
    // going -- progress you can read before letting go.
    const progress = Math.min(1, height / THRESHOLD);
    if (icon) {
      icon.style.transform = `rotate(${progress * 270}deg) scale(${0.6 + 0.4 * progress})`;
      icon.style.opacity = String(Math.min(1, progress * 1.4));
    }
  };
  const spring = new Spring(0, render);

  document.addEventListener("touchstart", (e) => {
    // Only ever the start of a pull if there's something to refresh
    // (signed in -- refreshEverything no-ops otherwise anyway) and nothing
    // above to scroll past. Re-checked on every touchstart, not cached,
    // since sign-in state and scroll position both change between pulls.
    if (refreshing || !currentUser || (window.scrollY || document.documentElement.scrollTop) > 0 || touchBelongsToInnerScroll(e.target) || edgeBackClaims(e.touches[0].clientX)) {
      startY = null;
      return;
    }
    startY = e.touches[0].clientY;
    pulling = false;
    armed = false;
    tracker.reset();
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (startY == null || refreshing) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0 || (window.scrollY || document.documentElement.scrollTop) > 0) {
      // Finger moved up, or the page scrolled out from under a pull
      // already in progress (e.g. content grew) -- bail rather than keep
      // tracking a gesture that no longer means "pull to refresh".
      startY = null;
      if (pulling) spring.to(0, { response: 0.3 });
      pulling = false;
      return;
    }
    pulling = true;
    // Resists more the further it goes, approaching MAX_PULL without ever
    // hitting a hard stop -- a cap that suddenly stops following the
    // finger reads as frozen. Starts out following ~70% of the finger.
    const pull = MAX_PULL * (1 - Math.exp(-delta / 160));
    tracker.add(pull, e.timeStamp);
    spring.set(pull);
    const nowArmed = pull >= THRESHOLD;
    if (nowArmed !== armed) {
      armed = nowArmed;
      indicator.classList.toggle("armed", armed);
      // One tick as it crosses into "release to refresh" -- the commit
      // point, on the same frame the icon fills in.
      if (armed) haptic(8);
    }
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
    pulling = false;
    startY = null;
    indicator.classList.remove("armed");
    // The finger's own velocity carries straight into the settle, so
    // letting go doesn't stall for a frame before springing.
    const velocity = tracker.velocity();
    if (armed) {
      armed = false;
      refreshing = true;
      indicator.classList.add("refreshing");
      if (icon) { icon.style.transform = ""; icon.style.opacity = ""; }
      spring.to(REST, { dampingRatio: REDUCED_MOTION.matches ? 1 : 0.8, response: 0.3, velocity });
      try {
        // A pull used to clear the pod as well. Not any more: the table is
        // shared now, and one person's pull would empty it for everyone.
        // "Clear the table" (with Undo) is how a pod starts fresh.
        await Promise.all([refreshEverything(), pollLiveTable(true)]);
      } finally {
        indicator.classList.remove("refreshing");
        refreshing = false;
        spring.to(0, { response: 0.32 });
      }
    } else {
      spring.to(0, { response: 0.3, velocity });
    }
  });
}

// A drag that starts inside something with its own scroll -- the deck list
// in an open seat (.pod-decks), or any open modal -- belongs to that box,
// not to the page. Checking only the page's scroll position treated
// dragging a long deck list back up as a pull, which blocked the list from
// scrolling and, past the threshold, cleared the pod.
function touchBelongsToInnerScroll(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest(".modal-overlay:not([hidden])")) return true;
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
  }
  return false;
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

// Runs before anything else in this section so there's no flash of the
// wrong theme after a stored explicit choice -- see initTheme/applyTheme.
initTheme();

// Must run before checkAuthSession -- consumes a just-completed Discord
// redirect (if any) so sessionToken is set before the very first /auth/me
// check uses it.
consumeAuthRedirect();
wireAuthControl();
initPullToRefresh();
initSelectionIndicators();
initScrollEdge();
initCompactBar();
initEdgeBack();
initTrophyTilt();
initHoverHighlights();

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
    initLiveTable();
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
    initProposals();
    loadProposals();
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
  await Promise.all([syncFromD1(), refreshPlaygroupGames(), loadRosterDiff(), refreshAchievementsView(), loadProposals()]);
}

// Only fires on an actual open/return to the app, not a timer -- catches
// up the instant it's looked at again instead of leaving stale data on
// screen, without polling in the background the rest of the time.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshEverything();
});

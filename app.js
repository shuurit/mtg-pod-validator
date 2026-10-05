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
// True once the last check passed and nothing has changed since: the orbs
// show each deck's colours and the nameplates its name. Any change to the
// pod (a seat added, removed or re-decked, on any phone) masks it again.
let podRevealed = false;
// The table's current turn in degrees (see turnPodTable). Local to this
// phone -- everyone turns their own view. Accumulates rather than wrapping,
// so each turn takes the short way round.
let podSpin = 0;
// The table's DOM, built once by buildPodTable and reused on every render so
// thrones can glide between positions instead of being rebuilt.
let podUi = null;
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

function renderTonight() {
  const host = document.getElementById("tonight-body");
  if (!host) return;
  host.innerHTML = "";

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
  host.appendChild(action);

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
    one: "game to log",
    many: "games to log",
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

  host.appendChild(list);

  // --- your season ---
  const myName = currentUser && players.length
    ? (players.find(p => p.id === currentUser.playerId) || {}).name
    : null;
  const myRow = myName && latestStandings
    ? latestStandings.rows.find(r => r.name === myName)
    : null;

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
  setPlayers(data.players.map(p => ({
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

// One shelf per category, in the order relay.js sends them.
function renderTrophyCaseShelves(d) {
  const root = document.getElementById("trophy-case-list");
  if (!root) return;
  root.innerHTML = "";
  for (const cat of d.categories) {
    const slots = d.slots.filter(s => s.category === cat.id);
    if (!slots.length) continue;
    const won = slots.filter(s => s.won).length;
    const shelf = tcEl("section", "tc-shelf");
    const head = tcEl("div", "tc-shelf-head");
    head.appendChild(tcEl("h3", "tc-shelf-title", cat.label));
    head.appendChild(tcEl("span", "tc-shelf-count" + (won === slots.length ? " tc-shelf-full" : ""), `${won}/${slots.length}`));
    shelf.appendChild(head);
    const grid = tcEl("div", "tc-shelf-grid");
    for (const slot of slots) grid.appendChild(buildTrophyCaseCard(slot, d));
    shelf.appendChild(grid);
    root.appendChild(shelf);
  }
}

// Same art/title/description anatomy as renderAchievements' cards, plus
// the Trophy Case extras: prestige frame, status tag, pin marker, rarity,
// and the runner-up box on locked slots. Opens showTrophyDetailModal via
// the delegated handler in initAchievementsTab.
function buildTrophyCaseCard(slot, d) {
  const tier = trophyPrestigeTier(slot.count);
  const card = tcEl("div", "trophy-card tc-card" + (slot.won ? "" : " trophy-card-locked") + (tier ? ` tc-prestige-${tier}` : ""));
  card.dataset.id = slot.id;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${slot.title}, ${slot.won ? "won" : "locked"}. Show details.`);

  if (slot.status) card.appendChild(tcEl("span", `tc-status tc-status-${slot.status}`, TROPHY_STATUS_LABEL[slot.status]));
  if (slot.pinned) {
    const pin = tcEl("span", "tc-pin-marker");
    pin.title = "Pinned to Player Win Rates";
    pin.innerHTML = PIN_ICON_SVG;
    card.appendChild(pin);
  }

  card.appendChild(trophyEmblemNode(slot));
  card.appendChild(tcEl("div", "trophy-title", slot.title));

  const body = tcEl("div", "trophy-body");
  body.appendChild(tcEl("div", "trophy-description", slot.description));
  if (slot.won) {
    const winnerRow = tcEl("div", "trophy-winner");
    winnerRow.appendChild(tcEl("span", "trophy-winner-name", slot.latestSeasonLabel));
    winnerRow.appendChild(tcEl("span", "trophy-winner-value", slot.latestDisplay));
    body.appendChild(winnerRow);
    if (tier) body.appendChild(tcEl("div", "tc-tier-label", trophyTierLabel(slot.count)));
  } else {
    body.appendChild(tcEl("div", "trophy-empty", "Locked"));
    if (slot.runnerUp) body.appendChild(buildRunnerUpBox(slot, d));
  }
  const rarity = trophyRarity(slot, d);
  body.appendChild(tcEl("span", `tc-rarity tc-rarity-${rarity.tier}`, rarity.label));
  card.appendChild(body);
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
  const art = tcEl("div", "tc-detail-art" + (slot.won ? "" : " trophy-card-locked") + (tier ? ` tc-prestige-${tier}` : ""));
  art.appendChild(trophyEmblemNode(slot));
  body.appendChild(art);
  body.appendChild(tcEl("h2", null, slot.title));
  body.appendChild(tcEl("p", "hint tc-detail-desc", slot.description));

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

  modal.hidden = false;
}

function hideTrophyDetailModal() {
  const modal = document.getElementById("trophy-detail-modal");
  if (modal) modal.hidden = true;
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
  modal.hidden = false;
  drawTrophyCaseCard(document.getElementById("case-card-canvas"), trophyCaseData);
}

function hideCaseCardModal() {
  const modal = document.getElementById("case-card-modal");
  if (modal) modal.hidden = true;
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
function renderAchievements(achievements, seasonActive) {
  const container = document.getElementById("achievements-list");
  container.innerHTML = "";
  // A live season has no winners to show yet, so every card is just art,
  // a title and a rule. At full size that was 28 tall cards of nothing to
  // act on; sealed, they pack into small tiles.
  container.classList.toggle("is-sealed", !!seasonActive && !achievements.some(a => a.winner));

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
      // Lazy: the season grid draws every achievement at once, and the art
      // further down shouldn't hold up the first screenful.
      img.loading = "lazy";
      img.decoding = "async";
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

    card.appendChild(body);
    container.appendChild(card);
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
  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
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

  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
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
      showClosingCeremonyModal(lastAchievementsData.achievements, season ? season.label : "");
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
      expandedPlayerId = isExpanded ? null : player.id;
      renderPlayersTable();
    });

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
  }));
  podRevealed = !!view.revealed;
  lastCeiling = view.ceiling ?? null;
  liveTableStale = !!view.stale;
  liveTableCheck = view.check || null;
  liveTableLoaded = true;

  // Someone joining on any phone pulls a throne up on every phone -- but
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
    else shakeFlaggedOrbs();
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
  toast.hidden = false;
  clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(hideUndoToast, 8000);
}

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

// ---------- Set Up Pod: the gathering table ----------
// A wizard's table in CSS 3D. Tapping a member on the rail pulls a throne
// up with a glass orb of spellfire in it; tapping a nameplate (or the
// button) turns that seat to face you and docks its deck panel under the
// table. The orb carries the seat's whole state (see podSeatState):
//   waiting  -- seated, no deck yet: a low violet pilot flame
//   sealed   -- deck picked and hidden: full spellfire, identical for all
//   flagged  -- over the last check's range: hellfire behind cracked glass
//   revealed -- the pod passed: each flame burns in its deck's colours
// The deck stays masked exactly as before until the whole pod passes.
//
// Everything below runs only after initLiveTable (renderPodSlots bails
// until then): these consts sit far below the load-time render that
// setPlayers triggers, and the pod tab is behind the sign-in gate anyway.

const POD_MAX_SEATS = 8;
const POD_SEAT_RADIUS = 132; // px, table centre to each throne
const POD_SEAT_TUCKED = 72; // px, under the table's edge: where thrones slide from/to
// The ring-shaped top, in the 0-100 sigil/carving space (table radius 50):
// the open well, the groove between the two plank bands, and the inner
// band's middle where each seat's sigil node sits. POD_HOLE_R must match
// the 34% in .pod-table's --pod-hole mask.
const POD_HOLE_R = 17;
const POD_GROOVE_R = 27;
const POD_NODE_R = 22;
// Flame colours per mana colour, outer edge and hot centre. Fixed material,
// like the pips: black burns as dark violet smoke-fire so it still reads as
// fire in dark glass, colorless as pale silver.
const POD_FIRE = {
  W: { e: "#e8b84a", c: "#fff6d8" },
  U: { e: "#1f5fe0", c: "#a8e0ff" },
  B: { e: "#3a1a5e", c: "#b98cff" },
  R: { e: "#e0260f", c: "#ffc46b" },
  G: { e: "#118a3e", c: "#bcff8a" },
  C: { e: "#8f97a6", c: "#eef1f6" },
};
const POD_GLOW = {
  W: "rgba(255,226,150,.7)", U: "rgba(61,143,255,.75)", B: "rgba(150,110,220,.7)",
  R: "rgba(255,80,40,.75)", G: "rgba(60,210,110,.7)", C: "rgba(220,226,236,.6)",
};
// Back to front: the aura that glances, the glass (plasma swirl, inner
// fire, crack, gloss, sweep), the flame rising out of it, then embers and
// sparks. Which of them burn, and how hard, is all CSS per state.
const POD_ORB_HTML =
  '<span class="pod-orb-float"><span class="pod-orb-aura"></span>' +
  '<span class="pod-orb"><span class="pod-plasma"></span><span class="pod-fire"><span class="pod-fire-core"></span>' +
  '<i class="pod-tw pod-tw4"><i></i></i><i class="pod-tw pod-tw5"><i></i></i>' +
  '<i class="pod-tw pod-tw1"><i></i></i><i class="pod-tw pod-tw2"><i></i></i><i class="pod-tw pod-tw3"><i></i></i></span>' +
  '<svg class="pod-orb-crack" viewBox="0 0 40 40" aria-hidden="true"><polyline points="15,2 19,12 13,18 21,25 17,38" fill="none" stroke="rgba(255,230,200,.75)" stroke-width="1.3" stroke-linejoin="round"/><polyline points="19,12 27,14" fill="none" stroke="rgba(255,230,200,.6)" stroke-width="1"/><polyline points="21,25 28,29" fill="none" stroke="rgba(255,230,200,.5)" stroke-width="0.9"/></svg>' +
  '<span class="pod-orb-gloss"></span><span class="pod-orb-sweep"></span></span>' +
  '<span class="pod-flame"><i class="pod-pf pod-pf2"><i></i></i><i class="pod-pf pod-pf3"><i></i></i><i class="pod-pf pod-pf1"><i></i></i></span>' +
  ["e1", "e2", "e3", "e4", "e5", "e6"].map(e => `<i class="pod-ember ${e}"></i>`).join("") +
  '<i class="pod-ember spark s1"></i><i class="pod-ember spark s2"></i></span>';

// playerId -> { chair, plate } for every seat currently at the table.
const podSeatEls = new Map();
// Player ids whose throne should slide in on the next render. Only a member
// tapped onto the table (or an undo) gets an entrance -- a restored pod or a
// background data refresh just shows the thrones where they already are.
const podSeatsEntering = new Set();
let podPanelWasOpen = false;

function podAngle(i, n) {
  return n ? (i * 360) / n : 0;
}

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
// for a nameplate ("Atraxa", "Eshki"); the full name rides in the tooltip.
function podShortDeckName(name) {
  return stripDeckDisambiguation(name).split(/[,/]/)[0].trim();
}

// Each flame tongue takes one of the deck's colours, cycling if it has fewer
// than three. Unknown identity (never captured) burns foil gold, the same
// "no claim" stance buildIdentityCoin takes by not drawing a coin at all.
function setPodRevealFire(chair, colorIdentity) {
  let keys;
  if (colorIdentity === null || colorIdentity === undefined) keys = null;
  else {
    keys = WUBRG_ORDER.filter(c => colorIdentity.includes(c));
    if (keys.length === 0) keys = ["C"];
  }
  const pick = k => (keys ? POD_FIRE[keys[k % keys.length]] : { e: "#a8812b", c: "#ffe6a6" });
  chair.style.setProperty("--r-e1", pick(0).e);
  chair.style.setProperty("--r-c1", pick(0).c);
  chair.style.setProperty("--r-e2", pick(1).e);
  chair.style.setProperty("--r-c2", pick(1).c);
  chair.style.setProperty("--r-c3", pick(2).c);
  chair.style.setProperty("--r-glow", keys ? POD_GLOW[keys[0]] : "rgba(201,161,63,.55)");
}

function buildPodTable(container) {
  const ui = {};

  const scene = document.createElement("div");
  scene.className = "pod-scene";
  // Static decoration, drawn once: the floor circle, and the table's
  // carving -- two bands of eight planks with staggered seams, grooves at
  // the well's lip, between the bands and at the bevel, and a scroll
  // carved into each outer plank. Our own drawing, in the spirit of a
  // carved round table, not a copy of any one.
  const marks = Array.from({ length: 12 }, (_, i) => {
    const t = (i * Math.PI) / 6;
    return `M${(50 + 45 * Math.sin(t)).toFixed(2)} ${(50 + 45 * Math.cos(t)).toFixed(2)}L${(50 + 48 * Math.sin(t)).toFixed(2)} ${(50 + 48 * Math.cos(t)).toFixed(2)}`;
  }).join("");
  const scroll =
    "M-8 0.6C-8.6-1.8-5.6-2.8-4.6-0.9C-3.9 0.5-5.4 1.4-6.1 0.4" +
    "M-4.6-0.9C-2.4 2.6 2.4 2.6 4.6-0.9" +
    "M8 0.6C8.6-1.8 5.6-2.8 4.6-0.9C3.9 0.5 5.4 1.4 6.1 0.4" +
    "M0 1.7C-0.6 0 0.4-1.6 1.8-1.9M0 1.7C0.6 0-0.4-1.6-1.8-1.9";
  let carving = [POD_HOLE_R + 0.6, POD_GROOVE_R, 44.3].map(r => `<circle class="groove" cx="50" cy="50" r="${r}"/>`).join("");
  for (let k = 0; k < 8; k++) {
    const seam = (deg, r1, r2) => {
      const [x1, y1] = podSigilPoint(r1, deg);
      const [x2, y2] = podSigilPoint(r2, deg);
      return `<line class="seam" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
    };
    carving += seam(22.5 + k * 45, POD_HOLE_R + 0.6, POD_GROOVE_R) + seam(k * 45, POD_GROOVE_R, 44.3);
    const deg = 22.5 + k * 45;
    const [sx, sy] = podSigilPoint(35.6, deg);
    carving += `<g transform="translate(${sx.toFixed(2)} ${sy.toFixed(2)}) rotate(${deg})"><path class="scroll-hi" transform="translate(0.3 0.4)" d="${scroll}"/><path class="scroll" d="${scroll}"/></g>`;
  }
  const apron = [43, 39, 35, 31, 27, 23, 19]
    .map(z => `<div class="pod-table-apron" style="transform: translateZ(-${z}px)"></div>`)
    .join("");
  const legs = [30, 90, 150, 210, 270, 330]
    .map(a => `<div class="pod-table-leg" style="--leg-a: ${a}deg"></div>`)
    .join("");
  const layers = [12, 10, 8, 6, 4, 2]
    .map(z => `<div class="pod-table-layer${z === 2 ? " edge" : ""}" style="transform: translateZ(-${z}px)"></div>`)
    .join("");
  scene.innerHTML = `
    <div class="pod-rig">
      <div class="pod-floor-sigil" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48"/><circle cx="50" cy="50" r="45" stroke-dasharray="0.8 2.2"/><circle cx="50" cy="50" r="40"/><path d="${marks}"/></svg></div>
      <div class="pod-floor-shadow"></div>
      <div class="pod-table" aria-hidden="true">
        <div class="pod-table-legs">${legs}</div>
        ${apron}
        <div class="pod-table-apron pod-table-well" style="transform: translateZ(-15px)"></div>
        ${layers}
        <div class="pod-table-top"><svg class="pod-table-carving" viewBox="0 0 100 100">${carving}</svg></div>
        <div class="pod-slate">
          <svg class="pod-sigil" viewBox="0 0 100 100"></svg>
          <div class="pod-slate-label"><span class="pod-slate-count">0</span><span class="pod-slate-word">Seats</span></div>
        </div>
      </div>
      <div class="pod-chairs"></div>
    </div>
    <div class="pod-plates"></div>
    <p class="pod-scene-empty">Tap a member below to pull up a chair.</p>`;
  container.appendChild(scene);

  ui.scene = scene;
  ui.rig = scene.querySelector(".pod-rig");
  ui.rig.addEventListener("transitionend", e => { if (e.target === ui.rig) positionPodPlates(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) trackPodPlates(900); });
  ui.chairs = scene.querySelector(".pod-chairs");
  ui.plates = scene.querySelector(".pod-plates");
  ui.table = scene.querySelector(".pod-table");
  ui.sigil = scene.querySelector(".pod-sigil");
  ui.count = scene.querySelector(".pod-slate-count");
  ui.word = scene.querySelector(".pod-slate-word");
  ui.empty = scene.querySelector(".pod-scene-empty");

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

  // The table is sized off the card's width (and re-pinned when the pod tab
  // goes from hidden to shown, which this also catches as a resize).
  if ("ResizeObserver" in window) new ResizeObserver(fitPodScene).observe(scene);
  initPodScenePause(scene);
  return ui;
}

// Holds every flame and ember still while the table is scrolled out of
// view (see .pod-scene.is-offscreen) -- up to ~200 animations nobody can
// see. A hidden Pod tab already stops them on its own (display: none).
function initPodScenePause(scene) {
  if (!("IntersectionObserver" in window)) return;
  new IntersectionObserver(entries => {
    for (const entry of entries) scene.classList.toggle("is-offscreen", !entry.isIntersecting);
  }).observe(scene);
}

function fitPodScene() {
  if (!podUi) return;
  const w = podUi.scene.clientWidth;
  if (w > 0) podUi.scene.style.setProperty("--pod-fit", Math.min(1, w / 372).toFixed(3));
  trackPodPlates(60);
}

function buildPodChair(playerId) {
  const chair = document.createElement("div");
  chair.className = "pod-chair";
  // Two throne carvings, spire and crest, alternating by player rather than
  // seat so a throne keeps its look when the seats around it shift.
  if (Number(playerId) % 2 === 0) chair.classList.add("crest");
  // Desyncs this seat's bob and flame from its neighbours'.
  chair.style.setProperty("--pod-d", `${(-Math.random() * 3.2).toFixed(2)}s`);
  chair.innerHTML =
    '<div class="pod-chair-shadow"></div>' +
    '<div class="pod-chair-legs back"></div><div class="pod-chair-legs front"></div>' +
    '<div class="pod-chair-side left"></div><div class="pod-chair-side right"></div>' +
    '<div class="pod-chair-seat"></div>' +
    // The orb's light on its seat and on the table in front of it.
    '<div class="pod-chair-light seat"></div><div class="pod-chair-light table"></div>' +
    '<div class="pod-chair-arm left"></div><div class="pod-chair-arm right"></div>' +
    '<div class="pod-chair-back"><span class="pod-chair-glow"></span><span class="pod-chair-gem"></span></div>' +
    `<div class="pod-bb"><span class="pod-orb-hit" aria-hidden="true">${POD_ORB_HTML}</span><span class="pod-plate-anchor"></span></div>`;
  // The orb is a pointer shortcut; the nameplate is the real (focusable) control.
  chair.querySelector(".pod-orb-hit").addEventListener("click", () => tapPodSeat(playerId));
  // Re-pin the nameplates when a glide actually finishes. The timers in
  // trackPodPlates can run out while a hidden page holds the transition at
  // its start, leaving plates pinned where the throne started, not ended.
  chair.addEventListener("transitionend", e => { if (e.target === chair) positionPodPlates(); });
  return chair;
}

function buildPodPlate(playerId) {
  const plate = document.createElement("button");
  plate.type = "button";
  plate.className = "pod-plate";
  plate.innerHTML = '<span class="pod-plate-name"></span><span class="pod-plate-state"></span>';
  plate.addEventListener("click", () => tapPodSeat(playerId));
  return plate;
}

function updatePodSeat(entry, slot, i, n) {
  const { chair, plate } = entry;
  const state = podSeatState(slot);
  const player = podPlayerOf(slot);
  const deck = podDeckOf(slot);
  chair.style.setProperty("--pod-a", `${podAngle(i, n)}deg`);
  chair.style.setProperty("--pod-i", i);
  if (state !== "revealed") chair.classList.remove("no-enter");
  const locked = podSeatLocked(slot);
  for (const el of [chair, plate]) {
    el.classList.remove("is-waiting", "is-sealed", "is-flagged", "is-revealed");
    el.classList.add(`is-${state}`);
    el.classList.toggle("is-focus", editingSeatIndex === i);
    el.classList.toggle("is-locked", locked);
  }
  // Not `disabled`: a disabled button swallows the tap silently, which read
  // as being locked out with no reason given. aria-disabled keeps it
  // focusable and announced, and tapPodSeat explains the lock.
  if (locked) plate.setAttribute("aria-disabled", "true");
  else plate.removeAttribute("aria-disabled");

  const name = player ? player.name : "…";
  plate.querySelector(".pod-plate-name").textContent = name;
  const stateEl = plate.querySelector(".pod-plate-state");
  plate.removeAttribute("title");
  let spoken;
  if (podPendingPicks.has(slot.playerId)) {
    stateEl.textContent = "Sealing…";
    spoken = "sealing a deck";
  } else if (state === "waiting") {
    stateEl.textContent = "Pick a deck";
    spoken = "no deck yet";
  } else if (state === "flagged") {
    stateEl.textContent = "Over range";
    spoken = "deck over this pod's range";
  } else if (state === "sealed") {
    stateEl.innerHTML = `${uiIcon("lock")}<span>${slot.outOfRange && slot.repicked ? "Re-check" : "Sealed"}</span>`;
    spoken = slot.outOfRange && slot.repicked ? "new deck sealed, check again" : "deck sealed";
  } else {
    stateEl.textContent = deck ? podShortDeckName(deck.name) : "";
    if (deck) plate.title = deck.name;
    setPodRevealFire(chair, deck ? deck.colorIdentity : null);
    spoken = deck ? deck.name : "deck revealed";
  }
  plate.setAttribute("aria-label", `Seat ${i + 1}, ${name}, ${spoken}${locked ? `. Only ${name} can change this seat.` : ""}`);
}

function renderPodChairs() {
  const n = podSelections.length;
  const seated = new Set(podSelections.map(s => s.playerId));
  for (const [id, entry] of podSeatEls) {
    if (!seated.has(id)) removePodSeatEls(id, entry);
  }
  podSelections.forEach((slot, i) => {
    let entry = podSeatEls.get(slot.playerId);
    if (!entry) {
      const chair = buildPodChair(slot.playerId);
      const plate = buildPodPlate(slot.playerId);
      const entering = podSeatsEntering.has(slot.playerId) && !REDUCED_MOTION.matches;
      chair.style.setProperty("--pod-a", `${podAngle(i, n)}deg`);
      chair.style.setProperty("--pod-r", `${entering ? POD_SEAT_TUCKED : POD_SEAT_RADIUS}px`);
      // A pod restored (or refreshed) already revealed shouldn't replay the
      // flare; cleared in updatePodSeat once the seat leaves that state.
      if (!entering && podSeatState(slot) === "revealed") chair.classList.add("no-enter");
      // Insert in seat order so the nameplates' tab order matches the table.
      const next = podSelections.slice(i + 1).map(s => podSeatEls.get(s.playerId)).find(Boolean);
      podUi.chairs.insertBefore(chair, next ? next.chair : null);
      podUi.plates.insertBefore(plate, next ? next.plate : null);
      entry = { chair, plate };
      podSeatEls.set(slot.playerId, entry);
      if (entering) {
        chair.style.opacity = "0";
        plate.classList.add("entering");
        // Pulled out at a slight angle (alternating sides so neighbours
        // don't swing in lockstep), straightening as it reaches its seat.
        chair.style.setProperty("--pod-sw", `${chair.classList.contains("crest") ? -16 : 16}deg`);
        // Commit the tucked start before moving to the seat, so it slides.
        getComputedStyle(chair).getPropertyValue("--pod-r");
        chair.style.setProperty("--pod-r", `${POD_SEAT_RADIUS}px`);
        chair.style.setProperty("--pod-sw", "0deg");
        chair.style.opacity = "1";
        chair.classList.add("ignite");
        setTimeout(() => chair.classList.remove("ignite"), 700);
        setTimeout(() => plate.classList.remove("entering"), 260);
      }
    }
    updatePodSeat(entry, slot, i, n);
  });
  podSeatsEntering.clear();
  podUi.scene.classList.toggle("has-focus", editingSeatIndex !== null);
  trackPodPlates(900);
}

function removePodSeatEls(id, entry) {
  podSeatEls.delete(id);
  const { chair, plate } = entry;
  plate.classList.add("leaving");
  setTimeout(() => plate.remove(), 180);
  chair.classList.add("leaving");
  chair.style.setProperty("--pod-r", `${POD_SEAT_TUCKED}px`);
  chair.style.setProperty("--pod-sw", `${chair.classList.contains("crest") ? 10 : -10}deg`);
  chair.style.opacity = "0";
  let done = false;
  const finish = () => { if (!done) { done = true; chair.remove(); } };
  chair.addEventListener("transitionend", e => { if (e.target === chair && e.propertyName === "opacity") finish(); });
  // Safety net: transitionend never fires if the tab is hidden mid-exit.
  setTimeout(finish, 450);
}

// Pins each flat nameplate under its orb by reading where the orb's anchor
// actually lands on screen. Runs every frame only while something moves.
function positionPodPlates() {
  if (!podUi) return;
  const sr = podUi.scene.getBoundingClientRect();
  if (sr.width === 0) return; // pod tab hidden; fitPodScene re-runs this on show
  for (const { chair, plate } of podSeatEls.values()) {
    const a = chair.querySelector(".pod-plate-anchor").getBoundingClientRect();
    const x = a.left + a.width / 2 - sr.left;
    const y = a.top - sr.top + 2;
    plate.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translateX(-50%)`;
  }
}

let podPlatesTrackUntil = 0;
let podPlatesTracking = false;
function trackPodPlates(ms) {
  positionPodPlates();
  podPlatesTrackUntil = Math.max(podPlatesTrackUntil, performance.now() + ms);
  // rAF pauses in a background tab -- land the final spot by timer too.
  setTimeout(positionPodPlates, ms + 60);
  if (podPlatesTracking) return;
  podPlatesTracking = true;
  const tick = () => {
    positionPodPlates();
    if (performance.now() < podPlatesTrackUntil) requestAnimationFrame(tick);
    else podPlatesTracking = false;
  };
  requestAnimationFrame(tick);
}

function podSigilPoint(r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [50 - r * Math.sin(rad), 50 + r * Math.cos(rad)];
}

function renderPodSigil() {
  const n = podSelections.length;
  const cls = (slot, prefix) => {
    const state = podSeatState(slot);
    return state === "flagged" ? `${prefix}-bad` : state === "waiting" ? `${prefix}-part` : `${prefix}-on`;
  };
  let html = "";
  if (n === 0) {
    html += `<circle class="seg" cx="50" cy="50" r="${POD_GROOVE_R}" stroke-dasharray="1.5 3"/>`;
  } else if (n === 1) {
    html += `<circle class="seg ${cls(podSelections[0], "seg")}" cx="50" cy="50" r="${POD_GROOVE_R}"/>`;
  } else {
    const step = 360 / n;
    const gap = 8;
    podSelections.forEach((slot, i) => {
      const c = podAngle(i, n);
      const [x1, y1] = podSigilPoint(POD_GROOVE_R, c - step / 2 + gap / 2);
      const [x2, y2] = podSigilPoint(POD_GROOVE_R, c + step / 2 - gap / 2);
      html += `<path class="seg ${cls(slot, "seg")}" d="M${x1.toFixed(2)} ${y1.toFixed(2)} A${POD_GROOVE_R} ${POD_GROOVE_R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}"/>`;
    });
    // Join the seats: a line, a triangle, a square with its cross, then stars.
    const skips = n <= 3 ? [1] : n === 4 ? [1, 2] : n <= 6 ? [2] : [3];
    const drawn = new Set();
    for (const k of skips) {
      for (let i = 0; i < n; i++) {
        const j = (i + k) % n;
        const key = `${Math.min(i, j)}-${Math.max(i, j)}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const [x1, y1] = podSigilPoint(POD_NODE_R, podAngle(i, n));
        const [x2, y2] = podSigilPoint(POD_NODE_R, podAngle(j, n));
        html += `<line class="line" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
      }
    }
  }
  podSelections.forEach((slot, i) => {
    const [x, y] = podSigilPoint(POD_NODE_R, podAngle(i, n));
    html += `<circle class="node ${cls(slot, "node")}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.2"/>`;
  });
  podUi.sigil.innerHTML = html;

  const sealed = podSelections.filter(s => s.sealed && podSeatState(s) !== "flagged").length;
  podUi.table.classList.toggle("is-ready", podRevealed);
  podUi.count.textContent = n === 0 ? "0" : (podRevealed ? String(n) : `${sealed}/${n}`);
  podUi.word.textContent = n === 0 ? "Seats" : (podRevealed ? "Ready" : "Sealed");
}

function renderPodRoster() {
  const roster = podUi.roster;
  roster.innerHTML = "";
  const full = podSelections.length >= POD_MAX_SEATS;
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
    roster.appendChild(chip);
  }
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

function removePodSeat(playerId) {
  const slot = podSelections.find(s => s.playerId === playerId);
  if (!slot) return;
  const name = podNameOf(slot);
  if (podEditingPlayerId === playerId) podEditingPlayerId = null;
  const leaving = playerId === myPodPlayerId() ? "You left the table" : `${name} left the table`;
  tableOp({ op: "unseat", playerId: Number(playerId) }, leaving);
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
  await tableOp({ op: "check" });
  podPendingCheck = false;
  renderPodCta();
  renderPodStatus();
}

// Turns the table so seat i faces you, the short way round. Only this
// phone's view turns.
function turnPodTable(i) {
  if (!podUi) return;
  const target = -podAngle(i, podSelections.length);
  const delta = ((((target - podSpin) % 360) + 540) % 360) - 180;
  podSpin += delta;
  podUi.rig.style.setProperty("--pod-spin", `${podSpin}deg`);
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
  turnPodTable(i);
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
  podSeatEls.get(playerId)?.plate.focus({ preventScroll: true });
}

// Seals a deck on the shared table. Closes the panel straight away -- the
// pick lands on every phone within a poll -- and flares this seat's orb
// once the relay confirms it.
async function pickPodDeck(playerId, deckId) {
  const slot = podSelections.find(s => s.playerId === playerId);
  if (!slot) return;
  if (podEditingPlayerId === playerId) podEditingPlayerId = null;
  podPendingPicks.add(playerId);
  renderPodSlots();
  const view = await tableOp({ op: "pick", playerId: Number(playerId), deckId: Number(deckId) });
  podPendingPicks.delete(playerId);
  renderPodSlots();
  const orb = view ? podSeatEls.get(playerId)?.chair.querySelector(".pod-orb") : null;
  if (orb && !REDUCED_MOTION.matches) {
    orb.animate([{ transform: "scale(1)" }, { transform: "scale(1.16)" }, { transform: "scale(1)" }],
      { duration: 420, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }
}

function shakeFlaggedOrbs() {
  if (REDUCED_MOTION.matches) return;
  podSelections.forEach(slot => {
    if (podSeatState(slot) !== "flagged") return;
    podSeatEls.get(slot.playerId)?.chair.querySelector(".pod-orb")?.animate(
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

  renderPodChairs();
  renderPodSigil();
  renderPodRoster();
  renderPodStatus();
  renderPodPanel();
  renderPodCta();
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

// achievements: the same array loadAchievements() already rendered (see
// lastAchievementsData) -- no separate fetch. Skips any achievement with
// no winner: this is meant to feel like a celebration, not another list of
// "no data yet" cards.
function showClosingCeremonyModal(achievements, seasonLabel) {
  const modal = document.getElementById("ceremony-modal");
  if (!modal) return;
  ceremonySteps = achievements.filter(a => a.winner);
  ceremonyIndex = 0;
  const title = document.getElementById("ceremony-title");
  if (title) title.textContent = `${seasonLabel} Closing Ceremony`;
  renderCeremonyStep(0);
  modal.hidden = false;
}

function hideClosingCeremonyModal() {
  const modal = document.getElementById("ceremony-modal");
  if (modal) modal.hidden = true;
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

function advanceCeremony(delta) {
  renderCeremonyStep(ceremonyIndex + delta);
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
document.getElementById("ceremony-prev")?.addEventListener("click", () => advanceCeremony(-1));
document.getElementById("ceremony-next")?.addEventListener("click", () => advanceCeremony(1));
// Tap-to-advance anywhere on the step itself, not just the Next button --
// this is meant to be flicked through at a table, one thumb.
document.getElementById("ceremony-step")?.addEventListener("click", () => advanceCeremony(1));

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

function hideCloseSeasonModal() {
  const modal = document.getElementById("close-season-modal");
  if (modal) modal.hidden = true;
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

  modal.hidden = false;
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
  if (ceremonyModal && !ceremonyModal.hidden) {
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

// A pass on any phone plays the reveal on every phone: the table's flames
// flare first (90ms apart), then "To the Game!" opens over it. A timer, not
// an animation event, so it opens even if the animation is skipped; dropped
// if the pod changes before it fires.
function schedulePodReveal(checkId) {
  // Long enough for the flames to start flaring, not to finish: a longer
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
  document.querySelectorAll(".tab-btn, .bottom-tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(`[data-tab="${tabName}"]`).forEach(b => b.classList.add("active"));
  document.querySelectorAll(".tab-panel").forEach(p => { p.hidden = true; });
  panel.hidden = false;
  // Same id scheme as the tab panel (#bg-<tab> next to #tab-<tab>).
  const bgEl = document.getElementById(`bg-${tabName}`);
  crossfadeTabBackground(bgEl);
  window.scrollTo({ top: 0 });
  if (switching) playTabEnter(panel);
  // Nameplates are pinned by measuring the 3D scene, which measures as
  // nothing while its tab is hidden.
  if (tabName === "pod") {
    trackPodPlates(400);
    pollLiveTable(true);
  }
  if (tabName === "tonight") pollLiveTable(true);
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
function playTabEnter(panel) {
  if (REDUCED_MOTION.matches) return;
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
  areaEl.appendChild(box);
  // "start", not "nearest": the form opens below every pending game, and
  // on a phone "nearest" only nudged its top edge into view, leaving the
  // tap looking like it did nothing.
  box.scrollIntoView({ behavior: REDUCED_MOTION.matches ? "auto" : "smooth", block: "start" });
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
        submitBtn.textContent = "Submitted ✓";
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
    root.style.setProperty("--app-vh", `${readViewportHeight()}px`);
    return;
  }

  syncingViewportHeight = true;
  let finished = false;
  const finish = () => {
    if (finished) return; // the resize listener and the safety-net timeout below can both fire
    finished = true;
    root.style.setProperty("--app-vh", `${readViewportHeight()}px`);
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

function initViewportHeight() {
  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportHeight);
  }
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
    if (refreshing || !currentUser || (window.scrollY || document.documentElement.scrollTop) > 0 || touchBelongsToInnerScroll(e.target)) {
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
        // A pull used to clear the pod as well. Not any more: the table is
        // shared now, and one person's pull would empty it for everyone.
        // "Clear the table" (with Undo) is how a pod starts fresh.
        await Promise.all([refreshEverything(), pollLiveTable(true)]);
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
  await Promise.all([syncFromD1(), refreshPlaygroupGames(), loadRosterDiff(), refreshAchievementsView()]);
}

// Only fires on an actual open/return to the app, not a timer -- catches
// up the instant it's looked at again instead of leaving stale data on
// screen, without polling in the background the rest of the time.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshEverything();
});

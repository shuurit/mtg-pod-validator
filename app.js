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

// Shared tail of applying a freshly-built players array, regardless of
// where it came from (DEFAULT_ROSTER fallback, or a real D1 read).
function setPlayers(newPlayers) {
  players = newPlayers;
  podPlayers = players.filter(p => knownPlaygroupPlayers.has(p.name));
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
      fetch(PLAYERS_RELAY_URL, { cache: "no-store" }),
      fetch(GAMES_RELAY_URL, { cache: "no-store" }),
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

// ---------- shared table building ----------

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

// Illustrative-only thresholds (not a canonical scale defined anywhere else
// in this app) -- just enough to bucket a deck's power into a color so a
// player's whole pool reads visually at a glance instead of needing to
// parse a column of numbers. Reuses the existing good/warn/bad tokens
// already established for banners/result-rows elsewhere.
function powerTierClass(power) {
  if (power < 2.5) return "power-chip-low";
  if (power < 3.2) return "power-chip-mid";
  if (power < 3.7) return "power-chip-high";
  return "power-chip-max";
}

function buildPowerChip(power) {
  const chip = document.createElement("span");
  chip.className = `power-chip ${powerTierClass(power)}`;
  chip.textContent = formatPower(power);
  return chip;
}

// Power cell in its normal (non-editing) state: the chip, flagged with a
// dashed border + tooltip when it's a manual bracket declaration not yet
// backed by a logged game (see computePlayersData's bracketPending), plus
// a de-emphasized pencil button that switches this cell into
// buildBracketEditRow below. Playgroup Power stays its own table column
// (see PLAYER_DECK_COLUMNS), not folded in here.
function buildPowerCell(deck) {
  const cell = document.createElement("span");
  cell.className = "power-cell";
  const chip = buildPowerChip(deck.power);
  if (deck.bracketPending) {
    chip.classList.add("power-chip-pending");
    chip.title = `Manually set to Bracket ${deck.bracket} — not yet confirmed by a logged game.`;
  }
  cell.appendChild(chip);

  const editBtn = document.createElement("button");
  editBtn.className = "deck-edit-btn";
  editBtn.textContent = "✎";
  editBtn.setAttribute("aria-label", `Set ${deck.name}'s bracket`);
  editBtn.addEventListener("click", () => {
    bracketEditingDeckIds.add(deck.id);
    renderPlayersTable();
  });
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
        headers: { "Content-Type": "application/json" },
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

  for (const player of podPlayers) {
    const isExpanded = expandedPlayerId === player.id;
    // Archived on playgroup.gg means retired -- not shown here, and not
    // offered in Set Up Pod either (see renderPodSlots).
    const activeDecks = player.decks.filter(d => !d.archived);

    const block = document.createElement("div");
    block.className = "player-block";

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

    const table = document.createElement("table");
    table.className = "winrates-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of PLAYER_DECK_COLUMNS) {
      const th = document.createElement("th");
      th.className = col.numeric ? "sortable num" : "sortable";
      const isActive = sortState.column === col.key;
      th.textContent = col.label + (isActive ? (sortState.direction === "desc" ? " ▾" : " ▴") : "");
      if (isActive) th.classList.add("sorted");
      th.addEventListener("click", () => {
        if (sortState.column === col.key) {
          playerDeckSortState.set(player.id, { column: col.key, direction: sortState.direction === "desc" ? "asc" : "desc" });
        } else {
          playerDeckSortState.set(player.id, { column: col.key, direction: col.defaultDir });
        }
        renderPlayersTable();
      });
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const { deck, pgPower } of deckRows) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.textContent = deck.name;
      const powerTd = document.createElement("td");
      powerTd.className = "num";
      powerTd.appendChild(bracketEditingDeckIds.has(deck.id) ? buildBracketEditRow(deck) : buildPowerCell(deck));
      const pgTd = document.createElement("td");
      pgTd.className = "num";
      pgTd.textContent = pgPower === null ? "—" : formatPower(pgPower);
      tr.append(nameTd, powerTd, pgTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    block.appendChild(table);
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

function renderPodSlots() {
  const container = document.getElementById("pod-slots");
  container.innerHTML = "";

  const prevSelections = podSelections;
  podSelections = [];

  for (let i = 0; i < podCount; i++) {
    const prev = prevSelections[i] || {};
    const slot = { playerId: prev.playerId || "", deckId: prev.deckId || "", outOfRange: !!prev.outOfRange };
    podSelections.push(slot);

    const row = document.createElement("div");
    row.className = "slot";

    const label = document.createElement("div");
    label.className = "slot-label";
    label.textContent = `Player ${i + 1}`;

    const playerSelect = document.createElement("select");
    const blankPlayerOpt = document.createElement("option");
    blankPlayerOpt.value = "";
    blankPlayerOpt.textContent = "Select player…";
    playerSelect.appendChild(blankPlayerOpt);
    for (const p of podPlayers) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      // A <select>'s .value (and so slot.playerId, read from it) is always
      // a string, but real D1 player ids are integers -- String() on both
      // sides here (and at every other p.id/d.id comparison against a
      // slot value below) so this works whether ids are D1 integers or
      // the fallback roster's string slugs, without assuming either.
      if (String(p.id) === slot.playerId) opt.selected = true;
      playerSelect.appendChild(opt);
    }

    const deckSelect = document.createElement("select");

    // Once a deck is picked, the select is swapped out for this masked
    // stand-in so nobody reading the screen over a player's shoulder can
    // see the deck's name or power -- not even the player, once they've
    // moved on. Tapping it re-reveals the select to change the pick.
    const maskedBtn = document.createElement("button");
    maskedBtn.type = "button";
    maskedBtn.className = "slot-deck-masked";
    maskedBtn.textContent = "🔒 Deck selected — tap to change";

    function syncDeckVisibility() {
      const masked = !!slot.deckId;
      deckSelect.hidden = masked;
      maskedBtn.hidden = !masked;
    }

    function refreshDeckOptions() {
      deckSelect.innerHTML = "";
      const player = podPlayers.find(p => String(p.id) === slot.playerId);
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = player ? "Select deck…" : "—";
      deckSelect.appendChild(blank);
      deckSelect.disabled = !player;
      if (player) {
        // Archived on playgroup.gg means retired -- not offered here at all,
        // same reasoning as Players & Decks below.
        const activeDecks = player.decks.filter(d => !d.archived);
        // A slot the last check flagged as over the pod's range only offers
        // decks that would actually bring it back in range, so re-picking
        // can't just land on another incompatible deck. Falls back to the
        // full list if nothing qualifies (e.g. this player has no deck that
        // low) rather than leaving the select with nothing pickable at all.
        const restricted = slot.outOfRange && lastCeiling !== null
          ? activeDecks.filter(d => d.power <= lastCeiling)
          : null;
        const decks = restricted && restricted.length > 0 ? restricted : activeDecks;
        for (const d of decks) {
          const opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = d.name;
          if (String(d.id) === slot.deckId) opt.selected = true;
          deckSelect.appendChild(opt);
        }
      }
      syncDeckVisibility();
    }

    function markStaleIfChecked() {
      const resultsSection = document.getElementById("results-section");
      if (!resultsSection || resultsSection.hidden) return;
      document.getElementById("validate-btn").classList.add("glow");
      const staleRow = document.querySelector(`.result-row[data-player-id="${slot.playerId}"]`);
      if (staleRow) staleRow.classList.add("pending-recheck");
    }

    playerSelect.addEventListener("change", () => {
      slot.playerId = playerSelect.value;
      slot.deckId = "";
      refreshDeckOptions();
    });

    deckSelect.addEventListener("change", () => {
      slot.deckId = deckSelect.value;
      syncDeckVisibility();
      markStaleIfChecked();
    });

    maskedBtn.addEventListener("click", () => {
      // Rebuilt fresh (not just unhidden) so a slot flagged out-of-range by
      // the last check shows its filtered, range-restricted options rather
      // than whatever was already rendered before that check ran.
      refreshDeckOptions();
      deckSelect.hidden = false;
      maskedBtn.hidden = true;
      deckSelect.focus();
    });

    refreshDeckOptions();

    row.appendChild(label);
    row.appendChild(playerSelect);
    row.appendChild(deckSelect);
    row.appendChild(maskedBtn);
    container.appendChild(row);
  }
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
  if (!modal || !grid || !goBtn) return;

  goBtn.href = PLAYGROUP_URL;
  grid.innerHTML = "";

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
    artSlot.textContent = "Loading art…";
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
document.addEventListener("keydown", e => {
  if (e.key === "Escape") hideRevealModal();
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

function runValidation() {
  const resultsSection = document.getElementById("results-section");
  const resultsDiv = document.getElementById("results");
  document.getElementById("validate-btn").classList.remove("glow");
  resultsDiv.innerHTML = "";
  resultsSection.hidden = false;

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
  }

  const evaluated = evaluatePod(entries);
  evaluated.forEach((entry, i) => { podSelections[i].outOfRange = !entry.compatible; });

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

function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach(p => { p.hidden = true; });
      document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
      // Same id scheme as the tab panel (#bg-<tab> next to #tab-<tab>) --
      // opacity-transitions to the new one via the .active class, see the
      // .tab-bg rules in style.css for the actual crossfade.
      document.querySelectorAll(".tab-bg").forEach(bg => { bg.classList.remove("active"); });
      const bgEl = document.getElementById(`bg-${btn.dataset.tab}`);
      if (bgEl) bgEl.classList.add("active");
    });
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

  const table = document.createElement("table");
  table.className = "winrates-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  const nameTh = document.createElement("th");
  nameTh.textContent = "Player";
  headRow.appendChild(nameTh);

  for (const col of WINRATES_COLUMNS) {
    const th = document.createElement("th");
    th.className = "sortable num"; // both columns here are numeric/right-aligned
    const isActive = winRatesSortColumn === col.key;
    th.textContent = col.label + (isActive ? (winRatesSortDirection === "desc" ? " ▾" : " ▴") : "");
    if (isActive) th.classList.add("sorted");
    th.addEventListener("click", () => {
      if (winRatesSortColumn === col.key) {
        winRatesSortDirection = winRatesSortDirection === "desc" ? "asc" : "desc";
      } else {
        winRatesSortColumn = col.key;
        winRatesSortDirection = "desc";
      }
      renderWinRatesTable(playgroupGamesData);
    });
    headRow.appendChild(th);
    // Trend rides right alongside the Adjusted Win Rate column it's
    // derived from -- not sortable itself (it's a change, not a value).
    if (col.key === "adjusted") {
      const trendTh = document.createElement("th");
      trendTh.className = "trend";
      trendTh.textContent = "Trend";
      trendTh.title = "Whether this player's rank in the Player Adjusted Win Rate standings moved compared to before their most recent logged game";
      headRow.appendChild(trendTh);
    }
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const row of rowData) {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = row.name;
    tr.appendChild(nameTd);

    const adjTd = document.createElement("td");
    adjTd.className = "num";
    if (row.adjPct !== null) {
      adjTd.textContent = `${row.adjPct.toFixed(3)}% (${row.adjWins}-${row.adjLosses})`;
    } else {
      adjTd.className += " muted";
      adjTd.innerHTML = `<span class="na">No games logged this season</span>`;
    }
    tr.appendChild(adjTd);

    const trendTd = document.createElement("td");
    trendTd.className = "trend";
    const direction = trendByPlayer[row.name];
    if (row.adjPct !== null && direction) {
      trendTd.innerHTML = `<span class="${TREND_CLASS[direction]}">${TREND_SYMBOL[direction]}</span>`;
    } else {
      trendTd.className += " muted";
      trendTd.textContent = "—";
    }
    tr.appendChild(trendTd);

    const pgTd = document.createElement("td");
    pgTd.className = "num";
    if (row.pgPct !== null) {
      pgTd.textContent = `${row.pgPct.toFixed(3)}% (${row.pgWins}-${row.pgLosses})`;
    } else {
      pgTd.className += " muted";
      pgTd.innerHTML = `<span class="na">No games in the active league yet</span>`;
    }
    tr.appendChild(pgTd);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  tableEl.innerHTML = "";
  tableEl.appendChild(table);

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
  if (!PLAYGROUP_GAMES_RELAY_URL) {
    if (gtuStatusEl) gtuStatusEl.textContent = "Live playgroup.gg data not configured.";
    if (wrStatusEl) wrStatusEl.textContent = "Live playgroup.gg data not configured.";
    return;
  }
  try {
    const res = await fetch(PLAYGROUP_GAMES_RELAY_URL, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    }
    playgroupGamesData = await res.json();
    applyKnownPlayers(playgroupGamesData);
    renderGamesToUpdate();
    renderWinRatesTable(playgroupGamesData);
  } catch (err) {
    if (gtuStatusEl) gtuStatusEl.textContent = `Couldn't load live playgroup.gg data (${err.message}).`;
    if (wrStatusEl) wrStatusEl.textContent = `Couldn't load live win rates (${err.message}).`;
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

// Mirrors updateRosterUpdateTabBadge's "Update the App" badge -- a count of
// games missing from the Game Log on the "Games to Update" tab button
// itself, hidden entirely at 0 so absence means "nothing to log," not "not
// loaded yet."
function updateGamesToUpdateTabBadge(count) {
  const badge = document.getElementById("gtu-tab-badge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = String(count);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderGamesToUpdate() {
  const statusEl = document.getElementById("gtu-status");
  const listEl = document.getElementById("gtu-game-list");
  if (!playgroupGamesData || !statusEl || !listEl) return;
  if (gameLogSeason3Rows.length === 0) {
    statusEl.textContent = "Waiting on deck-strength.xlsx to load...";
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
    p.textContent = "Nothing missing — every tracked game is already logged.";
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

  const rows = pgGame.participants.map((p, i) => {
    const defaultStrength = findDefaultStrength(p.player, p.commander);
    const defaultPlace = p.result === "win" ? 1 : "";
    const defaultBracket = findDefaultBracket(p.player, p.commander);
    return [
      p.player,
      p.commander,
      p.result === "win" ? "Win ✓" : "Loss",
      { node: makeGtuInput("number", "gtu-strength", i, { step: "0.1", min: "0", max: "5", value: defaultStrength ?? "" }) },
      { node: makeGtuInput("number", "gtu-place", i, { min: "1", max: pgGame.pod_size, value: defaultPlace }) },
      { node: makeGtuInput("number", "gtu-knockouts", i, { min: "0", value: 0 }) },
      { node: makeGtuInput("number", "gtu-tov", i, { min: "1", value: "" }) },
      { node: makeGtuInput("checkbox", "gtu-popoff", i) },
      { node: makeGtuInput("number", "gtu-disruptions", i, { min: "0", value: 0 }) },
      { node: makeGtuInput("number", "gtu-recoveries", i, { min: "0", value: 0 }) },
      { node: makeGtuInput("checkbox", "gtu-behind", i) },
      { node: makeGtuInput("number", "gtu-bracket", i, { min: "1", max: "5", value: defaultBracket }) },
    ];
  });
  const { table } = buildTable(
    "gtu-input-table",
    ["Player", "Commander", "Result", "Cmdr Strength", "Place", "KOs", "TOV", "Pop-Off", "Disruptions", "Recoveries", "Behind", "Bracket"],
    rows
  );
  // 12 columns of real content don't fit a phone (or even a narrower
  // desktop card) at once -- confirmed the hard way, the table was
  // overflowing its own wrapper with no way to reach the clipped columns.
  // Scrolls inside its own box instead of breaking out of it.
  const tableScroll = document.createElement("div");
  tableScroll.className = "gtu-table-scroll";
  tableScroll.appendChild(table);
  box.appendChild(tableScroll);

  // Fills in Place/KOs/TOV from playgroup.gg's raw per-game event log --
  // still fully editable, same as the Cmdr Strength/Bracket prefills
  // above. Fetched separately (not part of the regular /playgroup-games
  // response) since it needs the full event history for just this one
  // game, which is too expensive to pull for every pending game up front.
  if (pgGame.playgroup_game_id && RELAY_BASE_URL) {
    fetch(`${RELAY_BASE_URL}/debug/game?id=${pgGame.playgroup_game_id}&events=true`, { cache: "no-store" })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(rawGame => {
        const derived = deriveGameFieldsFromRawGame(rawGame);
        pgGame.participants.forEach((p, i) => {
          const fields = derived[p.deck_name];
          if (!fields) return;
          const placeInput = table.querySelector(`.gtu-place[data-i="${i}"]`);
          const kosInput = table.querySelector(`.gtu-knockouts[data-i="${i}"]`);
          const tovInput = table.querySelector(`.gtu-tov[data-i="${i}"]`);
          if (placeInput) placeInput.value = fields.place;
          if (kosInput) kosInput.value = fields.kos;
          if (tovInput && fields.tov != null) tovInput.value = fields.tov;
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
        })),
      };
      try {
        const res = await fetch(GAME_SUBMIT_RELAY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
const rosterUpdateDeckState = new Map(); // deckId (string) -> { checked, power }
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
    rosterUpdateDeckState.set(key, {
      checked: false,
      power: typeof deck.power_level === "number" ? deck.power_level.toFixed(1) : "",
    });
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
    return;
  }
  try {
    const res = await fetch(ROSTER_DIFF_RELAY_URL, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    }
    rosterDiffData = await res.json();
    renderPlayersTable();
    if (!isEditingRosterUpdateForm()) renderUpdateAppTab();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Couldn't load live playgroup.gg data (${err.message}).`;
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
    const existingIds = new Set(existingDecks.map(d => d.playgroupId).filter(Boolean));
    const existingNames = new Set(existingDecks.map(d => normalizeCommanderName(d.name)));

    const newDecks = allDecks.filter(deck =>
      !existingIds.has(String(deck.id)) && !existingNames.has(normalizeCommanderName(deck.commander_name))
    );
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
function deckTableRow(deck) {
  const state = rosterUpdateDeckState.get(String(deck.id));

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "uta-deck-check";
  checkbox.dataset.deckId = deck.id;
  checkbox.checked = !!state.checked;

  const nameCell = document.createDocumentFragment();
  nameCell.appendChild(document.createTextNode(deck.commander_name));
  if (deck.name !== deck.commander_name) {
    nameCell.appendChild(document.createTextNode(" "));
    const aside = document.createElement("span");
    aside.className = "hint";
    aside.textContent = `(${deck.name})`;
    nameCell.appendChild(aside);
  }

  const powerInput = document.createElement("input");
  powerInput.type = "number";
  powerInput.className = "uta-deck-power";
  powerInput.dataset.deckId = deck.id;
  powerInput.step = "0.1";
  powerInput.min = "0";
  powerInput.max = "5";
  powerInput.value = state.power;
  powerInput.placeholder = "power";

  return [{ node: checkbox }, { node: nameCell }, { node: powerInput }];
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
  container.querySelectorAll(".uta-deck-power").forEach(el => {
    el.addEventListener("input", () => {
      rosterUpdateDeckState.set(el.dataset.deckId, { ...rosterUpdateDeckState.get(el.dataset.deckId), power: el.value });
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
    const label = document.createElement("label");
    label.appendChild(document.createTextNode("New player (playgroup.gg: "));
    const code = document.createElement("code");
    code.textContent = p.username;
    label.appendChild(code);
    label.appendChild(document.createTextNode(") — display name: "));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "uta-display-name";
    nameInput.dataset.username = p.username;
    nameInput.value = rosterUpdateNameState.get(p.username);
    label.appendChild(nameInput);
    header.appendChild(label);
    box.appendChild(header);

    const { table } = buildTable("uta-deck-table", ["", "Deck", "Starting power"], p.decks.map(deckTableRow));
    box.appendChild(table);
  } else {
    const g = group.data;
    const strong = document.createElement("strong");
    strong.textContent = g.player;
    header.appendChild(strong);
    header.appendChild(document.createTextNode(` — ${g.decks.length} new deck(s)`));
    box.appendChild(header);

    const { table } = buildTable("uta-deck-table", ["", "Deck", "Starting power"], g.decks.map(deckTableRow));
    box.appendChild(table);
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
  const badge = document.getElementById("uta-tab-badge");
  if (!badge) return;
  const count = newPlayers.reduce((n, p) => n + p.decks.length, 0) +
    newDecksForExisting.reduce((n, g) => n + g.decks.length, 0);
  if (count > 0) {
    badge.textContent = String(count);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
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
    nothingNewEl.textContent = "Nothing new — everyone and everything tracked here matches playgroup.gg.";
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
          const power = parseFloat(state.power);
          if (!Number.isFinite(power)) return;
          decks.push({ name: d.commander_name, power, playgroupDeckId: d.id, playgroupDeckName: d.name });
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
          const power = parseFloat(state.power);
          if (!Number.isFinite(power)) return;
          payload.newDecksForExisting.push({ player: g.player, name: d.commander_name, power, playgroupDeckId: d.id, playgroupDeckName: d.name });
          submittedDeckIds.push(String(d.id));
        });
      });

      if (payload.newPlayers.length === 0 && payload.newDecksForExisting.length === 0) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Add Player/Decks";
        statusEl.textContent = "Nothing selected (or missing a starting power) — check the boxes and power fields above.";
        return;
      }

      try {
        const res = await fetch(ROSTER_UPDATE_RELAY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

// ---------- init ----------

const gtuIntroEl = document.getElementById("gtu-intro");
if (gtuIntroEl) {
  gtuIntroEl.textContent = "Games from playgroup.gg that aren't logged yet. Fill in what playgroup.gg can't supply, then submit.";
}

initPlayerCountSelect();
syncFromD1();
initTabs();
refreshPlaygroupGames();
loadRosterDiff();

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
// renderRosterUpdateSubmit). Triggered by: the manual refresh button, the
// visibility-change listener right below (so opening/returning to the app
// never shows stale data), once on initial page load, and once right
// after a game or roster submission.
async function refreshEverything() {
  const btn = document.getElementById("global-refresh-btn");
  if (btn) btn.classList.add("spinning");
  try {
    await Promise.all([syncFromD1(), refreshPlaygroupGames(), loadRosterDiff()]);
  } finally {
    if (btn) btn.classList.remove("spinning");
  }
}

const globalRefreshBtn = document.getElementById("global-refresh-btn");
if (globalRefreshBtn) {
  globalRefreshBtn.addEventListener("click", refreshEverything);
}

// Only fires on an actual open/return to the app, not a timer -- catches
// up the instant it's looked at again instead of leaving stale data on
// screen, without polling in the background the rest of the time.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshEverything();
});

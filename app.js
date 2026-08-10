const RANGE_TOLERANCE = 1; // max power spread allowed within a pod
const PLAYGROUP_URL = "https://playgroup.gg/tracker";

// Cloudflare Worker relay. Set once the Worker is deployed (see
// cloudflare-worker/README.md). GAME_SUBMIT_RELAY_URL empty disables
// submission (Copy row still works); PLAYGROUP_GAMES_RELAY_URL empty
// disables live playgroup.gg data (Games to Update and Player Win Rates
// show a "not configured" message instead).
const RELAY_BASE_URL = "https://mtg-pod-validator-relay.mattdomi18.workers.dev";
const GAME_SUBMIT_RELAY_URL = RELAY_BASE_URL + "/";
const PLAYGROUP_GAMES_RELAY_URL = RELAY_BASE_URL + "/playgroup-games";
const ROSTER_DIFF_RELAY_URL = RELAY_BASE_URL + "/roster-diff";
const ROSTER_UPDATE_RELAY_URL = RELAY_BASE_URL + "/apply-roster-update";

// Fallback for knownPlaygroupPlayers below, used only until the Worker's
// first response arrives. relay.js's USERNAME_TO_PLAYER is the real source
// of truth -- keep this roughly in sync, but a brand-new player will still
// show up correctly once the live known_players field loads even if this
// list is stale.
const PLAYERS_WITH_PLAYGROUP_ACCOUNT = ["Becca", "Manny", "Mateo", "Ryan", "Michelle", "Red"];

// Fallback roster shown only if deck-strength.xlsx fails to load at all
// (e.g. offline). Real data always comes from Current Deck Strength.
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
let expandedPlayerIds = new Set(); // player blocks currently showing their deck table
let rosterDiffData = null; // raw playgroup.gg roster/decks from loadRosterDiff, used for the Playgroup Power comparison column too

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

// Called once with the DEFAULT_ROSTER fallback (so the UI isn't empty
// before the first fetch resolves), then again with real rows every time
// deck-strength.xlsx syncs successfully.
function applyDeckStrengthRows(rows) {
  players = rowsToPlayers(rows);
  podPlayers = players.filter(p => knownPlaygroupPlayers.has(p.name));
  renderPlayersTable();
  renderPodSlots();
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

// ---------- XLSX import ----------

// Reads the "Current Deck Strength" tab. Its layout is: a bold player-name
// row whose Power cell holds an =AVERAGE(...) formula over the deck rows
// beneath it, followed by deck rows whose Power cell is itself a formula
// (=IFERROR(LOOKUP(...), baseline) pulling the latest logged game's Game
// Calculated Deck Strength, falling back to a manual baseline). We tell the
// two apart by the formula itself, not just whether one exists.
function extractRowsFromWorkbook(workbook) {
  const sheetName =
    workbook.SheetNames.find(n => n.trim().toLowerCase() === "current deck strength") ||
    workbook.SheetNames.find(n => n.toLowerCase().includes("deck strength"));
  if (!sheetName) {
    throw new Error('No "Current Deck Strength" sheet found in this workbook.');
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet["!ref"]) return [];
  const range = XLSX.utils.decode_range(sheet["!ref"]);

  const rows = [];
  let currentPlayer = null;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const nameCell = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
    const powerCell = sheet[XLSX.utils.encode_cell({ r, c: 1 })];
    const idCell = sheet[XLSX.utils.encode_cell({ r, c: 4 })]; // column E: Playgroup Deck ID
    const name = nameCell && typeof nameCell.v === "string" ? nameCell.v.trim() : null;
    if (!name || name.toLowerCase() === "decks") continue;

    const isPlayerHeader = !!(powerCell && typeof powerCell.f === "string" && powerCell.f.trim().startsWith("AVERAGE"));
    if (isPlayerHeader) {
      currentPlayer = name;
      continue;
    }

    const power = powerCell && typeof powerCell.v === "number" ? powerCell.v : NaN;
    if (currentPlayer && Number.isFinite(power)) {
      const playgroupId = idCell && idCell.v != null && idCell.v !== "" ? String(idCell.v).trim() : null;
      rows.push({ name: currentPlayer, deck: name, power, playgroupId });
    }
  }
  return rows;
}

// Name of the workbook this app auto-syncs from on every load, expected to
// sit alongside index.html. Swap in each quarter's updated export under
// this same filename — the app doesn't need to know the dated original name.
const REPO_WORKBOOK_FILE = "deck-strength.xlsx";

// The one place this app needs to know which season is current. Update this
// (and nothing else in this file) when deck-strength.xlsx rolls to a new
// Game Log tab -- see scripts/season_rollover.py.
const CURRENT_SEASON_SHEET = "Game Log Season 3";

// Rows already logged in the current season's Game Log tab, read fresh from
// the workbook on every sync. Populated by syncFromRepoWorkbook; used by the
// Games to Update tab to figure out which playgroup.gg games are missing,
// and to recompute a player's full Player Adjusted Win Rate with a new game
// added.
let gameLogSeason3Rows = [];

function extractGameLogFromWorkbook(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet["!ref"]) return [];
  const range = XLSX.utils.decode_range(sheet["!ref"]);

  const headerRowIndex = 1; // row 2 in Excel (row 1 is merged category labels)
  const headerCols = {};
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: headerRowIndex, c })];
    if (cell && typeof cell.v === "string") headerCols[cell.v.trim()] = c;
  }

  const get = (r, name) => {
    const c = headerCols[name];
    if (c === undefined) return undefined;
    const cell = sheet[XLSX.utils.encode_cell({ r, c })];
    return cell ? cell.v : undefined;
  };

  const rows = [];
  for (let r = headerRowIndex + 1; r <= range.e.r; r++) {
    const player = get(r, "Player Name");
    if (!player) continue;
    rows.push({
      gameNum: get(r, "Game #"),
      date: get(r, "Game Date"),
      player,
      commander: get(r, "Commander"),
      playgroupGameId: get(r, "Playgroup Game ID"),
      commanderStrength: get(r, "Commander Strength"),
      result: get(r, "Game Result"),
      podSize: get(r, "Pod Size"),
      bracket: get(r, "Current Deck Bracket"),
      J: get(r, "Adjusted Pod Size Win/Loss Score"),
      K: get(r, "Knockout Score"),
      M: get(r, "Win Probability based on Deck Strength"),
    });
  }
  return rows;
}

async function syncFromRepoWorkbook() {
  const statusEl = document.getElementById("sync-status");
  try {
    const res = await fetch(REPO_WORKBOOK_FILE, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const rows = extractRowsFromWorkbook(workbook);
    if (rows.length === 0) throw new Error("no decks found in the sheet");

    applyDeckStrengthRows(rows);
    if (statusEl) {
      const deckCount = players.reduce((n, p) => n + p.decks.length, 0);
      statusEl.textContent = `Synced from ${REPO_WORKBOOK_FILE} (${players.length} players, ${deckCount} decks; ${podPlayers.length} shown in Deck Strength Validator).`;
    }

    gameLogSeason3Rows = extractGameLogFromWorkbook(workbook, CURRENT_SEASON_SHEET);
    renderGamesToUpdate();
    renderWinRatesTable(playgroupGamesData);
    // computeRosterDiff (inside renderUpdateAppTab) reads the `players`
    // array just rebuilt above by applyDeckStrengthRows. refreshEverything()
    // runs this and loadRosterDiff() in parallel, and XLSX parsing is
    // slower than the /roster-diff JSON fetch, so loadRosterDiff() often
    // resolves first and renders Update the App against the *previous*
    // players array -- e.g. a just-submitted new player not showing up in
    // `players` yet, so they still look untracked and their decks still
    // look pending even though the submission fully landed. Nothing else
    // re-renders that tab once `players` catches up, so it has to happen
    // here too, not just in loadRosterDiff().
    if (!isEditingRosterUpdateForm()) renderUpdateAppTab();
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Using locally saved data — couldn't load ${REPO_WORKBOOK_FILE} (${err.message}).`;
    }
    const gtuStatus = document.getElementById("gtu-status");
    if (gtuStatus) gtuStatus.textContent = `Couldn't load ${REPO_WORKBOOK_FILE} — Games to Update needs it to know what's already logged.`;
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
    const isExpanded = expandedPlayerIds.has(player.id);

    const block = document.createElement("div");
    block.className = "player-block";

    const header = document.createElement("div");
    header.className = "player-block-header";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "icon-btn toggle-btn";
    toggleBtn.textContent = isExpanded ? "▾" : "▸";
    toggleBtn.setAttribute("aria-label", isExpanded ? "Collapse" : "Expand");
    toggleBtn.addEventListener("click", () => {
      if (isExpanded) expandedPlayerIds.delete(player.id);
      else expandedPlayerIds.add(player.id);
      renderPlayersTable();
    });

    const nameSpan = document.createElement("span");
    nameSpan.className = "player-name-display";
    nameSpan.textContent = player.name;

    const deckCount = document.createElement("span");
    deckCount.className = "deck-count";
    deckCount.textContent = `${player.decks.length} deck${player.decks.length === 1 ? "" : "s"}`;
    deckCount.addEventListener("click", () => {
      if (isExpanded) expandedPlayerIds.delete(player.id);
      else expandedPlayerIds.add(player.id);
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
    const deckRows = player.decks.map(deck => ({ deck, pgPower: findPlaygroupPowerLevel(player.name, deck) }));

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
      powerTd.appendChild(buildPowerChip(deck.power));
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
      if (p.id === slot.playerId) opt.selected = true;
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
      const player = podPlayers.find(p => p.id === slot.playerId);
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = player ? "Select deck…" : "—";
      deckSelect.appendChild(blank);
      deckSelect.disabled = !player;
      if (player) {
        // A slot the last check flagged as over the pod's range only offers
        // decks that would actually bring it back in range, so re-picking
        // can't just land on another incompatible deck. Falls back to the
        // full list if nothing qualifies (e.g. this player has no deck that
        // low) rather than leaving the select with nothing pickable at all.
        const restricted = slot.outOfRange && lastCeiling !== null
          ? player.decks.filter(d => d.power <= lastCeiling)
          : null;
        const decks = restricted && restricted.length > 0 ? restricted : player.decks;
        for (const d of decks) {
          const opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = d.name;
          if (d.id === slot.deckId) opt.selected = true;
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

// ---------- validation ----------

function evaluatePod(entries) {
  // entries: [{ playerId, playerName, deckId, power }]
  // The weakest deck in the pod sets the floor; anything more than
  // RANGE_TOLERANCE above it needs to come down. The weakest deck itself
  // is always compatible — it's never asked to get even weaker.
  const powers = entries.map(e => e.power);
  const floor = Math.min(...powers);
  const ceiling = floor + RANGE_TOLERANCE;
  return entries.map(entry => ({
    ...entry,
    compatible: entry.power <= ceiling,
    overBy: +Math.max(0, entry.power - ceiling).toFixed(2),
  }));
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
    const player = podPlayers.find(p => p.id === s.playerId);
    const deck = player.decks.find(d => d.id === s.deckId);
    return {
      playerId: player.id,
      playerName: player.name,
      deckId: deck.id,
      power: deck.power,
    };
  });

  const powers = entries.map(e => e.power);
  const max = Math.max(...powers);
  const min = Math.min(...powers);
  const spread = +(max - min).toFixed(2);
  const allInRange = spread <= RANGE_TOLERANCE;

  const banner = document.createElement("div");
  banner.className = "banner " + (allInRange ? "good" : "bad");
  banner.textContent = allInRange
    ? `All decks are within range (spread: ${formatPower(spread)}).`
    : `Spread is ${formatPower(spread)} — outside the ±${RANGE_TOLERANCE} target. Some decks need to change.`;
  resultsDiv.appendChild(banner);

  const evaluated = evaluatePod(entries);

  // Feeds refreshDeckOptions in renderPodSlots: a slot flagged here only
  // offers decks at or under this ceiling the next time its picker reopens.
  lastCeiling = min + RANGE_TOLERANCE;
  evaluated.forEach((entry, i) => { podSelections[i].outOfRange = !entry.compatible; });

  for (const entry of evaluated) {
    const row = document.createElement("div");
    row.className = "result-row " + (entry.compatible ? "ok" : "out");
    row.dataset.playerId = entry.playerId;

    // Deck identity is never shown here either -- only who it belongs to
    // and whether their (unnamed) pick is in range.
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.playerName;

    // Power itself stays masked here too -- only the amount a deck is
    // over the pod's range is ever shown, never the raw power value.
    const power = document.createElement("span");
    power.className = "power";
    power.textContent = entry.compatible ? "✓ In range" : `⚠ Over by ${formatPower(entry.overBy)}`;

    row.appendChild(name);
    row.appendChild(power);
    resultsDiv.appendChild(row);

    if (!entry.compatible) {
      const box = document.createElement("div");
      box.className = "suggestions";
      box.textContent = `Select a new deck for ${entry.playerName} above, then check the spread again.`;
      resultsDiv.appendChild(box);
    }
  }

  if (allInRange) {
    const goBtn = document.createElement("a");
    goBtn.className = "primary to-game-btn";
    goBtn.textContent = "To the Game!";
    goBtn.href = PLAYGROUP_URL;
    goBtn.target = "_blank";
    goBtn.rel = "noopener";
    resultsDiv.appendChild(goBtn);
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
// syncFromRepoWorkbook (a fresh gameLogSeason3Rows changes the Adjusted
// Win Rate column even when the playgroup.gg data itself hasn't changed),
// and from applyOptimisticGameSubmit for an instant, zero-network re-render
// right after a game is submitted. Safe to call with data === null (e.g.
// before the first fetch resolves) -- just leaves the status text as-is.
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
      adjTd.innerHTML = `<span class="na">No games logged in ${CURRENT_SEASON_SHEET}</span>`;
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
  note.textContent = `Scoped to the active league (${data.league || "unknown"}). Player Adjusted Win Rate is computed live from the spreadsheet's ${CURRENT_SEASON_SHEET}.`;
  noteEl.appendChild(note);
}

// ---------- games to update ----------

let playgroupGamesData = null;

// The one place /playgroup-games actually gets fetched. Games to Update and
// Player Win Rates used to each fetch it independently -- up to 3 calls to
// the same endpoint on a single page load (direct loadWinRates() call,
// loadWinRates() again via syncFromRepoWorkbook, and loadPlaygroupGames())
// for data that's identical every time. Both now render from this single
// fetch instead.
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
// (column Y -- written automatically by add_game.py, or backfilled onto
// older rows by backfill_game_ids.py) matches by exact ID, no inference
// needed. For everything else, a logged game and a playgroup.gg game are
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

  // A row backfill_game_ids.py or add_game.py already stamped with the real
  // playgroup.gg game ID needs no inference at all -- exact id equality,
  // no heuristics, no ambiguity. Handled first and removed from the pool so
  // the heuristic loop below only ever sees games that still need it (a
  // manually-entered game, or one predating the ID column).
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
// Éowyn, Kennerud -> Kennerüd) that this spreadsheet's own plain-ASCII
// deck names never have -- confirmed the hard way when Ryan's "Arna
// Kennerüd, Skycaptain" from a live game submission didn't exactly match
// Current Deck Strength's "Arna Kennerud, Skycaptain", so the LOOKUP
// formula there silently kept using an older game's result instead.
// Mirrors strip_accents in scripts/backfill_playgroup_ids.py.
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

// Same reasoning as applyOptimisticRosterUpdate: the real round trip
// (GitHub Action recalculating deck-strength.xlsx, the Pages rebuild, then
// this page's next 60s poll) takes 1-3 minutes. This merges the
// just-submitted game into gameLogSeason3Rows -- so Games to Update drops
// it from the missing list and Player Win Rates' Adjusted Win Rate column
// picks it up immediately, both computed client-side from this same array
// already -- and updates each played deck's power in players/podPlayers to
// its freshly computed Game Calculated Deck Strength (row.X), mirroring
// what Current Deck Strength's own LOOKUP formula will settle on once it
// recalcs (it always resolves to the newest logged game for that
// player+commander, which this always is). Safe to be optimistic: the next
// real syncFromRepoWorkbook() rebuilds both arrays from scratch, so nothing
// here lingers or conflicts with the authoritative data.
function applyOptimisticGameSubmit(pgGame, podSize, rows, gameNum) {
  const gameDate = new Date(pgGame.date);

  for (const row of rows) {
    gameLogSeason3Rows.push({
      gameNum,
      date: gameDate,
      player: row.player,
      commander: row.commander,
      commanderStrength: row.strength,
      result: row.result === "win" ? 1 : 0,
      podSize,
      bracket: row.bracket,
      J: row.J,
      K: row.K,
      M: row.M,
    });

    const player = players.find(p => p.name === row.player);
    if (!player) continue;
    const target = normalizeCommanderName(row.commander);
    const deck = player.decks.find(d => normalizeCommanderName(d.name) === target) ||
      player.decks.find(d =>
        normalizeCommanderName(d.name).startsWith(target) || target.startsWith(normalizeCommanderName(d.name))
      );
    if (deck) deck.power = row.X;
  }

  podPlayers = players.filter(p => knownPlaygroupPlayers.has(p.name));
  renderPlayersTable();
  renderPodSlots();
  renderGamesToUpdate();
  renderWinRatesTable(playgroupGamesData);
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

  const nextGameNum = Math.max(0, ...gameLogSeason3Rows.map(r => Number(r.gameNum) || 0)) + 1;

  resultsEl.innerHTML = "";

  const tableRows = rows.map(row => {
    const existing = gameLogSeason3Rows.filter(r => r.player === row.player && typeof r.J === "number");
    const before = computePlayerAdjustedWinRate(existing);
    const after = computePlayerAdjustedWinRate(existing, { result: row.result === "win" ? 1 : 0, J: row.J, K: row.K, M: row.M });
    const delta = after.B - before.B;
    const deltaStr = `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}pt`;

    const rowValues = [
      pgGame.date, nextGameNum, row.player, row.commander, row.strength.toFixed(1),
      row.result === "win" ? 1 : 0, row.place, podSize, row.knockouts,
      row.J.toFixed(6), row.K.toFixed(6), row.L.toFixed(6), row.M.toFixed(6),
      row.N.toFixed(6), row.O.toFixed(6), row.tov, row.Q.toFixed(6), row.popOff,
      row.disruptions, row.recoveries, row.U.toFixed(6), row.behind, row.bracket, row.X.toFixed(6),
    ];

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy row";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(rowValues.join("\t"));
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy row"; }, 1500);
    });

    return [
      row.player,
      row.commander,
      row.result === "win" ? "Win" : "Loss",
      `${(before.B * 100).toFixed(2)}% (${before.wins}-${before.losses})`,
      `${(after.B * 100).toFixed(2)}% (${after.wins}-${after.losses}) — ${deltaStr}`,
      { node: copyBtn },
    ];
  });

  const { table } = buildTable(
    "gtu-results-table",
    ["Player", "Commander", "Result", "Current PAWR", "PAWR w/ this game", ""],
    tableRows
  );
  resultsEl.appendChild(table);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = `Row order for pasting into ${CURRENT_SEASON_SHEET}: Game Date, Game #, Player Name, Commander, Commander Strength, Game Result, Place, Pod Size, Knockouts, Adjusted Pod Size Win/Loss Score, Knockout Score, Deck Strength Comparison Differential, Win Probability based on Deck Strength, Player Score, Normalized Player Score, TOV, Normalized TOV, Pop-Off, Disruptions, Successful Recoveries, Deck Resilience Score, Games Clearly Behind, Current Deck Bracket, Game Calculated Deck Strength. Suggested next Game # is ${nextGameNum} — check it doesn't collide if you're filling in more than one game.`;
  resultsEl.appendChild(hint);

  const submitBtn = document.createElement("button");
  submitBtn.className = "primary gtu-submit-btn";
  const statusEl = document.createElement("span");
  statusEl.className = "gtu-submit-status";

  if (!GAME_SUBMIT_RELAY_URL) {
    submitBtn.textContent = "Submit to Spreadsheet (not configured)";
    submitBtn.disabled = true;
    statusEl.textContent = "Relay not deployed yet — use Copy row for now.";
  } else {
    submitBtn.textContent = "Submit to Spreadsheet";
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
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        submitBtn.textContent = "Submitted ✓";
        applyOptimisticGameSubmit(pgGame, podSize, rows, nextGameNum);
        statusEl.textContent = "Added — already reflected in Games to Update, Player Win Rates, and Deck Strength Validator's deck power. GitHub Actions is syncing this to the spreadsheet in the background (usually 1-3 minutes) so it sticks around for everyone else.";
        // The submitted game is already gone from the missing-games list
        // above (applyOptimisticGameSubmit just re-rendered it), but this
        // filled-in form otherwise just sits here forever -- confirmed the
        // hard way, it was still showing a "submitted" game's form as if
        // still pending after switching tabs and back. Leaves the
        // confirmation message up briefly so it's actually seen, then
        // clears the form area so the tab returns to a clean state.
        setTimeout(() => {
          const areaEl = box.parentElement;
          if (areaEl) areaEl.innerHTML = "";
        }, 2500);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit to Spreadsheet";
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
// already parsed from Current Deck Strength (the `players` array -- same
// data source Deck Strength Validator and Player Win Rates already use). Matches by
// playgroup deck ID first; for rows the ID backfill hasn't reached yet,
// falls back to the same name normalization findDefaultStrength uses, so
// backfill completeness is never a hard requirement for correctness.
// Usernames submitted as a brand-new player this session. computeRosterDiff
// below has no way to know a submitted new player isn't "new" anymore
// other than this: member.tracked (and mapped_player) come straight from
// rosterDiffData, which only reflects reality once roster-update.yml's
// Worker redeploy finishes -- well after the optimistic merge into
// `players` already happened. Without this override, a submitted new
// player keeps showing as pending for those few minutes even though
// they're already fully added. Any of their decks left unsubmitted stay
// hidden until the real backend catches up too -- an acceptable gap given
// it's normally seconds to a few minutes, not an unbounded amount of time.
const rosterUpdateOptimisticallyTrackedUsernames = new Set();

function computeRosterDiff(data) {
  const newPlayers = [];
  const newDecksForExisting = [];

  for (const member of data.members) {
    if (rosterUpdateOptimisticallyTrackedUsernames.has(member.username)) continue;
    const allDecks = (data.decks_by_username[member.username] || []).filter(d => !d.archived);
    if (allDecks.length === 0) continue;

    if (!member.tracked) {
      newPlayers.push({ username: member.username, suggestedDisplayName: member.username, decks: allDecks });
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

// The real round trip (GitHub Action recalculating deck-strength.xlsx, the
// Pages rebuild that follows, then this page's next 60s poll) takes 1-3
// minutes -- too slow for someone who just added their own deck and wants
// to pick it for the pod they're building right now. This merges the
// just-submitted player/decks into the in-memory players/podPlayers arrays
// immediately so they're selectable right away. It's safe to be
// optimistic here: the next real syncFromRepoWorkbook() (interval or
// reload) rebuilds `players` from scratch from the spreadsheet, so this
// never lingers or conflicts with the authoritative data.
function applyOptimisticRosterUpdate(payload) {
  const findOrCreatePlayer = (name) => {
    let player = players.find(p => p.name === name);
    if (!player) {
      player = { id: slugify(name), name, decks: [] };
      players.push(player);
    }
    return player;
  };

  const addDeck = (player, d) => {
    const deckId = `${player.id}::${slugify(d.name)}`;
    if (player.decks.some(existing => existing.id === deckId)) return;
    player.decks.push({
      id: deckId,
      name: d.name,
      power: d.power,
      playgroupId: d.playgroupDeckId != null ? String(d.playgroupDeckId) : null,
    });
  };

  payload.newPlayers.forEach(p => {
    const player = findOrCreatePlayer(p.displayName);
    knownPlaygroupPlayers.add(p.displayName);
    p.decks.forEach(d => addDeck(player, d));
  });

  payload.newDecksForExisting.forEach(d => {
    addDeck(findOrCreatePlayer(d.player), d);
  });

  podPlayers = players.filter(p => knownPlaygroupPlayers.has(p.name));
  renderPlayersTable();
  renderPodSlots();
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
    submitBtn.textContent = "Add to Spreadsheet (not configured)";
    submitBtn.disabled = true;
  } else {
    submitBtn.textContent = "Add to Spreadsheet";
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
          decks.push({ name: d.commander_name, power, playgroupDeckId: d.id });
          submittedDeckIds.push(String(d.id));
        });
        if (displayName && decks.length > 0) {
          payload.newPlayers.push({ username: p.username, displayName, decks });
          submittedUsernames.push(p.username);
        }
      });

      newDecksForExisting.forEach(g => {
        g.decks.forEach(d => {
          const state = rosterUpdateDeckState.get(String(d.id));
          if (!state || !state.checked) return;
          const power = parseFloat(state.power);
          if (!Number.isFinite(power)) return;
          payload.newDecksForExisting.push({ player: g.player, name: d.commander_name, power, playgroupDeckId: d.id });
          submittedDeckIds.push(String(d.id));
        });
      });

      if (payload.newPlayers.length === 0 && payload.newDecksForExisting.length === 0) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Add to Spreadsheet";
        statusEl.textContent = "Nothing selected (or missing a starting power) — check the boxes and power fields above.";
        return;
      }

      try {
        const res = await fetch(ROSTER_UPDATE_RELAY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        applyOptimisticRosterUpdate(payload);
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

        // Setting this and re-rendering is what makes the just-submitted
        // group disappear immediately instead of lingering until the next
        // poll -- computeRosterDiff won't find it pending anymore since
        // applyOptimisticRosterUpdate just added it to `players`. The
        // banner survives the re-render because renderUpdateAppTab reads
        // and displays it before clearing it, not because anything here is
        // preserved in place.
        rosterUpdateSubmitConfirmation =
          `✓ Added ${submittedLabels.join(", ")} — already selectable in Deck Strength Validator. ` +
          "GitHub Actions is syncing it to the spreadsheet now (usually 1-3 minutes) so it sticks around for good.";
        renderUpdateAppTab();
        return;
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Add to Spreadsheet";
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
  gtuIntroEl.textContent = `Games from playgroup.gg that aren't in the spreadsheet's ${CURRENT_SEASON_SHEET} yet. Fill in what playgroup.gg can't supply, then copy the finished row(s) into the real Game Log — this app never edits deck-strength.xlsx itself.`;
}

initPlayerCountSelect();
syncFromRepoWorkbook();
initTabs();
refreshPlaygroupGames();
loadRosterDiff();

// Re-fetches everything derived from either data source: syncFromRepoWorkbook
// re-reads deck-strength.xlsx (also re-runs renderWinRatesTable as part of
// it), refreshPlaygroupGames re-fetches the live playgroup.gg games list
// that both Games to Update and Player Win Rates depend on, loadRosterDiff
// re-fetches the live roster/deck list that Update the App depends on.
// Nothing here is cached anywhere (client or Worker), so every call is
// truly live -- the only question is how often it runs, not how fresh the
// result is. Deliberately NOT on a timer: /playgroup-games touches Workers
// KV on every single call, and a continuous 60s poll from every open tab
// added up fast against the free tier's daily read/write budget for
// basically no benefit, since nothing here needs sub-minute freshness the
// way a user's own submit already gets via the optimistic-update paths
// elsewhere in this file. Triggered by: the manual refresh button, the
// visibility-change listener right below (so opening/returning to the app
// never shows stale data), and once on initial page load.
async function refreshEverything() {
  const btn = document.getElementById("global-refresh-btn");
  if (btn) btn.classList.add("spinning");
  try {
    await Promise.all([syncFromRepoWorkbook(), refreshPlaygroupGames(), loadRosterDiff()]);
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

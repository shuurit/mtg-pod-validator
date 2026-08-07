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

// Which tracked players show up in Pod Validator and Player Win Rates
// (players with no playgroup.gg account, like Kristy/Joseph, are filtered
// out of both). Seeded from the hardcoded list as a fallback for the moment
// before the Worker's first response arrives; updated live from
// known_players once it does, so relay.js's USERNAME_TO_PLAYER is the only
// place a new member needs adding.
let knownPlaygroupPlayers = new Set(PLAYERS_WITH_PLAYGROUP_ACCOUNT);

let players = []; // everyone in Current Deck Strength, unfiltered
let podPlayers = []; // players filtered to knownPlaygroupPlayers -- used by Pod Validator and Player Win Rates
let podCount = 4;
let podSelections = []; // { playerId, deckId } per slot
let expandedPlayerIds = new Set(); // player blocks currently showing their deck table

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
// the set of who's shown in Pod Validator (e.g. a new player was added to
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
      statusEl.textContent = `Synced from ${REPO_WORKBOOK_FILE} (${players.length} players, ${deckCount} decks; ${podPlayers.length} shown in Pod Validator).`;
    }

    gameLogSeason3Rows = extractGameLogFromWorkbook(workbook, CURRENT_SEASON_SHEET);
    renderGamesToUpdate();
    renderWinRatesTable(playgroupGamesData);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Using locally saved data — couldn't load ${REPO_WORKBOOK_FILE} (${err.message}).`;
    }
    const gtuStatus = document.getElementById("gtu-status");
    if (gtuStatus) gtuStatus.textContent = `Couldn't load ${REPO_WORKBOOK_FILE} — Games to Update needs it to know what's already logged.`;
  }
}

// ---------- players/decks display (read-only) ----------

function formatPower(power) {
  return power.toFixed(1);
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

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Deck</th><th>Power</th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const deck of player.decks) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.textContent = deck.name;

      const powerTd = document.createElement("td");
      powerTd.className = "num";
      powerTd.textContent = formatPower(deck.power);

      tr.appendChild(nameTd);
      tr.appendChild(powerTd);
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
    const slot = { playerId: prev.playerId || "", deckId: prev.deckId || "" };
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
    const powerSpan = document.createElement("div");
    powerSpan.className = "slot-power";

    function refreshDeckOptions() {
      deckSelect.innerHTML = "";
      const player = podPlayers.find(p => p.id === slot.playerId);
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = player ? "Select deck…" : "—";
      deckSelect.appendChild(blank);
      deckSelect.disabled = !player;
      if (player) {
        for (const d of player.decks) {
          const opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = `${d.name} (${formatPower(d.power)})`;
          if (d.id === slot.deckId) opt.selected = true;
          deckSelect.appendChild(opt);
        }
      }
      updatePowerDisplay();
    }

    function updatePowerDisplay() {
      const player = podPlayers.find(p => p.id === slot.playerId);
      const deck = player ? player.decks.find(d => d.id === slot.deckId) : null;
      powerSpan.textContent = deck ? formatPower(deck.power) : "";
    }

    playerSelect.addEventListener("change", () => {
      slot.playerId = playerSelect.value;
      slot.deckId = "";
      refreshDeckOptions();
    });

    deckSelect.addEventListener("change", () => {
      slot.deckId = deckSelect.value;
      updatePowerDisplay();
    });

    refreshDeckOptions();

    row.appendChild(label);
    row.appendChild(playerSelect);
    row.appendChild(deckSelect);
    row.appendChild(powerSpan);
    container.appendChild(row);
  }
}

// ---------- validation ----------

function evaluatePod(entries) {
  // entries: [{ playerId, playerName, deckId, deckName, power }]
  // The weakest deck in the pod sets the floor; anything more than
  // RANGE_TOLERANCE above it needs to come down. The weakest deck itself
  // is always compatible — it's never asked to get even weaker.
  const powers = entries.map(e => e.power);
  const floor = Math.min(...powers);
  const ceiling = floor + RANGE_TOLERANCE;
  return entries.map(entry => ({ ...entry, compatible: entry.power <= ceiling }));
}

function suggestAlternates(entry, evaluatedEntries) {
  const player = podPlayers.find(p => p.id === entry.playerId);
  if (!player) return [];
  // Only constrain against players who are already compatible. An
  // independently out-of-range player's current pick isn't a fixed target —
  // they're getting their own suggestions too — so it shouldn't narrow (or
  // block entirely) the valid window for this player's replacement deck.
  const others = evaluatedEntries.filter(
    e => (e.playerId !== entry.playerId || e.deckId !== entry.deckId) && e.compatible
  );
  const otherPowers = others.map(o => o.power);
  const otherMax = otherPowers.length ? Math.max(...otherPowers) : -Infinity;
  const otherMin = otherPowers.length ? Math.min(...otherPowers) : Infinity;
  const lowBound = otherMax - RANGE_TOLERANCE;
  const highBound = otherMin + RANGE_TOLERANCE;
  return player.decks
    .filter(d => d.id !== entry.deckId)
    .filter(d => d.power >= lowBound && d.power <= highBound)
    .sort((a, b) => a.power - b.power);
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
      deckName: deck.name,
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
    ? `All decks are within range (spread: ${formatPower(spread)}, ${formatPower(min)}–${formatPower(max)}).`
    : `Spread is ${formatPower(spread)} — outside the ±${RANGE_TOLERANCE} target. Some decks need to change.`;
  resultsDiv.appendChild(banner);

  const evaluated = evaluatePod(entries);

  for (const entry of evaluated) {
    const row = document.createElement("div");
    row.className = "result-row " + (entry.compatible ? "ok" : "out");
    row.dataset.playerId = entry.playerId;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${entry.playerName} — ${entry.deckName}`;

    const power = document.createElement("span");
    power.className = "power";
    power.textContent = formatPower(entry.power) + (entry.compatible ? " ✓" : " ⚠");

    row.appendChild(name);
    row.appendChild(power);
    resultsDiv.appendChild(row);

    if (!entry.compatible) {
      const alts = suggestAlternates(entry, evaluated);
      const box = document.createElement("div");
      box.className = "suggestions";
      if (alts.length === 0) {
        box.innerHTML = `<span class="none">No other saved deck for ${entry.playerName} fits this pod's range.</span>`;
      } else {
        const label = document.createElement("div");
        label.textContent = `Decks that would bring ${entry.playerName} into range — click to swap in:`;
        box.appendChild(label);
        for (const alt of alts) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "suggestion-chip";
          chip.textContent = `${alt.name} (${formatPower(alt.power)})`;
          chip.addEventListener("click", () => {
            const slot = podSelections.find(s => s.playerId === entry.playerId);
            if (!slot) return;
            slot.deckId = alt.id;
            renderPodSlots();
            const staleRow = resultsDiv.querySelector(`.result-row[data-player-id="${entry.playerId}"]`);
            if (staleRow) staleRow.classList.add("pending-recheck");
            document.getElementById("validate-btn").classList.add("glow");
          });
          box.appendChild(chip);
        }
      }
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

  const table = document.createElement("table");
  table.className = "winrates-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Player</th>
        <th>Win Rate (playgroup.gg)</th>
        <th>Player Adjusted Win Rate</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement("tbody");

  for (const player of podPlayers) {
    const name = player.name;
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.textContent = name;

    const pgTd = document.createElement("td");
    pgTd.className = "num";
    const t = tally[name];
    if (t && (t.wins + t.losses) > 0) {
      const pct = (t.wins / (t.wins + t.losses)) * 100;
      pgTd.textContent = `${pct.toFixed(3)}% (${t.wins}-${t.losses})`;
    } else {
      pgTd.className += " muted";
      pgTd.innerHTML = `<span class="na">No games in the active league yet</span>`;
    }

    const adjTd = document.createElement("td");
    adjTd.className = "num";
    const rows = gameLogSeason3Rows.filter(r => r.player === name && typeof r.J === "number");
    if (rows.length > 0) {
      const adj = computePlayerAdjustedWinRate(rows);
      adjTd.textContent = `${(adj.B * 100).toFixed(3)}% (${adj.wins}-${adj.losses})`;
    } else {
      adjTd.className += " muted";
      adjTd.innerHTML = `<span class="na">No games logged in ${CURRENT_SEASON_SHEET}</span>`;
    }

    tr.appendChild(nameTd);
    tr.appendChild(pgTd);
    tr.appendChild(adjTd);
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

// Same game if the same set of tracked players appears under a game number
// in the current season's Game Log tab, within a day of the playgroup.gg
// timestamp (playgroup.gg logs in UTC+2; the sheet's date can land a day off).
function findLoggedMatch(pgGame) {
  const pgPlayers = new Set(pgGame.participants.map(p => p.player));
  const byGameNum = {};
  for (const row of gameLogSeason3Rows) {
    (byGameNum[row.gameNum] ||= []).push(row);
  }
  const pgDate = new Date(pgGame.date);
  for (const gameNum in byGameNum) {
    const rows = byGameNum[gameNum];
    const loggedPlayers = new Set(rows.map(r => r.player));
    // Subset, not exact-size match: a logged game can include a player
    // with no mapped playgroup.gg account (e.g. Kristy), so playgroup.gg's
    // tracked participant set can legitimately be smaller than what's
    // logged for the same real game.
    if (![...pgPlayers].every(p => loggedPlayers.has(p))) continue;
    const loggedDate = rows[0].date instanceof Date ? rows[0].date : null;
    if (!loggedDate) return gameNum;
    const diffDays = Math.abs((loggedDate - pgDate) / 86400000);
    if (diffDays <= 1.5) return gameNum;
  }
  return null;
}

// Shared by findDefaultStrength below and computeRosterDiff -- a deck name
// or commander name reduced to its first segment, case-insensitive, so
// small naming variations ("Ms. Bumbleflower" vs "Ms. Bumbleflower, Deck")
// still line up.
function normalizeCommanderName(s) {
  return (s || "").toLowerCase().split(/[,/]/)[0].trim();
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

function renderGamesToUpdate() {
  const statusEl = document.getElementById("gtu-status");
  const listEl = document.getElementById("gtu-game-list");
  if (!playgroupGamesData || !statusEl || !listEl) return;
  if (gameLogSeason3Rows.length === 0) {
    statusEl.textContent = "Waiting on deck-strength.xlsx to load...";
    return;
  }

  const missing = playgroupGamesData.games.filter(g => !findLoggedMatch(g));
  statusEl.textContent = `${missing.length} of ${playgroupGamesData.games.length} ${playgroupGamesData.league || ""} games aren't in the Game Log yet.`;

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

    const summary = g.participants.map(p => `${p.player} (${p.commander}${p.result === "win" ? " — won" : ""})`).join(", ");
    const header = document.createElement("div");
    header.className = "gtu-game-summary";
    header.innerHTML = `<strong>${g.date}</strong> — ${summary}`;

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

function openGameForm(pgGame) {
  const areaEl = document.getElementById("gtu-form-area");
  areaEl.innerHTML = "";

  const box = document.createElement("div");
  box.className = "gtu-form";

  const title = document.createElement("h3");
  title.textContent = `${pgGame.date} — ${pgGame.participants.map(p => p.player).join(", ")}`;
  box.appendChild(title);

  const table = document.createElement("table");
  table.className = "gtu-input-table";
  table.innerHTML = `
    <thead><tr>
      <th>Player</th><th>Commander</th><th>Result</th>
      <th>Cmdr Strength</th><th>Place</th><th>KOs</th><th>TOV</th>
      <th>Pop-Off</th><th>Disruptions</th><th>Recoveries</th><th>Behind</th><th>Bracket</th>
    </tr></thead>
  `;
  const tbody = document.createElement("tbody");

  pgGame.participants.forEach((p, i) => {
    const tr = document.createElement("tr");
    const defaultStrength = findDefaultStrength(p.player, p.commander);
    const defaultPlace = p.result === "win" ? 1 : "";
    const defaultBracket = findDefaultBracket(p.player, p.commander);
    tr.innerHTML = `
      <td>${p.player}</td>
      <td>${p.commander}</td>
      <td>${p.result === "win" ? "Win ✓" : "Loss"}</td>
      <td><input type="number" step="0.1" min="0" max="5" class="gtu-in gtu-strength" value="${defaultStrength ?? ""}" data-i="${i}"></td>
      <td><input type="number" min="1" max="${pgGame.pod_size}" class="gtu-in gtu-place" value="${defaultPlace}" data-i="${i}"></td>
      <td><input type="number" min="0" class="gtu-in gtu-knockouts" value="0" data-i="${i}"></td>
      <td><input type="number" min="1" class="gtu-in gtu-tov" value="" data-i="${i}"></td>
      <td><input type="checkbox" class="gtu-in gtu-popoff" data-i="${i}"></td>
      <td><input type="number" min="0" class="gtu-in gtu-disruptions" value="0" data-i="${i}"></td>
      <td><input type="number" min="0" class="gtu-in gtu-recoveries" value="0" data-i="${i}"></td>
      <td><input type="checkbox" class="gtu-in gtu-behind" data-i="${i}"></td>
      <td><input type="number" min="1" max="5" class="gtu-in gtu-bracket" value="${defaultBracket}" data-i="${i}"></td>
    `;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  box.appendChild(table);

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

  const inputs = pgGame.participants.map((p, i) => ({ ...p, ...readInputs(i) }));
  const missingField = inputs.find(inp =>
    Number.isNaN(inp.strength) || Number.isNaN(inp.place) || Number.isNaN(inp.tov) || Number.isNaN(inp.bracket)
  );
  if (missingField) {
    resultsEl.innerHTML = `<p class="hint">Fill in Commander Strength, Place, TOV, and Bracket for every player first (missing for ${missingField.player}).</p>`;
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
  const table = document.createElement("table");
  table.className = "gtu-results-table";
  table.innerHTML = `<thead><tr><th>Player</th><th>Commander</th><th>Result</th><th>Current PAWR</th><th>PAWR w/ this game</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");

  for (const row of rows) {
    const existing = gameLogSeason3Rows.filter(r => r.player === row.player && typeof r.J === "number");
    const before = computePlayerAdjustedWinRate(existing);
    const after = computePlayerAdjustedWinRate(existing, { result: row.result === "win" ? 1 : 0, J: row.J, K: row.K, M: row.M });

    const tr = document.createElement("tr");
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

    tr.innerHTML = `
      <td>${row.player}</td>
      <td>${row.commander}</td>
      <td>${row.result === "win" ? "Win" : "Loss"}</td>
      <td>${(before.B * 100).toFixed(2)}% (${before.wins}-${before.losses})</td>
      <td>${(after.B * 100).toFixed(2)}% (${after.wins}-${after.losses}) — ${deltaStr}</td>
      <td></td>
    `;
    tr.lastElementChild.appendChild(copyBtn);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
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
        statusEl.textContent = "Added — already reflected in Games to Update, Player Win Rates, and Pod Validator's deck power. GitHub Actions is syncing this to the spreadsheet in the background (usually 1-3 minutes) so it sticks around for everyone else.";
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

let rosterDiffData = null;

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
    renderUpdateAppTab();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Couldn't load live playgroup.gg data (${err.message}).`;
  }
}

// Compares the Worker's raw playgroup.gg roster/decks against what's
// already parsed from Current Deck Strength (the `players` array -- same
// data source Pod Validator and Player Win Rates already use). Matches by
// playgroup deck ID first; for rows the ID backfill hasn't reached yet,
// falls back to the same name normalization findDefaultStrength uses, so
// backfill completeness is never a hard requirement for correctness.
function computeRosterDiff(data) {
  const newPlayers = [];
  const newDecksForExisting = [];

  for (const member of data.members) {
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

function deckRowHtml(deck, checkboxName, powerName) {
  const powerValue = typeof deck.power_level === "number" ? deck.power_level.toFixed(1) : "";
  return `
    <tr>
      <td><input type="checkbox" class="${checkboxName}" data-deck-id="${deck.id}" checked></td>
      <td>${deck.commander_name}${deck.name !== deck.commander_name ? ` <span class="hint">(${deck.name})</span>` : ""}</td>
      <td><input type="number" class="${powerName}" data-deck-id="${deck.id}" step="0.1" min="0" max="5" value="${powerValue}" placeholder="power"></td>
    </tr>
  `;
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
  statusEl.textContent = `Live as of ${new Date(rosterDiffData.generated_at).toLocaleTimeString()} — ${newPlayers.length} new player(s), ${newDecksForExisting.reduce((n, g) => n + g.decks.length, 0)} new deck(s) for existing players found on playgroup.gg.`;

  if (newPlayers.length === 0 && newDecksForExisting.length === 0) {
    listEl.innerHTML = '<p class="hint">Nothing new — everyone and everything tracked here matches playgroup.gg.</p>';
    return;
  }

  listEl.innerHTML = "";

  newPlayers.forEach((p, pi) => {
    const box = document.createElement("div");
    box.className = "uta-group";
    box.innerHTML = `
      <div class="uta-group-header">
        <label>New player (playgroup.gg: <code>${p.username}</code>) — display name:
          <input type="text" class="uta-display-name" data-player-index="${pi}" value="${p.suggestedDisplayName}">
        </label>
      </div>
      <table class="uta-deck-table">
        <thead><tr><th></th><th>Deck</th><th>Starting power</th></tr></thead>
        <tbody>${p.decks.map(d => deckRowHtml(d, `uta-new-player-deck-${pi}`, `uta-new-player-power-${pi}`)).join("")}</tbody>
      </table>
    `;
    listEl.appendChild(box);
  });

  newDecksForExisting.forEach((g, gi) => {
    const box = document.createElement("div");
    box.className = "uta-group";
    box.innerHTML = `
      <div class="uta-group-header"><strong>${g.player}</strong> — ${g.decks.length} new deck(s)</div>
      <table class="uta-deck-table">
        <thead><tr><th></th><th>Deck</th><th>Starting power</th></tr></thead>
        <tbody>${g.decks.map(d => deckRowHtml(d, `uta-existing-deck-${gi}`, `uta-existing-power-${gi}`)).join("")}</tbody>
      </table>
    `;
    listEl.appendChild(box);
  });

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

function renderRosterUpdateSubmit(formAreaEl, newPlayers, newDecksForExisting) {
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

      const payload = { newPlayers: [], newDecksForExisting: [] };

      newPlayers.forEach((p, pi) => {
        const displayName = document.querySelector(`.uta-display-name[data-player-index="${pi}"]`).value.trim();
        const decks = [];
        p.decks.forEach(d => {
          const checked = document.querySelector(`.uta-new-player-deck-${pi}[data-deck-id="${d.id}"]`).checked;
          if (!checked) return;
          const power = parseFloat(document.querySelector(`.uta-new-player-power-${pi}[data-deck-id="${d.id}"]`).value);
          if (!Number.isFinite(power)) return;
          decks.push({ name: d.commander_name, power, playgroupDeckId: d.id });
        });
        if (displayName && decks.length > 0) {
          payload.newPlayers.push({ username: p.username, displayName, decks });
        }
      });

      newDecksForExisting.forEach((g, gi) => {
        g.decks.forEach(d => {
          const checked = document.querySelector(`.uta-existing-deck-${gi}[data-deck-id="${d.id}"]`).checked;
          if (!checked) return;
          const power = parseFloat(document.querySelector(`.uta-existing-power-${gi}[data-deck-id="${d.id}"]`).value);
          if (!Number.isFinite(power)) return;
          payload.newDecksForExisting.push({ player: g.player, name: d.commander_name, power, playgroupDeckId: d.id });
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
        submitBtn.textContent = "Submitted ✓";
        applyOptimisticRosterUpdate(payload);
        statusEl.textContent = "Added — already selectable in Pod Validator. GitHub Actions is syncing this to the spreadsheet in the background (usually 1-3 minutes) so it sticks around for everyone else.";
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

// Keeps everything derived from either data source fresh without a manual
// reload: syncFromRepoWorkbook re-fetches deck-strength.xlsx (also re-runs
// renderWinRatesTable as part of it), refreshPlaygroupGames re-fetches the
// live playgroup.gg games list that both Games to Update and Player Win
// Rates depend on, loadRosterDiff re-fetches the live roster/deck list that
// Update the App depends on. Paused while the tab isn't visible so it
// doesn't do pointless work in the background.
const AUTO_REFRESH_INTERVAL_MS = 60000;
setInterval(() => {
  if (document.hidden) return;
  syncFromRepoWorkbook();
  refreshPlaygroupGames();
  loadRosterDiff();
}, AUTO_REFRESH_INTERVAL_MS);

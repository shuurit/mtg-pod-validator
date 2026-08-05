const STORAGE_KEY = "mtg-pod-validator-players";
const RANGE_TOLERANCE = 1; // max power spread allowed within a pod
const PLAYGROUP_URL = "https://playgroup.gg/playgroups/51996"; // "Amass a Gathering"

// Default roster — the group's real players/decks/power ratings. Used to
// seed local storage the first time the app runs in a browser; after that,
// whatever's in local storage (including edits) takes over.
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

let players = loadPlayers();
let podCount = 4;
let podSelections = []; // { playerId, deckId } per slot
let expandedPlayerIds = new Set(); // player blocks currently showing their deck table

// ---------- persistence ----------

function buildDefaultPlayers() {
  return DEFAULT_ROSTER.map(p => ({
    id: uid(),
    name: p.name,
    decks: p.decks.map(([name, power]) => ({ id: uid(), name, power })),
  }));
}

function getDefaultPlayer(name) {
  return DEFAULT_ROSTER.find(p => p.name.toLowerCase() === name.toLowerCase());
}

function getMissingPlayers() {
  return DEFAULT_ROSTER.filter(
    dp => !players.some(p => p.name.toLowerCase() === dp.name.toLowerCase())
  );
}

function getMissingDecksForPlayer(player) {
  const def = getDefaultPlayer(player.name);
  if (!def) return [];
  return def.decks.filter(
    ([dname]) => !player.decks.some(d => d.name.toLowerCase() === dname.toLowerCase())
  );
}

function loadPlayers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fall through to default roster
  }
  const seeded = buildDefaultPlayers();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

function savePlayers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(players));
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- CSV import ----------

// Splits one line on commas or tabs, respecting "quoted, fields" so deck
// names like `"Aminatou, Veil Piercer"` survive intact.
function splitDelimitedLine(line) {
  const delimiter = line.includes("\t") ? "\t" : ",";
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

function parseCSV(text) {
  const lines = text.split("\n").map(l => l.replace(/\r$/, "")).filter(l => l.trim());
  const rows = [];
  for (const line of lines) {
    const parts = splitDelimitedLine(line);
    if (parts.length < 3) continue;
    const [name, deck, powerStr] = parts;
    if (/^player\s*name$/i.test(name) || /^name$/i.test(name)) continue; // skip header row
    const power = parseFloat(powerStr);
    if (!name || !deck || Number.isNaN(power)) continue;
    rows.push({ name, deck, power });
  }
  return rows;
}

function importRows(rows) {
  let addedDecks = 0;
  let addedPlayers = 0;
  for (const row of rows) {
    let player = players.find(p => p.name.toLowerCase() === row.name.toLowerCase());
    if (!player) {
      player = { id: uid(), name: row.name, decks: [] };
      players.push(player);
      addedPlayers++;
    }
    let deck = player.decks.find(d => d.name.toLowerCase() === row.deck.toLowerCase());
    if (deck) {
      deck.power = row.power;
    } else {
      player.decks.push({ id: uid(), name: row.deck, power: row.power });
      addedDecks++;
    }
  }
  savePlayers();
  return { addedPlayers, addedDecks };
}

// ---------- XLSX import ----------

// Reads the "Current Deck Strength" tab. Its layout is: a bold player-name
// row whose Power cell holds an =AVERAGE(...) formula over the deck rows
// beneath it, followed by plain deck rows (name + numeric power, no
// formula). We tell the two apart by whether the Power cell has a formula.
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
    const name = nameCell && typeof nameCell.v === "string" ? nameCell.v.trim() : null;
    if (!name || name.toLowerCase() === "decks") continue;

    const isPlayerHeader = !!(powerCell && typeof powerCell.f === "string");
    if (isPlayerHeader) {
      currentPlayer = name;
      continue;
    }

    const power = powerCell && typeof powerCell.v === "number" ? powerCell.v : NaN;
    if (currentPlayer && Number.isFinite(power)) {
      rows.push({ name: currentPlayer, deck: name, power });
    }
  }
  return rows;
}

// Name of the workbook this app auto-syncs from on every load, expected to
// sit alongside index.html. Swap in each quarter's updated export under
// this same filename — the app doesn't need to know the dated original name.
const REPO_WORKBOOK_FILE = "deck-strength.xlsx";

async function syncFromRepoWorkbook() {
  const statusEl = document.getElementById("sync-status");
  try {
    const res = await fetch(REPO_WORKBOOK_FILE, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const rows = extractRowsFromWorkbook(workbook);
    if (rows.length === 0) throw new Error("no decks found in the sheet");

    const { addedPlayers, addedDecks } = importRows(rows);
    renderPlayersTable();
    renderPodSlots();
    if (statusEl) {
      statusEl.textContent = `Synced from ${REPO_WORKBOOK_FILE} (${addedPlayers} new player(s), ${addedDecks} deck(s) added/updated).`;
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Using locally saved data — couldn't load ${REPO_WORKBOOK_FILE} (${err.message}).`;
    }
  }
}

// ---------- players/decks management UI ----------

function renderPlayersTable() {
  const container = document.getElementById("players-table");
  container.innerHTML = "";

  if (players.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No players yet. Import a list above or add one manually.";
    container.appendChild(empty);
    return;
  }

  for (const player of players) {
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

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "player-name-input";
    nameInput.value = player.name;
    nameInput.addEventListener("change", () => {
      player.name = nameInput.value.trim() || player.name;
      savePlayers();
      renderPodSlots();
    });

    const deckCount = document.createElement("span");
    deckCount.className = "deck-count";
    deckCount.textContent = `${player.decks.length} deck${player.decks.length === 1 ? "" : "s"}`;
    deckCount.addEventListener("click", () => {
      if (isExpanded) expandedPlayerIds.delete(player.id);
      else expandedPlayerIds.add(player.id);
      renderPlayersTable();
    });

    const removePlayerBtn = document.createElement("button");
    removePlayerBtn.className = "icon-btn";
    removePlayerBtn.textContent = "Remove player";
    removePlayerBtn.addEventListener("click", () => {
      players = players.filter(p => p.id !== player.id);
      expandedPlayerIds.delete(player.id);
      savePlayers();
      renderPlayersTable();
      renderPodSlots();
    });

    const headerLeft = document.createElement("div");
    headerLeft.className = "player-block-header-left";
    headerLeft.appendChild(toggleBtn);
    headerLeft.appendChild(nameInput);
    headerLeft.appendChild(deckCount);

    header.appendChild(headerLeft);
    header.appendChild(removePlayerBtn);
    block.appendChild(header);

    if (!isExpanded) {
      container.appendChild(block);
      continue;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Deck</th><th>Power</th><th></th></tr>";
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const deck of player.decks) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      const deckNameInput = document.createElement("input");
      deckNameInput.type = "text";
      deckNameInput.value = deck.name;
      deckNameInput.addEventListener("change", () => {
        deck.name = deckNameInput.value.trim() || deck.name;
        savePlayers();
        renderPodSlots();
      });
      nameTd.appendChild(deckNameInput);

      const powerTd = document.createElement("td");
      const powerInput = document.createElement("input");
      powerInput.type = "number";
      powerInput.step = "0.1";
      powerInput.min = "0";
      powerInput.max = "5";
      powerInput.className = "power-input";
      powerInput.value = deck.power;
      powerInput.addEventListener("change", () => {
        const v = parseFloat(powerInput.value);
        if (!Number.isNaN(v)) deck.power = Math.min(5, Math.max(0, v));
        powerInput.value = deck.power;
        savePlayers();
      });
      powerTd.appendChild(powerInput);

      const actionTd = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", () => {
        player.decks = player.decks.filter(d => d.id !== deck.id);
        savePlayers();
        renderPlayersTable();
        renderPodSlots();
      });
      actionTd.appendChild(delBtn);

      tr.appendChild(nameTd);
      tr.appendChild(powerTd);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    block.appendChild(table);

    const deckActions = document.createElement("div");
    deckActions.className = "row";

    const addDeckBtn = document.createElement("button");
    addDeckBtn.textContent = "+ Add Deck";
    addDeckBtn.addEventListener("click", () => {
      player.decks.push({ id: uid(), name: "New Deck", power: 3.0 });
      savePlayers();
      renderPlayersTable();
    });
    deckActions.appendChild(addDeckBtn);

    const missingDecks = getMissingDecksForPlayer(player);
    if (missingDecks.length > 0) {
      const restoreSelect = document.createElement("select");
      for (const [dname, power] of missingDecks) {
        const opt = document.createElement("option");
        opt.value = dname;
        opt.textContent = `${dname} (${power.toFixed(1)})`;
        restoreSelect.appendChild(opt);
      }
      const restoreDeckBtn = document.createElement("button");
      restoreDeckBtn.textContent = "Restore Deck";
      restoreDeckBtn.addEventListener("click", () => {
        const [dname, power] = missingDecks.find(([n]) => n === restoreSelect.value);
        player.decks.push({ id: uid(), name: dname, power });
        savePlayers();
        renderPlayersTable();
        renderPodSlots();
      });
      deckActions.appendChild(restoreSelect);
      deckActions.appendChild(restoreDeckBtn);
    }

    block.appendChild(deckActions);
    container.appendChild(block);
  }

  const missingPlayers = getMissingPlayers();
  if (missingPlayers.length > 0) {
    const restoreBox = document.createElement("div");
    restoreBox.className = "row";

    const label = document.createElement("span");
    label.className = "hint";
    label.textContent = "Restore removed player:";

    const restoreSelect = document.createElement("select");
    for (const dp of missingPlayers) {
      const opt = document.createElement("option");
      opt.value = dp.name;
      opt.textContent = dp.name;
      restoreSelect.appendChild(opt);
    }

    const restorePlayerBtn = document.createElement("button");
    restorePlayerBtn.textContent = "Restore Player";
    restorePlayerBtn.addEventListener("click", () => {
      const def = getDefaultPlayer(restoreSelect.value);
      players.push({
        id: uid(),
        name: def.name,
        decks: def.decks.map(([name, power]) => ({ id: uid(), name, power })),
      });
      savePlayers();
      renderPlayersTable();
      renderPodSlots();
    });

    restoreBox.appendChild(label);
    restoreBox.appendChild(restoreSelect);
    restoreBox.appendChild(restorePlayerBtn);
    container.appendChild(restoreBox);
  }
}

document.getElementById("add-player-btn").addEventListener("click", () => {
  players.push({ id: uid(), name: "New Player", decks: [] });
  savePlayers();
  renderPlayersTable();
  renderPodSlots();
});

document.getElementById("import-btn").addEventListener("click", () => {
  const text = document.getElementById("csv-input").value;
  const rows = parseCSV(text);
  const msg = document.getElementById("import-msg");
  if (rows.length === 0) {
    msg.textContent = "No valid rows found. Expected: PlayerName,DeckName,Power";
    return;
  }
  const { addedPlayers, addedDecks } = importRows(rows);
  msg.textContent = `Imported ${addedDecks} deck(s) across ${addedPlayers} new player(s) (existing decks updated in place).`;
  document.getElementById("csv-input").value = "";
  renderPlayersTable();
  renderPodSlots();
});

document.getElementById("csv-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = document.getElementById("import-msg");
  const isXlsx = /\.xlsx$/i.test(file.name);
  const reader = new FileReader();

  reader.onload = () => {
    let rows;
    try {
      rows = isXlsx
        ? extractRowsFromWorkbook(XLSX.read(reader.result, { type: "array" }))
        : parseCSV(String(reader.result));
    } catch (err) {
      msg.textContent = `Could not read file: ${err.message}`;
      return;
    }
    if (rows.length === 0) {
      msg.textContent = isXlsx
        ? 'No decks found under "Current Deck Strength".'
        : "No valid rows found in file. Expected: PlayerName,DeckName,Power";
      return;
    }
    const { addedPlayers, addedDecks } = importRows(rows);
    msg.textContent = `Imported ${addedDecks} deck(s) across ${addedPlayers} new player(s) from file.`;
    renderPlayersTable();
    renderPodSlots();
  };

  if (isXlsx) reader.readAsArrayBuffer(file);
  else reader.readAsText(file);
  e.target.value = "";
});

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
    document.getElementById("results-section").hidden = true;
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
    for (const p of players) {
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
      const player = players.find(p => p.id === slot.playerId);
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = player ? "Select deck…" : "—";
      deckSelect.appendChild(blank);
      deckSelect.disabled = !player;
      if (player) {
        for (const d of player.decks) {
          const opt = document.createElement("option");
          opt.value = d.id;
          opt.textContent = `${d.name} (${d.power.toFixed(1)})`;
          if (d.id === slot.deckId) opt.selected = true;
          deckSelect.appendChild(opt);
        }
      }
      updatePowerDisplay();
    }

    function updatePowerDisplay() {
      const player = players.find(p => p.id === slot.playerId);
      const deck = player ? player.decks.find(d => d.id === slot.deckId) : null;
      powerSpan.textContent = deck ? deck.power.toFixed(1) : "";
    }

    playerSelect.addEventListener("change", () => {
      slot.playerId = playerSelect.value;
      slot.deckId = "";
      refreshDeckOptions();
      document.getElementById("results-section").hidden = true;
    });

    deckSelect.addEventListener("change", () => {
      slot.deckId = deckSelect.value;
      updatePowerDisplay();
      document.getElementById("results-section").hidden = true;
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
  const player = players.find(p => p.id === entry.playerId);
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
    const player = players.find(p => p.id === s.playerId);
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
    ? `All decks are within range (spread: ${spread.toFixed(1)}, ${min.toFixed(1)}–${max.toFixed(1)}).`
    : `Spread is ${spread.toFixed(1)} — outside the ±${RANGE_TOLERANCE} target. Some decks need to change.`;
  resultsDiv.appendChild(banner);

  const evaluated = evaluatePod(entries);

  for (const entry of evaluated) {
    const row = document.createElement("div");
    row.className = "result-row " + (entry.compatible ? "ok" : "out");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${entry.playerName} — ${entry.deckName}`;

    const power = document.createElement("span");
    power.className = "power";
    power.textContent = entry.power.toFixed(1) + (entry.compatible ? " ✓" : " ⚠");

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
        label.textContent = `Decks that would bring ${entry.playerName} into range:`;
        box.appendChild(label);
        for (const alt of alts) {
          const chip = document.createElement("span");
          chip.className = "suggestion-chip";
          chip.textContent = `${alt.name} (${alt.power.toFixed(1)})`;
          box.appendChild(chip);
        }
      }
      resultsDiv.appendChild(box);
    }
  }

  if (allInRange) {
    const goBtn = document.createElement("button");
    goBtn.className = "primary to-game-btn";
    goBtn.textContent = "To the Game!";
    goBtn.addEventListener("click", () => {
      window.open(PLAYGROUP_URL, "_blank", "noopener");
    });
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

const WIN_RATES_FILE = "player-win-rates.json";

function formatPct(v) {
  return v === null || v === undefined ? null : `${v.toFixed(1)}%`;
}

async function loadWinRates() {
  const statusEl = document.getElementById("winrates-sync-status");
  const noteEl = document.getElementById("winrates-note");
  const tableEl = document.getElementById("winrates-table");
  try {
    const res = await fetch(WIN_RATES_FILE, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

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

    for (const p of data.players || []) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.textContent = p.player;

      const pgTd = document.createElement("td");
      pgTd.className = "num";
      const pgPct = formatPct(p.playgroup_win_rate);
      if (pgPct) {
        pgTd.textContent = `${pgPct} (${p.playgroup_record})`;
      } else {
        pgTd.className += " muted";
        pgTd.innerHTML = `<span class="na">${p.playgroup_note || "no data"}</span>`;
      }

      const adjTd = document.createElement("td");
      adjTd.className = "num";
      const adjPct = formatPct(p.player_adjusted_win_rate);
      if (adjPct) {
        adjTd.textContent = `${adjPct} (${p.player_adjusted_record})`;
      } else {
        adjTd.className += " muted";
        adjTd.innerHTML = `<span class="na">${p.player_adjusted_note || "no data"}</span>`;
      }

      tr.appendChild(nameTd);
      tr.appendChild(pgTd);
      tr.appendChild(adjTd);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    tableEl.innerHTML = "";
    tableEl.appendChild(table);

    statusEl.textContent = `Loaded from ${WIN_RATES_FILE} (generated ${data.generated_at || "unknown date"}).`;
    noteEl.innerHTML = "";
    for (const note of [data.league_note, data.source_note]) {
      if (!note) continue;
      const p = document.createElement("span");
      p.className = "note-line";
      p.textContent = note;
      noteEl.appendChild(p);
    }
  } catch (err) {
    statusEl.textContent = `Couldn't load ${WIN_RATES_FILE} (${err.message}).`;
  }
}

// ---------- init ----------

initPlayerCountSelect();
renderPlayersTable();
renderPodSlots();
syncFromRepoWorkbook();
initTabs();
loadWinRates();

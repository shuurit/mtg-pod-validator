// Build a Deck: turns GET /deck-builder/candidates (EDHREC's cards for one
// commander at one bracket, the bracket's average-deck shape, and which of
// them the player owns) into a 99. Pure functions -- nothing here fetches or
// touches the page -- loaded before app.js like deck-tally.js, so
// tests/deck-builder.test.js can run it under plain Node.
//
// How a build works:
//   1. Every candidate gets an ownership status: "free" (a copy no
//      Archidekt deck is using), "deck" (owned, but every copy is in a deck),
//      or "missing".
//   2. Every candidate gets a score: EDHREC synergy and inclusion for this
//      bracket, plus a bonus for owning it (bigger when the copy is free), a
//      small bonus for being in the bracket's average deck, and a penalty by
//      price when it would have to be bought.
//   3. Nonbasic lands, then nonland cards by type, are taken best-score
//      first, aiming at the average deck's type counts. Then any open
//      nonland slots go to the best cards left of any type.
//   4. Basic lands fill out the land count, split the way the average deck
//      splits them.
// A card is skipped when it would break the bracket (Game Changers over the
// cap, mass land denial where it's banned, extra turns past the bracket's
// count) or push spending past the budget. Only if the deck still isn't full
// does it take over-budget cards, and it says so (overBudget).

const DECK_BUILDER_DECK_SIZE = 99;

// Wizards' Commander Brackets.
//   gameChangers   the most Game Changers a deck may run.
//   massLandDenial whether any mass land denial is allowed.
//   extraTurns     the most extra-turn cards. Bracket 1 bans extra turns;
//                  2 and 3 ban *chaining* them, which a deck can't do with
//                  only one, so they get 1.
//   twoCardCombos  "banned" (any two-card combo fails), "early" (only
//                  early-game infinite ones are banned -- the player judges
//                  "early", so found combos are a warning), or "allowed".
// The card flags (gameChanger, massLandDenial, extraTurn) come from the
// relay; two-card combos are found after the build by Commander Spellbook,
// through the relay's POST /deck-builder/combos.
const BRACKET_RULES = {
  1: { name: "Exhibition", gameChangers: 0, massLandDenial: false, extraTurns: 0, twoCardCombos: "banned" },
  2: { name: "Core", gameChangers: 0, massLandDenial: false, extraTurns: 1, twoCardCombos: "banned" },
  3: { name: "Upgraded", gameChangers: 3, massLandDenial: false, extraTurns: 1, twoCardCombos: "early" },
  4: { name: "Optimized", gameChangers: Infinity, massLandDenial: true, extraTurns: Infinity, twoCardCombos: "allowed" },
  5: { name: "cEDH", gameChangers: Infinity, massLandDenial: true, extraTurns: Infinity, twoCardCombos: "allowed" },
};

// Whether the relay's candidates carry the mass land denial / extra turn
// flags. It sends tagsChecked: true only when both Scryfall Tagger lists
// loaded; otherwise those two rules can't be enforced or checked.
function tagsChecked(data) {
  return !!(data && data.tagsChecked === true);
}

// Starting weights. synergy runs about -100..+100 and inclusion 0..100.
const DEFAULT_WEIGHTS = {
  synergy: 0.55,
  inclusion: 0.45,
  ownedFree: 40,
  ownedInDeck: 15,
  averageDeck: 10,
  pricePerDollar: 0.8,
};

// How much better (in score points, ownership aside) a card you'd buy has
// to be than the owned card it replaces before the budget is spent on it.
const UPGRADE_MARGIN = 10;

const NONLAND_TYPES =["creature", "instant", "sorcery", "artifact", "enchantment", "planeswalker", "battle"];
const COLOR_BASICS = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };

// collection: the relay's `collection` ({ connected, cards: { oracleId:
// { qty, decks } } }). Basics count as always owned. A card that's owned
// but has every copy in a deck is "deck" -- unless excludeDeckCards is on,
// when it's treated as one to get (its deck names still travel with it).
function cardStatus(card, collection, opts = {}) {
  if (card.basic) return "free";
  const owned = collection && collection.cards ? collection.cards[card.oracleId] : null;
  if (!owned || !(owned.qty > 0)) return "missing";
  const inDecks = (owned.decks || []).length;
  if (owned.qty > inDecks) return "free";
  return opts.excludeDeckCards ? "missing" : "deck";
}

function scoreCard(card, status, weights = DEFAULT_WEIGHTS) {
  let score = weights.synergy * (card.synergy ?? 0) + weights.inclusion * (card.inclusion ?? 0);
  if (status === "free") score += weights.ownedFree;
  else if (status === "deck") score += weights.ownedInDeck;
  else if (card.price != null) score -= weights.pricePerDollar * card.price;
  if (card.inAverageDeck) score += weights.averageDeck;
  return Math.round(score * 10) / 10;
}

// Land and nonland targets from the average deck's type counts, scaled so
// they add up to 99. Falls back to a plain 36-land shape when EDHREC sent
// no counts.
function deckTemplate(template) {
  const t = template || {};
  const nonland = {};
  let nonlandTotal = 0;
  for (const type of NONLAND_TYPES) {
    nonland[type] = Math.max(0, Number(t[type]) || 0);
    nonlandTotal += nonland[type];
  }
  let lands = Math.max(0, Number(t.land) || 0);
  if (!lands || !nonlandTotal) return { lands: 36, nonbasic: 0, nonland: null, nonlandSlots: DECK_BUILDER_DECK_SIZE - 36 };
  lands = Math.min(42, Math.max(30, lands));
  const nonlandSlots = DECK_BUILDER_DECK_SIZE - lands;
  // Scale to the open slots; any rounding gap is taken by the flex pass.
  const scale = nonlandSlots / nonlandTotal;
  for (const type of NONLAND_TYPES) nonland[type] = Math.floor(nonland[type] * scale);
  const nonbasic = Math.min(lands, Math.max(0, Number(t.nonbasic) || 0));
  return { lands, nonbasic, nonland, nonlandSlots };
}

// Basic land counts for `count` slots, split like the average deck's
// basics; without those, evenly across the commander's colors (Wastes for a
// colorless commander).
function splitBasics(count, averageBasics, colorIdentity) {
  if (count <= 0) return [];
  let weights = Object.entries(averageBasics || {}).filter(([, n]) => n > 0);
  if (!weights.length) {
    const names = [...new Set(String(colorIdentity || "").toUpperCase().split("").map(c => COLOR_BASICS[c]).filter(Boolean))];
    weights = (names.length ? names : ["Wastes"]).map(name => [name, 1]);
  }
  const total = weights.reduce((s, [, n]) => s + n, 0);
  const out = weights.map(([name, n]) => ({ name, count: Math.floor((count * n) / total), share: (count * n) / total }));
  let left = count - out.reduce((s, b) => s + b.count, 0);
  // Hand out the remainder by largest fractional share, ties by name.
  const order = [...out].sort((a, b) => (b.share - b.count) - (a.share - a.count) || a.name.localeCompare(b.name));
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) order[i].count++;
  return out.filter(b => b.count > 0).map(({ name, count: n }) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// data: the relay's /deck-builder/candidates response.
// opts: { budget (dollars for cards to get, default 0), excludeDeckCards,
//         weights }
function buildDeck(data, opts = {}) {
  const bracket = Number(data.bracket);
  const rules = BRACKET_RULES[bracket] || BRACKET_RULES[3];
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const budget = Math.max(0, Number(opts.budget) || 0);
  const shape = deckTemplate(data.template);
  const commanderOracle = data.commander && data.commander.oracleId;

  // One entry per card (EDHREC can list two printings of one card).
  const seen = new Set();
  const pool = [];
  for (const card of data.candidates || []) {
    if (!card.oracleId || seen.has(card.oracleId) || card.oracleId === commanderOracle) continue;
    seen.add(card.oracleId);
    const status = cardStatus(card, data.collection, opts);
    const owned = data.collection && data.collection.cards ? data.collection.cards[card.oracleId] : null;
    pool.push({ ...card, status, score: scoreCard(card, status, weights), decks: owned ? owned.decks || [] : [] });
  }
  pool.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const picked = [];
  const taken = new Set();
  const typeCount = {};
  let gameChangers = 0;
  let extraTurns = 0;
  let spent = 0;
  // A card the bracket forbids outright, whatever's already in the deck.
  const forbidden = card => !!card.massLandDenial && !rules.massLandDenial;
  let overBudget = false;

  // allowOverBudget: the last-resort pass, used only if the deck is short.
  const tryTake = (card, allowOverBudget) => {
    if (taken.has(card.oracleId)) return false;
    if (card.gameChanger && gameChangers >= rules.gameChangers) return false;
    if (forbidden(card)) return false;
    if (card.extraTurn && extraTurns >= rules.extraTurns) return false;
    if (card.status === "missing") {
      // An unknown price never fits a budget; it can still come in last.
      const cost = card.price;
      const fits = cost != null && spent + cost <= budget + 1e-9;
      if (!fits && !allowOverBudget) return false;
      if (!fits) overBudget = true;
      spent += cost || 0;
    }
    taken.add(card.oracleId);
    picked.push(card);
    typeCount[card.type] = (typeCount[card.type] || 0) + 1;
    if (card.gameChanger) gameChangers++;
    if (card.extraTurn) extraTurns++;
    return true;
  };

  const nonbasicLands = pool.filter(c => c.type === "land" && !c.basic);
  const nonlands = pool.filter(c => c.type !== "land" && c.type !== "other");
  const landsPicked = () => typeCount.land || 0;
  const nonlandsPicked = () => picked.length - landsPicked();

  // Spells first, so the budget goes where nothing can stand in for a
  // missing card -- a basic can always take a land slot for free.
  for (const allowOverBudget of [false, true]) {
    // Nonland cards by type, then the best of whatever's left.
    if (shape.nonland) {
      for (const card of nonlands) {
        if (nonlandsPicked() >= shape.nonlandSlots) break;
        if ((typeCount[card.type] || 0) < (shape.nonland[card.type] || 0)) tryTake(card, allowOverBudget);
      }
    }
    for (const card of nonlands) {
      if (nonlandsPicked() >= shape.nonlandSlots) break;
      tryTake(card, allowOverBudget);
    }
    if (nonlandsPicked() >= shape.nonlandSlots) break;
  }
  // Nonbasic lands up to the average deck's count, never over budget. Then
  // owned ones past that count, since an owned nonbasic is worth more than a
  // basic -- but never past the land total.
  for (const card of nonbasicLands) {
    if (landsPicked() >= shape.nonbasic) break;
    tryTake(card, false);
  }
  for (const card of nonbasicLands) {
    if (landsPicked() >= shape.lands) break;
    if (card.status !== "missing") tryTake(card, false);
  }

  // Upgrades: the passes above take an owned card over a better one you'd
  // have to buy (that's the ownership bonus), so on their own a budget
  // would barely ever be spent. Here the budget buys the clearest
  // upgrades: best missing card first, swapped for the weakest owned card
  // of the same type, when it's better by at least UPGRADE_MARGIN on card
  // quality alone and its price still fits.
  if (budget > 0 && !overBudget) {
    const quality = card => scoreCard(card, "missing", { ...weights, pricePerDollar: 0 });
    const upgrades = pool
      .filter(c => c.status === "missing" && !taken.has(c.oracleId) && c.price != null && c.type !== "other" && !forbidden(c))
      .sort((a, b) => quality(b) - quality(a));
    for (const card of upgrades) {
      if (spent + card.price > budget + 1e-9) continue;
      let weakest = null;
      for (const p of picked) {
        if (p.type !== card.type || p.status === "missing") continue;
        if (card.gameChanger && !p.gameChanger && gameChangers >= rules.gameChangers) continue;
        if (card.extraTurn && !p.extraTurn && extraTurns >= rules.extraTurns) continue;
        if (!weakest || quality(p) < quality(weakest)) weakest = p;
      }
      if (!weakest || quality(card) - quality(weakest) < UPGRADE_MARGIN) continue;
      picked[picked.indexOf(weakest)] = { ...card, upgradeFor: weakest.name };
      taken.delete(weakest.oracleId);
      taken.add(card.oracleId);
      if (weakest.gameChanger) gameChangers--;
      if (card.gameChanger) gameChangers++;
      if (weakest.extraTurn) extraTurns--;
      if (card.extraTurn) extraTurns++;
      spent += card.price;
    }
  }

  // Basics fill the rest -- including any nonland slots EDHREC didn't have
  // enough cards for (shortBy says how many).
  const shortBy = Math.max(0, shape.nonlandSlots - nonlandsPicked());
  const basicCount = DECK_BUILDER_DECK_SIZE - picked.length;
  const basics = splitBasics(basicCount, data.averageBasics, data.commander && data.commander.colorIdentity);

  const tally = { free: 0, deck: 0, missing: 0, missingCost: 0, unknownPrices: 0 };
  for (const card of picked) {
    tally[card.status]++;
    if (card.status === "missing") {
      if (card.price == null) tally.unknownPrices++;
      else tally.missingCost += card.price;
    }
  }
  tally.free += basicCount;
  tally.missingCost = Math.round(tally.missingCost * 100) / 100;

  return {
    commander: data.commander,
    bracket,
    bracketName: rules.name,
    cards: picked,
    basics,
    tally,
    budget,
    overBudget,
    shortBy,
    tagsChecked: tagsChecked(data),
    checks: bracketChecks(picked, bracket, { tagsChecked: tagsChecked(data), commander: data.commander }),
    size: picked.length + basicCount,
  };
}

// The finished deck against its bracket. Every check has a status:
//   "pass" / "fail"  checked, and ok is true / false
//   "warn"           found something the player has to judge (Bracket 3's
//                    "early-game" combos); ok is null
//   "unchecked"      couldn't be checked (Tagger lists or Spellbook
//                    unavailable); ok is null, never shown as passing
//   "pending"        two-card combos only: Spellbook hasn't answered yet
// opts.tagsChecked: the candidates carry mass land denial / extra turn
// flags. opts.commander: { name, cmc }, so a combo using the commander gets
// a mana cost too. opts.combos: the relay's POST /deck-builder/combos answer --
// { checked: true, combos: [{ cards: [names], ... }] } or
// { checked: false, reason }; leave it out while the call is in flight.
function bracketChecks(cards, bracket, opts = {}) {
  const rules = BRACKET_RULES[bracket] || BRACKET_RULES[3];
  const names = list => list.map(c => c.name);
  const verdict = ok => ({ status: ok ? "pass" : "fail", ok });

  const gc = cards.filter(c => c.gameChanger);
  const checks = {
    gameChangers: { count: gc.length, cap: rules.gameChangers, ...verdict(gc.length <= rules.gameChangers), cards: names(gc) },
  };

  if (opts.tagsChecked) {
    const mld = cards.filter(c => c.massLandDenial);
    const turns = cards.filter(c => c.extraTurn);
    checks.massLandDenial = { count: mld.length, allowed: rules.massLandDenial, ...verdict(rules.massLandDenial || mld.length === 0), cards: names(mld) };
    checks.extraTurns = { count: turns.length, cap: rules.extraTurns, ...verdict(turns.length <= rules.extraTurns), cards: names(turns) };
  } else {
    checks.massLandDenial = { status: "unchecked", ok: null, cards: [] };
    checks.extraTurns = { status: "unchecked", ok: null, cards: [] };
  }

  checks.twoCardCombos = combosCheck(opts.combos, rules.twoCardCombos);
  checks.twoCardCombos.combos = checks.twoCardCombos.combos.map(c => ({
    ...c,
    manaCost: comboManaCost(c.cards, cards, opts.commander),
  }));
  return checks;
}

// What a combo's cards cost to cast, added up -- the number that says how
// early it can come together. Names are matched against the deck (and the
// commander) case-insensitively; if any piece's mana value is unknown the
// total is null, never a guess.
function comboManaCost(names, cards, commander) {
  const byName = new Map();
  for (const c of cards || []) if (c && c.name) byName.set(c.name.toLowerCase(), c.cmc);
  if (commander && commander.name) byName.set(commander.name.toLowerCase(), commander.cmc);
  let total = 0;
  for (const name of names || []) {
    const cmc = byName.get(String(name).toLowerCase());
    if (cmc == null || !Number.isFinite(Number(cmc))) return null;
    total += Number(cmc);
  }
  return total;
}

function combosCheck(answer, rule) {
  if (answer === undefined) return { status: "pending", ok: null, rule, combos: [] };
  if (!answer || answer.checked !== true || !Array.isArray(answer.combos)) {
    return { status: "unchecked", ok: null, rule, combos: [], reason: answer && answer.reason };
  }
  const combos = answer.combos.filter(c => c && Array.isArray(c.cards) && c.cards.length === 2);
  const base = { rule, combos, count: combos.length };
  if (!combos.length || rule === "allowed") return { ...base, status: "pass", ok: true };
  if (rule === "early") return { ...base, status: "warn", ok: null };
  return { ...base, status: "fail", ok: false };
}

// The finished 99 plus the commander, as the relay's POST
// /deck-builder/combos takes it: names only, basics left out (no combo
// needs them, and it keeps the request small).
function comboRequest(build) {
  return {
    commander: build.commander && build.commander.name ? build.commander.name : null,
    cards: build.cards.map(c => c.name),
  };
}

// Plain "1 Card Name" lines, commander first: the format Archidekt's (and
// most deck sites') text import reads.
function deckToText(build) {
  const lines = [];
  if (build.commander && build.commander.name) lines.push(`1 ${build.commander.name}`);
  const byType = [...build.cards].sort((a, b) => typeOrder(a.type) - typeOrder(b.type) || a.name.localeCompare(b.name));
  for (const card of byType) lines.push(`1 ${card.name}`);
  for (const b of build.basics) lines.push(`${b.count} ${b.name}`);
  return lines.join("\n");
}

const TYPE_ORDER = ["creature", "planeswalker", "battle", "instant", "sorcery", "artifact", "enchantment", "land", "other"];
function typeOrder(type) {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
}

if (typeof module !== "undefined") {
  module.exports = {
    BRACKET_RULES, DEFAULT_WEIGHTS, cardStatus, scoreCard, deckTemplate, splitBasics,
    buildDeck, bracketChecks, combosCheck, comboManaCost, comboRequest, tagsChecked, deckToText, typeOrder,
  };
}

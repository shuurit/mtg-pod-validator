// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRACKET_RULES, ROLE_MINIMUMS, roleCounts, cardStatus, scoreCard, deckTemplate, splitBasics, buildDeck, deckToText,
  bracketChecks, comboRequest, comboManaCost, swapOptions, applySwap,
  deckSize, combinedIdentity, pairingOf, secondCommanderKind, canPair, pairOrder,
  humanizeThemeSlug, themeName, themeOptions, parseDeckRequest, requestedMinimum,
  pickBlockReason, mergeCollectionPicks,
} = require("../deck-builder.js");

let n = 0;
const oid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const card = (name, extra = {}) => ({
  name, oracleId: oid(), uid: oid(), type: "creature", synergy: 10, inclusion: 30,
  price: 1, gameChanger: false, basic: false, inAverageDeck: false, ...extra,
});

// A pool big enough to fill a deck: `each` cards of every nonland type, plus
// nonbasic lands, scored by descending synergy so the order is predictable.
function pool({ each = 20, lands = 30 } = {}) {
  const out = [];
  for (const type of ["creature", "instant", "sorcery", "artifact", "enchantment", "planeswalker"]) {
    for (let i = 0; i < each; i++) out.push(card(`${type} ${i}`, { type, synergy: 50 - i }));
  }
  for (let i = 0; i < lands; i++) out.push(card(`land ${i}`, { type: "land", synergy: 20 - i }));
  return out;
}

const TEMPLATE = { creature: 24, instant: 9, sorcery: 9, artifact: 9, enchantment: 7, planeswalker: 6, battle: 0, land: 35, basic: 11, nonbasic: 24 };
const owning = (cards, extra = {}) => ({ connected: true, cards: Object.fromEntries(cards.map(c => [c.oracleId, { qty: 1, decks: [], ...extra }])) });
const data = (candidates, collection = { connected: false }, bracket = 3, more = {}) => ({
  bracket, template: TEMPLATE, averageBasics: { Forest: 3, Island: 3, Plains: 3, Swamp: 2 },
  commander: { name: "Atraxa, Praetors' Voice", oracleId: "cmdr", colorIdentity: "WUBG" },
  candidates, collection, ...more,
});

test("ownership: a spare copy is free, every copy in a deck is 'deck', none is missing", () => {
  const c = card("Sol Ring");
  assert.equal(cardStatus(c, { cards: {} }), "missing");
  assert.equal(cardStatus(c, { cards: { [c.oracleId]: { qty: 2, decks: ["A"] } } }), "free");
  assert.equal(cardStatus(c, { cards: { [c.oracleId]: { qty: 1, decks: ["A"] } } }), "deck");
  assert.equal(cardStatus(c, { cards: { [c.oracleId]: { qty: 1, decks: ["A"] } } }, { excludeDeckCards: true }), "missing");
  assert.equal(cardStatus(card("Forest", { basic: true }), null), "free");
});

test("scoring prefers owned cards, free copies most, and docks price only when missing", () => {
  const c = card("X", { synergy: 20, inclusion: 40, price: 10 });
  assert.ok(scoreCard(c, "free") > scoreCard(c, "deck"));
  assert.ok(scoreCard(c, "deck") > scoreCard(c, "missing"));
  assert.equal(scoreCard(c, "missing"), scoreCard({ ...c, price: 0 }, "missing") - 8);
  assert.equal(scoreCard(c, "free"), scoreCard({ ...c, price: 999 }, "free"));
});

test("the template keeps the land count and scales nonland types to the open slots", () => {
  const t = deckTemplate(TEMPLATE);
  assert.equal(t.lands, 35);
  assert.equal(t.nonlandSlots, 64);
  assert.equal(t.nonland.creature, 24);
  assert.equal(deckTemplate({}).lands, 36);
  assert.equal(deckTemplate({ ...TEMPLATE, land: 20 }).lands, 30);
});

test("basics split like the average deck and always add up", () => {
  assert.deepEqual(splitBasics(11, { Forest: 3, Island: 3, Plains: 3, Swamp: 2 }), [
    { name: "Forest", count: 3 }, { name: "Island", count: 3 }, { name: "Plains", count: 3 }, { name: "Swamp", count: 2 },
  ]);
  assert.equal(splitBasics(20, { Forest: 3, Island: 3, Plains: 3, Swamp: 2 }).reduce((s, b) => s + b.count, 0), 20);
  assert.deepEqual(splitBasics(4, {}, "UR"), [{ name: "Island", count: 2 }, { name: "Mountain", count: 2 }]);
  assert.deepEqual(splitBasics(3, {}, ""), [{ name: "Wastes", count: 3 }]);
  assert.deepEqual(splitBasics(0, {}, "G"), []);
});

test("a full build is exactly 99 cards, all singletons", () => {
  const cands = pool({ each: 30 });
  const b = buildDeck(data(cands, owning(cands)));
  assert.equal(b.size, 99);
  assert.equal(new Set(b.cards.map(c => c.oracleId)).size, b.cards.length);
  assert.equal(b.cards.filter(c => c.type !== "land").length, 64);
  assert.equal(b.cards.filter(c => c.type === "creature").length, 24);
  assert.equal(b.tally.missing, 0);
});

test("with a $0 budget it uses owned cards and buys nothing while it can fill", () => {
  const cands = pool({ each: 30 });
  // Own only the weaker half of every type; the stronger half is missing.
  const owned = cands.filter((c, i) => c.type === "land" || i % 30 >= 15);
  const b = buildDeck(data(cands, owning(owned)), { budget: 0 });
  assert.equal(b.size, 99);
  assert.equal(b.tally.missing, 0);
  assert.equal(b.overBudget, false);
});

test("a budget lets in the best missing cards up to the limit", () => {
  const cands = pool({ each: 30 });
  const owned = cands.filter((c, i) => c.type === "land" || i % 30 >= 15);
  const b = buildDeck(data(cands, owning(owned)), { budget: 5 });
  assert.equal(b.tally.missing, 5);
  assert.ok(b.tally.missingCost <= 5);
  assert.equal(b.overBudget, false);
});

test("when owned cards can't fill it, it buys anyway and says it's over budget", () => {
  const cands = pool();
  const b = buildDeck(data(cands, { connected: false }), { budget: 0 });
  assert.equal(b.size, 99);
  assert.equal(b.overBudget, true);
  assert.equal(b.tally.missing, 64);
  // ...but never buys nonbasic lands for it: basics fill those slots.
  assert.equal(b.cards.filter(c => c.type === "land").length, 0);
});

test("Game Changers are capped at the bracket's limit", () => {
  const gcs = Array.from({ length: 6 }, (_, i) => card(`GC ${i}`, { type: "instant", synergy: 90, gameChanger: true }));
  const cands = [...gcs, ...pool()];
  const all = owning(cands);
  for (const [bracket, cap] of [[1, 0], [2, 0], [3, 3], [4, 6], [5, 6]]) {
    const b = buildDeck(data(cands, all, bracket));
    assert.equal(b.checks.gameChangers.count, cap, `bracket ${bracket}`);
    assert.equal(b.checks.gameChangers.ok, true);
    assert.equal(b.size, 99);
  }
  assert.equal(BRACKET_RULES[3].gameChangers, 3);
});

test("without the Tagger flags, land denial and extra turns are unchecked, never passing", () => {
  const b = buildDeck(data(pool(), { connected: false }));
  assert.equal(b.tagsChecked, false);
  for (const key of ["massLandDenial", "extraTurns"]) {
    assert.equal(b.checks[key].ok, null, key);
    assert.equal(b.checks[key].status, "unchecked", key);
  }
  // ...and combos are "pending" until Spellbook answers.
  assert.equal(b.checks.twoCardCombos.status, "pending");
  assert.equal(b.checks.twoCardCombos.ok, null);
});

// ---- Mass land denial and extra turns ----
const BRACKETS = [1, 2, 3, 4, 5];
const flagged = (cards) => data(cards, owning(cards), 3, { tagsChecked: true });
const withBracket = (d, bracket) => ({ ...d, bracket });

test("mass land denial is left out in brackets 1-3 and allowed in 4-5", () => {
  const mld = Array.from({ length: 3 }, (_, i) => card(`Armageddon ${i}`, { type: "sorcery", synergy: 95, massLandDenial: true }));
  const cands = [...mld, ...pool()];
  const d = flagged(cands);
  for (const bracket of BRACKETS) {
    const b = buildDeck(withBracket(d, bracket));
    const inDeck = b.cards.filter(c => c.massLandDenial).length;
    const check = b.checks.massLandDenial;
    assert.equal(b.size, 99, `bracket ${bracket}`);
    assert.equal(check.ok, true, `bracket ${bracket}`);
    assert.equal(check.status, "pass", `bracket ${bracket}`);
    if (bracket <= 3) {
      assert.equal(inDeck, 0, `bracket ${bracket} skips it`);
      assert.equal(check.allowed, false);
    } else {
      assert.equal(inDeck, 3, `bracket ${bracket} keeps it`);
      assert.equal(check.allowed, true);
      assert.equal(check.count, 3);
    }
  }
});

test("extra turns: none in bracket 1, one (no chaining) in 2-3, any number in 4-5", () => {
  const turns = Array.from({ length: 4 }, (_, i) => card(`Time Warp ${i}`, { type: "sorcery", synergy: 95, extraTurn: true }));
  const d = flagged([...turns, ...pool()]);
  for (const [bracket, expected] of [[1, 0], [2, 1], [3, 1], [4, 4], [5, 4]]) {
    const b = buildDeck(withBracket(d, bracket));
    assert.equal(b.cards.filter(c => c.extraTurn).length, expected, `bracket ${bracket}`);
    assert.equal(b.checks.extraTurns.count, expected, `bracket ${bracket}`);
    assert.equal(b.checks.extraTurns.ok, true, `bracket ${bracket}`);
    assert.equal(b.size, 99);
  }
  assert.deepEqual([1, 2, 3].map(n => BRACKET_RULES[n].extraTurns), [0, 1, 1]);
});

test("a budget's upgrades never bring in mass land denial or a second extra turn", () => {
  const cands = pool({ each: 30 }).map(c => ({ ...c, synergy: c.synergy - 40 }));
  const bad = [
    card("Ravages of War", { type: "sorcery", synergy: 95, inclusion: 90, price: 2, massLandDenial: true }),
    card("Temporal Mastery", { type: "sorcery", synergy: 95, inclusion: 90, price: 2, extraTurn: true }),
    card("Nexus of Fate", { type: "instant", synergy: 95, inclusion: 90, price: 2, extraTurn: true }),
  ];
  for (const bracket of [1, 2, 3]) {
    const b = buildDeck(withBracket(data([...bad, ...cands], owning(cands), bracket, { tagsChecked: true }), bracket), { budget: 100 });
    assert.equal(b.checks.massLandDenial.count, 0, `bracket ${bracket}`);
    assert.equal(b.checks.extraTurns.count, BRACKET_RULES[bracket].extraTurns, `bracket ${bracket}`);
    assert.ok(b.checks.extraTurns.ok);
  }
});

test("the checks fail and name the cards when a list breaks the bracket", () => {
  const list = [
    card("Armageddon", { massLandDenial: true }),
    card("Time Warp", { extraTurn: true }),
    card("Temporal Manipulation", { extraTurn: true }),
    card("Llanowar Elves"),
  ];
  for (const bracket of [1, 2, 3]) {
    const c = bracketChecks(list, bracket, { tagsChecked: true });
    assert.equal(c.massLandDenial.ok, false, `bracket ${bracket}`);
    assert.equal(c.massLandDenial.status, "fail");
    assert.deepEqual(c.massLandDenial.cards, ["Armageddon"]);
    assert.equal(c.extraTurns.ok, false, `bracket ${bracket}`);
    assert.deepEqual(c.extraTurns.cards, ["Time Warp", "Temporal Manipulation"]);
  }
  // One extra turn is fine in 2-3 (nothing to chain), not in 1.
  const one = [card("Time Warp", { extraTurn: true })];
  assert.equal(bracketChecks(one, 1, { tagsChecked: true }).extraTurns.ok, false);
  assert.equal(bracketChecks(one, 2, { tagsChecked: true }).extraTurns.ok, true);
  assert.equal(bracketChecks(one, 3, { tagsChecked: true }).extraTurns.ok, true);
  for (const bracket of [4, 5]) {
    const c = bracketChecks(list, bracket, { tagsChecked: true });
    assert.equal(c.massLandDenial.ok, true, `bracket ${bracket}`);
    assert.equal(c.extraTurns.ok, true, `bracket ${bracket}`);
  }
});

// ---- Two-card combos (Commander Spellbook, through the relay) ----
const combo = (a, b) => ({ id: `${a}-${b}`, cards: [a, b], produces: ["Infinite mana"] });
const found = { checked: true, combos: [combo("Dramatic Reversal", "Isochron Scepter")] };

test("two-card combos fail brackets 1-2, warn in 3, pass in 4-5", () => {
  const expected = { 1: ["fail", false], 2: ["fail", false], 3: ["warn", null], 4: ["pass", true], 5: ["pass", true] };
  for (const bracket of BRACKETS) {
    const c = bracketChecks([], bracket, { combos: found }).twoCardCombos;
    assert.deepEqual([c.status, c.ok], expected[bracket], `bracket ${bracket}`);
    assert.deepEqual(c.combos.map(x => x.cards), [["Dramatic Reversal", "Isochron Scepter"]]);
  }
});

test("no combos found passes every bracket", () => {
  for (const bracket of BRACKETS) {
    const c = bracketChecks([], bracket, { combos: { checked: true, combos: [] } }).twoCardCombos;
    assert.equal(c.ok, true, `bracket ${bracket}`);
    assert.equal(c.status, "pass");
  }
});

test("if Spellbook can't be reached the combo check stays unchecked, never passing", () => {
  for (const answer of [{ checked: false, reason: "unavailable" }, null, {}, { checked: true }, { checked: "yes", combos: [] }]) {
    for (const bracket of BRACKETS) {
      const c = bracketChecks([], bracket, { combos: answer }).twoCardCombos;
      assert.equal(c.ok, null, `${JSON.stringify(answer)} bracket ${bracket}`);
      assert.equal(c.status, "unchecked");
    }
  }
  assert.equal(bracketChecks([], 1, {}).twoCardCombos.status, "pending");
});

test("only two-card combos count", () => {
  const answer = { checked: true, combos: [{ id: "x", cards: ["A", "B", "C"] }, { id: "y", cards: ["A"] }] };
  const c = bracketChecks([], 1, { combos: answer }).twoCardCombos;
  assert.equal(c.ok, true);
  assert.equal(c.count, 0);
});

test("a combo's mana cost is what its two cards cost to cast, commander included", () => {
  const deck = [card("Sanguine Bond", { cmc: 5 }), card("Exquisite Blood", { cmc: 5 }), card("Thassa's Oracle", { cmc: 2 })];
  const commander = { name: "Kenrith, the Returned King", cmc: 5 };
  assert.equal(comboManaCost(["Sanguine Bond", "Exquisite Blood"], deck, commander), 10);
  assert.equal(comboManaCost(["kenrith, the returned king", "Thassa's Oracle"], deck, commander), 7, "matches names case-insensitively");
  // A piece with no known mana value gives no total, never a guess.
  assert.equal(comboManaCost(["Sanguine Bond", "Not In Deck"], deck, commander), null);
  assert.equal(comboManaCost(["Sanguine Bond", "Kenrith, the Returned King"], deck, { name: commander.name, cmc: null }), null);
  // bracketChecks attaches it to every combo it reports.
  const answer = { checked: true, combos: [combo("Sanguine Bond", "Exquisite Blood")] };
  const c = bracketChecks(deck, 3, { combos: answer, commander }).twoCardCombos;
  assert.equal(c.status, "warn");
  assert.equal(c.combos[0].manaCost, 10);
});

test("the combo request is the commander plus every nonbasic in the 99", () => {
  const cands = pool();
  const b = buildDeck(data(cands, owning(cands)));
  const req = comboRequest(b);
  assert.equal(req.commander, "Atraxa, Praetors' Voice");
  assert.equal(req.cards.length, b.cards.length);
  assert.ok(!req.cards.some(n => /^(Forest|Island|Plains|Swamp)$/.test(n)));
});

test("a short pool still makes 99, padded with basics, and says how short", () => {
  const cands = pool({ each: 5, lands: 0 });
  const b = buildDeck(data(cands, owning(cands)));
  assert.equal(b.size, 99);
  assert.equal(b.shortBy, 64 - 30);
  assert.equal(b.basics.reduce((s, x) => s + x.count, 0), 99 - 30);
});

test("the commander and duplicate printings are left out", () => {
  const dup = card("Sol Ring");
  const cands = [{ ...card("Atraxa"), oracleId: "cmdr" }, dup, { ...dup, uid: oid() }, ...pool()];
  const b = buildDeck(data(cands, owning(cands)));
  assert.equal(b.cards.filter(c => c.oracleId === "cmdr").length, 0);
  assert.equal(b.cards.filter(c => c.name === "Sol Ring").length, 1);
});

test("the text export lists the commander first, then cards, then basics with counts", () => {
  const cands = pool();
  const text = deckToText(buildDeck(data(cands, owning(cands))));
  const lines = text.split("\n");
  assert.equal(lines[0], "1 Atraxa, Praetors' Voice");
  assert.equal(lines.reduce((s, l) => s + Number(l.split(" ")[0]), 0), 100);
  assert.match(lines[lines.length - 1], /^\d+ (Forest|Island|Plains|Swamp)$/);
});

test("a budget buys clear upgrades over owned cards, within the budget", () => {
  // Own everything weak; a few strong missing creatures cost $4 each.
  const cands = pool({ each: 30 }).map(c => ({ ...c, synergy: c.synergy - 40 }));
  const stars = Array.from({ length: 5 }, (_, i) => card(`Star ${i}`, { type: "creature", synergy: 80, inclusion: 70, price: 4 }));
  const all = [...stars, ...cands];
  const owned = owning(cands);
  const none = buildDeck(data(all, owned), { budget: 0 });
  assert.equal(none.tally.missing, 0);
  const some = buildDeck(data(all, owned), { budget: 10 });
  assert.equal(some.tally.missing, 2);
  assert.equal(some.tally.missingCost, 8);
  assert.equal(some.size, 99);
  assert.equal(some.cards.filter(c => c.type === "creature").length, none.cards.filter(c => c.type === "creature").length);
  assert.ok(some.cards.filter(c => c.upgradeFor).every(c => c.name.startsWith("Star")));
  assert.equal(buildDeck(data(all, owned), { budget: 100 }).tally.missing, 5);
});

test("upgrades never break the Game Changer cap", () => {
  const cands = pool({ each: 30 }).map(c => ({ ...c, synergy: c.synergy - 40 }));
  const gcs = Array.from({ length: 5 }, (_, i) => card(`GC ${i}`, { type: "instant", synergy: 90, inclusion: 80, price: 2, gameChanger: true }));
  const b = buildDeck(data([...gcs, ...cands], owning(cands), 3), { budget: 100 });
  assert.equal(b.checks.gameChangers.count, 3);
  assert.equal(buildDeck(data([...gcs, ...cands], owning(cands), 2), { budget: 100 }).checks.gameChangers.count, 0);
});

// ---- Role minimums (ramp, draw, removal, wipes, protection) ----
// Role cards that score BELOW the plain pool, so the type passes alone
// would never pick them: any that end up in the deck got there through the
// role pass.
function rolePool({ ramp = 15, draw = 15, removal = 12, wipe = 5, protection = 4, extra = {} } = {}) {
  const out = [];
  const add = (role, n, type) => {
    for (let i = 0; i < n; i++) out.push(card(`${role} ${i}`, { type, synergy: -60 - i, roles: [role], ...extra }));
  };
  add("ramp", ramp, "artifact");
  add("draw", draw, "enchantment");
  add("removal", removal, "instant");
  add("wipe", wipe, "sorcery");
  add("protection", protection, "instant");
  return out;
}

test("the minimums live in one constant", () => {
  assert.deepEqual(ROLE_MINIMUMS, { ramp: 10, draw: 10, removal: 8, wipe: 3, protection: 2 });
});

test("role minimums are met when the pool allows, even over better-scoring cards", () => {
  const cands = [...pool({ each: 30 }), ...rolePool()];
  for (const bracket of [1, 2, 3, 4, 5]) {
    const b = buildDeck(data(cands, owning(cands), bracket));
    assert.equal(b.size, 99, `bracket ${bracket}`);
    for (const [role, min] of Object.entries(ROLE_MINIMUMS)) {
      assert.equal(b.roles[role].count, min, `bracket ${bracket} ${role}`);
      assert.equal(b.roles[role].short, 0);
    }
    assert.deepEqual(b.roleShortfall, []);
  }
});

test("without the role pass the same pool would miss every minimum", () => {
  // Guards the test above: the role cards really do lose on score alone.
  const cands = [...pool({ each: 30 }), ...rolePool()];
  const zero = Object.fromEntries(Object.keys(ROLE_MINIMUMS).map(r => [r, 0]));
  const b = buildDeck(data(cands, owning(cands)), { roleMinimums: zero });
  for (const role of Object.keys(ROLE_MINIMUMS)) assert.equal(b.roles[role].count, 0, role);
});

test("a short pool reports the shortfall instead of dropping it", () => {
  const cands = [...pool({ each: 30 }), ...rolePool({ ramp: 6, wipe: 1, protection: 0 })];
  const b = buildDeck(data(cands, owning(cands)));
  assert.equal(b.size, 99);
  assert.deepEqual(b.roleShortfall.map(r => [r.role, r.count, r.min, r.short]), [
    ["ramp", 6, 10, 4],
    ["wipe", 1, 3, 2],
    ["protection", 0, 2, 2],
  ]);
  assert.equal(b.roles.draw.short, 0);
  assert.equal(b.roles.removal.short, 0);
  assert.equal(b.roles.ramp.leftOut, 0, "the pool ran out, nothing was left behind");
});

test("a card with several roles counts for each", () => {
  const both = card("Removal that draws", { type: "instant", synergy: -90, roles: ["removal", "draw"] });
  assert.deepEqual(roleCounts([both, card("x", { roles: ["ramp"] })]), { ramp: 1, draw: 1, removal: 1, wipe: 0, protection: 0 });
  const cands = [...pool({ each: 30 }), ...rolePool({ removal: 7 }), both];
  const b = buildDeck(data(cands, owning(cands)));
  assert.ok(b.cards.includes(b.cards.find(c => c.name === "Removal that draws")));
  assert.equal(b.roles.removal.count, 8);
});

test("role picks respect the Game Changer cap and the bracket's banned cards", () => {
  const gcWipes = rolePool({ ramp: 0, draw: 0, removal: 0, wipe: 5, protection: 0, extra: { gameChanger: true } });
  const mldWipes = Array.from({ length: 3 }, (_, i) => card(`Armageddon ${i}`, { type: "sorcery", synergy: -50, roles: ["wipe"], massLandDenial: true }));
  const cands = [...pool({ each: 30 }), ...gcWipes, ...mldWipes];
  const b2 = buildDeck(data(cands, owning(cands), 2, { tagsChecked: true }));
  assert.equal(b2.checks.gameChangers.count, 0);
  assert.equal(b2.checks.massLandDenial.count, 0);
  assert.equal(b2.roles.wipe.count, 0);
  assert.equal(b2.roles.wipe.short, 3, "reported, not forced past the bracket");
  const b3 = buildDeck(data(cands, owning(cands), 3, { tagsChecked: true }));
  assert.equal(b3.roles.wipe.count, 3, "3 Game Changers allowed in bracket 3");
  assert.equal(b3.checks.gameChangers.count, 3);
});

test("role picks stay within the budget; a role the budget can't buy is reported short", () => {
  // Owned: the plain pool. Missing: every role card, $5 each.
  const plain = pool({ each: 30 });
  const roleCards = rolePool({ extra: { price: 5 } });
  const cands = [...plain, ...roleCards];
  const broke = buildDeck(data(cands, owning(plain)), { budget: 0 });
  assert.equal(broke.overBudget, false);
  assert.equal(broke.tally.missing, 0);
  assert.equal(broke.roleShortfall.length, 5);
  assert.equal(broke.roles.ramp.leftOut, 15, "there were ramp cards, the budget couldn't buy them");
  const some = buildDeck(data(cands, owning(plain)), { budget: 20 });
  assert.equal(some.tally.missingCost, 20);
  assert.equal(some.overBudget, false);
  assert.equal(Object.values(some.roles).reduce((n, r) => n + r.count, 0), 4);
});

test("when nothing is owned the role cards still come first in the forced buys", () => {
  const cands = [...pool(), ...rolePool()];
  const b = buildDeck(data(cands, { connected: false }), { budget: 0 });
  assert.equal(b.overBudget, true);
  assert.deepEqual(b.roleShortfall, []);
});

test("budget upgrades never pull a role below its minimum", () => {
  const plain = pool({ each: 30 }).map(c => ({ ...c, synergy: c.synergy - 40 }));
  const roleCards = rolePool();
  const owned = [...plain, ...roleCards];
  // Strong missing cards of the role cards' types, with no role.
  const stars = ["artifact", "enchantment", "instant", "sorcery"].flatMap(type =>
    Array.from({ length: 6 }, (_, i) => card(`Star ${type} ${i}`, { type, synergy: 90, inclusion: 90, price: 1 })));
  const b = buildDeck(data([...stars, ...owned], owning(owned)), { budget: 100 });
  assert.ok(b.tally.missing > 0, "it did buy upgrades");
  assert.deepEqual(b.roleShortfall, []);
});

// ---- Swaps: pinned (swapped in) and excluded (swapped out) ----
const names = b => b.cards.map(c => c.name);

test("an excluded card is never picked, and its slot goes to the next best", () => {
  const cands = pool({ each: 30 });
  const all = owning(cands);
  const before = buildDeck(data(cands, all));
  const top = before.cards.find(c => c.type === "creature");
  const after = buildDeck(data(cands, all), { excluded: [top.oracleId] });
  assert.ok(!names(after).includes(top.name));
  assert.equal(after.size, 99);
  assert.equal(after.cards.filter(c => c.type === "creature").length, before.cards.filter(c => c.type === "creature").length);
});

test("a pinned card is always in the deck, marked as the player's pick", () => {
  const cands = pool({ each: 30 });
  const weak = cands.find(c => c.name === "creature 29"); // scores last of its type
  const b = buildDeck(data(cands, owning(cands)), { pinned: [weak.oracleId] });
  const kept = b.cards.find(c => c.oracleId === weak.oracleId);
  assert.ok(kept, "pinned card is in");
  assert.equal(kept.pinned, true);
  assert.equal(b.size, 99);
  assert.equal(b.cards.filter(c => c.type === "creature").length, 24, "still the template's count");
});

test("a swap survives budget and toggle changes", () => {
  const cands = pool({ each: 30 });
  const owned = cands.filter((c, i) => c.type === "land" || i % 30 >= 15);
  const out = buildDeck(data(cands, owning(owned))).cards.find(c => c.type === "instant");
  const into = cands.find(c => c.name === "instant 29");
  const swaps = applySwap({}, out.oracleId, into.oracleId);
  for (const opts of [{ budget: 0 }, { budget: 25 }, { budget: 200 }, { budget: 25, excludeDeckCards: true }]) {
    const b = buildDeck(data(cands, owning(owned)), { ...opts, ...swaps });
    assert.ok(names(b).includes("instant 29"), JSON.stringify(opts));
    assert.ok(!names(b).includes(out.name), JSON.stringify(opts));
    assert.equal(b.size, 99);
  }
});

test("budget upgrades never replace a pinned card", () => {
  const cands = pool({ each: 30 }).map(c => ({ ...c, synergy: c.synergy - 40 }));
  const stars = Array.from({ length: 5 }, (_, i) => card(`Star ${i}`, { type: "creature", synergy: 80, inclusion: 70, price: 4 }));
  const weak = cands.find(c => c.name === "creature 29");
  const b = buildDeck(data([...stars, ...cands], owning(cands)), { budget: 100, pinned: [weak.oracleId] });
  assert.ok(names(b).includes("creature 29"));
  assert.ok(b.cards.filter(c => c.upgradeFor).every(c => c.upgradeFor !== "creature 29"));
});

test("a pinned card you'd have to buy spends the budget, and going over is flagged as the player's", () => {
  const cands = pool({ each: 30 });
  const owned = cands.filter(c => !c.name.startsWith("instant 2"));
  const pricey = cands.find(c => c.name === "instant 25");
  pricey.price = 30;
  const b = buildDeck(data(cands, owning(owned)), { budget: 10, pinned: [pricey.oracleId] });
  assert.ok(names(b).includes("instant 25"));
  assert.equal(b.pinsOverBudget, true);
  assert.equal(b.overBudget, false, "the builder itself didn't overspend");
});

test("pins never break the bracket: a clash is reported, not forced", () => {
  const gcs = Array.from({ length: 2 }, (_, i) => card(`GC ${i}`, { type: "instant", synergy: -50, gameChanger: true }));
  const cands = [...gcs, ...pool()];
  const b = buildDeck(data(cands, owning(cands), 2), { pinned: gcs.map(c => c.oracleId) });
  assert.equal(b.checks.gameChangers.count, 0);
  assert.deepEqual(b.pinsDropped.map(p => [p.name, p.reason]), [["GC 0", "gameChangers"], ["GC 1", "gameChangers"]]);
});

test("applySwap: swapping out a pick unpins it, swapping a card back un-excludes it", () => {
  let s = applySwap({}, "a", "b");
  assert.deepEqual(s, { pinned: ["b"], excluded: ["a"] });
  s = applySwap(s, "b", "c");
  assert.deepEqual(s, { pinned: ["c"], excluded: ["a", "b"] });
  s = applySwap(s, "c", "a");
  assert.deepEqual(s, { pinned: ["a"], excluded: ["b", "c"] });
});

test("swap options: the 5 best unused cards of the same type", () => {
  const cands = pool({ each: 30 });
  const d = data(cands, owning(cands));
  const b = buildDeck(d);
  const target = b.cards.find(c => c.type === "sorcery");
  const opts = swapOptions(d, b, target);
  assert.equal(opts.length, 5);
  assert.ok(opts.every(o => o.type === "sorcery"));
  const inDeck = new Set(b.cards.map(c => c.oracleId));
  assert.ok(opts.every(o => !inDeck.has(o.oracleId)));
  for (let i = 1; i < opts.length; i++) assert.ok(opts[i - 1].score >= opts[i].score, "best first");
  assert.ok(opts.every(o => o.status && "price" in o), "carries ownership and price");
});

test("swap options share a role with the card when it has one", () => {
  const cands = [...pool({ each: 30 }), ...Array.from({ length: 12 }, (_, i) => card(`removal ${i}`, { type: "instant", synergy: -60 - i, roles: ["removal"] }))];
  const d = data(cands, owning(cands));
  const b = buildDeck(d);
  const target = b.cards.find(c => (c.roles || []).includes("removal"));
  const opts = swapOptions(d, b, target);
  assert.ok(opts.length > 0);
  assert.ok(opts.every(o => o.roles.includes("removal")));
});

test("swap options that would break the bracket are blocked with the reason", () => {
  const gcs = Array.from({ length: 6 }, (_, i) => card(`GC ${i}`, { type: "instant", synergy: 90, gameChanger: true }));
  const cands = [...gcs, ...pool({ each: 30 })];
  const d = data(cands, owning(cands), 3);
  const b = buildDeck(d);
  assert.equal(b.checks.gameChangers.count, 3);
  // Swapping a plain instant for a 4th Game Changer: blocked.
  const plain = b.cards.find(c => c.type === "instant" && !c.gameChanger);
  const blocked = swapOptions(d, b, plain).filter(o => o.gameChanger);
  assert.ok(blocked.length > 0);
  assert.ok(blocked.every(o => o.blocked === "Bracket 3 allows 3 Game Changers, and the deck has 3"));
  // Swapping one Game Changer for another keeps the count: allowed.
  const gc = b.cards.find(c => c.gameChanger);
  assert.ok(swapOptions(d, b, gc).filter(o => o.gameChanger).every(o => o.blocked === null));
  // Bracket 2: none at all.
  const d2 = data(cands, owning(cands), 2);
  const b2 = buildDeck(d2);
  assert.ok(swapOptions(d2, b2, b2.cards.find(c => c.type === "instant")).filter(o => o.gameChanger)
    .every(o => o.blocked === "Bracket 2 allows no Game Changers"));
});

test("swap options block mass land denial and a second extra turn in the brackets that ban them", () => {
  const mld = card("Armageddon", { type: "sorcery", synergy: 99, massLandDenial: true });
  const turns = [card("Time Warp", { type: "sorcery", synergy: 98, extraTurn: true }), card("Temporal Mastery", { type: "sorcery", synergy: 97, extraTurn: true })];
  const cands = [mld, ...turns, ...pool({ each: 30 })];
  const d = data(cands, owning(cands), 2, { tagsChecked: true });
  const b = buildDeck(d);
  assert.equal(b.checks.extraTurns.count, 1);
  const plain = b.cards.find(c => c.type === "sorcery" && !c.extraTurn);
  const byName = Object.fromEntries(swapOptions(d, b, plain).map(o => [o.name, o.blocked]));
  assert.equal(byName["Armageddon"], "Bracket 2 allows no mass land denial");
  assert.equal(byName["Temporal Mastery"], "Bracket 2 allows one extra-turn card (no chaining)");
});

test("a swap that drops a role below its minimum says so, without blocking it", () => {
  const removal = Array.from({ length: 8 }, (_, i) => card(`removal ${i}`, { type: "instant", synergy: -60 - i, roles: ["removal", "draw"] }));
  const drawOnly = card("draw only", { type: "instant", synergy: -55, roles: ["draw"] });
  const cands = [...pool({ each: 30 }), ...removal, drawOnly];
  const d = data(cands, owning(cands));
  const b = buildDeck(d, { roleMinimums: { ramp: 0, draw: 0, wipe: 0, protection: 0 } });
  assert.equal(b.roles.removal.count, 8);
  const o = swapOptions(d, b, b.cards.find(c => c.name === "removal 0")).find(x => x.name === "draw only");
  assert.ok(o, "shares the draw role, so it's offered");
  assert.equal(o.blocked, null);
  assert.equal(o.roleNote, "Removal would drop to 7 of 8");
});

// ---- Two commanders (Partner, Partner with, Partner groups, Background, Doctor) ----
const PAIRING = Object.fromEntries(require("./fixtures/pairing-cards.json").map(c => [c.name, pairingOf(c)]));
const P = name => { assert.ok(PAIRING[name], name); return PAIRING[name]; };
// Same rule as the relay's edhrecSlug, enough for these names.
const slugOf = n => n.split(" // ")[0].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/['’,.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

test("pairing abilities are read from real Scryfall cards (Nov 2026)", () => {
  assert.equal(secondCommanderKind(P("Thrasios, Triton Hero")).kind, "partner");
  assert.deepEqual(secondCommanderKind(P("Pir, Imaginative Rascal")),
    { kind: "partner-with", label: "Partner with Toothy, Imaginary Friend", suggest: "Toothy, Imaginary Friend" });
  // Scryfall tags these plain "Partner"; the oracle text says which group.
  assert.equal(P("Cecily, Haunted Mage").partnerGroup, "Friends forever");
  assert.equal(P("Cecily, Haunted Mage").partner, false);
  assert.equal(secondCommanderKind(P("Wilson, Refined Grizzly")).kind, "background");
  assert.equal(secondCommanderKind(P("Raised by Giants")).kind, "background-for");
  assert.equal(secondCommanderKind(P("The Tenth Doctor")).kind, "companion");
  assert.equal(secondCommanderKind(P("Rose Tyler")).kind, "doctor");
  assert.equal(secondCommanderKind(P("Atraxa, Praetors' Voice")), null, "no second commander for Atraxa");
});

test("which pairs are legal", () => {
  const ok = (a, b) => canPair(P(a), P(b)).ok;
  assert.ok(ok("Thrasios, Triton Hero", "Tymna the Weaver"));
  assert.ok(ok("Pir, Imaginative Rascal", "Toothy, Imaginary Friend"));
  assert.ok(ok("Cecily, Haunted Mage", "Bjorna, Nightfall Alchemist"));
  assert.ok(ok("Wilson, Refined Grizzly", "Raised by Giants"));
  assert.ok(ok("Cultist of the Absolute", "Lae'zel, Vlaakith's Champion"), "either order");
  assert.ok(ok("Rose Tyler", "The Tenth Doctor"));
  assert.equal(canPair(P("Pir, Imaginative Rascal"), P("Thrasios, Triton Hero")).reason,
    "Pir, Imaginative Rascal can only partner with Toothy, Imaginary Friend.");
  assert.match(canPair(P("Cecily, Haunted Mage"), P("Thrasios, Triton Hero")).reason, /Partner—Friends forever/);
  assert.ok(!ok("Wilson, Refined Grizzly", "Thrasios, Triton Hero"));
  assert.ok(!ok("Atraxa, Praetors' Voice", "Tymna the Weaver"));
  assert.ok(!ok("Thrasios, Triton Hero", "Thrasios, Triton Hero"));
});

test("pairOrder matches EDHREC's page names for the pairs checked live", () => {
  // Canonical page names seen on json.edhrec.com (Nov 2026); the other
  // order of each answers with a redirect.
  const cases = [
    ["Tymna the Weaver", "Thrasios, Triton Hero", "thrasios-triton-hero-tymna-the-weaver"],
    ["Tymna the Weaver", "Kraum, Ludevic's Opus", "kraum-ludevics-opus-tymna-the-weaver"],
    ["Toothy, Imaginary Friend", "Pir, Imaginative Rascal", "pir-imaginative-rascal-toothy-imaginary-friend"],
    ["Raised by Giants", "Wilson, Refined Grizzly", "wilson-refined-grizzly-raised-by-giants"],
    ["Cultist of the Absolute", "Lae'zel, Vlaakith's Champion", "laezel-vlaakiths-champion-cultist-of-the-absolute"],
    ["Rose Tyler", "The Tenth Doctor", "the-tenth-doctor-rose-tyler"],
    ["Bjorna, Nightfall Alchemist", "Cecily, Haunted Mage", "bjorna-nightfall-alchemist-cecily-haunted-mage"],
  ];
  for (const [a, b, page] of cases) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const [first, second] = pairOrder(P(x), P(y), slugOf);
      assert.equal(`${slugOf(first.name)}-${slugOf(second.name)}`, page, `${x} + ${y}`);
    }
  }
});

const pairData = (candidates, collection, more = {}) => data(candidates, collection, 3, {
  commander: { name: "Thrasios, Triton Hero", oracleId: "thrasios", colorIdentity: "GU", cmc: 2 },
  commanders: [
    { name: "Thrasios, Triton Hero", oracleId: "thrasios", colorIdentity: "GU", cmc: 2 },
    { name: "Tymna the Weaver", oracleId: "tymna", colorIdentity: "WB", cmc: 3 },
  ],
  averageBasics: {},
  ...more,
});

test("with two commanders the deck is 98 cards, and neither commander is in it", () => {
  const cands = [{ ...card("Thrasios, Triton Hero"), oracleId: "thrasios" }, { ...card("Tymna the Weaver"), oracleId: "tymna" }, ...pool({ each: 30 })];
  const d = pairData(cands, owning(cands));
  assert.equal(deckSize(d), 98);
  const b = buildDeck(d);
  assert.equal(b.size, 98);
  assert.ok(!b.cards.some(c => c.oracleId === "thrasios" || c.oracleId === "tymna"));
  assert.equal(b.cards.length + b.basics.reduce((n, x) => n + x.count, 0), 98);
  assert.deepEqual(b.commanders.map(c => c.name), ["Thrasios, Triton Hero", "Tymna the Weaver"]);
  assert.equal(b.colorIdentity, "WUBG");
});

test("the pair's combined color identity sets the basics", () => {
  assert.equal(combinedIdentity([{ colorIdentity: "GU" }, { colorIdentity: "WB" }]), "WUBG");
  const b = buildDeck(pairData(pool({ each: 5, lands: 0 }), { connected: false }));
  assert.deepEqual(b.basics.map(x => x.name).sort(), ["Forest", "Island", "Plains", "Swamp"]);
  assert.equal(b.basics.reduce((n, x) => n + x.count, 0), 98 - b.cards.length);
});

test("the text export lists both commanders first and adds up to 100", () => {
  const cands = pool();
  const lines = deckToText(buildDeck(pairData(cands, owning(cands)))).split("\n");
  assert.deepEqual(lines.slice(0, 2), ["1 Thrasios, Triton Hero", "1 Tymna the Weaver"]);
  assert.equal(lines.reduce((n, l) => n + Number(l.split(" ")[0]), 0), 100);
});

test("combos see both commanders", () => {
  const cands = pool();
  const b = buildDeck(pairData(cands, owning(cands)));
  const req = comboRequest(b);
  assert.deepEqual(req.commanders, ["Thrasios, Triton Hero", "Tymna the Weaver"]);
  assert.equal(req.commander, "Thrasios, Triton Hero");
  const deck = [card("Sanguine Bond", { cmc: 5 })];
  assert.equal(comboManaCost(["Tymna the Weaver", "Sanguine Bond"], deck, b.commanders), 8);
});

test("an older single-commander answer (no `commanders`) still builds 99", () => {
  const cands = pool();
  const b = buildDeck(data(cands, owning(cands)));
  assert.equal(b.size, 99);
  assert.deepEqual(b.commanders.map(c => c.name), ["Atraxa, Praetors' Voice"]);
  assert.equal(deckToText(b).split("\n")[0], "1 Atraxa, Praetors' Voice");
});

// ---- Themes ----
const THEMES = [
  { slug: "infect", name: "Infect", count: 331 },
  { slug: "plus-1-plus-1-counters", name: "+1/+1 Counters", count: 275 },
  { slug: "proliferate", name: "Proliferate", count: 157 },
];

test("theme names come from the relay's list, humanized only as a last resort", () => {
  assert.equal(themeName(THEMES, "plus-1-plus-1-counters"), "+1/+1 Counters");
  assert.equal(themeName(THEMES, "lands-matter"), "Lands Matter");
  assert.equal(themeName(THEMES, ""), null);
  assert.equal(humanizeThemeSlug("group-hug"), "Group Hug");
});

test("the picker offers Any first, then each theme with its deck count", () => {
  assert.deepEqual(themeOptions(THEMES, ""), [
    { value: "", label: "Any" },
    { value: "infect", label: "Infect · 331 decks" },
    { value: "plus-1-plus-1-counters", label: "+1/+1 Counters · 275 decks" },
    { value: "proliferate", label: "Proliferate · 157 decks" },
  ]);
  assert.deepEqual(themeOptions([], ""), [{ value: "", label: "Any" }]);
  // A chosen theme missing from the list stays choosable.
  assert.deepEqual(themeOptions(THEMES, "voltron").pop(), { value: "voltron", label: "Voltron" });
});

test("a themed build carries its theme; an unthemed one carries none", () => {
  const cands = pool();
  const themed = buildDeck(data(cands, owning(cands), 3, { themes: THEMES, theme: { slug: "infect", name: null, source: "all-brackets" } }));
  assert.deepEqual(themed.theme, { slug: "infect", name: "Infect", source: "all-brackets" });
  assert.equal(themed.size, 99);
  assert.equal(buildDeck(data(cands, owning(cands), 3, { themes: THEMES })).theme, null);
});

// ---- "What are you looking for?" (parseDeckRequest) ----
const REQUEST_THEMES = [
  { slug: "infect", name: "Infect", count: 331 },
  { slug: "plus-1-plus-1-counters", name: "+1/+1 Counters", count: 275 },
];

test("'more' raises a role's minimum, 'lots' raises it further, a number sets it", () => {
  assert.equal(requestedMinimum(8, "more"), 11);
  assert.equal(requestedMinimum(10, "lots"), 16);
  assert.equal(requestedMinimum(2, "more"), 4, "at least +2");
  assert.equal(requestedMinimum(8, "more", 12), 12);
  assert.equal(requestedMinimum(8, "more", 99), 30, "capped");
  const r = parseDeckRequest("focus more on removal and ramp");
  assert.deepEqual(r.roleMinimums, { removal: 11, ramp: 13 });
  assert.deepEqual(r.roleMaximums, {});
  assert.deepEqual(r.ignored, []);
  assert.deepEqual(parseDeckRequest("12 removal").roleMinimums, { removal: 12 });
  assert.deepEqual(parseDeckRequest("removal 12 and more protection").roleMinimums, { removal: 12, protection: 4 });
});

test("'less' and 'no' cap a role; each role takes the word next to it", () => {
  const r = parseDeckRequest("more removal and less draw");
  assert.deepEqual(r.roleMinimums, { removal: 11, draw: 7 });
  assert.deepEqual(r.roleMaximums, { draw: 7 });
  assert.deepEqual(parseDeckRequest("no board wipes").roleMaximums, { wipe: 0 });
  assert.deepEqual(parseDeckRequest("no board wipes").understood, ["Board wipes: none"]);
  const mixed = parseDeckRequest("lots of ramp, less card draw");
  assert.deepEqual(mixed.roleMinimums, { ramp: 16, draw: 7 });
  assert.deepEqual(mixed.roleMaximums, { draw: 7 });
});

test("ownership, price, budget and synergy phrases set weights and budget", () => {
  assert.deepEqual(parseDeckRequest("mostly cards I own").weights, { ownedFree: 80, ownedInDeck: 30 });
  assert.deepEqual(parseDeckRequest("only cards I own").weights, { ownedFree: 150, ownedInDeck: 60 });
  assert.deepEqual(parseDeckRequest("ignore my collection").weights, { ownedFree: 10, ownedInDeck: 5 });
  assert.equal(parseDeckRequest("keep it cheap").weights.pricePerDollar, 2);
  assert.equal(parseDeckRequest("under $50").budget, 50);
  assert.equal(parseDeckRequest("30 bucks").budget, 30);
  assert.equal(parseDeckRequest("$900").budget, 200, "the slider's maximum");
  assert.deepEqual(parseDeckRequest("lots of synergy").weights, { synergy: 0.8, inclusion: 0.2 });
  assert.deepEqual(parseDeckRequest("popular staples").weights, { synergy: 0.25, inclusion: 0.75 });
});

test("themes are matched by their whole name, only from the commander's list", () => {
  const r = parseDeckRequest("I want infect, mostly cards I own, under $50", REQUEST_THEMES);
  assert.equal(r.theme, "infect");
  assert.equal(r.budget, 50);
  assert.deepEqual(r.ignored, []);
  assert.equal(parseDeckRequest("+1/+1 counters with plenty of protection", REQUEST_THEMES).theme, "plus-1-plus-1-counters");
  assert.equal(parseDeckRequest("infect", []).theme, null, "no list yet: no theme");
  assert.equal(parseDeckRequest("counters", REQUEST_THEMES).theme, null, "a part of a name isn't the theme");
});

test("anything not understood is reported back, never guessed", () => {
  const r = parseDeckRequest("make it spicy, more removal");
  assert.deepEqual(r.ignored, ["make it spicy"]);
  assert.deepEqual(r.roleMinimums, { removal: 11 });
  assert.deepEqual(parseDeckRequest("").understood, []);
});

test("buildDeck honours a request's minimums, maximums and weights", () => {
  // Plenty of draw and wipe cards that score well, so without a cap the
  // builder takes many; removal cards that score badly.
  const extra = [
    ...Array.from({ length: 15 }, (_, i) => card(`draw ${i}`, { type: "enchantment", synergy: 80 - i, roles: ["draw"] })),
    ...Array.from({ length: 8 }, (_, i) => card(`wipe ${i}`, { type: "sorcery", synergy: 80 - i, roles: ["wipe"] })),
    ...Array.from({ length: 15 }, (_, i) => card(`removal ${i}`, { type: "instant", synergy: -60 - i, roles: ["removal"] })),
  ];
  const cands = [...pool({ each: 30 }), ...extra];
  const d = data(cands, owning(cands));
  const plain = buildDeck(d);
  assert.ok(plain.roles.draw.count > 7 && plain.roles.wipe.count > 0, "uncapped, the builder runs plenty");
  const req = parseDeckRequest("more removal, less draw, no board wipes");
  const b = buildDeck(d, { roleMinimums: req.roleMinimums, roleMaximums: req.roleMaximums, weights: req.weights });
  assert.equal(b.roles.removal.count, 11);
  assert.equal(b.roles.draw.count, 7);
  assert.equal(b.roles.draw.max, 7);
  assert.equal(b.roles.wipe.count, 0);
  assert.equal(b.size, 99);
  // A card the player swapped in is kept even past a cap.
  const pinnedWipe = extra.find(c => c.name === "wipe 0");
  const kept = buildDeck(d, { roleMaximums: { wipe: 0 }, pinned: [pinnedWipe.oracleId] });
  assert.ok(kept.cards.some(c => c.name === "wipe 0"));
});

// ---- Picks from the player's collection ----
const collectionPick = (name, extra = {}) => ({
  oracleId: oid(), uid: oid(), name, type: "enchantment", cmc: 3, price: 2, gameChanger: false,
  massLandDenial: false, extraTurn: false, roles: ["draw"], qty: 1, decks: [], why: "Steady draw.", replace: null, ...extra,
});

test("an added collection pick joins the pool as an owned card and goes in the deck", () => {
  const cands = pool({ each: 30 });
  const d = data(cands, owning(cands));
  const arena = collectionPick("Phyrexian Arena");
  const merged = mergeCollectionPicks(d, [arena]);
  assert.equal(merged.candidates.length, cands.length + 1);
  assert.equal(d.candidates.length, cands.length, "the relay's answer isn't changed");
  assert.deepEqual(merged.collection.cards[arena.oracleId], { qty: 1, decks: [] });
  const target = buildDeck(merged).cards.find(c => c.type === "enchantment" && c.oracleId !== arena.oracleId);
  const b = buildDeck(merged, { pinned: [arena.oracleId], excluded: [target.oracleId] });
  const inDeck = b.cards.find(c => c.oracleId === arena.oracleId);
  assert.ok(inDeck, "in the deck");
  assert.equal(inDeck.status, "free", "owned, spare copy");
  assert.equal(inDeck.pinned, true);
  assert.ok(!b.cards.some(c => c.oracleId === target.oracleId), "the card it replaced is out");
  assert.equal(b.size, 99);
  // A pick already among EDHREC's candidates isn't added twice.
  assert.equal(mergeCollectionPicks(d, [{ ...arena, oracleId: cands[0].oracleId }]).candidates.length, cands.length);
});

test("a collection pick the bracket won't take says why", () => {
  const cands = pool({ each: 30 });
  const b2 = buildDeck(data(cands, owning(cands), 2, { tagsChecked: true }));
  assert.equal(pickBlockReason(b2, collectionPick("Smothering Tithe", { gameChanger: true }), null), "Bracket 2 allows no Game Changers");
  assert.equal(pickBlockReason(b2, collectionPick("Armageddon", { massLandDenial: true }), null), "Bracket 2 allows no mass land denial");
  assert.equal(pickBlockReason(b2, collectionPick("Divination"), null), null);
  const b1 = buildDeck(data(cands, owning(cands), 1, { tagsChecked: true }));
  assert.equal(pickBlockReason(b1, collectionPick("Time Warp", { extraTurn: true }), null), "Bracket 1 allows no extra turns");
  // Replacing a Game Changer with another keeps the count: allowed.
  const gcs = Array.from({ length: 3 }, (_, i) => card(`GC ${i}`, { type: "instant", synergy: 90, gameChanger: true }));
  const b3 = buildDeck(data([...gcs, ...cands], owning([...gcs, ...cands]), 3));
  const gcInDeck = b3.cards.find(c => c.gameChanger);
  assert.match(pickBlockReason(b3, collectionPick("Rhystic Study", { gameChanger: true }), null), /allows 3 Game Changers, and the deck has 3/);
  assert.equal(pickBlockReason(b3, collectionPick("Rhystic Study", { gameChanger: true }), gcInDeck), null);
});

test("applySwap with nothing to replace just adds the pick", () => {
  assert.deepEqual(applySwap({ pinned: ["a"], excluded: ["b"] }, null, "c"), { pinned: ["a", "c"], excluded: ["b"] });
});

// ---- The AI's reading of a request ----
{
  const db = require("../deck-builder.js");
  const THEMES = [{ slug: "infect", name: "Infect" }];

  test("an AI reading becomes the same settings the rules make", () => {
    const r = db.readingToRequest({
      roles: [{ role: "draw", change: "more" }, { role: "wipe", change: "none" }, { role: "ramp", change: "exactly", count: 12 }, { role: "nope", change: "more" }],
      budget: 500, ownership: "prefer", price: "cheaper", style: "staples", theme: "infect",
      searchTags: ["Discard", "hand disruption", "bad tag!"], notes: ["Cards that make opponents discard"],
    }, THEMES);
    assert.deepEqual(r.roleMinimums, { draw: 13, wipe: 0, ramp: 12 });
    assert.deepEqual(r.roleMaximums, { wipe: 0 });
    assert.equal(r.budget, 200, "capped at the slider's top");
    assert.deepEqual(r.weights, { ownedFree: 80, ownedInDeck: 30, pricePerDollar: 2.0, synergy: 0.25, inclusion: 0.75 });
    assert.equal(r.theme, "infect");
    assert.deepEqual(r.searchTags, ["discard", "hand disruption"]);
    assert.deepEqual(r.notes, ["Cards that make opponents discard"]);
    assert.equal(r.understood.length, r.keys.length);
    assert.ok(r.understood.includes("Card draw: at least 13 (usually 10)"));
    assert.ok(r.understood.includes("Board wipes: none"));
    assert.ok(r.understood.includes("Theme: Infect"));
  });

  test("a theme the commander doesn't have, or a junk reading, sets nothing", () => {
    assert.equal(db.readingToRequest({ theme: "voltron" }, THEMES).theme, null);
    for (const junk of [null, "text", 5, {}]) {
      const r = db.readingToRequest(junk, THEMES);
      assert.deepEqual([r.roleMinimums, r.weights, r.budget, r.theme, r.searchTags], [{}, {}, null, null, []]);
    }
  });

  test("the rules' reading wins wherever it set something; the AI fills in the rest", () => {
    const rules = db.parseDeckRequest("less draw, under $40, and things that make my opponents discard", THEMES);
    assert.equal(rules.ignored.length, 1);
    const ai = db.readingToRequest({
      roles: [{ role: "draw", change: "lots" }, { role: "removal", change: "more" }],
      budget: 100, price: "cheaper", searchTags: ["discard"], notes: ["Cards that make opponents discard"],
    }, THEMES);
    const m = db.mergeDeckRequests(rules, ai);
    assert.equal(m.byAi, true);
    assert.deepEqual(m.ignored, []);
    assert.equal(m.roleMaximums.draw, rules.roleMaximums.draw, "draw stays as the rules read it");
    assert.equal(m.roleMinimums.draw, rules.roleMinimums.draw);
    assert.equal(m.roleMinimums.removal, 11, "removal comes from the AI");
    assert.equal(m.budget, 40, "the rules' budget wins");
    assert.equal(m.weights.pricePerDollar, 2.0);
    assert.deepEqual(m.understood, rules.understood);
    assert.deepEqual(m.aiUnderstood, ["Removal: at least 11 (usually 8)", "Cheaper cards when buying", "Cards that make opponents discard"]);
    assert.deepEqual(m.searchTags, ["discard"]);
  });

  test("without an AI reading the rules' reading is used as it is", () => {
    const rules = db.parseDeckRequest("more ramp and some weird stuff", THEMES);
    const m = db.mergeDeckRequests(rules, null);
    assert.equal(m.byAi, false);
    assert.deepEqual(m.ignored, rules.ignored);
    assert.deepEqual(m.roleMinimums, rules.roleMinimums);
    assert.deepEqual(m.searchTags, []);
  });
}

// ---- Missing cards -> a want folder in the Archidekt Trading App ----
{
  const db = require("../deck-builder.js");
  const OID = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const UID = n => `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const card = (n, status, extra = {}) => ({ name: `Card ${n}`, oracleId: OID(n), uid: UID(n), status, ...extra });

  test("the want folder is named after the commander(s) and bracket", () => {
    assert.equal(db.wantsFolderName([{ name: "Atraxa, Praetors' Voice" }], 3), "Build: Atraxa, Praetors' Voice (Bracket 3)");
    assert.equal(db.wantsFolderName([{ name: "Tymna the Weaver" }, { name: "Kraum, Ludevic's Opus" }], 4), "Build: Tymna the Weaver / Kraum, Ludevic's Opus (Bracket 4)");
    assert.ok(db.wantsFolderName([{ name: "x".repeat(200) }], 2).length <= 80);
  });

  test("only the cards to get go, once each, with their print and oracle ids", () => {
    const build = { bracket: 2, cards: [card(1, "missing"), card(2, "free"), card(3, "deck"), card(1, "missing"), card(4, "missing", { uid: null }), { name: "Forest", status: "missing" }] };
    assert.deepEqual(db.missingCardsForWants(build), [
      { n: "Card 1", u: UID(1), o: OID(1) },
      { n: "Card 4", o: OID(4) },
      { n: "Forest" },
    ]);
  });

  test("the hand-off address opens the trading app's Wants import, with the list in the fragment", () => {
    const build = { bracket: 3, cards: [card(1, "missing"), card(2, "free")] };
    const url = db.wantsHandoffUrl(build, [{ name: "Atraxa, Praetors' Voice" }]);
    assert.ok(url.startsWith("https://archidekt-trading-app.pages.dev/#import-wants="));
    const payload = JSON.parse(decodeURIComponent(url.split("#import-wants=")[1]));
    assert.deepEqual(payload, { v: 1, folder: "Build: Atraxa, Praetors' Voice (Bracket 3)", cards: [{ n: "Card 1", u: UID(1), o: OID(1) }] });
    assert.ok(!url.split("#")[0].includes("Card"), "nothing about the cards outside the fragment");
    assert.equal(db.wantsHandoffUrl({ bracket: 3, cards: [card(2, "free")] }, [{ name: "X" }]), null);
  });
}

// ---- Saved builds ----
{
  const db = require("../deck-builder.js");
  const OID = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const build = {
    commanders: [{ name: "Tymna the Weaver" }, { name: "Kraum, Ludevic's Opus" }],
    bracket: 3,
    theme: { slug: "group-hug", name: "Group Hug" },
    cards: [
      { name: "Sol Ring", oracleId: OID(1), status: "free", price: 1.5, type: "artifact", synergy: 3, roles: ["ramp"] },
      { name: "Brainstorm", oracleId: OID(2), status: "missing", price: 2, type: "instant" },
      { name: "Arcane Signet", oracleId: OID(3), status: "deck", price: null, type: "artifact" },
    ],
    basics: [{ name: "Plains", count: 9 }, { name: "Swamp", count: 8 }],
    tally: { free: 1, deck: 1, missing: 1, missingCost: 2, unknownPrices: 0, extra: 5 },
  };

  test("a saved build keeps the settings it ran with and the list as it was, nothing else", () => {
    const pick = { oracleId: OID(9), uid: OID(19), name: "Mulldrifter", type: "creature", cmc: 5, price: 0.3, roles: ["draw"], qty: 2, decks: ["Old"], why: "not kept" };
    const saved = db.snapshotBuild(build, { budget: 50, excludeDeckCards: true, pinned: [OID(2), OID(2)], excluded: [OID(7)], request: "  more draw ", pairFallback: false, picks: [pick, { name: "no id" }] });
    assert.deepEqual(saved.commanders, ["Tymna the Weaver", "Kraum, Ludevic's Opus"]);
    assert.equal(saved.bracket, 3);
    assert.deepEqual(saved.options, {
      budget: 50, excludeDeckCards: true, pinned: [OID(2)], excluded: [OID(7)], theme: "group-hug", request: "more draw", pairFallback: false,
      picks: [{ oracleId: OID(9), uid: OID(19), name: "Mulldrifter", type: "creature", cmc: 5, price: 0.3, gameChanger: false, massLandDenial: false, extraTurn: false, roles: ["draw"], qty: 2, decks: ["Old"] }],
    });
    assert.deepEqual(saved.cards[0], { name: "Sol Ring", oracleId: OID(1), status: "free", price: 1.5, type: "artifact" });
    assert.equal(saved.cards[2].price, null);
    assert.deepEqual(saved.basics, build.basics);
    assert.deepEqual(saved.tally, { free: 1, deck: 1, missing: 1, missingCost: 2, unknownPrices: 0 });
  });

  test("the theme picked on the form wins over the build's own; none is null", () => {
    assert.equal(db.snapshotBuild(build, { theme: "voltron" }).options.theme, "voltron");
    assert.equal(db.snapshotBuild({ ...build, theme: null }, {}).options.theme, null);
    assert.equal(db.snapshotBuildOptions({}).budget, 0);
  });

  test("a saved list reads back grouped by type, and as Archidekt text", () => {
    const saved = db.snapshotBuild(build, {});
    assert.equal(db.savedBuildTitle(saved), "Tymna the Weaver / Kraum, Ludevic's Opus");
    assert.deepEqual(db.savedBuildGroups(saved).map(g => [g.type, g.cards.map(c => c.name)]), [["instant", ["Brainstorm"]], ["artifact", ["Arcane Signet", "Sol Ring"]]]);
    assert.equal(db.savedBuildToText(saved), [
      "1 Tymna the Weaver", "1 Kraum, Ludevic's Opus", "1 Brainstorm", "1 Arcane Signet", "1 Sol Ring", "9 Plains", "8 Swamp",
    ].join("\n"));
  });
}

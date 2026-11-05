// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BRACKET_RULES, cardStatus, scoreCard, deckTemplate, splitBasics, buildDeck, deckToText,
  bracketChecks, comboRequest, comboManaCost,
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

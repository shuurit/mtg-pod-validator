// planUpgrade and the My Decks helpers in deck-builder.js.
// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  planUpgrade, archidektDeckCards, archidektDeckName, isStrugglingDeck, featuredDeck, deckNameScore, UPGRADE_DEFAULT_SWAPS,
} = require("../deck-builder.js");

let n = 0;
const oid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const card = (name, extra = {}) => ({
  name, oracleId: oid(), uid: oid(), type: "creature", synergy: 10, inclusion: 30,
  price: 1, gameChanger: false, basic: false, inAverageDeck: false, roles: [], ...extra,
});

const TEMPLATE = { creature: 24, instant: 9, sorcery: 9, artifact: 9, enchantment: 7, planeswalker: 6, battle: 0, land: 35, basic: 11, nonbasic: 24 };
function pool() {
  const out = [];
  for (const type of ["creature", "instant", "sorcery", "artifact", "enchantment", "planeswalker"]) {
    for (let i = 0; i < 20; i++) out.push(card(`${type} ${i}`, { type, synergy: 50 - i }));
  }
  for (let i = 0; i < 30; i++) out.push(card(`land ${i}`, { type: "land", synergy: 20 - i }));
  return out;
}
const data = (candidates, collection = { connected: true, cards: {} }, bracket = 3) => ({
  bracket, template: TEMPLATE, averageBasics: { Forest: 6, Island: 5 }, tagsChecked: true,
  commander: { name: "Atraxa, Praetors' Voice", oracleId: "cmdr", colorIdentity: "WUBG" },
  candidates, collection,
});
// A deck from the start of a list, plus pet cards EDHREC doesn't list.
const deckOf = (cards, pets = []) => ({ commanders: ["cmdr"], cards: [...cards, ...pets].map(c => ({ ...c, qty: 1 })) });

test("a deck that already is the build gets no swaps", () => {
  const cands = pool();
  const d = data(cands);
  const { build } = planUpgrade(d, deckOf([]), { maxSwaps: 0 });
  const plan = planUpgrade(d, deckOf(build.cards));
  assert.equal(plan.swaps.length, 0);
  assert.equal(plan.more, 0);
});

test("pet cards EDHREC doesn't list are the first outs, paired spell for spell", () => {
  const cands = pool();
  const d = data(cands);
  const { build } = planUpgrade(d, deckOf([]), { maxSwaps: 0 });
  // The deck runs the build minus its last three creatures, plus three pets.
  const builtCreatures = build.cards.filter(c => c.type === "creature");
  const dropped = builtCreatures.slice(-3);
  const deck = build.cards.filter(c => !dropped.includes(c));
  const pets = [card("Pet One", { type: "creature" }), card("Pet Two", { type: "sorcery" }), card("Pet Land", { type: "land" })];
  const plan = planUpgrade(d, deckOf(deck, pets));
  const outs = plan.swaps.map(s => s.out.name).sort();
  assert.deepEqual(outs, ["Pet One", "Pet Two"]);
  for (const s of plan.swaps) {
    assert.equal(s.out.onEdhrec, false);
    assert.equal(s.gain, null);
    assert.equal(s.in.type === "land", s.out.type === "land");
  }
  // The deck keeps its size: the swaps trade one for one.
  assert.equal(plan.after.cards.length, deck.length + pets.length);
});

test("maxSwaps caps the list and reports how many more there are", () => {
  const cands = pool();
  const d = data(cands);
  const pets = Array.from({ length: 12 }, (_, i) => card(`Pet ${i}`, { type: "creature" }));
  const { build } = planUpgrade(d, deckOf([]), { maxSwaps: 0 });
  const deck = build.cards.filter(c => c.type !== "creature").concat(build.cards.filter(c => c.type === "creature").slice(12));
  const plan = planUpgrade(d, deckOf(deck, pets), { maxSwaps: 5 });
  assert.equal(plan.swaps.length, 5);
  assert.equal(plan.more, 7);
  assert.equal(UPGRADE_DEFAULT_SWAPS, 10);
});

test("keep protects a card; skip keeps a card out", () => {
  const cands = pool();
  const d = data(cands);
  const pet = card("Pet", { type: "creature" });
  const { build } = planUpgrade(d, deckOf([]), { maxSwaps: 0 });
  const creatures = build.cards.filter(c => c.type === "creature");
  const deck = build.cards.filter(c => c !== creatures[creatures.length - 1]);
  const plan = planUpgrade(d, deckOf(deck, [pet]));
  assert.equal(plan.swaps.length, 1);
  const wanted = plan.swaps[0].in.oracleId;
  assert.equal(planUpgrade(d, deckOf(deck, [pet]), { keep: [pet.oracleId] }).swaps.length, 0);
  const skipped = planUpgrade(d, deckOf(deck, [pet]), { skip: [wanted] });
  assert.equal(skipped.swaps.length, 1);
  assert.notEqual(skipped.swaps[0].in.oracleId, wanted);
});

test("a Game Changer over the bracket's cap is cut first and the after-check passes", () => {
  const cands = pool();
  const gcs = [0, 1, 2, 3, 4].map(i => card(`GC ${i}`, { type: "artifact", synergy: 60, gameChanger: true }));
  const d = data([...cands, ...gcs]);
  const { build } = planUpgrade(d, deckOf([]), { maxSwaps: 0 });
  const artifacts = build.cards.filter(c => c.type === "artifact" && !c.gameChanger);
  const deck = build.cards.filter(c => !c.gameChanger && !artifacts.slice(0, 2).includes(c)).concat(gcs);
  const plan = planUpgrade(d, deckOf(deck));
  assert.equal(plan.before.checks.gameChangers.status, "fail");
  assert.ok(plan.swaps[0].fixes === "gameChangers");
  assert.equal(plan.after.checks.gameChangers.status, "pass");
});

test("cards to get are counted with their price", () => {
  const cands = pool();
  const owned = Object.fromEntries(cands.map(c => [c.oracleId, { qty: 1, decks: [] }]));
  const d = data(cands, { connected: true, cards: owned });
  const { build } = planUpgrade(d, deckOf([]), { maxSwaps: 0 });
  const pet = card("Pet", { type: "creature" });
  const creatures = build.cards.filter(c => c.type === "creature");
  const missing = creatures[creatures.length - 1];
  delete owned[missing.oracleId];
  const deck = build.cards.filter(c => c !== missing);
  const plan = planUpgrade(d, deckOf(deck, [pet]), { budget: 50 });
  assert.equal(plan.swaps.length, 1);
  assert.equal(plan.toGet.count, plan.swaps[0].in.status === "missing" ? 1 : 0);
});

test("archidektDeckCards: commanders first and flagged, basics with counts, duplicates folded", () => {
  const cmd = card("Atraxa, Praetors' Voice");
  const sol = card("Sol Ring", { type: "artifact" });
  const rows = archidektDeckCards({ commanders: [cmd], cards: [sol, { ...sol }], basics: [{ name: "Forest", count: 6 }] });
  assert.deepEqual(rows.map(r => [r.name, r.qty, r.commander]), [["Atraxa, Praetors' Voice", 1, true], ["Sol Ring", 2, false], ["Forest", 6, false]]);
  assert.equal(archidektDeckName("x".repeat(120)).length, 100);
  assert.equal(archidektDeckName("Atraxa", "upgraded"), "Atraxa upgraded");
});

test("struggling decks and the featured one", () => {
  assert.equal(isStrugglingDeck({ gamesPlayed: 2, wins: 0 }), false);
  assert.equal(isStrugglingDeck({ gamesPlayed: 8, wins: 1 }), true);
  assert.equal(isStrugglingDeck({ gamesPlayed: 8, wins: 2 }), false);
  const a = { name: "a", gamesPlayed: 8, wins: 1 };
  const b = { name: "b", gamesPlayed: 4, wins: 0 };
  assert.equal(featuredDeck([a, b, { gamesPlayed: 9, wins: 5 }]), b);
  assert.equal(featuredDeck([{ gamesPlayed: 9, wins: 5 }]), null);
  assert.ok(deckNameScore("Atraxa Superfriends", "atraxa superfriends") > deckNameScore("Atraxa Superfriends", "Atraxa counters"));
  assert.equal(deckNameScore("Atraxa", "Krenko"), 0);
});

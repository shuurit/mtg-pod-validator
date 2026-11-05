// Run with: node --test tests/*.test.js
// Build a Deck's relay side: the Scryfall Tagger lookups that flag mass
// land denial and extra turns, and the Commander Spellbook answer parser
// behind the two-card combo check. relay.js is a Worker module, not
// something Node can require, so like land-denial.test.js this pulls each
// function's source straight out of the file and runs it in a sandbox
// with a fake fetch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RELAY = fs.readFileSync(path.join(__dirname, "..", "cloudflare-worker", "relay.js"), "utf8");

function source(name) {
  const start = RELAY.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} not found in relay.js`);
  const end = RELAY.indexOf("\n}\n", start);
  return RELAY.slice(start, end + 2);
}
function constant(name) {
  const m = new RegExp(`^const ${name} = .*;$`, "m").exec(RELAY);
  assert.ok(m, `${name} not found in relay.js`);
  return m[0];
}

function sandbox(fetchImpl, kv = new Map()) {
  const ctx = {
    fetch: fetchImpl,
    setTimeout: (fn) => fn(),
    console: { error() {} },
    URL,
    Set,
    Map,
    env: {
      DECK_CACHE: {
        get: async (k) => (kv.has(k) ? kv.get(k) : null),
        put: async (k, v) => { kv.set(k, v); },
      },
    },
    waits: [],
  };
  ctx.ctx = { waitUntil: (p) => ctx.waits.push(p) };
  vm.createContext(ctx);
  vm.runInContext([
    "SCRYFALL_API_BASE", "SPELLBOOK_SITE_BASE", "DECK_BUILDER_USER_AGENT", "DECK_BUILDER_CACHE_TTL_SECONDS",
    "DECK_BUILDER_TAGS_CACHE_KEY", "DECK_BUILDER_TAGS",
  ].map(constant).join("\n").replace(/^const /gm, "var "), ctx);
  vm.runInContext(["kvGetJson", "scryfallSearchOracleIds", "deckBuilderTags", "parseSpellbookCombos"].map(source).join("\n"), ctx);
  return ctx;
}

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("Tagger searches follow every page and collect lowercase oracle ids", async () => {
  const calls = [];
  const s = sandbox(async (url) => {
    calls.push(url);
    if (url.includes("page=2")) return json(200, { has_more: false, data: [{ oracle_id: "CCC" }] });
    return json(200, { has_more: true, next_page: "https://api.scryfall.com/cards/search?q=x&page=2", data: [{ oracle_id: "AAA" }, { card_faces: [{ oracle_id: "BBB" }] }] });
  });
  const ids = await s.scryfallSearchOracleIds("otag:extra-turn");
  assert.deepEqual([...ids].sort(), ["aaa", "bbb", "ccc"]);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /q=otag%3Aextra-turn/);
});

test("a search with no results is an empty list, not a failure", async () => {
  const s = sandbox(async () => json(404, { object: "error" }));
  assert.equal((await s.scryfallSearchOracleIds("otag:nothing")).size, 0);
});

test("both tag lists are fetched once, then served from KV", async () => {
  const kv = new Map();
  let calls = 0;
  const s = sandbox(async (url) => {
    calls++;
    const id = url.includes("mass-land-denial") ? "mld-1" : "turn-1";
    return json(200, { has_more: false, data: [{ oracle_id: id }] });
  }, kv);
  const first = await s.deckBuilderTags(s.env, s.ctx);
  await Promise.all(s.waits);
  assert.deepEqual([...first.massLandDenial], ["mld-1"]);
  assert.deepEqual([...first.extraTurn], ["turn-1"]);
  assert.equal(calls, 2);
  assert.ok(kv.has("deckbuilder:tags:v1"));
  const second = await s.deckBuilderTags(s.env, s.ctx);
  assert.equal(calls, 2, "second read comes from KV");
  assert.deepEqual([...second.extraTurn], ["turn-1"]);
});

test("if Scryfall fails the tags are null and nothing is cached", async () => {
  const kv = new Map();
  const s = sandbox(async () => json(503, {}), kv);
  assert.equal(await s.deckBuilderTags(s.env, s.ctx), null);
  await Promise.all(s.waits);
  assert.equal(kv.size, 0);
});

test("the candidates cache key moved to v2, and unflagged candidates aren't cached", () => {
  assert.match(RELAY, /DECK_BUILDER_CACHE_VERSION = "v2"/);
  assert.match(RELAY, /deckbuilder:\$\{DECK_BUILDER_CACHE_VERSION\}:\$\{slug\}:\$\{bracket\}/);
  const handler = source("handleDeckBuilderCandidates");
  assert.match(handler, /if \(data\.tagsChecked\) \{\s*ctx\.waitUntil/);
});

// A find-my-combos answer in the shape Spellbook's backend renders it
// (camelCase, paginated). Trimmed to the fields the parser reads.
const variant = (id, uses, extra = {}) => ({
  id,
  uses: uses.map(([name, quantity = 1, mustBeCommander = false]) => ({ card: { id: 1, name, oracleId: "x" }, quantity, mustBeCommander })),
  requires: [],
  produces: [{ feature: { id: 2, name: "Infinite mana" } }],
  manaValueNeeded: 4,
  bracketTag: "S",
  ...extra,
});
const spellbookAnswer = (included) => ({
  next: null,
  previous: null,
  results: { identity: "WUBG", included, includedByChangingCommanders: [], almostIncluded: [] },
});

test("Spellbook's answer keeps only two-card combos", () => {
  const s = sandbox(async () => json(200, {}));
  const out = s.parseSpellbookCombos(spellbookAnswer([
    variant("1-2", [["Dramatic Reversal"], ["Isochron Scepter"]]),
    variant("3-4-5", [["Sanguine Bond"], ["Exquisite Blood"], ["Some Lifegain"]]),
    variant("6-7", [["Kiki-Jiki, Mirror Breaker"], ["Zealous Conscripts"]], { requires: [{ template: { name: "A sacrifice outlet" }, quantity: 1 }] }),
    variant("8-9", [["Atraxa, Praetors' Voice", 1, true], ["Some Card"]]),
  ]));
  assert.equal(out.checked, true);
  assert.deepEqual(JSON.parse(JSON.stringify(out.combos.map(c => c.cards))), [
    ["Dramatic Reversal", "Isochron Scepter"],
    ["Atraxa, Praetors' Voice", "Some Card"],
  ]);
  const first = out.combos[0];
  assert.equal(first.url, "https://commanderspellbook.com/combo/1-2/");
  assert.equal(first.manaValueNeeded, 4);
  assert.equal(first.bracketTag, "S");
  assert.deepEqual([...first.produces], ["Infinite mana"]);
});

test("an empty `included` is a real 'no combos', checked", () => {
  const s = sandbox(async () => json(200, {}));
  const out = s.parseSpellbookCombos(spellbookAnswer([]));
  assert.equal(out.checked, true);
  assert.equal(out.combos.length, 0);
});

test("snake_case and unpaginated answers parse too", () => {
  const s = sandbox(async () => json(200, {}));
  const v = variant("1-2", [["A"], ["B"]], { manaValueNeeded: undefined, bracketTag: undefined, mana_value_needed: 3, bracket_tag: "R" });
  const out = s.parseSpellbookCombos({ identity: "U", included: [v] });
  assert.equal(out.combos[0].manaValueNeeded, 3);
  assert.equal(out.combos[0].bracketTag, "R");
});

test("anything unrecognisable is unchecked, never 'no combos'", () => {
  const s = sandbox(async () => json(200, {}));
  for (const body of [null, "nope", {}, { results: {} }, { results: { included: "x" } }, { detail: "Throttled" }]) {
    const out = s.parseSpellbookCombos(body);
    assert.equal(out.checked, false, JSON.stringify(body));
  }
});

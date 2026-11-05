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

// A multi-line `const NAME = { ... };` block.
function block(name) {
  const start = RELAY.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} not found in relay.js`);
  return RELAY.slice(start, RELAY.indexOf("\n};\n", start) + 3).replace(/^const /, "var ");
}

function sandbox(fetchImpl, kv = new Map()) {
  const ctx = {
    fetch: fetchImpl,
    setTimeout: (fn) => fn(),
    Date,
    console: { error() {} },
    URL,
    Set,
    Map,
    Infinity,
    Object,
    Number,
    Math,
    String,
    Array,
    JSON,
    Promise,
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
    "DECK_BUILDER_TAGS_CACHE_KEY", "DECK_BUILDER_TAGS", "DECK_BUILDER_ROLE_TAGS", "DECK_BUILDER_ROLE_PAGES",
    "DECK_BUILDER_ROLES_CACHE_PREFIX", "DECK_BUILDER_NOT_DRAW", "SCRYFALL_THROTTLE",
    "SCRYFALL_BACKOFF_MS", "SCRYFALL_BACKOFF_KEY", "DECK_BUILDER_ROLE_PAGE_BUDGET",
    "EDHREC_JSON_BASE", "DECK_BUILDER_TEMPLATE_KEYS", "DECK_BUILDER_BRACKET_SLUGS",
  ].map(constant).join("\n").replace(/^const /gm, "var "), ctx);
  vm.runInContext(block("DECK_BUILDER_ROLE_KEYWORDS"), ctx);
  vm.runInContext([
    "scryfallFetch", "scryfallBackingOff", "recordScryfallBackoff", "kvGetJson",
    "edhrecJson", "deckBuilderPrimaryType", "scryfallCollection", "buildDeckBuilderCandidates", "scryfallSearchOracleIds", "deckBuilderTags", "parseSpellbookCombos",
    "scryfallRoleSearch", "deckBuilderIdentityKey", "deckBuilderRoleTags", "deckBuilderKeywordRoles", "deckBuilderCardRoles",
  ].map(source).join("\n"), ctx);
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

test("the candidates cache key is v4 (roles), and unflagged candidates aren't cached", () => {
  assert.match(RELAY, /DECK_BUILDER_CACHE_VERSION = "v4"/);
  assert.match(source("buildDeckBuilderCandidates"), /cmc: num\(cmd\?\.cmc\)/);
  assert.match(RELAY, /deckbuilder:\$\{DECK_BUILDER_CACHE_VERSION\}:\$\{slug\}:\$\{bracket\}/);
  const handler = source("handleDeckBuilderCandidates");
  assert.match(handler, /if \(data\.tagsChecked && data\.rolesFromTagger\) \{\s*ctx\.waitUntil/);
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
  // Spellbook's manaValueNeeded is the mana to run the combo, not what the
  // cards cost -- it is deliberately not passed on.
  assert.equal("manaValueNeeded" in first, false);
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
  const v = variant("1-2", [["A"], ["B"]], { bracketTag: undefined, bracket_tag: "R" });
  const out = s.parseSpellbookCombos({ identity: "U", included: [v] });
  assert.deepEqual([...out.combos[0].cards], ["A", "B"]);
  assert.equal(out.combos[0].bracketTag, "R");
});

test("anything unrecognisable is unchecked, never 'no combos'", () => {
  const s = sandbox(async () => json(200, {}));
  for (const body of [null, "nope", {}, { results: {} }, { results: { included: "x" } }, { detail: "Throttled" }]) {
    const out = s.parseSpellbookCombos(body);
    assert.equal(out.checked, false, JSON.stringify(body));
  }
});

// ---- Roles: Tagger first, keyword rules where Tagger can't say ----
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "role-cards.json"), "utf8"));

test("keyword rules on real oracle text (Scryfall, Nov 2026)", () => {
  const s = sandbox(async () => json(200, {}));
  const expected = {
    "Cultivate": ["ramp"], "Sol Ring": ["ramp"], "Llanowar Elves": ["ramp"],
    "Rhystic Study": ["draw"], "Harmonize": ["draw"],
    // "Whenever an opponent draws a card" isn't draw; its Treasure is ramp.
    "Smothering Tithe": ["ramp"],
    "Swords to Plowshares": ["removal"], "Beast Within": ["removal"],
    // Blinking your own creature isn't removal; a counterspell isn't either (Tagger's line).
    "Ephemerate": [], "Counterspell": [],
    "Wrath of God": ["removal", "wipe"], "Blasphemous Act": ["removal", "wipe"],
    "Cyclonic Rift": ["removal", "wipe"], // overload
    "Heroic Intervention": ["protection"], "Swiftfoot Boots": ["protection"], "Lightning Greaves": ["protection"],
    // The land back face "adds" mana, but the card isn't ramp.
    "Sink into Stupor // Soporific Springs": ["removal"],
    "Command Tower": [], // a land is never ramp by keyword
    "Laboratory Maniac": [], // "if you would draw a card" isn't draw
    "Black Market Connections": ["draw", "ramp"],
  };
  assert.equal(FIXTURES.length, Object.keys(expected).length);
  for (const card of FIXTURES) {
    assert.deepEqual([...s.deckBuilderKeywordRoles(card.faces)].sort(), expected[card.name].sort(), card.name);
  }
});

test("Tagger decides wherever it covers the card; keywords only past that", () => {
  const s = sandbox(async () => json(200, {}));
  const tags = {
    ramp: { ids: new Set(["sol"]), throughRank: 500, complete: false },
    draw: { ids: new Set(), throughRank: 500, complete: false },
    removal: { ids: new Set(), throughRank: 500, complete: false },
    wipe: { ids: new Set(), throughRank: 500, complete: true },
    protection: { ids: new Set(), throughRank: 500, complete: false },
  };
  const wrath = [{ text: "Destroy all creatures. They can't be regenerated.", typeLine: "Sorcery" }];
  // Ranked within what was read: Tagger's "no" stands, even against the keywords...
  const covered = s.deckBuilderCardRoles("wrath", 100, wrath, tags);
  assert.deepEqual([...covered.roles], []);
  assert.equal(covered.fromKeywords, 0);
  // ...past it, keywords answer -- except for a search that was read to the end.
  const past = s.deckBuilderCardRoles("wrath", 9000, wrath, tags);
  assert.deepEqual([...past.roles], ["removal"]);
  assert.equal(past.fromKeywords, 4, "wipe's search was complete, so Tagger still answers it");
  // Unranked cards and a missing Tagger answer both fall back to keywords.
  assert.equal(s.deckBuilderCardRoles("wrath", null, wrath, tags).fromKeywords, 4);
  assert.deepEqual([...s.deckBuilderCardRoles("wrath", 100, wrath, null).roles].sort(), ["removal", "wipe"]);
  assert.deepEqual([...s.deckBuilderCardRoles("sol", 10, [], tags).roles], ["ramp"]);
});

test("a role search reads at most its page cap, best EDHREC rank first", async () => {
  const calls = [];
  const page = (n, more) => json(200, {
    has_more: more, next_page: `https://api.scryfall.com/cards/search?page=${n + 1}`,
    data: [{ oracle_id: `A${n}`, edhrec_rank: n * 100 }, { oracle_id: `B${n}`, edhrec_rank: n * 100 + 50 }],
  });
  const s = sandbox(async (url) => { calls.push(url); return page(calls.length, true); });
  const out = await s.scryfallRoleSearch("otag:ramp id<=wubrg f:commander", 3);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /order=edhrec/);
  assert.match(calls[0], /q=otag%3Aramp%20id%3C%3Dwubrg%20f%3Acommander/);
  assert.equal(out.throughRank, 350);
  assert.equal(out.complete, false);
  assert.equal(out.ids.size, 6);
  // Reaching unranked cards, or the end, means everything ranked was seen.
  const s2 = sandbox(async () => json(200, { has_more: false, data: [{ oracle_id: "X", edhrec_rank: 5 }, { oracle_id: "Y" }] }));
  const all = await s2.scryfallRoleSearch("q", 3);
  assert.equal(all.complete, true);
  assert.equal(all.throughRank, Infinity);
});

// A role search answer: `pages` pages of 2 cards each, more after unless last.
function roleSearchFetch(calls, { pagesPerRole = 4, status = 200 } = {}) {
  return async (url) => {
    calls.push(url);
    if (status !== 200) return { status, ok: false, headers: { get: () => null }, json: async () => ({}) };
    const tag = /otag%3A([a-z-]+)/.exec(url)[1];
    const page = Number((/[?&]page=(\d+)/.exec(url) || [0, 1])[1]);
    return json(200, {
      has_more: page < pagesPerRole,
      next_page: `https://api.scryfall.com/cards/search?q=otag%3A${tag}&page=${page + 1}`,
      data: [{ oracle_id: `${tag}-${page}-a`, edhrec_rank: page * 10 }, { oracle_id: `${tag}-${page}-b`, edhrec_rank: page * 10 + 5 }],
    });
  };
}

test("roles fill in over a few builds: two per build, each cached on its own", async () => {
  const kv = new Map();
  const calls = [];
  const s = sandbox(roleSearchFetch(calls), kv);
  const first = await s.deckBuilderRoleTags(s.env, s.ctx, "GWU");
  await Promise.all(s.waits);
  assert.equal(calls.length, 8, "the page budget: two roles of four pages");
  assert.ok(calls.filter(u => !/[?&]page=/.test(u)).every(u => /id%3C%3Dwug%20/.test(u)), "WUBRG order, lowercase");
  assert.equal(first.complete, false);
  assert.deepEqual(Object.keys(first.roles).filter(r => first.roles[r]), ["ramp", "draw"]);
  assert.equal(first.roles.removal, null, "not fetched yet: keywords answer it");
  assert.ok(kv.has("deckbuilder:roles:v2:wug:ramp") && kv.has("deckbuilder:roles:v2:wug:draw"));

  await s.deckBuilderRoleTags(s.env, s.ctx, "UGW");
  await Promise.all(s.waits);
  assert.equal(calls.length, 16, "second build: the next two roles");
  const third = await s.deckBuilderRoleTags(s.env, s.ctx, "WUG");
  await Promise.all(s.waits);
  assert.equal(calls.length, 20);
  assert.equal(third.complete, true);
  assert.ok(third.roles.protection.ids.has("protection-1-a"));

  const fourth = await s.deckBuilderRoleTags(s.env, s.ctx, "GUW");
  assert.equal(calls.length, 20, "all five from KV now");
  assert.equal(fourth.complete, true);
  assert.equal(s.deckBuilderIdentityKey(""), "c");
});

test("a rate-limited role search stops the rest and starts a backoff every isolate sees", async () => {
  const kv = new Map();
  const calls = [];
  const s = sandbox(roleSearchFetch(calls, { status: 429 }), kv);
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  const out = await s.deckBuilderRoleTags(s.env, s.ctx, "R");
  await Promise.all(s.waits);
  assert.equal(calls.length, 2, "one request plus its one retry, then stop");
  assert.equal(out.complete, false);
  assert.ok(Object.values(out.roles).every(t => t === null));
  assert.ok(kv.has("deckbuilder:scryfall-backoff"), "other isolates back off too");
  assert.ok(![...kv.keys()].some(k => k.startsWith("deckbuilder:roles:")), "nothing half-fetched is cached");

  // While backing off: no requests, cached roles still served.
  kv.set("deckbuilder:roles:v2:r:ramp", JSON.stringify({ ids: ["x"], throughRank: 50, complete: false }));
  const s2 = sandbox(roleSearchFetch(calls), kv);
  s2.SCRYFALL_THROTTLE.backoffUntil = 0;
  const during = await s2.deckBuilderRoleTags(s2.env, s2.ctx, "R");
  assert.equal(calls.length, 2, "no requests during the backoff");
  assert.ok(during.roles.ramp.ids.has("x"));
  assert.equal(await s2.deckBuilderTags(s2.env, s2.ctx), null, "bracket tags wait too");
});

test("a failure that isn't a rate limit doesn't start a backoff", async () => {
  const kv = new Map();
  const s = sandbox(async () => json(500, {}), kv);
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  const out = await s.deckBuilderRoleTags(s.env, s.ctx, "R");
  await Promise.all(s.waits);
  assert.equal(out.complete, false);
  assert.equal(kv.size, 0);
});

test("the card lookup runs before any optional search, and survives them failing", async () => {
  const calls = [];
  const edhrec = {
    container: { json_dict: { card: { id: "cmdr-uid", name: "Test Commander", color_identity: ["G"] }, cardlists: [
      { header: "Creatures", cardviews: [{ id: "uid-1", name: "Llanowar Elves", synergy: 0.1, num_decks: 5, potential_decks: 10 }] },
    ] } },
    creature: 30, land: 36,
  };
  const s = sandbox(async (url, init) => {
    calls.push(url);
    if (url.includes("edhrec")) return json(200, url.includes("average-decks") ? {} : edhrec);
    if (url.includes("/cards/collection")) {
      return json(200, { data: [
        { id: "uid-1", oracle_id: "OID-1", name: "Llanowar Elves", type_line: "Creature — Elf Druid", oracle_text: "{T}: Add {G}.", cmc: 1, legalities: { commander: "legal" }, prices: { usd: "0.25" }, edhrec_rank: 40 },
        { id: "cmdr-uid", oracle_id: "CMDR", name: "Test Commander", type_line: "Legendary Creature", cmc: 3, color_identity: ["G"] },
      ] });
    }
    return { status: 429, ok: false, headers: { get: () => null }, json: async () => ({}) };
  });
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  const data = await s.buildDeckBuilderCandidates("test-commander", 3,
    () => s.deckBuilderTags(s.env, s.ctx),
    id => s.deckBuilderRoleTags(s.env, s.ctx, id));
  const scryfall = calls.filter(u => u.includes("scryfall"));
  assert.match(scryfall[0], /\/cards\/collection/, "card lookup first");
  assert.ok(data, "the build still has its candidates");
  assert.equal(data.candidates.length, 1);
  assert.equal(data.tagsChecked, false);
  assert.equal(data.rolesFromTagger, false);
  assert.deepEqual([...data.candidates[0].roles], ["ramp"], "keywords stood in for the rate-limited roles");
});

test("the card lookup is patient: two retries before it gives up", async () => {
  let n = 0;
  const s = sandbox(async () => (++n < 3 ? { status: 429, ok: false, headers: { get: () => null }, json: async () => ({}) } : json(200, { data: [{ id: "u" }] })));
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  const byId = await s.scryfallCollection(["u"]);
  assert.equal(n, 3);
  assert.ok(byId.has("u"));
  assert.equal(s.SCRYFALL_THROTTLE.backoffUntil, 0, "it got through, so no backoff");
});

test("a build's Scryfall requests stay small", () => {
  // Role pages per build, on top of EDHREC (2), the two bracket tags (2),
  // Scryfall's collection lookups (~5 for 300 cards) and the collection
  // bridge (1). Well inside Workers' 50 -- and, since 2026-11-05, small
  // enough that Scryfall doesn't rate-limit the burst.
  const budget = Number(/^const DECK_BUILDER_ROLE_PAGE_BUDGET = (\d+);$/m.exec(RELAY)[1]);
  assert.ok(budget <= 8, `${budget} role pages a build is the burst that got rate-limited`);
  assert.ok(budget + 2 + 2 + 5 + 1 <= 20);
});

test("every Scryfall call is spaced out and a 429 is retried once", async () => {
  const waits = [];
  const statuses = [429, 200, 429, 429];
  const s = sandbox(async () => {
    const status = statuses.shift();
    return { status, ok: status === 200, headers: { get: () => null }, json: async () => ({}) };
  });
  s.setTimeout = (fn, ms) => { waits.push(ms); fn(); };
  s.SCRYFALL_THROTTLE.last = Date.now();
  assert.equal((await s.scryfallFetch("https://api.scryfall.com/x")).status, 200, "retried after the 429");
  assert.ok(waits.includes(1000), "backed off a second before retrying");
  assert.ok(waits.some(ms => ms > 0 && ms <= 100), "kept the gap between requests");
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  assert.equal((await s.scryfallFetch("https://api.scryfall.com/y")).status, 429, "a second 429 is returned, not looped on");
  assert.ok(s.SCRYFALL_THROTTLE.backoffUntil > Date.now(), "and starts a backoff");
  assert.match(source("scryfallCollection"), /scryfallFetch\(/);
  assert.match(source("scryfallSearchOracleIds"), /scryfallFetch\(/);
  assert.match(source("scryfallRoleSearch"), /scryfallFetch\(/);
});

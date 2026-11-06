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
    crypto: globalThis.crypto,
    TextEncoder,
    Uint8Array,
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
    "EDHREC_JSON_BASE", "DECK_BUILDER_TEMPLATE_KEYS", "DECK_BUILDER_BRACKET_SLUGS", "EDHREC_REDIRECT_RE",
    "DECK_BUILDER_THEME_LIMIT", "DECK_BUILDER_THEME_MIN_DECKS", "DECK_BUILDER_THEME_RE",
    "DECK_BUILDER_AI_MODEL", "COLLECTION_PICKS_MAX", "COLLECTION_PICKS_SHORTLIST", "ARCHIDEKT_TRADING_APP_BASE_URL",
    "DECK_BUILDER_REQUEST_STOPWORDS", "DECK_BUILDER_TAG_RE", "DECK_BUILDER_READ_CACHE_PREFIX",
    "DECK_BUILDER_READ_CACHE_TTL_SECONDS", "DECK_BUILDER_READ_ROLES", "DECK_BUILDER_TAG_EXAMPLES",
    "DECK_BUILDER_OWNERS_MAX", "DECK_BUILDER_GEMS_MAX",
  ].map(constant).join("\n").replace(/^const /gm, "var "), ctx);
  vm.runInContext(block("DECK_BUILDER_ROLE_KEYWORDS"), ctx);
  vm.runInContext(block("DECK_BUILDER_ROLE_ARCHIDEKT_TAGS"), ctx);
  vm.runInContext(block("DECK_BUILDER_PICKS_SCHEMA"), ctx);
  vm.runInContext(block("DECK_BUILDER_READING_SCHEMA"), ctx);
  // The handler answers through jsonResponse; a plain object is enough here.
  ctx.jsonResponse = (body, status = 200) => ({ body, status });
  vm.runInContext([
    "deckBuilderSearchTags", "deckBuilderPicksPrompt", "deckBuilderValidatePicks", "deckBuilderFallbackPicks", "handleDeckBuilderCollectionPicks", "deckBuilderCheckOwnedCards", "handleDeckBuilderGems",
    "deckBuilderReadingPrompt", "deckBuilderValidateReading", "handleDeckBuilderReadRequest",
    "handleDeckBuilderOwners",
    "scryfallFetch", "scryfallBackingOff", "recordScryfallBackoff", "kvGetJson",
    "edhrecJson", "deckBuilderThemes", "hasCardlists", "deckBuilderPages", "deckBuilderPrimaryType", "deckBuilderNameKey", "scryfallCollection", "buildDeckBuilderCandidates", "scryfallSearchOracleIds", "deckBuilderTags", "parseSpellbookCombos",
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
  assert.match(source("buildDeckBuilderCandidates"), /cmc: num\(c\?\.cmc\)/);
  const handler0 = source("handleDeckBuilderCandidates");
  assert.match(handler0, /deckbuilder:\$\{DECK_BUILDER_CACHE_VERSION\}:\$\{keySlug\}:\$\{bracket\}/);
  // A pair's key holds both slugs, sorted, so either order finds it; the
  // first-commander fallback has its own.
  assert.match(handler0, /\[slug, slug2\]\.sort\(\)\.join\("\+"\) \+ \(pairFallback \? "~first" : ""\)/);
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

// ---- Commander pairs ----
test("an EDHREC pair page in the other order is followed once to the real one", async () => {
  const calls = [];
  const s = sandbox(async (url) => {
    calls.push(url);
    if (url.endsWith("/commanders/tymna-the-weaver-thrasios-triton-hero/core.json")) return json(200, { redirect: "/commanders/thrasios-triton-hero-tymna-the-weaver/core" });
    if (url.endsWith("/commanders/thrasios-triton-hero-tymna-the-weaver/core.json")) return json(200, { header: "Thrasios // Tymna" });
    if (url.endsWith("/commanders/loop-a/core.json")) return json(200, { redirect: "/commanders/loop-b/core" });
    if (url.endsWith("/commanders/loop-b/core.json")) return json(200, { redirect: "/commanders/loop-a/core" });
    if (url.endsWith("/commanders/sneaky/core.json")) return json(200, { redirect: "/average-decks/x/core" });
    return { status: 403, ok: false, json: async () => ({}) };
  });
  assert.equal((await s.edhrecJson("commanders/tymna-the-weaver-thrasios-triton-hero/core.json")).header, "Thrasios // Tymna");
  assert.equal(calls.length, 2);
  assert.equal(await s.edhrecJson("commanders/loop-a/core.json"), null, "one redirect, not a chain");
  assert.equal(await s.edhrecJson("commanders/sneaky/core.json"), null, "only to the same kind of page");
  assert.equal(await s.edhrecJson("commanders/atraxa-praetors-voice-tymna-the-weaver/core.json"), null, "no page: null");
});

function pairFetch(calls) {
  const edhrec = {
    container: { json_dict: { card: { name: "Thrasios, Triton Hero // Tymna the Weaver", color_identity: ["W", "U", "B", "G"] }, cardlists: [
      { header: "Creatures", cardviews: [
        { id: "uid-elves", name: "Llanowar Elves", synergy: 0.1, num_decks: 5, potential_decks: 10 },
        // EDHREC can list a commander among the cards; it must be left out.
        { id: "uid-tymna", name: "Tymna the Weaver", synergy: 0.5, num_decks: 9, potential_decks: 10 },
      ] },
    ] } },
    creature: 30, land: 36,
  };
  return async (url, init) => {
    calls.push({ url, body: init && init.body });
    if (url.includes("edhrec")) return url.includes("average-decks") ? { status: 403, ok: false, json: async () => ({}) } : json(200, edhrec);
    if (url.includes("/cards/collection")) {
      const ids = JSON.parse(init.body).identifiers;
      const cards = {
        "uid-elves": { id: "uid-elves", oracle_id: "OID-ELVES", name: "Llanowar Elves", type_line: "Creature — Elf Druid", oracle_text: "{T}: Add {G}.", cmc: 1, legalities: { commander: "legal" }, prices: { usd: "0.25" } },
        "uid-tymna": { id: "uid-tymna", oracle_id: "OID-TYMNA", name: "Tymna the Weaver", type_line: "Legendary Creature — Human Cleric", cmc: 3, color_identity: ["W", "B"], legalities: { commander: "legal" } },
        "thrasios, triton hero": { id: "uid-thrasios", oracle_id: "OID-THRASIOS", name: "Thrasios, Triton Hero", type_line: "Legendary Creature — Merfolk Wizard", cmc: 2, color_identity: ["U", "G"] },
        "tymna the weaver": { id: "uid-tymna", oracle_id: "OID-TYMNA", name: "Tymna the Weaver", type_line: "Legendary Creature — Human Cleric", cmc: 3, color_identity: ["W", "B"] },
      };
      return json(200, { data: ids.map(i => cards[i.id || i.name.toLowerCase()]).filter(Boolean) });
    }
    return json(200, { has_more: false, data: [] });
  };
}

test("a pair build looks both commanders up in the same request, leaves both out, and answers with both", async () => {
  const calls = [];
  const s = sandbox(pairFetch(calls));
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  const identities = [];
  const data = await s.buildDeckBuilderCandidates("thrasios-triton-hero-tymna-the-weaver", 3, null,
    async id => { identities.push(id); return null; },
    { commanderNames: ["Thrasios, Triton Hero", "Tymna the Weaver"], pairSource: "pair" });
  const lookups = calls.filter(c => c.url.includes("/cards/collection"));
  assert.equal(lookups.length, 1, "one Scryfall request for cards and commanders");
  assert.deepEqual(JSON.parse(lookups[0].body).identifiers.filter(i => i.name).map(i => i.name), ["Thrasios, Triton Hero", "Tymna the Weaver"]);
  assert.deepEqual(data.commanders.map(c => [c.name, c.oracleId, c.colorIdentity, c.cmc]), [
    ["Thrasios, Triton Hero", "oid-thrasios", "UG", 2],
    ["Tymna the Weaver", "oid-tymna", "WB", 3],
  ]);
  assert.equal(data.commander.name, "Thrasios, Triton Hero", "`commander` is still the first");
  assert.equal(data.pairSource, "pair");
  assert.deepEqual([...data.candidates.map(c => c.name)], ["Llanowar Elves"], "Tymna isn't a candidate");
  assert.deepEqual(identities, ["WUBG"], "roles are searched in the pair's combined colors");
});

test("a commander name Scryfall doesn't know is reported, not guessed", async () => {
  const s = sandbox(pairFetch([]));
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  const data = await s.buildDeckBuilderCandidates("x", 3, null, async () => null,
    { commanderNames: ["Thrasios, Triton Hero", "Tymna the Wever"] });
  assert.equal(data.reason, "unknown-commander");
  assert.deepEqual([...data.missing], ["Tymna the Wever"]);
});

test("no page for the pair says so; the fallback reads the first commander's page", () => {
  const handler = source("handleDeckBuilderCandidates");
  assert.match(handler, /const reason = theme \? "no-edhrec-theme" : slug2 && !pairFallback \? "no-edhrec-pair" : "no-edhrec";/);
  assert.match(handler, /const pageSlug = slug2 && !pairFallback \? `\$\{slug\}-\$\{slug2\}` : slug;/);
  assert.match(handler, /pairSource: pairFallback \? "first-commander" : "pair"/);
});

test("the combo check sends both commanders to Spellbook", () => {
  const h = source("handleDeckBuilderCombos");
  assert.match(h, /Array\.isArray\(body && body\.commanders\) \? body\.commanders : \[body && body\.commander\]/);
  assert.match(h, /commanders: commanders\.map\(card => \(\{ card, quantity: 1 \}\)\)/);
});

test("the browser's slug rule matches the relay's", () => {
  const { deckBuilderSlug } = require("../deck-builder.js");
  const s = sandbox(async () => json(200, {}));
  vm.runInContext(source("edhrecSlug"), s);
  for (const name of ["Atraxa, Praetors' Voice", "Lae'zel, Vlaakith's Champion", "Kraum, Ludevic's Opus", "Séance Board", "Bjorna, Nightfall Alchemist", "Esika, God of the Tree // The Prismatic Bridge", "Jötun Grunt", "The Tenth Doctor"]) {
    assert.equal(deckBuilderSlug(name), s.edhrecSlug(name), name);
  }
});

// ---- Themes (EDHREC tag_counts and theme pages) ----
test("themes: most decks first, at least 5 decks, at most 10, real slugs only", () => {
  const s = sandbox(async () => json(200, {}));
  const tags = [
    { slug: "proliferate", value: "Proliferate", count: 157 },
    { slug: "infect", value: "Infect", count: 331 },
    { slug: "plus-1-plus-1-counters", value: "+1/+1 Counters", count: 275 },
    { slug: "clones", value: "Clones", count: 2 },
    { slug: "../etc", value: "Bad", count: 999 },
    ...Array.from({ length: 12 }, (_, i) => ({ slug: `t-${i}`, value: `T${i}`, count: 10 + i })),
  ];
  const out = s.deckBuilderThemes(tags);
  assert.equal(out.length, 10);
  assert.deepEqual([...out.slice(0, 3).map(t => t.slug)], ["infect", "plus-1-plus-1-counters", "proliferate"]);
  assert.deepEqual({ ...out[1] }, { slug: "plus-1-plus-1-counters", name: "+1/+1 Counters", count: 275 });
  assert.ok(!out.some(t => t.slug === "clones" || t.slug === "../etc"));
  assert.equal(s.deckBuilderThemes(undefined).length, 0);
});

function themePageFetch(calls, pages) {
  return async (url) => {
    const path = url.replace("https://json.edhrec.com/pages/", "").replace(/\.json$/, "");
    calls.push(path);
    if (!(path in pages)) return { status: 403, ok: false, json: async () => ({}) };
    return json(200, pages[path]);
  };
}
const withCards = n => ({ container: { json_dict: { cardlists: [{ header: "x", cardviews: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) }] } } });
const empty = { container: { json_dict: { card: { name: "x" } } }, header: "cEDH Voltron" };

test("a theme reads the bracket's theme page, bracket first", async () => {
  const calls = [];
  const s = sandbox(themePageFetch(calls, {
    "commanders/atraxa-praetors-voice/core/infect": withCards(3),
    "average-decks/atraxa-praetors-voice/core/infect": withCards(2),
  }));
  const out = await s.deckBuilderPages("atraxa-praetors-voice", "core", "infect");
  assert.equal(out.themeSource, "bracket");
  assert.ok(s.hasCardlists(out.page) && s.hasCardlists(out.average));
  assert.deepEqual([...calls].sort(), ["average-decks/atraxa-praetors-voice/core/infect", "commanders/atraxa-praetors-voice/core/infect"]);
});

test("an empty bracket theme page falls back to the theme's all-brackets page", async () => {
  const calls = [];
  const s = sandbox(themePageFetch(calls, {
    "commanders/wilson/cedh/voltron": empty,
    "average-decks/wilson/cedh/voltron": empty,
    "commanders/wilson/voltron": withCards(4),
    "average-decks/wilson/voltron": withCards(2),
  }));
  const out = await s.deckBuilderPages("wilson", "cedh", "voltron");
  assert.equal(out.themeSource, "all-brackets");
  assert.ok(s.hasCardlists(out.page) && s.hasCardlists(out.average));
  assert.ok(calls.includes("commanders/wilson/voltron"));
  // Neither page: nothing to build from (the handler says no-edhrec-theme).
  const none = await sandbox(themePageFetch([], {})).deckBuilderPages("wilson", "cedh", "nope");
  assert.equal(none.page, null);
});

test("a full bracket theme page with an empty average deck borrows the all-brackets average", async () => {
  const calls = [];
  const s = sandbox(themePageFetch(calls, {
    "commanders/x/core/tokens": withCards(3),
    "average-decks/x/core/tokens": empty,
    "average-decks/x/tokens": withCards(2),
  }));
  const out = await s.deckBuilderPages("x", "core", "tokens");
  assert.equal(out.themeSource, "bracket");
  assert.ok(s.hasCardlists(out.average));
});

test("no theme reads the same pages as before", async () => {
  const calls = [];
  const s = sandbox(themePageFetch(calls, { "commanders/x/core": withCards(1) }));
  const out = await s.deckBuilderPages("x", "core", null);
  assert.equal(out.themeSource, null);
  assert.deepEqual([...calls].sort(), ["average-decks/x/core", "commanders/x/core"]);
});

test("the theme is validated, gets its own cache key, and old cached answers get a theme list", () => {
  const handler = source("handleDeckBuilderCandidates");
  assert.match(handler, /DECK_BUILDER_THEME_RE\.test\(theme\)/);
  // No theme: the key it always had. A theme: its own.
  assert.match(handler, /:\$\{bracket\}\$\{theme \? `:theme=\$\{theme\}` : ""\}`/);
  assert.match(handler, /if \(!Array\.isArray\(data\.themes\)\)/);
  const s = sandbox(async () => json(200, {}));
  for (const bad of ["../x", "Infect", "a b", "x/y", ""]) assert.equal(s.DECK_BUILDER_THEME_RE.test(bad), false, bad);
  assert.ok(s.DECK_BUILDER_THEME_RE.test("plus-1-plus-1-counters"));
});

// ---- "What are you looking for?": picks from the player's own collection ----
const OID = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("a request becomes Archidekt tags: roles map to their tags, other words are tried as tags", () => {
  const s = sandbox(async () => json(200, {}));
  assert.deepEqual([...s.deckBuilderSearchTags(["draw"], "more card draw please")], ["draw", "card advantage"]);
  assert.deepEqual([...s.deckBuilderSearchTags(["wipe"], "")], ["sweeper", "board wipe", "wrath"]);
  assert.deepEqual([...s.deckBuilderSearchTags([], "lots of tokens and lifegain")], ["lots", "tokens", "token", "lifegain"].filter(t => t !== "lots"));
  assert.equal(s.deckBuilderSearchTags([], "more cards please").length, 0, "nothing worth searching");
});

const SHORTLIST = [
  { oracleId: OID(1), name: "Phyrexian Arena", typeLine: "Enchantment", cmc: 3, tags: ["draw"], matched: ["draw", "card advantage"], text: "At the beginning of your upkeep, you draw a card and you lose 1 life.", qty: 1, decks: [] },
  { oracleId: OID(2), name: "Mulldrifter", typeLine: "Creature Elemental", cmc: 5, tags: ["draw"], matched: ["draw"], text: "When Mulldrifter enters, draw two cards.", qty: 2, decks: ["Old Deck"] },
  { oracleId: OID(3), name: "Night's Whisper", typeLine: "Sorcery", cmc: 2, tags: ["draw"], matched: ["draw"], text: "You draw two cards and you lose 2 life.", qty: 1, decks: [] },
];
const DECK = [
  { oracleId: OID(10), name: "Divination", roles: ["draw"] },
  { oracleId: OID(11), name: "Llanowar Elves", roles: ["ramp"] },
];

test("the prompt names the commander, the request, the deck and the owned shortlist", () => {
  const s = sandbox(async () => json(200, {}));
  const [system, user] = s.deckBuilderPicksPrompt({ commanders: ["Atraxa, Praetors' Voice"], bracket: 3, requestText: "more card draw", deck: DECK, shortlist: SHORTLIST, max: 6 });
  assert.equal(system.role, "system");
  assert.match(system.content, /Only choose from OWNED/);
  assert.match(user.content, /Commander: Atraxa, Praetors' Voice/);
  assert.match(user.content, /The player asked: more card draw/);
  assert.match(user.content, /Divination \[draw\]/);
  assert.match(user.content, /Phyrexian Arena \| Enchantment \| mv 3 \| tags: draw \| At the beginning/);
});

test("AI picks are validated: only shortlist cards, each once, replacements only from the deck", () => {
  const s = sandbox(async () => json(200, {}));
  const answer = { response: { picks: [
    { name: "phyrexian arena", why: "Steady draw every turn.", replace: "Divination" },
    { name: "Black Lotus", why: "Invented.", replace: "" },
    { name: "Mulldrifter", why: "Draws two.", replace: "Divination" },
    { name: "Phyrexian Arena", why: "Duplicate.", replace: "" },
    { name: "Night's Whisper", why: "Cheap draw.", replace: "Not In Deck" },
  ] } };
  const out = s.deckBuilderValidatePicks(answer, SHORTLIST, DECK);
  assert.deepEqual([...out.map(p => p.name)], ["Phyrexian Arena", "Mulldrifter", "Night's Whisper"]);
  assert.deepEqual({ ...out[0].replace }, { oracleId: OID(10), name: "Divination" });
  assert.equal(out[1].replace, null, "Divination is already being replaced");
  assert.equal(out[2].replace, null, "a replacement not in the deck is dropped");
  assert.equal(out[0].why, "Steady draw every turn.");
  // A JSON string answer works too; an unreadable one is null (fall back), an empty list is [].
  assert.equal(s.deckBuilderValidatePicks(JSON.stringify({ picks: [{ name: "Mulldrifter", why: "x" }] }), SHORTLIST, DECK).length, 1);
  assert.equal(s.deckBuilderValidatePicks({ response: "not json" }, SHORTLIST, DECK), null);
  assert.equal(s.deckBuilderValidatePicks({ response: { nope: 1 } }, SHORTLIST, DECK), null);
  assert.equal(s.deckBuilderValidatePicks({ response: { picks: [] } }, SHORTLIST, DECK).length, 0);
});

// The whole route, with the trading app, Scryfall and the AI faked.
function picksSandbox({ ai, search, scryfall }) {
  const calls = { search: null, scryfall: null, ai: null };
  const s = sandbox(async (url, init) => {
    if (url.includes("/api/internal/collection-search")) {
      calls.search = JSON.parse(init.body);
      return json(200, search);
    }
    if (url.includes("/cards/collection")) {
      calls.scryfall = JSON.parse(init.body);
      return json(200, scryfall);
    }
    // deckBuilderTags' Tagger searches: no mass land denial / extra turns.
    return json(200, { has_more: false, data: [] });
  });
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  s.env.COLLECTION_BRIDGE_KEY = "test-key";
  if (ai) s.env.AI = { run: async (model, input) => { calls.ai = { model, input }; return ai(); } };
  return { s, calls };
}
const scryCard = (n, name, extra = {}) => ({
  id: `print-${n}`, oracle_id: OID(n), name, type_line: extra.type_line || "Enchantment", cmc: 3,
  color_identity: extra.color_identity || ["B"], legalities: { commander: extra.legal === false ? "banned" : "legal" },
  prices: { usd: "1.50" }, game_changer: !!extra.game_changer, oracle_text: extra.oracle_text || "Draw a card.",
});
const picksRequest = (more = {}) => ({
  json: async () => ({
    request: "more card draw", commanders: ["Atraxa, Praetors' Voice"], colorIdentity: "WUBG", bracket: 3,
    roles: ["draw"], deck: DECK, exclude: [OID(20)], ...more,
  }),
});

test("the route: search the collection, let the AI pick, check every pick with Scryfall", async () => {
  const { s, calls } = picksSandbox({
    search: { connected: true, cards: SHORTLIST },
    ai: async () => ({ response: { picks: [
      { name: "Phyrexian Arena", why: "Steady draw.", replace: "Divination" },
      { name: "Mulldrifter", why: "Draws two.", replace: "" },
      { name: "Night's Whisper", why: "Cheap draw.", replace: "" },
    ] } }),
    scryfall: { data: [
      scryCard(1, "Phyrexian Arena", { oracle_text: "At the beginning of your upkeep, you draw a card and you lose 1 life." }),
      scryCard(2, "Mulldrifter", { type_line: "Creature — Elemental", color_identity: ["U"], oracle_text: "When this creature enters, draw two cards." }),
      scryCard(3, "Night's Whisper", { legal: false }),
    ] },
  });
  const res = await s.handleDeckBuilderCollectionPicks(picksRequest(), s.env, s.ctx, { discordUserId: "123456789012" });
  assert.equal(res.status, 200);
  assert.equal(res.body.checked, true);
  assert.equal(res.body.source, "ai");
  assert.equal(res.body.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  // The search asked for the signed-in player only, in the commander's colours, without the deck's cards.
  assert.equal(calls.search.discordId, "123456789012");
  assert.equal(calls.search.colorIdentity, "WUBG");
  assert.deepEqual(calls.search.tags, ["draw", "card advantage"]);
  assert.ok(calls.search.exclude.includes(OID(10)) && calls.search.exclude.includes(OID(20)));
  assert.equal(calls.ai.input.response_format.type, "json_schema");
  // Night's Whisper isn't Commander-legal (in this fake), so it's dropped.
  assert.deepEqual([...res.body.picks.map(p => p.name)], ["Phyrexian Arena", "Mulldrifter"]);
  const arena = res.body.picks[0];
  assert.equal(arena.type, "enchantment");
  assert.equal(arena.price, 1.5);
  assert.ok(arena.roles.includes("draw"));
  assert.deepEqual({ ...arena.replace }, { oracleId: OID(10), name: "Divination" });
  assert.equal(res.body.picks[1].type, "creature");
});

test("a pick outside the commander's colours is dropped", async () => {
  const { s } = picksSandbox({
    search: { connected: true, cards: SHORTLIST.slice(0, 1) },
    ai: async () => ({ response: { picks: [{ name: "Phyrexian Arena", why: "x" }] } }),
    scryfall: { data: [scryCard(1, "Phyrexian Arena", { color_identity: ["R"] })] },
  });
  const res = await s.handleDeckBuilderCollectionPicks(picksRequest(), s.env, s.ctx, { discordUserId: "123456789012" });
  assert.equal(res.body.picks.length, 0);
});

test("without the AI (failed or unreadable) the best tag matches come back, labelled", async () => {
  for (const ai of [async () => { throw new Error("daily allocation used up"); }, async () => ({ response: "garbled" }), null]) {
    const { s } = picksSandbox({
      search: { connected: true, cards: SHORTLIST },
      ai,
      scryfall: { data: [scryCard(1, "Phyrexian Arena"), scryCard(2, "Mulldrifter", { color_identity: ["U"] }), scryCard(3, "Night's Whisper")] },
    });
    const res = await s.handleDeckBuilderCollectionPicks(picksRequest(), s.env, s.ctx, { discordUserId: "123456789012" });
    assert.equal(res.body.source, "tags");
    assert.equal(res.body.model, null);
    assert.equal(res.body.picks.length, 3);
    assert.match(res.body.picks[0].why, /Archidekt tags it draw, card advantage/);
    assert.equal(res.body.picks[0].replace, null);
  }
});

test("an AI that finds nothing suitable is believed, not overridden", async () => {
  const { s } = picksSandbox({
    search: { connected: true, cards: SHORTLIST },
    ai: async () => ({ response: { picks: [] } }),
    scryfall: { data: [] },
  });
  const res = await s.handleDeckBuilderCollectionPicks(picksRequest(), s.env, s.ctx, { discordUserId: "123456789012" });
  assert.equal(res.body.source, "ai");
  assert.equal(res.body.picks.length, 0);
});

test("no linked collection, nothing to search, or a bad request get a plain answer", async () => {
  let { s } = picksSandbox({ search: { connected: false, reason: "no-archidekt" }, ai: null, scryfall: {} });
  let res = await s.handleDeckBuilderCollectionPicks(picksRequest(), s.env, s.ctx, { discordUserId: "123456789012" });
  assert.deepEqual([res.body.checked, res.body.reason], [false, "no-archidekt"]);
  ({ s } = picksSandbox({ search: {}, ai: null, scryfall: {} }));
  res = await s.handleDeckBuilderCollectionPicks(picksRequest({ request: "more cards please", roles: [] }), s.env, s.ctx, { discordUserId: "1" });
  assert.equal(res.body.reason, "nothing-to-search");
  res = await s.handleDeckBuilderCollectionPicks(picksRequest({ bracket: 9 }), s.env, s.ctx, { discordUserId: "1" });
  assert.equal(res.status, 400);
});

test("the relay has its Workers AI binding", () => {
  const toml = fs.readFileSync(path.join(__dirname, "..", "cloudflare-worker", "wrangler.toml"), "utf8");
  assert.match(toml, /\[ai\]\s*\nbinding = "AI"/);
});

// ---- POST /deck-builder/read-request: the AI reads the request ----
const THEMES = [{ slug: "infect", name: "Infect" }, { slug: "plus-1-plus-1-counters", name: "+1/+1 Counters" }];
const readRequest = (more = {}) => ({
  json: async () => ({ request: "a few more ways to make my opponents discard, and keep it cheap", commanders: ["Atraxa, Praetors' Voice"], bracket: 3, themes: THEMES, ...more }),
});
function readSandbox(ai, kv = new Map()) {
  const calls = [];
  const s = sandbox(async () => json(500, {}), kv);
  if (ai) s.env.AI = { run: async (model, input) => { calls.push({ model, input }); return ai(); } };
  return { s, calls, kv };
}

test("AI tags replace a sentence's plain words in the collection search; roles keep theirs", () => {
  const s = sandbox(async () => json(200, {}));
  assert.deepEqual([...s.deckBuilderSearchTags(["draw"], "make my opponents discard", ["discard", "hand disruption", "NOT A TAG!"])], ["draw", "card advantage", "discard", "hand disruption"]);
  // Without AI tags, the old word rule still applies.
  assert.ok(s.deckBuilderSearchTags([], "make my opponents discard").includes("opponents"));
});

test("the reading prompt names the commander, the bracket, the themes, Archidekt's tag words and the request", () => {
  const s = sandbox(async () => json(200, {}));
  const [system, user] = s.deckBuilderReadingPrompt({ requestText: "graveyard stuff", commanders: ["Meren of Clan Nel Toth"], bracket: 2, themes: THEMES });
  assert.match(system.content, /ramp, draw, removal, wipe, protection/);
  assert.match(system.content, /hand disruption/);
  assert.match(user.content, /Meren of Clan Nel Toth/);
  assert.match(user.content, /Bracket: 2/);
  assert.match(user.content, /infect = Infect/);
  assert.match(user.content, /graveyard stuff$/);
});

test("a reading is validated: known roles and changes only, real themes, tag-shaped tags, bounded notes", () => {
  const s = sandbox(async () => json(200, {}));
  const r = s.deckBuilderValidateReading({ response: {
    roles: [
      { role: "draw", change: "more" },
      { role: "draw", change: "less" },          // a second change to the same role
      { role: "ramp", change: "exactly", count: 99 },
      { role: "removal", change: "exactly" },    // no count
      { role: "lands", change: "more" },         // not a role
      { role: "wipe", change: "double" },        // not a change
    ],
    budget: 75, ownership: "only", price: "cheapest", style: "synergy", theme: "voltron",
    searchTags: ["Discard", "hand disruption", "<script>", "x".repeat(60), "discard"],
    notes: ["Cards that make opponents discard", "", "  two   spaces  "],
  } }, THEMES);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), {
    roles: [{ role: "draw", change: "more" }, { role: "ramp", change: "exactly", count: 30 }],
    budget: 75, ownership: "only", price: "", style: "synergy", theme: "",
    searchTags: ["discard", "hand disruption"],
    notes: ["Cards that make opponents discard", "two spaces"],
  });
  assert.equal(s.deckBuilderValidateReading({ response: "not json" }, THEMES), null);
  assert.equal(s.deckBuilderValidateReading({ response: '{"roles":[],"searchTags":[],"notes":[],"theme":"infect"}' }, THEMES).theme, "infect");
  assert.equal(s.deckBuilderValidateReading(null, THEMES), null);
});

test("the route reads the request once, then serves it from KV", async () => {
  const answer = { response: { roles: [], price: "cheaper", searchTags: ["discard", "hand disruption"], notes: ["Cards that make opponents discard"] } };
  const { s, calls, kv } = readSandbox(async () => answer);
  const res = await s.handleDeckBuilderReadRequest(readRequest(), s.env, s.ctx);
  assert.equal(res.status, 200);
  assert.equal(res.body.read, true);
  assert.equal(res.body.cached, false);
  assert.equal(res.body.reading.price, "cheaper");
  assert.deepEqual([...res.body.reading.searchTags], ["discard", "hand disruption"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(calls[0].input.response_format.type, "json_schema");
  await Promise.all(s.waits);
  assert.equal([...kv.keys()].filter(k => k.startsWith("deckbuilder:read:v1:")).length, 1);
  // Same request, any capitalisation: no second AI call.
  const again = await s.handleDeckBuilderReadRequest(readRequest({ request: "A few more ways to make my opponents DISCARD, and keep it cheap" }), s.env, s.ctx);
  assert.equal(again.body.cached, true);
  assert.equal(again.body.reading.price, "cheaper");
  assert.equal(calls.length, 1);
});

test("the route says plainly when the AI can't read it, and caches nothing", async () => {
  for (const [ai, reason] of [[null, "ai-off"], [async () => { throw new Error("daily allocation used up"); }, "ai-failed"], [async () => ({ response: "garbled" }), "unreadable"]]) {
    const { s, kv } = readSandbox(ai);
    const res = await s.handleDeckBuilderReadRequest(readRequest(), s.env, s.ctx);
    assert.deepEqual([res.body.read, res.body.reason], [false, reason]);
    await Promise.all(s.waits);
    assert.equal(kv.size, 0);
  }
  const { s } = readSandbox(async () => ({}));
  assert.equal((await s.handleDeckBuilderReadRequest(readRequest({ request: "" }), s.env, s.ctx)).status, 400);
  assert.equal((await s.handleDeckBuilderReadRequest(readRequest({ bracket: 9 }), s.env, s.ctx)).status, 400);
});

test("the picks route passes the reading's tags to the collection search", async () => {
  const { s, calls } = picksSandbox({ search: { connected: true, cards: [] }, ai: null, scryfall: {} });
  const res = await s.handleDeckBuilderCollectionPicks(picksRequest({ request: "make my opponents discard", roles: [], tags: ["discard", "hand disruption"] }), s.env, s.ctx, { discordUserId: "1" });
  assert.equal(res.body.checked, true);
  assert.deepEqual(calls.search.tags, ["discard", "hand disruption"]);
});

test("the read-request route sits behind the sign-in check", () => {
  const signIn = RELAY.indexOf('url.pathname === "/deck-builder/candidates"');
  const read = RELAY.indexOf('url.pathname === "/deck-builder/read-request"');
  assert.ok(signIn > 0 && read > signIn, "read-request is routed with the other signed-in deck-builder routes");
});

// ---- POST /deck-builder/owners: friends who own the cards to get ----
function ownersSandbox(answer) {
  const calls = [];
  const s = sandbox(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (answer instanceof Error) throw answer;
    return typeof answer === "number" ? json(answer, {}) : json(200, answer);
  });
  s.env.COLLECTION_BRIDGE_KEY = "test-key";
  return { s, calls };
}
const ownersRequest = (oracleIds) => ({ json: async () => ({ oracleIds }) });
const SESSION = { discordUserId: "123456789012" };

test("owners: the bridge is asked for the signed-in player only, and only names and the flag come back", async () => {
  const { s, calls } = ownersSandbox({
    connected: true,
    owners: {
      [OID(1)]: [{ name: "Mateo", upForTrade: true, quantity: 4, uid: "x" }, { name: "  Ana ", upForTrade: false }],
      [OID(2)]: [],
      [OID(9)]: [{ name: "Not asked about", upForTrade: false }],
    },
  });
  const res = await s.handleDeckBuilderOwners(ownersRequest([OID(1), OID(2).toUpperCase(), OID(1), "nope"]), s.env, SESSION);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://archidekt-trading-app.pages.dev/api/internal/card-owners");
  assert.equal(calls[0].init.headers["X-Collection-Bridge-Key"], "test-key");
  assert.deepEqual(calls[0].body, { discordId: "123456789012", oracleIds: [OID(1), OID(2)] });
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), {
    checked: true,
    owners: { [OID(1)]: [{ name: "Mateo", upForTrade: true }, { name: "Ana", upForTrade: false }] },
  });
});

test("owners: nothing to ask, too many, no account, or the bridge failing each get a plain answer", async () => {
  let { s, calls } = ownersSandbox({ connected: true, owners: {} });
  let res = await s.handleDeckBuilderOwners(ownersRequest([]), s.env, SESSION);
  assert.deepEqual([res.body.checked, calls.length], [true, 0]);
  res = await s.handleDeckBuilderOwners(ownersRequest(Array.from({ length: 101 }, (_, i) => OID(i))), s.env, SESSION);
  assert.equal(res.status, 400);
  ({ s } = ownersSandbox({ connected: false, reason: "no-account" }));
  res = await s.handleDeckBuilderOwners(ownersRequest([OID(1)]), s.env, SESSION);
  assert.deepEqual([res.body.checked, res.body.reason], [false, "no-account"]);
  for (const failure of [403, new Error("network down")]) {
    ({ s } = ownersSandbox(failure));
    res = await s.handleDeckBuilderOwners(ownersRequest([OID(1)]), s.env, SESSION);
    assert.deepEqual([res.body.checked, res.body.reason], [false, "unavailable"]);
  }
  ({ s, calls } = ownersSandbox({}));
  delete s.env.COLLECTION_BRIDGE_KEY;
  res = await s.handleDeckBuilderOwners(ownersRequest([OID(1)]), s.env, SESSION);
  assert.deepEqual([res.body.reason, calls.length], ["bridge-off", 0]);
});

test("the owners route sits behind the sign-in check", () => {
  const signIn = RELAY.indexOf('url.pathname === "/deck-builder/candidates"');
  const owners = RELAY.indexOf('url.pathname === "/deck-builder/owners"');
  assert.ok(signIn > 0 && owners > signIn);
});

// ---- POST /deck-builder/gems: From your binder ----
function gemsSandbox({ bridge, scryfall }) {
  const calls = { bridge: null, scryfall: null };
  const s = sandbox(async (url, init) => {
    if (url.includes("/api/internal/collection-gems")) {
      calls.bridge = { body: JSON.parse(init.body), key: init.headers["X-Collection-Bridge-Key"] };
      if (bridge instanceof Error) throw bridge;
      return json(200, bridge);
    }
    if (url.includes("/cards/collection")) {
      calls.scryfall = JSON.parse(init.body);
      if (scryfall instanceof Error) throw scryfall;
      return json(200, scryfall);
    }
    return json(200, { has_more: false, data: [] }); // Tagger searches
  });
  s.SCRYFALL_THROTTLE.backoffUntil = 0;
  s.env.COLLECTION_BRIDGE_KEY = "test-key";
  return { s, calls };
}
const gemsRequest = (more = {}) => ({ json: async () => ({ colorIdentity: "wub", exclude: [OID(90).toUpperCase(), OID(90), "junk"], ...more }) });
const bridgeCard = (n, name, extra = {}) => ({ oracleId: OID(n), uid: `print-${n}`, name, cmc: 2, types: ["Instant"], edhrecRank: n * 10, gameChanger: false, massLandDenial: false, extraTurns: false, qty: 1, decks: [], ...extra });

test("gems: asks the bridge for the signed-in player, then keeps only what Scryfall says is legal and in colours", async () => {
  const { s, calls } = gemsSandbox({
    bridge: { connected: true, cards: [bridgeCard(1, "Counterspell", { decks: ["Old Deck"], qty: 2 }), bridgeCard(2, "Mana Crypt"), bridgeCard(3, "Lightning Bolt"), bridgeCard(4, "Rhystic Study", { edhrecRank: 46 })] },
    scryfall: { data: [
      scryCard(1, "Counterspell", { type_line: "Instant", color_identity: ["U"], oracle_text: "Counter target spell." }),
      scryCard(2, "Mana Crypt", { type_line: "Artifact", color_identity: [], legal: false }),
      scryCard(3, "Lightning Bolt", { type_line: "Instant", color_identity: ["R"] }),
      scryCard(4, "Rhystic Study", { type_line: "Enchantment", color_identity: ["U"], game_changer: true, oracle_text: "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}." }),
    ] },
  });
  const res = await s.handleDeckBuilderGems(gemsRequest(), s.env, s.ctx, { discordUserId: "123456789012" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.bridge.body)), { discordId: "123456789012", colorIdentity: "WUB", excludeOracleIds: [OID(90)], limit: 40 });
  assert.equal(calls.bridge.key, "test-key");
  assert.equal(calls.scryfall.identifiers.length, 4);
  const gems = JSON.parse(JSON.stringify(res.body.gems));
  assert.deepEqual(gems.map(g => g.name), ["Counterspell", "Rhystic Study"], "banned and off-colour cards dropped");
  assert.deepEqual(
    { type: gems[0].type, cmc: gems[0].cmc, price: gems[0].price, qty: gems[0].qty, decks: gems[0].decks, edhrecRank: gems[0].edhrecRank, uid: gems[0].uid },
    { type: "instant", cmc: 3, price: 1.5, qty: 2, decks: ["Old Deck"], edhrecRank: 10, uid: "print-1" }
  );
  assert.equal(gems[1].type, "enchantment");
  assert.equal(gems[1].gameChanger, true);
  assert.ok(gems[1].roles.includes("draw"));
});

test("gems: no account, bridge down, Scryfall down or a bad request each get a plain answer", async () => {
  let { s } = gemsSandbox({ bridge: { connected: false, reason: "no-archidekt" }, scryfall: {} });
  let res = await s.handleDeckBuilderGems(gemsRequest(), s.env, s.ctx, { discordUserId: "1" });
  assert.deepEqual([res.body.checked, res.body.reason], [false, "no-archidekt"]);
  ({ s } = gemsSandbox({ bridge: new Error("down"), scryfall: {} }));
  res = await s.handleDeckBuilderGems(gemsRequest(), s.env, s.ctx, { discordUserId: "1" });
  assert.deepEqual([res.body.checked, res.body.reason], [false, "unavailable"]);
  ({ s } = gemsSandbox({ bridge: { connected: true, cards: [bridgeCard(1, "Counterspell")] }, scryfall: new Error("down") }));
  res = await s.handleDeckBuilderGems(gemsRequest(), s.env, s.ctx, { discordUserId: "1" });
  assert.deepEqual([res.body.checked, res.body.reason], [false, "unchecked"], "nothing unchecked is offered");
  ({ s } = gemsSandbox({ bridge: { connected: true, cards: [] }, scryfall: {} }));
  res = await s.handleDeckBuilderGems(gemsRequest(), s.env, s.ctx, { discordUserId: "1" });
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { checked: true, gems: [] });
  res = await s.handleDeckBuilderGems(gemsRequest({ colorIdentity: "Blue" }), s.env, s.ctx, { discordUserId: "1" });
  assert.equal(res.status, 400);
});

test("the gems route sits behind the sign-in check", () => {
  const signIn = RELAY.indexOf('url.pathname === "/deck-builder/candidates"');
  const gemsRoute = RELAY.indexOf('url.pathname === "/deck-builder/gems"');
  assert.ok(signIn > 0 && gemsRoute > signIn);
});

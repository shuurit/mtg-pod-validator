// GET/POST/DELETE /deck-builder/builds (handleDeckBuilderBuilds in
// cloudflare-worker/relay.js) against the real schema.sql in an in-memory
// SQLite database (node:sqlite) behind a small D1 stand-in. The handler and
// its helpers are pulled out of relay.js by source, as in
// deck-builder-relay.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");

const DIR = path.join(__dirname, "..", "cloudflare-worker");
const RELAY = fs.readFileSync(path.join(DIR, "relay.js"), "utf8");
function source(name) {
  const start = RELAY.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} not found in relay.js`);
  return RELAY.slice(start, RELAY.indexOf("\n}\n", start) + 2);
}
function constant(name) {
  const m = new RegExp(`^const ${name} = .*;$`, "m").exec(RELAY);
  assert.ok(m, `${name} not found in relay.js`);
  return m[0].replace(/^const /, "var ");
}

function d1(db) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => {
      const r = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: sql => stmt(sql) };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(DIR, "schema.sql"), "utf8"));
  db.prepare("INSERT INTO players (id, name) VALUES (1, 'Me'), (2, 'Mateo')").run();
  const ctx = {
    URL, Set, Map, Number, Math, String, Array, JSON, Object, Promise,
    jsonResponse: (body, status = 200) => ({ body, status }),
  };
  vm.createContext(ctx);
  vm.runInContext(["DECK_BUILDS_PER_PLAYER", "DECK_BUILD_STATUSES", "DECK_BUILD_UUID_RE"].map(constant).join("\n"), ctx);
  vm.runInContext('var DECK_BUILDER_BRACKET_SLUGS = { 1: "exhibition", 2: "core", 3: "upgraded", 4: "optimized", 5: "cedh" };', ctx);
  vm.runInContext(["deckBuilderCleanBuild", "deckBuilderBuildOut", "handleDeckBuilderBuilds"].map(source).join("\n"), ctx);
  const env = { DB: d1(db) };
  const call = (method, query = "", body, playerId = 1) =>
    ctx.handleDeckBuilderBuilds(
      { method, json: async () => body },
      env,
      { playerId },
      new URL(`https://relay.example/deck-builder/builds${query}`),
    );
  return { db, call, ctx };
}

const OID = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const saveBody = (more = {}) => ({
  commanders: ["Atraxa, Praetors' Voice"],
  bracket: 3,
  options: { budget: 40, excludeDeckCards: true, pinned: [OID(2)], excluded: [], theme: "infect", request: "more draw", pairFallback: false, picks: [] },
  cards: [
    { name: "Sol Ring", oracleId: OID(1), status: "free", price: 1.5, type: "artifact" },
    { name: "Brainstorm", oracleId: OID(2), status: "missing", price: 2, type: "instant" },
  ],
  basics: [{ name: "Forest", count: 30 }],
  tally: { free: 1, deck: 0, missing: 1, missingCost: 2, unknownPrices: 0 },
  ...more,
});

test("save, list and open your own build", async () => {
  const s = setup();
  const saved = await s.call("POST", "", saveBody());
  assert.equal(saved.status, 200);
  const id = saved.body.build.id;
  assert.ok(id > 0);
  assert.equal(saved.body.build.cards.length, 2);
  const row = s.db.prepare("SELECT * FROM deck_builds WHERE id = ?").get(id);
  assert.equal(row.player_id, 1);
  assert.equal(row.commander, "Atraxa, Praetors' Voice");
  assert.equal(row.commander2, null);
  assert.equal(JSON.parse(row.options_json).theme, "infect");

  const list = await s.call("GET");
  assert.equal(list.body.builds.length, 1);
  const summary = list.body.builds[0];
  assert.deepEqual([summary.id, summary.bracket, summary.theme, summary.cardCount, summary.tally.missing], [id, 3, "infect", 32, 1]);
  assert.equal(summary.cards, undefined, "the list leaves the card lists out");
  assert.ok(summary.createdAt && summary.updatedAt);

  const one = await s.call("GET", `?id=${id}`);
  assert.deepEqual(one.body.build.cards.map(c => c.name), ["Sol Ring", "Brainstorm"]);
  assert.equal(one.body.build.options.budget, 40);
  assert.deepEqual(one.body.build.basics, [{ name: "Forest", count: 30 }]);
});

test("another player's builds can't be seen, changed or deleted", async () => {
  const s = setup();
  const theirs = (await s.call("POST", "", saveBody(), 2)).body.build.id;
  assert.equal((await s.call("GET")).body.builds.length, 0);
  assert.equal((await s.call("GET", `?id=${theirs}`)).status, 404);
  assert.equal((await s.call("DELETE", `?id=${theirs}`)).status, 404);
  assert.equal((await s.call("POST", "", saveBody({ id: theirs, commanders: ["Hijacked"] }))).status, 404);
  assert.equal(s.db.prepare("SELECT commander FROM deck_builds WHERE id = ?").get(theirs).commander, "Atraxa, Praetors' Voice");
  assert.equal((await s.call("GET", "", undefined, 2)).body.builds.length, 1);
});

test("saving with an id overwrites your own build; delete removes it", async () => {
  const s = setup();
  const id = (await s.call("POST", "", saveBody())).body.build.id;
  const again = await s.call("POST", "", saveBody({ id, bracket: 4 }));
  assert.equal(again.status, 200);
  assert.equal(again.body.build.id, id);
  assert.equal(again.body.build.bracket, 4);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM deck_builds").get().n, 1);
  assert.equal((await s.call("DELETE", `?id=${id}`)).status, 200);
  assert.equal((await s.call("GET")).body.builds.length, 0);
  assert.equal((await s.call("DELETE", "?id=abc")).status, 400);
});

test("at most 25 saved builds per player; the 26th is refused with a reason", async () => {
  const s = setup();
  for (let i = 0; i < 25; i++) assert.equal((await s.call("POST", "", saveBody())).status, 200);
  const full = await s.call("POST", "", saveBody());
  assert.equal(full.status, 409);
  assert.equal(full.body.reason, "full");
  assert.match(full.body.error, /25 saved builds/);
  // Someone else still has room, and overwriting one of yours still works.
  assert.equal((await s.call("POST", "", saveBody(), 2)).status, 200);
  const first = s.db.prepare("SELECT id FROM deck_builds WHERE player_id = 1 ORDER BY id LIMIT 1").get().id;
  assert.equal((await s.call("POST", "", saveBody({ id: first }))).status, 200);
});

test("what's stored is checked and bounded", async () => {
  const s = setup();
  const clean = JSON.parse(JSON.stringify(s.ctx.deckBuilderCleanBuild(saveBody({
    commanders: ["  Tymna   the Weaver ", "Kraum, Ludevic's Opus", "A third"],
    options: { budget: 1e9, pinned: ["nope", OID(1), OID(1)], theme: "Bad Theme!", request: "x".repeat(500), picks: [{ name: "No id" }], extra: "dropped" },
    cards: [
      { name: "Ok", oracleId: OID(1), status: "missing", price: -5, type: "creature", secret: 1 },
      { name: "Bad status", oracleId: OID(2), status: "stolen" },
      { name: "Junk id", oracleId: "x", status: "free" },
    ],
  }))));
  assert.deepEqual([clean.commander, clean.commander2], ["Tymna the Weaver", "Kraum, Ludevic's Opus"]);
  assert.equal(clean.options.budget, 10000);
  assert.deepEqual(clean.options.pinned, [OID(1)]);
  assert.equal(clean.options.theme, null);
  assert.equal(clean.options.request.length, 300);
  assert.deepEqual(clean.options.picks, []);
  assert.equal(clean.options.extra, undefined);
  assert.deepEqual(clean.list.cards, [
    { name: "Ok", oracleId: OID(1), status: "missing", price: 0, type: "creature" },
    { name: "Junk id", oracleId: null, status: "free", price: null, type: "other" },
  ]);
  assert.match(s.ctx.deckBuilderCleanBuild({ commanders: [], bracket: 3 }).error, /commander/);
  assert.match(s.ctx.deckBuilderCleanBuild({ commanders: ["X"], bracket: 9 }).error, /bracket/);
  assert.match(s.ctx.deckBuilderCleanBuild(saveBody({ cards: [] })).error, /no cards/);
  assert.equal((await s.call("POST", "", saveBody({ bracket: 0 }))).status, 400);
});

test("the routes sit behind the sign-in check, and DELETE is allowed cross-origin", () => {
  const signIn = RELAY.indexOf('url.pathname === "/deck-builder/candidates"');
  const builds = RELAY.indexOf('url.pathname === "/deck-builder/builds"');
  assert.ok(signIn > 0 && builds > signIn);
  assert.match(RELAY, /"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"/);
});

test("the migration creates the same table schema.sql does", () => {
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(fs.readFileSync(path.join(DIR, "schema.sql"), "utf8"));
  const migrated = new DatabaseSync(":memory:");
  migrated.exec("CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT);");
  const migration = fs.readFileSync(path.join(DIR, "migration_2026_11_deck_builds.sql"), "utf8");
  migrated.exec(migration);
  migrated.exec(migration); // IF NOT EXISTS: running it twice is harmless
  const cols = d => d.prepare("PRAGMA table_info(deck_builds)").all().map(c => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`);
  assert.deepEqual(cols(migrated), cols(fresh));
});

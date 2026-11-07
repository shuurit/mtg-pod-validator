// My Decks on the relay (cloudflare-worker/relay.js): GET /my-decks,
// POST /my-decks/link and the deck bridge call they share, against the real
// schema.sql in memory and a fake trading app. The handlers are pulled out
// of relay.js by source, as in deck-builds-relay.test.js.
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

function d1(db) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
  });
  return { prepare: sql => stmt(sql) };
}

function setup(answers = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(DIR, "schema.sql"), "utf8"));
  db.prepare("INSERT INTO players (id, name) VALUES (1, 'Me'), (2, 'Mateo')").run();
  db.prepare("INSERT INTO decks (id, player_id, name, baseline_power, bracket) VALUES (10, 1, 'Atraxa', 6, 3), (11, 1, 'Krenko', 5, 2), (20, 2, 'Not Mine', 5, 3)").run();
  const calls = [];
  const ctx = {
    URL, Set, Map, Number, Math, String, Array, JSON, Object, Promise, RegExp, console,
    AbortSignal: { timeout: () => undefined },
    ARCHIDEKT_TRADING_APP_BASE_URL: "https://trading.example",
    DECK_BRIDGE_TIMEOUT_MS: 1000,
    getCurrentSeasonId: async () => 1,
    jsonResponse: (body, status = 200) => ({ body, status }),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, headers: init.headers, body });
      const path = url.replace("https://trading.example/api/internal/", "");
      const answer = typeof answers[path] === "function" ? answers[path](body) : answers[path];
      return { ok: true, status: 200, json: async () => answer || { connected: false, reason: "no-account" } };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(["deckBridge", "playerDeckRecords", "handleMyDecks", "handleMyDeckLink"].map(source).join("\n"), ctx);
  const env = { DB: d1(db), DECK_BRIDGE_KEY: "k" };
  const session = { playerId: 1, discordUserId: "900100" };
  return { ctx, env, session, calls };
}

test("GET /my-decks: the player's own decks with records, brackets and their links", async () => {
  const { ctx, env, session, calls } = setup({
    "archidekt-decks": { connected: true, archidektUsername: "me", decks: [{ id: 500, name: "Atraxa" }], links: { 10: { archidektDeckId: 500, commanderUid: null } } },
  });
  const body = JSON.parse(JSON.stringify((await ctx.handleMyDecks(env, session)).body));
  assert.deepEqual(body.decks.map(d => [d.name, d.bracket, d.archidektDeckId]).sort(), [["Atraxa", 3, 500], ["Krenko", 2, null]]);
  assert.equal(body.archidekt.connected, true);
  assert.deepEqual(body.archidekt.decks, [{ id: 500, name: "Atraxa" }]);
  assert.equal(calls[0].headers["X-Deck-Bridge-Key"], "k");
  assert.equal(calls[0].body.discordId, "900100");
});

test("GET /my-decks: no bridge key still lists the decks, and says why Archidekt is missing", async () => {
  const { ctx, env, session, calls } = setup();
  const body = JSON.parse(JSON.stringify((await ctx.handleMyDecks({ ...env, DECK_BRIDGE_KEY: undefined }, session)).body));
  assert.equal(body.decks.length, 2);
  assert.deepEqual(body.archidekt, { connected: false, reason: "bridge-off", username: null, decks: [] });
  assert.equal(calls.length, 0);
});

test("POST /my-decks/link: only your own decks, and always as you", async () => {
  const { ctx, env, session, calls } = setup({ "pod-deck-link": b => ({ ok: true, ...b }) });
  const link = body => ctx.handleMyDeckLink({ json: async () => body }, env, session);
  assert.equal((await link({ podDeckId: 20, archidektDeckId: 1 })).status, 403);
  assert.equal(calls.length, 0);
  const ok = await link({ podDeckId: 10, archidektDeckId: 500, discordId: "666666" });
  assert.equal(ok.status, 200);
  assert.equal(calls[0].body.discordId, "900100");
  assert.equal(calls[0].body.archidektDeckId, 500);
});

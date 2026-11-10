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
    run: async () => db.prepare(sql).run(...params),
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
    URL, Set, Map, Number, Math, String, Array, JSON, Object, Promise, RegExp, console, Date,
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
  vm.runInContext(["deckBridge", "playerDeckRecords", "handleMyDecks", "handleMyDeckLink", "parseTime", "deckSnapshotStale", "deckSnapshotSummaries"].map(source).join("\n"), ctx);
  vm.runInContext("var DECK_SNAPSHOT_MAX_AGE_HOURS = 20;", ctx);
  const env = { DB: d1(db), DECK_BRIDGE_KEY: "k" };
  const session = { playerId: 1, discordUserId: "900100" };
  return { ctx, env, session, calls, db };
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

// ---- Stored deck copies (deck_snapshots) ----
function snapshotSetup({ live } = {}) {
  const s = setup({
    "archidekt-decks": { connected: true, decks: [{ id: 500, name: "Atraxa", updatedAt: "2026-11-05T12:00:00Z" }], links: { 10: { archidektDeckId: 500, commanderUid: null } } },
  });
  const reads = [];
  // The live read is stubbed: these tests are about what's stored and when.
  s.ctx.readArchidektDeck = async (env, ctx, session, deckId) => {
    reads.push({ deckId, discordUserId: session.discordUserId });
    return live ? live(deckId) : { payload: { connected: true, deckId, name: "Atraxa", commanders: [{ name: "Atraxa, Praetors' Voice" }], cards: [{ name: "Sol Ring" }] }, updatedAt: "2026-11-05T12:00:00Z" };
  };
  vm.runInContext(["DECK_SNAPSHOT_MAX_AGE_HOURS", "DECK_SNAPSHOT_REFRESH_PER_RUN"].map(n => {
    const m = new RegExp(`^const ${n} = .*;$`, "m").exec(RELAY);
    return m[0].replace(/^const /, "var ");
  }).join("\n"), s.ctx);
  vm.runInContext(["parseTime", "deckSnapshotStale", "deckSnapshotSummaries", "readDeckSnapshot", "storeDeckSnapshot", "handleMyDeckCards", "refreshDeckSnapshots"].map(source).join("\n"), s.ctx);
  return { ...s, reads };
}
const plain = v => JSON.parse(JSON.stringify(v));
const cardsUrl = q => new URL(`https://relay.example/my-decks/cards?${q}`);

test("a deck's first open reads it live and stores it; the next open is the stored copy", async () => {
  const { ctx, env, session, reads, db } = snapshotSetup();
  const first = plain((await ctx.handleMyDeckCards(env, {}, session, cardsUrl("deckId=500"))).body);
  assert.equal(first.cached, false);
  assert.equal(reads.length, 1);
  const row = db.prepare("SELECT archidekt_updated_at FROM deck_snapshots WHERE player_id = 1 AND archidekt_deck_id = 500").get();
  assert.equal(row.archidekt_updated_at, "2026-11-05T12:00:00Z");
  const second = plain((await ctx.handleMyDeckCards(env, {}, session, cardsUrl("deckId=500&updatedAt=2026-11-05T12:00:00Z"))).body);
  assert.equal(second.cached, true);
  assert.equal(second.stale, false);
  assert.equal(second.cards[0].name, "Sol Ring");
  assert.equal(reads.length, 1, "no second live read");
});

test("an edit on Archidekt marks the copy stale; refresh=1 reads it live again", async () => {
  const { ctx, env, session, reads } = snapshotSetup();
  await ctx.handleMyDeckCards(env, {}, session, cardsUrl("deckId=500"));
  const stale = plain((await ctx.handleMyDeckCards(env, {}, session, cardsUrl("deckId=500&updatedAt=2026-11-09T08:00:00Z"))).body);
  assert.equal(stale.cached, true);
  assert.equal(stale.stale, true);
  const fresh = plain((await ctx.handleMyDeckCards(env, {}, session, cardsUrl("deckId=500&refresh=1"))).body);
  assert.equal(fresh.cached, false);
  assert.equal(reads.length, 2);
});

test("stale: a different last edit (any format), or no last edit and over a day old", () => {
  const { ctx } = snapshotSetup();
  const snap = { archidektUpdatedAt: "2026-11-05T12:00:00Z", fetchedAt: new Date().toISOString() };
  assert.equal(ctx.deckSnapshotStale(snap, "2026-11-05T12:00:00.000Z"), false);
  assert.equal(ctx.deckSnapshotStale(snap, "2026-11-06T12:00:00Z"), true);
  assert.equal(ctx.deckSnapshotStale(snap, null), false);
  assert.equal(ctx.deckSnapshotStale({ archidektUpdatedAt: null, fetchedAt: "2020-01-01 00:00:00" }, null), true);
  assert.equal(ctx.deckSnapshotStale(null, null), true);
});

test("GET /my-decks says which decks have a copy, whether it's stale, and their commanders", async () => {
  const { ctx, env, session } = snapshotSetup();
  vm.runInContext(["deckSnapshotSummaries"].map(source).join("\n"), ctx);
  await ctx.handleMyDeckCards(env, {}, session, cardsUrl("deckId=500"));
  const body = plain((await ctx.handleMyDecks(env, session)).body);
  const atraxa = body.decks.find(d => d.podDeckId === 10);
  assert.equal(atraxa.archidektUpdatedAt, "2026-11-05T12:00:00Z");
  assert.equal(atraxa.snapshot.stale, false);
  assert.deepEqual(atraxa.snapshot.commanders, ["Atraxa, Praetors' Voice"]);
  assert.equal(body.decks.find(d => d.podDeckId === 11).snapshot, null);
});

test("the hourly job re-reads only old copies, as their own player, and drops deleted decks", async () => {
  const { ctx, env, db, reads } = snapshotSetup({
    live: deckId => (deckId === 501 ? { error: "gone", status: 404 } : { payload: { deckId, commanders: [], cards: [] }, updatedAt: "2026-11-09T00:00:00Z" }),
  });
  db.prepare("UPDATE players SET discord_user_id = '900100' WHERE id = 1").run();
  const put = (deckId, at) => db.prepare("INSERT INTO deck_snapshots (player_id, archidekt_deck_id, payload_json, fetched_at) VALUES (1, ?, '{}', ?)").run(deckId, at);
  put(500, "2020-01-01 00:00:00");
  put(501, "2020-01-02 00:00:00");
  put(502, new Date().toISOString().slice(0, 19).replace("T", " "));
  const out = plain(await ctx.refreshDeckSnapshots(env, {}));
  assert.deepEqual(out, { checked: 2, refreshed: 1 });
  assert.deepEqual(reads.map(r => [r.deckId, r.discordUserId]), [[500, "900100"], [501, "900100"]]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deck_snapshots WHERE archidekt_deck_id = 501").get().n, 0);
  assert.equal(db.prepare("SELECT archidekt_updated_at AS u FROM deck_snapshots WHERE archidekt_deck_id = 500").get().u, "2026-11-09T00:00:00Z");
});

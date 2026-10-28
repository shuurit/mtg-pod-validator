// Run with: node --test tests/*.test.js
// Uses only Node's built-in test runner -- no packages to install.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isDeckGameRow, computeDeckTally, formatWinRate, compareDecksByGames } = require("../deck-tally.js");

const row = (gameNum, date, result, extra = {}) => ({ gameNum, date: new Date(date), result, player: "Mateo", commander: "Atraxa", ...extra });

test("a deck with no games has a zero tally and no win rate", () => {
  const t = computeDeckTally([]);
  assert.equal(t.games, 0);
  assert.equal(t.wins, 0);
  assert.equal(t.losses, 0);
  assert.equal(t.winRate, null);
  assert.equal(t.lastPlayed, null);
  assert.deepEqual(t.history, []);
});

test("counts games, wins and losses, and derives the win rate", () => {
  const t = computeDeckTally([row(1, "2026-10-01", 1), row(2, "2026-10-08", 0), row(3, "2026-10-15", 0), row(4, "2026-10-22", 1)]);
  assert.equal(t.games, 4);
  assert.equal(t.wins, 2);
  assert.equal(t.losses, 2);
  assert.equal(t.winRate, 0.5);
});

test("history is newest first, and last played is the newest game", () => {
  const t = computeDeckTally([row(2, "2026-10-08", 0), row(5, "2026-10-25", 1), row(1, "2026-10-01", 1)]);
  assert.deepEqual(t.history.map(r => r.gameNum), [5, 2, 1]);
  assert.equal(t.lastPlayed.toISOString().slice(0, 10), "2026-10-25");
});

test("two games on the same day order by game number", () => {
  const t = computeDeckTally([row(7, "2026-10-25", 0), row(8, "2026-10-25", 1)]);
  assert.deepEqual(t.history.map(r => r.gameNum), [8, 7]);
});

test("does not reorder the rows it was given", () => {
  const rows = [row(1, "2026-10-01", 1), row(2, "2026-10-08", 0)];
  computeDeckTally(rows);
  assert.deepEqual(rows.map(r => r.gameNum), [1, 2]);
});

test("a result that is neither win nor loss counts as a game but not either", () => {
  const t = computeDeckTally([row(1, "2026-10-01", 1), row(2, "2026-10-08", null)]);
  assert.equal(t.games, 2);
  assert.equal(t.wins, 1);
  assert.equal(t.losses, 0);
  assert.equal(t.winRate, 0.5);
});

test("rows match a deck by id when the relay sends one", () => {
  const deck = { id: 12, name: "Atraxa" };
  assert.equal(isDeckGameRow(row(1, "2026-10-01", 1, { deckId: 12 }), "Mateo", deck), true);
  // Same names, different deck id (a player's two decks sharing a name): not this deck.
  assert.equal(isDeckGameRow(row(1, "2026-10-01", 1, { deckId: 13 }), "Mateo", deck), false);
});

test("rows without a deck id fall back to player and commander name", () => {
  const deck = { id: 12, name: "Atraxa" };
  assert.equal(isDeckGameRow(row(1, "2026-10-01", 1), "Mateo", deck), true);
  assert.equal(isDeckGameRow(row(1, "2026-10-01", 1), "Becca", deck), false);
  assert.equal(isDeckGameRow(row(1, "2026-10-01", 1, { commander: "Prossh" }), "Mateo", deck), false);
});

test("win rate formats as a whole percent, or a dash with no games", () => {
  assert.equal(formatWinRate(null), "—");
  assert.equal(formatWinRate(0), "0%");
  assert.equal(formatWinRate(5 / 12), "42%");
  assert.equal(formatWinRate(1), "100%");
});

test("decks sort by games played, ties alphabetical in either direction", () => {
  const decks = [
    { name: "Yuriko", gamesLogged: 8 },
    { name: "Atraxa", gamesLogged: 24 },
    { name: "Krenko", gamesLogged: 0 },
    { name: "Eshki", gamesLogged: 8 },
  ];
  assert.deepEqual([...decks].sort((a, b) => compareDecksByGames(a, b)).map(d => d.name), ["Atraxa", "Eshki", "Yuriko", "Krenko"]);
  assert.deepEqual([...decks].sort((a, b) => compareDecksByGames(a, b, "asc")).map(d => d.name), ["Krenko", "Eshki", "Yuriko", "Atraxa"]);
});

test("a deck missing a games count sorts as zero", () => {
  const decks = [{ name: "B", gamesLogged: 2 }, { name: "A" }];
  assert.deepEqual(decks.sort((a, b) => compareDecksByGames(a, b)).map(d => d.name), ["B", "A"]);
});

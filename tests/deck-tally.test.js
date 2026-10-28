// Run with: node --test tests/*.test.js
// Uses only Node's built-in test runner -- no packages to install.
const test = require("node:test");
const assert = require("node:assert/strict");
const { indexRowsByDeck, rowsForDeck, computeDeckTally, formatWinRate, compareDecksByGames } = require("../deck-tally.js");

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
  // Same player and name, different deck ids (a player's two decks sharing a name).
  const index = indexRowsByDeck([row(1, "2026-10-01", 1, { deckId: 12 }), row(2, "2026-10-08", 0, { deckId: 13 }), row(3, "2026-10-15", 1, { deckId: 12 })]);
  assert.deepEqual(rowsForDeck(index, "Mateo", { id: 12, name: "Atraxa" }).map(r => r.gameNum), [1, 3]);
  assert.deepEqual(rowsForDeck(index, "Mateo", { id: 13, name: "Atraxa" }).map(r => r.gameNum), [2]);
});

test("rows without a deck id fall back to player and commander name", () => {
  const index = indexRowsByDeck([row(1, "2026-10-01", 1), row(2, "2026-10-08", 0, { player: "Becca" }), row(3, "2026-10-15", 1, { commander: "Prossh" })]);
  assert.deepEqual(rowsForDeck(index, "Mateo", { id: 12, name: "Atraxa" }).map(r => r.gameNum), [1]);
  assert.deepEqual(rowsForDeck(index, "Becca", { id: 20, name: "Atraxa" }).map(r => r.gameNum), [2]);
  assert.deepEqual(rowsForDeck(index, "Mateo", { id: 99, name: "Krenko" }), []);
});

test("a deck's games across seasons all count toward its all-seasons tally", () => {
  const rows = [
    row(40, "2026-06-01", 1, { deckId: 12, seasonLabel: "Season 3" }),
    row(2, "2026-10-08", 0, { deckId: 12, seasonLabel: "Season 4" }),
    row(5, "2026-10-25", 1, { deckId: 12, seasonLabel: "Season 4" }),
  ];
  const t = computeDeckTally(rowsForDeck(indexRowsByDeck(rows), "Mateo", { id: 12, name: "Atraxa" }));
  assert.equal(t.games, 3);
  assert.equal(t.wins, 2);
  // Newest first by date, even though the older season has the higher game number.
  assert.deepEqual(t.history.map(r => r.seasonLabel), ["Season 4", "Season 4", "Season 3"]);
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

test("decks can sort by a count other than this season's", () => {
  const allSeasons = { Atraxa: 3, Yuriko: 30 };
  const decks = [{ name: "Atraxa", gamesLogged: 24 }, { name: "Yuriko", gamesLogged: 8 }];
  assert.deepEqual(decks.sort((a, b) => compareDecksByGames(a, b, "desc", d => allSeasons[d.name])).map(d => d.name), ["Yuriko", "Atraxa"]);
});

test("a deck missing a games count sorts as zero", () => {
  const decks = [{ name: "B", gamesLogged: 2 }, { name: "A" }];
  assert.deepEqual(decks.sort((a, b) => compareDecksByGames(a, b)).map(d => d.name), ["B", "A"]);
});

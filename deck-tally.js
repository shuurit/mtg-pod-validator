// Per-deck game tally: how many league games a deck has played this season,
// its win/loss record, and its game history. Pure functions over the same
// game log rows app.js already builds from GET /games (see gameRowFromD1)
// -- nothing here is stored, so the tally can never drift from the games
// actually logged through Games to Update. Kept in its own file, loaded
// before app.js, so tests/deck-tally.test.js can run it under plain Node
// without a browser.

// Whether a game log row belongs to this deck. Matched by deck id when the
// relay sends one; older relays only send the player and commander names,
// so those are the fallback.
function isDeckGameRow(row, playerName, deck) {
  if (row.deckId != null) return row.deckId === deck.id;
  return row.player === playerName && row.commander === deck.name;
}

// Everything the deck view shows, from that deck's rows (any order).
// League results are only ever a win (1) or a loss (0) -- there's no draw.
// winRate is null, not 0, for a deck with no games: "hasn't played" isn't
// the same thing as "never wins". history is newest first; rows on the
// same day fall back to game number.
function computeDeckTally(rows) {
  const history = [...rows].sort((a, b) => {
    const byDate = dayValue(b.date) - dayValue(a.date);
    return byDate || (b.gameNum || 0) - (a.gameNum || 0);
  });
  const games = history.length;
  const wins = history.filter(r => r.result === 1).length;
  const losses = history.filter(r => r.result === 0).length;
  return {
    games,
    wins,
    losses,
    winRate: games ? wins / games : null,
    lastPlayed: games ? history[0].date : null,
    history,
  };
}

function dayValue(date) {
  const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
  return isNaN(t) ? 0 : t;
}

// "42%", or an em dash before a deck's first game.
function formatWinRate(rate) {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

// Most played first; ties (and direction "asc") keep a stable,
// alphabetical order so equal counts don't shuffle between renders.
function compareDecksByGames(a, b, direction = "desc") {
  const dir = direction === "asc" ? 1 : -1;
  return ((a.gamesLogged || 0) - (b.gamesLogged || 0)) * dir || a.name.localeCompare(b.name);
}

if (typeof module !== "undefined") {
  module.exports = { isDeckGameRow, computeDeckTally, formatWinRate, compareDecksByGames };
}

// Per-deck game tally: how many league games a deck has played (this season
// or across all of them -- whichever rows the caller passes),
// its win/loss record, and its game history. Pure functions over the same
// game log rows app.js already builds from GET /games (see gameRowFromD1)
// -- nothing here is stored, so the tally can never drift from the games
// actually logged through Games to Update. Kept in its own file, loaded
// before app.js, so tests/deck-tally.test.js can run it under plain Node
// without a browser.

// Game log rows grouped by deck, built once per set of rows so every deck
// on screen (and every sort comparison) is a lookup rather than a pass over
// every game -- that matters with all seasons' games in play. Matched by
// deck id when the relay sends one; older relays only send the player and
// commander names, so those are the fallback.
function indexRowsByDeck(rows) {
  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    if (row.deckId != null) pushTo(byId, row.deckId, row);
    else pushTo(byName, deckNameKey(row.player, row.commander), row);
  }
  return { byId, byName };
}

function rowsForDeck(index, playerName, deck) {
  return [...(index.byId.get(deck.id) || []), ...(index.byName.get(deckNameKey(playerName, deck.name)) || [])];
}

function deckNameKey(player, commander) {
  return `${player}\u0000${commander}`;
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
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
// countOf picks which count -- this season's (the default, from /players)
// or whatever scope the Vault is showing.
function compareDecksByGames(a, b, direction = "desc", countOf = d => d.gamesLogged || 0) {
  const dir = direction === "asc" ? 1 : -1;
  return (countOf(a) - countOf(b)) * dir || a.name.localeCompare(b.name);
}

if (typeof module !== "undefined") {
  module.exports = { indexRowsByDeck, rowsForDeck, computeDeckTally, formatWinRate, compareDecksByGames };
}

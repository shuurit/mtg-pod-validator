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

// Veteran foil: the material a deck has earned by being played, from its
// game count. Index is the tier (0-4), used as the vet-<n> class; `at` is
// the count that reaches it. Tuned for a pod's pace -- thirty games on one
// deck is a deck someone loves.
const VETERAN_TIERS = [
  { name: "Sleeved", at: 0 },
  { name: "Played", at: 1 },
  { name: "Etched", at: 5 },
  { name: "Foil", at: 15 },
  { name: "Holo", at: 30 },
];

// { tier, name, next } for a game count; next is { name, in } for the tier
// above (how many more games reach it), or null at the top.
function veteranTier(games) {
  const n = Number.isFinite(games) && games > 0 ? Math.floor(games) : 0;
  let tier = 0;
  for (let k = 1; k < VETERAN_TIERS.length; k++) if (n >= VETERAN_TIERS[k].at) tier = k;
  const up = VETERAN_TIERS[tier + 1];
  return { tier, name: VETERAN_TIERS[tier].name, next: up ? { name: up.name, in: up.at - n } : null };
}

if (typeof module !== "undefined") {
  module.exports = { indexRowsByDeck, rowsForDeck, computeDeckTally, formatWinRate, compareDecksByGames, VETERAN_TIERS, veteranTier };
}

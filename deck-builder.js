// Build a Deck: turns GET /deck-builder/candidates (EDHREC's cards for one
// commander at one bracket, the bracket's average-deck shape, and which of
// them the player owns) into a 99. Pure functions -- nothing here fetches or
// touches the page -- loaded before app.js like deck-tally.js, so
// tests/deck-builder.test.js can run it under plain Node.
//
// How a build works:
//   1. Every candidate gets an ownership status: "free" (a copy no
//      Archidekt deck is using), "deck" (owned, but every copy is in a deck),
//      or "missing".
//   2. Every candidate gets a score: EDHREC synergy and inclusion for this
//      bracket, plus a bonus for owning it (bigger when the copy is free), a
//      small bonus for being in the bracket's average deck, and a penalty by
//      price when it would have to be bought.
//   3. Role minimums first (ROLE_MINIMUMS: ramp, draw, removal, board
//      wipes, protection), each filled with its best-scoring cards. Then
//      nonland cards by type, best score first, aiming at the average
//      deck's type counts, and any open nonland slots go to the best cards
//      left of any type. Then nonbasic lands.
//   4. Basic lands fill out the land count, split the way the average deck
//      splits them.
// A card is skipped when it would break the bracket (Game Changers over the
// cap, mass land denial where it's banned, extra turns past the bracket's
// count) or push spending past the budget. Only if the deck still isn't full
// does it take over-budget cards, and it says so (overBudget).

// A Commander deck is 100 cards with its commander(s): 99 with one, 98 with
// a pair (Partner, Partner with, Friends forever, a Background, a Doctor and
// companion).
const DECK_BUILDER_DECK_SIZE = 99;

// The relay's commanders: `commanders` (one or two) when it sent them,
// otherwise the single `commander` an older cached answer carries.
function deckCommanders(data) {
  if (data && Array.isArray(data.commanders) && data.commanders.length) return data.commanders.filter(Boolean);
  return data && data.commander ? [data.commander] : [];
}

// Cards in the deck besides its commanders.
function deckSize(data) {
  return 100 - Math.max(1, deckCommanders(data).length);
}

// The pair's combined color identity ("WUBRG" order), which sets the basics.
function combinedIdentity(commanders) {
  const all = commanders.map(c => String((c && c.colorIdentity) || "").toUpperCase()).join("");
  return "WUBRG".split("").filter(c => all.includes(c)).join("");
}

// ---- "What are you looking for?" ----
// A player's free-text request, read by plain rules into settings the
// builder already has: role minimums, scoring weights, a budget, an EDHREC
// theme. Nothing is guessed: what isn't understood comes back in `ignored`.
// The page also has the AI read the request (readingToRequest, below) and
// shows what each understood.

const REQUEST_ROLE_WORDS = {
  ramp: ["mana rocks", "mana dorks", "land ramp", "ramp", "acceleration", "rocks", "dorks"],
  draw: ["card advantage", "card draw", "draw spells", "draw"],
  removal: ["spot removal", "kill spells", "interaction", "removal", "answers"],
  wipe: ["board wipes", "board wipe", "board clears", "sweepers", "wipes", "wipe", "wraths"],
  protection: ["protect my commander", "protection", "hexproof", "indestructible"],
};
// Checked in this order, so "no" beats "more" in "no more wipes" and "less"
// beats "lots" in "less than lots".
const REQUEST_INTENSITY = [
  ["none", /\b(no|without|skip|zero)\b/],
  ["less", /\b(less|fewer|lighter|light on|minimal|not much|not many|cut|reduce|lower|drop)\b/],
  ["lots", /\b(lots of|lot of|tons of|loads of|a ton of|plenty of|heavy|heavily|max|maximum|very)\b/],
  ["more", /\b(more|extra|focus|focused|prioriti[sz]e|emphasi[sz]e|lean|boost|increase|higher|add|want|good|strong)\b/],
];
const REQUEST_MAX_ROLE = 30;

// The new minimum for one role: "more" adds ~30% (at least 2), "lots" ~60%
// (at least 4), "less" takes ~30% off (at least 2), "no" is 0, and a number
// is that number (capped at REQUEST_MAX_ROLE).
function requestedMinimum(base, intensity, number) {
  if (number != null) return Math.min(REQUEST_MAX_ROLE, number);
  if (intensity === "none") return 0;
  if (intensity === "less") return Math.max(0, base - Math.max(2, Math.ceil(base * 0.3)));
  if (intensity === "lots") return Math.min(REQUEST_MAX_ROLE, base + Math.max(4, Math.ceil(base * 0.6)));
  return Math.min(REQUEST_MAX_ROLE, base + Math.max(2, Math.ceil(base * 0.3)));
}

function requestIntensity(text) {
  for (const [name, re] of REQUEST_INTENSITY) if (re.test(text)) return name;
  return null;
}

// One role change into a request reading (parseDeckRequest's shape): the
// first change to a role wins. Returns whether it was applied.
function applyRoleChange(out, role, intensity, number, base) {
  if (!(role in ROLE_LABELS) || out.roleMinimums[role] != null || out.roleMaximums[role] != null) return false;
  const was = base[role] || 0;
  const now = requestedMinimum(was, intensity, number);
  // "less" and "no" are caps: decks usually run more of a role than its
  // minimum, so lowering the minimum alone would change nothing.
  if (number == null && (intensity === "less" || intensity === "none")) {
    out.roleMaximums[role] = now;
    out.roleMinimums[role] = Math.min(was, now);
    out.understood.push(now === 0 ? `${ROLE_LABELS[role]}: none` : `${ROLE_LABELS[role]}: at most ${now}`);
  } else {
    out.roleMinimums[role] = now;
    out.understood.push(`${ROLE_LABELS[role]}: at least ${now} (usually ${was})`);
  }
  return true;
}

const requestTokens = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

// text: what the player typed. themes: the commander's EDHREC themes
// ({ slug, name }), once a build has fetched them. base: the role minimums
// to adjust (ROLE_MINIMUMS unless given).
// Returns { roleMinimums, roleMaximums, weights, budget, theme, understood,
// ignored }: the role and weight maps hold only what the text changed
// ("more"/"lots"/a number raise a minimum, "less"/"no" set a maximum, which
// buildDeck takes as opts.roleMinimums / opts.roleMaximums); understood is a
// list of plain lines for the page to echo back; ignored is every clause
// nothing was read from.
function parseDeckRequest(text, themes = [], base = ROLE_MINIMUMS) {
  const out = { roleMinimums: {}, roleMaximums: {}, weights: {}, budget: null, theme: null, understood: [], ignored: [] };
  const raw = String(text || "").slice(0, 500);
  const clauses = raw.split(/[,;.\n!?]+|\bbut\b|\bthough\b/i).map(c => c.trim()).filter(Boolean);

  // A theme is matched as its whole name ("infect", "+1/+1 counters"); the
  // first one mentioned wins.
  const textTokens = ` ${requestTokens(raw).join(" ")} `;
  let themeAt = Infinity;
  let themeWords = [];
  for (const t of themes || []) {
    if (!t || !t.slug) continue;
    for (const form of [t.name, t.slug.replace(/-/g, " ")]) {
      const words = requestTokens(form);
      if (!words.length) continue;
      const at = textTokens.indexOf(` ${words.join(" ")} `);
      if (at >= 0 && at < themeAt) { themeAt = at; out.theme = t.slug; themeWords = words; }
    }
  }
  if (out.theme) out.understood.push(`Theme: ${(themes.find(t => t.slug === out.theme) || {}).name || out.theme}`);

  for (const clause of clauses) {
    const c = clause.toLowerCase();
    let used = false;

    // Roles: each mention takes the intensity (or number) written since the
    // previous mention, else the one before it in the clause, else "more" --
    // so "more removal and ramp" raises both, "more removal and less draw"
    // raises one and lowers the other.
    const mentions = [];
    for (const [role, words] of Object.entries(REQUEST_ROLE_WORDS)) {
      for (const w of words) {
        const re = new RegExp(`\\b${w}\\b`, "g");
        let m;
        while ((m = re.exec(c))) {
          const at = m.index;
          if (!mentions.some(x => x.at <= at && at < x.end)) mentions.push({ role, at, end: at + w.length });
        }
      }
    }
    mentions.sort((a, b) => a.at - b.at);
    let carry = null;
    let from = 0;
    mentions.forEach((m, i) => {
      const before = c.slice(from, m.at);
      const lead = /(\d{1,2})\s*$/.exec(before);
      const next = mentions[i + 1];
      const trail = /^\s*(\d{1,2})\b/.exec(c.slice(m.end, next ? next.at : undefined));
      const number = lead ? Number(lead[1]) : trail ? Number(trail[1]) : null;
      const intensity = requestIntensity(before) || carry || "more";
      carry = intensity;
      from = m.end;
      if (applyRoleChange(out, m.role, intensity, number, base)) used = true;
    });

    if (/\b(don'?t care about owning|ignore my (collection|cards)|doesn'?t matter if i own)\b/.test(c)) {
      Object.assign(out.weights, { ownedFree: 10, ownedInDeck: 5 });
      out.understood.push("Owning a card matters less");
      used = true;
    } else if (/\b(cards i (already )?(own|have)|what i (own|have)|my collection|my binder|owned cards|stuff i (own|have)|use my cards)\b/.test(c)) {
      const only = /\b(only|just|strictly)\b/.test(c);
      Object.assign(out.weights, only ? { ownedFree: 150, ownedInDeck: 60 } : { ownedFree: 80, ownedInDeck: 30 });
      out.understood.push(only ? "Cards you own, as far as they go" : "Prefer cards you own");
      used = true;
    }

    const dollars = /\$\s?(\d{1,4})\b|\b(\d{1,4})\s?(dollars|bucks|usd)\b/.exec(c);
    if (dollars) {
      const asked = Number(dollars[1] || dollars[2]);
      out.budget = Math.min(200, asked);
      out.understood.push(`Budget: $${out.budget}${asked > 200 ? " (the most the slider goes)" : ""}`);
      used = true;
    } else if (/\b(cheap|cheaper|budget|inexpensive|affordable|low cost)\b/.test(c)) {
      out.weights.pricePerDollar = 2.0;
      out.understood.push("Cheaper cards when buying");
      used = true;
    } else if (/\b(price doesn'?t matter|money is no object|expensive is fine|no budget)\b/.test(c)) {
      out.weights.pricePerDollar = 0.2;
      out.understood.push("Price matters less");
      used = true;
    }

    if (/\bsynerg/.test(c)) {
      Object.assign(out.weights, { synergy: 0.8, inclusion: 0.2 });
      out.understood.push("Lean on synergy with the commander");
      used = true;
    } else if (/\b(staples|popular|most played|good ?stuff|tried and true)\b/.test(c)) {
      Object.assign(out.weights, { synergy: 0.25, inclusion: 0.75 });
      out.understood.push("Lean on popular staples");
      used = true;
    }

    // A clause that only named the theme was understood too.
    const clauseText = ` ${requestTokens(clause).join(" ")} `;
    if (!used && !(themeWords.length && clauseText.includes(` ${themeWords.join(" ")} `))) out.ignored.push(clause);
  }
  return out;
}

// ---- The AI's reading of a request ----
// The rules above only know their phrases, so the page also asks the
// relay (POST /deck-builder/read-request) to have Cloudflare Workers AI read
// the whole request into the same settings, plus Archidekt tags to search
// the player's collection with and short notes on what else it understood.
// readingToRequest turns that answer into parseDeckRequest's shape;
// mergeDeckRequests lays the rules' reading over it, so whatever the rules
// understood stays exactly as they read it and the AI fills in the rest.
const REQUEST_SEARCH_TAG_RE = /^[a-z0-9][a-z0-9 +/'-]{0,39}$/;

function readingToRequest(reading, themes = [], base = ROLE_MINIMUMS) {
  const out = { roleMinimums: {}, roleMaximums: {}, weights: {}, budget: null, theme: null, understood: [], ignored: [], searchTags: [], notes: [], keys: [] };
  if (!reading || typeof reading !== "object") return out;
  const line = (key, text) => { out.understood.push(text); out.keys.push(key); };
  for (const r of Array.isArray(reading.roles) ? reading.roles : []) {
    if (!r || typeof r !== "object") continue;
    const count = Number.isInteger(r.count) && r.count >= 0 ? r.count : null;
    const intensity = ["more", "lots", "less", "none"].includes(r.change) ? r.change : r.change === "exactly" && count != null ? "more" : null;
    if (!intensity) continue;
    const before = out.understood.length;
    if (applyRoleChange(out, r.role, intensity, r.change === "exactly" ? count : null, base)) {
      out.keys.push(...Array(out.understood.length - before).fill(`role:${r.role}`));
    }
  }
  const budget = Number(reading.budget);
  if (Number.isFinite(budget) && budget >= 1) {
    out.budget = Math.min(200, Math.round(budget));
    line("budget", `Budget: $${out.budget}${budget > 200 ? " (the most the slider goes)" : ""}`);
  }
  if (reading.ownership === "only") { Object.assign(out.weights, { ownedFree: 150, ownedInDeck: 60 }); line("owned", "Cards you own, as far as they go"); }
  else if (reading.ownership === "prefer") { Object.assign(out.weights, { ownedFree: 80, ownedInDeck: 30 }); line("owned", "Prefer cards you own"); }
  else if (reading.ownership === "ignore") { Object.assign(out.weights, { ownedFree: 10, ownedInDeck: 5 }); line("owned", "Owning a card matters less"); }
  if (reading.price === "cheaper") { out.weights.pricePerDollar = 2.0; line("price", "Cheaper cards when buying"); }
  else if (reading.price === "any") { out.weights.pricePerDollar = 0.2; line("price", "Price matters less"); }
  if (reading.style === "synergy") { Object.assign(out.weights, { synergy: 0.8, inclusion: 0.2 }); line("style", "Lean on synergy with the commander"); }
  else if (reading.style === "staples") { Object.assign(out.weights, { synergy: 0.25, inclusion: 0.75 }); line("style", "Lean on popular staples"); }
  const theme = (themes || []).find(t => t && t.slug && t.slug === reading.theme);
  if (theme) { out.theme = theme.slug; line("theme", `Theme: ${theme.name || humanizeThemeSlug(theme.slug)}`); }
  const tags = (Array.isArray(reading.searchTags) ? reading.searchTags : [])
    .map(t => String(t || "").trim().toLowerCase()).filter(t => REQUEST_SEARCH_TAG_RE.test(t));
  out.searchTags = [...new Set(tags)].slice(0, 12);
  out.notes = (Array.isArray(reading.notes) ? reading.notes : [])
    .map(n => String(n || "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean).slice(0, 4);
  return out;
}

// rules: parseDeckRequest's reading. ai: readingToRequest's, or null.
// Returns parseDeckRequest's shape plus aiUnderstood (the AI's lines for
// what the rules didn't set, then its notes), searchTags, and byAi. With
// the AI's reading nothing is left `ignored`: it read the whole request.
function mergeDeckRequests(rules, ai) {
  if (!ai) return { ...rules, aiUnderstood: [], searchTags: [], byAi: false };
  const rulesRoles = new Set([...Object.keys(rules.roleMinimums), ...Object.keys(rules.roleMaximums)]);
  const pick = map => Object.fromEntries(Object.entries(map).filter(([role]) => !rulesRoles.has(role)));
  const w = rules.weights || {};
  const rulesKeys = new Set([
    ...[...rulesRoles].map(r => `role:${r}`),
    ...(rules.budget != null ? ["budget"] : []),
    ...(w.ownedFree != null ? ["owned"] : []),
    ...(w.pricePerDollar != null ? ["price"] : []),
    ...(w.synergy != null ? ["style"] : []),
    ...(rules.theme ? ["theme"] : []),
  ]);
  const aiLines = ai.understood.filter((_, i) => !rulesKeys.has(ai.keys[i]));
  return {
    roleMinimums: { ...pick(ai.roleMinimums), ...rules.roleMinimums },
    roleMaximums: { ...pick(ai.roleMaximums), ...rules.roleMaximums },
    weights: { ...(rulesKeys.has("owned") ? {} : pickKeys(ai.weights, ["ownedFree", "ownedInDeck"])), ...(rulesKeys.has("price") ? {} : pickKeys(ai.weights, ["pricePerDollar"])), ...(rulesKeys.has("style") ? {} : pickKeys(ai.weights, ["synergy", "inclusion"])), ...w },
    budget: rules.budget != null ? rules.budget : ai.budget,
    theme: rules.theme || ai.theme,
    understood: rules.understood,
    ignored: [],
    aiUnderstood: [...aiLines, ...ai.notes],
    searchTags: ai.searchTags,
    byAi: true,
  };
}

function pickKeys(obj, keys) {
  return Object.fromEntries(keys.filter(k => obj && obj[k] != null).map(k => [k, obj[k]]));
}

// ---- Missing cards -> a want folder in the Archidekt Trading App ----
// The trading app's Wants import takes a list handed over in its address
// (#import-wants=<JSON>, see stashWantsHandoff in that app): the player
// reviews it there, signed in, and presses Add. Nothing is written from
// here. The fragment never reaches a server.
const TRADING_APP_BASE_URL = "https://archidekt-trading-app.pages.dev/";

// "Build: Atraxa, Praetors' Voice (Bracket 3)"; a pair joins its names the
// way the page heads it ("Name A / Name B").
function wantsFolderName(commanders, bracket) {
  const names = (commanders || []).map(c => (c && c.name) || "").filter(Boolean).join(" / ");
  return `Build: ${names || "Unnamed deck"} (Bracket ${bracket})`.slice(0, 80);
}

// The cards to get, once each, as the import's { n, u, o } entries (name,
// Scryfall print id, oracle id).
function missingCardsForWants(build) {
  const seen = new Set();
  const cards = [];
  for (const c of (build && build.cards) || []) {
    if (c.status !== "missing" || !c.name) continue;
    const key = c.oracleId || c.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { n: c.name };
    if (c.uid) entry.u = c.uid;
    if (c.oracleId) entry.o = c.oracleId;
    cards.push(entry);
  }
  return cards;
}

// The trading app address that opens its Wants import with these cards,
// or null when there's nothing to get.
function wantsHandoffUrl(build, commanders, base = TRADING_APP_BASE_URL) {
  const cards = missingCardsForWants(build);
  if (!cards.length) return null;
  const payload = { v: 1, folder: wantsFolderName(commanders, build.bracket), cards };
  return `${base}#import-wants=${encodeURIComponent(JSON.stringify(payload))}`;
}

// ---- Saved builds ----
// What the relay keeps for a saved build (POST /deck-builder/builds) and how
// the page shows one again. The options are what buildDeck ran with, so
// "Rebuild with today's data" can run it again on fresh EDHREC numbers; the
// card list is the deck as it was, prices as at save time.

// The settings a build ran with, in the stored shape. settings: { budget,
// excludeDeckCards, pinned, excluded, theme, request, pairFallback, picks }.
function snapshotBuildOptions(settings = {}) {
  const ids = v => [...new Set((Array.isArray(v) ? v : []).filter(x => typeof x === "string" && x))];
  return {
    budget: Math.max(0, Number(settings.budget) || 0),
    excludeDeckCards: !!settings.excludeDeckCards,
    pinned: ids(settings.pinned),
    excluded: ids(settings.excluded),
    theme: settings.theme || null,
    request: String(settings.request || "").trim().slice(0, 300),
    pairFallback: !!settings.pairFallback,
    // Cards added from the player's own collection (mergeCollectionPicks):
    // EDHREC's list doesn't have them, so a rebuild needs them back.
    picks: (settings.picks || []).filter(p => p && p.oracleId && p.name).map(p => ({
      oracleId: p.oracleId,
      uid: p.uid || null,
      name: p.name,
      type: p.type || "other",
      cmc: p.cmc ?? null,
      price: p.price ?? null,
      gameChanger: !!p.gameChanger,
      massLandDenial: !!p.massLandDenial,
      extraTurn: !!p.extraTurn,
      roles: p.roles || [],
      qty: p.qty ?? 1,
      decks: p.decks || [],
    })),
  };
}

// A finished build -> the POST body that saves it.
function snapshotBuild(build, settings = {}) {
  const commanders = (build.commanders && build.commanders.length ? build.commanders : [build.commander]).filter(Boolean);
  const t = build.tally || {};
  return {
    commanders: commanders.map(c => c.name),
    bracket: build.bracket,
    options: snapshotBuildOptions({ ...settings, theme: settings.theme ?? (build.theme && build.theme.slug) }),
    cards: build.cards.map(c => ({ name: c.name, oracleId: c.oracleId || null, status: c.status, price: c.price ?? null, type: c.type || "other" })),
    basics: (build.basics || []).map(b => ({ name: b.name, count: b.count })),
    tally: { free: t.free || 0, deck: t.deck || 0, missing: t.missing || 0, missingCost: t.missingCost || 0, unknownPrices: t.unknownPrices || 0 },
  };
}

// "Atraxa, Praetors' Voice" / "Tymna the Weaver / Kraum, Ludevic's Opus".
function savedBuildTitle(saved) {
  return (saved.commanders || []).join(" / ") || "Unnamed deck";
}

// A saved list grouped by card type, in the deck view's type order, each
// group by name; basics stay separate ({ name, count }).
function savedBuildGroups(saved) {
  const byType = new Map();
  for (const c of saved.cards || []) {
    const type = c.type || "other";
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(c);
  }
  return [...byType.entries()]
    .sort((a, b) => typeOrder(a[0]) - typeOrder(b[0]))
    .map(([type, cards]) => ({ type, cards: [...cards].sort((a, b) => a.name.localeCompare(b.name)) }));
}

// The saved list as Archidekt's import text, like deckToText.
function savedBuildToText(saved) {
  const lines = (saved.commanders || []).map(name => `1 ${name}`);
  for (const group of savedBuildGroups(saved)) for (const c of group.cards) lines.push(`1 ${c.name}`);
  for (const b of saved.basics || []) if (b.count > 0) lines.push(`${b.count} ${b.name}`);
  return lines.join("\n");
}

// ---- Themes ----
// The relay answers with the commander's EDHREC themes ({ slug, name,
// count }, most decks first) and, for a themed build, `theme`: { slug,
// name, source } -- source "bracket" for the bracket's own theme page,
// "all-brackets" when that bracket had no decks with the theme and the
// all-brackets page was used (the bracket's rules still apply here).

// "plus-1-plus-1-counters" -> "Plus 1 Plus 1 Counters": only for a theme the
// relay sent without a name.
function humanizeThemeSlug(slug) {
  return String(slug || "").split("-").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// A theme's display name, from the theme list where it's known.
function themeName(themes, slug) {
  if (!slug) return null;
  const t = (themes || []).find(x => x && x.slug === slug);
  return (t && t.name) || humanizeThemeSlug(slug);
}

// The picker's choices: "Any" first, then each theme with its deck count.
// A chosen theme the list doesn't carry (an older cached answer) is kept,
// so the picker never silently drops what's being shown.
function themeOptions(themes, chosen) {
  const list = (themes || []).filter(t => t && t.slug);
  const out = [{ value: "", label: "Any" }, ...list.map(t => ({ value: t.slug, label: `${t.name || humanizeThemeSlug(t.slug)} · ${t.count} decks` }))];
  if (chosen && !list.some(t => t.slug === chosen)) out.push({ value: chosen, label: humanizeThemeSlug(chosen) });
  return out;
}

// ---- Commander pairs ----
// How a card can share the command zone, from its Scryfall object
// (keywords, oracle_text, type_line). Read from the oracle text where
// Scryfall's keywords blur it (checked Nov 2026):
//   - "Partner with X" cards also carry the plain Partner keyword;
//   - the newer partner groups print as "Partner—Friends forever",
//     "Partner—Character select", "Partner—Survivors", "Partner—Father &
//     son", also tagged plain Partner, but each pairs only within its group.
function pairingOf(card) {
  if (!card) return null;
  const keywords = (card.keywords || []).map(k => String(k).toLowerCase());
  const text = String(card.oracle_text || (card.card_faces || []).map(f => f.oracle_text || "").join("\n"));
  const typeLine = String(card.type_line || "");
  const partnerWith = /^Partner with ([^(\n]+?)\s*(\(|$)/m.exec(text);
  const group = /^Partner\s*[—-]\s*([^(\n]+?)\s*(\(|$)/m.exec(text);
  // Older printings' plain "Friends forever" keyword is the same group.
  const partnerGroup = group ? group[1].trim() : keywords.includes("friends forever") ? "Friends forever" : null;
  return {
    name: card.name,
    partnerWith: partnerWith ? partnerWith[1].trim() : null,
    partnerGroup,
    partner: !partnerWith && !partnerGroup && keywords.includes("partner"),
    chooseBackground: keywords.includes("choose a background"),
    background: /\bBackground\b/.test(typeLine),
    doctor: /\bTime Lord Doctor\b/.test(typeLine),
    companion: keywords.includes("doctor's companion"),
  };
}

// Whether a second commander field makes sense for this card, and what
// kind of card goes in it (for the form's label).
function secondCommanderKind(p) {
  if (!p) return null;
  if (p.partnerWith) return { kind: "partner-with", label: `Partner with ${p.partnerWith}`, suggest: p.partnerWith };
  if (p.partnerGroup) return { kind: "partner-group", label: `Partner—${p.partnerGroup}` };
  if (p.partner) return { kind: "partner", label: "Partner" };
  if (p.chooseBackground) return { kind: "background", label: "Background" };
  if (p.background) return { kind: "background-for", label: "Creature that can choose a Background" };
  if (p.doctor) return { kind: "companion", label: "Doctor's companion" };
  if (p.companion) return { kind: "doctor", label: "Doctor" };
  return null;
}

// Whether two cards can be commanders together: { ok, kind } or
// { ok: false, reason }.
function canPair(a, b) {
  if (!a || !b) return { ok: false, reason: "Both commanders are needed." };
  if (a.name && b.name && a.name.toLowerCase() === b.name.toLowerCase()) return { ok: false, reason: "That's the same card twice." };
  const same = (x, y) => String(x || "").toLowerCase() === String(y || "").toLowerCase();
  if (a.partnerWith || b.partnerWith) {
    if (same(a.partnerWith, b.name) || same(b.partnerWith, a.name)) return { ok: true, kind: "partner-with" };
    const p = a.partnerWith ? a : b;
    return { ok: false, reason: `${p.name} can only partner with ${p.partnerWith}.` };
  }
  if (a.partnerGroup || b.partnerGroup) {
    if (same(a.partnerGroup, b.partnerGroup)) return { ok: true, kind: "partner-group" };
    const p = a.partnerGroup ? a : b;
    return { ok: false, reason: `${p.name} can only pair with another “Partner—${p.partnerGroup}” commander.` };
  }
  if (a.partner && b.partner) return { ok: true, kind: "partner" };
  if ((a.chooseBackground && b.background) || (b.chooseBackground && a.background)) return { ok: true, kind: "background" };
  if ((a.doctor && b.companion) || (b.doctor && a.companion)) return { ok: true, kind: "doctor" };
  return { ok: false, reason: `${a.name} and ${b.name} can't be commanders together.` };
}

// EDHREC's page slug for a card name -- the same rule as the relay's
// edhrecSlug (tests/deck-builder-relay.test.js keeps the two matching).
function deckBuilderSlug(name) {
  return String(name || "")
    .split(" // ")[0]
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’,.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The order EDHREC names a pair's page in. Checked against 13 real pairs
// (Nov 2026): the creature before its Background, the Doctor before the
// companion, otherwise alphabetical by slug (Partner, Partner with, Friends
// forever). The other order answers with a redirect, which the relay
// follows anyway; this just saves that request.
function pairOrder(a, b, slugOf = deckBuilderSlug) {
  if (a.background && b.chooseBackground && !b.background) return [b, a];
  if (b.background && a.chooseBackground && !a.background) return [a, b];
  if (a.companion && b.doctor) return [b, a];
  if (b.companion && a.doctor) return [a, b];
  return slugOf(a.name) <= slugOf(b.name) ? [a, b] : [b, a];
}


// Wizards' Commander Brackets.
//   gameChangers   the most Game Changers a deck may run.
//   massLandDenial whether any mass land denial is allowed.
//   extraTurns     the most extra-turn cards. Bracket 1 bans extra turns;
//                  2 and 3 ban *chaining* them, which a deck can't do with
//                  only one, so they get 1.
//   twoCardCombos  "banned" (any two-card combo fails), "early" (only
//                  early-game infinite ones are banned -- the player judges
//                  "early", so found combos are a warning), or "allowed".
// The card flags (gameChanger, massLandDenial, extraTurn) come from the
// relay; two-card combos are found after the build by Commander Spellbook,
// through the relay's POST /deck-builder/combos.
const BRACKET_RULES = {
  1: { name: "Exhibition", gameChangers: 0, massLandDenial: false, extraTurns: 0, twoCardCombos: "banned" },
  2: { name: "Core", gameChangers: 0, massLandDenial: false, extraTurns: 1, twoCardCombos: "banned" },
  3: { name: "Upgraded", gameChangers: 3, massLandDenial: false, extraTurns: 1, twoCardCombos: "early" },
  4: { name: "Optimized", gameChangers: Infinity, massLandDenial: true, extraTurns: Infinity, twoCardCombos: "allowed" },
  5: { name: "cEDH", gameChangers: Infinity, massLandDenial: true, extraTurns: Infinity, twoCardCombos: "allowed" },
};

// Whether the relay's candidates carry the mass land denial / extra turn
// flags. It sends tagsChecked: true only when both Scryfall Tagger lists
// loaded; otherwise those two rules can't be enforced or checked.
function tagsChecked(data) {
  return !!(data && data.tagsChecked === true);
}

// The fewest of each role a deck should run. The playgroup can tune these:
// they're the only place the numbers live. A card can fill several roles
// (a removal spell that also draws counts for both). Roles come from the
// relay (Scryfall Tagger, keyword rules where Tagger can't say).
const ROLE_MINIMUMS = { ramp: 10, draw: 10, removal: 8, wipe: 3, protection: 2 };
const ROLE_LABELS = { ramp: "Ramp", draw: "Card draw", removal: "Removal", wipe: "Board wipes", protection: "Protection" };
// Filled scarcest first, so a card that fills a scarce role and a common
// one isn't spent on the common one before the scarce one gets a look.
const ROLE_FILL_ORDER = ["wipe", "protection", "removal", "draw", "ramp"];

const hasRole = (card, role) => Array.isArray(card.roles) && card.roles.includes(role);

// How many cards fill each role in a list.
function roleCounts(cards) {
  const out = {};
  for (const role of Object.keys(ROLE_MINIMUMS)) out[role] = 0;
  for (const card of cards) for (const role of card.roles || []) if (role in out) out[role]++;
  return out;
}

// Starting weights. synergy runs about -100..+100 and inclusion 0..100.
const DEFAULT_WEIGHTS = {
  synergy: 0.55,
  inclusion: 0.45,
  ownedFree: 40,
  ownedInDeck: 15,
  averageDeck: 10,
  pricePerDollar: 0.8,
};

// How much better (in score points, ownership aside) a card you'd buy has
// to be than the owned card it replaces before the budget is spent on it.
const UPGRADE_MARGIN = 10;

const NONLAND_TYPES =["creature", "instant", "sorcery", "artifact", "enchantment", "planeswalker", "battle"];
const COLOR_BASICS = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };

// collection: the relay's `collection` ({ connected, cards: { oracleId:
// { qty, decks } } }). Basics count as always owned. A card that's owned
// but has every copy in a deck is "deck" -- unless excludeDeckCards is on,
// when it's treated as one to get (its deck names still travel with it).
function cardStatus(card, collection, opts = {}) {
  if (card.basic) return "free";
  const owned = collection && collection.cards ? collection.cards[card.oracleId] : null;
  if (!owned || !(owned.qty > 0)) return "missing";
  const inDecks = (owned.decks || []).length;
  if (owned.qty > inDecks) return "free";
  return opts.excludeDeckCards ? "missing" : "deck";
}

function scoreCard(card, status, weights = DEFAULT_WEIGHTS) {
  let score = weights.synergy * (card.synergy ?? 0) + weights.inclusion * (card.inclusion ?? 0);
  if (status === "free") score += weights.ownedFree;
  else if (status === "deck") score += weights.ownedInDeck;
  else if (card.price != null) score -= weights.pricePerDollar * card.price;
  if (card.inAverageDeck) score += weights.averageDeck;
  return Math.round(score * 10) / 10;
}

// Land and nonland targets from the average deck's type counts, scaled so
// they add up to the deck's size (99, or 98 beside a pair). Falls back to a
// plain 36-land shape when EDHREC sent no counts.
function deckTemplate(template, size = DECK_BUILDER_DECK_SIZE) {
  const t = template || {};
  const nonland = {};
  let nonlandTotal = 0;
  for (const type of NONLAND_TYPES) {
    nonland[type] = Math.max(0, Number(t[type]) || 0);
    nonlandTotal += nonland[type];
  }
  let lands = Math.max(0, Number(t.land) || 0);
  if (!lands || !nonlandTotal) return { lands: 36, nonbasic: 0, nonland: null, nonlandSlots: size - 36 };
  lands = Math.min(42, Math.max(30, lands));
  const nonlandSlots = size - lands;
  // Scale to the open slots; any rounding gap is taken by the flex pass.
  const scale = nonlandSlots / nonlandTotal;
  for (const type of NONLAND_TYPES) nonland[type] = Math.floor(nonland[type] * scale);
  const nonbasic = Math.min(lands, Math.max(0, Number(t.nonbasic) || 0));
  return { lands, nonbasic, nonland, nonlandSlots };
}

// Basic land counts for `count` slots, split like the average deck's
// basics; without those, evenly across the commander's colors (Wastes for a
// colorless commander).
function splitBasics(count, averageBasics, colorIdentity) {
  if (count <= 0) return [];
  let weights = Object.entries(averageBasics || {}).filter(([, n]) => n > 0);
  if (!weights.length) {
    const names = [...new Set(String(colorIdentity || "").toUpperCase().split("").map(c => COLOR_BASICS[c]).filter(Boolean))];
    weights = (names.length ? names : ["Wastes"]).map(name => [name, 1]);
  }
  const total = weights.reduce((s, [, n]) => s + n, 0);
  const out = weights.map(([name, n]) => ({ name, count: Math.floor((count * n) / total), share: (count * n) / total }));
  let left = count - out.reduce((s, b) => s + b.count, 0);
  // Hand out the remainder by largest fractional share, ties by name.
  const order = [...out].sort((a, b) => (b.share - b.count) - (a.share - a.count) || a.name.localeCompare(b.name));
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) order[i].count++;
  return out.filter(b => b.count > 0).map(({ name, count: n }) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// The scored candidate pool, best first: one entry per card (EDHREC can
// list two printings of one card), never the commander, never a card the
// player swapped out (opts.excluded).
function candidatePool(data, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const excluded = new Set(opts.excluded || []);
  const commanderOracles = new Set(deckCommanders(data).map(c => c && c.oracleId).filter(Boolean));
  const seen = new Set();
  const pool = [];
  for (const card of data.candidates || []) {
    if (!card.oracleId || seen.has(card.oracleId) || commanderOracles.has(card.oracleId)) continue;
    seen.add(card.oracleId);
    if (excluded.has(card.oracleId)) continue;
    const status = cardStatus(card, data.collection, opts);
    const owned = data.collection && data.collection.cards ? data.collection.cards[card.oracleId] : null;
    pool.push({ ...card, status, score: scoreCard(card, status, weights), decks: owned ? owned.decks || [] : [] });
  }
  return pool.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// data: the relay's /deck-builder/candidates response.
// opts: { budget (dollars for cards to get, default 0), excludeDeckCards,
//         weights, roleMinimums,
//         roleMaximums (the most cards of a role the builder picks, e.g.
//           from "less card draw" or "no board wipes"; a card the player
//           pinned still counts but is never refused for it),
//         pinned (oracle ids the player swapped in: taken first, kept by
//           every later rebuild, and allowed past the budget -- the player
//           chose them -- but never past the bracket's rules),
//         excluded (oracle ids the player swapped out: never picked) }
function buildDeck(data, opts = {}) {
  const bracket = Number(data.bracket);
  const rules = BRACKET_RULES[bracket] || BRACKET_RULES[3];
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const budget = Math.max(0, Number(opts.budget) || 0);
  const commanders = deckCommanders(data);
  const size = deckSize(data);
  const shape = deckTemplate(data.template, size);
  const pinnedIds = new Set(opts.pinned || []);
  const pool = candidatePool(data, opts);

  const picked = [];
  const taken = new Set();
  const typeCount = {};
  let gameChangers = 0;
  let extraTurns = 0;
  let spent = 0;
  // A card the bracket forbids outright, whatever's already in the deck.
  const forbidden = card => !!card.massLandDenial && !rules.massLandDenial;
  let overBudget = false;
  let pinsOverBudget = false;

  // Why the bracket won't take this card right now, or null if it will.
  const bracketBlock = card => {
    if (card.gameChanger && gameChangers >= rules.gameChangers) return "gameChangers";
    if (forbidden(card)) return "massLandDenial";
    if (card.extraTurn && extraTurns >= rules.extraTurns) return "extraTurns";
    return null;
  };

  // allowOverBudget: the last-resort pass, used only if the deck is short.
  // isPin: the player's own pick -- it spends the budget like any other
  // card, but going past it is the player's call, reported separately.
  const tryTake = (card, allowOverBudget, isPin = false) => {
    if (taken.has(card.oracleId)) return false;
    if (bracketBlock(card)) return false;
    if (!isPin && atRoleMax(card)) return false;
    if (card.status === "missing") {
      // An unknown price never fits a budget; it can still come in last.
      const cost = card.price;
      const fits = cost != null && spent + cost <= budget + 1e-9;
      if (!fits && !allowOverBudget && !isPin) return false;
      if (!fits && isPin) pinsOverBudget = true;
      else if (!fits) overBudget = true;
      spent += cost || 0;
    }
    taken.add(card.oracleId);
    picked.push(card);
    typeCount[card.type] = (typeCount[card.type] || 0) + 1;
    if (card.gameChanger) gameChangers++;
    if (card.extraTurn) extraTurns++;
    return true;
  };

  const nonbasicLands = pool.filter(c => c.type === "land" && !c.basic);
  const nonlands = pool.filter(c => c.type !== "land" && c.type !== "other");
  const landsPicked = () => typeCount.land || 0;
  const nonlandsPicked = () => picked.length - landsPicked();

  // Spells first, so the budget goes where nothing can stand in for a
  // missing card -- a basic can always take a land slot for free.
  const maximums = { ...(opts.roleMaximums || {}) };
  // A maximum below the minimum wins: "less draw" means less.
  const minimums = { ...ROLE_MINIMUMS, ...(opts.roleMinimums || {}) };
  for (const [role, max] of Object.entries(maximums)) if (minimums[role] > max) minimums[role] = max;
  const roleCount = role => picked.filter(c => hasRole(c, role)).length;
  // Whether one more of this card's roles would go past its maximum.
  function atRoleMax(card) {
    return (card.roles || []).some(r => maximums[r] != null && roleCount(r) >= maximums[r]);
  }

  // The player's swaps first, best score first. One the bracket can't take
  // (only possible if the pins themselves clash) is reported, not forced.
  const pinsDropped = [];
  for (const card of pool) {
    if (!pinnedIds.has(card.oracleId)) continue;
    const block = bracketBlock(card);
    if (block) { pinsDropped.push({ name: card.name, oracleId: card.oracleId, reason: block }); continue; }
    tryTake({ ...card, pinned: true }, true, true);
  }
  for (const allowOverBudget of [false, true]) {
    // Role minimums, best score first: they come before the type targets,
    // so a deck short on creatures still gets its removal. Same rules as
    // every other pick (Game Changer cap, bracket rules, budget -- the
    // over-budget pass only runs when the deck can't be filled otherwise).
    for (const role of ROLE_FILL_ORDER) {
      for (const card of nonlands) {
        if (roleCount(role) >= (minimums[role] || 0) || nonlandsPicked() >= shape.nonlandSlots) break;
        if (hasRole(card, role)) tryTake(card, allowOverBudget);
      }
    }
    // Nonland cards by type, then the best of whatever's left.
    if (shape.nonland) {
      for (const card of nonlands) {
        if (nonlandsPicked() >= shape.nonlandSlots) break;
        if ((typeCount[card.type] || 0) < (shape.nonland[card.type] || 0)) tryTake(card, allowOverBudget);
      }
    }
    for (const card of nonlands) {
      if (nonlandsPicked() >= shape.nonlandSlots) break;
      tryTake(card, allowOverBudget);
    }
    if (nonlandsPicked() >= shape.nonlandSlots) break;
  }
  // Nonbasic lands up to the average deck's count, never over budget. Then
  // owned ones past that count, since an owned nonbasic is worth more than a
  // basic -- but never past the land total.
  for (const card of nonbasicLands) {
    if (landsPicked() >= shape.nonbasic) break;
    tryTake(card, false);
  }
  for (const card of nonbasicLands) {
    if (landsPicked() >= shape.lands) break;
    if (card.status !== "missing") tryTake(card, false);
  }

  // Upgrades: the passes above take an owned card over a better one you'd
  // have to buy (that's the ownership bonus), so on their own a budget
  // would barely ever be spent. Here the budget buys the clearest
  // upgrades: best missing card first, swapped for the weakest owned card
  // of the same type, when it's better by at least UPGRADE_MARGIN on card
  // quality alone and its price still fits.
  if (budget > 0 && !overBudget) {
    const quality = card => scoreCard(card, "missing", { ...weights, pricePerDollar: 0 });
    const upgrades = pool
      .filter(c => c.status === "missing" && !taken.has(c.oracleId) && c.price != null && c.type !== "other" && !forbidden(c))
      .sort((a, b) => quality(b) - quality(a));
    for (const card of upgrades) {
      if (spent + card.price > budget + 1e-9) continue;
      let weakest = null;
      for (const p of picked) {
        // The player's own picks are never upgraded away.
        if (p.type !== card.type || p.status === "missing" || p.pinned) continue;
        if (card.gameChanger && !p.gameChanger && gameChangers >= rules.gameChangers) continue;
        if (card.extraTurn && !p.extraTurn && extraTurns >= rules.extraTurns) continue;
        // Never swap out a card a role minimum is leaning on, unless the
        // upgrade fills that role too.
        if ((p.roles || []).some(role => !hasRole(card, role) && roleCount(role) <= (minimums[role] || 0))) continue;
        // ...nor bring in a role that's already at its maximum.
        if ((card.roles || []).some(role => !hasRole(p, role) && maximums[role] != null && roleCount(role) >= maximums[role])) continue;
        if (!weakest || quality(p) < quality(weakest)) weakest = p;
      }
      if (!weakest || quality(card) - quality(weakest) < UPGRADE_MARGIN) continue;
      picked[picked.indexOf(weakest)] = { ...card, upgradeFor: weakest.name };
      taken.delete(weakest.oracleId);
      taken.add(card.oracleId);
      if (weakest.gameChanger) gameChangers--;
      if (card.gameChanger) gameChangers++;
      if (weakest.extraTurn) extraTurns--;
      if (card.extraTurn) extraTurns++;
      spent += card.price;
    }
  }

  // Basics fill the rest -- including any nonland slots EDHREC didn't have
  // enough cards for (shortBy says how many).
  const shortBy = Math.max(0, shape.nonlandSlots - nonlandsPicked());
  const basicCount = size - picked.length;
  const basics = splitBasics(basicCount, data.averageBasics, combinedIdentity(commanders));

  const tally = { free: 0, deck: 0, missing: 0, missingCost: 0, unknownPrices: 0 };
  for (const card of picked) {
    tally[card.status]++;
    if (card.status === "missing") {
      if (card.price == null) tally.unknownPrices++;
      else tally.missingCost += card.price;
    }
  }
  tally.free += basicCount;
  tally.missingCost = Math.round(tally.missingCost * 100) / 100;

  // Each role against its minimum; nonbasic lands count too (Boseiju is
  // removal wherever it was picked). A shortfall is reported, never
  // dropped: the pool (or the budget) just didn't have enough.
  const counts = roleCounts(picked);
  const roles = {};
  const roleShortfall = [];
  for (const role of Object.keys(ROLE_MINIMUMS)) {
    const min = minimums[role] || 0;
    roles[role] = { label: ROLE_LABELS[role], count: counts[role], min, max: maximums[role] ?? null, short: Math.max(0, min - counts[role]) };
    // Role cards the pool had but the deck left out (budget, Game Changer
    // cap, bracket rules): 0 means EDHREC's pool itself ran out.
    if (roles[role].short) roles[role].leftOut = nonlands.filter(c => hasRole(c, role) && !taken.has(c.oracleId)).length;
    if (roles[role].short) roleShortfall.push({ role, ...roles[role] });
  }

  return {
    commander: commanders[0] || data.commander,
    commanders,
    theme: data.theme && data.theme.slug ? { ...data.theme, name: data.theme.name || themeName(data.themes, data.theme.slug) } : null,
    colorIdentity: combinedIdentity(commanders),
    bracket,
    roles,
    roleShortfall,
    bracketName: rules.name,
    cards: picked,
    basics,
    tally,
    budget,
    overBudget,
    pinsOverBudget,
    pinsDropped,
    shortBy,
    tagsChecked: tagsChecked(data),
    checks: bracketChecks(picked, bracket, { tagsChecked: tagsChecked(data), commanders }),
    size: picked.length + basicCount,
  };
}

// The finished deck against its bracket. Every check has a status:
//   "pass" / "fail"  checked, and ok is true / false
//   "warn"           found something the player has to judge (Bracket 3's
//                    "early-game" combos); ok is null
//   "unchecked"      couldn't be checked (Tagger lists or Spellbook
//                    unavailable); ok is null, never shown as passing
//   "pending"        two-card combos only: Spellbook hasn't answered yet
// opts.tagsChecked: the candidates carry mass land denial / extra turn
// flags. opts.commanders: [{ name, cmc }] (opts.commander for one), so a
// combo using a commander gets a mana cost too. opts.combos: the relay's POST /deck-builder/combos answer --
// { checked: true, combos: [{ cards: [names], ... }] } or
// { checked: false, reason }; leave it out while the call is in flight.
function bracketChecks(cards, bracket, opts = {}) {
  const rules = BRACKET_RULES[bracket] || BRACKET_RULES[3];
  const names = list => list.map(c => c.name);
  const verdict = ok => ({ status: ok ? "pass" : "fail", ok });

  const gc = cards.filter(c => c.gameChanger);
  const checks = {
    gameChangers: { count: gc.length, cap: rules.gameChangers, ...verdict(gc.length <= rules.gameChangers), cards: names(gc) },
  };

  if (opts.tagsChecked) {
    const mld = cards.filter(c => c.massLandDenial);
    const turns = cards.filter(c => c.extraTurn);
    checks.massLandDenial = { count: mld.length, allowed: rules.massLandDenial, ...verdict(rules.massLandDenial || mld.length === 0), cards: names(mld) };
    checks.extraTurns = { count: turns.length, cap: rules.extraTurns, ...verdict(turns.length <= rules.extraTurns), cards: names(turns) };
  } else {
    checks.massLandDenial = { status: "unchecked", ok: null, cards: [] };
    checks.extraTurns = { status: "unchecked", ok: null, cards: [] };
  }

  checks.twoCardCombos = combosCheck(opts.combos, rules.twoCardCombos);
  checks.twoCardCombos.combos = checks.twoCardCombos.combos.map(c => ({
    ...c,
    manaCost: comboManaCost(c.cards, cards, opts.commanders || opts.commander),
  }));
  return checks;
}

// What a combo's cards cost to cast, added up -- the number that says how
// early it can come together. Names are matched against the deck (and the
// commander) case-insensitively; if any piece's mana value is unknown the
// total is null, never a guess.
function comboManaCost(names, cards, commanders) {
  const byName = new Map();
  for (const c of cards || []) if (c && c.name) byName.set(c.name.toLowerCase(), c.cmc);
  for (const c of [].concat(commanders || [])) if (c && c.name) byName.set(c.name.toLowerCase(), c.cmc);
  let total = 0;
  for (const name of names || []) {
    const cmc = byName.get(String(name).toLowerCase());
    if (cmc == null || !Number.isFinite(Number(cmc))) return null;
    total += Number(cmc);
  }
  return total;
}

function combosCheck(answer, rule) {
  if (answer === undefined) return { status: "pending", ok: null, rule, combos: [] };
  if (!answer || answer.checked !== true || !Array.isArray(answer.combos)) {
    return { status: "unchecked", ok: null, rule, combos: [], reason: answer && answer.reason };
  }
  const combos = answer.combos.filter(c => c && Array.isArray(c.cards) && c.cards.length === 2);
  const base = { rule, combos, count: combos.length };
  if (!combos.length || rule === "allowed") return { ...base, status: "pass", ok: true };
  if (rule === "early") return { ...base, status: "warn", ok: null };
  return { ...base, status: "fail", ok: false };
}

// The finished deck plus its commander(s), as the relay's POST
// /deck-builder/combos takes it: names only, basics left out (no combo
// needs them, and it keeps the request small). `commander` stays for the
// relay versions that only read one.
function comboRequest(build) {
  const names = (build.commanders && build.commanders.length ? build.commanders : [build.commander]).filter(c => c && c.name).map(c => c.name);
  return { commander: names[0] || null, commanders: names, cards: build.cards.map(c => c.name) };
}

// ---- Swaps ----
// The player can trade any card in a build for one of the next-best unused
// candidates. A swap is two lists -- pinned (swapped in) and excluded
// (swapped out) -- that every later buildDeck honors, so moving the budget
// or a toggle never undoes it.

const SWAP_OPTION_COUNT = 5;

// The best unused candidates to replace `card` in `build`: same type, and
// sharing a role with it when it has one. Each says whether the bracket
// allows it in place of `card` (blocked: a reason, or null) and which role
// minimum the trade would drop below (roleNote), which doesn't block it.
// Why the bracket won't take `incoming` into `build` in place of `outgoing`
// (a card leaving the deck, or null when nothing specific goes), or null if
// it will: the Game Changer cap, mass land denial, the extra-turn limit.
// Used by swaps and by picks from the player's collection.
function pickBlockReason(build, incoming, outgoing) {
  const rules = BRACKET_RULES[build.bracket] || BRACKET_RULES[3];
  const n = build.bracket;
  const gc = build.cards.filter(c => c.gameChanger).length;
  const turns = build.cards.filter(c => c.extraTurn).length;
  if (incoming.gameChanger && !(outgoing && outgoing.gameChanger) && gc >= rules.gameChangers) {
    return rules.gameChangers === 0
      ? `Bracket ${n} allows no Game Changers`
      : `Bracket ${n} allows ${rules.gameChangers} Game Changers, and the deck has ${gc}`;
  }
  if (incoming.massLandDenial && !rules.massLandDenial) return `Bracket ${n} allows no mass land denial`;
  if (incoming.extraTurn && !(outgoing && outgoing.extraTurn) && turns >= rules.extraTurns) {
    return rules.extraTurns === 0
      ? `Bracket ${n} allows no extra turns`
      : `Bracket ${n} allows one extra-turn card (no chaining)`;
  }
  return null;
}

function swapOptions(data, build, card, opts = {}) {
  const inDeck = new Set(build.cards.map(c => c.oracleId));
  const cardRoles = card.roles || [];
  const options = candidatePool(data, opts)
    .filter(c => c.type === card.type && !c.basic && !inDeck.has(c.oracleId) && c.oracleId !== card.oracleId)
    .filter(c => !cardRoles.length || cardRoles.some(r => hasRole(c, r)))
    .slice(0, SWAP_OPTION_COUNT);
  return options.map(c => {
    const blocked = pickBlockReason(build, c, card);
    const drops = cardRoles.filter(r => !hasRole(c, r) && build.roles && build.roles[r] && build.roles[r].count - 1 < build.roles[r].min);
    const roleNote = drops.length
      ? drops.map(r => `${build.roles[r].label} would drop to ${build.roles[r].count - 1} of ${build.roles[r].min}`).join("; ")
      : null;
    return { ...c, blocked, roleNote };
  });
}

// One swap applied to the pinned/excluded lists (plain arrays of oracle
// ids). Swapping out a card the player had pinned unpins it; swapping a
// card back in un-excludes it. outId null just adds inId (a collection pick
// with no particular card to replace: the builder drops its weakest).
function applySwap(swaps, outId, inId) {
  const pinned = new Set(swaps.pinned || []);
  const excluded = new Set(swaps.excluded || []);
  if (outId) {
    pinned.delete(outId);
    excluded.add(outId);
  }
  excluded.delete(inId);
  pinned.add(inId);
  return { pinned: [...pinned], excluded: [...excluded] };
}

// ---- Picks from the player's collection ----
// The relay's POST /deck-builder/collection-picks returns owned cards that
// aren't in EDHREC's list. The ones the player adds join the candidate pool
// here, owned, so buildDeck, swaps and the bracket checks treat them like
// any other card. Returns new data; the relay's answer is left untouched.
function mergeCollectionPicks(data, picks) {
  const known = new Set((data.candidates || []).map(c => c.oracleId));
  const extra = (picks || []).filter(p => p && p.oracleId && !known.has(p.oracleId)).map(p => ({
    uid: p.uid || null,
    name: p.name,
    oracleId: p.oracleId,
    type: p.type || "other",
    cmc: p.cmc ?? null,
    price: p.price ?? null,
    gameChanger: !!p.gameChanger,
    massLandDenial: !!p.massLandDenial,
    extraTurn: !!p.extraTurn,
    roles: p.roles || [],
    basic: false,
    synergy: null,
    inclusion: null,
    inAverageDeck: false,
    fromCollection: true,
  }));
  if (!extra.length) return data;
  const cards = { ...((data.collection && data.collection.cards) || {}) };
  for (const p of picks) {
    if (p && p.oracleId && !cards[p.oracleId]) cards[p.oracleId] = { qty: Math.max(1, Number(p.qty) || 1), decks: p.decks || [] };
  }
  return {
    ...data,
    candidates: [...(data.candidates || []), ...extra],
    collection: { ...(data.collection || {}), cards },
  };
}

// Plain "1 Card Name" lines, commander(s) first: the format Archidekt's (and
// most deck sites') text import reads.
function deckToText(build) {
  const lines = [];
  const commanders = build.commanders && build.commanders.length ? build.commanders : [build.commander];
  for (const c of commanders) if (c && c.name) lines.push(`1 ${c.name}`);
  const byType = [...build.cards].sort((a, b) => typeOrder(a.type) - typeOrder(b.type) || a.name.localeCompare(b.name));
  for (const card of byType) lines.push(`1 ${card.name}`);
  for (const b of build.basics) lines.push(`${b.count} ${b.name}`);
  return lines.join("\n");
}

const TYPE_ORDER = ["creature", "planeswalker", "battle", "instant", "sorcery", "artifact", "enchantment", "land", "other"];
function typeOrder(type) {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
}

if (typeof module !== "undefined") {
  module.exports = {
    DECK_BUILDER_DECK_SIZE, parseDeckRequest, readingToRequest, mergeDeckRequests, requestedMinimum, humanizeThemeSlug, themeName, themeOptions, deckBuilderSlug, deckCommanders, deckSize, combinedIdentity, pairingOf, secondCommanderKind, canPair, pairOrder,
    pickBlockReason, mergeCollectionPicks, wantsFolderName, missingCardsForWants, wantsHandoffUrl,
    snapshotBuildOptions, snapshotBuild, savedBuildTitle, savedBuildGroups, savedBuildToText,
    BRACKET_RULES, DEFAULT_WEIGHTS, ROLE_MINIMUMS, ROLE_LABELS, roleCounts, cardStatus, scoreCard, deckTemplate, splitBasics,
    buildDeck, candidatePool, swapOptions, applySwap, SWAP_OPTION_COUNT, bracketChecks, combosCheck, comboManaCost, comboRequest, tagsChecked, deckToText, typeOrder,
  };
}

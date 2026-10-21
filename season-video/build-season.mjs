// Pulls one season's trophies, decks and games out of the live D1 database
// (read-only SELECTs via wrangler) and writes season-data.js for index.html.
// Commander art is downloaded into assets/art/ because Hyperframes renders
// must not fetch from the network.
//
//   node build-season.mjs            -> most recently closed season
//   node build-season.mjs 3          -> a specific season id
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.join(here, "..", "cloudflare-worker");

// On Windows `npx` needs a shell, so the SQL is collapsed onto one line and
// double-quoted as a single argument (the queries only use single quotes).
function q(sql) {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const out = execFileSync(`npx wrangler d1 execute mtg-pod-validator-db --remote --json --command "${oneLine}"`, {
    cwd: workerDir, encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out)[0].results;
}

const arg = process.argv[2];
const season = arg
  ? q(`SELECT id, label, closed_at FROM seasons WHERE id = ${Number(arg)}`)[0]
  : q("SELECT id, label, closed_at FROM seasons WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 1")[0];
if (!season) throw new Error("No such season");
const sid = season.id;

// Trophy names/descriptions live in relay.js's ACHIEVEMENTS array, not in D1.
const relay = readFileSync(path.join(workerDir, "relay.js"), "utf8");
const block = relay.slice(relay.indexOf("const ACHIEVEMENTS = ["));
const defs = {};
for (const m of block.matchAll(/id: "([^"]+)",\s*category: "([^"]+)",\s*title: "([^"]+)",[\s\S]*?description: "([^"]+)"/g)) {
  defs[m[1]] = { category: m[2], title: m[3], description: m[4] };
}

const awards = q(`
  SELECT a.achievement_id id, p.name winner, a.display, rp.name runnerUp, a.runner_up_display runnerUpDisplay
  FROM season_awards a JOIN players p ON p.id = a.player_id
  LEFT JOIN players rp ON rp.id = a.runner_up_player_id
  WHERE a.season_id = ${sid}`).map((a) => ({ ...a, ...defs[a.id] }));

const decks = q(`
  SELECT d.name deck, p.name player, d.color_identity ci, d.commander_art_url art,
         count(*) played, sum(r.result) wins
  FROM game_results r JOIN games g ON g.id = r.game_id
  JOIN decks d ON d.id = r.deck_id JOIN players p ON p.id = r.player_id
  WHERE g.season_id = ${sid} GROUP BY d.id ORDER BY played DESC, wins DESC, d.name`);

const games = q(`
  SELECT g.game_num num, g.played_at date, g.pod_size pod, p.name winner, d.name deck,
         d.commander_art_url art, d.color_identity ci, r.knockouts kos
  FROM games g JOIN game_results r ON r.game_id = g.id AND r.result = 1
  JOIN players p ON p.id = r.player_id JOIN decks d ON d.id = r.deck_id
  WHERE g.season_id = ${sid} ORDER BY g.game_num`);

const players = q(`
  SELECT p.name, count(*) games, sum(r.result) wins, sum(r.knockouts) kos, sum(r.pop_off) popoffs
  FROM game_results r JOIN games g ON g.id = r.game_id JOIN players p ON p.id = r.player_id
  WHERE g.season_id = ${sid} GROUP BY p.id ORDER BY wins DESC, kos DESC`);

// Download each distinct art URL once.
const artDir = path.join(here, "assets", "art");
mkdirSync(artDir, { recursive: true });
const localArt = {};
for (const url of new Set([...decks, ...games].map((d) => d.art).filter(Boolean))) {
  const file = createHash("sha1").update(url).digest("hex").slice(0, 12) + ".jpg";
  const dest = path.join(artDir, file);
  if (!existsSync(dest)) {
    // Scryfall answers 400 without a User-Agent and Accept header.
    const res = await fetch(url, { headers: { "User-Agent": "mtg-pod-validator-season-video/1.0", Accept: "image/*" } });
    await new Promise((r) => setTimeout(r, 100)); // Scryfall asks for ~10 req/s max
    if (!res.ok) { console.warn("art failed", url); continue; }
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  localArt[url] = "assets/art/" + file;
}
for (const d of [...decks, ...games]) d.art = localArt[d.art] || null;

// Trophy emblems are the app's own art (emblems/<achievement id>.png at the
// repo root); copy the ones this season awarded next to the composition.
const emblemDir = path.join(here, "assets", "emblems");
mkdirSync(emblemDir, { recursive: true });
for (const a of awards) {
  const src = path.join(here, "..", "emblems", a.id + ".png");
  if (existsSync(src)) { copyFileSync(src, path.join(emblemDir, a.id + ".png")); a.emblem = "assets/emblems/" + a.id + ".png"; }
  else console.warn("no emblem for", a.id);
}

// A player's "signature" deck is the one they piloted most this season;
// it becomes the art on each trophy card they won.
const signature = {};
for (const d of decks) if (d.art && !signature[d.player]) signature[d.player] = { deck: d.deck, art: d.art, ci: d.ci };

const data = {
  season: { id: sid, label: season.label, first: games[0]?.date, last: games.at(-1)?.date },
  awards, decks, games, players, signature,
};
writeFileSync(path.join(here, "season-data.js"), "window.SEASON = " + JSON.stringify(data, null, 1) + ";\n");
console.log(`${season.label}: ${awards.length} trophies, ${decks.length} decks, ${games.length} games, ${Object.keys(localArt).length} art files`);

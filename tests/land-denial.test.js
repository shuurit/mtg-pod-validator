// Run with: node --test tests/*.test.js
// The land denial weighting in Player Adjusted Win Rate. That formula lives
// in three places (app.js, the relay, the Discord report) with no shared
// module between a browser script, a Worker and Python, so this pulls each
// copy straight out of its source file and checks they agree -- and that
// with no land denial games they still give exactly the old formula.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");

// The source of one top-level `function name(...) {...}` or `const name = ...;`.
function extract(src, name) {
  const fn = src.indexOf(`function ${name}(`);
  if (fn !== -1) {
    let depth = 0;
    for (let i = src.indexOf("{", fn); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(fn, i + 1);
    }
  }
  const decl = src.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
  if (decl) return decl[0];
  throw new Error(`${name} not found`);
}

function load(file, names, exportName) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const ctx = {};
  vm.runInNewContext(`${names.map(n => extract(src, n)).join("\n")}\nthis.out = ${exportName};`, ctx);
  return ctx.out;
}

const appPawr = load("app.js", ["LAND_DENIAL_WEIGHT", "computePlayerAdjustedWinRate"], "computePlayerAdjustedWinRate");
const relayPawr = load("cloudflare-worker/relay.js", ["LAND_DENIAL_WEIGHT", "gameWeight", "computePlayerAdjustedWinRate"], "computePlayerAdjustedWinRate");

// The formula exactly as it was before land denial existed.
function oldPawr(all) {
  const wins = all.filter(g => g.result === 1);
  const losses = all.filter(g => g.result === 0);
  const C = wins.length, D = losses.length;
  const F = wins.reduce((s, g) => s + g.J, 0);
  const avgJLosses = D ? losses.reduce((s, g) => s + g.J, 0) / D : 0;
  const G = (1 - (avgJLosses * -1)) * D;
  const H = (F + G) ? F / (F + G) : 0;
  const I = C ? all.reduce((s, g) => s + g.K, 0) / all.length : 0;
  const avgMWins = C ? wins.reduce((s, g) => s + g.M, 0) / C : 0;
  const Jagg = (1 - (avgMWins - 0.5)) * C;
  const avgMLosses = D ? losses.reduce((s, g) => s + g.M, 0) / D : 0;
  const Kagg = (1 + (avgMLosses - 0.5)) * D;
  const L = (Jagg + Kagg) ? Jagg / (Jagg + Kagg) : 0;
  return H * 0.3 + I * 0.2 + L * 0.5;
}

const game = (result, kos, diff, landDenial = false) => ({
  result, J: result - 0.25, K: ((kos - 0.75) + 5 / 6) / 5, M: 0.5 + diff * 0.09, landDenial,
});
const season = [game(1, 2, 0.4), game(0, 0, -0.3), game(0, 1, 0), game(0, 0, 0.8), game(1, 1, -0.5), game(0, 0, 0.1)];
// The relay's rows use lowercase j/k/m and the raw land_denial column.
const relayRow = g => ({ result: g.result, j: g.J, k: g.K, m: g.M, land_denial: g.landDenial ? 1 : 0 });
const relayRate = rows => relayPawr(rows.map(relayRow)).rate;

test("with no land denial games, the rate is exactly the old formula", () => {
  for (const rows of [[], [game(0, 0, 0)], [game(1, 3, 0)], season]) {
    assert.equal(appPawr(rows).B, oldPawr(rows));
    assert.equal(relayRate(rows), oldPawr(rows));
  }
});

test("a land denial game moves the rate about half as much as a normal one", () => {
  const before = appPawr(season).B;
  for (const result of [1, 0]) {
    const full = appPawr(season, game(result, 2, 0)).B - before;
    const half = appPawr(season, game(result, 2, 0, true)).B - before;
    assert.ok(Math.sign(half) === Math.sign(full), "same direction");
    assert.ok(Math.abs(half) < Math.abs(full) * 0.65 && Math.abs(half) > Math.abs(full) * 0.4,
      `half-weight move ${half} vs full ${full}`);
  }
});

test("a land denial win is still one whole win on the record", () => {
  const r = appPawr(season, game(1, 2, 0, true));
  assert.equal(r.wins, 3);
  assert.equal(r.losses, 4);
});

test("app.js and the relay agree with land denial games in the mix", () => {
  const rows = [...season, game(1, 3, 0.2, true), game(0, 0, -0.4, true)];
  assert.ok(Math.abs(appPawr(rows).B - relayRate(rows)) < 1e-12);
});

test("the Discord report agrees with app.js", (t) => {
  const rows = [...season, game(1, 3, 0.2, true), game(0, 0, -0.4, true), game(0, 1, 0)];
  let out;
  try {
    out = execFileSync("python3", ["-I", "-c", [
      // Just the constant and the function, not the whole module -- its
      // imports (matplotlib, requests) aren't needed to check the math.
      "import ast, json, sys",
      `src = open(${JSON.stringify(path.join(root, "scripts", "discord_report.py"))}).read()`,
      "keep = [n for n in ast.parse(src).body if getattr(n, 'name', None) == 'compute_pawr_from_rows'",
      "        or (isinstance(n, ast.Assign) and any(getattr(t, 'id', None) == 'LAND_DENIAL_WEIGHT' for t in n.targets))]",
      "ns = {}",
      "exec(compile(ast.Module(body=keep, type_ignores=[]), 'discord_report.py', 'exec'), ns)",
      "print(repr(ns['compute_pawr_from_rows'](json.load(sys.stdin))))",
    ].join("\n")], { input: JSON.stringify(rows) }).toString();
  } catch (err) {
    t.skip(`python3 isn't available: ${err.message.split("\n")[0]}`);
    return;
  }
  assert.ok(Math.abs(Number(out) - appPawr(rows).B) < 1e-12);
});

// Run with: node --test tests/*.test.js
// The pod range check judges each deck's power rounded to one decimal, the
// same way the app shows it, so a deck can't be flagged "Over by 0.0". The
// rounding lives in both app.js and relay.js (no shared module between a
// browser script and the Worker), so this pulls each copy out of its source
// file and checks they agree with the display and with each other.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function extract(src, name) {
  const fn = src.indexOf(`function ${name}(`);
  if (fn === -1) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = src.indexOf("{", fn); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(fn, i + 1);
  }
  throw new Error(`${name} unterminated`);
}

function load(file, names) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const ctx = {};
  vm.runInNewContext(names.map(n => extract(src, n)).join("\n") +
    `\n${names.map(n => `this.${n} = ${n};`).join("\n")}`, ctx);
  return ctx;
}

const app = load("app.js", ["formatPower", "rangePower"]);
const relay = load("cloudflare-worker/relay.js", ["rangePower"]);

const samples = [];
for (let i = 0; i <= 1200; i++) samples.push(i / 100, i / 100 + 0.0049, i / 100 + 0.05);
samples.push(7.35, 7.25, 6.95, 1.05, 2.45);

test("app.js and relay.js round power the same way", () => {
  for (const p of samples) assert.equal(app.rangePower(p), relay.rangePower(p), `power ${p}`);
});

test("judged power is exactly the number the app displays", () => {
  for (const p of samples) assert.equal(app.rangePower(p).toFixed(1), app.formatPower(p), `power ${p}`);
});

test("a deck shown exactly 1.0 above the floor is in range", () => {
  for (const floor of samples) {
    const f = relay.rangePower(floor);
    const top = relay.rangePower(f + 1 + 0.04);
    assert.ok(top <= f + 1, `floor ${floor} -> ${f}, deck ${top}`);
  }
  // The reported case: 7.34 against a 6.30 floor used to be "Over by 0.0".
  assert.ok(relay.rangePower(7.34) <= relay.rangePower(6.3) + 1);
});

test("anything flagged is over by at least 0.1 once displayed", () => {
  for (const floor of samples) {
    const f = relay.rangePower(floor);
    const deck = relay.rangePower(f + 1.1);
    const overBy = +Math.max(0, deck - (f + 1)).toFixed(2);
    assert.ok(deck > f + 1, `floor ${f}, deck ${deck}`);
    assert.equal(app.formatPower(overBy), "0.1");
  }
});

test("non-numeric power passes through untouched", () => {
  assert.equal(relay.rangePower(null), null);
  assert.equal(app.rangePower(undefined), undefined);
});

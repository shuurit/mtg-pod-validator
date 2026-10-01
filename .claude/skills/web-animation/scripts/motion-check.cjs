#!/usr/bin/env node
// Captures a page's motion over time and audits what keeps animating under
// prefers-reduced-motion: reduce. Sees CSS animations/transitions and Web
// Animations API animations (document.getAnimations()) and GSAP tweens
// (window.gsap's global timeline) -- GSAP drives inline styles from rAF, so
// getAnimations() alone never sees it.
//
// Usage:
//   NODE_PATH=<dir>/node_modules node motion-check.cjs <url> <outdir>
//     [--times 0,100,250,500,1000]  ms after load (or after --click) to sample
//     [--click <selector>]          click this first; times count from the click
//     [--width 390] [--height 844]  viewport (default: phone)
//     [--scheme light|dark]         prefers-color-scheme (default: light)
//
// Writes <outdir>/frame-<ms>.png (normal motion) and <outdir>/reduced.png
// (reduced motion, at the last sample time). Set CHROMIUM_PATH to launch a
// specific Chromium binary if Playwright's bundled one isn't installed.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const opts = { times: [0, 100, 250, 500, 1000], width: 390, height: 844, scheme: "light", click: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--times") opts.times = argv[++i].split(",").map(Number).sort((x, y) => x - y);
    else if (a === "--click") opts.click = argv[++i];
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--scheme") opts.scheme = argv[++i];
    else positional.push(a);
  }
  [opts.url, opts.outdir = "."] = positional;
  if (!opts.url) {
    console.error("usage: motion-check.cjs <url> <outdir> [--times ...] [--click sel] [--width n] [--height n] [--scheme light|dark]");
    process.exit(2);
  }
  return opts;
}

// Everything currently moving: CSS/WAAPI animations that are running, plus
// active GSAP tweens.
function listRunning(page) {
  return page.evaluate(() => {
    const describe = (el) => {
      if (!el || !el.tagName) return "?";
      let s = el.tagName.toLowerCase();
      if (el.id) s += "#" + el.id;
      if (el.classList && el.classList.length) s += "." + [...el.classList].join(".");
      return s;
    };
    const out = document.getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => {
        const effect = a.effect || {};
        const timing = effect.getTiming ? effect.getTiming() : {};
        const kind = a.animationName ? "css-animation" : a.transitionProperty ? "css-transition" : "waapi";
        return {
          kind,
          name: a.animationName || a.transitionProperty || a.id || "(anonymous)",
          duration: typeof timing.duration === "number" ? Math.round(timing.duration) : timing.duration,
          infinite: timing.iterations === Infinity,
          target: describe(effect.target) + (effect.pseudoElement || ""),
        };
      });
    if (window.gsap && window.gsap.globalTimeline) {
      for (const t of window.gsap.globalTimeline.getChildren(true, true, false)) {
        if (!t.isActive()) continue;
        out.push({
          kind: "gsap",
          name: (t.vars && t.vars.id) || "tween",
          duration: Math.round(t.duration() * 1000),
          infinite: t.repeat() === -1,
          target: (t.targets ? t.targets() : []).map(describe).join(", ") || "?",
        });
      }
    }
    return out;
  });
}

const fmt = (a) => `${a.kind} ${a.name} ${a.infinite ? "∞" : a.duration + "ms"} on ${a.target}`;

async function run(browser, opts, reduced) {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    colorScheme: opts.scheme,
    reducedMotion: reduced ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
  await page.goto(opts.url, { waitUntil: "load" });
  if (opts.click) await page.click(opts.click);
  const t0 = Date.now();
  const samples = [];
  for (const t of opts.times) {
    const wait = t - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const isLast = t === opts.times[opts.times.length - 1];
    if (!reduced) await page.screenshot({ path: path.join(opts.outdir, `frame-${t}.png`) });
    else if (isLast) await page.screenshot({ path: path.join(opts.outdir, "reduced.png") });
    samples.push({ t, running: await listRunning(page) });
  }
  await context.close();
  return samples;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outdir, { recursive: true });
  const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  const browser = await chromium.launch(launch);
  try {
    for (const reduced of [false, true]) {
      console.log(`\n== ${reduced ? "prefers-reduced-motion: reduce" : "normal motion"} ==`);
      const samples = await run(browser, opts, reduced);
      for (const { t, running } of samples) {
        console.log(`  @${t}ms: ${running.length ? "" : "nothing running"}`);
        for (const a of running) console.log(`    ${fmt(a)}`);
      }
      if (reduced) {
        const seen = new Set();
        const last = samples[samples.length - 1].running;
        const flagged = samples.flatMap((s) => s.running).filter((a) => a.infinite).concat(last);
        for (const a of flagged) {
          const key = fmt(a);
          if (seen.has(key)) continue;
          seen.add(key);
          console.log(`⚠ still animating under reduced motion: ${key}`);
        }
        if (!seen.size) console.log("✓ nothing loops or lingers under reduced motion");
      }
    }
    console.log(`\nframes written to ${path.resolve(opts.outdir)}`);
  } finally {
    await browser.close();
  }
})();

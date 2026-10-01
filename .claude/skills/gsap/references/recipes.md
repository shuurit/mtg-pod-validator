# GSAP recipes

Each recipe assumes the content is already rendered in its final state,
and does nothing if GSAP isn't loaded or reduced motion is on.
`REDUCED_MOTION` is `matchMedia("(prefers-reduced-motion: reduce)")`,
defined once near the top of `app.js`.

## 1. Loader: vendored, lazy, never rejects

```js
// GSAP is vendored under vendor/ and loaded only when a "moment" might
// play -- most visits never need it, so phones don't parse it up front.
// Resolves to null instead of rejecting on failure (offline at the table,
// since sw.js doesn't cache vendor/), so callers just skip the animation.
const GSAP_DIR = "vendor/gsap-3.15.0/";
const loadingScripts = new Map();

function loadScript(src) {
  if (!loadingScripts.has(src)) {
    loadingScripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        loadingScripts.delete(src); // allow a retry on the next call
        reject(new Error(`failed to load ${src}`));
      };
      document.head.appendChild(s);
    }));
  }
  return loadingScripts.get(src);
}

async function loadGsap(plugins = []) {
  try {
    await loadScript(GSAP_DIR + "gsap.min.js");
    await Promise.all(plugins.map(p => loadScript(`${GSAP_DIR}${p}.min.js`)));
    window.gsap.registerPlugin(...plugins.map(p => window[p]));
    return window.gsap;
  } catch {
    return null;
  }
}

// Warm it during idle time once a moment becomes possible -- never await
// this on the way to showing something.
function warmGsap(plugins) {
  const idle = window.requestIdleCallback || (cb => setTimeout(cb, 300));
  idle(() => loadGsap(plugins));
}
```

## 2. Closing Ceremony step: a timeline with overlaps

Call this at the end of `renderCeremonyStep()`, in the same task that
built the step's DOM.

```js
let ceremonyTl = null;

function playCeremonyStep(step) {
  ceremonyTl?.kill(); // rapid next/prev taps: never stack timelines
  ceremonyTl = null;
  const g = window.gsap;
  if (!g || REDUCED_MOTION.matches) return;

  const reset = "transform,opacity,visibility"; // never "all" -- see SKILL.md rule 3
  ceremonyTl = g.timeline({ defaults: { duration: 0.35, ease: "power3.out", clearProps: reset } })
    .from(step.querySelector(".ceremony-art"), { autoAlpha: 0, scale: 0.9, y: 16, ease: "back.out(1.6)" })
    .from(step.querySelector(".ceremony-trophy-title"), { autoAlpha: 0, y: 10 }, "-=0.15")
    .from(step.querySelector(".ceremony-winner"), { autoAlpha: 0, y: 8 }, "-=0.2");
}
```

The `.ceremony-art` foil sweep stays in CSS. GSAP only brings the frame
in.

## 3. Reveal grid: stagger

```js
function playRevealGrid(grid) {
  const g = window.gsap;
  if (!g || REDUCED_MOTION.matches) return;
  g.from(grid.children, {
    autoAlpha: 0,
    y: 12,
    duration: 0.3,
    ease: "power2.out",
    stagger: { each: 0.05, from: "start" },
    clearProps: "transform,opacity,visibility",
  });
}
```

Keep the total stagger under about 0.4s (8 items at 0.05). For bigger
grids, use `stagger: { amount: 0.4 }` so the total stays fixed.

## 4. Flip: animate a re-sort (Win Rates cards)

Flip records positions, you rebuild the DOM, and Flip animates the
difference. It matches old and new elements by `data-flip-id`, so it
works even though `renderWinRatesTable` rebuilds the cards from scratch.
Rows are keyed by player name, so use that.

```js
// In buildWinRateCard: card.dataset.flipId = row.name;

function resortWithFlip(container, rerender) {
  const g = window.gsap, Flip = window.Flip;
  if (!g || !Flip || REDUCED_MOTION.matches) { rerender(); return; }
  const state = Flip.getState(container.querySelectorAll("[data-flip-id]"));
  rerender(); // must keep the same data-flip-id values
  Flip.from(state, {
    targets: container.querySelectorAll("[data-flip-id]"),
    duration: 0.35,
    ease: "power2.inOut",
    stagger: 0.015,
  });
}
```

Only use this for a user-initiated re-sort (a tap on the sort bar),
never for a data refresh, per web-animation rule 7. Load the plugin with
`loadGsap(["Flip"])`.

## 5. Count-up for a stat numeral

The real number is in the DOM first. GSAP only animates the displayed
text towards it, so a skipped or killed tween still shows the right
value.

```js
function countUp(el, to) {
  el.textContent = String(to);
  const g = window.gsap;
  if (!g || REDUCED_MOTION.matches) return;
  const counter = { v: 0 };
  g.to(counter, {
    v: to,
    duration: 0.6,
    ease: "power2.out",
    snap: { v: 1 },
    overwrite: "auto",
    onUpdate: () => { el.textContent = String(counter.v); },
    onComplete: () => { el.textContent = String(to); },
    onInterrupt: () => { el.textContent = String(to); },
  });
}
```

Give the element `font-variant-numeric: tabular-nums` so its width
doesn't jitter.

## 6. Modal-scoped context with cleanup

Everything created inside the context is reverted (killed, and inline
styles restored) in one call. Needed for any `repeat: -1` inside a
modal, because GSAP doesn't stop on `display: none` the way CSS
animations do.

```js
let revealCtx = null;

function playRevealModalMotion(modal) {
  revealCtx?.revert();
  const g = window.gsap;
  if (!g || REDUCED_MOTION.matches) return;
  revealCtx = g.context(() => {
    g.from(".modal-card", { autoAlpha: 0, y: 14, scale: 0.98, duration: 0.25, ease: "power3.out" });
    // selector text is scoped to `modal` by the context's second argument
  }, modal);
}

// in hideRevealModal():
revealCtx?.revert();
revealCtx = null;
```

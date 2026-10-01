---
name: gsap
description: "GSAP (GreenSock) animation in this no-build static app. Covers timelines and the position parameter, staggers, eases, Flip layout animation, gsap.context cleanup, reduced motion, and how to add GSAP (vendored, version-pinned, lazy-loaded, offline-safe). Use when a motion needs choreography that CSS makes awkward (Ready to Play reveal, Closing Ceremony steps, trophy moments), when animating a list re-sort or layout change (Flip), when the user mentions GSAP, GreenSock, timeline, tween, Flip, stagger, ScrollTrigger, or SplitText, or before adding GSAP to index.html or app.js. Load web-animation first for the shared motion rules."
---

# GSAP for Amass a Gathering

Read **web-animation** first. Its hard rules (reduced motion, the end
state never depending on an animation, no full-viewport layers, no
animating `.card`, loops rare and scoped) apply to GSAP exactly as they
do to CSS.

Recipes with copy-ready code are in
[references/recipes.md](references/recipes.md): loader, ceremony step
timeline, reveal stagger, Flip re-sort, count-up, and modal-scoped
context.

## When GSAP earns its place

Use GSAP only for what CSS does badly:

- **Choreography**: several elements in sequence with overlaps, such as
  a ceremony step (emblem, then title, then winner) or the reveal grid. A
  timeline with the position parameter (`"-=0.15"`, `"<"`, labels)
  replaces fragile `animation-delay` arithmetic.
- **Layout change**: re-sorting the Win Rates cards (`buildSortBar` →
  `renderWinRatesTable`) or re-ordering anything. **Flip** animates
  elements from their old position to their new one, even when the DOM
  was rebuilt.
- **Interruptible motion**: rapid next/prev taps in the ceremony, or
  anything that reverses or gets killed mid-flight.
- **Values**: animating to a measured or computed number (count-ups,
  gauge needles).

Hover, focus, press, loops (sweeps, shimmer, spinner, glow) and simple
single enter/exit stay in **CSS** (css-animation), even once GSAP is
loaded.

Don't use in this app: **ScrollTrigger** scroll-storytelling,
**ScrollSmoother**, or `ScrollTrigger.normalizeScroll()`. The pages are
short phone screens, and anything that takes over touch scrolling fights
`initPullToRefresh()`'s touch handlers and the `--app-vh` measurement in
`syncViewportHeight()`. SplitText is acceptable for one heading in a
ceremony moment, never for body copy, and its result must be reverted
afterwards so screen readers get the plain text back.

## Adding GSAP (first time only)

GSAP isn't in the app yet. When the first GSAP animation lands:

1. **Vendor it, version-pinned. Don't use a CDN.** The npm registry is
   the source:

   ```bash
   V=3.15.0   # check `npm view gsap version` for the newest 3.x
   npm pack gsap@$V --silent
   tar xzf gsap-$V.tgz package/dist/gsap.min.js package/dist/Flip.min.js   # only the plugins you use
   mkdir -p vendor/gsap-$V && mv package/dist/*.min.js vendor/gsap-$V/
   rm -rf package gsap-$V.tgz
   ```

   Why: it's same-origin, so a CDN outage or a blocked third-party host
   at the table can't break it. The version in the path makes the URL
   immutable, so it needs no `?v=N`. Only the plugins actually used ship.
   GSAP, all plugins included, is free under its Standard "no charge"
   licence. Keep the licence header in the `.min.js` files. Add
   `vendor/` to the "Repo layout" list in `README.md`.
2. **Lazy-load it, off the critical path.** Don't put a `<script>` for it
   in `index.html`. Most visits never play a "moment", and phones
   shouldn't parse ~73 KB up front. Use the `loadGsap()` helper (recipe 1)
   and warm it during idle time once a moment becomes possible, e.g. when
   the deal UI or the Trophies tab initialises.
3. **Play only if it's ready. Never wait for it.** At the moment of
   animating: `const g = window.gsap; if (!g || REDUCED_MOTION.matches)
   return;`. The content is already rendered in its final state, so a
   skipped animation still leaves correct UI. `sw.js` doesn't cache
   `vendor/` (and shouldn't), so offline means no GSAP, and that has to
   be fine.

## Rules

1. **Never hide content in CSS for GSAP to reveal.** No `opacity: 0` in
   the stylesheet waiting on a tween. If GSAP doesn't load, that content
   stays invisible. Render the final state, then animate **from** an
   offset with `gsap.from()` / `fromTo()`.
2. **Call `from()` in the same task that built the DOM**, before the
   browser paints, never after an `await`. Otherwise the end state paints
   for a frame and then jumps back to the start.
3. **`clearProps` only what you animated**:
   `clearProps: "transform,opacity,visibility"` (`autoAlpha` sets
   opacity and visibility). **Never `"all"`**, because it wipes every
   inline style, including the app's own: `bar.style.background` and
   `style.flexGrow` on the reveal colour strip, `--reveal-img-height`
   from `showRevealModal`. This was verified in testing: `clearProps:
   "all"` made a styled element vanish.
4. **Kill before re-rendering.** Keep the timeline in a variable. Before
   building the next ceremony step, call `tl?.kill()` (or
   `tl?.progress(1).kill()` if the old DOM stays) so rapid taps don't
   stack tweens.
5. **Scope modal animations with `gsap.context(fn, modalEl)`** and call
   `ctx.revert()` in the hide function (`hideRevealModal`,
   `hideClosingCeremonyModal`). Unlike CSS animations, **GSAP keeps
   ticking on `display: none` elements**, so a `repeat: -1` left running
   in a closed modal burns battery forever.
6. **Transforms, not layout.** Use `x`, `y`, `scale`, `rotation` and
   `autoAlpha`, never `left`, `top`, `width` or `height`. The `.card` rule
   from web-animation applies: animate content inside a `.card`, never the
   `.card` itself.
7. **`overwrite: "auto"`** on tweens that can retrigger on the same
   element (a pulse on re-render, a hover-driven tween).
8. **Reduced motion.** For one-shot moments, check
   `REDUCED_MOTION.matches` at play time and skip. For anything set up
   once and left running, use
   `gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", …)`,
   which reverts automatically if the setting changes.
9. **Durations are in seconds.** `duration: 300` is five minutes. Map
   from the web-animation timing table: enter 0.2–0.35, exit about 70% of
   that, layout move 0.3–0.4, stagger 0.03–0.06.
10. **Eases**: `power2.out`/`power3.out` for entrances, `power2.in` for
    exits, `power2.inOut` for Flip moves, `sine.inOut` for loops,
    `back.out(1.4–1.7)` for celebration moments only, and `none` for
    linear.

## Verify

The web-animation **motion-check** script sees GSAP tweens (it reads
`gsap.globalTimeline`, since GSAP is invisible to
`document.getAnimations()`). It flags any tween still running under
reduced motion. In the scratch harness, load GSAP the way the app will:

```html
<!-- once vendored -->
<script src="http://localhost:8765/vendor/gsap-3.15.0/gsap.min.js"></script>
<!-- before vendoring: npm i --prefix "$S/pw" gsap@3.15.0, then -->
<script src="file:///<scratch>/pw/node_modules/gsap/dist/gsap.min.js"></script>
```

Always look at the **end frame**. A wrong `clearProps`, a killed
timeline, or a `from()` that never ran all show up there, not mid-motion.

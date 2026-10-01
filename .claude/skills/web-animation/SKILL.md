---
name: web-animation
description: "Shared motion rules for this app's front end. Load first for any animation work, whether CSS or GSAP. Use before adding or changing anything that moves, fades, or changes over time: hover/press effects, enter/exit, reveals, loading states, \"moments\" like the Ready to Play reveal, Closing Ceremony, or trophies, count-ups, expand/collapse, list re-sorts, or anything described as \"animate\", \"transition\", \"fade\", \"slide\", \"shine\", \"glow\", \"pulse\", or \"make it feel alive\". Covers when motion belongs at all, CSS versus GSAP, timing and easing, the hard rules learned from real-device bugs, and the motion-check tool for verifying it. Then load css-animation or gsap for the how-to."
---

# Web animation for Amass a Gathering

Motion here has three jobs, in priority order:

1. **Feedback.** A control acknowledges hover, press or focus (0.05–0.2s).
2. **Orientation.** Something appears, disappears, moves or re-orders,
   and the eye should follow it (0.15–0.35s).
3. **Moments.** Rare, earned celebrations: the Ready to Play reveal, the
   Closing Ceremony, prestige trophies. The app's signature here is the
   **foil sweep**, light catching a foil card.

Motion is **not** used for routine navigation. Tab switches are instant
on purpose (rule 3). If an animation doesn't do one of the three jobs,
leave it out.

## CSS or GSAP?

| Use **CSS** (load css-animation) | Use **GSAP** (load gsap) |
|---|---|
| hover, focus, press | multi-step choreography with overlaps (ceremony step, reveal grid) |
| loops: sweeps, shimmer, spinner, glow | layout changes: re-sorting or re-ordering cards (Flip) |
| a single enter or exit | sequences that get interrupted, reversed or scrubbed |
| expand/collapse | animating to or from a measured or computed value |

Default to CSS. Bring in GSAP only when the CSS version would need
chained `animation-delay` arithmetic, JS timers, or manual FLIP maths.
GSAP isn't in the app yet, and the gsap skill covers adding it properly
(vendored and lazy-loaded). For one-off JS motion without GSAP (count-up,
a Web Animations API pulse), see
[references/js-recipes.md](references/js-recipes.md).

## Timing and easing

| Kind | Duration | CSS easing | GSAP ease |
|---|---|---|---|
| press (`:active` nudge) | 0.05s | `ease` | n/a |
| hover/focus colour, border, shadow | 0.1–0.15s | `ease` | n/a |
| small size settle | 0.2s | `ease` | `power1.out` |
| enter (modal, panel, revealed item) | 0.15–0.25s | `ease-out` / `cubic-bezier(0.2,0.8,0.2,1)` | `power2.out`/`power3.out` |
| exit | ~70% of the enter duration | `ease-in` | `power2.in` |
| layout move (re-sort) | 0.3–0.4s | n/a | `power2.inOut` |
| stagger step | 30–60ms, capped at ~8 items' worth | n/a | `stagger: 0.05` |
| spinner | 0.8s | `linear` | `none` |
| attention loop | 1.2–1.6s | `ease-in-out` | `sine.inOut` |
| decorative sweep loop | 3–3.2s with an idle hold | `ease-in-out` | n/a (keep in CSS) |

Overshoot (`back.out(1.6)` / `cubic-bezier(0.34,1.56,0.64,1)`) is for
celebration moments only. GSAP durations are in **seconds**, CSS in
`s` or `ms`. Don't mix them up.

## Hard rules

These come from real bugs in this app. They apply to CSS and GSAP alike.

1. **Respect `prefers-reduced-motion: reduce`, everywhere.** In CSS, put
   an override block right after each animated rule. In JS or GSAP, check
   `REDUCED_MOTION.matches` (a `matchMedia` defined once in `app.js`) and
   jump to the end state. A progress indicator must still show progress;
   it just shouldn't spin or slide.
2. **The end state never depends on an animation finishing.**
   `animationend` and `transitionend` don't fire if the element is hidden,
   removed, or the animation is skipped. `requestAnimationFrame` (and
   therefore GSAP's ticker) pauses in a backgrounded tab.
   `syncViewportHeight()` in `app.js` was stuck for exactly this reason.
   Always pair the event with a `setTimeout` safety net calling an
   idempotent `finish()`, and never hide content in CSS waiting for JS to
   reveal it.
3. **No full-viewport animated layers.** The `.tab-bg` crossfade between
   tab artworks was removed after a visible rendering glitch in Brave.
   Two fixed, full-screen, GPU-forced layers fading at once was too much
   compositor work. Don't reintroduce background crossfades, parallax,
   View Transitions on tab switch, or scroll-driven full-page effects.
4. **Move things with `transform` and `opacity` only.** Never animate
   `width`, `height`, `top`, `left` or `margin` on anything sizeable.
5. **Don't animate `.card`, or anything large behind one.** `.card` has
   `backdrop-filter: blur(30px)`, so moving or fading it forces the blur
   to recompute every frame, which is slow on phones. Animate the content
   inside it.
6. **Infinite loops are rare and scoped**: inside a "moment" or on a
   single call to action, never on every row of a list. Desynchronise
   identical loops shown together, and stop attention loops once they've
   worked (as `.glow` is removed from `#validate-btn`).
7. **Entrances are for user-initiated reveals, not data refreshes.**
   Pull-to-refresh and tab-focus refetches re-render lists, so those must
   not replay entrance animations.
8. **Hover-triggered motion also triggers on `:focus-visible` or
   `:focus-within`.** Touch has no hover, so motion is never the only way
   information is shown.
9. **No libraries other than GSAP.** No anime.js, Motion or Lottie.
   There's no build step, and CSS plus GSAP covers everything. GSAP itself
   is vendored and lazy-loaded (see gsap), never from a CDN in the
   critical path.

After changing CSS or JS, bump `?v=N` for `style.css` / `app.js` in
`index.html` (see web-design).

## Verify it: motion-check

Static screenshots can't show motion. `scripts/motion-check.cjs` captures
frames over time and audits CSS animations, transitions, Web Animations
API animations **and GSAP tweens**, under both normal and reduced
motion:

```bash
python3 -m http.server 8765 &      # repo root, as in .claude/launch.json
S=<your scratchpad>
npm i --prefix "$S/pw" playwright@1 >/dev/null 2>&1
NODE_PATH="$S/pw/node_modules" node .claude/skills/web-animation/scripts/motion-check.cjs \
  "file://$S/harness.html#dark" "$S/motion" \
  --times 0,150,400,900 --click "#trigger"   # --click is optional
```

- Host the component in the web-design harness
  (`.claude/skills/web-design/harness.html`, copied to scratch), since
  the live page is behind sign-in. Add a `<button id="trigger">` that
  starts the animation.
- If Playwright complains its browser "doesn't exist", point it at an
  installed Chromium with `CHROMIUM_PATH=…`. In Claude Code cloud
  sessions that's `/opt/pw-browsers/chromium`. Locally, run
  `npx playwright install chromium` once.
- Output: `frame-<ms>.png` per sample, `reduced.png`, a list of what's
  running at each sample, and a **`⚠ still animating under reduced
  motion`** line for anything looping or still running at the last
  sample. Each warning needs a fix, or a comment explaining why it's
  deliberate.

Read the frames back and look at them: the right start state, the end
state landing, and nothing left half-faded or missing. Check the **end
frame** especially. It's where a bad `clearProps` or a stuck class
shows up.

---
name: css-animation
description: "CSS transitions and @keyframes in this app's style.css: hover/focus/press feedback, the foil-sweep and shine effects, loading shimmers and spinners, attention glows, modal/panel enter and exit with the hidden attribute, staggered reveals, and expand/collapse. Use whenever writing or editing a `transition`, `animation`, `@keyframes`, `@starting-style`, or a `prefers-reduced-motion` block, or when asked for a CSS-only effect. Load web-animation first for the shared motion rules; use the gsap skill instead for multi-step choreography or layout (Flip) animation."
---

# CSS animation in style.css

CSS is the default tool here. Hover, focus, press, loops (sweeps,
shimmer, spinner, glow) and simple single enter/exit all stay in CSS,
even once GSAP is in the app. Read **web-animation** first: its hard
rules (reduced motion, the end state, no full-viewport layers, no
animating `.card`) apply to everything below.

Copy-ready patterns are in [references/recipes.md](references/recipes.md):
foil sweep, hover-and-focus shine, modal enter, exit-then-hide, stagger,
and expand/collapse.

## Existing keyframes: reuse before adding

Run `grep -n "@keyframes" style.css` to see the current set:

| Keyframes | What it is | Used by |
|---|---|---|
| `reveal-foil-sweep` | light band crosses, then idles (`0%,40%` / `60%,100%`) | reveal art, fallback art, `.tc-prestige-3` (3–3.2s, infinite) |
| `power-chip-shine` | single sweep | `.power-chip::after` on `.power-cell` `:hover` **and** `:focus-within` |
| `skeleton-shimmer` | loading sweep (not a pulse, so cards don't flash in sync) | `.skeleton-card::after` (1.6s) |
| `global-refresh-spin` | 360° rotation | `.pull-refresh.refreshing` (0.8s linear; replaced by a static "Refreshing…" label under reduced motion) |
| `recheck-glow` | breathing `box-shadow` call to action | `button.primary.glow` (1.4s), on Check Deck Power Spread and on Calculate once a Games to Update preview goes stale. JS removes `.glow` once acted on; a static warn ring replaces it under reduced motion. |
| `tab-bg-leave` | outgoing tab artwork fades out over the already-visible incoming one | `.tab-bg.tab-bg-leaving` (0.25s, once). Only ever one layer; see web-animation rule 3. |
| `tab-content-in` | 6px rise plus fade, `from` frame only | `.tab-panel.tab-entering > .card > *` and `#tonight-body > *` (0.2s). Animates content inside cards, never the `.card`. |

Name new keyframes `<component>-<verb>` (e.g. `modal-card-in`), and put
them directly under the rule that first uses them, with the
reduced-motion block right after, as the existing ones are.

## The foil sweep

This is the app's signature effect: light catching a foil card. On a
host with `position: relative; overflow: hidden`, add an absolutely
positioned `::after` with `pointer-events: none` and
`linear-gradient(115deg, transparent 40%, rgba(255,255,255,0.55) 50%, transparent 60%)`.
Start it at `transform: translateX(-160%)` and animate the `transform`
only. Lower the white's alpha (0.22–0.35) on small or muted surfaces.
Keep the foil sweep for "moments" (the reveal, the ceremony, top-tier
trophies); everyday UI gets the one-shot `power-chip-shine` on
hover/focus at most.

## Reduced motion, by kind

Put a `@media (prefers-reduced-motion: reduce)` block **directly after**
each animated rule, not collected at the end of the file:

| Kind | Under reduced motion |
|---|---|
| decorative `::after` sweep or shine | `display: none` |
| enter or exit | swap to a short opacity-only fade, or `animation: none` |
| attention loop (`recheck-glow`) | `animation: none`, plus a static cue (outline or colour) so the prompt survives |
| spinner or progress | keep a signal without rotation: static icon plus text, or a slow opacity pulse |
| hover colour or border transition | leave it; colour fades aren't vestibular motion |

For the spinner pattern, copy `.pull-refresh.refreshing`: under reduced
motion the icon stops (`animation: none`) and an `::after` label
("Refreshing…") takes over the signal.

## The `hidden` attribute and display: none

Many panels toggle with `el.hidden`, and rules like
`.modal-overlay[hidden] { display: none; }`. Two consequences:

- **A `transition` can't run on show**, because there's no previous
  rendered style to transition from. Instead, use a keyframe `animation`
  on `:not([hidden])`, which starts when the element renders (recipe 3),
  or `@starting-style`, which needs Safari 17.5+. Fine as progressive
  enhancement, since older browsers just skip the fade.
- **Exit needs JS**: add `.closing`, wait for `animationend` **plus a
  `setTimeout` safety net**, then set `hidden` (recipe 4). CSS animations
  on a `display: none` element stop by themselves, so nothing leaks after
  hiding.

Write enter keyframes with only a `from` frame. The element animates to
its normal styles, so if the animation is skipped (reduced motion,
unsupported) the end state is still correct.

## Performance on phones

- Animate `transform` and `opacity`. `box-shadow`, `border-color` and
  `background-color` are fine on single small controls (buttons, chips),
  but never on every row of a list.
- Don't add `will-change` broadly. The existing `translateZ(0)` on fixed
  layers is a targeted WebKit fix, not a performance habit to copy.
- Expand/collapse uses the `grid-template-rows: 0fr → 1fr` recipe, not a
  `height` or `max-height` transition.
- Several identical loops on screen at once get a per-item negative
  `animation-delay` (via a custom property, since you can't style
  `::after` from JS) so they don't run in lockstep.

## Verify

Use the motion checker described in **web-animation**. It lists every
running CSS animation and transition, and flags anything still moving
under reduced motion.

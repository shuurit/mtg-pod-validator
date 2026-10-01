# CSS animation recipes

Copy-ready patterns matching this app's conventions. Each carries its own
reduced-motion handling, so keep it when you copy one. `REDUCED_MOTION`
is `matchMedia("(prefers-reduced-motion: reduce)")`. Define it once
near the top of `app.js` (beside `RELAY_BASE_URL`) if it isn't there
yet. Don't redefine it per function.

## 1. Foil sweep on a new surface (looping, decorative)

For a "moment" surface only: reveal tiles, top-tier trophies.

```css
.my-foil {
  position: relative;
  overflow: hidden;
  border: 1.5px solid var(--foil);
  border-radius: var(--radius-md);
}
.my-foil::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(115deg, transparent 40%, rgba(255, 255, 255, 0.55) 50%, transparent 60%);
  transform: translateX(-160%);
  animation: reveal-foil-sweep 3s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .my-foil::after { display: none; }
}
```

Several on screen at once: desync them so they don't sweep in lockstep.
A pseudo-element can't be styled from JS, so pass the offset through a
custom property on its host:

```js
tile.style.setProperty("--sweep-offset", `${-i * 0.45}s`);
```

```css
.my-foil::after { animation-delay: var(--sweep-offset, 0s); }
```

## 2. One-shot shine on hover *and* focus

The `power-chip-shine` pattern. The hover target is the containing cell,
so keyboard and touch users landing anywhere in it get the same effect.

```css
.thing::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(120deg, transparent 35%, rgba(255, 255, 255, 0.65) 50%, transparent 65%);
  transform: translateX(-140%);
  opacity: 0;
}
.thing-cell:hover .thing::after,
.thing-cell:focus-within .thing::after {
  opacity: 1;
  animation: power-chip-shine 0.9s ease-in-out;
}
@media (prefers-reduced-motion: reduce) {
  .thing::after { display: none; }
}
```

## 3. Modal or panel enter (works with the `hidden` attribute)

`transition` can't run out of `display: none`. A keyframe animation does
run when the element starts rendering.

```css
.modal-overlay:not([hidden]) {
  animation: overlay-in 0.18s ease-out;
}
.modal-overlay:not([hidden]) .modal-card {
  animation: modal-card-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes overlay-in { from { opacity: 0; } }
@keyframes modal-card-in { from { opacity: 0; transform: translateY(12px) scale(0.98); } }

@media (prefers-reduced-motion: reduce) {
  .modal-overlay:not([hidden]) .modal-card { animation: overlay-in 0.12s ease-out; } /* fade only */
}
```

`from`-only keyframes animate to the element's normal style, so nothing
gets stuck if the animation is skipped.

## 4. Exit, then hide (the end state must not depend on the event)

```js
// Plays the .closing exit animation, then sets hidden -- always, even if
// animationend never fires (reduced motion, element already hidden, tab
// backgrounded), via the timeout safety net. Same idempotent-finish shape
// as syncViewportHeight.
function hideWithExit(el, ms = 160) {
  if (!el || el.hidden) return;
  if (REDUCED_MOTION.matches) { el.hidden = true; return; }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.classList.remove("closing");
    el.hidden = true;
  };
  el.addEventListener("animationend", finish, { once: true });
  setTimeout(finish, ms + 100);
  el.classList.add("closing");
}
```

```css
.modal-overlay.closing { animation: overlay-out 0.16s ease-in forwards; }
@keyframes overlay-out { to { opacity: 0; } }
```

If the user can re-open during the exit, have the open path call
`el.classList.remove("closing")` first.

## 5. Staggered entrance for a user-initiated reveal

Only for reveals the user triggered, never on refetch re-renders.

```js
items.forEach((node, i) => node.style.setProperty("--i", Math.min(i, 8)));
```

```css
.reveal-item {
  animation: reveal-item-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
  animation-delay: calc(var(--i, 0) * 40ms);
}
@keyframes reveal-item-in { from { opacity: 0; transform: translateY(8px); } }
@media (prefers-reduced-motion: reduce) {
  .reveal-item { animation: none; }
}
```

`backwards` applies the `from` frame during the delay so items don't
flash in, then leaves the element at its normal style.

## 6. Expand/collapse without animating `height`

```css
.collapsible {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.2s ease;
}
.collapsible.open { grid-template-rows: 1fr; }
.collapsible > .collapsible-inner { overflow: hidden; min-height: 0; }
@media (prefers-reduced-motion: reduce) {
  .collapsible { transition: none; }
}
```

This is cheap enough for one panel at a time, which matches the app's
single-open lists (`expandedPlayerId`).

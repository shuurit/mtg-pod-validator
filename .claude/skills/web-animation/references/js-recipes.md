# Vanilla JS motion recipes

For motion driven from `app.js` without GSAP. `REDUCED_MOTION` is
`matchMedia("(prefers-reduced-motion: reduce)")`. Define it once
near the top of `app.js` (beside `RELAY_BASE_URL`) if it isn't there
yet. Don't redefine it per function. If GSAP is already
loaded for the moment you're building, the gsap skill's versions are
shorter.

## Count-up for a stat numeral

The real value is in the DOM from the start, for screen readers and as
the fallback. The animation is a visual layer that can only ever finish
on the right number.

```js
function countUp(el, to, ms = 600) {
  el.textContent = String(to);
  el.setAttribute("aria-label", String(to));
  if (REDUCED_MOTION.matches || document.hidden) return;
  const start = performance.now();
  let done = false;
  const finish = () => { if (!done) { done = true; el.textContent = String(to); } };
  const step = (now) => {
    if (done) return;
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    el.textContent = String(Math.round(to * eased));
    if (t < 1) requestAnimationFrame(step); else finish();
  };
  requestAnimationFrame(step);
  setTimeout(finish, ms + 200); // rAF doesn't run in a backgrounded tab
}
```

Give the element `font-variant-numeric: tabular-nums` so its width
doesn't jitter as digits change.

## One-off "this just changed" pulse with the Web Animations API

```js
function pulse(el) {
  if (!el.animate || REDUCED_MOTION.matches) return;
  el.animate(
    [{ boxShadow: "0 0 0 0 var(--accent-soft)" }, { boxShadow: "0 0 0 6px transparent" }],
    { duration: 450, easing: "ease-out" }
  ).finished.catch(() => {}); // cancelled if the node is replaced -- fine
}
```

Since it adds no class and leaves no state behind, it's safe to call on
re-render.

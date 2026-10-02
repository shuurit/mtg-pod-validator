---
name: web-design
description: "Visual and layout design for this app's front end (index.html, style.css, the DOM that app.js builds). Use before adding or restyling any screen, card, modal, table, button, form control, badge, colour, font, spacing, or responsive/mobile behaviour, and whenever asked to make something \"look better\", \"fit on a phone\", \"match the rest of the app\", or work in dark/light mode. Covers the design tokens, the two-theme setup, typography, iOS/PWA layout traps, accessibility, the ?v=N cache-bust, and how to screenshot-check a change. For motion of any kind, also load the web-animation skill."
---

# Web design for Amass a Gathering

A static, no-build, vanilla HTML/CSS/JS app (`index.html`, `style.css`,
`app.js`), used mostly **at the table on phones**, often "Added to Home
Screen" on iOS. Design for a 390px-wide touchscreen first; desktop is the
secondary case.

No frameworks, no preprocessors, no utility CSS, no new dependencies. New
UI is plain CSS classes in `style.css` plus DOM built in `app.js` with
`document.createElement` (see any `build*` function, e.g. `buildPowerChip`).

## Before you change anything

1. Read the surrounding CSS block and its comments. Many rules carry a
   "confirmed the hard way" comment describing a real-device bug they fix.
   Don't undo one of those without reading why it's there.
2. Look for an existing class or pattern to reuse (`grep -n` the class
   names below). This app's look comes from a small set of components
   used consistently. Reuse beats inventing a near-duplicate.

## Design tokens: always use them

Every colour, radius and shadow comes from the custom properties at the
top of `style.css`. Never hard-code a hex value for UI chrome.

| Token | Use |
|---|---|
| `--bg`, `--bg-accent` | page ground; inputs and inset wells |
| `--card-bg`, `--card-bg-translucent` | panels, cards, modals |
| `--ink`, `--muted` | primary and secondary text |
| `--border`, `--border-soft` | card borders; table row rules |
| `--accent`, `--accent-strong`, `--accent-soft`, `--accent-ink` | violet brand accent; hover; tinted fill; text on accent |
| `--good*`, `--bad*`, `--warn*` | status. Each has text, `-bg`, `-border` variants, used as a set |
| `--shadow-sm`, `--shadow-md` | elevation |
| `--radius-lg` (16) / `--radius-md` (10) / `--radius-sm` (7) | modal and section / card / control |
| `--font-display`, `--font-body` | see Typography |

**Fixed-material colours** stay the same in both themes on purpose:
`--pip-w/u/b/r/g` (Magic's mana colours), `--foil` (gold) and `--silver`.
They represent physical card materials, so they don't belong to the theme.

### Two themes, three places

The dark palette is defined **twice** and both copies must stay identical:

1. `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`
2. `:root[data-theme="dark"] { … }`

Light lives in the base `:root`. If you add or change a token, update
**all three**. `applyTheme()` in `app.js` sets `data-theme` from the
avatar-menu toggle. An explicit choice must beat the OS setting, which is
what the `:not([data-theme="light"])` guard is for.

Light is "warm paper" (`#f3efe5`), not white, and dark is "ink"
(`#0b0a10`), not grey. New surfaces should keep that warmth. Check every
new colour pairing in both themes, especially the `-bg` status fills.

## Typography

- **`--font-display` (Saira Condensed 500/600/700)**: headings, stat
  numerals, player names, uppercase labels. Usually paired with
  `text-transform: uppercase; letter-spacing: 0.01–0.06em; line-height: 1`.
- **`--font-body` (IBM Plex Sans 400/500/600)**: everything read at normal
  distance, plus controls.
- Any column or figure of numbers gets `font-variant-numeric: tabular-nums`
  so digits line up (win rates, power, counts).
- Small uppercase table headers: `0.76rem`, weight 600, `--muted`,
  `letter-spacing: 0.05em`. Copy the `th` rule.
- Fonts load from Google Fonts in `index.html` with `display=swap`. If you
  add a weight, add it to that one `<link>` URL rather than a second
  request.

## Layout rules

- Content column: `.wrap`, `max-width: 880px`, 20px side padding.
- **Wrap, don't scroll sideways.** Wide content (pills, chips, strips)
  uses `flex-wrap: wrap` with a `gap`. A horizontal scroll on a phone
  counts as a bug.
- Pick device styles with **`@media (pointer: coarse)` / `(pointer: fine)`**
  (touch versus mouse), which this app already uses for the bottom tab bar
  and avatar placement. Use `max-width` queries (520px, 640px exist) only
  for genuinely width-driven reflow.
- **Tap targets ≥ 44px** high on touch (`min-height: 44px`, already used
  on the touch controls).
- **Safe areas:** the page draws under the iOS status bar
  (`viewport-fit=cover` plus `black-translucent`). Anything fixed to a
  screen edge offsets by `env(safe-area-inset-*)`, typically
  `max(14px, env(safe-area-inset-top))`. See `.wrap`, `.auth-control` and
  `.bottom-tabs`.
- **Viewport height:** use `var(--app-vh, 100dvh)` with `100vh`/`100dvh`
  fallbacks before it, never a bare `100vh`. `--app-vh` is measured by
  `syncViewportHeight()` because mobile `dvh` was unreliable here.
- `position: fixed` layers get `transform: translateZ(0)` (with the
  `-webkit-` prefix) to dodge WebKit's fixed-detaches-on-scroll bug.
- Modals use `.modal-overlay` (fixed, `z-index: 200`, centred) holding a
  `.modal-card` (`--card-bg`, `--radius-lg`, `--shadow-md`,
  `max-height: 90vh`). Size the contents to fit rather than letting the
  card scroll, as `showRevealModal` does.
- Each tab has a full-viewport `.tab-bg` artwork layer under a
  `--bg-scrim` wash. New tabs need one, even if it reuses existing art.

## Components to reuse

`.card`, the section panel (`--card-bg-translucent` over the tab artwork,
`backdrop-filter: blur(30px)`, `--radius-lg`; never animate it, see
web-animation), `button` / `button.primary` (accent fill, coloured drop shadow,
`translateY(1px)` on `:active`), `select` / `input` (`--bg-accent` well),
`table` / `th` / `td`, `.power-chip-*` (low/mid/high/max map to
accent/good/warn/bad), `.modal-overlay` / `.modal-card` / `.modal-close`,
`.skeleton-card` / `.skeleton-line` for loading, `.tc-card` for clickable
cards (border to `--accent` on hover, `:focus-visible` outline).

## Accessibility (not optional)

- Interactive elements are real `<button>`/`<a>`/`<select>`. A clickable
  `div` needs `role`, `tabindex="0"` and key handling, so use a
  `<button>` instead.
- Visible focus: `:focus-visible { outline: 2px solid var(--accent);
  outline-offset: 2px; }`. Never `outline: none` without a replacement.
- Any hover-only reveal must also trigger on `:focus-within` (see
  `.power-cell:focus-within`), and on touch there is no hover at all.
- Meaning is never carried by colour alone. Pair it with text, an icon or
  a pattern (the dashed `.power-chip-pending` border, for example).
  Visual-only summaries (like the reveal colour strip) get an
  `aria-label`.
- Toggling visibility uses the `hidden` attribute. A rule that sets
  `display` overrides it, so add a matching `.thing[hidden] { display:
  none; }` like `.row[hidden]` and `.modal-overlay[hidden]` do.
- Text contrast should reach WCAG AA (4.5:1 body, 3:1 large or UI) in
  **both** themes. `--muted` on `--card-bg-translucent` over artwork is
  the usual weak spot.

## General design advice versus this app

Generic UI/UX guidance (from another skill, a plugin, or a style
database) is a recommendation. This app's existing tokens, fonts and
patterns win. Use outside advice for UX questions (form feedback, focus
order, contrast checks, chart choice), not to replace the palette,
typography or component look. A wholesale restyle is a decision for the
user, not something to infer from a generic design-system generator.

The **ui-ux-pro-max** skill (vendored in `.claude/skills/ui-ux-pro-max/`)
is exactly that kind of database. In this app:

- **Do** use focused lookups: `--domain ux` (one outcome per query, e.g.
  `"focus not obscured"`, `"inline validation error"`), `--domain chart`
  for Win Rates or Trophies visuals, and the `references/pro-rules.md`
  checklist for touch, safe-area and dark-mode checks.
- **Don't** run `--design-system` to pick a palette, fonts or style for
  existing screens. The design system already exists and is documented
  above. **Never** use `--persist`, which writes a competing
  `design-system/` folder into the repo, unless the user asks for a
  restyle.
- **Skip `--stack`.** This app is vanilla HTML/CSS/JS with no Tailwind,
  so the nearest entry (`html-tailwind`) would route advice through
  utility classes the app doesn't use.
- Its `--domain gsap` presets are idea starters only. Adapt them to the
  gsap skill's rules (`autoAlpha`, scoped `clearProps`, no
  ScrollTrigger scroll-storytelling) before using any.

The same goes for **impeccable**, **taste-skill** and **emil-design-eng**
(vendored next to it). Use their judgement on hierarchy, polish, motion
and critique, but never their stack or setup defaults:

- No React, Tailwind, shadcn, npm UI packages or build step.
- No new fonts or palettes that replace the tokens above.
- Impeccable may offer to write PRODUCT.md or DESIGN.md, or turn on its
  detector hook. Do that only when the user asks: this file is the
  design record.

## Code style

Match the existing CSS: one blank line between rule blocks, and a
`/* comment */` above any non-obvious rule saying **why** (what breaks
without it), naming the `app.js` function that drives it. Keep the same
comment density as the code around it.

## Shipping a change

**Bump the cache-buster.** `index.html` loads `style.css?v=N` and
`app.js?v=N`. Increment the number for each file you changed, or phones
keep running the stale copy. `sw.js` deliberately doesn't cache these, so
don't add caching there.

## Check it visually

Serve the repo root (same as `.claude/launch.json`):

```bash
python3 -m http.server 8765    # leave running in the background
```

Signed out, the live page shows only the sign-in gate, because every
tab needs a Discord session. To check a component, copy
`.claude/skills/web-design/harness.html` into your scratchpad, paste the
markup in, and screenshot that. It links the real `style.css` from the
server above and has a theme switch in its URL hash:

```bash
H=file:///path/to/scratch/harness.html
npx -y playwright@1 screenshot --viewport-size=390,844  --color-scheme=light "$H#light" phone-light.png
npx -y playwright@1 screenshot --viewport-size=390,844  --color-scheme=dark  "$H#dark"  phone-dark.png
npx -y playwright@1 screenshot --viewport-size=1280,800 --color-scheme=dark  "$H#dark"  desktop-dark.png
```

Add `--wait-for-timeout=800` if web fonts need time to arrive. In
sandboxes without Google Fonts access, the fallback stack renders
instead, so judge layout and colour from those shots, not letterforms.
Read the PNGs back and look at them before you call a change done. Check
both themes, phone width, and that nothing overflows horizontally.

For a flow that really needs the signed-in app, the remaining path is
Playwright `page.route()` stubbing `RELAY_BASE_URL` (top of `app.js`).
Only go there when the harness can't show the change.

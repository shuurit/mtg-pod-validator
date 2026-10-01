# Vendored: UI/UX Pro Max

- **Source:** https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
  (`.claude/skills/ui-ux-pro-max/`)
- **Version:** 2.13.0, commit `09170eec67eefd46a7ae85de61b40c194020f997`
  (2026-09-27)
- **Licence:** MIT, see `LICENSE` in this folder.
- **Reviewed before vendoring:** the scripts are Python standard library
  only, with no network access and no subprocess or shell calls. They
  write files only with `--persist` (into `design-system/` under
  `--output-dir`).

## Local changes from upstream

1. In `SKILL.md`, `${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/`
   is rewritten to `.claude/skills/ui-ux-pro-max/`. That's the same
   rooted path upstream's own installer (`uipro init --ai claude`)
   writes for a project install. `CLAUDE_PLUGIN_ROOT` is only set when
   it's installed as a plugin.
2. `scripts/tests/` is dropped. It's upstream's test suite and isn't
   needed at runtime.

Nothing else is modified.

## Using it in this app

The **web-design** skill says how this generic database fits with the
app's own design system: the existing tokens, fonts and patterns win.

## Updating

Re-clone upstream at the new commit, review the diff of
`.claude/skills/ui-ux-pro-max/` (especially `scripts/`), copy it over
this folder minus `scripts/tests/`, re-apply change 1, and update the
version and commit above.

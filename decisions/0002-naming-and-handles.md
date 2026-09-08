# 0002 — Naming and handles

- **Status:** accepted
- **Date:** 2026-09-06

## Context

The name **Smelt** is kept: three meanings all on target (a small sea fish
related to the one Fathom was named for; to smelt ore into metal; to smelt out
a thing by instinct), and no live USPTO software mark exists in classes 9 and
42. But the namespace is crowded in exactly the AI-tooling neighborhood:

- npm `smelt` — dead stub, 0.0.2, last publish 2015.
- npm `@smelt` scope — owned (dormant React framework, `@smelt/core` 0.0.12,
  last publish 2022-06-27). Verified by direct GET, not search.
- npm `@smeltjs` — claimed 2026-09-02 by an active project
  (`smeltjs/smelt`, "structure-aware, reversible context optimization for
  coding agents"); `@smeltjs/core` 0.4.0, modified 2026-09-04, still pushed
  2026-09-06.
- npm `@smelt-ai` — active scope, releases through 2026-09-04.
- PyPI `smelt`, `pysmelt`, `smelt-ml` — taken.
- Domains `smelt.dev` and `smelt.sh` — registered.

Method note (recorded so the mistake is not repeated): the npm search
endpoint returns zero for scopes it fails to index, which misled one design
thread into reporting `@smelt` free. The only valid check is a direct GET on
`registry.npmjs.org/@scope%2Fname`.

## Decision

1. **GitHub org:** `smelt-oss`.
2. **npm scope:** `@smelt-oss` for every JS package (`@smelt-oss/runtime`,
   `@smelt-oss/consent-banners`, `@smelt-oss/cli`).
3. **PyPI:** `smelt-train` for the Python factory.
4. **Domains:** none printed in any document until registered. The crawler
   contact URL points at the GitHub repository. `getsmelt.org` and
   `smeltml.org` verified available 2026-09-06.
5. One install string everywhere; README, docs, and builds updated in the
   same edit when packages first publish.
6. A disambiguation page names the neighbors (`@smelt-ai`, `smeltjs/smelt`,
   PyPI `smelt`) with links.
7. No trademark filing in year one.
8. Rename trigger: two or more misdirected issues, security reports, or press
   conflations in one quarter. Shortlist if triggered: unscoped `smelt-web`
   (free on npm and PyPI, echoes the `fathom-web` lineage).
9. Week-1 gate honored: every registry below was re-checked the same day
   before this record was accepted. Re-check again the same day as the first
   publish.

## Registry checks, 2026-09-06 (direct GETs)

| Handle | Endpoint status | Result |
|---|---|---|
| npm `@smelt-oss/core` | 404 | free |
| npm `@smelt-oss/runtime` | 404 | free |
| npm org `smelt-oss` | 404 | no org |
| npm `smelt-web` | 404 | free (rename shortlist) |
| npm `@smeltjs/core` | 200 — 0.4.0, modified 2026-09-04 | taken, active |
| PyPI `smelt-train` | 404 | free |
| PyPI `smelt-web` | 404 | free |
| GitHub org `smelt-oss` | 404 | free |
| GitHub user `smelt-oss` | 404 | free (no user exists either) |
| GitHub `smeltjs/smelt` | 200 — pushed 2026-09-06 | neighbor active |
| `getsmelt.org` (RDAP) | 404 | available |
| `smeltml.org` (RDAP) | 404 | available |

## Consequences

- All install strings in IDEA.md and README use `@smelt-oss/*`; the earlier
  `@smelt/*` draft strings are void.
- Squat risk is real while the project is pre-development: register the org
  and scope before the first public launch post, not after.
- Search traffic will split with the neighbors; the disambiguation page and
  unique handles contain the damage.

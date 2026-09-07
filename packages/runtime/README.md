# @smelt-oss/runtime

The Smelt rules engine, Tier 0: pure JavaScript, zero runtime
dependencies. You describe a page with a Fathom-style ruleset. Rules pick
out elements with `dom()`, then attach types, notes, scores. Coeffs and
biases turn those scores into confidences.

Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0). Status: port landing,
unreleased. `CONTRACTS.md` in this directory defines the port scope.

## Usage

```js
import {ruleset, rule, dom, type, score, out} from '@smelt-oss/runtime';

const rules = ruleset([
    rule(dom('h1'), type('titley').score(2)),
    rule(dom('meta[property="og:title"]'), type('titley').score(1)),
    rule(type('titley').max(), out('title'))
]);
const run = rules.against(document);
const title = run.get('title')[0];
console.log(title.element.textContent, run.stats.ms);
```

`against()` compiles the ruleset once, then runs every rule eagerly, in
one pass. It returns a `BoundRun`. Use `run.get(key)` to read a stored
`out()` result, `run.get(element)` to get its fnode. `run.stats` reports
`{ms, elementsWalked, truncated, tier, rulesExecuted}`. `tier` is always
`0`.

## Charter

- Engine core under 10,240 bytes gzipped (`npm run size`).
- Under 2,000 total lines across engine `.mjs` files. Target: about 1,500.
- Zero runtime dependencies. Plain ESM modules. `sideEffects: false`.

## Develop

- `npm test` runs the ported test suite (`node:test` plus linkedom).
- `npm run size` prints raw plus gzipped bundle bytes.

See `../../IDEA.md` section 3.4 for the budgets. See `CONTRACTS.md` for
the module map, the public API, plus the dropped features.

# Runtime port contract

This file is the single coordination artifact for porting Fathom 3.7.3 into
`@smelt-oss/runtime`. Every builder and reviewer agent must read this file
first and follow it exactly. When this file and personal preference disagree,
this file wins.

## 1. Provenance and license

- Source: `/home/agent/fathom/fathom/*.mjs` (fathom-web 3.7.3, Mozilla,
  MPL-2.0).
- This port is a derivative work. Every ported file starts with the standard
  MPL-2.0 header comment, followed by one provenance line:

  ```js
  /* This Source Code Form is subject to the terms of the Mozilla Public
   * License, v. 2.0. If a copy of the MPL was not distributed with this
   * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

  // Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).
  ```

  Files with no fathom counterpart (new Smelt code) carry the header without
  the provenance line.

## 2. Goal and charter

Port the Fathom rule engine as a strict subset with one architectural change:

- Keep: the grammar (`rule`, `dom`, `element`, `type`, `typeIn`, `note`,
  `score`, `atMost`, `out`, `max`, `when`), the Fnode type/score/note model,
  the `elementCache` WeakMap, the `typeCache`, the `maxCache`, coeffs and
  biases with sigmoid scoring.
- Change: replace the lazy `get()` planner (per-request prerequisite graph
  plus toposort) with a compile-time topological sort of the whole ruleset
  plus a fixed one-pass executor. See section 5.
- Drop: `and`, `or`, `nearest`, `bestCluster`, `props`, `through`,
  `allThrough`, `clusters`, `distance`, `euclidean`, `conserveScore`, the
  UMD/rollup/babel build, the `jsdom` runtime dependency, and
  `utilsForBackend.mjs`.

Charter (from IDEA.md 3.4): the engine stays under 2,000 total lines across
all `*.mjs` engine files. Target is about 1,500. Zero runtime dependencies.
Plain `.mjs` modules with JSDoc comments. No TypeScript syntax.

## 3. File map

All engine modules sit at the package root of `packages/runtime/` so the
exports map stays shallow. Line counts are guides, not hard limits.

| File | Lines | Ported from | Notes |
|---|---|---|---|
| `errors.mjs` | 20 | `exceptions.mjs` | `CycleError`, `NoWindowError` |
| `utils.mjs` | 500 | `utilsForFrontend.mjs` | Keep-list in section 6 |
| `fnodes.mjs` | 130 | `fnode.mjs` | Class renamed file only; class stays `Fnode` |
| `sides.mjs` | 120 | `side.mjs` | Drop `props`, `and`, `nearest`, `bestCluster` |
| `lhs.mjs` | 190 | `lhs.mjs` | Keep `DomLhs`, `ElementLhs`, `TypeLhs`, `AggregateTypeLhs`, `TypeMaxLhs` |
| `rhs.mjs` | 210 | `rhs.mjs` | Drop `props`, `through`, `allThrough` |
| `rule.mjs` | 240 | `rule.mjs` | `rule()`, `InwardRule`, `OutwardRule` |
| `plan.mjs` | 110 | `ruleset.mjs` (part) | `ruleset()`, `Ruleset`, `compile()`, `CompiledPlan` |
| `executor.mjs` | 150 | `ruleset.mjs` (part) | `BoundRun`, one-pass execution, stats |
| `index.mjs` | 45 | `index.mjs` | Public exports, exact list in section 4 |

Supporting files (not counted in the engine charter):

- `test/*.test.mjs` — ported fathom tests, `node:test` plus `linkedom`.
- `scripts/size.mjs` — bundle with esbuild, gzip, print bytes.
- `README.md` — status, usage, charter, provenance.

## 4. Public API

`index.mjs` exports exactly this surface:

```js
export const VERSION = '0.0.0';
export {rule} from './rule.mjs';
export {ruleset, compile} from './plan.mjs';
export {dom, element} from './lhs.mjs';
export {out} from './rhs.mjs';
export {type, typeIn, note, score, atMost} from './sides.mjs';
export {CycleError, NoWindowError} from './errors.mjs';
export * as utils from './utils.mjs';
```

Nothing named `and`, `or`, `nearest`, `bestCluster`, `props`, `through`,
`allThrough`, or `clusters` appears in any export, comment, or identifier.

## 5. Architecture: compile-time plan, one-pass execution

### 5.1 plan.mjs

```js
export function ruleset(rules, coeffs = [], biases = []) // → Ruleset
export function compile(rulesetOrRules, coeffs, biases)  // → CompiledPlan
```

- `Ruleset` mirrors fathom's unbound `Ruleset`: sorts rules into inward and
  outward, builds `_rulesThatCouldEmit` and `_rulesThatCouldAdd` indexes,
  stores `_coeffs` and `biases` as Maps, and throws on non-rule elements.
  It also keeps fathom's `rules()` accessor.
- `compile()` builds one prerequisite graph over all rules, inward and
  outward alike, using `Rule.prototype.prerequisites()`. Edges map each
  prerequisite to the rules that need it. Execution order is
  `reversed(toposort(allRules))`, the same orientation fathom uses inside
  `_execute`. The result is stored as a flat ordered array on
  `CompiledPlan.rules`.
- Compile-time failures raise eagerly, with fathom's message shapes:
  - A cycle throws `CycleError` with the message
    `'There is a cyclic dependency in the ruleset.'`
  - A rule that needs a type no rule emits or adds throws fathom's
    `No rule ${verb} the "${type}" type, but another rule needs it as input.`
- `compile()` accepts a `Ruleset` or a bare array of rules. With a bare
  array, `coeffs` and `biases` apply as in `ruleset()`.
- `Ruleset.against(doc, options)` compiles once (memoized on the Ruleset,
  because rules are immutable), then delegates to
  `CompiledPlan.against(doc, options)`.

### 5.2 executor.mjs

```js
class BoundRun {            // constructed only by CompiledPlan.against()
  get(thing)                // string out-key | type() Side | DOM element
  weightedScore(mapOfScores)
  fnodeForElement(element)
  get stats()               // {ms, elementsWalked, truncated, tier, rulesExecuted}
}
```

- The constructor runs the whole plan eagerly, in order, exactly once:
  - For each `InwardRule`, call `results(this)`. The rule merges facts into
    fnodes, marks itself done in `doneRules`, and updates `typeCache`.
  - For each `OutwardRule`, compute its fnodes once and store the array in
    an outputs map keyed by `rule.key()`.
  - Execution is synchronous. No lazy evaluation of any kind.
- Timing: `performance.now()` when available, else `Date.now()`, captured
  around the loop, reported as `stats.ms`.
- Element budget: `options.maxElements` defaults to `20000`. The counter is
  `elementsWalked`, incremented once per element that obtains a fnode (the
  miss path of `fnodeForElement`). When a `dom()` or `element()` LHS wants
  to introduce elements beyond the budget, it skips those elements, sets
  `stats.truncated = true`, and continues. Elements that already have
  fnodes pass the budget free, since reintroducing them adds nothing.
  Explicit `get(domElement)` calls always create a fnode, even past the
  budget.
- `stats.tier` is always `0` (Tier 0, pure JavaScript).
- `get(thing)` behavior:
  - String: return a fresh array with the fnodes of the matching `out()`
    rule, or throw `There is no out() rule with key "${thing}".` Fresh, so
    mutating a result cannot corrupt a later `get()`.
  - A `Side` whose first call is `type`: evaluate the whole chain, including
    `max()` and `when()`, against the run's settled caches, and return the
    fnodes as a fresh array. A type no rule emits has no fnodes and yields
    an empty array.
  - A DOM element: return `fnodeForElement(element)`.
  - Anything else: throw
    `'ruleset.get() expects a string, a type() expression, or a DOM element.'`

### 5.3 Lazy-evaluation removal in Fnode

`Fnode._computeType` and its on-demand `ruleset.get(type(...))` call are
removed. After `against()`, everything has already run. The public Fnode
methods (`hasType`, `scoreFor`, `noteFor`, `hasNoteFor`) keep fathom
signatures and semantics: `scoreFor(type)` returns
`sigmoid(weightedScore(scoresSoFarFor(type)) + biasFor(type))`. The Fnode
constructor keeps its `(element, run)` signature; the second argument is the
`BoundRun`, which supplies `weightedScore` and `biases`. Document the delta:
queries from inside a `score()` callback during execution see partial state;
Smelt never runs rules lazily to answer them.

## 6. Module specs

### 6.1 utils.mjs (from utilsForFrontend.mjs)

Keep, with fathom's docs trimmed only where they reference dropped features:
`identity`, `maxes`, `sum`, `walk`, `isBlock`, `inlineTexts`,
`inlineTextLength`, `collapseWhitespace`, `linkDensity`, `isWhitespace`,
`setDefault`, `getDefault`, `toposort`, `NiceSet`, `first`, `rootElement`,
`numberOfMatches`, `page`, `domSort`, `toDomElement`, `attributesMatch`,
`ancestors`, `sigmoid`, `isVisible`, `rgbaFromString`, `saturation`,
`linearScale`, `reversed`, `isDomElement`, `windowForElement`, `map`,
`forEach`.

Drop: `best`, `max`, `min`, `length`, `flatten`, `isIterable` (their only
callers were clusters, nearest, and internal flatten). Keep the fathom bug
workarounds in `inlineTexts` (`textContent` over `wholeText`) and
`domSort`. `toposort` keeps throwing `CycleError('The graph has a cycle.')`.

### 6.2 sides.mjs (from side.mjs)

- Factories: `type(theType)`, `note(callback)`, `score(scoreOrCallback)`,
  `atMost(score)`, `typeIn(...types)`.
- `Side` keeps `_calls`, `_and`, `asLhs`, `asRhs`, `_asSide`, and the chain
  methods `type`, `typeIn`, `note`, `score`, `atMost`, `when`, and `max`.
  The `max` chain method builds the `TypeMaxLhs` path exactly as fathom's
  does through `fromFirstCall` plus later calls.

### 6.3 lhs.mjs (from lhs.mjs)

- `dom(selector)` → `DomLhs`; `element(selector)` → `ElementLhs`.
- `Lhs.fromFirstCall` accepts only `method === 'type'`; anything else throws
  `'The left-hand side of a rule() must start with dom(), element(), or type().'`
- Keep `when()`, `fnodesSatisfyingWhen`, `checkFact` (a `dom()` or
  `element()` rule whose RHS sets no type throws fathom's message),
  `guaranteedType`, `aggregatedType`, `possibleTypeCombinations`,
  `typesMentioned`.
- `TypeMaxLhs.fnodes` keeps the `maxCache` memoization and the tie behavior
  from `maxes()`.
- `DomLhs` and `ElementLhs` enforce the element budget as described in
  section 5.2. To do this they need the run; they already receive it as
  `fnodes(ruleset)`.

### 6.4 rhs.mjs (from rhs.mjs)

- Keep `SUBFACTS`, `out(key)`, `InwardRhs` with `atMost`, `type`,
  `typeIn`, `note`, `score`, `fact`, `_checkAtMost`, `_checkTypeIn`,
  `possibleEmissions`.
- `possibleEmissions()` loses its `props` branch: it returns
  `{couldChangeType: true, possibleTypes: new Set([type])}` when a `type()`
  call exists, else `{couldChangeType: false, possibleTypes: this._types}`.
- `OutwardRhs` keeps `key` and `asRhs` only. No `through`, no `allThrough`,
  no stored callbacks.
- `InwardRule.typesItCouldEmit()` keeps fathom's error for an emission that
  cannot be determined; with `props` gone, that error is unreachable but
  stays as a guard.

### 6.5 rule.mjs (from rule.mjs)

- Keep `rule(lhs, rhs, options)` with the string-RHS sugar
  (`rule(lhs, 'key')` means `rule(lhs, out('key'))`), internal rule names,
  `prerequisites()`, `_typesFinalized()`, `InwardRule.results()`,
  `typesItCouldEmit()`, `typesItCouldAdd()`, `OutwardRule.results()`,
  `key()`.
- `InwardRule.results()` simplifies one fathom generality: LHS results are
  plain fnodes now (the `{fnode, rhsTransformer}` shape existed only for
  `nearest()`). Keep the rest of the merge logic identical: rightType
  inference from `fact.type || lhs.guaranteedType()`, the two thrown errors
  for a score or note without a type, `addScoreFor`, `setNoteFor`, the
  returned-fnodes set, `doneRules` bookkeeping, and the `typeCache` update
  over `fnode.typesSoFar()`.

## 7. Style

- Plain `.mjs`, ESM imports and exports only. No default exports.
- JSDoc on every exported function and class, ported from fathom and trimmed
  of dropped-feature references. `@arg`, `@return`, `@example` keep fathom's
  shape.
- Comments: keep fathom's rationale comments where the code they explain
  survives. Delete comments that only explain dropped code.
- No lint setup ships in this port. Match fathom's 4-space indentation and
  quote style.
- Every file must parse with `node --check`.

## 8. Gates

A port is done only when all of these hold:

1. `node --check` passes on every `*.mjs` engine file.
2. `npm test` (run from `packages/runtime`) is green.
3. `npm run size` prints the gzip size of the bundled engine.
4. `grep` finds none of the banned identifiers (section 4) in engine files.
5. Total engine line count is under 2,000.

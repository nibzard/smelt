# Smelt

**Big teacher. Tiny student. Local page.**

Smelt is an open-source project for understanding web pages locally. The planned
product is a small, pre-trained package with one detection call. Inference needs
no network or API key. Size and latency targets remain unproven for the detector.

The provisional first product detects consent banners. Planned usage:

```js
import { detect } from '@smelt-oss/consent-banners'

const result = await detect(document)
if (result.found) highlight(result.found)
```

A large language model labels training pages as a teacher. Rules and a small
tree model run in the browser. The target is under 50 KB gzipped and under 5 ms
at the 95th percentile on a declared reference machine.

## Status

Early development. The runtime, the pilot evaluator, the consent detector
package, the Steel and local capture paths, the trainer, and the browser
benchmark harness work. The labeled corpus, the rules agent loop, and the npm
release do not exist yet. [IDEA.md](IDEA.md) defines the Steel pilot, starting
2026-09-07 with an evidence review on 2026-10-16. The public release date
depends on that result. Nothing is published to npm or PyPI yet.

## Quickstart

From a repository clone (the npm package does not exist yet):

```sh
npm ci
npm run quickstart
```

The quickstart detects the consent banner on a bundled sample page with the
local model, prints the honest status of that model, and exits nonzero if
the sample stops detecting. It sends nothing: there is no CLI telemetry. If
you want your completion counted, it prints a pre-filled GitHub issue link
you may open, plus an invitation to add yourself to
[ADOPTERS.md](ADOPTERS.md). Both signals are opt-in and count as a lower
bound only.

## Develop

Use Node.js 24 for development. Node.js 20 is the minimum supported version.
From the repository root:

```sh
npm ci
npm run verify
npm run pilot:demo
```

`verify` checks JavaScript syntax, runtime line count, tests, the browser bundle,
and the gzip budgets: under 10 KB for the engine core and under 50 KB total for
the consent package's eagerly loaded chunks, engine, rules, and model together.
The Node-only linkedom fallback ships as a lazy chunk outside the budget. The
bundle is written to `packages/runtime/dist/runtime.mjs`. Continuous integration
(CI) runs these checks on Linux and Windows with Node.js 20 and 24.

The pilot demo scores synthetic predictions with deliberate errors. It makes no
network requests and needs no Steel credentials. See the
[input contract](packages/pilot/README.md) and the
[consent task specification](tasks/consent-banners/program.md).

Capture pages without Steel credentials through the local Playwright path:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run local:fixture-crawl --workspace @smelt-oss/capture
```

The fixture crawl writes frozen snapshots, features, and metadata for the
bundled fixture pages. See [the capture package](packages/capture/README.md).
Live-browser latency and unseen release accuracy gates require a captured
corpus; they are not active yet.

## Steel pilot

The team owns [Steel](https://steel.dev/). Steel supplies cloud browsers and
the first integration path for Smelt. The pilot compares existing agent
workflows with the same workflows using a local detector.

Dedicated public crawls supply the initial corpus. Potential access to millions
of sessions can help find difficult cases where reuse is authorized. Customer
session content stays outside the public corpus. Session volume does not replace
diverse samples and human-verified labels.

Start with one task and a few hundred labeled pages. Compare hand-written rules,
linear and tree models, and agent-improved rules. Measure correct element
selection, task completion, model calls, cost per completion, browser latency,
and human effort. Expand the corpus and factory after this evidence supports them.

## Two layers

1. **Products** — pre-trained, per-task packages. Most users install and call.
2. **The factory** — the open toolkit that produces them: crawl, freeze,
   teacher-label, train, loop, test, export. Anyone can rebuild a model when
   the web drifts.

## Principles

1. Gate detection quality on correct element selection, size, and latency.
2. Rules stay readable. Every shipped model carries an auditable rules file.
3. The page never leaves the browser at inference. No CLI telemetry either.
4. Public corpora come from dedicated public crawls. Authorized session samples
   support private evaluation and failure discovery.
5. Small core, tasks as data. Engine under 2,000 lines by charter.
6. Train small models on a laptop. Measure teacher, agent, browser, and review costs.

## Project layout

- [IDEA.md](IDEA.md) — the full design document (progressive disclosure)
- [decisions/](decisions/) — MADR decision records, immutable once accepted
- [ADOPTERS.md](ADOPTERS.md) — who uses Smelt; add yourself by pull request
- `packages/` — the runtime, pilot evaluator, and per-task packages
- `tasks/` — task definitions and labeling policies
- `examples/pilot/` — synthetic labels and predictions for offline scoring

## License

MPL-2.0, matching the mozilla/fathom lineage.

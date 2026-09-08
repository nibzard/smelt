# IDEA.md — Smelt

**Big teacher. Tiny student. Local page.**
**Ore in, metal out.**

- Status: design document, v1.1. Updated 2026-09-07 to include Steel ownership, a Steel pilot, and revised evaluation gates. Earlier external claims retain their recorded verification dates; this revision does not re-verify them. Performance and adoption targets are hypotheses until measured.
- Home: `/home/agent/smelt`. Upstream lineage: `mozilla/fathom` (archived 2025-11-18).
- Reading guide. This document uses progressive disclosure. Read Part 0 for a 30-second answer. Read Part 1 for one page. Part 2 states the whole idea. Part 3 works each system out in depth. Part 4 covers execution. The appendices hold reference material. Stop wherever you have enough.

---

## Part 0 — Thirty seconds

Smelt is an open-source project that understands web pages locally.

The planned product is a pre-trained package with one detection call. Inference needs no network or API key. The target is under 5 ms at the 95th percentile on a declared reference machine. The detector has not yet demonstrated this target.

```js
import { detect } from '@smelt-oss/consent-banners'

const result = await detect(document)
if (result.found) highlight(result.found)
```

A large language model labels training pages as a teacher. Rules plus a small tree model then run in the browser. The package target is under 50 KB gzipped. Compare an agent loop against simpler training before adopting it.

Most users only install products. The factory stays open so contributors can rebuild models when the web changes. Steel can support recurring evaluation and retraining; maintenance effort still needs measurement.

The team owns Steel (steel.dev). Steel supplies cloud browsers and a first integration path. Smelt turns repeated page-understanding work into small, reusable detectors. Access to millions of browsing sessions is a potential source of evaluation cases, not an existing labeled corpus.

---

## Part 1 — One page

### 1.1 What Smelt is

Two layers, one project:

1. **Products.** Pre-trained, per-task npm packages. Detect consent banners, form fields, or other page structures. Local, fast, free at inference. Most users never train anything.
2. **The factory.** The open toolkit that produces the products. It crawls pages, freezes rendered DOMs, labels them with two LLM teachers, then optionally runs an agent loop that improves rules on development data. An unseen release test evaluates the final model.

### 1.2 The problem in three numbers

- **$0.001 to $0.003 per page.** The cost of LLM page understanding at scale (Gemini 2.5 Flash-Lite at $0.10 per million input tokens; a rendered page is 10k to 30k tokens). A feature that runs on every page cannot pay this in money, latency, or privacy.
- **88.3 percent.** Grounding accuracy that Prune4Web reached by putting programmatic DOM logic between the agent and the model, up from 46.8 percent. DOM-side machinery is the measured lever. Every current fix needs a GPU or an API call.
- **1,710 downloads a month.** Residual pull on `fathom-web`, a library dead since 2022. Developers still reach for local, learned page understanding. The shelf is empty.

### 1.3 The empty quadrant

| | Heuristic | Learned |
|---|---|---|
| Remote | Crawler libraries | LLM APIs, ReaderLM |
| Local | readability, defuddle, regexes | **vacant — Smelt takes it** |

Mozilla archived Fathom. Firefox runs two Fathom rule sets in production code and a private 14M-parameter successor model. Proton runs a closed fork. Nobody ships an open, local, learned page-understanding library. A re-check on 2026-09-05 found the quadrant still vacant.

### 1.4 The bar

The first product, a consent-banner detector, must reach:

- End-to-end detection F1 at or above 0.90 on a frozen, human-verified 1,000-page test set. A correct positive requires an acceptable banner root.
- Under 50 KB gzipped, total: engine, rules, and model together.
- Under 5 ms per page at p95, on a declared reference machine at 4x CPU throttle.

Everything in this document serves those three numbers.

The Steel pilot must also demonstrate workflow value: better task completion or lower cost per completed task, without a material regression in the other. Select the primary measure and acceptable regression limits before evaluation. Package downloads are a secondary signal.

### 1.5 Steel changes the starting conditions

The team owns Steel, which provides cloud browsers, reusable browser state, and session inspection ([Steel](https://steel.dev/)). These capabilities support controlled collection, live evaluation, and an initial product integration.

Two data paths have distinct roles:

- **Dedicated Steel crawls:** collect public pages under controlled conditions for training, repeatable evaluation, and the public corpus.
- **Authorized session samples:** discover recurring failures and test coverage on real workflows. Session availability, permitted uses, and capture fields must be established before reuse. Infrastructure ownership alone does not establish permission to reuse customer content. Customer session content does not enter the public corpus.

Millions of sessions would improve access to difficult cases. They would not supply correct labels automatically. Sample diversity, failures, and teacher disagreements; deduplicate repeated page templates. Dedicated crawls let the pilot proceed without customer-session access.

---

## Part 2 — The idea in full

### 2.1 Lineage: what Fathom proved, and how it died

Fathom (2016 to 2022) proved the design: declarative rules over DOM nodes, a trainer that learns one coefficient per rule, and a runtime of plain JavaScript that scores pages in milliseconds. Firefox shipped it for password and credit-card fields with 99.2 percent precision at 92.1 percent recall.

It died of maintainer burnout, not technology. Commit volume fell from 481 in 2019 to 5 in 2022. The last human commit landed 2022-06-13. Community pull requests from 2023 sat unanswered until the archival bulk-closed them on 2025-11-18. The training-corpus repositories now return 404 while shipped Firefox code still cites them. Single-maintainer dependence and unanswerable redistribution questions killed the project.

The remains are instructive. The full Fathom runtime — query planner, rules grammar, clustering — is 2,767 lines that bundle to 20,874 bytes minified and 7,333 bytes gzipped (measured with esbuild 0.25.0 on the checkout). Firefox ships the same code as `fathom.mjs` at 98,598 bytes. So a complete rules-plus-model runtime fits in a budget measured in kilobytes, not megabytes.

Smelt keeps the idea and fixes the death modes:

- The corpus becomes a regenerable public artifact, not a private repository.
- Training becomes cheap and repeatable, so any contributor can rebuild a model.
- Governance starts with a second releaser and a written archive path.

### 2.2 The job to be done

**Understand an unfamiliar web page well enough to act on it — locally, in milliseconds, at zero marginal cost.**

Four hirers:

- **Extension developer.** Find fields, banners, or players without sending the DOM anywhere. Current hires: hand-written selectors on a maintenance treadmill.
- **Agent builder.** Grounding that costs nothing and adds no round trip. Current hires: LLM calls that leak the page and add seconds.
- **Privacy vendor.** Decisions on device; never leak even the fact of a visit. Current hires: server-side APIs that fail the review.
- **Researcher.** One harness, one honest metric, comparable across weeks. Current hires: bespoke scripts that cannot be compared.

### 2.3 Two layers: bakery and bread

The default experience is Layer 1. You install a product, like installing readability. You never see the factory.

Layer 2 exists for three reasons:

1. **Freshness.** Consent platforms ship frontend changes weekly. A model trained in one quarter degrades by the next. If only the maintainers can retrain, the project repeats Fathom's single point of failure. The factory makes every model regenerable by anyone.
2. **The long tail.** Every product's task differs slightly. A registry cannot pre-train everything. A factory lets the long tail train itself.
3. **Trust.** Privacy-sensitive adopters audit the rules and the training path before they ship. An open factory is the audit.

### 2.4 Why not one generic model

A generic page-understanding model must read text. Reading text needs a transformer. A transformer is megabytes of weights plus a 13.6 MB WebAssembly runtime before any weights load. That is the API model rebuilt minus the server.

Specialization is what buys 50 KB and 5 ms. The shipping evidence agrees: Firefox runs two separate tiny rule sets rather than one general model. Mozilla's 66-class form model keeps Fathom running beside it for credit-card fields. Proton trained for its exact fields.

So Smelt ships one small model per task. Text-heavy tasks may promote to a small transformer later, under a strict rule (see 3.1.6). The default student is rules plus gradient-boosted trees.

### 2.5 The wedge: consent-banner detection

The first product detects consent banners. It does not click anything.

Why this task:

- Universal pain, regulated in the EEA, with IAB TCF v2.3 enforcement obligations from 2026-03-01.
- No free local standard exists. The neighbors solve different problems: DuckDuckGo's autoconsent drives known platforms with per-CMP rules; Consent-O-Matic does the same from a university lab. Both need a general find step for unknown banners. Smelt is that step.
- Small label space. One positive class plus a root element. Cheap to teach, cheap to audit.
- Instant demo. A browser extension that highlights every banner it finds sells the whole thesis in one screenshot.

Demand anchor: CookieEnforcer (USENIX Security 2023) trained a small learned notice detector on 505 annotated candidates from 250 sites and reached 0.97 F1 at the candidate level, with 93.7 percent correct end-to-end opt-out sequences across 1,000 banner domains. That is the closest published precedent for the 0.90 gate. CookieBlock (USENIX Security 2022) classifies cookies, not banners; it reports 84.4 percent accuracy against a human baseline of 84.7 percent, with a label-noise ceiling near 92 percent on CMP-derived labels. Rule-based tools stay per-platform: Consent-O-Matic lists more than 200 supported CMPs, and autoconsent describes itself as a library of rules for known consent pop-ups. The custom-banner slice is unbounded and unserved.

Expansion after the wedge: form fields (Proton-proven demand, password-manager design partners), then a research track on local grounding for agents.

Consent banners are the provisional first task. Before expanding the corpus, rank Steel workflow failures by frequency, cost, and suitability for a small detector. Compare banners, other overlays, form fields, and primary action buttons. A task change requires a new task specification and matching labels and gates before training. The existing consent package remains the default until this evidence supports a change.

The first integration runs detection inside a Steel browser before an agent requests model interpretation. Test whether the returned element helps the existing agent complete its task. Smelt v0.1 still detects only; the caller owns any action. Do not assume that a highlighting demo establishes workflow value.

### 2.6 How a model gets made

A walk-through of the factory, from empty directory to shipped package:

1. **You write `program.md`.** Five sections: task, positive examples, negative examples, edge-case policy, threshold policy. This is the only file a human owns end to end.
2. **`smelt crawl` gathers pages.** A polite crawler (Playwright 1.63.0) visits public URLs, one page per domain, and freezes each rendered DOM with the embedded single-file engine (3.3.2) into a stripped snapshot plus a feature JSON.
3. **Teachers label.** Two cheap LLM teachers from different vendors label every page: does a banner exist, which element is its root, what kind is it, what evidence supports it. A programmatic DOM verifier checks visibility and geometry. Disagreements go to human review.
4. **You seed `rules.ts`.** A first draft of declarative rules. The agent improves it later; you can also let the agent draft it.
5. **`smelt train` fits the student.** The rules run over every snapshot and produce a feature vector per candidate element. LightGBM 4.7.0 fits a small forest on CPU. Measured: 0.12 seconds for 40 trees on 10k by 80 features.
6. **`smelt loop --budget 8h` runs overnight.** An agent reads the failures, edits `rules.ts`, retrains, and faces the frozen dev score. A ratchet keeps wins and discards losses. Hundreds of iterations per night.
7. **`smelt test` gates the result.** Size, latency, and F1 must pass, in that order, on the frozen test set that the loop never saw.
8. **`smelt export --npm` ships it.** One package: readable rules file, model artifact, and a one-call wrapper.

Total teacher cost for the 5,000-page wedge corpus: on the order of $11 to $14 with nano-tier teachers (see 3.3.5). Total training compute: a laptop CPU. Total overnight agent cost: $15 to $86 (see 3.2.7).

### 2.7 What ships

Each task package contains:

- `dist/model.smelt.json` — the model artifact. A JSON envelope with metadata, the feature list, the rules hash, and the forest as a packed binary column encoded in base64.
- `dist/rules.js` — the rules, unminified, MPL-2.0, human-auditable.
- `MODEL.md` — a model card: task, corpus revision, teachers with terms versions, training date, measured F1, size, latency, known blind spots.
- A one-call wrapper exporting `detect`.

The runtime ships as `@smelt-oss/runtime`: zero dependencies, pure ESM, tree-shakable, under 10 KB gzipped for the engine core.

The public API for the wedge:

```js
import { detect } from '@smelt-oss/consent-banners'

const result = await detect(document)
// result.found: Element[] | null   (discriminated union on `found`)
// result.banner: { kind, evidence } | null
// result.stats: { ms, elementsWalked, truncated, tier }
// result.degraded: string[]       (empty when fully able)
```

Input accepts a `Document` or an HTML string. Output never throws for page-level failure; it returns a structured result with `stats`. Errors you can fix (bad model, unsupported runtime) throw typed subclasses of `SmeltError`.

Version 0.1 ships `detect` only: one-shot, no configuration object, no events. The `watch()` API for single-page applications lands in v0.2 behind an experimental flag, built on MutationObserver with debounce and cancellation (see 3.4.6).

### 2.8 Principles

1. **One metric, hard gates.** F1 counts only after size and latency pass.
2. **Rules stay readable.** Every shipped model carries a human-auditable rules file.
3. **The page never leaves the browser at inference.** No telemetry in the CLI either.
4. **Public corpora come from dedicated public crawls.** Authorized customer-session samples support private evaluation and failure discovery only.
5. **Small core, tasks as data.** Engine under 2,000 lines by charter.
6. **Small models train on a laptop CPU.** Teacher calls, agent calls, browser time, and human review have measured costs.

---

## Part 3 — Deep dives

### 3.1 Machine-learning core

#### 3.1.1 The rules grammar

The grammar descends from Fathom's clause system: `rule` / `dom` / `type` / `score` / `note` / `when` / `out` / `max`. A rule matches a DOM selector or a type, then annotates candidates with a score or a note. Types chain rules; `when` declares prerequisites.

Smelt cuts four operators that Fathom's planner needed for generality but the wedge does not: `and()`, `or()`, `nearest()`, and `bestCluster()`. It also drops `props()` and `through()`. What remains covers element detection and feeds the same feature semantics with less runtime code.

Rules are TypeScript. An esbuild compile step orders them by prerequisites at build time and emits a fixed execution plan. The shipped evaluator runs that plan in one pass.

#### 3.1.2 Features

The feature vector per candidate element:

- **Rule scores.** One feature per rule, named after it. Values are the rule's score for that candidate.
- **An intrinsic block.** Roughly 80 fixed features: tag, role, text statistics of the subtree, class and attribute fingerprints, plus layout carried from the freeze (viewport area fraction, fixed or sticky flag, z-index bucket, quartile position).

Layout features come from the frozen snapshot, never from live layout at training time. This is the layout contract, and it closes the deepest gap the critic found (see 3.2.5).

#### 3.1.3 The student model

LightGBM 4.7.0 (verified latest on PyPI, 2026-09-05) fits a gradient-boosted tree forest over the feature vectors. Gradient-boosted trees hold the accuracy edge on medium-scale tabular data (NeurIPS 2023), and DOM features are tabular.

Fixed configuration for the wedge: `num_leaves 15`, `max_depth 5`, `learning_rate 0.08`, `n_estimators 40`. Measured on a laptop CPU: 0.12 seconds for 40 trees on 10,000 rows by 80 features. Training cost is effectively free, which is what makes hundreds of overnight iterations possible.

A linear fallback (one coefficient per rule, one bias per type — Fathom's exact scheme) costs about 400 bytes for 200 rules and stays in the trainer as a baseline. If the forest does not beat the linear baseline by a margin, the rules are doing all the work and the forest is noise.

#### 3.1.4 The serialized format

The artifact is `model.smelt.json`: a JSON envelope for auditability with a packed binary column for size.

- The envelope holds: `abi` version, `corpusId` and corpus revision, `rulesHash`, `trainedAt`, `modelVersion`, feature names, and calibration data.
- The forest packs into flat typed arrays: feature index as u8 with 255 as the leaf sentinel, threshold as u16, child indices as u16, leaf values as f32, an explicit root table, and a 4-byte-aligned Float32Array view.

Measured with 40 trees: 8,721 bytes gzipped. Sign agreement with `booster.predict` is 100 percent across the validation set. Scoring cost is 0.010 ms for 30 candidates on a page — three orders of magnitude below the DOM work around it.

`smelt export --npm` inlines the artifact as base64 into one self-contained `.mjs`, so a consumer installs one file plus the wrapper. The JSON artifact stays in the package for audit; the inlined copy is what the wrapper loads.

#### 3.1.5 Confidence and calibration

Per-candidate probabilities come from the forest. The page-level verdict maps candidates to a decision by max score with a threshold, plus a tie-break on subtree size. The threshold is calibrated on a held-out slice of the dev split — never on the frozen test, which exists for the gate only. The calibration method ships in `MODEL.md`.

#### 3.1.6 The transformer promotion rule

A task may promote to a small transformer student only when all three hold:

1. The forest plateaued (the overnight ratchet stopped gaining for 40 consecutive discards).
2. The residual error is text-semantic, meaning the misclassified pages need reading, not measuring.
3. The task accepts 15 to 35 MB.

The promotion path is TinyBERT-class (TinyBERT_General_4L_312D), int8 ONNX, on ONNX Runtime Web 1.29.0. Mozilla's `tinybert-address-autofill` is the precedent: about 14M parameters, uint8 at 14.6 MB, running client-side in Firefox. The promoted model ships in a separate opt-in package, never inside the default task package (see 3.4.2 for the size arithmetic that forces this).

### 3.2 The overnight loop

#### 3.2.1 The autoresearch pattern

Andrej Karpathy's autoresearch project (verified, 2025) runs a nightly loop over a codebase: a fixed `prepare.py`, a fixed `train.py`, and a `program.md` that a human owns. An agent edits only the code under study. One metric (`val_bpb`) decides keep-or-discard on a fixed time budget. Roughly 100 experiments run per night. There is no harness framework; the loop is a script plus a stateless agent call.

Smelt adopts the pattern with the roles fixed by file:

| File | Who edits | Holds |
|---|---|---|
| `prepare.py` | nobody (fixed) | Crawl, freeze, teacher-label, split |
| `rules.ts` | the agent | Declarative rules — the features |
| `train.py` | nobody (fixed) | Fit the forest over vectorized rules |
| `program.md` | a human | Task spec, labeling policy |
| `eval.py` | nobody (fixed) | One metric on a frozen set; size and latency gates |

The agent is stateless per iteration: `claude -p --output-format json` with the failure digest and the current rules. Verified on Claude Code 2.1.220: the JSON result carries `total_cost_usd` and full usage including cache-read tokens, which is how the loop meters itself against its budget.

#### 3.2.2 The iteration

One iteration:

1. The runner extracts the current failure digest from `results.jsonl`: the top misclassified pages with 1,200-character snippets, ancestor paths, and per-rule activation vectors.
2. It calls the agent with the digest, the rules file, and `program.md`.
3. The agent returns a diff to `rules.ts`. One readable diff per iteration.
4. The runner applies the diff, re-vectorizes on frozen snapshots, refits the forest.
5. Gates run in fixed order: size, then latency, then dev F1. A size or latency failure discards without scoring.
6. The ratchet decides: F1 above the incumbent by epsilon keeps the change; otherwise it discards.

Epsilon starts at 0.005 F1. An unchanged-rule run measures training variability only; it does not estimate uncertainty from sampled pages. Estimate that uncertainty with paired resampling over independent domain or template groups on development data. Fix the acceptance policy before the loop starts. Repeated development-set improvements remain exploratory until final holdout evaluation. The F1 unit is fixed (see 3.2.6).

Before scaling the loop, compare hand-written rules, a linear student, a tree student, and agent-improved rules. Use the same data splits and browser harness. Report accuracy, human effort, total cost, and browser latency for each. The agent loop must show a useful gain over the best simpler baseline.

Budget: 300 to 600 iterations in an 8-hour night. The agent call at 30 to 90 seconds is the bottleneck; everything else is seconds. A $40 spend cap per night is hard-coded in the runner.

#### 3.2.3 Guardrails on the agent

The runner rejects any `rules.ts` that:

- Imports anything, or touches network, filesystem, `eval`, or dynamic import.
- Exceeds 200 rules or 1,000 lines.
- Runs longer than 200 ms per page on the vector replay.

Rejected edits count as discards. The experiment log records every iteration: the diff, the gate results, the usage, and a one-line verdict.

#### 3.2.4 Anti-overfitting

- Scoring during the loop uses the dev split only. The frozen test set is physically absent from the loop's inputs.
- Release evaluation runs on the frozen test plus a 200-page adversarial holdout with fresh pages from a re-crawl after training stops.
- A dev-to-test drop larger than 0.03 F1 blocks the release and files an overfit report.
- The ratchet stops the night after 40 consecutive discards.

#### 3.2.5 The layout contract (the gap the critic forced closed)

The problem. The loop evaluates rules in Node over linkedom. linkedom has no layout engine: `getBoundingClientRect` returns zeros, and so does `getComputedStyle` for geometry. The wedge's rules and about half the intrinsic feature block read layout. A loop that trains on zeroed geometry while inference runs with real geometry optimizes a different function than the one that ships.

The contract, in three parts:

1. **Frozen-snapshot schema.** At freeze time, every element gets a pre-order id plus its rect, z-index, fixed or sticky flag, display, visibility, and opacity. The feature JSON that the crawler already writes carries these.
2. **The shim.** In the Node path, a shim injects the freeze-time values so rule callbacks read layout through the same API the browser path uses. One code path for rule semantics; two backends for the data.
3. **The parity fixture.** A CI job runs identical rules in a real browser and in Node over N frozen pages and asserts identical feature vectors. The ratchet may not keep any iteration until parity holds.

This contract is what makes the loop's Node-measured F1 meaningful. It does not fix latency: honest latency still needs a real browser (see 3.4.7).

#### 3.2.6 The metric definition

The gate metric for the wedge at v0.1 is **end-to-end detection F1**, the harmonic mean of precision and recall. Each positive page has one annotated primary banner and a human-verified set of acceptable roots. Before labeling, define acceptable roots as containers that enclose the notice and its controls without unrelated page sections. Annotators explicitly record acceptable ancestors; arbitrary ancestors such as `body` do not qualify.

The evaluator scores the highest-ranked returned root. An acceptable root on a positive page counts as one true positive. A wrong root counts as one false positive and one false negative. No root on a positive page counts as one false negative. A root on a negative page counts as one false positive. This prevents page-presence accuracy from hiding unusable element selection. Publish page-presence F1, exact-root accuracy, precision, recall, and additional returned-root counts alongside the gate.

Use development data for merge decisions and threshold selection. The frozen test is release-only and never feeds failure digests to the loop. After release results guide development, use a fresh independent holdout for the next release claim. Keep earlier tests as regression suites, not unseen evidence.

Ground truth for the frozen test is 100 percent human-verified. At 1,000 pages this costs roughly 2 to 4 auditor-days, and it removes the failure where a student scores 0.95 against its teachers while sharing their blind spot. Teacher-human agreement on train and dev is measured and published with every release (see 3.3.6).

#### 3.2.7 Loop cost and diagnostics

Agent cost per night, at Sonnet-class pricing of $3 per million input (with cache reads) and $15 per million output: $15 to $86 across 300 to 600 iterations, capped at $40 by default. A quarter of iterations hit the cache heavily; the digest is bounded at about 8,000 tokens.

One diagnostics schema serves both consumers. `results.jsonl` is the single source: per-page outcome, per-rule activations, `next_action`, and stats. The agent digest is a deterministic projection of it; the human table is another. Golden-file tests cover the top 20 `next_action` messages.

### 3.3 Corpus and labeling

#### 3.3.1 Composition

Start with a few hundred human-labeled pages for the Steel pilot. Expand to 5,000 pages only after the baseline and integration experiments support the task. The expanded corpus contains one page per domain:

- Target 3,000 positives and 2,000 negatives, drawn from public domain lists and research seeds. Collect both classes from European and US egress locations. Location never determines the label. Include newsletter popups, footer notices, and age gates as hard negatives.
- Control and publish language, location, consent-platform family, custom-banner share, viewport, and browser-state distributions. Include both fresh and returning browser states where the task requires them.
- Split: 3,000 train, 1,000 dev, 1,000 frozen test. Keep related domains and duplicate templates in the same split. Reserve consent-platform families absent from training for a separate generalization report. Human-verify the frozen test in full.
- Sample by distinct cases rather than raw session count. Cap repeated templates and include failures and teacher disagreements. Keep all captures from the same session or workflow together when splitting private evaluation data.

#### 3.3.2 Capture

Use dedicated Steel cloud browsers as the first capture backend. Record browser version, viewport, egress location, storage state, navigation timing, and capture timing with each page. Local Playwright remains a reproduction path. Measure browser and storage costs even when Steel supplies capacity internally.

For authorized private workflow evaluation, capture the state before detection, the selected element, and the state after the caller's action. Task success is supporting evidence, not an automatic label for every intermediate selection. Customer-session samples remain separate from the public crawl artifacts and teacher-labeling pipeline.

Playwright 1.63.0 (verified latest) drives the crawl. Freezing uses the single-file engine, embedded (verified 2026-09-06 against the 2.9.2 source): the crawler injects the single-file script with `page.addInitScript` and calls `getPageData` through `page.evaluate`, so Playwright owns the page. The CLI binary cannot take this role — it always creates and closes its own tab, even when it attaches to an external browser over `--browser-server`. The engine strips script elements by default (`blockScripts` and `removeNoScriptTags` both default true; JSON-LD script elements survive), which is what the stripped snapshot wants. The third-party `playwright-single-file` package is rejected: AGPL-3.0 and unmaintained since 2024. freeze-dry is dead since 2022.

Crawl posture, measured: from one EU datacenter on the Tranco top 10,000, headless Chromium draws a 15.2 percent soft-block rate (HTTP 403, 429, or 503) while headed Chromium and any Firefox draw 6.8 to 7.2 percent (ARES 2026). So the crawler runs headed Chromium or Firefox, never headless Chromium. No published study compares datacenter against residential blocking; the 200-domain EEA pilot stays the only path to that number.

From each frozen page the pipeline writes:

- A **stripped DOM snapshot**: skeletonized and scrubbed, per the public-layer policy in 3.3.7.
- A **feature JSON**: the frozen layout per element (the 3.2.5 schema) plus intrinsic features.
- A **WARC record**: kept off-mirror, in the gated archive.

Politeness: `SmeltCorpusBot/1.0` user agent, robots respect via protego, TDM Article 4 opt-out exclusion, one page per domain, rate caps. The contact URL points at the project repository until a project domain is registered.

#### 3.3.3 The label schema

Per page: `has_banner`, `acceptable_roots` (human-verified evaluation references), `banner_root` (an element reference; the shipped model tags it `data-smelt="banner"` for compatibility with the Fathom lineage), `banner_kind`, `jurisdiction`, `frame` (is the banner inside a cross-origin iframe), `evidence` (quoted text and attributes), `confidence`.

Two schema decisions close critic gaps:

- **Dismiss controls are cut from v0.1.** The API returns detection plus root plus kind. The README snippet highlights; it does not click. Dismiss-selection labels (`dismiss` targets, `variant`) move to v0.2 with a teacher prompt extension, a schema extension, and a matching metric. The demo extension stays a radar, which also keeps it clear of consent-clicking liability.
- **Cross-origin frames are measured, not hidden.** The `frame` field exists from day one. The datasheet publishes the cross-origin fraction of positive pages. A top-frame runtime cannot see cross-origin CMP iframes; that blind spot gets a number, and the all-frames extension work lands in v0.2 against a corpus that can already evaluate it.

#### 3.3.4 Teachers

Two teachers from different vendors label every page. The page-plus-root schema in 3.3.3 is the primary teacher output; candidate-level labels derive from the root at vectorization time.

Teacher input is a sanitized, canonicalized DOM serialization: comments, hidden nodes, and free text stripped or capped. Structure carries most of the label signal, and sanitization is also the prompt-injection defense (see 3.5.6).

A programmatic DOM verifier checks teacher answers for visibility, geometry, and text plausibility, and can reject or flag a label before it enters the corpus.

#### 3.3.5 Teacher choice is a legal decision

Verified terms, September 2026:

- **OpenAI** Services Agreement (effective 2026-01-01), section 3.3(e): output use to build classifiers is a Permitted Exception only if the models are "not distributed or made commercially available to third parties." A Smelt student is exactly a distributed classifier. OpenAI use therefore rests on a written no-competition rationale, not a safe harbor.
- **Anthropic** Commercial Terms (effective 2025-06-17): outputs are owned by the customer, and Anthropic does not train on customer content. Section D.4 bars using the services to build a competing product or to train competing models. A 50 KB DOM classifier can carry a written no-competition rationale, but the rationale must be written.
- **Google** Gemini API terms (effective 2026-03-23): the paid tier is excluded from product improvement; the free tier is not, and free-tier EEA or UK content may be read by human reviewers.

Policy: the default teacher pair is **Gemini 2.5 Flash-Lite (paid tier) plus one Anthropic model**. Every adapter ships with a written rationale in its config. OpenAI nano-tier ships as opt-in, documented the same way. Free tiers are banned for labeling. Every `MODEL.md` records teacher vendor, model id, date, prompt hash, and terms version — so a terms change turns relabeling into a scripted job. An open-weight local teacher (a Qwen-class model served locally) is the v0.2 escape hatch.

Nano-tier price check, for the budget arithmetic: Gemini 2.5 Flash-Lite at $0.10 per million input and $0.40 per million output is verified. GPT-5-nano is $0.05 in / $0.40 out per million at standard tier, $0.025 in / $0.20 out at Batch (Appendix C, pinned 2026-09-06). The $11-to-$14 corpus-labeling figure assumes a nano-tier pair; the default Anthropic-plus-Gemini pair costs more and must be measured before it is quoted.

#### 3.3.6 Verification and audit

- The 1,000-page frozen test is 100 percent human-verified (2 to 4 auditor-days).
- A 200-page stratified audit of train and dev over-samples teacher disagreements. Gate: 95 percent agreement, element-level Cohen's kappa reported.
- Teacher disagreement rate is a published per-release metric, so drift in teacher quality is visible.
- Frontier-model adjudication of the disagreement set costs single-digit dollars and is budgeted per release.
- Consent-O-Matic serves as a second oracle on the known-CMP slice.

The 0.90 gate is reported against the human-verified test set. The known-CMP versus custom-banner share of the test set is published next to the F1, so the gate is interpretable: 0.90 on a corpus that is 80 percent known CMPs is a different claim from 0.90 on a corpus that is 40 percent custom banners.

#### 3.3.7 Licensing and publication

Three layers, three licenses:

- **Code** (runtime, trainer, crawler, rules files): MPL-2.0, matching the lineage. File-level copyleft let Firefox vendor `fathom.mjs` and let Proton fork the runtime inside a closed product. That property is the adoption argument for browsers and password vendors.
- **Model artifacts** (forest coefficients, quantized weights): CC-BY-4.0. Weak data licensing maximizes consumption and implies no copyleft for numbers.
- **Corpora**, split by exposure:
  - **Public layer** (ODC-By 1.0): URL manifests, crawl recipes, labels, feature vectors, content fingerprints, and the scrubbed stripped snapshots — which must be sufficient for CI to recompute F1 and size (the registry reproduction requirement, 3.5.5).
  - **Gated layer**: WARC archives and unscrubbed snapshots, on Hugging Face with access-logged requests. Full-page redistribution carries copyright and personal-data exposure. Mozilla's training repositories went dark while shipped code still cited them; Smelt does not repeat that shape.
  - PII scrub runs before anything leaves the crawl machine. A takedown form with a fast removal SLA is public. Pre-clear the public-layer shape with Hugging Face before the first upload.

Regeneration, quarterly: store `cmpId` and `banner_kind` at crawl time, publish a label-flip drift report, and keep per-CMP-family slices of the frozen-test F1. A 5-point holdout drop triggers an off-cycle rebuild. Anyone can rebuild between quarters; that is the point of the factory.

### 3.4 Runtime engineering

#### 3.4.1 Size and latency budgets

Three measured quantities, two gates:

- **Transfer size**: gzip of the shipped ESM plus model. Gate: under 50 KB total for the wedge package. Budget split: engine under 10 KB, rules 8 to 15 KB, forest 10 to 20 KB. Calibration: all of Fathom gzips to 7.3 KB, so this is achievable with margin.
- **Parse cost**: minified bytes plus `JSON.parse` time, because content scripts re-initialize on every page load. `JSON.parse` of a 50 KB model costs 0.2 to 0.5 ms — acceptable, and tracked.
- **Latency**: wall clock around a full `detect(document)` in-page. Gate: p95 under 5 ms at 4x CPU throttle on the declared reference machine.

The reference machine, one and only one: a declared 2020-class laptop at 4x CPU throttle via Chrome DevTools Protocol `Emulation.setCPUThrottlingRate`. The throttle factor is calibrated quarterly against one physical low-end Android device over adb. The gate text in the registry names the machine.

#### 3.4.2 Execution tiers

- **Tier 0 (default, v0.1): pure JavaScript.** Rule callbacks plus decoded-tree scoring. Runs in content scripts, page scripts, and workers. No CSP exposure anywhere. This tier carries the whole wedge.
- **Tier 1 (speculative): a hand-built WASM tree kernel**, 10 to 20 KB, behind a per-context probe. Build it only if benchmarks show model arithmetic above 20 percent of runtime. Fathom's profiling says 80 percent of runtime is DOM calls, so this tier may never be worth its bytes.
- **Tier 2 (opt-in package): ONNX Runtime Web WASM** for transformer students, in a long-lived extension context. Verified cost: onnxruntime-web 1.29.0 is 49 KB of JS plus a 13.6 MB WASM file before any weights. This is why it can never ship inside the default package.
- **Tier 3 (opt-in package): WebGPU** via the jsep build (27.1 MB WASM), hosted in a Window or DedicatedWorker context only.

Feature detection is a one-time per-context probe: `WebAssembly.validate` for WASM (this is what catches strict page CSP in content scripts), then `navigator.gpu` plus a `requestAdapter` round trip for WebGPU. Results cache per context and report in `result.stats.tier`.

#### 3.4.3 The content-script WASM trap

Chrome Manifest V3 requires every executable byte inside the package and bans remote code. WASM needs `wasm-unsafe-eval` in the `extension_pages` CSP. But a content script compiles WASM under the **host page's** CSP (Chromium issue 40879417) — strict-CSP sites such as GitHub block extension-bundled WASM too. Firefox MV3 also asks for `wasm-unsafe-eval`, and its background context is an event page with DOM access, not a service worker.

Design consequences:

- Tier 0 is pure JS by design, so the default path runs on every page regardless of page CSP.
- Tier 2 and 3 hosts: `chrome.offscreen` document on Chrome 109+; background event page on Firefox. Never a content script, never the MV3 service worker (ONNX Runtime issue 20876 documents both failing).
- One message protocol, `smelt:run`, carries bounded feature vectors and text extracts of candidate nodes — never raw HTML — across the host boundary. The ONNX session is created once per browser session and reused.

#### 3.4.4 Package architecture

`@smelt-oss/runtime`: zero dependencies, pure ESM, `sideEffects: false`, an exports map, no jsdom. Per-module entry points, so a consumer who only calls `detect` never downloads clustering or utils. Fathom's single UMD bundle is the rejected alternative.

Rules are bundled code; the model is data. That split (Fathom's own) lets the model be fetched, cached, and integrity-checked while code stays bundled — which the no-remote-code rule requires. On the npm-library path where a model is fetched, verify sha256 with `crypto.subtle.digest` before parsing, key Cache Storage by content hash, and treat integrity failure as a hard error. Extension-path models are bundled, so integrity is inherited from the package review.

#### 3.4.5 The composed-tree walker

Candidate generation walks the composed tree: it recurses through `element.shadowRoot` for open roots, because `querySelectorAll` is blind to shadow DOM. Closed roots are unreachable and documented as out of scope. A fast path uses native selectors when the document contains no shadow roots, so the walker's cost appears only where it is needed.

#### 3.4.6 Wild-mode behavior

- **Single-page applications.** `watch(doc, callback, {debounceMs})` lands in v0.2: MutationObserver on childList and subtree, 150 to 300 ms debounce, `requestIdleCallback` coalescing, a revision token that cancels in-flight runs, and a re-trigger on the Navigation API when present. v0.1 ships `detect` only.
- **Iframes.** Same-origin frames are walked directly through `contentDocument` (Fathom commit 96cbd5d is the precedent). Cross-origin frames need `all_frames: true` content scripts, each running Tier 0, with results aggregated in the background keyed by frame id; v0.2 work item.
- **Gigantic pages.** An element budget (20,000 nodes default) stops the walk, sets `stats.truncated`, and feeds truncation plus node count into training as features, so the student learns degraded-page behavior instead of failing silently.
- **Long tasks.** Yield with `scheduler.yield()` (Chrome 129+, Firefox 142+, absent in Safari) falling back to a MessageChannel yield. Rect reads are memoized per element and skipped for `checkVisibility()`-hidden subtrees.
- **Failure shape.** Every failure mode returns a structured result with `stats`. Never an exception for page-level failure; never an empty success that hides a timeout.

#### 3.4.7 The benchmark harness

`smelt bench` is a product, not a script:

- It replays frozen rendered DOMs in Playwright Chromium and runs `detect(document)` in-page with `performance.now()`, three warm-ups then 30 measured repetitions, reporting p50 and p95 per page and corpus-wide.
- jsdom is invalid for latency (it returns zero rects); the harness never uses it.
- Probe sets, named: `ci-50` (50 pages, every pull request), `dev-1000` (the dev split, nightly), `frozen-1000` (releases only).
- Merge checks use `ci-50` for size and latency, plus a development regression suite for accuracy. The frozen test runs only for release evaluation. A noisy timing result triggers a rerun; the published release limit remains under 5 ms.
- A quarterly physical run (one desktop, one 2020 laptop, one low-end Android over adb) calibrates the throttle factors.
- Results publish as JSON with every release, so the dashboard plots ms-per-page over time. That is the number adopters ask for first.

The loop's internal iteration gate runs on Node vector replay for speed; it is a filter, not a claim. The published latency number always comes from the browser harness.

Report first-call latency, initialization cost, and repeated-call latency separately. Include live pages with pending layout work and delayed banners. Measure the full call, including candidate collection and geometry reads. Steel cloud results measure deployment behavior; they do not replace the reference-machine gate for the portable package.

### 3.5 Ecosystem, legal posture, and security

#### 3.5.1 Names (resolved)

The name is Smelt. Three meanings, all on target: a small sea fish related to the fish Fathom was named for; to smelt ore into metal; to smelt out a thing by instinct. No live USPTO software mark exists (classes 9 and 42 checked). The namespace is crowded, so handles are unique:

- npm `smelt` is a dead 2015 stub. The `@smelt` scope is owned (a dormant 2022 React framework, `@smelt/core` 0.0.12). `@smeltjs` was claimed 2026-09-02 by an active project. `@smelt-ai` is active.
- **Decision: every install string uses `@smelt-oss/*`.** Verified free: the `smelt-oss` GitHub org, the `@smelt-oss` npm scope, `@smelt-oss/core` today.
- Python side: PyPI `smelt`, `pysmelt`, and `smelt-ml` are taken. The trainer ships as **`smelt-train`** (verified free).
- Domains: `smelt.dev` and `smelt.sh` are registered. `getsmelt.org` and `smeltml.org` are available. Print no domain in any document until it is registered; the crawler contact URL points at the repository.
- A one-page disambiguation note names the neighbors with links. No trademark filing in year one. Rename trigger: two or more misdirected issues, security reports, or press conflations in one quarter.
- A week-1 naming gate re-checks every registry the same day before the first publish, and pastes the checks into decision record 0002. The check that matters is a direct GET on `registry.npmjs.org/@scope%2Fname` — the npm search endpoint returns zero for scopes it fails to index, which is exactly how one design thread was misled.

#### 3.5.2 The Node-to-Python bridge (resolved)

The factory is Python (`prepare.py`, `train.py`, `eval.py`, LightGBM). The command surface is a Node CLI installed through npm. `npx smelt train` must work for a stranger.

**Decision:** `@smelt-oss/cli` is a thin Node launcher. On first run it provisions a `uv`-managed Python environment with pinned wheels, then drives the Python factory. The quickstart budget absorbs the provisioning cost; measure the added minutes and publish the honest number. Rejected alternative: porting the trainer to Node — there is no first-class LightGBM binding there, and the port is weeks of real work. Windows without WSL is tested in roadmap week 3 and recorded as a v0.1 exit criterion, with WSL documented as the fallback.

#### 3.5.3 Funding

- **NLnet**: general calls reopened after summer 2026 with new Open Internet Stack funds. Next deadline 2026-11-03, 12:00 CET. First awards EUR 5,000 to 50,000. Open licences required. One hard rule: AI-generated proposals are excluded and AI assistance must be disclosed with prompt logs. Smelt's factory is an agent that writes rules overnight, so the proposal frames the agent as a tool a human maintainer operates, and the repo keeps prompt and iteration logs from day one to make the disclosure cheap. Budget shape: EUR 45,000 over 9 months — about EUR 8k teacher APIs, 12k crawl and storage, 20k maintainer time, 5k contingency.
- **Sovereign Tech Fund** (now Sovereign Tech Agency inside SPRIND): active, funds globally, EUR 50k to 500k historically. The successor track if Smelt outgrows NLnet.
- **GitHub Sponsors** from day one: 0 percent platform fee on personal-account sponsorships.
- The EC-funded NGI Zero Commons Fund closed for good on 2026-06-01. That door is shut; do not plan around it.

#### 3.5.4 Design partners

Steel is the first internal integration partner. Its pilot compares the existing agent workflow with the same workflow using Smelt. Internal adoption does not count as independent market validation.

A public, month-to-month `DESIGN_PARTNERS.md` tracks external partners:

- **Proton first.** They run `@protontech/fathom` (0.0.38040317, published 2026-08-18; about 7,493 downloads a month versus 1,710 for dead upstream) with no public source. The offer: migrate to a shared upstream where their field-detection improvements land in the open.
- **The autoconsent-adjacent world second.** duckduckgo/autoconsent (MPL-2.0, active) drives known CMPs; Smelt detection is the general find step their rules lack. A joint benchmark on unknown banners is a launch artifact.
- **One agent-framework builder third**, for the grounding research track.

Partners owe corpus donations (URL lists from their domain — never user data), failing-page reports, one public acknowledgment, and registry engagement. Target: three signed partners by day 60, at least one outside the password-manager world.

#### 3.5.5 The registry

An in-repo `registry.json`, not a service. Each entry pins: task name, version, sha256 of model, rules, and corpus revision, the CI-measured F1, size, and latency, and a tier.

- **Verified tier**: the project's own tasks, with maintainer-owned frozen tests and full gate re-runs in CI.
- **Community tier**: third-party tasks. CI recomputes F1 and size from the public corpus layer (scrubbed stripped snapshots, labels, vectors — which is why the public layer must be sufficient for reproduction, 3.3.7). Latency is accepted from the authoring CI's signed benchmark report; the entry states which gates were re-verified and which were attested.
- Registry entries arrive as pull requests. CI rejects entries whose numbers do not reproduce.
- Deprecation, never deletion: six months stale or an F1 drop over 5 points on a refreshed probe earns a stale badge, then 60 days to refresh, then archive.

Corpus-aware semver: a corpus regeneration ships as a MINOR with a `SIDEGRADE` label when scores shift materially; PATCH never changes weights; the model artifact carries `modelVersion` from v0.1 (not v1.0 — shipped artifacts outlive repositories; Firefox's vendored 3.7.3 proves it).

#### 3.5.6 Security: the poisoned teacher

Teacher labels run once over semi-arbitrary public pages, then freeze into a test set and a student. An adversary who wants their banner missed can inject text into crawled pages that manipulates the teacher (indirect prompt injection; Greshake et al., 2023, arXiv 2302.12173). Attack surfaces: hostile page text, malicious corpus submissions, distribution gaming.

Countermeasures, all in the architecture:

- Sanitized DOM serialization as teacher input (3.3.4).
- Two vendors' teachers must agree; disagreements go to human review — disagreement signals attacks and ambiguity alike.
- A hand-audited frozen canary set of a few hundred pages re-runs on every registry rebuild.
- CI computes per-corpus statistics — teacher-agreement rate, domain concentration, near-duplicate ratio, feature-distribution shift against the canary set — and blocks merges on anomalies.
- Any corpus contribution from a single interested party is treated as adversarial until audited.
- Labels are derived data. A compromised corpus relabels with a different teacher as a scripted operation; provenance stamps make it cheap.

#### 3.5.7 Platform absorption

The standing threat: browsers ship their own page-understanding models and APIs. Firefox's TinyBERT form model lives inside Firefox with 49 downloads a month on its weights — nobody builds on it. Chrome's Gemini Nano Prompt API is a platform API, not a redistributable library. WebNN is still not stable in more than one engine.

Response: Smelt serves the cross-browser neutral layer — extensions, Node, server-side reuse — that a browser-internal model serves none of. Track WebNN for early compatibility adapters. Keep the wedge task one that browsers will not prioritize. Trigger for a messaging pivot: any browser ships a stable, extension-accessible page-understanding API.

---

## Part 4 — Execution

### 4.1 Six weeks to a Steel pilot decision

Start with one task and a few hundred human-labeled pages. Steel supplies dedicated cloud browsers and the first deployment path. Customer-session access is optional for this pilot. Account for browser capacity, labeling, storage, and engineering time even when supplied internally.

| Week | Starting | Deliverables |
|---|---|---|
| 1 | 2026-09-07 | Rank Steel workflow failures. Confirm the task and current workflow baseline. Define labels, acceptable roots, primary workflow metric, and regression limits. Continue the runtime port. |
| 2 | 2026-09-14 | Dedicated Steel captures with controlled locations and browser states. A few hundred human-labeled pages. Grouped train, development, and unseen evaluation splits. |
| 3 | 2026-09-21 | Compare hand-written rules, a linear model, and a tree model. Validate layout parity and complete browser latency. |
| 4 | 2026-09-28 | Test a bounded agent loop against the best simpler baseline. Record accuracy, human effort, and total cost. Integrate detection into a controlled Steel workflow. |
| 5 | 2026-10-05 | Compare matched workflows with and without Smelt. Measure task completion, model calls, cost per completion, and latency. Test new sites and delayed banners. |
| 6 | 2026-10-12 | Review pilot evidence on 2026-10-16. Continue, change the task, or stop. Expand to the release corpus only if the result supports it. |

The first milestone is one useful detector in Steel with a controlled benchmark. The general factory, registry, extension-store submissions, and broad platform support follow this evidence. The runtime port remains a subset of Fathom with in-process vectorization over linkedom and the layout shim.

### 4.2 Milestones after the pilot

Dates depend on the pilot outcome. The former 2026-10-16 public launch is now a pilot decision date, as recorded in decision 0003.

- **v0.1, first product.** Exit: useful Steel workflow results against predeclared limits; detection F1 at or above 0.90 on 1,000 human-verified unseen pages; under 50 KB gzipped; under 5 ms at p95 on the reference machine. Publish the package, model card, benchmark, and reproduction artifacts. Seek one independent integration.
- **v0.2, repeatable training.** Exit: a contributor rebuilds the first task from the public corpus. Demonstrate a useful agent-loop gain before generalizing the factory. Add local teacher support, `watch()`, and frame coverage according to measured failures.
- **Later tasks.** Select the next detector from Steel failures and external adopter needs. Each task needs its own labels, baseline comparison, and workflow evaluation. Form fields remain a candidate.
- **General factory and registry.** Proceed when a second task demonstrates reuse and an external contributor can train it. Transformer execution tiers remain deferred until a measured task requires them.

Freeze public contracts only after these integrations establish their requirements.

### 4.3 Metrics

The primary dashboard reports the Steel pilot: acceptable-root accuracy, detection precision and recall, task completion, model calls, cost per completed task, added browser latency, and human effort per update. Report sample counts and uncertainty. Split results by unseen domains, templates, consent-platform families, and capture conditions.

Compare the current workflow against Smelt on matched task cases with isolated browser state. Keep agent model, prompts, and action policy fixed. Include failures in cost accounting: total run cost divided by successful completions. Report browser runtime and infrastructure cost separately because faster sessions may also reduce billed usage. Report capture, teacher, training, and review costs separately from inference savings. Measure autonomous-loop value against the best simpler baseline.

A weekly GitHub Actions cron writes `metrics.json` and a static page to GitHub Pages, fed by free public APIs: npm downloads (`api.npmjs.org`), PyPI (`pypistats.org`), GitHub stars, forks, contributors, registry task count, per-task CI eval, store counters, and opt-in quickstart completions.

The privacy stance forbids CLI telemetry. External completion signals are opt-in: the quickstart prints a pre-filled GitHub issue link and an `ADOPTERS.md` pull request invitation. Every figure derived this way carries a lower-bound label. These signals support the public adoption reviews; they do not replace measured workflow value.

The dashboard records the pilot decision and the later public-launch date. Decision 0003 supersedes the dates and continuation rules in decision 0001. External adoption signals remain secondary evidence during the Steel pilot.

### 4.4 Governance

- **Decision records**: MADR-format markdown in `decisions/NNNN-title.md`. Immutable once accepted; corrections arrive as new records.
- **Merge policy**: the maintainer merges initially; contributors earn merge rights on non-frozen paths after three merged pull requests. Frozen files (`prepare.py`, `train.py`, `eval.py`, the rules grammar) additionally require a decision record and a seven-day comment window, because every trained model depends on their exact semantics.
- **Bus factor**: a second person must be able to cut a release before v0.2 ships. Release automation from week 1 — changesets plus CI publish on tag, no manual npm step. Fathom died partly because PyPI silently never received its final two versions while the tag claimed otherwise; automation removes that failure.
- **Charter limits**: the core stays under 2,000 lines; tasks live as plain files; the portable runtime requires no service or account. Steel hosts collection and private workflow evaluation. Public artifacts exclude customer-session content. The research track is firewalled in a separate `smelt-labs` repository with a hard cap of 10 percent of maintainer time and a graduation rule: a labs result enters the product line only via a decision record plus a working prototype on the product harness.
- **Contribution primitive**: a corpus, not a commit. A corpus pull request contains `manifest.json`, pages or crawl recipes, labels from a pinned teacher pair, and a `program.md` diff if policy changed. Two gates: a human gate for legality and representativeness (robots respect, rate limits, negative pages per Fathom's `.N` convention), and an automated gate computing teacher agreement, domain concentration, near-duplicate ratio, and canary drift. `CITATION.cff` credits curator, rubric author, and auditor. The rules agent's runs appear in the experiment log, never as authors.

### 4.5 Risks

| Risk | Trigger | Response |
|---|---|---|
| Platform absorption | A browser ships a stable, extension-accessible page-understanding API | Pivot messaging to extensions, Node, and the long tail; ship WebNN adapters early |
| Corpus rot | Frozen-test F1 drops 5 points on refresh, or a takedown arrives | Off-cycle rebuild from recipes; public layer keeps low exposure; deprecate with history, never silently delete |
| Loop overfitting | Dev-to-test drop over 0.03 F1 | Release blocked; adversarial holdout report; stop after 40 discards |
| Label noise | Teacher agreement falls, audit fails 95 percent | Adjudication pass; relabel with a different pair; publish the disagreement rate |
| Teacher terms change | A new training-artifact restriction in any vendor's terms | Quarterly ToS audit on the calendar; relabel via provenance stamps; local open-weight teacher as the escape hatch |
| Name confusion | Two or more misdirected issues or reports in one quarter | Disambiguation page; pre-agreed rename shortlist |
| Maintainer burnout | Fewer than a handful of commits in 60 days, or pull requests unreviewed for 30 days | Second releaser before v0.2; NLnet funds a second contributor; the archive path exists from day one |
| No demand | Kill-criteria clock fires | Section 4.6 |

### 4.6 Kill criteria and the archive path

Decision 0003 supersedes decision 0001's calendar and continuation rules. On 2026-10-16, review the Steel pilot against its predeclared workflow limits and simpler baselines. Continue when Smelt improves task completion or cost per completed task without a material regression in the other. If the loop adds no useful gain, retain the simpler trainer. If the task adds no workflow value, change the task or stop that integration.

Public-launch day 0 is the actual first product release. Register day-30, day-60, and day-90 review dates at launch. Review reproducibility, independent integrations, maintenance effort, and measured Steel value. Downloads and opt-in completions are supporting evidence, not automatic closure thresholds. Steel adoption alone does not establish external demand for a general factory.

Narrow to a single-task library when that task is useful but generalization lacks evidence. Keep its trainer and reproduction path maintained. Do not archive the trainer while promising repeatable model updates. Pause a task below its release gates; do not publish a failing model merely because an adoption target was met.

Before any public archive, publish the evidence and give contributors a 14-day comment window. Offer transfer to a willing maintainer, tag a final release, preserve public reproduction artifacts where possible, and publish `POSTMORTEM.md`. Private session evaluation data stays under its existing access and retention controls.

---

## Appendix A — Glossary

- **Teacher.** A large language model that labels corpus pages once, at training time.
- **Student.** The small model that ships: rules plus a gradient-boosted forest.
- **Factory.** The open toolchain: crawl, freeze, label, train, loop, test, export.
- **Frozen DOM.** A rendered page captured at crawl time as a static snapshot plus per-element layout data.
- **Ratchet.** The keep-or-discard rule in the overnight loop: a change survives only if dev F1 beats the incumbent by epsilon.
- **Rules file.** `rules.ts`: the declarative feature definitions a human can audit and an agent can edit.
- **program.md.** The human-written task spec: task, examples, edge-case policy, threshold policy.
- **Registry.** The in-repo `registry.json` of trained tasks with pinned hashes and CI-reproduced gates.
- **Layout contract.** The frozen-snapshot schema plus the Node shim plus the parity fixture that keep training geometry equal to inference geometry.
- **Tier 0 to Tier 3.** Execution paths: pure JS; WASM kernel; ONNX WASM; WebGPU.

## Appendix B — Prior art and landscape

| Approach | Where | Cost per page | Status, September 2026 |
|---|---|---|---|
| Regexes, selectors | Local | $0 | You maintain them |
| readability 0.6.0, defuddle 0.19.3 | Local | $0 | Maintained; articles only |
| trafilatura 2.2.0 | Local (Python) | $0 | Maintained; offline batch |
| fathom-web | Local | $0 | Archived 2025 |
| @protontech/fathom | Local | $0 | Active fork; no public source |
| Firefox TinyBERT (14M, uint8 14.6 MB) | Local | $0 | Internal to Firefox; weights published, 49 downloads a month |
| LLM APIs, ReaderLM-v2 | Remote | $0.001 to $0.003 | Vendor lock; ReaderLM is CC-BY-NC |
| duckduckgo/autoconsent | Local | $0 | Drives known CMPs; does not detect unknown banners |
| **Smelt** | **Local** | **$0** | **Open; any DOM task; this document** |

Research neighbors: Prune4Web (DOM pruning lifts grounding from 46.8 to 88.3 percent); SeeAct (grounding, not planning, is the bottleneck); MarkupLM and successors (GPU-class DOM encoders); Brave SpeedReader (a shipped gradient-boosted page classifier at 91 percent accuracy); Karpathy's autoresearch (the loop pattern).

## Appendix C — Verified facts ledger

Checked against primary sources, September 2026:

- mozilla/fathom: archived 2025-11-18; last commit 2022-06-13; runtime 2,767 lines; 20,874 B minified; 7,333 B gzipped; Firefox ships `fathom.mjs` at 98,598 B, release 3.7.3, MPL-2.0.
- Fathom profiling note: 80 percent of runtime is DOM calls (`docs/development.rst`).
- lightgbm 4.7.0; playwright 1.63.0; onnxruntime-web 1.29.0 (49 KB JS, 13.6 MB WASM, 27.1 MB WebGPU build); @huggingface/transformers 4.2.0 (422 KB web bundle); linkedom 0.18.13; single-file-cli 2.9.2 (2026-09-05; scripts stripped by default; CLI cannot attach to a caller's page); freeze-dry dead since 2022.
- Measured student: 40 trees, 8,721 B gzipped, 100 percent sign agreement, 0.010 ms per 30 candidates; training 0.12 s on 10k by 80.
- Gemini 2.5 Flash-Lite $0.10 / $0.40 per million tokens; GPT-5-nano pinned 2026-09-06 from the official pricing page: standard tier $0.05 input / $0.40 output per million tokens, Batch tier $0.025 input / $0.20 output. The disputed $0.20 figure was the Batch output price. Resolved.
- OpenAI Services Agreement effective 2026-01-01, section 3.3(e); Anthropic Commercial Terms effective 2025-06-17, sections B and D.4 — rechecked 2026-09-06, no later amendment shown, "Anthropic may not train models on Customer Content from Services", and the customer owns Outputs; Google Gemini API terms effective 2026-03-23, page last updated 2026-04-28 — Google claims no ownership of generated content, but bars using the Services to "develop models that compete with the Services" (the written no-competition rationale in 3.3.5 answers this).
- NLnet: deadline confirmed 2026-09-06 from nlnet.nl/propose — "Next deadline: November 3rd 2026 12:00 CET (noon)"; EUR 5k to 50k for a first grant; funds are Restack, CodeSupply, or the open call. AI use must be disclosed with prompts attached, and AI-generated projects are not accepted. NGI Zero Commons Fund closed 2026-06-01.
- Namespace: taken — npm `smelt`, `@smelt`, `@smeltjs`, `@smelt-ai`, PyPI `smelt`, `pysmelt`, `smelt-ml`. Free — GitHub org `smelt-oss`, npm scope `@smelt-oss`, `smelt-web`, PyPI `smelt-train`, `getsmelt.org`, `smeltml.org`. `smelt.dev` is in pendingDelete.
- @protontech/fathom 0.0.38040317 (2026-08-18), about 7,493 downloads a month; fathom-web 1,710.
- Chrome Web Store registration $5 one-time; AMO signing free.
- CookieBlock (USENIX Security 2022): cookie classification, not banner detection — 84.4 percent accuracy against an 84.7 percent human baseline, with at least 7.2 percent label noise on CMP-derived labels (ceiling near 92 percent). An earlier draft of this document misread its "94.7 percent" figure as CMP-rule applicability; it is the share of analyzed sites with at least one potential GDPR violation.
- CookieEnforcer (USENIX Security 2023): learned banner detection — 0.97 candidate-element F1 on 505 annotated candidates from 250 sites; 93.7 percent correct end-to-end opt-out sequences on 1,000 domains.
- Bot blocking (ARES 2026, arXiv 2606.14525): from one EU datacenter on Tranco top 10k, soft-block rates are 15.2 percent for headless Chromium versus 6.8 to 7.2 percent for headed Chromium and any Firefox.
- Hugging Face corpus hosting, verified 2026-09-06: the Content Policy (effective 2025-04-10, still current) polices datasets only through the general IP-infringement rule plus DMCA notice and counter-notice; it sets no dataset-specific licensing or provenance requirement. Publisher takedowns against scraped-web corpora are real and sometimes enforced: Torstar against FineWeb (2025-01-22), BBC Studios against fineweb-bbc-news (2025-11-12, dataset disabled), plus NYTimes (2024-04-08) and Guardian (2026-03-24) notices. The official log (67 notices through 2026-09-04) contains no SWDE or SciencesPo entry, and an unlicensed SWDE re-upload has stayed public for about 18 months — the presumed "SWDE takedown" is unverified and must not be stated as fact.
- Chrome Web Store remote code, verified 2026-09-06: remotely hosted code is defined by execution and "does not include data or things like JSON or CSS"; JavaScript and WASM are remote-hosted code by definition, so onnxruntime-web's JS and WASM files must ship inside the package. No policy text names ML weights, and the listed violation "Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data" cuts against treating weights as plain data. The 2026-07-01 policy update (enforcement from 2026-08-01) covers privacy disclosure and product categories only. Refuted in review: the reading that only the Debugger and User Scripts APIs are exempt — isolated contexts such as sandboxed pages are exempt too.
- Firefox WebGPU, verified 2026-09-06: the release channel ships WebGPU on Windows since Firefox 141 (2025-07-22), Apple-silicon macOS since 145, and all macOS since 147; Linux is Nightly-only as of August 2026, with a ship expected during 2026. Firefox MV3 backgrounds run as event pages, and background.service_worker is unsupported (bug 1573659 open). onnxruntime-web has worked in Chrome MV3 service workers since 1.19.0, ESM imports only (ort.webgpu.bundle.min.mjs). No source tests a Firefox event page; the probe in Appendix D item 7 stays empirical.
- Chrome built-in AI, verified 2026-09-06: the Prompt API runs on Gemini Nano, browser-downloaded on first use, with a 22 GB free-disk floor, desktop Chrome only; MDN records the Mozilla and WebKit standardization positions as negative.

## Appendix D — Open questions

1. Resolved 2026-09-06: the single-file engine strips scripts by default and must run embedded in Playwright via `addInitScript` plus `getPageData` (3.3.2). The CLI cannot attach to a caller's page.
2. What share of EEA Tranco domains bot-block a datacenter IP? No published study compares datacenter against residential; the 200-domain pilot remains the only path. Run it headed (Chromium or Firefox): headless Chromium doubles the soft-block rate (3.3.2).
3. Half-answered 2026-09-06: HF dataset review turns on copyright infringement alone — the Content Policy sets no licensing or provenance rule. The presumed SWDE takedown is absent from HF's own notice log; treat it as unverified. The live risk is a publisher DMCA demand of the Torstar or BBC class. Pre-upload conversation still required.
4. What is the measured teacher-agreement rate between the default pair on consent banners? The poisoning defense and the audit gate both need the calibration run.
5. What is the honest end-to-end detection F1 ceiling on a mixed known-CMP and custom-banner corpus? The nearest precedent, CookieEnforcer (0.97 candidate-level F1, 93.7 percent end-to-end), is balanced-set and candidate-level, so it does not establish the acceptable-root detection ceiling. The 0.90 gate stays an assumption.
6. Still open, now bounded (2026-09-06): the policy definition excludes data, but the "interpreter over remotely fetched commands" violation cuts the other way, and no enforcement example exists in either direction. The runtime JS and WASM must ship in the package regardless. Needs a test submission.
7. Narrowed 2026-09-06: release WebGPU exists on Windows (141+) and macOS (147+), Linux is Nightly-only, Firefox MV3 backgrounds are event pages, and ORT must load as ESM. The open question is narrower: does `navigator.gpu` appear, and does the ORT WebGPU backend initialize, inside a Firefox event page? Probe on Windows release and Linux Nightly before the Tier 3 host is fixed.
8. Candidates found 2026-09-06, none verified against primary texts: EDPB Guidelines 2/2023 (v2.0, October 2024) reportedly read ePrivacy Article 5(3) as not covering processing that never leaves the device; CJEU C-604/22 (IAB Europe, 2024-03-07) addresses joint-controller status; a 2025 Computer Law and Security Review paper argues a producer-controller thesis for on-device code. One verification pass is needed before citing any of them.
9. Can the dormant `smelt` and `@smelt` holders be persuaded to transfer? Cheap to ask; do not plan around it.
10. Resolved 2026-09-06 (Appendix C): $0.40 is the standard output price, $0.20 the Batch output price. Name the tier whenever a cost claim is published.

## Appendix E — Decision log

Contradictions and gaps found by the critic pass, resolved here:

1. **Namespace** (three plans conflicted; `@smelt` is taken). Decision: `smelt-oss` GitHub org; `@smelt-oss` npm scope for all JS packages; `smelt-train` on PyPI; `getsmelt.org` when a domain is bought; no domain printed until owned. The rejected alternative (`smelt-web` unscoped, echoing `fathom-web`) stays on the rename shortlist.
2. **Engine architecture** (lazy planner versus fixed pipeline). Decision: compile-time ordering of rule prerequisites, fixed one-pass execution in the shipped runtime. The planner's runtime machinery is training-time convenience; the shipped path stays small and predictable. The engine package is `@smelt-oss/runtime`, not `@smelt/core`.
3. **API shape** (synchronous-only versus `watch()` in core). Decision: v0.1 ships `detect` only. `watch()` is v0.2, experimental, with debounce and cancellation specified (3.4.6).
4. **Default teachers** (three ensembles proposed). Decision: Gemini 2.5 Flash-Lite paid tier plus one Anthropic model, both with written no-competition rationales; OpenAI opt-in with the same paperwork; free tiers banned. Cost arithmetic for the default pair must be measured before publication (3.3.5).
5. **Latency gate venue** (Node versus browser). Decision: the loop's Node replay is a filter; the published gate always comes from the browser harness on the declared reference machine (3.4.7).
6. **Size budget** (50 KB model-only versus 50 KB total). Decision: 50 KB gzipped is the total shipped artifact — engine, rules, model — split per 3.4.1.
7. **Model artifact format** (JSON versus binary versus inlined module). Decision: canonical `model.smelt.json` (JSON envelope, base64 binary column); `smelt export` inlines it into one `.mjs`. Auditability and size both served; `modelVersion` from v0.1.
8. **Quickstart instrumentation** (opt-in ping versus no telemetry). Decision: no telemetry, ever. Pre-filled GitHub issue plus `ADOPTERS.md` pull request; lower-bound labeling on the dashboard.
9. **Corpus totals and probe sets** (5,000 / 2,000 / 1,000 conflicted). Revised 2026-09-07: pilot with a few hundred human-labeled pages, then 5,000 pages split 3,000 / 1,000 / 1,000 if supported; named probe sets `ci-50`, `dev-1000`, `frozen-1000` with fixed roles.
10. **DOM library** (linkedom versus jsdom). Decision: linkedom 0.18.13, confined to the serialized-input path, with the layout shim; jsdom dropped from dependencies.
11. **Dismiss controls** (promised in README, absent from schema). Decision: cut from v0.1; detection plus root plus kind only; v0.2 extends schema, prompt, and metric together.
12. **F1 unit and ground truth** (undefined across threads). Revised 2026-09-07: end-to-end detection F1 requires an acceptable root against human-verified labels. Page-presence F1 is secondary. Unchanged-rule runs measure training variability only (3.2.2, 3.2.6).
13. **Node-to-Python bridge** (undesigned). Decision: `@smelt-oss/cli` provisions a `uv`-managed environment with pinned wheels on first run (3.5.2).
14. **Calibration set** (reused frozen test). Decision: calibrate on a held-out dev slice; the frozen test exists for the gate only (3.1.5).
15. **Registry reproduction versus gated corpora** (in conflict). Decision: the public layer must recompute F1 and size; latency is accepted from signed authoring-CI reports; tier entries state what was re-verified (3.3.7, 3.5.5).
16. **Diagnostics schemas** (two overlapping formats). Decision: `results.jsonl` is the single schema; the agent digest and the human table are projections; `next_action` is the shared contract (3.2.7).
17. **Reference machine** (three candidates). Decision: one declared 2020-class laptop at 4x throttle, calibrated quarterly against one physical Android device (3.4.1).
18. **Teacher output target** (page-level versus candidate-level). Decision: page-plus-root is primary; candidate labels derive at vectorization (3.3.4).
19. **Layout in the loop** (no thread had specified it). Decision: the layout contract — frozen-snapshot schema, Node shim, parity fixture (3.2.5).

20. **Steel pilot** (2026-09-07). The team owns Steel. Dedicated crawls and a controlled integration precede the general factory. Session access is potential and requires authorized reuse; customer content stays outside public corpora. Decision 0003 supersedes the earlier launch clock and continuation rules.

## Appendix F — Sources and grounding

- Prior research (six agents, with sources): `/home/agent/.claude/projects/-home-agent-fathom/06afeefa-da8a-4117-a029-0449ed54e22e/tool-results/bgtqvhn2t.txt`
- Design pass (seven aspect agents plus critic, 2026-09-05): workflow `wf_e98884f9-6b0`, run `wel3k8kp6`; digest at `/tmp/smelt-digest-wrapped.txt`
- mozilla/fathom checkout: `/home/agent/fathom` — `docs/rules.rst` (grammar), `fathom/` (runtime), `cli/fathom_web/` (trainer, vectorizer), `docs/development.rst` (profiling note)
- Karpathy autoresearch: verified write-ups, 2025
- Key external anchors: searchfox.org (vendored `fathom.mjs`); huggingface.co/Mozilla/tinybert-address-autofill; npm and PyPI registries (dates as in Appendix C); nlnet.nl/propose; openai.com legal terms; anthropic.com/legal/commercial-terms; ai.google.dev/gemini-api/docs/pricing; usenix.org (Bollinger et al., CookieBlock; Khandelwal et al., CookieEnforcer); arxiv.org/abs/2511.21398 (Prune4Web); arxiv.org/abs/2302.12173 (prompt injection); arxiv.org/abs/2606.14525 (bot detection, ARES 2026)
- Deep-research passes (five angles each, three-vote adversarial verification): first pass 2026-09-06, workflow `wf_09ce344a-d2f`, digest at `/tmp/smelt-research-wrapped.txt`; second pass 2026-09-06, workflow `wf_e3fa9d6f-330`, result at `/tmp/claude-1000/-home-agent-fathom/06afeefa-da8a-4117-a029-0449ed54e22e/tasks/w1brvpwr9.output` — 123 claims extracted, 25 verified, 22 confirmed, 3 refuted, plus same-day primary-source pinning of the GPT-5-nano price, the NLnet deadline, and both vendor terms pages. Remaining gaps: the GDPR candidate texts (Appendix D item 8) need one verification pass, and the market scan (CMP coverage numbers, consent-tool benchmarks, WebNN ship status beyond the Origin Trial, NGI Zero successors, namespace drift, local-library maintenance) still has no verified claims.

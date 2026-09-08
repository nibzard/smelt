# @smelt-oss/consent-banners

Consent-banner detection for the first Smelt task.

## Browser benchmark

Run the detector latency benchmark against frozen captures:

```sh
npm run bench --workspace @smelt-oss/consent-banners -- \
  --manifest path/to/bench.json \
  --set ci-50 \
  --out runs/bench.json
```

The command supports the named probe sets `ci-50`, `dev-1000`, and
`frozen-1000`. It opens each frozen DOM in Playwright Chromium, patches layout
from the feature file, and runs `detect(document)` in the page.

Replay rebuilds the top-frame document only, which matches v0.1 top-frame
detection. Elements from other frame documents stay in the snapshot file and
are counted in the report under `frames`. Frame records for documents the
capture could not reach are counted separately as `placeholderFrameRecords`.
Every replayed element carries its snapshot ID in a data attribute, so
alignment survives the HTML parser moving elements. The HTML parser can
insert elements the snapshot never held, such as a `tbody` around bare `tr`
rows; the report counts them as `phantomElements` instead of failing the
page. When an element holds both text and child elements, the replay inserts
one separator space, so word-boundary rules such as `\bcookies\b` score the
replay and the captured browser the same way. The benchmark context blocks
all network requests, so a replay fetches nothing.

Each page gets one first-call measurement, three warm-ups, and 30 measured
repeated calls. The JSON report includes initialization, first-call, p50, and
p95 latency.

Manifest format:

```json
{
  "schemaVersion": 1,
  "probeSets": {
    "ci-50": [
      {
        "id": "example",
        "group": "example.com",
        "snapshot": "captures/example.snapshot.json",
        "features": "captures/example.features.json"
      }
    ]
  }
}
```

## Watch mode (experimental, v0.2)

Re-run detection while a single-page application mutates itself (IDEA.md
3.4.6):

```js
import {watch} from '@smelt-oss/consent-banners/watch'

const handle = watch(document, (result, {cause, revision}) => {
  // cause is 'initial', 'mutation', or 'navigate'.
}, {debounceMs: 200})

handle.cancel()   // Stop watching and drop pending runs.
handle.flush()    // Run a pending re-detection now (useful in tests).
```

The first detection runs immediately. After that, childList and subtree
mutations schedule one debounced re-detection. The default debounce is
200 ms, inside the specified 150 to 300 ms band. When the platform has
`requestIdleCallback`, the run waits for idle time with a 500 ms timeout.
Navigations through the Navigation API re-trigger detection when the
platform has it.

Every run carries a revision token. Changes that land while a run is
pending or in flight bump the token. A run that is no longer current is
dropped, so the callback always sees the newest page. When no
MutationObserver exists, the handle reports `reactive: false`. The
initial run still fires, and Navigation API navigations still re-trigger
detection when the platform has them.

The subpath is experimental for v0.2 and stays outside the v0.1 dist.
The npm export path above is unchanged. Exceptions from the callback
propagate.

## Steel workflow hook

Use `runControlledSteelWorkflow()` to run detection inside an existing Steel
browser page before the caller asks its agent model to interpret the page:

```js
import {runControlledSteelWorkflow} from '@smelt-oss/consent-banners/steel-workflow'

const record = await runControlledSteelWorkflow({
  page,
  caseId: 'checkout-cookie-wall',
  fixedAgent: {
    model: 'agent-model-id',
    promptHash: 'sha256-prompt',
    actionPolicyHash: 'sha256-policy'
  },
  workflow: async ({page, detection, fixedAgent}) => runExistingAgent({
    page,
    detection,
    fixedAgent
  })
})
```

The helper does not click controls or change the caller's prompts or action
policy. It returns the selected element reference and records task completion,
model calls, total workflow cost, cost per completed task, and added detection
latency for the Steel pilot.

## Teacher labeling

Label frozen captures with a paid-tier teacher and verify the answer against
the capture before it enters the corpus (IDEA.md 3.3.4 and 3.3.5):

```js
import {anthropicTeacher, geminiTeacher, runTeacher} from '@smelt-oss/consent-banners/teacher'

const teacher = anthropicTeacher()          // reads ANTHROPIC_API_KEY
const google = geminiTeacher()              // reads GEMINI_API_KEY, paid tier only
const record = await runTeacher(teacher, {snapshot, features})
// record.verification.status: 'pass', 'flag', or 'reject'
```

The serialization strips non-rendering subtrees, head noise, hidden frames,
and attribute values, and caps free text, so structure carries the label
signal. Every record carries the vendor, model ID, terms version, written
no-competition rationale, prompt version, prompt hash, token usage, and
measured cost. Reject or flag records in `verification.issues` for human
review; answers built from a truncated serialization are always flagged.

### Batch labeling over the review queue

`teacher-labels` runs one teacher over every queued capture and appends one
provenance record per page to a JSONL file. Run it from the repository
root:

```sh
node packages/consent-banners/teacher-labels-cli.mjs \
  --captures corpus/captures \
  --queue tasks/consent-banners/review-queue.json \
  --manifest corpus/manifests/splits.json \
  --teacher anthropic \
  --out runs/teacher-labels/anthropic.jsonl
```

The output holds proposals for the human reviewer, never labels. Nothing
writes proposals into the split labels files; the reviewed record is the
only label that counts (IDEA.md 3.3.1). Use one output file per teacher so
the two-vendor ensemble stays separable.

Pass `--manifest` so the frozen test captures are excluded: the pilot test
pages stay teacher-free and 100 percent human-verified (IDEA.md 3.3.6).
The manifest lists capture ids and paths, not labels, so the exclusion
never opens the test labels file. A run without `--manifest` refuses to
start, and so does a file without a `splits.test` array — a wrong or
stale manifest path must stop the batch, not silently teach the test
pages. Only `--dry-run` runs without a manifest.

The batch is resumable. A capture with a full record in the output file is
skipped, so an interrupted run continues where it stopped. A torn final
line from a crash is dropped, its capture is labeled again, and the
consumer takes the last record per capture id. Spending stops at the cost
cap (`--max-cost`, default 40 USD; the call that crosses the cap still
completes, so spending can overshoot by one call). The cap counts the
spend already recorded in the output file, so a resumed batch cannot
double-spend past the same cap. The batch stops after five consecutive
failures and labels at most `--limit` pages. Every call waits
`--delay-ms`, 500 by default, and failed calls wait too.

`--dry-run` needs no API key and no teacher. It serializes every capture
and prints the byte totals, the caps in force, the count of pages that
truncate, and a cost estimate for both default teachers:

```sh
node packages/consent-banners/teacher-labels-cli.mjs \
  --captures corpus/captures \
  --queue tasks/consent-banners/review-queue.json \
  --manifest corpus/manifests/splits.json --dry-run
```

A page that hits a serialization cap (`--max-chars`, 120000 by default;
`--max-elements`, 2500 by default) is serialized truncated, and its answer
is always flagged for human review. A dry run at a larger cap shows the
trade: over the pilot queue, 150 non-test pages cost about 2.93 USD on
Claude Haiku 4.5 at the defaults with 59 truncated pages, and 4.21 USD at
400000 characters with one truncated page.

## Rules agent loop

Run the bounded keep-or-discard loop that edits only `rules.mjs`:

```sh
npm run loop --workspace @smelt-oss/consent-banners -- \
  path/to/manifest.json runs/loop.json \
  --command 'node packages/consent-banners/scripts/offline-agent.mjs'
```

The command receives `{digest, rulesSource, program}` on stdin and prints JSON
with at least `{source}`. The manifest needs only the `development` split. The
loop gates every candidate (safety, size, latency, dev F1), ratchets with an
epsilon of 0.005, stops at 40 consecutive discards or `$40` of reported cost,
and writes an experiment log with the diff, gate results, usage, and verdict
for every iteration. Nothing touches `rules.mjs` automatically; use
`--rules-out` to export a winning source for human review.

The frozen test set stays physically absent from loop and trainer inputs
(IDEA.md 3.2.4). Both entry points pin their manifest roles to the declared
split name, so a manifest that names the test labels file fails before any
run. The trainer also refuses a page id or a template group that appears in
both the train and the development role, because the corpus keeps every
group inside exactly one split.

## npm export path

Build the dist that ships to npm:

```sh
npm run export --workspace @smelt-oss/consent-banners
```

The dist contains four files:

- `detect.mjs` — the one-call wrapper, regenerated from `index.mjs` with the
  model artifact inlined as base64. It exports `detect`, `verifyIntegrity`,
  and the recorded hashes.
- `rules.js` — the unminified, human-auditable rules copy.
- `model.smelt.json` — the canonical JSON artifact, kept for audit.
- `integrity.json` — sha256 values for the rules, the model, and the wrapper;
  the corpus id and revision; and the eager gzip size against the budget.

The export refuses to finish when the artifact does not parse, when its
`rulesHash` does not match `rules.mjs`, when the smoke detection fails, or
when the eager bundle exceeds the package budget. The output directory must
stay inside the workspace so the smoke test resolves `@smelt-oss/runtime`.
`MODEL.md` is not part of the export; it ships with the release corpus.

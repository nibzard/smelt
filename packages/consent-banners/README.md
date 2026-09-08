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
page. The benchmark context blocks all network requests, so a replay
fetches nothing.

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

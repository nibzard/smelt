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

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

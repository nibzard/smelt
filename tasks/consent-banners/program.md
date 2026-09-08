# Consent-banner pilot

## Task

Find the primary visible consent notice and return its root element. Detection
does not select consent preferences or click controls. This is the provisional
first task; confirm its value using Steel workflow failures before expanding.

Decision 0004 confirms this as the first Steel pilot detector task. The
confirmation uses permitted planning metadata only because no authorized Steel
session export is in the repository. Continue to measure real workflow failure
slices during the pilot.

## Positive examples

- A visible dialog that requests a choice about cookies or tracking.
- A bottom bar with consent text and preference controls.
- A custom consent notice outside a known consent-platform template.

## Negative examples

- A newsletter subscription dialog.
- An age gate or sign-in dialog.
- A footer link to a cookie policy with no active notice.
- A hidden or dismissed consent dialog.

## Edge-case policy

Annotate one primary notice per capture. Its root must contain the notice and
its controls without unrelated page sections. Record each acceptable ancestor
explicitly. Do not accept `body` merely because it contains the notice.

Record frame boundaries and inaccessible content during capture. Do not label
an inaccessible banner as absent. Keep unresolvable captures in a review queue
and report their count. Capture delayed banners at declared observation times.
Keep related domains, templates, and captures from one session in one split.
Collect positive and negative pages from both European and US locations.

## Threshold policy

Compare hand-written rules, linear and tree models, and agent-improved rules
using the same development data. Select thresholds on development data only.
Require an acceptable root for a true positive. A wrong root on a positive page
counts as both a false positive and a false negative.

## Baseline training

Use the fixed consent trainer to compare the simpler baselines before running
the agent loop:

```sh
npm run train --workspace @smelt-oss/consent-banners -- path/to/manifest.json runs/baselines.json
```

The manifest uses `schemaVersion: 1` and has `train` and `development` splits.
Each split names one compact evaluator label file and matching frozen captures:

```json
{
  "schemaVersion": 1,
  "train": {
    "labels": "train.labels.json",
    "captures": [
      {"id": "example", "snapshot": "example.snapshot.json", "features": "example.features.json"}
    ]
  },
  "development": {
    "labels": "development.labels.json",
    "captures": [
      {"id": "example-dev", "snapshot": "example-dev.snapshot.json", "features": "example-dev.features.json"}
    ]
  }
}
```

The output compares `rules`, `linear`, and `lightgbm` on the development split.
Each baseline reports accuracy, human effort, cost, and latency fields. Do not
publish the report as release evidence until the grouped corpus and human labels
exist.

## The rules agent loop

Run the bounded loop after the baselines (IDEA.md 3.2.1 through 3.2.7):

```sh
npm run loop --workspace @smelt-oss/consent-banners -- \
  path/to/manifest.json runs/loop.json \
  --command 'claude -p --output-format json'
```

The manifest carries only the `development` split, because scoring during the
loop uses dev data only and the frozen test set stays physically absent. The
`--command` agent receives `{digest, rulesSource, program}` on stdin and prints
JSON with at least `{source}`; pass `--program` to include the task program.
The offline agent `packages/consent-banners/scripts/offline-agent.mjs` runs the
same contract without an API key.

Each iteration gates the candidate in fixed order before the ratchet:

1. Safety: no imports (the runner prepends the runtime itself), no network,
   filesystem, `eval`, `Function`, `constructor`, or prototype access; at most
   200 rules and 1,000 lines.
2. Size: under 15,360 bytes gzipped.
3. Latency: under 200 ms per page on the frozen-snapshot replay.
4. Dev F1: at least `epsilon` (0.005) above the incumbent. A wrong root counts
   as both a false positive and a false negative, and thresholds are selected
   on development data only.

The ratchet keeps nothing until the browser-versus-Node parity fixture holds
(`--no-parity` records a failing parity gate). The loop stops after 40
consecutive discards, `$40` of reported agent cost, the wall clock cap, or 600
iterations. The experiment log records every iteration with the diff, the gate
results, the usage, the cost, and the verdict, plus the winning rules hash and
source when an iteration was kept. `--rules-out` writes the winning source for
human review; nothing is applied to `rules.mjs` automatically.

An offline demonstration over the bundled fixture captures (real Chromium
captures, three pages) runs the loop end to end: the shipped rules already
reach dev F1 1.0 there, so honest iterations that do not beat the incumbent are
discarded by the ratchet, and an unsafe edit is rejected by the safety gate. A
real agent-driven run over the labeled corpus still waits on the T010 captures.

The textual safety gate is a tripwire, not a sandbox. It reads the candidate
source before anything imports it, but a determined module can disguise a
forbidden reference. The runner does not add network or filesystem isolation
of its own; run real agent sessions inside a sandbox that blocks egress.
Paths in the CLI are relative as follows: `--program` resolves against the
manifest directory, and the log, `--rules-out`, and `--command` paths resolve
against the working directory.

## Steel workflow metrics

Measure the current workflow baseline on the matched pilot case set before any
Smelt-assisted run. Use isolated browser state for each case. Keep the agent
model, prompts, and action policy fixed.

Primary metric: cost per completed task. Compute it as total workflow cost,
including failed runs, divided by successful completions. Count model calls,
Steel browser time, and any directly billed workflow step. Report browser
runtime and infrastructure cost separately.

Minimum useful improvement: the Smelt-assisted workflow must reduce cost per
completed task by at least 10 percent against the baseline. The paired
bootstrap 90 percent confidence interval must not include a cost increase.

Task-completion regression limit: completion rate must not fall by more than
two percentage points. If the baseline completes fewer than 50 percent of cases,
Smelt must instead improve completion by at least five percentage points.

Latency regression limit: added browser latency from detection and element
handoff must stay under 250 ms at p95, and under 5 percent of baseline workflow
wall time at p95. Report first-call, repeated-call, and end-to-end workflow
latency separately.

Secondary metrics: task completion, model calls per completed task, root
acceptability, extra roots, failure slices, and human review effort. Publish
sample counts and uncertainty for each metric.

Release targets remain detection F1 of at least 0.90, under 50 KB gzipped, and
under 5 ms at the 95th percentile on the reference machine.

Use dedicated public Steel crawls first. Authorized session samples remain
private evaluation inputs. Record browser, teacher, and human review costs.

## Teacher labeling

Two teachers from different vendors label every capture: Anthropic Claude
Haiku 4.5 and Google Gemini 2.5 Flash-Lite, both paid tier. Free tiers are
banned for labeling (IDEA.md 3.3.5). Each adapter ships with vendor
metadata, a terms version, checked prices, and a written no-competition
rationale in `packages/consent-banners/teacher.mjs`. A terms change turns
relabeling into a scripted job: records carry the vendor, model ID, prompt
version, prompt hash, terms version, usage, and cost.

Teacher input is the sanitized serialization from `serializeForTeacher`:
non-rendering subtrees, head noise, drawing elements, and frames with a
hidden host chain are stripped. A visibility-hidden wrapper keeps its
visible descendants, because CSS renders them. Attribute values are dropped
except class tokens and role, and every page-controlled string is clamped
and stripped of field delimiters, so page text cannot forge the structured
parts of a line. Free text is capped at 120 characters per element and
120,000 characters per page. Structure carries the label signal, which is
also the prompt-injection defense.

`verifyTeacherLabels` checks each answer against the frozen features before
it enters the corpus. Reject: unknown root, html or body root, hidden or
transparent root, empty geometry, root entirely off the viewport to the top
or a side, negative label with a root, a kind, or evidence. Flag for human
review: viewport-covering root, root entirely below the fold, text-free
root, low opacity, unknown evidence element, and any answer built from a
truncated serialization. Rejected and flagged records never reach the
training labels without human review.

# Pilot evaluator

Offline scoring for the Steel pilot. This package has no runtime dependencies
and makes no network requests. It evaluates supplied predictions; it does not
detect banners or train a model.

Run from the repository root:

```sh
npm run pilot:demo
node packages/pilot/cli.mjs path/to/labels.json path/to/predictions.json
node packages/pilot/cli.mjs --workflows path/to/baseline.json path/to/smelt.json
```

The demo uses synthetic labels and predictions, with deliberate errors. It
should report detection F1 of one third and page-presence F1 of two thirds.
These numbers demonstrate scoring behavior. They are not model quality evidence.

## Corpus preparation

`prepare:corpus` turns crawled captures into split manifests, provisional
labels, review-queue entries, and summary statistics. Run it from the
repository root, because relative paths resolve against the working
directory:

```sh
node packages/pilot/prepare-corpus-cli.mjs \
  --captures corpus/captures \
  --sessions corpus/sessions \
  --queue tasks/consent-banners/review-queue.json
```

It writes `corpus/manifests/splits.json`, one unresolved label file per
split under `corpus/manifests/labels/`, and
`corpus/stats/pilot-corpus-stats.json`. One group of related domains,
templates, or paired locations always lands in exactly one split, by a
deterministic group-hash order. Every label stays `unresolved` until human
review records acceptable roots, and every capture enters the review queue.
Expected classes in the manifests are recipe hints for balance reporting
only. The test split must stay out of agent-loop inputs.

A re-run keeps pasted human labels. A page record with
`label_status: "reviewed"` survives verbatim. An `unresolved` record
survives when its `review_notes` no longer start with
`awaiting initial human label`, which means a person wrote something. The
command reports how many records it preserved, moved between splits, and
dropped because their capture disappeared. Review-queue entries are
derived from capture metadata, so a re-run refreshes them.

## Labels doctor

`labels:doctor` checks the label files against the manifest, the queue, and
the capture files. Run it after every pasting session:

```sh
node packages/pilot/labels-doctor.mjs \
  --labels corpus/manifests/labels \
  --manifest corpus/manifests/splits.json \
  --queue tasks/consent-banners/review-queue.json \
  --captures corpus/captures
```

It exits nonzero when any check fails. It catches the paste accidents a
schema check alone misses: a record pasted into the wrong split file, a
paste below the stub instead of over it, a record for a capture that does
not exist, a group that disagrees with the manifest or queue, a missing
capture file, and captures on disk that no manifest knows about.

## Apply reviewed labels

`labels:apply` writes the copied records into the split label files, so the
reviewer never pastes over a stub by hand. Collect the copied records into
one file per reviewing session, then run it from the repository root:

```sh
node packages/pilot/labels-apply.mjs \
  --records path/to/collected.json \
  --labels corpus/manifests/labels
```

The records file holds a JSON array of records, or an object with a `pages`
array. Each record replaces the page stub with the same `id`. A record is
rejected when no split file holds that id, when its `group` disagrees with
the labels file, or when the replacement would fail the schema or semantic
checks. A rejected record leaves its file untouched, and the command exits
nonzero. Applying over an earlier reviewed record replaces it, which lets a
reviewer correct their own label. Run `labels:doctor` after every apply.

## Review viewer

`review:viewer` renders every queued capture as a standalone HTML page for
the human reviewer. Run it from the repository root, because relative
paths resolve against the working directory:

```sh
node packages/pilot/review-viewer-cli.mjs \
  --queue tasks/consent-banners/review-queue.json \
  --captures corpus/captures \
  --labels corpus/manifests/labels \
  --out runs/review-viewer
```

Each page rebuilds the top-frame DOM of the capture and positions every
element at its captured rectangle, composed through nested ancestors. Hover
an element to see its snapshot ID. Click the banner root first, then any
extra acceptable roots; click a selected element again to remove it. Pick
the banner kind and confidence, adjust the jurisdiction prefill (taken from
the crawl recipe or the capture egress location), and edit the review notes
(prefilled from the page's stub). The **Copy label JSON** button produces a
complete reviewed record — `id`, `group`, `label_status`, `has_banner`,
`acceptable_roots`, `banner_root`, `banner_kind`, `jurisdiction`, `frame`,
`evidence`, `confidence`, and `review_notes` — ready for `labels:apply`, or
for a manual paste over the page's stub in the split label file. The record passes
`validateConsentLabels` as-is; a browser test in
`test/review-viewer.browser.test.mjs` keeps that contract. The group comes
from the labels file, so the record cannot rewrite the group that split the
corpus even when the queue disagrees. Clicks on the control bar, the JSON
box, and blank page areas never change the selection.

Wrapped inline elements have one known limit. Each element is placed at its
bounding box. A wrapped inline element, such as a link or span that spans
several lines, has a box that also covers its neighbors. The topmost box
takes the click. When a click selects the wrong inline element, select the
block container around it instead.

Generated pages load nothing remote. The viewer strips every
loading attribute — iframe and image sources, `srcset`, `poster`, preload
and stylesheet `link` targets, meta refresh — before serialization, and
blanks each frame host to `about:blank` with `sandbox` at runtime. If the
banner sits inside an iframe, a dashed blue overlay covers each frame host;
click it to select the frame element, and the label records it under
`frame.element_id`. The overlay exists because a click inside a frame box
otherwise lands in the child document. Pages link from `index.html`; open
them directly from the output directory.

## Steel workflow metric contract

The pilot compares matched Steel task cases with and without Smelt. Measure the
baseline first, then run the Smelt-assisted workflow with the same agent model,
prompts, action policy, case order, and isolated browser state.

The primary workflow metric is cost per completed task:

```text
cost_per_completed_task = total_workflow_cost / successful_completions
```

Include failed runs in `total_workflow_cost`. Count model calls, Steel browser
time, and any directly billed workflow step. Report browser runtime and
infrastructure cost separately.

The minimum useful improvement is a 10 percent lower cost per completed task.
The paired bootstrap 90 percent confidence interval must not include a cost
increase. Completion rate must not fall by more than two percentage points. If
the baseline completes fewer than 50 percent of cases, the Smelt-assisted
workflow must instead improve completion by at least five percentage points.

Added browser latency from detection and element handoff must stay under 250 ms
at p95, and under 5 percent of baseline workflow wall time at p95. Report
first-call, repeated-call, and end-to-end workflow latency separately.

Secondary workflow metrics are task completion, model calls per completed task,
root acceptability, extra roots, failure slices, and human review effort. Report
sample counts and uncertainty for every metric.

## Input contract

Labels can use the compact evaluator shape with `schemaVersion: 1`, a `split`
(`train`, `development`, or `test`), and a nonempty `pages` array. Each page
contains:

- `id`: a unique capture identifier.
- `group`: the domain/template group used when creating independent splits.
- `hasBanner`: a Boolean label.
- `acceptableRoots`: captured element IDs accepted by human review. Positive
  pages require at least one root. Negative pages require an empty array.
- `exactRoot`: the canonical human root. This field is optional for compact
  labels. If omitted, the evaluator uses the first acceptable root.

Grouped evaluation accepts either an array of split datasets, a
`{schemaVersion: 1, splits: [...]}` object, or a `{splits: {train, development,
test}}` object. Each group can occur many times inside one split, but it must
not occur in more than one split. This validates the domain/template separation
used by the corpus split.

Predictions are an array of `{id, roots}` records. Every labeled page needs one
record. An empty `roots` array means no detection. Roots are ordered from highest
to lowest rank. IDs refer to elements in that capture, not live page selectors.
For grouped evaluation, predictions can be keyed by split:

```json
{
  "train": [{"id": "capture-a", "roots": ["e1"]}],
  "development": [{"id": "capture-b", "roots": []}]
}
```

A flat prediction array can also include `split` on each prediction record.

Only the first root contributes to detection scoring. A wrong root on a positive
page counts as both a false positive and a false negative. Extra returned roots
are counted separately. F1 is the harmonic mean of precision and recall.
Undefined metrics return `null`, including F1 for an all-negative set with no
detections. Malformed or incomplete input fails instead of silently reducing
the evaluation denominator.

This evaluator checks one split with `evaluate()` and grouped split independence
with `evaluateGroupedSplits()`. It does not verify human labels, element
existence, browser latency, or workflow costs. Capture validation must precede
release evaluation. Keep unseen test labels outside agent-loop inputs. CI uses
synthetic examples only.

## Workflow comparison input

Use `compareWorkflows()` or `--workflows` to compare matched Steel run records.
Both files are arrays of `schemaVersion: 1` records. Baseline records use
`variant: "baseline"`. Smelt records use `variant: "smelt-assisted"`.
Each `caseId` must appear once in each file. The fixed agent model, prompt hash,
and action-policy hash must match for the same case.

Each record contains workflow metrics:

- `taskCompleted`: whether the workflow completed.
- `modelCalls`: model calls used by the workflow.
- `totalWorkflowCostUsd`: full run cost, including failed runs.
- `browserMs`: browser runtime, optional.
- `workflowMs`: end-to-end workflow time, optional.
- `addedLatencyMs`: Smelt detection and handoff latency, required for the
  latency gate.
- `detectionMs`: detector runtime, optional.

The report publishes matched case count, sample counts, completion rate, total
cost, cost per completed task, model calls, p95 latency, 90 percent paired
bootstrap intervals, gate results, and failure slices.

The canonical consent-label schema lives in
`tasks/consent-banners/labels.schema.json`. It records `has_banner`,
`acceptable_roots`, `banner_root`, `banner_kind`, `jurisdiction`, `frame`,
`evidence`, `confidence`, and `label_status`. Reviewed labels convert to the
compact evaluator shape. `unresolved` labels stay out of scoring and must carry
`review_notes` so they can enter the human review queue.

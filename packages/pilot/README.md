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

Writes are atomic. The split label files and the split manifest are staged
through a temp file and swapped in by rename, and each keeps a `.bak` copy
of its previous content, because `corpus/` is outside version control.

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
capture file, and captures on disk that no manifest knows about. A page or
queue entry that is not an object is reported as a problem instead of
stopping the run, so one hand-edit mistake cannot hide the rest.

## Apply reviewed labels

`labels:apply` writes the copied records into the split label files, so the
reviewer never pastes over a stub by hand. Collect the copied records into
one file per reviewing session, then run it from the repository root:

```sh
node packages/pilot/labels-apply.mjs \
  --records path/to/collected.json \
  --labels corpus/manifests/labels
```

The records file holds the copied records pasted one after another —
commas and a wrapping array are optional, because each copied record is
pretty-printed and hand-assembly is where paste accidents live. A JSON
array of records and an object with a `pages` array work too. A torn
paste or stray text fails with the byte offset instead of skipping
content.
Each record replaces the page stub with the same `id`. A record is
rejected when no split file holds that id, when its `group` disagrees with
the labels file, or when the replacement would fail the schema or semantic
checks. A rejected record leaves its file untouched, and the command exits
nonzero.

A record that would change an already reviewed page is also rejected,
unless it is identical to the stored record. Pass `--replace` to correct
your own earlier label. A reviewed page is never demoted back to
`unresolved`, even with `--replace`; re-open a page by editing the labels
file by hand. These guards stop a stale records file from an earlier
session from silently reverting a correction. An `unresolved` record with
hand-written `review_notes` may still be applied over a stub, which is how
you save review progress on a page that needs a second look.

Writes are atomic. Each updated file is written to a sibling temp file
and renamed into place, and a `.bak` copy of the previous content stays
next to it. A crash or a full disk never truncates a labels file. When a
batch spans several splits, every file is staged before any file is
swapped, and a mid-batch failure reports which files were already
updated. Re-run the same records file to finish the batch: an identical
re-apply is allowed. Run `labels:doctor` after every apply.

## Training manifest

`training:manifest` builds the manifest the trainer and the rules loop
consume, from the corpus artifacts. Run it after a review session:

```sh
node packages/pilot/training-manifest.mjs \
  --manifest corpus/manifests/splits.json \
  --labels corpus/manifests/labels \
  --out runs/training/manifest.json
```

The frozen test set is excluded structurally: the command reads the train
and development splits only and never opens the test labels file
(IDEA.md 3.2.4). The build is all-or-nothing. One unresolved page in
either split refuses the whole run and names the pages, because the
compact conversion drops unresolved pages and a quiet subset would
under-train. Labels and manifest captures must agree exactly, and a group
may not span two splits.

The output path is guarded by real path, not spelling. The command
refuses an output directory that is the labels directory under any
spelling — a symlink or a `..` segment included — and refuses an output
path that is the input split manifest or that shares a basename with a
compact labels file. Outputs are written through temp files and atomic
renames, so an interrupted build never leaves fresh compact labels beside
a stale manifest. The written manifest also drives the rules loop, which
needs only the development role.

## Review session runbook

One pass over the queue, from a clean workspace to a training-ready
manifest. Each command runs from the repository root.

1. Regenerate the pages: `node packages/pilot/review-viewer-cli.mjs`
   (add `--proposals` when a teacher proposals file exists).
2. Open `runs/review-viewer/index.html`, then walk the queue with the
   prev and next links. Click roots on each page and copy each record
   into one session file, pasting the records one after another.
3. Apply the session file: `node packages/pilot/labels-apply.mjs
   --records path/to/session.json --labels corpus/manifests/labels`.
4. Check the result: `node packages/pilot/labels-doctor.mjs`. Fix what
   it reports before continuing.
5. Regenerate the viewer so the index counts the new progress, then
   repeat from step 2 until the index shows zero remaining.
6. Build the training manifest: `node packages/pilot/training-manifest.mjs
   --out runs/training/manifest.json`. It refuses while any page is
   unresolved, which is the intended stop.

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

Every page links to its neighbors and to the index, so a review session
walks the queue without returning to the index after each capture.

Pass `--proposals path/to/proposals.jsonl` to show teacher proposals
alongside the pages (the file `teacher-labels` writes). A page with a
proposal gains a collapsed advisory panel in the control bar. Open it
only if you want the teacher's answer: it shows the proposed banner
root, kind, jurisdiction, confidence, and the verification verdict, and
it can outline the proposed root on the page. A proposal never selects
anything and never enters the copied record — your clicks alone build
the label. Review the page first and open the panel when unsure. A torn
or corrupt line in the proposals file is skipped: the file a crashed and
resumed batch leaves behind still renders, and the last valid record per
capture wins. A file that yields no panels produces a warning that names
the cause — junk lines for a wrong file format, objects that are not
proposal records (the error records a failed batch writes), an empty
file, or records that match no capture in this queue — so a wrong file
cannot pass for a normal no-proposal build.

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
`test/review-viewer.browser.test.mjs` keeps that contract. Install
Chromium locally (`npx playwright install chromium`) and run that suite
before a review session: CI has no browser, so those tests skip there
and only the local run checks the click behavior. The group comes
from the labels file, so the record cannot rewrite the group that split the
corpus even when the queue disagrees. Clicks on the control bar, the JSON
box, and blank page areas never change the selection. The JSON box hides
again with its **Close** button or the **Esc** key, which frees the
content it covered for clicking.

Wrapped inline elements need care. Each element is placed at its bounding
box. A wrapped inline element, such as a link or span that spans several
lines, has a box that also covers its neighbors, and the topmost box takes
a plain click. When the hover tip ends with `+N below (alt+click)`, hold
**Alt** and click to step through the covered elements, one per click; the
walk replaces the previous step's pick, so the selection holds one element
at a time. Release Alt and click again to start over.

Generated pages load nothing remote. The viewer strips every
loading attribute — iframe and image sources, `srcset`, `poster`, preload
and stylesheet `link` targets, meta refresh — before serialization, and
blanks each frame host to `about:blank` with `sandbox` at runtime. If the
banner sits inside an iframe, a dashed blue overlay covers each frame host;
click it to select the frame element, and the label records it under
`frame.element_id`. The overlay exists because a click inside a frame box
otherwise lands in the child document. Pages link from `index.html`; open
them directly from the output directory. The index counts reviewed and
remaining captures and lists pending captures first, so regenerate it after
every apply session. When a split labels file is unreadable, or one page
id appears in more than one split file, the index prints a warning above
the counts: run `labels:doctor` before trusting the numbers.

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

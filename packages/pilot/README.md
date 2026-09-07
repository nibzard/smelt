# Pilot evaluator

Offline scoring for the Steel pilot. This package has no runtime dependencies
and makes no network requests. It evaluates supplied predictions; it does not
detect banners or train a model.

Run from the repository root:

```sh
npm run pilot:demo
node packages/pilot/cli.mjs path/to/labels.json path/to/predictions.json
```

The demo uses synthetic labels and predictions, with deliberate errors. It
should report detection F1 of one third and page-presence F1 of two thirds.
These numbers demonstrate scoring behavior. They are not model quality evidence.

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

Labels contain `schemaVersion: 1`, a `split` (`train`, `development`, or `test`),
and a nonempty `pages` array. Each page contains:

- `id`: a unique capture identifier.
- `group`: the domain/template group used when creating independent splits.
- `hasBanner`: a Boolean label.
- `acceptableRoots`: captured element IDs accepted by human review. Positive
  pages require at least one root. Negative pages require an empty array.

Predictions are an array of `{id, roots}` records. Every labeled page needs one
record. An empty `roots` array means no detection. Roots are ordered from highest
to lowest rank. IDs refer to elements in that capture, not live page selectors.

Only the first root contributes to detection scoring. A wrong root on a positive
page counts as both a false positive and a false negative. Extra returned roots
are counted separately. F1 is the harmonic mean of precision and recall.
Undefined metrics return `null`, including F1 for an all-negative set with no
detections. Malformed or incomplete input fails instead of silently reducing
the evaluation denominator.

This evaluator checks one split. It does not verify human labels, element
existence, cross-split group separation, browser latency, or workflow costs.
Capture validation and independent split checks must precede release evaluation.
Keep unseen test labels outside agent-loop inputs. CI uses synthetic examples only.

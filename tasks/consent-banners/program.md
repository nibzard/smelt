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

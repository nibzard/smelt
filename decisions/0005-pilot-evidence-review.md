# 0005 - Pilot evidence review

- **Status:** proposed
- **Date:** 2026-10-16
- **Prepared:** 2026-09-07
- **Depends on:** 0003, 0004

## Context

Decision 0003 schedules a Steel pilot evidence review for 2026-10-16. The
review decides whether to continue the consent-banner integration, change the
task, or stop the integration.

The first detector task is consent-banner root detection, as confirmed by
decision 0004. The detector returns the primary visible consent notice root. It
does not click controls or choose consent preferences.

This record prepares the review packet before the six-week pilot completes. It
therefore separates available repository evidence from evidence that must still
come from the pilot.

## Evidence to collect

The review must include these inputs:

| Evidence area | Required evidence | Current repository status |
|---|---|---|
| Task selection | Ranked Steel workflow failures by frequency, cost, and small-detector fit | Planning rank exists in decision 0004; no authorized Steel session export is present |
| Corpus | Dedicated Steel captures, a few hundred human-reviewed labels, grouped splits | Label schema and capture contract exist; updated 2026-09-08: 191 dedicated captures exist under `corpus/` (EU residential DE egress and US `iad` datacenter egress), grouped splits 114/36/41 over 165 groups, review queue populated; every label is still unresolved, so no labeled split exists yet |
| Detection scoring | Acceptable-root detection precision, recall, F1, page-presence F1, exact-root accuracy, extra roots | Evaluator exists; demo data reports detection F1 0.333333 and page-presence F1 0.666667 |
| Baselines | Hand-written rules, linear model, and tree model on the same development split | Baseline trainer exists and is covered by synthetic tests |
| Agent loop | Bounded keep-or-discard loop compared with the best simpler baseline | Not yet present over the pilot corpus; updated 2026-09-08: T020 is closed with the loop implemented and covered by synthetic runs; a real-corpus loop still needs labels |
| Browser latency | First-call, repeated-call, and p95 detector latency in Playwright | Updated 2026-09-08: real reports exist for `ci-50` (50 train captures) and for the current dev and frozen splits (36 and 41 captures; see "Evidence updates" below); the full 1,000-page probe sets await the release corpus |
| Workflow comparison | Matched Steel cases with and without Smelt, fixed agent model, prompts, and action policy | Workflow comparison evaluator exists; no real matched pilot run report is present |
| Cost | Model calls, Steel browser time, workflow cost, capture cost, teacher cost, and review cost | Cost fields exist in the contracts; real pilot values are not present |
| Failure slices | Failures by domain/template, consent-platform family, capture condition, and workflow failure reason | Slice fields exist; real pilot slices are not present |

## Evidence updates

Updates after preparation, so the packet stays truthful. The decision rules
above do not change.

2026-09-08 — corpus and latency:

- Dedicated Steel captures now exist: 191 pages, 165 groups, split 114/36/41,
  from EU residential (Germany) and US `iad` datacenter egress. Captures,
  session reports, and derived manifests stay under gitignored `corpus/`;
  the crawl recipes in `tasks/consent-banners/crawls/` document the set.
  Robots-disallowed pages were skipped and recorded. Every label remains
  `unresolved`, so corpus rows that need labels stay unavailable.
- The first real `ci-50` browser-latency report exists
  (`runs/bench-ci-50.json`, local only): 50 train-split captures, Chromium
  151 headless, 4x CPU throttle, three warm-ups and 30 measured calls per
  page. Initialization p50 71.2 ms, p95 133.1 ms; first call p50 22.3 ms,
  p95 70.6 ms; repeated call p50 11.2 ms, p95 44.0 ms. No truncated or
  degraded pages. This is detector-only latency, not the workflow
  added-latency gate.
- Producing that report required replay fixes, committed with the evidence:
  replay rebuilds the top-frame document only (matching v0.1 top-frame
  detection), aligns replayed elements by stamped ID because the HTML
  parser relocates script-moved elements, serializes void elements without
  closing tags, and blocks all network requests during benchmark replay.
  34 of the 50 pages carry more than one accessible frame document; 102
  further frame records are placeholders for documents the capture could
  not reach. 127,863 of 129,130 snapshot elements replay in the top frame.
  The parser inserted seven elements with no snapshot counterpart on six
  pages; the report counts them instead of failing those pages.
- The development and frozen splits also have latency reports
  (`runs/bench-dev-36.json` and `runs/bench-frozen-41.json`, local only),
  measured the same way over the 36 development and 41 frozen pilot
  captures. Development: initialization p50 63.6 ms, p95 176.1 ms; first
  call p50 19.4 ms, p95 68.4 ms; repeated call p50 8.7 ms, p95 45.5 ms.
  Frozen: initialization p50 67.7 ms, p95 137.9 ms; first call p50
  22.5 ms, p95 73.7 ms; repeated call p50 9.9 ms, p95 52.3 ms. No page
  truncated or degraded in either run. Both are partial probe sets; the
  full 1,000-page sets await the release corpus. The frozen run measures
  latency only. It feeds no failure digest and no loop input (IDEA.md
  3.2.4).

## Predeclared limits

Use the limits in `packages/pilot/README.md` and
`tasks/consent-banners/program.md`:

- Primary workflow metric: cost per completed task.
- Minimum useful cost improvement: at least 10 percent lower than baseline.
- Cost uncertainty: the paired bootstrap 90 percent confidence interval must
  not include a cost increase.
- Completion regression limit: completion rate must not fall by more than two
  percentage points.
- Low-baseline fallback: if the baseline completes fewer than 50 percent of
  cases, Smelt must improve completion by at least five percentage points.
- Latency regression limit: added browser latency from detection and element
  handoff must stay under 250 ms at p95 and under 5 percent of baseline
  workflow wall time at p95.
- Release detector gate: acceptable-root detection F1 at least 0.90 on 1,000
  human-verified unseen pages.
- Release package gate: under 50 KB gzipped for engine, rules, and model.
- Release portable latency gate: under 5 ms at p95 on the declared reference
  machine.

## Decision rule

Continue the consent-banner integration when the matched workflow comparison
passes the primary workflow limit and the regression limits.

Keep the simpler trainer when rules, linear, or tree baselines match the
agent-loop result within the predeclared margin.

Change the task when consent-banner detection passes detector gates but does
not improve the Steel workflow. A task change requires a new task
specification, labels, baselines, and gates before collection.

Stop the integration when the matched workflow comparison fails the primary
limit, the regression limits, or the detector cannot reach useful
acceptable-root accuracy.

Do not expand to the 5,000-page release corpus until the workflow comparison
supports the task.

## Consequences

The 2026-10-16 review cannot use the current repository state as continuation
evidence. It can use the repository state only to show that the contracts and
offline tools exist.

The review remains blocked until the pilot supplies real corpus, baseline,
agent-loop, latency, and matched workflow reports. Synthetic fixtures and unit
tests prove scoring behavior only.

If the pilot continues, publish the review evidence with sample counts,
uncertainty, costs, and failure slices. If the pilot stops or changes task,
preserve the consent task specification and explain which gate failed.

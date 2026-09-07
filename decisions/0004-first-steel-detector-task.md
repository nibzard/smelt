# 0004 - First Steel detector task

- **Status:** accepted
- **Date:** 2026-09-07

## Context

Decision 0003 requires the first Steel pilot task to be chosen by workflow
failure frequency, cost, and fit for a small detector. The repository contains
planning metadata and task candidates, but it contains no authorized Steel
session export. This record therefore uses permitted metadata only:

- Consent banners are the current provisional task.
- Other overlays, form fields, and primary action buttons are named candidates.
- Customer-session content must stay outside public corpora.
- Dedicated Steel crawls can proceed without customer-session access.

## Scoring

Scores use a 1 to 5 scale. Higher is better. The score is a planning rank, not
a measured Steel baseline.

| Candidate | Frequency | Cost | Small detector fit | Notes |
|---|---:|---:|---:|---|
| Consent banners | 5 | 5 | 5 | Common across EEA and US crawls, blocks page work early, has one root-label task, and has published nearest-neighbor evidence from CookieEnforcer. |
| Other overlays | 4 | 4 | 3 | Common and costly when modal, but the label mixes newsletters, age gates, sign-in walls, chat widgets, and promotions. It needs narrower task policy before training. |
| Form fields | 3 | 4 | 4 | High value for agents and password tools. The label space is larger than consent banners and needs field taxonomy before a pilot corpus. |
| Primary action buttons | 3 | 3 | 2 | Useful for workflows, but intent depends on page goal and surrounding text. A tiny detector is less likely to generalize without task context. |

## Decision

Confirm consent-banner root detection as the first Steel pilot task.

The first detector returns the primary visible consent notice root. It does not
click controls or choose consent preferences. The pilot can use dedicated Steel
crawls first, then authorized private samples only for failure discovery and
workflow evaluation.

Continue to rank real Steel failure slices during the pilot. A later change of
task requires a new task specification with labels, baselines, and gates before
collection.

## Consequences

The next task is to predeclare the Steel workflow metric and regression limits.
The existing consent task specification remains active. Other overlays become a
candidate second task only after the pilot records enough evidence to split them
into a clear detector target.

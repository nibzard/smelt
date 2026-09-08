# 0001 — Kill-criteria clock

- **Status:** accepted
- **Date:** 2026-09-06

## Context

Smelt must be closable honestly. mozilla/fathom died as a zombie: commits fell
from 481 in 2019 to 5 in 2022, community pull requests sat unanswered, and the
2025 archival bulk-closed them. Kill criteria only work if the decision dates
are registered before launch, the signals are countable without telemetry, and
the maintainer commits to acting on a dashboard snapshot.

## Decision

Day 0 is the public launch, planned for 2026-10-16. Pre-registered checks:

| Check | Date | Signals |
|---|---|---|
| Day 30 | 2026-11-15 | Repository public; CI gates green; ten distinct non-author quickstart completions |
| Day 60 | 2026-12-15 | Completion-signal diagnosis (not a kill; the opt-in metric undercounts by construction) |
| Day 90 | 2027-01-14 | Two third-party registry tasks; one shipped third-party extension (store URL plus source importing the package) |

Rules:

1. The ten-strangers signal is opt-in (no CLI telemetry, ever): a pre-filled
   GitHub issue plus an `ADOPTERS.md` pull request. Any two of three proxies
   count (quickstart completions, forks with pull requests, trainer downloads).
   Every dashboard figure derived this way carries a lower-bound label.
2. The maintainer pulls the plug on the check date, citing a dashboard
   snapshot. Contributors get a 14-day comment window first.
3. Narrowing to a single-task library means: freeze the factory at v0.x, keep
   one product package with quarterly retraining and CI eval, move the trainer
   to `attic/` with a postmortem record, keep the corpus mirrors. Full archive
   only if the surviving task stays under 100 weekly downloads for four
   consecutive weeks after narrowing.
4. Technical kill is separate: wedge F1 under 0.85 after week 8 narrows
   immediately, whatever the demand signals say.
5. The archive protocol (neutral home, final tag, mirrors stay, published
   `POSTMORTEM.md`) is specified in IDEA.md section 4.6 and is written before
   launch, not after failure.

## Consequences

- Closing or narrowing the project is a scheduled, evidence-cited act rather
  than a slow fade.
- The metrics dashboard must exist by day 30 for the clock to be readable.
- This record is the authority for all later "should we continue" threads.

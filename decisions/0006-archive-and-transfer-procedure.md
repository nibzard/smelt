# 0006 — Archive and transfer procedure

- **Status:** accepted
- **Date:** 2026-09-08
- **Depends on:** 0001, 0003, 0005
- **Fulfills:** IDEA.md section 4.6, task T039

## Context

mozilla/fathom died as a zombie: commits faded, pull requests sat unanswered,
and the 2025 archival bulk-closed them. Its training corpora then went dark
while shipped Firefox code still cited them.

Decision 0001 rule 5 and the risk table in IDEA.md section 4.5 require the
archive path to exist before failure. IDEA.md section 4.6 specifies its
content. This record turns that content into a runbook.

Decision 0003 sets the review calendar this procedure serves. The Steel pilot
evidence review runs on 2026-10-16. Public-launch day 0 is the actual first
product release. Decision 0001 rule 4 adds the technical kill: a wedge F1
under 0.85 after week 8 narrows the project immediately.

Decision 0003 supersedes decision 0001 for launch dates, continuation rules,
and trainer archival. This record follows 0003 wherever they overlap.

## Decision

The steps run in order. Step 1 runs for every stopping outcome. Steps 2
through 6 run when the project archives.

### Step 1 — Publish the evidence

Open a repository issue titled `Evidence: <outcome>` and post four items:

1. The review packet, as decision 0005 defines it.
2. The measurement snapshot the decision cites. Before public launch, that
   is the pilot evidence: the matched workflow comparison, the detector
   gates, and the costs. After launch, it is the metrics dashboard
   snapshot. Every opt-in figure carries a lower-bound label, because the
   opt-in metric undercounts by construction.
3. The predeclared gate that fired. State the measured value and the
   declared limit.
4. The measured costs: browser time, model calls, storage, and review
   hours.

Nothing else in this procedure starts until all four items are posted.

### Step 2 — Open the 14-day comment window

The window runs before every public archive, as IDEA.md section 4.6 and
decision 0003 rule 7 require. The evidence issue is the window. It stays
open for 14 calendar days. The maintainer answers every substantive
comment in the issue before proceeding.

The transfer offer in step 3 posts on the first day of the window, so
candidates can respond inside it.

### Step 3 — Offer the transfer

Post the transfer offer in the evidence issue and in the repository README.
The offer covers the repositories, the npm scope, the corpus mirrors, and
the gated-archive access list. Decision 0003 rule 7 and IDEA.md section 4.6
require the offer.

The maintainer accepts or declines a candidate in the issue. This record
adds the completion rule: a transfer agreed inside the window replaces the
archive. The new maintainer inherits this record and the kill-criteria
clock.

When the window closes with no candidate, step 4 follows.

### Step 4 — Preserve the artifacts

Public and preserved under the final tag:

- The repository history, the decision records, and the task
  specifications.
- The public corpus mirrors.
- The npm packages, kept installable.
- The review packets and the measurement snapshots.

Gated, and unchanged by an archive:

- WARC records and unscrubbed snapshots stay off-mirror under access
  logging.
- Private session evaluation data stays under its existing access and
  retention controls.

Track rules:

- Narrowing keeps the trainer and its reproduction path maintained.
  Decision 0003 rule 7 requires that. The maintenance cadence, quarterly
  retraining with CI evaluation, comes from decision 0001 rule 3. This
  record re-adopts the cadence for the narrowing track. Decision 0003
  supersedes the attic move in the same rule.
- Full archive preserves the trainer source with the final tag. The
  postmortem states that model updates stop.
- A task change preserves the old task specification with its failed gate,
  as decision 0005 requires.
- A surviving package follows the deprecation ladder in IDEA.md section
  3.5.5. Six months stale, or an F1 drop over 5 points on a refreshed
  probe, earns a stale badge. Then 60 days to refresh. Then archive. This
  record adds the routing: when that ladder ends in archive, the full
  procedure runs from step 1.

### Step 5 — Write POSTMORTEM.md

Write `POSTMORTEM.md` at the repository root from the template below. Name
the gate that fired and its measured values. State what a successor
inherits, and answer the redistribution question for every corpus layer.
The fathom lesson drives this: its training repositories went dark while
shipped code still cited them. A successor must not inherit that shape.

### Step 6 — Tag the final release

Tag the last verified commit `vX.Y.Z-final`. The tag message and the
changelog entry name the stopping reason and the gate that fired. The tag
lands after `POSTMORTEM.md`, so the final tree contains it. Publish the
npm packages from that tag. When no transfer happened, set the
repositories to archived and leave the issue trackers read-only.

## The tracks at a glance

| Outcome | Steps | Trainer | npm packages |
|---|---|---|---|
| Pause a task below its release gates | 1 | Maintained | Held back; never publish a failing model |
| Change the task | 1 | Maintained | Previous task held or withdrawn |
| Stop one integration, project continues | 1 | Maintained | Unaffected packages stay |
| Narrow to a single task | 1 | Maintained, quarterly retraining | One product package |
| Full archive | 1 to 6 | Preserved, frozen, with the final tag | Final release stays installable |

Track notes:

- The 2026-10-16 review can stop the consent-banner integration while the
  project continues. Decision 0005 names that outcome. The evidence issue
  records the stopped integration and its failed gate. No other step runs.
- The technical kill narrows immediately. Step 1 still publishes the
  evidence the narrowing used.
- Narrowing stops factory expansion. Decision 0003 rule 6 expands the
  factory only after a second task and an external contributor demonstrate
  reuse. A narrowed project has no second task.
- A narrowed project archives only through a scheduled review. That review
  runs the full procedure from step 1. Downloads and opt-in completions
  are supporting evidence, never automatic closure thresholds. This follows
  decision 0003 rule 6 and IDEA.md section 4.6.

## POSTMORTEM.md template

Copy this template into `POSTMORTEM.md` and fill every section. Delete no
headings; write "none" where a section has nothing.

    # Smelt postmortem

    - **Stopped on:** YYYY-MM-DD
    - **Outcome:** full archive
    - **Gate that fired:** <predeclared check, measured value, declared limit>
    - **Evidence:** <link to the evidence issue and measurement snapshot>
    - **Final tag:** vX.Y.Z-final

    ## What the evidence said

    Counts, uncertainty, and costs from the review packet. Every opt-in
    figure carries its lower-bound label.

    ## What went wrong

    The honest failure story. Name the assumption that broke and when it
    broke. Do not soften it.

    ## What a successor inherits

    Artifacts and their homes: repositories, mirrors, gated archive, npm
    packages. The redistribution answer for every corpus layer. Known
    debts, open questions, and the licenses that govern each artifact.

    ## What we would do differently

    Three items at most. Concrete, dated, and tied to the evidence above.

## Consequences

- Stopping is a scheduled, evidence-cited act. It is not a slow fade.
- Every archive takes at least 14 days.
- The procedure lives in the repository, so it survives a maintainer exit.
- Decision 0003 requires registering the public-launch review dates
  relative to the actual first product release. This record adds: register
  them in a new decision record that links here.
- This record adds three procedural details the sources leave open:
  - The transfer offer posts inside the window.
  - A completed transfer replaces the archive.
  - The deprecation ladder routes into this procedure.

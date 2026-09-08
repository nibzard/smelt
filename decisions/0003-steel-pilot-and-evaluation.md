# 0003 — Steel pilot and evaluation

- **Status:** accepted
- **Date:** 2026-09-07
- **Supersedes:** 0001 for launch dates, continuation rules, and trainer archival

## Context

The team owns Steel. Cloud browsers provide a collection backend and a first
integration path. Access to millions of browsing sessions is possible, but
availability and permitted reuse are not established by this decision.

The earlier plan assumes an independent project with a fixed public launch.
Its page-presence metric does not require useful element selection. Its
continuation rules prioritize external adoption before measuring Steel value.

## Decision

1. Run a six-week Steel pilot starting 2026-09-07. Review evidence on 2026-10-16.
   This replaces the planned public launch on that date. Register public
   adoption review dates relative to the actual first product release.
2. Begin with one task and a few hundred human-labeled pages from dedicated
   Steel crawls. Consent banners remain provisional. Choose the task using
   workflow failure frequency, cost, and suitability for a small detector.
3. Use authorized session samples for private evaluation and failure discovery.
   Keep customer-session content outside public corpora and the initial teacher
   pipeline. Dedicated crawls let the pilot proceed without session access.
4. Require an acceptable element root in the detection gate. Group related
   domains and duplicate templates when splitting data. Use development data
   for merge decisions and reserve unseen tests for release evaluation.
5. Compare rules, linear and tree models, and agent-improved rules on the same
   data. Compare matched Steel workflows with and without Smelt. Predeclare
   the primary workflow metric and acceptable regression limits.
6. Continue when task completion or cost per completed task improves without
   a material regression in the other. Retain a simpler trainer if the agent
   loop adds no useful gain. Expand the factory after a second task and an
   external contributor demonstrate reuse. Downloads remain supporting evidence.
7. Keep the trainer maintained when narrowing to a useful single-task library.
   Preserve the 14-day contributor comment window before public archival.
   Publish the decision evidence and offer transfer to a willing maintainer.

## Consequences

Steel can validate operational value before external distribution grows.
Internal adoption does not prove external demand. Browser time, model calls,
storage, and human review remain costs even when supplied internally.

The portable runtime still needs no Steel account or service. Public package
size and latency gates remain in place. Steel cloud measurements complement
the reference-machine benchmark; they do not replace it.

Decision 0001 remains unchanged as a historical record. IDEA.md sections 3.2,
3.3, 3.4.7, and 4 define the current evaluation and execution plan.

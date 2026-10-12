# Design arena, 2026-10-11

The material behind `docs/product-design.md`. Kept so the synthesis can be
traced; nothing here is normative. The brief every candidate received is
`brief.md`; the judge-only rubric is `rubric.md`.

| Candidate | Seed lens | Model | Judge score |
| --- | --- | --- | --- |
| [a](candidates/a/design.md) | evidence-stream centric | GPT 6.1 Sol | 27/30, recommended base |
| [b](candidates/b/design.md) | change-centric | GPT 6.1 Sol | 25/30 |
| [c](candidates/c/design.md) | repository and tooling centric | Claude Sonnet 5.5 | 16/30 |
| [d](candidates/d/design.md) | decision-queue centric (disclosed reading the rubric) | Claude Opus 5.5 | 14/30 |

- `judge.md`: the independent cross-judge's verdict (GPT 6.1 Sol).
- `verify-r1.md`, `verify-r2.md`, `verify-r3.md`, ...: independent verification rounds of
  the synthesis (GPT 6.1 Sol), each naming the revision it judged.

The orchestrator was Claude Fable 5.1. The synthesis decision, including how
the disagreement with the judge was resolved, is in `docs/product-design.md`.
Absolute paths inside the candidate files and reports are machine-local
(the worktree and scratch directory they were written in) and are not
portable; they are historical, not normative references.

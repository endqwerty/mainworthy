# Independent reviews of the MVP

The reports of the reviews named in the three pull requests that delivered the MVP (2026-10-12), as the reviewers
wrote them. Each reviewer judged a clean `git archive` export of one commit and changed nothing in the
repository. A reviewer is from a different provider than the author of the code it judged, except the two defect
hunts, which are marked.

Read them for the findings and the lines that decided each one. Three things to know:

- **The commits** are snapshots on the branch `mvp/history`; the stacked branches hold the same final tree cut
  into reviewable commits.
- **Links to logs, probes and scripts** point into the reviewers' working directories, which were not kept. The
  deciding lines are quoted in the reports, and every finding has a test in the repository that failed before
  its fix (`test/integrity.test.ts`, `test/policy.test.ts`, `test/budgets.test.ts`, `test/e2e/`).
- **A report describes the commit it judged.** A finding listed as open in one round is fixed in the next
  unless a later report or an issue says otherwise.

## The engine, the surfaces and the documents

| Review | Commit | Reviewer | Verdict | Report |
| --- | --- | --- | --- | --- |
| Engine, round 1 | `490aaf5` | GPT 6 Astra (Codex) | ISSUES (19 blockers) | [engine-r01.md](engine-r01.md) |
| Engine, round 2 | `3d7d860` | GPT 6 Astra (Codex) | ISSUES (9 blockers) | [engine-r02.md](engine-r02.md) |
| Engine, round 3 | `9ca6d25` | GPT 6 Astra (Codex) | ISSUES (11 blockers) | [engine-r03.md](engine-r03.md) |
| Engine, round 4 | `cb8e9a3` | GPT 6 Astra (Codex) | ISSUES (6 blockers) | [engine-r04.md](engine-r04.md) |
| Engine, round 5 | `310eddf` | GPT 6 Astra (Codex) | ISSUES (7 blockers) | [engine-r05.md](engine-r05.md) |
| Engine, round 6 | `aa7a605` | GPT 6 Astra (Codex) | ISSUES (4 blockers) | [engine-r06.md](engine-r06.md) |
| Engine, round 7 | `bdda0b1` | GPT 6 Astra (Codex) | ISSUES (2 blockers) | [engine-r07.md](engine-r07.md) |
| Engine, round 8 | `0be06bb` | GPT 6 Astra (Codex) | ISSUES (4 blockers) | [engine-r08.md](engine-r08.md) |
| Engine, round 9 | `f088a5c` | GPT 6 Astra (Codex) | ISSUES (4 blockers) | [engine-r09.md](engine-r09.md) |
| Engine, round 10 | `8482d11` | GPT 6 Astra (Codex) | ISSUES (4 blockers) | [engine-r10.md](engine-r10.md) |
| Engine, round 11 | `77fc9a7` | GPT 6 Astra (Codex) | ISSUES (5 blockers) | [engine-r11.md](engine-r11.md) |
| Engine, round 12 | `de57023` | GPT 6 Astra (Codex) | ISSUES (3 blockers) | [engine-r12.md](engine-r12.md) |
| Engine, round 13 | `3177d99` | GPT 6 Astra (Codex) | ISSUES (5 blockers) | [engine-r13.md](engine-r13.md) |
| Engine, round 14 | `3ef3aed` | GPT 6 Astra (Codex) | ISSUES (4 blockers) | [engine-r14.md](engine-r14.md) |
| Engine, round 15 | `46c9222` | GPT 6 Astra (Codex) | ISSUES (2 blockers) | [engine-r15.md](engine-r15.md) |
| Engine, round 16 | `a374026` | GPT 6 Astra (Codex) | PASS (no blockers) | [engine-r16.md](engine-r16.md) |
| Engine, defect hunt 1 | `a51da9f` | Claude Fable 5.1 (the author's provider: not independent) | 6 defects (H1-01 to H1-06), all fixed | [engine-hunt-1.md](engine-hunt-1.md) |
| Engine, defect hunt 2 | `ee6401d` | Claude Fable 5.1 (the author's provider: not independent) | 3 defects (H2-01 to H2-03), all fixed | [engine-hunt-2.md](engine-hunt-2.md) |
| Archive and reader threads | `aa7a605` | Claude Opus 5.5 | ISSUES (1 blocker) | [other-parts-r1.md](other-parts-r1.md) |
| Documents, diagrams and comments against the code | `a51da9f` | Claude Opus 5.5 | 9 wrong, 12 out of date, 11 unclear; all applied | [docs-r1.md](docs-r1.md) |
| The CLI's empty settings and the workflow | `46a58d9` | GPT 6 Astra (Codex) | PASS (no blockers) | [cli-r1.md](cli-r1.md) |

Rounds 1 to 14 each ran the same twelve checks. Rounds 15 and 16 were bounded to what had changed since the
round before.

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

## The web UI

Written by GPT 6.1 Sol. Each reviewer drove the real page in headless Chromium against a real server.

| Round | Commit | Reviewer | Verdict | Report |
| --- | --- | --- | --- | --- |
| 1 | `25d5571` | GPT 6 Astra (Codex) | ISSUES (5 blockers) | [ui-r1.md](ui-r1.md) |
| 2, full | `f1a2a24` | Claude Opus 5.5 | ISSUES (7 blockers) | [ui-r2c.md](ui-r2c.md) |
| 2, re-check of the parts Claude wrote | `f1a2a24` | GPT 6 Astra (Codex) | ISSUES (4 blockers) | [ui-r2a.md](ui-r2a.md) |
| 3, capture and editing | `b11d230` | Claude Opus 5.5 | ISSUES (4 blockers) | [ui-r3a.md](ui-r3a.md) |
| 3, queue and runs | `b11d230` | Claude Opus 5.5 | ISSUES (3 blockers) | [ui-r3b.md](ui-r3b.md) |
| 3, settings, session, keys, layout, speed | `b11d230` | Claude Opus 5.5 | ISSUES (2 blockers) | [ui-r3c.md](ui-r3c.md) |
| 3, re-check of the parts Claude wrote | `b11d230` | GPT 6 Astra (Codex) | ISSUES (2 blockers) | [ui-r3x.md](ui-r3x.md) |
| 4, drafts, saves, windows and sessions | `ec98ba4` | Claude Opus 5.5 | ISSUES (3 blockers) | [ui-r4a.md](ui-r4a.md) |
| 4, queue and runs | `ec98ba4` | Claude Opus 5.5 | ISSUES (4 blockers) | [ui-r4b.md](ui-r4b.md) |
| 4, changes, settings, session, keys, layout, speed | `ec98ba4` | Claude Opus 5.5 | PASS (no blockers) | [ui-r4c.md](ui-r4c.md) |
| 5, re-check: drafts, saves, windows and sessions | `9611d61` | Claude Opus 5.5 | ISSUES (1 blocker) | [ui-r5a.md](ui-r5a.md) |
| 5, re-check: queue and runs | `9611d61` | Claude Opus 5.5 | PASS (no blockers) | [ui-r5b.md](ui-r5b.md) |
| 6, re-check of round 5 | `67ebacc` | Claude Opus 5.5 | ISSUES (1 blocker) | [ui-r6.md](ui-r6.md) |
| 7, re-check of round 6 | `1fb4c0e` | Claude Opus 5.5 | ISSUES (1 blocker) | [ui-r7.md](ui-r7.md) |
| 8, re-check of round 7 | `5cc2b3a` | Claude Opus 5.5 | ISSUES (3 blockers) | [ui-r8.md](ui-r8.md) |
| 9, re-check of round 8 | `5df1747` | Claude Opus 5.5 | ISSUES (1 blocker) | [ui-r9.md](ui-r9.md) |

Round 9 was the last round, and the web UI as delivered is the commit it judged. Its blocker, R9-1, is open as
issue #81. Two attempts to fix it were each checked by GPT 6 Astra and each found incomplete
([ui-r9-fix-check-1.md](ui-r9-fix-check-1.md): 1 blocker; [ui-r9-fix-check-2.md](ui-r9-fix-check-2.md): 3
blockers), so they are not in the stack: they are on the branch `ui/conflict-recovery-attempt`. Round 9's
findings that do not block are issue #79.

`5cc2b3a` and `5df1747` were rebased onto the stacked branch `t3/mvp-product-delivery`: find them there by
their subject lines ("one record of a conflict", "one live window owns a case's draft"), not by these hashes.

## The check-speed work (pull request #80)

Written by Claude Opus 5.5.

| Review | Commit | Reviewer | Verdict | Report |
| --- | --- | --- | --- | --- |
| The parallel check, the split test files, the shared browser set-up and CI in shards | `6d7d12c` | GPT 6 Astra (Codex) | ISSUES (2 blockers) | [check-speed-r1.md](check-speed-r1.md) |
| The fix for the first finding (a test file in which every test was skipped) | `4a4f1fa` | GPT 6 Astra (Codex) | ISSUES (1 blocker) | [check-speed-r2.md](check-speed-r2.md) |

Both findings of the first are dealt with: the gate job fails on a test file in which every test was skipped,
and the pull request's description counts eight jobs, not nine. The second check passed every report Bun
writes and found one more shape, a test that takes its file from its suite, which no report in this
repository has. The commit after it counts those tests for their suite's file. That last commit has not had
an independent look.

## A failure that was the tests' and not the product's

[route-race.md](route-race.md): why a browser test that installs a network route and presses a key at once can
miss the request under load (Claude Opus 5.5, an investigation, not a review). The guard is in
`test/e2e/support.ts`.

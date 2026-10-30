# Panel 2: mutation testing in Mainworthy (claude-opus)

Evidence paths are under the investigation's scratch directory (not kept; see the research README); repository paths are at `91ce9287`.

## 1. Choice: (e) plus a documented assessor method, with (b) written down as a promotion trigger

- **In this repository's CI only.** A weekly job mutates about 12 sampled client lines. It picks them from lines whose covering tests the coverage cover would drop, and runs each mutant against the full covering set and the kept set, the same comparison phase 2 made (`phase2/RESULT.md:11-13`). The job reports one number: the kept set's lost-kill rate, which phase 2 measured at 2 of 18 (`phase2/RESULT.md:11`). It also lists each mutant that only one test killed.
- **The method, in `docs/`.** It describes how a repository-side assessor turns that output into a stage 1 review finding on the test (`decisions.tsv:17`; `panel1/contrarian.md:7-11`). The finding names the test, the mutant (file:line, operator) and its killers, and carries the kill rows as its evidence snapshot.
- **No product code.** No parser, no new facts in the per-test read, no new rule.
- **Promote to (b)** once either holds: a user team asks to upload mutation reports, or 8 weekly runs show the "only killer" rule deciding findings that people accept. Until then nothing reaches the state that an ingest would guard (`AGENTS.md:40`).

## 2. What a user sees, and which rule it decides

A Mainworthy user sees nothing new. In this repository a reviewer sees a finding such as "keep `people-signin.test.ts` #27: the only test that killed m015 (`src/web/lib/device.ts:69`, call deleted); the coverage cover dropped it" (`phase2/mutants.csv`, m015; `phase2/RESULT.md:27`). They accept, reject or defer it with the answers findings already have (`panel1/claude-opus.md:38-48`).

It decides one rule: **only killer → keep, and it vetoes delete, merge or move-down**. A test that coverage calls redundant but that alone kills a mutant stays (`phase2/RESULT.md:39`: "Retain tests that supply observed lost kills"). It does not decide "weak assertion: refactor". Phase 2 says a survivor can be an equivalent mutant, an unexercised branch on a covered line, or a missing assertion (`phase2/RESULT.md:36`). Google's developers called 85% of reported mutants unproductive (`research/methods.md:113`, marked [second]). Of the 11 survivors (`phase2/RESULT.md:13`), none has been triaged into those three kinds, so a survivor is a lead for a person to look at, not a verdict.

## 3. Cost

**This repository's CI.** Phase 2 used 6,126 s of wall time on 8 threads for 34 mutants (`phase2/mutation-total.json`), about 180 s per mutant. A standard private runner has 2 CPUs (`docs/development/tests.md:189-190`). Assuming the work is CPU-bound and scales linearly, that is about 720 runner-seconds per mutant. Twelve mutants come to about 8,650 runner-seconds per week. At $0.0001 per runner-second (`docs/development/tests.md:170-171`), that is about $0.86 a run, or **about $3.75/month** weekly. That equals about 8 runner-seconds added to every run at the $0.45 rate (`AGENTS.md:43`). The full 34-mutant sample would cost about $10.6/month, and at roughly 6.8 h it would pass the 6-hour job limit. Both figures are local proxies; I measured nothing on a runner. Running it per pull request at 12 mutants would be about 8,650 × $0.0001 × 4,530 ≈ $3,900/month, so weekly is the only reasonable frequency. Four of 34 mutants failed to build (`phase2/RESULT.md:13`). A type check before each run would skip those for seconds instead of minutes.

**Users.** Nothing until promotion. After promotion, users would pay for their own mutation runs, and on this stack those runs are hard. StrykerJS has no official Bun runner. The community runner needs TypeScript below 7, and this repository pins `^7.0.2` (`research/methods.md:128-146`; `package.json:53`).

## 4. Rejected

- **(a) alone.** A method with no recurring run drifts. The weekly lost-kill rate is the only ongoing check that the coverage cover, and any verdict built on it, still holds (`phase2/RESULT.md:11`).
- **(b) now.** It adds an ingest format without a requester. Mainworthy ingests JUnit and native runner reports and refuses CTRF (`docs/guide/report-results.md:92-111`), and its product vision is about pipeline results (`docs/product-vision.md:114-127`). `competitors.md` never mentions mutation (grep finds no hit), so it establishes neither demand nor its absence. A mutation report's test identities would also have to be joined to Mainworthy's tests, which are keyed by key, name and file (`product/inventory.md:58`). That join is unbuilt and untested.
- **(c).** Kill counts depend on the mutant sample. Phase 2's sample was cost-filtered and capped at 25 covering tests per mutant (`phase2/RESULT.md:31`). Surviving mutants cannot back "refactor" (§2). Putting them in the per-test read invites a reader to rank tests by kill count, the single-score risk panel 1 rejected (`panel1/claude-opus.md:82`).
- **(d).** Mainworthy does not execute tests (brief). Orchestration means running untrusted code, build matrices and hours of compute, a different product.

## 5. The strongest case against

Panel 1 settled that Mainworthy suggests a verdict only where it holds the deciding inputs (`decisions.tsv:17`). Mutation was the only check here that caught what coverage missed (`phase2/RESULT.md:11`, lost kills m001 and m015). Without ingest, then, the product can never hold the input that makes delete or move-down safe. It will answer `not-enough-evidence` for those verdicts indefinitely (`panel1/claude-opus.md:86-90`). Meanwhile, no competitor detects redundancy among automated tests (`research/competitors.md:138`), so ingesting a standard schema would be a cheap differentiator: one parser beside `src/surfaces/formats/trx.ts`.

My answer: the finding's evidence snapshot already carries the same kill rows without a schema commitment, so the deciding input does reach Mainworthy, attached by the assessor. The promotion trigger in §1 turns this objection into a measured decision rather than a guess. If a team uploads mutation reports, build (b) then.

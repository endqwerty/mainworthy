# Issue #81 round 2 independent QA review

Reviewer: Codex, gpt-6.1-sol, high reasoning effort. Author: Anthropic Claude Opus 5.5. Judged revision: 1aecf2076e8089d726dbe2ec4973f7b3be45fd49. Full range: caa8527..1aecf20.

Work runs only in exports under /tmp/cb81-verify-2. The shared checkout and /tmp/cb81-verify are read-only.

Safety fact: after settlement the page records only typed or chosen content, keeps typed text until the server holds it, and shows a conflict before replacing a colleague's newer change.

Planned checks: personally read the full diff and callees; whole check once with Chromium; focused browser and unit files; execute the new tests against 53d10aa; rerun every earlier probe twice; audit all versions and proposals for unfinished-step routes; follow the next editor leave and compare caa8527; probe adjacent rejection, alternate-answer, reload, inline tags/links, emptied actions and moved-card paths; inspect allRecorded and documents.

Review complete. No new blocker found; four non-blocking findings and the failed full check are recorded below.

## Initial results

Checks 1 and 8, PASS. Personally read full.diff and the changed helpers, their callers, draft storage/schema, cleanTitle, ConflictCard, sealDraft, mergeBodies, commandFate, command storage and registry dispatch. `git diff 7ef33ca 1aecf20 -- src/server src/core src/cli` returns no output. The new read operation has not changed since round 1. No additional standalone command probe is required by the brief.

Check 2, ISSUES. The full `bun run check` ran once with the required Chromium. check.log has `lint 1.6 s ok`, `typecheck 1.9 s ok`, `733 pass`, `1 skip`, `4 fail`, `Ran 738 tests across 61 files. [98.56s]`; the quiet tests ran 166 tests across 5 files in 65.60s. Total 164.2s. The 120s limit is not enforced on this 10-thread machine, as the log explicitly says.

Three failures match the named baseline exceptions. The fourth is `R3B-2 the first queue cursor survives a new question and settlement elsewhere`, a 5s timeout at round3-interactions.test.ts:100 waiting for `#detail` to contain `settled`. Focused rerun 1 passed, rerun 2 reproduced the exact timeout. This is a confirmed extra suite failure, with baseline attribution confirmed below. It is not hidden by the passing focused conflict tests. Logs: round3-repeat-1.log, round3-repeat-2.log.

Check 3, PASS on current revision. conflict-merge.log: `13 pass`, `0 fail`, `76 expect() calls`, 14.48s. merges.log: `14 pass`, `0 fail`, `35 expect() calls`. The two new browser tests assert that the expected-result text was not recorded in the head, remains in storage, and returns in the editor on the recorded-merge route. The moved-card route also retains the person's second action. They test their named settlement routes, not the next leave.

Both new browser tests fail against the 53d10aa export with only the current browser test file copied in. prior-v1.log: `0 pass`, `2 fail`, `4 expect() calls`; both fail the assertion `Expected to contain: "UNRECORDED EXPECTATION"`, receiving an empty storage string after adoption and a draft without the text after the new card. This is behavioral negative evidence, not an import failure.

## Finding N1: the next ordinary leave still drops an unfinished expected result

NON-BLOCKING, confirmed twice on each V1 route and twice on each route before the change. The initial settlement fix itself passes. Ordinary sealing removes the durable draft, and reload loses the unfinished expectation.

Smallest steps: edit v1's title and second action; add a third step with empty action and expected result `UNRECORDED EXPECTATION`; another client changes the title at v2; leave to open the card; type `MERGED TITLE`; resolve. The server records v3 with only the first two steps. The device draft at base 3 and the editor both still hold the third expectation. Press Escape once without completing the action. The page removes the durable stored draft although v3 still has only two steps. The open editor retains the expectation in volatile React state until reload; reload then loses it. No version or proposal holds the expectation. The moved-card variant first changes the title again at v3, resolves that new card with `AFTER MOVED TITLE` at v4, then removes its durable draft on Escape in the same way, losing the expectation on reload.

Cause on the judged revision: suite/index.tsx:712-716 excludes empty-action steps from the outgoing body. At :907 it removes the stored draft. At :910-919 it computes `more` using the same normalized body, so the unrecordable expectation is not a later change and the reconstructed draft is not dirty. This ordinary sealing code is unchanged in the reviewed diff. Evidence: extra.ts; extra.jsonl `unfinished` and `unfinished-moved`, both repetitions, points `settled` and `leave`. Each point includes every server version and proposal, the raw draft, and the rendered page. Settlement has `draft_count:1` and the expectation; leave has `draft_count:0`, no server expectation, and the same head version.

N1 attribution is now confirmed, NON-BLOCKING. The same two continuation probes each ran twice on caa8527, using its own export and helpers. unfinished-before.log has four PASS lines for reaching the audited checkpoints. extra-before.jsonl shows the unfinished expectation at settlement in all four cases, then `drafts:[]` after Escape, with no version or proposal holding it. The text remains visible in the current editor until a reload, which loses it. The old adopted route goes from v3 `MERGED TITLE` to v4 `Title typed locally`; the old moved route goes from v4 `AFTER MOVED TITLE` to v5 `Title typed locally`. The current revision avoids those title reversions but still removes its durable draft, so a reload loses the expectation. This inherited loss is not caused or touched by the changed ordinary sealing code, so it does not block this change under the brief's explicit rule. The absolute safety fact is nevertheless false if it includes the next ordinary leave.

## Checks 4 and 5: V1 and earlier routes

Check 4, PASS for settlement; ISSUES for the inherited continuation N1. neighbours.ts was copied from round 1 with only the import/export and evidence paths changed. `blank-expected` and `blank-expected-moved` both PASS twice. In the adopted route the head is v3 `MERGED TITLE` with two steps, while the stored draft on base 3 has those steps plus `{action:"",expected:"UNRECORDED EXPECTATION"}`. In the moved route the head remains v3 `Their title changed AGAIN`; the draft on base 1 has the expectation and new Q-5 card. Every version and proposal was audited and none holds that expectation. No unwanted version was recorded. The extra probe then answers the replacement card, confirms the expectation returns in the editor, and follows the next Escape as N1 describes.

Check 5, PASS. Every round-1 route ran twice on this revision. earlier.log has 34 PASS lines and no ISSUE. neighbours.log has 20 PASS lines and no ISSUE. probes.jsonl and neighbours.jsonl contain raw versions, bodies, device drafts, card IDs and visible status.

| Route | Deciding observations, both repetitions |
| --- | --- |
| R9-1 `ack`; F1 `retry`, `reload` | v4 has `Hand merged title`, `First action COLLEAGUE NEWER`, `Second action MY INPUT`; no draft; Escape keeps v4 |
| F2 `same-after` | Later title stays on base 4; Escape opens a card and keeps v5 `Their title AFTER`; deliberate answer makes v6 |
| F2 `same-before` | Head v4 `Their title BEFORE`; new Q-6 holds the later title and second-step input; only a deliberate second answer makes v5 |
| F3 `again-title` | v5 `Their title AFTER` stands through reload and Escape; no draft |
| F3 `api-title`; F4 `api-step` | Alternate answer is actually `decided`; the hand-typed card title and second-step input remain on original base; Escape asks before replacing the alternate v4; only a deliberate answer makes v5 |
| `later`, `choice-mine`, `choice-current` | Later typing or explicit choices become a draft on v4; the colleague's newer first step remains in v5 |
| `reject-lost` | Original-base draft keeps hand-typed title and second action; the next title collision is asked about |
| `step-retry`, `step-reload`, `empty-step` | Action merge survives recovery; temporarily empty action remains in the card and is not recorded; later valid action records |
| `takeover` | New owner recovers v4; no extra draft or version on Escape |
| `recorded-field-collision` | Selecting current title, then a colleague's newer title and a lost reply, allows later title typing into the card. Recovery keeps it on base 1; Escape shows a conflict without changing v5; explicit answer makes v6 |
| Step membership, keep and remove with lost reply | v3 has or omits `Edited action one` according to the explicit choice; second-step input remains; no draft |
| Two failed attempts, first arrives later | First merge records v3, second attempt's words remain a draft on base 3, and leaving records those words at v4 |
| Takeover with request held, both arrival orders | If first window wins, B's words survive in a draft and then v4; if B wins, v3 holds its words and A's late reply cannot change it |
| Strict policy, reply received and lost | Merge remains a proposal at v2 until acceptance, proposal holds all recordable text, acceptance makes v3 |
| No-conflict proposal refusal | Raw title and second action remain while v1 stands; reload and Escape later record exactly them at v2 |

## Check 6: adjacent unfinished, metadata and emptied-action routes

PASS for conflict settlement. extra.jsonl and extra-corrected.jsonl retain the full audit. Every listed route ran twice.

- Unfinished expectation with lost reply and reload, later card typing, and later typing after a moved card: the text remains in storage and the reopened editor. The card's latest typed title is recorded, and the unfinished expectation is never falsely recorded. The next leave has inherited N1 where the proposal can finish.
- Rejection, another client answering with the same body, and another client answering differently: the unfinished expectation remains. Same-body settlement does not discard it even though the head matches the merged card. Escape after rejection or a different answer opens a fresh card while leaving the alternate head and the expectation unchanged.
- A wholly empty new step carries no input and is removed after successful settlement; the recorded two-step body is correct and Escape records nothing more.
- Tags and requirement keys typed inline in title and second action: the initial conflict proposal contains four edits. The existing server rule refuses a merge of a proposal containing multiple edits; no input is dropped. After rejection the cleaned draft has `MERGED TITLE`, the second action without inline tokens, tags `["checkout","step-tag"]` and covers `["WEB-12","WEB-13"]`. Escape opens a new card while retaining those lists and the head. The refusal also preserves everything when the colleague changes the title again. This is not a moved-card merge route because the multi-edit proposal cannot be merged by design.
- An action emptied before an attempt stays empty in the card, the invalid attempt records nothing, and a subsequent valid action records exactly it.
- An action emptied after a recorded request's lost reply stays empty in the reopened draft. Escape deletes that step, reflecting the explicitly emptied action.
- An action emptied after a lost reply that held a new conflict uses the sent action for the next recordable card, retaining the step and its other fields. The new card visibly has `MERGED ACTION`; typing `AFTER MOVED ACTION` and answering records it, with no extra draft.

Method correction: the first rejection/alternate-answer/metadata scripts tried to click Resolve after the page had already reconciled an externally answered card. Those clicks timed out because the correct card was detached. extra-initial.ts and extra.log preserve the failed method. extra.ts removes that unnecessary click, waits for stored conflict absence and audits storage, editor and all server bodies. extra-corrected.log has 12 PASS lines and no ISSUE. These method timeouts are not product defects.

## Coverage finding N2: the fallback is browser-reachable

NON-BLOCKING, present in the first two commits too. The claim that the conservative fallback cannot be reached through the card's controls after an adopted merge is false. The unchanged round-1 `recorded-field-collision` probe reaches it twice on this revision: select current title, let the colleague change that title before the merge, lose the reply, type later title text, then recover. The resulting draft stays on base 1 and requires a new card before writing over v5.

A browser regression test is warranted for this route. The existing unit test already detects removal of the fallback, and the independent real-browser probe passes; no authored test claims to exercise this branch. Thus this gap is not a test passing for the wrong reason and does not block the change. The requested ordinary V1 settlement browser tests are meaningful and protect the introduced regression.

Check 3 additional unit negative evidence: extra-unit-prior.test.ts calls the prior helper using its actual prior `body` argument, computed by its recordable(). Both adopted and null-version cases require retention of the new raw expected text. prior-unit-v1.log has `0 pass`, `2 fail`, both `Received: null` at `expect(left).not.toBeNull()`. New allRecorded and nextMine did not exist on 53d10aa, so importing the whole new unit file there would fail at module loading and would not prove behavior. No such import failure is represented as a behavioral negative control.

## Check 7 and documentation finding N3

Check 7, PASS for preserving text absent from every server version or proposal, but ISSUES for its literal stronger statement about the head. When a hand-typed card matches the head, beyondCard still prevents dropping an unfinished expectation and placed prevents dropping changed tags or covers. Independent same-body alternate-answer probes confirm the former. The unit suite independently checks the tag case.

There is a documented qualification: allRecorded compares the entire card with the head only if hasTypedMerge is true. Otherwise it compares the draft with the head. A side selection can therefore differ from the head at removal. all-recorded-probe.log executes the production helper twice with draft/head title `My title`, selected card title `Their title`, and produces `typed:false,allRecorded:true`. The real-browser all-recorded-browser.ts repeats it twice: choose `Use current title` at v2 `Their title`; another client merges the underlying draft at v3 `Title typed locally`; the page drops its draft and card although the chosen card title differs from v3. `Their title` remains recorded in v2, and all manually typed underlying text is in v3. Thus no unrecorded input is lost, and this is not a blocker. The older implementation also allowed a draft matching the head to be dropped even when the chosen card differed.

N3 is NON-BLOCKING documentation. The comments on allRecorded and SHELL.md:50 and decision 0013:35-36 say the head holds all of both bodies, which the no-hand-typed branch does not require. Describe the actual rule in terms of unrecorded personal input, with selected-side text already held in a server version. Decision 0013:25-26 also says only later card typing moves onto a recorded merge's version; V1 now moves raw unfinished draft text onto it too. Its broad `Nothing typed leaves the device unrecorded` and `every path` at :33-34 need to be scoped to conflict settlement because of pre-existing N1.

Check 9, ISSUES only from these non-blocking qualifications.

| Document | Assessment |
| --- | --- |
| decision 0013 | Command states, caller/project isolation, per-attempt IDs, exact outcome recovery and conservative rebasing match code. The later raw-draft case and qualification above should be stated. The full ordinary-leave and reload guarantee is false by N1. |
| SHELL.md | The corrected recorded-field-collision qualification matches the code and the twice-run browser probe. Preservation of unfinished text on conflict settlement is correct. The literal all-text-in-head sentence needs N3's qualification. |
| CHECKS.md | The 13 browser tests assert the listed settlement routes and pass. Both new tests fail on 53d10aa. `last two rows` at :555-556 means the last two tests; the table combines them in its final row, and the penultimate row describes the already-passing rejection test. Use `last two tests`. The 899c428 run is a historical claim, not rerun in this round. |
| CHANGELOG.md | The reported stale-draft route and command-based lost-reply attribution are fixed. The three command states match the operation. |
| AGENTS.md | Issue #81's conflict-settlement blocker is fixed on the reviewed revision. No new blocker was found. Record inherited N1 and the extra pre-existing suite failure as follow-up work without implying this review found a new blocker. |
| docs/architecture.md, additionally read | The registry table correctly adds command, but the overview still says fifteen operations while there are sixteen. Non-blocking count update. |

## Additional suite finding N4

NON-BLOCKING for this change, but the full check is not green. The extra R3B-2 timeout reproduced in the full judged check and a focused judged rerun. It also reproduced unchanged on caa8527, in round3-before-7.log, at the identical `waitForFunction` assertion and 5s timeout. The other baseline repetitions passed, so this is intermittent. The queue implementation and this test have no diff in caa8527..1aecf20; do not attribute the failure to the conflict rewrite. Fourteen baseline runs were bounded attribution checks, not retries used to declare the full check passing. This failure counts in check 2 and is not one of the three provided exceptions.

The smallest recorded sequence is the existing test: start a standard project, create three cases, report C-1 failure, open Queue, report C-2 failure, open the first question's defect note and type BUG-12, then answer that question as infrastructure from the second client. The test times out waiting for `#detail` to say `settled` at test/e2e/round3-interactions.test.ts:100. This review establishes a pre-existing failing assertion, not the root cause of the queue timing and not a proven data-loss defect. It does not count as a new blocker of the reviewed conflict change.

Additional check 6 probes, PASS. last-probes.ts tests an unfinished expected result after a merge request never arrives followed by rejection, after a request never arrives followed by another client's same-body answer, and after a recorded merge's reply is lost followed by a second window taking ownership. All six runs retain the unfinished expectation at settlement. last-probes.log has six PASS lines and no ISSUE, and last-probes.jsonl contains all versions, proposals, durable drafts and the active editor.

N1 precision and final evidence: continuation.ts checks the actual expected-result textbox after Escape. It still contains the expectation in volatile editor state even though durable storage is empty. Reload and reopening the editor yields no third expected-result textbox, and no server version or proposal holds its text. continuation-before.ts repeats this on caa8527. Each script runs both settlement routes twice, and all eight audited continuations show `volatile-after-leave count:1,value:"UNRECORDED EXPECTATION"`, followed by `expectation-after-reload count:0,value:null`. The loss is durable-storage deletion on ordinary leave and actual disappearance on reload, not immediate clearing of the still-open input.

## Verdict and limits

No new blocker found on 1aecf2076e8089d726dbe2ec4973f7b3be45fd49. V1's two introduced settlement losses are fixed; the earlier R9-1/F1/F2/F3/F4 routes and adjacent ownership, retry, rejection, policy, side-selection and delayed-arrival routes pass. The new regression tests pass and fail behaviorally before the third commit. PASS here is for this change under the brief's rule excluding pre-existing untouched loss. It does not assert that the full check is green or that the absolute end-to-end no-loss fact holds beyond conflict settlement: N1 and N4 are retained pre-existing issues.

Not checked: every possible event ordering or arbitrary card body; other browsers; production or remote services; standalone command probes beyond the unchanged diff and current full-suite tests; a fresh full check on caa8527; the root cause of the intermittent queue timeout; custom idle-30s continuations for the unfinished-step case; a browser moved-card route with newly added inline tags/links, because the existing multi-edit server rule refuses such a merge; historical runs on 899c428; current new allRecorded/nextMine unit cases on 53d10aa, where those exports do not exist. Current source was not mutated for single-part-removal controls in this round; round 1's retained controls were read, and current focused tests and independent fallback probes were rerun.

Exact-source audit: source-audit.log compared all 490 tracked exported files with the judged git archive and found `Differences: []`. No judged product or test source was changed. The prior export intentionally holds the copied current browser test file.

No commit, push, PR, shared-checkout mutation or shared worktree cleanup was performed. All servers and browser contexts started by this review have been stopped. Only node_modules in the three review exports are removed; report, scripts, exports and logs remain under /tmp/cb81-verify-2.

Reviewer: Codex, gpt-6.1-sol, high reasoning effort. Judged revision: 1aecf2076e8089d726dbe2ec4973f7b3be45fd49.

PASS

# Issue #81 independent QA review

Reviewer: Codex, gpt-6.1-sol (high). Revision: 7ef33ca475c103095976be9584b1e18faaabcc29. Range: 957d03e..7ef33ca.

The shared checkout is read-only. All execution and scratch edits are in /tmp/cb81-verify. No network service or production is involved. The user explicitly selected this verifier; the project's normal different-provider rule is not met by this Codex reviewer, and this report does not claim otherwise.

Safety fact: once settled, the page records only typed or chosen content, removes typed text only when the server holds it, and shows a conflict before replacing a colleague's newer change.

Planned checks before probes: read the exact diff and callees; run the whole check once; run conflict-merge and merges individually; before-revision and single-part-removal controls; independent earlier-route probes and nearby failures; command isolation/read-only/generated interfaces; proposal callers and changed documents. Confirm any defect twice before reporting it.

Review complete. One confirmed blocker disproves the safety fact. The earlier reported routes pass on this revision.

## Checks 1, 2 and 6: initial evidence

1. PASS. Read the full diff personally, starting with merges.ts and the conflict callbacks, then registry/command storage, core merge3, the card UI, sealDraft, command read and generated interfaces. change.diff retains the exact range. A return to the fallback comparison in settleAnswered is an intentional whole-body check that proves text is held elsewhere, not attribution of one's own command. Single-part-removal controls and adjacent probes are recorded below.

2. ISSUES from three confirmed pre-existing Mac failures, with no new suite failure. `bun run check` ran once on the exact export with Chromium. Deciding lines in check.log: `lint 2.3 s ok`, `typecheck 2.7 s ok`, `728 pass`, `1 skip`, `3 fail`; quiet phase `Ran 166 tests across 5 files. [65.54s]`; total `165.1 s`. All three failures are exactly the ones named in the brief. The 120 s check limit is explicitly not enforced on this 10-thread Mac. No new failure appeared.

6. PASS. Own independent command-probe.ts uses real invoke/invokeAsync and HTTP/CLI. command-probe.log: `own ... state:done ... seq:2`, `absent`, `other-actor`, `other-project`, `refused`, `instance` all `state:none`; `running ... state:begun,op:report`; completed report `state:done,seq:4`. Repeated reads leave both command rows and project sequence numbers unchanged. The read connection rejects writes by configuration and registry dispatch creates no transaction for command. HTTP returns the exact stored reply, OpenAPI lists `/api/p/{project}/command`, and the generated CLI exits 0 with `state:done`. MCP intentionally omits it (`mcp:null`); the user asked HTTP/OpenAPI/CLI, all present. The command probe's initial Chromium skip message comes from importing browser helpers without setting the browser variable; this probe uses no browser and does not replace the actual browser checks.

## Check 4: earlier findings, independent browser probes

PASS on all earlier findings. probe.ts uses its own fixture, a two-step case whose second step also has an expected result, with real browser input and independent server edits. Every route ran twice. Full versions, bodies, stored drafts, conflict state and rendered text are in probes.jsonl. PASS below means both rounds agree.

| Earlier finding | Probe and deciding observations |
| --- | --- |
| R9-1 | `ack`: v4 `Hand merged title / First action COLLEAGUE NEWER / Second action MY INPUT`; `drafts:[]`; Escape leaves v4 |
| F1, retry and reload | `retry`, `reload`: same v4 and no draft, unchanged after Escape |
| F2, same-after | `same-after`: v5 holds `Their title AFTER`; later draft base 4; Escape opens a card without altering v5; answering records v6 `Hand merged title LATER` with both steps |
| F2, same-before | `same-before`: v4 `Their title BEFORE`, replacement question Q-6 retains `Hand merged title LATER` and second-step input; v5 only after a second deliberate answer |
| F3, again-title | `again-title`: v5 `Their title AFTER`, correct steps, no device draft, unchanged after Escape |
| F3, api-different-title | corrected `api-title`: API really returns `status:decided`; browser retains `Hand merged title` and second-step input on original base; Escape opens a new conflict and leaves the alternate v4 untouched; explicit answer records v5 |
| F4, api-different-step | corrected `api-step`: alternate v4 second step `API DIFFERENT STEP`; browser keeps `Second action MY INPUT`; Escape opens a new conflict, and only another answer changes the step |

Method correction: the first API probes passed an entire CaseView, including display metadata, where a strict CaseBody was required. Those requests returned `status:invalid`, but the first script did not assert the decision result. Its later retry legitimately recorded the browser merge. These runs are retained as failed-method evidence and are not product findings. probe.ts now constructs a valid body and asserts `status:decided`; probe-api-corrected.log has four PASS lines.

## Check 2: before-revision confirmation

PASS for attribution of the three baseline failures. On the clean 957d03e export, `bun test test/e2e/capture.test.ts` has `6 pass, 2 fail`, exactly the two capture failures from the full current check. `bun test src/cli/startup.test.ts` has `6 pass, 1 fail`, exactly the stdout-close failure with `head: illegal line count -- 0`. Logs before-capture.log and before-startup.log retain the assertions and stack traces. These are excluded from new-change defects; the full check still exits 1 and is not described as green.

## Check 3: focused tests on the judged revision

PASS. conflict-merge.log: `11 pass`, `0 fail`, `68 expect() calls`, `12.41s`. merges.log: `10 pass`, `0 fail`, `21 expect() calls`. I read every assertion. The browser tests assert stored drafts, actual server versions and bodies, and the presence of a replacement card before another write. The late-arrival test sends the original captured request to the real server under its original command ID. The unit tests call the production helpers directly. These are behavioral assertions rather than status-only tests. Completed negative controls are recorded below.

## Confirmed blocker V1: normalization deletes an unfinished step's typed expected result

Blocks: yes, violates the requirement that typed text is removed from the device only when the server holds it. Confirmed twice on the judged revision, with a second route confirmed twice too. This is a real-page probe using ordinary keys and textboxes, with no localStorage injection. Before-revision attribution is recorded below and establishes a regression on these routes.

Smallest steps from a two-step case at v1:

1. Enter the editor. Change the title to `Title typed locally` and step 2 to `Second action typed locally`.
2. At the end of step 2 press Enter to start step 3, Tab to its expected result, and type `UNRECORDED EXPECTATION`. Leave step 3's action empty.
3. Another client changes the title to `Their title` at v2. Press Escape; the title-conflict card opens. The device still holds step 3 `{action:"",expected:"UNRECORDED EXPECTATION"}` in the underlying draft.
4. Type `MERGED TITLE` in the card and press Resolve conflict.

Result, both repetitions: server v3 `MERGED TITLE / Action one / Second action typed locally`, no third step; device `drafts:[]`; probe reports `kept:false,recorded:false`. The expected-result text never existed in any server version or proposal because normalization excluded the empty-action step. The page says the conflict was resolved and version 3 recorded.

Second route: after step 3, before resolving, the other client changes the title again to `Their title changed AGAIN` at v3. Resolve opens the replacement card Q-5 and adopts nothing, but the underlying draft loses step 3 immediately. Both repetitions have `kept:false,recorded:false`, while the server remains v3 with its two original actions. This rules out clearing only after a successful adoption.

Cause on this revision:

- `src/web/lib/merges.ts:13-18` and `src/web/suite/index.tsx:59-60` omit empty-action steps from the sendable body, including their nonempty expected text.
- `src/web/lib/merges.ts:103-105` compares only that sendable body against conflict.mine. It sees no remaining draft text and returns null; `src/web/suite/index.tsx:470,480` removes the entire raw draft, including the omitted input.
- For the replacement-card route, `src/web/suite/index.tsx:125-127` now uses `sameBody(sentBody(latest), latest.conflict.mine)` and replaces latest.body with normalized state.mine, dropping the unfinished step even though nothing was adopted.

Evidence: neighbours.ts `blank-expected` and `blank-expected-moved`; neighbours-run.log has both ISSUE lines per route; neighbours.jsonl retains exact before/after server bodies, stored drafts, card IDs and screen messages. The existing unit test's empty-step case has `expected:null` only, so it does not protect nonempty expected-result text in an unfinished step.

V1 attribution confirmed: run the identical real-browser probes using the 957d03e export's helpers and product. `neighbours-before.log` has `PASS blank-expected 1`, `PASS blank-expected 2`, `PASS blank-expected-moved 1`, `PASS blank-expected-moved 2`. In both routes the unfinished expected text remains in the raw device draft on the earlier revision. V1 is introduced by this change on these settlement routes. This comparison stops at conflict settlement; it does not claim the old ordinary sealing path safely records unfinished steps.

V1 has a retained focused regression in scratch/test/unfinished-step-merge.test.ts. It calls the exact production helper with an empty-action/nonempty-expected step in the raw draft and its correctly normalized sendable body. unfinished-step-unit.log: `expect(received).not.toBeNull()`, `Received: null`, `0 pass`, `1 fail`. This is in the scratch export only, not the shared checkout.

## Check 5: nearby browser routes

ISSUES because of V1. The following other routes PASS, each twice with independent probes. The logs retain both server state and raw drafts; these are not claims based only on a PASS printout.

| Route | Deciding evidence |
| --- | --- |
| More card typing after a lost reply | probe.ts `later`: draft base 4 keeps later title and colleague's newer step; Escape records v5 with both |
| Use all my changes after a lost reply | `choice-mine`: selected `My title` becomes v5, while the newer colleague step remains |
| Keep current version after a lost reply | `choice-current`: selected `Their title` and original second action become v5; newer first action remains |
| Rejection after request loss | `reject-lost`: hand-typed title and independent second-step input remain a draft on original base; no overwrite before a replacement card and explicit answer |
| Step action conflict, lost reply then retry or reload | `step-retry`, `step-reload`: recorded action merge and second-step input remain; no extra draft or proposal |
| Temporarily empty merged step action | `empty-step`: empty value stays in the card; the invalid merge is not adopted; subsequent valid typed action is recorded |
| Step membership, keep and remove after lost reply/reload | neighbours.ts `member-keep-lost`, `member-remove-lost`: v3 respectively has `Edited action one` or lacks it; second-step input retained; no device draft |
| Two failed attempts with different text, first later arrives | `two-failed-late`: v3 has the first `MERGED TITLE`, while a draft on base 3 keeps `SECOND FAILED TEXT`; leaving records v4 with the latter |
| Takeover after a lost merge reply | probe.ts `takeover`: new owner recovers v4 and clears the already-recorded draft; Escape records nothing more |
| Takeover while the merge request is held, either arrival order | corrected neighbours.ts `takeover-pending`, `takeover-B-wins`: if A wins, B's words remain a draft on A's v3 and are later recorded by B; if B wins, v3 directly has `MERGED BY NEW WINDOW`; A's eventual reply changes neither outcome |
| Strict policy, acknowledged and lost reply | `strict`, `strict-lost`: v2 remains until a person accepts; P-5 holds `MERGED TITLE` and the second-step input before local draft deletion; acceptance records v3. Lost-reply recovery also finds the waiting proposal |

Takeover method correction: the initial probe assumed click() meant B's asynchronous merge had completed before A's held request was released. A sometimes arrived first, correctly leaving B's later words in a preserved draft. Waiting for draft deletion therefore timed out despite preservation. The corrected probe checks the safety requirement for that ordering, then seals the preserved draft, and separately waits for B's recorded merge before releasing A to test the opposite ordering. takeover-corrected.log has four PASS lines. No takeover defect is counted.

## Check 7: proposal callers with no conflict

PASS. I read sealDraft's conflict, rejected, and ApiError paths at suite/index.tsx:783-807 and 962-970, and both changed helper bodies. Without an existing conflict, forgetRequest still preserves latest.body, clears sent/conflict, and creates a new command ID. storeConflict's new body-replacement clause requires an existing conflict with a different question; it does not run for a draft with no conflict. The extracted sentBody normalization matches the prior inline normalization.

Independent real-page `plain-error`, twice: a controlled HTTP refusal of `/propose` leaves `Title typed locally / Action one / Second action typed locally` in the device draft, with server v1 unchanged. After removing the refusal and reloading, Escape records exactly that text at v2. plain-error.log has two PASS lines and both raw drafts/server bodies. Existing ordinary-draft browser tests also passed in the full current check. This pass is limited to the no-conflict caller behavior and does not erase V1 in conflict settlement.

## Check 8: changed documents

ISSUES, from V1 and two overbroad descriptions; no extra blocker is counted for documentation.

| Document | Assessment against code and execution |
| --- | --- |
| docs/decisions/0013-ask-what-became-of-a-command.md | The command read, actor/project isolation, per-attempt IDs, response classification and conservative version rebasing match the code. The assertion that the draft retains only content not held by the server is incomplete for raw input omitted by recordable, as V1 shows. The decision's explicit fallback for later text that conflicts with recorded fields matches draftAfterMerge:113-125. The operation is proposed and built, not represented as approved. |
| docs/architecture.md | The registry includes command. The lost-reply read does not replay a write, create a command record or advance a sequence. These statements match the code and independent command probe. |
| src/web/SHELL.md | Editing a temporarily empty merged action retains ownership and card, verified by empty-step. Per-attempt persistence and owner checks match. The sentence saying card text after a recorded merge becomes a draft on that merge's version needs the qualification already given in decision 0013: conflicting later text stays on the original base. The page also has a whole-body comparison at suite/index.tsx:596 for text held by an alternate client's merge; it never uses that comparison to identify its own submitted command. |
| src/web/CHECKS.md | All eleven listed regression routes are genuinely asserted and pass on this head. Independently copying the file into 957d03e gives 0 pass/11 fail. The cited 899c428 run is historical and was not rerun. The round6 status assertion changed without dropping its following text/editability checks. The coverage list omits the V1 case where an otherwise unfinished step already has a typed expectation. |
| CHANGELOG.md | The stated R9-1 route and command-based lost-reply attribution are fixed. Command returns the three described states. It is not a claim that every conflict input path is safe. |
| AGENTS.md | `No blocking defect is known` is no longer accurate after V1. The author should record this finding before making that claim. |
| README.md | The added decision 0013 link is valid. |

## Check 3: before-revision and single-part-removal controls

PASS for test sensitivity, with the explicit limit below. controls.py and controls-resume.py keep the source changes and restoration procedure reviewable. Each browser file runs by itself. The interruption stopped the first scratch mutation run; I restored scratch sources from the judged export before restarting the mutation controls. Its incomplete log was superseded by the completed rerun. The shared checkout was never edited.

| Control | Unit result | Browser result | What notices it |
| --- | --- | --- | --- |
| Copy current test files into 957d03e | Cannot execute merges.test.ts because merges.ts is newly introduced; `Cannot find module`, not behavioral evidence | 0 pass / 11 fail | The old actual UI leaves drafts, drops later merge data or restores undone content. Baseline browser failures are assertions/timeouts after fixture construction, not missing imports. |
| Skip command outcome recovery | 10 pass / 0 fail | 4 pass / 7 fail | Lost-reply recovery, later typing, replacement-card recovery and late first-attempt routes |
| Keep only the latest merge attempt ID | 10 pass / 0 fail | 10 pass / 1 fail | Specifically the first-attempt-arrives-after-second-attempt test |
| Let cardText return the whole merged card | 8 pass / 2 fail | 10 pass / 1 fail | Both unit tests on attribution, and the browser's rejection/colleague-undo test |
| Ignore conflicts when carrying later text onto recorded version | 9 pass / 1 fail | 11 pass / 0 fail | Only the unit case where the recorded version took that field from somebody else |
| Restore exact source | Original unit result remains 10 pass / 0 fail | 11 pass / 0 fail, 68 assertions, 12.66s | restored-regression.log |

The browser suite does not cover the helper's conservative fallback when later text changes a field that the server had combined differently in the recorded merge. The unit test does catch removal of that protection; this is a coverage limit, not a test passing for the wrong reason. The independent real-page probe recorded-field-collision passed twice, as detailed below. No author test pretends to cover the raw nonempty expectation in V1; the existing empty-step unit fixture explicitly has no typed expectation.


The real-page `recorded-field-collision` probe exercises the unit-only protection in the final control. Select the current title in the original card, let another client change that title before the merge, lose the merge reply, then type later title text into the card. Recovery leaves that text on original base 1, because the server combined a different title into its recorded v5. Escape opens a conflict and leaves v5 unchanged; a deliberate answer records v6 with the later text. recorded-field-collision.log has two PASS lines. This supports the conservative fallback even though the eleven authored browser tests alone do not cover it.

The final V1 audit reran both losing routes twice and read all case versions and case-related proposals through the actual API. unfinished-step-audit.log and the `all-server-text` rows in neighbours.jsonl show three versions per route, three proposals for the adopted route and four for the replacement-card route. None holds `UNRECORDED EXPECTATION`. Each still reports `kept:false,recorded:false`. The head-only inspection was therefore not hiding a server proposal that kept the omitted text.

## Verdict and limits

The command operation passes the checks in this review. R9-1, F1, F2 both variants, F3 both variants and F4 pass independent real-page rechecks. The authored browser/unit tests pass, and isolated removals establish what they protect. The full check has only the three independently confirmed baseline Mac failures.

The conflict-flow safety fact fails on V1. The raw device draft is more than its normalized request body. Settling or replacing a card must preserve text that normalization excluded from the request, including expected results in unfinished steps. V1 is one blocker with two confirmed settlement routes, both introduced on this range; it is not counted twice.

Not checked:

- Every combination of arrival order, retry, rejection, reload and colleague edits. The safety fact is disproved by concrete repeated routes, not claimed exhaustive.
- Real browser/network crashes, discarded/frozen tabs, storage quota failures, operating-system interruptions, other browser profiles/devices, headed Chromium or another browser engine.
- The new routes waiting for the 30-second idle seal. They use Escape and inspect real recorded versions; no separate idle-time claim is made.
- New custom journeys for preconditions, expected-result conflicts, methods, automate, custom fields or ordering conflicts. Step actions, step membership, titles and the unfinished-step expectation were exercised as specified above; the core merge implementation and existing full-suite tests were read/run.
- A standard-policy agent-author UI merge, production, external services or deployed code. Strict-policy human acceptance was exercised locally, including the lost-reply waiting-proposal branch.
- The historical 899c428 documentation run. The requested comparison revision 957d03e was tested directly instead.

Provider/model: Codex, gpt-6.1-sol, high effort. Judged revision: 7ef33ca475c103095976be9584b1e18faaabcc29. No repository changes, commits, pushes or PR actions were made.

## Restoration and cleanup

source-audit.log compares all 489 tracked files in each of tree and scratch with the exact judged git archive: both have `differences: []`. The new V1 regression is an additional scratch-only file. The before export intentionally contains the copied current test files. Reports, exports, probe/control scripts and logs remain in /tmp/cb81-verify.

Every helper-owned server and browser was closed. The final process check showed no probe, test server or browser suite still running. Only node_modules in the three exports were removed, including scratch's dependency symlink. No shared-checkout cleanup or worktree release ran.

ISSUES (1 blockers)

# Casebook web UI: independent verification, round 6 (re-check of round 5's six findings)

Revision judged: `67ebacc648445a03f2fcd3e6c479540a42c7070b`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's author (GPT 6.1 Sol).

Status: **complete** (see "Not checked"). Nothing in the repository was changed; it was read with `git archive` only.
While I worked the branch moved on to `3cfbbd2` (three snapshots: diagrams and the engine); `git diff --stat
67ebacc 3cfbbd2 -- src/web test/e2e src/surfaces/http.ts` is empty, so the code in scope is the same there.
I judged `67ebacc` only.

## Result in short

All six round-5 findings are fixed **by the route round 5 reported**, on two runs each, and the authors' suite
passed twice. One fix brought back an older defect in a new place: the fix for N-1 keeps a choice made in the
conflict card as a fixed piece of text, so text typed in the editor **after** a choice is left out of the merge
and then deleted with the draft, while the screen says "Conflict resolved." (R6-1). That is round 4's R4A-1
again, for the fields the person made a choice on (and for every field after "Use all my changes" or "Keep
current version"). On round 5's revision the same keys recorded the text. I count it as the one blocker, by
the standard rounds 4 and 5 used for R4A-1 and N-1.

Three more things do not block: "Resolve conflict" says "Conflict resolved." when the server answered that the
merge met a new conflict (R6-2, not new: the same on round 5's revision); N-2 is still reachable through a
reload (R6-3); and the step-mark half of R5B-1 is not fixed (R6-4).

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision, by one defect** (R6-1: text typed after a choice in the conflict card is lost
when another producer changed the same thing). It holds on every other route I ran, with the false status
line of R6-2 beside it.

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium`
  (`--headless=new --ozone-platform=headless`), real server processes on 127.0.0.1, ports 8950 to 8999, data under
  `/tmp/casebook-ui-r6`. The authors' suite ran unpatched on its own ports (7400 to 7499). No file of the export
  is changed; the probes use their own copy of the test helper (`probes/b/support.ts`, ports and flags only).
- Round 5's probes copied into `probes/a/` (from `ui-r5a/probes/`) and `probes/b/` (from `ui-r5b/probes/`) with
  only paths and ports changed; run from `tree/` as `bun ../probes/<a|b>/<name>.ts <scenario>`. New probes for
  the neighbours: `probes/a/r6.ts`, `probes/b/r6-run.ts`, `probes/b/r6-queue.ts`. Output in `logs/`:
  `a-*`/`b-*` are round 5's probes, `a4-*`/`b4-*` round 4's, `a6-*`/`b6-*` mine; `.1.log` is the first run,
  `.2.log` the second; my `a6-*` probes run each scenario twice inside one log ("round 1", "round 2").
- Every probe drives the real UI with trusted key events and reads the server through its API. Slow, failed and
  lost replies are injected at the browser (`page.route`); a closing tab's lost write by taking the browser
  context offline.
- Three probes were also run against round 5's revision `9611d61` (export in `r5tree/`,
  `logs/*.r5-revision.log`) to tell a new problem from an old one.
- Mutations: `probes/mutate6.py` removes one fix at a time in a scratch copy (`mut/tree`, removed afterwards) and
  runs the authors' test for it (`logs/mutations.log`).

## Findings re-checked

| Finding | Verdict | What ran and the deciding lines |
| --- | --- | --- |
| N-1 a choice in the card thrown away by the next key in the editor | **fixed, with a new problem** (R6-1, blocks) | `a/r5.ts card-choice` twice (`logs/a-card-choice.{1,2}.log`, two rounds in each, 4 of 4 per variant): typed: `mergedFieldAfterTheChoice "Coupon case, merged by hand", mergedFieldAfterOneKeyInAStep "Coupon case, merged by hand", sentToServer ["Coupon case, merged by hand"], server {version 3, title "Coupon case, merged by hand", steps ["Open the cart","Apply the coupon!"]}, storage []`; use-current: `mergedFieldAfterOneKeyInAStep "Coupon case theirs" … server {version 3, title "Coupon case theirs", steps [… "Apply the coupon!"]}`. `card-edit` twice: `server {version 3, title "Coupon case, written by hand in the card", steps […,"Apply the coupon!"]}`. The new problem is the other order of the same two things: a choice, then typing in the field the choice was about (or anywhere, after a whole-body choice). |
| N-2 every leave under a card proposes again; the earlier proposals stay open | **fixed** for the route reported; still reachable by a reload (R6-3, does not block) | `a/r5.ts orphans` twice (`logs/a-orphans.{1,2}.log`, 4 of 4 rounds): one request only, `cmd 0ccf453f base 1 "Coupon case mine" … reply "status":"conflict" "question":"Q-3"`; after resolving `server {version 3, title "Coupon case mine", steps […,"Apply the coupon SAVE10 and check the total"]}`, `questions open []`, `inbox []`, `proposalCards 0`, `storage []`. |
| N-3 a closed tab leaves the person in conflict with their own half sentence | **fixed** | `a/r5.ts closed-edit-more` twice (`logs/a-closed-edit-more.{1,2}.log`): close: requests `cmd d41ab22a base 1 "Coupon case for returning cust"` → `adopted`, then `cmd 63149f97 base 2 "Coupon case for returning customers"` → `adopted`; `cards 0`, server `C-1 Coupon case for returning customers v3`, `storage []`, no open question; reload: the same. `a/r4.ts closed-tab-edit` twice (4 of 4 rounds): `conflict 0`, `version 3`, `"Open the order and ask for a refund to the card"`. (`closed-edit-resolve type-and-resolve` now times out waiting for a card that no longer comes: that is the fix.) |
| R5B-1 a note in the field at Enter is not sent | **the note: fixed; the step mark: not fixed** (R6-4, does not block) | `b/r5-run.ts refail-pace` twice (`logs/b-refail-pace.{1,2}.log`): report +800 and +1200 ms: `fieldAtEnter "wrong total"`, requests `C-1:fail(wrong total)`, `C-1:fail@s2(wrong total) corrects 1`, server `C-1:failing:daniel/fail(wrong total)` (round 5: `fail@s2()`); +300 and +500 ms: the field is empty at Enter and nothing is sent as a note, as in round 5. `refail` twice: the same at +800 ms with and without the step. `note-after-failed` twice: the third request is `C-1:fail(wrong total) corrects 1`, server `fail(wrong total)`, `stored {}` (round 5: `C-1:fail corrects 1`, the note stuck on the device). `mark-after-pass` twice, +1500 ms: hint at Enter `Step 2 marked. …`, request `C-1:fail(meant to fail at two) corrects 1`: no step, as in round 5. |
| R5B-2 `u` in a closed run says the result was corrected | **fixed** | `b/r5-run.ts closed-u` twice (`logs/b-closed-u.{1,2}.log`): after `u`: `status "This run is closed. No result was recorded; your note is kept."`, `requests ["C-1:pass"]` (nothing new), server `C-1:satisfied:daniel/pass`, rows unchanged. |
| R5B-3 two selected, the reference field open, one answered elsewhere: Enter and Escape refused | **fixed** | `b/r5-queue.ts bulk-inline-gone` twice (`logs/b-bulk-inline-gone.{1,2}.log`): after the other person's answer `needs "1 selected questions will receive this answer."`, field `BUG-7` still open; Enter: `field {open 0}`, `decides ["Q-6:defect(BUG-7)"]`, server `decided:defect(BUG-7) by daniel`, `decided:flaky by daniel`. Escape (my `b/r6-queue.ts bulk`, variant `escape`, twice): `decides ["Q-7:defect"]`, the field closed, `j` moves on. |

R5B-4 (`u` restores a failure without its step) is left by the authors (issue #72, its test is skipped). Not
re-checked; it stands as round 5 reported it.

## What each fix could have broken next to it

Each line ran twice with the same result unless it says otherwise.

**N-1** (`probes/a/r6.ts`, `logs/a6-*.log`; round 4's `a/r4.ts`, `logs/a4-*.log`):

| Check | Result |
| --- | --- |
| R4A-1 as round 4 reported it: text typed after the card, then "Use my title", then resolve (`r4.ts conflict-more`) | holds: one request, `server {version 3, title "Coupon case mine", steps […,"Apply the coupon SAVE10 typed after the conflict"]}`, `storage []`, the same 32 s later |
| No choice, more typed in the conflicting field, resolve | holds: `decide Q-3 merge title "Coupon case mine, second thoughts"`, `version 3` |
| A choice in one field, typing in another, both sides: "Use my title" then a step; "Use current title" then a step | holds: `title "Coupon case mine"` / `"Coupon case theirs"`, `steps […,"Apply the coupon SAVE10"]`, `version 3` |
| **A choice, then typing in the same field; a whole-body choice, then typing anywhere** | **fails: R6-1** (six variants, 2 of 2 each) |
| Two fields in conflict (title and step 2): current title + a step merged by hand, then typing in step 1; my title + current step, then step 1 | holds: `title "Coupon case theirs", steps ["Open the cart first","Apply the coupon, merged by hand"]`; `title "Coupon case mine", steps ["Open the cart first","Apply the coupon THEIRS"]` |
| Two fields: current title + "Use my steps.b2.action", then more typed in step 2 | fails the same way: `editorStep2 "Apply the coupon MINE AND MORE"`, recorded `"Apply the coupon MINE"` (R6-1) |
| A second conflict on the same case after the first was resolved with "Use current title" | holds: the second card starts from the draft (`mergedTitle "Coupon case theirs once more"`), not from the first card's choice; `version 4`, no open question |
| The other side changes the same field again while the card is open, then resolve | **fails: R6-2** (not new) |
| The other side changes another field while the card is open, then resolve | holds: `version 4, title "Coupon case mine", steps ["Open the cart, changed by them later", …]`, no open question |

**N-2**:

| Check | Result |
| --- | --- |
| The draft changes after "Resolve conflict" was pressed (replies 700 ms away), then Escape, or nothing | holds: `status "Conflict resolved. Your later text is kept as a draft."`, the editor still open with the text, then `propose … base 3 … "Apply the coupon typed after Resolve"` → `adopted`, `version 4`, `storage []`, no open question |
| The other side withdraws the conflict (rejects its question), the person on the case or on another case | holds: `The conflict proposal was rejected. Your current draft is kept; leave the editor to propose it afresh.`, `cards 0`; the next leave sends a new request (`cmd 8c2a3ce9 … "Apply the coupon SAVE10"` → `conflict Q-5`), a card, resolved to `version 3`; `questions open []` |
| Away to another case and back with the card open | holds: the card is back with `e`, one question, `version 3`, nothing open |
| **A reload with the card open** | **leaves the first question open: R6-3** |
| Round 4's R4A-2 probes (`conflict-elsewhere`, `conflict-reject-ui`), R4A-1's (`conflict-variants`, `conflict-after-failure`) | hold, twice each: `conflict-variants`: without leaving the editor `steps […,"Apply the coupon SAVE10"]`; going on in the conflicting field with the choice made last: `title "Coupon case mine, second thoughts"`. `conflict-after-failure` (2 rounds each): the same id sent twice, card `Your draft Coupon case mine and the rest of my sentence`, `version 3` with the full sentence. `conflict-reject-ui`: after `r`, `r` the card is gone, the next leave sends a new id (`cmd 3dc8be33`), a new card, resolved to `version 3 … "Apply the coupon SAVE10"`. `conflict-elsewhere reject`: `The conflict proposal was rejected. Your current draft is kept…`, `cards 0`, proposed afresh and resolved to `version 3`; `accept` is refused by the server and the card resolves as before |

**N-3**:

| Check | Result |
| --- | --- |
| A tab closed and reopened twice in one sentence (`closed-twice`) | holds: three window ids; `"Coupon case for return"` → `"… returning cust"` → `"… returning customers"`; requests `cmd d920becf base 1 "Coupon case for return"` → `adopted Q-2` (the stored request, answered with what was recorded), `cmd 48656c5f base 2 "Coupon case for returning customers"` → `adopted`; `cards 0`, `version 3`, `storage []`. See "Worth doing later" for what the second close does not record. |
| The closing tab's write never arrived (context offline), then a new tab | holds: `after1 version 1`; the new tab sends the stored request (`version 2`), then the full text (`version 3`), no card |
| A colleague changed the title between the close and the new tab | holds: the stored request is answered as recorded, the longer text meets a real conflict (`Q-4`), the card shows both sides, resolved to `version 4 "Coupon case for returning customers"`, nothing open |
| A colleague changed a step in between | holds: `version 4`, both changes, no card |
| Two live windows do not share a request (round 4's R4A-2 `dup-tab`, R4A-5 `windows-capture`, `windows-reload`, `tabs2.ts windows`) | hold, twice each: `dup-tab`: `windowIds ["6d0e784e","bebdbadb"]`, requests `A cmd 36be4fbb`, `B cmd 612b01a2` (different); different fields: `version 4, "Coupon case from A again", ["Open the cart from B"]`; the same field: a card with both sides, B's text kept. `windows-capture`: the second window opens with `focus BODY[], editors 0`, one request, one new case. `windows-reload`: `version 3, steps ["Open the cart from window A","Apply the coupon from window B"]`. `tabs2.ts windows`: two ids, `version 3` for different fields, a card for the same field |

**R5B-1 to R5B-3** (`probes/b/r6-run.ts`, `r6-queue.ts`, `logs/b6-*.log`; round 4's `new-run.ts`, `new-queue.ts`, `logs/b4-*.log`):

| Check | Result |
| --- | --- |
| R4B-8 a correction must not carry the note of the failure it replaces (`new-run.ts orders`, twelve order and delay pairs) | holds: all `"verdict":"ok"`, e.g. `C-1:fail(wrong total)`, `C-1:skip(Withdrawn by the author) corrects 1`, `C-1:pass corrects 2` |
| The same at the note field: fail with a note (reply +800 ms), `k`, `p` | holds: `C-1:pass corrects 1`, no note |
| The note cleared by hand, or changed, before the second Enter (reply +800 ms) | holds: `C-1:fail corrects 1` (no note); `C-1:fail(other text) corrects 1` |
| R4B-7 Enter on a note in a closed run (`new-run.ts closed-under-note`) | holds: `This run is closed. No result was recorded; your note is kept.`, the note in the field and on the device, `requests ["C-1:pass"]` |
| `u` held down (seven key-downs) and `u` twice in an open run | holds: one correction, `["C-1:pass","C-1:skip(Withdrawn by the author) corrects 1"]` |
| `u` twice and `s` in a closed run | holds: nothing sent, the closed-run message |
| Step marks (`new-run.ts step-mark`, `step-pass`; `r6-run.ts mark`) | hold where the mark is new: `2 f` note Enter `k 3 f` Enter with replies +1200 ms: `C-1:fail@s3(seen it) corrects 1`; `f` note Enter `k 2 f` Enter: `C-1:fail@s2(seen it) corrects 1`. Not where the mark was pressed before an earlier result on the slot: R6-4 |
| R4B-4 the field follows the person (`new-queue.ts inline-click`, both variants) | holds: `fieldOpen 0`, `decides []`, the other question untouched |
| R4B-5 a selected question settled elsewhere (`new-queue.ts selected-gone`) | holds: `ticks ["","",""]`, `decides ["Q-5:infra"]`, `decided:infra by daniel` |
| Both selected answered elsewhere with the field open | holds: the field closes, `decides []`, the reference kept on the device, `j` moves on |
| The selected question under the cursor answered elsewhere, the other still selected | holds: the field closes (`1 selected questions will receive this answer.`), Enter sends nothing, `j` moves to the other |
| Three selected, one answered elsewhere, Enter | holds: `decides ["Q-7:defect(BUG-7)+Q-5:defect(BUG-7)"]` |

## The authors' suite

`bun test test/e2e`, unpatched, twice, one after the other, with my first probes running beside it:

```text
run 1: 175 pass, 1 skip, 0 fail, 783 expect() calls. Ran 176 tests across 19 files. [280.31s]   (logs/e2e-1.log)
run 2: 175 pass, 1 skip, 0 fail, 783 expect() calls. Ran 176 tests across 19 files. [275.29s]   (logs/e2e-2.log)
```

No failure and no flake in two runs. (The authors' own notes record two earlier pairs where an old test, R3B-3
and then UI-5's undo, timed out once; I did not see either.) The one skip is R5B-4's.

`bunx tsc --noEmit`: exit 0. `bunx biome check src/web test/e2e`: `Checked 60 files in 123ms. No fixes applied.`
`bun test test/architecture.test.ts`: `12 pass, 0 fail`.

## Defects

### R6-1: Text typed in the editor after a choice in the conflict card is left out of the merge and deleted with the draft; the screen says "Conflict resolved."

Blocks: **yes, as a judgement** (see "How wide"). New on this revision; it comes from the fix for N-1. Round 4's
R4A-1 again, for the fields a choice was made on. Reproduced 2 of 2 in each of six variants
(`probes/a/r6.ts choice-then-type` and `two-fields`, `logs/a6-choice-*.log`, `logs/a6-two-fields.log`,
`shots/r6-choice-*.png`).

A choice is now kept apart from the merged body and applied on top of it each time the card is drawn (the fix).
But what is kept is the **text at the moment of the click**, not which side was chosen
(`src/web/case/pane.tsx`: `onClick={() => field.set(field.mine)}`, and for the two whole-body buttons
`setChoices(new Map([["all", () => state.mine]]))`, where `state` is the card as it was at that click). Text
typed in the editor afterwards changes the draft and the card's "Your draft" side, but not the stored choice.
"Resolve conflict" sends the stored text, and `onResolved` (`src/web/suite/index.tsx`) then removes the draft,
because the draft is equal to the conflict's own `mine`.

Smallest reproduction (the widest form). C-1 with two steps: `e`, type ` mine` in the title; a colleague records
the title `Coupon case theirs`; Escape: the card. Press **Use all my changes**. Click step 2, type ` SAVE10`.
Press **Resolve conflict**:

```text
beforeResolve: editorStep2 "Apply the coupon SAVE10"; the card's diff shows "Apply the coupon SAVE10" as the draft's step
decide Q-3 merge title "Coupon case mine" steps ["Open the cart","Apply the coupon"]     reply "status":"decided"
after: status "Conflict resolved. Both earlier versions remain in the timeline.",
  server {version 3, title "Coupon case mine", steps ["Open the cart","Apply the coupon"]}, storage [], editorOpen 0
34 s later: the same
```

` SAVE10` is in no version, not on the device and no longer on the screen. Nothing on the card shows it will be
dropped: the step is not in conflict, so the card has no merged field for it, and the diff at the top of the
card shows the step with the new words (`shots/r6-choice-use-all-my-changes-then-a-step.png`). On round 5's
revision the same keys record `steps ["Open the cart","Apply the coupon SAVE10"]`, and "Use my title" followed
by more words in the title records `"Coupon case mine, second thoughts"`
(`logs/a6-choice-allmine-step.r5-revision.log`, `logs/a6-choice-mine-title.r5-revision.log`).

The variants, each 2 of 2:

| Choice in the card | Typed afterwards in the editor | Recorded | Lost |
| --- | --- | --- | --- |
| Use all my changes | ` SAVE10` in step 2 (not in conflict) | `"Apply the coupon"` | ` SAVE10` |
| Use all my changes | `, second thoughts` in the title | `"Coupon case mine"` | `, second thoughts` |
| Use my title | `, second thoughts` in the title | `"Coupon case mine"` (the card's "Your draft" side reads `Coupon case mine, second thoughts`, its merged field `Coupon case mine`) | `, second thoughts` |
| Use my steps.b2.action (two fields in conflict) | ` AND MORE` in step 2 | `"Apply the coupon MINE"` | ` AND MORE` |
| Keep current version | ` SAVE10` in step 2 | version 2 unchanged, the draft deleted | ` SAVE10` |
| Use current title | `, second thoughts` in the title | `"Coupon case theirs"` (version 2), the draft deleted | the words typed after the choice (the rest of the title was given up by the choice) |

The last two are the weakest: the person did choose the other side, and the authors' test asserts the fifth as
intended ("a whole-body choice deliberately fixes all fields"). But the words in the right-hand column were
typed after that choice, in an editor that stayed open and took them, and they go without a message. The first
four are plainly wrong: the button says "my", and the person's own later text is what is cut.

How wide, said plainly: it needs a conflict card, a choice on the card, then typing in the editor (in the same
field for a one-field choice; anywhere for the two whole-body buttons), then the merge. "Use all my changes",
fix one more word, "Resolve conflict" is an ordinary order. Someone who types first and chooses last, or who
does not type after choosing, is not affected; typing in a field other than the one chosen is recorded. It is
rated a blocker for the reason rounds 4 and 5 gave for R4A-1, R4A-3 and N-1: typed input is dropped without a
message and the UI reports success. If Daniel weighs the order as unusual, the count drops to none.

Promise contradicted: "nothing typed is lost … when another producer changed the same thing"; "no key press is
lost". Smallest fix: store which **side** was chosen (`mine`, `current`, or text typed in the merged field) and
read that side from the card as it is now, so "my" follows the draft; and after the merge keep as a draft
whatever the draft holds that the merge did not record (the "Your later text is kept as a draft." branch of
`onResolved` exists already, but it compares the draft with the conflict's `mine`, which is the draft itself).
A test: "Use all my changes", type in a step, resolve, expect the step's text on the server or in a kept draft.

### R6-2: "Resolve conflict" says "Conflict resolved." when the server answered that the merge met a new conflict; the draft and the card are removed and the text is left in a proposal the page cannot merge

Blocks: **no**, and the lead may weigh it differently. **Not new**: the same on round 5's revision
(`logs/a6-moved-under-card.r5-revision.log`), so it is not caused by the fixes; it turned up under the brief's
"a second conflict on the same case". 5 of 5 (`probes/a/r6.ts moved-under-card "same field"` twice on each
revision, `moved-detail` once; `logs/a6-moved-under-card.log`, `logs/a6-moved-detail.log`,
`shots/r6-moved-under-card.png`).

Reproduction: `e`, type ` mine` in the title; a colleague records `Coupon case theirs`; Escape: the card. The
colleague records the title again, `Coupon case theirs, changed again`. The card does not change (it still
shows `Current version Coupon case theirs`). Press **Use my title**, **Resolve conflict**:

```text
decide Q-3 merge title "Coupon case mine"
reply {"q":"Q-3","status":"decided","effects":{"cases":[],"proposal":"P-5","adopt":"Q-5","status":"conflict"}}
after: status "Conflict resolved. Both earlier versions remain in the timeline.", cards 0, storage [], editor closed
  server {version 3, title "Coupon case theirs, changed again"}
  pane: "Q-5 · daniel Proposed, waiting for a person. Resolves the conflict in P-3 ~ Coupon case theirs, changed againmine … a Accept r Reject"
Q-5: "needs":"the author of the proposal who is not an agent","answers":["merge","reject"]
  accept → "C-1 has an unresolved conflict; its author must resolve it"
```

The page reads only `status: "decided"` and not `effects.status: "conflict"`. Nothing was adopted, the head is
the colleague's second title, and the person's title is in an open proposal for which the page offers `a
Accept` (which the server refuses) and `r Reject` (which discards it). There is no card for Q-5, so the author
cannot give the merge the server asks for. The text is not lost (it is in the proposal, and on the screen in
its diff), which is why this does not block; the statement on the screen is false and the way forward is to
type the title again. Since every leave of an editor records a version, a colleague who goes back to fix a typo
is enough to get here. With N-2's fix a leave under the card no longer proposes afresh, which before would
have given a card against the newer version; the card is now never refreshed.

Promise contradicted: "every optimistic change either becomes the server's record or is rolled back visibly
with the person's input kept". Fix: when the merge's reply carries `effects.status: "conflict"`, keep the
draft and open the card for `effects.adopt` against the current version.

### R6-3: N-2 through a reload: a page reloaded with a conflict card open proposes the draft again, and the first question stays open after the conflict is resolved

Blocks: **no** (nothing is lost; what is left is one proposal somebody has to reject), the grade round 5 gave
N-2. 2 of 2 (`probes/a/r6.ts reload-card reload`, `logs/a6-reload-card.log`); the same shape in round 4's
`dup-tab` after its reload (`logs/a4-dup-tab.{1,2}.log`: Q-3, then Q-4).

The page remembers a case's conflict in memory only. After a reload the draft is back in the editor with no
card; leaving the editor proposes it under a new id, and the server opens a second question. Resolving that one
leaves the first:

```text
propose cmd 5620d260 base 1 … reply "status":"conflict" "question":"Q-4"       (the card; then type, reload)
back: cards 0, editorStep2 "Apply the coupon SAVE10", "Draft, saved on this device"
propose cmd ba1f8f16 base 1 … reply "status":"conflict" "question":"Q-5"       (Escape after the reload)
after resolving: server {version 3, …,"Apply the coupon SAVE10"}, storage [], questions open ["Q-4 open"], proposalCards 1
```

Moving to another case and back does not do this (the card returns, one question). A new tab was not driven;
it starts with the same empty memory. Fix: keep the conflict's question with the stored draft, or look for an
open conflict question of the person's on the case before proposing.

### R6-4: The step-mark half of R5B-1 is not fixed: a mark shown as "Step 2 marked." when Enter is pressed is not sent, when it was pressed before an earlier result on the slot whose reply is slow

Blocks: **no** (round 5 graded R5B-1 the same; the failure, its note and its place are right, the step is
missing). `b/r5-run.ts mark-after-pass` twice and `b/r6-run.ts mark` twice, 4 of 4 with a slow reply:

```text
keys: 2 p (2 f was meant), k, f, "meant to fail at two", Enter; report +1500 ms
atEnter: hint "Step 2 marked. 2 f fails step 2. …", field "meant to fail at two"
requests: C-1:pass, C-1:fail(meant to fail at two) corrects 1          (no step)
```

With a fast reply the hint no longer says "Step 2 marked." at Enter and no step is sent, which is honest. The
fix for the note (Enter sends what is in the field) has no counterpart for the mark: `failedStep` is still
decided by `consumedSteps`, which the pass set. Fix: a mark that is shown when a failure is recorded goes with
it. A mark pressed after the earlier result is sent correctly (`C-1:fail@s3(seen it) corrects 1`).

## The tests do not prove this

Judged by removing one fix at a time in a scratch copy and running the authors' test for it
(`probes/mutate6.py`, `logs/mutations.log`; the unchanged copy first: `12 pass, 1 skip, 0 fail`):

| Fix removed | Authors' test in `test/e2e/round5.test.ts` | Result |
| --- | --- | --- |
| N-1: the card is keyed by the draft's text again (round 5) | `N-1 conflict preserves … choice` (4) | 4 fail (`Expected: "Their title"`, `"Merged by hand"`, `"My title"`) |
| N-1: the choice is plain state again, the card keyed by its question (round 4) | `N-1 …` (4) | 3 fail (`Expected: "Apply the coupon SAVE10"`), `all` passes |
| N-2: a seal under a known conflict proposes again | `N-2 leaving an open conflict sends no extra proposal` | fails (`Expected: 0`) |
| N-3: a new window drops an existing case's stored request (round 5) | `N-3 a new tab recovers …` | fails; `N-3 two live windows …` passes, as it should |
| N-3: a new window **always** keeps the stored request, its owner live or not | `N-3 two live windows never share a pending existing-case request` | **passes** |
| R5B-1: Enter does not pass the field's text (both handlers) | `R5B-1 Enter resends the visible note` (2) | 2 fail (`Expected: "wrong total"`) |
| R5B-1: only the input's own Enter handler | `R5B-1 …` | 2 fail |
| R5B-1: only the key binding's Enter | `R5B-1 …` | 2 pass (the input's handler covers it) |
| R5B-1: a failed request behind a later write does not release the note (round 5) | `R5B-1 … with lost earlier reply` | **passes** |
| R5B-2: undo announces a correction whatever `record` returned | `R5B-2 undo in a closed run …` | fails |
| R5B-3: the open field keeps a question the selection dropped | `R5B-3 bulk reference prunes …` (2) | 2 fail |

So each fix has a test that fails without it, with these gaps:

- **`N-1 … mine choice`** and **`N-1 … all choice`** assert the behaviour of R6-1. The first presses "Use my
  title", types `My title with later words` in the editor and expects the merged title, and the server, to say
  `My title`. The second presses "Keep current version", types in step 2 and expects the step without the new
  words. Both pass because the later words are dropped. The `all` test also passes with round 4's code.
- **`N-3 two live windows never share a pending existing-case request`** passes with the liveness check
  removed. The second window then does send the first window's request first, but the test keeps only the
  **last** command the second window sent and compares that. It proves the outcome (both fields recorded, no
  card), not that the request was not shared. Round 4's `dup-tab` probe shows two ids on this revision.
- The release of a note after a failed request (the second half of the R5B-1 fix) has no test: the
  "lost earlier reply" test passes without it, because Enter now sends the field's text whatever was consumed.
- No test presses a choice and then types in the same field expecting the text to survive (R6-1), changes the
  case a second time under an open card (R6-2), reloads under a card (R6-3), or holds a reply with a step mark
  pressed before it (R6-4).

## Worth doing later

- After a closed tab is reopened and closed again mid-sentence, the second close sends the first tab's stored
  request again (the server answers it as recorded) and not the newer text: `after2 {version 2, title "Coupon
  case for return"}` while the second tab held `… returning cust` (`logs/a6-closed-twice.log`). The text is
  on the device and is recorded when the person comes back, so nothing is lost; for that second close R4C-4's
  promise (a closed tab records its draft) does not hold.
- A failure whose request failed behind a later pass leaves its note on the slot (right), and a later `p` on
  that slot then records `pass(wrong total)`: the note that is shown goes with whatever key is pressed next
  (`logs/b6-enter.{1,2}.log`, `pass-after-failure`). It is what the screen shows; it may not be what is meant.
- With no selection, a reference field open on a question that is answered elsewhere refuses Enter with either
  `This question was settled elsewhere. Your note is kept.` or `Reading this question before answering. Your
  note is kept.`, depending on timing (`logs/b4-inline.1.log` against `.2.log`); nothing is sent either way.
  Old code, round 5's note.
- Escape in the defect reference field still records the defect without a reference (round 4's list; the
  authors' R5B-3 test now asserts it).

## Engine observations (not judged here)

- A merge whose case moved again is answered `status: "decided"` for the question, with the new conflict only
  inside `effects` (`"effects":{"cases":[],"proposal":"P-5","adopt":"Q-5","status":"conflict"}`); the new
  question's answers are `["merge","reject"]` (R6-2). One reproduction: `logs/a6-moved-detail.log`.

## Mistakes in my own method

- `closed-lost "write lost"` first aborted the write with a route on the page; a closing page's last write does
  not pass through it, so that run (`logs/a6-closed-lost.log`, first two lines) is the plain N-3 case. Rerun
  with the browser context offline (`logs/a6-closed-lost-offline.log`), which is the result quoted.
- `r6-run.ts undo closed-then-note` types a sentence after `f` in a closed run; the note field does not open
  there, so the letters went to the key bindings (`s`, `u`). Nothing was sent, which is the result, but it is
  not a test of the note field in a closed run; round 4's `closed-under-note` is.
- `after-resolve` was left out of my first batch and run afterwards; it has one log with two rounds per variant.
- `mutate6.py`'s log does not list the names of passing tests (its pattern does not match Bun's output for
  them); the counts and the failing names are right.
- Headless Chromium never hides a tab. "Two windows" means two pages of one browser context, both visible, and
  "a closed tab" is `page.close({ runBeforeUnload: true })`.

## Not checked

- Anything outside the six findings and their neighbours: this was a bounded re-check. Round 4's and round 5's
  other probes were not re-run (the sessions and persons, the 30 s idle seal, capture, the queue's key orders,
  the strict preset, the dispute evidence).
- R5B-4 (left by the authors, issue #72).
- Step membership choices in the card ("Use your draft step" for an added or removed step, then editing that
  step): read in the code to have the same shape as R6-1, not driven.
- The roll-call between windows answering later than the 40 ms the page waits for it; with N-3's fix a late
  answer would make a new window send a live window's stored request once. Not driven.
- R6-3 in a new tab (only a reload was driven).
- A real "Duplicate tab", a real tab switch or close in a headed browser, session restore, any browser other
  than headless Chromium, mobile widths, screen readers, IME input.
- The non-browser tests other than the architecture test, and the budgets.

## Cleanup

No server or browser of this review is running (nothing listens on 8950 to 8999). `/tmp/casebook-ui-r6`, my
port locks, the scratch copy for the mutations (`mut/`), the export of round 5's revision (`r5tree/`) and
`tree/node_modules` are removed (run `bun install --frozen-lockfile` in `tree/` to rerun a probe; for the
comparison runs, export `9611d61` into `r5tree/` and link its `node_modules` to `tree/`'s). The repository
checkout was read with `git archive`, `git diff` and `git log` only; no release or clean-up command was run
in it, and the `/tmp/casebook-e2e-*` directories of other runs were not touched.

ISSUES (1 blocker)

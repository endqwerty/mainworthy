# Mainworthy web UI: independent verification, round 5, re-check B (the queue and running a suite)

Revision judged: `9611d6136f8486142e26d3835b1e07cd2c03e11c`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's author (GPT 6.1 Sol).

Status: **complete** (see "Not checked"). Nothing in the repository was changed.

## Result in short

All ten round-4 findings in this part are fixed on this revision: each round-4 probe was run twice and gives the
right result both times. Nine are clean. One fix brought a new problem: the fix for R4B-8 (a note must not ride
along on a later result) now also withholds a note the person can see in the field and presses Enter on, when the
first reply is slower than their next keys or the first request failed behind a later one (R5B-1). I do not count
it as a blocker, for the reasons given under it; it is the one place in this part where the reply time still
changes what is recorded. Three smaller defects (R5B-2 to R5B-4) do not block. Fifteen of seventeen mutations
that remove one fix each are caught by the authors' tests in `test/e2e/round4.test.ts`; the two that survive are
named below.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Holds for the queue.** Every round-4 route to a wrong decision is closed, and the neighbours I tried hold
(below). **Holds for the run screen with one exception**, R5B-1: after Enter the screen and the server agree, but
the result that stands lacks the note that was in the field when Enter was pressed.

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, `/usr/bin/chromium` with
  `--headless=new --ozone-platform=headless`, real server processes on 127.0.0.1, ports 8800 to 8849, data under
  `/tmp/mainworthy-ui-r5b`.
- The only files changed in the export are five test helpers (ports moved into 8800..8849, the Chromium flags):
  `test-environment.patch`. No application source and no assertion is changed.
- Round 4's probes copied unchanged into `probes/` (only the screenshot path differs), run from `tree/` as
  `TMPDIR=/tmp/mainworthy-ui-r5b bun ../probes/<name>.ts [scenario]`. First pass in `logs/`, second pass in
  `logs/run2/`. New probes: `probes/r5-queue.ts`, `probes/r5-run.ts` (`logs/r5-*.log`).
- Every probe drives the real UI with trusted key events and reads the server through its API. Slow, failing and
  lost replies are injected at the browser (`page.route`).
- Mutations: `probes/mutate.py` removes one fix at a time in a copy (`mut/tree`) and runs the authors' test for it
  (`logs/mutations.log`).
- One probe was also run against round 4's revision `ec98ba4` (export in `r4tree/`) to tell a new problem from an
  old one (`logs/r4-revision-refail-pace.log`).
- At the end my servers and browsers are stopped and `/tmp/mainworthy-ui-r5b` and `tree/node_modules` are removed;
  run `bun install --frozen-lockfile` in `tree/` to rerun a probe (`mut/tree` and `r4tree` link to it).
- Other reviewers' processes were running on this machine at the same time; no probe result depended on it (every
  timing result was the same on both passes).

## Round-4 findings re-checked

Each finding's probe ran twice on this revision (the two server-only `api-dispute*` reads and my own neighbour probes once, except R5B-1's, which ran twice); both passes gave the lines quoted.

| Finding | Verdict | What ran and the deciding lines |
| --- | --- | --- |
| R4B-1 a failure disputed after it was asked showed no evidence and took every key | **fixed** | `probes/dispute-blind.ts`, `dispute-hint.ts`, `api-dispute.ts`, `api-dispute-evidence.ts`, `new-queue.ts dispute`. The pane now reads `Expected 10 Observed 12 expected 10, got 12 … A counted pass and fail disagree. A decision must settle the dispute.` with `Needs one member who did not produce the evidence who is not an agent.`; `m` by a member who did not produce the failing result records `decided:mistaken by robin`, slot `C-1:satisfied` (one key, with the evidence and the hint on screen). To the producer of the failing result, live and after a reload: `You cannot settle this. Needs one member who did not produce the evidence who is not an agent.`, `"keys":""`, `f` sends nothing (`"decides":[]`). Server: `"message":"expected 10, got 12","sample":1,"hints":["disputed"]`, `"you":"forbidden"`. The UI half, which the engine fix no longer exercises, driven by rewriting the `inbox` reply (`r5-queue.ts evidence`): `message: null, sample: null` is readable (`Expected 3 Observed 0 …`, `"keys":"dtefi"`, `i` records); evidence the page cannot parse gives `The failure evidence could not be read. Refresh to try again.`, `"keys":""`, and `i`, `f`, `t`, Enter and a click each give `The evidence could not be read. Refresh before answering.` with `"decides":[]`; the same when the unreadable question is only selected, not shown. |
| R4B-2 a step digit could not be taken back | **fixed** | `new-run.ts step-mark`, `step-dead`, `step-pass`. `2 3` gives `Step 23 marked.`; Escape: `2 f fails step 2.` (no mark), Backspace the same, `"stored":{}` after a reload; then `f`, note, Enter: `C-1:failing:robin/fail(fails at step three)`. A wrong mark: `try 1: C-1 was not recorded: The pinned case has no step 23. The mark was cleared`, `try 2: C-1 fail recorded`. `2 p` leaves `"stored":{}`, and the later correction is `C-1:fail(Looked again, the total is wrong) corrects 1`, no step. Neighbours (`r5-run.ts marks`, `held`): a mark on C-1 does not go with a failure on C-2 (`C-2:fail(C-2 fails, no step)`) and is still there on return (`Step 2 marked.`); `1 2` quickly is `Step 12 marked.` and records `fail@s12`; `1`, a pause, `1` is `Step 1`; `1` held is `Step 1`. |
| R4B-3 a second `u` was dropped while the first was on its way | **fixed** | `new-queue.ts seq` (15 key-order and delay pairs) and `seq2` (11): all 26 `"verdict":"ok"` on both passes, `0` wrong. `f u i u t` with every call +250 ms and 300 ms between keys, round 4's failing pair: `"server":"decided:test by robin"`, `"decides":["Q-5:flaky","undo Q-5","Q-5:infra","undo Q-5","Q-5:test"]`; the same at 0/0 and +400/150. `f u f u f u`: `open`, six requests, all on Q-5. |
| R4B-4 the reference field followed the person to another question | **fixed** | `new-queue.ts inline-click`, both variants: after the click `"current":"Q-4","fieldOpen":0`, typing and Enter send nothing (`"decides":[]`), `Q-5` stays `open` (or `decided:flaky by robin` where it was answered elsewhere: not overwritten). The reason field under `strict`, not driven in round 4 (`r5-queue.ts strict`): closed by the click, Enter sends nothing, `"stored":["Q-7:flaky:reason=flaky on the runner"]`, offered again on return and recorded as `decided:flaky [flaky on the runner]`. Leaving through the palette or a route change also closes it with the text kept (`r5-queue.ts jump`: `"field":{"open":0}`, `"decides":[]`, `"stored":["Q-5:defect:ref=BUG-1"]`). |
| R4B-5 a selected question settled elsewhere made every answer key dead | **fixed** | `new-queue.ts selected-gone`: no tick is left (`"ticks":["","",""]`), the pane says `Needs one member.`, and `i` answers the question that was read: `"decides":["Q-5:infra"]`, `decided:infra by robin`. The status at the moment it is dropped: `Q-5 removed from the selection because it is no longer listed.` (`logs/r5-queue-bulk-inline-gone.log`). See R5B-3 for the same event with the reference field open. |
| R4B-6 a failed withdrawal could not be retried | **fixed** | `new-queue.ts undo-fail`: `Q-5 is still decided: the withdrawal failed. Failed to fetch Press u to retry.`, the question not listed while the server holds `decided`; `u` again: `Answer withdrawn. Both decisions stay in the ledger.`, `"server":"open"`, `"decides":["undo Q-5","undo Q-5"]`. Three answered at once, the second of three withdrawals failing (`r5-queue.ts bulk-undo-fail`): list and server agree in between (`["open","decided:infra","decided:infra"]`, rows `["Q-6","Q-3"]`), `u` again reopens all three. |
| R4B-7 Enter on a note in a closed run said nothing | **fixed** | `new-run.ts closed-under-note`: `This run is closed. No result was recorded; your note is kept.`, `"statusChanged":true`, the note in the field and on the device, no request. |
| R4B-8 a correction to pass could carry the note of the failure it replaced | **fixed with a new problem** | `new-run.ts orders`: `fail, u, u, p` with `report` +0 and +500 ms both end `C-1:satisfied:robin/pass`, requests `C-1:fail(wrong total)`, `C-1:skip(Withdrawn by the author) corrects 1`, `C-1:pass corrects 2`; all ten order and delay pairs `"verdict":"ok"`, UI reason equal to the server's. The new problem is R5B-1. |
| R4C-2 `u` in the queue was refused under `strict` | **fixed** | `held3.ts undo`: `u` now opens a field (`"field":1`, focus `INPUT#answer-extra`). Driven to the end in `r5-queue.ts strict`, `strict-settled`, `strict-bulk`: label `Reason for withdrawing the answer`; Enter with nothing typed sends nothing; with a reason `"decides":[…,"undo Q-7 [answered the wrong one]"]`, `"server":"open"`, `Answer withdrawn. Both decisions stay in the ledger.` The reason is kept when the person clicks away (`"stored":["Q-7:withdraw:reason=answered the wrong one"]`, `u` still offered, the text back in the field). From Settled, with the request failing: `Q-7 is still decided: the withdrawal failed…`, reason kept, `u` and Enter withdraw it. Three at once: three `undo` requests with the one reason. At 1280x800 the field and its hint are inside the viewport (`shots/strict-withdraw-field.png`). |
| R4C-3 a held key that opens a field typed its repeats into it | **fixed** | `held3.ts open` (one keydown, nine repeats): `c` held `TEXTAREA[Case title]=""`; `e` held: the title unchanged, and `e` held then Escape leaves `v1` at `v1`; run `f` `INPUT[Result note]=""`; runs `n` `INPUT#run-name[]=""`; queue `d` `INPUT#answer-extra[]=""`; settings `n` `INPUT#token-actor[]=""`. The new withdrawal field too: `u` held under `strict` opens it with `"value":""`. (The probe's `/` and `t` lines type into an editor the step before left open, as in round 4; they show nothing.) |

Ordinary journeys, round 4's probes again, once: twenty answers on mixed questions with `decide` held 500 ms
(`queue-d2.ts fast`): `decide requests: 20`, `wrong or missing decisions: []`, `UI open rows: ["Q-8"]`, the four
proposal diffs on screen 23 to 24 ms after their question became current. Keys offered equal the server's list
for 21 seeded questions (`queue-d2.ts offered`: `problems: []`, `decide requests after pressing unlisted keys:
[]`). Ten results in 26 keys with `report` held (`run-b.ts j5`): `report requests: 10`, the UI verdict and tally
equal to the server's, controls 609..772 in an 800 viewport. Twelve failure answers at machine speed with `decide`
+400 ms (`r5-queue.ts fast`): `"wrong":[]`, twelve requests. No uncaught error and no console error in any probe
(`"errors":[]` throughout).

## Defects

None blocks.

### R5B-1: Run: a note that is in the field when Enter is pressed is not sent, when the same text was already sent once and that reply is slow or was lost behind a later result

Blocks: **no**, and it is the closest call in this report. New on this revision: it comes from the fix for R4B-8
(`consumedNotes` in `src/web/runs/cockpit.tsx` marks a note as used when it is sent, not when the server has it,
and the failure handler does not release it when a later write for the slot is already queued).

**(a) A slow reply.** The person fails a case with a note, sees they forgot the step, goes back, marks it and
fails it again: `f`, `wrong total`, Enter, `k`, `2`, `f`, Enter. `probes/r5-run.ts refail-pace`,
`logs/r5-run-refail-pace.log`, 150 ms between keys; also `refail` at 40 ms (`logs/r5-run.log`):

| `report` delay | in the field at the second Enter | request sent | the result that stands |
| --- | --- | --- | --- |
| 300, 500 ms | (empty: the first reply is back and cleared it) | `C-1:fail@s2 corrects 1` | `fail@s2()` |
| 800, 1200 ms | `wrong total` | `C-1:fail@s2 corrects 1` | `fail@s2()`, slot `C-1:failing:robin/fail(no failure message (Run case 1))` |

On `ec98ba4` the same keys at 800 and 1200 ms sent `C-1:fail@s2(wrong total) corrects 1` and ended
`C-1:failing:robin/fail(wrong total)` (`logs/r4-revision-refail-pace.log`). So where the note is on screen, this
revision drops it and round 4's kept it. Afterwards the screen and the server agree (the field is empty, the row
says fail), and the text is still in the ledger on the corrected first result; it is missing from the result that
counts, and the question it raises is titled `no failure message`.

The step mark has the same shape (`r5-run.ts mark-after-pass`, `logs/r5-run-mark-after-pass.log`): `2 p` pressed
where `2 f` was meant, then `k`, `f`, a note, Enter with `report` +1500 ms: the hint reads `Step 2 marked.` when
Enter is pressed and the request is `C-1:fail(meant to fail at two) corrects 1`, no step.

**(b) A failed request.** `f`, `wrong total`, Enter while the request fails after 700 ms, and `u` pressed before
that is known (`r5-run.ts note-after-failed`, twice: `logs/r5-run.log`, `logs/r5-run-note-after-failed-2.log`).
The failure of the first request is never shown; the `u` records `C-1:skip(Withdrawn by the author)` on a slot
that held nothing. The note is still in the field and on the device, which is right. The person presses `f`,
Enter with `"fieldAtEnter":"wrong total"`: the request is `C-1:fail corrects 1`, the server holds
`C-1:failing:robin/fail(no failure message (Run case 1))`, the status says `C-1 fail recorded`, and the note
stays in the field and on the device (`"stored":{"run-note:scratch:R-1:1":"wrong total"}`). Every later Enter
does the same until the text is edited. Here the typed text never reaches the server.

Why not a blocker: (a) needs a write slower than three or four deliberate keys on one slot (600 ms and more at a
person's pace; nothing on loopback), the failure, its step and its place are right, and the text is not lost from
the ledger; (b) needs a failed request and a second key on that slot inside the failure window, and the text is
kept on the device and visible. R4B-8, the finding this is the other side of, was graded the same in round 4. The
lead may weigh it differently: by round 3's standard for R3B-1 (a reply slower than the person's next key) this is
a reply slower than their next four.

Promise contradicted: no key press is lost; nothing typed is lost on a failed request. Smallest fix: decide what
a result carries from what is on screen, not from what was sent: a note (or mark) counts as used only once the
server has it, an explicit Enter in the note field always sends the field's text, and the failure handler
releases the note and the mark whether or not a later write is queued. A test: hold the first `report`, press
`k 2 f Enter`, expect the second request to carry the note.

### R5B-2: Run: `u` in a closed run says the result was corrected, and nothing was sent

Blocks: **no**. Not new (the same code as `ec98ba4`; round 4 listed "a closed run still offers `u correct`" under
worth doing later). `r5-run.ts closed-u`, `logs/r5-run.log`, `shots/closed-u.png`: the person passes C-1, another
person passes C-2, the run closes (`passed: 2 results proven`). `u`: the status reads `The result is corrected to
skipped. A skipped slot counts as no proof.`, `"requests":["C-1:pass"]` (nothing new), the server holds
`C-1:satisfied:robin/pass`, and the rows still say pass. `undo` sets its message after `record` has already said
`This run is closed…`. The statement on screen is false; the list beside it is right. Fix: `undo` says what
`record` returned.

### R5B-3: Queue: two selected, the reference field open, one of the two answered elsewhere: Enter and Escape are both refused with the wrong message, and the keyboard has no way out

Blocks: **no** (nothing wrong is recorded, the text is kept, a click on a row gets out). The neighbour of R4B-5.
`r5-queue.ts bulk-inline-gone`, `logs/r5-queue-bulk-inline-gone.log`: `x j x k d`, `BUG-7`; another person
answers Q-5. The screen says `Q-5 removed from the selection because it is no longer listed.` and `1 selected
questions will receive this answer.`, which is right. Enter: `Reading this question before answering. Your note is
kept.`, `"decides":[]`. Escape: the same line, the field still open. Q-6 is open and readable, so the message is
wrong, and since `j` and `k` are off while the field is open only a click (or the palette) leaves it. Fix: when
the selection drops a question, drop it from the open field's questions too.

### R5B-4: Run: `u` restores an earlier failure without the step it was recorded at

Blocks: **no**. Not new. `r5-run.ts restore-step`: `2 f` with a note (recorded `fail@s2(fails at two)`), `k`,
`p`, `u`: the status says `The earlier outcome is restored by a correction.` and the request is `C-1:fail(fails
at two) corrects 2`: the outcome and note come back, the step does not.

## The tests do not prove this

`bun test test/e2e/round4.test.ts` in the export, once: `0 fail`, `Ran 61 tests across 1 file`
(`logs/authors-round4.log`). The whole suite was not run (the other reviewer).

Mutations, one fix removed at a time (`logs/mutations.log`): **15 of 17 caught.** Caught: R4B-1 nullable message
(1 test fails), R4B-1 unread-evidence guard (5), R4B-2 Escape and Backspace (2), a digit after a pause or a key
(2), the mark cleared by a recorded result (1), cleared on "no such step" (1), two quick digits (1), R4B-3 (1),
R4B-4 with every close removed (6), R4B-5 (1), R4B-6 (1), R4B-7 (1), R4B-8 (1), R4C-2 (1), R4C-3 (6). The tests
for my findings are real: each holds or shapes replies itself and fails for the reported reason.

Not caught:

- **A mark riding along on a later result while a reply is slow** (`consumedSteps` removed: `7 pass, 0 fail`).
  No test holds a `report` and records again on the same slot. The same missing test would have shown R5B-1.
- **The field closing when the cursor leaves by a route the click handlers do not cover** (the effect alone
  removed: `6 pass, 0 fail`). The handlers close it too, so this is a second guard without a test of its own; the
  palette and a route change are the cases only it covers, and they work (`r5-queue.ts jump`).

Also without a test: R5B-1 to R5B-4; a withdrawal of several answers where one fails; a reply that is lost after
the server recorded (below).

## What is left of the lost reply (issue #71), in this part

The queue and the run screen never send a remembered request: every answer, withdrawal and result is built when
it is sent, under a new command id (`randomId()` inside `submit`, `undo` and `record`), and `call` does not retry.
With the server recording and the reply dropped (`r5-queue.ts reply-lost`, `r5-run.ts reply-lost`):

- Queue answer: the last line says only `Failed to fetch`; after the refresh the question is not listed, the
  server holds `decided:defect(BUG-9) by robin`, `u` is not offered (it can be withdrawn from Settled). The
  reference stays on the device (`Q-5:defect:ref=BUG-9`), harmless.
- Queue withdrawal: `Q-5 is still decided: the withdrawal failed…` while the server and the list say open; `u`
  again sends a second `undo`, accepted, `Answer withdrawn.`
- Run result: `C-1 was not recorded: Failed to fetch. Its note is kept. Return to the slot to retry.` while the
  row already shows the failure from the server; the retry sends `C-1:fail@s2(seen once) corrects 1`, so the
  ledger holds the result twice with the same text and step, and the note and mark are then cleared.

No text is lost or misrecorded by this route here. The message is wrong for a moment in all three. The resend of
a draft under the same id is in the other reviewer's part.

## Worth doing later

- `This question was settled elsewhere. Your note is kept.` is shown for the person's own answer: while the
  `strict` withdrawal field is open (`shots/strict-withdraw-field.png`) and after a failed withdrawal.
- An answer that fails on the network after `u` was already pressed leaves `Q-5 · withdrawing the answer` on the
  last line for good; the failure is never named (`r5-queue.ts answer-fail-u`). The question is open on both
  sides and answers normally.
- After a withdrawal of three where one failed, the line reads `Q-6, Q-5, Q-4 is still decided` though Q-6 was
  reopened and is listed.
- `Failed to fetch Press u to retry.` lacks a full stop; a failed queue answer still says only `Failed to fetch`.
- Going back to add a step to a failure already recorded (`k 2 f Enter` on a fast link) records the correction
  with an empty note, because the note was cleared when the first result landed. The field is empty, so the screen
  is honest; the person has to type the note again.
- A step mark is not shared between two tabs on one run (notes are).
- Round 4's list still stands where not named above: Escape in the defect reference field records; `u` on a first
  result records `skip` with `Withdrawn by the author`.

## Engine observations (not judged here)

None new. The engine half of R4B-1 is fixed as far as the UI can see: `inbox` now gives the message, the sample,
`hints:["disputed"]`, and `you` and `needs` for the question as it is now (`logs/api-dispute.log`,
`logs/api-dispute-evidence.log`).

## Mistakes in my own probes

- `r5-queue.ts`'s first run stopped in `strict` because it read a question's timeline, which the server does not
  have for questions (`case Q-7 not found`); the read was changed to `get` and the scenarios rerun. Only the three
  `evidence` lines of `logs/r5-queue.log` count from that first run.
- `evidence`'s "Enter takes the advice" step may not have had advice on the question (the helper's token is
  created in a `catch`): Enter was refused with the same message as the answer keys, which is what a key with no
  binding would not print, but I did not confirm the advice was there.
- `step-dead`'s second try presses `3` again, so it records `fail@s3`; that is the probe, as in round 4.

## Not checked

- The whole browser suite, and the Suite, Case, Changes, Settings and sign-in screens, the duplicated-tab window
  id, the draft resend and the `X-Mainworthy-As` refusal (the other reviewer); I ran only `round4.test.ts`.
- R5B-1 by hand at real network latency: delays and failures were injected at the browser on a loopback server.
- Sign-off answers, the `l` (link) and `merge` answers, a queue longer than one page, a run longer than 200
  slots.
- A finding's suggested-edit read (the authors' "R4B-1 finding answers wait…" tests passed; I did not probe it or
  mutate it).
- 1440x900 and the dark theme for these two screens beyond the two screenshots taken; browsers other than
  Chromium, macOS key repeat, mobile widths, screen readers, IME input.
- Mutations of the server half (the session and event routes).

PASS (no blockers)

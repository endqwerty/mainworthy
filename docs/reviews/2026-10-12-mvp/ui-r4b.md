# Casebook web UI: independent verification, round 4, part B (the queue, running a suite, errors)

Revision judged: `ec98ba41d759e037b2ff7b4b6138f587ee2f15ca`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's author (GPT 6.1 Sol). Round 3's
report says three parts in this scope were written by Claude Opus 5.5, the same model as this reviewer (one
storage key per run-note slot with the `storage` event, the person-keyed device storage, and the rule that an
acknowledgement clears a note only if it is the text that was sent). For those I am not the different-provider
check; they were only run here, and they hold.

Status: **complete** (see "Not checked"). Nothing in the repository was changed.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision, for the queue and the run screen.** All five round-3 findings in this part are
fixed, and the ordinary journeys hold at full key speed against slow writes, as do the round-2 fixes. It fails in
four new places. A failure question whose slot was disputed after it was asked shows no evidence and still takes
every answer key (R4B-1). A wrong step digit in a run cannot be taken back, and the slot can then never be failed
(R4B-2, brought in by the fix for R3B-4). A second `u` on one question is dropped while the first is on its way
(R4B-3, the neighbour of R3B-1). And the reference field follows the person to another question and records on
the one they left (R4B-4).

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, `/usr/bin/chromium` with
  `--headless=new --ozone-platform=headless`, real server processes on 127.0.0.1, ports 8550 to 8599, data under
  `/tmp/casebook-ui-r4b`.
- The only files changed in the export are five test helpers (ports moved into 8550..8599, the Chromium flags):
  `test-environment.patch`. No application source and no assertion is changed.
- Probes in `probes/`, run from `tree/` as `TMPDIR=/tmp/casebook-ui-r4b bun ../probes/<name>.ts [scenario]`;
  output in `logs/`, screenshots in `shots/`. Round 3's, reused unchanged but for the screenshot path:
  `races.ts`, `blind.ts`, `queue-tabs.ts`, `queue-b.ts`, `run-a.ts`, `run-b.ts`, `run-c.ts`, `misc.ts`,
  `extra.ts`. New: `new-queue.ts`, `new-run.ts`, `queue-d2.ts`, `dispute-blind.ts`, `dispute-hint.ts`,
  `api-dispute.ts`, `api-dispute-evidence.ts`, `session-cost.ts`.
- Every probe drives the real UI with trusted key events and reads the server through its API. Slow and failing
  requests are injected at the browser (`page.route`); the outage checks stop the real server process.
- Each blocker was reproduced at least twice. `tree/node_modules` and the `/tmp` data are removed at the end; run
  `bun install --frozen-lockfile` in `tree/` to rerun.

## Round-3 findings in this part, re-checked

| Finding | Result here | Deciding lines |
| --- | --- | --- |
| R3B-1 answer, `u`, answer again before the first reply | **fixed** | `probes/races.ts fuf`, `logs/races-fuf.log`, seven delay/pace pairs (100 to 500 ms on every call, 100 to 1200 ms between keys): every one `"server":"decided:infra"`, `"decides":["Q-5:flaky","undo Q-5","Q-5:infra"]`, last line `Q-5 · Infrastructure · recorded`, Q-5 not listed. Round 3 had `open` in three of six. |
| R3B-2 the object under the key changed when another producer changed the data | **fixed** | Queue, just opened, a failure arrives (`logs/races-arrive.log`, twice): `"decided":["Q-3:test:expected 1, got 0"],"open":["Q-4"]`, the key landed on the question that was read. Queue, the question read is answered elsewhere (`logs/queue-tabs.log`, twice): `"afterTheOtherAnswer":{"current":"Q-4",…}`, `i` sends nothing, `"decided":["Q-4:defect"]`. Run, a note half typed when another person fills the slot (`logs/races-derived-control.log`, `logs/run-derived.log`): stays on C-1, `Filled by person tester`, the field is not disabled, the whole note `The total is wrong by two cents` is kept on the device, Enter records nothing: `This slot is already filled by another producer. Your note is kept.` |
| R3B-3 `u` in a run moved the cursor when the reply arrived | **fixed** | `logs/races-undo-steal.log`, four runs (`report` delayed 400 to 1000 ms): `"shownForF":"C-1","shownForEnter":{"current":"C-1","note":"Wrong total at checkout"}`, server `C-1:failing:fail(Wrong total at checkout)`, `C-2:missing`, nothing left on the device. |
| R3B-4 a failed `2 f` lost its step mark | **fixed** | `logs/races-step-kept.log`: on return `Step 2 marked.`, the retry sends `"steps":[{"step":"b2","outcome":"fail"}]`, recorded `"atStep":"b2"`. |
| R3C-1 in the queue: a key accepted a proposal whose diff had not been read | **fixed** | `probes/blind.ts queue`, `logs/blind-queue.log`. Read delayed 4 s: the pane says `Reading the proposed edits…`, `a` gives `Still reading the proposal. Read its edits before answering.`, question `open`, case `v1`. Read failed: the pane says `read failed`, `a` gives `read failed`, question `open`, case `v1`. |

## Checks

| # | Check | Verdict | What ran and the deciding lines |
| --- | --- | --- | --- |
| 4 | The queue (D2) | **issues** | Round 3's probes on this revision, then new ones. Twenty answers on mixed questions under `standard` at 1280x800 with `decide` held 500 ms, waiting only for each proposal's diff (`probes/queue-d2.ts fast`, `logs/queue-d2-fast.log`): `decide requests: 20`, `wrong or missing decisions: []`, `server open: ["Q-8:map:counts"]`, `UI open rows: ["Q-8"]`, `1 need an answer`; the four diffs were on screen 7 to 29 ms after their question became current. (Round 3's own `fast` probe, which does not wait, now gets 12 of 20: its `a` and `r` on a proposal are refused with `Still reading the proposal`, which is R3C-1's fix working, `logs/queue-fast.log`.) One key with its consequence beside it, none clipped, and the keys enabled equal the server's list for all 21 seeded questions, with nothing sent for an unlisted key (`logs/queue-offered.log`: `problems: []`, `decide requests after pressing unlisted keys: []`). `u` withdraws and both decisions remain (`logs/queue-uu.log`: ledger rows 3 `{"is":"flaky"}` and 4 `{"is":"withdrawn"}`, `"supersedes":3`). Forbidden: `You cannot settle this. Needs one member who is not an agent.`, both buttons off, `"requestsSent":0`. Advice only: `Your answer is advice. Needs one member.`, `"server":"open","advice":1`, `Advice recorded.`, and the person's Enter then records `infra` by `daniel` (`logs/queue-roles.log`). Changed evidence on a stale screen: `The evidence changed. C-1 changed after this proposal was made; redo the proposal on version 2`, the question returns and reads `version 2 → proposed version 3` (`logs/misc-conflict.log`). Bulk: one request `["Q-6:infra","Q-5:infra","Q-4:infra"]`, `u` reopens all three, another kind cannot join (`logs/queue-bulk.log`). Proposal: diff on screen before the key, adopted as `"version":2,"by":"reviewer","kind":"agent"` (`logs/queue-proposal.log`). (a) put back by a failed request, by undo and by a conflict, then answered again: decided and not listed, also after leaving and returning (`logs/queue-again.log`). (b) `f u u`: `"server":"open","rows":["Q-5","Q-4","Q-3"]`, one undo request, a third `u` sends nothing (`logs/queue-uu.log`). (c) see check 5. The Settled view: `u` then an answer at once, right at 0 and 400 ms (`logs/new-queue-settled-u.log`). A reference being typed when the question is settled elsewhere: refused, text kept (`logs/new-queue-inline.log`). **A failure question on a slot disputed now:** `m` is offered as soon as the server lists it, but the evidence and the dispute hint are not shown and who may answer is wrong: **R4B-1**. **Also fails:** R4B-3, R4B-4; R4B-5 and R4B-6 (not blocking). |
| 5 | Running a suite (J5) | **issues** | `logs/run-b-plan.log`: planned through `n` by folder (`C-1,C-2,C-3`), tag (`C-4,C-5`), text (`C-4,C-5`) and commit (`"accepts":{"commit":"abcdef1234567"}`), the count shown matching each. `logs/run-b-j5.log`: ten results in 26 keys with `report` held 500 ms: `report requests: 10`, all on the server, `C-3:failing:fail(total is wrong)` with `"atStep":"b2"`, `C-4:skipped:blocked`, `C-10:skipped:skip`; the node that was next became current (`{"ref":"C-2","probe":"was-next","ready":"true"}`), and with the case reads held 1200 ms and a key every 250 ms all nine cases were on screen when their key was pressed (`logs/new-run-slow-next.log`). At 1280x800: controls 609..772, note 666..701, buttons end at 656, viewport 800. UI verdict and tally equal the server's (`blocked: 1 failure unexplained, 1 question open`, `7 pass · 1 unexplained failures · 4 missing · 2 skipped`), again after `p p b u u s p` (`logs/run-fast-undo.log`) and after five other orders of results and `u` at 0 and 500 ms (`logs/new-run-orders.log`: all `"verdict":"ok"`, `uiReason` equal to `serverReason`). `u` appends a correction (`corrects 1`, the earlier result kept). Slots filled by a pipeline or an agent are shown, skipped and unchanged after every outcome key (`logs/run-b-external.log`, `logs/extra-agent-slot.log`). Two tabs and the acknowledgement rule still hold (`logs/run-two-tabs.log`, `logs/run-ack.log`). 4(c), writes and reads failing: `C-1 was not recorded: Failed to fetch. Its note is kept. Return to the slot to retry.`, dots all `missing`, the note on the slot and the device, the retry records it (`logs/run-reads-fail.log`). **Fails:** `2 f` has no way back from a wrong digit: **R4B-2**; R4B-7 and R4B-8 (not blocking). |
| 10 | Errors | pass | No uncaught error and no console error in any journey above: every probe log that collects them ends `errors: []` (requests the probes themselves abort or refuse are excluded). Server process stopped while typing a case: the text is in the editor, the row says `draft`, the device holds title and step, status `Failed to fetch. Your draft is kept on this device.`, chip `Draft, saved on this device · Private, no version yet`. Stopped while recording a result: `C-1 was not recorded: Failed to fetch. Its note is kept. Return to the slot to retry.`, slot `missing`, `Seen before the server stopped` in the field and on the device (`logs/run-outage.log`, `shots/outage-case.png`, `shots/outage-result.png`). Only the network console errors the stop itself causes (`ERR_CONNECTION_REFUSED`, `ERR_INCOMPLETE_CHUNKED_ENCODING`). |

## Defects

### R4B-1: Queue: a failure whose slot is disputed after the question was asked shows no evidence, no dispute hint and the wrong "who may answer"; every answer key still records

Blocks: **yes**. Nothing here is a race: the person opens the queue after all of it has happened. It is the case
the brief asks to be confirmed ("a failure question shows the answers the server lists for it now, `mistaken`
where a slot disputes it, and who may answer"), and it is the class of R3C-1: a key settles a question whose
evidence is not on screen.

Order of events: a person fails a case in a run that accepts a commit (a failure question is asked); a pipeline
then reports a pass for the same case on that commit, so the slot is `disputed`. The other order (pass first,
then the fail), which round 3 seeded, is fine.

What the queue then shows for that question (`probes/dispute-blind.ts`, `logs/dispute-blind.log`,
`shots/dispute-blind-m.png`; live arrival and after a reload in `probes/dispute-hint.ts`, `logs/dispute-hint.log`,
twice each):

- The evidence pane reads only `The failure evidence could not be read. Refresh to try again.` A reload gives the
  same line. Before the pass the same pane read `Total is wrong on a real device rc4000010000 ·
  commit:rc4000010000 · 1 test shares this cause T-1 Case 1 C-1` (`logs/dispute-hint.log`, `"before"`).
- The dispute hint (`A counted pass and fail disagree. A decision must settle the dispute.`) is not shown, because
  it is drawn inside the evidence that could not be read.
- All seven answers stay enabled, `"keys":"dtefinm"`, under `Needs one member.` One key records:
  `dispute-blind(m)`: `"requests":1,"server":"decided:mistaken by daniel","slot":["C-1:satisfied",…]`, last line
  `Q-3 · The failure was a mistake · recorded`; `dispute-blind(f)`: `"server":"decided:flaky by daniel"`.
  `m` throws out a person's failing result and the slot becomes `satisfied`, decided with nothing on screen but the
  question's title.

Two causes, one on each side:

1. **UI** (`src/web/queue/evidence.tsx`): `FailureEvidence` requires `message: z.string()`. When the parse fails
   the pane prints the line above and the answer keys are left as they were. R3C-1's rule (no answer until the
   evidence has rendered) was applied to proposals only. Smallest fix: accept a null message (show the signature
   text), and treat failure, finding and unlinked evidence that cannot be read like a proposal that has not been
   read: the keys say so and send nothing.
2. **Engine**, for its reviewers (`probes/api-dispute-evidence.ts`, `logs/api-dispute-evidence.log`;
   `probes/api-dispute.ts`, `logs/api-dispute.log`): after the later pass, `inbox` lists the question with
   `"message":null,"sample":null` (asked: `"message":"expected 10, got 12","sample":1`), `hints:["disputed"]` and
   `mistaken` added, the evidence hash unchanged (`7e76b294` before and after), and `you`/`needs` not brought up to
   date: to the person who produced the failing result it says `"you":"counts","needs":"one member"`, while
   `decide` answers `"status":"forbidden","needs":"one member who did not produce the evidence who is not an
   agent"`. In the other order `inbox` says `"you":"forbidden"` with that same clause. So the engine change "held
   to the dispute rule when a slot disputes it now" reached `answers` and `decide`, not `you`, `needs`, the sample
   or the hash.

What the producer of the failing result sees in the UI (`probes/new-queue.ts dispute`,
`logs/new-queue-dispute.log`): `m` appears live (`"enabled":"dtefin"` to `"dtefinm"`), the pane still says `Needs
one member.`, and `f` or `m` comes back with `Answer not recorded. Needs one member who did not produce the
evidence who is not an agent.` The question returns to the list and nothing is recorded: the refusal is honest,
the offer before it was not. The brief's "a forbidden answer is shown as such" does not hold for this question.

Promise contradicted: an answer on changed evidence shows the new evidence; the keys offered and who may answer
are the server's for the question as it is now. No browser test disputes a slot after its question was asked.

### R4B-2: Run: a step digit cannot be taken back, and after a wrong one the slot can no longer be failed from this browser

Blocks: **yes**. Introduced by the fix for R3B-4: the step mark is now kept per slot on the device until a
failure with that step is recorded, and nothing else clears it. On b11d230 it was one value for the screen,
cleared by any move and after any result (`setStep("")` in `move` and `record` of round 3's `cockpit.tsx`), so
`j k` took a wrong digit back.

`probes/new-run.ts step-mark`, `logs/new-run-step-mark.log`, `shots/step-mark-stuck.png`. On a case with three
steps press `2`, then `3` (meaning step 3, not 2):

- `"2 3":{"hint":"Step 23 marked. …","marks":[]}`. Digits only append. Escape, Backspace and Delete leave
  `Step 23 marked.`; `0` makes it `Step 230 marked.`; `j k` and a reload keep it
  (`"stored":{"run-step:scratch:R-1:1":"230"}`).
- `f`, a note, Enter: `C-1 was not recorded: The pinned case has no step 230. Your note is kept.. Its note is kept.
  Return to the slot to retry.` No request is sent (`"requests":[]`), the slot stays `missing`, and the retry the
  message asks for fails the same way every time. There is no key, button or click that clears the mark, so a
  failure, with or without a step, cannot be recorded for that case by this person on this browser
  (`step-dead`, `logs/new-run-step-dead.log`: three tries, one after pressing `3` again, which gives `no step
  233`, and one after a reload, all `C-1:missing`). `b` still records (`C-1:skipped:daniel/blocked(fails at step
  three)`), and leaves the mark `233` on the device.
- The same with one slip: `2` pressed where `3` was meant can only become `23`.
- A mark also outlives the result it was typed for (`step-pass`, `logs/new-run-step-pass.log`): `2 p` records the
  pass and leaves `"run-step:scratch:R-1:1":"2"`; correcting that slot later with `f`, a note, Enter records
  `fail@s2(Looked again, the total is wrong)`: a step the person did not mark for this result (the hint does say
  `Step 2 marked.` on return).

Promise contradicted: check 5's "`2 f` fails at step 2" has no way back from a slip; "rolled back visibly with
the person's input kept" becomes input that can never be recorded. Smallest fix: a digit pressed after a pause (or
after any other key) replaces the mark, Escape or Backspace clears it, the mark is cleared when any result is
recorded for the slot, and "no such step" clears it too. The authors' test for R3B-4 marks a valid step only.

### R4B-3: Queue: a second `u` on one question is dropped while the first withdrawal is still on its way; the next answer key lands on the next question

Blocks: **yes, by the standard round 3 used for R3B-1** (a reply slower than the person's next key); say no if
Casebook is judged for loopback only: with no injected delay it holds from 40 ms between keys and fails only at
machine speed.

`undo` drops any question already in `undoing` (the guard for check 4b, "`u` twice"), and a question stays there
until the first withdrawal and the reads after it are back. An answer given in between is a new answer, and its
`u` is thrown away without a word. `probes/new-queue.ts seq` and `seq2`, `logs/new-queue-seq.log`,
`logs/new-queue-seq2.log`: wrong key, `u`, wrong key again, `u`, right key (`f u i u t`) on Q-5.

| delay on every call | between keys | server at the end | requests | the last key was pressed on |
| --- | --- | --- | --- | --- |
| 0 | 40, 80, 120, 200 ms | Q-5 `test` (right) | `flaky, undo, infra, undo, test` on Q-5 | Q-5 |
| 100 ms | 150, 250, 400 ms | right | | Q-5 |
| 250 ms | 300 ms | **Q-5 `infra`, Q-4 `test`** | `Q-5:flaky`, `undo Q-5`, `Q-5:infra`, `Q-4:test` | **Q-4** |
| 250 ms | 500, 800, 1200 ms | right | | Q-5 |
| 400 ms | 150 ms | **Q-5 `infra`, Q-4 `test`** | `Q-5:flaky`, `Q-4:test`, `undo Q-5`, `Q-5:infra` | **Q-4** |
| 0 | 0 (machine speed) | **Q-5 `infra`, Q-4 `test`** | | **Q-4** |

`f u i u` alone ends `decided:infra` where the person asked for open; `f u f u f u` ends with Q-5 `decided:flaky`
and the third `f` recorded on Q-4 and then withdrawn. The screen agrees with the server each time (Q-5 is not
listed, `Q-5 · Infrastructure · recorded`, `u undo` still offered), so this is a lost key and a key on a question
the person did not mean, not a screen that lies. `f u u i` and `f u i` are right at every pace.

Promise contradicted: no key press is lost; the author's "requests about one question go out in the order the
keys were pressed" holds for answers and not for the second `u`. Smallest fix: let `undoing` name the answer being
withdrawn (its action number), not the question, and queue a `u` for a newer answer behind it.

### R4B-4: Queue: the reference (or reason) field stays open when another question is clicked; Enter records the answer on the question that is no longer shown, and over an answer given elsewhere

Blocks: **yes**. No delay and no other producer is needed; it needs one click while the field is open (`j` and
`k` are off while it is).

`probes/new-queue.ts inline-click`, `logs/new-queue-inline-click.log`, `shots/inline-click-plain.png`. On Q-5 press
`d` (the field `Defect reference, optional` opens), type `BUG-1`, click Q-4 in the list. The pane now shows Q-4
(`expected 2, got 0`, its evidence, its answers greyed) with the same field under it, still holding `BUG-1`, and
nothing naming Q-5. Type `23`, Enter:

`"shownWhenEnterWasPressed":{"current":"Q-4","title":"expected 2, got 0","fieldOpen":1,"field":"BUG-1",…}`,
`"decides":["Q-5:defect"]`, `"server":{"Q-5":"decided:defect(BUG-123) by daniel","Q-4":"open"}`.

Second run of the same probe: Q-5 is first answered elsewhere (`flaky`) while the field is open. On Q-5 the pane
says `This question was settled elsewhere. Your note is kept.` and Enter is refused, as it should be. After a click
on Q-4 the same Enter is sent: `"decides":["Q-5:defect"]`, `Q-5 decided:defect(BUG-123)`, replacing the answer
given elsewhere. The guard asks whether the question on screen is settled, not the question the field belongs to.

It is also the only way out of a `d` pressed by mistake that does not record something: Escape in this field
records the defect without a reference (round 3, "worth doing later"), so clicking away is what a person does.
By the source the `Reason required by policy` field under `strict` is the same state and behaves the same, and so
does a click on Open, Settled or a kind tab (they move the cursor and leave the field); I drove only the two runs
above.

Promise contradicted: no key press is applied to a different object than the one shown. Smallest fix: the field
belongs to its question: close it (keeping the text on the device, as now) when the cursor leaves that question,
and test `settled` against the field's own entries.

## Defects that do not block

### R4B-5: Queue: with a selected question settled elsewhere, answer keys do nothing and say nothing

`probes/new-queue.ts selected-gone`, `logs/new-queue-selected-gone.log` and `-2.log` (twice). Select one question
with `x`; somebody else answers it; move to another question and press `i`. The pane says `1 selected questions
will receive this answer.` with no tick on any row; the key sends nothing (`"decides":[]`), the status and last
line do not change, and it stays that way for every answer key on every question until a tab is clicked or the
page is reloaded (or `x` is pressed on the question read, which then is answered alone under "2 selected").
Nothing wrong is recorded. Contradicts "no key press is lost". Fix: drop from the selection what is no longer
listed, and say so.

### R4B-6: Queue: a withdrawal that fails cannot be retried with `u`, and the message does not say what failed

`probes/new-queue.ts undo-fail`, `logs/new-queue-undo-fail.log`. `f` (recorded), `u` while the request fails: the
question is put back, then removed again; the last line is only `Failed to fetch`; the pane keeps Q-5 with all
answers off under `This question was settled elsewhere. Your note is kept.` (it was settled here). `u` again does
nothing (`"decides":["undo Q-5"]` only): the answer can now be withdrawn only from Settled. The list agrees with
the server (`decided:flaky`). Fix: say `Q-5 is still decided: the withdrawal failed`, and keep `u`.

### R4B-7: Run: Enter on a note does nothing and says nothing once the run has closed

`probes/new-run.ts closed-under-note`, `logs/new-run-closed-under-note.log`. Two slots; the person passes C-1 and
is typing a failure note on C-2 when another person passes C-2 and the run closes by rule (`passed: 2 results
proven`). The screen stays on C-2 with `Filled by person tester` and the whole note in the field and on the
device, which is right; Enter then changes nothing at all (`"statusChanged":false`, no request). With the run
still open the same Enter says `This slot is already filled by another producer. Your note is kept.`
(`logs/run-derived.log`); `record()` returns before that message when the run is not open. The note for a closed
run then stays on the device for good.

### R4B-8: Run: a correction to pass can carry the note of the failure it replaces, depending on reply time

`probes/new-run.ts orders`, `logs/new-run-orders.log`: `f`, `wrong total`, Enter, `u`, `u`, `p` on one slot. With
no delay the server ends `C-1:satisfied:daniel/pass`; with `report` delayed 500 ms it ends
`C-1:satisfied:daniel/pass(wrong total)`, because the note is still on the device until the first reply. Both
screens match their server. Every other order tried ends the same at both speeds.

## The session check before a write (R3-1, R3-2), as it shows in this part

- **What it costs** (`probes/session-cost.ts`, `logs/session-cost.log`): every answer and every result is two
  requests in a row, `GET session` then the write. On loopback a key reaches `recorded` in 40 to 110 ms; with
  200 ms on every request it takes about 800 ms, 200 of them the check. Corrections on one object queue behind
  each other, so `f u i` is six requests end to end.
- **It stops a change of person made before the key** (`logs/new-queue-person.log`, `logs/new-run-person.log`):
  only `GET session` is sent, nothing is recorded, the sign-in page is shown, and the run note stays on the
  device.
- **It cannot stop a change between the check and the write.** The server binds a write to whatever cookie
  arrives with it. With the cookie replaced after the check was answered and before the write left the browser:
  queue `"server":"decided:flaky by mallory"`, run `C-1:failing:mallory/fail(Typed by the first person)`, while
  the screen still shows `daniel` and says `recorded`. The window is as long as the check takes to come back (a
  millisecond on loopback, a round trip on a real link), and a second tab has to sign in as somebody else inside
  it, so I do not count it as a blocker. Closing it needs the server: the write names the person it is for and is
  refused when the session is somebody else's. My probe opens the window by pausing the write in the browser;
  it does not show how often it happens by hand.

## The tests do not prove this

Authors' files for this part, one run each of `bun test test/e2e/<file>` (`logs/authors-*.log`):
`triage.test.ts` `8 pass, 0 fail`; `execution.test.ts` `7 pass, 0 fail`; `recovery.test.ts` `12 pass, 0 fail`;
`followups.test.ts` `7 pass, 0 fail`; `round3-interactions.test.ts` `21 pass, 0 fail`. The whole suite was not run
(reviewer A). The round-3 tests for R3B-1 to R3B-4 exist, hold their replies with a latch, and are real. Gaps:

- No test disputes a slot after its failure question was asked, or gives the queue failure evidence with a null
  message (R4B-1). Round 3's and the authors' disputed questions are all seeded pass first.
- "R3B-4 a failed step-two failure keeps its step for the retry and reload" marks a valid step once. Nothing
  presses a second digit, a digit and then another outcome, or tries to clear a mark (R4B-2).
- "R3B-1 answer, undo, answer waits for the undo…" stops at the third key. Nothing presses `u` a second time
  while the first withdrawal is on its way (R4B-3).
- No test moves the cursor with the reference or reason field open (R4B-4), settles a selected question elsewhere
  (R4B-5), fails a withdrawal (R4B-6), or closes a run under a note (R4B-7).

## Worth doing later

- The round-3 list still stands on this revision: a failed queue answer says only `Failed to fetch`; a proposal
  whose case changed in the same field cannot be accepted from the queue (`a` returns the same conflict each
  time, `logs/misc-conflict.log`); Escape in the defect reference field records; `u` on a first result records
  `skip` with `Withdrawn by the author`, so the header says `2 left` beside the server's `4 missing`; a closed run
  still offers `u correct` and says `Recording again corrects your earlier result.` (`logs/misc-signoff.log`).
- A failed result's status line doubles its ending: `…has no step 230. Your note is kept.. Its note is kept.`
- A question settled by this person's own failed withdrawal is described as `settled elsewhere`.
- Walking a queue faster than a proposal's diff arrives now costs a refused key on each proposal. That is the
  right trade; a slow link will make it felt.

## Engine observations (not judged here)

- The dispute case in R4B-1, cause 2: `inbox` gives `message: null`, `sample: null`, an unchanged evidence hash
  and a stale `you` and `needs` for a failure question whose slot was disputed after it was asked, while `decide`
  holds it to the dispute clause. Reproduction: `probes/api-dispute.ts`, `probes/api-dispute-evidence.ts`.
- As in round 3: `decide` on a question that is already decided, with another answer and the same evidence hash,
  writes a new decision (seen again in R4B-4's second run, where it replaced an answer given elsewhere); the run
  tally counts a skipped or blocked slot under both `skipped` and `missing`.

## Mistakes in my own probes

- `probes/new-queue.ts evidence-under` meant to change the evidence under the cursor; the second failure made a
  new question instead (`logs/new-queue-evidence-under.log`), so it shows nothing about changed evidence. The
  stale-screen conflict (`logs/misc-conflict.log`) is the check that counts.
- `inline`'s last step typed a `d` into the still-open field (`"offeredAgain":"BUG-1234d"`); the lines before it
  are the result.
- `person(before the key)` in the queue reports `"ms":64022`: that is the probe waiting for parts of a page that
  had been replaced by the sign-in form, not the UI.
- `step-kept` reports `"stepsMarkedOnReturn":2`: the mark is drawn on the current case and on the hidden,
  pre-rendered next one. One is visible.

## Not checked

- Sign-off answers in the queue: under `standard` a self-accepting run closes by rule and raises no sign-off
  question (`logs/misc-signoff.log`), as in round 3.
- The `l` (link through the case picker) and `merge` answers, unlinked tests decided by rules, a queue longer
  than one page (100), a run longer than 200 slots, a case with ten or more steps (two-digit marks).
- The `strict` reason field for R4B-4: read in the source (the same `inline` state), not driven.
- How often the session window of the section above is hit by hand; real network latency (delays and failures
  were injected at the browser, on a loopback server).
- The whole browser suite, and the Suite, Case, Changes, Settings and sign-in screens (parts A and C).
- 1440x900 and the dark theme for these two screens beyond the screenshots taken; browsers other than Chromium,
  Cmd on macOS, mobile widths, screen readers, IME input.

ISSUES (4 blockers)

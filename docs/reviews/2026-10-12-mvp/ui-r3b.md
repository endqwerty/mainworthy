# Mainworthy web UI: independent verification, round 3, part B (the queue, running a suite, errors)

Revision judged: `b11d2307959bd1ea7f5edea6351cd5cc7bbf077f`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's main authors (GPT 6.1 Sol).
Three parts in my scope were written by Claude Opus 5.5, the same model as this reviewer: one storage key per
run-note slot with the `storage` event, the person-keyed device storage, and the rule that an acknowledgement
clears a note only if it is the text that was sent (`src/web/runs/cockpit.tsx`, `src/web/lib/device.ts`). For
those I am not the different-provider check; they are judged here only by running them (they hold).

Status: complete. Nothing in the repository was changed.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision, for the queue and the run screen.** Every round-2 finding in my part is fixed, and
the ordinary journeys hold at full key speed against slow writes. It still fails in three places, all of the
shape round 2 found: the object under the next key changes without the person doing anything. An undo that waits
for a slow reply withdraws the answer given after it (R3B-1); a question or slot that another producer changes
takes the place of the one being read, and the next key lands on it (R3B-2); and `u` in a run moves the cursor
when the reply arrives, in the middle of a note (R3B-3).

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium` with
  `--headless=new --ozone-platform=headless`, real server processes on 127.0.0.1, ports 8350 to 8399, data under
  `/tmp/mainworthy-ui-r3b`.
- The only files changed in the export are five test helpers (ports moved into 8350..8399, the Chromium flags):
  `test-environment.patch`. No application source and no assertion is changed.
- Every probe drives the real UI with trusted key events and reads the server through its API (the decision rows
  for "both decisions remain" are read from the server's database file, read-only). Slow and failing requests are
  injected at the browser (`page.route`); the outage checks stop the real server process.
- Probes: `probes/` (run from `tree/` as `TMPDIR=/tmp/mainworthy-ui-r3b bun ../probes/<name>.ts [scenario]`), output
  in `logs/`, screenshots in `shots/`. Round-2 probes reused: `queue-a.ts`, `queue-steal.ts`, `run-a.ts`,
  `run-b.ts`, `extra.ts`. New: `queue-b.ts`, `run-c.ts`, `races.ts`, `misc.ts`, `queue-tabs.ts`, `api-already.ts`.
- The repository checkout was read with `git archive` only. At the end of this review its working tree held
  uncommitted engine changes by other agents (`src/server/evidence/evidence.ts`, `src/server/ops/writes.ts`,
  `src/server/runs/runs.ts`, `test/integrity.test.ts`, `test/sequences-extended.test.ts`); none is mine and none
  is part of what was judged, which is the committed revision above.
- Each blocker was reproduced at least twice, with a control that shows the same keys working when the trigger
  is absent. `tree/node_modules` is removed at the end; run `bun install --frozen-lockfile` in `tree/` to rerun.

## Round-2 findings in this part, re-checked

| Finding | Result here | Deciding lines |
| --- | --- | --- |
| R2-1 a late failure moved the run cursor while a note was typed | **fixed, with a new problem beside it (R3B-3, R3B-2)** | `logs/run-a.log` `steal(f)` and `steal(p)`: before Enter `"current":"C-2","note":"Second note typed at a walk"`, status `C-1 was not recorded: Failed to fetch. Its note is kept. Return to the slot to retry.`; server `C-1 missing`, `C-2 failing, fills ["fail:Second note typed at a walk"]`. The authors' test for it (`recovery.test.ts`, "a late fail/pass result failure keeps the next slot's note, cursor and caret") is real and passes. |
| R2-2 a late failure moved the queue cursor | **fixed, with new problems beside it (R3B-1, R3B-2)** | `logs/queue-steal.log`, twice: `"shownAfterI":"Q-4","shownWhenTWasPressed":"Q-4","requests":["Q-3:infra","Q-4:track"],"serverFailure":"open","serverMap":{"is":"track"}`. The authors' test (`followups.test.ts`, "a late queue … refusal keeps the next question selected") passes. |
| R2-7 a reason or defect reference typed in the queue was lost | **fixed** | `logs/queue-reason.log`. strict: after a reload `"restoredAfterReload":"Known flaky on the s"`; after a failed request and returning to the question `"offeredAgain":"Known flaky on the staging runner, see BUG-77"`; recorded with that reason; `"storageLeft":[]`. standard: `"offeredAgain":"BUG-1234"`, recorded `{"is":"defect","ref":"BUG-1234"}`. |
| Astra R2-1 two tabs overwrote each other's run notes (fix by Claude Opus 5.5) | **fixed** | `logs/run-two-tabs.log`, twice: `"before":"Tab A new first-slot note","after":"Tab A new first-slot note","afterSlot2":"Tab B new second-slot note"`; each tab shows the other's note live; a note both tabs typed into is recorded whole (`fail(A writes slot three and B adds)`) and is cleared in the other tab. |
| Astra R2-4 an acknowledgement deleted a newer note (fix by Claude Opus 5.5) | **fixed** | `logs/run-ack.log`, twice: after the first request is released `"note":"New unsubmitted second note","stored":{"R-1:1":"New unsubmitted second note"}`; recording it then clears it (`"stored":{}`). |
| Answers offered are the server's list; `inherited`, `mistaken`, the base hint | **holds** | `logs/queue-offered.log`, 21 questions: for every one `enabled` equals `server`. `Q-9 … enabled=[dtefin] … hints=["The same cause also fails on the base of this change."]` (the only question with `n`); `Q-12 … enabled=[dtefim] … hints=["A counted pass and fail disagree. A decision must settle the dispute."]` (the only one with `m`); the five session failures `[dtefi]`. Every key the server does not list was pressed on every question: `decide requests after pressing unlisted keys: []`, `server still open: 21`. The base comparison is a tinted hint line under the evidence, not an answer and not preselected (`shots/queue-offered-Q-9.png`). |

## Checks

| # | Check | Verdict | What ran and the deciding lines |
| --- | --- | --- | --- |
| 4 | The queue (D2) | **issues** | Twenty answers on mixed questions (failures of a session, of a change with a failing base, of a disputed slot; proposals; findings; unlinked tests) under `standard`, at 1280x800, `decide` delayed 500 ms, no waiting between keys (`logs/queue-fast.log`): `keys: 20`, `decide requests: 20`, `wrong or missing decisions: []`, `server open: ["Q-8:map:counts"]`, `UI open rows: ["Q-8"]`, `1 need an answer`. Each key has its consequence beside it and no answer card is clipped (`logs/queue-offered.log`: `problems: []`). Keys offered equal the server's list (table above). `u` withdraws and both decisions remain (`logs/queue-uu.log`: decision row 3 `{"is":"flaky"}` and row 4 `{"is":"withdrawn"}`, `"supersedes":3`). Forbidden: `"needs":"You cannot settle this. Needs one member who is not an agent.","disabled":[true,true],"requestsSent":0`, question open, case still version 1. Advice only: `"needs":"Your answer is advice. Needs one member."`, one request, `"server":"open","advice":1`, `Advice recorded. Needs one member who is not an agent.`; the person then sees `reviewer suggests infra` and Enter records `infra` by `daniel` (`logs/queue-roles.log`). Changed evidence, with the screen made stale (`logs/misc-conflict.log`): `The evidence changed. C-1 changed after this proposal was made; redo the proposal on version 2`, the question returns, the cursor stays, and the evidence then reads `version 2 → proposed version 3 ~ My own → Agent retitles`; a change in another field is rebased and adopted as version 3 with both edits. Bulk: `"requests":1,"entries":[["Q-6:infra","Q-5:infra","Q-4:infra"]]`, `u` reopens all three; a question of another kind cannot join (`logs/queue-bulk.log`). Proposal: the diff is on screen before the key (`version 1 → proposed version 2 … + Open the checkout page > The total is shown − Open the page > Ready`), and the adopted version is `"version":2,"by":"reviewer","kind":"agent"` (`logs/queue-proposal.log`). (a) put back by a failed request, returned to and answered again: `"server":"decided","rows":["Q-4","Q-3","Q-6"]`; put back by undo and answered again: decided, not listed; nothing reappears after leaving and returning (`logs/queue-again.log`). (b) `f u u`: `"server":"open","rows":["Q-5","Q-4","Q-3"]`, one undo request, a third `u` sends nothing. (c) see check 5. **Fails:** R3B-1, R3B-2. |
| 5 | Running a suite (J5) | **issues** | `logs/run-b.log`. Planned through `n` by folder (`C-1,C-2,C-3`), tag (`C-4,C-5`), text (`C-4,C-5`) and commit (`accepts {"commit":"abcdef1234567"}`), the count shown matching each. Ten results in 26 keys with `report` delayed 500 ms: 10 requests, all on the server, `C-3:failing:fail(total is wrong)` with `"atStep":"b2"`, `C-4:skipped:blocked`, `C-10:skipped:skip`. The node that was next became current (`{"ref":"C-2","probe":"was-next","ready":"true"}`). At 1280x800: controls 609..772, note 666..701, buttons end at 656, viewport 800 (`shots/run-j5-1280.png`). UI verdict and tally equal the server's (`blocked: 1 failure unexplained, 1 question open`, `7 pass · 1 unexplained failures · 4 missing · 2 skipped`); again after `p p b u u s p` (`logs/run-fast-undo.log`). `u` appends a correction (`"corrects":3`, a new result, the earlier one kept). Slots filled by a pipeline or an agent are shown, skipped by the cursor and unchanged after every outcome key (`logs/run-b.log` `external`, `logs/extra-agent-slot.log`). 4(c), writes and reads failing: `C-1 was not recorded: Failed to fetch. Its note is kept. Return to the slot to retry.`, dots all `missing`, note kept on the slot and on the device, the retry records it (`logs/run-reads-fail.log`). **Fails:** R3B-2, R3B-3; R3B-4 (not blocking). |
| 10 | Errors | pass | No uncaught error and no console error in any journey above (`errors: []` in every log; aborted and refused requests that the probes themselves caused are excluded). Server process stopped while typing a case: the text is in the editor, the row says `draft`, the device holds title and step, status `Failed to fetch. Your draft is kept on this device.`, chip `Draft, saved on this device · Private, no version yet`. Stopped while recording a result: `C-1 was not recorded: Failed to fetch. Its note is kept. Return to the slot to retry.`, slot `missing`, note `Seen before the server stopped` in the field and on the device (`logs/run-outage.log`, `shots/outage-case.png`, `shots/outage-result.png`). Only network console errors (`ERR_CONNECTION_REFUSED`, `ERR_INCOMPLETE_CHUNKED_ENCODING`), which the stop itself causes. |
| - | Authors' tests for this part | pass, with gaps | One run each of `bun test test/e2e/<file>`: `triage.test.ts` `8 pass, 0 fail`; `execution.test.ts` `7 pass, 0 fail`; `recovery.test.ts` `12 pass, 0 fail`; `followups.test.ts` `7 pass, 0 fail` (`logs/authors-*.log`). The whole suite was not run (reviewer A). Gaps below. |

## Defects

### R3B-1: Queue: answer, `u`, answer again before the first reply is back: the undo withdraws the second answer; the screen says "recorded" and the question is open

Blocks: **yes**. It needs a reply slower than the person's next key. If Mainworthy is judged for loopback use only it
needs keys under about 100 ms apart, and then it is arguable.

`undo` waits for the first answer's reply before sending its request (`if (prior && !(await prior.confirmed))` in
`src/web/queue/index.tsx`); the answer given after `u` is sent at once. The server receives answer, answer, undo,
and withdraws the second decision. The server accepts a second answer on a decided question as a new decision
(`logs/api-already.log`), so nothing refuses the sequence.

Reproduction (`probes/races.ts fuf`, `logs/races-fuf.log`; every API call delayed, a pause between the keys):
on a failure question press `f` (Flaky), `u`, `i` (Infrastructure).

| delay on every call | between keys | server at the end | requests |
| --- | --- | --- | --- |
| 100 ms | 100 ms | **open** | `Q-5:flaky`, `Q-5:infra`, `undo Q-5` |
| 100 ms | 250 ms | decided: infra | `Q-5:flaky`, `undo Q-5`, `Q-5:infra` |
| 250 ms | 200 ms | **open** | `Q-5:flaky`, `Q-5:infra`, `undo Q-5` |
| 250 ms | 400 ms | decided: infra | |
| 500 ms | 400 ms | **open** | |
| 500 ms | 1200 ms | decided: infra | |

With no delay at all it fails when the three keys follow each other at once and holds at 150 ms
(`logs/queue-fuf.log`). At the end the list shows Q-5 open again, the cursor is on the next question, and the last
line reads `Q-5 · Infrastructure · recorded` with `u undo` beside it (`shots/queue-fuf-250-200.png`).

Wrong key, `u`, right key is what `u` is for. Promise contradicted: no key press is lost; a change that does not
become the server's record is rolled back visibly. The authors' test "an answer after undo leaves once…" waits for
the server after each key.

Smallest fix: send the decide calls for one question in order (the new answer waits for the pending undo).

### R3B-2: The object under the key changes when another producer changes the data: the next key lands on a question or slot the person has not read

Blocks: **yes** (the class of round 2's R2-1 and R2-2; the trigger is another producer, which the brief names).

Both screens derive the current object: `items.find(cursor) ?? items[0]` in `src/web/queue/index.tsx`,
`slots.find(cursor) ?? slots.find(missing) ?? slots[0]` in `src/web/runs/cockpit.tsx`. The cursor is null until the
first `j`, `k`, click or answer, and in the queue a question that leaves the list frees it again.

1. **Queue, just opened** (`probes/races.ts arrive`, `logs/races-arrive.log`, twice). Open the Queue (`g q`): Q-3
   "expected 1, got 0" is shown. A new failure is reported. 14 to 17 ms later the pane shows Q-4 "expected 2, got 0";
   `t`, pressed 3 to 9 ms after that, records "The test is wrong" on Q-4: `"decided":["Q-4:test:expected 2, got 0"],"open":["Q-3"]`.
   Controls: after one `j k`, or with the question's own URL, the same keys answer Q-3.
2. **Queue, the question being read is answered elsewhere** (`probes/queue-tabs.ts`, `logs/queue-tabs.log`, twice).
   With the cursor set on Q-4 by `j`, another tab or person answers Q-4. The pane switches to Q-5, the first row,
   with no message; `i` records Infrastructure on Q-5: `"reading":"Q-4 …","afterTheOtherAnswer":{"current":"Q-5",…},"decided":["Q-5:infra","Q-4:defect"]`.
3. **Run, just opened or reloaded, a key** (`probes/run-c.ts derived`, `logs/run-derived.log`). The run opens on
   C-1; another producer fills C-1; the pane switches to C-2; `p` records a pass on C-2:
   `"first":"C-1","shownWhenPPressed":"C-2","server":["C-1:satisfied:tester/pass","C-2:satisfied:daniel/pass",…]`.
4. **Run, just opened, a note.** `f`, type `The total is wr`, the other producer fills C-1, type `ong by two cents`,
   Enter. The field empties in the middle of the sentence, the rest goes to C-2's note, and Enter records on C-1
   while C-2 is shown: `"server":["C-1:disputed:tester/pass+daniel/fail(The total is wr)","C-2:missing:"]`,
   device `{"R-1:2":"ong by two cents"}`.

Related, with the run cursor set by a click (`logs/races-derived-control.log`): the screen stays on C-1 and says
`Filled by person tester`, which is right, but the note field is disabled in the middle of the sentence. The keys
typed after that are dropped, and Enter still records the first half (`daniel/fail(The total is wr)`).

A wrong answer here can excuse a failure nobody read, or record a pass for a case nobody ran. `u` withdraws it if
the person notices. Promise contradicted: no key applied to a different object than the one shown; nothing typed
is lost when another producer changed the same thing. No browser test changes the data under a cursor.

Smallest fix: set the cursor to the object first shown; when the object under the cursor is settled by someone
else, keep it on screen marked as settled (as the run screen does for a filled slot) instead of switching.

### R3B-3: Run: `u` moves the cursor when the reply arrives; a note typed meanwhile is split and Enter records on a slot that is not shown

Blocks: **yes** (R2-1 again, through undo; needs a slow reply).

`undo` waits for the pending result and then calls `setCursor(last.slot.id)` (`src/web/runs/cockpit.tsx`). Until
then the screen stays on the next slot, so `f` opens that slot's note; when the reply arrives the field becomes the
earlier slot's, while `noting` still names the other.

Reproduction (`probes/races.ts undo-steal`, `logs/races-undo-steal.log`, four runs): `p` on C-1 (a mistake), `u`,
`f`, type `Wrong total at checkout`, Enter.

| `report` delayed | typing | between `p u f` | server | left on the device |
| --- | --- | --- | --- | --- |
| 600 ms | 60 ms a key | 0 | `C-1 skip(Withdrawn by the author)`, `C-2 fail(Wrong tota)` | `C-1: "l at checkout"` |
| 400 ms | 120 ms a key | 150 ms | `C-1 skip(…)`, `C-2 fail(W)` | `C-1: "rong total at checkout"` |
| 1000 ms | 120 ms a key | 300 ms | `C-1 skip(…)`, `C-2 fail(Wron)` | `C-1: "g total at checkout"` |

Before Enter the screen shows C-1 with the tail of the note; the failure is recorded on C-2 with its head
(`shots/run-undo-steal-600.png`). With no delay the same keys give `C-1 fail(Wrong total at checkout)`
(`logs/run-undo-steal.log`).

Promise contradicted: no key applied to another object; the person's input kept. The authors' late-failure test
covers a failed request, not `u`.

Smallest fix: move the cursor when `u` is pressed, not when the reply arrives; never move it from a reply.

### R3B-4: A failed `2 f` loses the step mark; the retry records the failure without its step

Blocks: no.

`probes/races.ts step-kept`, `logs/races-step-kept.log`. `2`, `f`, `fails at step two`, Enter while the request
fails. The note is kept; the step is not: back on the slot `"stepsMarkedOnReturn":0`, and `f` Enter sends
`{"outcome":"fail","note":"fails at step two"}` with no `steps`, recorded with `"atStep":null`. The first request
had `"steps":[{"step":"b2","outcome":"fail"}]`. The status line says only that the note is kept.

## The tests do not prove this

- "an answer after undo leaves once, and repeated undo cannot hide the reopened question" (`triage.test.ts`) waits
  for the server after every key, so it cannot see R3B-1.
- No browser test changes the data under a cursor that the person has not moved, or settles the question being
  read from elsewhere (R3B-2). "pipeline and agent slots fill a commit run and the cursor skips them" fills the
  slots before the page opens.
- "a late fail/pass result failure keeps the next slot's note, cursor and caret" proves R2-1 for a failed request.
  Nothing presses `u` while a result is pending and then types (R3B-3).
- "a queue reason / defect reference survives a failed answer and reload" clicks back to the question after the
  failure, so it would also pass if the cursor had moved; the cursor rule is proven by the follow-up test instead.
- D2 now holds every `decide` while the twenty keys are pressed, and the two-tab and acknowledgement tests are
  real: these three round-2 gaps are closed.

## Worth doing later

- A failed queue answer says only `Failed to fetch`. Say which question was not recorded and that the reason is
  kept, as the run screen now does. The question returns at the top of the list while the cursor is elsewhere.
- A proposal whose case changed in the same field cannot be accepted from the queue: each `a` returns
  `redo the proposal on version 2` with the same evidence hash, and `a Accept` stays offered (`logs/misc-conflict.log`).
- In the defect reference field Escape records the answer without a reference; there is no way to back out but `u`.
- `u` on a first result records `skip` with the note `Withdrawn by the author`; the slot is then "skipped", not
  empty, and the header says `2 left` beside the server's `4 missing`.
- After a reload the reason field is not reopened; the text comes back when the same answer key is pressed.
- A run that is closed still offers `u correct` in its footer.

## Engine observations (not judged here)

- `decide` on a question that is already decided, with a different answer and the same evidence hash, returns
  `decided` and writes a new decision (`logs/api-already.log`: decisions 3, 4, 5 for flaky, infra, flaky). The
  reply type's comment says `conflict` covers "already decided differently". Reproduction: `probes/api-already.ts`.
- The run tally counts a skipped or blocked slot under both `skipped` and `missing` (12 slots:
  `7 pass · 1 unexplained · 4 missing · 2 skipped`), as in round 2.

## Mistakes in my own probes

- The round-2 `failed-twice` and `reason` probes pressed the retry key without going back to the question. Now
  that a failure no longer moves the cursor they answered the next question and reported an empty reason field.
  Rewritten in `queue-b.ts` (`again`, `reason`), which return to the question first.
- The first changed-evidence probe produced no conflict: the queue had already refreshed from the event stream.
  `misc.ts conflict` blocks the stream and the reads until the answer is sent.
- The round-2 `fast` probe pressed `u u` on a proposal, which cannot be withdrawn; `queue-b.ts uu` uses a failure.
- My own agent-slot plan input was invalid; the round-2 `extra.ts agent-slot` was used instead. My sign-off probe
  found no question (see below).

## Not checked

- Sign-off answers: under `standard` my self-accepting run closed by rule (`passed: 2 results proven`) and raised
  no sign-off question (`logs/misc-signoff.log`).
- The `l` (link through the case picker) and `merge` answers, unlinked tests decided by rules, a queue longer than
  one page (100), a run longer than 200 slots: by the authors' tests at most.
- The whole browser suite, the Suite, Case, Changes, Settings and sign-in screens (parts A and C).
- 1440x900 and the dark theme for these two screens; the screenshots looked at are 1280x800 and 1440x900, light.
- Real network latency: delays and failures were injected at the browser, on a loopback server.
- Browsers other than Chromium, Cmd on macOS, mobile widths, screen readers, IME input.

ISSUES (3 blockers)

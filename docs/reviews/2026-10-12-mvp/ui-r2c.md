# Mainworthy web UI: independent verification, round 2 (full review)

Revision judged: `f1a2a2404153513892d0981035085a1acb250a17`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's main authors (GPT 6.1 Sol).
Three of the round-1 fixes (UI-1, UI-2, UI-6) and the per-project capabilities were written by Claude Opus 5.5,
the same model as this reviewer. For those the different-provider side is the round-1 reviewer (GPT-6 Astra);
here they were re-checked by running them, not by reading them.

Status: complete. Nothing in the repository was changed.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision.** The five round-1 blockers are fixed, and the ordinary journeys hold at full
typing speed against slow writes. It fails where a late reply moves the cursor or closes the editor while the
person is still typing: a failure note ends up on another slot and is recorded (R2-1), a queue answer is recorded
on a question the person had already left (R2-2), and a new case that seals itself after 30 idle seconds turns the
rest of the sentence into commands (R2-3). Typed text is also lost to view after a failed save and a reload
(R2-4), and a typed reason is lost when its request fails (R2-7).

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium`
  (headless, the flags named in the task), real server processes on 127.0.0.1, ports 7800 to 7839.
- The only files changed in the export are five test helpers (ports moved into 7800..7839, the Chromium launch
  flags): `test-environment.patch`. No application source and no assertion is changed.
- Every probe drives the real UI with trusted key events and then reads the server through its API. Slow and
  failing requests are injected at the browser (`page.route`); the outage checks stop the real server.
  Probes are in `probes/` (run from `tree/` as `bun ../probes/<name>.ts [scenario]`), their output in `logs/`,
  screenshots in `shots/`. To rerun, first `bun install --frozen-lockfile` in `tree/` (its `node_modules` is
  removed at the end of this review).
- Each blocker was reproduced at least twice. Where a first result was my own mistake, it is said below
  (see "Mistakes in my own probes").

## Round-1 findings, re-checked on this revision

| Round-1 finding | Result here | Evidence |
| --- | --- | --- |
| UI-1 reload lost an unrecorded run note | fixed | `logs/run-a.log`: after reload `note:"Unsaved failure det"`, then recorded as `fail:Unsaved failure detail` |
| UI-2 two failed result requests lost the first note | fixed for the reported case; **a new defect beside it (R2-1)** | `logs/run-a.log` `ui2`: slot 1 `First failed note`, slot 2 `Second failed note`, both `missing` on the server |
| UI-3 `c` on a case URL edited the existing case | fixed; **its route effect causes R2-3** | `logs/suite-a-1.log`: `C-1 "Original case" v1`, `C-2 "New case" v1`, with every request delayed 500 ms |
| UI-4 a refused session left the app open | fixed | `logs/session.log`: `sign-in shown again {"signin":1,"app":0}`; note and case draft restored after signing in (`logs/final-2.log`) |
| UI-5 undo during a pending tag, move or archive was dropped | fixed | archive: 42 repetitions, end state `active`, version 1, two placements each time (`logs/undo-archive*.log`); tag and move by the authors' tests, 3 of 3 |
| UI-6 proposal keys acted on a proposal outside the pane | fixed | `logs/edit-a-agent.log`: first `a` → `"Q-3 is now in view. Read it, then press a again."`, card 516..764 inside pane 0..772, question still open; second `a` adopts (`logs/proposal.log`) |
| Session capabilities per project | holds | `logs/session.log`: session `can:[]`, `scratch:read+produce`; run buttons enabled, `p` recorded `tester/pass`; Settings preset disabled |

## Checks

| # | Check | Verdict | What ran and the deciding lines |
| --- | --- | --- | --- |
| 1 | Authors' tests | **issues** | `bun test test/e2e` three times: `41 pass, 1 fail`, `42 pass, 0 fail`, `42 pass, 0 fail` (`logs/e2e-{1,2,3}.log`). Flaky: `UI-5 immediate undo also waits for a pending archive`, a harness miss, not a product failure (see "The tests do not prove this"). `bunx tsc --noEmit`: exit 0. `bunx biome check src/web test/e2e`: `Checked 50 files in 42ms. No fixes applied.` `bun test test/architecture.test.ts`: `12 pass, 0 fail`. Several tests pass with the behaviour wrong; listed below. |
| 2 | Capture (J1) | **issues** | `logs/final.log` `j1`, every request delayed 500 ms, typed at full speed: `keys {"total":169,"text":161,"beyondText":8}`; caret in the new case on the frame after `c`: `true`; list row mirrored the title; server: version 1, tag `checkout`, six steps, three with an expected result. Two unchanged edits: still version 1. Reload mid-word and a closed tab restore `Half a wo` with the caret in it. Ctrl+Enter, Escape and leaving each make exactly one version. Pasted three lines became three steps, one with its result. Idle seal fires at 30034 ms and 30047 ms (`logs/idle2.log`). Fails: R2-3 (the idle seal closes the editor of a new case), R2-4 (a failed capture is not shown after a reload), R2-6 (a capture in a folder leaves the folder). |
| 3 | Editing and versions | **issues** (not blocking) | `logs/edit-a.log`. Step edit → v2 with a step-level diff on `v` (`v1 → v2 · b2.action … ~ Apply the coupon OLD10`); `u` restores as v3 (`["v3 b2.action","v2 b2.action","v1 created"]`). Badge and proof strip sampled on every frame behind 400 ms reads: `["v1|H✓now|✓","Draft|H✓now|✓","v2|H~now|~"]`, no stale tick. Two tabs, different fields: v3 holds `Coupon case from A` and `Open the cart from B`. Two tabs, same field: conflict card with both sides, resolved to v5, five versions kept. A draft is not replaced by an agent's proposal: the title stayed, focus stayed, my seal made the next version, the agent's adoption came after as `v3 by reviewer (agent)` with my title kept (`logs/proposal.log`). Defects found here: R2-8, R2-9, R2-10. |
| 4 | Queue (D2) | **issues** | `logs/queue-a.log` `fast`, 1280x800, `decide` delayed 500 ms, twenty keys with no waiting: `keys 20`, `decide requests 20`, `server open []`, `wrong or missing decisions []`, keys offered equal to the server's list for all twenty, the help sentence beside each key, no answer card clipped. (a) put back by a failed request, answered again: `server ["Q-5 decided"], rows ["Q-4","Q-3"]`, still two rows later; put back by undo, answered again: `decided`, not visible (`logs/final-2.log`). (b) `f u u`: `server "Q-8 open", visible true`, one `undo` request. (c) `logs/run-a.log` `ui2`: writes and reads failing, both slots `missing`, both notes kept. Bulk: `requests 1, entries [3]`, three decided. Proposal: diff shown before the key, adopted version by the agent. Forbidden and advice-only: by the authors' tests only (3 of 3), not run independently. Fails: R2-2 (a late failure moves the cursor and the next key answers the wrong question), R2-7 (the typed reason is lost). Changed evidence: see R2-2 and "Worth doing later". |
| 5 | Running a suite (J5) | **issues** | `logs/run-b.log`. Planned through `n` by folder (`C-1,C-2,C-3`), tag (`C-4,C-5`), text (`C-4,C-5`) and commit (`accepts {"commit":"abcdef1234567"}`). Ten results in 26 keys with `report` delayed 500 ms: all ten on the server, `C-3:failing:fail(total is wrong)` with `"atStep":"b2"`, `C-4 blocked`, `C-10 skip`; 10 requests. The node that was next became current (`{"ref":"C-2","probe":"was-next","ready":"true"}`). At 1280x800: controls 609..772, note 666..701, buttons end at 656, viewport 800. UI verdict and tally equal the server's (`blocked: 1 failure unexplained, 1 question open`, `7 pass · 1 unexplained failures · 4 missing · 2 skipped`). `u` appends a correction (result 11). Pipeline-filled and agent-filled slots are shown, skipped and unchanged after every outcome key (`logs/run-b.log` `external`, `logs/extra.log` `agent-slot`). Fails: R2-1. |
| 6 | Changes and Settings | pass | `logs/session.log`. Gate, open and settled questions, impact and uncovered files shown; 16 fast switches behind unevenly delayed reads, 19 distinct frames, `frames pairing a header with another change's gate: []`. Policy: `standard is in force. Proposal P-2 and decision Q-2 are both recorded.`, on the server `Q-2 … accept by robin`. New token: shown once, `local:false, session:false, cookie:false`, gone after dismiss and reload. Scoped token: sees `scratch` only, can record a result, cannot change Settings; revoking returns the sign-in. Note R2-11 (a refused project reads as an empty one). |
| 7 | Sign-in and session | **issues** | `logs/session.log`. Local mode: `app:1, token:0, cookies:0`. Server mode: asks for the token, wrong token `That token was not accepted. Try again.`, cookie `httpOnly:true, sameSite:"Strict"`, `document.cookie ""`. Second project created and in the switcher (`["scratch","second"]`). Refused session returns to sign-in and restores the note and the draft. Fails: R2-5 (opened over plain HTTP under any name but localhost, nothing can be written). |
| 8 | Keyboard, layout, themes | **issues** | `logs/layout.log`. The `?` sheet lists 33 bindings; exercised from the keyboard: `c e Enter j k arrows / Escape Ctrl+Enter Shift+Enter x m t # u Space ] Alt+[ n f z [ v a r g s/q/r/c/, Ctrl+K ?`. Plain keys typed in the filter and the tag box fire nothing (`value "cejkxmt#u z", drafts 0`). Palette finds cases (`Password reset restores access C-3`) and commands (`Go to Queue`). No key-acted control clipped on seven screens at 1280x800 and 1440x900 in both themes (no `clipped` line), no page scroll. 28 screenshots taken; the 14 at 1280x800 were looked at as light/dark pairs and are legible in both themes; the 1440x900 set was checked by measurement only. Fails: `j`/`k` in a folder leave the folder (R2-6); a navigation key is typed into a stored draft (R2-9). |
| 9 | Speed (P1) | pass | `logs/latency.log`, 10,000 real cases, 200 samples each, timed from the capturing keydown; "frame" is the next animation frame, where the state is checked, "painted" the frame after. `j` 16.1 / 17.3 ms and 31.5 / 35.4 ms (p50 / p95, frame and painted); `k` 17.5 / 19.1 and 32.7 / 32.9; `c` to a focused caret 16.4 / 18.4 and 32.7 / 33.6; a typed character 16.4 / 16.6 and 32.7 / 32.9. Budget 100 ms at p95. No wrong sample in the 200 of each action (one of the two extra title characters my script typed without waiting a frame was counted wrong; the 200 step characters all reached the server). A measurement on a shared machine (load 2.7 to 3.9), headless, not a guarantee. |
| 10 | Errors | pass, with two exceptions | No uncaught error and no console error in any journey above on loopback (`errors: []` in every log). Server stopped while typing a case: text kept in the editor and on the device, status `Failed to fetch. Your draft is kept on this device.`, chip `Draft, saved on this device · Private, no version yet`. Server stopped while recording a result: note kept, slot shown `missing`, status `Failed to fetch` (`logs/layout.log` `outage`). Exceptions: R2-4 (after a reload the kept draft may not be shown), R2-5 (`crypto.randomUUID is not a function`, uncaught, over plain HTTP). |

## Defects

### R2-1: A late failure moves the run cursor while a note is being typed; the rest of the note goes to another slot

Blocks: **yes**.

When a result request fails, the cockpit moves the cursor back to the failed slot (`setCursor(slot.id)`, and for a
failure also `setNoting(slot)` and focus on the note field: `src/web/runs/cockpit.tsx`, the `request.catch`
handler in `record`). If the person is typing the next slot's note at that moment, the remaining keys go into the
failed slot's note, and Enter records something other than what they wrote.

Reproduction (`probes/run-a.ts steal`, `logs/run-a.log`; four cases, only the first `report` request fails, 900 ms
after it is sent):

- `f`, `First note`, Enter, `f`, then `Second note typed at a walk` at 60 ms a key, Enter. Server afterwards:
  `C-1 failing, fills ["fail:First noteed at a walk"]`, `C-2 missing, fills []`. The second half of the second
  note is recorded under C-1. C-2 has no result and `Second note typ` is left on the device for it.
- `p`, `f`, `Second note typed at a walk` at 60 ms a key, Enter. Before Enter the screen shows C-1 with the note
  `ed at a walk`; Enter records `C-2 failing, fills ["fail:Second note typ"]`: a failure on a slot that is not the
  one shown, with a cut note (`shots/run-steal-p.png`).

Promise contradicted: no key applied to another object; a rollback that keeps the person's input. The authors'
test for two failed requests types both notes before either failure arrives, so it cannot see this.

### R2-2: A late failure moves the queue cursor; the next key answers a question the person had left

Blocks: **yes**.

The same shape in the queue: when an answer is refused or its request fails, `bringBack` puts the question back
and sets the cursor on it (`src/web/queue/index.tsx`). A key pressed just after, meant for the question the
person is now reading, answers the one that came back. Answer keys mean different things per kind (`t` is "Track
without a case" for an unlinked test and "The test is wrong" for a failure; `d` is "Duplicate" or "Defect").

Reproduction, twice, identical (`probes/queue-steal.ts`, `logs/queue-steal.log`; one failure Q-3 and one unlinked
test Q-4, the first `decide` fails 500 ms after it is sent): on Q-3 press `i` (Infrastructure); the screen moves
to Q-4; 650 ms later press `t`. `shownAfterI:"Q-4", shownWhenTWasPressed:"Q-3"`, requests
`["Q-3:infra","Q-3:test"]`, server: `Q-3 {"is":"test"}`, `Q-4 open`. The ledger now says the person judged the
test wrong; they pressed "track" on another question. `u` withdraws it if they notice.

With a proposal whose case changed underneath (`logs/evidence-sweep.log`), five `a` presses at 250 to 400 ms
landed on `["Q-7","Q-6","Q-7","Q-5","Q-7"]`: every other key went to the returned question instead of the next
one; at 520 ms and slower all five went to Q-7 and none of the other proposals was reached.

Promise contradicted: no key applied to a different object than the one shown. The D2 test waits for each write
before the next key and no test fails a request under fast keys.

### R2-3: A new case left idle for 30 seconds closes its editor; the rest of the sentence runs as commands

Blocks: **yes**.

When a new case seals itself after 30 idle seconds, `sealDraft` replaces the URL with the new case's URL. The
route effect added for UI-3 (`src/web/suite/index.tsx`, the `previousRef` effect) sees a route change, reads the
stored draft for that ref, finds none (it was just removed) and sets the draft to null. The editor unmounts and
focus falls to the page. What the person types next is handled as commands.

Reproduction, twice, identical (`probes/idle-capture.ts`, `logs/idle-capture.log`, `shots/idle-capture-after-typing-1.png`):
`c`, `Checkout total`, Enter, `Add two items`, wait 31 s, type ` and check the total`, Escape.
`focusAfterPause:"BODY[null]", editorsAfterPause:0`; server: `["C-1 Existing case v1","C-2 Checkout total v1","C-3 heck the total v1"]`,
C-2's step is still `["Add two items"]`. The `c` of "check" started another case and the tail of the sentence
became its title. With other words the same keys archive (`#`), tag (`t`), reopen the title (`e`) or restore a
version (`u`). The same in a folder view and in "All cases" (`logs/idle2.log`).

The authors' test "30 seconds idle records one version, preserves the caret..." edits an existing case, where the
URL does not change. Decision 0011 says of this timer: "thirty seconds of silence does not prove a thought is
finished".

Promise contradicted: P1 and J1 (capture never waits; the caret stays), no key applied to another object, typed
text lost.

### R2-4: A new case that failed to save is not shown again after a reload

Blocks: **yes**.

New-case drafts are stored one per key, but a single pointer (`mainworthy:active:<project>`) says which to restore.
After two captures fail to save, a reload restores the last only. The first stays in `localStorage`; no screen
shows it, and it is never sent.

Reproduction (`probes/suite-a.ts failed-captures`, `logs/suite-a-2.log`, `propose` requests failing): `c`,
`First unsaved case`, Enter, `First unsaved step`, Escape; `c`, `Second unsaved case`, Escape. Both rows show
"draft"; status `Failed to fetch. Your draft is kept on this device.` Reload with the network back: rows
`["new Second unsaved case draft","C-1 Existing", …]`. 32 seconds later and after leaving the editor the server
holds `["Existing","Second unsaved case"]`; storage still holds a draft titled `First unsaved case`.

Promise contradicted: "nothing typed is lost on reload, on a failed request". The UI had said it was kept.

### R2-5: Opened over plain HTTP under any name but localhost, the UI cannot write anything

Blocks: **yes, if server mode is meant to be opened from another machine over HTTP**, which is what `Dockerfile`
(`MAINWORTHY_HOST=0.0.0.0`) and `compose.yaml` set up; no document says HTTPS is required.

`crypto.randomUUID` exists only in a secure context. The UI calls it for every draft id and command id (13 call
sites in `src/web`). Chromium treats `http://localhost` and `http://127.0.0.1` as secure, so every test passes;
`http://tower:7357` or `http://192.168.x.x:7357` is not.

Reproduction (`probes/extra.ts http-name`, `logs/extra.log`; the same server opened as `http://mainworthy.test:<port>`
with the name mapped to 127.0.0.1 by a Chromium flag): `{"isSecureContext":false,"randomUUID":"undefined","clipboard":"undefined"}`.
Sign-in works. `c`, type, Escape: no draft row, nothing on the server, uncaught
`crypto.randomUUID is not a function`. `p` in a run: `C-1:missing`, status `crypto.randomUUID is not a function`.
`navigator.clipboard` is missing too, so "Copy token" cannot work there, and the new token is in a password
field that cannot be read or copied by hand (the button itself was not clicked in this probe).

Smallest fix: one id helper that falls back to `crypto.getRandomValues`.

### R2-6: Selecting a case in a folder view leaves the folder

Blocks: **yes** (arguable: nothing is lost or written wrongly).

A case URL carries no folder (`refUrl` in `src/web/lib/router.ts`) and the list's folder is read from the URL, so
in a folder view the first `j`, `k`, click on a row or sealed capture replaces the folder's list with "All cases".

Reproduction (`probes/suite-a.ts folder`, `logs/suite-a-1.log`, 30 seeded cases):
`{"url":"/p/scratch/suite?folder=Accounts","title":"Accounts","count":"6 cases","sel":"C-3"}`, press `j`:
`{"url":"/p/scratch/suite/c/8","title":"All cases","count":"30 cases","sel":"C-8"}`. A capture made in the folder
is filed in it but sealing it also leaves the view on "All cases". The `?tag=` filter is dropped the same way.

It blocks in my judgement because the folder tree is the reason decision 0011 kept the workbench frame, and a
folder cannot be walked: every selection throws the person out of it. If the owner judges it cosmetic, the count
drops by one.

### R2-7: A reason or defect reference typed in the queue is lost when the request fails, and on a reload

Blocks: **yes** (the smallest of the blockers; the same promise UI-1 and UI-2 broke in round 1).

The queue's inline field lives in component state and is cleared when the answer is submitted. When the request
fails the question comes back, but the typed text does not.

Reproduction (`probes/queue-a.ts reason`, `logs/queue-a.log`). Under `strict`, with two pipeline failures: `f`,
type `Known flaky on the staging runner, see BUG-77`, Enter while `decide` fails: the question returns (status
`Failed to fetch`), press `f` again: `value offered when answering again: ""`. Under `standard` the same with `d`
and `BUG-1234`. A reload in the middle of typing empties it too.

Promise contradicted: "rolled back visibly with the person's input kept". Under `strict` every failure answer
needs a sentence, so every failed request costs one.

### R2-8: A proposal that arrives while its case is open does not appear on the case

Blocks: no.

The event for a proposal names the proposal and its question, not the case (`logs/events.log`:
`"op":"propose","actor":"reviewer","touched":["P-3","Q-3"]`), and the client refetches a case's timeline only when
the event names the case (`src/web/lib/data.ts`, `useEvents`). The Queue count in the sidebar goes to 1 at once;
the open case shows no proposal card and `a` / `r` do nothing.

Reproduction (`probes/proposal.ts`, `logs/proposal.log`): `card appeared after ms (-1 = not within 20 s): -1`, with
and without a draft open; it appears after the person's own next write to the case. What the screen shows is
then not what the server holds, though the UI has settled. Fix on either side: name the case in the event (the
event route is in this review's scope), or refetch timelines on any `propose` event.

### R2-9: A case with a stored draft opens its editor when the list cursor lands on it; the next navigation key is typed into its title

Blocks: no (it needs a draft that stayed unsaved: an unresolved conflict, a proposal waiting for a person, or a
save that failed and was not retried).

Selecting a case restores its stored draft (`choose` in `src/web/suite/index.tsx`), and the editor takes focus
when it mounts. Reproduction, twice, identical (`probes/extra.ts trap`, `logs/extra.log`): edit C-2's title, let
someone else change it, Escape (the conflict card appears), then walk the list: `k`, `j`, `j`.
`selectedAfterTwoJ:"C-2", focus:"TEXTAREA[title]", titleField:"Case 2, my wordingj", conflictCards:0`. The second
`j` is in the title, the cursor never reaches C-3, and the conflict card is gone until the next seal attempt.

Related, same cause (`probes/final.ts late-conflict`, `logs/final-2.log`, `shots/late-conflict.png`): when the
conflict reply arrives after the person moved to the next case, the card for C-1 is drawn in C-2's pane
(`paneRef:"C-2", conflictCard:"…C-1 changed while you were writing…"`), and C-1's row shows no draft mark.

### R2-10: Typing " > " in a step that already has an expected result replaces that result

Blocks: no.

Reproduction (`probes/suite-a.ts gt`, `logs/suite-a-1.log`): step `Open billing` with the expected result
`The invoice list is shown`. Click the step, End, type ` from Settings > Billing`, Escape. Version 2:
`{"action":"Open billing from Settings","expected":"Billing"}`. The earlier result is gone from the current
version without a word (it is in version 1 and in the diff). Menu paths such as "Settings > Billing" are common
in test steps, and there is no way to type one into an action.

### R2-11: A project the session may not read is shown as an empty project

Blocks: no.

`logs/session.log`, the scoped person opening `/p/second/suite`: `All cases | 0 cases | … | No cases yet. Press c
and start typing.` The Suite screen does not show a failed or refused list read (`list.error` is not rendered in
`src/web/suite/index.tsx`), so a refusal and an empty project look the same.

## The tests do not prove this

- **Flaky:** `UI-5 immediate undo also waits for a pending archive` (`test/e2e/placement.test.ts`) failed in 1 of 3
  full runs ("The expected server state did not arrive" at line 80). Repeated 42 times here it missed twice
  (`logs/undo-archive.log`, `logs/undo-archive-2.log`). In both the product was right (`state:"active"`,
  `version:1`, `placements:2`, status "Undone. The inverse change is recorded."); Playwright reported one
  `propose` request instead of two (`requested` holds only the inverse), and the test waits for `writes === 2`.
  In such a run the first write was also not delayed, so the "pending" premise is not exercised.
- `30 seconds idle records one version, preserves the caret…`: true for an existing case only. A new case loses
  the caret (R2-3).
- `a failure note is kept on the device: … one per slot when two requests fail`: both notes are typed before
  either failure arrives. The failure arriving mid-note is R2-1.
- `D2: twenty mixed one-key answers…` and the J5 test wait for each write before the next key, so they do not
  show that fast keys lose nothing. The probes here did that (they hold), and found R2-2 when a request fails.
- `a stale agent proposal comes back with the new evidence…`: asserts the message and that the row returns; it
  never looks at the evidence shown. (Shown correctly in `logs/extra.log`: `version 2 → proposed version 3`.)
- `advice is taken with Enter and forbidden answers are disabled`: after pressing `a` it reads the server at
  once, with no wait, so a write landing a moment later would pass. The disabled-button assertions stand.
- `a failed seal keeps the typed text and retry uses the same command`: never compares the two command ids.
- `settings … scopes and revokes tokens…`: scope is one `find` returning no cases; no other project is tried.
- `rapid capture keeps the folder…`: reads the server's folder; it does not look at the list, which has left the
  folder (R2-6).
- `shell routes, palette, help and theme work…`: opens the sheet and counts it; it drives few of the listed keys.
- The latency test takes 30 samples and has no `j` / `k` timing.
- Every test runs on 127.0.0.1, a secure context, so none can see R2-5.
- No browser test reads the ledger after `u` (the "both decisions remain" claim); see "Not checked".

## Worth doing later

- In the run screen a failed result says only `Failed to fetch`. Say that it was not recorded and the note is kept.
- `d` (defect) opens a reference field where Escape records the answer ("Escape skips the reference":
  `logs/extra.log`, `{"state":"decided","answer":{"is":"defect"}}`). There is no way to back out except `u`.
- A proposal whose case changed in the same field can never be accepted from the queue (five `a` presses, five
  "The evidence changed … redo the proposal on version 2"), yet `a Accept` stays offered and each press puts the
  cursor back on it. Offer what the server will take, and leave the cursor where the person is.
- Run header `2 left` beside the server's tally `4 missing` (`logs/run-b.log`): a skipped or blocked slot is
  counted in both `skipped` and `missing`, so the tally sums to 14 for 12 slots. The UI prints the server's
  numbers faithfully; the two counts on one screen disagree. (Engine.)
- On Suite, `u` undoes the last placement and, when there is none, restores the previous version of the selected
  case. After an undo, a second `u` makes a new version. Two meanings on one key.
- Closing a tab mid-word records the half word as version 1 (`onServerAfterClose:1`, title `Half a wo`). That is
  "leaving" as decision 0011 defines it, but it is the half sentence that decision set out to keep private.
- An upper-case letter fires the command (`Shift+C` starts a capture), so Caps Lock does too.
- From reading only, not run: the tag box keeps its last text; two tabs on one run share one notes key and
  overwrite each other's stored notes; a change whose key starts with `Q-` or `R-` loses that prefix in its URL
  (`routeUrl`); `]` walks folders in the server's order, the tree shows them sorted by path.

## Engine observations (not judged here)

- The `propose` event does not name the case it concerns (cause of R2-8). Reproduction: `probes/events.ts`.
- The run tally counts a skipped slot under both `skipped` and `missing` (`logs/run-b.log`, `j5 server verdict`).

## Mistakes in my own probes

- An early idle probe reported a seal after 23 s; its timer started late. Measured properly: 30034 ms, 30047 ms.
- A two-tab probe "left with `j`" from inside the editor, where `j` is text; the proper form (Escape, then `j`)
  is `probes/final.ts late-conflict`.
- A probe seemed to show a draft sealing by itself; it had waited over 30 s for a proposal card that never came
  (which is R2-8), so the idle timer fired. `probes/spont.ts` shows no seal within 6 s.
- An attempt to change a failure's evidence did not change its hash; the changed-evidence check uses a proposal.
- An agent result reported to a run without the `agent` method in its obligations did not fill the slot; the
  agent-slot check plans the run as the authors' test does.

## Not checked

- That both decisions remain in the ledger after `u`: the reopened state and the single `undo` request were seen;
  the ledger rows were not read (no browser test reads them either).
- Forbidden and advice-only answers, the `l` (link) and `c` (create cases) answers for unlinked tests, sign-offs,
  undo of a pending move, and full device storage: by the authors' tests only (each 3 of 3), not independently.
- The "Copy token" button, drag and drop onto a folder, the Connect section's commands, the MCP endpoint.
- The 1440x900 screenshots by eye (measured only). Physical paint time; latency numbers are frame proxies in
  headless Chromium.
- Browsers other than Chromium, Cmd on macOS, mobile widths, screen readers, IME input.
- The engine, beyond the two observations above.

ISSUES (7 blockers)

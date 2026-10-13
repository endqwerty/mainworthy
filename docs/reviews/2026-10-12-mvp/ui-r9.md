# Mainworthy web UI, verification round 9 (re-check of round 8)

Revision judged: `5df174722dc991b0399ad26493f3a1a3b17e0b88` (branch `t3/mvp-product-delivery`), a clean
`git archive` export in `ui-r9/tree`. Verifier: Claude Opus 5.5 (Anthropic). Started 2026-10-12.

## Result in short

R8-1 and R8-3 are fixed, and R8-2 is fixed with a new problem (R9-1), on the routes round 8 reported, twice each. The ownership rule holds everywhere I
pushed it with two and three windows: a second window is read-only and says so, a refused key is never applied,
"Take over here" moves the whole draft at any moment I tried (mid-typing, a proposal or a merge on its way, a
card open, two windows pressing at once), one window owns the draft at the end, and a draft whose owner went
away could always be taken.

One blocking defect is new, and it needs one window only:

- **R9-1 (blocks).** A side effect of R8-2's fix. After a merge with a hand-typed field, when the server
  combined that merge with a colleague's newer change to another field, the page keeps the merge it sent as
  "your later text". Leaving the editor, or 30 seconds without a key, records it and undoes the colleague's
  change. 2 of 2 on every variant; round 8's revision does not do it.

Two more are new and do not block: R9-2 (one window, a conflict left by a closed tab: "This case is being edited
in another window") and R9-3 ("Take over here" from read mode takes a conflicted draft and shows no card).

## The fact to prove

"What the UI shows is what the server holds once the UI has settled … and nothing typed is lost on reload, on a
failed request, or when another producer changed the same thing." For text typed by the person: **held on every
route I ran**. For the first half: **not proven**, by R9-1 (the page shows and then records a body the server
had already improved on).

## Findings re-checked

Each round-8 probe was copied from `ui-r8/probes/a/r8.ts` with only paths changed and run twice (the probe's own
two rounds); logs in `ui-r9/logs/`.

| Finding | Verdict | What ran and the deciding lines |
| --- | --- | --- |
| R8-1 text typed in a second window's editor is deleted when the first window's proposal meets a conflict | **fixed** (the right outcome changed: the second window can no longer type) | `r8.ts instant "B was typing in the same draft before A left"`, storage events delivered (`logs/a8-instant-natural.log`) and held back (`logs/a8-instant-held.log`), 2 of 2 each, identical. B presses `e`: `readOnly true`, `status "This case is being edited in another window"`. B's ` typed in B before` is refused at the key: `b2 "Apply the coupon"`, stored draft unchanged (`Coupon case mine / Open the cart / Apply the coupon / no conflict`). A's conflict and merge: `v3 Coupon case mine / Open the cart / Apply the coupon`, `stored []`, B: `Conflict resolved in another window. The recorded version is shown.` Nothing B typed was ever taken, so nothing is deleted. The route with B typing after "Take over here" is in the next section (`r9.ts second`) |
| R8-2 text typed by hand into the card's merged field is deleted on a rejection, or after a lost merge reply and a reload | **fixed, with a new problem** (R9-1, blocks) | `r8.ts card-text`, 2 of 2 each, identical (`logs/a8-card-text.log`). Rejected by the other side: `status "The conflict proposal was rejected. Your typed merge is kept; leave the editor to propose it afresh."`, `stored "HAND MERGED TITLE / Open the cart / Apply the coupon SAVE10 / no conflict / base 1"`, `hand {server false, device true, screen true}`; leaving proposes it and a new card (Q-4) holds it. Lost reply, typed, reload: `status "Conflict resolved. Your later text is kept on this device as a draft on version 3."`, `stored "HAND MERGED TITLE / ... / no conflict / base 3"`; leaving: `v4 HAND MERGED TITLE / Open the cart / Apply the coupon SAVE10`, `stored []`. Lost reply, typed, second press: the same `v4` |
| R8-3 with two windows and a slow reply, a merge that met a newer version brings back the text from before the merge | **fixed** | `r8.ts race`, reply held 1.5 s: 4 of 4 (B in the editor, B only showing the case), and not held (`logs/a8-race.log`). First merge: `A decide Q-3 merge "Coupon case, merged by hand" -> "status":"decided" "status":"conflict" "adopt":"Q-5"`; A: `Nothing was adopted: the case changed again. Your draft is kept. Resolve the new conflict in the card.`; B: `This case is being edited in another window` (round 8: `Conflict resolved. Your later text ...`); `stored "Coupon case, merged by hand / ... / conflict Q-5 merged "Coupon case, merged by hand""`. Second merge: `v4 Coupon case, merged by hand / Open the cart / Apply the coupon SAVE10`, `stored []`, `Conflict resolved. Version 4 is recorded; ...`; leaving sends nothing more; `questions open []` |

## What the ownership rule could have broken next to it

New probe `probes/a/r9.ts` (`second`, `typing`, `proposal`, `merge`, `both`, `gone`, `fresh`, `list`, `apart`,
`stale`), run from `tree/` as `bun ../probes/a/r9.ts <scenario> [variant]`, each variant twice; logs
`logs/r9-*.log`. "Windows" are pages of one browser context. Same result in both runs unless said.

| Check | Verdict | What ran and the deciding lines |
| --- | --- | --- |
| The second window: read-only, the line, the button; a refused key changes nothing and is not applied later | **pass** | `second`: `e` in B opens A's draft `readOnly true`, `status "This case is being edited in another window"`, `takeOver 1`. ` KEY`, Backspace and Enter in B: `b2 "Apply the coupon"`, stored draft unchanged, owner A; ` KEY` is in no later state. B follows A's typing with no reload (`title "Coupon case mine more"`). Escape in B: `requests []` |
| After taking over, the first window's text is present and the first window is read-only without a reload | **pass** | `second`: B `readOnly false`, `Continue editing here. Your draft is kept on this device.`, `title "Coupon case mine more"`, stored `owner THIS WINDOW`. A: `readOnly true`, the line, the button; ` XA` typed in A is refused. B leaves: `v2 Coupon case mine more / Open the cart / Apply the coupon fromB`. A then edits again: `v3 … Open the cart lastA …` |
| "Take over here" while the owner is typing | **pass** | `typing`, 60 numbered words at 12 ms and 3 ms a key, 4 runs: B's editor and the stored draft hold an unbroken prefix (`w1 … w10`, `w1 … w11`, once ending mid-word `… w9 w`), `contiguousPrefix true`, A shows the same text (`aShowsSameAsB true`), `readOnly true` and the line; the rest of A's keys are refused there. `v2 … Apply the coupon w1 … w10` |
| "Take over here" while the owner's proposal is on its way | **pass** | `proposal`: request held 1.5 s before the server, reply held 1.5 s and 3 s, 6 runs. A's proposal is recorded (`v2 Coupon case mine`), A writes nothing over B (`afterReply.stored … Apply the coupon fromB … owner THIS WINDOW`), B's leave: `B propose base 1 … "Apply the coupon fromB" -> adopted`, `v3 Coupon case mine / Open the cart / Apply the coupon fromB`, `stored []`, `questions open []` |
| "Take over here" while a conflict card is open, and while the owner's merge is on its way | **pass**, with R9-3 | `merge`. Card open, B's read-only editor: `Merged title` cannot be filled, "Resolve conflict" is disabled, no request. After the button: B's card is editable and holds A's hand-typed merge; A's card refuses typing; B resolves: `v3 HAND MERGED IN A, FINISHED IN B / … SAVE10`, both windows `cards 0`, `stored []`. Merge reply held 2 s, B takes over: B settles at once on the recorded merge (`Conflict resolved. Version 3 is recorded; …`), `v3 HAND MERGED IN A`, nothing left. Merge request held 2.5 s, B takes over, replaces the merged title and resolves first: `v3 MERGED IN B AFTER TAKING OVER`, A's late request is answered "already" and A shows the server's sentence (R9-4); 1 run, the other stopped on a click my probe could not make under load. B only reading the case (never pressed `e`): R9-3 |
| Both windows pressing "Take over here" | **pass** | `both`, three windows (A owns; B and C press): one after the other, at the same moment, and six presses going round. Every run: `editableWindows 1`, and the stored owner is that window. Then each window types a word: only the owner's is taken (`Open the cart TC`), the others show the line. In one "same moment" run my probe's click on the owner's field was swallowed (nothing typed, nothing refused); repeated alone: see the note under "Mistakes in my own method" |
| The owner goes away: can another window always get the draft, with the text? | **pass** | `gone`. Closed mid-sentence (with and without unload handlers): the closing tab records what was typed (`v2 … Apply the coupon closing in t`), the stored draft keeps it; B gets it by `e` when it was reading (`readOnly false`, no button needed) and by the button when its read-only editor was open; `v3 … Open the cart thenB / Apply the coupon closing in t`. Reloaded: the owner keeps its id and the draft, editable (`aAfterReload readOnly false`, `b2 "Apply the coupon before reload"`). A copy opened with `window.open` (session storage copied): its own window id (`sameSessionId false`), read-only, the button works. A window given the owner's id and reloaded: it takes a new id and is read-only. Signed out in the owner (`POST /api/logout`), signed in again: B takes over with all the text and records it. No run ended with a draft nobody could edit, and "Take over here" did something in every run |
| One window only: none of this visible; the round 6 and 7 probes as round 8 recorded | **issues**: R9-1 (blocks), R9-2 | Round 8's probes, unchanged, compared value by value with round 8's logs (`probes/cmp.py`): `r7.ts freeze-ends` 10 of 10 runs `0 of N values differ`; `reload-card` (reload, new tab) `0 of 40`; `moved` same field, same field twice, same field then again under the new card `0 of 44/60`; `r6.ts choice-then-type` 18 of 18 runs `0 of 27`. **`moved [another field]`: `18 of 34 values differ`, R9-1.** `settled-while-closed`, opened on another case: `3 of 95` and `1 of 95` differ, R9-2 |
| A capture in one window while another owns an existing case's draft; two windows on two cases | **pass** | `apart`: B edits C-2 and captures C-3 while A types in C-1; no line or button in B; `C-1 v2 Coupon case mine / … / Apply the coupon SAVE10 and more`, `C-2 v2 Other case edited in B`, `C-3 v1 Captured in B while A edits`. `list`: a new window opened on the suite list shows A's draft read-only with the line (it is the device's active draft); `c` there captures `C-3 v1 Captured in the new window`; A is untouched and records `v2 … SAVE10` |

## Defects

### R9-1: After a hand-typed merge that the server combines with a colleague's newer change, the page keeps the merge as "your later text", and leaving the editor (or waiting 30 seconds) records it over the colleague's change

Blocks: **yes** (something is recorded that the person did not type, another producer's change is undone without
anyone being told, and the status line calls text "later" that is not). One window, no slow or lost reply.
New on this revision: round 8 ran the same probe and ended `Conflict resolved. Version 4 is recorded; …`,
`stored []` (`ui-r8/logs/a7-moved.log`).

Found by round 7's probe, unchanged (`r7.ts moved "another field"`, 2 of 2, `logs/a7-moved.log`), then by
`r9.ts stale` (2 of 2 each variant, `logs/r9-stale-*.log`, `shots/r9-stale-*.png`).

Steps, one window, four deliberate steps and two changes by a colleague:

1. On C-1: `e`, type ` mine` in the title and ` SAVE10` in step 2. A colleague changes the title. Escape: a card.
2. While the card is open, a colleague changes **another** field (step 1: `Open the cart, changed by a colleague`).
3. Type `Coupon case, merged by hand` in "Merged title". "Resolve conflict".
4. Press Escape. Or press nothing for 30 seconds. Or reload and press Escape.

```text
before the merge:  server "v3 Coupon case theirs | Open the cart, changed by a colleague / Apply the coupon"
Resolve conflict:  server "v4 Coupon case, merged by hand | Open the cart, changed by a colleague / Apply the coupon SAVE10"
                   status "Conflict resolved. Your later text is kept on this device as a draft on version 4."
                   the editor is open and editable: title "Coupon case, merged by hand", step 1 "Open the cart"
                   stored "Coupon case, merged by hand | Open the cart / Apply the coupon SAVE10 | no conflict | base 4"
Escape:            A propose base 4 "Coupon case, merged by hand" ["Open the cart","Apply the coupon SAVE10"] -> adopted
                   server "v5 Coupon case, merged by hand | Open the cart / Apply the coupon SAVE10"; status "Version 5, by you, just now"
no key, 33 s:      the same request and the same v5
```

The only sign on the screen is in the timeline, which shows the draft's difference from version 4 as step 1
losing `, changed by a colleague` (`shots/r9-stale-typed-merge-leave-1.png`); the status line and the draft
banner say a draft of the person's later text is kept.

The server's merge (v4) was right: it kept the colleague's step. The page then kept the body it had sent as a
dirty draft on version 4, and that draft still has step 1 as it was before the colleague's change. Nothing was
typed after the merge. With "Use my title" in place of the typed title the same steps end at
`Conflict resolved. Version 4 is recorded; …`, `stored []`, the colleague's step kept (`stale "choice only"`).

The cause: `finishConflict` in `src/web/suite/index.tsx`. R8-2's fix made `hasTypedMerge(stored.conflict)` enough
for `laterMerge`. After the person's own merge, the card's body is exactly what was sent; it differs from the
recorded head only because the server combined it with the newer version. The old condition (`sent` given and
the card differs from `sent`) said "nothing later"; the new one says "later text" whenever a merged field was
typed by hand.

Smallest fix: when `finishConflict` is given `sent`, compare the card with `sent` only; use `hasTypedMerge` only
when there is no `sent` (the question was answered elsewhere, or after a reload with no stored `sentMerge`):
`(sent ? !sameBody(stored.conflict.merged, sent) : hasTypedMerge(stored.conflict))`. Tried in a scratch copy
(`mut/fix2`, removed afterwards): `stale "typed merge, leave"` ends `Conflict resolved. Version 4 is recorded; …`,
`stored []`, `v4 … Open the cart, changed by a colleague …` (`logs/fix2-stale.log`); `card-text "lost reply, typed, reload"` still ends `Your later text is kept …` and `v4 HAND MERGED TITLE` (`logs/fix2-card-text-lost-reload.log`); `bun test test/e2e/round8.test.ts test/e2e/round6.test.ts` there: `32 pass, 0 fail` (`logs/fix2-tests.log`). I did not run the rest of the suite on it.
Test: the steps above, expecting no draft after the merge and the colleague's step in the head.

Promise contradicted: "what the UI shows is what the server holds once the UI has settled"; "undo appends" (a
colleague's change is reverted by a proposal nobody made).

### R9-2: With one window, a conflict left by a closed tab says "This case is being edited in another window"

Blocks: **no** (nothing is lost; the button and `e` both work). It contradicts the brief's "one window only:
none of this should be visible", and it delays what round 8 recorded as fixed for R7-1 route B.

`r9.ts fresh "card, new tab opened on another case"` (2 of 2, `shots/r9-fresh-card-new-tab-opened-on-another-case-*.png`)
and round 7's `settled-while-closed`, opened at `/c/2` (`logs/a7-settled-while-closed.log`). One window, four
deliberate steps and one change by a colleague: a card on C-1; close the tab (or the browser); open the app on
another case; click C-1.

```text
onCase:  line 1, takeOver 1, cards 0;  stored "… conflict Q-4 … | owner 9473c3"   (the closed tab; no other window exists)
round 8, same probe: "The conflict proposal was rejected. Your current draft is kept; leave the editor to propose it afresh."
this revision:       "… Draft kept on this device. Press e to continue. This case is being edited in another window Take over here …", the rejected conflict still stored
```

`e` claims the draft (the owner is not live) and the rest of the probe ends as in round 8 (3 of 95 values
differ). The cause: `ownedElsewhere` in `SuiteScreen` is `owner !== windowId`; it does not ask whether the owner
is live, though `claimDraft` does. The same shows with two windows after the owner's tab is closed: the other
window's read-only editor keeps the line until the button is pressed (`gone "closed mid-sentence, B's editor
open"`: `line 2, takeOver 1` after the close). Opened at the case's own URL, or reloaded, the window claims the
draft and nothing shows (`fresh "card, new tab opened on the case"`, `"card, reload"`: `line 0`, the card
editable, `v3 MERGED IN THE NEW TAB`).

Smallest fix: `ownedElsewhere = owner !== windowId && draftOwnerIsLive(owner)`, and claim on arrival when the
owner is not live.

### R9-3: "Take over here" in a window that only shows the case takes a conflicted draft and shows no card

Blocks: **no** (nothing is lost). `merge "card open, B reading"`, 2 of 2. Two windows, three deliberate steps
and one change by a colleague: A edits and leaves (a card on C-1); B shows C-1 and never pressed `e`; the button
is pressed in B. Before it, B shows the line and the button but no card (`cards 0, line 1, takeOver 1`). After it:

```text
B: status "Resolve the conflict first. Edit the merged fields in the conflict card; other fields can be edited after it is resolved."
   cards 0, no editor;  stored "… conflict Q-4 … | owner THIS WINDOW";   A: read-only, the line
```

B now owns the draft and is told to edit a card that is not on its screen; `e` brings the card and the merge
goes through (`v3 HAND MERGED IN A, FINISHED IN B`). The pane gets `conflict={draft?.conflict ?? null}`, so a
card shows only where the editor is open, while the line and the button come from the stored draft.

## The tests do not prove this

`bun test test/e2e/round8.test.ts` on the export: `18 pass, 0 fail, 67 expect() calls [57.04s]`
(`logs/round8-test.1.log`). `bunx tsc --noEmit`: exit 0. `bunx biome check src/web test/e2e`: `Checked 63 files
in 75ms. No fixes applied.`

The new file against round 8's `src/web` (5cc2b3a, scratch copy): `16 fail, 2 pass` (`logs/round8-tests-on-r8-revision.log`). The two that pass on round 8's code are `R8 a closed owner's mid-sentence draft is claimed on opening the editor` and `R8-2 choosing a side after replacing a hand-typed field keeps the original draft on rejection`; each guards against the change going too far and fails under a removal below. Both `R8-1`, all four `R8-2 … survives …` and both `R8-3` tests fail on round 8's code.

One fix removed at a time in a scratch copy (`probes/mutate9.py`, `logs/mutations-*.log`, `logs/mut-*.log`; the
unchanged copy: 18 pass):

| Fix removed | Tests in `round8.test.ts` that fail |
| --- | --- |
| `writeDraft` refuses a draft another window owns | **none** (18 pass): `mayWrite` covers every caller |
| `mayWrite` (the check at the moment of each proposal, merge and settle) | 7: `R8 ownership: opening, refusing a key …`, `R8-1 B types before A leaves …`, `R8 conflict card follows the owner …`, `R8 a stored takeover before its event guards input and seal …`, `R8 a late conflict reply cannot write over a draft taken over …`, `R8 a takeover stored before its event guards a conflict-card change and merge`, `R8 an empty merged step remains owned …` |
| both of the above | 9: those, `R8-1 A leaves before B types …` and `R8-3 a nonowner in the editor cannot release a merge …` |
| `removeDraft` refuses a draft another window owns | **none** |
| a second window claims a draft a live window owns | 8, among them `R8 simultaneous keys and sequential takeovers …` and `R8-3 a nonowner in the editor …` |
| a draft whose owner is gone is not claimed by `e` | 1: `R8 a closed owner's mid-sentence draft is claimed on opening the editor` |
| the storage handler follows only conflicted drafts (round 8's rule) | 3: `R8 ownership …`, `R8 simultaneous keys …`, `R8 both clean editors racing their first key …` |
| the editor is not read-only for a window that does not own the draft | 7 |
| the card is not read-only for such a window | 4 |
| a window that does not own the draft may settle a conflict (`ownedElsewhere` out of the effect) | **none** |
| that, and `mayWrite` | the 7 of `mayWrite`; **neither `R8-3` test** |
| a rejection drops the hand-typed merge | 2: `R8-2 a hand-typed merged title/step survives rejection` |
| `sentMerge` is not stored with the draft | **none** |
| a hand-typed merge is not "later text" (`hasTypedMerge` out of `laterMerge`) | **none** |
| both of the last two | 2: `R8-2 a hand-typed merged title/step survives lost reply then reload` |
| `hasTypedMerge` is always true | 1: `R8-2 choosing a side after replacing a hand-typed field keeps the original draft on rejection` |
| "Take over here" keeps the former owner's `sent` request | **none** |

What follows:

- Every test in the file fails with some fix removed, **except `R8-3 a nonowner in read mode cannot release a
  merge while the owner's reply is held`**: it fails on round 8's code, and passed under all seventeen removals
  here. The `in the editor` variant fails only when a second window can write or claim the draft at all. So
  R8-3's named fix (only the owning window settles a conflict) is not pinned on its own: with it and `mayWrite`
  both removed, both tests pass, held by the other layers. The route itself is closed on this revision (my
  probe, 4 of 4 with the reply held).
- R8-2's lost-reply route rests on two mechanisms and its tests need only one of them. That is how R9-1 got in:
  the clause that causes it can be removed with all 18 tests passing.
- No test in the file makes a merge that the server combines with a newer change in another field (R9-1), and
  no test opens a conflicted draft from a window that arrived some other way than the case's URL (R9-2, R9-3).
- Clearing `sent` on "Take over here" is not pinned by any test here.

Earlier two-window tests that were rewritten: I read the changes to `round4`, `round5`, `round6` and
`round7.test.ts`. None was rewritten into something that cannot fail by reading: each still ends on a server
version or a stored draft (`R4A-2`: version 1 after A's Escape, then version 2 with A's title and B's step;
`R6-3 new tab`: "Resolve conflict" disabled, then the merge after the button; `R7-1`: read-only after the
rejection until the button). I did not run those files or remove fixes under them. Note `R6-3 a stored conflict
resolved elsewhere preserves hand-typed card text on return` now expects "later text is kept" for a typed merge:
right when the question was merged elsewhere, and the same clause as R9-1 when it was the person's own merge.

## Worth doing later

- R9-4. A window whose merge request arrives after another window's merge of the same question shows the
  server's sentence as its status: `an adopted edit is undone by restoring the earlier version, which keeps both
  in the history` (`merge "merge request held, B resolves first"`).
- After the other window records the draft, the former owner's status is `Conflict resolved in another window.
  The recorded version is shown.` though there was no conflict (`second`, `proposal`, `gone`).
- The line appears twice in the pane of a read-only editor (`line 2`: once above the card, once in the editor).
- After "Take over here" the keyboard focus is nowhere: in `typing`, ` B1 B2 B3` typed in B straight after the
  click went to no field (4 of 4). A click in a field first, and typing works.
- After "Take over here" the new owner's draft keeps the old base and loses `sent`. When the former owner's last
  proposal was recorded in the meantime and both touched one field, the new owner's leave meets a conflict with
  the person's own version (`gone "reloaded, B's editor open"`: a card, `Q-4`, all text in it). Different fields
  merge without a card (`proposal`).
- A new window opened on the suite list opens the device's active draft read-only, though the URL names no case.

## Mistakes in my own method

- `pkill -f` matched my own shell once and stopped a command before it edited anything; I ran it again.
- A shell line ran two probes in the foreground and hit the tool's time limit; they finished in the background
  and their logs are whole.
- The first `merge` probe assumed a window that only shows the case has a card; it has none (R9-3). I changed
  the probe to open B's editor first and added the reading variant; the first run's log was overwritten.
- `both "same moment"` round 2: no word was typed in the owner window and none was refused; the click on the
  field was swallowed by my probe's `catch` while two suites of fix removals were running. Repeated alone (`logs/r9-both-same-moment.again.log`), 2 of 2: `typeErrors []`, `editableWindows 1`, the owner's word taken (`Open the cart TB`), `v2 … Open the cart TB …`.
- `merge "merge request held, B resolves first"` round 1 stopped on the same kind of click (`Timeout 2000ms`),
  so that variant has one run.
- Fix removals and probes ran at the same time (two to six processes). No probe result differs between its two
  rounds except by the window ids and the points above.

## Not checked

- A real "Duplicate tab", a tab discarded or frozen by the browser, a crashed tab (no `pagehide`), a second
  browser profile or device, a headed browser, any browser other than headless Chromium.
- A window opened less than 40 ms before a busy owner answers (`initializeDraftOwners` waits 40 ms): by reading,
  the new window would claim the draft and the owner would turn read-only on its next key, with the text in the
  stored draft. Not run.
- The owner signing out through the UI (I found no sign-out control in `src/web`; the probe posted to
  `/api/logout`).
- Take over during a merge that meets a newer version; three windows with a conflict; a capture (a new case's
  draft) taken over while its first proposal is held.
- R9-1 with the colleague's second change in the preconditions, tags or a step's expected result, and after a
  lost reply with a second press.
- `ui-r7/probes/a/r7.ts settled-while-closed` beyond the comparison; `probes/b/` (Queue and run cockpit).
- The whole browser suite, by instruction; the earlier round test files were read, not run, except
  `round6.test.ts` on the scratch copy of the fix.

## Cleanup

No server, browser or probe of this review is running, and nothing of mine listens on 8950 to 8999. The round-8 test
file and the fix removals started their servers in the suite's own range (7400 to 7449 by `SHELL.md`), one or two files at a
time, while another agent's parallel check was running there; none of my runs failed for a port. `/tmp/mainworthy-ui-r9`,
the scratch copies (`mut/`) and `tree/node_modules` are removed (run `bun install --frozen-lockfile` in `tree/`
to rerun a probe). Kept: `REPORT.md`, `probes/`, `logs/`, `shots/` and the export in `tree/`. The repository
checkout was only read (`git archive`, `git show`); no release or clean-up command was run in it. When I finished
(15:55) it had uncommitted changes under `docs/reviews/`, made by someone else; I judged the export of the commit only.
Time taken: 25 minutes.

ISSUES (1 blocker)

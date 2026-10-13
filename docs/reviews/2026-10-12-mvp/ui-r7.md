# Mainworthy web UI: independent verification, round 7 (re-check of round 6's four findings)

Revision judged: `1fb4c0eb2e1958698c523e04d31724368d46a641`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's author (GPT 6.1 Sol).

Status: **complete** (see "Not checked"). Nothing in the repository was changed; it was read with `git archive`,
`git diff` and `git log` only. While I worked the branch was rewritten into thirteen commits (head `dbb35d5`);
`git diff --stat 1fb4c0e dbb35d5 -- src/web test/e2e src/surfaces/http.ts` is empty, so the code in scope is the
same there. I judged `1fb4c0e` only.

## Result in short

All four round-6 findings are fixed on the routes round 6 reported, twice each, and each has a test that fails
without its fix. The new design holds where one window knows about the conflict: every kind of input on the
frozen editor is refused with the text unchanged, text typed while the conflict reply was held is in the card and
in the merge, the freeze ends with the card, and a reload, a new tab, a duplicated tab and a sign-out all bring
the card back with one question.

One blocking defect is new on this revision (R7-1). The conflict is now stored with the draft, but each window
reads it only once, when the Suite screen loads. A window that does not know about the conflict opens the same
draft in an editor with no card that takes text, and never proposes it. That text is then deleted: by "Resolve
conflict" in the window that has the card, or by the next reload. Two routes reach it, one with two windows and
one with a single window. On round 6's revision the two-window route recorded the text.

Three more things do not block (R7-2 to R7-4).

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision, by one defect** (R7-1: text typed in an editor is lost on reload, and deleted
under "Conflict resolved.", when another producer changed the same thing). It holds on every other route I ran.

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium`
  (`--headless=new --ozone-platform=headless`), real server processes on 127.0.0.1, ports 8950 to 8999, data under
  `/tmp/mainworthy-ui-r7`. The authors' suite ran unpatched on its own ports.
- Round 6's probes copied into `probes/a/` and `probes/b/` with only paths changed. `probes/a/r6.ts
  choice-then-type` and `two-fields` were adapted: they also record the status line, the focus and the caret after
  the keys, because the right outcome is now a visible refusal. New probes: `probes/a/r7.ts`, `probes/a/r7b.ts`,
  `probes/a/r7-person.ts`, `probes/b/r7-run.ts`. Run from `tree/` as `bun ../probes/<a|b>/<name>.ts <scenario>`.
- Logs in `logs/`: `a6-*`, `a4-*`, `a5-*`, `b-*`, `b4-*`, `b6-*` are earlier rounds' probes on this revision;
  `a7-*`, `a7b-*`, `b7-*` are mine. Where a name ends `.1.log`/`.2.log` those are two runs; my `a7*` probes run
  each scenario twice inside one log ("round 1", "round 2"). `probes/pp.py <width> <log>` prints a log readably.
- Every probe drives the real UI with trusted key events and reads the server through its API. Held, failed and
  lost replies are injected at the browser (`page.route`).
- One probe was also run against round 6's revision `67ebacc` (export in `r6tree/`, removed afterwards;
  `logs/a7-second-window.r6-revision.log`) to tell a new problem from an old one.
- Mutations: `probes/mutate7.py` removes one fix at a time in a scratch copy (`mut/tree`, removed afterwards) and
  runs the authors' test for it (`logs/mutations.log`).

## Findings re-checked

| Finding | Verdict | What ran and the deciding lines |
| --- | --- | --- |
| R6-1 text typed in the editor after a choice in the card is left out of the merge and deleted | **fixed, with a new problem** (R7-1, blocks) | `a/r6.ts choice-then-type`, all nine variants (round 6's six and its three controls), and `two-fields`, three variants, 2 of 2 each (`logs/a6-choice-*.log`, `logs/a6-two-fields.log`). "Use all my changes", then keys in step 2: `editorBeforeKeys {title "Coupon case mine", step2 "Apply the coupon"}` → the same after the keys; `statusAfterKeys "Resolve the conflict first. Edit the merged fields in the conflict card; other fields can be edited after it is resolved."`; `focus TEXTAREA[b2:action] caret 16/16 readOnly true`; `decide Q-3 merge title "Coupon case mine" steps ["Open the cart","Apply the coupon"]`; `server {version 3, title "Coupon case mine"}`, `storage []`, `questions []`, the same 34 s later. "Keep current version" and "Use current title": `version 2, "Coupon case theirs"`, nothing typed after the choice was accepted. `two-fields`: `editorStep1 "Open the cart"`, `editorStep2 "Apply the coupon MINE"` unchanged, recorded `["Open the cart","Apply the coupon, merged by hand"]` / `[…,"Apply the coupon THEIRS"]` / `[…,"Apply the coupon MINE"]` |
| R6-2 "Conflict resolved." when the merge met a new conflict | **fixed** | `a/r6.ts moved-under-card` twice and `moved-detail` twice (`logs/a6-moved-*.{1,2}.log`), `a/r7.ts moved` (`logs/a7-moved.log`, four variants, 2 of 2). Same field: `reply "status":"decided" "status":"conflict" "adopt":"Q-5"` → `status "Nothing was adopted: the case changed again. Your draft is kept. Resolve the new conflict in the card."`, `cards 1`, the card reads `Your draft Coupon case, merged by hand … Current version Coupon case theirs, changed again`, the stored draft carries `conflict Q-5`; "Resolve conflict" again: `version 4, title "Coupon case, merged by hand", steps […,"Apply the coupon SAVE10"]`, `questions []`, `storage []` |
| R6-3 a reload under a card proposes again and leaves the first question open | **fixed** | `a/r6.ts reload-card` twice (`logs/a6-reload-card.{1,2}.log`, 4 of 4): one `propose … base 1`, one `decide Q-4 merge`, `questions open []`. `a/r7.ts reload-card` (`logs/a7-reload-card.log`), reload, new tab, duplicated tab and the list URL, 2 of 2 each: `back {cards 1, readOnly true, mergedTitle "Coupon case, merged by hand"}` (the text typed in the card before the reload), keys refused, `left {cards 1, questions ["Q-4 open"]}`, after resolving `version 3, title "Coupon case, merged by hand"`, `questions []` |
| R6-4 a step mark shown at Enter is not sent | **fixed** | `b/r5-run.ts mark-after-pass` twice, `b/r6-run.ts mark` twice (`logs/b-mark-after-pass.{1,2}.log`, `logs/b6-mark.{1,2}.log`), report +1500 ms: `atEnter hint "Step 2 marked. …"`, `requests ["C-1:pass","C-1:fail@s2(meant to fail at two) corrects 1"]`, `results ["fail@s2(meant to fail at two)","pass()"]`. With a fast reply the hint shows no mark at Enter and no step is sent |

## What the change of design could have broken next to it

Each line ran twice with the same result.

**The freeze** (`a/r7.ts`, `a/r7b.ts`, `a/r7-person.ts`):

| Check | Result |
| --- | --- |
| Text typed between leaving the editor and the conflict reply, the reply held 1 s and 3 s, in a step and in the conflicting title (`held`, 8 of 8) | holds: the card's diff shows `~ Apply the coupon typed while waiting`; `Your draft Coupon case mine and more while waiting`, `mergedTitle` the same; recorded `version 3 … "Apply the coupon typed while waiting"` / `title "Coupon case mine and more while waiting"`, `storage []` |
| Every kind of input on the frozen editor (`frozen-keys`): a letter, Space, Backspace, Delete, Enter, Shift+Enter, Ctrl+Enter, Ctrl+Backspace, Ctrl+V with text on the clipboard, Ctrl+X, Ctrl+A then a letter, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Alt+Up, Alt+Down, text committed with no key event (as an input method does), a paste event with tabs and new lines, a drop of text | holds for the text: `before` and `end` are the same (`same true`), each key `nothing changed`, and after the merge `server {version 3, title "Coupon case mine", steps ["Open the cart","Apply the coupon SAVE10"]}`: nothing refused turned up later. The properties are `disabled`. Two keys move something: see "Worth doing later" (Tab, Ctrl+Z) |
| A drag of a step and the step buttons | nothing to drive: the editor has none on this revision (`buttons in the editor: []`) |
| The freeze ends after "Resolve conflict" (`freeze-ends resolved`) | holds: `at "after", cards 0, readOnly false, took true`; the later text recorded as `version 4` |
| The other side rejects the conflict with the card open | holds: `The conflict proposal was rejected. Your current draft is kept; …`, `cards 0`, the editor takes text, the next leave proposes again, a new card with that text, resolved to `version 3 … ["Open the cart Z","Apply the coupon SAVE10"]`, `questions []` |
| The person rejects their own proposal with `r`, `r` (round 4's `conflict-reject-ui`) | holds: the card is gone, the editor takes text, a new card after the next leave, `version 3 … "Apply the coupon SAVE10"` |
| The merge request fails before it reaches the server | holds: `Failed to fetch. Your draft and conflict card are kept.`, `cards 1`, still frozen; the second press resolves, `version 3` |
| The merge reply is lost (the server recorded it), "Resolve conflict" pressed again | nothing lost, a dead card until a reload: R7-4 |
| Escape with a card open; away to another case and back; `c` and a new case; the editor of another case; the palette (`others`, `read-mode`) | hold: Escape keeps the card and the editor (`cards 1`, focus to the list); `C-3 Captured while a card is open`; `C-2 … edited under a card elsewhere v2`; back on C-1 `Draft kept on this device. Press e to continue.`, `e`: `cards 1, readOnly true`; the palette takes the keys (`focus INPUT[Jump to or run]`) and gives the focus back to the field, the card intact; a tag set with `t` goes to the server (`tags ["smoke"]`) and leaves the draft alone |
| The session ends, the same person signs in again (`r7-person same`) | holds: `aliceBack {cards 1, readOnly true}`, the card's hand-merged title kept, `version 3, title "Coupon case, merged by Alice"`, `open []` |
| Another person signs in on the device, edits the case, then the first comes back (`r7-person other`) | holds: Bob sees `cards 0`, his own fresh editor (`title "Coupon case theirs"`), `v3 by bob`; Alice's key `mainworthy:alice:draft:scratch:C-1 … Q-3` untouched; Alice back: `cards 1, readOnly true`, resolved to `v4 by alice`, title `Coupon case, merged by Alice`, Bob's step kept |
| **A second window that was open before the conflict** (`second-window`) | **fails: R7-1** |
| **The question settled elsewhere while the page was opened on another case** (`route2`, `settled-while-closed … /c/2`) | **fails: R7-1** |
| The question rejected while the page was closed, the page opened on the case (`settled-while-closed rejected … /c/1`) | the card is released and the editor takes text again, but the draft is replaced: R7-2 |

**R6-2's neighbours** (`a/r7.ts moved`): the other side changes another field: `Conflict resolved.`, `version 4`,
both changes. The same field twice before the merge: one new card against `Coupon case theirs, changed a third
time`, resolved to `version 5`. The same field again under the new card: a third card (`Q-7`), resolved to
`version 5`; `questions open []` each time. The editor is frozen under each new card.

**Rounds 4 and 5's conflict probes** (`logs/a4-*.{1,2}.log`, `logs/a5-*.{1,2}.log`), twice each: `conflict-more`
(the keys after the card are refused: `stepFieldBeforeLeaving "Apply the coupon"`, `version 3`, `storage []`),
`conflict-variants`, `conflict-after-failure` (`cardMySide "Your draft Coupon case mine and the rest of my
sentence"`, `version 3`), `conflict-elsewhere` (reject: card gone, draft kept, `version 3`; accept: refused by
the server, the card resolves), `conflict-reject-ui`, `orphans` (one question, none left), `closed-edit-more`
(`adopted`, `adopted`, `version 3`, `cards 0`), `card-choice`, `card-edit`, `dup-tab` (two window ids; the same
field: a card in B with B's text, frozen; different fields: `version 4`). All right under the new design.

**R6-4's neighbours** (`b/r7-run.ts`, 18 orders, `logs/b7-mark.{1,2}.log`; round 4's `new-run.ts`): every order
`verdict "ok"`: the step in each failure request is the one the hint showed at its Enter.

| Keys | Report +1500 ms |
| --- | --- |
| `2 p k f` note Enter | `hint "Step 2 marked. "` → `C-1:fail@s2(seen it) corrects 1` |
| `2 f` note Enter `k f` Enter (a mark before a slow fail) | both Enters show `Step 2 marked.` and the note; `C-1:fail@s2(seen it)`, `C-1:fail@s2(seen it) corrects 1` |
| `2 f` note Enter `k p` (R4B-8) | `C-1:pass corrects 1`: no note, no step |
| `2 Escape f` note Enter; `2 Backspace f` note Enter | no mark shown, `C-1:fail(seen it)` |
| `2 p k Escape f` note Enter | no mark shown, `C-1:fail(seen it) corrects 1` |
| `2 p k Backspace 3 f` note Enter | `Step 3 marked.` → `C-1:fail@s3(seen it) corrects 1` |
| `p k 2 f` note Enter (a mark after the pass) | `C-1:fail@s2(seen it) corrects 1` |

`new-run.ts orders`: 10 of 10 `"verdict":"ok"` in both runs; `step-mark`, `step-pass`, `refail-pace` as in round 6.

## The authors' suite

`bun test test/e2e`, unpatched:

```text
run 1: 189 pass, 1 skip, 0 fail, 855 expect() calls. Ran 190 tests across 20 files. [298.37s]   (logs/e2e-1.log)
run 2: 188 pass, 1 skip, 1 fail, 849 expect() calls. Ran 190 tests across 20 files. [337.31s]   (logs/e2e-2.log)
run 3: 189 pass, 1 skip, 0 fail, 855 expect() calls. Ran 190 tests across 20 files. [291.10s]   (logs/e2e-3.log, nothing running beside it)
```

The one failure, in run 2: `R3B-2 the first queue cursor survives a new question and settlement elsewhere`
(`test/e2e/round3-interactions.test.ts:100`, `TimeoutError: waitForFunction: Timeout 5000ms exceeded`). The queue
screen is not touched by this change, and about twenty of my probe processes, each with its own browser and server, were running beside that run (load
average 14 on 16 cores). The file alone, three times: `21 pass 0 fail` each (`logs/e2e-r3b2-alone.log`). I count it as a
test that is flaky under load, caused by me; runs 1 and 3 are the ones to read. The one skip is R5B-4's.

`bunx tsc --noEmit`: exit 0. `bunx biome check src/web test/e2e`: `Checked 61 files in 64ms. No fixes applied.`
`bun test test/architecture.test.ts`: `12 pass, 0 fail`.

## Defects

### R7-1: A window that does not know about a stored conflict opens the draft in an editor with no card that takes text; the text is never proposed, and is then deleted under "Conflict resolved." or by the next reload

Blocks: **yes**, by the brief's rule (input is lost without the person being told; the screen says "Conflict
resolved." and "Your current draft is kept" for text that is nowhere). New on this revision. Two routes, each
2 of 2 in every variant (`probes/a/r7.ts second-window`, `probes/a/r7b.ts second-window` and `route2`;
`logs/a7-second-window.log`, `logs/a7b-second-window.log`, `logs/a7b-route2.log`, `logs/a7-settled-while-closed.log`;
`shots/r7-1-*.png`, `shots/r7-route2-*.png`).

The cause. The conflict now lives in three places: in the stored draft (`draft.conflict`), in each window's
`conflicts` map, and in the `conflict` state. The map is filled once, when the Suite screen loads
(`initialConflicts` in `src/web/suite/index.tsx`), and by that window's own `storeConflict`. The freeze and the
card follow the map (`change()`, `edit()`, `choose()`); the refusal to propose follows the stored draft
(`sealDraft`: `if (snapshot.ref && (snapshot.conflict || …)) return;`). A window whose map lacks the case
therefore opens the draft unfrozen, takes text, writes it into the stored draft beside the conflict, and sends
nothing when the person leaves. Then one of two things deletes it: `resolveConflict` in the window with the card
removes the stored draft because its `conflict.q` and `conflict.merged` match, without looking at its body; or
the next load finds the question settled and `forgetRequest(id, true)` replaces the draft's body with
`conflict.merged`.

**Route A: two windows.** Both on the Suite screen (the case or the list). In A: `e`, type ` mine` in the title;
a colleague records the title `Coupon case theirs`; Escape: the card, in A. In B: `e` on C-1, type ` typed in
window B` in step 2, Escape. In A: "Resolve conflict". Reload B.

```text
B, e:        cards 0, readOnly false, title "Coupon case mine" (A's draft)
B, typed:    step 2 "Apply the coupon typed in window B"; stored "Coupon case mine | Open the cart / Apply the coupon typed in window B | conflict Q-3"
B, Escape:   requests []; status "Drafts stay on this device. A version is recorded when you leave, press ⌘↵, or pause for 30 seconds."
             pane "Draft, saved on this device"
A, Resolve:  decide Q-3 merge "Coupon case mine" ["Open the cart","Apply the coupon"]
             status "Conflict resolved. Both earlier versions remain in the timeline."; stored []
             server "v3 Coupon case mine | Open the cart / Apply the coupon"
B, reload:   status "The conflict proposal was answered elsewhere. Your current draft is kept; leave the editor to propose it afresh."
             step 2 "Apply the coupon"
```

` typed in window B` is in no version, not on the device and not on the screen. If B is reloaded first, B shows
the card over an editor that holds the text (`readOnly true`, step 2 `Apply the coupon typed in window B`), the
card's own draft side does not have it, and "Resolve conflict" in B sends `["Open the cart","Apply the coupon"]`
and says "Conflict resolved." Without a reload, B has no card at all and the question stays open.

How wide: B must have had the Suite screen loaded before the conflict arose. A window that was on the Queue and
moves to the Suite afterwards gets the card and is frozen (`logs/a7b-second-window.log`, third variant). On
round 6's revision the same keys record the text: `B propose … "Apply the coupon typed in window B"` → a card in
B → `version 4 … "Apply the coupon typed in window B"` (`logs/a7-second-window.r6-revision.log`).

**Route B: one window.** A card on C-1. The page is opened again on another case (a reload there, or the app
opened at `/suite/c/2`). The conflict's question is rejected meanwhile (from the Queue, another window or the
API; in the probe, by the same person). Click C-1, `e`, type in step 2, Escape, reload.

```text
on C-1:      status "The conflict proposal was rejected. Your current draft is kept; leave the editor to propose it afresh."
             stored "Coupon case mine | Open the cart / Apply the coupon | conflict Q-4"      (the conflict is still in the stored draft)
e, typed:    cards 0, readOnly false, step 2 "Apply the coupon typed after the rejection"
Escape:      requests []          (the status line still says leaving proposes it afresh)
reload:      status "The conflict proposal was rejected. Your current draft is kept; …"
             step 2 "Apply the coupon"; stored "Coupon case mine | Open the cart / Apply the coupon | no conflict"
```

Here `forgetRequest` returns early because this window has no live copy of the draft (`liveDrafts` is empty
after the load), so the map and the state are cleared and the stored draft keeps its conflict. No choice in the
card is needed; after "Keep current version" the reload also puts the other side's title into the draft.

Promise contradicted: "nothing typed is lost on reload … or when another producer changed the same thing";
"every optimistic change either becomes the server's record or is rolled back visibly". The brief's own test for
this round: "nothing is deleted under 'Conflict resolved.' that the server does not hold".

How it weighs, said plainly: both routes need more than round 6's "choose, then type". Route A needs a second
window already on the Suite, and the person editing the conflicted case there. Route B needs an unresolved
conflict, the app opened on another case, and the question rejected in between. I rate it a blocker because the
text is taken by an ordinary editor under "Draft, saved on this device" and is then removed with a success
message; if the owner weighs both routes as unusual, the count drops to none.

Smallest fix: let the draft that is being opened decide. Where a draft is loaded (`edit()`, `choose()`, the route
effect, the initial state) take the conflict from `saved.conflict` as well as from the map, and put it in the
map; pick up another window's change with a `storage` event. Make `forgetRequest` clear the stored draft's
conflict even when the window has no live copy. And keep the two destructive steps honest: after a merge remove
the draft only if its body is still the conflict's `mine`, otherwise keep it as a draft; never replace a draft's
body with `conflict.merged` when the body differs from `mine`. Tests: route A and route B above, expecting the
text on the server or still in the draft.

### R7-2: When the conflict's question is settled elsewhere, the draft is replaced by the card's merged body, under "Your current draft is kept"

Blocks: **no**, and the lead may weigh it differently. `a/r7.ts settled-while-closed` (`rejected, opened at
/p/scratch/suite/c/1`), `a/r7b.ts route2 "Keep current version"`.

`forgetRequest(conflict.draftId, true)` puts `conflict.merged` into the draft. With no choice made that is the
person's own text for the fields in conflict, so nothing is lost. After "Keep current version" or "Use current
title" (pressed, not yet confirmed with "Resolve conflict") it is the other side's text:

```text
before:  draft "Coupon case mine", step 2 "Apply the coupon SAVE10"; "Keep current version" pressed; page closed; Q-4 rejected
opened:  status "The conflict proposal was rejected. Your current draft is kept; leave the editor to propose it afresh."
         editor title "Coupon case theirs", step 2 "Apply the coupon"; stored the same, no conflict
```

The person did choose the other side, which is why this does not block. But the choice was still reversible
("Use all my changes" was one click away), the merge was never recorded, and the line on the screen says the
draft is kept. Fix: on a rejection keep the draft's own body and drop only the conflict; or keep the merged body
only when the draft's body equals the conflict's `mine` and say which was kept.

### R7-3: A window left behind after the conflict was resolved elsewhere proposes the recorded text again and reports "Version 1, by you, just now"

Blocks: **no**. `a/r7.ts reload-card "duplicated tab"`, `second-window`, `freeze-ends "merge reply lost"`.

After the conflict is resolved in another window, the window that still had the card says `The conflict proposal
was answered elsewhere. Your current draft is kept; leave the editor to propose it afresh.` and writes the draft
back to the device with the merged body. Leaving proposes it on the old base:

```text
A propose … base 1 "Coupon case, merged by hand" …      reply "status":"adopted"
A status "Version 1, by you, just now"      server {version 3, title "Coupon case, merged by hand"}
```

Nothing is lost and no question is left open, but the page asks the person to propose what is already recorded,
calls their own merge "answered elsewhere", and the status names version 1 while the head is version 3. Fix:
when the question was decided with a merge and the head equals the draft, drop the draft and say it was
resolved.

### R7-4: After a lost merge reply the card can only be cleared by a reload

Blocks: **no** (nothing is lost, and the page says what to do). `a/r7.ts freeze-ends "merge reply lost"`, 2 of 2.

```text
first press:   status "Failed to fetch. Your draft and conflict card are kept."   server version 3 (the merge was recorded)
second press:  status "This conflict was answered elsewhere. Your draft is still kept. Reload to continue from it."
               cards 1, readOnly true      (the editor stays frozen under a card that cannot be resolved)
reload:        "The conflict proposal was answered elsewhere. Your current draft is kept; …", cards 0, the editor takes text
```

The brief asks that the editor never stays frozen with no way on; here the way on is the reload the message
names. Fix: when the question is found decided on the second press, release the card there (as the page does when
the question is settled while the card is open) and compare the head with the merge that was sent.

## The tests do not prove this

Judged by removing one fix at a time in a scratch copy (`probes/mutate7.py`, `logs/mutations.log`; the unchanged
copy first: 14 and 7 pass, 0 fail).

| Fix removed | Authors' test | Result |
| --- | --- | --- |
| The editor is not frozen under a card (the read-only flag and the guard in `change()`) | `R6-1 … refuses later editor input visibly without moving focus` (2); `N-1 conflict preserves … choice while later editor input is refused` (4, `round5.test.ts`) | 6 fail (`Expected: "My title"`, `Received: "My title AND MORE"`; `Expected: "Apply the coupon"`, `Received: "Apply the coupon SAVE10"`) |
| Only the guard in `change()`; only the read-only flag | the same six | **pass** each time: the two layers cover each other, so neither alone is tested |
| The card is built from the request that was sent | `R6-1 a held conflict reply includes every character typed before it arrives` | fails |
| A merge that met a newer version is read as resolved | `R6-2 a merge meeting a newer head keeps the draft and opens the replacement card` | fails |
| The conflict is not read back from the stored draft | `R6-3 …` (5) | 5 fail (`Expected: 1`, `Received: 0`) |
| The mark shown at Enter is not sent when an earlier result used it | `R6-4 a step mark visible at Enter is sent behind a slow earlier pass` | fails |
| A failed request behind a later write does not release the note | `R5B-1 a failed note request behind a later write releases the note for the next shortcut` (new) | fails (`Expected: "wrong total"`, `Received: undefined`); round 5's two `R5B-1` tests still pass, as round 6 said |
| The card takes changes while its merge is on the way | `R6-1 a pending merge visibly refuses changes to its card until the reply arrives` | fails |
| A lost merge reply is not remembered | `R6-2 a lost reply keeps the draft and card for retry` | fails |
| A new window always keeps a stored request, its owner live or not | `N-3 two live windows never share a pending existing-case request` | fails (`Expected: not "5db71a6d-…"`) |
| The draft is removed after a merge whatever the stored draft holds | all thirteen `R6-` tests | **13 pass** |

So every new test in `test/e2e/round6.test.ts` fails with its fix removed. The three tests round 6 named now
prove their claim: `N-1 … mine choice` and `all choice` assert the refusal and fail without the freeze; `N-3 two
live windows …` checks every command the second window sent and fails without the liveness check; the release of
a note after a failed request has its own test, which fails without it.

Gaps:

- No test opens the conflicted case in a window that did not see the conflict arise, or settles the question
  while the page is on another case (R7-1).
- The condition under which "Resolve conflict" removes the draft has no test: all thirteen pass with it
  replaced by `true`. It is also the wrong condition (R7-1 route A), so a test is the way to find the right one.
- No test reads the draft's text after a conflict was settled elsewhere with a choice already made in the card
  (R7-2), or the status after the left-behind window proposes again (R7-3).

## Worth doing later

- Tab in the frozen editor is not refused: it moves the focus out of the field (`focus SUMMARY[]` from step 2;
  Shift+Tab to step 1), while the hint under the steps still offers `Tab` for the expected result. It is the
  browser's own Tab, a key, and changes no text.
- Ctrl+Z in the frozen editor changes no text and moves the caret to the start of the field (`16/16` → `0/16`).
- Under a frozen editor the key bar still offers `⌘enter Record version` and the hint under the steps still
  offers Enter for the next step (`shots/r7-frozen-1.png`); both are refused or do nothing there.
- In route A's window B, and in route B after the rejection, the status line promises a version on leaving and
  nothing is sent (part of R7-1; worth its own message even after the fix, wherever a seal is refused).
- An error reply to the merge that is not in the server's shape is printed raw in the status line, in front of
  "Your draft and conflict card are kept." (my own fabricated 500, see below).

## Mistakes in my own method

- The second full run of the suite ran beside about twenty of my probe processes; its one failure is mine to explain (see
  "The authors' suite"). A third run was made with nothing beside it.
- `settled-while-closed "merged elsewhere"` sent a merge body the server refused (`status "invalid"`), so that
  variant is in fact "the question still open, the page opened again": the card comes back, on the case and from
  another case (`cards 1, readOnly true`). A question merged elsewhere was driven instead by the duplicated tab
  and by the lost reply followed by a reload.
- `freeze-ends "merge answered with an error"` fulfils the request with a body I made up; the status line then
  shows a validation dump. It shows that the card and the draft are kept, not what a real server error looks like.
- In `frozen-keys` the status line already held the refusal when most keys were pressed, so the log proves the
  message for the first key and "nothing changed" for the rest, not a fresh message per key.
- My adaptation of `two-fields` did not add the status line (the edit did not match); its refusal is shown by
  the unchanged fields and the recorded steps only.
- Headless Chromium never hides a tab. "Two windows" means two pages of one browser context, both visible; a
  "duplicated tab" is a second page opened at the same URL with the first still open.

## Not checked

- Anything outside the four findings and their neighbours: this was a bounded re-check.
- Route B of R7-1 on round 6's revision (only route A was compared; by reading, that revision kept no conflict
  on the device, so a page opened again had none).
- R7-1's first step in a window that was on the list with a filter or a folder open, and with three windows.
- A stored conflict whose question was merged (not rejected) while every page was closed, as its own case.
- Step membership choices in the card ("Use your draft step" for an added or removed step).
- Real input-method composition, a real "Duplicate tab", a headed browser, any browser other than headless
  Chromium, mobile widths, screen readers.
- R5B-4 (left by the authors, its test skipped).
- The non-browser tests other than the architecture test, and the budgets.

## Cleanup

No server or browser of this review is running (nothing listens on 8950 to 8999 or 7400 to 7499).
`/tmp/mainworthy-ui-r7`, the scratch copy for the mutations (`mut/`), the export of round 6's revision (`r6tree/`)
and `tree/node_modules` are removed (run `bun install --frozen-lockfile` in `tree/` to rerun a probe; for the
comparison run, export `67ebacc` into `r6tree/` and link its `node_modules` to `tree/`'s). Kept: `REPORT.md`,
`probes/`, `logs/`, `shots/` and the export in `tree/`. The repository checkout was only read; no release or
clean-up command was run in it, its `node_modules` is in place, and the `/tmp/mainworthy-e2e-*` directories of
other runs were not touched.

ISSUES (1 blocker)

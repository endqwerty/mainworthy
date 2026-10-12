# Casebook web UI: independent verification, round 8 (re-check of round 7's four findings)

Revision judged: `5cc2b3a4c0768ba974d8a37d7b54278371db3600`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's author (GPT 6.1 Sol).

Status: **complete** (see "Not checked"). Nothing in the repository was changed; it was read with `git archive`
and `git show` only.

## Result in short

All four round-7 findings are fixed on the routes round 7 reported, twice each, and every new test in
`test/e2e/round7.test.ts` fails on round 7's code. The new design holds where the windows only look at a
conflict: five windows on one conflicted case all show the card and refuse keys with no reload, the freeze ends
in every window when the conflict ends in one, two windows pressing "Resolve conflict" leave one merge, and
drafts that are not in conflict are untouched.

Three defects are new on this revision. Each was run against round 7's revision too, where the same keys end
with the text recorded or kept.

- **R8-1 (blocks).** Two windows edit the same case. Text typed in the second window's editor is deleted from
  the device and the screen when the first window's proposal meets a conflict. No key, no reload, 2 of 2.
- **R8-2 (blocks by the brief's rule; narrower).** Text typed by hand into the card's "Merged" box is deleted
  when the question is rejected by the other side, or after a lost merge reply followed by a reload. The status
  line says the draft is kept, or that the conflict is resolved. 2 of 2 each.
- **R8-3 (blocks by the brief's rule; needs a slow reply).** With two windows on the case, a merge that meets a
  newer version, and a slow reply in the merging window, the page brings back the text from before the merge as
  "your later text", and leaving the editor records it over the merge just made. 4 of 4 with the reply held
  1.5 s; 0 of 10 at normal speed with two windows; 1 of 2 with five windows on a loaded machine.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision**, by R8-1 (text typed in an editor is lost when another producer changed the same
thing) and R8-2 (text typed in the card is lost on a rejection, and on a failed request followed by a reload).
It holds on every other route I ran.

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium`
  (`--headless=new --ozone-platform=headless`), real server processes on 127.0.0.1, ports 8950 to 8974, data under
  `/tmp/casebook-ui-r8`. The authors' suite ran unpatched on its own ports.
- Round 7's probes copied into `probes/a/` and `probes/b/` with only paths changed. New probes:
  `probes/a/r8.ts` (`fleet`, `both-resolve`, `instant`, `neighbours`, `card-text`, `race`). Run from `tree/` as
  `bun ../probes/a/<name>.ts <scenario> [variant]`. `probes/keys.py`, `probes/fleet.py` and `probes/cmp.py` print
  the logs; `cmp.py` compares a log with round 7's log of the same probe.
- Every probe drives the real UI with trusted key events and reads the server through its API. Held, failed and
  lost replies are injected at the browser (`page.route`). In `instant`, window B's `storage` events are held
  back by a capturing listener registered before the application's; `NOHOLD=1` leaves them alone.
- Comparison runs against round 7's revision `1fb4c0e` (export in `r7tree/`, removed afterwards):
  `logs/*.r7-revision.log`.
- Mutations: `probes/mutate8.py` removes one fix at a time in a scratch copy (`mut/tree`, removed afterwards)
  and runs the authors' tests (`logs/mutations.log`). The new test file was also run against round 7's code
  (`logs/round7-tests-on-r7-revision.log`).

## Findings re-checked

| Finding | Verdict | What ran and the deciding lines |
| --- | --- | --- |
| R7-1 route A (two windows) | **fixed, with a new problem** (R8-1, blocks) | `probes/a/r7b.ts second-window` (B on the case, on the list, on the Queue; 2 of 2 each, `logs/a7b-second-window.log`) and `probes/a/r7.ts second-window` (three orders, 2 of 2 each, `logs/a7-second-window.log`), unchanged but for paths. B, `e`: `cards 1, readOnly true, title "Coupon case mine"`; B, keys in step 2: `b2 "Apply the coupon"` unchanged, `status "Resolve the conflict first. Edit the merged fields in the conflict card; other fields can be edited after it is resolved."`, `stored … conflict Q-3`; Escape: `requests []`, the card stays. Resolve in A: B shows `cards 0`, `Conflict resolved. Version 3 is recorded; both earlier versions remain in the timeline.` with no reload, `stored []`. Resolve in B (with and without a reload first): `B decide Q-3 merge`, `version 3`, `questions open []`. Nothing is taken by B's editor after the conflict, so nothing is lost there. What B typed **before** the conflict is lost: R8-1 |
| R7-1 route B (one window, the question rejected while the page is on another case) | **fixed** | `probes/a/r7b.ts route2`, no choice and "Keep current version", 2 of 2 each (`logs/a7b-route2.log`). On C-1: `The conflict proposal was rejected. Your current draft is kept; …`, `stored "Coupon case mine … | no conflict"` (round 7: the conflict stayed). `e`, keys: `readOnly false`, `b2 "Apply the coupon typed after the rejection"`. Escape: `propose base 1 "Coupon case mine" [… "Apply the coupon typed after the rejection"]` → a new card (`conflict Q-5`), `readOnly true`. Reload: `cards 1`, the same text in the editor and in the stored draft, `open ["Q-5"]` |
| R7-2 the draft replaced by the card's merged body under "Your current draft is kept" | **fixed, with a new problem** (R8-2) | `probes/a/r7.ts settled-while-closed`, run twice, identical (`logs/a7-settled-while-closed.{1,2}.log`), and `r7b.ts route2 "Keep current version"` 2 of 2. "Keep current version" pressed, the page closed, Q-4 rejected, the page opened on the case and on another case: `status "The conflict proposal was rejected. Your current draft is kept; leave the editor to propose it afresh."`, `stored title "Coupon case mine", steps ["Open the cart","Apply the coupon SAVE10"], conflict null` (round 7: `"Coupon case theirs"`, `"Apply the coupon"`). Leaving sends `propose base 1 "Coupon case mine" ["Open the cart Z","Apply the coupon SAVE10"]`; a new card (Q-5) holds it after a reload. The card's merged body is now dropped in every case, also when it was typed by hand: R8-2 |
| R7-3 the window left behind proposes the recorded text again, "Version 1" | **fixed** | `probes/a/r7.ts reload-card`, four variants, 2 of 2 (`logs/a7-reload-card.log`). Duplicated tab, resolved in the copy; the first window, not reloaded: `aSees {cards 0, status "Conflict resolved. Version 3 is recorded; both earlier versions remain in the timeline.", stored []}`; `e`, Escape there: no request (one `A propose` in each of the eight runs, the one that met the conflict), `server version 3 "Coupon case, merged by hand"`, `questions open []` |
| R7-4 after a lost merge reply the card clears only by a reload | **fixed** | `probes/a/r7.ts freeze-ends`, five variants, 2 of 2 (`logs/a7-freeze-ends.log`). Reply lost: `status "Failed to fetch. Your draft and conflict card are kept."`, `cards 1, readOnly true`, `server version 3`. Second press: no second `decide`; `status "Conflict resolved. Version 3 is recorded; both earlier versions remain in the timeline."`, `cards 0, stored []`; the editor takes ` Z` at once and leaving records `version 4 … ["Open the cart Z","Apply the coupon SAVE10"]`. Text typed in the card between the two presses is kept as a draft and recorded on leaving (`card-text "lost reply, typed, second press"`: `Conflict resolved. Your later text is kept on this device as a draft on version 3.` → `v4 HAND MERGED TITLE`); with a reload instead of the second press it is lost: R8-2 |

## What the change could have broken next to it

Each line ran twice with the same result unless it says otherwise.

**Several windows on one conflicted case** (`r8.ts fleet`, `logs/a8-fleet.log`; five pages of one browser: A saw
the conflict arise, B was on the list, C on the Queue, D on another case, E was opened afterwards at the case's
URL, which is also what a duplicated tab is here):

| Check | Result |
| --- | --- |
| The card and the freeze without a reload, in all five, in all sixteen runs | holds: each `cards 1, readOnly true, took false`, `status "Resolve the conflict first. …"`, the stored draft unchanged |
| A choice or a hand-typed merge in one window's card shows in the others | holds: `mergedTitleSeenInEach` is `"Coupon case, merged in C"` (typed in C) or `"Coupon case theirs"` ("Keep current version" in A) in all five |
| "Resolve conflict" in A, and in C | holds: all five `cards 0`, `Conflict resolved. Version 3 is recorded; …`, `stored []`, one `decide Q-4 merge`; then each window in turn takes a word in step 1 and records it: `v4 … W1` to `v8 … W1 W2 W3 W4 W5`, `questions open []` |
| The other side rejects | holds for the draft: all five `cards 0, readOnly false`, `The conflict ended in another window. Your current draft is kept and editable.` (the window that noticed first: `The conflict proposal was rejected. …`), `stored … no conflict`; A's next leave proposes, a new card, resolved; the others then record on the new head; `questions open []` |
| The person rejects their own proposal with `r` in B | holds: `B decide Q-4 reject`, the same as above in all five |
| A merge that met a newer version | first run holds: the new card (Q-6) in all five, once each (`cards 1, readOnly true`, title `Coupon case, merged by hand`), frozen, resolved from B: `v4 Coupon case, merged by hand`, `stored []`. **Second run fails: R8-3** |
| A lost merge reply in A | holds: the other four notice the recorded merge and release (`Conflict resolved. Version 3 is recorded; …`), A hears it (`Conflict resolved in another window. The recorded version is shown.`); no second `decide`; all five then record in turn |
| B is reloaded, then resolves | holds: `bReloaded {cards 1, readOnly true}`, the other four keep their cards; after B's merge all five `cards 0`, `v3` |

**Two windows both pressing "Resolve conflict"** (`r8.ts both-resolve`, `logs/a8-both-resolve.log`): one after the
other, at the same moment, at the same moment with both replies held 900 ms, and with a merge typed by hand in B
just before A presses. Every run: `decided ["Q-4 accept","Q-3 merge", …]` (one merge), `open []`, `stored []`,
both windows `Conflict resolved. Version 3 is recorded; …`. When both requests went out, the second was answered
`"status":"already"` and that window ended the same way. The hand-typed merge reached A's card before A's press
(`aShows "Coupon case, merged by hand in B"`) and is what was recorded.

**A key typed before window B has heard of the conflict** (`r8.ts instant`, `logs/a8-instant.log`, B's storage
events held back):

| Check | Result |
| --- | --- |
| B opens the editor after the conflict | holds: `cards 1, readOnly true`, the key refused, `requests []` |
| B's editor was open and clean (it showed version 2) | holds: at the key B's editor becomes the stored draft with its card (`title "Coupon case mine"`, `readOnly true`), the key is refused with the message |
| B types in the draft while A's conflict reply is on the way | holds: the text is in the stored draft when the conflict is stored, the card's merge includes it, `v3 … "Apply the coupon typed in B before and during"` |
| **B typed in the draft before A left** | **fails: R8-1** (with the events held and with them delivered) |

**Drafts not in conflict** (`r8.ts neighbours`; round 4's `r4.ts dup-tab`, `windows-capture`, `windows-reload`,
`tabs2.ts windows`): a capture in B that was half typed when the conflict arose in A is recorded whole
(`C-3 Captured in B, first half and second half`); B's edit of C-2 across A's card edits and A's merge is
recorded (`v2 Other case edited in B and more at the end`); `dup-tab` gives the same values as in round 7 (the
same field: a card in B with B's text; different fields: `version 4`); `windows-reload`:
`version 3, steps ["Open the cart from window A","Apply the coupon from window B"]`; `tabs2 windows` same field:
a card in B holding `Coupon case from A and from B`; `windows-capture`: `C-2 Refund is sent to the original
payment method v1`.

**Another person on the same browser** (`r7-person.ts same`, `other`): the same values as in round 7 but for the
wording of the status line (`probes/cmp.py`: 1 of 51 and 1 of 74 values differ, the status).

**Round 7's and earlier probes** on this revision, compared value by value with round 7's logs: `r7.ts moved`
(four variants), `held`, `frozen-keys`, `read-mode`, `others`; `r6.ts two-fields`, `moved-under-card`,
`moved-detail`, `reload-card`; `r4.ts conflict-more`, `conflict-variants`, `conflict-after-failure`,
`conflict-elsewhere`, `conflict-reject-ui`; `r5.ts orphans`, `closed-edit-more`, `card-choice`, `card-edit`;
`r6.ts choice-then-type` (nine variants, 2 of 2 each: 1 of 27 values differs in each, the status wording). The
differences are the new wording (`Conflict resolved. Version N is recorded; …`), an extra first press of `r` in
`conflict-reject-ui` (`Still reading the proposal. Read its edits before answering.`, then the two presses of
round 7; in `fleet` one press was enough, so I take it for the existing reading guard and my probe's pace), and
one intended change: after a merge that
met a newer version the frozen editor and the stored draft now show the merge that was sent
(`Coupon case, merged by hand`) where round 7 showed the text from before it. `held [1000 ms, title]` differed
in one of two runs while my mutation runs loaded the machine (the card was up before the probe typed, and the
text was refused with the message); alone, 4 of 4 as in round 7 (`logs/a7-held-title.again.log`).

## The authors' suite

`bun test test/e2e`, unpatched:

```text
run 1: 201 pass, 1 skip, 0 fail. Ran 202 tests across 21 files. [302.83s]   (logs/e2e-1.log; one probe process beside it at times)
run 2: 201 pass, 1 skip, 0 fail. Ran 202 tests across 21 files. [300.41s]   (logs/e2e-2.log; nothing beside it)
```

No test failed or was flaky. The one skip is R5B-4's, as before.

`bunx tsc --noEmit`: exit 0. `bunx biome check src/web test/e2e`: `Checked 62 files in 54ms. No fixes applied.`
`bun test test/architecture.test.ts`: `12 pass, 0 fail`.

## Defects

### R8-1: Text typed in a second window's editor on the same case is deleted when the first window's proposal meets a conflict

Blocks: **yes** (input is lost without the person being told). New on this revision: on round 7's revision the
same keys record the text (`logs/a8-instant-natural.r7-revision.log`: `B propose … "Apply the coupon typed in B
before KEY"` → a card in B → `v4 … Apply the coupon typed in B before KEY`).

`probes/a/r8.ts instant "B was typing in the same draft before A left"`: with storage events delivered normally
(`NOHOLD=1`, `logs/a8-instant-natural.log`), 2 of 2; with them held back (`logs/a8-instant.log`), 2 of 2.

Two windows on C-1. In A: `e`, type ` mine` in the title. In B: `e` (B's editor opens A's draft), type
` typed in B before` in step 2. A colleague records another title. In A: Escape. Nothing more is pressed in B.

```text
B typed:      stored "Coupon case mine | Open the cart / Apply the coupon typed in B before | no conflict"
A, Escape:    A propose base 1 "Coupon case mine" ["Open the cart","Apply the coupon"] -> conflict Q-3, a card in A
              stored "Coupon case mine | Open the cart / Apply the coupon | conflict Q-3"
B, no key:    cards 1, readOnly true, b2 "Apply the coupon"
              status "Resolve the conflict first. Edit the merged fields in the conflict card; other fields can be edited after it is resolved."
A, Resolve:   server "v3 Coupon case mine | Open the cart / Apply the coupon"; stored []; questions open []
```

` typed in B before` is in no version, not on the device and not on the screen. The message B shows is the
refusal of further input; nothing says the text that was there a moment ago is gone.

The cause. Two steps, each reasonable alone. When A leaves, `sealDraft` writes its own live copy to the device
before it sends (`writeDraft({ project, draft: sending })`), over the stored draft that B owns and that holds
B's text; `storeConflict` then puts the conflict on that body. B still has its text in memory, but the new
`storage` handler (`draftRef.current = saved; setDraftState(saved)`) and the new refusal in `change()`
(`draftRef.current = stored`) both replace the window's live draft with the stored one as soon as the stored one
has a conflict, without comparing the two bodies. Before this revision B kept its live copy and proposed it on
leaving.

How it weighs: two windows editing the same case at once (four deliberate steps: `e` and text in A, `e` and text
in B, Escape in A) and a colleague's change to that case in between. Two windows editing one case is what round
4's R4A-2 and R4A-5 were about, and those still hold when there is no conflict.

Smallest fix: a window never throws away a live body that differs from the stored one. Where the stored draft
gains a conflict under an open editor (the `storage` handler and the refusal in `change()`), keep the window's
text: write it into the stored draft's body beside the conflict (the removal guard already keeps such a body as
"later text" after the merge), or fold it into the conflict's `mine` and `merged`. And `sealDraft` should not
write its copy over a stored draft another live window owns. Test: the route above, expecting ` typed in B
before` on the server or in the stored draft and on B's screen.

### R8-2: Text typed by hand into the card's "Merged" box is deleted when the conflict ends by a rejection, or after a lost merge reply and a reload

Blocks: **yes by the brief's rule** (typed text is lost, and the line on the screen says the draft is kept, or
that the conflict is resolved); the lead may weigh it lower, since both routes need something outside the
person's hands. New on this revision: round 7's revision put the card's merged body into the draft, so the text
stayed on the device and on the screen (`logs/a8-card-text-rejected.r7-revision.log`,
`logs/a8-card-text-lost-reload.r7-revision.log`: `stored "HAND MERGED TITLE | … | no conflict"`,
`hand {device true, screen true}`). That is the behaviour round 7 reported as R7-2 for a body chosen with one
click; the fix drops the card's body in every case.

`probes/a/r8.ts card-text`, 2 of 2 each (`logs/a8-card-text.log`, `shots/r8-card-text-*.png`). One window.

Route A, three steps and another person: a card on C-1; type `HAND MERGED TITLE` in "Merged title"; the other
side rejects the question before "Resolve conflict" is pressed.

```text
typed:     stored "… | conflict Q-3 merged "HAND MERGED TITLE""
rejected:  status "The conflict proposal was rejected. Your current draft is kept; leave the editor to propose it afresh."
           cards 0; stored "Coupon case mine | Open the cart / Apply the coupon SAVE10 | no conflict"
           HAND MERGED TITLE: server false, device false, screen false
```

Route B, four steps and a lost reply: a card; "Resolve conflict", the reply is lost (`Failed to fetch. Your
draft and conflict card are kept.`, the server recorded version 3); type `HAND MERGED TITLE` in "Merged title"
(the card takes it); reload.

```text
reload:    status "Conflict resolved. Version 3 is recorded; both earlier versions remain in the timeline."
           cards 0; stored []; server "v3 Coupon case mine | …"
           HAND MERGED TITLE: server false, device false, screen false
```

With a second press instead of the reload the same text is kept as a draft and recorded (R7-4's fix). The
difference is that the merge that was sent is remembered only in memory (`uncertainMerges`), so after a reload
`finishConflict` cannot tell that the card was edited after it.

Promise contradicted: "nothing typed is lost on reload, on a failed request"; the right outcome named in the
brief ("never removed under 'Conflict resolved.' or 'Your current draft is kept.'").

Smallest fix: when a conflict ends without this card's merge being the recorded one, keep `conflict.merged` if
it differs from both `mine` and `current` (that is, it was edited): as the draft's body with a line that says
so, or beside the draft. For route B, store the body that was sent with the conflict (in the stored draft), not
in memory.

### R8-3: With two windows and a slow reply, a merge that met a newer version brings back the text from before the merge, and leaving the editor records it over the merge

Blocks: **yes by the brief's rule** (the server ends with something other than what the person merged, and the
line on the screen calls the old text "your later text"); it needs a slow reply, so the lead may weigh it lower.
New on this revision (`logs/a8-race-held.r7-revision.log`: `v4 Coupon case, merged by hand`, `stored []`).

`probes/a/r8.ts race` (`logs/a8-race.log`, `shots/r8-race-*.png`): with A's next reply after the merge held
1.5 s, 4 of 4 (B in the editor, and B only showing the case in read mode). Not held, two windows, idle machine:
0 of 10. It also happened unprovoked in one of two `fleet "merge met a newer version"` runs, with five windows
and eight probe processes running.

Two windows show C-1; a card in A. The colleague changes the title again. In A: type `Coupon case, merged by
hand` in "Merged title", "Resolve conflict" (it meets the newer version; a new card), "Resolve conflict" again,
then leave the editor. Nothing is typed after the merge.

```text
1st merge:  A decide Q-3 merge "Coupon case, merged by hand" -> "status":"decided" "status":"conflict" "adopt":"Q-5"
            B: "Conflict resolved. Your later text is kept on this device as a draft on version 3."   (nothing is resolved; Q-5 is open)
            stored "Coupon case mine | … | conflict Q-5 merged "Coupon case, merged by hand" | base 3"
2nd merge:  A decide Q-5 merge "Coupon case, merged by hand" -> adopted; server "v4 Coupon case, merged by hand | …"
            A: "Conflict resolved. Your later text is kept on this device as a draft on version 4."
            the editor is open, editable, title "Coupon case mine"; stored "Coupon case mine | … | no conflict | base 4"
Escape:     A propose base 4 "Coupon case mine" … -> adopted; server "v5 Coupon case mine | …"
```

By reading the code, not run: the same would happen with no key at all after 30 seconds, since an open dirty
draft is recorded on a pause.

The cause. Every window that shows the case watches the conflict's question. When A's merge is recorded as
decided but meets a newer version, the other window sees "decided, merge" and runs `releaseSettledConflict` →
`finishConflict`, which reads it as a merge made elsewhere: the head is not the stored body, so it keeps the
draft, drops the conflict and moves the draft to the head's version. If that lands before A's own
`storeConflict` for the new question, A then finds a draft with no conflict, so the rule that replaces the body
with the merge that was sent does not apply, and the new conflict is stored on the old body. After the second
merge `finishConflict` finds a body that is neither the head nor the conflict's `mine` and keeps it as "later
text". By reading, A wins the race when its reply is fast: it needs one request after the merge, the other window two.

Smallest fix: a decided question whose effect is a new conflict is not a resolution; `releaseSettledConflict`
should leave the draft alone in that case (the decision's effects name the new question), or only the window
that sent the merge should act on it. And `finishConflict` should not call a body "later text" when it equals
the conflict's base-side `mine` from before the merge. Test: the route above with the reply held, expecting
`v4` to stay the head and no draft.

## The tests do not prove this

Judged by running the new file against round 7's code, and by removing one fix at a time in a scratch copy.

`test/e2e/round7.test.ts` against round 7's `src/` (`logs/round7-tests-on-r7-revision.log`): **12 fail, 0 pass**.
On this revision: 12 pass. So each new test fails without the change as a whole.

One fix removed at a time (`logs/mutations.log`; my script's count of passing tests did not parse, so read the
failures; the unchanged copy: 12 pass, 0 fail):

| Fix removed | Tests that fail |
| --- | --- |
| The `storage` listener | `R7-1 storage freezes an already open editor and rejection releases it without a reload`; `R7 removal guard: a late merge reply keeps a fresh draft …`. The two `R7-1 route A … through storage` tests **pass**: they open the editor after the conflict, which reads the stored draft and needs no event |
| The guard in `change()` (the stored draft read at the moment of writing) | `R7 write guard: a conflict stored before its event refuses input in an unfrozen editor` |
| The read-only flag | five, among them both `R7-1 route A` tests and the write-guard test (`Expected: true`, `Received: false`) |
| `forgetRequest` reads the stored draft and not the live copy (route B's named cause) | **none**: `R7-1 route B …` passes. The route is also closed by the editor reading the stored draft when it opens, so the test proves the route, not this line |
| The draft is removed after a merge whatever is stored | `R7 removal guard: a merge reply preserves a stored body that changed since mine`, `R7 removal guard: a late merge reply …`, `R7-4 retry after a lost merge reply keeps text subsequently typed in the card`, and `R6-3 a stored conflict resolved elsewhere releases only the card on return` |
| A settled conflict puts the merged body into the draft | both `R7-2 rejection preserves the draft after unconfirmed …` (`Expected: "My title"`, `Received: "Their title"`) |
| A merge decided elsewhere is treated like any other answer | `R7-3 …` and four more |
| A second press that finds the question gone only says so | both `R7-4` tests |
| The merge that was sent is not compared with the card as it is now | `R7-4 retry after a lost merge reply keeps text subsequently typed in the card` |

Round 7's two gaps:

- The condition under which "Resolve conflict" removes the draft: **closed** (three round-7 tests and one
  round-6 test fail with it replaced by `true`).
- The freeze's two layers covering each other: **closed**. The write-guard test runs with the editor not frozen
  and fails without the guard; five tests assert `readOnly` and fail without the flag. Round 6's `R6-1` and
  round 5's `N-1` tests still pass with either layer alone removed, as before.

Gaps now:

- No test types in a second window's editor before the conflict arises in the first (R8-1). Every two-window
  test opens or types in B after the conflict is stored, or checks that B refuses.
- No test types in the card's merged box and then ends the conflict any other way than by that card's merge or
  a second press (R8-2): no rejection with a hand-typed merge, no reload after a lost reply.
- No test has a second window open during a merge that meets a newer version (R8-3); `R6-2`'s test of that
  merge runs in one window.
- The two `R7-1 route A … through storage` tests do not test the storage event (see the table).

## Worth doing later

- After a rejection the windows that hear of it by the storage event say `The conflict ended in another window.`
  though it ended on the server, by the other side; only the window that noticed first says it was rejected.
- "Keep current version", then "Resolve conflict": `Conflict resolved. Version 2 is recorded; both earlier
  versions remain in the timeline.` Version 2 is the colleague's and was recorded before; nothing of the
  person's is in the head, which is what they chose, but the line reads as if their merge made a version.
- Round 7's list (Tab and Ctrl+Z in the frozen editor, the key bar offering `⌘enter` under a card) is unchanged:
  `frozen-keys` gives the same values as in round 7.

## Mistakes in my own method

- One of my shell loops waited on a process list that matched its own command line and ran until the tool's
  time limit; stopping it also stopped the probes started in that command, which I ran again. No result comes
  from the interrupted run.
- The first run of the suite had one probe process beside it at times; the second had nothing beside it. Both
  are clean.
- My attempt at a question merged from elsewhere with a different body sent a merge the server refused
  (`status "invalid"`), three times, as in round 7; see "Not checked".
- `fleet "lost merge reply in A"` and `card-text "lost reply, typed, a second window shows the case"` show that
  another window releases the conflict within a few hundred milliseconds of the recorded merge, so my probe
  could not type in A's card there (`could not type in the card`); there was no text to lose.
- "Two windows" means two pages of one browser context, both visible; headless Chromium never hides a tab. A
  "duplicated tab" is a second page opened at the same URL with the first still open.
- R8-3's rate at normal speed is from ten runs on an idle machine; I did not measure it under load beyond the
  two `fleet` runs.

## Not checked

- A conflict's question merged from another place with a body other than the card's (the CLI, another device),
  with the card open or the page closed: my API merge was refused. What happens when the same merge is recorded
  elsewhere is covered (the duplicated tab, the five windows, the lost reply).
- The `probes/b/` probes (the run cockpit and the Queue): the change does not touch them and the suite covers
  them; not run again.
- R8-1 with the two windows typing in the same field, with three windows, and with B's text typed in the title
  that is in conflict.
- R8-2 for a hand-typed merged step (only the title was typed), and for a rejection by the person's own `r`
  (their own choice, but the text typed in the card goes the same way by the code).
- Step membership choices in the card.
- Real input-method composition, a real "Duplicate tab", a headed browser, any browser other than headless
  Chromium, mobile widths, screen readers.
- R5B-4 (left by the authors, its test skipped). The non-browser tests other than the architecture test, and the
  budgets.

## Cleanup

No server or browser of this review is running: nothing listens on 8950 to 8999. When I finished (13:41) other
agents' test runs were listening on ports in 7400 to 7499 (`bun test test/e2e/round8.test.ts` and others, started
13:40 from other directories); they are not mine and I left them alone. The shared checkout also had uncommitted
changes in `src/web` at that time, made by someone else; I judged the export of the commit only.
`/tmp/casebook-ui-r8`, the scratch copy for the mutations (`mut/`), the export of round 7's revision (`r7tree/`)
and `tree/node_modules` are removed (run `bun install --frozen-lockfile` in `tree/` to rerun a probe; for a
comparison run, export `1fb4c0e` into `r7tree/` and link its `node_modules` to `tree/`'s). Kept: `REPORT.md`,
`probes/`, `logs/`, `shots/` and the export in `tree/`. The repository checkout was only read; no release or
clean-up command was run in it and its `node_modules` is in place.

ISSUES (3 blockers)

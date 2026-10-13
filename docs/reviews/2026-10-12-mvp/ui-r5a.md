# Mainworthy web UI: independent verification, round 5, re-check A (drafts, saves, windows and sessions)

Revision judged: `9611d6136f8486142e26d3835b1e07cd2c03e11c`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's author (GPT 6.1 Sol).

Status: complete except where "Not checked" says otherwise. Nothing in the repository was changed; it was read
with `git archive` only.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision, by one defect.** All eight round-4 findings of this part are fixed by the routes
round 4 reported, on two runs each, and the authors' suite passed twice. But the fix for R4A-1 rebuilds the
conflict card whenever the draft changes, and that throws away what the person chose or typed in the card (N-1):
the merge then records a title the person did not choose and says "Conflict resolved." Two more new problems
lose nothing and do not block (N-2, N-3).

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium`
  (`--headless=new --ozone-platform=headless`), real server processes on 127.0.0.1. The authors' suite ran
  unpatched on its own ports (7400 to 7499); my probes start their own servers on 8750 to 8799.
- Probes are in `probes/`, run from `tree/` as `bun ../probes/<name>.ts <scenario>`:
  round 4's, copied with only paths and ports changed (`r4.ts`, `cmd.ts`, `tabs2.ts`, `more.ts`, `person.ts`;
  round 4C's `misc4.ts`, `person-moments.ts`, `persons.ts` in `probes/c/`, with a copy of the test helper on my
  ports), and new ones (`person5.ts`, `r5.ts`, `header.ts`, `mutate5.py`). Output is in `logs/`: `<name>.1.log`
  is the first run, `<name>.2.log` the second; several probes also run each scenario twice inside one log.
  Screenshots are in `shots/`.
- Every probe drives the real UI with trusted key events and then reads the server through its API. Held, failed
  and lost replies are injected at the browser (`page.route`).
- Round 4's person probes hooked the session read before a write. That read is gone, so they no longer exercise
  anything (`logs/person.1.log` shows a plain save). `probes/person5.ts` replaces them: it changes the browser's
  cookie when the write itself has left the page and is held at the browser's network layer, which is the latest
  moment there is.

## Round-4 findings, re-checked on this revision

| Finding | Verdict | What ran and the deciding lines |
| --- | --- | --- |
| R4A-3 text typed while a save is under way, then leaving | **fixed** | `r4.ts inflight-leave` (`logs/r4-inflight-leave.{1,2}.log`; edit and new, `j` and click, replies 1500 and 500 ms away; 7 of 8 variants in run 1, 8 of 8 in run 2, all the same): two requests each, `cmd 4032afe6 "Existing case"` then `cmd b2e8bdc7 "Existing case with more words"`; server `C-1 Existing case with more words v3`, `storage []`, the same 35 s later; new case `C-3 Fresh case with more words v2`. `rapid-inflight` (leaving with Shift+Enter, 2 runs): `C-1 Existing case with more words v3`, `C-2 Next one v1`. `inflight-human` (a person's speed, 2.5 s writes, 2 runs): `C-1 Existing case SAVE10 v3`. `idle-leave` (the 30 s idle seal goes out, more is typed during its reply, then `j`; `logs/r4-idle-leave.{1,2}.log`): `idleSealAfterMs 30013`, requests `"Existing case"` then `"Existing case with more words"`, server `C-1 Existing case with more words v3`; new case `C-3 Fresh case with more words v2`; `storage []`. Next to it, new: leave, come back to the case, type a third part, leave, all before the first reply (`r5.ts back-inflight`, `logs/r5-back-inflight.1.log`): `C-1 Existing case with more words and a third part v3`, `storage []`. |
| R4A-1 text typed after a conflict card, or a conflict after a failed save | **fixed, with new problems** (N-1 blocks; N-2 does not) | `r4.ts conflict-more` twice: server `version 3, title "Coupon case mine", steps ["Open the cart","Apply the coupon SAVE10 typed after the conflict"]`, `storage []`, the same 32 s later. `conflict-variants` twice: without leaving the editor `steps […,"Apply the coupon SAVE10"]`; going on in the conflicting field: card `Your draft Coupon case mine, second thoughts`, server `title "Coupon case mine, second thoughts"`. `conflict-after-failure` (2 rounds): card `Your draft Coupon case mine and the rest of my sentence`, server `version 3, title "Coupon case mine and the rest of my sentence"`. |
| R4A-2 a draft's old request sent again for ever (reject, reject elsewhere, duplicated tab) | **fixed** (with N-2 beside it) | `conflict-reject-ui` (2 rounds): after `r`, `r`: `The conflict proposal was rejected. Your current draft is kept; leave …`, `cards 0`; the next leave sends a new id (`cmd 5f4b07e3`), a new card, and "Resolve conflict" gives `version 3 … "Apply the coupon SAVE10"`. `conflict-elsewhere reject` three times: in two the card is gone 1.5 s after the rejection (`The conflict proposal was rejected. Your current draft is kept…`, `cards 0`), the draft is proposed afresh and resolved to `version 3, "Coupon case mine"`; in one (run 2, the machine busy with four probe chains) the card was still there after 1.5 s and "Resolve conflict" said `This conflict was answered elsewhere. Your draft is still kept.`, but the next leave sent a new id (`cmd 09941209 "Coupon case mine again"` → `Q-4`) and a card that can be resolved, where round 4 sent the old request for ever. So the draft is never stuck; the stale card is released by the page's next read of the question, not by the refusal itself. `dup-tab` twice: `windowIds ["dc92e8b0","bb3c8486"]` (different); different fields: `version 4, "Coupon case from A again", ["Open the cart from B"]`; the same field: a conflict card with both sides, B's text in the field and in storage, no refusal. |
| R4A-5 a second window takes over an unfinished capture | **fixed** | `windows-capture` (2 rounds): the second window opens with `focus BODY[], editors 0` and the row `new Refund is sent to the original pay draft`; Escape there records nothing; one request, `A cmd 5077b4b9 "Refund is sent to the original payment method"`; server `C-2 Refund is sent to the original payment method v1` and no other new case. |
| R4A-4 and R4C-1 a change of person between the check and the write | **fixed** | `person5.ts all` twice (`logs/person5.{1,2}.log`, identical): five surfaces (case edit, new case, run note, queue answer, the 30 s idle seal) times two ways for Bob to sign in (a login outside the app; the sign-in form of a second tab whose own session read is held). Every one: `sessionReadsBeforeWrite 0`, the write carries `as=alice`, the server records nothing (`c1 ["v1 by daniel"]`, `["C-1:-","C-2:-"]`, no decision), tab A shows the sign-in, Alice's text is stored under `mainworthy:alice:…` and is back in its field when she signs in again on A. The server asked directly (`header.ts`, `logs/header.1.log`): Bob's cookie with `X-Mainworthy-As: alice` gives `401 … the session now belongs to another person; sign in again` on a read, a write and `admin`; no header: `200`; a malformed, empty or differently-cased name: `401`. Round 4C's `person-moments.ts before` and `during`, and `persons.ts` (Bob sees none of Alice's text on the same page; Alice gets it back and records it as herself, four surfaces): hold as in round 4 (`logs/c-person-*.1.log`, `logs/c-persons.1.log`: `"by":"alice"`, `alice/fail/Alice private unfinished sentence`, `Q-3 flaky by alice`). |
| R4C-4 a closed or reloaded tab no longer records its draft | **fixed, with a new problem** (N-3, does not block) | `c/misc4.ts close` twice: `onServerAfter2s ["C-4 "Typed just before the tab went away""]` for a closed tab and for a reload (round 4: `[]`). `cmd.ts closed-tab` twice, `edit-reload` and `new-reload` (2 rounds each): after the reload the server already holds `"Open the order and ask for a ref", version 2`; typing on gives `version 3 … "ask for a refund to the card"`, `storage []`; new case `C-2 Refund is sent to the original payment method v2`, one case. Left alone after coming back (`r5.ts close-return`, close and reload): the row `new … draft` stands beside `C-2` for 30 s, then the idle seal sends the same id, the server answers with what it recorded, and one row is left: `server ["C-1 Existing v1","C-2 Typed just before the tab went away v1"]`, `storage []`. |
| R4C-5 a refused event stream | **fixed** | `c/misc4.ts idle` twice: a signed-in tab whose token is revoked, nothing touched: `seen ["3s:sign-in","15s:sign-in","40s:sign-in"]` (round 4: `app` three times). Here the sign-in came from a read the revoke's own event set off (`"22:get:401"`), not from the stream's refusal; the stream's own 401 and 502 are covered by the authors' two R4C-5 tests, which fail with the handler removed (see the mutations). |

## The authors' suite

`bun test test/e2e`, unpatched, twice, one after the other, with my probes running beside it:

```text
run 1: 163 pass, 0 fail, 748 expect() calls. Ran 163 tests across 18 files. [280.24s]   (logs/e2e-1.log)
run 2: 163 pass, 0 fail, 747 expect() calls. Ran 163 tests across 18 files. [276.50s]   (logs/e2e-2.log)
```

No flake in two runs (round 4 saw `R3B-2` fail once in four). The two runs differ by one expectation, so some
test asserts conditionally; I did not find out which.

`bunx tsc --noEmit`: exit 0. `bunx biome check src/web test/e2e`: `Checked 59 files in 70ms. No fixes applied.`
`bun test test/architecture.test.ts`: `12 pass, 0 fail`.

## Defects

### N-1: A choice made in the conflict card is thrown away by the next key typed in the editor, and "Resolve conflict" records the card's default

Blocks: **yes, as a judgement**. New on this revision; it comes from the fix for R4A-1. Reproduced 5 of 5
(`r5.ts card-choice`, two variants twice, `logs/r5-card-choice.1.log`; `r5.ts card-edit`,
`logs/r5-card-edit.1.log`; `shots/r5-card-choice-use-current-1.png`).

The card is now given a key made of the draft's text (`src/web/case/pane.tsx:246`,
`<ConflictCard key={JSON.stringify(conflict.mine)} …>`), and `change` (`src/web/suite/index.tsx`) rebuilds the
conflict from the draft on every edit. So one character typed in the editor under the card makes a new card,
whose merged text starts again from the default (`useState(state.merged)`, which is the person's own side for a
field both changed). What the person had set in the card (a side chosen with "Use current …", or text typed by
hand in "Edit merged …") is gone, with no message. Round 4's card had no key and kept the choice (and lost the
later text instead: R4A-1).

Reproduction: C-1 with two steps. `e`, type ` mine` in the title; a colleague records the title `Coupon case
theirs`; Escape: the card. Then either

- press **Use current title** (keep the colleague's): the merged field reads `Coupon case theirs`; or
- type `Coupon case, merged by hand` into **Edit merged title**.

Click step 2, type `!` (one character). The merged field reads `Coupon case mine` again. Press **Resolve
conflict**:

```text
card-choice use-current: mergedFieldAfterTheChoice "Coupon case theirs", mergedFieldAfterOneKeyInAStep "Coupon case mine",
  sentToServer ["Coupon case mine"], status "Conflict resolved. Both earlier versions remain in the timeline.",
  server {version 3, title "Coupon case mine", steps ["Open the cart","Apply the coupon!"]}, storage []
card-choice typed: mergedFieldAfterTheChoice "Coupon case, merged by hand", mergedFieldAfterOneKeyInAStep "Coupon case mine",
  sentToServer ["Coupon case mine"], server {version 3, title "Coupon case mine"}, storage []
```

In the first form the person chose to keep the colleague's title and their own title is recorded over it; in the
second the sentence typed into the card is in no version, not on the device and not on the screen.

How wide, said plainly: it needs a conflict card, a choice in the card, then a key in the editor, then the
merge, in that order. Someone who chooses and resolves at once is not affected. The change is on the screen if
the card is in view (in this two-step case it is: the merged field is at 426 to 477 px of 800), but nothing
draws the eye to it, and in a longer case the card is above the fold while a lower step is edited. It is rated
a blocker for the reason round 4 gave for R4A-1 and R4A-3: typed input is dropped without a message and the UI
reports success. If Daniel weighs the unusual order and the visible field more, the count drops to none.

Promise contradicted: "nothing typed is lost … when another producer changed the same thing"; "no key press is
lost". Fix: keep the card's choices across a rebuild (hold the merged body outside the card, or key the card by
its question and re-merge only the fields the person has not touched).

### N-2: Every leave of the editor while a conflict card is open proposes the draft again; the earlier proposals stay open after the conflict is resolved

Blocks: **no** (no text is lost; what is left is clutter that somebody has to reject).

After a conflict the draft forgets its request (the R4A-2 fix), so the next seal sends the current text under a
new id with the old base. The server answers each with another conflict and another question. The card follows
the latest; "Resolve conflict" answers only that one.

Reproduction (`r5.ts orphans`, `logs/r5-orphans.{1,2}.log`, 4 of 4): `e`, type ` mine`; a colleague changes the
title; Escape (card, Q-3). Click step 2, type ` SAVE10`, Escape (Q-4). Type ` and check the total`, Escape (Q-5).
"Use my title", "Resolve conflict":

```text
requests: cmd 862d82cf base 1 … reply "status":"conflict" "question":"Q-3"
          cmd 239e997c base 1 … reply "status":"conflict" "question":"Q-4"
          cmd 5e675222 base 1 … reply "status":"conflict" "question":"Q-5"
after:    status "Conflict resolved. …", server version 3, steps […,"Apply the coupon SAVE10 and check the total"], storage []
          questions open ["Q-4 open","Q-3 open"], decided ["Q-6 accept","Q-5 merge", …], proposalCards 2
inbox:    ["Q-4 adopt open","Q-3 adopt open"]
```

The two left over show on the case as `Q-4 · daniel Proposed, waiting for a person` with `a Accept proposal` in
the key bar, and in the Queue. Accepting one is refused by the server with `C-1 has an unresolved conflict; its
author must resolve it` (there is none any more); rejecting works, and the case stays at version 3. The same
happens in the duplicated-tab route (`logs/r4-dup-tab.1.log`: Q-3, Q-4, Q-5). Fix: while a conflict's question
is open, a seal should not propose again (the card already follows the draft), or resolving should withdraw the
person's earlier conflicted proposals for that case.

### N-3: A tab closed in the middle of editing an existing case now leaves the person in conflict with their own half sentence

Blocks: **no** (nothing is lost; the card shows both sides and resolves to the full text).

The last write of a closing tab now arrives (the R4C-4 fix). The draft stays on the device with its old base,
because the page never saw the reply. In the same window (a reload) the stored request is sent again under its
id, the server answers with what it recorded, and the rest follows as the next version: right. In a **new** tab
the window id differs, and `ownedDraft` then drops the stored request of an existing case (`sent: saved.ref ===
null ? saved.sent : null`; it keeps it for a new case). The new tab sends the longer text against the old base,
and the server holds the person's own half sentence as a newer version.

Reproduction (`r4.ts closed-tab-edit`, 4 of 4 in two runs; `r5.ts closed-edit-more` and `closed-edit-resolve`):
open C-1, `e`, type ` for returning cust`, close the tab. Open the case in a new tab: the editor is back with
the text. Type `omers`, Escape:

```text
onServerAfter2s ["C-1 Coupon case for returning cust v2"]
requests: cmd 49155c91 base 1 "Coupon case for returning customers" → "status":"conflict" "question":"Q-3"
status "Both edits are kept. Choose each field to resolve the conflict.", cards 1
card: "Your draft Coupon case for returning customers … Current version Coupon case for returning cust"
```

"Use my title", "Resolve conflict": `C-1 Coupon case for returning customers v3`, `storage []`, no question
left. With a reload in place of the close: `version 3`, no card. Round 4 on the same probe: `version 2`, the
full text, no conflict (the write did not arrive then). Closing a tab mid-sentence and finishing later is an
ordinary thing to do, so this will be met. Fix: a new window that takes over a draft whose owner is gone should
keep the stored request (send it first, as it does for a new case); only a draft taken from a **live** window
needs a fresh one.

## What is left of issue #71 (the same request sent again before newer text)

The brief asks whether what is left can lose or misrecord text. In what I ran: **it loses nothing; it can
record one version the person had already moved on from.**

- Reply lost, more typed, leave (`cmd.ts lost-reply`, twice): `C-2 Card is charged once only v2`, `C-1 Refund
  case for a card once only v3`, one case each.
- Reply lost, then the person takes the words out again and leaves (`r5.ts lost-reply-revert`): requests `cmd
  b77c9cdb "Refund case WRONG WORDS"` twice, then `cmd 388a9bb7 base 2 "Refund case"`; server `C-1 Refund case
  v3`. The head is what the person left; version 2 holds the removed words, which the server had in fact
  received.
- The request never arrived, a colleague changed the field, more typed (`conflict-after-failure`): the old
  request goes out again and meets the conflict; the card is built from the draft as it is now and the merge
  records the full sentence.
- The request never arrived and nobody else changed anything: the resend records the old text as a version at
  that moment, and the newer text follows as the next one (read from the code and from the request order above;
  the case where that second write then fails too was not run: the draft would stay on the device).
- Reply lost, then a new tab, an existing case: N-3. A new case: the same id is sent, no second case.

## The tests do not prove this

Judged by disabling one fix at a time in a scratch copy and running the authors' test for it
(`probes/mutate5.py`, `logs/mutations.log`, 20 mutations):

| Fix removed | Authors' test | Result |
| --- | --- | --- |
| R4A-3: a waiting seal and a finished seal decide by the open editor (round-4 behaviour) | `R4A-3` (10) | 8 fail, 2 pass |
| R4A-3: only the finished seal | `R4A-3` | 8 fail, 2 pass |
| R4A-3: only the waiting seal | `R4A-3` | 10 pass (the finished seal covers it) |
| R4A-1: the card is not rebuilt from later text **and** resolving removes the draft | `R4A-1 conflict keeps` (4) | 2 fail (`seal false`), 2 pass (`seal true`) |
| R4A-1: either of those alone | `R4A-1 conflict keeps` | 4 pass (each covers the other) |
| R4A-1: the conflict is built from the request sent, not from the draft now | `R4A-1 a conflict after a missing reply` | fails |
| R4A-2: a duplicated tab keeps the stored window id | `R4A-2 duplicated` | passes (the roll-call covers it); with the roll-call off as well: fails |
| R4A-2: a refused request is remembered | `R4A-2 a refused command` | fails |
| R4A-2: a rejected conflict keeps its card and request | `R4A-2 a conflict rejected` (2) | 2 fail |
| R4A-2: a conflict reply does not forget the request | `R4A-2 a conflict rejected` | 2 pass (the reject effect covers it) |
| R4A-5: another window may open a live window's capture | `R4A-5` | fails |
| R4C-1: the page does not name its person | `R4C-1` (3) | 3 fail |
| R4C-1: the server does not compare the name | `R4C-1` | 3 fail |
| R4C-4: nothing is sent when the page is hidden | `R4C-4` (2) | 2 fail |
| R4C-4: the last write is sent **without** `keepalive` | `R4C-4` | **2 pass** |
| R4C-4: a new window forgets what a capture sent | `R4C-4` | close fails (two cases), reload passes (same window) |
| R4C-5: the stream has no error handler | `R4C-5` (2) | 2 fail |
| R4C-5: the stream reconnects without asking whose session it is | `R4C-5` | 401 fails, 502 passes (as it should) |

So the tests for my findings do fail with their fix removed, with these gaps:

- **`R4C-4 … sends the keepalive capture`** passes when the write is sent without `keepalive`: in headless
  Chromium an ordinary request started as the page is hidden still gets out. The test proves that a write is
  started on leaving, not that it survives a real tab close.
- The two **`R4A-3 … survives route`** tests (leaving by a click on Runs) pass with round 4's behaviour; that
  route was never broken. The other eight discriminate.
- The **`R4A-1 … with seal true`** tests pass with both card fixes removed, because leaving the editor proposes
  again (N-2) and the new card is built from the new text. No test counts the questions left open (N-2).
- No test makes a choice in the card and then types in the editor (N-1). The R4A-1 tests press "Use my title"
  after the typing, never before.
- No test closes a tab on an **existing** case and goes on in a new tab (N-3); `R4C-4` uses a new case.
- `R4A-2 duplicated tabs` opens the copy with `window.open(location.href)`, as round 4's probe did; a real
  "Duplicate tab" is not reached by either.

## Worth doing later

- After coming back to a case whose closing tab had already recorded the text, a leave with nothing more typed
  sends a write that changes nothing, and the status bar says `Version 1, by you, just now` while the pane says
  `v2 Version 2, by you` (`logs/r5-closed-edit-resolve.{1,2}.log`). The number is the draft's old base.
- A draft larger than the browser allows for a write that outlives the page (64 KB) is not sent when the tab is
  hidden or closed (`r5.ts big-hidden`, once, `logs/r5-big-hidden.1.log`: 73,616 characters in one step; hidden:
  `Failed to fetch. Your draft is kept on this device.`, server `v1`; back and Escape: `version 2`, 73,615
  characters, `storage 0`). Nothing is lost; for such a case R4C-4 is as it was in round 4.
- After a closed tab, a new case shows twice (`new … draft` and `C-2 …`) until the person leaves the restored
  editor or 30 s pass (`logs/r5-close-return.1.log`). It heals by itself; nothing says the two rows are one case.
- A key that is refused because the session changed is gone with the sign-in (a queue answer `f`: `stored {}`,
  no decision): the person has to press it again after signing in. Text is kept; a bare key is not.
- A person's name may hold only letters, digits and `. _ @ -` (`actor name: letters, digits, . _ @ -`; `Zoë` and
  `田中` are refused), so the percent-encoding of `X-Mainworthy-As` only ever has `@` to encode
  (`logs/r5-names.1.log`: `Dr.O_Brien%40qa`, `v2 by Dr.O_Brien@qa`).

## Engine observations (not judged here)

- A conflicted proposal left open after its author resolved a later one (N-2) answers `accept` with `C-1 has an
  unresolved conflict; its author must resolve it`, when the case has none and its author has no card for it;
  only `reject` settles it (`logs/r5-orphans.1.log`, "the questions left open, answered afterwards"). The message
  is stale, and nothing closes such a proposal when the case moves past it.
- `GET /api/session` also refuses a request that names another person (`logs/header.1.log`, last line but one).
  The brief says that route takes no such header; the page sends none there, so it does no harm.

## Mistakes in my own method

- The first run of `r4.ts inflight-leave` was cut by my own 300 s limit after seven of its eight variants (the
  log ends in a connection error from the killed server). Rerun with a longer limit as the second run.
- `probes/person.ts` (round 4A) was run unchanged before I saw that it waits for a request the page no longer
  makes; its log shows an ordinary save by Alice and proves nothing. `person5.ts` is the check.
- `r5.ts names` first used names the server does not allow; rerun with allowed ones.
- `person5.ts` changes the cookie from the route handler of the held write and trusts the browser to attach the
  cookie when the request is let go. The authors' R4C-1 test relies on the same thing. That the server saw Bob's
  cookie with Alice's name is shown by its answer (401 and the sign-in), and `header.ts` shows the server rule
  without a browser.
- Headless Chromium never hides a tab. "Two windows" means two pages of one browser context, both visible, and
  "a closed tab" is `page.close({ runBeforeUnload: true })`.
- In the scratch copy for the mutations I ran `git init` by mistake; it is inside my own directory and removed.

## Not checked

- The other reviewer's part: R4B-1 to R4B-8, R4C-2, R4C-3, and everything on Queue, Runs, Changes
  and Settings beyond a write under a changed person.
- A real "Duplicate tab" from the tab strip, a real tab switch, a real tab close in a headed browser (whether
  the last write survives there; see the `keepalive` mutation), session restore after a browser restart, and
  any browser other than headless Chromium.
- The roll-call between windows answering later than the 40 ms the page waits for it.
- A person's edit that needs somebody else's answer (`submission: waiting`): not reached, as in round 4.
- Mutations of fixes from earlier rounds; the rest of round 4A's regression probes (`capture.ts`, `edit.ts`,
  `recheck.ts`) beyond `more.ts inflight`, `tabs2.ts windows` and `switch`, `r4.ts windows-reload` and
  `conflict-step-removed`, which all hold as in round 4.
- The non-browser tests other than the architecture test, and the budgets: not run by me this round.
- IME input, screen readers, mobile widths, Cmd on macOS.

## Cleanup

No server or browser of this review is running (nothing listens on 8750 to 8799). `/tmp/mainworthy-ui-r5a`, my
port locks, the scratch copy for the mutations and `tree/node_modules` are removed (run `bun install
--frozen-lockfile` in `tree/` to rerun a probe). The repository checkout was read with `git archive` only; the
`/tmp/mainworthy-e2e-*` directories of other runs were not touched.

ISSUES (1 blocker)

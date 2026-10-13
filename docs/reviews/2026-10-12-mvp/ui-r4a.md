# Mainworthy web UI: independent verification, round 4, part A (the authors' tests, capture, editing and versions)

Revision judged: `ec98ba41d759e037b2ff7b4b6138f587ee2f15ca`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's author (GPT 6.1 Sol).

Status: complete. Nothing in the repository was changed.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision.** All six round-3 findings of this part are fixed by the routes round 3 reported,
and each has a test that fails when its fix is removed. But the fix for A-1 (a draft keeps the request it sent and
sends it again unchanged) brought two new defects, and one race in leaving the editor is open:

- text typed while a save is still under way is dropped when the person then moves to another case, and the UI
  says "Version N, by you" (R4A-3);
- text typed after a conflict card appears, or after a save that failed and then met a conflict, is dropped when
  the conflict is resolved (R4A-1);
- after a conflict's proposal is rejected (one key, offered on the same screen) the case can no longer be edited
  from that tab: the old request is sent again for ever (R4A-2).

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium`
  (`--headless=new --ozone-platform=headless`), real server processes on 127.0.0.1. The authors' suite ran
  unpatched on its own ports; my probes start their own servers on 8500 to 8549 with data under
  `/tmp/mainworthy-ui-r4a`.
- Probes are in `probes/` (run from `tree/` as `bun ../probes/<name>.ts <scenario>` after `bun install
  --frozen-lockfile` there): the round-3 probes unchanged except for paths and ports (`cmd.ts`, `tabs2.ts`,
  `edit.ts`, `more.ts`, `recheck.ts`, `capture.ts`), and new ones (`r4.ts`, `person.ts`, `apierr.ts`,
  `dupstep.ts`, `mutate4.py`, `mutate4-a3.py`). Output is in `logs/`, screenshots in `shots/`. Every probe drives
  the real UI with trusted key events and then reads the server through its API. Slow, failing and lost replies
  are injected at the browser (`page.route`).
- Each blocker was reproduced at least twice. Mistakes in my own method are listed at the end.

## Checks

| # | Check | Verdict | What ran and the deciding lines |
| --- | --- | --- | --- |
| 1 | The authors' tests | **issues** (not blocking: one flaky test; gaps listed below) | `bun test test/e2e` four times, unpatched (`logs/e2e-{1,2,3,4}.log`): `102 pass, 0 fail, 619 expect() calls` in runs 1, 2 and 4 (221 s, 220 s, 209 s); run 3: `101 pass, 1 fail`, `(fail) R3B-2 the first queue cursor survives a new question and settlement elsewhere` (`round3-interactions.test.ts:100`, `waitForFunction: Timeout 5000ms exceeded` waiting for "settled"). That test alone: 12 of 12, and 15 of 15 with twelve busy loops running (`logs/flake-r3b2-summary.log`, `logs/flake-load-summary.log`); run 3 was the one during which four of my probes ran. Flaky once, cause not found; it is part B's screen. `bunx tsc --noEmit`: exit 0. `bunx biome check src/web test/e2e`: `Checked 58 files in 63ms. No fixes applied.` `bun test test/architecture.test.ts`: `12 pass, 0 fail`. Judged by disabling one round-3 fix at a time in a scratch copy (`probes/mutate4.py`, `logs/mutations.log`; `probes/mutate4-a3.py`, `logs/mutations-a3-clean.log`): the tests for A-1 (two mutations), A-2, A-3 (tags; clean draft), A-4, A-5, A-6 and "badge and proof change together" each fail with their fix removed (9 of 9). |
| 2 | Capture (J1) | **issues** (R4A-3 blocks; R4A-5 does not) | `logs/capture-j1.log`, every request delayed 500 ms: `keys {"total":169,"text":161,"beyondText":8}`; `caret {"inNewCaseOnNextFrame":true,"ms":60.7,"rowOnThatFrame":true}` (the machine was loaded; round 3 measured 18 ms); the row mirrored the title; all six step fields right before leaving with `writesSentBeforeLeaving 0`; server `version 1, tags ["checkout"]`, six steps, three with an expected result, `versions ["v1"]`, one write. Three cases in a row with Shift+Enter behind slow writes: three cases, one version each, in order (`logs/capture-rapid.log`). `c` before any read has returned, three URLs: all land in the right folder (`logs/more-early.log`). One version on Escape, Ctrl+Enter, `j`, a click and `g q` (`logs/capture-leave.log`: `versions ["v1"], creates 1` five times) and after 30 idle seconds with the caret kept (`logs/recheck-r2-3.log`: `sealedAfterMs 30027`, `focus TEXTAREA[…:action], editors 1`; `logs/capture-idle-inflight.log`). Two unchanged edits: `versions ["v1"], writes 1`; `c`, Escape with nothing typed: no case. Four pasted lines became four steps, two with a result (`logs/capture-paste.log`). Reload and closed tab mid-word: draft and caret come back and what is typed afterwards is recorded (`logs/cmd-new-reload.log`: `C-2 Refund is sent to the original payment method v2`; `logs/cmd-closed-tab.log`). **Fails:** text typed during a slow save and followed by a move to another case is dropped (R4A-3); a second window turns one capture into two cases (R4A-5). |
| 3 | Editing and versions | **issues** (R4A-1 and R4A-2 block) | `logs/edit-versions.log`: a step edit makes version 2; `v` shows `v1 → v2 · b2.action … ~ Apply the coupon OLD10 > Total drops`; `z` widens the pane (486 → 704 px) and back; `u` restores as version 3 (`["v3 b2.action","v2 b2.action","v1 created"]`), with a version row focused as version 4 (`logs/more-restore.log`). Badge, row proof and pane proof on every frame: `["v1|row H✓|pane ✓","Draft|row H✓|pane ✓","Draft|row H~|pane ~","v2|row H~|pane ~"]`, no frame with version 2 and a tick. Two browsers and two windows of one browser: different fields both land (`version 3`, title from A, step from B); the same field gives a card with both sides (`"Your draft / Title by B"`, `"Current version / Title by A"`), resolved to version 5 with five versions kept (`logs/edit-tabs.log`, `logs/tabs2-windows.log`). A colleague removing the step being rewritten: card `steps.b2 Your draft Apply the coupon SAVE10 and check the total … Current version Step removed`, resolved to version 3 with the step (`logs/r4-conflict-step-removed.log`). A draft is not replaced by an agent's proposal (`logs/recheck-r2-8.log`: my seal makes version 2, the agent's adoption follows as `v3 by reviewer (agent)` with my title kept). **Fails:** text typed once a conflict is open is discarded on resolve (R4A-1); after the conflict's proposal is rejected the case cannot be edited from that tab (R4A-2). |

## Round-3 findings, re-checked on this revision

| Finding | Result here | Evidence |
| --- | --- | --- |
| A-1 text typed after a reload, a closed tab or a lost reply | **fixed, with new problems** (R4A-1, R4A-2: both come from the stored request being sent again whatever the answer was) | `probes/cmd.ts edit-reload` twice (`logs/cmd-edit-reload.log`): typed `und to the card` after the reload, Escape: `status "Version 3, by you, just now"`, server `version 3, ["Open the order and ask for a refund to the card"]`, `storage []`. `closed-tab`: `C-2 Password reset mail arrives within a minute v2`. `lost-reply` new and edit: `C-2 Card is charged once only v2`, `C-1 Refund case for a card once only v3`. `new-reload` twice: `C-2 Refund is sent to the original payment method v2`, the same 32 s later. Existing case, closed tab (`logs/r4-closed-tab-edit.log`, twice): `version 2`, full text, no conflict with oneself. |
| A-2 two windows of one browser | **fixed** for two windows opened separately; two residues (R4A-5; the duplicated-tab route of R4A-2) | `probes/tabs2.ts windows`, 4 runs (`logs/tabs2-windows.log`): each window sends its own id (`A cmd 91612d1a`, `B cmd ff4868c3`); different fields: `version 3`; same field: `bStatus "Both edits are kept…"`, `conflict 1`, B's text still in the field and in storage. One window reloading while both type: both texts land, `version 3` (`logs/r4-windows-reload.log`, twice). |
| A-3 a clean draft reused later | **fixed** | `logs/edit-stale.log`: `storedAfterEEscape []`; `e` after a colleague's version 2 opens on version 2. `logs/tabs2-tags.log`: server `tags ["checkout"]` after my seal, placements `["tags: checkout by robin"]`; `logs/tabs2-covers.log`: `covers []`. |
| A-4 a folder key opened an unsaved new case's editor | **fixed** | `logs/edit-folder-editor.log`: after `]`: `focus DIV[], editors 0`; the draft stays in storage with its title unchanged. |
| A-5 a result from somebody else left the pane's proof stale | **fixed** | `logs/more-external-result.log`, twice: 1 s after the other producer's failure `row H✗`, `pane H✗ person · fail on v1`, `timelineResults 2`. |
| A-6 a step holding " > " split by the next character | **fixed** | `logs/recheck-r2-10.log`: after one character `action "Open Settings > Billing!", expected (none)`, focus stays in the action; server v3 the same. |

Round-2 fixes run again with the round-3 probes, all still holding: R2-3 (`logs/recheck-r2-3.log`), R2-4
(`logs/recheck-r2-4.log`), R2-8, R2-9 (`logs/recheck-r2-9.log`, twice), R2-10, Back then Forward
(`logs/recheck-back.log`, twice).

## Defects

### R4A-3: Text typed while a save is still under way is thrown away when the person then moves to another case, and the UI says "Version N, by you"

Blocks: **yes**. Reproduced 14 of 14: an existing case and a new case, leaving with `j` and with a click, replies
500 ms and 1500 ms away (8), after the 30-second idle seal (2), at a person's speed with 2.5 s writes (2), and
leaving with Shift+Enter (2).

`choose` (the `j`/`k` keys and a click on a row, `src/web/suite/index.tsx`) calls `sealDraft()` and then sets
`draftRef.current = null`. When an earlier seal of the same draft is still waiting for its reply, the new seal
only waits for it (`await existing`) and then sends the newer text only `if (… draftRef.current?.id ===
snapshot.id)`, which is no longer true. The first seal's success path meanwhile removes the stored draft
(`removeDraft`), which by then held the newer text. So the words typed after the first seal went out are in no
version, not on the device and not on the screen; the status reads "Version 2, by you, just now".

Reproduction (`probes/r4.ts inflight-leave`, `logs/r4-inflight-leave.log`; `propose` replies delayed by 1500 ms and
by 500 ms, leaving with `j` and with a click): on C-1 press `e`, type ` case`, Escape (the seal goes out). Click
the title, End, type ` with more words` (the field reads `Existing case with more words`), then Escape and `j`,
or click C-2, before the reply is back. One request only: `cmd 963f4008 "Existing case"`. 3 to 4 s later and
35 s later: server `C-1 Existing case v2`, `status "Version 2, by you, just now"`, row `C-1 Existing case`, `storage []`.
The same for a new case (`c`, `Fresh case`, Escape, click the title, ` with more words`, `j`): server `C-3 Fresh
case v1`, `status "Version 1, by you, just now"`, `storage []`.

How wide it is, said plainly: the person must go back into the editor, type and move to another case while the
first write is still under way, so the window is one write (the session read plus the `propose`). The runs above
type at machine speed. At a person's speed it needs a slow link: with every request 1.25 s away (2.5 s a write),
120 ms a key and 300 ms pauses, Escape, click the title, type ` SAVE10`, click the other case 1.6 s after Escape
(`probes/r4.ts inflight-human`, `logs/r4-inflight-human.log`): `titleFieldBeforeLeaving "Existing case SAVE10"`,
one request `"Existing case"`, server `C-1 Existing case v2`, `storage []`; the same for a new case. The other
natural form is the 30-second idle seal, which goes out by itself while the person is still in the editor
(`probes/r4.ts idle-leave`, `logs/r4-idle-leave.log`, reply 800 ms away): `idleSealAfterMs 30012`, typed ` with
more words`, Escape, `j`: server `C-1 Existing case v2`, `storage []`, the same 37 s later; and for a new case.
Starting the next new case instead of moving to another one does the same, since `create` also replaces
`draftRef` right after `void sealDraft()` (`probes/r4.ts rapid-inflight`, `logs/r4-rapid-inflight.log`): Escape,
click the title, ` with more words`, Shift+Enter, `Next one`, Escape: requests `"Existing case"` and `"Next one"`
only; server `C-1 Existing case v2`, `C-2 Next one v1`, `storage []`, the same 37 s later; and for a new case.

It is rated a blocker because the loss is silent and the UI reports success, under the condition check 2 sets
(slow requests); on a fast link the window is a few tens of milliseconds. If the owner weighs the narrow window
more than the silence, the count drops by one.

What holds: staying in the editor while the idle seal's reply is under way keeps the text (it is recorded as the
next version: `logs/capture-idle-inflight.log`), and so does leaving the second time with Escape alone
(`probes/more.ts inflight`, `logs/more-inflight.log`: `C-1 Existing case with more words v3` after 3 s; a new
case after 31.7 s, by the idle timer, as round 3 found).

Promise contradicted: "no key press is lost"; "nothing typed is lost … on a failed [or slow] request"; P1 "capture
never waits". Fix: `choose`, `create` and the other places that replace `draftRef.current` after `void
sealDraft()` must hand the newer snapshot to the waiting seal instead of deciding by `draftRef`, and a finished
seal must not remove a stored draft that is newer than what it sent.

### R4A-1: Text typed after a conflict card appears, or after a failed save that then meets a conflict, is thrown away when the conflict is resolved

Blocks: **yes**. Reproduced 6 of 6 (the probe twice, two variants, and the failed-save route twice).

A draft keeps the record of the request it sent (`sent` in `src/web/suite/index.tsx`, `sealDraft`: `if
(recovered) { body = recovered.body … }`, `const request = recovered?.input ?? …`), and the record is cleared only
when the request is adopted or waits for a person. While a conflict is open the editor stays open and accepts
typing, but every later seal sends that same old request again; the server answers it with the same conflict; the
card's "Your draft" side stays the old text. "Resolve conflict" then records the card's merge and `onResolved`
removes the draft from the screen and from the device. Whatever was typed since the request was first sent is in
no version, not on the device and not on the screen, and the status says "Conflict resolved."

Reproduction 1, typing after the card (`probes/r4.ts conflict-more`, `logs/r4-conflict-more.log` and
`r4-conflict-more-2.log`, `shots/r4-conflict-more.png`): C-1 with two steps. `e`, type ` mine` in the title; a
colleague records another title; Escape: the card shows (`title Your draft Coupon case mine … Current version
Coupon case theirs`). Click step 2, End, type ` SAVE10 typed after the conflict` (the field reads `Apply the coupon
SAVE10 typed after the conflict`), Escape: requests `cmd 22fe898b "Coupon case mine"` twice, both answered
`"status":"conflict"`. Click "Use my title", "Resolve conflict": `status "Conflict resolved. Both earlier versions
remain in the timeline."`, server `version 3, title "Coupon case mine", steps ["Open the cart","Apply the
coupon"]`, `storage []`; still so 32 s later.

Variants (`probes/r4.ts conflict-variants`, `logs/r4-conflict-variants.log`): the same without leaving the editor
before "Resolve conflict" (`fieldBeforeResolving "Apply the coupon SAVE10"` → server `steps ["Open the cart","Apply
the coupon"]`, `storage []`); and going on in the conflicting field itself (`"Coupon case mine, second thoughts"`,
Escape: the card still says `Your draft Coupon case mine`; "Use my title", resolve → server `title "Coupon case
mine"`, `storage []`, the same 34 s later).

Reproduction 2, no typing after the card at all (`probes/r4.ts conflict-after-failure`,
`logs/r4-conflict-after-failure.log`, 2 of 2): `e`, type ` mine`, Escape while the network is down: `Failed to
fetch. Your draft is kept on this device.` A colleague changes the title. Click the title, End, type ` and the
rest of my sentence` (the field reads `Coupon case mine and the rest of my sentence`), Escape. Requests: `cmd
f2576620 "Coupon case mine"` twice (the failed one, then the same again). The card: `Your draft Coupon case mine`:
the person's actual text is never shown on it. "Use my title", "Resolve conflict": server `version 3, title "Coupon
case mine"`, `storage []`.

What holds: a conflict with nothing typed after the request went out keeps both sides and loses neither (check
3), also when a colleague removed the step being rewritten.

Promise contradicted: "nothing typed is lost … on a failed request, or when another producer changed the same
thing"; check 3 "two tabs editing the same field show a conflict with both sides and lose neither". Fix: when the
stored request is answered with a conflict, build the conflict from the draft as it is now (or send what is new
before showing the card), and keep the draft on resolve when it differs from what was merged.

### R4A-2: After a definitive answer the draft's stored request is still sent again, for ever: the case can no longer be edited from that tab

Blocks: **yes**, as a judgement. The text stays on the device and a message is shown, so the promise holds to the
letter; but there is no way forward in that tab. Reloading does not help; only a new tab does (it gets a new
window id, which drops the stored request; read from `ownedDraft`, not run). It is reached with one key that the
same screen offers.

The cause is the one of R4A-1: the `sent` record survives every answer except "adopted" and "waiting for a
person". Three routes:

1. **Rejecting one's own conflicted proposal** (`probes/r4.ts conflict-reject-ui`,
   `logs/r4-conflict-reject-ui.log`, `shots/r4-conflict-reject-ui-1.png`, 2 of 2; one person, one tab, keys
   only). `e`, type ` mine`; a colleague changes the title; Escape: the conflict card, and below it the proposal
   with `a Accept proposal`, `r Reject proposal` in the key bar. Press `r`, `r`: `Q-3 rejected. The author remains
   recorded.` The card stays and the pane still says `Draft, saved on this device`. Click step 2, type ` SAVE10`,
   Escape: request `cmd c339a1b0 "Coupon case mine"` (the old one), status `Both edits are kept. Choose each field
   to resolve the conflict.` "Resolve conflict": `This conflict was answered elsewhere. Your draft is still kept.`
   Reload, `e`, Escape: the same request, the same card. Server: `version 2, "Coupon case theirs"`, steps
   unchanged.
2. **Somebody else rejects it** (the Queue, another person; here through the API: `probes/r4.ts
   conflict-elsewhere`, `logs/r4-conflict-elsewhere.log`, the `reject` run, once): the same loop. (An `accept`
   from elsewhere is refused by the server, `"C-1 has an unresolved conflict; its author must resolve it"`, and
   the card then resolves normally.)
3. **A duplicated tab** (`probes/r4.ts dup-tab`, `logs/r4-dup-tab.log`, both fields, 2 of 2). The window id that
   keeps two windows from sharing a command id lives in `sessionStorage` (`draftOwner`, `src/web/lib/ids.ts`), and
   a duplicated tab starts with a copy of it: `windowIds ["a0f12069","a0f12069"]`. The copy takes over the first
   tab's draft with its id; when both have typed and both leave, the second is refused: `B cmd b150db1c "Coupon
   case from A and from B"` → `{"ok":false,"error":{"code":"conflict","message":"this command id was already used
   for another request; send new content under a new id"}}`, shown to the person as the status. Typing more and
   leaving again, and a reload, send the same refused request each time; server `version 2, "Coupon case from A"`;
   B's text (`Coupon case from A and from B again!`) is on the device only. This route is narrow: a real
   "Duplicate tab" hides the first tab, which seals at once; it needs the copy moved to its own window so both
   stay visible. The copy was made with `window.open(location.href)`, which copies `sessionStorage` the same way;
   the tab strip's own command cannot be driven headless.

Promise contradicted: "every optimistic change either becomes the server's record or is rolled back visibly with
the person's input kept" (kept, with no way to record it). Fix: clear `sent` and take a new id on any answer that
is not a lost reply (a conflict, a rejection, a refusal); when the conflict's question is no longer open, drop
the card and send the draft afresh; and do not let two live tabs share a window id.

### R4A-4: The session read before a write does not close the gap: a change of person between the read and the write is recorded as the new person

Blocks: **no**, as a judgement (the window is one reply long and needs somebody else to sign in on the same
browser in that moment). It answers the question the brief asks about the R3-1/R3-2 mechanism; sessions are
otherwise outside part A.

`call` (`src/web/lib/api.ts`) reads `/api/session`, compares the person, and then sends the write. The write
carries nothing but the browser's cookie, so whatever the cookie is when the write leaves decides who recorded it.
Between the server answering the read and the page sending the write lies the time the reply needs to travel
back; a sign-in in another tab in that time changes the cookie, and the other tab's notice (a `storage` event,
sent only after that tab has finished its own session read) cannot arrive first.

Reproduction (`probes/person.ts`, `logs/person.log`, 2 of 2; server mode, tokens for alice and bob): alice opens
C-1, `e`, types `, as typed by Alice`, Escape. While the reply to her session read is on its way back, the browser
signs in as bob. Log: `session read answered: alice`, `cookie now belongs to bob`, `propose sent: "Shared case, as
typed by Alice"`. Server: `v2 by bob`, title `Shared case, as typed by Alice`. Alice's screen: `Version 2, by you,
just now`, still signed in as alice.

What the mechanism costs, measured here:

- One more round trip before every write (`propose`, `decide`, `report`, `plan`, `announce`, `admin`): with every
  request 500 ms away a seal takes two delays, not one. It does not hold up typing (check 2), but it doubles the
  window of R4A-3.
- **The text a page sends as it goes away no longer arrives.** The seal on `visibilitychange` uses `keepalive`,
  but the write is now sent only after the session read has come back, and by then the page is gone. Round 3, same
  probes: after a reload the server already held the text (`"server":["Open the order and ask for a ref"],
  "version":2`), and after a closed tab the new case existed (`C-2 Password reset mail arr v1`). Here, 0 of 7
  (`logs/cmd-edit-reload.log`, `logs/cmd-new-reload.log`, `logs/cmd-closed-tab.log`,
  `logs/r4-closed-tab-edit.log`): `"server":["Open the order"],"version":1` and `"server":["C-1 Existing v1"]`. The
  draft is still on the device and is sent when that browser opens the Suite again, so nothing is lost there; but
  until then nobody else sees it, and a person who closes the tab and carries on elsewhere does not find it. A
  tab that is only hidden (a tab switch, emulated) still sends (`logs/tabs2-switch.log`).

A fix for both: let the write itself name the person it was typed by (a header or a field) and have the server
refuse it when the session is somebody else's; then no read is needed first.

### R4A-5: A second window that opens the Suite takes over the first window's unfinished capture; one capture becomes two cases

Blocks: **no**, as a judgement (no text is lost; it needs two windows visible at once, since a tab that is switched
away from seals first; the result is an extra case holding half a sentence, recorded under the person's name,
which they must find and archive).

An unfinished new case is the project's "active draft" on the device. Any page that opens a Suite URL without a
case restores it and puts the caret in it, also while the window that is writing it is still open. The second
window gets its own command id (the A-2 fix), so when both leave, both create.

Reproduction (`probes/r4.ts windows-capture`, `logs/r4-windows-capture.log`, `shots/r4-windows-capture-1.png`, 2 of
2): window A: `c`, type `Refund is sent to the original pay`. Open a second window on `/p/scratch/suite`: `focus
TEXTAREA[title], editors 1, title "Refund is sent to the original pay"`. Press Escape there (the person did not
ask for an editor): server `C-2 Refund is sent to the original pay v1`. Back in A: type `ment method`, Escape.
Requests: `B cmd 768ea869 "Refund is sent to the original pay"`, `A cmd d639ce78 "Refund is sent to the original
payment method"`. Server: `C-3 Refund is sent to the original payment method v1` and `C-2 Refund is sent to the
original pay v1`.

Promise contradicted: J1 "it becomes exactly one version when you leave". Fix: a draft that a live window owns is
not restored into another window (the owner id is already stored on it); restore it only when its owner is gone.

## The tests do not prove this

- The tests for the round-3 fixes in this part do prove their names: each fails with its fix removed (9 of 9
  mutations), including the one round 3 found missing (the row's proof changing with the badge: the new test
  holds the list read back, so a late refetch cannot satisfy it). `J1` now asserts its key count (`toBe(8)`) and
  delays `propose` by 500 ms; reads are not delayed there (they were here).
- No test types into a draft whose save is still under way and then moves to another case or starts a new one
  (R4A-3). The tests that slow `propose` down leave once.
- No test types after a conflict card is shown, or meets a conflict after a failed save (R4A-1). `A-1 … lost
  reply` types on after a lost reply with nobody else changing the case; `same-field edits retain both sides…`
  and the A-2 conflict tests stop when the card appears.
- No test answers a conflict's question anywhere but on the card and then uses the draft again (R4A-2).
- The A-2 tests open the second page with `context.newPage()`, which has its own `sessionStorage`: two pages with
  one window id are never tried (R4A-2 route 3), nor is a second window opened during a capture (R4A-5).
- No test checks that the write sent as a page goes away arrives (no test mentions `keepalive`, `pagehide` or
  `visibilitychange`). It arrived in round 3 and does not now, and the suite stayed green (R4A-4).
- `R3-1 an old seal reply never retries as the next person…` covers a reply that comes back after the person
  changed; no test changes the person between the session read and the write (R4A-4).
- One test is flaky: `R3B-2 the first queue cursor survives a new question and settlement elsewhere` (1 failure in
  4 full runs; 27 of 27 alone).

## Worth doing later

- After a reload or a closed tab in the middle of a word, a new case is recorded as two versions, the first
  holding the half word (`logs/cmd-new-reload.log`: `C-2 … v2`; `logs/cmd-closed-tab.log`). Nothing is lost.
- Typing a character and deleting it sends a write that changes nothing and reports `Version 1, by you, just now`
  (`logs/r4-type-delete.log`: one request, `versions ["v1"]`).
- With the editor left open while a tag is removed elsewhere, the editor goes on showing the tag
  (`logs/tabs2-tags.log`: `tagsShownInEditor "#checkout#wip"`); the server ends right.
- The refusal of a reused command id is shown to the person as the server wrote it (`this command id was already
  used for another request; send new content under a new id`).
- Still as round 3 found them: an unsaved new case shown again after a reload opens only with a click and is not
  sent by itself (`logs/recheck-r2-4.log`: `after j k k … sel C-1`, unsent 32 s later); a list pasted into the empty
  title of a new case whose first line has no marker is recorded with an empty title (`logs/capture-paste.log`:
  `title "", steps ["Login works", …]`); a version recorded by somebody else shows `v2 | row ✓ | pane ~` for as
  long as the list read is slower than the case read (`logs/more-external-proof.log`: 900 ms), then heals; `u`
  with a version row focused restores the version before that row, and nothing says which.

## Engine observations (not judged here)

- None that is a defect. The server answers a repeated command id with the reply it recorded, also when that
  reply was "conflict" for a question that has since been decided; that is right for a retry, and it is what
  makes R4A-2 a loop on the client. Two steps sent with one id are given distinct ids (`logs/dupstep.log`). Which
  requests the server refuses outright: `logs/apierr.log`.

## Mistakes in my own method

- The first start of the suite ran nothing (`/usr/bin/time` is not installed here); rerun with shell timing.
- Suite run 3, the one with the failure, ran while four of my probes were running; the other runs had fewer
  beside them (one to three). The failure may be load, though the test did not fail in 15 runs under twelve busy
  loops.
- A wait loop of mine matched its own command line and had to be killed; it only printed logs.
- The first form of the "clean draft is kept" mutation changed two places and did not bring the old behaviour
  back (the seal still removed the clean draft), so the test passed (`logs/mutations.log`, fifth entry); the
  complete form, three places, fails it (`logs/mutations-a3-clean.log`). The 9 of 9 counts the complete form.
- R4A-2 was first rated on the duplicated-tab route alone (not blocking); it was re-rated when the one-tab route
  (reject, then edit) reproduced. The earlier wording is kept in `logs/report-in-progress-defects.md`.
- `probes/person.ts` replaces the browser's cookie through the browser context's request API at the chosen moment,
  not through a second tab's sign-in form; the ordering is forced, the gap is the product's.
- Headless Chromium never hides a tab. "Two windows" here means two pages of one browser context, both visible;
  what a real tab switch does (the hidden tab seals) is taken from round 3's emulation, rerun
  (`logs/tabs2-switch.log`).

## Not checked

- Everything in parts B and C: Queue, Runs, Changes, Settings, sign-in and sessions beyond R4A-4, keyboard
  coverage, layout at 1280x800 and themes.
- The engine changes listed in the brief (dispute rule, `pending` gate, rule sign-off) as they show in the UI.
- A person's edit that needs somebody else's answer (the `submission: waiting` path): not reached; whether the
  stored-request defects have a form there is unknown.
- That a new tab frees a draft stuck by R4A-2: read from the code, not run.
- A real "Duplicate tab" from the tab strip, a real tab switch, and any browser other than headless Chromium;
  whether a real reload or tab close delivers the going-away write there.
- Mutations of the round-2 fixes (round 3 ran them, 7 of 7); here only the round-3 fixes were mutated.
- Full device storage, custom fields, case producer settings, drag and drop onto a folder, move, archive and tag
  undo: by the authors' tests only (3 of 4 full runs green, see check 1), not independently.
- Speed, beyond the authors' latency test passing (its printed p95: 13 to 21 ms on 2,000 and 10,000 cases) and
  one caret sample.
- IME input, screen readers, mobile widths, Cmd on macOS.

Cleanup: no server or browser of this review is running; `/tmp/mainworthy-ui-r4a`, the scratch copy `mut/` and
`tree/node_modules` are removed. The `/tmp/mainworthy-e2e-*` directories and port locks left by other runs were
not touched.

ISSUES (3 blockers)

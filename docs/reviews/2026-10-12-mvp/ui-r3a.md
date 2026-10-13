# Mainworthy web UI: independent verification, round 3, part A (the authors' tests, capture, editing and versions)

Revision judged: `b11d2307959bd1ea7f5edea6351cd5cc7bbf077f`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's main authors (GPT 6.1 Sol). Two files
this part touches were written by Claude Opus 5.5, the same model as this reviewer: `src/web/case/pane.tsx` (the
tall-proposal rule) and `src/web/lib/device.ts` (storage keyed by the person). Neither is the subject of a finding
here; where they were exercised (a proposal answered from the case pane) it was by running them, and the
different-provider reading of those two files is the other reviewers', not this one.

Status: complete. Nothing in the repository was changed.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled: every optimistic change either becomes the
server's record or is rolled back visibly with the person's input kept; no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision.** The round-2 findings in this part are fixed, and ordinary capture and editing
hold at full typing speed behind slow writes. It fails in four places: text typed after a reload, a closed tab or a
lost reply is discarded while the UI says "Version N, by you, just now" (A-1); the same happens to the second of
two windows of one browser on one case (A-2); a draft kept from an earlier look puts back tags and requirement
links that somebody removed (A-3); and the open case's Proof block keeps a green tick after somebody else
recorded a failure (A-5).

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium`
  (`--headless=new --ozone-platform=headless`), real server processes on 127.0.0.1. Nothing in the export was
  changed: the authors' suite ran unpatched on its own ports (7400 to 7499); my probes start their own servers on
  8300 to 8349 with data under `/tmp/mainworthy-ui-r3a`.
- Probes are in `probes/` (run from `tree/` as `bun ../probes/<name>.ts [scenario]`; first `bun install
  --frozen-lockfile` in `tree/`, whose `node_modules` is removed at the end of this review), output in `logs/`,
  screenshots in `shots/`. Every probe drives the real UI with trusted key events and then reads the server through
  its API. Slow, failing and lost replies are injected at the browser (`page.route`).
- Each blocker was reproduced at least twice. Mistakes in my own probes are listed at the end.

## Round-2 findings, re-checked on this revision

| Finding | Result here | Evidence |
| --- | --- | --- |
| R2-3 a new case idle for 30 s closed its editor | **fixed** | `logs/recheck-r2-3.log`, All cases and a folder view: sealed after 30021 ms and 30016 ms, `focus TEXTAREA[…:action], editors 1`; the rest of the sentence lands in the same step (`version 2, ["Add two items and check the total"]`), case count +1 only. Also with the reply 1.5 s away and typing during it, twice: `versions ["v2","v1"]`, full text (`logs/capture-idle-inflight.log`). |
| R2-4 a failed new case was not shown after a reload | **fixed** (two limits, see "Worth doing later") | `logs/recheck-r2-4.log`: after the reload `["C-1 Existing", "new First unsaved case draft", "new Second unsaved case draft", …]`; each was sent once (`C-3 First unsaved case`, `C-2 Second unsaved case`), `storage []` at the end. |
| R2-6 selecting a case left the folder | **fixed** | `logs/recheck-r2-6.log`: `j` → `/p/scratch/suite/c/8?folder=Accounts, "Accounts", "6 cases"`; the same after a reload, a click, Back, Back, Forward; a capture sealed in the folder stays in it (`c/31?folder=Accounts, "7 cases"`); `?tag=checkout` survives `j` and a reload. |
| R2-8 a proposal arriving on an open case did not appear | **fixed** | `logs/recheck-r2-8.log`: `card appeared after ms: 57`, with and without a draft. With a draft: focus stays in the title, my text stays, my seal makes version 2, the agent's adoption comes after as `v3 by reviewer (agent)` with my title kept. |
| R2-9 the list cursor opened a stored draft's editor | **fixed for `j` and `k`; the same shape remains for the folder keys (A-4)** | `logs/recheck-r2-9.log`, twice: on C-2 `editors 0, focus DIV`, `"Draft kept on this device. Press e to continue."`, the row keeps its `draft` mark; second `j` reaches C-3; `e` brings back `Case 2, my wording` and the conflict card. |
| R2-10 " > " typed in a step with an expected result replaced it | **fixed for the reported case; one residue (A-6)** | `logs/recheck-r2-10.log`: action `Open billing from Settings > Billing`, expected `The invoice list is shown`, the same on the server as version 2. |
| Astra: Back then Forward hid an unfinished new case | **fixed** | `logs/recheck-back.log`, twice: after Back the draft is a row (`new Back navigation draft draft`); after Forward the editor is back with both fields and the caret in the step, no reload. Back does not send it (the server still has one case): it stays a draft. |

## Checks

| # | Check | Verdict | What ran and the deciding lines |
| --- | --- | --- | --- |
| 1 | The authors' tests | **pass**, with gaps listed under "The tests do not prove this" | `bun test test/e2e` three times, unpatched: `64 pass, 0 fail, 506 expect() calls` each time, 165.13 s, 167.51 s, 173.80 s (`logs/e2e-{1,2,3}.log`). No flaky test. `bunx tsc --noEmit`: exit 0. `bunx biome check src/web test/e2e`: `Checked 54 files in 53ms. No fixes applied.` `bun test test/architecture.test.ts`: `12 pass, 0 fail`. Judged by disabling one fix at a time in a scratch copy of the export (`probes/mutate.py`, `logs/mutations.log`; the copy, `mut/`, is removed): the tests for R2-3, R2-4, R2-6, R2-8, R2-9, R2-10 and Back/Forward each fail with their fix removed (7 of 7). One named claim has no test that can fail: the row's proof changing in the same update as the badge. |
| 2 | Capture (J1) | **issues** (A-1 blocks) | `logs/capture-j1.log`, every request delayed 500 ms, typed at 130 keys a second: `keys {"total":169,"text":161,"beyondText":8}`; `caret {"inNewCaseOnNextFrame":true,"ms":18.4,"rowOnThatFrame":true}`; the row mirrored the title; all six step fields correct before leaving with no write sent yet; server `version 1, tags ["checkout"]`, six steps, three with an expected result, one write. Three cases in a row with Shift+Enter behind 500 ms writes: three cases, one version each, in order (`logs/capture-rapid.log`). `c` typed before any read has returned, on three URLs: all three land, in the right folder (`logs/more-early.log`). Exactly one version on Escape, Ctrl+Enter, `j`, a click on another row and `g q` (`logs/capture-leave.log`: `versions ["v1"], creates 1` five times) and after 30 idle seconds. Two unchanged edits: still `["v1"]`, no write; `c` then Escape with nothing typed: no case, no row. Pasted four lines became four steps, two with their result (`logs/capture-paste.log`). Reload and closed tab mid-word: the draft and the caret come back (`focus TEXTAREA[title]`). **Fails:** what is typed after that is discarded (A-1). |
| 3 | Editing and versions | **issues** (A-2, A-3, A-5 block) | `logs/edit-versions.log`: a step edit makes version 2; `v` shows `v1 → v2 · b2.action … ~ Apply the coupon OLD10 > Total drops`; `z` widens the pane (486 → 704 px) and back; `u` restores as version 3 (`["v3 b2.action","v2 b2.action","v1 created"]`), and with a version row focused restores the one before it as version 4 (`logs/more-restore.log`). Badge, row proof and pane proof sampled on every frame behind 400 ms reads: `["v1|row H✓|pane ✓","Draft|row H✓|pane ✓","v2|row H~|pane ~"]`, no frame with version 2 and a tick. Two browsers (separate storage): different fields both land (`version 3`, title from A, step from B); the same field gives a conflict card with both sides, resolved to version 5 with five versions kept (`logs/edit-tabs.log`, `devices`). A draft is not replaced by an agent's proposal (R2-8 row above). **Fails:** two windows of one browser lose the second edit, with no conflict (A-2); a stored draft shows an old version and re-adds removed tags and links (A-3); a result from another producer leaves a green tick in the pane (A-5). |

## Defects

### A-1: Text typed after a reload, a closed tab or a lost reply is thrown away, and the UI says it was recorded

Blocks: **yes**.

A draft keeps one command id (`cmd`) until a reply for it comes back. The server answers a command id it has seen
with the reply it recorded the first time, whatever the request now contains (`src/server/ops/registry.ts`,
`findCommand`). So when a seal reached the server but its reply did not reach the page, the next seal of the same
draft, with more text in it, is answered "adopted, version N" for the OLD text. The client then reads version N,
finds its own text equal to what it just sent, takes the server's body (`mergeBodies({ base: body, mine:
normalized.body, theirs: adopted })` in `sealDraft`, `src/web/suite/index.tsx`), removes the stored draft and
shows "Version N, by you, just now". The words typed since are in no version, not on the device and not on the
screen.

The reply is lost in three ordinary ways, each reproduced:

1. **Reload in the middle of a word** (the page seals with `keepalive` as it goes away, and dies before the reply).
   `probes/cmd.ts edit-reload`, twice, identical (`logs/cmd-edit-reload.log`, `shots/cmd-edit-reload-1.png`):
   click step 1 of C-1, End, type ` and ask for a ref`, reload. The editor comes back with the caret in the step
   (`focus TEXTAREA[aa:action]`, `Open the order and ask for a ref`; the server already holds that as version 2).
   Type `und to the card`: the field reads `Open the order and ask for a refund to the card`. Escape.
   `status "Version 2, by you, just now"`, pane `Open the order and ask for a ref`, server
   `version 2, ["Open the order and ask for a ref"]`, `storage []`.
   The same for a new case, twice (`probes/cmd.ts new-reload`, `logs/cmd-new-reload.log`): typed `Refund is sent to
   the original pay`, reload, `ment method`, Escape: server and pane `C-2 Refund is sent to the original pay v1`,
   still so 32 seconds later.
2. **Closed tab, opened again** (`probes/cmd.ts closed-tab`, `logs/cmd-closed-tab.log`): `c`, `Password reset mail
   arr`, close the tab, open the Suite again: the draft is back with the caret in it. Type `ives within a minute`,
   Escape: `status "Version 1, by you, just now"`, pane and server `C-2 Password reset mail arr v1`, `storage []`.
3. **A request the server applied whose reply was lost** (`probes/cmd.ts lost-reply`, `logs/cmd-lost-reply.log`):
   `e`, type ` for a card`, Escape with the reply dropped: status `Failed to fetch. Your draft is kept on this
   device.` (the server holds version 2). Click the title, End, type ` once only`, Escape: `status "Version 2, by
   you, just now"`, pane and server `Refund case for a card`, `storage []`. The same for a new case.

Promise contradicted: "nothing typed is lost on reload, on a failed request"; J1 "the draft survives a reload and
a closed tab mid-word". It is worse than a failed save because the UI reports success. The round-2 reviews
checked that the draft and the caret come back after a reload; neither typed on and left.

Smallest fix, on the client: a command id belongs to one content. Give the draft a new `cmd` whenever its content
changes after that `cmd` has been sent (keep it only for an unchanged retry). The server could also refuse a
repeated id whose request differs, which would have turned this into a visible error.

### A-2: Two windows of one browser on one case: the second one's edit is thrown away, with no conflict shown

Blocks: **yes** (same cause as A-1; check 3's two-tab promises fail when both tabs are in one browser and visible).

Drafts are stored per case, in storage both tabs share. The second tab, opening the editor, reads the first tab's
stored draft, text and command id included, and continues from it. When both then leave, both requests carry the
same command id; the server replays the first reply to the second, and the second tab drops its text.

Reproduction, 4 of 4 (`probes/tabs2.ts windows`, `logs/tabs2-windows.log`, `shots/tabs2-windows-*.png`; one
browser context, two pages on `/p/scratch/suite/c/1`):

- Different fields. A: `e`, type ` from A`. B: click step 1, End, type ` from B` (B's editor shows A's title too).
  A: Escape. B: Escape. Requests: `A cmd 5fd8df7d {"title":"Coupon case from A",… "Open the cart" …}`,
  `B cmd 5fd8df7d {… "action":"Open the cart from B" …}`. Server: `version 2, steps ["Open the cart", …]`.
  B: status `Version 2, by you, just now`, step field back to `Open the cart`, `storage []`.
- Same field. A: `e`, ` from A`. B: `e`, ` and from B`. A: Escape. B: Escape. Same id twice; server
  `version 2, "Coupon case from A"`; B: `Version 2, by you, just now`, title field `Coupon case from A`,
  `conflict 0`.

What holds: with two separate browsers both promises hold (check 3 above). With two tabs of one window, the tab
that is left becomes hidden and seals at once, so each tab sends its own id and both land (`probes/tabs2.ts
switch`, hidden state emulated because headless tabs are never hidden: `A cmd 9bdc1870`, `B cmd ef2613e2`,
`version 3`). The loss needs both to be visible (two windows), or the first tab's seal still under way when the
second starts. The round-2 probes gave each tab its own storage, and the authors' `merge` and `conflict` tests use
one page and the API for the other side; none can see it.

### A-3: A draft left on the device from an earlier look is reused later: it shows an old version, and puts back tags and requirement links that somebody removed

Blocks: **yes**, for the tags and links: a standing change nobody asked for, undoing another producer's change,
with nothing on the screen to show it. The stale text alone would not block.

Opening the editor stores a draft even when nothing is typed, and leaving without a change does not remove it
(`sealDraft` returns at `!snapshot.dirty`; after `e`, Escape: `storage [{"key":"draft:scratch:C-1","dirty":false,
"base":1}]`). `e`, Enter and a click on a field later prefer that stored draft to the case as it is now (`edit`
and `begin` in `src/web/suite/index.tsx`). It never expires. And a seal sends every tag and every requirement
link the draft holds (`tags: { add: … }`, `cover … on: true`), not only the ones the person typed.

Reproduction 1, tags (`probes/tabs2.ts tags`, `logs/tabs2-tags.log`): C-1 has tags `wip, checkout`. `e`, Escape, `j`.
Somebody removes `wip` (server: `["checkout"]`). `k`, `e` (the editor still shows `#checkout#wip`), add ` v2` to
the title, Escape. Server: `tags ["checkout","wip"]`, placements `["tags: checkout, wip by robin", "tags: checkout
by robin"]`. The same with the editor simply left open while the tag is removed.

Reproduction 2, requirement links (`probes/tabs2.ts covers`, `logs/tabs2-covers.log`): the same keys with a case
covering `REQ-12` and the link removed in between: `start ["REQ-12"], afterRemoval [], server {"version":2,
"covers":["REQ-12"]}`.

Reproduction 3, stale text, twice identical (`probes/edit.ts stale`, `logs/edit-stale.log`, `shots/edit-stale-1.png`):
on C-1 press `e`, Escape, `j`. A colleague records version 2 (new title, new step 1). `k`: the pane reads version 2
correctly (`chip v2, "Coupon case, renamed by a colleague", "Open the cart from the header"`). `e`: the editor
and the list row show `chip v1, title "Coupon case", steps ["Open the cart", …]`, beside a timeline that says two
versions. Editing another step from there is merged correctly by the server (version 3 keeps the colleague's
title and step); editing a field the colleague changed gives a conflict about text the person never saw.

Promise contradicted: "what the UI shows is what the server holds once the UI has settled"; nothing lost "when
another producer changed the same thing". Fix: do not keep (or do not reuse) a draft that is not dirty, bring a
clean draft up to the current version when the editor opens, and send only the tags and links the person added.

### A-5: A result recorded by somebody else leaves the open case's Proof block as it was: a green tick beside a failure

Blocks: **yes**, by decision 0011's "no stale proof" (its example is a green tick that stayed "until the user
navigated away", which is what happens here). It is a judgement: the list row on the same screen is right, and
round 2 rated the same cause for proposals (R2-8) as not blocking. If the owner judges it the same way, the count
drops by one.

The `report` event names the run and the question, not the case (`"op":"report","touched":["R-2","Q-3"]`), and the
client refetches a case and its timeline only when the event names the case (`useEvents`, `src/web/lib/data.ts`;
the exception added for R2-8 covers `propose` only). The list is always refetched.

Reproduction, twice identical (`probes/more.ts external-result`, `logs/more-external-result.log`): C-1 has a pass
and is open. Another producer records a failure for it. After 1 s, 5 s and 20 s: row `H✗`, pane `✓ person · pass
on v1 · basis exact`, the result not in the pane's timeline; server `{"outcome":"fail","current":true}`. After `j`,
`k` the pane reads `✗ person · fail on v1` and shows two results. (By the query settings it should also heal when
the window regains focus; that was read, not run.)

Fix on either side: name the case in the event, or refetch the open case and its timeline on any `report`.

### A-4: With an unsaved new case on the device, a folder key opens its editor and the next keys are typed into its title

Blocks: no (it needs a new case that is still a draft: a save that failed, or a capture left with the browser's
Back button). The same shape as R2-9, which is fixed for `j` and `k`.

Reproduction (`probes/edit.ts folder-editor`, `logs/edit-folder-editor.log`, `shots/edit-folder-editor.png`), with
`propose` failing: `c`, `Unsaved capture`, Escape, `j` (C-1 selected, no editor, focus on the list), `]`:
`url /p/scratch/suite?folder=Checkout, focus TEXTAREA[title], editors 1`. `]`, `j`: the folder does not change and
the draft's title is now `Unsaved capture]j`. Any arrival at a Suite URL without a case does this (the route
effect restores `activeDraft` and the editor takes focus when it mounts). On a reload that is what J1 asks for;
after a key that moves the view it is not.

### A-6: A step whose action already holds " > " and has no expected result is split by the next character typed in it

Blocks: no. The residue of R2-10.

Reproduction (`probes/recheck.ts r2-10`, `logs/recheck-r2-10.log`): a step `Open Settings > Billing` with no
expected result (as the API, an agent or an import may write it; by the code the editor can leave one too, when an
empty expected result is dropped at sealing, which was read, not run). Click it, End, type `!`: action `Open Settings`, expected `Billing!`, focus
moved to the expected field; recorded so as version 3. The split should happen only where the person types the
delimiter, not on text that was already there.

## The tests do not prove this

- **No stale proof.** Decision 0011 says there is a browser test for the row's proof changing in the same update
  as the version badge. With `proof: received.proof` removed from that update, every test whose name mentions
  proof still passes (`logs/mutations.log`, last entry: `1 pass, 0 fail`). The one test (`30 seconds idle records
  one version, preserves the caret and updates current proof`) reads the row after waiting, so a late refetch
  satisfies it. The behaviour itself holds here, sampled per frame (check 3).
- `L2 reload restores an unsealed sentence and its caret` stops once the text and caret are back, and its only
  server assertion sits inside `if (stored.items.length)`. Nothing types on after a reload and leaves: A-1.
- `a failed seal keeps the typed text and retry uses the same command` refuses the request before it reaches the
  server and retries an unchanged draft; it asserts one command id. A changed draft, or a request that was
  applied, is not tried: A-1.
- `reload offers every unsaved new case and each can be sent once` allows one or more rows for the second case
  (its comment explains why: the page may already have sent it) and re-sends unchanged drafts by clicking them.
- `same-field edits retain both sides…` and `a disjoint merge remains in the draft baseline…` use one page and the
  API for the other side. No test opens one case in two tabs, with shared or separate storage: A-2.
- No test leaves a clean draft on the device and changes the case elsewhere (A-3), records a result for the open
  case from outside (A-5), or presses a folder key with an unsaved new case on the device (A-4).
- `J1 captures six steps…` prints the key count and asserts none; it delays no request. (Counted and delayed here.)
- The tests for the seven round-2 fixes in this part do prove their names: each fails with its fix removed.

## Worth doing later

- An unsaved new case shown again after a reload can be opened only with a click (`j` and `k` walk saved cases
  only: `after j k k … sel C-1`), and nothing sends it by itself (still unsent after 32 s, `logs/recheck-r2-4.log`).
  Right after the reload the case the page sent while unloading is listed twice, as `new … draft` and as `C-2`,
  until that draft is left.
- A new case left a second time while its first seal is still under way is not sent then; it waits for the 30 s
  timer (`logs/more-inflight.log`: full text on the server after 31720 ms; for an existing case 3016 ms). The
  screen says Draft meanwhile, so nothing is misreported.
- Ctrl+Enter ("Record version") also leaves the editor, so a person who presses it to save and keeps typing runs
  commands (`#` archives, `u` restores the previous version).
- A list pasted into the empty title of a new case whose first line has no marker becomes steps only; the case is
  recorded with an empty title (`logs/capture-paste.log`: `title "", steps ["Login works", …]`).
- Leaving a new case with the browser's Back button does not send it; it stays a draft row.
- `u` with a version row focused restores the version BEFORE that row (focus v2, get v1's text as v4). Nothing on
  the screen says which.
- A version recorded by somebody else: the pane's badge and the row's proof arrive by two reads, so with the list
  read 900 ms slower the screen shows `v2 | row ✓ | pane ~` for 900 ms (`logs/more-external-proof.log`). It heals
  by itself.
- In the pane's timeline the "n versions by …" line is partly covered by the first question card and shows the
  producer glyph twice (`shots/cmd-edit-reload-1.png`, `shots/edit-stale-1.png`).

## Engine observations (not judged here)

- A command id sent again with a different request is answered with the first reply and no error
  (`src/server/ops/registry.ts`). Correct for a retry; it is what makes A-1 and A-2 silent. Reproduction:
  `probes/cmd.ts lost-reply`.
- The `report` event does not name the case its results are for (cause of A-5). Reproduction: `probes/more.ts
  external-result`, the `events` line.

## Mistakes in my own probes

- The first folder run of the idle probe looked the new case up by a title that the seeded cases also match
  ("checkout"); rerun with a unique title (the log kept is the rerun).
- The first run of the " > " residue looked for a read-mode button while the editor was still open; fixed, rerun.
- `probes/edit.ts tabs-reload` (two tabs of one browser, one reloads) is inconclusive: the request the page sends
  while unloading was not held back by the route, so the server already had the text. It is not used above.
- Tab visibility cannot be produced in headless Chromium; the "tabs of one window" line in A-2 sets
  `document.visibilityState` and dispatches `visibilitychange` by script. That the product seals on a hidden tab is
  read from the code and shown by that emulation, not by a real tab switch.

## Not checked

- Everything in parts B and C: Queue, Runs, Changes, Settings, sign-in and sessions, another person on the same
  browser, keyboard coverage, layout at 1280x800 and themes.
- Speed, beyond the authors' own latency test passing three times (its printed p95: 12 to 16 ms on 2,000 and
  10,000 cases). The only timing measured here is the caret after `c` (18.4 ms, one sample).
- A-1 in a browser other than headless Chromium, and whether a real reload always delivers the unload request
  (when it does not, the draft simply comes back unsent, which is safe).
- Full device storage, custom fields, case producer settings, deleted step ids, drag and drop onto a folder,
  move, archive and tag undo: by the authors' tests only (each 3 of 3), not independently.
- The tall-proposal paging rule in `src/web/case/pane.tsx` (written by Claude Opus 5.5): only a short proposal was
  answered here (first `a` brings it into view, second answers).
- IME input, screen readers, mobile widths, Cmd on macOS.
- The engine, beyond the two observations above.

Cleanup: no server or browser of this review is running; `/tmp/mainworthy-ui-r3a` and `tree/node_modules` are removed.
The stale `/tmp/mainworthy-e2e-*` directories dated 01:44 to 01:56 and the servers on ports 8419 and 8425 belong to
other runs and were left alone.

ISSUES (4 blockers)

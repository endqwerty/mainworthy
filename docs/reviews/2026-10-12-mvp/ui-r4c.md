# Mainworthy web UI: independent verification, round 4, part C

Part C: changes and settings, sign-in and session, keyboard, layout and themes, speed; and the re-check of
R3C-1 to R3C-6 and Astra's R3-1 and R3-2.

Revision judged: `ec98ba41d759e037b2ff7b4b6138f587ee2f15ca`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's author (GPT 6.1 Sol).

Status: complete. Nothing in the repository was changed.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled … no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Holds in this part, with five defects that do not block.** All eight round-3 findings given to this part are
fixed as reported. The session mechanism that fixes R3-1 and R3-2 works for every ordinary sequence I could drive
(before, during and after a write, in one tab and across two), and leaves one gap a round trip wide (R4C-1). It
also has a cost nobody listed: a tab that is closed or reloaded no longer records its draft (R4C-4).

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium` with
  `--headless=new --ozone-platform=headless`, real server processes on 127.0.0.1, ports 8600 to 8649, data under
  `/tmp/mainworthy-ui-r4c`.
- The only files changed in the export are five test helpers (ports moved into 8600..8649, the Chromium flags):
  `test-environment.patch`. No application source and no assertion is changed.
- Probes in `probes/` (round 3's, reused, plus new ones: `person-moments.ts`, `session-cost.ts`,
  `fields-held.ts`, `held2.ts`, `held3.ts`, `misc4.ts`), run from `tree/` as
  `TMPDIR=/tmp/mainworthy-ui-r4c bun ../probes/<name> [scenario]`; output in `logs/`, screenshots in `shots/`.
- Every probe drives the real UI with trusted key events and then reads the server through its API. Slow, held
  and failing requests are injected at the browser (`page.route`).
- R4C-1 was reproduced twice; the comparisons for R4C-4 ran against a round-3 export (`r3/tree`) and against
  scratch copies of this revision with one line changed (`mut*/tree`). The judged export has no source change.
- The machine was shared with the other two reviewers (load average 4 to 10 on 16 cores).

## Round-3 findings re-checked

| Finding | Result here | Evidence |
| --- | --- | --- |
| R3C-1 a key accepted a proposal whose diff had not been read | **fixed** (keys; buttons: see below) | `probes/blind.ts`, `logs/blind.log`. Read delayed 4 s, `a` and `r` twice each: `diffs=0 -> open \| Still reading the proposal. Read its edits before answer`, case `v1 "Proposal case"`. Read answered 500: card says `read failed`, both keys leave it `open`, `v1`. Queue, slow and failed: `after one a: {"q":"open","case":"v1 \"Proposal case\""…}`. |
| R3C-2 closing the palette from a field left the focus on the page | **fixed** | `probes/palette-focus.ts`, `logs/palette-focus.log`, Escape and Ctrl+K, three fields: `focusAfterClose:"TEXTAREA[Step 1]"`, server `C-4 v1 "Checkout total" ["Add two items and check the total"]`, no `C-5`; run note `"The total is wrong, the badge shows a stale price"`, url still `/p/scratch/runs/1`, nothing recorded; queue field `"BUG-1234, the fix is in tomorrow"`. |
| R3C-3 a project admin was offered token and project creation | **fixed** | `probes/scoped.ts`, `logs/scoped.log`, `padmin` with every capability on `scratch` only: policy change works (`standard is in force. Proposal P-2 and decision Q-3 are both recorded.`); `Tokens \| scratch \| An admin creates and revokes tokens.` (no form), `secretShown:0`, tokens on the server unchanged; Projects shows the list and no form. |
| R3C-4 a held key repeated recording actions | **fixed** for the three round-3 cases (more keys: see check 8) | `probes/keys2.ts held`, `probes/tall.ts held`: `p` held eight repeats `slotsFilledBefore:8, after:9`; an answer key held in the queue `openBefore:5, openAfter:5` (`d` opens its field); `#` held `activeBefore:40, activeAfter:39`; `a` held on the 35-step proposal for 40 repeats: `server:"open"`, `Q-3 is now in view. Read it, then press a again.` |
| R3C-5 focus stayed in a `select` after a change | **fixed** | `probes/keys2.ts select`: `focus:"BODY[]", jMoved:true, editors:1`. |
| R3C-6 Settings and Suite on a project the session may not read | **fixed** | `probes/scoped2.ts`, `logs/scoped2.log`: `second/settings at 600 ms: … Policy \| second \| Your session may not read this project.` (also at 3 s and 7 s); `second/suite at 600 ms: All cases \| Reading cases…`, at 3 s `Cases unavailable … Your session may not read this project.`; no "No cases yet" in between. |
| R3-1 a pending draft reply continued under the next person | **fixed** | Astra's `probes/pending-person.mjs` unchanged, twice: `timeline:[{version:2,by:"alice"},{version:1,by:"daniel"}]`, `serverSteps … "Alice submitted text"`, `writes` holds one request, Bob's stored draft still there (`mainworthy:bob:draft:scratch:C-1 = ["Bob private unsubmitted text"]`), Alice's too. Across two tabs: `probes/person-moments.ts during`, `versions:["v2 by alice","v1 by daniel"]`. |
| R3-2 another open tab kept the previous person's input and recorded it as the new person | **fixed, with a narrow gap left (R4C-1)** | Astra's probe now stops because tab A shows the sign-in (`logs/identity-tabs.log`). `probes/person-moments.ts before`, case and run note: `aAfterBob:{"signin":1,"app":0}`, `aInputs:[]`, the keys pressed there record nothing (`versions:["v1 by daniel"]`, `["C-1:-","C-2:-"]`), Alice's text stays on the device under her name and comes back when she signs in again on A. |

## Checks

| # | Check | Verdict | What ran and the deciding lines |
| --- | --- | --- | --- |
| 6 | Changes and Settings | **pass** | **Changes** (`probes/session.ts changes`, `logs/session.log`): gate, open and settled questions, impact and uncovered files (`pr:500 … Passed … 1 pass … OPEN QUESTIONS … SETTLED AND EXCUSED … IMPACT … UNCOVERED FILES src/cart.ts`); 16 fast switches behind unevenly delayed reads: `distinct frames: 19`, `frames pairing a header with another change's gate: []`. A commit only an agent reported (`probes/misc4.ts changes`): server `verdict:"pending"`, row `pr:901 agent-only No evidence for the latest commit pending`, detail `Pending \| pending: nothing a gate counts has been reported for this commit`; the pipeline's commit beside it `Passed`. **Policy**: `standard is in force. Proposal P-2 and decision Q-2 are both recorded.`, server `Q-2 1 edits accept by daniel`. **New token**: `local:false, session:false, cookie:false, text:false`; after dismiss and reload `html:false, fields:0`. **Scoped tokens** (`probes/scoped.ts`): the instance grant is `can:[]` in every case and each screen follows the project's: a reader of `scratch` gets run buttons `[false,false,false,false]`, `p f … Enter` record nothing (`fills:[0,0,0]`), `You cannot settle this`, preset and switch disabled, a capture kept as a draft with `propose needs the produce capability on scratch. Your draft is kept on this device.`; read+produce records `tester/pass`; a token on `second` sees only `second` and on `scratch` reads `Your session may not read this project.` **Revoking** (`probes/scoped2.ts`): the next request is refused and the sign-in is shown 25 ms later (`"3013:get:401"`, `signin:true, atMs:3038`). A tab that makes no request: R4C-5. |
| 7 | Sign-in and session | **pass**, one gap (R4C-1) | `logs/session.log`. Local mode: `{"app":1,"token":0,"cookies":0}`. Server mode: `asks for the token: {"app":0,"focused":"token"}`; wrong token `That token was not accepted. Try again.`; cookie `httpOnly:true, sameSite:"Strict"`, `script-visible: {"cookie":"","local":false,"session":false}`. Refused session: `{"signin":1,"app":0}`, nothing recorded (`slot 2 on the server: []`). Another person on the same page (`probes/persons.ts`, `logs/persons.log`; edit, new case, run note, queue reason): Bob sees `inputs:[]`, `draftRows:[]`, `body:[]` and after an idle wait `writes:[]`; Alice signs in again and has `Step 1=Alice private unfinished sentence`, `Result note=…`, `answer-extra=…`, recorded `"by":"alice"`, `alice/fail/…`, `Q-3 flaky by alice`. Second project: `switcher:["scratch","second"]`, switching back shows its 3 rows. Change of person at each moment of a write: see "Round-3 findings" (R3-1, R3-2), R4C-1 and the section on the session check. |
| 8 | Keyboard, layout, themes | **issues** (not blocking) | **Keys** (`probes/keys2.ts sheet`, `keys3.ts`, `layout.ts keys`, `misc4.ts keys`): the `?` sheet lists 33 bindings on Suite and Case, 24 on Queue, 13 on Runs, 30 in a run, 12 on Changes and Settings. Pressed and observed: Suite `c e Enter j k arrows / Escape Ctrl+Enter Shift+Enter x t # u ] Alt+[ n f [`; Case `v z Space u a r`; Queue `j k arrows`, answer keys, `x j x i` (two questions answered at once: `decided:["Q-11:infra","Q-5:infra"]`), `u`; Runs `j k Enter n`; run `j k arrows`, `2` (step marked), `f` note Escape/Enter, `p b s u`; Changes `j k Enter`; Settings `j k n`; shell `g s/q/r/c/,`, `[`, Ctrl+K, `?`. Fails: `u` in the Queue under `strict` (R4C-2). **Plain keys in inputs**: filter and tag box take `cejkxmt#u z` and `c#um` as text (`drafts:0`); see also the palette rows below. **Palette**: finds cases by words (`Password reset restores access C-3 …`), opens one (`/p/scratch/suite/c/3`), runs a command (`/p/scratch/queue`). **Palette and focus from every field** (`probes/fields-held.ts fields`, `probes/held2.ts planner reason`; Escape and Ctrl+K each): 16 fields: Suite filter, tag box, new folder; new case title and step; case page title and step; run name, planner Tag, Search and Folder; run note; queue reference and reason (all five answers under `strict`); token actor; project key; policy preset. Every one: `sameElement:true`, the next characters `cd g, #u` land in the field, `urlMoved:false`, `serverChanged:{}`, `runs planned by accident: 0`. **Held keys** (`probes/fields-held.ts held`, `held2.ts`, `held3.ts`; one keydown and nine or ten repeats): one action each for run `p`, `b`, `s` (`fills 8 -> 9`, `9 -> 10`, `10 -> 11`), Enter in the note (`fills 11 -> 12`), `u`; queue `d t e f i` (one `decide` request each), Enter in the reference and reason field (one `decide`), `u` (one `{"undo":"Q-9"}`); Suite `#` (`40 -> 39`), `u` (`38 -> 39`), Ctrl+Enter and Shift+Enter in a new case (one case each), Escape in an edit (`versions 1 -> 2`, one write), Enter in the tag and new-folder box (one each); case page `u` (`v2 -> v3`, not v4); Runs name Enter (`runs 1 -> 2`); token Enter (`tokens 3 -> 4`); project Enter (`projects 1 -> 2`); palette Enter (one editor); `a` on the tall proposal (`server:"open"`). Leftover: R4C-3. **Clipping**: seven screens at 1280x800 and 1440x900 in both themes, no `clipped` line in `logs/layout.log`. **Themes**: 28 screenshots plus sign-in, key sheet, palette and token panel in both themes. Looked at as light/dark pairs: Suite with the case pane, Queue, a run, Runs, Changes, Settings at 1280x800 (`shots/pairs/`), the case at 1440x900, and the four overlays (`shots/ov-sheet-1.png`, `ov-sheet-2.png`): text, proof marks, answer keys, the focus ring and the refused-token message are legible in both. |
| 9 | Speed (P1) | **pass** (a measurement) | `probes/latency.ts`, `logs/latency.log`, 10,000 real cases, 200 samples each, timed from the capturing keydown; "frame" is the next animation frame, where the state is checked, "painted" the one after. p50 / p95 / max in ms: `j` frame 16.0 / 18.3 / 30.2, painted 31.2 / 34.1 / 41.8; `k` 17.7 / 19.6 / 29.7 and 32.2 / 33.2 / 41.4; `c` to a focused caret 16.6 / 28.1 / 52.0 and 32.6 / 36.5 / 67.1; a typed character 16.3 / 16.7 / 22.0 and 32.6 / 33.2 / 35.7. Budget 100 ms at p95. `wrong:0` for `j`, `k`, `c`; `typed characters on server: 200` (the one "wrong" typing sample is a title character my script sends without waiting a frame, as in round 3). Headless Chromium, frames as a proxy for paint, load average 7.9 to 9.8 on 16 cores: not a guarantee. The authors' `latency.test.ts` was not run (it would have competed with reviewer A's suite). |
| – | Authors' tests for this part | pass, with gaps | Single files: `signin.test.ts` 3 pass, `settings.test.ts` 2 pass, `shell.test.ts` 2 pass, `round3-session.test.ts` 6 pass, `round3-interactions.test.ts` 21 pass (`logs/authors-*.log`). Sensitivity: see "The tests do not prove this". |

## What the session check costs, and whether it holds

`src/web/lib/api.ts`: before `propose`, `decide`, `report`, `plan` and `admin` the page reads `/api/session` and
compares the actor with the person it was opened as; every call also carries a session object that stops being
current when the page's person changes; another tab's sign-in is announced through `localStorage`.

- **Time** (`probes/session-cost.ts cost`, 10,000 cases, 40 results recorded with `p`): 41 session reads for 40
  writes, 604 bytes each; the check 1.3 / 1.7 / 1.7 ms (p50 / p95 / max), the write itself 3.9 / 5.3 / 5.6 ms,
  key to recorded 21.7 / 24.7 / 26.0 ms. On loopback the check adds about a third to a write's time. Over a real
  link it is one more round trip per write.
- **Keys do not wait for it.** With the read held 2 s (`slow`): `p` painted and the cursor on the next slot 11 ms
  after the key; `p b s f`+note+Enter typed in 110 ms; settled `["C-1:pass","C-2:blocked","C-3:skip","C-4:fail(slow
  session note)"]`. With the first read slow and the later ones fast (`order`), `p`, `u`, `f`+note on one slot
  left in that order (`pass`, `skip … corrects:1`, `fail … corrects:2`); server `C-1:fail(really a failure)`.
- **A failed check is a failed write, with the input kept** (`fail`): run `C-1 was not recorded: Failed to fetch.
  Its note is kept. Return to the slot to retry.`, slot back to `missing`, the note stored under the person and
  slot; new case `Failed to fetch. Your draft is kept on this device.`, row `new … draft`, recorded by the next
  Ctrl+Enter (`C-7`); queue `Failed to fetch`, the question back in the list, `BUG-12` still in its field when
  `d` is pressed on it again, then `decided`.
- **A closing tab no longer records** (R4C-4).
- **Change of person**, two tabs of one browser (`probes/person-moments.ts`): *before* the write: tab A shows the
  sign-in, its keys record nothing, Alice's text is kept for her. *During* (the write has reached the server, its
  reply is held, Bob signs in): `versions:["v2 by alice","v1 by daniel"]`, her newer text still stored, nothing
  as Bob. *Between the check and the write*, the other tab's note arriving first: `sentByA:[]`. The same with the
  note late or absent: **gets through** (R4C-1).
- The two guards cover for each other in the authors' tests: with either one removed `round3-session.test.ts`
  still passes 6 of 6; with both removed the two R3-2 tests fail (`logs/mutation-*.log`, scratch copies in `mut*/`).

## Defects

### R4C-1: A change of person during the session check's round trip still gets through: the first person's text is recorded as the second person

Blocks: **no**, in my judgement (it needs two things to happen inside one network round trip, and one person at
one keyboard cannot produce it with keys; a timer can). It is the answer to the brief's question "can a change of
person between the check and the write still get through": **yes**. Daniel may weigh it differently, because what
it does when it happens is exactly what R3-2 did.

A write is now two requests one after the other (`src/web/lib/api.ts`, `call`): `GET /api/session`, compare the
actor with the person the page was opened as, then the write. The write carries no name; the server takes the
person from whatever cookie the browser holds when the second request leaves. So the guard is only as fresh as
the first reply. The second guard, the note another tab leaves in `localStorage` (`mainworthy:session-person`),
is written only after that tab's own first session read has come back, one more round trip later.

Reproduction (`probes/person-moments.ts between-slowB`, `logs/person-moments.log`; both surfaces, the same
result): one browser, two tabs. Tab B shows the sign-in. Alice signs in on tab A and types (a case edit; a run
note). On A the write key is pressed (Ctrl+Enter; Enter): A's session check is answered `alice` by the server and
its reply is held on its way back, as a slow link would. Bob signs in on B; B's first session read is held too.
A's reply arrives:

```text
between/slowB/case: checkAnswered:["alice"], sentByA:["propose \"Alice private case from tab A\""],
  server: versions:["v2 by bob","v1 by daniel"], step:["Alice private case from tab A"], stored:{}
between/slowB/run:  checkAnswered:["alice"], sentByA:["report \"Alice private note from tab A\""],
  server: ["C-1:fail/bob/Alice private note from tab A","C-2:-"], stored:{}
```

Alice's text is a version (a failing result) by Bob, and her copy on the device is gone (`stored:{}`), while A
shows the sign-in. With the other tab's note arriving first (`between-storage-first`) the guard holds:
`sentByA:[]`, `versions:["v1 by daniel"]`, her draft still stored. With a sign-in that leaves no note at all
(`between-no-storage`, the cookie replaced by a request that is not the app) the result is the same as `slowB`
and A goes on saying `alice`, `Version 2, by you, just now`.

How wide: Bob's sign-in reply has to land while A's check is on its way, so the window is one round trip of the
session read (1.3 ms at p50 on loopback here; tens to hundreds of ms on a real link), and A must start a write in
it. A person cannot press a key on A while signing in on B. What can: the 30-second idle seal of a draft left
dirty in another window (a window, not a tab: hiding a tab seals the draft at once, as Alice, which is right).

Promise contradicted: R3-2's ("an old page must not write under a different person from the one its editor
represents"). The client cannot close this by itself. Smallest fix: the write names the person the page believes
it is (a header or a field), and the server refuses it when the session's actor differs. That also removes the
extra read (see "What the session check costs").

### R4C-2: Under the `strict` preset an answer in the Queue cannot be withdrawn: `u` is refused and the screen says only "a reason"

Blocks: **no** (nothing wrong is recorded; the answer stays as it was). It is on part B's screen; it is here
because check 8 asks that every action in the footer and the `?` sheet works from the keyboard, and this one does
not work at all under one of the three presets.

Reproduction (`probes/held3.ts undo`, `logs/held3-undo.log`; seen first in `logs/held2-queue.log`,
`queue/strict: u held`): policy `strict`, a failing result reported by a pipeline. Queue, `i`, type
`the runner was down`, Enter: `afterAnswer:"decided"`. Press `u`:

```text
afterU:"decided", status:"a reason", field:0
reply: {"ok":true,"result":[{"q":"Q-5","status":"invalid","needs":"a reason", …}]}
```

The client sends `{"undo":"Q-5"}` with no reason (`src/web/queue/index.tsx`, `undo`), the server wants one under
`strict`, and the UI has no field for it. The question comes back as decided, which is right, but the status line
is the two words `a reason` and there is no way to give one. Under `standard` the same key works
(`withdrawn:["Q-9:infra"]`, `Answer withdrawn. Both decisions stay in the ledger.`). Smallest fix: `u` opens the
same reason field the answers use when the policy asks for one, and the refusal is a sentence.

### R4C-3: A key that opens a field, held a moment too long, types its own repeats into that field

Blocks: **no**. What is left of R3C-4. Every recording key now acts once per press (see check 8). But a key that
opens a field hands the keyboard to that field while it is still down, and the repeats that follow are text.

Reproduction (`probes/held3.ts open`, `logs/held3.log`; one keydown, then nine repeats 33 ms apart):

```text
suite, new case: c held          TEXTAREA[Case title]="ccccccccc"
suite, edit case: e held         TEXTAREA[Case title]="Expired coupon is rejectedeeeeeeeee"
cockpit, fail and note: f held   INPUT[Result note]="fffffffff"
runs, plan run: n held           INPUT#run-name[]="nnnnnnnnn"
queue, defect reference: d held  INPUT#answer-extra[]="ddddddddd"   (under strict the same for t, e, f, i: the reason field)
settings, new token: n held      INPUT#token-actor[]="nnnnnnnnn"
e held on C-3, then Escape:      v1 "Password reset restores access" -> v2 "Password reset restores accesseeeeeeeee"
```

The text is on the screen, and nothing is recorded until the person presses Enter or leaves the editor. With `e`
the leaving is one Escape, and it records a version whose title ends in the repeats. On a real keyboard the
repeats start after the system's delay (about half a second), so one stray letter needs a press that long. macOS
does not repeat letter keys by default. Smallest fix: after a key opens a field, swallow that key's repeats until
its keyup.

### R4C-4: A tab that is closed or reloaded no longer records its draft (a cost of the session check)

Blocks: **no** (the text is kept on the device and is there when the person comes back to this browser).

The Suite still asks for a last write when the page is hidden (`sealRef.current({ keepalive: true })`), and the
status line still says `A version is recorded when you leave, press ⌘↵, or pause for 30 seconds.` But the write
now waits for the session read first, and a page that is going away never runs what comes after it.

Reproduction (`probes/misc4.ts close`, `logs/misc4-close.log`): `c`, a title, Enter, a step; close the tab (or
reload) at once; ask the server 2 s later.

```text
this revision:                 onServerAfter2s: []            after returning: row "new … draft", both fields restored, server []
round 3 (b11d230):             onServerAfter2s: ["C-4 …"]     (logs/misc4-close-r3.log)
this revision, check removed:  onServerAfter2s: ["C-4 …"]     (logs/misc4-close-mutation.log, a scratch copy)
```

So a case typed and left by closing the tab is seen by nobody else until its author opens Mainworthy again in the
same browser. Nothing says so. Either send the last write without the read (the server-side check proposed in
R4C-1 makes that safe), or stop promising it.

### R4C-5: A tab whose event stream has been refused stops being live and says nothing

Blocks: **no**.

`useEvents` (`src/web/lib/data.ts`) has no error handler. An `EventSource` that gets an HTTP error does not try
again. Reproduction (`probes/misc4.ts idle`, `logs/misc4-idle.log`): sign in with a person's token, revoke it,
touch nothing: `seen:["3s:app","15s:app","40s:app"]`, `requests:[… "21811:events:401"]`; a case made by somebody
else after that never appears (`showsNewCase:0`). The tab shows what it had read, as if current, until the
person does something that makes a request (then the sign-in is shown, `scoped2.log`). From reading only, not
run: the same would follow any HTTP error on the stream, for instance a proxy answering 502 while the server
restarts. Smallest fix: on the stream's error, ask `/api/session`; show the sign-in when refused, otherwise open
the stream again.

## The tests do not prove this

- The session check has no test of its own, and neither has the note between tabs: `round3-session.test.ts`
  passes 6 of 6 with either removed (`logs/mutation-no-session-check.log`,
  `logs/mutation-no-storage-listener.log`) and fails only with both gone. No test has the other tab's note late
  or missing (R4C-1).
- `R3C-2 … palette restores the field and caret` (case, run, queue) and both `R3C-4` tests do fail when their
  fix is removed (`logs/mutation-repeat-and-palette.log`: 8 fail). They cover three fields and four keys; the
  other thirteen fields and the other recording keys are covered by my probes only.
- `R3C-4 … held letters still type in a field` asserts that repeats are text once a field has the focus; nothing
  looks at the key that opened the field (R4C-3).
- No test withdraws an answer under `strict` (R4C-2). No test closes or reloads a tab with a dirty draft and then
  asks the server (R4C-4). No test revokes a token under an idle tab (R4C-5).
- `R3C-1 … wait for a slow/failed proposal read` covers keys and buttons; nothing covers the page reading the
  proposal again after a failure.

## Worth doing later

- A proposal whose read failed says `read failed` and has no control to read it again; it did not read again by
  itself in 2.5 s (`logs/misc4-buttons.log`). I did not establish what else makes it read again short of a reload.
- After a failed answer in the Queue the status is the bare `Failed to fetch`; the run names the slot
  (`C-1 was not recorded: …`). The cursor is already on the next question, so Enter or the same key answers that
  one.
- The `?` sheet is still one column in a box that scrolls: at 1280x800 the entries from "Next folder" down are
  below its edge, with half the sheet empty beside them (`shots/ov-sheet-1.png`).
- The sheet and the palette still list bindings whose condition is false (`New project n` on the Policy section,
  `Accept proposal a` on a case with no proposal).
- Opening the project switcher and choosing the project already shown fires no change, so the focus stays in the
  `select` and keys are dropped until a click (from reading; round 3's probe chooses through the change event).
- There is still no sign-out; the only way to hand the browser to somebody else is a refused token or a second
  tab left on the sign-in.
- The footer on Changes and Settings still shows the Suite's sentence about drafts.

## Outside this part (one paragraph each)

- **Capture, for whoever fixes R4C-4** (seen only in my scratch copy with the session check removed, so not a
  finding on this revision): when the last write does leave a closing tab, the server has `C-4` and the tab that
  opens next shows both `C-4` and a row `new … draft` with the same text. Whether sealing that draft makes a
  second case I did not follow (`logs/misc4-close-mutation.log`; round 3 behaved the same,
  `logs/misc4-close-r3.log`). It is part A's A-1/A-2 ground.
- **Queue under `strict`**: R4C-2 above is on part B's screen.
- **Engine**: nothing found. Under `strict` the server asks for a reason to withdraw an answer; that looks
  intended and the gap is the UI's.

## Mistakes in my own probes

- `probes/session-cost.ts fail` first started failing the session read before the Suite had loaded, so the app
  itself showed its reconnect screen; and its queue part first pressed `f` under `standard`, which answers at
  once, and then typed a sentence as keys. Both corrected; the logs quoted are from the corrected runs.
- `probes/fields-held.ts` prints `ok:false` for six rows where the field already held text (an existing title, or
  a draft the earlier row had left): the typed characters did land in the field (`sameElement:true`). Its `/`
  and `t` rows in `held3.log` were typed into an editor an earlier row had left open and are not counted. Its
  first queue rows ran out of failure questions (`i`, `n`, `m`, `u`, Enter in the field): redone on fresh data
  in `held2.ts`.
- `scoped.ts` again reports `sign-in after ms … -1` for the revoked reader, the same mistake as in round 3 (its
  `j` goes into a restored editor); `scoped2.ts` is the valid run.
- Astra's `identity-tabs.mjs` stops with a timeout on this revision because tab A shows the sign-in; that is the
  fix, not a failure. `person-moments.ts before` replaces it.
- Resource timing kept only the first 8 of 40 writes in the first cost run (buffer full); rerun with a larger
  buffer.

## Not checked

- `m` (move) in the Suite this round (round 3 pressed it). Space in the Queue (it changed nothing visible on the seeded question), `Take advice` with Enter, and the
  answers `n` and `m`, which my data did not offer. Whether the step marked with `2` reaches the server (the mark
  is shown; that is part B's R3B-4).
- The 1440x900 screenshots by eye, except the case screen (all seven were measured for clipping). The Projects
  and Connect sections of Settings in dark theme.
- R4C-1 on a real slow link (the round trip was stretched by holding replies in the browser). A sign-in that
  leaves no note for other tabs was simulated with a direct request.
- The authors' whole browser suite and `latency.test.ts` (reviewer A). Physical paint time. Browsers other than
  Chromium, Cmd on macOS, mobile widths, screen readers, IME input. The engine.

## Cleanup

No listener is left on ports 8600 to 8649 and no browser of this review is running. `/tmp/mainworthy-ui-r4c` is
removed, and so is `node_modules` in the export (run `bun install --frozen-lockfile` in `tree/` to rerun a
probe; `mut*/tree` and `r3/tree` link to it). The repository checkout was read with `git archive` only. While this review ran, its
branch moved on to `c3ec096` with uncommitted work by others (among it `src/web/lib/api.ts` and a commit titled
"a request may name who it believes it is and is refused when the session is somebody else's", which is the fix
R4C-1 asks for). None of that is judged here: everything above is about `ec98ba4`.

PASS (no blockers)

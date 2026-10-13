# Mainworthy web UI: independent verification, round 3, part C

Part C: changes and settings, sign-in and session, keyboard, layout and themes, speed; and the re-check of
R2-5, R2-11, Astra R2-2 and Astra R2-3.

Revision judged: `b11d2307959bd1ea7f5edea6351cd5cc7bbf077f`, branch `t3/mvp-product-delivery`.

Reviewer: Claude Opus 5.5 (Anthropic), a different provider from the UI's main authors (GPT 6.1 Sol). Two of the
parts re-checked here were written by Claude Opus 5.5, the same model as this reviewer: what the device keeps is
keyed by the person (Astra R2-2), and the tall proposal card and its answer rule (Astra R2-3). For those the
different-provider side is the other reviewers of this round; here they were judged by running them, and one of
the two blockers below (R3C-1) is in that code.

Status: complete. Nothing in the repository was changed.

## The fact to prove

"What the UI shows is what the server holds once the UI has settled … no key press is lost or applied to a
different object than the one shown; and nothing typed is lost on reload, on a failed request, or when another
producer changed the same thing."

**Not proven on this revision, for two reasons in this part.** The four round-2 findings given to this part are
fixed as reported. Two things remain: a key accepts a proposal whose content is not on the screen when its read
is slow or has failed (R3C-1), and closing the command palette from inside an editor leaves the focus on the page,
so the rest of the sentence runs as commands (R3C-2, the same result as round 2's R2-3 by another route).

## Method

- Clean `git archive` export in `tree/`, `bun install --frozen-lockfile`, Bun 1.4.3, `/usr/bin/chromium` with
  `--headless=new --ozone-platform=headless`, real server processes on 127.0.0.1, ports 8400 to 8449, data under
  `/tmp/mainworthy-ui-r3c`.
- The only files changed in the export are five test helpers (ports moved into 8400..8449, the Chromium flags):
  `test-environment.patch`. No application source and no assertion is changed.
- Every probe drives the real UI with trusted key events and then reads the server through its API. Slow and
  failing reads are injected at the browser (`page.route`). Probes are in `probes/` (run from `tree/` as
  `TMPDIR=/tmp/mainworthy-ui-r3c bun ../probes/<name>.ts [scenario]`), their output in `logs/`, screenshots in
  `shots/`. To rerun, first `bun install --frozen-lockfile` in `tree/` (its `node_modules` is removed at the end).
- Both blockers were reproduced at least twice. Where a first result was my own mistake it is said at the end.
- The machine was shared with the other reviewers (load average 4 to 10 on 16 cores).

## Round-2 findings given to this part

| Finding | Result here | Evidence |
| --- | --- | --- |
| R2-5 over plain HTTP under a name other than localhost nothing could be written | **fixed** | `probes/http-name.ts`, `logs/http-name.log`, server mode with a token, `http://mainworthy.test:<port>`: `{"isSecureContext":false,"randomUUID":"undefined","clipboard":"undefined"}`. Capture: `C-4 v1 "Typed over plain http"`, steps `Open the cart => The cart is shown`, `Pay`. Edit: `v2 "Typed over plain http again"`, tag `["smoke"]`. Run: `C-1:satisfied:pass()`, `C-2:failing:fail(total is wrong over http)`, `C-3:skipped:blocked()`. Queue: `Q-9 decided`. Copy token: `"Token copied."`, `fieldTypeAfter:"password"`, `pastedEqualsToken:true`. Policy: `strict is in force. Proposal P-7 and decision Q-10 are both recorded.` New project created. A change made elsewhere appears after 31 ms on both origins (`logs/events-origin.log`). `errors: []`. Cookie `httpOnly:true, sameSite:"Strict"`. |
| R2-11 a project the session may not read was shown as empty | **fixed**, two small leftovers (R3C-6) | `logs/session.log`, `logs/scoped2.log`: Suite `Cases unavailable … Your session may not read this project. find needs the read capability on second Retry`; Queue, Runs, a run and Changes each print the refusal. For about a second before it, the Suite still says `No cases yet. Press c and start typing.`; Settings never says it and shows a policy the server does not hold. |
| Astra R2-2 another person signing in on the same browser was shown the previous person's draft and note (written by Claude Opus 5.5) | **fixed** | `probes/persons.ts`, `logs/persons.log`, `logs/persons-2.log`, four surfaces (an edit of an existing case, a new case, a run note, a queue reason under `strict`). Alice types, her token is revoked, the write returns 401 and the sign-in appears. Bob signs in on the same page: `inputs:[]`, `draftRows:[]`, `body:[]`; opening the same field shows the server's text (`Step 1=Original step`) or nothing; 33 s idle: `writes:[]`, server unchanged; the same in a new tab. Bob types his own, is refused, Alice signs in again (a new token for the same actor): `Step 1=Alice private unfinished sentence`, `Result note=Alice private unfinished sentence`, `answer-extra=Alice private unfinished sentence`, none of Bob's words; recorded as `"by":"alice"`, `alice/fail/Alice private unfinished sentence`, `Q-3 flaky by alice`. Storage keys carry the person (`mainworthy:alice:draft:…`, `mainworthy:bob:run-note:…`). |
| Astra R2-3 a tall proposal answered with only its end visible (written by Claude Opus 5.5) | **fixed, with a new problem beside it (R3C-1), and R3C-4** | `probes/tall.ts`, `logs/tall-matrix.log`: thirty-five changed steps on a six-step case. 1280x800, `a` and `r`: press 1 `Q-3 is now in view. Read it, then press a again.`, presses 2 to 7 `Q-3 has more below: the next part is now in view`, steps seen `..10, ..16, 16..21, 22..27, 27..32, ..34`, answered at press 8 with `card [283,764] in pane [0,772]`, `whole:true, heading:true, buttons:true, atEnd:true`. 1440x900: answered at press 7, `card [337,864] in pane [0,872]`. Astra's route (pane scrolled to its end by hand, one key): `server:"open"`, it pages instead (`logs/tall-more.log`). A 480-character reason: card `[156,764]`, still whole. Two proposals: each revealed and answered in turn, the other left open. |

## Checks

| # | Check | Verdict | What ran and the deciding lines |
| --- | --- | --- | --- |
| 6 | Changes and Settings | **issues** (not blocking) | **Changes** (`probes/session.ts changes`, `logs/changes.log`): gate, open and settled questions, impact and uncovered files shown (`pr:500 … Passed … 1 pass … UNCOVERED FILES src/cart.ts`); 16 fast switches behind unevenly delayed reads, `distinct frames: 19`, `frames pairing a header with another change's gate: []`. `j`, `k` and Enter (opens the blocking question, `/p/scratch/queue/13`) work (`logs/keys3.log`). **Policy** (`logs/session.log`): `standard is in force. Proposal P-2 and decision Q-2 are both recorded.`; server `Q-2 … accept by robin`. **New token**: `local:false, session:false, cookie:false, text:false`; after dismiss and reload `html:false, fields:0`. **Scoped tokens** (`probes/scoped.ts`, `logs/scoped.log`): reader on `scratch` only: session `can:[]`, `scratch:read`; run buttons `[false,false,false,false]`, `p f … Enter` record nothing (`fills:[0,0,0]`); queue `You cannot settle this`, buttons disabled, `i` leaves `Q-2 open`; Settings preset and switch disabled; a capture is kept as a draft with `propose needs the produce capability on scratch. Your draft is kept on this device.` A read+produce person records `tester/pass`. A token on `second` sees only `second` in the switcher and gets disabled controls on `scratch`. The screens use the current project's grant, not the instance's (`can:[]` on the instance in every case). **Revoking**: the next request returns the sign-in (`get:401`, 46 ms after the key; `logs/scoped2.log`). Defects: R3C-3 (a project admin is offered token and project creation the server refuses), R3C-6. |
| 7 | Sign-in and session | **pass** | `logs/session.log`. Local mode: `{"app":1,"token":0,"cookies":0}`. Server mode: asks for the token with the field focused; wrong token `That token was not accepted. Try again.`, `app:0`; cookie `httpOnly:true, sameSite:"Strict"`, `document.cookie ""`, token in neither storage. Refused session: `{"signin":1,"app":0}`, the typed note and draft come back for the same person only (see Astra R2-2). Second project made in Settings and in the switcher: `["scratch","second"]`; switching back shows its three cases. Over plain HTTP under another name: the same (R2-5). Notes, not defects: there is no sign-out control; a tab that makes no request keeps showing what it had read after its token is revoked (seen for 3 s; not followed further). |
| 8 | Keyboard, layout, themes | **issues** | **Keys** (`probes/keys2.ts`, `keys3.ts`, `layout.ts keys`; `logs/keys2-a.log`, `keys3.log`, `layout.log`). The `?` sheet lists 33 bindings on Suite and Case, 24 on Queue, 13 on Runs, 30 in a run, 12 on Changes and on Settings. Pressed and observed: Suite `c e Enter j k arrows / Escape Ctrl+Enter Shift+Enter x m t # u Space ] Alt+[ n f z [`; Case `v` (step diff), `z` (pane 486 → 704 px), Space, `u` (v3 restores v1's title), `a`/`r`; Queue `j k arrows`, an offered answer key (`decided`), `u` (`open`); Runs `j k Enter n` (run planned and opened); run `j k arrows`, `f` note Escape (nothing recorded, note kept), `f` Enter, `p b s`, `u`; Changes `j k Enter`; Settings `j k n`; shell `g s/q/r/c/,`, `[`, Ctrl+K, `?`. **Plain keys in inputs**: the 27 characters `cejkxmt#upfbsnadrizvlg q?[]` typed into the filter, tag box, move box, new-folder box, run name, run note, token actor and project key arrive exactly and change nothing (`exact:true, serverChanged:false` eight times); under the `?` sheet and in the palette they change nothing either. **Palette**: finds a case by words and by ref (`Go to C-8`), runs `Go to …` for all five screens and `New case` (typed title recorded). **Clipping**: seven screens at 1280x800 and 1440x900 in both themes, no `clipped` line, no page scroll (`logs/layout.log`). **Themes**: 28 screenshots plus the sign-in, key sheet, palette and token panel in both themes; looked at as light/dark pairs: all seven screens at 1280x800, Queue and Settings at 1440x900, and the four overlays; text and controls are legible in both. Fails: **R3C-2** (palette closed from an editor: the next keys are commands), **R3C-1** (a key answers a proposal that is not shown), R3C-4 (a held key repeats), R3C-5 (focus left in the project switcher). |
| 9 | Speed (P1) | **pass** (a measurement) | `probes/latency.ts`, `logs/latency.log`, 10,000 real cases, 200 samples each, timed from the capturing keydown; "frame" is the next animation frame, where the state is checked, "painted" the frame after. `j` 15.9 / 17.9 ms and 31.2 / 34.0 ms (p50 / p95, frame and painted; max 44.9); `k` 17.5 / 18.6 and 32.6 / 32.8; `c` to a focused caret 16.4 / 17.8 and 32.7 / 32.9; a typed character 16.3 / 16.6 and 32.6 / 32.9. Budget 100 ms at p95. `wrong:0` for `j`, `k`, `c`; the 200 typed step characters all reached the server (the one "wrong" sample is a title character my script typed without waiting a frame). Headless Chromium, frames as a proxy for paint, load average 9.7 to 10.2 during the run: not a guarantee. |
| – | Authors' tests for this part | pass, with gaps | Single files only: `signin.test.ts` 3 pass, `settings.test.ts` 2 pass, `shell.test.ts` 2 pass, `followups.test.ts` 7 pass, `latency.test.ts` see `logs/authors-tests.log`. Gaps under "The tests do not prove this". |

## Defects

### R3C-2: Closing the palette from inside an editor leaves the focus on the page; the rest of the sentence runs as commands

Blocks: **yes**.

Ctrl+K is offered in the footer while a field has the focus (`⌘k Jump to or run`). Closing the palette without
choosing, with Escape or with Ctrl+K again, does not give the focus back to the field: `document.activeElement`
is `BODY`. The editor is still on the screen with its text, so nothing tells the person; what they type next is
handled as commands.

Reproduction, the same result in four runs (`probes/palette-focus.ts`, `logs/palette-focus.log`,
`shots/palette-focus-case-esc.png`; first seen in `logs/keys3.log`): `c`, `Checkout total`, Enter,
`Add two items`, Ctrl+K, Escape, type ` and check the total`, Escape.
`focusBefore:"TEXTAREA[Step 1]", inPalette:"INPUT[Jump to or run]", focusAfterClose:"BODY[]"`; server:
`C-4 v1 "Checkout total" ["Add two items"]`, `C-5 v1 "heck the total" []`. The `c` of "check" started another
case and the tail of the sentence became its title; the step never got its ending. With other words the same
keys archive (`#`), tag (`t`), restore a version (`u`) or leave the screen (`g s`).

The same loss of focus in the run's note field and the queue's reference field. There the outcome keys are
switched off while the field is open, so nothing wrong is recorded, but the typed keys are dropped without a
word (note stays `The total is`, field stays `BUG-12`), and a comma after a word ending in "g" is the chord
`g ,`: typing ` wrong, the badge…` after the palette left the run for `/p/scratch/settings`.

Promise contradicted: "plain keys typed in an input do not fire commands", no key applied to a different object
than the one shown, P1 (the caret stays). Round 2's R2-3 was the same result by the idle timer. Smallest fix:
the palette remembers the focused element when it opens and focuses it again when it closes without a choice.
No test opens the palette from a field.

### R3C-1: A key accepts a proposal whose content is not on the screen (its read is slow or has failed)

Blocks: **yes**, by the rule Astra R2-3 was judged under (a key answers only what is shown). It needs the
proposal's read to be slow or to fail: on loopback the card is without its diff for 4 to 8 ms
(`logs/blind.log`, `window`). If the owner judges a slow or failed read outside the MVP, the count drops by one.

The proposal card on a case page is drawn as soon as the timeline names the question. Its diff comes from two
more reads (`get P-n`, then the base version). Until they arrive, and for good if the first fails, the card is
complete to the eye: `Q-3 · agent-review · agent | Proposed, waiting for a person. Edit: Proposal case | a Accept
| r Reject` (`shots/blind-failed-a.png`). Nothing says a diff is missing or failed to load. `answerByKey`
(`src/web/case/pane.tsx`) checks that the card is in the pane and that the end of the diff is showing; with no
diff element that is true at once (`pageProposal` returns false), so the key answers.

Reproduction (`probes/blind.ts`, `logs/blind.log`), 1280x800, a one-step case, an agent proposal that replaces
the title with "Delete every check" and the steps with "Do nothing":

- `get` for `P-…` delayed 4 s; open `/p/scratch/suite/c/1`; press `a` once:
  `card when the key was pressed: {"diffs":0, … "inPane":true}`, `#1 diffs=0 -> decided:accept`,
  server `v2 "Delete every check" steps=["Do nothing"]`.
- `get` for `P-…` answered with a 500 (both tries); wait 3.5 s; press `a` once: the same, `decided:accept`, v2.
- With the card below the fold (six-step case) it is two presses: `#1 … is now in view. Read it, then press a
  again`, `#2 diffs=0 -> decided:accept` (`logs/tall-more.log`, `slow a`). `r` behaves the same.

The Queue has the same hole (part B's screen; one paragraph): with the same slow or failed read the evidence
pane says `Reading the proposed edits…` or `read failed`, and one `a` records `decided:accept`, case
`v2 "Delete every check"` (`logs/blind.log`, `queue slow`, `queue failed`; `shots/blind-queue-failed.png`).
There at least the screen says what is missing.

Promise contradicted: decision 0011 (nothing a key acts on is clipped; here none of it is shown) and the
round-2 rule "answers only when the end of the diff is showing". Smallest fix: `a`, `r` and the two buttons do
nothing but say "still reading the proposal" until the diff has rendered, and a failed read says so on the card.
Written by Claude Opus 5.5 (the answer rule in `pane.tsx`); judged by running it.

### R3C-3: A person who is admin of one project is offered token and project creation that the server refuses

Blocks: no (nothing is written wrongly; the refusal is shown).

Settings decides what to offer from the current project's grant (`session.can.includes("admin")`), which is what
check 6 asks. But every `admin` action is an instance operation on the server and needs `admin` on the instance.
A token limited to one project never has that, and the Settings screen makes only such tokens ("A token
identifies its producer and is limited to this project", with an `admin` box).

Reproduction (`probes/scoped.ts`, `logs/scoped.log`, person `padmin` with every capability on `scratch`):
session `can:[]`, `scratch:read+produce+answer+plan+admin`. Policy preset: enabled, and the change works
(`standard is in force. Proposal P-2 and decision Q-3 are both recorded.`). Tokens: the form is offered, `n`,
a name, Enter: `admin needs the admin capability`, no token made; the list of issued tokens and the clause
table cannot be read either. Projects: the form is offered, `n`, `third`, Enter:
`admin needs the admin capability`.

So delegating a project's administration through the UI gives a person a Settings screen where two of three
things fail. Either the screen asks for the instance's grant for tokens and projects, or the server takes a
project's admin for that project's tokens and policy. (The second half is an engine decision.)

### R3C-4: A held key repeats the action; nothing ignores key repeat

Blocks: no.

The key handler (`src/web/lib/keys.ts`) does not look at `event.repeat`, and nothing else in `src/web` does.
Reproduction (`probes/keys2.ts held`, `probes/tall.ts held`; `logs/keys3.log`, `logs/tall-more.log`), repeats
sent every 33 ms as a keyboard does:

- In a run, `p` held for eight repeats: `slotsFilledBefore:8, after:16`. Eight cases passed by one long press.
- On the thirty-five-step proposal, `a` held: revealed, paged six times and accepted in 693 ms
  (`repeatsUntilAnswered:7, server:"decided:accept"`). The rule that fixes Astra R2-3 is kept to the letter (the
  end is showing when it answers) and defeated in effect: no page was on screen for more than a frame or two.
- `d` in the queue opens its reference field, and `#` archived one case in six repeats, so those two are safe.

Smallest fix: ignore `event.repeat` for every key that records (outcomes, answers, `a`, `r`, `#`, `u`); keep it
for `j`, `k` and the arrows.

### R3C-5: After the project switcher is used, the focus stays in it and keys are dropped

Blocks: no.

Reproduction (`probes/keys2.ts select`, `logs/keys3.log`, two projects): choose a project in the sidebar's
switcher. `focus:"SELECT[Project]"`; then `j`: `jMoved:false`; `c` and a title: `editors:0`, nothing on the
server. A `select` counts as an input, so every plain key is ignored until the person clicks somewhere else, and
nothing shows why. The same for the policy preset select in Settings. Fix: blur the select after a change.

### R3C-6: Two leftovers of R2-11 on a project the session may not read

Blocks: no.

`logs/scoped2.log`, a reader of `scratch` opening `second`, whose policy is `strict`:

- Settings: `Policy | second | loose | The policy decides whose answers count.` at 0.6 s, 3 s and 7 s. It never
  says the project may not be read, and "loose" is not what the server holds (the screen falls back to `loose`
  when the session does not list the project). `logs/scoped.log`, `C on scratch settings`: `scratch | loose`
  while the server has `standard`.
- Suite: for about a second (one retry) it shows `0 cases … No cases yet. Press c and start typing.`, then
  `Cases unavailable … Your session may not read this project.` The empty-state sentence is shown while the
  first read is still pending.

## The tests do not prove this

- No test opens the palette from a field and types on (R3C-2). `shell routes, palette, help and theme work…`
  opens the palette from the list only.
- The tall-proposal test (`agent.test.ts`, thirty-five steps) lets every read arrive before the first key; no
  test presses `a` or `r` before the proposal's body is there or after its read failed (R3C-1).
- No test holds a key (no `repeat` in any test's key events; R3C-4).
- `settings … scopes and revokes tokens…` gives its scoped token no `admin`, so it cannot see R3C-3; no test
  signs in as a person who is admin of one project only.
- `a refused project read shows the refusal instead of an empty suite` waits for the refusal; it does not look
  at the second before it, nor at Settings (R3C-6).
- `UI-4 a revoked session returns to sign-in, and the <surface> comes back for the person who typed it and
  nobody else` covers Astra R2-2; the queue reason (kept on the device since R2-7) is not among its surfaces.
  Run here: it holds (`logs/persons-2.log`, `queue`).
- `latency.test.ts` now takes 200 samples for `j`, `k` and capture; it is a frame proxy in headless Chromium,
  like the numbers above.

## Worth doing later

- The `?` sheet puts its entries in one column of a box that scrolls: at 1280x800 the last eleven of Suite's 33
  (from "Next folder" down: folders, widen, sidebar, the five `g` chords) are below its edge. Half the sheet is
  empty beside them (`shots/ov-sheet-1.png`). Whether the keyboard can scroll it was not checked.
- The sheet and the palette list bindings whose condition is false: `New project n` on the Policy section of
  Settings (where `n` does nothing), `Accept proposal a` on a case with no proposal.
- The footer on Changes and Settings shows the Suite's sentence about drafts as its status line.
- A person without `produce` is still offered `c New case`; the draft then stays on the device for good.
- There is no sign-out. The only way to hand the browser to another person is for the token to be refused.
- A revoked session is noticed at its next request only. The server closes the event stream; the client does
  not act on that.
- `]` and `Alt+[` walk folders in the server's order (`Checkout`, then back to `Checkout/Cart`), the tree shows
  them sorted by path. (Round 2 said the same.)

## Outside this part (one paragraph each)

- **Queue, same as R3C-1**: see the paragraph in R3C-1. Reproduction: `bun ../probes/blind.ts queue`.
- **Suite, seen once in two runs, not reproduced on purpose**: in the first run of `probes/http-name.ts` the
  keys `e`, End, ` again`, Ctrl+Enter were pressed in the instant after a new case had sealed, while its row
  still read `new … draft`. The server got `v2` with the title unchanged, and after a reload the row showed
  `draft` with `mainworthy:robin:draft:scratch:C-4` on the device. Nothing was lost (the text was in the stored
  draft). The second run, a moment slower, was clean: `v2 "Typed over plain http again"`, no draft left. The
  first run's output was overwritten by the second; reviewer A's capture checks are the place for it.
- **Engine**: `admin` is an instance operation, so a project's `admin` capability grants nothing a screen
  offers except the policy change, which goes through `propose` and `decide` (R3C-3).

## Mistakes in my own probes

- `probes/scoped.ts` first reported that a revoked reader was never returned to the sign-in. Its `j` had been
  typed into a draft editor that the reload had restored, so no request was made. `probes/scoped2.ts`:
  `after j: {"signin":true … "requests":["3029:get:401"]}`.
- `probes/http-name.ts` first reported `event stream: {"appeared":false}`. By then the probe had switched the
  policy to `strict`, under which the other person's new case waits for review. `probes/events-origin.ts` on
  both origins: appeared after 31 ms.
- The first run of `probes/persons.ts` stopped on two surfaces (it waited for a title button while the editor
  had been restored; it planned a run under `strict`). The second run completes all four.
- A Playwright error printed the session cookie of one throwaway test server into `logs/http-name.log`. It is
  redacted there, and that server and its data are gone.
- `probes/keys2.ts inputs` could not open the queue's reason field on the seeded data (my selector). That field
  is covered by `persons.ts queue` and `palette-focus.ts queue`, not by the 27-character string.
- `probes/keys3.ts` could not tell whether Space ("all evidence") and `x` (select) did anything in the Queue (my
  selectors matched nothing). Not verified here.

## Not checked

- Space and `x` in the Queue, the digit keys that mark a failing step in a run, `Take advice` with Enter, `m`
  ("the failure was a mistake"): by the authors' tests or the other parts only.
- The 1440x900 screenshots of Suite, Case, Runs, the run and Changes by eye (measured for clipping only; Queue
  and Settings were looked at). The Projects and Connect sections of Settings in dark theme.
- Whether a tab that makes no request ever returns to the sign-in after its token is revoked (seen for 3 s only).
- Two tabs signed in as different people at once (the cookie is one per browser, so the first tab would then
  write as the second person). From reading only, not run.
- The authors' whole browser suite (reviewer A runs it). Physical paint time. Browsers other than Chromium, Cmd
  on macOS, mobile widths, screen readers, IME input. The engine, beyond the note above.

## Cleanup

No listener is left on ports 8400 to 8449 and no browser of this review is running (one test server orphaned by
a crashed probe was found and stopped at the end). `/tmp/mainworthy-ui-r3c` and the export's `node_modules` are
removed. The repository checkout was read with `git archive` only; `git status` there is clean.

ISSUES (2 blockers)

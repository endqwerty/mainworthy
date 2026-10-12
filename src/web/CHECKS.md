# Builder 1 checks

Before implementing the UI, these are the checks that decide this subtask.

- Shell: TypeScript and Bun compile; real Chromium loads a real server. Navigation to Suite, Case, Queue, Runs, Changes and Settings, command palette, help and theme work without document navigation. The shell contract is accurate before `.shell-ready` exists.
- J1: Capture a title with #checkout, six steps and three expected results, including a three-line paste. Escape seals exactly version 1 with the six steps and tag in the server. No dialogs, no page loads, no console errors. Count non-text keys.
- The lead's final layout correction: `c` focuses the document title, the list row mirrors it, the folder tree exists only in Suite, and `[` collapses the sidebar while keeping navigation accessible. The document-focus assertion failed before correcting capture.
- L1: On 2,000 and 10,000 seeded cases, 200 trusted samples each measure capture focus, step input and j/k selection at an animation frame. Each navigation sample verifies its destination, finishes before the next key and gets a paint frame between inputs. All four p95 budgets remain 100 ms. Scroll 5,000 rows and check populated frames. CASEBOOK_SKIP_10K skips only the large benchmark.
- L2: Reload an unfinished draft. The text and selection return synchronously. The server may seal the same body on visibilitychange, as required by the brief.
- Conflict: Change the same field through the page and API. Both bodies remain visible, the server retains the intervening version, and a merge decision creates the next version.
- Custom fields: JSON reads currently omit them. Editing only the fields this pane owns must leave custom fields intact in the server's canonical Markdown; this regression failed before excluding custom fields from ordinary edit payloads.
- Sign-in: Server mode rejects a wrong token and accepts the owner token; local mode needs no login.
- UI-3: Capture from `/suite/c/1` creates C-2 at v1 and leaves C-1's title, step and v1 intact. The regression failed before restricting the route effect to route changes and clearing the old case URL for a new draft.
- UI-4: Revoke a scoped writer token, then seal a draft or report a note. Both real 401 regressions failed before API refusals reopened sign-in. Signing back in restores the exact text and a retry is checked on the server, without a page load.
- With the lead's ownership handoff, triage and execution's revoked-token tests now also check sign-in recovery: no decision or result is recorded, the question and missing slot return, and the per-slot device note returns to its field. Their existing network-failure tests are unchanged.
- UI-5: With proposal requests delayed by 500 ms, tag and immediately undo once. The regression failed before making the inverse available with its pending request. Tag, move and archive now undo after the original write is adopted; repeated undo while queued sends no extra inverse. All are checked against the server and retained placement history, with the body still at v1.
- Step identity: the earlier timeout waited for read mode while the seal acknowledgement was still in flight. Delay the real proposal reply by 500 ms, prove the server head advances while the pane still says Draft, then wait for the acknowledged version and draft removal before reloading.
- R2-1: Hold the first pass or fail request until the next slot's note has begun, then refuse it. The cursor, focus, caret and text stay on the next slot; its complete note reaches the server, and the failed slot keeps its own note and missing state.
- R2-2: Hold a queue answer until the next question is selected, then fail the request or change the proposal's case through the API before releasing it. The next question stays selected, its own `t` key records Track, and the refused question returns to the list without a decision.
- R2-3: Advance the browser clock through 30 idle seconds during a new title and a new step in a folder. Sealing keeps the same editor node, focus and caret; resumed text becomes version 2 of the same case. The existing idle test also checks the real 30-second delay.
- R2-4: Fail two new captures, then reload. Both drafts remain selectable and retain their steps. Resuming either shows New case at the Suite URL with exactly one selected row, including after another draft was recorded. Each is sent as one case at version 1, including an idempotent retry after reload; a second reload shows only recorded cases.
- R2-5: Open the real server as `http://casebook.test` with Chromium's host resolver pointing to loopback. Check that the context is insecure and randomUUID is absent, then capture, edit, answer and undo, plan and record a run, and change policy. Copy a new token without navigator.clipboard, compare it privately with the real clipboard through a secure-origin page, and check that its field stays masked.
- R2-6: Select by j, k and click in a folder with two tag filters, then reload, go Back and Forward, and seal a capture. The URL, list heading, count, selected case and captured tags preserve the folder and filters.
- R2-7: Under strict and standard policies, refuse a queue reason or defect-reference submission, return to its row, continue typing and reload. The exact text returns and reaches the recorded decision; a successful answer clears only the text it sent. Device keys name the person, project, question, answer and field.
- R2-8: While a case is open, send an agent proposal through the real API. Its card appears without navigation in read mode and during a draft; the draft keeps focus and text, and the read-mode card can be accepted by key.
- R2-9: Walk through a case with an unresolved draft using k and j. Selection keeps read mode and focus in the list; the row and pane say a draft is kept. Pressing e restores its text, caret and conflict. A delayed conflict reply stays off the next case's pane, marks its own draft row and is available when e resumes that case.
- R2-10: Type ` from Settings > Billing` into an action that has an expected result. Both the editor and the server's next version retain the complete action and the existing expected result.
- R2-11: Sign in with a token scoped to scratch, then open another project's Suite. The list shows the real API refusal and Cases unavailable, rather than No cases yet and a false zero count.
- Back/Forward recovery: From a selected case, start a new title and step, go Back and Forward, then continue typing. The draft row, editor, text and caret return without a reload; sending it creates a new case and leaves the original at version 1.
- Formatting and architecture: `bunx tsc --noEmit`, Biome on owned files, `bun test test/architecture.test.ts`, and `bun test test/e2e`.
- Screenshots: inspect Suite and Case with a diff at 1440 by 900, light and dark. Builder 2 supplies its four screens.

The lead owns commits, publishing and independent cross-provider verification of the combined revision. This builder runs the real-page checks and reports evidence without changing git state.

Round-2 regressions are in `test/e2e/recovery.test.ts` and `test/e2e/followups.test.ts`. Before the fixes, all 12 original regressions and all seven tests for the later findings failed on the reported behaviour. Finding numbers above follow the reviewer's completed report. The placement tests hold replies until the optimistic UI checks finish and wait for two server placement entries, so a missed Playwright request event cannot decide the result. The first full run failed at an immediate tag-render assertion; its check now waits for the rendered tag while the server still holds the original value. The failed-seal test installs its refusal before typing begins and compares the failed and retried command ids.

The review's weak checks now prove their premises: archive, move and tag writes are intercepted and held before undo; D2 and J5 accept the whole key sequence before replies are released, while server reads prove that nothing has recorded yet. D2 reads the real public export before and after u, preserving the original decision and appending a withdrawal that supersedes it. Forbidden keys must send no decide call; a stale proposal's displayed before/after titles and version pair must match the new evidence. Token scope is checked against two populated projects, rapid capture checks its visible folder and rows, and the shell drives its Suite shortcuts. The fixture exposes the same existing archive routes as the shipped server so the ledger check reads real records.

Outside these eleven findings, leaving a v2 version diff open while navigating to a case with only v1 produced 404 reads. The shortcut check closes the diff after verifying it. That selection/diff issue is left for the lead because this task allows behaviour changes only for the reported findings.

Round-2 closeout: `bun run typecheck` passes; `bunx biome check src/web test/e2e` checks 54 files with no fixes; architecture passes 12 tests. Two consecutive complete `bun test test/e2e` runs on the final source each report **64 pass, 0 fail, 506 expect() calls**, in **163.13 s** and **158.83 s**. Both include the real 30-second idle check, 2,000 and 10,000 case budgets with 200 samples per path, person-scoped recovery, real plain-HTTP writes and copying, and the public-export ledger check. The sign-in recovery assertion waits for its pinned slot before reading the note, matching the earlier stages of that test. No server, core, surface or package file was changed by this builder; no git state command was used. A fresh independent verdict and the commit remain with the lead.

Closeout after UI-3, UI-4, UI-5 and the acknowledgement-wait correction: `bun run typecheck` passed; Biome checked 50 files with no fixes; architecture passed 12 tests. `bun test test/e2e`: **41 pass, 0 fail, 274 expectations, 81.44 seconds**. Capture, sign-in and placement passed 15 targeted tests; the two adjusted triage/execution session tests also passed independently.

The final full-run L1 estimates (30 events per path, event to next animation frame) were: 2,000 cases, capture p50/p95 10.6/14.4 ms and typing 14.8/15.1 ms; 10,000 cases, capture 10.7/14.6 ms and typing 15.0/15.2 ms. J1 used eight control keys beyond text; D2 used 20 answers plus three navigation keys; J5 used 11 controls plus 12 note characters. These are local Chromium frame opportunities, not a hardware display guarantee or a comparative speedup.

## Round 3 implementation checks

This pass follows `UI-R3-FIXES.md` and the completed reports ui-r3a, ui-r3b,
ui-r3c and ui-r3x. The lead owns the engine, the combined independent verdict,
commits and delivery. This builder changes only `src/web` and `test/e2e`.

| Finding | Cause and repair | Changed implementation | Browser check |
| --- | --- | --- | --- |
| A-1 | A sent command was reused with changed text. Keep its exact request for an unchanged replay, then send newer text with a new command and the recovered case/version. | `lib/drafts.ts`, `suite/index.tsx` | `round3-capture.test.ts`: `A-1 new` and `A-1 edit`; `drafts.test.ts`: L2 now continues the sentence and proves the server received it. |
| A-2 | Shared storage supplied another window's command and pending request. Existing-case drafts fork their command when another window resumes them; the window identity survives its own reload. A reply clears only that window's stored draft. | `lib/ids.ts`, `lib/drafts.ts`, `suite/index.tsx` | `round3-capture.test.ts`: shared windows with disjoint and conflicting edits, plus a second window opening during an applied, held reply. |
| A-3 | Clean drafts were stored and preferred to the current case, and seals resent all placement metadata. Ignore clean stored drafts, open a clean editor from the current case, and send only tag/link deltas from the draft's baseline. | `lib/drafts.ts`, `suite/model.ts`, `suite/index.tsx` | `round3-capture.test.ts`: clean and dirty drafts after another producer removes a tag and requirement link; the clean case also receives a newer title. |
| A-4 | A view navigation restored the active capture as an editor. Restore on a document opening or the capture's own history entry, while folder/filter navigation stays in read mode. | `lib/router.ts`, `suite/index.tsx` | `round3-capture.test.ts`: folder keys with a refused capture; `recovery.test.ts`: Back/Forward still restores the draft. |
| A-5 | Report events did not name the case, so its open read and timeline stayed cached. Invalidate both on every report. | `lib/data.ts` | `round3-capture.test.ts`: external pass/fail proof and timeline on the already-open case. |
| A-6 | Every character reparsed an existing delimiter. Split only a delimiter overlapping the newly inserted text. | `case/editor.tsx` | `round3-capture.test.ts`: append to `Open Settings > Billing` without an expected result; the existing round-2 menu-path test still covers an action with an expected result. |
| R3B-1 | The answer after undo overtook the undo. Serialize writes per question, while their selection changes remain synchronous. | `queue/index.tsx` | `round3-interactions.test.ts`: hold the first answer through `f u i`, then prove request order and the final Infrastructure decision. |
| R3B-2 | The first cursor was derived from changing data, and a disappeared question fell back to the first row. Pin the first shown object; retain a settled question and its editable text, and keep a filled run slot's note editable. Refuse note submission against its fresh external fill. | `queue/index.tsx`, `runs/cockpit.tsx` | `round3-interactions.test.ts`: a new question, settlement of the selected question while its reference is typed, and another producer filling the selected run slot mid-sentence. Enter and Escape leave the external decision intact. |
| R3B-3 | Run undo moved selection from its eventual reply. Move it at the key press and queue the correction immediately behind the original result. | `runs/cockpit.tsx` | `round3-interactions.test.ts`: pending pass, immediate undo, then a note on a newly selected slot while both replies arrive. |
| R3B-4 | The step mark was global transient state and was cleared before a failed result could be retried. Store it per person/run/slot and clear only the mark acknowledged by a successful failure result. | `runs/cockpit.tsx` | `round3-interactions.test.ts`: `2 f`, refusal, reload, retry, and the exact pinned step ID in the timeline. |
| R3C-1 | The absence of a diff satisfied the old visibility check. Mark rendered proposal evidence as ready and gate keys and buttons on that state, including the case proposal's base read. Show pending/read-error text. | `lib/proposals.ts`, `case/pane.tsx`, `queue/evidence.tsx`, `queue/index.tsx` | `round3-interactions.test.ts`: a/r and buttons, on case and queue, with both held and failed reads; release the held read and prove the answer then records. D2 now waits for each rendered proposal. |
| R3C-2 | Closing the palette lost the originating field. Remember it when opening and restore focus on cancellation, preserving its selection. | `app.tsx` | `round3-interactions.test.ts`: case, run note and queue reference, each with Escape and Ctrl+K, then the rest of the sentence. |
| R3C-3 | Project administration was mistaken for instance administration. Expose the instance grants separately; only those grants offer token/project creation, while the project's policy preset remains available. | `ui/context.tsx`, `app.tsx`, `settings/index.tsx` | `round3-session.test.ts`: a scoped project admin changes policy but has neither instance creation form. |
| R3C-4 | Recording handlers ignored key repeat. Ignore repeated bound actions and native repeated submission, while preserving navigation and ordinary held text in fields. | `lib/keys.ts`, `case/editor.tsx`, `app.tsx`, `queue/index.tsx`, `runs/cockpit.tsx` | `round3-interactions.test.ts`: held pass versus held j, and twenty held a repeats on a tall proposal versus held p text in an editor. |
| R3C-5 | A changed select retained focus and consumed plain shortcuts. Blur selects after changes. | `app.tsx`, `settings/index.tsx`, `case/pane.tsx`, `runs/planner.tsx` | `round3-session.test.ts`: focus the project and policy selects, change them, then use c and j. |
| R3C-6 | An unreadable policy fell back to loose, and a pending suite read looked empty. Show the refusal and withhold the policy; show reading state until the suite read completes. | `app.tsx`, `settings/index.tsx`, `suite/index.tsx` | `round3-session.test.ts`: a held inaccessible Suite read, its refusal, and Settings for that project's real strict policy. |
| R3-1 | A pending seal and device cleanup used the replacement session. Bind requests, queued writes, callbacks and cleanup to the originating session generation, and discard old work after refusal or a person change. Clear optimistic cached data on refusal without clearing private input. | `lib/device.ts`, `lib/api.ts`, `app.tsx`, `suite/index.tsx`, `queue/index.tsx`, `runs/cockpit.tsx`, `case/pane.tsx` | `round3-session.test.ts`: applied Alice seal with a held reply, newer Alice text, real refusal, Bob's own draft, then the old reply; no Bob version or draft deletion. |
| R3-2 | Another tab replaced the shared cookie without notifying the old page. Broadcast the person change through storage, suspend old pages, and compare the session person before writes; every reply also checks its originating generation. | `lib/device.ts`, `lib/api.ts`, `app.tsx` | `round3-session.test.ts`: real Alice/Bob tokens in one browser context, both an existing-case draft and a run note. The old tab shows sign-in and retains Alice's input without a write. |

The initial regression runs reproduced the defects before their implementation
changes. The first select test did not focus its select and passed; the stronger
version was checked with a failing mutation. Fixture corrections were rerun
before judging the failures: A-5 uses a second run because
the first one closes after its pass; A-1 waits for either the replay refusal or
acknowledgement before checking the lost sentence. The strengthened select test
focuses the select before changing it. Temporarily removing its blur fails with
`Expected: 1, Received: 0` editors. The additional pending-window test failed
because its conflict card never appeared, then passed after separating that
window's request.

The stronger proof check holds every later case-list read and samples the badge,
row proof and pane proof on animation frames. It passes on the implementation;
removing only `proof: received.proof` makes it fail with `Expected: true,
Received: false`. A late refetch cannot repair that assertion. J1 now holds writes
for 500 ms and asserts eight control keys instead of only printing the count.
L2 has no conditional server assertion. Sign-in checks accept the real 401 from
the new session preflight, which refuses the write before its operation is sent.
The Back/Forward and HTTP-plan tests wait for creation before reading a new ref.

The latency tests are unchanged. They check 200 actual destinations, caret/input
state and populated scrolling frames on each seeded size, then confirm the typed
case in the server. These are headless animation-frame budget checks, not a claim
of a performance improvement or a measurement of physical display paint. The
final full runs include both 2,000 and 10,000 cases; no skip flag is used.

No server/core edit is needed for these client repairs. The lead's independent
verification of the combined revision remains required. No commit, push, pull
request or worktree release was performed by this builder.

Final checks on the frozen implementation and tests:

- `bunx tsc --noEmit`: exit 0, no diagnostics.
- `bunx biome check src/web test/e2e`: `Checked 58 files in 59ms. No fixes applied.`
- `bun test test/architecture.test.ts`: `12 pass`, `0 fail`, `31 expect() calls`.
- First final `bun test test/e2e`: `102 pass`, `0 fail`, `619 expect() calls`, 17 files, **204.72 s**.
- Second consecutive final `bun test test/e2e`: `102 pass`, `0 fail`, `619 expect() calls`, 17 files, **202.28 s**.
- Both final browser runs include the real 30-second idle seal and all eight latency checks on 2,000 and 10,000 cases. No browser suite or large-data check is skipped.
- Checksums of every owned TypeScript, TSX, CSS and HTML file match through the final runs. The sorted checksum manifest hashes to `720660fd1fd16f0bf3daa6e2c1ef584facd6a4afee97fa5ceea1b19efe644eaf`.
- The final re-read of ui-r3c still lists R3C-1 through R3C-6, with no additional finding.

Two exploratory complete runs preceded these final runs. The first exposed the
old 401-endpoint waits, the weak J1 count, proposal reads missing from D2's
premise, stale optimistic data after a same-person sign-in, and creation reads
that ran before their ref existed. Each was corrected and its affected test was
rerun. The later exploratory run overlapped an in-progress source edit and
failed one app-startup wait. Neither exploratory run is counted as a final pass.

## Round 4 implementation checks

This pass follows `UI-R4-FIXES.md` and the completed ui-r4a, ui-r4b and
ui-r4c reports. Only `src/web` and `test/e2e` are owned by this implementation
worker. The lead retains commits, publishing and independent verification of
the combined revision.

Every reported cause has a browser regression in `test/e2e/round4.test.ts`.
The tests run the real Bun server and SQLite database, drive Chromium keys and
clicks, hold or refuse requests at the browser, and inspect recorded values.
The original regressions failed before their implementation changes. The
close/reload regressions also failed against a clean HEAD export with the old
session-read guard, while the actor-header version recorded exactly one case.
A fixture initially grouped three numbered failure messages into one cause;
its corrected messages make three distinct questions and were rerun before
changing the queue. Strict reason fixtures report through a pipeline token so
the signed-in person is allowed to answer.

| Finding | Cause and implementation files | Regression |
| --- | --- | --- |
| R4A-1 | A saved request and conflict card described earlier text. `suite/index.tsx` rebuilds the conflict from the live draft, refreshes it as typing continues and retains later edits when a merge completes; `case/pane.tsx` resets the card's merge choices when its text changes and returns the exact card state that was resolved. | `conflict keeps later…` checks title and step changes, with and without another seal; `a conflict after a missing reply…` checks failed send, further typing, another producer's edit and resolution. |
| R4A-2 | Definitive refusals and rejected questions retained their saved request/card, and copied session storage reused a tab identity. `suite/index.tsx` releases refused requests and rejected conflict cards; `lib/ids.ts` assigns new documents their own id and checks live identities by BroadcastChannel. | `duplicated tabs…`, `a refused command…`, and `a conflict rejected through API/UI…`; `drafts.test.ts` now requires a fresh command after a definitive refusal. |
| R4A-3 | A pending reply consulted only the active editor and cleared newer stored text after navigation. `suite/index.tsx` retains each live draft independently, reconciles its reply and seals its newer text without moving the current cursor. | Existing and new cases, with a held applied reply, leaving by click, j, another screen, Shift+Enter and the idle seal. |
| R4A-4 / R4C-1 | A session read could precede a cookie change. `lib/api.ts` sends `X-Casebook-As` on operation reads and writes and removes the read before a write. | Case, run and queue requests change the shared cookie immediately before reaching the server; the header names Alice, no session read precedes the write, no record is attributed to Bob, and private text remains under Alice's keys. |
| R4A-5 | A new window automatically restored another live window's capture. `lib/ids.ts`, `main.tsx` and `suite/index.tsx` exchange live owner identities before restoration and keep a capture with its live owner. | `a live window's unfinished capture…` checks no editor in the second window and one complete case on the server. |
| R4B-1 | Null failure values failed parsing, and unread non-proposal evidence still accepted answers. `queue/evidence.tsx` accepts null message/sample, displays the fallback title and dispute hints, validates all evidence kinds and marks a suggested edit's read state; `queue/index.tsx` guards both keys and buttons. | Malformed failure/finding/map/signoff/adopt evidence; nullable failure values; a later pipeline pass disputes a failing slot, with fresh permissions; held and failed suggested-edit reads refuse all answers. |
| R4B-2 | Marks appended forever and remained attached to later results. `runs/cockpit.tsx` clears a mark with Escape/Backspace, replaces digits after 600 ms or another key, consumes it for its result, and clears it after any recorded outcome or a nonexistent-step refusal. | Escape, Backspace, a pause, another key, pass and an invalid step; rapid `1 2` still marks step twelve. The earlier `R3B-4` test still proves a failed valid mark survives reload and retry. |
| R4B-3 | The first withdrawal locked the question rather than its answer. `queue/index.tsx` tracks withdrawals by their answer object and queues later withdrawals in key order. | Hold the first answer through `f u i u t`; all five requests target the original question and it ends as Test. |
| R4B-4 | Inline fields outlived their question selection and checked the displayed question. `queue/index.tsx` closes fields on row/view changes, keeps their device text and checks every entry's own question before submission. | Reference and strict reason fields, each leaving by row, kind and state; return restores the text. The earlier external-settlement regression still refuses Enter and Escape. |
| R4B-5 | Bulk selection retained questions that had disappeared. `queue/index.tsx` removes unlisted refs and reports which were removed. | Settle the only selected question elsewhere, observe the notice, then answer another question normally. |
| R4B-6 | A failed withdrawal discarded its retry state and named no operation. `queue/index.tsx` retains the answer and reports that its withdrawal failed. | Refuse the first withdrawal, then press u again and prove the question reopens. |
| R4B-7 | Recording returned silently for a closed run. `runs/cockpit.tsx` explains the closed run before returning and keeps the note. | Close the run through another producer while a note is being typed, then press Enter. |
| R4B-8 | A note awaiting acknowledgement became the default for a later result. `runs/cockpit.tsx` tracks consumed note text until it is edited or its result fails. | Hold the failure through `Enter u u p`; the final pass has no failure note. |
| R4C-2 | Strict withdrawals supplied no reason and offered no field. `queue/index.tsx` gives withdrawals their own reason input and device key. | Answer with a strict reason, withdraw with a separate reason and prove the question reopens; `recovery.test.ts` now completes that reason flow before checking the cleared answer input. |
| R4C-3 | A shortcut moved focus while its key was still held, letting repeats type into the new field. `lib/keys.ts` swallows that opening key's repeats until keyup. | Capture, edit, failure note, run planner, defect reference and token actor; a fresh press and subsequent text repeats still type normally. |
| R4C-4 | A departing page could not continue after the extra session read. `lib/api.ts` sends the guarded keepalive write directly. | Close and reload immediately after typing; the server holds the case before return, and recovery makes no duplicate. |
| R4C-5 | A refused EventSource had no recovery path. `lib/data.ts` checks the session on stream errors, shows sign-in on authentication failure, retries other failures and invalidates on reconnect; `app.tsx` supplies its connection status. | Idle 401 after token revocation shows sign-in; a 502 reconnects and an externally created case appears. |

The existing lost-reply recovery remains an immutable replay of an unknown
command outcome followed by the current draft under a fresh command. A known
conflict, rejection or API refusal releases that replay immediately. Removing
all replays, including an unknown create after its reply was lost, requires a
project- and actor-scoped command-outcome read from the server. The current
registry exposes no such lookup; matching a case by title would not establish
which command created it. This is the remaining limit of the brief's literal
"never send a remembered request" requirement. No server/core files were
changed by this worker.

Before final full runs, TypeScript passed, Biome checked 59 files without
changes, and architecture passed 12 tests. A preflight run used earlier
assertions about command reuse and strict undo, and failed those assertions;
they now check the required fresh-command and withdrawal-reason behaviour.
A pending run correction timed out once in that mixed-revision preflight and
passed its isolated rerun. Final full runs below judge the final source.

The latency check measures trusted input to the next animation-frame
opportunity, with the focused field, typed value and selected destination
checked inside that frame. It uses 200 samples per path on real 2,000- and
10,000-case datasets and fails above 100 ms. These are budget checks, with no
speedup or physical-paint claim. The machine has 16 cores and was shared with
other work; its load average was about 8 to 9 before these final runs.

The first attempted pair ended with an early assertion in the existing
`A-5 external reports refresh the open case proof and timeline` test: the case
proof had refreshed while the independent timeline query was still in flight.
`round3-capture.test.ts` now waits for the actual result row's note before
asserting the timeline contents. It passes locally and fails in a scratch
export when the report-to-timeline invalidation is removed, so the wait still
proves that invalidation. The pair was restarted after this test correction.

Two consecutive complete `bun test test/e2e` runs on the final implementation
and tests each report **163 pass, 0 fail, 748 expect() calls**, across 18 files,
in **265.31 seconds** and **272.57 seconds**. Both include all 61 new round-4
checks, the real 30-second idle test and both 200-sample latency datasets.
Their largest printed p95 was 16.7 ms, below the unchanged 100 ms budget.
`bunx tsc --noEmit` passes; `bunx biome check src/web test/e2e` checks 59 files
with no fixes; `bun test test/architecture.test.ts` passes 12 tests with 31
expectations. No independent verdict on this new implementation is claimed;
the lead must obtain one for the combined current revision. No commit, push,
pull request or worktree release was performed by this worker.

## Round 5 implementation checks

This bounded pass follows ui-r5a and ui-r5b's reviews of `9611d61`. Only
`src/web/**` and `test/e2e/**` were edited. The lead owns the combined revision's
independent verification, commits and delivery.

The real-browser checks were written before each behaviour fix. N-1's four
choice variants, N-2, N-3 and R5B-1 through R5B-3 each failed twice for the
reported cause before the change. Tests run Chromium against the real Bun
server and SQLite database on the existing 7400..7449 fixture ports.

| Finding | Cause and files | Browser regression in `test/e2e/round5.test.ts` |
| --- | --- | --- |
| N-1 | The draft text keyed the card, so typing remounted it and reset its choices. `case/pane.tsx` keys by question and applies explicit field choices to the latest merged draft body. Whole-body choices remain explicit choices of every field. | Current title, typed merged title, my title and whole-body current choice survive edits to a step and the title; the recorded body keeps untouched editor fields. Existing R4A-1 tests must also pass. |
| N-2 | Sealing a known conflict sent another proposal under a fresh id. `suite/index.tsx` returns before proposing when that case has a conflict card. | Two edit/leave cycles send zero additional proposals; resolution leaves no open adoption questions. |
| N-3 | Changing windows discarded an existing case's unknown-outcome request even when its owner had closed. `lib/ids.ts` exposes existing window liveness and `suite/index.tsx` preserves that request only when the old owner is gone. | Close mid-sentence, open in a different tab and continue: the full title is version 3 with no conflict. A held request in a still-live window is not shared; both windows' fields reach the server under distinct commands. |
| R5B-1 | Enter reused the same note-consumption guard as automatic result shortcuts. `runs/cockpit.tsx` explicitly sends the visible field text on Enter and releases consumed text/marks after failure even when another write is queued. | Hold the first failure, return and mark step 2, then Enter without retyping. The final correction has the visible note. Also abort the first request while an undo is queued and retry that visible note. |
| R5B-2 | Undo overwrote a refusal from `record` with a success message. `runs/cockpit.tsx` changes undo state and announces a correction only when `record` starts a request. | Another producer closes the run; u sends no report, says the run is closed and no result was recorded, and leaves the original pass intact. |
| R5B-3 | The bulk selection dropped an answered question but its inline field retained it. `queue/index.tsx` prunes those field entries with the selection. | With two selected and the reference field open, settle the other selected question externally; Enter records the remaining defect with BUG-7, and Escape records it without a reference. Both close the field by keyboard. |

R5B-4 is left for a server change. Its browser reproduction failed twice:
`2 f`, note, Enter, `k p`, u restores the failure and note but `atStep` is null.
`src/server/ops/reads.ts`'s `slotView` omits the result's `at_step` from each
fill; the web `Fill` therefore cannot restore it. The smallest complete fix is
to expose `atStep: fill.at_step` in that server response, parse it in
`src/web/runs/models.ts`, and include that prior step in the correction sent by
`runs/cockpit.tsx`. A timeline lookup would add an asynchronous read and depend
on bounded history containing that result. No server or core edits were made.
The reproduction is explicitly skipped, with the needed server field named in
its test title, so the passing suite does not claim this defect is fixed.

Preflight checks passed: `bunx tsc --noEmit` exited 0;
`bunx biome check src/web test/e2e` checked 60 files without changes;
`bun test test/architecture.test.ts` reported 12 pass, 0 fail, 31 assertions.
The combined round-4/round-5 browser run reported 73 pass, 1 explicit skip,
0 fail and 164 assertions across two files in 71.10 seconds.

The first full-suite pair was interrupted by the existing R3B-3 check waiting
for two report requests. Run 1 had 175 pass, 1 skip, 0 fail, 783 assertions
in 291.36 seconds; run 2 had 174 pass, 1 skip, 1 fail, 780 assertions in
281.18 seconds. R3B-3 passed the immediate isolated rerun in 981.09 ms,
with no source or test changes. No cause for that intermittent timeout is
claimed. All round-5 checks passed in both runs. The consecutive pair was
restarted on the same implementation after that failed run.

The second attempted pair also had an existing check time out. Its first run
reported 175 pass, 1 skip, 0 fail, 783 assertions in 273.41 seconds. The next
run reported 174 pass, 1 skip, 1 fail, 778 assertions in 281.59 seconds,
with only UI-5's pending-archive undo timing out while waiting for two
placement entries. That test passed its immediate isolated rerun in
914.55 ms with no change. All round-5 checks passed in both runs, and R3B-3
passed in both. The pair was restarted again without changing source or tests.

The final two consecutive complete `bun test test/e2e` runs each reported
**175 pass, 1 explicit skip, 0 fail, 783 assertions across 19 files**. Their
elapsed times were **279.83 seconds** and **276.83 seconds**. The one skip is
R5B-4's deferred server-field reproduction. Both runs include all 61 round-4
checks, the 12 passing round-5 checks, the real 30-second idle save, and both
200-sample latency datasets with their unchanged 100 ms limits. The largest
printed p95 in this pair was 16.2 ms. These measure the next animation-frame
opportunity and check the changed input, focus, selection and stored results;
no speedup or physical-paint claim is made. The machine is shared, with 16
cores and a load average of 8.60 when read during the earlier runs.

No source or test change occurred between the final two passes. Independent
cross-provider verification of the combined revision remains with the lead.
This worker made no commit, push, pull request or checkout cleanup. Each test
fixture closed its own browser and server and removed only its temporary data.

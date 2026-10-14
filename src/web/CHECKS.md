# Builder 1 checks

Before implementing the UI, these are the checks that decide this subtask.

- Shell: TypeScript and Bun compile; real Chromium loads a real server. Navigation to Suite, Case, Queue, Runs, Changes and Settings, command palette, help and theme work without document navigation. The shell contract is accurate before `.shell-ready` exists.
- J1: Capture a title with #checkout, six steps and three expected results, including a three-line paste. Escape seals exactly version 1 with the six steps and tag in the server. No dialogs, no page loads, no console errors. Count non-text keys.
- The lead's final layout correction: `c` focuses the document title, the list row mirrors it, the folder tree exists only in Suite, and `[` collapses the sidebar while keeping navigation accessible. The document-focus assertion failed before correcting capture.
- L1: On 2,000 and 10,000 seeded cases, 200 trusted samples each measure capture focus, step input and j/k selection at an animation frame. Each navigation sample verifies its destination, finishes before the next key and gets a paint frame between inputs. All four p95 budgets remain 100 ms. Scroll 5,000 rows and check populated frames. MAINWORTHY_SKIP_10K skips only the large benchmark.
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
- R2-5: Open the real server as `http://mainworthy.test` with Chromium's host resolver pointing to loopback. Check that the context is insecure and randomUUID is absent, then capture, edit, answer and undo, plan and record a run, and change policy. Copy a new token without navigator.clipboard, compare it privately with the real clipboard through a secure-origin page, and check that its field stays masked.
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

Outside these eleven findings, leaving a v2 version diff open while navigating to a case with only v1 produced 404 reads (issue #160). That no longer happens: the pane closes a diff when the selected case changes, and the shortcut check opens a diff on C-1, selects C-2 (one version) and back, and expects no diff card and no console error.

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
| R3C-5 | A changed select retained focus and consumed plain shortcuts. A select changes once, when a choice is made from its open list, and gives the focus back at that change (a closed select changes on every arrow key, so blurring at the first change cost the keyboard, and a select that writes on change wrote on the way; issue #130). A key that would step a closed select opens its list. One component, `Select` in `ui/index.tsx`, holds the rule for every select. | `ui/index.tsx`, `settings/index.tsx`, `settings/people.tsx`, `case/pane.tsx`, `runs/planner.tsx` | `round3-session.test.ts`: on one select of each group (the case pane, Tokens in Settings, the invitation's expiry, the run planner), opened with an arrow, Space, Alt and an arrow, and Enter, and on both Policy selects, opened with an arrow: the key changes nothing, two arrows and Enter in the list are one change two options on, the focus is back and `?` then Escape works; the Policy selects write once and never on the way; a pick with no key (`selectOption`) gives the focus back; Enter then Escape then Escape on the closed select changes nothing and leaves the screen behind alone; with `showPicker` missing or throwing an arrow changes the select by one and gives the focus back. |
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

Every reported cause has a browser regression in `test/e2e/draft-conflicts.test.ts`, `queue-and-runs.test.ts` or `session-and-keys.test.ts`.
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
| R4A-4 / R4C-1 | A session read could precede a cookie change. `lib/api.ts` sends `X-Mainworthy-As` on operation reads and writes and removes the read before a write. | Case, run and queue requests change the shared cookie immediately before reaching the server; the header names Alice, no session read precedes the write, no record is attributed to Bob, and private text remains under Alice's keys. |
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

R5B-4 was fixed after the server exposed the step (issue #72). `2 f`, note, Enter, `k p`, u restores the failure,
its note and its step. The slot view carries `atStep` on each fill (`src/server/ops/reads.ts`), the web `Fill`
parses it, and `runs/cockpit.tsx` sends it with the correction. A fill still in the cache under its sent id has no
step until the slots are read again, so the cockpit remembers the step it sent for that id. A step marked after the
correction is not used by u and is not cleared by it: it is for the next failure, as a note typed since then is.

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

## Round 6 implementation checks, 2026-10-12

The brief is `UI-R6-FIXES.md` from the lead's verification directory. This
worker owns only `src/web/**` and `test/e2e/**`. The lead owns the independent
cross-provider verdict, changelog, commit and delivery. This implementation
has author-run checks below and is not independently verified yet.

The invariant is that each character typed on a case reaches a recorded
version, remains in a visible device draft, or is visibly refused when typed.
The round-6 browser checks were written and run before the corresponding
behaviour changes. The first run of `round6.test.ts` reported 2 pass and
8 fail. Its failures showed accepted editor input after both a field choice
and a whole-body choice, false resolution after a newer head, missing cards
after reload and in a new tab, and a missing `steps` field in the marked
failure request. The held-reply test already passed: the existing reply
handler builds the card from the latest draft, rather than the sent body.

| Finding | Cause and changed files | Regression in `test/e2e/round6.test.ts` |
| --- | --- | --- |
| R6-1 | The editor and card both accepted text, but choices captured older text. `case/editor.tsx` refuses editor input visibly while a card exists. `case/pane.tsx` makes properties unavailable and stores the card's merged body through `suite/index.tsx`. | `Use my title` followed by title input, and `Use all my changes` followed by step input, leave the draft unchanged and focus where the user put it. Editing the card records its text. A held proposal reply includes later title and step text in the card's draft side, diff and recorded merge. |
| R6-2 | The UI treated outer `status: decided` as adoption and ignored `effects.status: conflict`. `suite/index.tsx` owns resolution and checks the effects before removing a draft. `case/pane.tsx` waits for that operation. | A second edit to the same title creates a replacement card for the new question. The raw draft stays, the manually written merge stays in storage, and the new card records that merge. Failed requests and lost replies keep the card and its editable merged text. |
| R6-3 | Conflicts lived only in memory. `lib/drafts.ts` stores their question, proposal, base, both sides, merged body and paths with the per-person draft. `suite/index.tsx` restores them and releases closed questions while retaining the merged text as a draft. | Reload and a new tab restore the same question and merged text, refuse editor keys and send no extra proposal. Resolution leaves no open adoption question. A replacement tab that never touches the editor removes the matching stored draft. A rejected or resolved stored question drops its card on return, says why, and keeps typed card text editable. |
| R6-4 | The consumption guard suppressed a step mark still shown at Enter. `runs/cockpit.tsx` sends the displayed mark through both Enter handlers, as it already sends the displayed note. | Press `2 p` with its reply held, then `k`, `f`, note, Enter. The hint shows step 2, the correction request carries `s2` and the note, and the recorded failure has `atStep: s2`. |

For point 6 of the brief, the card keeps its displayed current version while
open. A merge that meets a newer version replaces it with a card against the
current head. It does not announce success or discard the draft. The merge
text submitted on the first card becomes the draft side of the replacement.

The card also refuses input visibly while its merge reply is pending. Its
fields remain mounted and read-only, and its choice buttons are unavailable.
This closes the same loss between a card field and an in-flight request. The
new pending-card check first failed with `My title typed during merge` where
it expected `My title`. A lost-reply check then found that changing the card
could clear it when the question read was already decided. The implementation
keeps uncertain merges open until a retry or reload establishes the outcome.
Reload uses the closed-question rule and keeps the saved merged text.

The round-4 conflict tests and all four round-5 choice tests now use real key
input and assert visible refusal and unchanged editor fields. Choosing the
entire current body can be a no-op at version 2. The tests no longer require
a new version from that no-op. The known-conflict seal test still checks zero
extra proposals.

Two checks now prove the guards the round-6 reviewer found untested:

- `N-3 two live windows never share a pending existing-case request` checks
  every command sent by the second window. Removing the liveness guard made
  it fail on an ID equal to the first window's command.
- `R5B-1 a failed note request behind a later write releases the note for the
  next shortcut` holds the first failure, queues a pass, aborts the failure,
  and presses the next pass shortcut while the second request is held.
  Moving note release after the later-write guard made the third request's
  note `undefined` instead of `wrong total`. The second pass still carries
  no note.

Both temporary guard removals were restored before validation. No server or
core change is needed for R6-1 through R6-4. The earlier R5B-4 limitation is
unchanged: restoring a prior failure's step still needs the server's slot
fill to expose `atStep`, tracked as issue #72. Its reproduction remains the
suite's single explicit skip.


Final preflight passed on this implementation: `bunx tsc --noEmit` exited 0,
`bunx biome check src/web test/e2e` reported `Checked 61 files` with no fixes,
and `bun test test/architecture.test.ts` reported `12 pass`, `0 fail` and
31 assertions. The final focused round-6 run reported `14 pass`, `0 fail`
and 58 assertions in 15.83 seconds.

The final two consecutive full `bun test test/e2e` runs reported:

```text
run 1: 189 pass, 1 skip, 0 fail, 855 expect() calls.
       Ran 190 tests across 20 files. [288.59s]
run 2: 189 pass, 1 skip, 0 fail, 855 expect() calls.
       Ran 190 tests across 20 files. [287.00s]
```

No source or test changed between those two runs. The skip is R5B-4's
previously deferred slot-fill field, not a round-6 finding. Both runs include
the existing real idle seal and latency checks with their unchanged limits.
Each test fixture closed its own server and browser and removed its temporary
data. This worker made no commit, push, pull request or checkout cleanup.
Only the worker's own `/tmp` logs and source backups were removed after their
deciding lines were recorded here. The current diff remains for the lead's
independent verification and commit.

## Round 7 conflict fixes

The author checked the four findings in `UI-R7-FIXES.md` against the real Bun
server and Chromium. The lead owns independent verification and delivery of
this shared checkout. This pass changes only `src/web/suite/index.tsx`, this
check record, `test/e2e/round7.test.ts` and the round-6 expectations described
below. No server or core change is needed.

The stored draft's `conflict` is now the record of the conflict. The separate
`conflicts` map and `conflict` React state are gone. The open draft, live drafts
used by pending saves, and the draft list cache whole drafts. A storage event
refreshes the list and any open conflicted draft. Opening an editor reads the
stored draft; each editor change reads it again before writing. Caret changes
keep its stored body, and a refused content change restores that body and
reports the refusal in the footer. The pagehide rewrite was removed because
each input already writes synchronously and a departing window could otherwise
write its old copy over a conflict changed elsewhere.

The checks were written before implementation in `test/e2e/round7.test.ts`:

- R7-1 route A opens the second window before the conflict. Its editor shows
  the card and is read-only; keys are refused visibly. Resolving in the first
  window releases the second through storage. Both reload orders preserve the
  recorded text and leave no draft. Another check has the second editor open
  before the conflict arises and confirms that rejection releases it without
  reloading.
- R7-1 route B opens the page on another case while the question is rejected.
  Returning clears the stored conflict even without a live draft in that
  window. Later text is proposed, survives a reload, and reaches the server.
- R7-2 rejects after either "Keep current version" or "Use current title" was
  chosen but never confirmed. The draft keeps its original title and steps;
  only the conflict and pending request are cleared.
- R7-3 records the draft elsewhere, then opens the window left behind. The
  draft is dropped, no redundant proposal is sent, and the pane shows version
  3 rather than version 1.
- R7-4 records a merge but aborts its reply. The second press reads the settled
  question and head, clears the card without a reload, and permits a later
  edit that becomes version 4. The uncertain-request map remembers the body
  actually sent, so the comparison does not depend on later card choices.
- The removal check holds a successful merge reply and changes the stored
  body before releasing it. The later body stays on the device and in the
  editor, without a conflict, on base version 3, also after reload. Removal
  and settlement read the draft currently stored rather than a live copy.
- The write-guard check stores a conflict without dispatching a storage event
  while the editor is still writable. Text insertion is refused, the stored
  body stays intact, the editor freezes, and the footer reports the refusal.
  The read-only flag is asserted separately by the two-window checks.

Before implementation, the first nine checks reported `0 pass`, `9 fail`,
with `7 expect() calls`, in 34.49 seconds. They failed at the missing card,
the conflict that stayed stored, the replacement title after rejection, the
draft that stayed after recording elsewhere, the stuck retry card, the deleted
later body, and accepted input before a storage event. The later open-editor
check also failed on the original source in a scratch export, waiting for its
missing card. The focused fixed run reported `10 pass`, `0 fail`, with
`49 expect() calls`, in 20.84 seconds. A further footer assertion passed in a
focused run with `1 pass`, `0 fail`, and `5 expect() calls`.

Scratch exports prove both guards independently. Replacing the removal
condition with `true` made the later-body check receive `undefined` instead
of "Later text kept on the device". Removing just the read-only flags made
both route-A tests fail with `Expected: true`, `Received: false`. Removing
just the guard in `change()` left the footer without "Resolve the conflict
first", so its focused check failed. The scratch exports were removed; no
mutation touched the shared checkout.

Two round-6 expectations were updated to follow this brief. Rejection or a
different merge elsewhere keeps the draft's own body, rather than an
unconfirmed card edit. When a submitted merge meets a new conflict, its body
becomes the replacement draft's `mine` only if the stored body still equals
the earlier `mine`; later text is never replaced. The earlier conflict checks
reported `87 pass`, `1 skip`, `0 fail`, and `236 expect() calls` in 82.68
seconds. The skip is the existing R5B-4 slot-fill `atStep` deferral, issue #72.

Preflight on the fixed source passed: `bunx tsc --noEmit` exited 0;
`bunx biome check src/web test/e2e` checked 62 files without fixes;
`bun test test/architecture.test.ts` reported `12 pass`, `0 fail`, and
`31 expect() calls`. `git diff --check` passed.

Two more checks exercise the same removal step. A successful reply can arrive
after another window has cleared the conflict and begun a fresh draft whose
body happens to equal the earlier `mine`. Removal now also requires that the
stored draft still carry that question. The new check failed before that
condition, because the draft disappeared, and passed afterwards.

After a lost merge reply, text typed subsequently in the card must survive the
second press. Settlement compares the stored merged body with the body
actually sent. If they differ and the draft body still equals `mine`, the later
card body becomes an editable draft on the recorded head. A draft body that
differs from `mine` is kept as it is. The new check failed before this guard,
waiting for the missing "later text is kept" status, and passes with the later
card text in the editor and storage, then recorded as version 4. A read failure
during retry does not replace the remembered sent body with an unsent choice.

The expanded focused round-7 run reported `12 pass`, `0 fail`, and
`58 expect() calls` in 24.46 seconds. The final full runs below use this
expanded suite. The earlier full pass reported `199 pass`, `1 skip`, `0 fail`,
and `905 expect() calls` in 302.84 seconds, before these two additional checks.
An overlapping intermediate run had one R3B-3 failure waiting for its second
undo request. Its immediate focused rerun passed. No run or undo source was
changed in this pass; the final consecutive runs are the delivery evidence.

The two final consecutive `bun test test/e2e` runs passed:

```text
run 1: 201 pass, 1 skip, 0 fail, 913 expect() calls.
       Ran 202 tests across 21 files. [298.26s]
run 2: 201 pass, 1 skip, 0 fail, 912 expect() calls.
       Ran 202 tests across 21 files. [298.37s]
```

No source or test changed between these runs. Both include all twelve round-7
regressions and the real idle and latency checks. The skip remains R5B-4's
previously deferred slot-fill field. TypeScript, Biome and the twelve
architecture tests also passed on the final source. Independent verification
of this uncommitted diff remains with the lead. This worker made no commit,
push, pull request or checkout cleanup. Each test fixture closed its server
and browser and removed its temporary data. Only this worker's own scratch
exports and logs under `/tmp` were removed after recording their evidence.

## Round 8: one live window owns each draft

R8-1 came from two live windows writing one existing-case device draft. Opening the editor changed its owner implicitly, and an older proposal reply could overwrite another window's text. Ownership now covers every draft. Opening claims only an absent owner's draft. "Take over here" is the only live handoff. Storage events synchronize the body, conflict and owner. Device writes, removals, proposal sends and conflict merges check the stored owner when they run.

`test/e2e/draft-ownership.test.ts` checks both reported orders with real proposal replies held by Playwright routes, visible input refusal, complete text on takeover, a read-only former owner sending nothing, simultaneous keys, sequential takeovers, closed-tab recovery, and conflict-card ownership. It also checks a takeover before its storage event, a held conflict reply after takeover, two clean editors racing their first key, and a stored takeover before a conflict-card change. Before implementation, the original seven tests produced `1 pass`, `6 fail`. The failing assertions showed a writable second editor and card, absent refusal, and an unguarded stored ownership change. Closed-tab recovery already passed.

Earlier checks now assert the ownership contract:

- Round 3's shared-window tests hand off title or step edits, refuse the second editor until takeover, make the first read-only, and record distinct command ids. The pending-request test requires takeover before the second window sends its own request.
- Round 4's duplicated-tab test keeps distinct window ids, refuses input in the copy until takeover, preserves the first window's text and records both windows' accepted text together. The unfinished-capture test now shows another live window's draft read-only, using the same rule as existing cases.
- Round 5's pending-request test makes the second window read-only and proves Escape sends nothing. After the first request is acknowledged, the second continues from the recorded head under a different command id. Closed-owner recovery remains covered without changing its assertions.
- Round 6's new-tab conflict test requires takeover before resolving while the original owner is live. Its settled-card tests now keep the hand-typed title after rejection or a merge elsewhere and prove it remains editable after reopening.
- Round 7's second-window tests show ownership refusal alongside the conflict freeze. Rejection ends the conflict without transferring ownership, so the second window deliberately takes over before continuing. Its late-merge test takes over before releasing a settled conflict and retains the new owner's fresh draft when the old reply arrives.

The lead owns independent cross-provider review of this uncommitted fix pass. No server or core changes are required.

The completed review added R8-2 and R8-3 before this pass finished. R8-2 discarded all card content on rejection and kept the sent merge only in memory. Each conflicted text field is compared with both sides to distinguish hand-typed content from the unconfirmed button choices covered by R7-2; `sentMerge` survives reloads. Four round-8 tests type a title or step, then reject the question or lose the merge reply and reload. All four failed before this change, and pass with the typed content on the device, on screen after another reload, and finally on the server. The older unconfirmed-choice checks still require the original draft.

R8-3 allowed a second window to reconcile a settled question while the owning window was still processing its merge reply. The ownership rule prevents that second writer. Its round-8 test holds the first merge reply for 1.5 seconds with a second window open, resolves the resulting new conflict, and proves version 4 stays recorded with no draft after opening and leaving the editor. Run against a clean export of `5cc2b3a`, it failed with `Expected: "Coupon case merged by hand"`, `Received: "Coupon case mine"`. The full round-8 file now passes `15 pass`, `0 fail`.

Reload checks wait for the settled-conflict status before reading the editor, so the assertion covers the reconciled UI rather than the initial frozen body. The revised round-6 file passes `14 pass`, `0 fail`.

The final round-8 file covers R8-3 with the second window in read mode and in its editor: `16 pass`, `0 fail`. One held-proposal reply timed out during a loaded run; rerunning the complete file alone passed without an implementation change.

A merged step is live input, so its stored schema must allow an empty action while the person replaces it. With the version-body schema, clearing that field made `readDraft` reject the entire record and the other window lose its read-only card and takeover action. `R8 an empty merged step remains owned until a deliberate takeover` failed at the missing takeover action before changing `DraftConflict.merged` to the existing draft-body schema. It checks empty-field ownership, deliberate takeover, continued typing, and the final server text.

The hand-typed check compares each text field separately, because side choices can combine a title from one side with a step from the other. A new test types in the merged title, replaces it with a side choice, then rejects the question. A sticky hand-edit marker failed with `Expected: "Coupon case mine"`, `Received: "Coupon case theirs"`; comparing the surviving field values preserves the original draft. This also recovers older stored cards without requiring a new marker.

### Round-8 final handoff evidence

The final focused command, `bun test test/e2e/round8.test.ts`, passed all 18 tests: `18 pass`, `0 fail`, `67 expect() calls`, `[65.06s]`. This includes all three findings and the empty merged-step and replaced hand-typed-field regressions. Isolated file runs also passed: round 4, `61 pass`, `0 fail`; recovery, `12 pass`, `0 fail`; revised round 6, `14 pass`, `0 fail`. The second full attempt passed every test in round 3 capture, round 5 (apart from its existing skip), round 6 and round 7.

`bunx tsc --noEmit` passed after the final source changes. `bunx biome check src/web test/e2e` passed earlier in this fix pass; after the last changes, `bunx biome check --write src/web/lib/drafts.ts src/web/case/pane.tsx src/web/suite/index.tsx test/e2e/round8.test.ts` passed. `bun test test/architecture.test.ts` passed all 12 tests earlier in the pass. No server or core changes were made.

Both full attempts used `bun test test/e2e`:

```text
attempt 1: 212 pass, 1 skip, 4 fail, 979 expect() calls.
           Ran 217 tests across 22 files. [410.14s]
attempt 2: 216 pass, 1 skip, 2 fail, 983 expect() calls.
           Ran 219 tests across 22 files. [847.55s]
```

| Full-attempt failure | Error | Isolated result |
| --- | --- | --- |
| R6-3 new tab restores the same conflict and its merged text without proposing again | `TimeoutError: click: Timeout 5000ms exceeded.` Resolve conflict was disabled. | Revised to require deliberate takeover; round 6 passed 14/14. |
| R6-3 a stored conflict rejected elsewhere releases only the card on return | `TimeoutError: waitFor: Timeout 5000ms exceeded.` Waiting for the old draft-kept status. | Revised to assert the kept hand-typed merge and its status; round 6 passed 14/14. |
| R6-3 a stored conflict resolved elsewhere releases only the card on return | `Expected: "My title"`, `Received: "Draft typed in the card"`. | Revised to require preserving hand-typed content; round 6 passed 14/14. |
| R8-2 a hand-typed merged step survives lost reply then reload | `Expected: "HAND TYPED TEXT"`, `Received: "Apply coupon mine"`. | Assertion now waits for conflict settlement; final round 8 passed 18/18. |
| a queue defect reference survives a failed answer and reload | `TimeoutError: waitForFunction: Timeout 5000ms exceeded.` Waiting for Answer unavailable. | Recovery passed 12/12 unchanged. |
| R4C-1 server rejects run write after shared cookie changes without an extra session read | `TimeoutError: waitFor: Timeout 5000ms exceeded.` Waiting for #token. | Round 4 passed 61/61 unchanged. |

Two consecutive full passes were not completed. The lead instructed this worker to stop full-suite runs because other agents were running parallel suites under load, and will perform the full check on a quiet machine. The separate race review confirmed that an action immediately after installing a Playwright route can precede Chrome's interception activation. Another agent owns the guard in `test/e2e/support.ts`; this worker did not edit that file or latency.test.ts, or add route workarounds. Independent verification of the final diff remains with the lead. The existing R5B-4 slot-fill `atStep` skip (issue #72) is unchanged. No commit, push, PR or checkout release was performed.

## Issue #81: a merge the server combined with a newer change (review round 9, R9-1)

The page no longer decides whether its merge was recorded by comparing bodies. It asks the server what became
of each command id the card sent (`command`, decision 0013) and builds the draft from the answer. The rule
itself is in `src/web/lib/merges.ts`, with unit tests in `test/merges.test.ts`.

`test/e2e/conflict-merge.test.ts` runs the routes in a browser. Each starts from a card with a hand-typed merged
title, after a colleague changed another field while the card was open.

| Route | Source | What the test requires |
| --- | --- | --- |
| The merge is acknowledged | R9-1 | Version 4 holds the typed title and the colleague's step; no draft is left; leaving proposes nothing |
| The reply is lost; a second press, or a reload | first check, F1 | The same |
| The reply is lost; more text is typed in the card | first check | The later words are a draft on version 4 with the colleague's step; leaving records version 5 with both |
| `same-after`: a colleague changes the title after the lost merge, then later words | second check, F2 | Leaving shows a conflict card; version 5 keeps the colleague's title until the person resolves |
| `same-before`: the lost reply held a new conflict | second check, F2 | The new card opens with the later words; nothing is recorded; the person's second step is still there |
| `again-title`: the head moves on before the reload | second check, F3 | No draft; version 5 keeps the colleague's title and the merged steps |
| `api-different-title`, `api-different-step`: the merge never arrived and the same person answered elsewhere | second check, F3 and F4 | The card's text stays a draft; leaving shows a conflict card; the other client's version stands until resolved |
| A merge the page gave up arrives while a second attempt is on its way | this change | The first is recorded, the second refused; the later words are a draft on the recorded version |
| A typed merge is kept after a rejection, and a colleague undoes a change the card had held | this change | The undone change does not come back |
| A step with an expected result and no action yet is in the draft; the merge is recorded, or meets a new conflict | the check of this change, V1 | The step stays on the device, and is in the editor again after the merge |
| The person takes the current title, a colleague changes it again before the merge, the reply is lost, and a title is typed in the card | the second check of this change, N2 | The typed title stays a draft on the version it was written on; leaving shows a conflict card; the colleague's title stands until resolved |

The first eleven failed on the revision before the change (`899c428`), run from a clean export. The last two
tests are the finding of the independent check of the first version of this change (`7ef33ca`), and failed there:

```text
(fail) a merge typed by hand that the server combines with a colleague's newer change leaves no draft to undo it
error: The expected server state did not arrive
(fail) text typed in the card after a lost merge reply is kept on the recorded version, with the colleague's change
Expected: "Open the cart, changed by a colleague"  Received: "Open the cart"
 0 pass
 11 fail

on 7ef33ca:
(fail) a step still being typed, with an expected result and no action, stays on the device when the merge is recorded
Expected to contain: "UNRECORDED EXPECTATION"  Received: ""
```

One earlier test changed. `R6-3 a stored conflict resolved elsewhere preserves hand-typed card text on return`
expected the status "later text is kept". The text is still kept and still editable. It is now a draft on the
version it was written on, and the status says "typed merge is kept", as it does after a rejection.

Two independent checks of this change are beside the earlier reviews: `ui-r9-fix-check-3.md` (the first
version, one blocker, V1) and `ui-r9-fix-check-4.md` (with the fix, PASS). The second names two things that
were so before this change and are not fixed by it. Leaving the editor in the ordinary way still drops a step
that has an expected result and no action (issue #86). `R3B-2 the first queue cursor survives a new question and
settlement elsewhere` times out now and then on a 10-thread Mac (issue #87).

## Issue #86: leaving the editor keeps a step that has an expected result and no action

`sealDraft` sends the body without the steps that have no action. When the version was recorded it removed the
stored draft, and it decided whether a draft was left by comparing the same reduced body. A step with an
expected result and no action was then in no version and in no stored draft, and a reload lost it.

The draft that is left after a version is recorded now stays stored while it holds such a step
(`holdsUnfinishedStep` in `lib/merges.ts`, on the rule a conflict card already had). It is kept, not sent:
while all a draft of a recorded case holds beyond its version is that step, leaving the editor, the idle timer
and a hidden tab propose nothing. A draft with nothing but empty steps is removed as before.

| Route | Test | What the test requires |
| --- | --- | --- |
| On a case: a new step with an expected result and no action, another change, Escape, reload | `drafts.test.ts`, the issue's steps | Version 2 has the other change and not the step; the stored draft and, after the reload, the editor have it; Escape again proposes nothing; with an action the step is version 3 and no draft is left |
| The step is in a draft a settled conflict card left (finding N1's own route), then Escape | `conflict-merge.test.ts`, the V1 test | Nothing is proposed, and the step is still stored |
| The rule: an expectation with no action; an empty step; a recordable step | `test/merges.test.ts` | Only the first is unfinished |

The first failed before the change with `Expected to contain: "Total shows $90.00"  Received: ""` on the stored
drafts. With the change in and the check before sending taken out, it fails with two proposals where one is
expected, and the second row fails with one where none is.

Run once by hand in the browser, with no test of their own: a new case with a title and such a step keeps it
under the new case's ref and shows it after a reload; removing the step and leaving ends the draft with a
proposal that changes nothing; a stored draft older than 30 seconds, whose idle timer fires at once after a
reload, proposes nothing. An action emptied on a recorded step that has an expected result is recorded as the
step's removal, as before, and the step now stays in the draft with its expected result.

Not changed: a new case with no title and no step that has an action is still dropped on leaving, with an
expected result or preconditions typed or not (`dropEmpty`).

### The independent review's blocker (B1): what a draft held of a step removed a colleague's restored step

The first version of this change kept a draft for what was left of a recorded step whose action the person
had emptied: the step's removal is recorded, and the draft holds the step with no action. A colleague then
restored the step. The person's next proposal was recorded beside it, and the draft was moved onto that
version by a plain three-way merge, in which the draft's step counted as the colleague's with its action
taken out. The draft stayed stored, so leaving again proposed the step's removal: version 5 without it, with
nothing typed and no conflict card. Before this change the same body was in the editor and not stored, so it
was not sent.

A draft now moves onto a newer version through `carried` (`lib/merges.ts`), after its own proposal is recorded
and when an editor with nothing to record reads a newer version. A step the draft holds with no action, which
was not in the body last recorded, is text and never a change: where the version has a step under its id, that
step stands, an expected result of the draft's own stays as a step under a new id, and a step with nothing of
its own goes. An action the person emptied after the body went out is still their removal of the step. A card's
draft was safe already: `draftAfterMerge` does not carry a draft that conflicts with the recorded version.

| Route | Test | What the test requires |
| --- | --- | --- |
| The review's five steps: an action emptied, its removal recorded, the step restored by a colleague, the title changed, Escape twice | `drafts.test.ts` | Version 4 has the title and the restored step; the second Escape proposes nothing; the editor shows the restored step; no draft is left |
| An editor with nothing to record still shows an emptied step; a colleague restores it; the title is changed | the same test, second half | The editor shows the restored step once the version is read, and version 7 still has it |
| The rule: a restored step, a reworded one, an expected result typed on what was left, a step no version has, two kinds at once, an action emptied after the send | `test/merges.test.ts` | The recorded step stands; typed text stays under a new id; a new step stays; the person's own removal stays one; with no action typed since, nothing is left to record |
| A card's draft holding such a step, and a recorded merge that has the step | `test/merges.test.ts` | The draft stays on its own base |

The first row failed on `593f1eb` with three proposals where two are expected. With the rule taken out after a
reply it fails the same way; taken out where a newer version is read, the second half fails waiting for the
restored step in the editor. That second route was so before this change (the review calls it an older
defect): the title change itself removed the restored step.

Run once by hand in the browser, before and after: the colleague records the step again with another action
(before: version 5 removes it; after: it stands and nothing more is sent); the colleague removes the step whose
action the person has emptied (before: the same unchanged request at every Escape; after: one request);
a new unfinished step beside what is left of a recorded one (after: the recorded step stands, the new one
stays in the draft); a new expected result typed on what was left (after: it is step 3 under a new id, also
after a reload, and the restored step stands); the review's route with the connection dropped.

## Issue #135: one read of a case the page owes

Since #129 the page reads a case first when an editor is asked for on a case whose draft another tab removed
and whose read failed or was left (`owed`). Each request made its own read: two presses of `e` while the reply
waited made two, and the two could come back in either order. A property changed in the read view of such a
case was read and then dropped.

Now `readCase` keeps the read of each owed case while it is on its way, and every request for it waits on that
one: `endFollowed`, and `readOwed` for `e`, a click on a field and a property change. It holds what it read and
takes the case out of `owed` once. A property change waits on it like the others, and is not made: the person
makes it again on the case as read, as before. A request whose case is no longer the one in the pane gets nothing.

What the shared read cannot hand to the wrong place: it is per screen, and the screen is made again for each
person (the `Workbench` key) and each project (the screen's key). `call` refuses a reply that arrives in another
session, and the read holds the case only in the session that made it. It is keyed by the case, and each waiter
opens only if its case is still the one in the pane. What the read brings is the case as recorded. Whether this
window may write a draft of it is asked after the read, as before: `e` and a click do not take a draft a live
window owns (`claimDraft`).

| Route | Test | What the test requires |
| --- | --- | --- |
| The read held; a property ticked in the read view and `e` pressed twice | `round6.test.ts`, R6-1 a case left before the second tab could read it | One read of the case while it is held; then one editor, on the merged title, with the property not ticked; leaving it stores no draft |

It failed before the change with `Expected: 1  Received: 3` reads. With the sharing taken out it fails the same
way. Run by hand, not a test: another case selected while the read waits (nothing is made or said there).

A first version also made the property change on the case as read. Its review found three ways that went wrong:
a second choice made while the read waited lost to the first, the "not made" line was overwritten by the line of
the `e` waiting beside it, and a screen left for another project made the change when the read came back. That
part was taken out; the issue lists the dropped change as a known limit, and it stays one. Not tested:
`endFollowed` and a press of `e` waiting on the same read (the read of a removed draft still on its way when
the person leaves the case, comes back and presses `e`); by reading, both go through `readCase`.

Left as it is: after a failed read and coming back to the case, the read view shows the case as the page last
read it, which can be from before the other tab's change, until `e`, a click, a property change or the page's
own refetch succeeds. Showing that would take the read view saying the case may be out of date, with a way to
read it again, as the ending draft's pane does (`draftEndedStatus`), in `case/pane.tsx`.

## Issue #71: a save whose reply was lost is asked about before anything is sent (and #73, item 1)

The editor's save stores its request with the draft (`sent`). When the reply was lost, the next leave sent the
same request again under the same id, and sent what was typed since only after that reply. Rounds 3 and 4
(A-1, A-2, R4A-1, R4A-2) found routes on which the remembered request went out when it should not. A tab closed
twice in one sentence (#73) sent the first tab's request again as it closed, and the newer text never went out,
because a closing page gets no reply.

Now `sealDraft` asks `command` about the remembered save first. `done`: the recorded reply is handled as a live
one, and the request is not sent again. `none`: the same request goes again, unchanged, under its own id: it may
still be on its way, and the server records one id once. Then what was typed since goes under a new id. `begun`
or no answer: nothing is sent, and the draft is kept. An effect asks as soon as a draft with such a save is in
the pane, once for each save, and only settles that save (`settleOnly`): taken as recorded, or sent again;
nothing typed since goes until the editor is left. So a second tab is on the version the first close made
before the person types. A page that closes before an answer sends nothing more. Decision 0013, "The ordinary
save asks too", has the reasons and what was turned down.

The first build sent the current text under a new id on `none`. Its review (B1) held the first save on its way,
reloaded, and let the page's `none` stand: the held save then landed after the current text, as a second case
for a capture and as a conflict question for an edit. The answer is the rule above: on `none` the one request
sent is the one that cannot be recorded twice.

| Route | Test | What the test requires |
| --- | --- | --- |
| A tab closed in a sentence; a second tab opens the draft, the person types on and closes it | `round3-capture.test.ts`, "a tab closed twice in one sentence" | The second tab says "Your last save is recorded as version 2"; version 3 has the whole sentence |
| The server recorded the save, its reply was lost, and the page's first question about it got no answer either; more is typed; Escape | `round3-capture.test.ts`, A-1 (new and edit) | Two proposals in all, under two ids, and two `command` questions |
| A save is held on its way; more is typed; the page reloads, and its question is answered `none`; Escape; the held save then lands | `round3-capture.test.ts`, "a save still on its way when the page reloads is recorded once" (new and edit) | One case, no question; the held save's version has the first phrase and the next has the rest; the held copy gets the reply of the copy sent again; two ids, each with one request body |
| The save never reached the server; a colleague changes the title; more is typed; Escape | `draft-conflicts.test.ts`, R4A-1 | The first request goes again under its own id, unchanged; it meets the colleague's title as a conflict, and the card shows the current text |
| A capture's save goes out as the page reloads | `recovery.test.ts`, "reload offers every unsaved new case and each can be sent once" | A capture with a save of unknown fate is a case once it is opened (recorded, or sent again under its id); the other is sent once |
| A capture's save goes out as the page closes or reloads | `session-and-keys.test.ts`, R4C-4 (close and reload) | The returning page says version 1 (recorded, or sent again); one case, at version 1 |

On `d5623a3` (the first build): B1's two tests fail with two cases for the capture and one open question for
the edit; R4A-1 with the second request under a new id; R4C-4 at its status wait, which looked for "Version"
where the page said "Your last save is recorded as version 1". The double close, A-1 and R4A-1 had failed on
`2a56c24`, before any of it. Taken out one at a time from the corrected change: without the question on
opening, the double close fails (and A-1, which counts two questions); with the question on leaving taken out
(the remembered request sent again unasked), both A-1 tests fail with three proposals.

The recovery test sent a capture whose save the browser had delivered as the page reloaded, and the replay
answered it with the case the server had made. The reloaded page now settles that save as soon as the capture
is in the pane, and shows the case. The test opens each capture, waits for its save to be settled, and sends
the ones that are still captures.

Left: a page that closes before the answer sends nothing; the draft waits for the next page. A save sent again
on `none` records the text it carried, which the person may have changed since; the later text is the next
version. "Take over here" still drops the former owner's request: if that request was recorded, or lands later,
the new owner's save meets it.

## The documentation at `/docs` (decision 0016)

The checks that decide this change, written before it. `test/docs.test.ts` and `test/e2e/docs.test.ts` hold them.

- D1: Signed out, in server mode, `/docs` and each of its pages answer 200 with no cookie set, while
  `/api/session` and an operation still answer 401.
- D2: The sidebar's footer has Docs, beside Keys and Theme, which opens the page about the screen that is open, and the sign-in page has "Read the docs", which opens `/docs`. Both open a new tab.
- D3: `g d` on the queue opens `/docs/decide` in a new tab, in the theme the app is in. The `?` sheet links to the
  same page and to the keyboard page. `docs policy` in the palette offers "Docs: Policy". The empty queue links to
  the page that says how a question gets there.
- D4: A diagram on a page is drawn, in the page's theme, and its frame has an origin of its own: a `fetch` of
  `/api/session` from inside it is refused.
- D5: `/` focuses the search, typed words list headings that hold them, and Enter goes to the first.
- D6: Every key the `?` sheet lists on each screen is a row of `docs/guide/keyboard.md` with the same words.
- D7: No page of the docs runs a script or a style written into the page, and none makes the browser report an
  error.

## People sign in as themselves: the pages (issue #30, decision 0017)

The pages for what the server and the command line already did: the sign-in page, the page of an invitation,
"Your sign-in", "Your sessions" and "People" in Settings, and sign-out. Each row is something a screen must do
and the browser test that holds it. The tests run Chromium against the real server; a passkey is made and used
on Chromium's virtual authenticator, with the page at `localhost`.

| Screen | What it must do | Test |
| --- | --- | --- |
| Sign-in | Focus starts in the name. Tab goes name, password, "Sign in", the passkey button where there is one, token, "Sign in with the token". Enter submits the form the caret is in. | `people-signin.test.ts`: the token form still signs the owner in |
| Sign-in | A wrong name or password shows one sentence under the form and keeps the name and the password. The page says that an admin can send a new link. | `people-signin.test.ts`: an invited person accepts with a password |
| Sign-in | A button pressed by the keyboard keeps the focus while its request runs and after the refusal. Busy, it is marked `aria-disabled` and takes no second press. The same holds for "Accept and sign in", "Change password" and "Make invitation link". | `people-signin.test.ts`: an invited person accepts with a password; `people-invite.test.ts`: the invitation page says how long to wait; `people-settings.test.ts`, the first two tests |
| Sign-in | The fifth wrong password for one name is answered as the four before it, and starts the block. The next attempt while the block lasts shows "Too many attempts. Try again in N seconds.", with N from the reply's `Retry-After`, and keeps the name and the password. Nothing is sent again by itself. | `people-signin.test.ts`: five wrong passwords for a name; `limit.test.ts` for a token |
| Sign-in | A refusal that is neither a wrong proof (401) nor a wait (429) is shown as the server wrote it, under the way that was tried. A wait whose length a proxy dropped says "Try again later." One refusal is on the page at a time. | `people-signin.test.ts`: a refusal that is neither a wrong proof nor a wait |
| Sign-in | "Read the docs" opens `/docs`, which needs no account. | `docs.test.ts`, D2 |
| Sign-in | "Sign in with a passkey" is there only when the instance says it has passkeys and the browser has them. At another name of the instance the browser refuses, and the page says "This browser could not use a passkey here." | `people-passkey.test.ts`, both tests |
| Sign-in | The token form signs in whoever holds a token, and a wrong token says "That token was not accepted." | `people-signin.test.ts`, `signin.test.ts` |
| Invitation | It renders with nobody signed in, says who the invitation is for and until when, and takes the code out of the address bar as soon as it has read it. A second link opened in the same tab is read too. | `people-invite.test.ts`: a wrong, a used and an expired link |
| Invitation | A wrong, a used and an expired link each show "This invitation does not work any more. Ask whoever sent it for a new one." and no form. The address with no code says to open the link again. | the same test |
| Invitation | The password is typed twice and counted as it is typed. One that is too short, and two that differ, are refused in the page beside the field, with what was typed kept. Accepting signs the person in and opens the app. | `people-signin.test.ts`: an invited person accepts with a password |
| Invitation | With a passkey: by keys alone, Tab to the box, Space, Tab to the name (it starts as the browser's own), Enter. | `people-passkey.test.ts`: a person accepts an invitation with a passkey |
| Invitation | A browser signed in as somebody else is told who and asked. The fields are disabled until the answer. "Continue" ends that person's session with the acceptance, which carries their name (`replace`) and no other. | `people-invite.test.ts`: a browser signed in as somebody else |
| Invitation | Until the page knows who is signed in, the fields and the button are disabled and it says that it is checking. Then it asks, or puts the caret in the password. | `people-invite.test.ts`: the fields of an invitation wait |
| Invitation | When the page cannot find out who is signed in, because the request failed or no answer came in twenty seconds, it says so, the fields stay disabled, and "Try again" asks once more with the code it holds. An answer that fails is not taken for "nobody". | `people-invite.test.ts`: when the answer to who is signed in is refused by the network; never arrives |
| Invitation | Somebody who signs in elsewhere after the page opened is asked when they accept. What they typed stays, and "Continue" sends it again with the name the question was about. | `people-invite.test.ts`: somebody who signs in elsewhere |
| Invitation | An answer about one person signs nobody else out. After "Continue" for robin, tom signs in from another tab: the acceptance names robin, the server refuses it, tom is still signed in, and the page asks about tom. "Continue" then names tom. | `people-invite.test.ts`: an answer about one person signs nobody else out |
| Invitation | A passkey that was made before the question is kept. After "Continue" the same answer is sent again with the name, the authenticator is not asked twice, and one passkey is stored. Past the five minutes its challenge lasts the page says so and the passkey is made again; that last part has no test here. | `people-passkey.test.ts`: a passkey made before the question |
| Invitation | A recovery link says "Accepting replaces every way you sign in and signs you out everywhere else." | `people-invite.test.ts`: a recovery link |
| Invitation | When looking at the invitation is answered with a wait, the page says it and "Try again" asks once more, with the code still in memory. When accepting is, the wait is under the form and the passwords stay. | `people-invite.test.ts`: the invitation page says how long to wait |
| Shell | Enter and Space press a button that was reached with the keyboard, on every screen: a screen's own binding on those keys does not take them from it. On the Suite, either key on "Sign out" sends one sign-out. A button the pointer gave the focus to (until the focus moves on), and the rows of a screen's list, leave the keys to the screen: after a click on "Toggle theme", Enter does not press it again; reached with Tab, it does. | `people-signin.test.ts`: on the Suite screen, Enter; Space; Enter after a button was clicked |
| Shell | A sign-out that gets no reply is looked up: the page asks who is signed in, and shows the sign-in page, or says that the browser is still signed in and takes another press. When that question gets no reply either, it says it cannot tell and to try again. | `people-signin.test.ts`: a sign-out whose reply is lost; a sign-out that never reached the server |
| Shell | The navigation has Suite, Queue, Runs and Changes and nothing else. The footer has, in this order: who is signed in, the link to Settings (marked as the current page while Settings is open), "Sign out", then Docs, Keys and Theme. Collapsed, the footer's links stay inside the sidebar as icons. | `shell.test.ts`: shell routes, palette, help and theme |
| Shell | The sidebar collapses to 64 px with `[` or the button beside the name, whose tooltip names the key. On every screen, at 1440, 1000, 900 and 700 px, the list keeps its width and the pane on its right takes what the sidebar gave up (under 760 px both take it), and the key caps outside the sidebar stay. A case pane widened with `z` stays widened, and under 760 px `z` leaves no empty column. A reload keeps the sidebar as it was; a browser whose store refuses still collapses and opens it. A phone has no such button. | `shell.test.ts`: collapsing the sidebar; `phone.test.ts`; `architecture.test.ts`: the columns of the app |
| Shell | "Sign out" is in the sidebar's footer and on `g x` when the session is a browser's. It ends the session on the server: a reload is still the sign-in page. In local mode there is no button, no key and no line in the keys sheet. | `people-signin.test.ts`: the first and the last test |
| Your sign-in | `n` goes to the new password. "Change password" asks for the current one; a wrong one says so beside its field and keeps the rest. A change says how many other sessions ended, and the fields are emptied and made again, so a mark a password manager put on a field it filled goes with it; a caret that was in a field is on the button. "Set password" asks for no current one. A wait is said beside the current password, with the rest kept. | `people-settings.test.ts`: changing the password; `people-passkey.test.ts` |
| Your sign-in | Each passkey has its name and when it was last used. A new one is named from the browser. The authenticator that holds one already is told "This passkey is already registered.", and the name typed stays. | `people-passkey.test.ts` |
| Your sign-in | The last way of signing in has a disabled "Remove" and the reason under the list. Removing the passkey this browser signed in with returns to the sign-in page. | `people-passkey.test.ts` |
| Your sessions | Each session says what opened it and from which address, the browser as the server recorded it, and when and from where it was last used; this browser's is marked. The list is read again each time the section opens. "End" on another session signs that browser out; on this one it returns to the sign-in page. | `people-settings.test.ts`: changing the password |
| People | An admin who is a person names somebody, chooses what they may do, the project and how long the link works, and gets the link once, masked, with "Copy link". After "Dismiss link" the page does not hold it. `n` goes to the name. | `people-settings.test.ts`: an admin invites somebody |
| People | By the keyboard: the two selects keep the focus from one arrow key to the next. When a link is made the focus is on its "Copy link"; when it is dismissed, on the name. | the same test |
| People | A reply that is lost after the invitation was made: the page says that it cannot tell whether the person was invited, reads its lists again, shows the person in them, and sends no second invitation for that name. | the same test |
| People | A new invitation starts with read, record, produce, answer and plan ticked and `admin` not, with a line under the boxes saying what `admin` gives. After an invitation that had it ticked, it is unticked again. | the same test |
| People | Open invitations show what each person may do, who made each and when it runs out; "Revoke" removes one and the link accepts nothing. A name that signs in already is not invited as new. | the same test |
| People | "Recovery link" asks first and says that it replaces every way the person signs in. The owner has it beside every person. Anybody else has it beside their own name only, with a sentence saying the owner makes the others, so no button is answered 403. | the same test; `people-settings.test.ts`: a person who is not an admin |
| People | A person who does not administer the instance has no "People" section. | `people-settings.test.ts`: a person who is not an admin |

Every test asserts what the browser logged. For most that is nothing, which under the page's
`Content-Security-Policy` includes any inline script or style the pages might have added. The tests that ask
for a refusal assert exactly what they asked for: the 404s of links that accept nothing, the 409s of a browser
signed in as somebody else, the 403 of a wrong current password, the 429 of a name with five wrong passwords,
the 408 and the 429s that a test answers in the server's place, and the one reply a test drops. (A 401 is not
in the list: `test/e2e/support.ts` leaves it out for every browser test.)

**When no reply comes back.** A request that changes something may have arrived though its reply did not, or
may never have left, and the page cannot know which. Where a second press would act a second time it does not
say "try again", and says only what it knows:

- Accepting an invitation: it cannot tell whether the invitation was accepted; try signing in with what was
  chosen.
- Changing a password: it cannot tell whether the password was changed; it may or may not have been, and
  signing in with the new one finds out. The list of credentials and the session are read again. A refusal of
  the current password on the next try proves nothing, since it may be mistyped.
- Making a link: it reads its lists again and says that a person found in them was invited and that link is
  lost.
- Signing out: it asks `/api/session`, and shows the sign-in page or says that the browser is still signed in.
  When that gets no reply either it says it cannot tell and to try again: a second sign-out ends nothing more.

Ending a session, removing a way of signing in and revoking an invitation are safe to press again. With no
reply they say "Mainworthy did not answer. Check the connection and try again." and read their list again,
which shows what became of them. A sign-in that gets no reply says the same: nothing is lost by trying it
again.

The page sends a proof or a change once for each press and never again by itself. What it asks again by itself
only reads: these lists, and `/api/session`. Three of the cases have a browser test: the lost reply to a new
invitation, to a password change and to a sign-out.

The waits on the invitation page and in "Your sign-in" are answered by the test, not the server. The browser
reaches the test's server from the loopback address, which the server does not count, and a real block on a
name would refuse the right password a few lines later in the same test. The server's own counting is held by
`test/people.test.ts` and `test/limit.test.ts`.

Three checks were broken on purpose to see their tests fail, and restored: with the sign-out button shown to
any session, "local mode has no sign-in page and nothing to sign out of" fails with `Expected: 0`,
`Received: 1`; with the code left in the address, the invitation test fails with the address still ending in
`#not-a-code-anybody-made`; with the wait shown in the server's words and not read from `Retry-After`, the two
tests of a wait on the sign-in page time out waiting for "Too many attempts".

What no browser test holds:

- A passkey in a browser other than Chromium, and on a real authenticator. The conversions between the
  server's text and a browser's bytes are unit-tested (`src/web/lib/passkey.test.ts`), and the message for a
  browser without `getPublicKey()` is written and never shown by a test: Chromium has it.
- The copy button over plain http at a name that is not this machine's, where a browser has no
  `navigator.clipboard`. The token's copy button has that test (R2-5); the link's uses the same steps
  (`src/web/lib/clipboard.ts`) and is tested with the clipboard only.
- A person cancelling the browser's passkey dialog: the virtual authenticator answers by itself. The sentence
  for it is unit-tested by the refusal's name.
- A passkey challenge older than four minutes, which the invitation page asks for again before it makes the
  passkey. The page has no clock a test can move.
- What a password manager does with the forms. They carry `autocomplete` values, a hidden field with the
  person's name, the lengths a new password may have (`passwordrules`) and, on the token, `data-1p-ignore`;
  nothing checks that a manager reads them. The mark 1Password leaves on a field it filled
  (`data-com-onepassword-filled`) is put there by the test, not by 1Password: no test runs the extension.

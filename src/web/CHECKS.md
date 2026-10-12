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

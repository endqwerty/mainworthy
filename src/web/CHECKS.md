# Builder 1 checks

Before implementing the UI, these are the checks that decide this subtask.

- Shell: TypeScript and Bun compile; real Chromium loads a real server. Navigation to Suite, Case, Queue, Runs, Changes and Settings, command palette, help and theme work without document navigation. The shell contract is accurate before `.shell-ready` exists.
- J1: Capture a title with #checkout, six steps and three expected results, including a three-line paste. Escape seals exactly version 1 with the six steps and tag in the server. No dialogs, no page loads, no console errors. Count non-text keys.
- The lead's final layout correction: `c` focuses the document title, the list row mirrors it, the folder tree exists only in Suite, and `[` collapses the sidebar while keeping navigation accessible. The document-focus assertion failed before correcting capture.
- L1: On 2,000 and 10,000 seeded cases, 30 trusted key samples measure capture focus and step paint on the next animation frame. p95 must be at most 100 ms. Scroll 5,000 rows and check populated frames. CASEBOOK_SKIP_10K skips only the large benchmark.
- L2: Reload an unfinished draft. The text and selection return synchronously. The server may seal the same body on visibilitychange, as required by the brief.
- Conflict: Change the same field through the page and API. Both bodies remain visible, the server retains the intervening version, and a merge decision creates the next version.
- Custom fields: JSON reads currently omit them. Editing only the fields this pane owns must leave custom fields intact in the server's canonical Markdown; this regression failed before excluding custom fields from ordinary edit payloads.
- Sign-in: Server mode rejects a wrong token and accepts the owner token; local mode needs no login.
- UI-3: Capture from `/suite/c/1` creates C-2 at v1 and leaves C-1's title, step and v1 intact. The regression failed before restricting the route effect to route changes and clearing the old case URL for a new draft.
- UI-4: Revoke a scoped writer token, then seal a draft or report a note. Both real 401 regressions failed before API refusals reopened sign-in. Signing back in restores the exact text and a retry is checked on the server, without a page load.
- With the lead's ownership handoff, triage and execution's revoked-token tests now also check sign-in recovery: no decision or result is recorded, the question and missing slot return, and the per-slot device note returns to its field. Their existing network-failure tests are unchanged.
- UI-5: With proposal requests delayed by 500 ms, tag and immediately undo once. The regression failed before making the inverse available with its pending request. Tag, move and archive now undo after the original write is adopted; repeated undo while queued sends no extra inverse. All are checked against the server and retained placement history, with the body still at v1.
- Step identity: the earlier timeout waited for read mode while the seal acknowledgement was still in flight. Delay the real proposal reply by 500 ms, prove the server head advances while the pane still says Draft, then wait for the acknowledged version and draft removal before reloading.
- Formatting and architecture: `bunx tsc --noEmit`, Biome on owned files, `bun test test/architecture.test.ts`, and `bun test test/e2e`.
- Screenshots: inspect Suite and Case with a diff at 1440 by 900, light and dark. Builder 2 supplies its four screens.

The lead owns commits, publishing and independent cross-provider verification of the combined revision. This builder runs the real-page checks and reports evidence without changing git state.

Closeout after UI-3, UI-4, UI-5 and the acknowledgement-wait correction: `bun run typecheck` passed; Biome checked 50 files with no fixes; architecture passed 12 tests. `bun test test/e2e`: **41 pass, 0 fail, 274 expectations, 81.44 seconds**. Capture, sign-in and placement passed 15 targeted tests; the two adjusted triage/execution session tests also passed independently.

The final full-run L1 estimates (30 events per path, event to next animation frame) were: 2,000 cases, capture p50/p95 10.6/14.4 ms and typing 14.8/15.1 ms; 10,000 cases, capture 10.7/14.6 ms and typing 15.0/15.2 ms. J1 used eight control keys beyond text; D2 used 20 answers plus three navigation keys; J5 used 11 controls plus 12 note characters. These are local Chromium frame opportunities, not a hardware display guarantee or a comparative speedup.

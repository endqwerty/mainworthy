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
- Formatting and architecture: `bunx tsc --noEmit`, Biome on owned files, `bun test test/architecture.test.ts`, and `bun test test/e2e`.
- Screenshots: inspect Suite and Case with a diff at 1440 by 900, light and dark. Builder 2 supplies its four screens.

The lead owns commits, publishing and independent cross-provider verification of the combined revision. This builder runs the real-page checks and reports evidence without changing git state.

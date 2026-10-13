# Mainworthy UI independent execution review

Revision: `25d5571300b6853774a320cc7a03ccd34367feca`, branch `t3/mvp-product-delivery`.

Reviewer: GPT-6 Astra through Codex. This is an independent execution/review session, but the authors and reviewer use the same provider. It does not satisfy the repository's different-provider delivery gate.

Status: Review complete.

## Fact to prove

After the UI settles, it agrees with the server. Every optimistic write is recorded or visibly rolled back with input retained. Keys act on the displayed object. Reload, failures and concurrent producers do not lose typed input.

**Disproven on this revision.** New-case keys can modify an existing case (UI-3), run notes can be lost on reload or overlapping failures (UI-1/UI-2), and an early Undo is dropped (UI-5). Clipped proposal evidence with active decision keys also fails the required layout gate (UI-6).

## Method and evidence

- Judged a clean `git archive 25d5571` export with `bun install --frozen-lockfile`, Bun 1.4.3 and `/usr/bin/chromium` 152.0.7977.82. All browser interaction used real headless Chromium against production-mode Bun servers on 127.0.0.1:7600–7649.
- Only six exported test-helper/test files differ: port substitutions and Chromium launch flags `--headless=new --ozone-platform=headless`. Test assertions and all application sources are unchanged. [Exact environment patch](test-environment.patch); [comparison of all 464 archived files](integrity.json). The shared repository checkout was not modified.
- Author tests were executed here, not accepted from author logs. Independent probes seed through the real API, drive browser keys, then compare the displayed state with server reads; queue undo also checks the local SQLite ledger. Failed HTTP envelopes and request delays are injected at the browser; the outage checks stop the actual server.
- The 24 main-screen screenshots cover Suite, Case, Queue, Runs, Changes and Settings in light/dark at 1280×800 and 1440×900. All were visually inspected; text is legible. [Screenshot manifest](screenshots/manifest.json). Two additional proposal screenshots demonstrate UI-6; their clipping was confirmed against the pane bounds, not just the browser viewport.
- Early scratch runs marked INCOMPLETE include probe mistakes (locators, fixture deduplication and waits). The check table names the successful/reproduced evidence logs. The four full/isolated deleted-step test failures are retained and explained in the test audit.
- Fixtures stopped their servers/browsers and removed data. The isolated Bun test timeout left one data directory, a port reservation and Chromium temporary directories; these owned remnants were identified and removed. [Cleanup record](cleanup.json). No other verifier ports or data were touched.
- Final audit: no owned server/browser process, no listener on 7600–7649 and no port reservation remained. Exported dependencies are removed at closeout; to reproduce a scratch script, first run `bun install --frozen-lockfile` in `tree/`, then `bun ../<script>.mjs`. Logs, screenshots and exported source are retained here.

## Checks

| # | Check | Verdict | What ran and deciding evidence |
| --- | --- | --- | --- |
| 1 | Authors tests | issues | `bun test test/e2e` ×3: `31 pass`, `1 fail`, `32 tests` each; `deleted step ids remain reserved after sealing and reloading` timed out at 30000 ms every run and in isolation. No intermittent pass/fail observed. `bunx tsc --noEmit`: exit 0; `bunx biome check src/web test/e2e`: `Checked 50 files in 55ms. No fixes applied.` Architecture: `12 pass, 0 fail`. [Per-test audit](TEST-AUDIT.md), [run 1](logs/e2e-1.log), [run 2](logs/e2e-2.log), [run 3](logs/e2e-3.log), [static checks](logs/biome.log), [architecture](logs/architecture.log). |
| 2 | Capture | issues | J1 with all API requests delayed 500 ms: `keys:135`, six steps, three expected results, `tags:[checkout]`, exactly v1 on leaving; caret focused at the next rAF, list input mirrored title, no server case before leaving. Reload/closed-tab recovery kept Mid-word; Ctrl+Enter sealed one version. Idle seal: `elapsed:30033, versions:1`; pasted three steps; unchanged editor added none. [Capture](logs/capture-recovery.log), [idle](logs/journeys-a.log). UI-3: capture from a saved case URL instead changed C-1 twice. |
| 3 | Editing and versions | pass | Step edit yielded v2 and z/v step diff; u restored v3 with three immutable versions. With a delayed v2 read, observed v2 badge always paired with row H~ and detail ~: `bad:[]`. Two actual tabs preserved disjoint edits at v3 and displayed both competing titles on conflict. Agent proposal/adoption preserved the human draft; resolution created v3. [Edit/restore](logs/editing-retry.log), [proof pairs](logs/probe-proof-case-final.log), [two tabs, both error collectors](logs/two-tabs-final.log), [agent/concurrent draft](logs/agent-complete.log). |
| 4 | Queue | pass | 500 ms delayed writes: `keys:20, unique:20, serverOpen:0, answerSetsMatched:20`. Double u left reopened row visible; re-answer after undo, failure and conflict stayed closed. Ledger kept original/withdrawal/replacement; accepted v2 by verifier-agent. Bulk and the one-failed-run-request/read regression passed all three author runs. Advice UI left `state:open, decision:null`; forbidden answer stayed open. [Queue](logs/queue-complete.log), [advice/conflict](logs/agent-complete.log), [all answer keys](logs/keyboard-coverage-final.log). Multiple failed run notes are UI-2, under checks 5/10. |
| 5 | Running a suite | issues | Folder/tag/text planning each selected C-1,C-2 with commit abcdef1234567. Ten fast results under 500 ms delay: 7 pass, fail+note, blocked, skip; 24 keys. `2 f` stored `atStep:a2`; next case reused pre-rendered node. Controls/note y=621.6..700.6 at 1280×800. UI/server tally matched (7 pass, 1 unexplained, 2 missing, 2 skipped; blocked); u appended result 11 correcting 10. Pipeline/agent fills remained unchanged in all three author runs. UI-1/UI-2 lose notes. [Run evidence](logs/journeys-b-final.log), [planner](logs/keyboard-final.log). |
| 6 | Changes and Settings | pass | Policy proposal P-2 accepted by robin; token absent from localStorage/sessionStorage/document.cookie and secret count 0 after dismissal/reload. Scoped human session: instance can=[], scratch can=[read,produce]; p recorded a result. Other project returned 403; revocation returned 401. Rapid changes: `observations:17,bad:[]` against distinct real gate reasons; open/settled questions and impact/uncovered paths displayed. [Session/settings](logs/sessions-settings.log), [changes](logs/visuals-changes.log). |
| 7 | Sign-in and session | issues | Local loopback: `loginRequired:false,cookies:0`. Server sign-in rejected wrong token; valid cookie `httpOnly:true,sameSite:Strict,jsCanRead:false`. Second project created and switched in each author run. Refused live session: `app:1,signin:0`; only reload shows sign-in (UI-4, non-blocking). [Session](logs/sessions-settings.log), [second refusal](logs/errors.log). |
| 8 | Keyboard, layout and themes | issues | Suite/Case, Queue, Runs, Changes and Settings action families exercised; all applicable answer keys recorded their intended answers (21 additional keyboard scenarios). Palette case/command lookup and plain-input suppression passed. 24 main screenshots visually inspected in both themes/sizes; text legible, run/queue controls fit. UI-6: six-step Case proposal diff starts y=797.9, buttons end y=794.6, pane ends y=772, while a/r commit. UI-3/UI-5 also break key guarantees. [Keyboard](logs/keyboard-final.log), [answer/navigation keys](logs/keyboard-coverage-final.log), [aliases, all numeric digits, peek/zoom](logs/keyboard-aliases.log), [clipping](logs/probe-proof-case-final.log). |
| 9 | Speed | pass | 10,000 real cases, 200 keydown samples each for j/k/c/typing; 0 incorrect work samples and 0 captured errors. Second-rAF paint-opportunity p95: j 32.5 ms, k 32.5 ms, c 27.5 ms, typing 32.8 ms, all under 100 ms. All 200 typed characters reached server. Measurement on a shared machine, not a physical-display guarantee; full p50/p95 table below. [Log](logs/latency.log), [raw samples](latency-raw.json). |
| 10 | Errors | issues | Successful monitored journeys: `errors:[]`. Actual server stop midway through case/run note typing preserved `First half second half` in the open tab and showed `Failed to fetch`; case draft was on device, run note was not. Expected Chromium connection-refused/stream-disconnection console errors occurred during outage; helper excludes expected 401 resource errors. No uncaught application exception observed. Reload/concurrent-failure retention fails UI-1/UI-2. [Outages](logs/errors.log), [note losses](logs/journeys-b-final.log). |

## Latency measurements

Measured by [latency.mjs](latency.mjs) with 10,000 server cases loaded in Chromium. Each action has 200 samples; timing starts at capturing keydown. The first rAF checks the intended DOM/focus state; the second rAF is a conservative next-paint-opportunity proxy. Headless Chromium does not expose a physical display presentation time.

| Action | Samples | First rAF p50 / p95 (ms) | Second rAF p50 / p95 (ms) |
| --- | ---: | ---: | ---: |
| j, next case | 200 | 15.7 / 15.9 | 32.3 / 32.5 |
| k, previous case | 200 | 15.7 / 15.9 | 32.3 / 32.5 |
| c, focused capture caret | 200 | 10.5 / 11.1 | 27.1 / 27.5 |
| Character in step editor | 200 | 16.4 / 16.5 | 32.7 / 32.8 |

Shared host: Intel Core i7-10700K, 16 logical CPUs, initial load averages 3.71/3.00/3.07, final 3.67/3.09/3.09. Production server, default 1440×900 page. No comparative speedup is claimed. No lost/incorrect action was excluded from the measurements; none occurred. A separate CPU profile was taken after timing. The near-frame-period results include frame scheduling; the minified profile does not identify a proven application bottleneck.

## Defects

### UI-3: New case on a case URL edits the existing case instead

Blocks: yes.

Reproduced twice. Open `/p/scratch/suite/c/1` for a saved case, press `c`, type `New case`, Enter, `New step`, Escape. The new draft is replaced by C-1 during the route/selection effect. The server still contains one case; its existing step becomes `New stepOriginal step` and its version advances to 2. The existing title becomes `Original casew case`; part of the new title is lost and its remaining keys alter C-1. Run `bun ../probe-capture-route.mjs` from `tree/`. [Deciding log](logs/probe-capture-route.log), [screenshot](screenshots/capture-route-1.png). The route effect in src/web/suite/index.tsx resets selection whenever it differs from route.ref, including the null selection created for a new case. This violates capture and the promise that keys never apply to an object other than the new case shown.

### UI-2: Two failed result requests overwrite the first failure note

Blocks: yes.

Reproduced twice. In a three-slot run, delay failing writes by 700 ms and fail reads too. Press `f`, type `First failed note`, Enter; immediately press `f`, type `Second failed note`, Enter. When both failures settle, both slots are missing on the server, but only the second note remains in the UI and neither note is in device storage. Selecting the first slot cannot recover its text. The first rollback uses the same note state as the second rollback. Selecting C-1 leaves `firstSlotNote:""`; both attempts returned `writes:2,currentNote:"Second failed note",firstSlotNote:""`. Run `bun ../journeys-b.mjs` from `tree/`; [deciding log](logs/journeys-b-final.log). This violates visible rollback with every person's input kept and the repeated-keys/failure requirement. The supplied one-failure regression test does not cover concurrent failures.

### UI-1: Reload discards an unrecorded run failure note

Blocks: yes.

Reproduced twice against separate real servers. Open a run with an empty slot, press `f`, type `Unsaved failure detail 1`, then reload before Enter. The note field becomes empty and the server has zero results for the slot. [Probe](journeys-b.mjs), [deciding log](logs/journeys-b-final.log): `before:"Unsaved failure detail 1", after:"", recorded:0`, repeated with suffix 2. The result note only lives in React state in src/web/runs/cockpit.tsx. This contradicts the brief's fact that nothing typed is lost on reload.

### UI-5: Undo during a pending tag write is dropped

Blocks: yes.

Reproduced twice with a real server and 500 ms delay on propose requests. Open C-1 at v1, press `t`, type `earlyundo`, Enter, immediately `u`. The optimistic tag is visible and Undo is advertised, but after the request settles the server still has `earlyundo`. Pressing `u` again after settlement removes it. [Probe](probe-early-undo.mjs); [deciding lines](logs/probe-early-undo.log) are `afterEarlyUndo:["earlyundo"], afterLateUndo:[]` twice. The inverse is assigned only after awaiting call in src/web/suite/index.tsx placement, so undoLast sees no inverse while the write is pending. This contradicts no lost key presses and input that need not wait for a server response.

### UI-6: Case proposal keys act on clipped evidence and buttons

Blocks: yes.

Reproduced with two ordinary six-step cases at 1280×800. Open a case with an agent proposal and do not scroll. The proposal diff is below the case pane edge and Accept/Reject buttons are clipped by it, yet `a` adopts the first proposal and `r` rejects the second. Both real decisions reach the server. [Probe](probe-proof-case.mjs), [deciding bounds](logs/probe-proof-case-final.log), [before a](screenshots/proposal-before-key-1.png), [before r](screenshots/proposal-before-key-2.png). Both screenshots were visually inspected: the diff starts at y=797.9 and the buttons occupy y=766.6..794.6, while the pane ends at y=772. This violates decision 0011’s explicit requirement that nothing a key acts on, including answer buttons and evidence, is clipped at 1280×800. The proposal actions are bound whenever the case has a ref, regardless of visibility.

### UI-4: A refused session leaves the signed-in app open

Blocks: no.

Confirmed in [sessions-settings.mjs](sessions-settings.mjs) and [errors.mjs](errors.mjs) with two different scoped human tokens. Revoke the token through the owner API, then submit a result correction or seal a new case. The server returns 401 and refuses the write; the page still has #app and no #token after the error settles. The status says a token is required, but there is no sign-in form until the user reloads. This fails check 7's return-to-sign-in behavior. The authorization boundary holds, so this is a non-blocking recovery defect, not an access-control bypass.

## The tests do not prove this

- [TEST-AUDIT.md](TEST-AUDIT.md) assesses every one of the 32 tests, with deciding assertions and the limits of each.
- The consistently failing deleted-step test waits for a read-mode title button after reloading before the save acknowledgement. The restored draft uses a textarea. [Targeted probe](logs/probe-step-race-final.log) reproduced this twice: `readButtons:0,editors:1`; a retry settled at v2, then the next replacement was `id:a2` at v3. The original a0 and deleted a1 remained reserved. This is a test wait/locator assumption, not a reproduced ID-reuse defect.
- The author latency tests use 30 samples and omit j/k timing. D2 and ordinary J5 pass keys wait for writes to finish. Independent 200-sample and delayed-burst probes cover the requested measurements and fast-key behavior.
- Passing tests omit the five blockers: capture from an existing case URL, reload of a run note, overlapping failed notes, Undo before a placement acknowledgement, and Case proposal actions below the pane edge. The single-failure rollback regression alone cannot prove all input is retained.
- Other overclaims: failed-seal retry never compares command IDs; proof test checks final state rather than intermediate pairs; scoped-token test never attempts another project; shell test does not drive every advertised action or inspect both themes. Independent checks supplement these, as identified above.

## Worth doing later

None recorded.

## Not checked

- Physical display/compositor presentation time; reported latency uses explicit rAF proxies in headless Chromium.
- Non-Chromium browsers, mobile layouts, screen-reader accessibility and IME input (outside the supplied UI direction’s tested scope).
- The engine’s general correctness, migration behavior and non-UI surfaces; these belong to the separate verifier. No engine defect was needed to reproduce these findings.

ISSUES (5 blockers)

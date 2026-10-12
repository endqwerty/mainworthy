# Casebook web UI round 2 re-check

Revision: `f1a2a2404153513892d0981035085a1acb250a17`, branch `t3/mvp-product-delivery`.

Reviewer: GPT-6 Astra through Codex. This is an independent execution session, not a claim that this session satisfies the repository's different-provider delivery gate. No other agents were started.

The six original reproductions are repaired. Adjacent checks found four blockers: two ways to lose new run-note text, recovery of another person's private input, and a tall-proposal exception to the brief's visibility requirement. Browser Back/Forward also requires a reload to recover a new draft, without losing its stored text.

## Method

Judged a clean `git archive` of the exact revision, with `bun install --frozen-lockfile`, Bun 1.4.3 and system Chromium using `--headless=new --ozone-platform=headless`. All application code remained unchanged. Six exported test files have only port/Chromium environment changes, documented in [test-environment.patch](test-environment.patch). [Integrity comparison](integrity.json) checked 468 archived files. All servers used ports 7850–7899 and all database/browser temporary data used `/tmp/casebook-ui-r2a`.

Checks ran against real local application servers. Independent probes seed through the API, drive Chromium, and compare the UI with server reads. Browser request delays or failure envelopes provide reproducible pending/failure cases. The report was updated as results arrived; [progress record](REPORT-progress.md) retains the earlier entries. No git state or repository file was changed.

The safety fact is that keys act on the displayed object, optimistic writes reconcile with the server, and typed input remains available through reload and failed requests without crossing its intended scope. The new findings disprove this fact on this revision.

## Round-1 findings

| Finding | Status | What ran and deciding evidence |
| --- | --- | --- |
| UI-1: reload lost an unrecorded run note | **fixed with a new problem** | Original `journeys-b.mjs` reproduction twice: `before:"Unsaved failure detail 1",after:"Unsaved failure detail 1",recorded:0`, also suffix 2. [Original note log](logs/original-notes.log). Separate slot/run/project scope checks pass twice. Cross-tab and pending-acknowledgement loss are R2-1/R2-4. |
| UI-2: overlapping failed results lost the first note | **fixed with a new problem** | Original reproduction twice, including failed reads: `writes:2,currentNote:"Second failed note",firstSlotNote:"First failed note"`; storage retains both notes, all server fills remain 0. [Original note log](logs/original-notes.log). The new store still loses notes in R2-1/R2-4. |
| UI-3: c from a case URL edited that case | **fixed with a new problem** | Exact original reproduction twice: `count:2,existingTitle:"Original case",existingVersion:1`, new title/step correct. [Original capture log](logs/original-capture.log). List capture and an existing edited draft pass twice. Back/Forward preserves storage but hides the draft until reload, a non-blocking problem described below. [Adjacent capture](logs/capture-adjacent.log), [history check](logs/capture-back.log). |
| UI-4: refused session left the app open | **fixed with a new problem** | Two real-token revocation checks on each of case draft and run note: `signin:true,serverVersion:1,results:0`. Sign-in appears without a document reload. Local mode works with `signin:0,cookies:0`. Another person's recovery is R2-2. [Session log](logs/auth-adjacent.log). |
| UI-5: early undo was dropped | **fixed** | Original probe twice, then corrected its pre-settlement observation: its 900 ms wait is shorter than original+inverse delays of 500+500 ms. At settlement, all 12 tag/move/archive × one/three u keys × success/failure combinations pass. Success sends exactly 2 writes, failure 1. Final `tags:[],folder:Original,state:active,version:1`; successful inverses remain in the timeline. [Matrix](logs/placement-adjacent.log). |
| UI-6: proposal keys acted below the pane | **fixed with a new problem** | Six-step, title-only original scenario: first a/r leaves question open and reveals whole card, second answers; both keys at 1280×800 and 1440×900, matrix repeated twice. Already-visible small cards answer on first key; two-proposal cases answer one and leave the other open. Tall-card rule is R2-3. [Matrix](logs/proposal-adjacent.log), [repeat](logs/proposal-adjacent-repeat.log). |

The copied old probes include legacy automatic finding predicates. Their console `legacy-detector-needs-reassessment` lines are not current verdicts: UI-2's old predicate checked only the second note; UI-5 checked too early. Current conclusions use both notes, server state, and settled inverse writes.

## New findings

### R2-2: Recovery exposes a previous person's private draft and note to the next person

Blocks: yes.

Smallest reproduction: sign in as Alice using a scoped human token, edit C-1's step to `Alice private unfinished sentence`, revoke Alice, and Escape. The real write returns 401 and sign-in appears. Sign in as Bob, a separate scoped human actor. Alice's exact text is restored into Bob's editor with no ownership warning. Ctrl+Enter records it as Bob. The same sequence with f, `Alice unrecorded failure detail`, Enter restores Alice's run note to Bob, and f/Enter records it with `by:"bob"`.

[auth-adjacent.mjs](auth-adjacent.mjs) repeats both surfaces twice; [log](logs/auth-adjacent.log) records `restored:"Alice private unfinished sentence",identity:"H\nbob"` and server v2 `by:"bob"`, plus the equivalent run fill. Neither refused write reached the server. Draft keys and run-note keys identify the project/case/run, not the person. This violates the expected privacy and ownership of unrecorded input during the brief's different-person sign-in check. It does not show that Bob can read a project his token cannot access.

### R2-1: Two tabs overwrite each other's unrecorded notes

Blocks: yes.

Open two tabs on the same two-slot run. Both load the existing notes. In tab A update C-1's note to `Tab A new first-slot note`; in tab B update C-2's note to `Tab B new second-slot note`. Reload A. Its note reverts to the older `First slot private note`. No result recorded the newer text.

[notes-adjacent.mjs](notes-adjacent.mjs), [log](logs/notes-adjacent.log), reproduced twice: `before:"Tab A new first-slot note",after:"First slot private note"`. Each tab writes its stale whole-run object to the same localStorage key. Updating a different slot silently overwrites the other tab's text. This contradicts retention through reload and the requested two-tab check. In a single tab, slot/run/project isolation passes twice.

### R2-4: A result acknowledgement deletes a newer unsubmitted note

Blocks: yes.

In a one-slot run, hold the report request. Press f, type `Submitted first note`, Enter. Before that request finishes, press f and replace the note with `New unsubmitted second note`. Release the first request. The acknowledgement clears the slot's current text and stored note even though it only recorded the earlier text.

[notes-pending.mjs](notes-pending.mjs), [log](logs/notes-pending.log), reproduced twice: `before:"New unsubmitted second note",after:"",stored:{},serverNote:"Submitted first note",requests:1`. The successful-report path calls `setNoteOf(slot.id, "")` without checking whether the note changed after submission. This violates retention during pending requests. Ordinary recording clears its own note correctly in all three executions of the author's combined note regression.

### R2-3: A tall proposal answers when only its end is visible

Blocks: yes, against the supplied whole-proposal visibility requirement.

Propose 35 changed steps on a six-step case. Open it at 1280×800 or 1440×900. The first a/r reveals the beginning and leaves it open; another key at that position still leaves it open. Scroll directly to the card's end and press a/r. The decision records although its header and most of its evidence are outside the pane.

[proposal-adjacent.mjs](proposal-adjacent.mjs), both matrix logs, and [1280 accept screenshot](screenshots/tall-proposal-1280-a.png). At 1280×800: card `top:-1460.375,bottom:768`, pane `0..772`, `whole:false`, final state `decided`. At 1440×900: `top:-1360.375,bottom:868`, pane `0..872`. Both accept and reject behave this way. The buttons remain visible because their CSS is sticky; this is **not** a clipped-button finding.

`proposalInView` explicitly allows a tall card when its bottom is visible. That is a scroll-to-end policy rather than the brief's requirement that the whole proposal be on screen when a key answers. If scroll-to-end is the intended product rule, the requirement and report gate need that explicit exception. The current implementation does not meet the rule this review was asked to judge.

## Non-blocking recovery issue

UI-3's Back/Forward path hides an unfinished new case until reload. From `/suite/c/1`, c, type title and a step, Back, Forward. The Suite has no draft editor or draft row. Reload that Suite URL and both return. [capture-back.mjs](capture-back.mjs), [log](logs/capture-back.log), twice: `forward:[],visibleDraft:false,afterReload:["Back navigation draft","Back navigation step"]`. The original case remains v1 and the text remains in localStorage, so this is recovery friction rather than lost stored input.

## Other checks

- `bun test test/e2e` ran three times: each `42 pass`, `0 fail`, `281 expect() calls`. Times 85.44 s, 91.30 s, 82.50 s. [Run 1](logs/e2e-1.log), [run 2](logs/e2e-2.log), [run 3](logs/e2e-3.log). No failing/flaky test on the judged revision. The deleted-step test passes all three.
- `bunx tsc --noEmit`: exit 0, [log](logs/tsc.log). `bunx biome check src/web test/e2e`: `Checked 50 files in 41ms. No fixes applied.`, [log](logs/biome.log). Both ran before environment-only test patching.
- All six new regression targets fail with their corresponding behavior deliberately disabled in a separate scratch copy. [Test audit](TEST-AUDIT.md) gives exact mutations, deciding failures and coverage limits. These intentional failures are not flakes on the judged revision.
- Scoped session: instance `can:[]`, scratch project `can:[read,produce]`, only scratch listed despite another project existing. The enabled Pass control records as scoped-writer. Queue a/r still each decide on their first key. [Capability/Queue log](logs/capabilities-queue.log).
- Rapid changes view switching compares displayed header/verdict/reason with real server replies; no mismatched pair. The copied ten-result run probe also retains its fast result sequence, pinned version/step, server tally and correction. [Visual/changes log](logs/visuals-changes.log), [run probe](logs/original-notes.log).
- All 12 screenshots of Suite, Case, Queue, Runs, Changes and Settings at 1280×800 in both themes were opened and inspected. Text and controls remain legible; Queue answers and run controls fit; no unexpected horizontal overflow. [Manifest](screenshots/manifest.json). The tall-proposal screenshots were also inspected. No additional visual defect found.

## Limits and reproducibility

No general engine, migration, deployment or non-UI review; no mobile, non-Chromium, screen-reader, IME, or physical-display timing checks. No claim of exhaustive concurrency testing. Scoped capabilities were checked for one-project writer behavior, not every possible role matrix. The view check covers the six requested screens, not every subpanel. I did not independently rerun the entire broader round-1 journey catalog because this is the bounded six-finding re-check.

To reproduce, install dependencies in `tree/` with `bun install --frozen-lockfile`, create an owned `/tmp/casebook-ui-r2a` directory, then run `TMPDIR=/tmp/casebook-ui-r2a bun ../<probe>.mjs` from `tree/`. Set `RECHECK_NO_REPORT=1` to avoid appending to this report. The exported test helper confines servers to ports 7850–7899. [Environment patch](test-environment.patch), [mutation driver](mutation-audit.py), and all logs are retained. Final cleanup: no owned server/browser process and no listener on ports 7850–7899 remains. Removed all owned `/tmp` data, exported dependencies and test artifacts. The shared worktree was untouched. [Cleanup record](cleanup.json).

ISSUES (4 blockers)

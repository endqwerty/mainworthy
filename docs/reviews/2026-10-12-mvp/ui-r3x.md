# Mainworthy UI review, round 3

Revision: `b11d2307959bd1ea7f5edea6351cd5cc7bbf077f`, branch `t3/mvp-product-delivery`.

Reviewer: GPT-6 Astra through Codex, independently checking the Claude-written fixes and their integration. No agents were started. All checks ran locally against the exact exported revision.

The five original reproductions are repaired. Two adjacent person-change paths still let Alice's private input be recorded as Bob. One also deletes Bob's stored draft. These block approval. The note retention and proposal visibility checks pass.

The correctness promise under review is that device input stays with its person and slot, an acknowledgement does not erase newer input, and a proposal shortcut answers only the fully visible card after the diff's end is showing. The two findings below disprove the person-ownership part.

## Round-2 findings

| Finding | Status | What ran and deciding lines |
| --- | --- | --- |
| R2-1: tabs overwrite independent slot notes | **fixed** | [notes-adjacent.mjs](notes-adjacent.mjs), twice. Both print `before:"Tab A new first-slot note",after:"Tab A new first-slot note"`; the other slot retains `Tab B new second-slot note`. Slot, run, and project isolation each print `true`. [Log](logs/notes-adjacent.log). |
| R2-2: the next person sees the prior person's drafts and notes | **fixed with a new problem** | [auth-adjacent.mjs](auth-adjacent.mjs), twice on each surface. After Alice is refused, Bob has `restored:0` case editors and `restored:""` run note, with `serverVersion:1,results:0`. Single-page alternating-person and same-person checks also pass. Pending replies and another open tab remain unsafe, R3-1 and R3-2 below. [Original log](logs/auth-adjacent.log). |
| R2-3: a tall proposal answers with only its end visible | **fixed** | [proposal-matrix.mjs](proposal-matrix.mjs) repeats the old tall-card key/outer-scroll sequence twice for a/r at both sizes. It leaves the question `state:"open"` while the inner diff has more below. Across all 40 matrix cases, the deciding key has `whole:true,atEnd:true`, with both buttons visible. [Log](logs/proposal-matrix.log). |
| R2-4: an acknowledgement deletes a newer note | **fixed** | [notes-pending.mjs](notes-pending.mjs), twice. Both print `before:"New unsubmitted second note",after:"New unsubmitted second note",serverNote:"Submitted first note",requests:1`; storage retains the newer text. [Log](logs/notes-pending.log). |
| Back/Forward hides an unfinished new case | **fixed** | [capture-back.mjs](capture-back.mjs), twice. Both print `forward:["Back navigation draft","Back navigation step"],visibleDraft:true`, with the same values after reload. [Log](logs/capture-back.log). |

## New findings

### R3-1: A pending draft reply continues under the next person's identity

Blocks: yes. This is an integration failure of the per-person storage fix.

Run [pending-person.mjs](pending-person.mjs). It reproduces twice with real scoped Alice and Bob tokens, a real token revocation and 401, and a delayed successful response from the real server.

1. As Alice, edit C-1 to `Alice submitted text` and press Ctrl+Enter. Delay delivery of the successful response.
2. While it is pending, change the step to `Alice newer private unsubmitted text`.
3. Revoke Alice's token. Click Runs and sign in as Bob after the real request is refused.
4. Open C-1 and type `Bob private unsubmitted text`, without submitting it.
5. Deliver Alice's delayed response.

The old editor resumes under Bob's session. It publishes Alice's newer text as Bob, and removes Bob's stored draft. Both repeats in [the log](logs/pending-person.log) show:

```text
beforeStore:
  mainworthy:alice:draft:scratch:C-1 = ["Alice newer private unsubmitted text"]
  mainworthy:bob:draft:scratch:C-1 = ["Bob private unsubmitted text"]
after storage:
  mainworthy:alice:draft:scratch:C-1 = ["Alice newer private unsubmitted text"]
timeline: [{version:3,by:"bob"},{version:2,by:"alice"},{version:1,by:"daniel"}]
server step: "Alice newer private unsubmitted text"
```

Bob's mounted editor keeps its in-memory text. An ordinary reload writes it back during pagehide, so this finding does not claim that every reload loses that text. The wrong-person publication and deletion of Bob's stored copy are directly observed.

The relevant code is [device.ts](tree/src/web/lib/device.ts), [drafts.ts](tree/src/web/lib/drafts.ts), and [SuiteScreen.sealDraft](tree/src/web/suite/index.tsx). `deviceKey()` reads a mutable global person. After its awaits, the old `sealDraft()` calls `removeDraft` and `writeDraft` using the new person, at lines 392 and 429. Its pending/unmount paths can call `sealDraft()` again, at lines 236 and 494. Those fresh requests use Bob's current browser cookie. Query-cache clearing does not cancel these promises.

This contradicts the promise that the prior person's private input cannot be recorded as the next person's, and the requirement for correct authorship. Bind queued work and device cleanup to the originating person; old work must not continue under a replacement session.

### R3-2: Another open tab keeps the previous person's input and records it as the new person

Blocks: yes. This has no delayed request or pending acknowledgement.

Run [identity-tabs.mjs](identity-tabs.mjs). It reproduces twice for an existing-case draft and twice for a run note, including bringing the old tab to the foreground before submitting.

1. Sign in as Alice in tab A and type a private case draft or result note.
2. Open tab B in the same browser context. Revoke Alice, let B receive a real 401, and sign in there as Bob.
3. Return to A. It still shows Alice and Alice's private input.
4. Press Ctrl+Enter for the case or Enter for the run note.

Both case repeats in [the log](logs/identity-tabs.log) show `tabAIdentity:"H\nalice",tabBIdentity:"H\nbob"`, and a new version with `by:"bob"` containing `"Alice private case from tab A"`. Both run repeats record `by:"bob",note:"Alice private note from tab A"`.

[App.refreshSession](tree/src/web/app.tsx) updates the person and clears the cache only in the page that refreshes its session. The other page is not notified that the shared cookie now belongs to someone else. It retains the old session and input, while [call()](tree/src/web/lib/api.ts) sends requests with the new cookie.

This violates the same person-ownership and authorship promise. A change of person must invalidate or re-authenticate other open pages, and an old page must not write under a different person from the one its editor represents. Cancelling pending work alone would not fix this reproduction.

## Adjacent checks

- **Notes:** [notes-matrix.mjs](notes-matrix.mjs) passes with three tabs, two repetitions, independent notes in three slots, and a tab opened after typing. When B records the same slot while A types a correction, A retains `"A is typing a correction"` and focus; the server records `"Recorded in B"`. The four same-slot/other-slot × success/failure cases each retain the newer text through reload and preserve selection and focus. A failed request keeps the original slot's note when the user is editing another slot. [Log](logs/notes-matrix.log).
- **People and recovery:** [auth-matrix.mjs](auth-matrix.mjs) passes Alice/Bob/Alice/Bob/Alice for existing-case drafts, new-case drafts, and run notes. Every transition stays in the same document, `documentLoads:1`, and every person sees only their own input. Ending each cookie session causes a real 401, with no refused write recorded. [Log](logs/auth-matrix.log). Alice/Alice/Bob/Bob/Alice also passes on all three surfaces. [Same-person log](logs/same-person.log). Local mode keeps the owner identity without sign-in, and restores the run note and new-case draft after clearing cookies and reloading: `identity:"H\ndaniel",runNoteRestored:true,newDraftRestored:true`. These passing cases do not involve a pending response or a second still-open page.
- **Proposal keyboard behavior:** The 40-case matrix covers both a/r, 1280x800 and 1440x900, two repetitions, a fitting card, a card below the pane, 35 and 200 changed steps, and two proposals on one case. A capture-phase keydown listener measures the card before the application handles each key. Every deciding key has the whole card and both buttons in the pane and the inner diff at its end. With two proposals, only the selected question is decided; the other stays open. The 200-step cases need 38 presses at 1280x800 and 33 at 1440x900, including reveal and answer. [Log](logs/proposal-matrix.log).
- **Proposal boundaries and mouse:** All 12 cases in [proposal-edges.mjs](proposal-edges.mjs) pass. One remaining text line produces 14 px overflow at 1280x800 or 16 px at 1440x900, against an 18.125 px line height. The first key pages that line without deciding; the second decides. Both mouse buttons answer the intended proposal. A 500-character reason with a long diff also fits and pages correctly. [Log](logs/proposal-edges.log). I opened and inspected [the 1280x800 screenshot](screenshots/tall35-paged.png); the heading, reason, scrollable diff, and answer buttons are together in the pane.
- **Queue:** [capabilities-queue.mjs](capabilities-queue.mjs) confirms that a/r still decide on their first key, with `answer:{is:"accept"}` and `answer:{is:"reject"}`. The same probe confirms a scoped human producer can record in their project. [Log](logs/capabilities-queue.log).

## Requested commands and regression sensitivity

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Exit 0, 117 packages installed. [Log](logs/install.log). |
| `bunx tsc --noEmit` | Exit 0, no diagnostics. [Log](logs/tsc.log). |
| `bunx biome check src/web test/e2e` | Exit 0, `Checked 54 files in 77ms. No fixes applied.` [Log](logs/biome.log). |
| `bun test test/e2e/execution.test.ts` | `7 pass`, `0 fail`, `56 expect() calls`. [Log](logs/e2e-execution.log). |
| `bun test test/e2e/signin.test.ts` | `3 pass`, `0 fail`, `18 expect() calls`. [Log](logs/e2e-signin.log). |
| `bun test test/e2e/agent.test.ts` | `3 pass`, `0 fail`, `34 expect() calls`. [Log](logs/e2e-agent.log). |
| `bun test test/e2e/drafts.test.ts` | `4 pass`, `0 fail`, `16 expect() calls`. [Log](logs/e2e-drafts.log). |

The four browser files ran separately, 17 passing tests and 124 expectations. No whole-suite run and no authored-test failure or port retry on the judged revision.

Every main R2 fix has an authored test that fails when the fix is deliberately removed in a separate scratch copy. [TEST-AUDIT.md](TEST-AUDIT.md) gives each test, exact mutation, and deciding failure. R2-1 expects `"Tab A first-slot note"` and gets empty text; R2-4 independently expects the newer note and gets empty text. The R2-2 run-note test sees the previous person's note; its case test fails less clearly by timing out before its editor-count assertion. The long-proposal test detects both removal of the height cap and bypassing diff paging.

The two sign-in tests still pass with only `queryClient.clear()` removed: `2 pass`, `0 fail`, `15 expect() calls`. They do not independently prove cache clearing, and they do not test R3-1 or R3-2. This is a coverage limit, not another blocker. Intentional mutation failures are not flakes in the judged revision.

## Method, limits, and reproduction

The clean export came from `git archive` of the full revision above. Bun 1.4.3 and `/usr/bin/chromium` ran with `--headless=new --ozone-platform=headless`. All application source is unchanged. [Integrity comparison](integrity.json) checks 407 archive files and finds only the three expected test-environment changes, documented in [test-environment.patch](test-environment.patch): ports 8250 through 8299 and Chromium arguments. Type checking and lint ran before those adaptations. The reviewed source diff is [reviewed-changes.diff](reviewed-changes.diff); the new device module was also read directly.

Original probes are retained in `original-probes/`. Re-checks preserve their actions while changing old bug-expecting assertions and disabling the old report writer. Initial probe mistakes were corrected before judgement: the question reply uses `q`, a shortcut typed into a focused note is text, and an optimistically removed proposal cannot be measured in a later request handler. The final measurements use the actual keydown event and settled server state. None of those probe errors is counted as an application failure.

The [progress report](REPORT-progress.md) preserves results written during the run. All data is artificial. No repository file, branch, commit, or pull request was changed. No production, engine, migration, full browser-suite, non-Chromium, mobile, screen-reader, or pre-fix device-storage migration review was attempted. No claim of exhaustive concurrency coverage. The remaining UI outside the supplied fix scope was not signed off here.

To reproduce, run `bun install --frozen-lockfile` in `tree/`, create `/tmp/mainworthy-ui-r3x`, and run `TMPDIR=/tmp/mainworthy-ui-r3x bun ../<probe>.mjs` from `tree/`. Run each requested browser file separately using the same `TMPDIR`. The mutation copy is recreated by `prepare-mutations.py`; `run-mutations.py` runs its targets and restores each source file afterward.

Cleanup verified: no owned server or browser remains, and no listener remains on ports 8250 through 8299. Removed all `/tmp/mainworthy-ui-r3x` data, exported dependencies, and review test artifacts. Source exports, probes, logs, and reports remain available. The shared repository checkout was never changed or cleaned. [Cleanup record](cleanup.json).

ISSUES (2 blockers)

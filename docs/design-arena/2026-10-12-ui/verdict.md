# Casebook UI arena verdict

Recommend **u3, the document**, as the base, with the grafts below. The totals are **u1 20/30, u2 22/30, u3 22/30**. P0 breaks the tie: u3 retains the accepted proposal, the reversing decision, and a later human edit; u2 deletes accepted history when undoing it. This chooses a design to implement, not an artifact ready to ship. U3's stale proof strip is also a release blocker.

## Revision and method

- Read the common brief, hidden rubric and requested product context before judging the candidates. I ran the checks myself; the candidates' self-tests and other reviewers' verdicts are not my evidence.
- Some candidate files changed during the review. I froze the then-current HTML and rationales at **2026-10-12 05:55:40 UTC** and reran all browser checks against those byte-identical copies. Full hashes and original paths are in [frozen-manifest.json](frozen-manifest.json).
- HTML SHA-256 prefixes: u1 `f67951159bae`, u2 `29c5e5611203`, u3 `246a2ae9f555`. Their original HTML still matched the frozen copies after the replays.
- Used `/usr/bin/chromium`, Chromium 152.0.7977.82, headless, through a Node 26.11.1 DevTools-protocol driver. All job text and shortcuts used trusted `Input.dispatchKeyEvent` events. Clipboard setup used a separate blank tab, followed by real Ctrl+C/Ctrl+V; no synthetic paste event or candidate operation function performed a job.
- Fresh Suite state for each counted job. Inspected DOM focus, resulting case/version data, queue answers, run results and console/network events. Took and inspected all four screens at 1280×800 and 1440×900 in both system themes, 48 screenshots, plus interaction and failure screenshots.
- The scripts, JSON observations and PNGs are in this directory. Main evidence: [jobs.json](jobs.json), [screens.json](screens.json), [probes.json](probes.json), [timing.json](timing.json), [integrity.json](integrity.json), [final-probes.json](final-probes.json), [reproduce.json](reproduce.json). [frozen-runs.json](frozen-runs.json) records the successful reruns.

## Scores

Equal-weight descriptive totals; they do not override the record-integrity floor. Five means excellent on the tested criterion, three means usable with material shortcomings, and one means a serious failure.

| Criterion | u1: outline | u2: workbench | u3: document |
| --- | ---: | ---: | ---: |
| 1. Capture, J1 | 4 | 5 | 5 |
| 2. Density and scale | 3 | 5 | 2 |
| 3. Triage, D2 | 3 | 4 | 3 |
| 4. Run cockpit, J5 | 4 | 3 | 5 |
| 5. Honest state | 2 | 1 | 3 |
| 6. Product quality | 4 | 4 | 4 |
| **Total / 30** | **20** | **22** | **22** |

### 1. Capture

- **u1, 4.** Real `c`, six Enters, three Tabs and the version chord produced six steps, three expectations and the title's `checkout` tag without a dialog or lost caret; typed ` > ` and a real multiline paste also split correctly. However, `Pay #checkout` in a step remained literal text and produced no tag, so inline tagging works only in part of the editor.
- **u2, 5.** The same typed and pasted jobs passed, including a tag inside a step; `c` focused the list-row input synchronously and Enter transferred the caret to the first step. That transfer requires an eye movement into the detail pane, but no extra command or required field interrupted capture.
- **u3, 5.** The same jobs passed with the caret staying in the central document, and tags in either the title or steps entered the sealed version's metadata. Its raw document retains the inline `#checkout` text while also showing a tag chip; this is a presentation choice, not a failed tag operation.

### 2. Density and scale

- **u1, 3.** The initial Suite fits **9 / 11** complete cases with proof strips at **1280 / 1440**; opening the initial case leaves only **1 / 3** complete case-title rows visible. Wheel scrolling through the entire 2,000-case outline kept at most 19 case rows mounted, but expansion displaces the surrounding list substantially.
- **u2, 5.** The default workbench fits **21 / 24** complete case rows, with three producers and ages, while retaining the editor; scrolling kept at most 39 rows mounted. Its 32px rows and fixed regions are the strongest browsing layout, although widening the pane deliberately reduces proof strips to outcome marks and removes their ages.
- **u3, 2.** The Suite fits only **6 / 7** complete cases because each index entry consumes 79px, and the document also spends substantial height above the first step. Windowing works, at most 15 mounted rows during the wheel sweep, but low visible density is a design cost that virtualization cannot solve.

### 3. Triage

- **u1, 3.** Twenty mixed answers took 22 keys with navigation, left ten questions open, and `u` reopened the last one while adding a 21st decision; `j`, `k` and Space preserved the list context. At 1280×800 the initial failure's expected/observed values are below the visible evidence area, and the answer buttons mostly name classifications without explaining their consequences.
- **u2, 4.** Twenty answers also took 22 keys, with the best advance-before-press explanation: each answer card states its consequence, and the prior-answer hint distinguishes a suggestion from an applied decision. Selection and peeking worked, but undo restores the row while discarding its answer history, so the apparent undo contract is false.
- **u3, 3.** Twenty answers took 22 keys; undo added a superseding decision, and peeking and movement stayed in Queue. The evidence is readable, but at 1280×800 the initial answer buttons are partly below the visible pane, and failure buttons do not explain the different gate or carry-forward effects before answering.

### 4. Run cockpit

- **u1, 4.** It opened slot 28, skipped the 25 CI and two agent results, focused the failure note, and completed ten new results with three slots left. Its visible next-case card is useful, but only the first two steps of that four-step next case were rendered in advance, not the complete next document.
- **u2, 3.** It correctly opened slot 3, its first unfilled slot among interspersed producer results, and skipped filled slots through the ten-result job. The next case, C-848, had neither generated steps nor an execution document in the DOM before the first pass, so the required advance rendering is absent.
- **u3, 5.** It opened slot 28, recorded the requested outcomes and note, and advanced to slot 38 with three remaining; the 27 prefilled results stayed unchanged. The complete next document was already present, and I retained a reference to its first step and confirmed that the same DOM node became the current step after `p`.

### 5. Honest state

- **u1, 2.** Draft/current labels, producer names and step diffs work, and explicit, leave and actual idle sealing made versions without duplicate no-change seals. But accepting Q-2, sealing a later human title edit on C-311, then undoing Q-2 removed that later edit from the current case; old snapshots remain, but the reversal changes more than the agent's contribution.
- **u2, 1.** The fixed draft banner and agent-authored proposal card communicate the intended policy well, but accepting Q-17 changed its case from two versions to three and undo reduced it back to two, with no retained answer, while claiming that the withdrawn answer remained in the ledger. Separately, recording `b` on C-311 left its latest-human proof strip showing the earlier `✓ 2d` instead of the new blocked result.
- **u3, 3.** Acceptance and undo kept both decisions and appended versions, preserved a later human title edit, and retained separate agent authorship and human adoption. However, after editing C-311 and sealing v4, the Suite still showed `H ✓ 2d` from v3 until navigating away and back changed it to `H ~ 2d`; I reproduced that stale success twice on the frozen revision.

### 6. Product quality

- **u1, 4.** Light and dark use a coherent warm accent, clear selected-row edge and readable step hierarchy; focus remained visible throughout capture. The oversized header and small proof/key labels weaken its otherwise polished presentation, and a long step still occupies a single-line field.
- **u2, 4.** The compact hierarchy and stable list/editor relationship feel suitable for sustained daily work, and contextual keys are consistently available. Many titles truncate at 1280px, some metadata is faint and small, and the dense timeline needs more visual separation between a draft, a pending proposal and recorded history.
- **u3, 4.** The serif titles, restrained palette and separate expected/observed readouts make the document and evidence easiest to read as a coherent artifact in both themes. Excess vertical padding and offscreen controls prevent a higher score, despite its strongest writing identity.

For the side-by-side judgment, I would choose u3 with the grafts for sustained writing and review; u2 is the better browsing and triage reference. This is a design judgment, not proof of whole-product superiority or F3: both [TestRail](https://support.testrail.com/hc/en-us/articles/14438119644692-Adding-test-cases) and [Qase](https://docs.qase.io/en/articles/5563704-test-cases) already document title-and-Enter quick creation, so none earns credit for supposedly inventing that path.

## Keystrokes I replayed

One printable character is one stroke, including spaces and `#`; a chord is one command stroke. Clipboard preparation, reading the evidence and actually executing the software under test are excluded. These are separate jobs starting on an unfocused Suite, not an uninterrupted chain after J1; leaving a focused editor before a global `g` shortcut costs Escape.

| Job | u1 claimed → my replay of its text | u2 claimed → my replay of its text | u3 claimed → my replay of its text | My identical-text comparison |
| --- | --- | --- | --- | --- |
| J1 | 134 → **134** | 278 → **278** | 198 → **198** | **134 each**, 123 text + 11 commands |
| J5, including `g r` | 25 → **25** | 23 → **23** | 26 → **26** | **25 each**, 12 text + 13 commands |
| D2, including `g q` | 22 → **22** | 22 → **22** | 22 → **22** | **22 each**, 20 answers + 2 navigation keys |

U2 calls J1's tag-introducing space and `#` overhead, yielding 13 overhead plus 265 content strokes; counting those two printable characters as text gives 11 commands plus 267 text strokes. Its total is correct. The different J5 totals come from the different note lengths, not a faster result flow.

The common J1 title was `Apply coupon #checkout`; actions were `Open cart`, `Add item`, `Apply SAVE10`, `Check total`, `Pay by card`, `Check order`; expectations on steps 1, 3 and 6 were `Cart is empty`, `Total is 90`, `Order is placed`. Commands were `c`, title Enter, five separating Enters, three Tabs and Ctrl+Enter. All three finished with one version, six steps, three expectations and the tag.

The separate paste check used `c`, a typed title/tag, Enter, **one real Ctrl+V**, then Ctrl+Enter: four command interactions plus title text. The six-line clipboard mixed `=>`, ` > ` and `Expected:`; all three produced the six intended actions and three expectations. I also typed `Open cart > Cart ready` character by character and verified the delimiter was removed from the action.

The common J5 was `g r`, eight `p`, `f`, `Total is 100`, Enter, `b`. All finished with **8 new human passes, 1 failure with the exact note, 1 blocked result, 3 unfilled slots and a new failure question**; no prefilled CI/agent result changed. The failure note took focus on every candidate. U1/u3 finished on slot 38; u2 finished on slot 33 because its unfilled slots are interspersed.

For D2 I selected answers appropriate to each visible kind, rotating failure answers and accept/reject or link/track. The observed mix was u1 **5 failures / 5 proposals / 5 findings / 5 unlinked**, u2 **9 / 2 / 4 / 5**, u3 **8 / 4 / 4 / 4**. No counted answer was a no-op, no extra focus key was needed, and all left ten open. These minimum submission counts do not measure twenty considered human judgments; changing question kinds still requires reading the type and consequences.

After the counted jobs, `u`, `j`, `k` and two Spaces worked in all three. U1/u3 retained 21 decision records after the twentieth answer was undone; u2 retained only 19 current answers. Navigation `g s/q/r`, `/`, Ctrl+K to C-2000/Q-12/R-4, a palette defect action, `?`, system-theme following and the visible theme toggle all worked in the exercised paths.

## Timing, layout and failures

- Five interleaved fresh-page capture probes per candidate focused the title during the key handler and before its next animation frame, with a new 2,001st case actually present. Event-to-next-rAF median and range were u1 **16.0 ms, 14.8–18.5**, u2 **16.0 ms, 14.9–16.6**, u3 **14.3 ms, 13.7–14.8**.
- These are local paint opportunities, not hardware-to-screen latency or a p95 claim. The 16-core machine was busy, with load about 10 when the frozen timing run began; no CPU/rendering limiter was isolated, so **relative performance is inconclusive** and these small differences did not decide the base.
- Five wheel movements per candidate, ending at the bottom, changed visible row content and kept the DOM bounded. No persistent blank list, page-level horizontal overflow, lost capture caret or unhandled browser/JavaScript error appeared in the tested replays; no candidate made an HTTP(S) resource request.
- All three retained the focused title through a real 31–32 second idle wait, made exactly one version, and made no second version on an unchanged explicit seal. Leaving a draft for Queue also made a version. This verifies the triggers, not durable storage.
- Layout costs were visible: u1 expansion pushes neighboring cases out; u2 title-to-step entry moves the caret between regions; u3's large headers force internal scrolling at 1280px. U1's initial Queue evidence and u3's initial answer controls are clipped by their visible pane boundaries even though the page itself does not overflow horizontally.
- The destructive u2 undo was independently repeated on fresh pages; the u1 later-human-edit reversal and u3 stale proof were each reproduced twice. A missing u3 proof selector in my first probe was a script error, corrected before drawing the stale-proof conclusion. A Chromium-profile deletion race was also a harness cleanup error, not a candidate exception; the frozen reruns completed cleanly.

## A. Base and extension to the remaining screens

Use **u3's document editor, versioned history, narrow proposal application and complete next-document preload**. Keep Suite as home. Its author writes title, actions and expectations in one place; its record behavior gives the strongest starting point for the owner's requirement that agent operations preserve human work. U2's density advantage is substantial, which is why it supplies the main structural graft rather than being discarded.

Extend the central document and its optional evidence/history rail to Change/PR: put the gate verdict and ranked reasons at the top, then blocking questions, reviewed impact and uncovered paths; keep attribution and decisions in the rail. Requirements can use the same searchable index and document, with linked-case proof rows in the body. Policy should use the available body width for the clause table, with the rail closed, rather than inventing another nested outline or forcing a permanent third pane.

First repair u3's seal transition: every adopted version must invalidate the visible proof summaries in the same update that changes the version badge, without replacing the focused editor node. Preserve its later-human-edit-safe undo and test that the accepted agent version and both decisions remain after reversal. A tied total does not excuse u2's deletion of history, nor make u3's stale success acceptable to ship.

## B. Grafts, by source

**From u1, one run-cockpit graft.** Put Pass/Fail/Blocked/Skip in a footer fixed inside the current run document, with the focused failure-note field in that same area. Add u1's visible `Up next` card to the existing right rail, showing the next short ID, pinned version, title and first two action/expectation pairs above the scrollable slot list; retain u3's complete preloaded DOM behind that preview. This makes controls and the next task discoverable at 1280×800 without giving up u3's actual preload.

**From u2, two grafts.**

1. Replace u3's 79px Suite cards with u2's fixed 32px virtual rows: ID, title, small draft/question marks and aligned H/C/A outcome-and-age columns. Let this index use approximately `clamp(480px, 42vw, 600px)` on the tested desktop widths, reduce the document's side padding to 24px, and move repeated folder metadata into the shared breadcrumb/filter; target at least 16 complete proof-bearing rows at 1280×800. Keep u3's title caret in the document and mirror text into the selected row, so the density graft does not introduce u2's title-to-pane eye movement.
2. In Queue, use u2's answer cards with a key, answer name and one sentence stating the effect before pressing. Derive that sentence from the active policy and selected question: scope of an excuse, carry-forward condition, proposed version and authorship, or exact link target; do not copy the mock's hardcoded flaky threshold. Keep the last-answer/undo message in a stable status area, and use u3's real decision ledger underneath it.

Do not transplant u1's whole-snapshot acceptance undo, u2's undo closures, or u2's missing next-case rendering. Preserve u3's central writing layout while reducing its padding; copying its current sparse index unchanged would squander the arena's clearest density finding.

## C. Shared misses and limits

- Every candidate uses a 30-second idle heuristic; silence cannot establish that an interrupted author has finished a thought. Show the transition rule and last shared version plainly, and test interrupted writing before treating this timeout as settled UX.
- None proves durability, save-failure recovery, conflict handling, accessibility or the 10,000-case input budget. Memory-only storage was required by the brief, so lack of persistence is not a scoring penalty; it must not become the real product's save contract.
- The seeded successes establish keyboard mechanics, not correct human decisions, trustworthy live evidence, or a measured win against incumbents. The public-doc comparison above is the limit of my competitor check; I did not run logged-in TestRail/Qase trials.
- I did not test one million results, 50 concurrent users, reload/crash survival, a real backend, physical desktop clipboard integration, IME, screen readers, native undo across structured edits, browser engines other than Chromium, an exhaustive contrast audit, 1920×1080, or every palette operation/object combination. Those claims remain unverified.

## D. Draft versus version, in three sentences

Autosave each author's text and caret into a durable private draft, while everyone else keeps seeing the last adopted version and a fixed badge tells the author which version is shared. For human edits in a loose project, seal a changed draft when the author leaves for another case or screen, presses Ctrl/Cmd+Enter, or pauses for 30 seconds, recording the trigger, preserving the caret, updating proof strips immediately and creating no duplicate version when nothing changed. Keep agent changes as separately attributed proposals until the project's human-review rule permits adoption, never replace an open human draft, and make undo append a reversal that preserves subsequent human edits.

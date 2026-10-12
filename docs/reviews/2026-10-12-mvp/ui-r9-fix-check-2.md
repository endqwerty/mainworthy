# UI R9 second verification

Revision: `26b4183a36f29c5d572825786837b04249b13b98`; scope `5df1747..26b4183 -- src/web`. Reviewer: Codex, gpt-6-astra. Clean git archive; shared checkout untouched; no agents. Playwright is the explicitly requested browser workflow. Test support port range changed only in the export to 8900–8949, with TMPDIR under this review directory.

Safety fact: recovery must remove only text proved recorded and must preserve later input and newer server fields, or show a conflict before recording over them. Checks planned before any negative-control edits: four regression tests and isolated reversions; eight first-look probes twice; requested real-page neighbours; round8, round6, round7, conflict individually; TypeScript and Biome.

Review complete. The original F1 is fixed on the requested routes, but three blocking recovery failures remain. Results and reproductions follow.

Probe `delay`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts delay`.

Probe `delay-plain`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts delay-plain`.

Probe `reject`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts reject`.

Probe `lost-retry`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-retry`.

Probe `lost-reload`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-reload`.

Probe `choice`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts choice`.

Probe `same-field`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts same-field`.

Probe `later-editor`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts later-editor`.

Probe `delay`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts delay`.

Probe `delay-plain`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts delay-plain`.

Probe `reject`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts reject`.

Probe `lost-retry`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-retry`.

Probe `lost-reload`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-reload`.

Probe `choice`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts choice`.

Probe `same-field`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts same-field`.

Probe `later-editor`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts later-editor`.

## Checks completed so far

Regression tests PASS: `bun test test/e2e/conflict-merge.test.ts` reports `4 pass`, `0 fail`, `14 expect() calls` in `logs/regression.log`.

First-look probes PASS, all eight twice: `bun ../probe.ts delay delay-plain reject lost-retry lost-reload choice same-field later-editor` repeated in one invocation. `logs/probe-run.log` has 16 PASS lines. `logs/probes.jsonl` contains server heads, drafts, requests and statuses. Both lost-retry and lost-reload now end at version 4 with the merged title, both step edits and no draft. F1 from the first look is fixed for these cases.

## Confirmed blocker F2: recovery ignores new merge conflicts

The real-page `same-after` probe records the initial merge at version 4, loses its reply, then a colleague changes the title to `Colleague title AFTER merge` at version 5. The person types `Hand merged title PLUS LATER` into the retained card and presses Resolve again. Recovery removes the card, sets the draft base to 5 and says `Conflict resolved. Your later text is kept on this device as a draft on version 5.` Escape records version 6 with the person's title, replacing the unseen colleague title without a conflict or warning.

Cause: `finishConflict` takes only `.merged` from `mergeBodies({base:sent,mine:card,theirs:recorded})`. The merge function returns mine AND a conflict when both sides changed a field. The caller discards that conflict and advances the base to the current head, so the next proposal cannot detect the collision. This blocks delivery because a newer field is overwritten without the person being told. Evidence: `neighbours.ts same-after`, `logs/neighbours.jsonl`, `logs/neighbour-same-after.png`. A repeat is pending.

The `same-before` neighbour also confirms a related failure when the colleague changes the conflicted title before the first merge attempt. The lost reply contains a replacement conflict, so the server remains at version 3. Recovery of the settled original question nevertheless says `Conflict resolved`, discards the replacement card, and rebases later title text on version 3. It also drops the original Step 2 input `Apply the coupon SAVE10`, since that equals sent while the server still holds `Apply the coupon`. Escape records version 4 with the later title and the old step. The server's original reply and subsequent requests are retained in the same JSONL. This is not the expected safe replacement-card behaviour observed by the original `same-field` probe with an acknowledged reply.

## Confirmed blocker F3: an unconfirmed sent body is replaced with the pre-merge draft

`api-different-title` drops the original merge request before it reaches the server, leaving the genuine `sentMerge` stored by the page. The same local person then answers that question through the API with `Different API title`. The server permits this and records version 4. On retry the card's `Hand merged title` disappears. Recovery retains `Coupon case mine` and the old first step on base 4, and labels them later text. Escape records those stale fields as version 5, replacing the API title and colleague step. `mergeRecorded` correctly returns false, but `finishConflict` falls back to `stored.body` rather than preserving the unconfirmed merged card. Evidence: `neighbours.ts api-different-title`, JSONL and screenshot.

`again-title` reaches the same fallback without an alternative API answer. The first merge really records version 4, its reply is lost, and during reload the colleague changes the title to version 5. Recovery retains the original pre-merge title and old first step on base 5. Escape records version 6 and replaces both the newer title and the previously merged colleague step. No later typing occurs. `again-step` passes because the colleague changes only a non-conflict field and the original conflicted title still matches.

## Confirmed blocker F4: matching the conflict fields does not prove the whole submitted input was recorded

`api-different-step` also drops the first request before delivery and answers the same question through the API. The API body keeps `Hand merged title` but uses `Different API step` for Step 2, where the page's sent body holds `Apply the coupon SAVE10`. Recovery sees the title match, deletes the entire local draft and card, and reports `Conflict resolved. Version 4 is recorded`. The Step 2 input survives nowhere in local storage and was never recorded. The person is not told that the API recorded different text. `mergeRecorded` needs evidence that accounts for these fields rather than treating an equal title as proof of the sent body. Evidence: `neighbours.ts api-different-step`, JSONL and screenshot.

## Repetition and real-page neighbour outcomes

All five failure probes were repeated against the unchanged target before negative controls. Each reproduced the same versions, bodies, storage loss and status. `logs/neighbours-repeat.log` has five COMPLETED lines; these mean the probe reached its final inspection, not that the product passed. Full observations are appended to `logs/neighbours.jsonl`.

| Requested neighbour | Verdict | Deciding observation |
| --- | --- | --- |
| d1, later title after lost reply | PASS | `later`: recovered draft base 4 has `Hand merged title PLUS LATER`, `Colleague newer step` and `Apply the coupon SAVE10`. Escape records all three as version 5. |
| d2, colleague's second edit is the title | ISSUES, F2 | `same-before`: lost reply reports a replacement conflict; recovery skips it, loses SAVE10 and records over the colleague title. `same-after` separately proves the same-field collision after a successful merge. Both repeated. |
| d3, step text, retry and reload | PASS | `step-retry`, `step-reload`: version 4 retains `Hand merged action`, colleague title and SAVE10; no draft or extra version after Escape. |
| d3, step membership, retry and reload | PASS | `member-keep-retry`, `member-keep-reload`, `member-remove-retry`, `member-remove-reload`: both keeping the edited step and choosing its deletion survive recovery at version 4 with no draft. |
| d4, same local person answers via API with different body | ISSUES, F3 and F4 | Allowed by the real server. Different title restores the pre-merge draft and loses the hand-typed card. Equal title with a different second step deletes all local input, including unrecorded SAVE10. Both repeated. |
| d5, lost reply, reload, another edit before app loads | ISSUES for title, PASS for other step | `again-title` replaces version 5 title and step at version 6 with old draft text. Repeated. `again-step` preserves version 5 and leaves no draft. Reload's document request is held while the API changes the case, then released. |

All probes use real local servers and browser input. For d4 the network failure occurs before request delivery, which is indistinguishable to the page from a lost reply and preserves the sent body naturally. The ordinary lost-reply probes call `route.fetch()` before aborting. Each route install is followed by `page.evaluate(() => undefined)` before acting.

## Reachability and smallest reproductions

The common prerequisite is an open title-conflict card with an independently edited Step 2. From that card, type `Hand merged title` and press Resolve with its reply lost. These are two deliberate actions and one network event. A colleague's separate first-step edit before this press is included in the recorded probes to match the author's regression setup.

- F2, after that failed-reply card: the colleague changes the title once. Type later title text, press Resolve, then Escape. Three deliberate actions and one outside edit after the common prerequisite overwrite the colleague title with no warning. The `same-before` variant instead moves that outside title edit before the failed merge, then loses the non-conflicting Step 2 input too.
- F3, after that failed-reply card: reload while the colleague changes the title, then Escape. Two deliberate actions and one outside edit after the prerequisite record the pre-merge title and step over the newer head. The API variant needs an alternate API decision followed by retry; that retry alone loses the typed merged title. Escape is an additional action demonstrating the server overwrite.
- F4, after a failed request with the sent body stored but not delivered: answer the question from the API with the same title and a different Step 2, then retry in the page. Two deliberate actions, no additional outside event. The retry immediately removes the only local copy of unrecorded Step 2 input. Escape confirms that nothing remains to record.

These are separate blocking branches: discard of newly detected merge conflicts, replacement with an older local body when proof fails, and whole-draft removal based on incomplete proof. All three meet the requested input-loss or unannounced-overwrite definition.

## Existing browser files and static checks

PASS. Each browser file ran alone in sequence with TMPDIR under this review directory. No known route-installation race occurred.

| Command | Deciding lines |
| --- | --- |
| `bun test test/e2e/round8.test.ts` | `18 pass`, `0 fail`, `67 expect() calls` |
| `bun test test/e2e/round6.test.ts` | `14 pass`, `0 fail`, `59 expect() calls` |
| `bun test test/e2e/round7.test.ts` | `12 pass`, `0 fail`, `59 expect() calls` |
| `bun test test/e2e/conflict.test.ts` | `1 pass`, `0 fail`, `7 expect() calls` |
| `bunx tsc --noEmit` | Exit 0, no diagnostics |
| `bunx biome check src/web test/e2e` | Exit 0, `Checked 64 files in 73ms. No fixes applied.` |

Logs are `logs/round8.log`, `logs/round6.log`, `logs/round7.log`, `logs/conflict.log`, `logs/tsc.log` and `logs/biome.log`.

## Diff and conflict-path reasoning

Read the complete `git diff 5df1747 26b4183 -- src/web` and the new test file, then both callers of `finishConflict`, card persistence and the core merge implementation. The acknowledged-success caller supplies the submitted body and `removeUnchanged=true`. The recovery caller looks only at `decision.answer.is`, fetches the current head, uses `mergeRecorded` for the removal decision, and still passes `sent` to `finishConflict` even when the comparison fails. It does not establish which body the decision recorded, or whether the decision produced a replacement conflict rather than a new version.

`bun ../path-check.ts` executes the actual helper and merge implementation. Deciding results are in `logs/path-check.log`.

| Stored conflict path | What the helper does | Assessment |
| --- | --- | --- |
| `title` | Exact string equality between sent and current head | Correct field comparison, insufficient evidence about other fields or a head advanced after the decision. |
| `pre` | Exact string equality | Same limit as title. The direct changed-pre probe returns false. |
| `steps.<id>.action` | Compares action text, missing step becomes null | A missing or changed action returns false; equal action says nothing about other input. Real retry and reload probes pass for a recorded action merge. |
| `steps.<id>.expected` | Compares expected text, null and missing step become empty string | Changed expected text returns false. A sent step with null expected and a missing head step compare equal, directly demonstrated. This normalization is not proof of step existence. |
| `steps.<id>` | Compares presence only | Correctly distinguishes retention from removal. Both choices pass retry and reload. If the step exists in both bodies but its text differs, the helper still returns true. The direct action-difference probe demonstrates this limit. |

The page persists `mergeBodies(...).conflicts.map(c => c.path)` without restricting the paths to the five above. Core merging can also produce `methods`, `automate`, `fields.<key>` and `steps.order`. `textAt` returns null for the first three, so they compare equal regardless of content. `steps.order` is treated as membership of a step called `order`, so it normally compares false with false and returns true too. Direct probes demonstrate the `methods` and `steps.order` results. I did not construct browser conflicts for these extra paths and do not count them as additional confirmed blockers.

For later card text versus a different head value on the same field, `mergeBodies` returns the card value AND a conflict. The direct execution returns `merged.title:"later"` and `conflicts:[{path:"title",base:"T",mine:"later",theirs:"colleague"}]`. `finishConflict` ignores the latter. F2 demonstrates the resulting overwrite on the real page. If the server never recorded the sent body, using it as the merge base also treats original submitted input as unchanged and can remove it, as shown by the SAVE10 loss in `same-before`.

The changed predicate fixes the acknowledged merge and unchanged-card recovery when the submitted conflict fields still match. The additional rebase correctly combines later input with unrelated server edits. Neither establishes safe behaviour for the confirmed failure branches above. The safety fact is therefore disproved on this revision.

## Isolated reversions and restoration

Each control edits only the clean export, runs `bun test test/e2e/conflict-merge.test.ts`, then restores the two source files before the next control. `negative-controls.py` preserves the exact target files and restores them in `finally`. No probes or other browser suites ran during these source mutations.

| Single change reverted | Test failures and deciding lines |
| --- | --- |
| Entire `finishConflict` change reverted to `5df1747`, recovery and helper kept | `0 pass`, `4 fail`. The first three fail waiting for zero drafts at `expectTheMergeToStand`, line 88. The later-text test fails at line 165: expected `Open the cart, changed by a colleague`, received `Open the cart`. |
| Only `releaseSettledConflict` call restored to its old whole-body comparison | `2 pass`, `2 fail`. Only lost-reply second-press and reload tests fail, at the zero-draft check. Acknowledged merge and later typing pass. |
| Only `mergeRecorded` changed back to whole-body equality | `2 pass`, `2 fail`. The same second-press and reload tests fail at the zero-draft check. Since the helper did not exist in the parent, this restores its prior equality semantics while retaining the symbol so the current caller can run. |
| Only later-text rebase removed, returning the card body directly | `3 pass`, `1 fail`. Only the later-text test fails at line 165, expected colleague step but received `Open the cart`. This separately establishes that the rebase itself is exercised. |

Logs: `logs/negative-finish-reverted.log`, `logs/negative-release-reverted.log`, `logs/negative-mergeRecorded-whole-body.log`, `logs/negative-later-rebase-reverted.log`. The generic `The expected server state did not arrive` errors here come from `expectTheMergeToStand` waiting for draft removal, not from `conflict()` constructing a test conflict. They are deliberate negative-control failures, not the reported route-installation race.

After restoration, `logs/regression-restored.log` reports `4 pass`, `0 fail`, `14 expect() calls`. A byte comparison of every tracked exported file with the target git archive finds only `test/e2e/support.ts`, whose port substitution is documented above. `logs/restoration-audit.log` records that comparison. Product code is restored exactly to the judged revision.

## Finding locations and limits

F2 centers on `src/web/suite/index.tsx:422`, where merge conflicts are discarded, and line 445, where the draft advances to the current head. The lost replacement-conflict variant also depends on `releaseSettledConflict` inspecting only the answer kind at lines 477–482.

F3 centers on `src/web/suite/index.tsx:416` and line 444: an unchanged sent card is not later text, but a failed proof still falls back to the older draft body and assigns the current head as its base.

F4 centers on `src/web/lib/drafts.ts:46` and `src/web/suite/index.tsx:428`. Partial field equality allows the whole draft to be removed even when another submitted field was never recorded.

No fixes were attempted. No full suite, latency budgets, production, other browsers, idle-time sealing, or unrelated application flows were checked. Preconditions and expected-result path comparisons were exercised directly, not as additional custom browser journeys. Extra core conflict path kinds were inspected and partly executed directly; no end-to-end claim is made for those kinds. Browser probes use Chromium, real local server writes and Escape to observe the resulting recorded versions. The known race did not occur on the unchanged revision, so no race-driven reruns were needed.

All checks requested in a–e were completed. All spawned test servers and browser contexts were closed through the test helpers. No agents were started, no shared-checkout files changed, no shared cleanup ran, and no commit or PR was created. All review artifacts remain under this review directory.

ISSUES (3 blockers)

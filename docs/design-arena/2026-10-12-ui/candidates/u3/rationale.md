# U3: The document

## Direction

A case is a writable document, with its canonical Markdown one click from the rendered steps. A narrow suite index keeps the book visible while the author types, and a search-first folder switcher replaces the permanent tree. Questions and run slots each put one piece of work in the centre and advance after the answer.

## Where I departed from the seed

I kept a narrow case index beside the centre column on Suite. A completely hidden suite would make a new user's first task depend on knowing a shortcut, and would hide the proof strips the brief requires. The full Case screen removes the index and gives its space to a timeline.

The default editor renders numbered steps and indented expectations rather than raw Markdown. Enter, Tab and ` > ` give the document structure without making the writer select fields. Markdown remains editable in place, including stable step IDs, but it is an optional view. I did not build a slash-command menu inside the body. Prefix capture and the global palette handle the implemented operations.

## What I rejected

- A permanent folder tree. Forty folders should not consume the width needed for a sentence. The folder switcher searches names and full paths.
- A table full of metadata. A row has an ID, a title, a proof strip, its folder and an open-question dot. Context belongs in the document.
- A dashboard home. The first action is writing, not reading a chart.
- A Publish step. It would leave finished work in drafts. Publishing every keystroke would expose half a thought and create versions with no useful boundary.
- A single green status that mixes producers. H, C and A each show their own latest outcome and age. Hover states the version, target and basis. A pass on an older version is `~`, not `✓`.
- Agent edits applied while the author is typing. A proposed change has a purple producer label and a before/after diff. Acceptance creates an agent-authored version and records Dana's decision. Rejection leaves the case untouched.

## Friction against TestRail and Qase

The intended advantage is the uninterrupted six-step capture path, with no Add Step action, metadata selection or required save. The [TestRail steps template](https://support.testrail.com/hc/en-us/articles/14927678348052-Test-case-templates) documents adding individual steps and their expected-result fields. U3 uses repeated Enter and three Tab strokes for the same structure.

[Qase already offers title-and-Enter quick creation and an editable preview](https://docs.qase.io/en/articles/5563704-test-cases). U3's bet is extending that continuous typing path through all six steps, three expectations and an inline tag. I do not claim Qase lacks fast capture or inline editing.

For execution, the next document is rendered before the current result is recorded, and a failure key places the caret in its note. For triage, the evidence and the allowed answers are together, and each answer advances without a detail-page visit. These are demonstrated mechanics, not measured wins against live competitor accounts. A timed head-to-head audit remains necessary.

## Counted on the mock

A chord such as Ctrl+Enter counts as one command stroke. Every printable character, including a space or capital, counts as one text stroke. Counts start on Suite, include navigation where needed, and use keyboard input only. They exclude reading the evidence and executing the software being tested.

| Job | Command strokes | Text strokes | Total |
| --- | ---: | ---: | ---: |
| J1, create six steps, three expectations and `checkout` | 11 | 187 | 198 |
| J5, eight passes, one failure with a note and one blocked | 13 | 13 | 26 |
| D2, answer twenty mixed questions | 22 | 0 | 22 |

J1 uses `c`, the title `Coupon survives reload #checkout`, Enter, and these six actions: `Open the cart`, `Apply SAVE10`, `Reload the page`, `Continue to checkout`, `Choose delivery`, and `Review the total`. Tab starts the expectations on steps 2, 3 and 6: `Total is $90.00`, `Coupon remains applied`, and `Discount appears in summary`. Five Enters separate the steps. Ctrl+Enter makes version 1. The command count is one create, six Enters, three Tabs and one version chord.

J5 uses `g r`, eight `p` strokes, `f`, the 13-character note `Total is $100`, Enter and `b`. It starts at slot 28 because 25 CI and two agent executions already filled slots. Slot 38 is selected afterwards, with three unfilled slots left.

D2 uses `g q`, then `d a a l f e r r t i` twice. That sequence answers eight failures, four proposals, four findings and four unlinked tests. The list advances after each answer. Optional evidence peeks cost one Space to open and one to close. Undo costs one `u`.

## Private draft and versions

Every edit updates the author's private draft in memory. The version badge becomes `Private draft · kept as you type`; the current version stays unchanged. Leaving for another case or screen, pressing Ctrl/Cmd+Enter, or 30 seconds without an edit makes one version. A pause with no changed content makes none. Opening the same case's timeline or Markdown view keeps the draft open.

A version is a separate snapshot. Execution uses the slot's pinned snapshot, even if the case has since changed. An accepted agent proposal has Scout as the author and Dana as the accepter. Undo appends a decision and, when needed, a restoring version. It reverses the proposal's unchanged fields and keeps later human edits.

Thirty seconds is a hypothesis. It gives ordinary sentence editing room while making finished work visible without a button. The status remains explicit because an author must know whether colleagues are seeing this text. Production must preserve drafts through reload and crashes. This mock deliberately resets all state on reload, as the brief requires.

## Checks written before implementation

The initial rationale recorded these checks before the HTML was written. They were then exercised against the file URL in headless Chromium, through keyboard events, input, paste, and DOM inspection.

- Seed counts are 2,000 cases, 40 folders, 30 questions, 40 slots, 25 CI-filled and two agent-filled slots.
- `c` focuses the title before returning. J1 creates exactly six steps, three expectations and a tag, with no dialog.
- One pasted outline makes six steps and splits `=>`, `>` and `Expected:`. Normal typing and Tab preserve expected results.
- An edit remains private until leaving, the explicit chord, or the actual 30-second timer. Earlier snapshots stay unchanged.
- Two versions have a readable step-level diff. Canonical Markdown is editable and round-trips into a new version.
- Queue movement, Space peeking, twenty mixed answers, accept/reject, link/track and undo work. An undo is an additional ledger row.
- Run starts at slot 28. Eight passes, one failure note and a blocked result produce ten human results and one new question. The next case is already in the DOM.
- Search reaches C-2000. The palette reaches Q-12, R-4 and folders. Help and the theme toggle work. The mock makes no network requests.
- Scrolling to case 2,000 keeps the rendered row count bounded. All four screens fit at 1280x800 and 1920x1080 without horizontal page overflow.
- Chromium reported no JavaScript console errors. Four screenshots at 1440x900 were inspected after rendering.

The first independent review by Claude Opus 5.5 found a typed ` > ` delimiter left in the action, a stale proposal overwriting an undisclosed human action, and an unescaped step ID in a diff. Before the fixes, browser probes produced `Apply SAVE10 >`, replaced the human action with `Reload the page`, and accepted two questions from a repeated key. Focused checks now prove the delimiter is removed, only the displayed expectation changes, step IDs render as text, and a held key answers once. Later human edits and earlier snapshots remain intact. The full rationale was written after the reviewer's initial read of the provisional checks. A second review confirmed those fixes and found that accepting a proposal for a removed step created a false agent version. The corrected UI explains the missing step and offers rejection, while the acceptance key makes no decision or version. A proposal already present in the document records agreement without inventing a change. The final read-only verdict is PASS from Claude Opus 5.5 on `index.html` SHA-256 `246a2ae9f555b3956f1c763ca872bdc141bd9c5fcb6d4cbbdfea6afee697920d`. The reviewer independently ran 12 full check groups, nine targeted regressions and two missing-step checks, all with zero console errors. It probed renamed and privately removed steps, palette acceptance, already-present expectations, rejection and undo. It read the critical changed functions rather than the entire 92 KB source. OS clipboard, IME, screen readers, native undo and a full-source read remain review limits.

## Open risks and cuts

No required screen was cut. Run planning, drag-to-reorder, attachments, a rich Markdown parser, collaboration, permissions, offline storage and a custom home are outside this mock. There is one planned run. Failure evidence uses illustrative data, not live CI logs.

The structured editor still needs IME, screen-reader, selection, multiline expectation, OS clipboard and native undo testing. The literal sequence ` > ` is reserved capture syntax; literal comparisons need an escape convention in the product. The nested folder model is two levels deep. Queue shortcuts can invite rushed answers, so production must preserve identity, basis and a dependable undo rather than introduce confirmations. Step-level proposal conflicts and concurrent edits need explicit conflict handling. The prototype does not validate a complete arbitrary Markdown file or prevent someone editing a stable step ID in that view. It escapes those IDs before rendering a diff.

The large document sometimes needs its own vertical scroll at 1280x800. That preserves readable type instead of shrinking the steps. The case timeline can also scroll independently. The run rail shows filled slots, but execution keys do not overwrite them.

## At one million results or fifty users

At one million results, fetch bounded case and queue pages from a search index and database, with indexed producer summaries. Keep the virtual list and the next-slot document cache. Read history by cursor and load a particular diff on demand. Store evidence attachments outside the document. Do not copy the mock's whole-project arrays into the product.

At fifty users, base each draft on a known version, keep private drafts durable, and show another author's draft as awareness without streaming its text. Disjoint changes can merge. Conflicting text needs a visible comparison with neither author discarded. Queue answers need optimistic revisions so two humans cannot silently settle the same question differently. Keep both run observations if two people fill a slot. Refresh counts and proof strips in the background, with no rerender of a focused editor.

# 0058: Resolve an overlapping save in the iPhone editor

- Date: 2026-10-15
- Status: proposed

The iPhone editor kept an overlapping draft but sent its author to the web app. The phone now shows each
field's draft and current value vertically and requires a choice for each overlap before recording a merge.
The merged document is shown underneath, including custom fields and changes that did not overlap.

`CaseEditorScreen` owns the draft, conflict and immutable pending command. A view asks it to choose a side
and record the merge. `ProjectClient` reads the full proposal and question evidence through the generated
consumer contract. Merge replies are interpreted by their effects, including adoption, no change, a proposal
waiting for acceptance, a replacement conflict, and refusal. Every conflict reads its exact proposal base
version. A history comparison of that version against itself supplies its full custom fields, which a direct
case read omits. A replacement keeps the proposed merge as its draft. The original editor content stays
until completion.

The phone runs `src/core/merge3.ts` in JavaScriptCore. The existing Swift generator bundles that pure function
and `applyMergeChoice`, including their used helpers, as a string. The web card calls the same choice
function. This keeps step identity, ordering and field merging identical across clients without a second
Swift algorithm. One JSON scenario table runs through both the browser card and Swift package tests.
The bundle contains no third-party code or I/O. The contract test requires it to be regenerated when its source changes.

A kept step that the draft removed returns beside its surviving neighbours from the chosen side. This
preserves its context instead of moving it to the end. Both ordinary merging and choice application use
the same insertion rule. If its neighbours now appear in reverse order, it follows the preceding neighbour.
An explicit `steps.order` choice takes precedence, including after later step choices. Steps absent from
that order stay at the end, so concurrent additions are kept. The web stores that order choice with its
card; the phone keeps it with its selections.

A refused merge reads the question again. If it was answered elsewhere or no longer applies, the phone
keeps the draft and choices, disables recording, and tells the person to choose Cancel. A refusal of an
open question still permits another choice.

A lost reply is recovered by asking `command`, as decision 0013 requires. A completed command's own effects
settle the editor. An unknown command can be sent again only with its unchanged body and id. A begun command
keeps the editor locked for another read. No body comparison is used to infer whether a request was recorded.
The chosen merge cannot be edited while its outcome is uncertain. An adopted stamp is read at its exact
version before the suite opens it.

We considered putting merge choices and networking directly into the SwiftUI sheet. That would lose the
choices when a session renewal recreates views and bypass the package's screen boundary. We also considered
a native merge implementation with generated parity cases, but it would duplicate the server's ordering
algorithm. A small generated bundle keeps one algorithm at the cost of using Apple's JavaScriptCore framework.

Resolution starts from an overlapping save in the open editor. A conflict opened separately from the Queue
still opens in the web app. Draft lifetime is unchanged: backgrounding and session renewal keep it, closing
the app does not. The phone offers side selection for whole fields rather than free-form merge typing.

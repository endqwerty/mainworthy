# U1: one outline

## Direction

The suite is a folded document: folders contain cases, and expanding a case reveals
the same steps you edit. A quiet evidence rail holds questions, producer results
and immutable versions beside the focused case. Keyboard commands keep capture,
execution and decisions in a continuous sequence with no required fields.

I kept the ONE OUTLINE seed for reading and writing. I departed for the run cockpit:
execution gets its own focused view with the next case already visible, rather than
adding execution controls to every writing row. The queue also has a dedicated list;
its questions still lead back to the same expanded case, never a separate case page.

## Choices and rejections

- Rejected a case page and separate edit mode. Both detach the next sentence from
  its place in the suite. A case expands under its title; edits happen there.
- Rejected a dashboard as home. It would spend the first screen on reading numbers
  when the owner has asked to make writing the fastest job.
- Rejected a permanently expanded tree of every step. The outline retains folders
  and case titles; one focused case expands so its body does not hide its neighbours.
- Rejected producer-specific inboxes. A failure, proposal, finding and unlinked test
  share one question list; each displays its producer and appropriate answer keys.
- Rejected automatic agent edits. Violet proposals display a diff, a base version
  and Accept/Reject. Acceptance records Scout as author and Dana as approver.

## Where friction improves

Both incumbents already offer quick title creation. TestRail documents an Add Case
link and Enter to capture a title. Qase documents title-plus-Enter quick creation,
and an editable preview sidebar for details. U1 extends that first title sequence
through steps, expectations and tags in the outline itself. Enter does not end
capture and ask the author to find the detail editor. Multiline paste creates
structured steps without a form or import workflow. These are differences from
the documented paths, not an independently timed incumbent speed comparison.

Sources checked 2026-10-11: [TestRail, adding test cases](https://support.testrail.com/hc/en-us/articles/14438119644692-Adding-test-cases)
and [Qase, test cases](https://docs.qase.io/en/articles/5563704-test-cases).
Execution skips the 27 slots already filled by other producers. Triage removes a
row on one answer and retains selection at the next row. Those mechanisms are
demonstrated here; their comparative time advantage still needs the friction audit.

## Counted jobs

Counts were exercised through the Chromium interface, not estimated from a sketch.
One inserted character counts as one key; a shortcut chord counts as one interaction.
Reading, clipboard preparation, modifier-only presses and mistakes are excluded.
Navigation is included below. J1 starts in Suite; J5 and D2 start in Suite as well.

| Job | Text keys | Command keys | Total |
| --- | ---: | ---: | ---: |
| J1: title, six steps, three expectations, #checkout | 123 | 11 | **134** |
| J5: eight pass, one fail with note, one blocked | 12 | 13 | **25** |
| D2: twenty mixed questions | 0 | 22 | **22** |

J1 used `c`, `Apply coupon #checkout`, Enter, then `Open cart`, `Add item`,
`Apply SAVE10`, `Check total`, `Pay by card`, `Check order` with five intervening
Enters. Tab opened expectations on steps 1, 3 and 6: `Cart is empty`, `Total is 90`,
`Order is placed`. Ctrl/Cmd+Enter sealed the version. The commands are c + six
Enters + three Tabs + the version chord. With this whole block already on the
clipboard, c + paste + the version chord is **3 interactions**.

J5 used g r, eight p, f, `Total is 100`, Enter, b. The run opens on slot 28;
the 25 pipeline and two agent results are left intact. Without navigation: 23.
D2 used g q, then d a l r repeated five times. Five failures became defects,
five proposals were accepted, five tests linked and five findings rejected.
Without navigation: 20. Evidence is displayed beside each selected row; Space
toggles its detail without changing selection. Undo is one additional u.

## Private draft and versions

Every edit updates a private draft. The inline badge says "Private draft · only
you" and identifies the shared version; it does not claim the draft is published.
Leaving the case, folding it, Ctrl/Cmd+Enter, or 30 seconds without input seals one
version. A pause shorter than 30 seconds creates no history. A no-change seal
creates no redundant version. Idle sealing retains the focused text field.

This is the default human-edit policy for the mock. It avoids a Publish button
people can forget, and keeps colleagues from reading each half-typed sentence.
Thirty seconds is a concrete starting choice, not an observed optimum. A production
draft must survive crashes; this brief requires memory only, so the editor says
"Kept in memory" and the footer says "resets on reload".

Agent proposals have a different boundary. Sealing alone never adopts them.
Accept checks their base, creates an agent-attributed version and records the
human decision. Reject keeps the decision without changing the case. Undo writes
a reversal; undoing acceptance makes another version instead of erasing history.
Step diffs show removed and added text, with independent from/to version selectors.

## Checks and limits

The initial check list, written before code, covered capture, paste, drafts and
versions, all queue keys, undo, run progression, navigation, windowing and layouts.
Observed checks: 2,000 cases / 40 folders / 30 questions / 40 slots; 16 mounted
outline nodes at 1280x800 initially and 14 at the end of 2,040 flattened rows.
Capture produced six steps, three expectations and a tag with zero dialogs.
Paste split all three separators and a following Expected: line. Idle sealing
produced v4, retained title focus and left the original three snapshots unchanged.
Twenty answers left ten open; undo restored one and added D-21 superseding D-20.
The ten-result run left three unfilled and created a failure question with its note.
JavaScript syntax and these browser interactions reported no JavaScript errors.

Independent verification: **PASS**, Claude / `claude-opus-5-5`, high effort,
2026-10-11. All eight checks and the resumed-tag regression passed in Chromium
over file://, with native key, mouse and wheel input on the unchanged revision:
`f67951159bae55070f7b1c7e03d4e679760709d031663c4fa7c41f1ca6deb4fc`.
The verifier confirmed 134 / 25 / 22 keys, exactly one checkout tag after typing
and after refocusing a partial tag, exact-ID palette ranking, and 12–18 mounted
nodes across the full tree. The draft remained private at 27.0 seconds and became
one version at 31.5 seconds; the earlier versions stayed byte-identical.
All four views passed both required sizes and themes, without exceptions or
external requests. Visible text contrast was at least 4.5:1 in the checked views;
placeholders, focus rings, non-text marks and frame-time percentiles remain unaudited.
The author's four final 1440x900 PNGs were opened and visually inspected. The case
screenshot shows the expanded outline beside a v2-to-v3 step diff.

No required screen was cut. Persistence, real CI/agent calls, uploads, issue tracker
integration, concurrent authors, shared steps and policy administration are outside
this mock. Classification records a decision; it does not create a real defect.
An empty case may record v1 because no field is required. Slot-rail titles use
ellipsis with the full title in the centre; footer key caps and slot labels are 9px.

## Open risks and scale

- The 30-second seal may publish an incomplete thought during an interruption.
  The badge, shared base and history make that visible; test the delay with authors.
- Long steps need wrapped text without breaking caret placement or window heights.
  The present single-line fields favour the requested short capture job.
- A one-case expansion favours sequential writing; comparing two long cases may
  need a temporary split, without making split navigation the default.
- A proposal with a stale base is blocked; this mock does not include a conflict
  editor or automatic rebase of agent edits.
- Colour is reinforced by glyph, producer name, result word and short ID. A full
  screen-reader and contrast audit has not been completed.
- Input-to-paint percentiles and incumbent task times have not been benchmarked.

At 1,000,000 results, retain this layout and request only the newest result per
producer for visible cases. Page the case timeline by cursor, aggregate run counts
on the server, and return small evidence summaries before traces. Search and
folder filtering must use indexed server queries rather than this mock's in-memory
scan. Preserve the window and preloaded next slot.

At 50 users, drafts become durable and private, edits carry a base version, and
conflicts retain both texts for comparison. Broadcast changed proof strips and
queue counts without moving the focused row. Run slots need conflict handling,
not last-write-wins. Show another author's presence only at the focused case;
never steal their text cursor, and keep agent authorship separate from adoption.

# U2 · The Workbench: rationale

## Direction, in three sentences

Mainworthy is one fixed three-region workbench (sidebar, a windowed list, a pane that edits in place), and
every screen in the brief is a state of it: the case, the question's evidence and the run cockpit all live
in the pane, so nothing ever navigates. Capture starts in the list row under the cursor (`c`, type, `⏎`)
and continues in the pane as an outline, with no dialog, no save and no field to fill first. Who produced
a thing is a shape, a letter and a colour used the same way everywhere (solid circle H person, square C
pipeline, violet diamond A agent), and anything an agent wants to change is a dashed violet card that
stays pending until a person presses `a` or `r`.

## Where I left the seed

- "Space peeks" had no job: in three panes the pane already follows the cursor. Space now means "show me
  the evidence for this row, keep my focus in the list" (full log and history in the queue, the latest
  result per producer on a case, other evidence in a run). Enter means "put my caret in the pane".
- "The layout never jumps" holds with one exception the user asks for: `z` widens the pane (the list
  drops to id, title and three marks). `case.png` is taken in that state.
- No toasts. One status line under the list says what just happened and how to undo it; the right half
  of the same line shows the keys that mean something for the row under the cursor.
- The title is typed in the list row itself, as the seed says, so the caret appears where the eyes
  already are; `⇧⏎` seals that case and opens the next row, which makes a brain-dump of ten titles ten
  lines. The price is one eye movement to the pane when the steps start (see risks).

## What I rejected, and why

- **A case page.** A page per case costs a navigation each way and hides the list during a burst.
- **A new-case dialog or form.** Any field before the first character breaks P1 and floor F2.
- **A spreadsheet grid.** Good for bulk edits, bad for steps with expected results: cell navigation and
  text editing fight over the same keys.
- **A pane that opens and closes, or hover previews.** Both move the list under the cursor.
- **Auto-applying agent edits with a revert.** The owner ranks human edits higher; an agent's change is a
  proposal with a step-level diff and two keys, in the queue and on the case, never silently live.
- **Tabs per producer** ("Automation", "AI"). The proof strip carries it in 180 px per row.
- **A note required on blocked.** `b` records and moves on; only `f` lands in a note, and `⏎` on an
  empty note is allowed.
- **Rich text in steps.** Plain lines are faster to type, paste and diff.

## Where it beats TestRail and Qase on friction

The incumbent side below is from general knowledge, not measured in this session; `docs/competitors.md`
treats such claims as hypotheses and the phase 0 friction audit should count them on live trials.

| Job | Incumbent shape (unverified) | This mock (counted) |
| --- | --- | --- |
| Write a case | Open a form, pass title, template, type and priority, add each step with a button into two boxes, Save, page reload | 13 keys beyond the text itself, 6 with a paste; 0 dialogs, 0 loads, 0 pointer moves |
| Several cases | Form again for each one | `⇧⏎` in the title: next case, same row position |
| Record results | Pick a status, a result dialog on fail, pointer to the next test; CI results live in a different run | 1 key per result; 27 of 40 slots are already filled by CI or an agent and are skipped |
| Triage | No single list across failures, agent output and unlinked tests | 1 key per answer, the consequence is written next to the key, `u` undoes |
| "Is it proven?" | A status someone set, or the last run | Derived per producer and per version; an edit turns `✓` into `~` at once |

## Keystrokes, counted on the mock

Convention: one per key press that reaches the app; a chord (`⌃⏎`, `⌘V`) counts once; Shift is free.
`index.html#selftest` drives the real key handlers and prints these numbers plus 21 behaviour checks;
I also replayed J1, J5 and D2 with trusted key events over the DevTools protocol and got the same state.

- **J1** (title, six steps, three expected results, `#checkout`): **13 keystrokes of overhead** on top of
  the case's own text (278 in total for 265 characters): `c`, space and `#`, `⏎` after the title, five
  `⏎` between steps, three `⇥`, `⌃⏎`. From a pasted list: **6** (`c`, space, `#`, `⏎`, `⌘V`, `⌃⏎`),
  50 in total with a 36-character title; `=>`, ` > ` and `Expected:` were all split correctly.
- **J5** (eight pass, one fail with a 10-character note, one blocked): **21** in the cockpit (8 × `p`,
  `f` + note + `⏎`, `b`), 23 with `g r`. The failure opened a question in the queue by itself.
- **D2** (twenty mixed questions): **20**, one per question (9 failures, 4 findings, 2 proposals, 5
  unlinked tests in the scripted run), 22 with `g q`.

## Draft versus version

**Decision.** Typing autosaves into a private draft. The draft becomes a version on the first of three
events: the cursor leaves the case (another row, another folder, another screen), `⌃⏎`/`⌘⏎`, or 30 s
without a keystroke. There is no Publish button and nothing to confirm.

**Why this avoids both Confluence failures.** Nobody can forget to publish, because walking away is
publishing. Nobody reads half a sentence, because others keep seeing the last version until then, and
history gets one entry per sitting instead of one per keystroke.

**How the state is shown, in one wording and three places.**
- An amber strip at the top of the case: `Draft · saved · everyone else still sees v3 · becomes v4 when
  you leave, on ⌃⏎, or after 30 s idle`. Sealed, the same strip is grey: `v4 · current, what everyone
  sees · who · when`. Same height, so nothing moves.
- An amber `draft` chip on the list row; someone else's private draft shows as a grey `draft · sam` and
  you keep reading the current version.
- A "Your draft" entry at the top of the timeline with the live step-level diff against the current
  version: you see exactly what leaving will publish.

**The rules that keep it quiet.** A draft equal to the current version makes no version. A new case
with no title and no steps is dropped. `esc` returns to the list without sealing, because you have not
left. The status line reports the seal and `u` reverts it by appending a version that restores the old
body (v2 stays in the timeline; P0). After a seal the proof strip turns earlier passes into `~`: the
cost of the edit is on screen the moment it is made.

**What I would add before shipping.** Seals by the same author with no result and no reader in between
should fold into one timeline entry (the facts stay append-only, the view folds); the idle trigger makes
this necessary. Under a strict policy the same seal opens a proposal for an approver instead of adopting,
and it would use the same card an agent's proposal uses today.

## What works, what is cut

Works: everything listed in the brief's "must really do" section, checked by the self-test (0 failures,
no console errors on any screen) and by eye at 1280×800, 1440×900 and 1920×1080 in both themes.
`suite.png` and `case.png` are light, `queue.png` and `run.png` dark. Extras: `⇧⏎` rapid capture, `e`
renames in the row, `⌘↑/↓` moves a step, digit then `f` fails a named step, `a`/`r` on the case itself,
`[` `]` walk folders, one operation table feeds the key handler, the palette and the `?` overlay.

Cut: no persistence (a reload resets; the draft does not survive it, which L2 requires), no runs index
or run planning (`g r` goes straight to R-4), no Change, Release, Requirement or Policy pages, no
`@requirement` links, no multi-select or bulk move, no settled-ledger view (answers show on the case
timeline and in the status line only), no attachments, no keyboard focus inside the folder tree, no
layout below about 1200 px, no ARIA roles.

## Open risks

- **The eye jump** from the row (title) to the pane (steps) at `⏎`. If authors stumble, type the title
  in the pane and mirror it into the row; the keys stay the same.
- **Keys change meaning by screen** (`f` flaky or fail, `e` expected or rename, `a` accepts with one
  key). The status line shows the current meanings and `u` undoes all of them, but mode errors will
  happen; this needs watching with real users.
- **Idle sealing** will publish a half-finished case when someone is interrupted for 30 s.
- **Three glyphs on 2,000 rows** may read as noise; showing only what is not green is the fallback.
- **One unexplained observation.** In the long synthetic self-test (hundreds of untrusted events in one
  task) the row editor lost focus on the first frame afterwards. It did not happen in about thirty
  shorter or phased sequences, nor when J1, rapid capture, J5 and D2 were replayed with trusted key
  events over the DevTools protocol, nor across a 31 s idle seal. I treat it as a test artefact, but it
  is not explained.
- Editing uses `contenteditable="plaintext-only"`; a product needs a real editor model, IME handling
  and a caret that survives a tag being lifted out of the middle of a line (the mock moves it to the end).

## At 1,000,000 results or 50 users

- **Results.** The timeline must aggregate pipeline results (per build or per day: "214 pass, 3 fail")
  and window the rest; the proof strip must come from a projection written with the result (P6), never
  computed per row at read. The list already renders only what is visible at a fixed row height, so the
  change is fetching ranges instead of holding 2,000 objects; `/` becomes a server index behind the
  same field. The queue must group by cause so 3,000 red tests stay a dozen questions ("3 tests share
  this cause" is that idea at toy size).
- **Users.** The queue defaults to "needs me" with the total beside it, and rows show who else is
  looking. A run slot needs a soft claim ("sam is on this") so two people do not execute the same case;
  if both do, both results stay and the disagreement becomes a question. Other people's drafts are
  already marked; two drafts on one case need the side-by-side merge of decision 0004. Home becomes a
  per-user choice. No notifications are added: the queue count is the notification.

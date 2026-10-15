# Web accessibility assessment

This is the automated portion of [issue #47](https://github.com/endqwerty/mainworthy/issues/47), dated 2026-10-15.
The target is [WCAG 2.2 level AA](https://www.w3.org/TR/WCAG22/). This is not a claim of conformance.
Nobody has completed the VoiceOver or NVDA assessment. The native iPhone app, documentation site, operating
system dialogs, and files supplied by users are outside this web UI assessment.

## Evidence and limits

`test/e2e/accessibility.test.ts` uses the existing browser helpers, one seeded server, and one page.
It injects the development dependency axe-core into the browser. axe-core is MPL-2.0, a licence already
accepted in `scripts/licences.ts`. It is absent from the application bundles and shipped notices.

The test scans these states in light and dark themes:

- Sign-in, an invitation, and its passkey form.
- Queue evidence for all five question kinds, plus a failure answer's reason form.
- Runs, the planner, its commit form, an active run, its failure note, and a closed run.
- Suite, a case, and the case editor.
- Changes.
- Every Settings section, the custom field and policy clause editors, and People with invitation,
  recovery, sign-in details, team management, and forgetting forms open.
- Command palette, keyboard help, and the sign-out dialog.
- Phone queue, question, case, menu, and palette.

The axe tags are `wcag2a`, `wcag2aa`, `wcag21aa`, and `wcag22aa`. Reported violations fail the test.
Incomplete axe results are counted separately and require human review. Set `MAINWORTHY_A11Y_CAPTURE` to an
existing scratch directory, or one the process can create, to save example screenshots and `manual-checks.json`.
The latter lists each incomplete result by state, theme, rule, and element.

The same test makes up to two Tab passes until it reaches every control, checks the computed focus
indicator, and checks an exposed point inside the control after intersecting ancestor scroll clips.
Native radio groups use Tab for the selected radio and arrows within the group. The planner checks that arrow behavior. The phone may reveal a
pane when focus enters it. Escape must dismiss the palette, keyboard sheet, and sign-out dialog.
Every ordinary control must be reachable.
Pointer-only overlay backdrops have keyboard alternatives through Escape and the visible close or menu controls.

Target checks require 24 by 24 CSS pixels. Checkbox and radio targets include their associated labels.
Links inside paragraphs use the inline-text exception in criterion 2.5.8. The live status check records a
real case proposal and observes its message in a polite, atomic status region. These checks cannot establish
what a screen reader actually says, whether a label makes sense, or whether the reading order is useful.

To repeat the automated check, set `MAINWORTHY_CHROMIUM` to the Chromium executable on the machine and run
`bun test test/e2e/accessibility.test.ts`. With no browser, the existing helper prints a skip; a skipped run is
not accessibility evidence. Run `bun test test/licences.test.ts` to check that the audit dependency stays out
of the shipped build. Full-suite timing and independent review remain part of the parent change's checks.

## Criterion results

Every WCAG 2.2 A or AA criterion appears below. WCAG 2.2 removed 4.1.1, so it is not a criterion in this table.
`Axe` means an automated rule checks part of the criterion. `Script` means browser interaction or geometry
checks. `Inspection` means source or product inspection. `Person` means the listed work still needs a person.
Supports applies only within the states and first-party content described above. Not evaluated remains the
result wherever human assessment supplies the missing evidence.

| Criterion | Level | Result | Evidence | Reason |
| --- | --- | --- | --- | --- |
| 1.1.1 Non-text content | A | Not evaluated | Axe, Person | Names and alternatives pass automated rules; screen-reader meaning of proof marks, icons, and diffs needs review. |
| 1.2.1 Audio and video only | A | Not applicable | Inspection | The first-party web UI contains no audio or video. |
| 1.2.2 Captions | A | Not applicable | Inspection | No first-party prerecorded media. |
| 1.2.3 Audio description or alternative | A | Not applicable | Inspection | No first-party prerecorded media. |
| 1.2.4 Live captions | AA | Not applicable | Inspection | No live media. |
| 1.2.5 Audio description | AA | Not applicable | Inspection | No first-party prerecorded video. |
| 1.3.1 Information and relationships | A | Not evaluated | Axe, Person | Labels and ARIA checks pass; tables, virtual lists, nested evidence, and editor relationships need screen-reader review. |
| 1.3.2 Meaningful sequence | A | Not evaluated | Person | Reading order across panes, overlays, and phone transitions has not been heard. |
| 1.3.3 Sensory characteristics | A | Not evaluated | Person | Instructions need review without visual position or shape cues. |
| 1.3.4 Orientation | AA | Not evaluated | Person | Phone states are scanned in portrait; rotation and attached-keyboard use need review. |
| 1.3.5 Input purpose | AA | Partially supports | Axe, Inspection, Person | Sign-in fields declare password-manager autocomplete purposes; supported assistive technology has not been tried. |
| 1.4.1 Use of color | A | Partially supports | Axe, Inspection, Person | Links are underlined and outcomes have symbols or text; the meaning of every visual signal still needs review. |
| 1.4.2 Audio control | A | Not applicable | Inspection | The application plays no audio. |
| 1.4.3 Minimum contrast | AA | Partially supports | Axe, Script, Person | Both themes pass reported contrast violations and scripted badge contrast; incomplete contrast results still require visual assessment. |
| 1.4.4 Resize text | AA | Not evaluated | Person | Text at 200 percent zoom has not been assessed across every state. |
| 1.4.5 Images of text | AA | Supports | Inspection | Application text uses HTML text; the logo is the applicable exception. |
| 1.4.10 Reflow | AA | Not evaluated | Script, Person | Phone states are scanned at 390 CSS pixels; 320 CSS pixels and desktop zoom still need review. |
| 1.4.11 Non-text contrast | AA | Not evaluated | Person | Control boundaries, proof marks, and focus indicators need a separate contrast assessment. |
| 1.4.12 Text spacing | AA | Not evaluated | Person | Overrides for line, word, letter, and paragraph spacing have not been assessed. |
| 1.4.13 Hover or focus content | AA | Not evaluated | Person | Tooltips and any content revealed on focus need a dismissal and persistence review. |
| 2.1.1 Keyboard | A | Partially supports | Script, Person | Tab reaches scanned controls and radio arrows work; complete tasks with a screen reader remain untested. |
| 2.1.2 No keyboard trap | A | Supports | Script | Tab traverses the scanned controls and Escape exits the palette, keyboard sheet, and sign-out dialog. |
| 2.1.4 Character key shortcuts | A | Does not support | Inspection | Global single-character shortcuts have no off switch or remapping option. |
| 2.2.1 Timing adjustable | A | Not evaluated | Person | Session expiry, draft sealing, and recovery during a longer task need assessment. |
| 2.2.2 Pause, stop, hide | A | Not evaluated | Person | Automatically refreshed lists and announcements need review during reading and editing. |
| 2.3.1 Flashes | A | Supports | Inspection | First-party controls contain no flashing content. |
| 2.4.1 Bypass blocks | A | Not evaluated | Person | Assess bypassing repeated sidebar content with screen-reader landmarks and keyboard navigation. |
| 2.4.2 Page title | A | Partially supports | Axe, Person | The document names Mainworthy; whether the current screen and case are sufficiently identified needs review. |
| 2.4.3 Focus order | A | Not evaluated | Script, Person | Traversal reaches controls; logical order, restoration, and phone pane changes need human assessment. |
| 2.4.4 Link purpose | A | Not evaluated | Axe, Person | Links have accessible names; their purpose in a screen-reader links list needs review. |
| 2.4.5 Multiple ways | AA | Partially supports | Inspection, Person | Navigation, search, palette, and direct addresses exist; a person must assess their coverage. |
| 2.4.6 Headings and labels | AA | Not evaluated | Axe, Person | Automated naming checks pass; clarity and heading structure still need review. |
| 2.4.7 Visible focus | AA | Supports | Script | Keyboard-focused controls have an outline or the filter wrapper's visible focus treatment. |
| 2.4.11 Focus not obscured | AA | Supports | Script | Focused controls have an exposed portion after scroll clipping, including phone proposal links. |
| 2.5.1 Pointer gestures | A | Supports | Inspection | First-party actions do not require multipoint or path-based gestures. |
| 2.5.2 Pointer cancellation | A | Not evaluated | Person | Cancellation of pointer actions across forms and drag operations has not been assessed. |
| 2.5.3 Label in name | A | Partially supports | Axe, Person | Automated label-in-name checks pass; speech-input commands need human testing. |
| 2.5.4 Motion actuation | A | Not applicable | Inspection | No action uses device or user motion. |
| 2.5.7 Dragging movements | AA | Not evaluated | Person | Folder moves have keyboard and palette alternatives; their full equivalence needs a task-based check. |
| 2.5.8 Minimum target size | AA | Supports | Axe, Script | Scanned targets meet 24 by 24 CSS pixels, including label targets, with the inline-link exception. |
| 3.1.1 Page language | A | Supports | Axe | The document declares English. |
| 3.1.2 Language of parts | AA | Not evaluated | Person | First-party wording is English; handling mixed-language case content needs review. |
| 3.2.1 On focus | A | Not evaluated | Script, Person | Phone focus can reveal another pane; a person must assess whether these changes preserve context. |
| 3.2.2 On input | A | Not evaluated | Person | Immediate select actions, autosave, and proposal submission need a predictability assessment. |
| 3.2.3 Consistent navigation | AA | Partially supports | Inspection, Person | Screens share the shell and navigation order; screen-reader navigation has not been assessed. |
| 3.2.4 Consistent identification | AA | Not evaluated | Person | Review controls that perform the same action in different screens. |
| 3.2.6 Consistent help | A | Partially supports | Inspection, Person | Docs and keyboard help use shared shell controls; assess their accessibility in each layout. |
| 3.3.1 Error identification | A | Not evaluated | Axe, Person | Error regions and labels are present; announcement and recovery need screen-reader tests. |
| 3.3.2 Labels or instructions | A | Not evaluated | Axe, Person | Forms pass automated name checks; a person must assess instructions and required-field cues. |
| 3.3.3 Error suggestions | AA | Not evaluated | Person | Try invalid credentials, invitation passwords, policy clauses, and conflicting case edits. |
| 3.3.4 Error prevention | AA | Not evaluated | Person | Confirm destructive operations and recovery without relying on visual confirmation. |
| 3.3.7 Redundant entry | A | Not evaluated | Person | Check repeated information across invitations, password changes, and case workflows. |
| 3.3.8 Accessible authentication | AA | Not evaluated | Inspection, Person | Password managers, paste, and passkeys are supported in code; real assistive-technology sign-in remains untested. |
| 4.1.2 Name, role, value | A | Not evaluated | Axe, Person | Axe passes names and roles; list selection, editor updates, and expanded states need screen-reader confirmation. |
| 4.1.3 Status messages | AA | Not evaluated | Script, Person | A real proposal updates a polite, atomic status region; speech, interruptions, and repeated messages have not been heard. |

## Manual assessment still needed

Use current Safari with VoiceOver on macOS and current Firefox or Chrome with NVDA on Windows. Record browser,
screen-reader version, theme, zoom, input method, criterion, steps, and result. A successful automated run is not
a substitute for these checks.

1. Sign in with a password manager and a passkey. Accept and recover an invitation. Try mismatched passwords,
   expired links, and an interrupted sign-in. Check names, descriptions, errors, paste, and focus after refusal.
2. Navigate every shell destination by landmarks, headings, links, and controls. Find a case through the palette
   and filter. Open the keyboard sheet, leave with Escape, and verify focus restoration. Check speech-input use
   alongside the global character shortcuts, whose missing off switch is a known gap.
3. Read and answer each queue kind. Hear the evidence, selected and checked rows, reason requirements, outcome,
   undo, and stale evidence. Select several rows and confirm that their state and the resulting status are clear.
4. Create, read, edit, and propose a case. Traverse steps, expected results, tags, proof, attachments, timeline,
   and version diffs. Resolve a same-field conflict and verify that saved and unsaved content can be distinguished.
5. Plan a run, record pass and failure, enter a note, attach a file, change a result, and inspect a closed run.
   Review Changes, the gate, and every Settings form, including recovery, teams, tokens, sessions, and forgetting.
6. On a phone and with an attached keyboard, open and leave the menu, palette, list, and detail. Rotate the
   device. Verify that covered content is not announced as if it were visible and that the proposal link stays visible.
7. Check both themes at 200 percent text size, 400 percent zoom, and 320 CSS pixels. Apply WCAG text-spacing
   overrides. Check high-contrast settings, non-text contrast, long names, dense lists, and every incomplete
   axe result from `manual-checks.json`.
8. Hear success, failure, background refresh, repeated identical statuses, and undo while focus stays in a form.
   Confirm that announcements are complete and do not interrupt reading. Repeat after a session expires and
   after a temporary connection failure.

Keep [issue #47](https://github.com/endqwerty/mainworthy/issues/47) open until those results and any resulting
fixes have independent review.

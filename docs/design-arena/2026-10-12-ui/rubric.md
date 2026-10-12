# UI arena: rubric (judge only; candidates did not see this)

Score each criterion 1 to 5 for each candidate (u1, u2, u3) with one or two sentences of evidence you checked yourself. Drive each mock in headless Chromium (`chromium --headless`, over the DevTools protocol or with a small script); do not judge from the source or the screenshots alone, and do not trust the keystroke counts in the rationales: replay J1, J5 and D2 yourself and report your counts.

1. **Capture (J1).** `c` puts the caret in a new case at once; Enter makes steps; ` > ` or Tab starts the expected result; a pasted list becomes steps with expected results split off; inline `#tag`. Zero dialogs, no required field. Keystrokes beyond the text itself.
2. **Density and scale.** 2,000 cases stay smooth (measure scroll or key-to-paint if you can). How many cases, with their proof strips, fit on a 1280x800 and a 1440x900 screen without clutter? Does the layout jump?
3. **Triage (D2).** Twenty mixed questions by keyboard: one key per answer, evidence visible without leaving the list, the consequence of each answer clear before pressing, undo. Count keystrokes and note any place a person must stop and read to know what a key will do.
4. **Run cockpit (J5).** Opens on the first unfilled slot, next case already rendered, slots filled by CI or an agent shown as such and skipped, the fail-with-note flow.
5. **Honest state.** Draft versus version shown without ceremony (the owner asked for this decision to be made with Confluence's publish-versus-live-edit friction in mind); person, pipeline and agent distinguishable everywhere; an agent's change easy to tell apart from a person's and easy to accept or reject (the owner: "making human changes significantly more important is a good UX").
6. **A product a team would choose.** Typography, hierarchy, calm, contrast, visible focus, light and dark. Compared with TestRail and Qase as you know them: would this win a side-by-side?

Then:

A. Which candidate should be the base of the real UI, and why that one is the easiest to extend to the screens not mocked (a change/PR page, a policy page, requirements)?
B. From each of the other two: the one or two things worth grafting into the base, concretely (which screen, which element).
C. Anything all three got wrong or missed.
D. The draft-versus-version decision you would ship, in three sentences.

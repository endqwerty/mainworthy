# UI arena brief (every candidate gets this file, plus one seed lens)

You are one of several independent candidates designing the web UI of
**Casebook**, a test case management system. Do not look at other candidates'
directories. You produce a working interactive mock, not pictures.

## Read first (in the repository, read-only)

Repository: `/home/endqwerty/.t3/worktrees/casebook/t3-639b4b0f`. Do not write
anything inside it.

- `docs/product-design.md`: sections 1, 4.1, 5.1, 5.4 and 8 (thesis, the
  Linear move, quickstart, author/lead/executor call sites, product surface).
- `docs/decisions/0007-guiding-principles.md`: P0, P1, P4 and the floor F2.
- `docs/ux/flows.md`: F2 (capture), F4 (run), F5 (triage).

## What the owner said (2026-10-11), which outranks the docs

- The job to make fastest is getting what is in a tester's head into an
  artifact. The brain never waits for the app.
- Home is the suite (where you write) for now; later users will customise
  their home.
- Draft versus published: think about Confluence. Its classic editor has an
  explicit Publish step, so people forget to publish and others read stale
  pages; its live docs publish every keystroke, so half-typed edits are live
  and history is noise. Casebook autosaves into a private draft and makes a
  version when the author leaves the case, presses an explicit key, or idles.
  Show that state honestly and without ceremony. This is a UX decision; make
  it and defend it.
- Flexibility comes later. The MVP builds the basics well.
- Human edits matter more than agent edits; an agent's change must be easy to
  tell apart and easy to accept or reject.

## The artifact

Write exactly these files in your own output directory (given in your seed):

1. `index.html`: one self-contained file. Inline CSS and JavaScript, no
   network requests, no build step, no framework CDN. It must work when opened
   as a `file://` URL in Chromium. Fake data generated in JavaScript with a
   fixed seed: about 2,000 cases in about 40 nested folders, 30 open questions
   of mixed kinds (failure, agent finding, agent proposal, unlinked test), one
   planned run with 40 slots (25 already filled by CI, 2 by an agent), three
   producers (person, pipeline, agent) distinguishable everywhere.
2. `rationale.md` (at most 150 lines): the design direction in three
   sentences; what you rejected and why; where it beats TestRail and Qase on
   friction; keystroke counts for the three jobs below, counted on your mock;
   the draft-versus-version decision; open risks; what should change for
   1,000,000 results or 50 users.

The mock must really do these things (state changes in memory, nothing
persisted):

- **Suite and capture (the hot path).** `c` creates a case with the caret in
  the title on the same frame. Enter starts steps; each Enter is the next
  step; ` > ` (or Tab) starts the expected result of a step; pasting several
  lines makes several steps and splits `=>`, `>` or `Expected:` into the
  expected result. Inline `#tag`. No modal, no save button, no required field.
  The list must stay smooth with 2,000 rows (virtualise or window it).
- **Case.** Body editable in place; a timeline of versions (with a readable
  step-level diff between two versions), results from the three producers and
  questions the case is part of. The draft state is visible.
- **Queue.** One list of everything that needs a human answer. `j`/`k` move,
  one key answers (`d` defect, `f` flaky, `i` infrastructure, `e` expected for
  a failure; `a` accept, `r` reject for a proposal or finding; `l` link, `t`
  track for an unlinked test), the row leaves, `u` undoes. Space peeks the
  evidence without leaving the list.
- **Run cockpit.** Opens on the first unfilled slot. `p` pass, `f` fail (caret
  lands in a note), `b` blocked, `s` skip; the next case is already rendered.
  Slots filled by CI or an agent are shown as such and skipped.
- **Navigation.** `g s` suite, `g q` queue, `g r` runs, `/` search, Ctrl+K or
  Cmd+K a command palette that reaches every object and action. Short ids
  (`C-311`, `Q-12`, `R-4`) everywhere. A `?` overlay listing the keys.
- Each case row shows a **proof strip**: one glyph per producer with the
  latest outcome and age (for example `H ✓ 2d  C ✗ 1h  A ·`).
- Light and dark, following `prefers-color-scheme`, with a visible toggle.
- Readable at 1280x800 and at 1920x1080. Real typography and spacing: this is
  judged as a product a team would choose over the incumbents, not as a
  wireframe.

Jobs to count keystrokes for, on your mock:

- J1: create a case with a title and six steps, three of which have an
  expected result, tagged `checkout`.
- J5: record ten results in the run (eight pass, one fail with a short note,
  one blocked).
- D2: answer twenty mixed questions in the queue.

## Rules

- Quality over breadth: if you run short of time, cut a screen before you
  ship a broken hot path. Say what you cut.
- Check your own work: open the file in headless Chromium
  (`chromium --headless --screenshot=<file>.png --window-size=1440,900 file://...`)
  and save `suite.png`, `queue.png`, `run.png` and `case.png` in your output
  directory (use a URL hash such as `#queue` to open a screen directly). Look
  at the screenshots and fix what looks wrong. No JavaScript errors in the
  console.
- Time box: stop and write `rationale.md` no later than the deadline in your
  seed (check `date`). A complete smaller mock beats an unfinished larger one.
- Final message: the paths you wrote, what works, what is cut, and the three
  keystroke counts.

# 0011: UI direction: the workbench frame with the document as its case pane

- Date: 2026-10-12
- Status: proposed (Daniel reviews the screenshots and the running product)

Daniel recommended several designs before building, so the work does not go far down the wrong one. Three
candidates each built an interactive mock of the hot paths from one brief with a different starting lens. The
material is in `docs/design-arena/2026-10-12-ui/`: the brief, the judge-only rubric, each mock with its
rationale and screenshots, and the judge's verdict with its evidence.

## The arena

| Candidate | Lens | Model | Judge's score (of 30) |
| --- | --- | --- | --- |
| u1 | one outline: the suite is one folded document | GPT 6.1 Sol | 20 |
| u2 | the workbench: sidebar, dense list, pane | Claude Opus 5.5 | 22 |
| u3 | the document: a calm page you type into | GPT 6.1 Sol | 22 |

A fourth seat (Gemini, through Antigravity) dropped out: the tool is not installed on this machine.

The cross-judge was GPT 6 Astra, a different model family from the lead. It drove each mock in headless
Chromium with real key events, replayed the three jobs itself and took 48 screenshots. What it measured:

| Job (identical text on each mock) | u1 | u2 | u3 |
| --- | --- | --- | --- |
| J1: a case with six steps, three expected results and a tag | 134 keys | 134 | 134 |
| J5: ten results in a run, one failure with a note | 25 | 25 | 25 |
| D2: twenty mixed questions | 22 | 22 | 22 |
| Cases with proof strips visible at 1280x800 / 1440x900 | 9 / 11 | 21 / 24 | 6 / 7 |

Keystrokes do not separate the designs; the mechanics converged. **Density does**, by a factor of three. All
three put the caret in a new case within one frame of `c` (about 16 ms to the next paint, on a busy machine,
so not a p95 claim).

## Decision

**The frame is u2's workbench: a sidebar, a dense virtual list of 32 px rows with aligned proof-strip columns,
and a pane. The pane is u3's document.** Grafts, each named by the judge:

1. From u3: the case is written in one place. On `c` the row appears in the list and the caret goes to the title
   in the document pane; the row mirrors the text. u2 put the title caret in the list row and the steps in the
   pane, which costs an eye movement on every new case.
2. From u3: in a run, the complete next case is already rendered; the node that was "next" becomes "current".
3. From u1: Pass, Fail, Blocked and Skip and the failure note sit in a footer fixed inside the run document, and
   an "Up next" card shows what follows.
4. From u2: each answer in the queue is a card with its key, its name and one sentence saying what it does.
   The sentences are declared once (`ANSWER_HELP` in `src/core/kinds.ts`) and shared with the CLI.
5. From u1 and u3: a failure of the shape "expected X, got Y" shows the two values side by side.

## Where the lead and the judge disagreed

The judge recommended **u3 as the base**. u2 and u3 tied on points and it broke the tie on principle P0: in
u2's mock, undoing an accepted proposal deleted the accepted version and the answer, and u3's kept both.

The lead kept u2's frame. That tie-break is about how each mock's fake data behaved. In the product the
record is the server's: a decision is superseded and never deleted, an adopted version stays in the history, and
a test proves it (`test/evidence.test.ts`, `test/policy.test.ts`). No layout can break it. What a layout does
decide is how much of the suite a person sees, and there the judge's own numbers favour u2 three to one; its
graft list already replaces u3's index with u2's rows. The two positions differ in name more than in result:
both end at dense rows beside a document pane. The lead's version keeps the persistent folder tree (on the
Suite screen only), because moving cases between folders is the spatial part of the job.

The judge's other findings are taken as requirements, not opinions:

- **No stale proof.** One mock showed a green tick for a version that was no longer current until the user
  navigated away. In the product a new version changes the row's proof strip in the same update as the version
  badge. There is a browser test for it.
- **Nothing a key acts on is clipped at 1280x800.** Two mocks hid answer buttons or evidence below a pane edge.
- **Undo appends.** It never removes a later human edit.

## Draft versus version (open question 23)

Daniel pointed at Confluence. Its classic editor has an explicit Publish step: people forget it, and others
read a stale page. Its live docs publish every keystroke: half a sentence is live, and history is noise.

Casebook does neither. Typing saves at once into a private draft on the author's device, and the pane says so
in one line ("Draft, saved on this device. Others see version 3."). The draft becomes a version when the author
leaves the case, presses Ctrl+Enter or Cmd+Enter, or stops typing for 30 seconds. There is no button to
forget, and nobody sees half a sentence. An unchanged draft makes no version. In the timeline, consecutive
versions by one author within ten minutes are shown as one group; the data keeps every version.

Not settled by a mock (the judge's point, and it is right): thirty seconds of silence does not prove a thought
is finished. The number is a setting to tune on real use (#35).

An agent's change is never a draft of yours: it is a proposal with its own author, shown as a card with its
diff and `a` / `r`. It cannot replace an open human draft; if both touched the same field, the person's seal
wins the field and the conflict is shown.

## Front-end stack (part of decision 0010)

React 19 and TypeScript, bundled by Bun from `src/web/index.html`; plain CSS with custom properties taken from
the mock; TanStack Query for the cache and optimistic writes, TanStack Virtual for the lists. No Vite, no
Tailwind, no component library. `src/web` imports only `src/core`, so the editor runs the same outline parser,
Markdown printer and diff as the server.

React over Solid or Svelte: Bun bundles it with no plugin, it has the most worked examples for an agent to
copy correctly, and the latency budget (key to paint within 100 ms at p95 on 10,000 cases) is a browser test
in the check. If that test cannot be met with React, this choice is reopened with the measurement.

## What this does not establish

- Not a comparison with TestRail or Qase on a real task. Both already document title-and-Enter quick creation;
  the judge checked their public docs only. Floor item F3 gates 1.0 (#39).
- Not accessibility (#47), not IME input, not browsers other than Chromium.
- The mocks proved mechanics on seeded data. Whether the real UI meets the budgets is what its own tests say.

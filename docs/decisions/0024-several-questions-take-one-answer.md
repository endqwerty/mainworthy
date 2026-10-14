# 0024: Several questions of one kind take one answer

- Date: 2026-10-14
- Status: proposed (built in the pull request that adds this file; the owner reviews)

The owner asked for a way to select several rows in the Queue and act on them together. Decision 0021 had left it
open ("one answer for several rows"), and `mainworthy seed` keeps sixty unlinked rows for it. Half of it was
there: `x` marked the question shown, an answer then went to every marked question in one `decide`
request, and `u` withdrew them all. It was hard to find: only the keyboard page mentioned it, a mark was a
check mark 8 px wide, and there was no way to select with the mouse, to select a range or all of a kind, or to
clear the selection except by answering or switching tabs.

## Decision

**What is selected is visible and can be changed with the mouse.** Each open row starts with a box. A click on the
box adds the row to the selection or takes it out, and a click anywhere else on the row opens it, as before.
Shift and a click select every row from the last one selected or cleared; `⌘` or Ctrl and a click act as
the box. `*` selects every listed question of the selection's kind (or of the question shown) and, once all
are selected, clears them. A bar above the list counts the selection and has buttons for both; `Esc`
clears it.

**A selection is of one kind, and holds only questions you can settle.** One answer has to mean the same thing to
each question it goes to, and the answers of two kinds share keys with different meanings (`a` accepts a
proposal and approves a sign-off). A question the policy does not let you answer is refused when you select it,
with the reason on the status line, instead of when you answer. So is a proposal, and a finding that suggests an
edit: an answer to one counts only once its edits have been read on screen (`questionReadMessage`), and only the
question shown has them there. The first review of this change found that a selection of proposals could be made
and then never answered.

**The answers are the selection's.** While a selection exists, the answers under the evidence and their keys are
those of the selection's kind, and each is offered only when every selected question takes it ("Already failing
on base" is not offered for a selection that holds a failure on trunk). The question shown can be outside the
selection, for reading one before adding it; the line above the answers says so. "Link to a case" asks for a case
for each test of each question, so it is given to one question at a time. Advice is about the question shown, so
`Enter` (take advice) does nothing while a selection exists and says so; before, it gave the shown question's
advice, a link's pairs included, to every selected question.

**Nothing changes on the server.** `decide` already took up to 500 answers in one command, and each question gets
its own decision, so a withdrawal, a carried answer and the ledger work as they did. A question that is refused
(its evidence changed while the selection was made) comes back to the list and the rest stay answered.

**A phone selects from the palette.** Decision 0018: a screen adds no touch control for what a key does. On a phone
the rows have no box and the bar has no buttons. "Select question", "Select all of this kind" and "Clear
selection" are in **Actions** once a question is open, as every key of the screen is.

## Turned down

- **A checkbox element inside each row.** A row is a button (`ListRow`), and a control inside a button is not
  valid HTML; a checkbox beside it would sit in a listbox that should hold only its options. The box is drawn in
  the row and the row's click looks at where it landed.
- **A selection of several kinds, answered kind by kind.** It saves nothing: each kind still needs its own answer,
  and a key would mean different things to different rows.
- **Select all across pages.** "Select all" takes what is listed (a page holds 100). A question that is not listed
  has not been seen, and the status line says when more are not listed yet. A selection holds at most 500, the
  most one `decide` request carries (`DECIDE_MAX`); the review bot on the pull request found that six loaded
  pages made a selection the server refused whole.
- **Splitting a larger selection into several requests.** A request that fails part way would leave some answered
  and some not, under one undo. Five hundred is more than a person checks by eye.
- **Answering several proposals at once.** It would need the queue to show every selected proposal's edits, or
  to trust that a person read them on another visit. Neither is built.
- **Withdrawing several settled answers at once.** `u` already withdraws every question of the last answer.
  Withdrawing a selection in "Settled" can come later if it is wanted.

# 0021: What happens to a test with no case is a setting, and `standard` tracks them

- Date: 2026-10-13
- Status: accepted (the owner agreed the direction in the thread that built it, 2026-10-13)

A day after this repository's CI began to report to the instance, the queue of project `mainworthy` held 105
open questions. One was a failure. The other 104 said "N tests in `<file>` have no case", covered 1,786 tests,
and blocked nothing. The owner opened the queue and could not tell what it wanted from them.

The project ran under `standard`, which bundled two things: an agent's edit waits for a person, and every test
file with no case is a question. Whoever wanted the first got the second. The second is one choice for a whole
project ("do our automated tests need cases?"), and the preset asked it once per file, again whenever a file
gained a test. 72 rows opened with the first report and 32 more in the next 13 hours.

## Decision

**What happens to a test with no case is a setting of the policy, `unlinked`, with three values.** `track`: the
test is kept without a case and nobody is asked. `create`: a case is made for each test and linked to it, which
is what Qase's "auto-create test cases" does and what the owner's team uses there. `ask`: one question per file,
as `standard` did. `loose` and `standard` start at `track`, `strict` at `ask`.

**The setting is read by clauses.** Two predicates, `unlinked:track` and `unlinked:create`, test it. Every
preset has the same three `map` clauses: a rule that tracks, a rule that creates, and the clause that says who
is asked. So the clause table still says everything about who answers, `mainworthy policy show` prints the
rule that will answer, and a preset stays a preset whatever the setting is (as it does for the flaky hold).

**Changing the setting answers the open questions about files at once.** The next report that named a file
would hand its question to the rule anyway; done at the change, whoever made it sees the queue as the new
policy leaves it. This is for `map` questions only. A proposal or a passed run that waited for a person under
the old policy still waits for one under the new: no later report asks about those again, so answering them by
rule would be a new outcome, and nobody asked for it.

**A link holds for the tests it names.** Before, a `map` decision held until the file's set of tests with no
case changed. A new test in a file therefore withdrew the decision that had linked its other tests, and the
links with it. With `create` every new test would have made each case of its file a second time. A link or a
created case now uses the hold term that "The failure was a mistake" uses: it does not carry to what is
reported later, and what is reported later does not undo it. "Track" keeps the old term.

**Overruling takes a rule.** A person who answers against a rule keeps the question with people the next time
too. A person who answered while the policy asked people overruled nothing, so a rule the policy gets later
answers that file's next question. The signature on a decision names the clause it was given under, and that
is what tells the two apart.

## What `create` gives up

Decision 0014 says a pipeline never changes the suite. Under `create` a report adds cases: one for each test
name it sends, authored by the reporter and adopted by the rule. It still cannot change or remove a case, and
an admin of the project has to choose `create` first. Where the policy has a person adopt new cases the rule
makes none: `strict` refuses the setting, and under `standard` an agent's report leaves the file's question
open.

## Turned down

- **A setting that overrides the clause table.** Smaller, and then two things route a question: the table
  would say "a member" while the setting tracked.
- **A Settings control that rewrites the one `map` clause.** One mechanism, but every project that used it
  would read as `custom`, and Settings hides its controls for a custom policy.
- **Letting the new policy's rules answer every open question**, proposals and passed runs included. See
  above.
- **Moving the stored policies to the new clauses at start-up.** A policy is standing and changes only through
  a decision. A project made before this keeps its clauses and is listed as `custom` until its admin chooses
  the preset again.
- **Taking the questions out of the queue.** The first proposal. The owner kept them there: a test with no
  case is worth resolving, only not ahead of a failure, and not once per file by hand.

## Not done

- Withdrawing a link made before its file gained tests leaves two open questions about that file, the old one
  with the tests it listed then. Either can be answered; the other is then answered with nothing left to do.
- One answer for several rows in the queue ("answer all of these"). The owner is thinking about its form; the
  demo data keeps enough of these rows to try it on. Built on 2026-10-14: decision 0024.

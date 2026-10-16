# 0088. The iPhone answers a selection, and shows results and tests

Date: 2026-10-16. Asked by the owner in a thread; follows decisions 0024, 0074 and 0087.

## Problem

The owner asked for four things in the iPhone app:

- It showed neither the results behind a change's gate nor the Tests screen (decision 0087, "Not done"), so a
  test tracked without a case could not be seen on the phone at all.
- The queue answered one question at a time, from its page. Sixty unlinked tests took sixty visits.
- A case's row ended in a green tick that said nothing of whose result it was or that it was the worst of
  several.
- "Who may run it" on a case's page was a comma-separated list of words.

## Decision

**Results and tests read what the web reads.** A change's page gets **Results** from `find --in results`, with the
tally's counts as filters and a text filter, a hundred rows a page. A page refused because the results changed
(`conflict`, decision 0087) reads the first page again. **Cases** gets **Automated tests** from `find --in
tests`, with **Only tests with no case**, and a test's page from `get T-n`. The three replies are in the app's
contract (`scripts/ios/contract.ts`), held to real replies by `test/ios-contract.test.ts`. Nothing changes on the
server.

**A selection follows decision 0024.** One kind; nothing the policy forbids; no proposal and no finding with a
suggested edit, whose content is read on its own page before an answer counts; no question with an answer still
waiting to send. Only the answers every selected question takes are offered, and not **Link to a case**, which
needs a case for each test. A selection holds at most 100 questions.

**Each answer of a selection is its own saved answer.** The app saves one answer per question in the device's
outbox (decision 0074) and sends them in order, each with its own command id, its question's evidence and
`ifOpen`. Each question gets its own decision and its own outcome in **Unsent answers**, and **Undo** withdraws
the ones that were decided. An answer goes on the questions as they were shown when the person chose it: the
confirmation keeps them, and a question whose evidence changed behind it is refused by the server and named,
never answered on evidence nobody saw (the verifier's first finding of 2026-10-16).

**Results are the shown gate's.** The Results panel reads by the run that the gate on the page names, not by the
change, so a report of a newer head between the two reads cannot put that head's results under the older head's
verdict (the verifier's third finding). A read of the page that finds another run makes a new panel.

## Turned down

- **One `decide` request with `all`, as the web sends** (decision 0024 turned down splitting for the web). The
  outbox saves, replays and recovers one answer per command, and its rules for a lost reply took several rounds
  of review (decision 0074, issue #321). One command for many questions would need an entry with an outcome for
  each question and new rules for dropping it. The web's reason against splitting, that a request failing part
  way leaves some questions answered under one undo, mostly holds on the phone either way: the server decides
  each question of an `all` request on its own too, and refuses one whose evidence changed while it decides the
  rest. The difference is an unexpected failure inside the server, which rolls back the whole of one `all`
  request but only the answer it hit when each is sent alone; the phone then shows that one as waiting or
  refused and the rest as recorded. The cost is one request per question, which is why a selection
  holds 100 and not the 500 one request carries.
- **SwiftUI's own edit mode for the list.** Its selection gives no way to say why a row cannot join, and a
  disabled row is silent when pressed.
- **One mark for a case's results.** The chips say who ran it and what came of it in words, as the web's proof
  strip does with letters; a single mark had to pick one result and hid whose it was.

## Not done

- A test's page lists its last twenty results, as on the web.
- Creating cases from a selection goes through the outbox like every other answer; creating them from one
  question's page keeps its preview sheet, which needs a connection.

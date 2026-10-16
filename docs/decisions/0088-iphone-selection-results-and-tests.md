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

The first version of this change sent a selection as one request per question. The owner pointed out that a bulk
interface cannot scale that way, and an architecture review (two independent designs, Claude and GPT-6.1-Sol on
2026-10-16) agreed on the shape below.

## Decision

**Results and tests read what the web reads.** A change's page gets **Results** from `find --in results`, with the
tally's counts as filters and a text filter, a hundred rows a page. A page refused because the results changed
(`conflict`, decision 0087) reads the first page again. **Cases** gets **Automated tests** from `find --in
tests`, with **Only tests with no case**, and a test's page from `get T-n`. The three replies are in the app's
contract (`scripts/ios/contract.ts`), held to real replies by `test/ios-contract.test.ts`. One `PagedList` owns
the paging of both lists: the query its rows answer, the next cursor, and which read may still change them, so a
page of one query is never added to another's rows and asking for more never discards a read of the list again.
Only the test pages that are open are read again when the project changes.

**A selection follows decision 0024.** One kind; nothing the policy forbids; no proposal and no finding with a
suggested edit, whose content is read on its own page before an answer counts; no question with an answer still
waiting to send. Only the answers every selected question takes are offered, and not **Link to a case**, which
needs a case for each test. A selection holds at most what one `decide` request carries, `DECIDE_MAX` (500),
which the iOS generator writes from `src/core/ops.ts`.

**One answer is one saved command, whatever it answers.** A saved answer (`PreparedAnswer`) answers one or more
questions: one `decide` request with `all`, under one command id, each question on the evidence the person saw and
with `ifOpen`. An answer to one question is the same thing with one member, so there is one way to answer. The
device's outbox (decision 0074) keeps its rules for the whole command: it is saved before it is sent, replayed
under the same id, left waiting on a lost or unreadable reply, and dropped whole. The server's reply says what
became of each question, and the outbox keeps an outcome per question: the reply must name every question once
and no other, or it is unreadable and the answer stays as uncertain as it was. A question that is refused or
was decided meanwhile is named; the others are decided. `AnswerOutbox.record` is the one call a screen makes:
it prepares, saves and sends, and returns the saved answer once its attempt has an outcome. A question with an
answer still waiting is not answered again, and a command is admitted whole or not at all.

An answer saved by an earlier build answers one question with the `decide` input of that question alone. It is
read as an answer of one member and sent unchanged: the server ties a command id to its request, so the same id
with the request written as `all` would be refused as another command.

An answer goes on the questions as they were shown when the person chose it: the confirmation keeps them, and a
question whose evidence changed behind it is refused by the server and named, never answered on evidence nobody
saw (the verifier's first finding of 2026-10-16).

**The words are written once.** How a gate counts a result and its labels (`RESULT_STANDINGS`) and the ways a case
is run (`MethodKind`, `METHOD_LABELS`) are in `src/core`. The server and the web read them there, and the iOS
generator writes them as the Swift enums `ResultStanding` and `CaseMethod`, so a new one fails to compile where a
view has not said how to draw it.

**Results are the shown gate's.** The Results panel reads by the run that the gate on the page names, not by the
change, so a report of a newer head between the two reads cannot put that head's results under the older head's
verdict (the verifier's third finding). A read of the page that finds another run makes a new panel.

## Turned down

- **One saved answer per question, sent one after another** (this change's first version). Each question costs a
  request and a network round trip, and the device rewrote its saved file once per question. On the tests'
  server, with no network between, 500 answers took 142 ms as 500 requests and 26 ms as one (median of three
  runs each, alternated, every answer decided); on a phone each request also waits for the network. It also
  retried a blocked first answer once for every question selected after it (the architecture review's finding).
- **Splitting a selection into several commands of at most 500.** A parent of several commands needs partial
  progress, partial dropping and an undo across commands that may still arrive. Nothing here needs more than
  500 at once; if that changes, it is a job of its own, not a hidden split.
- **Coalescing saved per-question answers into one request when sending.** Each saved answer has its own command
  id and the request one: a command id would change after it was saved, and a lost reply could not be recovered.
- **SwiftUI's own edit mode for the list.** Its selection gives no way to say why a row cannot join, and a
  disabled row is silent when pressed.
- **One mark for a case's results.** The chips say who ran it and what came of it in words, as the web's proof
  strip does with letters; a single mark had to pick one result and hid whose it was.

## Not done

- **Undo of a selection withdraws one question at a time**, as the web's `u` does: `decide` has no withdrawal of
  several questions in one request. That changes the operation for every client and the MCP schema, so it is
  its own change (issue #351), done once for the web and the phone.
- A test's page lists its last twenty results, as on the web.
- Creating cases from a selection goes through the outbox like every other answer; creating them from one
  question's page keeps its preview sheet, which needs a connection.

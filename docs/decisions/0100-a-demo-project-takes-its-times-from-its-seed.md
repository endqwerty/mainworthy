# 0100: A demo project takes the time of a write from its caller, and no other project does

- Date: 2026-10-13
- Status: proposed (built in the pull request that adds it; the owner reviews)

The owner looked at a seeded project and saw the same case 400 times: `mainworthy seed` had five titles and one
body, and wrote everything in the minute it ran. They asked for many distinct cases made from a seed, grouped the
way a real product's suite is, and for runs and results that give the demo at least ten days of history.

The cases are a matter of content (`src/cli/demo/`). The history is not. Every row a write makes carries
`ctx.now`, which `makeCtx` reads from the server's clock, and no caller can say when something happened. A demo
that shows ten days needs writes dated in those days.

## Decision

**A project can be made a demo, and only a demo takes a time from a caller.** `admin` with `do: "project.demo"`
marks a project. The mark is a row in `demo_projects` with `since`, the moment it was made by the server's clock.
A project that holds a mark keeps it for good, and `project.list` and the session say which projects hold one.

**Only a project nothing was written to can be marked.** The test is the project's sequence number: it is 1 after
`createProject` and moves with every command. So a project that ever recorded real work never accepts a time from
a caller, and the times in it stay the server's. This is the fact the design rests on.

**The time travels beside the request, not in it.** `Call` in the registry has `at`. For a write to a demo it
becomes `ctx.now`. Anywhere else it is refused, not ignored: on a read, on an operation of the instance, on a
project that is no demo, and for a time after the server's clock. The check that the project is a demo is made
inside the write's transaction. HTTP reads the time from the header `X-Mainworthy-At` and passes it on; the
registry decides. No operation's input changes, so the generated commands and the agent tools do not offer a
field that a real project would refuse.

**A command id names the time too.** The digest of a request that carries a time covers the time. The same id at
another time is refused as another request, so a retry cannot quietly move a write.

**`since` is the day a seed counts back from.** `seed` asks for the mark first and dates everything before
`since`. A seed sent again gets the same `since`, sends the same times, and each command is recognised as a
retry. The anchor is the server's clock, so a client whose clock is ahead cannot ask for a time in the future.

**A report applied after a restart keeps the time it was accepted at.** `recoverAccepted` made a fresh context,
so the results of a recovered report were dated by the restart. It now passes the batch's own time. This holds
for every project: a report's request already applies with the time it was accepted at, and recovery now does
the same.

**An archive does not carry the mark.** `demo_projects` is in `UNEXPORTED`, so an export leaves it out and an
import empties it. An imported demo keeps its rows and their dates and accepts no more times. Exporting the table
would change what an archive holds, raise the archive version and refuse every archive taken before. An import
puts projects under the ids the archive gives them, so a mark left behind would pass to another project:
`removeBootstrap` deletes the mark of the first project it replaces, and a test imports over a marked one.

Migration `0009_demo_projects.sql` adds the mark at schema version 9 with `archive: false`. The archive version stays 7.

## What the seed writes

The plan is pure and comes from three numbers: the seed, the count of cases and the days
(`demoCases`, `demoHistory`). The executor (`src/cli/seed.ts`) replays it through `propose`, `report`, `plan`,
`claim` and `decide` as the owner, a pipeline and an agent, oldest first.

- **Cases** come from a catalog of 29 features in eight areas. A scenario is written once with slots (a card, a
  country, a carrier) and gives one case for each way to fill them. A feature that needs more cases repeats its
  scenarios for another browser, language or kind of customer, and names the axes that apply to it: an API case
  is never repeated for a browser. Shares follow a weight per feature.
- **The project is on `standard` from its first day**, and a person links each automated test to its case after
  the first report. The demo sets `unlinked: "ask"` explicitly: `standard` now tracks unlinked tests by default.
  The CLI also keeps main's sixty unit-test files with no case, each leaving a question.
- **History** is a nightly report on `main`, pull requests on working days, a planned run every other day, a few
  edits and two reviews by the agent. Failures are answered `defect`, `test` or `infra`. No answer is `flaky`: it
  ends after the policy's hold, which the sweeper compares with the real clock. An older answer could reopen
  its question a minute after the seed.
- **Today** is what the demo had before: `main` red on one test, pull request 482 with the same failure, a run
  planned on it, a finding, an agent's edit and a test with no case. Five questions, plus the CLI's sixty unit-test questions by default.

## Turned down

- **Generating the demo inside the server**, as one operation that calls the others with its own clock. One
  command has one sequence number and one actor, and a 100,000-case seed would hold the single writer for all of
  it. No time would cross the API, which is its merit.
- **An `at` field in the input of each write.** The same rule, shown in every generated flag table and agent tool
  for a field real projects refuse.
- **A clock stored per demo project that an admin moves.** A seed that stops halfway leaves the project in the
  past.
- **A mark on the token.** The owner's own token would need it too.
- **Exporting the mark.** Above.

A second model (GPT 6.1 Sol) reviewed the design before it was built. It kept the shape and found three things,
all in the decision above: the time has to be part of the command id, a recovered report has to keep its time,
and an answer that ends by the clock must stay out of the past.

## What this does not do

- The times of a demo's writes are not checked against each other. A caller that sends them out of order gets a
  project whose sequence and dates disagree. The seed sends them in order, and a test holds it to that.
- A verdict in the past is not frozen. A read compares a hold's end with the real clock, as it does everywhere.
- The history does not move. A demo seeded a month ago shows the fourteen days before that day.
- The web UI does not say that a project is a demo. `project.list` and the session do (`demo`), so a screen can.

# How it is built

A short look under the hood for people who run or extend Mainworthy: the parts, how a request travels through them, and the rules the design holds itself to. You do not need this page to use the product.

[Diagram: the surfaces, the operations and the record](../diagrams/architecture.html)

## One process, one file

An instance is one process and one SQLite file. The server, the web UI, the command line and the agent endpoint are a single executable. There is no second service to run and no database server to look after.

The file has one writer. A write waits its turn in a queue, and reads run on their own threads with read-only connections, so a long write never holds up a page. [Configuration](./configuration.md) says how many reader threads a server starts.

## One list of operations

Everything the product can do is one of sixteen operations, such as `propose`, `report`, `decide` and `gate`. The HTTP routes, the OpenAPI document, the commands of `mainworthy` and the agent tools are all made from that one list. A capability exists on every one of them or on none.

Each operation does the same things in the same order. It checks that the caller may run it. It checks the input. For a write it opens a transaction, takes the project's next sequence number, runs, commits, and tells listening clients what changed. [API and agent tools](./api.md) lists the operations.

## A record that only grows

Versions, results, answers and decisions are never updated. A correction is a new row that names the row it replaces.

Each project has one clock. Every write gets the next sequence number and stamps its rows with it. "What changed since I last looked" is one range read, and the number is the cursor an agent passes back.

## One way to change what is current

The head version of a case, the case a test belongs to, how a failure counts, whether a run is closed and the policy in force are the things Mainworthy treats as current. The code has exactly one way to change each of them: a function that needs proof of a recorded decision. The database refuses a row that cites a decision the record does not hold.

So no path through the product, and no bug that takes a shortcut, can change a verdict without a row that says who decided, on what evidence, under which clause of the policy. [How Mainworthy works](./concepts.md) explains what this means when you use it.

## What happens when a pipeline reports

[Diagram: one red build, from upload to a green gate](../diagrams/red-build.html)

1. `mainworthy report` reads the JUnit XML and the commit, branch and pull request from the CI environment.
2. The server stores the results first. From that moment the gate for the commit reads `pending`, so nobody is served the verdict from before the upload.
3. The server applies the results in slices of 200, so a report of ten thousand results does not freeze anyone's screen.
4. Each failure is reduced to its cause, and each cause raises one question, unless a decision about it still holds.
5. The verdict is worked out. When someone answers the question, it is worked out again in the same transaction.

## The rules are tests

The design rules are checked on every change: a module may not reach into another's tables, nothing but the decision code may change what is current, and the agent tools may not grow past ten. Each thing that must never happen, such as a green gate with nothing proven, has a test of its own. So does the speed of the paths people wait on.

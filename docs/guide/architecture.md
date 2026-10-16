# How it is built

Mainworthy runs as one server process with a SQLite database. This page explains how its operations record evidence and decisions, and which rules the tests hold the design to.

[Diagram: the surfaces, the operations and the record](../diagrams/architecture.html)

## One process, one file

An instance runs as one process. It keeps its records in one SQLite database and attachment bytes in a `blobs` directory beside it. The executable includes the server, the web UI, the command line, the documentation and the MCP endpoint. It needs no separate database server.

The database has one writer. Writes wait their turn in a queue. By default, reads use separate threads with read-only connections so they can continue during a long write. [Configuration](./configuration.md) says how many reader threads a server starts.

## One list of operations

The operation registry lists the product's operations, such as `propose`, `report`, `decide` and `gate`. The HTTP routes, the OpenAPI document, the commands of `mainworthy` and the agent tools all come from that list. Every operation is an HTTP route and a command. Ten of them, marked in the list, are also agent tools.

The registry checks the input and the caller's permission. A project write runs in a transaction with the project's next sequence number. After a commit, the server tells listening clients what changed. Some writes use more than one transaction. A report first commits its receipt, then applies its results. [API and agent tools](./api.md) lists the operations.

## A record that only grows

Case versions, observations and decisions retain their history. A correction records what it replaces instead of overwriting the earlier content. Automatic [demo refreshes](./customize.md#a-project-of-demo-data) replace the demo project's history at startup.

Each project has a sequence counter. A project transaction takes the next number and stamps its changes with it. Clients use that number as a cursor to read subsequent changes through `since`.

## One way to change what is current

The current case version, test links, failure classifications, run closure and policy are the state that decisions control. Functions that establish that state require proof of a recorded decision. Dedicated withdrawal handlers reverse a decision's effects when it ends. The database refuses a row that cites a decision the record does not hold.

The recorded decision names who decided, on what evidence and under which policy clause. Tests check that the modules use these writers. A verdict follows the evidence and the decisions still in force. It can also change when a decision's hold expires. [How Mainworthy works](./concepts.md) explains what this means when you use it.

## What happens when a pipeline reports

[Diagram: one red build, from upload to a green gate](../diagrams/red-build.html)

1. `mainworthy report` reads the JUnit XML and the commit, branch and pull request from the CI environment.
2. The server stores the report durably before applying it. From that moment the gate for the commit reads `pending` until application finishes.
3. The server applies the results in slices of 200 and yields between slices to answer other requests.
4. Mainworthy groups failures by cause. A cause on an open change raises a question unless a decision about it still holds. A planned run can also require an answer after the change ends.
5. The server computes the verdict. When someone answers a failure question, it computes the affected verdicts again in the same transaction.

## The rules are tests

Tests check the module boundaries, the writers that require proof of a decision, and the limit of ten agent tools. Gate tests check that a gate with nothing proven stays pending, unless the policy accepts a declaration that no tests were required. Latency tests check the paths people wait on.

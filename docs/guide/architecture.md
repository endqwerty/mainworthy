# How it is built

Mainworthy runs as one server process connected to PostgreSQL 18. This page explains how its operations record evidence and decisions, and which rules the tests hold the design to.

[Diagram: the surfaces, the operations and the record](../diagrams/architecture.html)

## One app process and PostgreSQL

An instance needs PostgreSQL 18 for structured records. The app keeps attachment bytes in `blobs/` under its data directory. The executable includes the server, web UI, command line, documentation and MCP endpoint. `compose.yaml` starts the app and its database. Running elsewhere is possible but not yet supported.

Writes lock the affected actor and project rows until commit. Different projects can write concurrently. Reports commit acceptance before application, then recheck the admitting credential and current authority. A revoked report is cancelled and stops holding runs pending. A lock wait that exceeds its bound returns retryable `busy`. Reads use separate connections and repeatable-read, read-only transactions. The registry rechecks authority in a fresh snapshot before sending a read reply. See [the API](./api.md) for retries and [configuration](./configuration.md) for connections.

## One list of operations

The operation registry lists the product's operations, such as `propose`, `report`, `decide` and `gate`. The HTTP routes, the OpenAPI document, the commands of `mainworthy` and the agent tools all come from that list. Every operation is an HTTP route and a command. Ten of them, marked in the list, are also agent tools.

The registry checks the input and the caller's permission. A project write runs in a transaction with the project's next sequence number. After a commit, the server tells listening clients what changed. Some writes use more than one transaction. A report first commits its receipt, then applies its results. [API and agent tools](./api.md) lists the operations.

## A record that only grows

Case versions, observations and decisions retain their history. A correction records what it replaces instead of overwriting the earlier content. Automatic [demo refreshes](./customize.md#a-project-of-demo-data) replace the demo project's history at startup.

Each project has a sequence counter. A project transaction takes the next number and stamps its changes with that number. Clients use that number as a cursor to read subsequent changes through `since`.

## One way to change what is current

The current case version, test links, failure classifications, run closure and policy are the state that decisions control. Functions that establish the current state require proof of a recorded decision. Dedicated withdrawal handlers reverse a decision's effects when it ends. The database refuses a row that cites a decision the record does not hold.

The recorded decision names who decided, on what evidence and under which policy clause. Tests check that the modules use these writers. A verdict follows the evidence and the decisions still in force. It can also change when a decision's hold expires. [How Mainworthy works](./concepts.md) explains what this means when you use it.

## What happens when a pipeline reports

[Diagram: one red build, from upload to a green gate](../diagrams/red-build.html)

A pipeline report goes through these stages.

1. `mainworthy report` reads the JUnit XML and the commit, branch and pull request from the CI environment.
2. The server stores the report durably before applying its results. The gate for the commit then reads `pending` until the server finishes applying those results.
3. The server applies the results in slices of 200 and yields between slices to answer other requests.
4. Mainworthy groups failures by cause. A cause on an open change raises a question unless a decision about it still holds. A planned run can also require an answer after the change ends.
5. The server computes the verdict. When someone answers a failure question, the server computes the affected verdicts again in the same transaction.

## The rules are tests

Tests check the module boundaries, the writers that require proof of a decision, and the limit of ten agent tools. Gate tests check that a gate with nothing proven stays pending, unless the policy accepts a declaration that no tests were required. Latency tests check the paths people wait on.

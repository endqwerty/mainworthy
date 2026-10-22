# 0139: A failed stream permission check closes the stream

Date: 2026-10-22. Builds on decision 0108.

Fixes [issue #621](https://github.com/endqwerty/mainworthy/issues/621).

Decision 0108 isolates change subscribers so a notification failure cannot change
a committed reply. If an HTTP stream's permission read threw, however, its stream
stayed open after missing the event. A connected client had no signal to reload.
The same permission check runs on a heartbeat, outside the publisher's handler.

The HTTP stream now catches permission-read failures, logs a fixed message without
the exception text, and closes through its existing cleanup. That unsubscribes the
stream and clears its heartbeat. A denied permission still closes the stream too.
The committed write and the other subscribers continue as before.

Closing uses recovery both clients already have. The web app reconnects after
checking its session and invalidates project reads when the stream opens. The
iPhone app finishes its change reader on EOF, retries, and refreshes its screens
on each attempt and after the stream opens. CLI and MCP replies do not consume
this stream. No operation, event schema or iPhone contract changes.

A new reload event would require a second recovery signal and changes in both
clients. Closing reuses their existing reconnect and reload behavior. It does not
add event replay. Reads and `since` remain the way to recover missed changes.

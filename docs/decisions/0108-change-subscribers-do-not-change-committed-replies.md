# 0108: Change subscribers do not change committed replies

Date: 2026-10-18

Fixes [issue #600](https://github.com/endqwerty/mainworthy/issues/600).

The registry publishes changes after committing them. Previously, a throwing
subscriber escaped into the registry's error handler, so a durable write could
return `internal` while its command was already `done`. A report could also stop
between acceptance and application because a subscriber threw after acceptance.

`App.publish` catches failures separately for each subscriber and continues
delivery to the remaining subscribers. It logs the sequence number without the
exception text, which may contain secrets. The committed reply stays successful,
and a report continues to its next transaction. Recovery jobs, tracker polling
and archive restoration use the same publisher and get the same isolation.

Catching only at the registry would still skip later subscribers and leave the
other publishers exposed. Per-subscriber isolation keeps that policy in the one
place that calls subscribers, without changing operations or client contracts.

Events remain best-effort hints. A failing subscriber may miss its own hint;
other subscribers receive it without waiting for a reconnect. A client recovers
missed changes by refetching or calling `since` with its last cursor. Connecting
to the stream does not replay events. The web app invalidates its project reads
when the stream opens, and its query client refetches stale reads on focus.

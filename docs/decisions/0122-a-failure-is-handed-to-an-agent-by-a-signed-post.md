# 0122: A failure is handed to an agent by a signed post

Date: 2026-10-20. Status: accepted.

The owner wants a failing test in CI to reach a coding agent with one tap, from a phone, and to start a new T3 Code thread that fixes it. Any agent should also be usable by hand.

A failure question therefore offers two things. **Copy for an agent** puts a brief on the clipboard, written by `failureBrief` in `src/core/handoff.ts`, for any agent a person pastes into. **Hand to the agent** is the `handoff` operation: the server posts the same brief, with the build link and the sample result's further output added, as JSON to one configured endpoint (`MAINWORTHY_HANDOFF_*`). A T3 Code webhook task that starts a thread per request is one such endpoint. Nothing in Mainworthy names T3 Code. Another receiver needs only to read the JSON and check the signature.

The endpoint lives in the server's configuration, not in the browser. A T3 Code webhook address is itself a credential that starts work on the owner's machine, so a page must never hold it. The post is signed with HMAC-SHA256 under a shared secret, which the receiver checks, so knowing the address is not enough to start an agent. Neither the address nor the secret is stored in the database.

A hand-off is a row in `handoffs`, queued inside the write and sent after it commits, outside the write gate, as tracker requests are (decision 0051). The row is what lets a phone show "sent" or why not after a reload, so the same failure is not handed off twice by accident. A send is tried once. A row still `sending` at start is marked failed, not sent again: it may have arrived, and a second post would start a second agent on the same failure. Archives leave the table out, so a restored instance starts no agent.

Handing off needs `answer`. Starting an agent on the owner's machine is a person's call about a question, like answering it. An agent or a pipeline holding `produce` cannot do it.

Turned down:

- **A link to the webhook in the page.** A link needs no server code, but it puts the webhook address in every reader's browser.
- **A tracker port.** A tracker returns an issue the server keeps reading. A hand-off returns nothing to read, so it would fill the tracker's shape with empty fields.
- **Fire and forget, as mail does.** With no row, a person on a phone cannot tell whether the agent was started.

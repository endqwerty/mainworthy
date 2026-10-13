# Troubleshooting

What the common messages mean and what to do about each. Find the message or the symptom you have, then follow the link for the background.

## The gate

### The gate says `pending`

Evidence is missing. One of these is true:

- Nothing has been reported for the commit yet. `mainworthy gate` prints `pending: nothing a gate counts has been reported for this commit`.
- A report was just uploaded and is still being applied. Run `mainworthy gate --wait 60` to wait for it.
- Only an agent reported the commit. An agent's report is shown and asked about, but it never gives a commit a gate.
- A planned run has a slot nobody has filled, or a required job that has not reported.

### The gate says `blocked`

A failure has no explanation yet, or two results for the same thing disagree. Open the queue with <kbd>g</kbd> <kbd>q</kbd> and answer the question. The verdict is worked out again the moment you answer, without running the pipeline again. See [decide in the queue](./decide.md).

### The gate says `failed`

A decision said a failure is real: a defect, a wrong test, or behaviour that changed on purpose. The commit needs a fix, and the decision says why. Report a build that passes to turn it green.

### A test failed and no question appeared

Someone already decided about that cause, and the decision still holds, so nobody is asked again. Look at the decided questions in the queue to find the decision and who made it. Withdraw it there if it no longer applies.

### A result did not fill a slot in my planned run

A result fills a slot only when three things are true. It is for that case at the pinned version. Its method is one the run asked for. And the method is admitted: a person or an agent must be among the methods the case declares, and an automated test must be linked to the case or name it. See [planned runs](./runs.md).

## Commands

A command that could not run prints one line to standard error, the code and then the message, and exits with 4. The sections below are such messages. A command that ran and has bad news uses a code of its own: `mainworthy gate` exits 1, 2 or 3 for its verdicts, and `mainworthy check` and `mainworthy health` exit 1.

### `connection: cannot connect to ...`

No server answers at that address. Start one with `mainworthy serve`, or point the command at the right one with `--url` or `MAINWORTHY_URL`.

### `unauthenticated: a token is required`

The server is in server mode, or the token is wrong or was revoked. Pass a token with `--token` or `MAINWORTHY_TOKEN`. See [people, agents and pipelines](./access.md).

### `forbidden: propose needs the produce capability on scratch`

The token's actor holds a grant on that project and lacks the capability the message names. An admin can change the grant. A pipeline's token records results and reads the gate, and can be granted `read` besides. It can never edit a case, answer, plan or administer, whatever it is granted.

### `not_found: no project named scratch, or no grant on it`

The project does not exist, or the token's actor holds no grant on it. The two are answered alike, so that a token cannot find out which projects an instance has. Check the key, then ask an admin for a grant with `mainworthy actor grant`.

### `conflict`

The edit was made on an older version of the case than the current one. Read the case again and make the edit on the current version. In the web UI the case shows a conflict card that lets you merge both sides.

### `the request body is larger than 64 MB`

One report may be at most 64 MB. Split the results into several `mainworthy report` calls.

## Signing in

### The page sends me back to sign in

Your session belongs to someone else now, usually because another tab signed in with a different token. Mainworthy refuses the request instead of recording your text under their name. Sign in again. Your drafts are kept per person and are still there.

### The token is not accepted behind a proxy

A browser's requests must come from the same address the server sees itself at. A proxy that ends TLS must send `X-Forwarded-Proto: https`. Without it an HTTPS page looks like another site, and the server refuses the sign-in. See [configuration](./configuration.md).

### The owner token was never shown

In server mode the server prints a generated owner token on a start where the owner holds no token that works and none is configured: the first start, and the start after an import. If the owner has a token and you lost it, set `MAINWORTHY_OWNER_TOKEN` to a new value and restart. See [configuration](./configuration.md).

### Revoke refuses the owner's token

In server mode the last token the owner can sign in with is kept, whoever asks, because the owner is who repairs the instance. As the owner, make another token first with `mainworthy token new --human <owner>`, then revoke the old one.

## The web UI

### A key does nothing

Keys other than <kbd>⌘</kbd> combinations and <kbd>Esc</kbd> are off while you type in a field. Press <kbd>Esc</kbd> to leave the case editor, the filter or a run's note. In Settings, click outside the field. Press <kbd>?</kbd> to see the keys that work on the current screen. The full list is on the [keyboard](./keyboard.md) page.

### What I typed is not a version yet

A draft stays on your device as you type. It becomes a version when you leave the case, press <kbd>⌘</kbd> <kbd>↵</kbd>, or pause for 30 seconds. See [write cases](./write-cases.md).

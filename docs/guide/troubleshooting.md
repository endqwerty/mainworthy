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

### `connection: the server answered ... to /healthz`

The server or its proxy answered the health probe, so the command prints the HTTP status. For a redirect,
use the HTTPS destination in `--url` or `MAINWORTHY_URL`. A 5xx response or invalid JSON can mean the proxy
is waiting for a deployment; check the instance and retry once it serves `/healthz` again. No token or
operation is sent after a failed health probe.

### `limited: too many failed attempts`

Five wrong tokens came from your address, or five wrong tokens that begin as yours does, within 15 minutes. Wait the seconds the message names and try again with the right token. Each further wrong one doubles the wait, up to 15 minutes. If you share an address with whoever is guessing, a token the server generated still works. The owner token the server made from the value of `MAINWORTHY_OWNER_TOKEN` is one somebody chose, whatever it looks like, and waits with the rest.

A person's sign-in gets this message too. Five wrong passwords for one name within 15 minutes block sign-in with a password for that name, from every address, and five from one address block that address. The right password waits like a wrong one, so wait and then type it once. If you have a passkey, it still signs you in. Somebody who keeps guessing at your name can keep it blocked. A passkey is the way round that. Mainworthy keeps no log of requests, so where the guesses come from is in the proxy's log, if anywhere.

In the web UI the sign-in page, an invitation and "Your sign-in" in Settings say "Too many attempts. Try again in N seconds." under what you tried, and keep what you typed. What you typed is not sent again by itself: press the button after the wait.

If everybody behind one proxy gets this message together, the server is counting the proxy as one address. Name the proxy with `MAINWORTHY_TRUSTED_PROXY` and `MAINWORTHY_CLIENT_ADDRESS_HEADER`: see [configuration](./configuration.md).

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

A browser's session ends after 14 days without use and after 90 days in any case, and when the token you signed in with is revoked or the password or passkey you signed in with is removed or replaced. Changing your password signs out your other browsers that used the old one. Sign in again, with your password, your passkey or a token that works. After an upgrade from a build in which the browser held the token itself, everyone signs in once more.

Your session belongs to someone else now, usually because another tab signed in with a different token. Mainworthy refuses the request instead of recording your text under their name. Sign in again. Your drafts are kept per person and are still there.

### "This browser could not use a passkey here"

A passkey belongs to one host name: the one in `MAINWORTHY_PUBLIC_URL`. The page was opened at another name of the same instance, such as an IP address, `127.0.0.1` in place of `localhost`, or a second name the proxy also answers at, and the browser refuses to make or use a passkey there. Open the instance at the address in that variable. If your browser has no passkeys at all, the page shows no passkey button. Sign in with your name and password, or a token.

"No passkey was used: the request was cancelled or ran out of time" means the browser's own dialog was closed or left open too long. Press the button again. "This passkey is already registered" means the device already holds one of your passkeys for this instance.

### "This invitation does not work any more"

An invitation link works once and until the time it was made with, and a new invitation for the same person replaces the one before it. The page says the same for a link that was used, was revoked, has run out or was cut short when it was copied, and for all of them the way on is the same: ask whoever sent it for a new one. An admin makes it in Settings, People, or with `mainworthy invite new`.

"This address holds no invitation" means the page was opened or reloaded without the part after the `#`. The page takes the code out of the address bar when it reads it. Open the link you were given again.

### I lost my password or my passkey

With mail enabled, use **Forgot your password?** on the sign-in page and enter your verified email address. If no reset link arrives, check the address and ask for another. The reply never says whether the address belongs to an account. Reset retains an enrolled authenticator. Without mail, without a verified address, or after losing an authenticator too, ask the owner for a recovery link. An admin who is still signed in can make their own under Settings, People, **Recovery link**. See [people, agents and pipelines](./access.md#a-lost-password-or-passkey).

### The token is not accepted behind a proxy

A browser's requests must come from the same address the server sees itself at. A proxy that ends TLS must send `X-Forwarded-Proto: https`. Without it an HTTPS page looks like another site, and the server refuses the sign-in. See [configuration](./configuration.md).

### The owner token was never shown

In server mode the server prints a generated owner token on a start where the owner holds no token that works and none is configured: the first start, and the start after an import. If the owner has a token and you lost it, set `MAINWORTHY_OWNER_TOKEN` to a new value and restart. See [configuration](./configuration.md).

### Revoke refuses the owner's token

In server mode the last token the owner can sign in with is kept, whoever asks, because the owner is who repairs the instance. As the owner, make another token first with `mainworthy token new --human <owner>`, then revoke the old one.

## The web UI

### A list is loading while reports or edits arrive

Suite keeps loading the remaining cases while changes arrive. The web app lets a page or refresh finish before reading the list again, and combines changes during that read into one refresh. The newest changes can appear after the current load finishes. Queue and Runs use the same behaviour.

Your own saved edits, tags and moves appear in an already loaded list without waiting for that refresh. A reply from before your change cannot replace that update. Saving while the list has nothing loaded lets its first read finish, then refreshes it for the saved change.

### A key does nothing

Keys other than <kbd>⌘</kbd> combinations and <kbd>Esc</kbd> are off while you type in a field. Press <kbd>Esc</kbd> to leave the case editor, the filter or a run's note. In Settings, click outside the field. Press <kbd>?</kbd> to see the keys that work on the current screen. The full list is on the [keyboard](./keyboard.md) page.

### What I typed is not a version yet

A draft stays on your device as you type. It becomes a version when you leave the case, press <kbd>⌘</kbd> <kbd>↵</kbd>, or pause for 30 seconds. See [write cases](./write-cases.md).

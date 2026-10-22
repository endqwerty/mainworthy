# Troubleshooting

Find your message or symptom, then follow the steps to resolve it. Each section links to more detail where needed.

## The gate

### The gate says `pending`

Evidence is missing. One of the following conditions applies:

- Nothing has been reported for the commit yet. `mainworthy gate` prints `pending: nothing a gate counts has been reported for this commit`.
- A report was just uploaded and is still being applied. Run `mainworthy gate --wait 60` to wait for it.
- Only an agent reported the commit. An agent's report is shown and asked about, but it never gives a commit a gate.
- A planned run has a slot nobody has filled, or a required job has not reported.
- Every counted result was skipped or blocked, so no test proved anything. An empty report also stays pending unless the policy accepts an explicit declaration that no tests were required.
- A decision's hold expired. The gate stays pending until the server reopens the question and computes the verdict again.

### The gate says `blocked`

A failure has no explanation yet, or two results for the same thing disagree. To resolve the question, follow these steps:

1. Open the queue with <kbd>g</kbd> <kbd>q</kbd>.
2. Answer the question.

Mainworthy computes the verdict again the moment you answer, without another pipeline run. See [decide in the queue](./decide.md).

### The gate says `failed`

A decision said a failure is real: a defect, a wrong test, or behaviour that changed on purpose. The commit needs a fix, and the decision says why. To turn the gate green, report a build that passes.

### A test failed and no question appeared

A decision about that cause may still hold. To check the decision, follow these steps:

1. Look at the decided questions in the queue to find who answered the failure question.
2. If the answer no longer applies, withdraw the answer.

If the change has ended, Mainworthy records later reports. It asks about their failures only if an open planned run needs an answer. Open the change in **Changes** to inspect the results its gate counted. See [report results](./report-results.md) and [changes and the gate](./changes.md).

### A result did not fill a slot in my planned run

Check the result against these requirements:

- If the run accepts only its own results, the result names the run. Otherwise, the result matches the run's accepted commit, build, and environment.
- The result identifies the slot's case and meets the run's basis rule. Depending on the run, the rule requires an exact version, an assumed version, or the same case content.
- The result's method is one the run accepts.
- For a result from a person or an agent, the case allows that method.
- For a result from an automated test, the test is linked to the case or names the case.

See [planned runs](./runs.md).

## Commands

A command that cannot run prints its error code and message to standard error and exits with 4. The sections below explain those messages. Commands that complete can use other exit codes for their results. `mainworthy gate` exits 1, 2 or 3 for a verdict that did not pass. `mainworthy check` and `mainworthy health` exit 1 when their checks fail.

### `connection: cannot connect to ...`

No server answers at that address. Start one with `mainworthy serve`, or point the command at the right one with `--url` or `MAINWORTHY_URL`.

### `connection: the server answered ... to /healthz`

The server or its proxy answered the health probe, so the command prints the HTTP status. For a redirect,
use the HTTPS destination in `--url` or `MAINWORTHY_URL`. A 5xx response or invalid JSON can mean the proxy
is waiting for a deployment. Check the instance. Once the instance serves `/healthz` again, retry the command. No token or
operation is sent after a failed health probe.

### `limited: too many attempts`

Anonymous passkey/provider starts have a separate allowance of 300 per public IPv4 address or IPv6 /56 per minute.
If that source allowance is exhausted, wait for `Retry-After` before starting again. These waits do not escalate or extend on retry.
They never cause password refusals, and valid answers to pending ceremonies still finish. A working invitation still opens its form.

For token authentication, five wrong tokens from one address or five with the same prefix within 15 minutes trigger a wait.
Wait for the time the message names, then try the right token. Each further wrong attempt doubles the wait, up to 15 minutes.

A valid token the server generated still works if you share an address with someone making wrong attempts. A token set through `MAINWORTHY_OWNER_TOKEN` counts as a chosen token and must wait, whatever it looks like.

Password sign-in can return the same message. Within 15 minutes, five wrong passwords for one name block password sign-in for that name from every address. Five wrong passwords from one address block that address. The block also applies to the right password. After the wait ends, type the right password once. Someone who keeps trying wrong passwords for your name can keep password sign-in blocked. If you have a passkey, use it to sign in. Mainworthy keeps no request log. The proxy's log may show where the guesses come from.

In the web UI, the sign-in page, an invitation, and "Your sign-in" in Settings keep what you typed. These forms display "Too many attempts. Try again in N seconds." under the attempted action. The page does not resend what you typed. Press the button after the wait.

If everybody behind one proxy gets this message together for failed credentials, the server may be counting the proxy as one address.
Configure `MAINWORTHY_TRUSTED_PROXY` and `MAINWORTHY_CLIENT_ADDRESS_HEADER` as described in [configuration](./configuration.md).
There is no instance-wide start allowance. Sources sharing a public address or /56 still share its own allowance.

### `unauthenticated: a token is required`

The server is in server mode, or the token is wrong or was revoked. Pass a token with `--token` or `MAINWORTHY_TOKEN`. See [people, agents and pipelines](./access.md).

### `forbidden: propose needs the produce capability on scratch`

The token identifies an actor with a grant on that project, but the grant lacks the named capability. An admin can change the grant. A pipeline's token records results and reads the gate. An admin can also grant the pipeline `read`. It can never edit a case, answer, plan or administer, whatever it is granted.

### `not_found: no project named scratch, or no grant on it`

The project does not exist, or the token's actor holds no grant on it. Both conditions return the same message, so a token cannot reveal which projects an instance has. To resolve the error, follow these steps:

1. Check the project key.
2. Ask an admin for a grant with `mainworthy actor grant`.

### `conflict`

The edit was made on an older version of the case than the current one. To update the edit, follow these steps:

1. Read the case again.
2. Make the edit on the current version.

In the web UI the case shows a conflict card that lets you merge both sides.

### `the request body is larger than 64 MB`

One report may be at most 64 MB. Split the results into several `mainworthy report` calls.

## Signing in

### The page sends me back to sign in

By default, a browser's session ends after 14 days without use or 90 days in total. The operator can [change those lifetimes](./configuration.md). Revoking a token or removing a password or passkey ends the sessions created with that token or credential. Changing your password signs out your other browsers that used the old one. Sign in again with a working password, passkey or token.

Another tab may have signed in as someone else. Mainworthy refuses requests from the earlier tab instead of recording your text under their name. Sign in again as yourself to recover your drafts.

### "This browser could not use a passkey here"

A passkey belongs to the host name in `MAINWORTHY_PUBLIC_URL`. If you open the instance at another address, the browser refuses to create or use a passkey there. For example, `127.0.0.1` in place of `localhost`, or another proxy host name, counts as a different address. Open the instance at the address in that variable. If your browser has no passkeys at all, the page shows no passkey button. Sign in with your name and password, or a token.

"No passkey was used: the request was cancelled or ran out of time" means the browser's own dialog was closed or left open too long. Press the button again. "This passkey is already registered" means the device already holds one of your passkeys for this instance.

### "This invitation does not work any more"

An invitation link works once, until its expiry time. A new invitation for the same person replaces the previous one. The page gives the same message for a used, revoked, expired or incomplete link. Ask whoever sent it for a new one. An admin makes it in Settings, People, or with `mainworthy invite new`.

"This address holds no invitation" means the page was opened or reloaded without the part after the `#`. The page takes the code out of the address bar when it reads it. Open the link you were given again.

### I lost my password or my passkey

If mail is enabled and you have a verified email address, follow these steps:

1. Use **Forgot your password?** on the sign-in page.
2. Enter your verified email address.
3. If no reset link arrives, check the address.
4. If the address is correct, ask for another link.

The reply never says whether the address belongs to an account. A password reset keeps the requirement to use an enrolled authenticator.

If mail is disabled, you have no verified address, or you also lost an authenticator, ask the owner for a recovery link. An admin who is still signed in can make their own under Settings, People, **Recovery link**. See [people, agents and pipelines](./access.md#a-lost-password-or-passkey).

### The token is not accepted behind a proxy

A browser's requests must come from the same address the server sees itself at. A proxy that ends TLS must send `X-Forwarded-Proto: https`. Without that header, an HTTPS page looks like another site, and the server refuses the sign-in. See [configuration](./configuration.md).

### The owner token was never shown

In server mode, if the owner has no working token and no owner token is configured, the server prints a generated owner token at startup. This happens on the first start and the start after an import.

If the owner has a token that you lost, follow these steps:

1. Set `MAINWORTHY_OWNER_TOKEN` to a new value.
2. Restart the server. See [configuration](./configuration.md).

### Revoke refuses the owner's token

Server mode refuses to revoke the owner's last working token so the owner can still repair the instance. As the owner, follow these steps:

1. Create another token with `mainworthy token new --human <owner>`.
2. Revoke the old token.

## The web UI

### "The server answered something this page cannot read; reload."

The reply does not match the operation's expected data. Reload the page to load the current web app, then try again.
If the message persists, ask the operator to check the server. After an action that writes data, check whether it took effect before repeating it.

On a run page, an unreadable or lost report reply leaves the outcome unknown until the page checks the original command.
If that check also fails, keep the run page open. Press a result key on the affected slot to check the same request again.
That press resolves the earlier result before you can record another one. If the server refuses the resent report,
the page shows the refusal and keeps the note. The next result key can send a new result.
Settings reads the credential list again after a possible passkey addition.

### A list is loading while reports or edits arrive

Suite keeps loading the remaining cases while changes arrive. The web app lets a page or refresh finish before reading the list again. Changes that arrive during that read are combined into one refresh. The newest changes can appear after the current load finishes. Queue and Runs use the same behaviour.

Your own saved edits, tags and moves appear in an already loaded list without waiting for that refresh. A reply from before your change cannot replace that update. If you save before the list has loaded any items, the app lets the first read finish. The app then refreshes the list for the saved change.

### A key does nothing

Keys other than <kbd>⌘</kbd> combinations and <kbd>Esc</kbd> are off while you type in a field. Press <kbd>Esc</kbd> to leave the case editor, the filter or a run's note. In Settings, click outside the field. Press <kbd>?</kbd> to see the keys that work on the current screen. The full list is on the [keyboard](./keyboard.md) page.

### What I typed is not a version yet

A draft stays on your device as you type. It becomes a version when you leave the case, press <kbd>⌘</kbd> <kbd>↵</kbd>, or pause for 30 seconds. See [write cases](./write-cases.md).

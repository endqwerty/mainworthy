# Privacy

The privacy of your data, and it is your data, not ours, is a big deal to us. This policy says what Mainworthy keeps and why, how it is handled, and your rights with respect to it. We never sell your data, and we keep as little of it as Mainworthy can work with.

*Last updated: October 14, 2026*

This policy covers the instance at `mainworthy.com` and the Mainworthy iPhone app, which are run by the owner of the Mainworthy project ("we", "us"). Mainworthy is software that anyone can run. If you use an instance that somebody else runs, that person decides what happens to your data there, and you should ask them. What the software itself keeps, which is most of this page, is the same on every instance.

## What we collect and why

Our guiding principle is to collect only what Mainworthy needs to work. Here is what that means in practice.

### Identity and access

An account is a name and a way to sign in. We do not ask for an email address, a real name or anything else about you. You are invited by somebody who already has an account, and you choose how you sign in:

- **A password.** We store it as an argon2id hash, never the password itself.
- **A passkey.** We store its public key, its credential id, a counter, the label you gave it and when it was made and last used. Mainworthy never receives the private key: where it is kept, and whether it syncs between your devices, is up to your device or password manager.
- **A token**, for scripts and pipelines. We store a SHA-256 hash of it, its label, when it was made and last used, and the network address it was last used from.

An invitation is stored as a hash of its code, with who it is for and who made it.

### Sessions

When you sign in, we keep a record of the session so that you can see where you are signed in and end a session that is not yours: when it started and was last used, what the browser or app calls itself (its user agent, up to 256 characters), and the network address it was opened from and last used from. We keep only the latest address, never a history of addresses.

A session ends when you sign out, after 14 days without use, or after 90 days. Revoking its token also records its end at once. When a token expires, the next minute job records that expiry time as the end of its sessions. The job also records earlier token revocations whose sessions an older build left unended. An earlier recorded end stays. Once a session has been ended for 30 days, the server deletes its record.

The server checks retention every minute while it runs. A stopped server or a long write can delay cleanup. For token revocations and expiries, the 30 days start at the token's end, even when the job runs later.

### Failed sign-ins

To slow down anybody guessing passwords, the server remembers failed sign-in attempts: the network address they came from and the name that was typed. This is kept in the server's memory only, never written to disk or a log. The server stops using them at most 30 minutes after the last failed attempt, and its memory is cleared when it restarts.

### Product interactions

We store the content you put into Mainworthy: cases, test results, decisions, notes and the reasons you give. Each change records who made it and when, because a trustworthy record of who decided what is the point of the product. This content is kept for as long as the instance exists. Mainworthy keeps history and does not erase it yet: see [data retention](#data-retention).

### Cookies and browser storage

The web app sets two cookies, and both are strictly necessary: one that keeps you signed in, and one that lasts the five minutes of a passkey sign-in. There are no analytics, advertising or tracking cookies.

The web app keeps your unsaved case drafts, queue answers, run notes, theme, and signed-in name in your browser. Signing out opens a dialog with three choices. **Sign out and keep drafts** starts with the focus and keeps your browser data for when you return. **Sign out and clear browser data** deletes your drafts, answers, notes, and name. The warning explains that clearing deletes unsaved text in every open tab and cannot be undone. **Stay signed in**, or <kbd>Esc</kbd>, closes the dialog without signing out or clearing data. The same dialog appears when you end this browser's session under Settings, **Your sessions**.

Clearing takes effect in other open tabs and survives a reload. It leaves the theme and sidebar preference, other people's drafts, and content already recorded on the server. If the sign-out reply is lost, the page checks the session, with a second check if the first gets no answer. Your choice to clear applies if either check confirms that the session ended. If a check finds you still signed in, or neither check answers, the attempt ends and keeps your browser data. The page tells you the result and lets you sign out again. When it cannot tell, it also explains how to clear the site's data in your browser settings before leaving a shared computer.

The pending choice stays only in the tab making the attempt and does not survive a reload. It cannot clear data when a later session expires or another tab signs out. A session that expires keeps your drafts, as does signing in again as the same person. If the browser cannot clear its storage after a confirmed sign-out, the app warns you to clear the site's data in your browser settings.

### Logs

The server writes no log of requests. It logs when it starts and when something fails, and a failed sign-in is logged without the name, the address or the password.

### The iPhone app

The app talks only to `mainworthy.com`, or to the instance a build of the app from its source code names. A phone that an earlier version signed in to another instance may stay signed in there and keep talking to it. It keeps your session in the phone's keychain and your last project in its settings. It does not keep your password. It contains no analytics, advertising or crash-reporting code, and it tells the server only that it is "Mainworthy for iPhone" and which version. The only permission it can ask for is to reach your local network, and only when the instance it talks to is on it.

### Voluntary correspondence

If you contact us through GitHub, that conversation is kept by GitHub, under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

### Why we may keep it

We keep your account, your sessions and your content because you asked us to provide Mainworthy to you, and we keep the records of sign-ins and failed attempts because we have a legitimate interest in keeping accounts secure. We use none of it for anything else.

## When we access or disclose your information

**To provide the service.** We use a few providers to run `mainworthy.com`:

- **Cloudflare** carries every request to `mainworthy.com`. It provides the domain's DNS, the encrypted connection and the tunnel to our server, so it sees your network address and the requests you make. See [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **Apple** delivers the iPhone app through TestFlight and the App Store, under [Apple's privacy policy](https://www.apple.com/legal/privacy/).

The server and its database are ours, not a cloud provider's.

**No human looks at your content** except for limited purposes: to fix an error that needs a person, with your permission to help you with a problem you asked about, or when the law requires it.

**When required under applicable law.** We disclose data to a government authority only when we are compelled by valid legal process. We will tell you before we do, unless the law forbids it.

## Your rights with respect to your information

We apply the same rights to everyone, wherever they are:

- **Right to know.** This page lists what we collect and why.
- **Right of access and portability.** An admin can export everything in an instance as a text file that any tool can read ([Your data](./data.md)). We will export what we hold about you on request.
- **Right to correction.** Ask us to correct anything about you that is wrong.
- **Right to erasure.** Ask us to forget you. We then replace your name with a pseudonym, including attribution in question evidence, saved command replies and report receipts. New question evidence stores actor ids and resolves names when read. We revoke your passwords, passkeys, tokens and invitations, erase your password's hash and your passkeys' public keys, and clear your token and credential labels, including labels on previously revoked rows. We end your sessions, whose records are then deleted as [sessions](#sessions) describes. The history still says that one person did each thing, without saying who. Four things stay for now: text that you typed into cases and notes, because Mainworthy cannot yet erase part of its history ([#40](https://github.com/endqwerty/mainworthy/issues/40)); a fingerprint (a SHA-256 hash) of each request sent with a command id, which keeps a retried request from being recorded twice and lets someone who holds the database confirm a name they already guess; your name in replies and questions saved before 2026-10-14, if you were forgotten before then; and the records of your tokens, passwords and passkeys, with when they were made and used and each passkey's credential id, but nothing that signs in. Your invitations are deleted 30 days after they end, and your tokens' network addresses 30 days after the tokens end ([Data retention](#data-retention)).
- **Right to restrict processing and to object.** Ask us, and we will tell you what we can do.
- **Right to complain.** You can complain to the data protection authority where you live.
- **Right to non-discrimination.** Exercising these rights never costs you anything.

You can do some of this yourself. Under Settings, **Your sessions** lists every session you have open and ends any of them, and **Your sign-in** removes a password or a passkey, as long as one way to sign in is left. A person who administers the instance can forget somebody through Settings, **People**, **Forget a person**, or `mainworthy actor forget <name> --confirm <name>`. Both require confirmation and explain what stays. You cannot forget yourself or the current owner. [People, agents and pipelines](./access.md#forget-a-person) gives the steps. There is no in-app request for forgetting or self-service account deletion yet. For the rest, contact us as described in [changes and questions](#changes-and-questions). We may need to make sure a request comes from you before acting on it.

## How we secure your data

Every connection to `mainworthy.com` is encrypted with TLS. Passwords are stored as argon2id hashes, and tokens, session cookies and invitation codes as SHA-256 hashes, so none of them can be read back from the database. The database itself is not encrypted by Mainworthy. It is protected by the server it lives on. An export never contains a password, a passkey, a token, a session or an invitation.

## Data retention

We keep information only for as long as it is needed:

| What | How long |
| --- | --- |
| Failed sign-in attempts | Used for at most 30 minutes; in memory only, until the server restarts |
| A passkey sign-in in progress | Usable for 5 minutes; in memory only, until the server restarts |
| A session's record | Deleted once the session has been ended for 30 days, by the running server (see [sessions](#sessions)) |
| A token's last network address | Erased 30 days after revocation or expiry, whichever happens first |
| An invitation's record | Deleted 30 days after use, revocation or expiry, whichever happens first |
| Your account and content | As long as the instance exists |

The running server applies these periods in its minute job. Token records remain after their addresses are erased, including the hash, label and dates. Keeping the hash prevents a revoked configured owner token from becoming valid again after a restart. Mainworthy does not yet delete old product content. We will help with a request to delete it as described under [your rights](#your-rights-with-respect-to-your-information).

## Children

Mainworthy is a tool for software teams and is not meant for children under 16. We do not knowingly keep data about them.

## Location of site and data

`mainworthy.com` is run from the United States. If you use it from elsewhere, your data is transferred to and stored in the United States.

## Changes and questions

We may update this policy to comply with the law and to reflect what Mainworthy does. Every change is in the [history of this page on GitHub](https://github.com/endqwerty/mainworthy/commits/main/docs/guide/privacy.md), and we update the date at the top whenever we change it.

Have a question, a concern or a request about your data? We do not yet have a private contact address ([#231](https://github.com/endqwerty/mainworthy/issues/231)). Until we do, open an issue in the [Mainworthy repository on GitHub](https://github.com/endqwerty/mainworthy/issues). Issues there are public, so do not put personal information in one: say that you want to reach us privately, and we will give you a private way to do so.

---

This policy is adapted from the [Basecamp open-source policies](https://github.com/basecamp/policies) by 37signals, used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). We changed it to describe Mainworthy.

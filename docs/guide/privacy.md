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

A session ends when you sign out, after 14 days without use, or after 90 days. Once a session has been ended for 30 days, the server deletes its record: it looks for such records every minute while it runs, so a record can outlast the 30 days while the server is stopped. A session that stopped working another way, for example because its token was revoked, is only marked ended when the server later finds that one of those limits has passed, and its 30 days start then, so its record can stay well beyond 30 days after it stopped working ([#227](https://github.com/endqwerty/mainworthy/issues/227)).

### Failed sign-ins

To slow down anybody guessing passwords, the server remembers failed sign-in attempts: the network address they came from and the name that was typed. This is kept in the server's memory only, never written to disk or a log. The server stops using them at most 30 minutes after the last failed attempt, and its memory is cleared when it restarts.

### Product interactions

We store the content you put into Mainworthy: cases, test results, decisions, notes and the reasons you give. Each change records who made it and when, because a trustworthy record of who decided what is the point of the product. This content is kept for as long as the instance exists. Mainworthy keeps history and does not erase it yet: see [data retention](#data-retention).

### Cookies and browser storage

The web app sets two cookies, and both are strictly necessary: one that keeps you signed in, and one that lasts the five minutes of a passkey sign-in. There are no analytics, advertising or tracking cookies.

The web app keeps a few things in your browser so that you do not lose work: your unsaved drafts and notes, your theme, and the name you signed in with. They stay in that browser after you sign out, so that your drafts are there when you come back. Clear the site's data in your browser to remove them.

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
- **Right to erasure.** Ask us to forget you. We then replace your name with a pseudonym, including attribution in question evidence, saved command replies and report receipts. New question evidence stores actor ids and resolves names when read. We revoke your passwords, passkeys, tokens and invitations, erase your password's hash and your passkeys' public keys, and clear your token and credential labels, including labels on previously revoked rows. We end your sessions, whose records are then deleted as [sessions](#sessions) describes. The history still says that one person did each thing, without saying who. Four things stay for now: text that you typed into cases and notes, because Mainworthy cannot yet erase part of its history ([#40](https://github.com/endqwerty/mainworthy/issues/40)); a fingerprint (a SHA-256 hash) of each request sent with a command id, which keeps a retried request from being recorded twice and lets someone who holds the database confirm a name they already guess; your name in replies and questions saved before 2026-10-14, if you were forgotten before then; and the records of your tokens, invitations, passwords and passkeys, with when they were made and used and each passkey's credential id, but nothing that signs in ([#227](https://github.com/endqwerty/mainworthy/issues/227)).
- **Right to restrict processing and to object.** Ask us, and we will tell you what we can do.
- **Right to complain.** You can complain to the data protection authority where you live.
- **Right to non-discrimination.** Exercising these rights never costs you anything.

You can do some of this yourself. Under Settings, **Your sessions** lists every session you have open and ends any of them, and **Your sign-in** removes a password or a passkey, as long as one way to sign in is left. For the rest, contact us as described in [changes and questions](#changes-and-questions). We may need to make sure a request comes from you before acting on it.

## How we secure your data

Every connection to `mainworthy.com` is encrypted with TLS. Passwords are stored as argon2id hashes, and tokens, session cookies and invitation codes as SHA-256 hashes, so none of them can be read back from the database. The database itself is not encrypted by Mainworthy. It is protected by the server it lives on. An export never contains a password, a passkey, a token, a session or an invitation.

## Data retention

We keep information only for as long as it is needed:

| What | How long |
| --- | --- |
| Failed sign-in attempts | Used for at most 30 minutes; in memory only, until the server restarts |
| A passkey sign-in in progress | Usable for 5 minutes; in memory only, until the server restarts |
| A session's record | Deleted once the session has been ended for 30 days, by the running server (see [sessions](#sessions)) |
| Your account and content | As long as the instance exists |

Mainworthy does not yet delete old content, the records of revoked tokens with the address each was last used from, or the records of invitations. We are working on it, and until then we will delete such records by hand if you ask.

## Children

Mainworthy is a tool for software teams and is not meant for children under 16. We do not knowingly keep data about them.

## Location of site and data

`mainworthy.com` is run from the United States. If you use it from elsewhere, your data is transferred to and stored in the United States.

## Changes and questions

We may update this policy to comply with the law and to reflect what Mainworthy does. Every change is in the [history of this page on GitHub](https://github.com/endqwerty/mainworthy/commits/main/docs/guide/privacy.md), and we update the date at the top whenever we change it.

Have a question, a concern or a request about your data? We do not yet have a private contact address ([#231](https://github.com/endqwerty/mainworthy/issues/231)). Until we do, open an issue in the [Mainworthy repository on GitHub](https://github.com/endqwerty/mainworthy/issues). Issues there are public, so do not put personal information in one: say that you want to reach us privately, and we will give you a private way to do so.

---

This policy is adapted from the [Basecamp open-source policies](https://github.com/basecamp/policies) by 37signals, used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). We changed it to describe Mainworthy.

# Privacy

This policy explains what Mainworthy keeps, why we keep it, how we handle it and your rights over your data. We never sell your data, and we keep as little of it as Mainworthy can work with.

*Last updated: October 16, 2026*

This policy covers the instance at `mainworthy.com` and the Mainworthy iPhone app. The owner of the Mainworthy project runs both. "We" and "us" refer to that owner. Mainworthy is software that anyone can run. If you use an instance that somebody else runs, that person decides what happens to your data there. Ask that person about their policy. Most of this page describes what the software itself keeps on every instance.

## What we collect and why

### Identity and access

An account is a name and a way to sign in. We do not require an email address or a real name. If the instance has mail enabled, you can add a recovery email address. We store the address and whether and when you verified it. We use that information to send recovery links and notices about changes to your sign-in methods.

Somebody who already has an account invites you. You choose how you sign in:

- **A password.** We store it as an argon2id hash, never the password itself.
- **A passkey.** We store its public key, its credential id, a counter, the label you gave it and when it was made and last used. Mainworthy never receives the private key. Your device or password manager decides where it keeps that key and whether it syncs between devices.
- **A token**, for scripts and pipelines. We store a SHA-256 hash of it, its label, when it was made and last used, and the network address it was last used from.

If you add an authenticator as a second sign-in step, we store its shared secret, the last accepted time step and SHA-256 hashes of its unused recovery codes. The shared secret is not encrypted by Mainworthy. Removing the authenticator erases the secret and recovery-code hashes.

We store an invitation as a hash of its code, with who it is for and who made it. Email verification and password reset links stay in server memory only. A verification link works once for 24 hours, and a reset link works once for 15 minutes. Restarting the server clears them.

### Sessions

When you sign in, we keep a session record so that you can see where you are signed in and end a session that is not yours. The record holds when the session started and was last used, the browser or app's user agent, and the session's opening and latest network addresses. The user agent identifies what the browser or app calls itself, up to 256 characters. We keep no history of addresses between those two.

A session ends when you sign out, after 14 days without use, or after 90 days. Revoking its token also records its end at once. When a token expires, the next minute job records that expiry time as the end of its sessions. The job also records earlier token revocations whose sessions an older build left unended. An earlier recorded end stays. Once a session has been ended for 30 days, the server deletes its record.

The server checks retention every minute while it runs. A stopped server or a long write can delay cleanup. For token revocations and expiries, the 30 days start at the token's end, even when the job runs later.

### Failed sign-ins

To slow down anybody guessing passwords, the server remembers the network address and the name typed for each failed sign-in attempt. The server keeps these attempts only in memory, never on disk or in a log. The server stops using them at most 30 minutes after the last failed attempt. Restarting the server clears the attempts from memory.

### Product interactions

We store the content you put into Mainworthy: cases, test results, decisions, notes and the reasons you give. Each change records who made it and when. A trustworthy record of who decided what is the point of the product. This content is kept for as long as the instance exists. Mainworthy keeps history and does not erase it yet. See [data retention](#data-retention).

### Cookies and browser storage

The web app sets two cookies, both strictly necessary:

- One keeps you signed in.
- The other lasts the five minutes of a passkey sign-in.

There are no analytics, advertising or tracking cookies.

The web app keeps your unsaved case drafts, queue answers, run notes, theme, and signed-in name in your browser. Signing out opens a dialog with three choices. **Sign out and keep drafts** starts with the focus and keeps your browser data for when you return. **Sign out and clear browser data** deletes your drafts, answers, notes, and name. The warning explains that clearing deletes unsaved text in every open tab and cannot be undone. **Stay signed in**, or <kbd>Esc</kbd>, closes the dialog without signing out or clearing data. The same dialog appears when you end this browser's session under Settings, **Your sessions**.

Clearing takes effect in other open tabs and survives a reload. It leaves the theme and sidebar preference, other people's drafts, and content already recorded on the server. If the sign-out reply is lost, the page checks the session. If the first check gets no answer, the page checks the session a second time. Your choice to clear applies if either check confirms that the session ended. If a check finds you still signed in, or neither check answers, the attempt ends and keeps your browser data. The page tells you the result and lets you sign out again. When it cannot tell, it also explains how to clear the site's data in your browser settings before leaving a shared computer.

The pending choice stays only in the tab making the attempt and does not survive a reload. The choice cannot clear data when a later session expires or another tab signs out. Your drafts stay when a session expires or you sign in again as the same person. If the browser cannot clear its storage after a confirmed sign-out, the app warns you to clear the site's data in your browser settings.

Your personal home is stored separately for each signed-in name and project. It does not sync to other browsers. **Sign out and keep drafts** keeps this preference. **Sign out and clear browser data** removes it. Clearing the site's browser data removes it.

### Logs

The server writes no log of requests. It logs when it starts and when something fails. A failed sign-in is logged without the name, the address or the password.

### The iPhone app

The app talks only to `mainworthy.com`, or to the instance named in a build made from the app's source code. A phone that an earlier version signed in to another instance may stay signed in there and keep talking to that instance. The app keeps your session in the phone's keychain and your last project in its settings.

Except for answers that link tests or create cases, the app saves queue answers in its files before sending them. The saved data includes each question's title, evidence hash, reference and reason, the command id, and the eventual server outcomes. These files survive closing the app and signing out, separated by instance, person, and project. The app excludes these answer files from iCloud and computer backups. **Clear outcomes** removes completed answers and keeps waiting and Dropped answers. A Dropped answer stays until the server records an outcome that you can clear. There is no automatic expiry. Removing the app deletes the files.

The app does not keep your password. It contains no analytics, advertising or crash-reporting code. Its user agent tells the server that it is "Mainworthy for iPhone" and which version. The only permission the app can ask for is to reach your local network. It asks only when the instance it talks to is on that network.

### Voluntary correspondence

If you contact us through GitHub, that conversation is kept by GitHub, under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

### Why we may keep it

We keep your account, your sessions and your content because you asked us to provide Mainworthy to you. We keep the records of sign-ins and failed attempts because we have a legitimate interest in keeping accounts secure. We use none of it for anything else.

## When we access or disclose your information

**To provide the service.** We use a few providers to run `mainworthy.com`:

- **Cloudflare** carries every request to `mainworthy.com`. It provides the domain's DNS, the encrypted connection and the tunnel to our server.
  Cloudflare sees your network address and the requests you make. See [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **Apple** delivers the iPhone app through TestFlight and the App Store, under [Apple's privacy policy](https://www.apple.com/legal/privacy/).

The server and its database are ours, not a cloud provider's.

**No human looks at your content** except for limited purposes: to fix an error that needs a person, with your permission to help you with a problem you asked about, or when the law requires it.

**When required under applicable law.** We disclose data to a government authority only when we are compelled by valid legal process. We will tell you before we do, unless the law forbids it.

## Your rights with respect to your information

We apply the same rights to everyone, wherever they are:

- **Right to know.** This page lists what we collect and why.
- **Right of access and portability.** An instance admin can export everything in an instance as a text file that any tool can read ([Your data](./data.md)). We will export what we hold about you on request.
- **Right to correction.** Ask us to correct anything about you that is wrong.
- **Right to erasure.** Ask us to forget you. We then replace your name with a pseudonym, including attribution in question evidence, saved command replies and report receipts. New question evidence stores actor ids and resolves names when read. We revoke your passwords, passkeys, authenticators, tokens and invitations. We erase your password's hash, your passkeys' public keys and your authenticator's secret and recovery-code hashes. We clear your token and credential labels, including labels on previously revoked rows. We also delete your recovery email address. We end your sessions, whose records are then deleted as [sessions](#sessions) describes. The history still says that one person did each thing, without saying who.

  Attachments and their file names also stay when a person is forgotten. Screenshots and files can contain personal information. Mainworthy does not scan or redact them, and has no attachment deletion control yet. Text you typed into cases and notes stays because Mainworthy cannot yet erase part of its history ([#40](https://github.com/endqwerty/mainworthy/issues/40)).

  A fingerprint of each request sent with a command id also stays. The fingerprint is a SHA-256 hash. It prevents a retried request from being recorded twice. Someone who holds the database can also use the fingerprint to confirm a name they already guess. Your name stays in replies and questions saved before 2026-10-14 if you were forgotten before then. Records of your tokens, passwords, passkeys and authenticators stay, with nothing in them that signs in. The records include when those credentials were made and used and each passkey's credential id. Your invitations are deleted 30 days after they end. Your tokens' network addresses are erased 30 days after the tokens end. See [Data retention](#data-retention).
- **Right to restrict processing and to object.** Ask us, and we will tell you what we can do.
- **Right to complain.** You can complain to the data protection authority where you live.
- **Right to non-discrimination.** Exercising these rights never costs you anything.

You can manage your sessions and sign-in methods yourself. Under Settings, **Your sessions** lists every session you have open and lets you end any of them. **Your sign-in** removes a password or a passkey, as long as one way to sign in is left.

A person who administers the instance can forget somebody through Settings, **People**, **Forget a person**, or `mainworthy actor forget <name> --confirm <name>`. Both the page and the command require confirmation and explain what stays. The page opens a confirmation beside the selection. **Cancel** or <kbd>Esc</kbd> closes the confirmation without forgetting anybody. Your own name and the current owner's name are unavailable, with the reason beside each. [People, agents and pipelines](./access.md#forget-a-person) gives the steps.

There is no in-app request for forgetting or self-service account deletion yet. For other requests, contact us as described in [changes and questions](#changes-and-questions). We may need to make sure a request comes from you before acting on it.

## How we secure your data

Every connection to `mainworthy.com` is encrypted with TLS. We store passwords as argon2id hashes. We store tokens, session cookies and invitation codes as SHA-256 hashes. None of these secrets can be read back from the database. Mainworthy does not encrypt the database itself. The server protects the database. An export never contains a password, a passkey, an authenticator, a token, a session or an invitation. Recovery email addresses and their verification status are included in exports.

## Data retention

We keep information only for as long as it is needed:

| What | How long |
| --- | --- |
| Failed sign-in attempts | Used for at most 30 minutes. Kept only in memory and cleared when the server restarts. |
| A passkey sign-in or authenticator step in progress | Usable for 5 minutes. Kept only in memory and cleared when the server restarts. |
| An email verification link | Usable once for 24 hours. Kept only in memory and cleared when the server restarts. |
| A password reset link | Usable once for 15 minutes. Kept only in memory and cleared when the server restarts. |
| A recovery email address | Until you remove or replace it, or your account is forgotten |
| A session's record | Deleted by the running server once the session has been ended for 30 days. See [sessions](#sessions). |
| A token's last network address | Erased 30 days after revocation or expiry, whichever happens first |
| An invitation's record | Deleted 30 days after use, revocation or expiry, whichever happens first |
| Your account and content | As long as the instance exists |

The running server applies these periods in its minute job. Token records remain after their addresses are erased, including the hash, label and dates. Keeping the hash prevents a revoked configured owner token from becoming valid again after a restart. Mainworthy does not yet delete old product content. We will help with a request to delete it as described under [your rights](#your-rights-with-respect-to-your-information).

## Children

Mainworthy is a tool for software teams and is not meant for children under 16. We do not knowingly keep data about them.

## Location of site and data

`mainworthy.com` is run from the United States. If you use it from elsewhere, your data is transferred to and stored in the United States.

## Changes and questions

We may update this policy to comply with the law and to reflect what Mainworthy does. Every change is in the [history of this page on GitHub](https://github.com/endqwerty/mainworthy/commits/main/docs/guide/privacy.md). Whenever we change the policy, we update the date at the top.

Have a question, a concern or a request about your data? We do not yet have a private contact address ([#231](https://github.com/endqwerty/mainworthy/issues/231)). Until we do, open an issue in the [Mainworthy repository on GitHub](https://github.com/endqwerty/mainworthy/issues). Issues there are public, so do not put personal information in one. Say that you want to reach us privately, and we will give you a private way to do so.

---

This policy is adapted from the [Basecamp open-source policies](https://github.com/basecamp/policies) by 37signals, used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). We changed it to describe Mainworthy.

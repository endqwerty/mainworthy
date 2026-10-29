# Privacy

This policy explains what Mainworthy keeps, why we keep it, how we handle it and your rights over your data. We never sell your data, and we keep as little of it as Mainworthy can work with.

*Last updated: October 29, 2026*

This policy covers the instance at `mainworthy.com`. The owner of the Mainworthy project runs it. "We" and "us" refer to that owner. Mainworthy is software that anyone can run. If you use an instance that somebody else runs, that person decides what happens to your data there. Ask that person about their policy. Most of this page describes what the software itself keeps on every instance.

## What we collect and why

### Identity and access

An account is a name and a way to sign in. Mainworthy keeps no password, asks for no email address and sends no
mail. Somebody who already has an account invites you, and you sign in through the instance's identity provider.
On `mainworthy.com` that provider is Google: you sign in with your Google account.

- **An identity at the provider.** When you link one, we store the provider's issuer and its subject for you (an
  identifier the provider gives this instance for your account), a label made of the provider's name and the email
  address it reports as verified, or else the name it gives, and when the identity was linked and last used. We
  use the subject to recognise you when you sign in, never the email address or the name. Your password at the
  provider, and any second sign-in step there, stay with the provider.
- **A token**, for scripts and pipelines. We store a SHA-256 hash of it, its label, when it was made and last used, and the network address it was last used from.

We store an invitation as a hash of its code, with who it is for and who made it.

### Sessions

When you sign in, we keep a session record so that you can see where you are signed in and end a session that is not yours. The record holds when the session started and was last used, the browser or app's user agent, and the session's opening and latest network addresses. The user agent identifies what the browser or app calls itself, up to 256 characters. We keep no history of addresses between those two.

A session ends when you sign out, after 14 days without use, or after 90 days. Revoking its token also records its end at once. When a token expires, the next minute job records that expiry time as the end of its sessions. The job also records earlier token revocations whose sessions an older build left unended. An earlier recorded end stays. Once a session has been ended for 30 days, the server deletes its record.

The server checks retention every minute while it runs. A stopped server or a long write can delay cleanup. For token revocations and expiries, the 30 days start at the token's end, even when the job runs later.

### Failed sign-ins

To slow down guesses, the server stores counts under SHA-256 digests of source addresses and token prefixes. It stores these counters in PostgreSQL, shared by every instance, without keeping those keys as plaintext. The server stops using a failure count at most 30 minutes after the last failed attempt. Anonymous starts have a separate one-minute count. Restarting an instance preserves both counts. Expired rows can remain until cleanup or eviction, but do not extend a block.

### Product interactions

We store the content you put into Mainworthy: cases, test results, decisions, notes and the reasons you give. Each change records who made it and when. A trustworthy record of who decided what is the point of the product. This content is kept for as long as the instance exists. Mainworthy keeps history and does not erase it yet. See [data retention](#data-retention).

### Cookies and browser storage

The web app sets two cookies, both strictly necessary:

- One keeps you signed in.
- The other binds this browser to a five-minute sign-in at the identity provider.

There are no analytics, advertising or tracking cookies.

The web app keeps your unsaved case drafts, queue answers, run notes, theme, and which person is signed in (by id, not by name) in your browser. Signing out opens a dialog with three choices. **Sign out and keep drafts** starts with the focus and keeps your browser data for when you return. **Sign out and clear browser data** deletes your drafts, answers, notes, and that record. The warning explains that clearing deletes unsaved text in every open tab and cannot be undone. **Stay signed in**, or <kbd>Esc</kbd>, closes the dialog without signing out or clearing data. The same dialog appears when you end this browser's session under Settings, **Your sessions**.

Clearing takes effect in other open tabs and survives a reload. It leaves the theme and sidebar preference, other people's drafts, and content already recorded on the server. If the sign-out reply is lost, the page checks the session. If the first check gets no answer, the page checks the session a second time. Your choice to clear applies if either check confirms that the session ended. If a check finds you still signed in, or neither check answers, the attempt ends and keeps your browser data. The page tells you the result and lets you sign out again. When it cannot tell, it also explains how to clear the site's data in your browser settings before leaving a shared computer.

The pending choice stays only in the tab making the attempt and does not survive a reload. The choice cannot clear data when a later session expires or another tab signs out. Your drafts stay when a session expires or you sign in again as the same person. If the browser cannot clear its storage after a confirmed sign-out, the app warns you to clear the site's data in your browser settings.

Your personal home is stored separately for each signed-in name and project. It does not sync to other browsers. **Sign out and keep drafts** keeps this preference. **Sign out and clear browser data** removes it. Clearing the site's browser data removes it.

### Logs

The server's own log names no request. It logs when it starts and when something fails. A failed sign-in is logged as a reason code, without the token, the identity or the address.

So we can find what is slow or failing, the server sends Sentry (see [below](#when-we-access-or-disclose-your-information)) a trace of each request except health checks, and of each background job. A trace holds the method, the route's pattern (`/api/p/:project/:op`, not the project's key), the operation's or job's name, the status, the server's own database statements and how long each step took. It holds nothing you typed, no network address and nothing that names you.

### Voluntary correspondence

If you contact us through GitHub, that conversation is kept by GitHub, under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

### Why we may keep it

We keep your account, your sessions and your content because you asked us to provide Mainworthy to you. We keep the records of sign-ins and failed attempts because we have a legitimate interest in keeping accounts secure. We use none of it for anything else.

## When we access or disclose your information

**To provide the service.** We use a few providers to run `mainworthy.com`:

- **Cloudflare** carries every request to `mainworthy.com`. It provides the domain's DNS and the encrypted connection, and passes requests on to Render.
  Cloudflare sees your network address and the requests you make. See [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **Render** runs the server and its PostgreSQL database in Oregon, in the United States, so everything the server
  stores is on Render's machines. See [Render's privacy policy](https://render.com/privacy).
- **Google** is the identity provider of `mainworthy.com`. When you sign in, Google checks who you are and tells us
  your account's subject, and the email address and name you allow it to share. Your Google account is under
  [Google's privacy policy](https://policies.google.com/privacy).
- **Sentry** receives the traces described under [logs](#logs) in the United States, and keeps them for its plan's
  retention period.
  They hold none of your content or personal information. See [Sentry's privacy policy](https://sentry.io/privacy/).

**No human looks at your content** except for limited purposes: to fix an error that needs a person, with your permission to help you with a problem you asked about, or when the law requires it.

**When required under applicable law.** We disclose data to a government authority only when we are compelled by valid legal process. We will tell you before we do, unless the law forbids it.

## Your rights with respect to your information

We apply the same rights to everyone, wherever they are:

- **Right to know.** This page lists what we collect and why.
- **Right of access and portability.** An instance admin can export everything in an instance as a text file that any tool can read ([Your data](./data.md)). We will export what we hold about you on request.
- **Right to correction.** Ask us to correct anything about you that is wrong.
- **Right to erasure.** Ask us to forget you. We then replace your name with a pseudonym, including attribution in question evidence, saved command replies and report receipts. New question evidence stores actor ids and resolves names when read. We revoke your linked identities, tokens and invitations. We erase each identity's issuer and subject. We clear your token and identity labels, including labels on previously revoked rows. We end your sessions, whose records are then deleted as [sessions](#sessions) describes. The history still says that one person did each thing, without saying who.

  Attachments and their file names also stay when a person is forgotten. Screenshots and files can contain personal information. Mainworthy does not scan or redact them, and has no attachment deletion control yet. Text you typed into cases and notes stays because Mainworthy cannot yet erase part of its history ([#40](https://github.com/endqwerty/mainworthy/issues/40)).

  A fingerprint of each request sent with a command id also stays. The fingerprint is a SHA-256 hash. It prevents a retried request from being recorded twice. Someone who holds the database can also use the fingerprint to confirm a name they already guess. Your name stays in replies and questions saved before 2026-10-14 if you were forgotten before then. Records of your tokens and identities stay, with nothing in them that signs in. The records include when they were made and used. Your invitations are deleted 30 days after they end. Your tokens' network addresses are erased 30 days after the tokens end. See [Data retention](#data-retention).
- **Right to restrict processing and to object.** Ask us, and we will tell you what we can do.
- **Right to complain.** You can complain to the data protection authority where you live.
- **Right to non-discrimination.** Exercising these rights never costs you anything.

You can manage your sessions and sign-in methods yourself. Under Settings, **Your sessions** lists every session you have open and lets you end any of them. **Your sign-in** unlinks an identity, as long as one is left.

A person who administers the instance can forget somebody through Settings, **People**, **Forget a person**, or `mainworthy actor forget <name> --confirm <name>`. Both the page and the command require confirmation and explain what stays. Their warning also names the linked provider identities that forgetting erases, and the team memberships it removes. The page opens a confirmation beside the selection. **Cancel** or <kbd>Esc</kbd> closes the confirmation without forgetting anybody. Your own name and the current owner's name are unavailable, with the reason beside each. [People, agents and pipelines](./access.md#forget-a-person) gives the steps.

There is no in-app request for forgetting or self-service account deletion yet. For other requests, contact us as described in [changes and questions](#changes-and-questions). We may need to make sure a request comes from you before acting on it.

## How we secure your data

Every connection to `mainworthy.com` is encrypted with TLS. We store tokens, session cookies and invitation codes as SHA-256 hashes. Credential tables keep only hashes of these secrets. Mainworthy does not encrypt the database itself. The server protects the database. An export never contains a linked identity, a token, a session or an invitation.

## Data retention

We keep information only for as long as it is needed:

| What | How long |
| --- | --- |
| Failed sign-in attempts | Digest-keyed counters in PostgreSQL, used for at most 30 minutes after the last failure. Restarts preserve them; periodic cleanup removes expired rows, and capacity eviction can remove older rows sooner. |
| A sign-in at the identity provider in progress | Usable once for 5 minutes across instances and restarts. Stored in PostgreSQL; periodic cleanup removes expired records. |
| A linked identity | Until you unlink it, a recovery link replaces it, or your account is forgotten |
| Project change-stream hints | 24 hours. A returning stream with older or missing history refreshes the project. |
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

Have a question, a concern or a request about your data? Email `admin@mainworthy.com`. The owner chose this private contact for now and chose to publish no postal address.

---

This policy is adapted from the [Basecamp open-source policies](https://github.com/basecamp/policies) by 37signals, used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). We changed it to describe Mainworthy.

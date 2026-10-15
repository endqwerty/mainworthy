# 0013: A client asks what became of a command, and a draft keeps the version it was written on

- Date: 2026-10-12
- Status: proposed (built in the pull request for issue #81; the owner reviews)

The ninth review of the web UI found that a merge typed by hand in the conflict card could undo a colleague's
newer change (R9-1, issue #81). Two fixes each closed the reported route and opened others
(`docs/reviews/2026-10-12-mvp/ui-r9-fix-check-1.md` and `-2.md`). All of them had one cause. After a merge whose
reply was lost, the page decided whether the server had recorded it by comparing the recorded head with what it
had sent. The server records a merge together with whatever changed since the conflict was shown, and somebody
else can record the same text, so the comparison was wrong in both directions.

## Decision

**The server answers the question.** A sixteenth operation, `command`, takes a command id and says what became
of it: `none`, `begun` or `done` with the reply the command was given. It answers only the caller who sent the
command, in the project it was sent to. The `commands` table already held all of it. This is the read issue #71
asks for.

**The conflict card uses it.** Each press of "Resolve conflict" sends its merge under a new command id and
stores the id and the body with the draft, before the request leaves. When the card's question is answered, the
page asks the server about each id. A reply names what the merge did: the version it became, a new conflict, a
proposal that waits for a person, or nothing.

**A draft keeps the version it was written on.** The page moves a draft onto another version in one case only:
text that is later than a merge the server recorded is carried onto the version the server made of that merge,
and only where the person saw what they change. Later text is what was typed in the card after the merge was
sent, and what the draft holds that the card was not made of. Every field of that version is either the
person's, as they sent it, or somebody else's. Later text in a field of the second kind stays on the draft's own
base. So does the text of a card whose question was answered by anything other than its own merge. Proposing a
draft on the version it was written on lets the server merge it with what is recorded now, or ask, which is what
a base version is for (decision 0004). The page never takes "the current head" as a draft's base because two
bodies look alike.

**Settling a card removes nothing typed that is not recorded.** A draft can hold text that no merge carries,
such as a step with an expected result and no action yet. It stays with the draft when a card is settled or
moves to a new question. A card and its draft are dropped in two cases only: the card's own merge was recorded
and neither holds anything beyond it, or the recorded head holds everything the person typed in them. A side
chosen in the card is text of a recorded version and does not count as typed. This is about settling a card.
Leaving the editor in the ordinary way keeps such a step by the same rule since issue #86: the version is
recorded without it, and the draft that holds it stays on the device and is not proposed again for it.

## What was turned down

- **Cutting the hand-typed merged field** (the smaller option in issue #81). Without it a card has no later
  text. The comparison would stay, and with it the routes that need no typing after the merge: a head that
  moved on before the page asked, and the same person answering from another client.
- **Comparing more fields, or only the fields in conflict** (the two attempts). Any comparison of bodies answers
  "does the head look like my merge", and the question is "did my merge make it".
- **Reading the question's decision instead of the command.** The decision says what was answered, not which
  request answered it. Two clients of one person can send the same body.
- **Sending the same request again under the same id**, as `propose` does. A replay records a merge the person
  may have edited since. Asking records nothing.

## The ordinary save asks too (issue #71)

Added when issue #71 was built, and corrected after its review. The editor's save stores its request with the
draft before it leaves, as the card does. When its reply never comes (a reload, a closed tab, a dropped
connection), the page asks `command` about its id before it sends anything: as soon as the draft is in the
pane, and again when the editor is left if that question had no answer.

- `done`: the recorded reply is handled as if it had come in time. The request is not sent again, and later
  text goes out under a new id on the version the reply names.
- `none`: not recorded yet, which is not "never will be": the request may still be on its way. The one request
  that is safe to send either way is that save itself, under its own id: the server records it once, however
  many copies arrive, and gives each the first reply. So it goes again, unchanged, its reply is handled as any
  reply, and later text follows it under a new id on the version that reply names.
- `begun`, or no answer: nothing is sent, and the draft is kept.

Asked as the draft comes into the pane, a save is only settled: taken as recorded, or sent again. Nothing typed
since is sent until the editor is left.

Turned down, in the first build of #71: on `none`, sending the draft's current text under a new id. Its review
found that a save still on its way then lands after it and is recorded too: a new case's first save as a
second case, an edit as a conflict with the person's own version. Turned down at that review: on `none` as the
draft comes into the pane, keeping the save and sending nothing until the editor is left. A tab closed twice in
one sentence whose first close never reached the server would then record nothing at the second close, because
a closing page cannot wait for the answer.

A page that is closing cannot wait for the answer, so it sends nothing more, and the next page that opens the
draft asks. Turned down: sending the newer text under a new id from the closing page. It does not know whether
the earlier save was recorded. If it was, the newer text meets it as a conflict with the person's own version,
and the question waits for somebody to answer it. The text is kept either way; asking later costs one
question and no conflict.

The page sends under an id it has used only the request it first sent under it, unchanged. Nothing here relies
on the server refusing a repeated id whose request differs; that rule stays as the backstop.

## What it does not do

- A save sent again on `none` records the text it carried, which the person may have changed since. What they
  typed later is the next version, so the history shows both.

## Taking over keeps the last save (issue #217)

"Take over here" keeps the former window's remembered request, including its command id and exact input.
The new window uses the same recovery path as a reload: ask `command`, replay the unchanged request on
`none`, and carry later text onto the version that request made. A lost answer leaves the request in the
draft for the next attempt. The draft gets a new command id for future edits, as before.

Clearing the request on takeover let an in-flight create and the new window's save make two cases.
Handling recovery separately in the takeover action would duplicate the ordinary save's rules.

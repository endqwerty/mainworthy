# 0013: A client asks what became of a command, and a draft keeps the version it was written on

- Date: 2026-10-12
- Status: proposed (built in the pull request for issue #81; Daniel reviews)

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
Leaving the editor in the ordinary way still drops a step with no action, as it did before (issue #86).

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

## What it does not do

`propose` still replays a request whose reply was lost (issue #71 stays open for that). The operation it needs
is now there.

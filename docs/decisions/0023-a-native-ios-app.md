# 0023: A native iOS app, as one more client of the operations

- Date: 2026-10-13
- Status: proposed (built in the pull request that adds this file; the owner reviews)

Decision 0018 gave a phone its own layout in the web app and turned a native app down: "Two more clients to
build, release and keep in step with a product that changes every day and has one user." On 2026-10-13 the owner
decided otherwise (issue #171). A person works with Mainworthy on a phone in a native app. The phone layout of
the web app stays, as a backup for reading. The app starts without a paid Apple developer account.

That part of 0018 is replaced. Its objection is not answered by deciding against it, so most of this decision is
about the objection: how an app that nobody here compiles stays in step with a server that changes every day.

## Decision

**The app is one more client of the operations.** It calls what the web UI and the command line call
(`src/server/ops/index.ts`), and the server did not change for it. It signs in the way a browser does: a name and
a password, or a token, opens a session and the reply sets a cookie (decision 0017). The app keeps that cookie in
the device's keychain and nothing else: not the password and not the token. It reads the cookie from the
reply's header as text, because the system's cookie parser applies a browser's rules for the `__Host-` prefix
and they differ between versions of the system. The session is listed under "Your
sessions" as "Mainworthy for iPhone" and can be ended from anywhere.

**What the app reads is written in TypeScript, once.** The server's rows have no schema (issue #52), and an agent
that changes a reply does not open a Swift file. So `scripts/ios/contract.ts` lists every field of every reply the
app decodes, in a small language (`scripts/ios/shape.ts`) that gives two things for each shape:

- a check, which `test/ios-contract.test.ts` holds real replies of a real instance to. It runs with every other
  test, on Linux. A change that removes or retypes a field the app reads fails there and names the field. A field
  that is added fails nothing.
- a Swift type, which `bun scripts/ios.ts gen` writes (`ios/Kit/Sources/MainworthyClient/Generated/Wire.swift`).
  The same test fails when that file is not what the contract says.

The app has no other description of a reply, so the check and the decoder cannot disagree. The words of the
queue (what an answer is called and what it does) are written from `src/core/kinds.ts` by the same command.

**A function of `src/core` that the app needs is written again in Swift, and held to the original.** There are
two: the sentence that says what leaving a question open costs, and the queue's count in words
(`src/core/stakes.ts`). `gen` runs the TypeScript on a list of inputs and writes what it returned
(`Parity.swift`); the app's tests hold the Swift to it. Everything else of the core the app asks the server for:
the server parses an outline, merges an edit and counts a verdict.

**The app's tests talk to a real Mainworthy.** `bun scripts/ios.ts test` starts a server in the same process,
fills a project for each test (`scripts/ios/scenario.ts`) and runs the package's tests on a Mac with no
simulator, in under a second once built. `bun scripts/ios.ts uitest` drives the app's screens in a
simulator against the same kind of server. A job on a macOS runner runs the first and builds the app.

**The server is ahead of the app.** The instance follows `main` within minutes (issue #90). The app on a phone is
the build somebody last installed. So the app reads leniently and says what it cannot do:

- a kind of question it does not know, and evidence it cannot decode, is shown by its title and has no answer
  to give in the app,
- an answer it has no words for is listed and sent to the web app,
- a reply it cannot decode is said to be that, with the advice to install a newer build.

Nothing has to stay compatible before 1.0 (the working rules), and that holds for the app too: a change may
break the installed build. The contract test makes sure that is known in the pull request that does it.

**A view never holds the connection.** The Swift package has two modules. `MainworthyClient` knows the server and
hands out values (a question, an answer). Everything in it that sends a request is `package`, a Swift access level
that the app target, being outside the package, cannot reach. `MainworthyScreens` holds what each screen shows
and does. A SwiftUI view binds to one of its classes. A new screen is a function in the first, a class in the
second and a view, and the compiler refuses a view that reaches past the middle for the client. It cannot refuse
a view that uses the system's own networking, so a test does (`test/ios-contract.test.ts`, "no view sends a
request of its own"). The one place that sends follows no redirect: it sets the cookie on each request by hand,
and the system would carry it to wherever a reply pointed.

**A question is answered from its own page.** Decision 0018 found, in three reviews, ways to record a decision
about a question nobody had opened. The app has no answer in a list: no swipe, no menu. The page of a question
shows its evidence, and the answers are under it, each with the sentence that says what it does. The evidence an
answer was given on is kept inside the question's value, where a view cannot change it, and an answer goes out
on the question as it was when the person chose it: a sheet that asks for a reason does not pick up evidence
that arrived behind it. What was not shown is not answered. A new case and an edit to what a case says are
accepted only once their documents were read: the case as it is beside the case as it would be, with where a new
one goes and who runs it. A proposal that does anything else (it restores an earlier version, moves or archives
cases, or changes the policy) is answered in the web app, because the app does not show all of it. A reply
that lacks a document the question counted is unreadable, not a smaller change. A finding's suggestion is shown
with the step it would change, which need not be the step the finding is on. A question that is read by itself,
because no list on the screen holds it, takes what the person's answer is worth from a listing of what it is
about, and says nothing about it where there is none: the server decides when the answer is given.

**A free Apple ID is enough.** That rules out what needs a paid membership: push notifications, passkeys (they
need an associated domain) and TestFlight. An app signed that way opens for seven days, so installing is one
command, `bun scripts/ios.ts install`, and the sign-in survives it. The team that signs is read from the
certificate on the Mac into a file that is not committed (`ios/Config/Local.xcconfig`): the repository is public.
The bundle identifier ends in the team's id, because an identifier belongs to one team for good.

**The Xcode project is not committed.** `ios/project.yml` is the project, and XcodeGen writes
`Mainworthy.xcodeproj` from it before every build. A project file is hard to edit by hand and to merge.

## What the first pull request builds

Signing in and out, switching project, and the queue: every kind of question with its evidence, answering with a
reason and a reference where they are asked for, withdrawing a decision, the decided list, and following the
project's change stream while the app is in front. Runs, the suite, changes and "Your sessions" follow in
their own pull requests (issue #171).

## What was turned down

- **Running `src/core` in the app** (JavaScriptCore), which the second design candidate proposed. It would give
  the app the outline grammar, the diff and the merge unchanged. The app needs none of the three yet: the server
  parses an outline, and an edit is shown by setting two versions side by side by their step ids. It costs a
  bundle to build, a bridge and a start-up time. It is the way to go when the app has to merge or diff offline.
- **Swift types written by hand, checked against stored replies.** A stored reply changes with every field the
  server adds, so every such change would have needed the files written again, by an agent with no reason to look
  at them. The contract names only what the app reads.
- **The phone layout in a web view.** The owner's request is the opposite, and 0018 lists what that layout
  cannot do on a phone.
- **A committed Xcode project**, for the reason above.
- **A change to `decide` so that an undo names the decision it withdraws.** Withdrawing names the question, so
  an answer somebody else gave in the same second could be the one withdrawn. The web UI has the same gap. It is
  a server change for every client, filed as its own issue.
- **Keeping an unsent answer across a restart of the app.** A write is sent again under the same command id
  while the app runs. An app that is closed mid-request shows the server's state when it opens.

## What is not checked

No real phone has run it yet: the owner installs it. The tests ran in the iOS 27 simulator and on macOS. The
session cookie's https name was tested against a server told it was behind TLS, not through a real certificate.
Not checked: VoiceOver, Dynamic Type at its largest sizes, an iPad.

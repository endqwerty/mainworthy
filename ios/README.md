# The iPhone app

A SwiftUI app that is one more client of Mainworthy's operations. What it is for and why it is built this way:
[decision 0023](../docs/decisions/0023-a-native-ios-app.md). What a person does with it:
[the guide](../docs/guide/iphone.md). What is still to build: issue #171.

Every command below is run from the root of the repository. On a Mac whose first `bun` is older than 1.4, put
the newer one first: `export PATH=/opt/homebrew/bin:$PATH`.

## Install it on your phone

You need a Mac with Xcode, XcodeGen (`brew install xcodegen`) and an Apple ID added in Xcode under Settings,
Accounts. A free Apple ID will do.

1. Connect the iPhone with a cable, unlock it and choose Trust.
2. Run the install:

	```
	$ bun scripts/ios.ts install
	```

3. The first time, the phone refuses to open the app until you trust the developer: Settings, General, VPN &
   Device Management.

The command reads the team from the development certificate on the Mac and writes it to
`ios/Config/Local.xcconfig`, which is not committed. To sign with another team, edit that file.

A paid team can tie the app to `mainworthy.com` for native passkey sign-in and password AutoFill, including
1Password. Uncomment `CODE_SIGN_ENTITLEMENTS` in that file (`App/Mainworthy.entitlements`), install,
and have the instance list the name the command prints in
`MAINWORTHY_APPLE_APPS` (`docs/deploy.md`). A personal team's build fails with that line: Apple signs an associated
domain for a paid membership only.

An app signed with a free Apple ID opens for seven days. The app says until when under **You**, **Works
until**. Run the command again before then. The sign-in is kept in the phone's keychain and survives it.

`bun scripts/ios.ts install --dry-run` builds and signs and installs nothing.

### Another instance

The app signs in to `mainworthy.com` and does not ask for an address: running Mainworthy elsewhere is a future
item for the apps (issue #233). A build from source for another instance names it in `ios/Config/Local.xcconfig`:

```
MAINWORTHY_INSTANCE = 192.168.1.20:7357
```

Write the host and its port with no scheme: `//` starts a comment in that file. A host on the phone's own network
(a private address, `localhost`, a `.local` name) is reached over http, any other over https. A launch argument
wins over the setting, `-instance <address>`, which is how the screen tests point the app at the server they
start. For native passkeys and saved-password AutoFill at another HTTPS instance, also set
`MAINWORTHY_WEBCREDENTIALS_DOMAIN = mainworthy.example` to its host without a scheme or port.
Enable `CODE_SIGN_ENTITLEMENTS = App/Mainworthy.entitlements` and sign with a paid team.
Set the instance's `MAINWORTHY_PUBLIC_URL` to its HTTPS address and `MAINWORTHY_APPLE_APPS` to the team and
bundle identifier printed by the install command. Its public
`https://mainworthy.example/.well-known/apple-app-site-association` must return that identifier under
`webcredentials.apps`, without authentication or a redirect. Apple must be able to fetch it over HTTPS on
the domain's standard port, even if the app reaches the instance on another port. Rebuild and reinstall after
changing the entitlement. The distributed app cannot add arbitrary associated domains at runtime.
[Decision 0122](../docs/decisions/0122-native-passkey-sign-in.md) records this limit.

## Check passkey sign-in

`PasskeySignInTests` puts a fake `PasskeyAuthorizing` in place of AuthenticationServices. It checks the
challenge, RP ID, assertion bytes, ceremony cookie, saved session, cancel, unavailable credentials, refusal,
stale-attempt retry and password fallback. Server tests keep native and web origins separate and check
expiry, replay and cookie binding.

The iOS test instance uses HTTP loopback and has no configured public RP address.
`POST /api/login/challenge` with `{ "native": true }` returns 400, asking for an HTTPS public address and an associated app domain.
A separately configured HTTP localhost instance also refuses native challenges, while allowing web challenges.
The simulator build uses `CODE_SIGNING_ALLOWED=NO` and has no signed associated-domain entitlement. It cannot complete this native ceremony against that test instance.
A simulator passkey assertion is not covered by a UI test. Physical-device sign-in, including an external
credential provider, remains open in [issue #205](https://github.com/endqwerty/mainworthy/issues/205).

### Identity provider sign-in

`ASWebAuthenticationSession` presents the provider and receives the fixed OIDC return URL
`com.mainworthy.app://signin/oidc` through its completion handler. It takes `com.mainworthy.app` as its
`callbackURLScheme`; no `CFBundleURLTypes` registration or opened-URL handler is needed. No signing-team
setting is needed for the custom scheme. The app exchanges a one-minute, verifier-bound code
with its instance and keeps only the session cookie. Configure OIDC as for the web app and register an
additional provider redirect URI, `MAINWORTHY_PUBLIC_URL/api/login/oidc/native/callback`.

A universal link would also need an associated-domains entitlement, a paid signing team and an `applinks`
entry for the app and callback path in the instance's `apple-app-site-association`. The current
`webcredentials` entry only provides password AutoFill. Decision 0121 records the handoff and threat model.
Real-device provider sign-in remains open in issue #421.

## Send it to TestFlight

A paid team can send the app to App Store Connect, and TestFlight installs it on the team's phones with no cable.
A build from TestFlight opens for 90 days.

1. Once: in [App Store Connect](https://appstoreconnect.apple.com) accept the agreements it shows, then Apps, +,
   New App, with the bundle ID that `ios/Config/Local.xcconfig` names (`com.mainworthy.app.` and the team's id).
   In the app's TestFlight tab, make an internal group with automatic distribution on, and add yourself.
2. Send a build:

	```
	$ bun scripts/ios.ts upload
	```

3. Apple processes it, usually in minutes. Then the TestFlight app on the phone offers it.

The command builds for release, signs for distribution with the Apple ID in Xcode under Settings, Accounts, and
uploads. The first time, Xcode makes the team's distribution certificate. The build number is the minute it was
built, in UTC (`202610141530`): App Store Connect takes each number once and wants each one higher than the last,
and when it has that number already, Xcode raises it; the command prints the one sent. The app's version is
`MARKETING_VERSION` in `Config/Base.xcconfig`. `Info.plist` answers the question about encryption, so a build is
not held for it. `App/PrivacyInfo.xcprivacy` says what the app collects (the name a person signs in with, what they
write and what each session records, for the app to work, tracking nobody) and why it reads its own settings, which Apple asks of every
upload. The App Privacy answers on the App Store page are a separate form, needed only for the App Store, and the
privacy policy is `https://mainworthy.com/privacy` (`docs/guide/privacy.md`).

`bun scripts/ios.ts upload --dry-run` builds and signs the same and writes the `.ipa` to the cache instead of
sending it. Testers outside the team need Apple's beta review first, and issue #210 says what else is left before the
app suits people who do not run their own instance.

### Sent on its own after a deploy

The owner's Mac sends the app without being asked: a job there (the homelab repository,
`services/mainworthy-testflight/`) reads `https://mainworthy.com/healthz` every five minutes. When the commit
that instance runs passed the `gate` job of its push run on `main`, and `ios/`, `scripts/ios.ts` or
`scripts/ios/` changed since the commit it last sent, it runs `bun scripts/ios.ts upload` in a checkout of that
commit, after reading both again. So TestFlight gets the app of the server it talks to, from a commit that passed
CI, unless a deploy or a CI re-run lands in the minute the archive takes before the send. A change that touches none
of those paths sends nothing. The job keeps its builds off the SSD with
`MAINWORTHY_IOS_CACHE`, because a job launchd starts may not read a removable volume.

## Licence and the App Store

The app is under the Apache License 2.0 like the rest of the repository, copyright held by the owner
(decision 0025). It contains no code from others, only its own and Apple's frameworks, so it carries no
third-party notice. It shows its copyright line, its licence and a link to the instance's page "Licence" under
**You**, **About**; the copyright line is `NSHumanReadableCopyright` in `App/Info.plist`.

What App Store Connect asks about the licence, and what to answer:

| Field | Answer |
| --- | --- |
| Copyright, in the version's information | The line in `Info.plist` without the word `Copyright`: the year and the name (Apple adds the ©) |
| App Information, License Agreement | Apple's standard licence agreement. The Apache licence covers the source; the App Store build is delivered under Apple's agreement, which the copyright holder may choose for their own build |

`test/licences.test.ts` fails when `Info.plist`, `NOTICE` and the UI test name different holders.

## Work on it

| Command | What it does | Time |
| --- | --- | --- |
| `bun scripts/ios.ts test [filter]` | The package's tests, on the Mac, against a Mainworthy started for them | 2 s once built |
| `bun scripts/ios.ts uitest [filter]` | The app in a simulator, driven through its screens. Prints where its screenshots are | 80 s |
| `bun scripts/ios.ts build` | Builds the app for a simulator | 20 s |
| `bun scripts/ios.ts gen` | Writes the Swift that is made from the TypeScript | 1 s |
| `bun scripts/ios.ts serve` | Starts the tests' Mainworthy and prints how to sign in and the launch argument that points the app at it, to try the app by hand | |
| `bun scripts/ios.ts project` | Writes `ios/Mainworthy.xcodeproj`, to open in Xcode | 1 s |
| `bun scripts/ios.ts upload [--dry-run]` | Builds for release and sends it to TestFlight ([above](#send-it-to-testflight)) | 35 s and the upload |

Builds go to `~/.cache/mainworthy-ios` (or `$MAINWORTHY_IOS_CACHE`), never into the repository: `test/architecture.test.ts` reads every file
here. There is one simulator, named Mainworthy, so one `uitest` runs at a time on a machine: a second one,
from any checkout, waits for the first.

## Where things are

| Path | What |
| --- | --- |
| `project.yml`, `Config/` | The Xcode project as XcodeGen reads it, and its build settings |
| `App/` | The SwiftUI views. They bind to a class of `MainworthyScreens`. The client is out of their reach, and a test keeps them from the system's networking |
| `Kit/Sources/MainworthyClient/` | Everything that knows the server. `Server.swift` sends; the other files are the values it hands out |
| `Kit/Sources/MainworthyClient/Generated/` | Written by `gen`: reply types, the queue's words, and the shared merge code. Never edited |
| `Kit/Sources/MainworthyScreens/` | What each screen shows and does: one class for each |
| `Kit/Tests/` | The package's tests. `Support/Live.swift` gives a test its own project on the tests' server |
| `UITests/` | The tests that drive the app in a simulator |
| `../scripts/ios/` | The contract, the Swift writer, and the scenario and server the tests use |

## When the contract test fails

`test/ios-contract.test.ts` runs with every other test and fails in two ways.

**A reply is not what the app reads.** The message names the field: `$.items[0].evidenceHash: Invalid input: expected string, received undefined`.
The app decodes that field, and the server no longer sends it that way.

1. If the change to the server was not meant, fix the server.
2. If it was, change the shape in `scripts/ios/contract.ts` to what the server sends now.
3. Run `bun scripts/ios.ts gen`.
4. On a Mac, run `bun scripts/ios.ts test` and fix what no longer compiles in `ios/Kit`. Without a Mac, push:
   the `ios` job does the same and says what it found. Say in the pull request that the app's installed build
   stops reading that reply until it is installed again.

**A generated file is not current.** Run `bun scripts/ios.ts gen` and commit what it wrote. This happens after a
change to an answer's label or help in `src/core/kinds.ts`, or to a sentence in `src/core/stakes.ts`. If the
sentence's logic changed, a test of the app fails next (`ValueTests`): change `Stakes.swift` to match.

## Add a screen

The queue is the example to copy.

1. **What it reads.** Add the reply's shape to `scripts/ios/contract.ts` and to `SHAPES`, a test of it against a
   real reply in `test/ios-contract.test.ts`, and run `gen`.
2. **What can be asked.** Add a file to `MainworthyClient` with the values the screen shows and an
   `extension ProjectClient` with a function for each thing a person does, as `Queue.swift` has `answer`. A
   function takes and returns the app's own values and hides the operation, as `answer` hides `decide`. A value
   is built from its `Wire` type where it is decoded (`Question.swift`). Test it against the server in a file
   beside `LiveTests.swift`.
3. **What the screen holds.** Add a class to `MainworthyScreens`, as `QueueScreen`, and make it in
   `Workspace.open`, where a project's screens are made. Test it in `MainworthyScreensTests`.
4. **The view.** Add it under `App/` and a tab in `WorkspaceView.swift`.
5. **The whole way through.** Add a test to `UITests/` that does on the screen what a person would.

Four things the queue does that a copy must keep:

- **A screen is one project's.** `Workspace.open` makes every screen anew for the project that is opened and
  lists them in `screens`, which is what the change stream reads again. A view takes its screen from the
  workspace and is given `.id(workspace.project?.key)`, so nothing typed or opened in one project is shown in
  another.
- **A read that was overtaken is dropped** (`PagedList` in `ResultsScreens.swift`), and a list read past its
  first page is read as far again. What a page shows does not depend on the list holding it: a question whose page
  is open is read by itself where the list does not have it (`open` in `QueueScreen`).
- **What is typed is kept by the screen's class**, not by a view's state: the workspace, with its screens, is
  kept while a session that the server ended is renewed by the same person (`AppModel.sessionEnded`), and a
  view's own state is not.
- **What is sent later is sent on what was shown.** A sheet or a dialog keeps the value the person acted on
  (`Chosen` in `QuestionView`), not a ref to look up again when it is submitted.

## Resolve overlapping edits

`CaseEditorScreen` owns the conflict and the choices made in its editor. `Conflicts.swift` reads the full
proposal, keeps the question's evidence hash, and interprets the effects of `decide`. A lost reply is recovered
through `command` before another request is sent. The editor locks choices while that result is unknown.

The web and phone use `src/core/merge3.ts` for both three-way merging and applying choices. The server
uses its three-way merge too. `gen` bundles the pure code through `scripts/ios/merge.ts` into `Generated/MergeRuntime.swift`; `Conflicts.swift` runs that string
in a fresh JavaScriptCore context. No server code, hashing library or network API is in the bundle.
One JSON table in `Kit/Tests/MainworthyScreensTests/Fixtures/conflict-choices.json` runs through the actual
web conflict buttons and Swift package tests. It includes deleted-step restoration, both sides of action
and removal choices, concurrent additions, and an explicit order applied before a later restoration.
The contract test holds the generated string to the current source, and `ConflictTests` runs it against real
server conflicts and checks mixed choices, removed steps, order, refusal, a moved case and lost replies.

## Saved queue answers

Projects expose an opaque `identity`, retained by export/import and regenerated on creation. Workspace scopes screens and outboxes by this identity, and FileAnswerStore adds it to the instance, actor id and key used for the file name. PreparedAnswer freezes it, and every send includes `projectIdentity` in the shared write envelope. The registry checks it inside the write transaction before command replay. Refresh retires a replaced project's outbox; a send delayed past replacement still receives a server refusal. `details.projectIdentity: "obsolete"` maps to the client's `obsolete_project` refusal and the outbox's terminal **Obsolete** status.

An unfinished answer from an earlier identity or a build without identity becomes **Obsolete** and is never sent or recovered against the current project. Completed entries keep their outcomes and statuses. Outcomes take precedence even if an earlier build marked a completed entry obsolete. Historical outcomes do not clear current drafts.

When the current identity has no file, FileAnswerStore imports readable earlier files for the same instance, person and key. After its first successful atomic write, it removes those imported files. Loading a readable current file also removes readable earlier files in that scope to complete cleanup interrupted by app closure. A retired outbox ignores late replies and stale screen actions, so they cannot recreate its file. Cleared outcomes cannot reappear after another replacement. Unreadable earlier files stay on disk and are skipped with one notice per import. They do not block new saved answers. An unreadable current file still blocks writes. ProjectIdentityTests covers repeated replacement, interrupted cleanup, scope isolation, recorded history, unreadable earlier files, legacy files, foreground replacement and sends paused across replacement and retirement.

`AnswerOutbox` belongs to one instance, signed-in person, and project. `Workspace` owns every accessible project's outbox, so its existing stream reconnect loop sends waiting answers even after a project switch. `QueueScreen` calls `AnswerOutbox.record` with the questions as they were shown: it captures one `PreparedAnswer` through `ProjectClient` (one `decide` request with `all`, for one question or a selection of up to `decideMax`), saves it before sending, and leaves each question open until the server confirms its decision. The reply must name every question once; the outbox keeps an outcome per question (decision 0088). Views still reach the server only through screen classes.

The saved `decide` input includes the original evidence, answer, reference, reason, command id, and `ifOpen: true`. A question decided meanwhile becomes Overtaken without replacing the decision that stands. A known command replays its recorded reply before the server checks `ifOpen`. Replay uses that input unchanged. A lost or unreadable reply leaves it waiting. Changed evidence and refusals become outcomes, never silent retries on newer evidence. Atomic files under Application Support are excluded from device backups when saved or loaded. They survive app closure and explicit sign-out, scoped to the stable actor id and instance. The session reply supplies actorId, so a new person reusing a forgotten name cannot inherit these files. Closing the app stops delivery. Reopening still needs a connection to identify the signed-in person. See decision 0074.

Mapping answers keep `MappingSubmission` and its `ifOpen` precondition. They need a connection and are not saved in `AnswerOutbox`. Their sheet and uncertain-reply notice say so. A refusal shows the server's reason. An uncertain reply keeps the same command in memory for **Retry**, with choices locked until the result is known. Closing the app loses that mapping command and its choices.

The first waiting answer with an uncertain reply offers **Keep trying** and **Drop saved answer**. Keep trying resends the same answer and command id. Drop asks for confirmation, shares the send guard, and calls `ProjectClient.answerCommand`. A recorded reply becomes its outcome. On `none`, only an answer whose every attempt got a definite HTTP error reply can be removed. Any uncertain attempt instead becomes **Dropped**, never sends again, and lets later answers run. Each send pass sends waiting answers first, then checks dropped commands, including after relaunch, stopping those checks after the first failed lookup. The pass then sends answers saved during those checks, without repeating the checks. A failed send pauses the queue and skips Dropped checks. QueueScreen waits for its own answer attempt, so it can confirm a saved outcome before the Dropped checks finish. Clear outcomes keeps Dropped entries until a recorded outcome exists.

After 24 hours, **Forget** offers confirmed removal from this device and warns that a recorded outcome will no longer show here. It never removes an entry automatically. The outbox persists `droppedAt`, checks the device clock again at confirmation, and saves before removing the entry from memory. A clock moved back delays Forget; a clock moved forward can advance it. An older Dropped entry with no time starts a full wait on its first successfully saved read.

Each entry stores typed delivery metadata. Missing metadata in earlier files counts as uncertain. The outbox saves uncertainty before sending; `WriteDelivery` in the client tracks all transport attempts so a later rejection cannot erase an earlier lost reply. Local persistence must succeed before later entries resume. A `begun`, unreadable, or failed command lookup keeps the waiting answer and explains why. A stopped workspace ignores a late lookup reply.

`QueueScreenTests` covers persistence, ordered replay, lost replies, storage failure, separate scopes, command recovery, offline drop refusal, and concurrent drop/send/save paths against the local server. `QueueUITests/testSavedAnswerSurvivesClosingAndShowsItsOutcome` uses the test server's answer proxy to make `decide` temporarily unavailable while sign-in and reads work. It checks the waiting entry after a relaunch, Drop confirmation and cancellation, immediate removal after a definite rejection, persistence of an uncertain Dropped entry, and a later recorded answer after restoring delivery. It also checks Forget after a day, cancellation, confirmed removal, and persistence of the removal. DEBUG builds accept `-answer-clock-offset <seconds>` for that test; release builds always use the device clock. Kit tests inject a clock and cover the exact 24-hour boundary, backward changes, older files, and failed saves. No such route exists in the product.

The simulator command uses `CODE_SIGNING_ALLOWED=NO`. Its executable has no keychain entitlement, so Security returns `errSecMissingEntitlement` (-34018) when `KeychainStore` adds or reads the session. The saved-answer UI test signs in again as the same person after relaunch. It proves that answer files survive closure, not that the simulator keeps a session. Signed device builds use the keychain across relaunches; package tests cover restoring a stored session, but this UI run does not check a signed device.

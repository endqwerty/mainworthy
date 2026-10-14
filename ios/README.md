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

A paid team can tie the app to `mainworthy.com`, so the phone's AutoFill (and 1Password through it) offers the
login saved for that site on the sign-in screen: uncomment `CODE_SIGN_ENTITLEMENTS` in that file
(`App/Mainworthy.entitlements`), install, and have the instance list the name the command prints in
`MAINWORTHY_APPLE_APPS` (`docs/deploy.md`). A personal team's build fails with that line: Apple signs an associated
domain for a paid membership only.

An app signed with a free Apple ID opens for seven days. The app says until when under **You**, **Works
until**. Run the command again before then. The sign-in is kept in the phone's keychain and survives it.

`bun scripts/ios.ts install --dry-run` builds and signs and installs nothing.

## Work on it

| Command | What it does | Time |
| --- | --- | --- |
| `bun scripts/ios.ts test [filter]` | The package's tests, on the Mac, against a Mainworthy started for them | 2 s once built |
| `bun scripts/ios.ts uitest [filter]` | The app in a simulator, driven through its screens. Prints where its screenshots are | 80 s |
| `bun scripts/ios.ts build` | Builds the app for a simulator | 20 s |
| `bun scripts/ios.ts gen` | Writes the Swift that is made from the TypeScript | 1 s |
| `bun scripts/ios.ts serve` | Starts the tests' Mainworthy and prints how to sign in, to try the app by hand | |
| `bun scripts/ios.ts project` | Writes `ios/Mainworthy.xcodeproj`, to open in Xcode | 1 s |

Builds go to `~/.cache/mainworthy-ios`, never into the repository: `test/architecture.test.ts` reads every file
here. There is one simulator, named Mainworthy, so one `uitest` runs at a time on a machine: a second one,
from any checkout, waits for the first.

## Where things are

| Path | What |
| --- | --- |
| `project.yml`, `Config/` | The Xcode project as XcodeGen reads it, and its build settings |
| `App/` | The SwiftUI views. They bind to a class of `MainworthyScreens`. The client is out of their reach, and a test keeps them from the system's networking |
| `Kit/Sources/MainworthyClient/` | Everything that knows the server. `Server.swift` sends; the other files are the values it hands out |
| `Kit/Sources/MainworthyClient/Generated/` | Written by `gen`: the reply types and the queue's words. Never edited |
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
- **A read that was overtaken is dropped** (`reads` in `QueueScreen`), and a list that was read past its first
  page is read as far again. What a page shows does not depend on the list holding it: a question whose page
  is open is read by itself where the list does not have it (`open` in `QueueScreen`).
- **What is typed is kept by the screen's class**, not by a view's state: the workspace, with its screens, is
  kept while a session that the server ended is renewed by the same person (`AppModel.sessionEnded`), and a
  view's own state is not.
- **What is sent later is sent on what was shown.** A sheet or a dialog keeps the value the person acted on
  (`Chosen` in `QuestionView`), not a ref to look up again when it is submitted.

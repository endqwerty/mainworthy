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
here. One agent at a time runs `uitest` on a machine: there is one simulator, named Mainworthy.

## Where things are

| Path | What |
| --- | --- |
| `project.yml`, `Config/` | The Xcode project as XcodeGen reads it, and its build settings |
| `App/` | The SwiftUI views. They bind to a class of `MainworthyScreens` and cannot send a request |
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
2. **What can be asked.** Add a function to `ProjectClient.swift` for each thing a person does. It takes and
   returns the app's own values and hides the operation, as `answer` hides `decide`. A value is built from its
   `Wire` type where it is decoded (`Question.swift`). Test it against the server in `LiveTests.swift`.
3. **What the screen holds.** Add a class to `MainworthyScreens`, as `QueueScreen`, and make it in
   `Workspace.open`, where a project's screens are made. Test it in `MainworthyScreensTests`.
4. **The view.** Add it under `App/` and a tab in `WorkspaceView.swift`.
5. **The whole way through.** Add a test to `UITests/` that does on the screen what a person would.

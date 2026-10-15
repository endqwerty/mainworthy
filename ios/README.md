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
| `bun scripts/ios.ts serve` | Starts the tests' Mainworthy and prints how to sign in, to try the app by hand | |
| `bun scripts/ios.ts project` | Writes `ios/Mainworthy.xcodeproj`, to open in Xcode | 1 s |
| `bun scripts/ios.ts upload [--dry-run]` | Builds for release and sends it to TestFlight ([above](#send-it-to-testflight)) | 35 s and the upload |

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

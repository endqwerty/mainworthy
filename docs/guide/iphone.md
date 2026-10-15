# The iPhone app

Work with Mainworthy from your phone in a native app.
This page says how to install the app, how to sign in and what it does today.

The app has the queue, planned runs, the cases, changes and your sessions (issue #171). What an admin does,
inviting people, tokens and the project's policy, is not in the app: open the instance in the phone's browser,
which gets [a layout of its own](./keyboard.md#on-a-phone).

## Install the app

There is no App Store entry. You build the app from the repository and install it over a cable. You need a Mac
with Xcode, [XcodeGen](https://github.com/yonaskolb/XcodeGen) and Bun, and an Apple ID added in Xcode under
Settings, Accounts. A free Apple ID will do.

1. Connect the iPhone to the Mac with a cable, unlock it and choose **Trust**.
2. In a checkout of the repository, run:

	```
	$ bun scripts/ios.ts install
	```

3. The first time, open **Settings**, **General**, **VPN & Device Management** on the phone and trust the
   developer. Until then the phone refuses to open the app.

An app signed with a free Apple ID opens for seven days. The app shows the day under **You**, beside **Works
until**. Run the command again before that day. You stay signed in.

### From TestFlight

With a paid Apple developer membership you can send the app to TestFlight instead, and install it from there on
your phone and on your team's, with no cable. Run `bun scripts/ios.ts upload` on the Mac, after making the app
once in App Store Connect (the repository's `ios/README.md`, "Send it to TestFlight", has the steps). A build from
TestFlight opens for 90 days, and the TestFlight app shows when it ends.

## Sign in

The app signs in to `mainworthy.com`. It does not ask for an address.

1. Type your name and your password. Set a password in the web app under Settings, **Your sign-in**. The app
   takes no token: a token is for a script or a pipeline.
2. Press **Sign in**.

An account with an enrolled authenticator requires a second sign-in step. This build does not support that step yet. It says so after the password is accepted and keeps no session. Use the web app for that account. An instance that requires a second factor for admins also refuses password-only admin sign-in in the app.

After sign-in completes, the app opens a session, as a browser does, and keeps that session in the phone's keychain. It does not keep
the password. The session appears in the web app under Settings, **Your sessions**, as "Mainworthy for
iPhone", and you can end it there.

### Fill the password from 1Password or the phone's passwords

The name and password fields take what the phone's AutoFill offers. The phone offers the login it keeps for
`mainworthy.com` only when the app is tied to that site, and Apple allows that only for an app signed by a paid
Apple developer membership. An app installed with a free Apple ID is not tied to it: press the key above the
keyboard and search for the login yourself.

With a paid membership:

1. Add `CODE_SIGN_ENTITLEMENTS = App/Mainworthy.entitlements` to `ios/Config/Local.xcconfig` and run
   `bun scripts/ios.ts install`. It prints the app's name as Apple knows it, such as
   `ABCDE12345.com.mainworthy.app.ABCDE12345`.
2. Whoever runs the instance at `mainworthy.com` adds that name to `MAINWORTHY_APPLE_APPS`
   ([configuration](./configuration.md)) and starts it again.

The phone then offers the login saved for `mainworthy.com` on the sign-in screen, and offers to save one after a
sign-in. Apple reads the site's list when the app is installed, so install the app again after the instance
lists it.

A passkey does not work in the app.

## Answer a question

1. Open **Queue**. The list shows what waits for an answer, the failures first. The line under the list says how
   much needs an answer today: "1 failure to explain · 3 can wait".
2. Press a question. Its page shows the evidence: what failed and where, what an edit changes, what a review
   found.
3. Press an answer. Each has the sentence that says what it does.
   - Where the project's policy asks for a reason, the app asks for it before it records the answer.
   - **Defect in the product** asks where the defect is tracked. You can leave that empty.
4. Back in the list, a bar says what was recorded. **Undo** withdraws the answer, with a reason where the policy
   asks for one. Both decisions stay in the ledger. Undo sends the decision id returned by your answer.
   If somebody replaced that answer meanwhile, their decision stays and the app says the decision changed.

You cannot answer from the list. A question is answered from its page, where its evidence is.

**Decided** at the top shows what was decided and by whom. Open a question there to withdraw its decision.
The withdrawal names the decision shown. If it changed meanwhile, read the question again before withdrawing it.
An unconfirmed withdrawal shows the server's response without claiming that the earlier decision still stands.

The chips over the list show one kind of question. The name at the top left is the project that is open. Press
it to open another.

## Link tests to cases

1. Open an unlinked question in **Queue**, then press **Link to a case**.
2. Press **Choose a case** for each test. Search by title or case number and choose its case.
3. Review every test and its selected case, including their references and names. Add a reason if the policy asks for one.
4. Press **Record**. The sheet shows the server's result. Press **Done** to return to the question.

To make cases instead, press **Create cases** on the question. Review the test names before recording.
The server makes one automated case per test, with that test's name, and links it. It chooses the folder from the test file.
If the policy requires somebody to adopt new cases first, the server refuses this answer. Create and adopt the cases in **Cases**, then link them here.

Linking tests and creating cases need a connection. These answers are not saved in **Unsent answers**. Keep the app open and use **Retry** after a network drop. Closing the app loses these choices and any uncertain mapping command.

Closing the sheet keeps your case choices, search and reason in the current workspace. A refusal or changed question keeps them too.
If the evidence changed, press **Review current tests** before answering on the new evidence.
If somebody else answered, the sheet shows their current answer and preserves your choices.
Your own confirmed answer shows the recorded result without a **Question changed** warning while that decision still stands on the reviewed evidence.
When a reply is uncertain, editing pauses. **Retry** sends the same command to learn its result without making cases twice.
A question with more tests than this build can show still needs the web app.

## Execute a planned run

1. Open **Runs**, then open a run. Its page shows the server's verdict, the results it accepts and its cases in order.
2. Press **Start** to open the first case with no result, or press any slot to open it.
   The case is shown at the version pinned when the run was planned.
3. Press the step that failed to mark it. Press it again to clear the mark. Add an optional note.
4. Press **Pass**, **Fail**, **Blocked** or **Skip**. **Fail** records the marked step.
   After the server confirms the result and the app reads the slots again, it opens the next slot with no result.
5. **Undo** corrects the result to your earlier outcome, including its note and failed step, or to skipped if there was none.
   It does not delete the result. You can return to any slot and record again to correct your own earlier result.

Notes and step marks you have not recorded stay with their slot while the run is open, including when you use **Undo**.

Recording needs the project's `produce` capability. Without it, slots are read-only.
A closed run cannot receive results. Withdraw its sign-off in the **Queue** to reopen it.
The app does not assign slots, set required jobs or close a run from this screen.

To plan a run, press **+** in **Runs**. Give it a name and choose all cases, a folder, a tag or search text.
Optionally enter a commit whose results it accepts. **Plan** says how many slots it made and opens the new run.
If the run was planned but cannot be read, the app keeps its reference and offers **Read run again**.
This reads the saved run without planning another.
Planning needs the project's `plan` capability. A selection with no cases is refused with the server's sentence.

## Read a change's gate

1. Open **Changes**. A pipeline report with a branch or pull request makes a change appear. The list shows the
   newest 500 changes.
2. Press a change to read its head and base commits, the gate's verdict and reason, its failing tests and
   linked cases, and the cases it touches. Pull down to refresh. The list and open page also follow the
   project's change stream. An open page stays readable when its change leaves the list.
3. Press an open question to read its evidence and answer it, as in Queue. When you answer, the change's
   gate is read again.

The head, gate, failing tests and affected cases are checked against the commits named in the replies. If the
head moves during a read, the app tries again once. If it moves again, the app says so and keeps the previous
page, if one was read. Pull down to try again.

A merged or closed change is marked as ended. Its gate keeps the last verdict its head had. The app does not
end a change or run tests again.

## End a session

1. Open **You**, then **Your sessions**. Each session says what opened it, what the client called itself,
   when and where it opened and was last used. **This device** marks the app's own session.
2. Press **End session** and confirm. Ending this device's session signs you out. Ending another leaves
   this device signed in.

The list is yours on the instance, whichever project is open. Pull down to refresh. Other people's sessions,
passwords and passkeys are managed in the web app.

**You**, **About** also shows the app's version and the server's, the licence (Apache License 2.0), **Licences**,
which opens the page [Licence](./licence.md) on the instance, and the copyright line.

## Browse and write cases

1. Open **Cases**. It works like the Files app: **All cases**, the top folders, and the most used tags, with
   **All tags** for the rest. A folder opens as its own page with its subfolders above its own cases. Swipe from
   the left edge of the screen, or press the back button, to go up. Scroll to the end of a list to read the next
   page. A mark at the end of a case's row shows its worst result on the current version: a cross for a failure
   or an error, a triangle for blocked, a tick for a pass.
   A list you opened recently shows at once and is read again in the background after a change. The app keeps the
   last forty lists you left; an older one is read again with a spinner. Pull down to read a list now.
   The magnifier at the top searches for words of a case or its number, such as `C-12`. Opened in a folder, it
   searches that folder and its subfolders; in a tag, the cases with that tag. Press **Everywhere** to search the
   whole project. A case number finds that case only inside the folder or tag you search. Closing the search
   clears it.
2. Open a case to read its version, preconditions, steps and who may run it. **History** lists who wrote each
   version, when and why. Saved versions are read-only. **Open current case** opens the editable page.
   Folder and tags show the current placement.
3. If you may produce evidence, press **+** to write a case in the folder you are in, or **Edit case** on its
   page. A case written from the top of the tab, a tag or **All cases** goes to **Unsorted**. Type a title, preconditions and steps. Each step has an action and an optional expected result.
   **Add step** adds one; **Edit** lets you remove or reorder them. The title limit is 300 UTF-16 units and
   the optional reason limit is 500. An emoji may use two units. Save stays disabled until the limits and
   whitespace warnings are resolved. The server sets no separate limit on preconditions, step text or the
   number of steps.
4. Press **Save**. An adopted proposal opens the saved version. Where the policy asks for acceptance, the app
   says the proposal waits in the Queue. If the saved document differs from what you typed, or cannot be read,
   the editor keeps your draft and says why. If another edit overlaps, **Both edits are kept** shows each
   overlapping field with **Your draft** above **Current version**. Choose **Use my version** or
   **Use current version** for each field, then review **Merged case** and press **Record merge**.
   You can keep an action from one side and its expected result from the other, keep or remove a step, and
   choose the order when both sides reordered steps. Changes that do not overlap are combined automatically.
   If the case changes again, a new conflict keeps your merge for another choice. The policy can leave the
   merge waiting for acceptance in the Queue. A refused answer keeps your draft and choices. If the question
   was answered elsewhere or no longer applies, recording stops and the notice offers **Cancel**.
   Keeping a removed step restores it beside its surviving neighbours from the chosen side. An order you
   explicitly choose takes precedence; steps absent from that order follow at the end.
   An edit uses the version you opened.

What you type stays while the app goes to the background, and when your session ends and you sign in again as yourself on the same server. **Cancel** asks before discarding a changed draft.
A lost save reply offers **Retry**, which sends the same command. For a merge, **Retry** first asks what the
server recorded for that command. Choices stay locked until its outcome is known. Drafts do not survive closing the app.

The editor keeps custom field values without editing them. A newly required field does not block edits to an older case that leaves that value unchanged. New cases must supply required values through [Markdown or a content proposal](./policy.md#custom-fields).

Moving, tagging, archiving and restoring cases, changing folders and version diffs still
need the web app. The button on a case's page opens it there.

## Answer during a network drop

Except for linking tests and creating cases, you can answer questions whose evidence the app has already shown. Before sending, the app saves each answer on this device with its original evidence and command id. The question stays open until the server confirms a decision. A second answer to the same question waits until the first has an outcome.

Open **Unsent answers** at the top right of Queue. Each entry shows **Waiting to send**, **Recorded**, **Recorded as advice**, **Overtaken**, or **Refused**, with the server's reason. Keep the app open. Waiting answers send in order when the connection returns, including answers in other projects. If a reply stays uncertain, later answers in that project wait behind it. You cannot discard a waiting answer, even with **Clear outcomes**, because the server may already have recorded it. **Send waiting answers** tries again immediately.

If somebody decides the question before a saved answer arrives, the saved answer becomes **Overtaken** and leaves their decision unchanged. For **Overtaken**, open **Read Q-…**, read its current evidence, and choose an answer again if one is still needed. The saved answer will not be sent again. For **Refused**, read the reason and the question before giving another answer. A lost reply keeps the same command id when retried, so it cannot record the answer twice.

Saved answers and their outcomes survive closing the app and are excluded from device backups. Signing out keeps them for you on the same instance and stops new sends from that workspace. A request already sent may complete. Other people signing in on the device have separate saved answers. Removing the app deletes them. **Clear outcomes** removes completed entries and keeps waiting answers.

The app needs a connection to identify you after reopening. It sends no answers while closed. Case drafts still do not survive closing.

## What the app does not do yet

- **Resolve a conflict opened from the Queue**. The answer is listed and greyed.
  Resolve an overlapping save in the open case editor, or use the button at the top right of a question to
  open it in the web app.
- **Answer a proposal that does more than add a case or change what one says.** One that restores an earlier
  version, moves, tags or archives cases, makes a folder or changes the policy is answered in the web app: the
  app does not show all of what it changes. So is one with more than twenty edits. A new case and an edit to a
  case are shown step by step, and their answers stay off until that is on the screen.
- **Notifications.** They need a paid Apple developer membership.
- **Start without a connection.** Reopening the app needs the server to identify you. Answers saved before closing stay on the device until you reconnect and open your workspace.

## When something is wrong

| The app says | What to do |
| --- | --- |
| "The reply could not be read." | Update the server and install the app from matching source revisions |
| "This build cannot show what the question is about" | The same: install the app again, or answer in the web app |
| "Your session ended. Sign in again." | The session ran out, or was ended under **Your sessions**. Sign in as yourself and the screens come back as you left them |
| "Too many attempts." | Wait as long as it says. The server limits failed sign-ins |
| The app does not open | Its signing ran out. Run `bun scripts/ios.ts install` again |

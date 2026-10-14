# The iPhone app

Work with Mainworthy from your phone in a native app.
This page says how to install the app, how to sign in and what it does today.

The app has the queue, planned runs, the suite, changes and your sessions (issue #171). What an admin does,
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

## Sign in

1. The address is `mainworthy.com` until you change it. For another instance, type the address you open it at in
   a browser, such as `mainworthy.example`; the app adds `https://`. An instance on your own network is reached by
   its address and port, such as `192.168.1.20:7357`.
2. Type your name and your password. Set a password in the web app under Settings, **Your sign-in**. The app
   takes no token: a token is for a script or a pipeline.
3. Press **Sign in**.

The app opens a session, as a browser does, and keeps that session in the phone's keychain. It does not keep
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
lists it. An instance at another address is not tied to the app: the fields still take a login you pick by hand.

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
   asks for one. Both decisions stay in the ledger.

You cannot answer from the list. A question is answered from its page, where its evidence is.

**Decided** at the top shows what was decided and by whom. Open a question there to withdraw its decision.

The chips over the list show one kind of question. The name at the top left is the project that is open. Press
it to open another.

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
## Browse and write cases

1. Open **Suite**. Drill into a folder or choose **All cases**. Search asks the server for matching cases;
   **Tag** filters them. Scroll to the end to read the next page. **Back to folders** clears the search and tag.
2. Open a case to read its version, preconditions, steps and who may run it. **History** lists who wrote each
   version, when and why. Saved versions are read-only. **Open current case** opens the editable page.
   Folder and tags show the current placement.
3. If you may produce evidence, press **+** to write a case in the folder you are in, or **Edit case** on its
   page. Type a title, preconditions and steps. Each step has an action and an optional expected result.
   **Add step** adds one; **Edit** lets you remove or reorder them. The title limit is 300 UTF-16 units and
   the optional reason limit is 500. An emoji may use two units. Save stays disabled until the limits and
   whitespace warnings are resolved. The server sets no separate limit on preconditions, step text or the
   number of steps.
4. Press **Save**. An adopted proposal opens the saved version. Where the policy asks for acceptance, the app
   says the proposal waits in the Queue. If the saved document differs from what you typed, or cannot be read,
   the editor keeps your draft and says why. If another edit overlaps, the app names the fields and asks its author
   to resolve the proposal in the web app. An edit uses the version you opened.

What you type stays while the app goes to the background, and when your session ends and you sign in again as yourself on the same server. **Cancel** asks before discarding a changed draft.
A lost reply offers **Retry**, which sends the same command. Drafts do not survive closing the app.
Moving, tagging, archiving and restoring cases, changing folders, version diffs and resolving overlaps still
need the web app. The button on a case's page opens it there.

## What the app does not do yet

- **Link a test to a case**, and **resolve an edit that overlaps another**. The answer is listed and greyed.
  The button at the top right of a question opens it in the web app.
- **Answer a proposal that does more than add a case or change what one says.** One that restores an earlier
  version, moves, tags or archives cases, makes a folder or changes the policy is answered in the web app: the
  app does not show all of what it changes. So is one with more than twenty edits. A new case and an edit to a
  case are shown step by step, and their answers stay off until that is on the screen.
- **Notifications.** They need a paid Apple developer membership.
- **Work without a connection.** An answer whose reply was lost is sent again by itself. The app does not keep
  an answer for later.

## When something is wrong

| The app says | What to do |
| --- | --- |
| "The reply could not be read." | Check the address. If it is right, the server is newer than the app: install the app again |
| "This build cannot show what the question is about" | The same: install the app again, or answer in the web app |
| "Your session ended. Sign in again." | The session ran out, or was ended under **Your sessions**. Sign in as yourself and the screens come back as you left them |
| "Too many attempts." | Wait as long as it says. The server limits failed sign-ins |
| The app does not open | Its signing ran out. Run `bun scripts/ios.ts install` again |

# The iPhone app

Install the iPhone app, sign in and work with your queue, runs, cases and automated tests.

The app has the queue, planned runs, cases, automated tests, changes and your sessions. Instance admins can
also revoke tokens. To create tokens, invite people or change the project's policy, open the instance in the
phone's browser. It has [a layout of its own](./keyboard.md#on-a-phone).

Cases that use shared fragments can be read and run in the app. Edit fragments
and their pins in the web editor. The app's editor cannot change fragments or cases that contain shared steps.

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
   does not accept tokens. Use tokens for scripts or pipelines.
2. Press **Sign in**.

An account with an enrolled authenticator requires a second sign-in step. The app cannot complete that step. After accepting your password, it says that you need the web app and keeps no session. Sign in to that account in the web app. An instance that requires a second factor for admins also refuses password-only admin sign-in in the app.

After sign-in completes, the app opens a session, as a browser does, and keeps that session in the phone's keychain. It does not keep
the password. The session appears in the web app under Settings, **Your sessions**, as "Mainworthy for
iPhone", and you can end it there.

### Fill the password from 1Password or the phone's passwords

The name and password fields take what the phone's AutoFill offers. The phone offers the login it keeps for
`mainworthy.com` only when the app is tied to that site, and Apple allows that only for an app signed by a paid
Apple developer membership. For an app installed with a free Apple ID, press the key above the
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

A question is answered from its page, where its evidence is, or with others of its kind from the list.

**Decided** at the top shows what was decided and by whom. Open a question there to withdraw its decision.
The withdrawal names the decision shown. If it changed meanwhile, read the question again before withdrawing it.
An unconfirmed withdrawal shows the server's response without claiming that the earlier decision still stands.

The chips over the list show one kind of question. The name at the top left is the project that is open. Press
it to open another.

## Answer several questions at once

1. In **Queue**, press **Select** at the end of the row of kinds. Each open question gets a circle.
2. Press questions to select them. A selection holds one kind, such as unlinked tests or failures, and at most
   500 questions. Select a question or choose a kind's chip before pressing **Select all**. It selects eligible
   questions of that kind from the list, up to the limit. A question that cannot join appears faint.
   Press it to read why. It may be another kind, require a decision you cannot make, or have an answer
   waiting to send. Proposals and findings with a suggested edit need an answer on their own page,
   where you can read the edit.
3. Press **Answer all** and choose an answer. Only the answers every selected question takes are offered.
   To **Link to a case**, answer one question at a time and choose a case for each test.
   **Create cases** makes and links one automated case for each test of the selected questions, and the
   confirmation says how many.
4. Confirm. Where the policy asks for a reason, or the answer takes a defect reference, the app asks first, and
   the same reason and reference go to every selected question.

Each question gets its own decision on the evidence it was listed with. The answer is saved on this device and sent
as one request. See [Answer during a network drop](#answer-during-a-network-drop). **Unsent answers** shows it as
one entry with each of its questions. The bar under the list says how many were recorded and names any question
that was decided or changed meanwhile. Read that question again. **Undo** withdraws every decision the answer made,
one question after another, with one reason where the policy asks for one. Press **Done** to leave Select.

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
4. **Results** lists every test the gate on the page counted, including tests tracked without a case. Each row
   shows how the gate counted it (unexplained, needs a fix, excused, could not run, skipped, passed), its case or
   **no case**, its file, job, attempt, duration, who reported it and the failure message. The counts above the list
   choose what it shows, and the field under them filters by test name or file. A row's question opens it, and
   **Open the build** opens the CI build when the report named one. Press a row to open its test.
   **Show more** reads the next hundred. If the results changed since the first page, the app says so and
   **Read them again** starts from the top.

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

Under **You**, **About** shows the app's version and the server's, the licence (Apache License 2.0) and the
copyright line. **Licences** opens the [Licence](./licence.md) page on the instance.

## Revoke a token

1. Open **You**, then **Tokens**. This entry appears for a person with the instance's `admin` capability.
   Being an admin of one project is not enough.
2. Identify the token by its label, number, actor, kind, creation date and creator, last use and address,
   expiry, and state. Pull down to refresh. The list covers the instance, whichever project is open.
3. Press **Revoke token**. The confirmation names its label and number. Review them, then confirm.
   Revocation stops the token and ends sessions opened with it. The app signs in with a password, so its own
   session stays signed in.
4. The screen says **Revoked**, **Already revoked**, or shows the server's refusal reason.
   If the reply is lost or unreadable, it says **Outcome unknown** and pauses further revocations.
   Press **Check again** to send the saved command again and learn its result without revoking twice.

The pending command stays when you leave this screen or switch projects. Keep the app open until its outcome
is known. Token creation, people, and policy administration still need the web app or command line.

## Browse and write cases

1. Open **Cases** to see **All cases**, the top folders and the most used tags, with
   **All tags** for the rest. A folder opens as its own page with its subfolders above its own cases. Swipe from
   the left edge of the screen, or press the back button, to go up. Scroll to the end of a list to read the next
   page. Under a case's title, a chip for each way it was run shows its latest result: the icon of who ran it (a
   person, a pipeline's gears, an agent's sparkles), a tick or a cross, and the word, such as **passed** or
   **failed**. A grey chip that says **older version** is a result on an earlier version of the case.
   A list you opened recently shows at once and is read again in the background after a change. The app keeps the
   last forty lists you left; an older one is read again with a spinner. Pull down to read a list now.
   The magnifier at the top searches for words of a case or its number, such as `C-12`. Opened in a folder, it
   searches that folder and its subfolders; in a tag, the cases with that tag. Press **Everywhere** to search the
   whole project. A case number finds that case only inside the folder or tag you search. Closing the search
   clears it.
2. Open a case to read its version, preconditions, steps and who may run it. Badges show **Person**,
   **Pipeline** and **Agent**, struck through where the case does not allow that way. **History** lists who wrote each
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

## Read the automated tests

Open **Cases**, then **Automated tests**. The list shows every test a pipeline has reported, newest first,
with its case or **no case**, and **quarantined** while its quarantine is active. Search by name or file,
and turn on **Only tests with no case** to see tests tracked without one.

Open a test to read its file, key, linked case and quarantine. A test without a case still counts for the gate.
The page also shows how often the test flipped between passing and failing on the same code, and its latest
twenty results. Each result names its commit, change, job, who reported it and the build. A test opened from a
change's results shows the same page.

## Answer during a network drop

Except for linking tests and creating cases from a question's page, you can answer questions whose evidence the app has already shown. Before sending, the app saves each answer on this device with its original evidence and command id. The question stays open until the server confirms a decision. While an answer is waiting to send, another answer to that question waits until the saved answer has an outcome or you drop it.

Open **Unsent answers** at the top right of Queue. Each entry shows **Waiting to send**, **Dropped**, **Recorded**, **Recorded as advice**, **Overtaken**, or **Refused**, with the server's reason. Keep the app open. Waiting answers send in order when the connection returns, including answers in other projects. **Send waiting answers** tries again immediately.

If an uncertain reply holds later answers in that project, the first waiting entry shows the problem and two choices. **Keep trying** sends the same answer and command again. **Drop saved answer** asks for confirmation, then checks that command with the server. A recorded answer shows its outcome. If every send attempt got a definite HTTP error reply and the command is still unrecorded, the app removes that entry.

A timeout, lost connection, or unreadable reply means an earlier request may still arrive, even when the server reports no recorded command yet. Dropping that answer keeps a **Dropped** entry that never sends again and lets later answers send in order. Each send pass sends waiting answers first, then checks Dropped commands for outcomes, including after you reopen the app. A failed lookup stops the remaining checks for that pass. Answers saved during those checks are sent in the same pass. The screen confirms a sent answer without waiting for Dropped checks. **Send waiting answers and check dropped** starts a pass immediately. If the server records it, its outcome appears here and **Clear outcomes** can remove it. If it never does, this entry stays. There is no time limit that proves a request cannot still arrive. If the server is still recording the command, cannot be reached, or gives an unreadable command reply, Drop keeps the waiting answer and explains why.

An answer refused after an earlier timeout stays **Waiting to send** with the refusal text and blocks later answers. If you drop it, it becomes **Dropped** because the earlier attempt may still arrive. While a waiting answer holds the queue, Dropped entries are not checked.

If somebody decides the question before a saved answer arrives, the saved answer becomes **Overtaken** and leaves their decision unchanged. For **Overtaken**, press **Read** and the question's ref, such as **Read Q-12**, read its current evidence, and choose an answer again if one is still needed. The saved answer will not be sent again. For **Refused**, read the reason and the question before giving another answer. A lost reply keeps the same command id when retried, so it cannot record the answer twice.

Saved answers and their outcomes survive closing the app and are excluded from device backups. Signing out keeps them for you on the same instance and stops new sends from that workspace. A request already sent may complete. Other people signing in on the device have separate saved answers. Removing the app deletes them. **Clear outcomes** removes completed entries and keeps waiting and Dropped answers.

The app needs a connection to identify you after reopening. It sends no answers while closed. Case drafts still do not survive closing.

## What the app does not do yet

- **Resolve a conflict opened from the Queue**. The answer is listed and greyed.
  Resolve an overlapping save in the open case editor, or use the button at the top right of a question to
  open it in the web app.
- **Answer a proposal that does more than add a case or change what one says.** One that restores an earlier
  version, moves, tags or archives cases, makes a folder or changes the policy needs the web app. So does
  a proposal with more than twenty edits. For a new case or a change to a case's content, read the steps
  on the question's page before choosing an answer.
- **Notifications.** They need a paid Apple developer membership.
- **Start without a connection.** Reopening the app needs the server to identify you. Answers saved before closing stay on the device until you reconnect and open your workspace.

## When something is wrong

| The app says | What to do |
| --- | --- |
| "The reply could not be read." | Update the server and install the app from matching source revisions |
| "This build cannot show what the question is about" | Install the app again, or answer in the web app |
| "Your session ended. Sign in again." | The session ran out, or was ended under **Your sessions**. Sign in as yourself and the screens come back as you left them |
| "Too many attempts." | Wait as long as it says. The server limits failed sign-ins |
| The app does not open | Its signing ran out. Run `bun scripts/ios.ts install` again |

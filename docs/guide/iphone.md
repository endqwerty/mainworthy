# The iPhone app

Install the iPhone app, sign in and work with your queue, runs, cases and automated tests.

The app has the queue, planned runs, cases, automated tests, changes and your sessions. Instance admins can
also revoke tokens. To create tokens, invite people or change the project's policy, open the instance in the
phone's browser. It has [a layout of its own](./keyboard.md#on-a-phone).

Cases that use shared fragments can be read and run in the app. Edit fragments
and their pins in the web editor. The app's editor cannot change fragments or cases that contain shared steps.

## Install the app

There is no App Store entry. You build the app from the repository and install it over a cable. You need a Mac
with Xcode, [XcodeGen](https://github.com/yonaskolb/XcodeGen) and Bun. Add an Apple ID in Xcode under
Settings, Accounts. A free Apple ID will do. The app needs iOS 26 or later: it supports the current iOS and
the one before it. To install the app, follow these steps:

1. Connect the iPhone to the Mac with a cable.
2. Unlock the phone.
3. Choose **Trust**.
4. In a checkout of the repository, run the install command:

	```
	$ bun scripts/ios.ts install
	```

5. For the first installation, open **Settings**, **General**, **VPN & Device Management** on the phone.
6. Trust the developer. Until then the phone refuses to open the app.

An app signed with a free Apple ID opens for seven days. The app shows the day under **You**, beside **Works
until**. Run the command again before that day. You stay signed in.

### From TestFlight

With a paid Apple developer membership you can send the app to TestFlight instead.
You can then install it from TestFlight on your phone and your team's phones, with no cable. Before running `bun scripts/ios.ts upload` on the Mac, make the app
once in App Store Connect. The repository's `ios/README.md` has the steps under "Send it to TestFlight". A build from
TestFlight opens for 90 days, and the TestFlight app shows when it ends.

## Sign in

**Privacy** on the sign-in screen opens the instance's [privacy policy](./privacy.md) in your browser, without
signing in. The same link is under **You**, **About**. A build for another instance opens that instance's `/privacy` page.

The app signs in to `mainworthy.com`. It does not ask for an address. Set a password or add a passkey in
the web app under Settings, **Your sign-in**. The app does not accept tokens. Use tokens for scripts or pipelines.
To sign in, follow these steps:

1. Type your name and your password.
2. Press **Sign in**.

When the instance offers an identity provider, press **Sign in with** and the provider's name instead. Complete the sign-in
in the system browser sheet. The app returns signed in as the person linked to that provider identity. You
need no Mainworthy password. Link the identity in the web app first, under Settings, **Your sign-in**, or
accept an invitation there through the provider. Cancelling the sheet leaves you signed out.
If the provider does not sign you in, the app offers a retry or password sign-in and keeps any name and password you entered.
Repeated refused provider callbacks count toward the instance's sign-in limit for that address, shared
with web sign-in. If a refusal reaches that limit, the sheet closes and the app tells you how many seconds
to wait before trying again. A valid provider answer still passes that limit.

To use a passkey, press **Sign in with a passkey** and choose a credential in the phone's sign-in sheet.
The app needs an HTTPS instance associated with its signed build, using the same paid-team setup as
[password AutoFill](#fill-the-password-from-1password-or-the-phones-passwords). For another instance, the
repository's `ios/README.md` explains how to build with its domain and configure the instance.
If you cancel, the app adds no message. If the app cannot use a passkey for this instance, it says so and
points you to password sign-in. A failed passkey attempt keeps the name and password you entered.
If the challenge has expired, press **Sign in with a passkey** again to get a new one.
Physical-device checks, including an external credential provider, remain open in
[issue #205](https://github.com/endqwerty/mainworthy/issues/205).

Password sign-in for an account with an enrolled authenticator requires a second step. The app cannot complete
that step and keeps no session after accepting the password. Use a passkey, or sign in through the web app.
An instance that requires a second factor for admins also refuses password-only admin sign-in in the app.

After sign-in completes, the app opens a session, as a browser does, and keeps that session in the phone's keychain. It does not keep
the password or the provider's tokens. The session appears in the web app under Settings, **Your sessions**, as "Mainworthy for
iPhone", and you can end it there.

### Fill the password from 1Password or the phone's passwords

The name and password fields take what the phone's AutoFill offers. The phone offers the login it keeps for
`mainworthy.com` only when the app is tied to that site. Apple allows that tie only for an app signed by a paid
Apple developer membership. For an app installed with a free Apple ID, press the key above the
keyboard and search for the login yourself.

With a paid membership, follow these steps to enable AutoFill:

1. Add `CODE_SIGN_ENTITLEMENTS = App/Mainworthy.entitlements` to `ios/Config/Local.xcconfig`.
2. Run `bun scripts/ios.ts install`. The command prints the app's name as Apple knows it, such as
   `ABCDE12345.com.mainworthy.app.ABCDE12345`.
3. Ask whoever runs the instance at `mainworthy.com` to add that name to `MAINWORTHY_APPLE_APPS`.
   See [configuration](./configuration.md).
4. Ask the same person to restart the instance.
5. Install the app again. Apple reads the site's list when the app is installed.

The phone then offers the login saved for `mainworthy.com` on the sign-in screen, and offers to save one after a
sign-in.


## Answer a question

To answer from a question's page, follow these steps:

1. Open **Queue**. The list shows what waits for an answer, the failures first. The line under the list says how
   much needs an answer today: "1 failure to explain · 3 can wait". **Open** and **Decided** and the kinds stay
   at the top while you pull the list down to refresh it.
2. Press a question. Its page shows the evidence: what failed and where, what an edit changes, what a review
   found.
   A proposed edit shows why it was proposed and who proposed it. It also says in a sentence what the edit does,
   such as "Adds 1 step." For an edit to an existing case, choose one of three views:
   **Changes** shows the steps with **Added**, **Removed**, **Changed** and **Moved** marks.
   **Current** shows the case as it is now, which **Reject** keeps.
   While the proposal waits, **Proposed** shows the case with the edit applied to it as it is now, so a change made after the edit was proposed is kept.
   If the edit on its own would be refused now, for example because someone changed a field it changes too, the page says why.
   **Proposed** then shows the edit as it was proposed, as it does for a decided proposal.
   Proposal answers stay disabled until every part on the **Changes** side of each edit has appeared on screen,
   or the full case for a new case. Scroll through tall edits, including their middle.
   With VoiceOver, use a three-finger swipe to scroll page by page. Moving between elements in a long field
   does not show its middle on screen. Fetching the documents or jumping to the bottom does not enable answering.
   If the evidence changes, read the edits again.
   Proposals with more than twenty edits or changes this build cannot show are still answered in the web app.
3. Press an answer. Each answer has a sentence that says what it does.
4. If the project's policy asks for a reason, enter the reason before the app records the answer.
   **Defect in the product** asks where the defect is tracked. You can leave that field empty.

If the question settles elsewhere while an answer sheet or Accept confirmation is open, the app closes it and
says the question was settled elsewhere. The notice clears if the question reopens. A refresh that temporarily
omits the question keeps the answer sheet open. A mapping submission with an uncertain reply stays available to retry.

Back in the list, a bar says what was recorded. **Undo** withdraws the answer, with a reason where the policy
asks for one. Both decisions stay in the ledger. Undo sends the decision id returned by your answer.
Settled also keeps answers that ended when their cause passed, their flaky hold expired, or their tracker issue closed.
Replacing an inherited answer lists the answer on the ordinary cause question. Open an ended answer to read the
original answer and who gave it, followed by the recorded rule and reason for its end. There is no withdrawal
button for an answer that has ended.
If somebody replaced that answer meanwhile, their decision stays and the app says the decision changed.

A question is answered from its page, where its evidence is, or with others of its kind from the list.

**Decided**, beside **Open** under the top bar, shows what was decided and by whom. Open a question there to withdraw its decision.
The withdrawal names the decision shown. If that decision changed meanwhile, read the question again before withdrawing the decision.
An unconfirmed withdrawal shows the server's response without claiming that the earlier decision still stands.

The chips over the list show one kind of question. The name at the top left is the project that is open. Press
it to open another.

## Answer several questions at once

To give one answer to several questions of one kind, follow these steps:

1. In **Queue**, press **Select** at the top right. Each open question gets a circle. The tabs give way to a bar
   that counts what is selected, such as **9 unlinked tests selected** (questions about tests with no case are
   counted by their tests), or says **Select questions** while nothing is. **Done** at the top right ends selection.
2. Press questions to select them. A selection holds one kind, such as unlinked tests or failures, and at most
   500 questions. Select a question or choose a kind's chip before pressing **Select All** at the top left. The button
   selects eligible questions of that kind from the list, up to the limit, and then reads **Deselect All**. A question that cannot join appears faint.
   Press it to read why. It may be another kind, require a decision you cannot make, or have an answer
   waiting to send. Proposals and findings with a suggested edit need an answer on their own page,
   where you can read the edit.
3. Press **Answer** in the bar at the bottom. Only the answers every selected question takes are offered.
4. Choose an answer.
   To **Link to a case**, answer one question at a time and choose a case for each test.
   **Create cases** makes and links one automated case for each test of the selected questions, and the
   confirmation says how many.
5. If the app asks for a reason or defect reference, enter the requested details.
   The same reason and reference go to every selected question.
6. Confirm.

Each question gets its own decision on the evidence it was listed with. The answer is saved on this device and sent
as one request. See [Answer during a network drop](#answer-during-a-network-drop). **Unsent answers** shows it as
one entry with each of its questions. The bar under the list says how many were recorded and names any question
that was decided or changed meanwhile. Read that question again. **Undo** withdraws every decision the answer made,
one question after another, with one reason where the policy asks for one. Press **Done** to leave Select.

## Link tests to cases

To link each test in a question to a case, follow these steps:

1. Open an unlinked question in **Queue**.
2. Press **Link to a case**.
3. For one test, press **Choose a case**.
4. Search by title or case number.
5. Choose the case for that test.
6. Repeat steps 3 to 5 for the other tests.
7. Review every test and its selected case, including their references and names.
8. If the policy asks for a reason, enter one.
9. Press **Record**. The sheet shows the server's result.
10. Press **Done** to return to the question.

To make cases instead, press **Create cases** on the question. Review the test names before recording.
The server makes one automated case per test, with that test's name, and links the test to it. It chooses the folder from the test file.
If the policy requires somebody to adopt new cases first, the server refuses this answer. Create and adopt the cases in **Cases**, then link the tests here.

Linking tests and creating cases need a connection. These answers are not saved in **Unsent answers**. Keep the app open. After a network drop, use **Retry**. Closing the app loses these choices and any uncertain mapping command.

Closing the sheet keeps your case choices, search and reason in the current workspace. Those choices also stay after a refusal or changed question.
If the evidence changed, press **Review current tests** before answering on the new evidence.
If somebody else answered, the sheet shows their current answer and preserves your choices.
Your own confirmed answer shows the recorded result without a **Question changed** warning while that decision still stands on the reviewed evidence.
When a reply is uncertain, editing pauses. **Retry** sends the same command to learn its result without making cases twice.
A question with more tests than this build can show still needs the web app.

## Find a run

**Runs** lists every run of the project, newest first: the runs somebody planned, and the change run
Mainworthy makes for each commit a report names. Each row shows the verdict and how long ago the run was made.
Choose **Planned** or **Change** to see one kind, and **Open** or **Closed** to see one state. The two filters stay at the top while you pull the list down to refresh it.

Open a change run to see its commit, its change and every result its gate counted.
Press a standing above the results to see only those results, or type part of a test's name or file.

## Execute a planned run

To record results for a planned run, follow these steps:

1. Open **Runs**.
2. Open a run. Its page shows the server's verdict, the results it accepts and its cases in order.
3. Press **Start** to open the first case with no result, or press a slot to open it.
   The case is shown at the version pinned when the run was planned.
   Every slot opens, including one filled only by another producer. That slot is read-only.
   Its recorded results show the latest fills, step trails and screenshots.
4. If a step failed, press that step to mark it. Press the step again to clear the mark.
5. If needed, add a note.
6. Press **Pass**, **Fail**, **Blocked** or **Skip**. **Fail** records the marked step.
   After the server confirms the result and the app reads the slots again, it opens the next slot with no result.

**Undo** corrects the result to your earlier outcome, including its note, failed step, step trail and attachments, or to skipped if there was none.
It disappears when a refresh shows that result was already replaced. It does not delete the result.
You can return to any eligible slot and record again to correct your own earlier result.

If a Record or Undo reply is lost or unreadable, **Retry report** checks the original command before another result on that slot.
The app keeps the submitted outcome, note and evidence while the outcome is uncertain. Keep the workspace open until it recovers the receipt.
Closing the app loses an uncertain report; reports are not saved in **Unsent answers**.

Notes and step marks you have not recorded stay with their slot while the run is open, including when you use **Undo**.

Recording needs the project's `produce` capability. Without it, slots are read-only.
A closed run cannot receive results. Withdraw its sign-off in the **Queue** to reopen it.
The app does not assign slots, set required jobs or close a run from this screen.

Planning needs the project's `plan` capability. To plan a run, follow these steps:

1. In **Runs**, press **+**.
2. Give the run a name.
3. Choose all cases, a folder, a tag or search text. The planner shows how many runnable cases match.
4. If needed, enter a commit whose results the run accepts.
5. Press **Plan**. The app says how many slots it made and opens the new run.

If the reply is lost or cannot be read, the app keeps the submitted plan and locks its choices.
**Retry plan** recovers the original command or sends the same request, so retrying does not plan another run.
If the run was planned but cannot be read, the app keeps its reference and offers **Read run again**.
**Cancel** closes the planner. A late successful reply adds the run to the list.
If you reopen the planner before that reply arrives, success closes the planner and opens the run.
Otherwise, open the run from **Runs**. Reopen the planner to recover an uncertain outcome or retry a failed run read.
Once the run is read successfully, **+** starts a fresh planner with no submitted choices or previous notice.
An unresolved plan stays while this project's screen is open. It is not kept after the app closes.
A selection with no cases is refused with the server's sentence.

## Read a change's gate

To inspect a change and the results its gate counted, follow these steps:

1. Open **Changes**. A pipeline report with a branch or pull request makes a change appear. The list shows the
   newest 500 changes.
2. Press a change to read its head and base commits, the gate's verdict and reason, its failing tests and
   linked cases, and the cases it touches. Pull down to refresh. The list and open page also follow the
   project's change stream. An open page stays readable when its change leaves the list.
3. Press an open question to read its evidence and answer it, as in Queue. When you answer, the change's
   gate is read again.
4. Read **Results** to see every test the gate on the page counted, including tests tracked without a case. Each row
   shows how the gate counted the test: unexplained, needs a fix, excused, could not run, skipped, or passed. The row also shows its case or
   **no case**, its file, job, attempt, duration, who reported it and the failure message. The counts above the list
   choose which results appear. The field under the counts filters by test name or file. A row's question opens that question, and
   **Open the build** opens the CI build when the report named one. Press a row to open its test.
   **Show more** reads the next hundred. If the results changed since the first page, the app says so.
   **Read them again** starts from the top.
5. Under **Runs, newest first**, each row is one commit of the change that was reported, with its verdict. Press
   one to read what its gate counted. **More runs** reads the next hundred.

The head, gate, failing tests and affected cases are checked against the commits named in the replies. If the
head moves during a read, the app tries again once. If the head moves again, the app says so and keeps any
previous page it read. Pull down to try again.

A merged or closed change is marked as ended. Its gate keeps the last verdict its head had. The app does not
end a change or run tests again.

## End a session

To end one of your sessions, follow these steps:

1. Open **You**.
2. Open **Your sessions**. Each session says what opened it, what the client called itself,
   when and where it opened and was last used. **This device** marks the app's own session.
3. Press **End session**.
4. Confirm. Ending this device's session signs you out. Ending another leaves
   this device signed in.

The list is yours on the instance, whichever project is open. Pull down to refresh. Other people's sessions,
passwords and passkeys are managed in the web app.

Under **You**, **About** shows the app's version and the server's, the Apache License 2.0 licence and the
copyright line. **Licences** opens the [Licence](./licence.md) page on the instance.

## Revoke a token

The **Tokens** entry appears for a person with the instance's `admin` capability.
Being an admin of one project is not enough. To revoke a token, follow these steps:

1. Open **You**.
2. Open **Tokens**.
3. Identify the token by its label, number, actor, kind, creation date and creator, last use and address,
   expiry, and state. Pull down to refresh. The list covers the instance, whichever project is open.
4. Press **Revoke token**. The confirmation names the token's label and number.
5. Review the label and number.
6. Confirm.
   Revocation stops the token and ends sessions opened with it. The app signs in with a password, the identity provider or a passkey, so its own
   session stays signed in.
   The screen says **Revoked**, **Already revoked**, or shows the server's refusal reason.
   If the reply is lost or unreadable, the screen says **Outcome unknown** and pauses further revocations.
   Press **Check again** to send the saved command again and learn its result without revoking twice.

The pending command stays when you leave this screen or switch projects. Keep the app open until its outcome
is known. Token creation, people, and policy administration still need the web app or command line.

## Browse and write cases

To browse cases and write a new case or an edit, follow these steps:

1. Open **Cases**. The tab shows **All cases**, the top folders and the most used tags.
   **All tags** shows the rest.
2. Open a folder, tag or **All cases** to browse its cases.
3. Open a case to read its version, preconditions, steps and who may run it.
4. If you may produce evidence, press **+** to write a case in the folder you are in.
   To change an existing case, press **Edit case** on its page instead.
5. Type a title, preconditions and steps. Each step has an action and an optional expected result.
   **Add step** adds a step. **Edit** lets you remove or reorder steps.
6. Press **Save**. An adopted proposal opens the saved version. Where the policy asks for acceptance,
   the editor keeps the submitted text and waits for the proposal's answer in the Queue. An edit uses the version you opened.

A folder opens as its own page with its subfolders above its own cases. To go up, swipe from the left edge
of the screen or press the back button. To read the next page, scroll to the end of a list.
Under a case's title, a chip for each way the case was run shows its latest result. Each chip shows
who ran the case with an icon: a person, a pipeline's gears or an agent's sparkles. The chip also shows
a tick or a cross and the outcome, such as **passed** or **failed**.
A grey chip that says **older version** is a result on an earlier version of the case.

A list you opened recently shows at once. After a change, the app reads that list again in the background.
The app keeps the last forty lists you left. An older list is read again with a spinner.
To read a list now, pull down.

The magnifier at the top searches for words of a case or its number, such as `C-12`.
In a folder, the magnifier searches that folder and its subfolders. In a tag, it searches the cases with that tag.
To search the whole project, press **Everywhere**.
A case number finds that case only inside the folder or tag you search. Closing the search clears the search.

A case's badges show **Person**, **Pipeline** and **Agent**, struck through where the case does not allow that way.
Each label stays on one line. Whole badges move to another row when needed, including at larger text sizes,
in cases, merged-case previews and proposal evidence.
**History** lists who wrote each version, when and why. Saved versions are read-only.
**Open current case** opens the editable page. Folder and tags show the current placement.

A case written from the top of the tab, a tag or **All cases** goes to **Unsorted**.
The title limit is 300 UTF-16 units and the optional reason limit is 500. An emoji may use two units.
Save stays disabled until the limits and whitespace warnings are resolved.
The server sets no separate limit on preconditions, step text or the number of steps.

If the saved document differs from what you typed, or cannot be read, the editor keeps your draft and says why.

While a proposal waits, editing pauses. **Retry** reads its answer without sending another proposal.
The editor also checks after a project change arrives. If somebody accepts the proposal, the editor follows
the case and version named by that decision and unlocks. Continue editing there to propose a new version of
the same case. If somebody rejects the proposal, your draft and reason remain editable. If the answer cannot
be read, the editor keeps waiting and says so. Keep the editor open to follow the proposal.
If another edit overlaps, **Both edits are kept** shows each overlapping field with **Your draft** above
**Current version**. To resolve the overlap, follow these steps:

1. For each field, choose **Use my version** or **Use current version**.
2. Review **Merged case**.
3. If **Reason required** appears, give a reason. The reason you gave for the save is already filled in; change it if
   it does not fit the merge. **Record merge** stays disabled while the reason is empty.
4. Press **Record merge**.

You can make these choices:

- Keep an action from one side and its expected result from the other.
- Keep or remove a step.
- Choose the order when both sides reordered steps.

The app combines changes that do not overlap automatically.
If the case changes again, a new conflict keeps your merge for another choice.
The policy can leave the merge waiting for acceptance in the Queue. A refused answer keeps your draft and choices.
If the question was answered elsewhere or no longer applies, recording stops and the notice offers **Cancel**.
Keeping a removed step restores that step beside its surviving neighbours from the chosen side.
An order you explicitly choose takes precedence. Steps absent from that order follow at the end.

What you type stays while the app goes to the background. Your draft also stays when your session ends
and you sign in again as yourself on the same server. **Cancel** asks before discarding a changed draft.
A lost or unreadable save reply, or an internal server error, offers **Retry**, which sends the same save and command.
The editor says it will retry the same save and pauses editing, even if a later retry is refused.
You can edit and save again after a definite refusal, such as missing permission, only if no earlier attempt was uncertain.
Internal errors, rate limits, and ended sessions keep the same save for **Retry**.
For a merge, **Retry** first asks what the server recorded for that command. The merge keeps its first body, reason, and command on retries.
Choices and the reason stay locked until the command's outcome is known.
Drafts do not survive closing the app.

The editor keeps custom field values without editing them.
A newly required field does not block edits to an older case that leaves that value unchanged.
New cases must supply required values through [Markdown or a content proposal](./policy.md#custom-fields).

Moving, tagging, archiving and restoring cases, changing folders and version diffs still
need the web app. The button on a case's page opens that case in the web app.

## Read the automated tests

To browse reported tests, follow these steps:

1. Open **Cases**.
2. Open **Automated tests**. The list shows every test a pipeline has reported, newest first,
   with its case or **no case**, and **quarantined** while its quarantine is active.
3. To find a test, search by name or file.
4. To see tests tracked without a case, turn on **Only tests with no case**.
5. Open a test to read its file, key, linked case and quarantine.

A test without a case still counts for the gate.
The page also shows how often the test flipped between passing and failing on the same code, and its latest
twenty results. Each result names its commit, change, job, who reported it and the build. A test opened from a
change's results shows the same page.

## Answer during a network drop

You can answer questions whose evidence the app has already shown, except when linking tests or creating cases from a question's page.
Before sending, the app saves each answer on this device with its original evidence and command id.
The question stays open until the server confirms a decision.
While an answer is waiting to send, another answer to that question waits until the saved answer has an outcome or you drop it.

To check saved answers and send them when the connection returns, follow these steps:

1. Open **Unsent answers** at the top right of Queue. Answers the server has not replied to are under
   **No reply yet**, each marked **Waiting to send** or **Dropped**. Completed and obsolete answers are under **Finished**.
   A completed answer shows **Recorded**, **Recorded as advice**, **Overtaken**, or **Refused**, with the server's reason.
   An **Obsolete** entry has no confirmed outcome and the app never sends it again.
   When nothing waits, the page says **Nothing is waiting to send**.
2. Keep the app open. Waiting answers send in order when the connection returns, including answers in other projects.
3. To try again immediately, press **Send waiting answers**. It is there only while an answer has no reply.
4. To remove completed and obsolete answers, press **Clear outcomes** at the top of **Finished**.

If an uncertain reply holds later answers in that project, the first waiting entry shows the problem and two choices. **Keep trying** sends the same answer and command again. **Drop saved answer** asks for confirmation, then checks that command with the server. A recorded answer shows its outcome. If every send attempt got a definite HTTP error reply and the command is still unrecorded, the app removes that entry.

A timeout, lost connection, or unreadable reply means an earlier request may still arrive, even when the server reports no recorded command yet.
Dropping that answer keeps a **Dropped** entry that never sends again and lets later answers send in order.
Each send pass sends waiting answers first, then checks Dropped commands for outcomes, including after you reopen the app.
A failed lookup stops the remaining checks for that pass. Answers saved during those checks are sent in the same pass.
The screen confirms a sent answer without waiting for Dropped checks.
To start a pass immediately, press **Send waiting answers and check dropped**.

If the server records the dropped command, its outcome appears here. **Clear outcomes** can then remove that entry.
After 24 hours, **Forget** appears on a Dropped entry. It asks you to confirm that the answer may still have been recorded and its outcome will no longer show here. Confirm **Forget** to remove the entry from this device.

The wait uses the device's clock. Setting it back delays Forget; setting it forward can make Forget appear sooner. Nothing is removed without your confirmation.
For an older saved entry without a drop time, the 24-hour wait starts when this build first reads and saves it.

If the server is still recording the command, cannot be reached, or gives an unreadable command reply,
the app keeps the waiting answer and explains why you cannot drop it.

An answer refused after an earlier timeout stays **Waiting to send** with the refusal text and blocks later answers. If you drop it, it becomes **Dropped** because the earlier attempt may still arrive. While a waiting answer holds the queue, Dropped entries are not checked.

If somebody decides the question before a saved answer arrives, the saved answer becomes **Overtaken** and leaves their decision unchanged.
The saved answer will not be sent again. To review an **Overtaken** answer, follow these steps:

1. Press **Read** and the question's ref, such as **Read Q-12**.
2. Read the question's current evidence.
3. If an answer is still needed, choose an answer again.

For **Refused**, read the reason and the question before giving another answer.
A lost reply keeps the same command id when retried, so the retry cannot record the answer twice.

An answer belongs to the project that existed when you saved it. If another project takes its address, unfinished saved answers show **Obsolete** and the app never sends them to the replacement. The app does not know their outcomes. Unfinished answers saved by an earlier build without a project identity also show **Obsolete**. Completed answers keep their recorded outcomes and statuses. Read the current project before answering again. **Clear outcomes** removes obsolete and completed entries, and they stay cleared after later project replacements. An app restart or a late reply from an earlier project's send does not bring cleared answers back.

If an earlier project's saved-answer file cannot be read, the app skips it and shows a notice. You can still save new answers for the current project. An unreadable file for the current project blocks new saves to protect its existing answers.

Saved answers and their outcomes survive closing the app and are excluded from device backups. Signing out keeps them for you on the same instance and stops new sends from that workspace. A request already sent may complete. Other people signing in on the device have separate saved answers. Removing the app deletes them. **Clear outcomes** removes completed entries and keeps waiting and Dropped answers.

The app needs a connection to identify you after reopening. It sends no answers while closed. Case drafts still do not survive closing.

## What the app does not do yet

The following tasks still need another app or setup:

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

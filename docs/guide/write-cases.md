# Write cases

Write cases as outlines, keep their versions, and resolve edits that overlap.
Use folders, tags, and search to find the cases you need.

Search applies the active or archived state, folder and tags before limiting matches.
Archived matches cannot hide an active case. A search with at most 2,000 matching
cases reports the full count for those filters, independent of the page size.

Suite keeps loading the rest of the list while new results and edits arrive,
and shows live changes without a reload. A tag or move still being sent stays visible
when live updates arrive. If the write fails, only that pending change disappears.
Live updates pause after the page stays hidden for one minute, or after thirty
minutes without keyboard or pointer input while visible. Returning to a hidden
page resumes updates; an idle page resumes on the next key or pointer press.
Reconnecting reads the latest project data. A shorter tab switch keeps the connection.

A confirmed later move replaces an earlier pending move of the same case.
A slow or failed folder-list read keeps the cases returned by the current folder filter visible.

While the selected case loads, its pane says "Reading case…". Pressing <kbd>e</kbd>
before it appears explains that the case has not loaded yet. Press <kbd>e</kbd> again
after it appears to edit it. That loading message clears when the case appears.
A failed read says to reload to try again. A missing case says "Case not found."

![Suite with cases, folders, tags, and the selected case](../ui/screenshots/suite-light.png)

## Capture a case

Create a case in Suite with the outline editor.

1. Open Suite with <kbd>g</kbd> <kbd>s</kbd>.
2. Press <kbd>c</kbd>.
3. Type the title.
4. Press <kbd>Enter</kbd> to start the first step.
5. Type an action and its expected result, separated by ` > `.
6. Press <kbd>Enter</kbd> for the next step.
7. Press <kbd>Escape</kbd> to record the case and leave the editor.

Use <kbd>Tab</kbd> to move to the expected result field.
Fields grow and shrink to fit their text, including when the case pane changes width.
Press <kbd>Shift</kbd> <kbd>Enter</kbd> to record this case and start another.
The [keyboard guide](./keyboard.md) lists the remaining editor keys.

## Use the outline grammar

Put tags in the title with `#tag`. A space separates the tag from the title text.
Mainworthy removes recognized tags from the title and keeps them as tags.
In the web editor, inline tags and `@REQ-123` links also work in actions and expected results.
Tokens can follow whitespace such as tabs, nonbreaking spaces, figure spaces, and full-width spaces.

```text
Checkout applies a percentage coupon #checkout #regression
  Open the cart with one $100.00 item
  Apply coupon SAVE10 > Total shows $90.00
  Reload the page > Coupon is still applied
```

When you paste a whole outline, indent the steps or start each with a list marker.
An unmarked first line is a title only when every following line is indented or marked.
A Markdown heading such as `# Coupon checkout` makes the title explicit.

You can paste numbered lists, bullet lists, or checkbox lists. Mainworthy removes
recognized list markers and splits each action from its expected result.
A more deeply indented line continues the previous step's expected result.
A separate line beginning with `>` or `Expected:` also continues the previous step's expected result.

You can paste two columns from a spreadsheet, with an action and an expected result.
Markdown tables work too. Mainworthy omits a header followed by a separator row.
A numeric first column can supply step numbers without becoming action text.

## Know what is saved

While you type, the editor keeps a private draft on this device.
A new draft shows "Private, no version yet". For an existing case, others still see
the recorded version named beside your draft. The timeline names the version your draft is based on,
which can be older if someone else records a version while you type.

The editor submits a changed draft when you leave or pause for 30 seconds.
To submit sooner, press <kbd>Cmd</kbd> <kbd>Enter</kbd> on macOS or <kbd>Ctrl</kbd> <kbd>Enter</kbd> elsewhere.
The policy then decides whether the proposal becomes current or waits for review.
If you open another screen while a save finishes, its reply leaves you on the screen you chose.
Returning to Suite shows the recorded case without its old draft row.
Changing the filter while a new case saves keeps the filter and gives the case its address when the save finishes.
A delayed save reply keeps any newer version the page has already received.
There is no save button. Moving the caret or selecting text while a save finishes
does not submit the text again. Text waiting for review stays in its proposal.
When a new case proposal is accepted, its draft follows the case and version that acceptance recorded.
Continuing the draft edits that case. Text typed while the proposal waits stays in your draft.
Submitting while the question is open sends nothing new. After acceptance, leave the editor again to submit that text.
If reading the waiting question fails, the draft keeps its link to the proposal and tries that read again on the next submission.
If the case updates before you edit, your next edit starts from the newer version.
While you edit, the folder and tags follow changes made elsewhere. Tags you add in
the editor appear alongside those live tags. Saving changes only the tags you added
or removed, and keeps unrelated tag changes.
A tag you type remains your addition while a shortcut write adds or removes that same tag,
whether the shortcut succeeds or is refused.
Your typed text stays on the version you started from.
The editor submits a case's body, tag changes and requirement links together.
Current and proposed tags classify the whole proposal for policy review.
This includes requirement-link changes, even when one proposal adds many links to the same case.
While review is pending, none of those changes is current. Rejecting it leaves the case unchanged.
A conflict or failed save keeps your text and metadata on this device.

The editor records a step once the step has an action.
A step with an expected result but no action stays in your draft on this device, including after a reload.
The recorded version excludes that step.
To record the step, type its action and leave the editor again.
To discard the step, remove it and leave the editor again.
A new draft is discarded on leave only when all its text, tags, and requirement links are empty.
An expected result or precondition keeps the draft even when its title and actions are blank.
Leaving a new draft that holds only an expected result records an untitled case with no steps, subject to the policy.
The expected result stays in your draft until you add an action.

Emptying the action of a recorded step removes the step from the next version.
Its expected result, if it has one, stays in your draft in the same way.
If someone else records that step again while yours still has no action, their step replaces the step in your draft.
If your expected result differs from theirs, your expected result stays in your draft as a new step.

If a reload, a closed tab, a lost connection, an internal server error, or signing in again
interrupts a save's reply, the page keeps that save's command. Submitting again or reopening
the draft asks the server about the same save. If the save made a version, the status line
says "Your last save is recorded as version N". The page does not send that save again.
If the server has not recorded it yet, the save may still be on its way. The page sends the same
save again, and the server records it once, however many copies arrive.
In either case, the editor sends any text you typed after that save when you leave the editor.
After a reload or reopening a closed tab, you can select text while the server replies.
Later text stays on the version that save made, including spaces typed while recovery waits.
A tab closed before the reply arrives sends nothing more. The draft stays on this device.
When you open the draft again, the page asks the server about the save.

Each saved draft belongs to the project it was written for, including unsent edits, conflicts and submissions waiting for review.
If that project is deleted and another uses the same key, recovery neither reads the new project's question under the old reference nor sends the old text.
This also applies while the tab stays open: a matching question accepted in the replacement cannot settle or erase the old draft.
The page explains that the original project is gone or cannot be identified, and moves your text into **Preserved text**.
The old command is removed, so you can edit and save the current case normally.
Older saved drafts without their own project identity follow the same rule, even if an earlier saved command includes an identity.
You can copy text from the preserved draft or merge into your current edit, or choose **Discard preserved copy**.
The preserved copy stays through reloads and fresh saves until you discard it.
For a draft of a new case, find the preserved copy on the Suite.

The draft status says "Draft, saved on this device" when device storage works.
If storage is unavailable, it says "Draft, kept in this tab". Keep that tab open
until a version is recorded. Drafts do not sync between devices.

[Diagram: the life of a case](../diagrams/case-lifecycle.html)

## Edit in one window at a time

A draft belongs to the window that is editing it. Another window that opens the same draft shows it
read-only, with "This case is being edited in another window" and "Take over here".
To move the draft to your current window, choose "Take over here".
The draft opens with its text and any conflict card. The first window becomes read-only.
If its last save has not been confirmed, the new window asks the server what became of it.
A save still on its way is retried unchanged and recorded once. Later text becomes the next version
when you leave the editor. If the answer is lost, the draft keeps that save and asks again when you leave.

If two windows start typing at the same time, one can win ownership after the other has accepted text.
The losing text stays in a separate copy on this device. **Preserved text** shows the copy below the ownership
message, including its tags, requirement links, and any typed merge.
After taking over, copy the text you need into the editor. The copy survives a reload or closing the window.
Mainworthy keeps the copy until one of these events occurs.

- You choose **Discard preserved copy**.
- Another window's draft matches the copy exactly.
- A later recorded version contains all the text in the copy.

Ordinary takeovers carry the shared text forward and leave no preserved copy. If device
storage is full, keep the window open until you have copied the text.

Moving from one case to another never takes over its draft. Opening the app directly on a case,
through a link or a reload, continues a draft whose window has closed.
A window that is open keeps its draft, however busy it is. If the window holding a draft has closed or
crashed, another window showing the draft says "This draft is held by a window that is not answering, or
has closed". Press <kbd>e</kbd> or choose "Take over here" to continue the draft in the window you are in.

## Read versions and restore earlier content

Select a case to read its version, author, proof, and timeline.
A result names the case version it exercised. Editing the case does not rewrite that result.
The Proof section shows each method's latest result, with its original version, author, basis, and any model or test name.
It keeps those details even when the result is older than the timeline's displayed entries.
An older pass does not prove the current version. If a result has no recorded version, Proof says "unknown version".
Data replies from `get` and `find --in cases`, including CLI and MCP output, carry each proof's result `id`, `version`,
`by`, `method`, `model`, `name`, `outcome`, `at`, `current`, and `basis`. A method with no result is `null`.

![Case with proof and a proposed edit in its timeline](../ui/screenshots/case-light.png)

To read a version diff, follow these steps.

1. Press <kbd>v</kbd> to compare the current version with the one before it.
2. To compare another version with its preceding version, select that version in the timeline.
3. Choose "Close" to dismiss the diff.

The first version of a case has nothing before it. Asking for its diff opens nothing.
The status line at the bottom of the window says that there is no earlier version.
Diff rows wrap long words and tokens so their full text can be read.

In Suite, <kbd>u</kbd> first undoes the latest placement action when one is available.
Otherwise, on a recorded case with more than one version, it restores the preceding
version as a new version. With a timeline version focused, it restores that version's
predecessor. The API can request a specific version to restore.
When the policy asks a person first, the status line says the restore is proposed and names its question.
The case stays at its current version until that question is answered.
If a restore reply is lost, press <kbd>u</kbd> again. The page checks that request's recorded outcome before retrying it.
An already-recorded restore leaves later edits alone.
Leaving the case checks the old request once and reports its outcome with the case reference.
The page then drops that request. Pressing <kbd>u</kbd> on another case starts a new restore there.
The retry instruction clears as soon as you leave. The check reports that case's outcome even if you keep navigating.
A newer folder creation or version restore shows its own status instead.
If nothing was recorded when checked, the old request may still arrive, but the page does not retry it.
A final refusal shows the server's message without promising a retry of the old request.
If the project was replaced under the same key, the page discards the restore and asks you to reload.
See [the API guide](./api.md) for that operation.

Restoring creates history. It never deletes or rewrites the earlier versions.
The web diff compares adjacent versions, rather than offering two arbitrary version selectors.

## Organize the suite

To create a folder, follow these steps.

1. Press <kbd>n</kbd> <kbd>f</kbd> to create a folder.
2. Type its name.
3. Press <kbd>Enter</kbd>.

Creating a folder while inside another folder places it below that folder.
If the reply is lost, press <kbd>Enter</kbd> again to check the same request before retrying it.
The name stays read-only while that request is kept.
Pressing <kbd>Escape</kbd> or leaving the parent folder checks the old request once and reports its outcome
with the full folder path, then drops it and closes the field. The next folder creation is a fresh request.
The retry instruction clears while the page checks the outcome. Navigating again does not hide that folder's outcome;
a newer folder creation or version restore shows its own status instead.
If nothing was recorded when checked, the old request may still arrive, but the page does not retry it.
A final refusal leaves the name editable and shows the server's message without promising recovery of that request.
If the project was replaced under the same key, the server refuses the old creation and the page asks you to reload.
Select a folder in the sidebar to see its cases.

Creating, renaming, or moving a folder cannot introduce a duplicate path.
Existing duplicate paths do not block unrelated edits or a rename to a free path.
Path comparisons ignore letter case and use the Unicode cleaning described in [scope clauses](./policy.md#limit-agent-edits-by-folder-or-tag).
Creating or moving a case to an existing path uses that folder.
The server checks the final paths of a whole proposal again when accepting it.
Folder edits apply in order. A path that temporarily names two folders cannot be used as a destination during that batch.
Reorder the edits so that the path is unique first.
A pending proposal replays against the current folders. If a destination becomes ambiguous during replay,
its question stays visible in Queue and names the ambiguous path. You can reject it without changing the folders.
Accepting it is refused without applying any edits. Restore a unique destination before accepting it.
A refused replay still checks the policy against later edits and all candidate folders, including their paths and case tags.
It combines the requirements of every clause a resolution could select, so an earlier, looser folder clause cannot weaken review.
Conflicting role or author requirements need an admin. A person answers a refused replay, even where a rule would normally answer.
For a large or deep refused batch, any folder condition in the policy may apply, along with tags from any current folder.
Rejecting it may therefore need a reviewer or reason for an unrelated folder.
The policy's role and reason requirements also apply when rejecting the proposal.
You can combine folder creations, renames, moves, and case placement in one proposal.

Press <kbd>x</kbd> on each case you want to select for a bulk action.
With no selection, the action uses the current case.
Filtering keeps your selection. Adding or removing tags includes selected cases hidden by the filter.
Undoing a tag action includes those cases too.
Press <kbd>m</kbd> to choose a destination folder.
After the move, select that folder in the sidebar to see the case without reloading.
To add a tag, press <kbd>t</kbd>. Enter the tag name.
To remove a tag, press <kbd>Alt</kbd> (Option on a Mac) and <kbd>t</kbd>, or choose **Remove tag from selected cases** in the command palette.
Choose the tag to remove from the selected cases.
While editing one case, you can also use the remove control beside a tag chip, then record the edit with <kbd>Escape</kbd>.
On a phone, open the case and choose **Remove tag from selected cases** from **Actions**.
A removal protected by the project policy waits for review before changing the case.
Press <kbd>#</kbd> to archive the selected cases.
Press <kbd>u</kbd> to record the inverse of the latest placement action.
The changed-case count includes only cases the server changed.
If another person already made the requested change, the action says **No cases changed. Nothing to undo.**
Pressing <kbd>u</kbd> then leaves earlier actions alone.
For a partly stale selection, Undo affects only the cases this action changed.
Moves return to the folder and position that were current at the write.
If that folder was archived meanwhile, it stays archived. Find the returned active cases in **All cases**.
Tag undo reverses only the tags this action added or removed.
If a placement or Undo reply is lost, press <kbd>u</kbd>. The page checks the same request's recorded
outcome before sending it again, so retrying an already-recorded Undo leaves another person's later move alone.
For a lost placement reply, <kbd>u</kbd> undoes the placement if it reached the server.
If it never reached the server, <kbd>u</kbd> sends it once and then undoes it.
That leaves two entries in history and no net change.
If the project was replaced under the same key, the server refuses the old action. The page discards its Undo
and asks you to reload before changing cases.

Moves, tag changes, and archiving appear in history without creating a new body version.
Archived cases leave the active suite. Their recorded history remains available.
Select **Archived** in the Suite sidebar to find them, then open the case.
The case page labels it **Archived**, including when you open its old URL.
Press <kbd>#</kbd> to restore it, or choose **Restore selected** from the command palette.
On a phone, open the case and choose **Restore selected** under **Actions**.
Select only active cases to archive, or only archived cases to restore. A mixed selection is refused without changing any case.
A picked case must be open or in the loaded list before you archive or restore it.
If a selected state is unread, open the case or return to its list and wait for it to load.
Restore keeps its folder, tags, body version, and history. Select **All cases** to return to the active suite.
Folder, tag, and text filters also work in the archived view.

While the server saves or accepts a large bulk change, you can keep reading the suite.
Each read sees the complete state before or after the change. The proposal's changes become current together.
A save queued behind that change still waits for it to finish.
The same behavior applies to confirmed CSV imports and a person's answers that create cases for unlinked tests or apply accepted findings.
When the policy uses `unlinked: create`, the server creates cases during report ingestion without pausing for reads.

To filter the current list, press <kbd>/</kbd> to focus "Filter cases". Type the words to match.
Use the sidebar's tags to narrow the suite by tag.

The header counts every case that matches the words, the folder and the tags, and the list loads all of them, best match first.
Words that match more than 2,000 cases are too broad to rank. The list then shows one page of the newest matches,
those with the words in their title first, and the header says `N+ cases`. Add a word, a folder or a tag to reach the rest.
Planning a run from such a search says "Too many matching cases to count".

## Resolve simultaneous edits

Edits to different fields can merge without a conflict. If two edits change the
same field differently, Mainworthy keeps both sides and shows "Both edits are kept".
The current version stays current while you resolve the conflict.

To resolve the conflict, follow these steps.

1. Read "Your draft" and "Current version" in the conflict card.
2. Choose a side for each field, or type the merged text.
3. If both sides reordered steps, choose the draft or current order. A kept step that your draft removed
   returns beside its surviving neighbours. An order you explicitly choose takes precedence.
   Steps absent from that order follow at the end.
4. Choose "Resolve conflict".

A choice for a deleted step restores that step from the chosen side, including a pinned fragment version.
Step choices and step-order choices are separate, even when a step's id is `order`.

"Use all my changes" and "Keep current version" fill the merged body from one side.
Resolving sends the chosen changes through the policy for ordinary edits.
If someone changes the case again meanwhile, the new edit merges or opens another conflict.
The card lists the tag and requirement-link changes that accompany its body.
Resolving submits those changes with the chosen body as one proposal, including when you keep the current body.
You can also type `#tags` and `@REQ-123` links in the merged title, actions or expected results.
In a field you changed, they leave the text and join the same proposal when you resolve it.
In a changed title, whitespace becomes spaces before capture, including nonbreaking and full-width spaces before tokens.
Changed actions and expected results recognize the same whitespace before tokens without flattening their lines.
Actions and expected results recognize LF, CRLF and bare CR line endings equally and keep every other line of field text.
Saved titles are one line; actions and expected results can have multiple lines.
A title, action or expected result equal to that field in the conflict's recorded current or base version
stays literal, including any `#tag` or `@REQ-123` text. Step fields are matched by step id.
"Keep current version" keeps that body exactly. With no remaining metadata changes, resolving it
records no new version.
The replacement still needs any review required by its current or proposed tags.
Accepting records its body, tags and links together; rejecting records none of them.
A resolution accepts up to 5,000 tag additions and 5,000 requirement-link additions, and its whole
replacement must fit 5,000 edits, including the original proposal. An oversized resolution keeps
the conflict open without creating a replacement; reject it and propose smaller changes.
Tags and links added or removed by someone else remain as they recorded them,
unless your proposal explicitly changed those same items.
A failed reply or reload keeps the request and any later edits, so recovery does not submit accepted metadata again.

The conflict card stays until the page reads your recorded merge or a later case version from the server.
The same rule applies in a second tab. A merge waiting for approval under a stricter policy has not changed the case yet.
If the read fails, the card stays and the page says so. Choose "Resolve conflict" again, or "Read the case again" in a second tab.
If you leave the case in that second tab before the read finishes, pressing <kbd>e</kbd> reads the case first when you return.
Clicking a field or changing a property also triggers that read.
The page discards a property change made before the read finishes.
Once the page shows the recorded case, change the property again.
Until the read finishes, the tab shows the case as it last read it.

## Review under a stricter policy

Under `loose`, ordinary case proposals take effect at once.
Under `standard`, an agent's edit waits for a person. A person's ordinary edit still takes effect at once.
Under `strict`, ordinary edits wait for a person with a reason, including edits by people.

The case timeline shows the proposal with every edit in it, the edits of other cases included,
since accepting it accepts all of them. An authorized person can use
<kbd>a</kbd> to accept it or <kbd>r</kbd> to reject it.
A key, or the Accept or Reject button, brings the proposal into view and shows its first unread part in the same press.
Later presses page through unread edits even when the card is taller than its pane.
If the pane hides the next unread part, the same press moves the pane to show it.
It answers only once the last edit is showing.
The buttons and action keys offer only answers that apply to the proposal.
A conflicting proposal cannot be accepted. Its author resolves both sides: in the conflict card when they edited
the case in their browser, or with the `merge` answer of `decide` when they proposed through the API, the command
line or MCP. An authorized person can reject it with <kbd>r</kbd>.
When the policy requires a reason, the case pane opens a field labeled with Accept or Reject.
The answer buttons and keys stay disabled while this field is open.
If someone settles the question meanwhile, the field closes when the page receives that decision.
If your answer fails, the pane keeps newer timeline updates and reads the case again.
Type the reason and press <kbd>Enter</kbd> to record the answer, or <kbd>Escape</kbd> to cancel.
Conflicts and policy changes have separate rules. See [policy](./policy.md).

## Write cases from the command line

```sh
$ mainworthy new coupon.txt
$ mainworthy get C-1 --md > coupon.md
$ mainworthy fmt coupon.md
```

`new` reads an outline or canonical case Markdown. It also accepts standard input.
`get --md` prints the stored case as canonical Markdown.
`fmt` parses canonical Markdown and prints its standard form without changing the server.
It needs no running instance. Parse errors name the source line.
See [the CLI guide](./cli.md) for command forms and flags.

## Custom field values

Canonical Markdown can carry a `fields` map in its header. Values are strings and survive Markdown round trips.
Terminal controls and workflow-command prefixes print as reversible escapes in header values and body text.
When editing an existing case, omitting the `fields` header keeps the values from the edit's base version.
Concurrent field changes merge under the ordinary edit rules.
A proposal that supplies the map replaces all its values, so include keys you want to keep.
Unless a required field prevents it, an explicit empty header clears the values.
The empty header can be either `fields:` with no entries or `fields: {}`.
In the web editor, every field defined in Settings appears below the title when you capture or edit a case.
Text fields accept text; choice fields offer the allowed values. Fields marked **required** need a nonblank
value for a new case. Escape, Record version and automatic saving validate fields before sending a proposal.
A refusal names the field in the status line and keeps your draft on this device. Fill the field and save again.
Clearing an optional field removes its value. The editor preserves stored keys without a definition. A save sends the field map only when you change it, so
resuming a draft from before custom field reads preserves values the draft never loaded, unless you change a field in it:
then the save sends only the fields that draft knows, and stored values it never loaded are removed.
The iPhone editor preserves custom field values but does not edit them.

A project can define text or choice fields and require values.
See [Custom fields](./policy.md#custom-fields) for the procedure.
New cases, restores, and changed field values must meet the definitions in force when proposed and adopted.
An edit can keep unchanged values from the current case, including missing required values or choices no longer allowed.
The web and iPhone editors can therefore edit older cases without filling new required fields.
Older versions remain readable as recorded.

## Reuse pinned fragments

A fragment is a versioned set of shared steps. To create a fragment in Suite, follow these steps.

1. Start a new case.
2. Choose **Fragment** in **Kind**.
3. Write the shared steps.

A recorded document's kind stays fixed. Fragments cannot include other fragments. A reference inserts
only the steps, not the fragment's preconditions or custom fields.

While editing a case, insert shared steps with these controls.

1. Open **Insert fragment**.
2. Enter the fragment ref, such as `C-12`.
3. Leave **Version** empty to pin the current version, or enter an older version.
4. Choose **Insert pinned fragment**.

The editor shows the shared steps and their source.
To remove the reference from the case, choose **Remove fragment**.
To change shared instructions, edit the fragment itself.

An archived fragment keeps its versions and existing pins. The insertion picker
excludes archived fragments, including their historical versions. You can edit
other content in cases that reference the fragment. Restore the fragment before inserting another
reference or moving a pin to a different version.

Reading a case or running it shows the fragment steps inline, marked with the
fragment ref and pinned version. Publishing another fragment version leaves
existing cases unchanged. Old case versions and runs keep their original pins.
Fragments themselves are omitted from run selections.

Search and run selections by text include the actions and expected results of
pinned steps at their pinned version. A newer fragment version changes those
matches only after you update the case's pin.

Open a fragment to see **Fragment users** and the versions each case uses.
To update cases pinned to an older fragment version, follow these steps.

1. Choose the older fragment version.
2. Select the cases to update.
3. Choose **Update selected to vN**.

One proposal records the selected updates and who requested them. The
project's policy may require acceptance. Unselected cases stay pinned. If any
selected case changes before the update is accepted, refresh and propose the
batch again. No selected case moves from that refused batch.
Large batches let reads answer while checking and applying the selected updates.
Until the batch commits, readers see every case at its previous version.
Moving a pin makes earlier results no longer current proof of the updated case,
even when the two fragment versions have the same instructions.

Markdown preserves a reference with its own step id:

```markdown
- !use C-12@v3 ^ab
```

A fragment's header uses `kind: fragment`. A literal action beginning with `!`
is escaped as `\!` in canonical Markdown. Instance and project archives preserve
fragment history and pins. Use the web editor to edit a fragment or a case with pinned fragments.
The iPhone app reads these documents but cannot save edits to them.
Fragment authoring and batch updates use the web,
HTTP `propose`, or CLI JSON. MCP discovery omits these inputs.
When a creation supplies both `kind` and Markdown, their kinds must agree.
A missing Markdown `kind:` line means `case`, so `kind: "fragment"` also requires
`kind: fragment` in the Markdown header.

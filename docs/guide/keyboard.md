# Keyboard

Every key of the web UI, by screen. In the app, <kbd>?</kbd> lists the keys of the screen you are on, and the bar at the bottom shows the ones you are most likely to want next.

## How the keys work

- Two keys in a row, such as <kbd>g</kbd> <kbd>q</kbd>, are pressed one after the other, not together. You have a little under a second for the second key.
- <kbd>⌘</kbd> is Command on macOS and Ctrl everywhere else.
- While you type in a field, only <kbd>⌘</kbd> combinations, <kbd>Esc</kbd> and the keys of the case editor work. <kbd>Esc</kbd> leaves the case editor, the filter and a run's note. A field in Settings keeps the focus: click outside it first.
- While the palette or the list of keys is open, only <kbd>Esc</kbd> and <kbd>⌘</kbd> <kbd>K</kbd> work.

## Everywhere

| Key | What it does |
| --- | --- |
| <kbd>g</kbd> <kbd>s</kbd> | Go to Suite |
| <kbd>g</kbd> <kbd>q</kbd> | Go to Queue |
| <kbd>g</kbd> <kbd>r</kbd> | Go to Runs |
| <kbd>g</kbd> <kbd>c</kbd> | Go to Changes |
| <kbd>g</kbd> <kbd>,</kbd> | Go to Settings |
| <kbd>g</kbd> <kbd>d</kbd> | Docs for this screen. Opens the page about the screen you are on, in a new tab. |
| <kbd>g</kbd> <kbd>x</kbd> | Sign out. Ends this browser's session and shows the sign-in page. It is there when you signed in, and not in local mode, where the owner of the machine needs no sign-in. |
| <kbd>⌘</kbd> <kbd>K</kbd> | Jump to or run. Opens the palette: type a ref such as `C-12`, words from a case title, the name of an action, or `docs` and a word. |
| <kbd>?</kbd> | All keys of the current screen |
| <kbd>[</kbd> | Collapse / expand sidebar |
| <kbd>Esc</kbd> | Close palette / keys |

## Suite and case

![The suite: cases on the left, the selected case on the right](../ui/screenshots/suite-light.png)

| Key | What it does |
| --- | --- |
| <kbd>c</kbd> | New case |
| <kbd>e</kbd> or <kbd>↵</kbd> | Edit case |
| <kbd>j</kbd> or <kbd>↓</kbd> | Next case |
| <kbd>k</kbd> or <kbd>↑</kbd> | Previous case |
| <kbd>/</kbd> | Filter the list |
| <kbd>x</kbd> | Select case, for the three keys below. With none selected they act on the current case. |
| <kbd>m</kbd> | Move selected to a folder |
| <kbd>t</kbd> | Tag selected |
| <kbd>#</kbd> | Archive selected |
| <kbd>u</kbd> | Undo the last move, tag or archive. With nothing to undo, restores the version before. |
| <kbd>Space</kbd> | Peek timeline |
| <kbd>]</kbd> | Next folder |
| <kbd>Alt</kbd> <kbd>[</kbd> | Previous folder |
| <kbd>n</kbd> <kbd>f</kbd> | New folder |
| <kbd>z</kbd> | Widen case pane |
| <kbd>v</kbd> | Version diff |
| <kbd>a</kbd> | Accept proposal |
| <kbd>r</kbd> | Reject proposal |

### While you write a case

| Key | What it does |
| --- | --- |
| <kbd>↵</kbd> | First step, when you are in the title |
| <kbd>↵</kbd> | Next step, when you are in a step |
| <kbd>Tab</kbd> | Expected result of the step you are on |
| <kbd>Shift</kbd> <kbd>↵</kbd> | Next new case: records this one and starts another |
| <kbd>⌘</kbd> <kbd>↵</kbd> | Record version now |
| <kbd>Esc</kbd> | Seal and leave editor: records the version and leaves |

[Write cases](./write-cases.md) explains the outline you type and when a version is recorded.

## Queue

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> or <kbd>↓</kbd> | Next question |
| <kbd>k</kbd> or <kbd>↑</kbd> | Previous question |
| <kbd>Space</kbd> | All evidence of the question, or back to the short view |
| <kbd>x</kbd> | Select question, to answer several of one kind at once |
| <kbd>↵</kbd> | Take advice: gives the answer an agent advised |
| <kbd>u</kbd> | Undo answer |

The answer keys depend on the kind of question. The queue shows the ones that apply to the question you are on, each with what it does.

<!-- generated:queue-keys -->

| Key | Answer | On a question about |
| --- | --- | --- |
| <kbd>a</kbd> | Accept | a proposed edit |
| <kbd>r</kbd> | Reject | a proposed edit |
| <kbd>l</kbd> | Link to a case | a test with no case |
| <kbd>c</kbd> | Create cases | a test with no case |
| <kbd>t</kbd> | Track without a case | a test with no case |
| <kbd>d</kbd> | Defect in the product | a failed result |
| <kbd>t</kbd> | The test is wrong | a failed result |
| <kbd>e</kbd> | Expected: behaviour changed | a failed result |
| <kbd>f</kbd> | Flaky | a failed result |
| <kbd>i</kbd> | Infrastructure | a failed result |
| <kbd>n</kbd> | Already failing on base | a failed result |
| <kbd>m</kbd> | The failure was a mistake | a failed result |
| <kbd>a</kbd> | Accept | a finding from a review |
| <kbd>r</kbd> | Reject | a finding from a review |
| <kbd>d</kbd> | Duplicate | a finding from a review |
| <kbd>z</kbd> | Defer | a finding from a review |
| <kbd>a</kbd> | Approve | closing a run |
| <kbd>r</kbd> | Reject | closing a run |

<!-- /generated -->

[Decide in the queue](./decide.md) explains each answer.

## Runs

In the list of runs:

| Key | What it does |
| --- | --- |
| <kbd>n</kbd> | Plan run |
| <kbd>j</kbd> | Next run |
| <kbd>k</kbd> | Previous run |
| <kbd>↵</kbd> | Open cockpit: the run with its slots |

In a run:

| Key | What it does |
| --- | --- |
| <kbd>p</kbd> | Pass |
| <kbd>f</kbd> | Fail and note: type what went wrong, then <kbd>↵</kbd> |
| <kbd>b</kbd> | Blocked |
| <kbd>s</kbd> | Skip |
| <kbd>u</kbd> | Correct last result |
| <kbd>j</kbd> or <kbd>↓</kbd> | Next slot |
| <kbd>k</kbd> or <kbd>↑</kbd> | Previous slot |
| <kbd>0</kbd> <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> <kbd>5</kbd> <kbd>6</kbd> <kbd>7</kbd> <kbd>8</kbd> <kbd>9</kbd> | Mark step digit |
| <kbd>Esc</kbd> or <kbd>⌫</kbd> | Clear step mark |
| <kbd>↵</kbd> | Record failure, while you type its note |
| <kbd>Esc</kbd> | Cancel note |

To say which step failed, type its number and then <kbd>f</kbd>. [Planned runs](./runs.md) explains slots and what fills them.

## Changes

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> | Next change |
| <kbd>k</kbd> | Previous change |
| <kbd>↵</kbd> | Open blocking question in the queue |

## Settings

| Key | What it does |
| --- | --- |
| <kbd>j</kbd> | Next setting |
| <kbd>k</kbd> | Previous setting |
| <kbd>n</kbd> | New token, in the Tokens section |
| <kbd>n</kbd> | New project, in the Projects section |
| <kbd>n</kbd> | New invitation, in the People section: the caret goes to the person's name |
| <kbd>n</kbd> | New password, in the Your sign-in section |

Settings has no key that ends a session or removes a passkey: <kbd>Tab</kbd> reaches "End" and "Remove".

## The sign-in page and an invitation

These two pages open before you are signed in, so the keys above do not work on them. They are plain forms.

| Key | What it does |
| --- | --- |
| <kbd>Tab</kbd> | Next field or button, in the order they are on the page |
| <kbd>↵</kbd> | Sends the form the caret is in: sign in, or accept the invitation |
| <kbd>Space</kbd> | Ticks "Make a passkey on this device" on an invitation, when the caret is on it |

The caret starts in the name on the sign-in page and in the password on an invitation.

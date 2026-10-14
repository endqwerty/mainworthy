# Keyboard

Every key of the web UI, by screen. In the app, <kbd>?</kbd> lists the keys of the screen you are on, and the bar at the bottom shows the ones you are most likely to want next.

## How the keys work

- Two keys in a row, such as <kbd>g</kbd> <kbd>q</kbd>, are pressed one after the other, not together. You have a little under a second for the second key.
- <kbd>⌘</kbd> is Command on macOS and Ctrl everywhere else.
- While you type in a field, only <kbd>⌘</kbd> combinations, <kbd>Esc</kbd> and the keys of the case editor work. <kbd>Esc</kbd> leaves the case editor, the filter and a run's note. A field in Settings keeps the focus: click outside it first.
- A list you choose from, such as a case's automation, a token's producer or a run's cases, keeps the focus while the arrow keys step through it. <kbd>↵</kbd> or <kbd>Esc</kbd> gives the keys back to the screen, and so does <kbd>Tab</kbd>. Picking from the open list gives them back at once.
- While the palette or the list of keys is open, only <kbd>Esc</kbd> and <kbd>⌘</kbd> <kbd>K</kbd> work.
- <kbd>↵</kbd> and <kbd>Space</kbd> press a button that you reached with <kbd>Tab</kbd>, and <kbd>↵</kbd> follows a link you reached that way. Everywhere else they are the screen's keys. That includes a button you clicked with the mouse, until the focus moves on, and the rows of a screen's list.

## On a phone

A phone, or a tablet held upright, is worked with a finger, so the app is laid out for one there. It shows one pane at a time.

- **Menu** (☰) opens the sidebar: the screens, the project, the folders and tags of the suite, the theme and Sign out.
- A screen opens on its list. Tap a row to read it, and **Back** to return to the list. A link to one case, question, run or change opens on that thing.
- **Actions** opens the palette. It lists what the keys of the screen do. Tap one to run it. Tap the field at the top to search for a case or to jump to a ref.
- While a list is shown, **Actions** offers what belongs to the list, such as New case, Filter and Plan run. Open a row for the actions on it, such as Edit case, an answer or Record version. Nothing is decided about a case or a question you have not opened.
- With a keyboard attached, the keys follow the same rule. While a list is shown, the keys of the list work: <kbd>c</kbd>, <kbd>/</kbd>, <kbd>n</kbd> in Runs, and the keys under [Everywhere](#everywhere) but <kbd>[</kbd>. Once a row is open, every key of the screen works but <kbd>n</kbd> <kbd>f</kbd>, whose form is in the sidebar, which is closed by then. <kbd>Tab</kbd> into the detail shows it. While the sidebar is open, only the keys of the list work. While the palette is open, only <kbd>Esc</kbd> and <kbd>⌘</kbd> <kbd>K</kbd> do, as on the desktop, and the palette has its own <kbd>↑</kbd> <kbd>↓</kbd> to move and <kbd>↵</kbd> to run the choice. Its field does not take the focus on a phone, so the keyboard on the screen stays closed: tap the field to type in it, since a letter typed before that goes nowhere.
- A button does what it does on a desktop: an answer in the Queue, Pass, Fail, Blocked and Skip in a run, Accept and Reject on a proposal.

Three things need a keyboard and have another way without one:

| On a desktop | On a phone |
| --- | --- |
| A digit marks the step a run failed at | Write the step in the note |
| Drag a case onto a folder | **Actions**, then Move selected |
| <kbd>Esc</kbd> leaves the case editor | **Back**, or **Actions**, then Seal and leave editor. Both record what you typed. A conflict that waits for your answer stays as it is. |

The layout follows the pointer, not the width of the window. A browser worked with a mouse keeps the desktop layout however narrow its window is. So does a tablet whose window is wider than 900 px and taller than 500 px, as most are on their side.

## Everywhere

| Key | What it does |
| --- | --- |
| <kbd>g</kbd> <kbd>s</kbd> | Go to Suite |
| <kbd>g</kbd> <kbd>q</kbd> | Go to Queue |
| <kbd>g</kbd> <kbd>r</kbd> | Go to Runs |
| <kbd>g</kbd> <kbd>c</kbd> | Go to Changes |
| <kbd>g</kbd> <kbd>,</kbd> | Go to Settings |
| <kbd>g</kbd> <kbd>p</kbd> | Switch project. Lists the projects you can read. Type part of a name or a key and press <kbd>↵</kbd>. The screen you are on stays open. The key is there when you can read more than one project. |
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

The caret starts in the name on the sign-in page and in the password on an invitation. When the browser is signed in as somebody else, an invitation first asks whether to sign them out, and the caret starts on "Continue". A button that was pressed keeps the keyboard focus while its request runs and after a refusal, so the next <kbd>↵</kbd> tries again.

# What you can customize

See everything a team can adjust in Mainworthy, who may adjust it, and where to do it. Use this page to find the right setting, then follow the link to the page that explains it.

[Diagram: what you can customize, and where](../diagrams/customize-map.html)

## Five levels

Settings sit at five levels. The level tells you who is affected when you change one.

- The instance is one running server and its data. The server's address, mode, data directory and reader threads belong here, and so do people, agents, pipelines and their tokens. You set the server through environment variables. You set the rest in Settings or with the `mainworthy` command.
- A project is its own set of cases, runs, queue and policy. One instance can hold several. A person, an agent or a pipeline can have different rights in each.
- A case says which producers may test it: people, the pipeline, agents, or any mix.
- A run says what it needs before it is complete. You choose that when you plan the run.
- Your browser keeps your theme, sidebar choice, and personal home. Each person has a separate home for each project.

Two words recur below. An instance admin holds the `admin` capability on every project. A project admin holds it on one project. The owner is the person the instance names as its owner, your user name by default, and the owner always holds every capability.

## What you can change

| What | Where you change it | Who may | Details |
| --- | --- | --- | --- |
| The policy preset | Settings, Policy, "Preset", or `mainworthy policy use` | An admin on the project who also holds `produce` | [Policy](./policy.md) |
| What happens to a test with no case | Settings, Policy, "Tests with no case", or `mainworthy policy tests` | The same | [Policy](./policy.md#tests-with-no-case) |
| When a report with no tests passes | `mainworthy policy empty pending` or `mainworthy policy empty nothing-required` | The same | [Policy](./policy.md#reports-with-no-tests) |
| Single clauses, the flaky hold, the evidence basis | Settings, Policy, "Edit clauses", or `mainworthy propose` with a policy edit | In Settings, a person with instance `admin` and project `produce`. The command line can propose for another admin to accept | [Policy](./policy.md#change-single-clauses) |
| Same-code detector settings | `mainworthy propose` with a policy edit. Settings shows the current values | An admin on the project who also holds `produce` | [Policy](./policy.md#same-code-detector-settings) |
| Custom field definitions | Settings, Policy, "Custom fields", or a `propose` policy edit | An instance admin who holds `produce` in Settings; a project admin through `propose` | [Policy](./policy.md#custom-fields) |
| Projects | Settings, Projects, "Create a project", or `mainworthy admin` | An instance admin | [Policy](./policy.md#choose-a-preset-for-a-new-project) |
| What each person, agent or pipeline may do | `mainworthy actor grant` and `actor ungrant`. Settings shows tokens only | An instance admin who is a person | [People, agents and pipelines](./access.md) |
| Tokens | Settings, Tokens, or `mainworthy token new`, `list` and `revoke` | An instance admin. A token for a person who exists: that person or the owner | [People, agents and pipelines](./access.md#make-a-token) |
| How an agent connects | Settings, Connect, then `mainworthy mcp` or the `/mcp` address | Whoever holds an agent token | [Let an agent in](./agents.md) |
| What a run asks for | Runs, <kbd>n</kbd>, or `mainworthy plan` for methods, people and required jobs | Anyone with `plan` | [Planned runs](./runs.md) |
| Folders and tags | Suite | Anyone with `produce`. The policy decides whether the edit applies at once | [Write cases](./write-cases.md#organize-the-suite) |
| Which methods a case admits | The case's "Can be exercised by" section, or `methods` in its Markdown | Anyone with `produce`, under the same rule | [Let an agent in](./agents.md#what-agent-work-is-worth) |
| Your home | Settings, Your home | You, for yourself in this browser and project | [This page](#choose-your-home) |
| The theme | The "Theme" button at the bottom of the sidebar | You, in your own browser | This page |
| The sidebar, open or collapsed | The button beside "Mainworthy" at the top of the sidebar, or <kbd>[</kbd> | You, in your own browser | [This page](#the-sidebar) |
| Where the server listens, its mode, data directory and reader threads | Environment variables | Whoever starts the server | [Configuration](./configuration.md) |
| How CI reports | A pipeline token, and `MAINWORTHY_URL`, `MAINWORTHY_TOKEN` and `MAINWORTHY_PROJECT` in the job | An admin makes the token. Whoever edits the pipeline sets the rest | [Report results](./report-results.md#give-a-pipeline-its-own-token) |
| Backups and moving machines | `mainworthy export` and `mainworthy import` | An instance admin | [Your data](./data.md) |

## Policy is the largest setting

The policy decides who answers each kind of question and what an agent's answer is worth. It changes how much your team trusts an edit, a failure explanation or an agent without changing any data. The three presets run from `loose` to `strict`. [Policy](./policy.md) compares them and shows how to switch.

A policy change is not a private setting. It is a proposal that an admin who is a person accepts, and both stay in the record.

## Projects

Each project keeps its own cases, queue, runs and policy. A new project starts with the preset you choose. The first project, `scratch`, exists so you can write a case before you configure anything.

A project key is lower-case letters, digits and hyphens, up to 40 characters, and starts with a letter or digit. You cannot rename or delete a project yet. The other commands pick a project with `--project` or `MAINWORTHY_PROJECT`, or use the only one when there is one.

### Switch projects

The sidebar names the project you are in, under "Mainworthy". When you can read more than one project, the name is a button. Press it, or <kbd>g</kbd> <kbd>p</kbd>, and Mainworthy lists your projects, each with its key and its policy. The choice starts on the first project you are not in, so <kbd>↵</kbd> goes there. To find another, type part of its name or its key.

You stay on the screen you were on: from Queue you arrive in the other project's Queue. A case, question or run that was open stays behind, because its ref belongs to one project, and Back returns to it. With the sidebar collapsed, the button shows the first letter of the project's name.

On a phone the project's line is in the menu: tap **Menu**, then the project, then the one to go to. **Actions** offers "Switch project" as well. With a keyboard attached, <kbd>g</kbd> <kbd>p</kbd> opens the list, and <kbd>↑</kbd> <kbd>↓</kbd> and <kbd>↵</kbd> choose from it, as on a desktop.

The palette (<kbd>⌘</kbd> <kbd>K</kbd>) finds a project too, once you type a word of its name. Settings, Projects lists the same projects, and a press on one opens its Settings.

### A project of demo data

To look around before you write a case of your own, fill a project with the demo.

```
$ mainworthy seed demo
seeded demo: 2000 cases, run R-53, 65 questions
http://127.0.0.1:7357/p/demo/suite
```

The demo is a shop's suite. Its cases are in 29 folders under eight areas: Checkout, Accounts, Orders, Catalog, Back office, Notifications, Mobile app and API. Each folder holds the scenarios of one feature, and each case has steps of its own. A feature that needs more cases than it has scenarios repeats them for another browser, language or kind of customer, as a real suite does. About a third of the cases have an automated test, and each test is linked to its case.

The pipeline also reports the shop's unit tests, which no case names: 60 files under `tests/unit/`, one open question each. That is the queue a first real project has, with many rows that want the same answer. Answer them one at a time to see what that costs. Then answer them all at once: in Settings, Policy, set "Tests with no case" to "Track without a case", or run `mainworthy --project demo policy tests track`. `--unlinked-files` sets how many files there are, from 0 to 500.

The project holds fourteen days of history before today:

- A pipeline named `pipeline` reported on `main` every night, and on one to three pull requests on most days. Two days of each week are quieter; this pattern comes from the seed, so it does not depend on the real weekday. Two nights found a defect, one night its services were down, and some pull requests failed before they were fixed. A person answered each failure the day it was reported.
- A run was planned every other day and worked through by hand. The older ones are closed as passed. The one from two days ago found a defect and stays open, and yesterday's is half done.
- Some cases were edited, and an agent named `reviewer` reviewed two pull requests.

Today `main` fails one test, and so does pull request 482, which starts from that commit. A run named "Checkout regression" is planned on the pull request, and `reviewer` has left a finding and a proposed edit. The queue holds five questions that need judgment: the failing test on `main` and on the pull request, the finding, the proposed edit, and a test that has no case. The sixty unit-test questions make 65 in all. The demo adopts the `standard` preset before its first report, set to ask about tests with no case. This keeps the pull request's failure open with the hint that it also fails on the base.

Four flags change what is written:

- `--cases` sets how many cases, from 1 to 100000.
- `--seed` is the number the demo is made from. The same seed gives the same cases, pull requests and failures on any instance. Another seed gives another demo of the same shop. The default is 1.
- `--days` sets how many days of history, from 0 to 90. With 0 the demo holds today and nothing before it.
- `--unlinked-files` sets how many files of unit tests have no case, from 0 to 500. The default is 60; use 0 to leave only the five questions above.

The history ends on the day you run the command. It does not move forward afterwards: a demo seeded a month ago shows the fourteen days before that day.

You name the project each time. `seed` makes it when the instance has none of that name, and it does not read `--project` or `MAINWORTHY_PROJECT`. It fills a project nothing was written to, and refuses any other, so it cannot add the demo to your own work. If a seed stops halfway, send the same command again with the same flags: it finishes the rest and writes nothing twice.

A seeded project is a demo project, and stays one. Only a demo project accepts a write that says when it happened, which is how the demo comes to hold days it was not there for. Every other project records the server's clock, and no flag or token changes that. [The API page](./api.md#say-when-a-write-happened) has the detail.

The demo mark is stored by migration `0009_demo_projects.sql`, schema version 9. It is excluded from archives, so it does not change their version.

`seed` needs a person who administers the instance, because it makes the project and the two actors. In server mode, give that person's token with `--token` or `MAINWORTHY_TOKEN`. The pipeline and the agent hold a grant on the demo project alone, and the two tokens `seed` used for them end after an hour.

You cannot delete a project yet, so the demo stays until you start with a new data directory.

## Cases, folders and tags

Folders nest. A tag is lower case, starts with a letter or digit, and can hold `-`, `_`, `.` and `/`. Moving a case or changing its tags is an edit like any other, so under `strict` it waits for a person.

A case lists the methods that may produce evidence for it. People are the default. Add agents so an agent's result can count in a run that asks for agents. An automated test does not depend on this list: its link to the case, or the case's ref in the test's name, is what lets its result fill a slot. A case keeps at least one method.

## The theme

Press "Theme" at the bottom of the sidebar to switch between light and dark. Until you do, Mainworthy follows your system. The choice stays in this browser.

## The sidebar

To make room for what you are reading, collapse the sidebar: press the button beside "Mainworthy" at its top, or <kbd>[</kbd>. The sidebar becomes a strip 64 px wide. The strip keeps the project, the search, the four screens and the footer, each as an icon. It does not show the folders and tags of the Suite.

The pane on the right takes the width the sidebar gave up. That is the pane where you read a case, a question, a run or a change. The list keeps its width. In a window narrower than about 900 px the panes are at their least width and do not all fit beside the open sidebar, so part of the width goes to fitting them in first. In a window narrower than 760 px the list is above the other pane, and both get wider.

Press the button or <kbd>[</kbd> again to open the sidebar. The choice stays in this browser, so a reload and your next visit find the sidebar as you left it. A browser that stores nothing for the site still collapses the sidebar, and opens with it open.

In the Suite, <kbd>z</kbd> sets the list to 340 px and gives the case the rest, which widens the case further in a window wider than about 900 px. The two work together. In a narrower window the list is under 340 px already, so <kbd>z</kbd> takes width from the case. In a window narrower than 760 px <kbd>z</kbd> changes nothing, because the case is under the list.

A phone has no strip. There, **Menu** opens the sidebar over the pane ([Keyboard](./keyboard.md)).

## Choose your home

Open Settings with <kbd>g</kbd> <kbd>,</kbd>, then choose **Your home**. Pick Suite, Queue, a run, or a saved search, and press **Save home**. Suite is the default.

For a run, enter its ref in this project, such as `R-12`. For a saved search, enter the search text, folder path, tag, or any combination. The search applies all the filters you enter and reads the current cases each time. Leave a field empty to leave that filter out. This saves one home search per project, not a named search library.

Press <kbd>g</kbd> <kbd>h</kbd>, or choose **Go home** in the palette, to open your home. On a phone, **Actions** offers Go home while either pane is shown. Opening the instance at `/` uses your first accessible project's home. Opening `/p/<project>` or `/p/<project>/` without a query uses that project's home. A project address with filters or a link to an invitation, screen, case, question, or run keeps its own destination. Other paths outside `/p/`, such as `/?utm=1` and `/nowhere`, open Suite in your first accessible project.

The preference is stored in this site's localStorage, separately for your signed-in name and each project. **Sign out and keep drafts** keeps it for when you sign back into the same browser. **Sign out and clear browser data** removes it. It does not follow you across browsers or into the iPhone app. Clearing the site's browser data removes it. Nobody else's home or project data changes when you save yours.

A browser that cannot read the preference opens Suite. If saving fails, the form says so and keeps your previous home. If the saved run or search folder no longer exists, Mainworthy opens Suite and tells you that your home was not found. Open Settings to choose another home. If the lookup fails on entry, Mainworthy opens Suite with a notice and keeps your saved home so you can try **Go home** again. A search that matches no cases still opens with its saved filters.

## What is fixed today

Some things look like settings and are not. Each of these is the same on every instance.

- The five kinds of question: a proposed edit, a test with no case, a failed result, a finding and closing a run. Each takes the answers [Decide in the queue](./decide.md) lists, on the keys it lists.
- The four verdicts, `passed`, `failed`, `blocked` and `pending`, and the exit codes 0 to 3 of `mainworthy gate`.
- The six capabilities (`read`, `record`, `produce`, `answer`, `plan`, `admin`) and the kinds of actor. You cannot define a role of your own.
- A pipeline holds `read` and `record` at most, whatever its grant says.
- Three named presets. A policy with different clauses is called `custom`. Settings edits its clauses under Policy.
- The shape of a case: a title, preconditions, steps with expected results, methods, an automation intent, tags, a folder and the requirements it covers. A case can carry free `fields` of text in its Markdown, and project definitions can require values or limit them to a choice. The case editor does not show or edit field values; use Markdown or a `propose` body. [Policy](./policy.md#custom-fields) explains the definitions.
- Sign-in is by token, or for a person by a name and a password or a passkey, which an admin's invitation link sets up. A password can require an authenticator code. There is no single sign-on or mail: a lost password is replaced through a recovery link. A password is 12 to 256 characters and has no other rule. A token works until you revoke it or until the end you gave it.
- The database is one SQLite file.

These are not built yet: stable-trunk flakiness detection, quarantine entry and exit, a requirements coverage matrix, two-person approval, frozen evidence, gap waivers, importers from other tools, and reports or dashboards.

## See also

- [Configuration](./configuration.md) for the server's variables.
- [Glossary](./glossary.md) for the words used here.

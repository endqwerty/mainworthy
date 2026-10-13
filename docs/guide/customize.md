# What you can customize

See everything a team can adjust in Mainworthy, who may adjust it, and where to do it. Use this page to find the right setting, then follow the link to the page that explains it.

[Diagram: what you can customize, and where](../diagrams/customize-map.html)

## Five levels

Settings sit at five levels. The level tells you who is affected when you change one.

- The instance is one running server and its data. The server's address, mode, data directory and reader threads belong here, and so do people, agents, pipelines and their tokens. You set the server through environment variables. You set the rest in Settings or with the `mainworthy` command.
- A project is its own set of cases, runs, queue and policy. One instance can hold several. A person, an agent or a pipeline can have different rights in each.
- A case says which producers may test it: people, the pipeline, agents, or any mix.
- A run says what it needs before it is complete. You choose that when you plan the run.
- Your browser keeps your theme. Nobody else sees it.

Two words recur below. An instance admin holds the `admin` capability on every project. A project admin holds it on one project. The owner is the person the instance names as its owner, your user name by default, and the owner always holds every capability.

## What you can change

| What | Where you change it | Who may | Details |
| --- | --- | --- | --- |
| The policy preset | Settings, Policy, "Preset", or `mainworthy policy use` | An admin on the project who also holds `produce` | [Policy](./policy.md) |
| Single clauses, the flaky hold, the evidence basis | `mainworthy propose` with a policy edit. Settings has no control for these | The same | [Policy](./policy.md#change-single-clauses) |
| Projects | Settings, Projects, "Create a project", or `mainworthy admin` | An instance admin | [Policy](./policy.md#choose-a-preset-for-a-new-project) |
| What each person, agent or pipeline may do | `mainworthy actor grant` and `actor ungrant`. Settings shows tokens only | An instance admin | [People, agents and pipelines](./access.md) |
| Tokens | Settings, Tokens, or `mainworthy token new`, `list` and `revoke` | An instance admin | [People, agents and pipelines](./access.md#make-a-token) |
| How an agent connects | Settings, Connect, then `mainworthy mcp` or the `/mcp` address | Whoever holds an agent token | [Let an agent in](./agents.md) |
| What a run asks for | Runs, <kbd>n</kbd>, or `mainworthy plan` for methods, people and required jobs | Anyone with `plan` | [Planned runs](./runs.md) |
| Folders and tags | Suite | Anyone with `produce`. The policy decides whether the edit applies at once | [Write cases](./write-cases.md#organize-the-suite) |
| Which methods a case admits | The case's "Can be exercised by" section, or `methods` in its Markdown | Anyone with `produce`, under the same rule | [Let an agent in](./agents.md#what-agent-work-is-worth) |
| The theme | The "Theme" button in the sidebar | You, in your own browser | This page |
| Where the server listens, its mode, data directory and reader threads | Environment variables | Whoever starts the server | [Configuration](./configuration.md) |
| How CI reports | A pipeline token, and `MAINWORTHY_URL`, `MAINWORTHY_TOKEN` and `MAINWORTHY_PROJECT` in the job | An admin makes the token. Whoever edits the pipeline sets the rest | [Report results](./report-results.md#give-a-pipeline-its-own-token) |
| Backups and moving machines | `mainworthy export` and `mainworthy import` | An instance admin | [Your data](./data.md) |

## Policy is the largest setting

The policy decides who answers each kind of question and what an agent's answer is worth. It changes how much your team trusts an edit, a failure explanation or an agent without changing any data. The three presets run from `loose` to `strict`. [Policy](./policy.md) compares them and shows how to switch.

A policy change is not a private setting. It is a proposal that an admin who is a person accepts, and both stay in the record.

## Projects

Each project keeps its own cases, queue, runs and policy. A new project starts with the preset you choose. The first project, `scratch`, exists so you can write a case before you configure anything.

A project key is lower-case letters, digits and hyphens, up to 40 characters, and starts with a letter or digit. You cannot rename or delete a project yet. The other commands pick a project with `--project` or `MAINWORTHY_PROJECT`, or use the only one when there is one.

## Cases, folders and tags

Folders nest. A tag is lower case, starts with a letter or digit, and can hold `-`, `_`, `.` and `/`. Moving a case or changing its tags is an edit like any other, so under `strict` it waits for a person.

A case lists the methods that may produce evidence for it. People are the default. Add agents so an agent's result can count in a run that asks for agents. An automated test does not depend on this list: its link to the case, or the case's ref in the test's name, is what lets its result fill a slot. A case keeps at least one method.

## The theme

Press "Theme" in the sidebar to switch between light and dark. Until you do, Mainworthy follows your system. The choice stays in this browser.

## What is fixed today

Some things look like settings and are not. Each of these is the same on every instance.

- The five kinds of question: a proposed edit, a test with no case, a failed result, a finding and closing a run. Each takes the answers [Decide in the queue](./decide.md) lists, on the keys it lists.
- The four verdicts, `passed`, `failed`, `blocked` and `pending`, and the exit codes 0 to 3 of `mainworthy gate`.
- The six capabilities (`read`, `record`, `produce`, `answer`, `plan`, `admin`) and the kinds of actor. You cannot define a role of your own.
- A pipeline holds `read` and `record` at most, whatever its grant says.
- Three named presets. A policy with different clauses is called `custom`, and no screen edits clauses.
- The shape of a case: a title, preconditions, steps with expected results, methods, an automation intent, tags, a folder and the requirements it covers. A case can carry free `fields` of text in its Markdown, but the web UI does not show or edit them, and there are no typed or required custom fields.
- Sign-in is by token. There are no passwords, accounts or single sign-on, and a token works until you revoke it.
- The database is one SQLite file.

These are not built yet: a flaky-test detector, a requirements coverage matrix, sign-off by a named role or by two people, attachments, a gate check posted to your code host, importers from other tools, and reports or dashboards.

## See also

- [Configuration](./configuration.md) for the server's variables.
- [Glossary](./glossary.md) for the words used here.

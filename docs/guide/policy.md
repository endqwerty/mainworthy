# Policy

Decide how strict a project is, read its policy, and switch it. A policy says who must answer each kind of question and what an agent's answer is worth.

![Settings with the policy preset, the compare table and the clause table](../ui/screenshots/settings-light.png)

## What a policy is

A policy is a table of clauses. Each clause covers one kind of question: a proposed edit, a test with no case, a failed result, a finding, or closing a run. For that kind it says who answers, whether they give a reason, and what an agent's answer is worth. Mainworthy reads the clauses of a kind from the top and uses the first one that matches.

[Diagram: who answers a question under a policy](../diagrams/policy-routing.html)

The `when` column holds the conditions a clause tests. `always` matches every question of its kind. The others describe the question: `author:agent` for an edit by an agent, `conflict` for an edit that clashes with a newer version, `policy` for a change to the policy itself, `scope:change` for a failure on a change, `hint:disputed` for two reports that disagree, and `verdict:passed` for a run that passed. `answer:reject` matches only once someone picks that answer.

"Who answers" is one of these.

- A rule. Nobody is asked. The policy gives its answer at once and records it as a decision. A person with the `answer` capability can still overrule it.
- A member. A person with the `answer` capability.
- An admin. A person with the `admin` capability.
- The author. The person who wrote the proposal, or an admin.

An agent's answer is one of three things. It counts as a decision, it is shown as advice and a person decides, or it is refused. The table also says whether a person who produced the evidence may answer, and whether the answer needs a reason.

A policy never decides a verdict. A failure that nobody has explained blocks every run that shows it, under all three presets. The policy decides who may explain it. The `blocks` column only says which runs list a question.

## Read the policy

In Settings, open Policy (<kbd>g</kbd> <kbd>,</kbd>). It shows the preset in force, a short summary, and "Compare the policies". An instance admin also sees the clause table and the numbers below it.

From the command line:

```
$ mainworthy policy show
policy: loose
kind     when                      who answers  agent's answer  blocks   rule's answer
adopt    conflict & answer:reject  author       counts          nothing
adopt    policy                    admin        refused         nothing
adopt    always                    rule         refused         nothing  {"is":"accept"}
map      always                    rule         refused         nothing  {"is":"track"}
failure  scope:change              member       advice          change
failure  always                    member       advice          release
signoff  verdict:passed            rule         refused         nothing  {"is":"approve"}
basis: exact-or-assumed; flaky hold: 14 days
```

The last line holds two numbers. The basis is which evidence a planned run accepts for a slot by default, and `strict` raises it to `exact`. The flaky hold is how many days a "Flaky" answer carries forward.

## The three presets

`loose` is the default. Edits take effect at once, a test needs no case, and a person answers failures and findings. A run that passed closes by itself.

`standard` holds an agent's edit for a person and turns a test with no case into a question. A person's own edit still takes effect at once. Two reports that disagree go to a person who did not produce either one.

`strict` asks a person for every edit, test with no case, failure, finding and passed run, and the person gives a reason. No agent answers any of them. Approval by a named role or by two people is not built yet, so `strict` is as far as the product goes today.

All three send a change to the policy to an admin, and send a conflicting edit back to its author. The presets differ most in what they ask of people, so this table, built from the presets themselves, shows who answers each question.

<!-- generated:policy-presets -->

| Preset | In short |
| --- | --- |
| `loose` | Edits to cases take effect at once and a test needs no case. A person is asked about failures and findings, and a run that passed closes by itself. |
| `standard` | An agent's edit waits for a person, and a test with no case is a question. A person's own edit still takes effect at once. |
| `strict` | A person, never an agent, answers every edit, test with no case, failure, finding and passed run, and gives a reason. A policy change and a conflicting edit are handled as under the other presets. Approval by a named role or by two people is not built yet. |

Who answers each question:

| Question | `loose` | `standard` | `strict` |
| --- | --- | --- | --- |
| A person's edit to a case | By rule: Accept | By rule: Accept | A person, with a reason |
| An agent's edit to a case | By rule: Accept | A person | A person, with a reason |
| A test with no case | By rule: Track without a case | A person or an agent | A person, with a reason |
| A failed result | A person; agents advise | A person; agents advise | A person who did not report it, with a reason |
| A result that two reports disagree on | A person; agents advise | A person who did not report it | A person who did not report it, with a reason |
| A finding | A person; agents advise. Duplicate: a person or an agent | A person; agents advise | A person, with a reason |
| Closing a run that passed | By rule: Approve | By rule: Approve | A person, with a reason |
| An edit that conflicts with a newer version | Its author if a person, or an admin. Reject: its author (person or agent), or an admin | Its author if a person, or an admin. Reject: its author (person or agent), or an admin | Its author if a person, or an admin. Reject: its author (person or agent), or an admin |
| A change to the policy | An admin, not an agent | An admin, not an agent | An admin, not an agent |
| How long a `flaky` answer carries forward | 14 days | 14 days | 14 days |
| What fills a slot of a planned run | Also a result assumed to be for the current version | Also a result assumed to be for the current version | Only a result that names the pinned version |

<!-- /generated -->

## Switch the policy

1. Open Settings, then Policy.
2. Choose a preset in "Preset".

The switch "Agent edits need a person" is a shortcut. It flips between `loose` and `standard`. It is hidden while the policy is `custom`.

From the command line:

```
$ mainworthy policy use standard
policy: standard; proposal P-1 and decision 1 are both recorded
```

You hold the right to switch when you have `produce`, to propose, and `admin` on the project, to accept. A switch is a proposal, and accepting it is a decision. Both stay in the record, and you can find them in Queue under "Settled". No agent can accept one, whatever its grant says.

If you cannot accept it yourself, the proposal stays open for an admin:

```
$ mainworthy policy use strict
policy proposal P-2: open Q-2 needs an admin
```

An admin finds it in Queue under "Proposals". Reading the clause table needs `admin` on every project, which is more than switching needs.

Data does not change when the policy does. Results, decisions and cases stay as they were. What changes is who may answer, and whether a reason is needed. That holds for the next question and for every question that is still open: an open question now waits for whoever the new policy names.

## Change single clauses

Settings has no control for one clause. To change one, send a policy edit to `mainworthy propose`. The edit carries the whole clause list, so start from what `mainworthy policy show --json` prints, change a clause, and send it back. This example, with the clauses cut to `[...]`, makes a reason mandatory for findings and shortens the flaky hold to 7 days:

```
$ mainworthy propose --json '{"edits":[{"op":"policy","preset":"standard","clauses":[...],"settings":{"basis":"exact-or-assumed","holds":{"flakyDays":7,"infraThisTargetOnly":true}}}]}'
{"proposal":"P-9","question":"Q-9","conflicts":[],"status":"open","needs":"an admin","cases":[]}
```

An admin accepts it like any policy change. Mainworthy refuses a policy in which some kind of question has no last clause that matches `always`:

```
invalid: every kind must end with a clause that always matches; missing for: finding
```

The flaky hold takes 1 to 365 days. `infraThisTargetOnly` is true when an "Infrastructure" answer covers only the build it was given for.

## What custom means

A policy is `custom` when its clauses are not exactly those of a preset. A preset's name can stay on the stored policy after you edit its clauses, so Mainworthy compares the clauses and not the name. Settings and `mainworthy policy show` then say `custom`, the preset summary and the compare table's marked column go away, and the switch between two presets is hidden. Choosing a preset in "Preset", or `mainworthy policy use`, replaces every clause with that preset's.

## Choose a preset for a new project

Choose the first policy when you create a project. In Settings, open Projects and pick "Initial policy" under "Create a project". It defaults to `loose`. You can switch later without migrating anything.

- Start with `loose` when one person or a small trusted team writes the cases, and you want the queue to hold only failures.
- Use `standard` when agents propose edits, or when you want every test without a case raised as a question.
- Use `strict` when each answer needs a person and a recorded reason, for example when someone else audits the queue.

A policy belongs to one project. A team can run a `loose` scratch project and a `strict` release project on one instance.

## See also

- [People, agents and pipelines](./access.md) for who holds `answer` and `admin`.
- [Let an agent in](./agents.md#what-agent-work-is-worth) for what an agent's work is worth under each preset.
- [Decide in the queue](./decide.md) for answering a question.

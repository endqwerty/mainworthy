# 0122: A CI failure belongs to the session that pushed it

- Date: 2026-10-20
- Status: accepted (the owner asked for it in the thread that built it, 2026-10-20)

## Problem

The owner: "Test failures from CI should be addressed by the session that started it. [...] I don't want my
Mainworthy queue to just fill up with manual actions I need to take. [...] The queue is not sacred."

Project `mainworthy` ran `standard`, where a failure is a question for a member and an agent's answer is advice.
Every failing test of a pull request was a question in the owner's queue, and the gate was `blocked` on it. The
job's log said "Q-844 needs an answer", and `AGENTS.md` told a session to fix the test "or leave the question to
the owner". On 2026-10-20 the queue held four such questions: one test failing the same way on three pull
requests, and one on `main`. None needed the owner. Each was waiting for a session to push a fix.

## Decision

**The policy answers every CI failure "needs a fix" by rule.** The project's failure clauses for a change and
for everything else are a rule that answers "Defect in the product". The clause for a dispute between two reports
still asks a person, because two reports that disagree have no default answer. Under the new clauses:

- The gate reads `failed` (needs a fix), not `blocked` (needs a decision), and no question opens.
- The answer carries to the pull request's later commits, so a fix in progress is not asked about again. It ends
  when a commit passes the test (decision 0102), and a later failure is a new one.
- A person can still overrule the rule. An agent and the pipeline cannot, so no session can excuse its own
  failure. The gate passes only on a commit that passes.

The questions open at the switch were answered by the rule as it was adopted.

**A session reads what failed from the instance.** `bun scripts/work.ts ci [<pull request> | <commit>]` reads the
gate and lists each failing test with its message and build, with a read-only token of the agent `sessions` kept
outside the repository. It exits as `mainworthy gate` does and can wait for a pending gate, so a session can wait
for its CI and act on the answer. The `gate` job's log ends with that command when the gate does not pass.

**The policy is set by a script.** `bun scripts/work.ts ci-policy`, with the owner token, proposes the clauses and
accepts them, and changes nothing when they are already in force. `ci` says to run it when it finds a person
asked. `test/work.test.ts` holds what the clauses do: a failure fails the gate and asks nobody, a passing retry
or a later passing commit passes it, and a question already open is answered by the rule.

## Turned down

- **Changing `loose` and `standard` for every project.** It may be the right default for a team whose changes
  are written by agents, but it is a product decision for every team, the demo and the guide, not this
  repository's process. A project's policy is where Mainworthy already keeps who answers what. Open question:
  should a preset answer a change's failure by rule?
- **Agents answering with a counted answer** (`agents: answer`). The session whose change failed would explain its
  own failure, and "infra" or "flaky" would pass the gate with nothing fixed.
- **Agents' advice, as before.** Advice is a question for a person all the same.
- **A new answer "needs a fix".** "Defect in the product" already says the gate fails until a build passes. A
  second answer that means the same would be one more to choose between.

## Not done

- A flaky test still fails the gate until a retry passes it. That is the cost of not asking, and `AGENTS.md` keeps
  a flaky test a defect to fix.
- The token for `ci` is on the Mac only. Another machine needs its own (`docs/deploy.md`).

# 0098: Inherited answers follow the current policy and their author

Date: 2026-10-18. Implements [issue #365](https://github.com/endqwerty/mainworthy/issues/365) and
[issue #366](https://github.com/endqwerty/mainworthy/issues/366). Clarifies decision 0042.

An automatic inherited answer stands on exact head and base results. A person's answer stands on the ordinary
cause and scope, with the holds of the answer they chose. The author determines which question shape receives
the decision. A manual replacement must not retain the rule's exact-result basis or omit flaky expiry.

Policy adoption queues the runs named by existing inherited questions for the normal reconciliation path.
Reconciliation checks whether the current clause still permits inheritance before carrying an unchanged basis.
Adoption alone therefore retires a disallowed inherited answer and asks one ordinary cause question. Waiting
for another report would leave the gate dependent on which unrelated test reported next.

A direct non-rule replacement uses the same withdrawal as an explicit undo, then answers the ordinary cause
question in the same savepoint. Withdrawal disables automatic inheritance for that commit and cause. The normal
answer path checks the cause's policy and supplies its existing effects and holds. If that answer cannot be
recorded, the savepoint restores the inherited answer. Advice does not withdraw the rule's decision.

The reply keeps the requested question in `q`, so batch replies still match their inputs. Its `effects.question`
names the ordinary question for subsequent replacements or withdrawals. The decision ID belongs to that question.
The web queue already withdraws settled answers before offering another answer. The iPhone sends `ifOpen`, so it
refuses direct replacements. Neither client needs a new contract. CLI, HTTP and MCP callers share the registry path.
Stored questions and decisions remain in archives without a schema change; no archive rebuilding logic changes.

Keeping a person's answer on the inherited question would require separate manual expiry, effect and retry
rules. We reuse the existing cause path instead. Model the Domain shaped the author-to-question handoff;
Laziness Protocol removed the need for another set of holds; Fix Root Causes placed the policy check before
the shortcut. Registry regressions and HTTP checks exercise the resulting gates and questions.

This fixes existing behavior and adds no demo scenario. The demo already uses standard to keep its failure
questions visible. Full-suite checks, test-timing refresh and independent verification belong to the integrating
coordinator before delivery.

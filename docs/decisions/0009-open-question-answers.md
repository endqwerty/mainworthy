# 0009: The owner's answers to the open questions, and what they change

- Date: 2026-10-11
- Status: accepted (the owner's answers); the consequences marked "decided here"
  are the agent's reading and are theirs to overrule

The owner answered all 28 questions in `docs/open-questions.md` when they asked for
the MVP. Their general rule: "we want flexibility, but that comes at a cost, so
for an MVP we can build basics and increase flexibility and more options as we
go." Every deferral below has a GitHub issue in the milestone `Backlog to 1.0`.

## Answers

| # | Question | Answer (the owner, 2026-10-11) | Consequence |
| --- | --- | --- | --- |
| 1 | Who uses it | Start with the owner; expandable to any number of users and teams. | The model has actors and grants from day one and no seat. The MVP signs in one owner and issues tokens; accounts, invitations, teams and SSO are deferred (#30). |
| 2 | Hosted instance | First self-hosted on their Unraid server through Coolify. If the product works, a paid tier they host on AWS or GCP should be viable. | Replaces the vision's non-goal "multi-tenant SaaS billing" with "not yet". Nothing may assume one organisation per deployment forever: every row hangs off a project, and a project off an organisation. Tenancy is deferred (#31). |
| 3 | Pain points in incumbents | To be written. | Still open (#46). |
| 4 | Jira or ADO on day one | No. Day one has no integration requirement. | Defects and requirements are pasted references. Tracker ports are deferred (#32). |
| 5 | Import at launch | No, later. | Importers are deferred (#33). Markdown and pasted lists come in; the full export goes out. |
| 6 | Language | Most used to TypeScript, familiar with Python, passing familiarity with Go; "if another language is decidedly better, we want to use the correct language rather than what I know". | Decided by the stack arena, decision 0010. |
| 7 | Name | `Mainworthy` stays as a placeholder; "it's not bad". Copyright, trademark and the .com domain need a check. Not critical for the MVP. | Deferred (#34). |
| 8 | Live collaboration | "Whatever is the best UX/DX we can implement." | Decision 0004 stands: no live co-editing of text; lists update when others change them. The MVP pushes change events over one channel and refetches. Presence hints are deferred (#35). |
| 9 | Offline | An offline allowance only if it can be an extremely good UX. | The MVP keeps unsent drafts across a reload or crash and nothing more. Queued offline edits are deferred until a design shows they can be excellent (#35). |
| 10 | Review default | Agreed: a new project is `loose`. Organisations must be able to limit agent edits, and "making human changes significantly more important is a good UX for that". | The `adopt` clause distinguishes the author's kind. One project setting, "agent edits need a person", switches the clause. An agent's change is always marked as such, and it can never overwrite a person's unsealed draft. Finer limits (scope, rate, protected content) are deferred (#36). |
| 11 | CI systems and frameworks | Ideally all. The MVP need not support any, but GitHub is useful because this project is on GitHub and can test itself. | JUnit XML first. The CLI reads the GitHub Actions environment. This repository's own workflow reports its tests to Mainworthy. Other CI environments and report formats are deferred (#37). |
| 12 | Flaky policy defaults | "Why not make it a user setting. Maybe on a per project basis." | The hold windows are numbers in the project policy, not constants. The detector and quarantine standing are deferred (#38); `flaky` is already an answer that carries forward. |
| 13 | Competitor trial accounts | None. Use public documentation. Tell the owner if something truly needs an account. | The hands-on audit becomes a desk audit (#39). |
| 14 | Local footprint | A container is fine, "especially since this will likely turn into a multi-container system". | A native single binary stops being a requirement. Decision 0002's hypothesis is withdrawn; see 0010. |
| 15 | Regulated depth | No. But track whether Mainworthy can stay legally compliant and what it would take. Do what is very low cost; plan what is significant; where compliance would make UX or DX poor, note it and document where the law is not met. | `docs/compliance.md` is the register: what each regime needs, what the model already gives, what is missing, the cost. Kept current with each release (#40). |
| 16 | Requirements source | A project can hold its own requirements, and can link external ones. "Prescribing a good way to manage requirements is going to be a must. Users are generally bad at requirements management." | A local `Requirement` row, optionally mirroring a tracker item, as decision 0008 proposed. The MVP stores requirements and `covers` links. The prescribed workflow and the traceability views are deferred and need a design of their own (#41). |
| 17 | Deployment events | Whatever works; "think about the CI tooling for this". | `mainworthy announce --deploy` from the deploy step, as proposed. Deferred with the release run (#42). |
| 18 | Teams compared | See "Practitioner evidence" below. | Confirms the loose-to-regulated spectrum, and makes "the cases are the requirements" the default reading for loose teams. |
| 19 | Agent clients | "Does it matter which agent clients are used first? We should be agnostic." | The agent surface is plain MCP over stdio and HTTP plus the same REST API. Token budgets are counted with one fixed tokenizer over what Mainworthy serves, not per client (#43). |
| 20 | Home screen | Set a home for now; later users will customise their home. | Suite is home in the MVP. A per-user home setting is deferred (#44). |
| 21 | Assumed basis | "Roughly yes." | As designed: a drop-in report is `assumed`, and the loose and standard presets accept it. |
| 22 | Agent evidence in gates | "I don't know, think about it for me." | Decided here; see below. |
| 23 | Sealed proposals | "I think so." Use Confluence's live editing as a hint to where the friction is. "The decision here is a UX decision." | Decided in the UI arena, decision 0011. |
| 24 | Who may excuse a failure on their own PR | "This will have to be customisable, as teams have different ideas." | It is a policy clause. The MVP ships the drafted defaults and lets `policy apply` change them; a policy editor is deferred (#45). |
| 25 | Hold windows | They would have wanted to choose the number: "it's just a number that should be a config, unless we have some specific UX that we're wanting to guide users towards". | The numbers live in the policy with the drafted defaults (flaky: 14 days or 20 clean runs; defect: 5 clean runs). |
| 26 | Will testers name the build | "Who knows, that depends on the team." | A planned run accepts a commit, a build label, or `self` (results typed into this run only). The MVP defaults to `self` and says in the run header that such a run proves nothing about a build. |
| 27 | Slice order | "Yes, sounds great." | The thin cross-producer slice is the MVP. |
| 28 | Principle order and floor F3 | Probably. "By ship I mean ship a 1.0 version. Any WIP can be not good enough so long as we have an idea for what we're working on and how it might be improved. Trying things out prior to 1.0 is valid. Just don't lose track of it. Make sure to file an issue." | F3 (measurably better than the incumbents) gates 1.0, not previews. A preview may miss it when an issue records the gap and the plan. Decision 0007's floor is amended accordingly. |

## Practitioner evidence (question 18)

The owner, 2026-10-11:

> Boeing enterprise used ADO and had strict forward and backward traceability
> between requirements and tests. The smallest agile teams used the tests as
> the requirements. Once a ticket was completed in a sprint, it's just a
> historical artifact. The real tracking is the test cases. At top-tier tech
> companies, that's what I find to hold true. We can have requirements, but
> the tests are what enforce things and devs change tests in conjunction with
> feature work.

What it settles:

- Both ends of the spectrum are real, so decision 0003 stands: one model,
  policy decides.
- In loose and top-tier teams **the case is the durable requirement** and a
  ticket is history once done. So a requirement row is optional everywhere, a
  case is complete without one, and coverage reports never shame a suite for
  having none.
- "Devs change tests in conjunction with feature work" makes the **change**
  the place where cases and code meet. The Change page shows which cases a
  change touched or should have touched (`impact`), next to its gate.
- Strict traceability is the regulated profile's need. It is built on the same
  `covers` links and deferred with the traceability views (#41).

One source with its own bias, as decision 0005 says.

## Decided here: agent evidence in gates (question 22)

The owner asked the agent to think it through. The rule that follows from their
other answers ("human changes significantly more important", agents limited
by organisation policy):

1. **An agent's result never fills a slot by default.** A planned run's
   default obligation admits `human` and `auto`. An agent's result counts only
   when the run or gate names `agent` in its methods **and** the case declares
   an agent method with a charter. This is the design's rule 4 of the
   acceptance rule, with the default set to off.
2. **An agent's results and findings are always recorded and always visible**
   on the case, the run and the change. They inform a person; they do not
   satisfy a gate unless asked to.
3. **An agent may advise on any question and settle almost none.** Under
   `loose` an agent's answer counts for `map` (linking a test to a case) and
   for marking a finding a `duplicate`. Everything else an agent answers is
   advice shown beside the question. Under `standard` and stricter it settles
   nothing unless a clause says so.
4. **A rule is not an agent.** A rule clause (for example "excuse a failure
   that already fails on the base") is the project's own recorded policy and
   may settle what its clause says.

Why: an agent that can both produce the evidence and accept it removes the
person the gate exists for. The cost is that an agent-heavy team sees more
advice than decisions until it opts in, which is one line in a run or a
policy clause.

## What this changes in earlier records

- **Vision, non-goals:** "multi-tenant SaaS billing" becomes "not in the MVP;
  a hosted tier must stay possible" (answer 2).
- **Decision 0002:** a native single binary is no longer the Local layer's
  hypothesis (answer 14). The rest stands.
- **Decision 0007:** floor item F3 applies to 1.0; a preview may miss it with
  a tracking issue (answer 28).
- **Research plan:** the hands-on incumbent audit becomes a desk audit of
  public documentation (answer 13).
- **Roadmap:** phase 0's research no longer blocks the first product code.
  The owner asked for the MVP now and accepted the slice (answer 27); the audit
  and the benchmark continue beside it.

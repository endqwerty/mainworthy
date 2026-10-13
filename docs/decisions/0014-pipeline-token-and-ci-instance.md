# 0014: A pipeline's token, and which Mainworthy this repository's CI reports to

- Date: 2026-10-12
- Status: proposed (built in the pull request that adds this file; the owner reviews)

The owner asked whether Mainworthy can test itself yet: its own CI reporting to the instance on their home server,
`https://casebook.owl-perch.ts.net`, a name that resolves only inside their tailnet. They expected that tokens with
roles had to come first. This record says what was missing, what was built and what was left.

## Problem

Tokens with roles already existed. An actor has a kind (`human`, `agent`, `ci`, `rule`) and a grant per project
that lists capabilities; a token names an actor. Three things were wrong for a token that lives in a CI system.

1. **The smallest pipeline token could rewrite the suite.** `report` needed `produce`, and so do `propose`,
   `claim` and `decide`. Under `loose` and `standard` a proposal from a `ci` actor is adopted by rule
   (`adopt-agent` holds agents, not pipelines). A token made with `--ci … --can read,produce`, the documented
   one, created and changed cases with no person involved, and read the whole project. Run on commit caa8527:
   `propose` by such a token returned `status: adopted` under both presets.
2. **An admin could not see or take away a grant.** `actor.list` showed the grants on every project and hid a
   grant on one. The only way to change a grant was a side effect: `token.create` for an actor that existed
   replaced its grant, so `mainworthy token new --human robin --can read` cut the owner down to reading until the
   next restart.
3. **CI could not reach the instance, and nothing said what happens when it cannot.** The workflow started a
   throwaway Mainworthy in a shell step when `MAINWORTHY_URL` was unset. With it set, a home server that is down
   would fail every pull request, and a pull request that changes `report` would talk to a server that does not
   know the change: nothing redeploys the instance by itself.

Constraints: one registry and one place that checks a capability (`execute` in `src/server/ops/registry.ts`); a
shipped migration is never edited; the web UI reads `can` from the session; the `gate` job is the required check
and landing a change should cost minutes.

## Usage

An operator, once, on the instance:

```
mainworthy --project mainworthy token new --ci github-actions    # may record on mainworthy, and read its gate
mainworthy actor list                                          # who may do what, on which project
mainworthy --project mainworthy actor grant github-actions --can read,record
mainworthy --project mainworthy actor ungrant github-actions     # its tokens then do nothing there
```

The pipeline is unchanged: `mainworthy report results.xml --job tests-1`, then `mainworthy gate`. With a pipeline's
token a blocked gate prints the verdict, the refs of the open questions and the address where a person answers
them; the queue itself is the project's to read.

In this repository's workflow the `gate` job joins the tailnet when the repository says how, and
`scripts/ci-gate.ts` asks `chooseInstance` which Mainworthy to use. The run's summary page says which one decided,
also when the gate passes.

## Shape

**One more capability, `record`.** It means: put results on the record and read the verdict. `report` needs it;
`gate` accepts `read` or `record`, the one operation with two. `produce` includes `record`
(`heldCapabilities` in `src/core/kinds.ts`), so every grant made before this keeps working and no migration is
needed.

**A pipeline is held to `read` and `record`, whatever its grant says.** The same function that adds what a
capability implies drops everything else for a `ci` actor. It is the one place a stored grant becomes authority,
so the rule holds for a grant written before this change, edited by hand or brought in by an archive. Writing a
wider grant for a pipeline is refused with the reason, so an operator hears about it. No policy preset can
matter to an actor that cannot call `propose`, `claim` or `decide`. `--ci` with no `--can` grants `record` alone.

**Who may call is settled before the operation checks its input.** `execute` used to check the input against
the operation's schema first, so a caller with no right to an operation was told what was wrong with its input.
Now it is told it may not call. (The HTTP surface still wants the body to be JSON before it asks the registry: a
body that is not JSON is `invalid` for everyone.) This also lets
one test ask every operation in the registry with a pipeline's token and expect `403` from all but two; an
operation added later is in that loop the day it is added. `test/architecture.test.ts` names the operations that
accept `record`, so one more is a decision here and not a copy of `report`.

**A grant has one writer.** `grant.set` replaces what an actor may do on a project and `grant.remove` takes it
away (`admin` actions; `mainworthy actor grant|ungrant`). `token.create` gives a new actor its first grant and
leaves an existing actor alone: naming the grant it already holds is accepted, anything else is refused and
names `grant.set`. Nobody changes their own grant, and nobody changes the owner's, which is written again on
every start. `actor.list` shows every grant with its project.

**The session names a project the caller holds any grant on**, not only one it may read. That is how the job
checks a pipeline's token before reporting. The web UI shows the projects the session may read, as before.

**`chooseInstance` (`scripts/ci-instance.ts`) decides once per run.** It reads and reports nothing.

| What it finds | What the job does |
| --- | --- |
| `MAINWORTHY_URL` is not set | starts its own Mainworthy; a notice |
| the instance does not answer `/healthz` in three tries | starts its own; a warning |
| the instance describes `report` or `gate` differently from this checkout (`/api/openapi.json`) | starts its own; a warning |
| the instance refuses the token (401) | fails, exit 4, nothing reported |
| the token may not record on `MAINWORTHY_PROJECT`, or none is named and it may record on several or none | fails, exit 4, nothing reported |
| none of these | reports to the instance |

With no `MAINWORTHY_PROJECT` the job takes the one project the token may record on and names it to the CLI, which
would otherwise count the projects the token may only read. The job's own Mainworthy is stopped and its data
removed on every way out, an error included.

A Mainworthy started for the job knows no earlier decision, so it blocks every failing test: it is never the
looser of the two for a failure. It is looser in one way: it has not seen an earlier attempt's results.

The secret is given to the one workflow step that reports. Only the `gate` job may ask GitHub for an identity
token, which is what admits it to the tailnet; no Tailscale secret is stored in the repository.

Interface: one capability name, one list-valued `needs`, two `admin` actions, one CLI command and one script
function. Behind them: what a capability implies, what a kind may hold, how a project's and an all-project grant
add up, and five probes with their outcomes.

## Synthesis decision

Two candidates were designed independently from one brief (GPT-6.1 Sol and Claude Sonnet 5.5). Claude Opus 5.5
compared them and wrote this record; no separate judge scored them.

**Base: the `record` capability** (Sonnet's candidate). It changes one enum and one function and adds no table,
no column and no second path through the registry.

Taken from the other candidate: the reader shortcut in `invokeAsync` must use the same check as `execute`, or a
pipeline's `gate` is refused on a server with reader threads; a credential that is wrong fails the job instead
of sending it elsewhere; the summary names the instance when the gate passes too; a narrow tailnet rule beside
the existing allow-all rule restricts nothing, so the set-up says to replace it.

Changed from the base: a pipeline may also hold `read` (a pipeline that picks tests with `impact` needs it); a
pipeline's grant may be on every project (one rule fewer; the set-up says to name one); the gate is readable for
any commit of the project, not only one the token reported (below); the CLI skips the queue when it may not read
it, in place of a second copy of the questions in the gate's reply.

Turned down, from the other candidate: a `role` column with a migration that revokes every pipeline token, a
closed branch in the registry that runs a second, narrower `report` and `gate`, replies cut down for a pipeline
(`PipelineReceipt | ReportReceipt` in every consumer), and `gate --batch`. It isolates more: a pipeline could
not name a planned run or a case in a report. It is three times the change and gives every reader of a reply two
shapes to tell apart.

## Tradeoffs accepted

- A pipeline's token reads the gate of any commit, change or run in its project: the verdict, the tally and
  question refs. We accept that in exchange for no ownership check on a read.
- A pipeline's token can report anything `report` accepts, a planned run's results included, and wrong results
  if the code it runs is dishonest. It could before. The gate job runs the pull request's code, so it could also
  skip the gate; the token limits the harm to wrong results in one project. What it cannot do any more is
  change or read the suite.
- A `ci` actor can no longer propose cases. A pipeline that should sync cases from a repository uses an `agent`
  actor, whose proposals `standard` holds for a person.
- The contract check compares inputs and required capabilities, not replies (#52): a pull request that changes
  the shape of a reply fails against the deployed instance until that instance is redeployed. Clearing the
  `MAINWORTHY_URL` variable for the length of that pull request is the way round it. Any difference in the
  description, a reworded summary included, sends the job to its own Mainworthy with a warning.
- The check passes on the job's own Mainworthy when the home server is down. We accept losing the carried
  decisions for that run in exchange for a required check that does not depend on a home server.

## Alternatives considered

- **A token that narrows its actor's grant.** A column on `tokens` and authority in two places; a pipeline
  token made without narrowing is as wide as before.
- **A policy clause that holds a pipeline's proposals for a person.** Fixes one operation under two presets and
  does nothing about reading, or about the next operation that needs `produce`.
- **Reaching the instance another way.** Tailscale Funnel would put the instance on the public internet, which
  `docs/deploy.md` rules out until accounts exist and sign-in is rate limited. A self-hosted runner on the home
  server runs every pull request's code on that server. Having the instance fetch reports from GitHub needs a
  GitHub App and is a product feature of its own (#89).
- **Failing the check when the instance cannot be reached.** Honest about which Mainworthy decided, and it makes
  every pull request wait for a home server.

## Not built here

- The Tailscale side, which needs the owner's admin console: the tag, the federated identity and the access rule.
  `docs/deploy.md` has the steps. Until then the job runs as before, on its own Mainworthy.
- Sign-in hardening before the instance leaves the tailnet (#88), the instance redeploying itself (#90), agents
  on tokens of their own (#91), and switching self-testing on (#92).

## Answer to the question

Yes, for the owner's own use on the tailnet, once this is merged and deployed and the three Tailscale steps are done.
Nothing else in the backlog stands between this repository and reporting to its own instance.

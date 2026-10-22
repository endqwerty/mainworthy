# The security audit before a merge

Every merge into `main` passes a Daybreak security audit first (the owner, 2026-10-21). It is the last step before
the merge: after the independent verdict and a green `gate`, on the revision that will land. The rule is this
repository's; other repositories have their own security posture and their own rules. Nothing runs it for you: it is
a judgment call that the owner reviews.

## Running it

`scripts/security-audit.ts` runs it. Run origin/main's copy, never the branch's, so a pull request cannot change the
audit that reads it:

```sh
git fetch -q origin main && git show origin/main:scripts/security-audit.ts | bun run - <number> [--context <file>]
```

Run from a file instead, the script refuses unless it is the same as origin/main's. A pull request that edits the
script, this page or the delivery rules is therefore audited by the copy already on `main`, and the brief says first
that the change edits the audit. The script prints the head and base it read and its scratch directory, which holds
`brief.md`, `findings.md` and `log.txt`; delete it with `bun scripts/work.ts scratch rm` once the round is recorded.
`--context` takes a file with the earlier rounds' issues and their answers.

- **Whose pull request.** It refuses, before Codex starts, a pull request that is not open, that someone other than
  the repository's owner opened, that comes from a fork, or that has a commit the owner did not write and commit or
  that GitHub does not verify as signed. Pull requests can be opened only by collaborators, and the owner is the only
  one (read 2026-10-21: `pull_request_creation_policy=collaborators_only`, collaborators `endqwerty admin`, all 380
  pull requests and 355 issues the owner's). To sign the commits of a branch that has unsigned ones, run
  `git rebase --exec 'git commit --amend --no-edit -S' <base>` where 1Password can sign, then push it.
- **Head and base.** It reads the base branch on origin as it is now (`main`, or the layer below in a stack) and
  refuses a head that is not on it, so the tree it audits is the tree a rebase merge lands.
- **The sandbox.** Daybreak Blue (`gpt-daybreak-blue-latest`) runs at effort `high` (the `reviewer` row of
  `homelab route models --profile deep`) through `codex exec --sandbox read-only`, from the export, with standard
  input closed. The sandbox stops its commands writing anywhere or reaching the network (checked 2026-10-21: `touch`
  answers "Operation not permitted", `curl` "Could not resolve host"). Do not run it as a T3 Code child task: a child
  inherits the thread's full access.
- **What it is asked.** The brief names the head, the base, the export and the diff, says to read nothing else, and
  lists what to look at: who a request is, the HTTP and browser boundary, the writers, SQL, CI, dependencies and what
  a public repository must not hold. The list is in the script, so the audit and this page cannot drift apart.
- **What it returns.** Each issue with its file and line, a concrete case that goes wrong, its severity and a fix, in
  `findings.md`. The sandbox cannot write files, so that is the run's last message, written by Codex. A run cut off
  keeps its session under `~/.codex/sessions`.
- **What stays open, accepted by the owner (2026-10-21).** The sandbox does not stop the auditor's commands reading
  files outside the export, and what they read reaches the model provider as context. Codex 0.163 denies reads only
  through managed requirements, not for one run, and an outer `sandbox-exec` stops Codex applying its own
  (`sandbox_apply: Operation not permitted`). Text that would ask the auditor to read a credential could reach a
  pull request only through the owner's own agents, for example copied from an issue comment or a web page. Read
  `findings.md` before you quote it on GitHub, and quote nothing it read outside the export. Running a dependency's
  code is a separate exposure: [#740](https://github.com/endqwerty/mainworthy/issues/740).

## Every issue is addressed

- Fix it, and the fix comes with a test. An issue that is not a defect gets an answer in the pull request with the
  evidence (the code path, a test, a probe).
- Then audit the new head, giving Daybreak its earlier issues and their answers. The pull request is ready to merge
  only when a round on the current head and base leaves no issue unaddressed.
- A new head or a new base needs another round: a rebase, a fix from review, or another pull request landing on
  `main` first. GitHub's rebase merge lands the head on `main` as it is then, which may not be the base the audit
  read.

## Where it sits in delivery

- **Review-first** (`AGENTS.md`, Delivery): run the audit after the verdict and a green `gate`, as the last step
  before you hand the pull request over, and record it in the description: the model and effort, the head and the
  base it read, each issue and what answered it. The owner then knows which revision on which `main` was audited.
- **When the owner says to merge** (`ship`, [landing-a-stack.md](landing-a-stack.md)): just before the merge, check
  that each head and base is still the audited pair; if one is not, audit it again first. In a stack, every layer is
  audited.
- **One merge at a time.** A merge that lands first moves `main` under the next one, and GitHub's rebase merge puts
  the next head on the new `main`. So land one pull request at a time, and only while nothing else lands on `main`.
  Just before each merge, read the head (`gh pr view <number> --json headRefOid`) and `main`
  (`git ls-remote origin refs/heads/main`), compare them with the pair the script printed, and pass the audited head
  to `gh pr merge --rebase --match-head-commit <head>`.
- **When Daybreak cannot run** (not in the catalog, the account not eligible, no allowance left): merge nothing, and
  say in the pull request that the audit is missing and why.

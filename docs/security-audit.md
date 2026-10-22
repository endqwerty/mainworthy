# The security audit before a merge

Every merge into `main` passes a Daybreak security audit first (the owner, 2026-10-21). It is the last step before
the merge: after the independent verdict and a green `gate`, on the revision that will land. The rule is this
repository's; other repositories have their own security posture and their own rules. Nothing runs it for you: it is
a judgment call that the owner reviews.

## Running it

- **Who.** Daybreak Blue, model `gpt-daybreak-blue-latest` on the `codex` provider, as a read-only child task
  (T3 Code's `delegate_task`; the model is in its live catalog). Effort `high`, the `reviewer` row of
  `homelab route models --profile deep`.
- **What it reads.** The pull request, the head commit it audits and that commit's base, in a `git archive <head>`
  export under `bun scripts/work.ts scratch new <name>`. The brief names a head only after a command printed it.
- **What it looks at.** The diff and what it reaches: `admit` and sessions, tokens and the hashes in `UNEXPORTED`,
  the `Witness` writers, SQL and migrations, input an operation takes, file paths, the CLI and MCP surfaces, CI
  workflows, dependencies, and anything the public repository must not hold. Word the brief as a check of how the
  code behaves, in the repository's terms.
- **What it returns.** Each issue with its file and line, a concrete case that goes wrong, and its severity, written
  to a file in the scratch directory as it is found, so a run cut off still leaves them.

## Every issue is addressed

- Fix it, and the fix comes with a test. An issue that is not a defect gets an answer in the pull request with the
  evidence (the code path, a test, a probe).
- Then audit the new head, giving Daybreak its earlier issues and their answers. The pull request is ready to merge
  only when a round on the current head leaves no issue unaddressed.
- A new head after the audit, a rebase included, needs another round.

## Where it sits in delivery

- **Review-first** (`AGENTS.md`, Delivery): run the audit after the verdict and a green `gate`, as the last step
  before you hand the pull request over, and record it in the description: the model and effort, the head it read,
  each issue and what answered it. The owner then merges an audited revision.
- **When the owner says to merge** (`ship`, [landing-a-stack.md](landing-a-stack.md)): just before the merge, check
  that each head is still the audited one; if one is not, audit it again first. In a stack, every layer is audited.
- **When Daybreak cannot run** (not in the catalog, the account not eligible, no allowance left): merge nothing, and
  say in the pull request that the audit is missing and why.

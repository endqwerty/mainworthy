# The security audit before a merge

Every merge into `main` passes a Daybreak security audit. Complete local checks and independent review before
opening a PR. The first audit runs on the reviewed draft because its runner requires an open PR. Resolve findings
before marking ready and starting full CI. The round that clears the merge runs on the revision that will land,
after the independent verdict and a green `gate`. This repository's audit rule is enforced by delivery review.

## Running it

`scripts/security-audit.ts` runs it. Run one exact origin/main commit's copy, written outside the checkout, never the
branch's, so a pull request cannot change the audit that reads it; and run bun from `/`: in the checkout, bun loads the
branch's `bunfig.toml` (its `preload`) and `.env` before the script's first line, with your full access. Copy this
from origin/main's page (`git show origin/main:docs/security-audit.md`), not from the branch's:

```sh
repo=$(git rev-parse --show-toplevel); runner=$(mktemp -d)
(
  set -e
  git -C "$repo" fetch -q origin main
  main_commit=$(git -C "$repo" rev-parse --verify 'origin/main^{commit}')
  git -C "$repo" show "${main_commit}:scripts/security-audit.ts" > "$runner/security-audit.ts"
  cd / && bun "$runner/security-audit.ts" <number> --repo "$repo" --source "$main_commit" [--context <file>]
); rc=$?; rm -rf "$runner"; (exit "$rc")
```

The block exits with the audit's status: nonzero when a step before it fails, when the script refuses, or when Codex
fails, so a missing audit never reads as a passing one. The script refuses unless `--source` is still origin/main's
tip and the file it runs is that commit's copy, outside the checkout and not read from standard input, and it prints
the commit it ran from; record that commit with the round.
It also refuses when bun runs inside the checkout, but by then a preload has run, so the `cd /` is what protects you.
Those checks catch a mistake or a race (`main` moving between the launcher and the script), not a hostile copy, which
would skip them: what protects the audit is that the launcher takes the copy from `main`. A pull request that edits
the script, this page or the delivery rules is therefore audited by the copy already on `main`, and the brief says
first that the change edits the audit. The script prints the head and base it read and its scratch directory, which
holds `brief.md`, `findings.md` and `log.txt`; delete it with `bun scripts/work.ts scratch rm` once the round is
recorded. `--context` takes a file with the earlier rounds' issues and their answers.

- **Whose pull request.** It refuses, before Codex starts, a pull request that is not open, that someone other than
  the repository's owner opened, that comes from a fork, or that has a commit the owner did not write and commit or
  that GitHub does not verify as signed. Pull requests can be opened only by collaborators, and the owner is the only
  one (read 2026-10-21: `pull_request_creation_policy=collaborators_only`, collaborators `endqwerty admin`, all 380
  pull requests and 355 issues the owner's). To sign the commits of a branch that has unsigned ones, run
  `git rebase --exec 'git commit --amend --no-edit -S' <base>` where 1Password can sign, then push it.
- **Head and base.** It reads the base branch on origin as it is now (`main`, or the layer below in a stack) and
  refuses a head that is not on it, so the tree it audits is the tree a rebase merge lands. The commits it checks
  must be exactly `git rev-list <base>..<head>`: it refuses when GitHub's list differs (the pull request changed while
  it was read) or reaches 250, the most GitHub lists.
- **The export.** It writes each blob of the head's tree as git stores it, not through `git archive`, which applies
  the head's own `.gitattributes` (`export-ignore`, `export-subst`) whatever it is told. It refuses a link, a
  submodule or a path that leaves the export, then hashes every exported file and refuses unless the files are the
  head's, one for one. The diff is made with no attributes, so `-diff` cannot hide a file's change.
- **The sandbox.** Daybreak Blue (`gpt-daybreak-blue-latest`) runs at effort `high` (the `reviewer` row of
  `homelab route models --profile deep`) through `codex exec --sandbox read-only`, from the scratch directory and not
  the export, with project instruction files off (`-c project_doc_max_bytes=0`) and standard input closed. Each run
  sets `CODEX_HOME` to a private temporary directory containing only a symlink to the existing home's `auth.json`,
  when present. It copies no credentials. Codex loads no `AGENTS.md`, `AGENTS.override.md` or config from the
  original Codex home. The temporary home is removed when Codex exits. The brief supplies the audit instructions;
  Codex's built-in and managed instructions still apply. The automatic skills instruction block is disabled for this run
  (`-c skills.include_instructions=false`), excluding the host's skill catalog from the model input too. Project docs alone did not exclude global instructions
  in Codex 0.164.0. The regression uses `codex debug prompt-input` to show a user-file marker in a control run and
  its absence with the audit invocation, while the brief remains present. Run in the export, Codex took the head's
  own `AGENTS.md` as its instructions (probed 2026-10-21), so a change could tell its auditor what to find;
  the brief also says the export's files are evidence, not instructions. The sandbox stops its
  commands writing anywhere or reaching the network (checked 2026-10-21: `touch` answers "Operation not permitted",
  `curl` "Could not resolve host"). Do not run it as a T3 Code child task: a child inherits the thread's full access.
- **What it is asked.** The brief names the head, the base, the export and the diff, says to read nothing else, and
  lists what to look at: who a request is, the HTTP and browser boundary, the writers, SQL, CI, dependencies and what
  a public repository must not hold. Each issue names what reaches it in the head, in any configuration the head's
  code accepts (an environment variable an operator sets without a commit counts; who may open a pull request is the
  trust model above, not a setting): a state none of them reaches, or one only a later commit could create, is not
  an issue, since that commit is audited in turn. The list and that
  rule are in the script, so the audit and this page cannot drift apart.
- **What it returns.** Each issue with its file and line, what reaches it, a concrete case that goes wrong, its
  severity and a fix, in `findings.md`. The sandbox cannot write files, so that is the run's last message, written by
  Codex. A run cut off keeps its partial output in `log.txt`. Sessions in the temporary Codex home are removed with
  that home.
- **What stays open, accepted by the owner (2026-10-21).** The sandbox does not stop the auditor's commands reading
  files outside the export, and what they read reaches the model provider as context. Codex 0.163 denies reads only
  through managed requirements, not for one run, and an outer `sandbox-exec` stops Codex applying its own
  (`sandbox_apply: Operation not permitted`). Text that would ask the auditor to read a credential could reach a
  pull request only through the owner's own agents, for example copied from an issue comment or a web page. Read
  `findings.md` before you quote it on GitHub, and quote nothing it read outside the export. Running a dependency's
  code is a separate exposure: [#740](https://github.com/endqwerty/mainworthy/issues/740).
- **Also accepted by the owner (2026-10-21): the instructions come from the branch.** The agent that runs the audit
  reads `AGENTS.md` and this page from the branch it audits, so a branch could rewrite them to run its own copy. No
  check inside the repository can stop that, since such a copy skips the checks. What answers it is the record: the
  script prints the commit its copy came from, and the description of the pull request names it with each round, so
  the owner can see that it is `main`'s at the time.

## Every issue is addressed

- Fix it, and the fix comes with a test. An issue that is not a defect gets an answer in the pull request with the
  evidence (the code path, a test, a probe). One that names nothing reaching it in the head is answered by saying
  what rules it out (the type, the owning module, a value no configuration can set), and needs no fix or test. Count every writer: an
  imported archive or data an older version stored reaches what the normal writers never write.
- Then audit the new head once the verifier has passed it, giving Daybreak its earlier issues and their answers. The
  pull request is ready to merge only when a round on the current head and base leaves no issue unaddressed.
- Two rounds with an issue still open: stop and rethink the approach before the next, as `verify` does with its
  findings (the owner, 2026-10-27: "limit reviewers to 2 rounds and if there are still issues, for the agent to pause
  and rethink before trying again").
- A new head or a new base needs another round: a rebase, a fix from review, or another pull request landing on
  `main` first. GitHub's rebase merge lands the head on `main` as it is then, which may not be the base the audit
  read.

## Where it sits in delivery

- **Review before the PR** (`AGENTS.md`, Delivery): batch a coherent change, run local checks and obtain its
  independent verdict first. Open a draft only once it is likely to ship. The PR-dependent audit runs there while
  heavy CI remains skipped. Resolve findings before marking ready. Run the final audit after a green `gate` on
  the reviewed head/base. Record each round's model, effort, head, base, trusted runner revision and findings in
  the standalone description.
- **When the owner says to merge** (`ship`, [landing-a-stack.md](landing-a-stack.md)): just before the merge, check
  that each head and base is still the audited pair; if one is not, audit it again first.
- **A stack may be audited as one** when every layer has already had its own audit, or when it has five layers or
  more (the owner, 2026-10-28: "Definitely make it a rule that if an audit has already been done the stack can be
  audited all together. Furthermore when large stacks are being worked on, 5 or more, then auditing all at once is
  reasonable"). Otherwise each layer is audited against the one below. To audit it as one, open a pull request from
  the top layer's branch to `main`, audit that pull request with every layer's earlier rounds and their answers as
  `--context`, and close it once the stack has landed. The stack lands only while its top head and `main` are the
  pair that round read; a layer or base that changes after it needs another round of the whole stack.
- **One merge at a time.** A merge that lands first moves `main` under the next one, and GitHub's rebase merge puts
  the next head on the new `main`. So land one pull request at a time, and only while nothing else lands on `main`.
  Just before each merge, read the head (`gh pr view <number> --json headRefOid`) and `main`
  (`git ls-remote origin refs/heads/main`), compare them with the pair the script printed, and pass the audited head
  to `gh pr merge --rebase --match-head-commit <head>`.
- **When Daybreak cannot run** (not in the catalog, the account not eligible, no allowance left): merge nothing, and
  say in the pull request that the audit is missing and why.

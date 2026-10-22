# The security audit before a merge

Every merge into `main` passes a Daybreak security audit first (the owner, 2026-10-21). It is the last step before
the merge: after the independent verdict and a green `gate`, on the revision that will land. The rule is this
repository's; other repositories have their own security posture and their own rules. Nothing runs it for you: it is
a judgment call that the owner reviews.

## Running it

Export the head and the diff, then run Daybreak Blue in Codex's read-only sandbox from the export:

```sh
dir=$(bun scripts/work.ts scratch new audit-<number> | tail -1); mkdir "$dir/tree"
git archive <head> | tar -x -C "$dir/tree"; git diff <base> <head> > "$dir/change.diff"
cd "$dir/tree" && codex exec -m gpt-daybreak-blue-latest -c model_reasoning_effort=high --sandbox read-only \
  --skip-git-repo-check -o "$dir/findings.md" "<the brief>"
```

- **Head and base.** The audit is of one head on one base: the commits the brief names, and the base the merge will
  land on (`origin/main` for an ordinary pull request, the layer below in a stack). Name a commit only after a command
  printed it.
- **The sandbox.** `--sandbox read-only` stops the auditor's commands from writing anywhere or reaching the network
  (checked 2026-10-21: `touch` answers "Operation not permitted", `curl` "Could not resolve host"). It does not stop
  them reading files outside the export. Effort `high` is the `reviewer` row of `homelab route models --profile deep`.
  Do not run it as a T3 Code child task: a child inherits the thread's full access.
- **What it reads.** The brief points it at `tree/` and `change.diff`, and says to read nothing else.
- **What it looks at.** The diff and what it reaches:
  - who a request is: `admit`, sessions and tokens in `src/server/identity/`, and the secret hashes `UNEXPORTED`
    keeps out of an export (`src/server/transfer/`);
  - the HTTP and browser boundary: `src/surfaces/http.ts` (`sameOrigin`, the cookie attributes),
    `src/surfaces/signin.ts` (sign-in, passkey, OIDC and password routes, which are not operations, and their body
    limit),
    `src/surfaces/headers.ts` and `with-headers.ts` (the content security policy), and what `src/web` renders;
  - the `Witness` writers, SQL and migrations, and the input an operation takes;
  - file paths, the CLI and MCP surfaces, `.github/workflows/`, dependencies, and anything the public repository must
    not hold.

  Word the brief as a check of how the code behaves, in the repository's terms.
- **What it returns.** Each issue with its file and line, a concrete case that goes wrong, its severity and a fix, in
  `findings.md`. The sandbox cannot write files, so that is the run's last message, written by `-o`. A run cut off
  keeps its session under `~/.codex/sessions`.
- **Before anything is published.** Read `findings.md` before you quote it on GitHub. The auditor can read files
  outside the export, so check that it quotes nothing from them.

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
- **When Daybreak cannot run** (not in the catalog, the account not eligible, no allowance left): merge nothing, and
  say in the pull request that the audit is missing and why.

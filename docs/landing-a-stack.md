# Landing a stack

## Use one combined check for draft review layers

Batch small related changes as commits. Use draft layer PRs only for chunks that benefit from separate review,
not for every small change. Open each layer only after its local checks and review. Open the combined draft PR
from the tip branch to `main` after the whole change passes local checks and independent review. Complete its PR-dependent audit, then mark it ready once. Draft PRs run the description
check only. The ready combined PR runs normal CI against GitHub's merge of the full stack into `main`.
Pushing several local commits together produces one PR synchronization event, rather than one per commit.

The combined PR is the merge unit. Link its draft review layers in its description. Review each layer, then
verify the complete combined change at its exact current tip and `main` base. Follow the existing
[audit threshold](security-audit.md#where-it-sits-in-delivery): a single combined audit requires earlier audits of
every layer, or at least five layers. Otherwise audit each layer against its base. A changed tip or base
invalidates that evidence. Refresh the merge tree and required checks before landing it.

Merge the combined PR by rebase only with the owner's authorization. Confirm `main` contains every layer's
changes before closing the draft review PRs with a link to the merged combined PR. Do not use `gh stack merge`
for this mode: draft review layers are not independent merge units. To land a partial stack instead, open a
ready combined PR for that prefix and obtain its own checks, review and audit.

Skipped draft jobs prove nothing about the code. A lower layer that becomes an independent merge unit must be
marked ready and pass its own checks. Keep `ready_for_review` in the workflow triggers so that transition runs CI.
Main pushes still run CI and publish a tested image. This reduces duplicate checks across review layers; it does
not limit how many times a ready combined PR can run after further pushes.

## Land native stacks with checks on every layer

For an agent, when the owner has said in the current thread to merge a stack or its lower layers. Without those
words nothing merges: `build`, `babysit` and `autopilot-stack` open the stack, link it to the thread and stop.

A stack is a chain of pull requests: each one's base is the branch of the one below, and the lowest one's base is
`main`. After a layer lands by rebase its commits have new ids on `main`, so a layer landed alone leaves the rest
to be rebased onto the result and pushed, and a changed revision or base needs its checks and a short round of
review again. `gh stack merge` lands the layers together instead:

```
gh stack merge <the highest pull request the owner's word covers> --rebase --yes
```

It merges that pull request and every layer below it into the stack's base, or none of them. You look at every
layer before the command and at every result after it. That replaces two things in `ship`: landing one request at
a time, and looking at the next request between landings. Its other gates hold.

## Before the command

- The owner's word covers every layer the command merges. It merges all the layers below the one you name, so
  merge nothing if one of them is a layer the owner did not name.
- The number means the pull request. The command first tries its argument as the number of a stack and merges the
  whole of a stack that has it, so `gh api 'repos/{owner}/{repo}/stacks/<number>'` must answer 404. In the answer
  of `gh api 'repos/{owner}/{repo}/stacks?pull_request=<number>'` the base is `main` and the members are the layers
  you expect, in order. It prints `[]` for a chain that only its base branches hold together; `gh stack link
  <lowest> ... <highest>` (pull request numbers) makes a stack of it, changes a base that does not fit the order
  you gave, and only warns when it could not. Read the members and the bases afterwards; a layer whose base changed
  needs its checks and its verdict again.
- Each layer has its own passing independent verdict and a green `gate` on the head and the base it has now. The
  command sends no revision: what the branches hold when it runs is what lands. Just before you run it, compare
  every head and base with the ones that were verified, and run it only while nothing else pushes to those
  branches. The extension checks that a layer is open and not a draft; `main` has neither branch protection nor a
  ruleset requiring `gate`, so only you stop a layer whose check failed. When `gate` is a required check on
  `main`, GitHub stops it and this sentence goes.
- Each layer's head and base are the pair the Daybreak audit read, or, for a stack audited as one, the top layer's
  head and `main` are the pair its round read through a pull request from the top branch to `main`
  ([security-audit.md](security-audit.md) says when a stack may be). No issue is left unaddressed. A changed layer or
  base is audited again before the command.
- Pass `--rebase`. Without it the command picks the method: the one the account used last or the repository's
  default. The repository allows rebase only, but pass it anyway. A merge queue on `main` would ignore the flag and
  could land the layers apart; there is none, and with one, do not use this command.

## After the command

- Check that every layer says merged and that `main` holds its commits. The `/health` check is made once, for the
  commit `main` ends on.
- A command that fails can leave the merge running: it asks for the status up to 600 times, a second apart, and
  gives up at the first request that fails. Read the state of every layer first. Land nothing one at a time until
  you know that no layer merged and that no merge is still running.

`gh stack` is an extension of `gh` (`gh extension install github/gh-stack`; 0.2.1 has `merge`). It merges only
pull requests that GitHub holds as a stack. This page comes from the extension's code and README, not from a
landing: when the command does something the page does not say, correct the page.

# Put the recommendation beside the source evidence

Checkout `91ce928764460c67e4e840800af3b59eefb6aa68`. Repository paths below refer to that revision. Evidence paths begin with `out/` under this investigation. This is a design review, not a runtime verification.

## The alternative and its case

Mainworthy should supply shared facts and record attributed recommendations. A repository-side assessor should produce automated-test verdicts. That assessor may be a deterministic script, an outside agent, or a person following a documented method. Mainworthy calls no AI service. Start with a documented workflow and evidence format, rather than a new report screen or a server evaluator.

The user still receives a suggested action, supporting evidence, contrary evidence and missing evidence. The recommendation belongs to its named author and source revision. It reaches Mainworthy through an extended review finding. A person accepts, rejects or defers it in the existing queue. Automated edits land through repository review. Manual case changes use the existing proposal and decision path. Mainworthy already separates observations from interpretations and requires decisions for changes to standing (`docs/guide/concepts.md:9-15,49-63`).

The evidence format would name the subject, action, evaluator identity and version, source commit or case hash, observation window, retained replacements, assertion comparison, probe commands and results, limitations and artifact references. Deletion requires an ended obligation or a reviewed replacement. Moving down requires a demonstrated cheaper check and an account of remaining browser obligations. The same format covers manual cases using exact case versions and reviewed expected results. A manual-only team can author findings without a source repository or an agent.

Keep aggregation in Mainworthy. Expose a paginated per-subject facts read through the registry, composing domains through their functions. An external repository utility reads that operation and local artifacts. Do not add a special Mainworthy CLI command outside the registry (`docs/architecture.md:54-87`). Extending reads is necessary: `get T-n` currently truncates result history (`src/server/ops/reads.ts:632-668`). Recommendations then appear in existing finding evidence, with explicit authorship, rather than as Mainworthy's computed judgment.

This locates the reasoning where its inputs exist. Test metadata records identity, name, file and case link, without assertions or layer (`src/server/kernel/schema.sql:772-787`). The product inventory also finds no coverage, mutation or source-edit history (`out/product/inventory.md:18,44,58`). Local analysis can inspect assertions and run failure probes without turning Mainworthy into test execution infrastructure.

## What this avoids

The panel's shared evaluator has two possible outcomes. Strict gates make it return insufficient evidence until reviewers supply the deciding analysis. Looser gates infer actions from proxies. Neither explains why the server should own the action computation.

A concrete counterexample is `accessibility.test.ts`. Its scorecard reports operation coverage below the browser layer (`out/synth/scorecard.csv`, row retained in `contrarian-raw.json`). The actual test presses Tab and inspects clipping and visible focus (`test/e2e/accessibility.test.ts:51-93`). Operation overlap cannot prove those assertions redundant. The supplied methods explicitly distinguish coverage equivalence from fault detection (`out/research/methods.md:54-62`).

A second problem is unjustified certainty from thresholds. The Opus panel turns a research feature window into a universal history floor. The cited evidence describes historical features, not a validated retirement threshold (`out/research/methods.md:22-30`). Even a long green history cannot establish an assertion replacement. Conversely, a demonstrated dead assertion need not wait for history before review.

There is also a lifecycle trap. The existing finding basis is the case hash or the hash of its location string. The material excludes the recommendation evidence and source patch (`src/server/ops/writes.ts:515-537`). Merely adding an automated-test subject does not make accepted or rejected recommendations valid across source changes. Both designs need explicit material evidence and replacement dependencies. The external assessment makes those requirements visible from the beginning.

## Where this alternative fails

It adds setup and may produce inconsistent recommendations between teams. Deterministic server rules are easier to discover and compare. A report page helps a QA lead who does not use agents or inspect repository artifacts. Manual-case similarity can run entirely on existing product data (`out/research/methods.md:83-106`). Moving that computation outside is less compelling.

External tools can also produce weak claims. Provenance makes a claim inspectable, not correct. Mainworthy must validate subjects and preserve evidence snapshots, while reviewers assess meaning. Artifact disappearance and sensitive source excerpts require care. This review establishes no adoption, usability or cost advantage for the workflow.

## Verdict

Change the panel's implementation sequence and ownership. Keep shared facts, typed findings, evidence snapshots and human decisions. Initially remove server-computed action labels and defer the new report screen. Ship the recommendation workflow beside repository analysis, covering manual cases through the same finding format. Later promote individually validated rules into Mainworthy when their deciding inputs are available there. The Sol panel already approaches this staging; make it explicit rather than building a general evaluator around mostly missing evidence.

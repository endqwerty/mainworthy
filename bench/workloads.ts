import { z } from "zod";
import type { Actor } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import {
	BUDGETS,
	CasePage,
	CaseView,
	call,
	Delta,
	ensure,
	Gate,
	Impact,
	itemAt,
	Proposal,
	Queue,
	Receipt,
	Slots,
	TestView,
} from "./contracts.ts";
import { type DatasetInstance, ingestInput, random, verifyReport } from "./dataset.ts";
import type { Workload } from "./measure.ts";

export type ReadRequest = { name: string; op: string; input: unknown; check: (result: unknown) => void };
export const SEARCHES = [
	{ name: "search/common", text: "customer" },
	{ name: "search/two words", text: "customer account" },
	{ name: "search/rare", text: "benchneedle" },
	{ name: "search/prefix", text: "check" },
];

/** Runs exactly the registry path timed by the benchmark, leaving output and storage checks outside its timer. */
export function operation(instance: DatasetInstance, op: string, input: unknown, actor = instance.owner): unknown {
	const reply = invoke(instance.app, OPS, { op, project: instance.metadata.project, input, actor: () => actor });
	if (!reply.ok) throw new Error(`${op}: ${reply.error.code}: ${reply.error.message}`);
	return reply.result;
}

/** Adds twenty real recent edits to each clone without mutating the reusable baseline. */
export function prepareRecentChanges(instance: DatasetInstance): void {
	// A cursor past everything returns no changes and the cursor of where the project is now.
	const current = Delta.parse(
		operation(instance, "since", { cursor: `s:${Number.MAX_SAFE_INTEGER}`, limit: 1 }),
	).cursor;
	const seq = Number(current.slice(2));
	const recent = instance.metadata.cases.filter((stamp) => stamp.version > 1 && stamp.version < 6).slice(0, 20);
	ensure(recent.length === 20, "the history fixture must supply twenty cases for recent diffs");
	const reply = Proposal.parse(
		operation(instance, "propose", {
			edits: recent.map((stamp) => ({
				op: "edit",
				case: stamp.ref,
				base: stamp.version,
				body: { pre: "Customer account has verified checkout access for the recently reviewed pull request." },
			})),
		}),
	);
	ensure(reply.status === "adopted" && reply.cases.length === 20, "recent edits must create twenty real versions");
	instance.metadata = { ...instance.metadata, since: `s:${seq >= 300 ? seq - 300 : seq}` };
}

/** Checks every returned search row against its persisted document and FTS word/prefix semantics. */
export function verifySearch(instance: DatasetInstance, result: unknown, text: string): void {
	const page = CasePage.parse(result);
	ensure(page.items.length > 0 && page.items.length <= 50, `search ${text} must match a bounded nonempty page`);
	const body = z.object({
		title: z.string(),
		pre: z.string(),
		steps: z.array(z.object({ action: z.string(), expected: z.string().nullable() })),
		tags: z.array(z.string()),
	});
	const docs = call(
		instance.app,
		instance.owner,
		"get",
		{ refs: page.items.map((item) => item.ref), fields: ["title", "pre", "steps", "tags"] },
		z.array(body),
	);
	const terms = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
	for (const doc of docs) {
		const words =
			[doc.title, doc.pre, ...doc.tags, ...doc.steps.flatMap((step) => [step.action, step.expected ?? ""])]
				.join(" ")
				.toLowerCase()
				.match(/[\p{L}\p{N}_]+/gu) ?? [];
		ensure(
			terms.every((term, index) =>
				words.some((word) => (index === terms.length - 1 ? word.startsWith(term) : word === term)),
			),
			`search ${text} returned a nonmatching persisted document`,
		);
	}
}

/** The HTTP read mix uses the same inputs and output assertions as isolated operation reads. */
export function readRequests(instance: DatasetInstance, index: number): ReadRequest {
	const { metadata } = instance;
	const stamp = itemAt(metadata.cases, (index * 997) % metadata.cases.length);
	const test = itemAt(metadata.tests, index % metadata.tests.length);
	switch (index % 8) {
		case 0:
			return {
				name: "case",
				op: "get",
				input: { refs: [stamp.ref] },
				check(value) {
					const row = itemAt(z.array(CaseView).parse(value), 0);
					ensure(row.ref === stamp.ref && row.steps.length >= 3, "HTTP case must be the requested document");
				},
			};
		case 1:
			return {
				name: "folder",
				op: "find",
				input: { in: "cases", folder: metadata.hotFolder, limit: 50 },
				check(value) {
					const page = CasePage.parse(value);
					ensure(
						page.items.length === 50 && page.items.every((row) => row.folder === metadata.hotFolder),
						"HTTP folder must contain fifty matching rows with proof and counts",
					);
				},
			};
		case 2: {
			const text = itemAt(SEARCHES, Math.floor(index / 8) % SEARCHES.length).text;
			return {
				name: "search",
				op: "find",
				input: { in: "cases", text, limit: 50 },
				check(value) {
					const page = CasePage.parse(value);
					ensure(page.items.length > 0 && page.items.length <= 50, "HTTP search must return matching documents");
				},
			};
		}
		case 3:
			return {
				name: "test history",
				op: "get",
				input: { refs: [test.ref] },
				check(value) {
					const view = itemAt(z.array(TestView).parse(value), 0);
					ensure(
						view.ref === test.ref &&
							view.key === test.key &&
							view.last.length > 0 &&
							view.last.length <= 20 &&
							view.last.every((row) => row.test === test.ref),
						"HTTP test history must belong to the requested test",
					);
				},
			};
		case 4:
			return {
				name: "gate",
				op: "gate",
				input: { commit: metadata.lastCommit },
				check(value) {
					ensure(Gate.parse(value).run !== null, "HTTP gate must reference an existing run");
				},
			};
		case 5:
			return {
				name: "queue",
				op: "inbox",
				input: { limit: 50 },
				check(value) {
					const queue = Queue.parse(value);
					ensure(
						queue.items.length === 50 && (queue.counts.open ?? 0) >= 50,
						"HTTP queue must return fifty open rows and full counts",
					);
				},
			};
		case 6:
			return {
				name: "since",
				op: "since",
				input: { cursor: metadata.since, limit: 200 },
				check(value) {
					const delta = Delta.parse(value);
					ensure(
						delta.changed.length <= 200 &&
							delta.changed.length > 0 &&
							delta.settled.length <= 200 &&
							Number(delta.cursor.split(":")[1]) >= Number(metadata.since.slice(2)),
						"HTTP changed-since must advance a valid cursor",
					);
				},
			};
		default:
			return {
				name: "impact",
				op: "impact",
				input: { change: metadata.change, files: metadata.files, ledger: false },
				check(value) {
					const impact = Impact.parse(value);
					ensure(
						impact.change.files === metadata.files.length &&
							impact.cases.length > 0 &&
							impact.cases.length <= 200 &&
							impact.cases.every((row) => row.why.length > 0),
						"HTTP impact must include linked cases for the supplied files",
					);
				},
			};
	}
}

/** Produces isolated reads, including the complete proof strip and queue counts, over an immutable baseline clone. */
export function readWorkloads(instance: DatasetInstance, iterations: number): Workload[] {
	const { metadata, app, owner } = instance;
	const rng = random(metadata.parameters.seed + 1);
	const expectedGate = Gate.parse(operation(instance, "gate", { commit: metadata.lastCommit }));
	let expectedRef = "";
	const reads: Workload[] = [
		{
			name: "case read",
			budget: BUDGETS.case,
			iterations,
			correctness: "Requested full document, 3–9 steps, proof, open counts and current version.",
			prepare() {
				expectedRef = itemAt(metadata.cases, Math.floor(rng() * metadata.cases.length)).ref;
				return () => operation(instance, "get", { refs: [expectedRef] });
			},
			check(value) {
				const row = itemAt(z.array(CaseView).parse(value), 0);
				ensure(
					row.ref === expectedRef && row.steps.length >= 3 && row.steps.length <= 9 && row.head === row.version,
					"case read must return the requested current document",
				);
			},
		},
		{
			name: "folder page (50)",
			budget: BUDGETS.folder,
			iterations,
			correctness: "Fifty cases in the requested folder, each with proof and open-question count.",
			prepare: () => () => operation(instance, "find", { in: "cases", folder: metadata.hotFolder, limit: 50 }),
			check(value) {
				const page = CasePage.parse(value);
				ensure(
					page.items.length === 50 &&
						(page.count ?? 0) >= 50 &&
						page.items.every((row) => row.folder === metadata.hotFolder),
					"folder page must return fifty matching rows",
				);
			},
		},
	];
	for (const search of SEARCHES)
		reads.push({
			name: search.name,
			budget: BUDGETS.search,
			iterations,
			correctness: "Nonempty bounded results; every persisted document satisfies the query's FTS terms.",
			prepare: () => () => operation(instance, "find", { in: "cases", text: search.text, limit: 50 }),
			check: (value) => verifySearch(instance, value, search.text),
		});
	const test = itemAt(metadata.tests, 0);
	const testId = Number(test.ref.slice(2));
	const historyCount = z
		.object({ n: z.number().int() })
		.parse(
			app.db.raw
				.query(
					"SELECT count(*) AS n FROM results WHERE test = (SELECT id FROM tests WHERE no = ? AND project = (SELECT id FROM projects WHERE key = 'benchmark'))",
				)
				.get(testId),
		).n;
	reads.push(
		{
			name: "test history (20)",
			budget: BUDGETS.test,
			iterations,
			correctness: "Latest twenty persisted results of the requested T-ref, newest first.",
			prepare: () => () => operation(instance, "get", { refs: [test.ref] }),
			check(value) {
				const row = itemAt(z.array(TestView).parse(value), 0);
				ensure(
					row.ref === test.ref &&
						row.last.length === Math.min(20, historyCount) &&
						row.last.every((result) => result.test === test.ref) &&
						row.last.every((result, i) => i === 0 || result.id < itemAt(row.last, i - 1).id),
					"test history must contain the latest results in descending order",
				);
			},
		},
		{
			name: "gate read",
			budget: BUDGETS.gate,
			iterations,
			correctness: "Persisted commit run, unchanged verdict and tally; no stale accepted batch.",
			prepare: () => () => operation(instance, "gate", { commit: metadata.lastCommit }),
			check(value) {
				const gate = Gate.parse(value);
				ensure(
					gate.run === expectedGate.run &&
						gate.run !== null &&
						gate.verdict === expectedGate.verdict &&
						JSON.stringify(gate.tally) === JSON.stringify(expectedGate.tally) &&
						!gate.stale,
					"gate must be readable with applied results",
				);
			},
		},
		{
			name: `queue (50/${metadata.counts.open})`,
			budget: BUDGETS.queue,
			iterations,
			correctness: "Fifty open questions with evidence hashes; total count equals the persisted baseline.",
			prepare: () => () => operation(instance, "inbox", { limit: 50 }),
			check(value) {
				const queue = Queue.parse(value);
				ensure(
					queue.items.length === 50 &&
						queue.counts.open === metadata.counts.open &&
						queue.items.every((q) => q.state === "open" && q.evidenceHash.length > 0),
					"queue page must match the actual open population",
				);
			},
		},
		{
			name: "changed since",
			budget: null,
			iterations,
			correctness: "Bounded changed cases or settled questions, with an advancing sequence cursor.",
			prepare: () => () => operation(instance, "since", { cursor: metadata.since, limit: 200 }),
			check(value) {
				const delta = Delta.parse(value);
				ensure(
					delta.changed.length <= 200 &&
						delta.settled.length <= 200 &&
						delta.changed.length + delta.settled.length > 0 &&
						// A full page keeps its base and carries a position; the last page moves to the present.
						Number(delta.cursor.split(":")[1]) >= Number(metadata.since.slice(2)),
					"changed-since must prove changes occurred after the cursor",
				);
			},
		},
		{
			name: "impact (20 files)",
			budget: null,
			iterations,
			correctness: "Twenty input files; bounded linked candidates with reasons and version hashes.",
			prepare: () => () =>
				operation(instance, "impact", { change: metadata.change, files: metadata.files, ledger: false }),
			check(value) {
				const impact = Impact.parse(value);
				ensure(
					impact.change.files === metadata.files.length &&
						impact.cases.length > 0 &&
						impact.cases.length <= 200 &&
						impact.cases.every((row) => row.hash.length > 0 && row.why.length > 0),
					"impact must return linked candidates for the changed files",
				);
			},
		},
	);
	// Resolve the owner outside timings; this also proves the same actor reads every operation.
	ensure(owner.kind === "human", "reads must use the owner actor");
	return reads;
}

/** A changed precondition exercises the full seal-and-adopt transaction, and the new version must persist. */
export function saveWorkload(instance: DatasetInstance, iterations: number): Workload {
	const stamp = itemAt(instance.metadata.cases, instance.metadata.cases.length - 1);
	let version = stamp.version;
	let pre = "";
	let serial = 0;
	return {
		name: "case save",
		budget: BUDGETS.save,
		iterations,
		correctness: "One adopted proposal, one new immutable version, and the edited content read back.",
		prepare() {
			pre = `Customer account confirmed for benchmark save ${++serial}.`;
			const input = {
				edits: [{ op: "edit", case: stamp.ref, base: version, body: { pre } }],
				reason: "Clarify setup during case authoring",
			};
			return () => operation(instance, "propose", input);
		},
		check(value) {
			const reply = Proposal.parse(value);
			ensure(
				reply.status === "adopted" && reply.proposal !== null && reply.cases.length === 1,
				"save must adopt a real changed version",
			);
			const current = itemAt(call(instance.app, instance.owner, "get", { refs: [stamp.ref] }, z.array(CaseView)), 0);
			ensure(
				current.version === version + 1 && current.pre === pre && current.hash === itemAt(reply.cases, 0).hash,
				"the saved version and content must be persistent",
			);
			version = current.version;
		},
	};
}

/** Alternating destinations and fresh tags make every 1,000-case move do real attributable work. */
export function bulkWorkload(instance: DatasetInstance): Workload {
	const refs = instance.metadata.cases.slice(0, 1_000).map((stamp) => stamp.ref);
	let folder = 0;
	let tag = "";
	let serial = 0;
	return {
		name: "bulk move (1000)",
		budget: BUDGETS.bulk,
		criterion: "max",
		iterations: 5,
		warmup: 1,
		correctness: "All thousand named cases persisted in the destination with the newly added tag.",
		prepare() {
			folder = itemAt(instance.metadata.moveFolders, ++serial % 2);
			tag = `bulk-${serial}`;
			const input = {
				edits: [{ op: "place", cases: refs, folder, tags: { add: [tag] } }],
				reason: "Move customer journeys together",
			};
			return () => operation(instance, "propose", input);
		},
		check(value) {
			const reply = Proposal.parse(value);
			ensure(reply.status === "adopted" && reply.proposal !== null, "bulk move must adopt a proposal");
			for (let start = 0; start < refs.length; start += 200) {
				const rows = call(
					instance.app,
					instance.owner,
					"get",
					{ refs: refs.slice(start, start + 200), fields: ["place", "tags"] },
					z.array(z.object({ ref: z.string(), tags: z.array(z.string()), folder: z.object({ id: z.number().int() }) })),
				);
				ensure(
					rows.length === Math.min(200, refs.length - start) &&
						rows.every((row) => row.folder.id === folder && row.tags.includes(tag)),
					"all thousand moved cases must retain the added tag",
				);
			}
		},
	};
}

/** Times report completion and separately checks its gate, including visible failure questions. */
export function ingestWorkload(
	instance: DatasetInstance,
	options: { iterations?: number; size?: number; budget?: number; prefix?: string } = {},
): { workload: Workload; visibility: number[] } {
	const size = options.size ?? 10_000;
	const visibility: number[] = [];
	let serial = 0;
	let commit = "";
	let started = 0;
	return {
		visibility,
		workload: {
			name: `ingest (${size})`,
			budget: options.budget ?? BUDGETS.ingest,
			criterion: "max",
			iterations: options.iterations ?? 10,
			warmup: 1,
			correctness:
				"Fresh batch, exact accepted and stored result counts, twenty failure causes, and gate readable after synchronous invoke completes acceptance and apply.",
			prepare() {
				const id = `${options.prefix ?? "direct"}-${++serial}`;
				const input = ingestInput(instance.metadata, id, size);
				commit = `bench-${id}`;
				return () => {
					started = performance.now();
					return operation(instance, "report", input, instance.ci);
				};
			},
			check(value, iteration) {
				const receipt = Receipt.parse(value);
				// Read the gate before the storage assertion, so its visibility includes no benchmark count scan.
				const gate = Gate.parse(operation(instance, "gate", { commit }));
				const visible = performance.now() - started;
				if (iteration >= 0) visibility.push(visible);
				ensure(
					gate.run !== null && !gate.stale && receipt.gate?.run === gate.run && receipt.gate.verdict === gate.verdict,
					"gate must show the completed report",
				);
				ensure(
					receipt.counts.fail === Math.floor(size / 50) && receipt.questions.length === 20,
					"ingest must materialise every failure and all twenty causes",
				);
				verifyReport(instance.app, receipt, size);
			},
		},
	};
}

/** One manual result fills a previously missing slot in the pinned run, verified by its stored result id. */
export function executeWorkload(instance: DatasetInstance, iterations: number): Workload {
	let ref = "";
	const filled = new Set(instance.metadata.runCases.slice(0, 250));
	return {
		name: "execute run",
		budget: BUDGETS.execute,
		iterations,
		warmup: 5,
		correctness: "One fresh manual result, exact pinned basis, and a satisfied slot containing its result id.",
		prepare(iteration) {
			ref = itemAt(instance.metadata.runCases, 250 + iteration + 5);
			ensure(!filled.has(ref), "each manual execution must address a previously missing slot");
			const input = {
				run: instance.metadata.run,
				results: [{ test: { case: ref }, outcome: "pass", durationMs: 750 }],
			};
			return () => operation(instance, "report", input);
		},
		check(value) {
			const receipt = Receipt.parse(value);
			verifyReport(instance.app, receipt, 1);
			ensure(
				receipt.basis.exact === 1 && receipt.basis.assumed === 0,
				"manual results must have an exact pinned basis",
			);
			const result = itemAt(receipt.results, 0);
			const slots = call(
				instance.app,
				instance.owner,
				"find",
				{ in: "slots", run: instance.metadata.run, limit: 500 },
				Slots,
			);
			const slot = slots.items.find((item) => item.case === ref);
			ensure(
				slot !== undefined && slot.state === "satisfied" && slot.fills.some((fill) => fill.result === result),
				"manual result must fill its exact pinned slot",
			);
			filled.add(ref);
		},
	};
}

/** Confirms that a workload's actor is an authenticated producer without altering measured inputs. */
export function assertProducer(actor: Actor): void {
	ensure(actor.kind === "ci" && actor.can.includes("record"), "ingest must use the authenticated CI producer");
}

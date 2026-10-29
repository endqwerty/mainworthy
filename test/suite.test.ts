import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { observeDatabase } from "../bench/profile.ts";
import { budget } from "../scripts/budget.ts";
import { open } from "../src/app/start.ts";
import { Client } from "../src/cli/client.ts";
import { parseCase } from "../src/core/markdown.ts";
import { applyMergeChoice, type Conflict } from "../src/core/merge3.ts";
import { type CaseBody, type ConflictAddress, emptyBody } from "../src/core/model.ts";
import { type DecideReply, type Edit, ProposeReply } from "../src/core/ops.ts";
import { PRESETS } from "../src/core/presets.ts";
import { Proofs } from "../src/core/replies.ts";
import { actorByName } from "../src/server/identity/identity.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { type SqlValue, sql } from "../src/server/kernel/db.ts";
import { OPS } from "../src/server/ops/index.ts";
import { type AnyOp, invoke, type Reply } from "../src/server/ops/registry.ts";
import { casesByIds, findCase, findCases, versionsOf } from "../src/server/suite/suite.ts";
import { testDatabase } from "./db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness();
});
afterEach(() => h?.close());

type Proposed = {
	proposal: string | null;
	status: string;
	question: string | null;
	cases: { ref: string; version: number; hash: string }[];
	conflicts: { case: string; addresses: ConflictAddress[] }[];
};
type CaseView = {
	ref: string;
	title: string;
	version: number;
	hash: string;
	steps: { id: string; action: string; expected: string | null }[];
	tags: string[];
	covers: string[];
	folder: { path: string };
};

const OUTLINE = `Checkout applies a percentage coupon #checkout @WEB-290
  Open the cart with one $100.00 item
  Apply coupon SAVE10 > Total shows $90.00
  Reload the page => Coupon is still applied`;

const storedBody = async () => {
	const [result] = await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" });
	const parsed = parseCase(result?.md ?? "");
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
	return parsed.doc.body;
};

test("sealing sibling edits reads their base versions together", async () => {
	await h.call("propose", { edits: Array.from({ length: 64 }, (_, n) => ({ op: "create", outline: `Case ${n}` })) });
	let reads = 0;
	const restore = observeDatabase(h.app.database, (text) => {
		if (text === "SELECT * FROM versions WHERE case_id = $1 AND no = $2") reads++;
	});
	try {
		const reply = await h.call<Proposed>("propose", {
			edits: Array.from({ length: 64 }, (_, n) => ({
				op: "edit",
				case: `C-${n + 1}`,
				base: 1,
				body: { pre: "Updated" },
			})),
		});
		expect(reply.cases).toHaveLength(64);
		expect(reads).toBeLessThanOrEqual(130);
		const rows = await h.app.database.read((db) =>
			db.all(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM cases WHERE head=2")),
		);
		expect(rows).toEqual([{ n: 64 }]);
	} finally {
		restore();
	}
});

test("adopting independent edits batches versions, heads and search documents", async () => {
	await h.call("propose", {
		edits: Array.from({ length: 64 }, (_, n) => ({
			op: "create",
			body: { title: `Case ${n}`, pre: "Before" },
			tags: ["kept"],
		})),
	});
	const before = h.app.database.statementCount;
	const reply = await h.call<Proposed>("propose", {
		edits: Array.from({ length: 64 }, (_, n) => ({
			op: "edit",
			case: `C-${n + 1}`,
			base: 1,
			body: { pre: "After bulk revision" },
		})),
	});
	expect(h.app.database.statementCount - before).toBeLessThanOrEqual(100);
	expect(reply.cases.map(({ ref, version }) => ({ ref, version }))).toEqual(
		Array.from({ length: 64 }, (_, n) => ({ ref: `C-${n + 1}`, version: 2 })),
	);
	await h.app.database.read(async (db) => {
		expect(await db.allDynamic("SELECT head,count(*) AS n FROM cases GROUP BY head")).toEqual([{ head: 2, n: 64 }]);
		expect(
			await db.allDynamic(
				"SELECT v.no,count(*) AS n FROM versions v JOIN decisions d ON d.id=v.decision JOIN proposals p ON p.id=v.proposal WHERE d.kind='adopt' AND v.parent IS NOT DISTINCT FROM nullif(v.no-1,0) GROUP BY v.no ORDER BY v.no",
			),
		).toEqual([
			{ no: 1, n: 64 },
			{ no: 2, n: 64 },
		]);
	});
	const page = await h.call<{ count: number; items: { tags: string[] }[] }>("find", {
		text: "After bulk revision",
		limit: 100,
	});
	expect(page.count).toBe(64);
	expect(page.items.every((row) => row.tags.includes("kept"))).toBe(true);
});

test("a stale sibling edit falls back without repeatedly preloading the remaining batch", async () => {
	await h.close();
	h = await harness({ preset: "standard" });
	await h.call("propose", {
		edits: Array.from({ length: 12 }, (_, n) => ({ op: "create", body: { title: `Case ${n}`, pre: "Before" } })),
	});
	const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
	const waiting = await h.call<Proposed>(
		"propose",
		{
			edits: Array.from({ length: 12 }, (_, n) => ({
				op: "edit",
				case: `C-${n + 1}`,
				base: 1,
				body: { pre: "After" },
			})),
		},
		agent,
	);
	expect(waiting.status).toBe("open");
	await h.call("propose", { edits: [{ op: "edit", case: "C-12", base: 1, body: { title: "Changed while waiting" } }] });
	const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [waiting.question] });
	let preloads = 0;
	const restore = observeDatabase(h.app.database, (text) => {
		if (text === "SELECT * FROM cases WHERE id = ANY($1::bigint[])") preloads++;
	});
	try {
		expect(
			await h.call("decide", { q: waiting.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "decided" }]);
		expect(preloads).toBeLessThanOrEqual(4);
		expect(await h.call("get", { refs: ["C-12"] })).toMatchObject([
			{ title: "Changed while waiting", pre: "After", version: 3 },
		]);
	} finally {
		restore();
	}
});

test("batched adoption preserves proposal provenance and searchable tags", async () => {
	await h.close();
	h = await harness({ preset: "standard" });
	await h.call("propose", {
		edits: ["firsttag", "secondtag"].map((tag, n) => ({
			op: "create",
			body: { title: `Case ${n}`, pre: "Before" },
			tags: [tag],
		})),
	});
	const author = await h.actor("reviewer", "agent", ["read", "produce"]);
	const proposal = await h.call<Proposed>(
		"propose",
		{
			reason: "The author's revision",
			edits: [1, 2].map((n) => ({ op: "edit", case: `C-${n}`, base: 1, body: { pre: "After" } })),
		},
		author,
	);
	expect(proposal.status).toBe("open");
	const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [proposal.question] });
	expect(
		await h.call("decide", { q: proposal.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } }),
	).toMatchObject([{ status: "decided" }]);
	await h.app.database.read(async (db) => {
		expect(
			await db.allDynamic(
				"SELECT c.no,v.author,v.reason,c.updated_by FROM versions v JOIN cases c ON c.id=v.case_id WHERE v.no=2 ORDER BY c.no",
			),
		).toEqual([1, 2].map((no) => ({ no, author: author.id, reason: "The author's revision", updated_by: author.id })));
		expect(await db.allDynamic("SELECT tags FROM search_docs ORDER BY id")).toEqual([
			{ tags: "firsttag" },
			{ tags: "secondtag" },
		]);
	});
	expect(
		(await h.call<{ items: { ref: string }[] }>("find", { text: "firsttag" })).items.map((row) => row.ref),
	).toEqual(["C-1"]);
});

test("batched adoption refuses a newly invalid field before publishing any sibling", async () => {
	await h.close();
	h = await harness({ preset: "standard" });
	const setFields = async (choices: string[]) => {
		const policy = await h.call<{ version: number; settings: Record<string, unknown> }>("admin", {
			do: "policy.show",
			project: "scratch",
		});
		const proposal = await h.call<Proposed>("propose", {
			edits: [
				{
					op: "policy",
					base: policy.version,
					settings: {
						...policy.settings,
						fields: { risk: { kind: "choice", label: "Risk", required: false, choices } },
					},
				},
			],
		});
		const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [proposal.question] });
		expect(
			await h.call("decide", { q: proposal.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "decided" }]);
	};
	await setFields(["low", "high"]);
	await h.call("propose", {
		edits: [1, 2, 3].map((n) => ({
			op: "create",
			body: { title: `Case ${n}`, pre: "Before", fields: { risk: "low" } },
		})),
	});
	const author = await h.actor("reviewer", "agent", ["read", "produce"]);
	const proposal = await h.call<Proposed>(
		"propose",
		{
			edits: [1, 2, 3].map((n) => ({
				op: "edit",
				case: `C-${n}`,
				base: 1,
				body: { pre: "After", fields: { risk: n === 2 ? "high" : "low" } },
			})),
		},
		author,
	);
	expect(proposal.status).toBe("open");
	await setFields(["low"]);
	const snapshot = () =>
		h.app.database.read(async (db) => ({
			cases: await db.allDynamic("SELECT * FROM cases ORDER BY id"),
			versions: await db.allDynamic("SELECT * FROM versions ORDER BY case_id,no"),
			docs: await db.allDynamic("SELECT * FROM search_docs ORDER BY id"),
		}));
	const before = await snapshot();
	const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [proposal.question] });
	expect(
		await h.call("decide", { q: proposal.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } }),
	).toMatchObject([{ status: "invalid", needs: expect.stringContaining("case custom fields are not valid") }]);
	expect(await snapshot()).toEqual(before);
});

test("bulk suite reads preserve reference and alias resolution and pair versions exactly", async () => {
	await h.call("propose", {
		edits: [
			{ op: "create", body: { title: "First" }, aliases: ["OLD1", "OLD2"] },
			{ op: "create", body: { title: "Second" }, aliases: ["vendor:two"] },
		],
	});
	await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "First revised" } }] });
	await h.call("admin", { do: "project.create", key: "other", preset: "loose" });
	await h.app.database.read(async (db) => {
		const refs = ["C-1", "1", " 1 ", "OLD1", "OLD2", " OLD1 ", "vendor:two", "C-999", "missing", "C-1", "Q-1"];
		const before = h.app.database.statementCount;
		const found = await findCases(db, 1, refs);
		expect(h.app.database.statementCount - before).toBe(1);
		for (const text of refs) expect(found.get(text)).toEqual(await findCase(db, 1, text));
		expect(await findCases(db, 2, refs)).toEqual(new Map(refs.map((text) => [text, null])));
		const first = found.get("C-1"),
			second = found.get("vendor:two");
		if (!first || !second) throw new Error("missing batch cases");
		const byIds = await casesByIds(db, [second.id, first.id, first.id, 999999]);
		expect(byIds.map((row) => row.id).sort((a, b) => a - b)).toEqual([first.id, second.id]);
		const versions = await versionsOf(db, [
			{ caseId: first.id, no: 2 },
			{ caseId: second.id, no: 1 },
			{ caseId: second.id, no: 99 },
		]);
		expect(versions.map((row) => [row.case_id, row.no]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))).toEqual([
			[first.id, 2],
			[second.id, 1],
		]);
		expect(await casesByIds(db, [])).toEqual([]);
		expect(await versionsOf(db, [])).toEqual([]);
		expect(await findCases(db, 1, [])).toEqual(new Map());
	});
});

test("batched coverage preserves first titles, final membership and re-added decision attribution", async () => {
	await h.call("propose", { edits: [{ op: "create", body: { title: "Coverage" }, covers: ["REQ-1"] }] });
	const links = async () =>
		await h.app.database.read(
			async (db) =>
				await db.all(
					sql<readonly [], { key: string; title: string; decision: number | null }>(
						"SELECT r.key, r.title, c.decision FROM requirements r LEFT JOIN covers c ON c.requirement = r.id ORDER BY r.key",
					),
				),
		);
	const before = await links();
	await h.call("propose", {
		edits: [
			{ op: "cover", case: "C-1", requirement: "REQ-1", on: false },
			{ op: "cover", case: "C-1", requirement: "REQ-1", title: "Keep original title", on: true },
			{ op: "cover", case: "C-1", requirement: "REQ-2", title: "First title", on: true },
			{ op: "cover", case: "C-1", requirement: "REQ-2", on: false },
			{ op: "cover", case: "C-1", requirement: "REQ-2", title: "Later title", on: true },
			{ op: "cover", case: "C-1", requirement: "REQ-3", title: "Retained requirement", on: true },
			{ op: "cover", case: "C-1", requirement: "REQ-3", on: false },
		],
	});
	const after = await links();
	expect(after).toEqual([
		{ key: "REQ-1", title: "", decision: expect.any(Number) },
		{ key: "REQ-2", title: "First title", decision: expect.any(Number) },
		{ key: "REQ-3", title: "Retained requirement", decision: null },
	]);
	expect(after[0]?.decision).not.toBe(before[0]?.decision);
	expect(after[1]?.decision).toBe(after[0]?.decision);
	expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([{ covers: ["REQ-1", "REQ-2"] }]);
});

test("a body larger than the search vector limit saves and keeps title, tags and early body searchable", async () => {
	const pre =
		"earlycanary café " +
		Array.from({ length: 200_000 }, (_, i) => `word${i.toString(36).padStart(6, "0")}`).join(" ") +
		" latecanary";
	expect(Buffer.byteLength(pre)).toBeGreaterThan(2_000_000);
	expect(
		await h.call("propose", {
			edits: [{ op: "create", body: { title: "Large vector canary", pre }, tags: ["largetag"] }],
		}),
	).toMatchObject({ status: "adopted" });
	for (const text of ["large vector", "earlycanary", "cafe", "largetag"]) {
		expect(await h.call("find", { text })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
	}
	expect(await h.call("find", { text: "latecanary" })).toMatchObject({ count: 0, items: [] });
	expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([{ pre }]);
});

test("search folds accents, keeps stop words and uses exact earlier words with a final prefix", async () => {
	await h.call("propose", {
		edits: [
			{ op: "create", body: { title: "Café running the checkout" } },
			{ op: "create", body: { title: "Cafe run the cart" } },
		],
	});
	const refs = async (text: string) =>
		(await h.call<{ items: { ref: string }[] }>("find", { text })).items.map((row) => row.ref).sort();
	expect(await refs("cafe")).toEqual(["C-1", "C-2"]);
	expect(await refs("the")).toEqual(["C-1", "C-2"]);
	expect(await refs("run the")).toEqual(["C-2"]);
	expect(await refs("running ch")).toEqual(["C-1"]);
	expect(await refs("running | & ! ch")).toEqual(["C-1"]);
	expect(await refs("***")).toEqual([]);
});

describe("atomic bulk proposals", () => {
	const count = 450;
	const creates = (): Edit[] =>
		Array.from({ length: count }, (_, i) => ({ op: "create", outline: `Bulk case ${i}\n  Check > Pass` }));
	const tick = async (instance: Awaited<ReturnType<typeof disk>>): Promise<void> => {
		await instance.nextSlice();
	};
	const disk = async () => {
		const dir = mkdtempSync(join(tmpdir(), "mainworthy-bulk-"));
		const fixture = await testDatabase();
		const config = { ...defaultConfig({ MAINWORTHY_DATA: dir, MAINWORTHY_OWNER: "robin" }), databaseUrl: fixture.url };
		const instance = await open(config);
		const call = (op: string, input: unknown = {}) => ({
			op,
			input,
			project: "scratch",
			actor: async () => instance.owner,
		});
		const observed: { active: boolean; monitor: boolean; finished: boolean; counts: Record<string, number> } = {
			active: false,
			monitor: false,
			finished: true,
			counts: {},
		};
		let releaseSlice: (() => void) | null = null;
		const sliceWaiters: (() => void)[] = [];
		const notifySlice = () => {
			for (const resolve of sliceWaiters.splice(0)) resolve();
		};
		const resumeSlice = () => {
			observed.active = false;
			releaseSlice?.();
			releaseSlice = null;
		};
		const observe = (operation: AnyOp): AnyOp => {
			if (operation.scope !== "project" || operation.effect !== "write" || !("steps" in operation)) return operation;
			return {
				...operation,
				async *steps(ctx, input) {
					const steps = operation.steps(ctx, input);
					if (!observed.monitor) return yield* steps;
					let initialCounts: Record<string, number> | null = null;
					const changes = new Set<string>();
					try {
						for (let step = await steps.next(); ; step = await steps.next()) {
							if (step.done) return step.value;
							const counts = await ctx.db.one(
								sql<readonly [], Record<string, number>>(
									`SELECT (SELECT count(*) FROM cases) AS cases, (SELECT count(*) FROM versions) AS versions,
							 (SELECT count(*) FROM decisions) AS decisions, (SELECT count(*) FROM proposals) AS proposals,
							 (SELECT count(*) FROM cases WHERE head = 2) AS edited,
							 (SELECT count(*) FROM cases WHERE tags = '["changed"]') AS placed,
							 (SELECT count(*) FROM cases WHERE state = 'archived') AS archived`,
								),
							);
							let changed = initialCounts === null;
							for (const key of Object.keys(counts)) {
								if (initialCounts && counts[key] !== initialCounts[key] && !changes.has(key)) {
									changed = true;
									changes.add(key);
								}
							}
							initialCounts ??= counts;
							if (!changed) {
								yield step.value;
								continue;
							}
							observed.counts = counts;
							observed.active = true;
							notifySlice();
							if (observed.monitor)
								await new Promise<void>((resolve) => {
									releaseSlice = resolve;
								});
							yield step.value;
						}
					} finally {
						observed.active = false;
						observed.monitor = false;
						observed.finished = true;
						notifySlice();
						await steps.return(undefined);
					}
				},
			};
		};
		const ops: typeof OPS = Object.fromEntries(
			Object.entries(OPS).map(([name, operation]) => [name, observe(operation)]),
		);
		const raw = async (op: string, input: unknown = {}) => await invoke(instance.app, OPS, call(op, input));
		return {
			...instance,
			config,
			ops,
			observed,
			resumeSlice,
			async nextSlice() {
				resumeSlice();
				if (!observed.finished) await new Promise<void>((resolve) => sliceWaiters.push(resolve));
				await new Promise<void>((resolve) => setImmediate(resolve));
			},
			startObserving() {
				observed.finished = false;
				observed.monitor = true;
			},
			call,
			raw,
			async close() {
				observed.monitor = false;
				resumeSlice();
				await instance.app.close();
				await fixture.close();
				rmSync(dir, { recursive: true, force: true });
			},
		};
	};
	const result = <T>(reply: Reply): T => {
		if (!reply.ok) throw new Error(JSON.stringify(reply.error));
		return reply.result as T;
	};
	const storedCount = async (
		instance: Awaited<ReturnType<typeof disk>>,
		table: "cases" | "versions" | "decisions" | "proposals",
	) =>
		instance.observed.active
			? (instance.observed.counts[table] ?? 0)
			: (
					await instance.app.database.read(
						async (db) => await db.one(sql<readonly [], { n: number }>(`SELECT count(*) AS n FROM ${table}`)),
					)
				).n;
	const acceptance = async (instance: Awaited<ReturnType<typeof disk>>, proposed: ProposeReply) => {
		const question = result<{ evidenceHash: string }[]>(await instance.raw("get", { refs: [proposed.question] }))[0];
		return {
			q: proposed.question,
			onEvidence: question?.evidenceHash,
			answer: { is: "accept" },
			reason: "Reviewed all cases",
		};
	};
	const strict = async (instance: Awaited<ReturnType<typeof disk>>) => {
		const policy = result<ProposeReply>(await instance.raw("propose", { edits: [{ op: "policy", preset: "strict" }] }));
		expect(result<DecideReply[]>(await instance.raw("decide", await acceptance(instance, policy)))[0]?.status).toBe(
			"decided",
		);
	};

	test("a maximum-size conflict resolution yields while sealing and keeps its replacement atomic", async () => {
		const instance = await disk();
		try {
			result(await instance.raw("propose", { edits: [{ op: "create", body: { title: "Base" } }] }));
			result(
				await instance.raw("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Theirs" } }] }),
			);
			const conflict = result<ProposeReply>(
				await instance.raw("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }] }),
			);
			const question = result<{ evidenceHash: string }[]>(await instance.raw("get", { refs: [conflict.question] }))[0];
			const proposalsBefore = (
				await instance.app.database.read(
					async (db) =>
						await db.get(sql<readonly SqlValue[], { n: number }>("SELECT count(*) AS n FROM proposals"), []),
				)
			)?.n;
			const decisionsBefore = await storedCount(instance, "decisions");
			const covers = Array.from({ length: 4999 }, (_, i) => `REQ-${i}`);
			const input = {
				q: conflict.question,
				onEvidence: question?.evidenceHash,
				answer: {
					is: "merge",
					body: { title: "Resolved", pre: "", steps: [], methods: ["human"], automate: "none", fields: {} },
					covers,
				},
				cmd: "max-merge-01",
			};
			let done = false;
			instance.startObserving();
			const saving = invoke(instance.app, instance.ops, instance.call("decide", input));
			void saving.then(() => {
				done = true;
			});
			let duringSeal = false;
			while (!done) {
				await tick(instance);
				if (!instance.observed.active) continue;
				const proposals = await storedCount(instance, "proposals");
				if (done || (await storedCount(instance, "decisions")) === decisionsBefore || proposals !== proposalsBefore)
					continue;
				duringSeal = true;
				expect(result<CaseView[]>(await instance.raw("get", { refs: ["C-1"] }))[0]).toMatchObject({
					title: "Theirs",
					version: 2,
					covers: [],
				});
				expect(result<{ state: string }[]>(await instance.raw("get", { refs: [conflict.question] }))[0]?.state).toBe(
					"open",
				);
			}
			const replies = result<DecideReply[]>(await saving);
			expect(replies[0]).toMatchObject({ status: "decided", effects: { status: "adopted" } });
			expect(duringSeal).toBe(true);
			const replacement = await instance.app.database.read(
				async (db) =>
					await db.get(
						sql<readonly SqlValue[], { edits: string }>("SELECT edits FROM proposals ORDER BY id DESC LIMIT 1"),
						[],
					),
			);
			expect(JSON.parse(replacement?.edits ?? "[]")).toHaveLength(5000);
			expect(result<CaseView[]>(await instance.raw("get", { refs: ["C-1"] }))[0]).toMatchObject({
				title: "Resolved",
				version: 3,
				covers: expect.arrayContaining(["REQ-0", "REQ-4998"]),
			});
			expect(result<CaseView[]>(await instance.raw("get", { refs: ["C-1"] }))[0]?.covers).toHaveLength(4999);
			expect(result<DecideReply[]>(await invoke(instance.app, instance.ops, instance.call("decide", input)))).toEqual(
				replies,
			);
		} finally {
			instance.observed.monitor = false;
			instance.resumeSlice();
			await instance.app.database.write(() => {});
			await instance.close();
		}
	});

	test.each(["map", "finding", "policy"] as const)(
		"case creation from %s answers yields without publishing partial effects",
		async (kind) => {
			const instance = await disk();
			try {
				const total = kind === "finding" ? 200 : count;
				const questionKind = kind === "finding" ? "finding" : "map";
				if (kind !== "finding") {
					const policy = result<ProposeReply>(
						await instance.raw("propose", { edits: [{ op: "policy", unlinked: "ask" }] }),
					);
					expect(
						result<DecideReply[]>(await instance.raw("decide", await acceptance(instance, policy)))[0]?.status,
					).toBe("decided");
					result(await instance.raw("report", ciReport({ commit: "ba1c0001", n: total })));
				} else {
					result(
						await instance.raw("claim", {
							lens: "coverage",
							findings: Array.from({ length: total }, (_, i) => ({
								on: `req:bulk-${i}`,
								category: "uncovered-path",
								note: `Missing path ${i}`,
								suggest: { case: { title: `Suggested ${i}`, steps: ["Check > Pass"] } },
							})),
						}),
					);
				}
				const questions = result<{ items: { q: string; evidenceHash: string }[] }>(
					await instance.raw("inbox", { kind: questionKind, limit: 200 }),
				).items;
				expect(questions).toHaveLength(kind === "finding" ? total : 1);
				const pendingPolicy =
					kind === "policy"
						? result<ProposeReply>(await instance.raw("propose", { edits: [{ op: "policy", unlinked: "create" }] }))
						: null;
				const input = {
					all: pendingPolicy
						? [await acceptance(instance, pendingPolicy)]
						: questions.map((question) => ({
								q: question.q,
								onEvidence: question.evidenceHash,
								answer: kind === "map" ? { is: "create" } : { is: "accept", apply: true },
							})),
					cmd: `bulk-${kind}`,
				};
				let done = false;
				instance.startObserving();
				const saving = invoke(instance.app, instance.ops, instance.call("decide", input));
				void saving.then(() => {
					done = true;
				});
				let partial = false;
				while (!done) {
					await tick(instance);
					if (!instance.observed.active) continue;
					const written = await storedCount(instance, "cases");
					if (done || written === 0 || written === total) continue;
					partial = true;
					expect(result(await instance.raw("find"))).toMatchObject({ count: 0, items: [] });
					expect(
						result<{ items: unknown[] }>(await instance.raw("inbox", { kind: questionKind, limit: 200 })).items,
					).toHaveLength(questions.length);
				}
				const saved = result<DecideReply[]>(await saving);
				expect(saved.map((reply) => reply.status)).toEqual(questions.map(() => "decided"));
				expect(result(await instance.raw("find"))).toMatchObject({ count: total });
				expect(result(await instance.raw("inbox", { kind: questionKind }))).toMatchObject({ items: [] });
				expect(result<DecideReply[]>(await invoke(instance.app, instance.ops, instance.call("decide", input)))).toEqual(
					saved,
				);
				if (kind !== "finding") {
					const receipt = result<{ basis: { assumed: number; unresolved: number } }>(
						await instance.raw("report", ciReport({ commit: "ba1c0002", n: total })),
					);
					expect(receipt.basis).toMatchObject({ assumed: total, unresolved: 0 });
				}
				expect(partial).toBe(true);
			} finally {
				instance.observed.monitor = false;
				instance.resumeSlice();
				await instance.app.database.write(() => {});
				await instance.close();
			}
		},
	);

	test("sealing a bulk proposal that needs review also answers reads before publishing it", async () => {
		const instance = await disk();
		try {
			await strict(instance);
			let done = false;
			instance.startObserving();
			const sealing = invoke(instance.app, instance.ops, instance.call("propose", { edits: creates() }));
			void sealing.then(() => {
				done = true;
			});
			let during = false;
			while (!done) {
				await tick(instance);
				if (!instance.observed.active) continue;
				if (done) break;
				during = true;
				expect(result(await instance.raw("find"))).toMatchObject({ count: 0 });
				expect(await instance.raw("get", { refs: ["P-2"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
			}
			const proposed = result<ProposeReply>(await sealing);
			expect(proposed).toMatchObject({ proposal: "P-2", status: "open", cases: [] });
			expect(result<unknown[]>(await instance.raw("get", { refs: [proposed.proposal] }))[0]).toMatchObject({
				ref: "P-2",
			});
			expect(during).toBe(true);
		} finally {
			instance.observed.monitor = false;
			instance.resumeSlice();
			await instance.app.database.write(() => {});
			await instance.close();
		}
	});

	test("sealing a 401-case fragment move answers reads even when its last case conflicts", async () => {
		// Two 200-case slices precede the last consumer, where the conflict must roll back the move.
		const instance = await disk();
		try {
			result(
				await instance.raw("propose", {
					edits: [
						{
							op: "create",
							kind: "fragment",
							body: {
								title: "Sign in",
								steps: [{ id: "ab", action: "Password", expected: "Signed in" }],
							},
						},
					],
				}),
			);
			const created = result<ProposeReply>(
				await instance.raw("propose", {
					edits: Array.from({ length: 401 }, (_, i) => ({
						op: "create",
						body: {
							title: `Consumer ${i}`,
							steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }],
						},
					})),
				}),
			);
			result(
				await instance.raw("propose", {
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: 1,
							body: { steps: [{ id: "ab", action: "Passkey", expected: "Signed in" }] },
						},
						{ op: "edit", case: "C-402", base: 1, body: { title: "Changed consumer" } },
					],
				}),
			);
			const before = {
				versions: await storedCount(instance, "versions"),
				decisions: await storedCount(instance, "decisions"),
			};
			const edits: Edit[] = [
				{
					op: "fragment",
					fragment: "C-1",
					from: 1,
					to: 2,
					cases: created.cases.map(({ ref }) => ({ case: ref, base: 1 })),
				},
			];
			let done = false;
			instance.startObserving();
			const moving = invoke(instance.app, instance.ops, instance.call("propose", { edits }));
			void moving.then(() => {
				done = true;
			});
			let readDuringSealing = false;
			while (!done) {
				await tick(instance);
				if (!instance.observed.active) continue;
				if (done) break;
				expect(
					result<unknown[]>(await invoke(instance.app, instance.ops, instance.call("get", { refs: ["C-2", "C-402"] }))),
				).toMatchObject([
					{ version: 1, steps: [{ action: "Password", source: { version: 1 } }] },
					{ version: 2, title: "Changed consumer", steps: [{ action: "Password", source: { version: 1 } }] },
				]);
				readDuringSealing = true;
			}
			expect(await moving).toMatchObject({
				ok: false,
				error: {
					code: "conflict",
					message: "C-402 changed; redo the fragment batch",
				},
			});
			expect(await storedCount(instance, "versions")).toBe(before.versions);
			expect(await storedCount(instance, "decisions")).toBe(before.decisions);
			expect(await instance.raw("get", { refs: ["P-4"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
			expect(readDuringSealing).toBe(true);

			instance.startObserving();

			const retry = invoke(
				instance.app,
				instance.ops,
				instance.call("propose", {
					edits: [
						{
							op: "fragment",
							fragment: "C-1",
							from: 1,
							to: 2,
							cases: created.cases.map(({ ref }) => ({ case: ref, base: ref === "C-402" ? 2 : 1 })),
						},
					],
				}),
			);
			done = false;
			void retry.then(() => {
				done = true;
			});
			while (!done) {
				await tick(instance);
				if (!instance.observed.active) continue;
				if (done) break;
				expect(result<unknown[]>(await instance.raw("get", { refs: ["C-2", "C-402"] }))).toMatchObject([
					{ version: 1, steps: [{ action: "Password", source: { version: 1 } }] },
					{ version: 2, steps: [{ action: "Password", source: { version: 1 } }] },
				]);
			}
			const adopted = result<ProposeReply>(await retry);
			expect(adopted.status).toBe("adopted");
			expect(adopted.cases).toHaveLength(401);
			expect(await storedCount(instance, "versions")).toBe(before.versions + 401);
			expect(await storedCount(instance, "decisions")).toBe(before.decisions + 1);
			expect(result<unknown[]>(await instance.raw("get", { refs: ["C-2", "C-402"] }))).toMatchObject([
				{ version: 2, steps: [{ action: "Passkey", source: { version: 2 } }] },
				{ version: 3, title: "Changed consumer", steps: [{ action: "Passkey", source: { version: 2 } }] },
			]);
		} finally {
			instance.observed.monitor = false;
			instance.resumeSlice();
			await instance.app.database.write(() => {});
			await instance.close();
		}
	}, 30000);

	test("a bulk save answers reads between slices and publishes the complete proposal and decision once", async () => {
		const instance = await disk();
		try {
			const events: unknown[] = [];
			instance.app.subscribe((event) => events.push(event));
			let done = false;
			instance.startObserving();
			const saving = invoke(
				instance.app,
				instance.ops,
				instance.call("propose", { edits: creates(), cmd: "bulk-save-01" }),
			);
			void saving.then(() => {
				done = true;
			});
			let partial = false;
			while (!done) {
				await tick(instance);
				if (!instance.observed.active) continue;
				const written = await storedCount(instance, "cases");
				if (written === 0 || written === count) continue;
				partial = true;
				expect(result(await instance.raw("find"))).toMatchObject({ count: 0, items: [] });
				expect(await instance.raw("get", { refs: ["P-1"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
				expect(result(await instance.raw("inbox"))).toMatchObject({ items: [] });
				expect(events).toHaveLength(0);
			}
			const saved = result<ProposeReply>(await saving);
			expect(saved.status).toBe("adopted");
			expect(saved.cases).toHaveLength(count);
			expect(result(await instance.raw("find"))).toMatchObject({ count });
			expect(await storedCount(instance, "versions")).toBe(count);
			expect(await storedCount(instance, "decisions")).toBe(1);
			expect(events).toHaveLength(1);
			expect(partial).toBe(true);
			expect(
				result<ProposeReply>(
					await invoke(instance.app, instance.ops, instance.call("propose", { edits: creates(), cmd: "bulk-save-01" })),
				),
			).toEqual(saved);
			expect(await storedCount(instance, "versions")).toBe(count);
		} finally {
			instance.observed.monitor = false;
			instance.resumeSlice();
			await instance.app.database.write(() => {});
			await instance.close();
		}
	});

	test("accepting a bulk proposal answers reads without exposing half its cases or a decided question", async () => {
		const instance = await disk();
		try {
			await strict(instance);
			const proposed = result<ProposeReply>(await instance.raw("propose", { edits: creates() }));
			expect(proposed.status).toBe("open");
			const question = result<{ evidenceHash: string }[]>(await instance.raw("get", { refs: [proposed.question] }))[0];
			let done = false;
			instance.startObserving();
			const accepting = invoke(
				instance.app,
				instance.ops,
				instance.call("decide", {
					q: proposed.question,
					onEvidence: question?.evidenceHash,
					answer: { is: "accept" },
					reason: "Reviewed all cases",
				}),
			);
			void accepting.then(() => {
				done = true;
			});
			let partial = false;
			while (!done) {
				await tick(instance);
				if (!instance.observed.active) continue;
				const written = await storedCount(instance, "cases");
				if (written === 0 || written === count) continue;
				partial = true;
				expect(result(await instance.raw("find"))).toMatchObject({ count: 0 });
				expect(result(await instance.raw("find", { text: "Bulk" }))).toMatchObject({ count: 0 });
				expect(result<unknown[]>(await instance.raw("get", { refs: [proposed.question] }))[0]).toMatchObject({
					state: "open",
				});
			}
			expect(result<DecideReply[]>(await accepting)[0]).toMatchObject({
				status: "decided",
				effects: { cases: expect.any(Array) },
			});
			expect(result(await instance.raw("find"))).toMatchObject({ count });
			expect(result<unknown[]>(await instance.raw("get", { refs: [proposed.question] }))[0]).toMatchObject({
				state: "decided",
			});
			expect(partial).toBe(true);
		} finally {
			instance.observed.monitor = false;
			instance.resumeSlice();
			await instance.app.database.write(() => {});
			await instance.close();
		}
	});

	test.each(["edit", "place", "state"] as const)(
		"a bulk %s keeps every case at its previous state between slices",
		async (op) => {
			const instance = await disk();
			try {
				const created = result<ProposeReply>(await instance.raw("propose", { edits: creates() }));
				const refs = created.cases.map((row) => row.ref);
				const edits: Edit[] =
					op === "edit"
						? refs.map((ref) => ({ op: "edit", case: ref, base: 1, body: { title: `Changed ${ref}` } }))
						: op === "place"
							? [{ op, cases: refs, tags: { add: ["changed"] }, folder: "Moved" }]
							: [{ op, cases: refs, to: "archived" }];
				const condition = op === "edit" ? "head = 2" : op === "place" ? "tags = '[\"changed\"]'" : "state = 'archived'";
				let done = false;
				instance.startObserving();
				const saving = invoke(instance.app, instance.ops, instance.call("propose", { edits }));
				void saving.then(() => {
					done = true;
				});
				let partial = false;
				while (!done) {
					await tick(instance);
					if (!instance.observed.active) continue;
					const changed = instance.observed.active
						? (instance.observed.counts[op === "edit" ? "edited" : op === "place" ? "placed" : "archived"] ?? 0)
						: 0;
					if (changed === 0 || changed === count) continue;
					partial = true;
					expect(result(await instance.raw("find"))).toMatchObject({ count });
					expect(result<unknown[]>(await instance.raw("get", { refs: ["C-1", `C-${count}`] }))).toMatchObject([
						{ title: "Bulk case 0", version: 1, tags: [], state: "active" },
						{ title: `Bulk case ${count - 1}`, version: 1, tags: [], state: "active" },
					]);
				}
				expect(result<ProposeReply>(await saving).status).toBe("adopted");
				expect(
					(
						await instance.app.database.read(
							async (db) =>
								await db.get(
									sql<readonly SqlValue[], { n: number }>(`SELECT count(*) AS n FROM cases WHERE ${condition}`),
									[],
								),
						)
					)?.n,
				).toBe(count);
				expect(partial).toBe(true);
			} finally {
				instance.observed.monitor = false;
				instance.resumeSlice();
				await instance.app.database.write(() => {});
				await instance.close();
			}
		},
	);

	test("a late adoption conflict rolls back earlier slices and leaves the next batched answer usable", async () => {
		const instance = await disk();
		try {
			await strict(instance);
			const edits = creates();
			edits.push({ op: "create", outline: "Last case", aliases: ["bulk:last"] });
			const pending = result<ProposeReply>(await instance.raw("propose", { edits }));
			const competitor = result<ProposeReply>(
				await instance.raw("propose", { edits: [{ op: "create", outline: "Alias holder", aliases: ["bulk:last"] }] }),
			);
			expect(
				result<DecideReply[]>(await instance.raw("decide", await acceptance(instance, competitor)))[0]?.status,
			).toBe("decided");
			const next = result<ProposeReply>(
				await instance.raw("propose", { edits: [{ op: "create", outline: "Next answer" }] }),
			);
			const replies = result<DecideReply[]>(
				await invoke(
					instance.app,
					instance.ops,
					instance.call("decide", {
						all: [await acceptance(instance, pending), await acceptance(instance, next)],
					}),
				),
			);
			expect(replies.map((reply) => reply.status)).toEqual(["conflict", "decided"]);
			expect(replies[0]?.needs).toBe("case alias bulk:last is already in use");
			expect(result(await instance.raw("find"))).toMatchObject({ count: 2 });
			expect(await storedCount(instance, "versions")).toBe(2);
			expect(await storedCount(instance, "decisions")).toBe(3);
			expect(result<unknown[]>(await instance.raw("get", { refs: [pending.question] }))[0]).toMatchObject({
				state: "open",
			});
			expect(result<CaseView[]>(await instance.raw("get", { refs: ["C-1", "C-2"] })).map((row) => row.title)).toEqual([
				"Alias holder",
				"Next answer",
			]);
		} finally {
			instance.observed.monitor = false;
			instance.resumeSlice();
			await instance.app.database.write(() => {});
			await instance.close();
		}
	});

	test.each(["propose", "decide"])(
		"a process killed between %s slices leaves no partial adoption after restart",
		async (op) => {
			const instance = await disk();
			let child: ReturnType<typeof Bun.spawn> | undefined;
			try {
				let input: unknown = { edits: creates(), cmd: "bulk-crash-01" };
				let pending: ProposeReply | undefined;
				if (op === "decide") {
					await strict(instance);
					pending = result<ProposeReply>(await instance.raw("propose", { edits: creates() }));
					input = { ...(await acceptance(instance, pending)), cmd: "bulk-crash-01" };
				}
				const before = await storedCount(instance, "decisions");
				const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
				const running = Bun.spawn(
					[
						process.execPath,
						"-e",
						`
import { sql } from ${module("../src/server/kernel/db.ts")};
import { OPS } from ${module("../src/server/ops/index.ts")};
import { invoke } from ${module("../src/server/ops/registry.ts")};
import { open } from ${module("../src/app/start.ts")};
const { config, op, input } = JSON.parse(await Bun.stdin.text());
const { app, owner } = await open(config);
const operation = OPS[op];
if (!("steps" in operation)) throw new Error("the bulk operation has no slices");
const paused = { ...operation, async *steps(ctx, input) {
	const steps = operation.steps(ctx, input);
	for (let step = await steps.next(); ; step = await steps.next()) {
		if (step.done) return step.value;
		const count = (await ctx.db.one(sql("SELECT count(*) AS n FROM cases"))).n;
		if (count > 0 && count < ${count}) {
			process.stdout.write("PARTIAL " + count + "\\n");
			for (;;) yield;
		}
		yield step.value;
	}
} };
await invoke(app, { ...OPS, [op]: paused }, { op, project: "scratch", input, actor: async () => owner });
throw new Error("the operation completed without a partial adoption slice");
`,
					],
					{ stdin: new Blob([JSON.stringify({ config: instance.config, op, input })]), stdout: "pipe", stderr: "pipe" },
				);
				child = running;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const output = await Promise.race([
						running.stdout.getReader().read(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("no adoption slice within five seconds")), 5000);
						}),
					]);
					expect(new TextDecoder().decode(output.value)).toMatch(/^PARTIAL \d+\n$/);
				} finally {
					clearTimeout(timer);
				}
				child.kill("SIGKILL");
				await child.exited;
				const restarted = await open(instance.config);
				try {
					const raw = async (operation: string, body: unknown = {}) =>
						await invoke(restarted.app, OPS, {
							op: operation,
							project: "scratch",
							input: body,
							actor: async () => restarted.owner,
						});
					expect(result(await raw("find"))).toMatchObject({ count: 0 });
					for (const table of ["cases", "versions", "placements", "search_docs", "commands"]) {
						expect(
							(
								await restarted.app.database.read(
									async (db) =>
										await db.get(sql<readonly SqlValue[], { n: number }>(`SELECT count(*) AS n FROM ${table}`), []),
								)
							)?.n,
						).toBe(0);
					}
					expect(
						(
							await restarted.app.database.read(
								async (db) =>
									await db.get(sql<readonly SqlValue[], { n: number }>("SELECT count(*) AS n FROM decisions"), []),
							)
						)?.n,
					).toBe(before);
					if (pending)
						expect(result<unknown[]>(await raw("get", { refs: [pending.question] }))[0]).toMatchObject({
							state: "open",
						});
					else expect(await raw("get", { refs: ["P-1"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
					const retried = await raw(op, input);
					expect(retried.ok).toBe(true);
					expect(await raw(op, input)).toEqual(retried);
					expect(result(await raw("find"))).toMatchObject({ count });
					expect(
						(
							await restarted.app.database.read(
								async (db) =>
									await db.get(sql<readonly SqlValue[], { n: number }>("SELECT count(*) AS n FROM versions"), []),
							)
						)?.n,
					).toBe(count);
					expect(
						(
							await restarted.app.database.read(
								async (db) =>
									await db.get(sql<readonly SqlValue[], { n: number }>("SELECT count(*) AS n FROM decisions"), []),
							)
						)?.n,
					).toBe(before + 1);
				} finally {
					await restarted.app.close();
				}
			} finally {
				if (child) {
					child.kill("SIGKILL");
					await child.exited;
				}
				await instance.close();
			}
		},
	);
});

describe("capture", () => {
	test("an outline becomes C-1, version 1, with steps, expected results, a tag and a requirement", async () => {
		const reply = await h.call<Proposed>("propose", {
			edits: [{ op: "create", outline: OUTLINE, folder: "checkout/coupons" }],
		});
		expect(reply.status).toBe("adopted");
		expect(reply.cases).toEqual([{ ref: "C-1", version: 1, hash: expect.any(String) }]);
		const [view] = await h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect(view?.title).toBe("Checkout applies a percentage coupon");
		expect(view?.steps.map((s) => [s.action, s.expected])).toEqual([
			["Open the cart with one $100.00 item", null],
			["Apply coupon SAVE10", "Total shows $90.00"],
			["Reload the page", "Coupon is still applied"],
		]);
		expect(view?.tags).toEqual(["checkout"]);
		expect(view?.covers).toEqual(["WEB-290"]);
		expect(view?.folder.path).toBe("checkout/coupons");
	});

	test("suite writes clean Unicode folder paths and tags", async () => {
		await h.call("propose", {
			edits: [{ op: "create", outline: "Unicode", folder: " Cafe\u0301\u200b / Child ", tags: ["#Crit\u200bical"] }],
		});
		expect((await h.call<CaseView[]>("get", { refs: ["C-1"] }))[0]).toMatchObject({
			folder: { path: "Café/Child" },
			tags: ["critical"],
		});
		await h.call("propose", {
			edits: [{ op: "place", cases: ["C-1"], folder: "Re\u0301sume\u0301", tags: { set: ["re\u200bview"] } }],
		});
		expect((await h.call<CaseView[]>("get", { refs: ["C-1"] }))[0]).toMatchObject({
			folder: { path: "Résumé" },
			tags: ["review"],
		});
	});

	test("folder creation and rename use the same Unicode cleaning as paths", async () => {
		await h.call("propose", { edits: [{ op: "folder", name: " Cafe\u0301\u200b " }] });
		await h.call("propose", { edits: [{ op: "create", outline: "Unicode", folder: "Café" }] });
		expect((await h.call<{ items: unknown[] }>("find", { in: "folders" })).items.length).toBe(1);
		await h.call("propose", { edits: [{ op: "folder", folder: "Café", name: " Re\u0301sume\u0301\u200b " }] });
		expect((await h.call<CaseView[]>("get", { refs: ["C-1"] }))[0]?.folder.path).toBe("Résumé");
	});

	test.each([
		["Checkout", "Checkout"],
		["check\u200bout", "checkout"],
	])("a rename cannot hide a sibling's cases at %s", async (name, path) => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "Checkout case", folder: "Checkout" },
				{ op: "create", outline: "Refund case", folder: "Refunds" },
			],
		});
		expect(await h.raw("propose", { edits: [{ op: "folder", folder: "Refunds", name }] })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: `folder path "${path}" is already in use; choose another name or parent` },
		});
		expect(
			(await h.call<{ items: { path: string }[] }>("find", { in: "folders" })).items.map((row) => row.path),
		).toEqual(["Checkout", "Refunds"]);
		expect(await h.call("find", { folder: "Checkout" })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
		expect(await h.call("find", { folder: "Refunds" })).toMatchObject({ count: 1, items: [{ ref: "C-2" }] });
		expect(await h.call("find")).toMatchObject({ count: 2 });
		expect(await h.call("plan", { name: "Checkout regression", select: { folders: ["Checkout"] } })).toMatchObject({
			run: "R-1",
			slots: 1,
		});
		expect(await h.call("plan", { name: "Both folders", select: { folders: ["Checkout", "Refunds"] } })).toMatchObject({
			run: "R-2",
			slots: 2,
		});
	});

	test.each([false, true])("legacy duplicate paths allow edits and repairs, new folder first: %s", async (first) => {
		const names = first ? ["Public", "Checkout", "Refunds"] : ["Checkout", "Refunds", "Public"];
		await h.call("propose", {
			edits: [
				...names.map((name) => ({ op: "folder", name })),
				{ op: "create", outline: "Unrelated", folder: "Public" },
			],
		});
		const duplicate = (await h.call<{ items: { id: number; path: string }[] }>("find", { in: "folders" })).items.find(
			(row) => row.path === "Refunds",
		);
		if (!duplicate) throw new Error("no folder to duplicate");
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE folders SET name = 'Checkout' WHERE id = $1"), [
							duplicate.id,
						]),
				),
		);
		expect(
			await h.raw("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Updated" } }] }),
		).toMatchObject({ ok: true, result: { status: "adopted" } });
		expect((await h.call<CaseView[]>("get", { refs: ["C-1"] }))[0]).toMatchObject({
			title: "Updated",
			version: 2,
			folder: { path: "Public" },
		});
		expect(
			(await h.call<{ items: { path: string }[] }>("find", { in: "folders" })).items.map((row) => row.path).sort(),
		).toEqual(["Checkout", "Checkout", "Public"]);
		expect(await h.raw("propose", { edits: [{ op: "folder", folder: "Public", name: "Checkout" }] })).toMatchObject({
			ok: false,
			error: {
				code: "invalid",
				message: 'folder path "Checkout" is already in use; choose another name or parent',
			},
		});
		expect(
			(
				await h.call<Proposed>("propose", {
					edits: [{ op: "folder", folder: duplicate.id, name: "Repaired" }],
				})
			).status,
		).toBe("adopted");
		expect(
			(await h.call<{ items: { path: string }[] }>("find", { in: "folders" })).items.map((row) => row.path).sort(),
		).toEqual(["Checkout", "Public", "Repaired"]);
	});

	test("two renames cannot create the same final folder path", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "First", folder: "Public/First" },
				{ op: "create", outline: "Second", folder: "Public/Second" },
			],
		});
		expect(
			await h.raw("propose", {
				edits: [
					{ op: "folder", folder: "Public", name: "Checkout" },
					{ op: "folder", folder: "Public/First", name: "Secure" },
					{ op: "folder", folder: "Public/Second", name: "Secure" },
				],
			}),
		).toMatchObject({
			ok: false,
			error: {
				code: "invalid",
				message: 'folder path "Checkout/Secure" is already in use; choose another name or parent',
			},
		});
		expect((await h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] })).map((row) => row.folder.path)).toEqual([
			"Public/First",
			"Public/Second",
		]);
	});

	test("creating or moving a folder cannot duplicate a canonical sibling path", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "Existing", folder: "Parent/Café" },
				{ op: "create", outline: "Moving", folder: "Other/Café" },
			],
		});
		for (const edit of [
			{ op: "folder", parent: "Parent", name: "CAFE\u0301" },
			{ op: "folder", folder: "Other/Café", parent: "Parent" },
		])
			expect(await h.raw("propose", { edits: [edit] })).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect((await h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] })).map((row) => row.folder.path)).toEqual([
			"Parent/Café",
			"Other/Café",
		]);
	});

	test("a pending rename rechecks collisions at adoption and leaves the proposal rejectable", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Refunds" }] });
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		await h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const policy = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
			.items[0];
		if (!policy) throw new Error("no policy question");
		await h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		const pending = await h.call<Proposed>(
			"propose",
			{
				edits: [
					{ op: "edit", case: "C-1", base: 1, body: { title: "Must roll back" } },
					{ op: "folder", folder: "Refunds", name: "Checkout" },
				],
			},
			agent,
		);
		await h.call("propose", { edits: [{ op: "create", outline: "New sibling", folder: "Checkout" }] });
		const question = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
			.items[0];
		if (!question) throw new Error("no rename question");
		expect(pending).toMatchObject({ question: question.q });
		expect(
			await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([
			{ status: "invalid", needs: 'folder path "Checkout" is already in use; choose another name or parent' },
		]);
		expect((await h.call<CaseView[]>("get", { refs: ["C-1"] }))[0]).toMatchObject({
			title: "Original",
			version: 1,
			folder: { path: "Refunds" },
		});
		expect(
			(
				await h.call<{ status: string }[]>("decide", {
					q: question.q,
					onEvidence: question.evidenceHash,
					answer: { is: "reject" },
				})
			)[0]?.status,
		).toBe("decided");
	});

	test("a batch may swap folder names when its final paths are distinct", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "First", folder: "Checkout" },
				{ op: "create", outline: "Second", folder: "Refunds" },
			],
		});
		expect(
			(
				await h.call<Proposed>("propose", {
					edits: [
						{ op: "folder", folder: "Checkout", name: "Refunds" },
						{ op: "folder", folder: "Refunds", name: "Checkout" },
					],
				})
			).status,
		).toBe("adopted");
		expect(await h.call("find", { folder: "Checkout" })).toMatchObject({ count: 1, items: [{ ref: "C-2" }] });
		expect(await h.call("find", { folder: "Refunds" })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
	});

	test("a mixed folder batch preserves nested moves, a rename chain, a swap and case placement", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "Nested", folder: "Source/Child/Leaf" },
				{ op: "create", outline: "Left case", folder: "Left/Inside" },
				{ op: "create", outline: "Right case", folder: "Right/Inside" },
				{ op: "create", outline: "Moving case", folder: "Destination" },
			],
		});
		expect(
			(
				await h.call<Proposed>("propose", {
					edits: [
						{ op: "folder", folder: "Source", name: "Interim" },
						{ op: "folder", folder: "Source/Child", parent: "Destination", name: "Moved" },
						{ op: "folder", folder: "Source", name: "Final" },
						{ op: "folder", folder: "Left", name: "Right" },
						{ op: "folder", folder: "Right", name: "Left" },
						{ op: "folder", name: "New", parent: "Final/Branch" },
						{ op: "place", cases: ["C-4"], folder: "Final/Branch/New" },
						{ op: "create", outline: "Created case", folder: "Destination/Moved/Leaf" },
					],
				})
			).status,
		).toBe("adopted");
		expect(
			(await h.call<CaseView[]>("get", { refs: ["C-1", "C-2", "C-3", "C-4", "C-5"] })).map((row) => ({
				title: row.title,
				folder: row.folder.path,
			})),
		).toEqual([
			{ title: "Nested", folder: "Destination/Moved/Leaf" },
			{ title: "Left case", folder: "Right/Inside" },
			{ title: "Right case", folder: "Left/Inside" },
			{ title: "Moving case", folder: "Final/Branch/New" },
			{ title: "Created case", folder: "Destination/Moved/Leaf" },
		]);
		expect(
			(await h.call<{ items: { path: string }[] }>("find", { in: "folders" })).items.map((row) => row.path).sort(),
		).toEqual([
			"Destination",
			"Destination/Moved",
			"Destination/Moved/Leaf",
			"Final",
			"Final/Branch",
			"Final/Branch/New",
			"Left",
			"Left/Inside",
			"Right",
			"Right/Inside",
		]);
	});

	test("path targets cannot pick an arbitrary folder while a batch swaps names", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "First", folder: "Checkout" },
				{ op: "create", outline: "Second", folder: "Refunds" },
			],
		});
		expect(
			await h.raw("propose", {
				edits: [
					{ op: "folder", folder: "Checkout", name: "Refunds" },
					{ op: "create", outline: "Ambiguous", folder: "Refunds/New" },
					{ op: "folder", folder: "Refunds", name: "Checkout" },
				],
			}),
		).toMatchObject({
			ok: false,
			error: {
				code: "invalid",
				message: 'folder path "Refunds" is ambiguous during the proposal; reorder the folder edits',
			},
		});
		expect(await h.call("find", { folder: "Checkout" })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
	});

	test.each([
		["move", "inbox"],
		["move", "read"],
		["move", "accept"],
		["create", "inbox"],
		["create", "read"],
		["create", "accept"],
		["place", "inbox"],
		["place", "read"],
		["place", "accept"],
	] as const)("a stored %s proposal handles %s when its target becomes ambiguous during replay", async (op, action) => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "First", folder: "Source" },
				{ op: "create", outline: "Second", folder: "Moving" },
			],
		});
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		await h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const policy = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
			.items[0];
		if (!policy) throw new Error("no policy question");
		await h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		const target: Edit =
			op === "move"
				? { op: "folder", folder: "Moving", parent: "Target" }
				: op === "create"
					? { op: "create", outline: "New case", folder: "Target/New" }
					: { op: "place", cases: ["C-2"], folder: "Target/New" };
		const pending = await h.call<Proposed>(
			"propose",
			{
				edits: [
					{ op: "folder", folder: "Source", name: "Target" },
					{ op: "folder", folder: "Moving", archive: false },
					target,
					{ op: "folder", folder: "Source", name: "Finished" },
				],
			},
			agent,
		);
		const question = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
			.items[0];
		if (!question) throw new Error("no folder question");
		expect(pending).toMatchObject({ status: "open", question: question.q });
		await h.call("propose", { edits: [{ op: "folder", folder: "Moving", name: "Target" }] });
		const ambiguity = 'folder path "Target" is ambiguous during the proposal; reorder the folder edits';
		if (action === "accept")
			expect(
				await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }),
			).toMatchObject([{ status: "invalid", needs: ambiguity }]);
		else if (action === "inbox")
			expect(await h.call("inbox", { kind: "adopt" })).toMatchObject({
				items: [
					{ q: question.q, state: "open", needs: `one member who is not an agent; accepting refused: ${ambiguity}` },
				],
			});
		else
			expect(await h.call("get", { refs: [question.q] })).toMatchObject([
				{ q: question.q, state: "open", needs: `one member who is not an agent; accepting refused: ${ambiguity}` },
			]);
		expect((await h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] })).map((row) => row.folder.path)).toEqual([
			"Source",
			"Target",
		]);
		expect(
			(
				await h.call<{ status: string }[]>("decide", {
					q: question.q,
					onEvidence: question.evidenceHash,
					answer: { is: "reject" },
				})
			)[0]?.status,
		).toBe("decided");
	});

	test.each([
		["ambiguity", "folder:secure"],
		["self-move", "folder:secure"],
		["ambiguity", "folder:b/secure"],
		["self-move", "folder:a/b/secure"],
		["ambiguity", "tag:guarded"],
		["self-move", "tag:guarded"],
		["ambiguity", "folder:fin/n"],
		["ambiguity", "folder:other/n"],
		["ambiguity", "folder:other/n/fin/n"],
		["ambiguity", "folder:fin/n/old"],
	] as const)(
		"a refused %s replay keeps policy facts for %s from later edits and every candidate",
		async (refusal, scope) => {
			await h.call("propose", {
				edits: ["A", "B", "C", "Secure", "C/Sub", ...(scope === "folder:fin/n/old" ? ["A/N"] : [])].map(
					(folder, i) => ({
						op: "create",
						outline: `Case ${i}${folder === "Secure" ? " #guarded" : ""}`,
						folder,
					}),
				),
			});
			await h.actor("approver", "human", ["read", "produce", "answer"]);
			await h.call("admin", {
				do: "grant.set",
				actor: "approver",
				project: "scratch",
				can: ["read", "produce", "answer"],
				roles: ["approver"],
			});
			const approver = await h.app.database.read(async (db) => await actorByName(db, "approver", 1));
			if (!approver) throw new Error("no approver");
			const clauses = [...PRESETS.standard.clauses];
			clauses.splice(
				clauses.findIndex((clause) => clause.id === "adopt-agent"),
				0,
				{
					id: "review-scope",
					kind: "adopt",
					when: ["author:agent", scope],
					ask: { who: "role:approver", agents: "none", notProducer: false, reason: "required" },
					blocks: "nothing",
				},
			);
			await h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
			const policy = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
				.items[0];
			if (!policy) throw new Error("no policy question");
			await h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
			const agent = await h.actor("writer", "agent", ["read", "produce"]);
			const pending = await h.call<Proposed>(
				"propose",
				{
					edits: [
						refusal === "ambiguity"
							? { op: "folder", folder: "A", name: "X" }
							: { op: "folder", folder: "A", parent: "B" },
						{ op: "create", outline: "New case", folder: "X/N" },
						{ op: "folder", folder: "Secure", parent: "B" },
						...(scope === "folder:fin/n/old"
							? ([
									{ op: "folder", folder: "A/N", name: "Old" },
									{ op: "create", outline: "Recreated child", folder: "X/N" },
									{ op: "folder", folder: "A/N", parent: "X/N" },
								] satisfies Edit[])
							: []),
						{ op: "folder", folder: "A", name: "Fin" },
						...(scope === "folder:other/n/fin/n"
							? ([
									{ op: "create", outline: "Other candidate", folder: "X/N" },
									{ op: "folder", folder: "A", parent: "X/N" },
								] satisfies Edit[])
							: []),
						...(scope.startsWith("folder:other/")
							? ([{ op: "folder", folder: "C", name: "Other" }] satisfies Edit[])
							: []),
					],
				},
				agent,
			);
			const ask = "a member with role approver who is not an agent with a reason";
			expect(await h.call("get", { refs: [pending.question] })).toMatchObject([
				{
					needs:
						scope === "folder:other/n" || scope === "folder:other/n/fin/n" || scope === "folder:a/b/secure"
							? "one member who is not an agent"
							: ask,
				},
			]);
			await h.call("propose", {
				edits: [
					refusal === "ambiguity"
						? { op: "folder", folder: "C", name: "X" }
						: { op: "folder", folder: "B", parent: "A" },
				],
			});
			const needs =
				refusal === "ambiguity"
					? `${ask}; accepting refused: folder path "X" is ambiguous during the proposal; reorder the folder edits`
					: ask;
			expect(await h.call("get", { refs: [pending.question] })).toMatchObject([{ state: "open", needs }]);
			const question = (
				await h.call<{ items: { q: string; evidenceHash: string; needs: string }[] }>("inbox", { kind: "adopt" })
			).items.find((item) => item.q === pending.question);
			if (!question) throw new Error("no folder question");
			expect(question.needs).toBe(needs);
			const member = await h.actor("plain", "human", ["read", "produce", "answer"]);
			expect(
				await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, member),
			).toMatchObject([{ status: "forbidden", needs: ask }]);
			expect(
				await h.call(
					"decide",
					{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } },
					approver,
				),
			).toMatchObject([{ status: "invalid", needs: "a reason" }]);
			expect(
				await h.call(
					"decide",
					{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" }, reason: "No longer needed" },
					approver,
				),
			).toMatchObject([{ status: "decided" }]);
		},
	);

	test.each([
		["union", "member"],
		["union", "rule"],
		["union", "role:auditor"],
		["union", "author"],
		["budget", "member"],
		["budget", "rule"],
	] as const)("a refused %s replay cannot select an earlier looser %s clause", async (shape, who) => {
		const chain = Array.from({ length: 16 }, (_, i) => `L${i}`);
		await h.call("propose", {
			edits: ["A", "C", ...(shape === "budget" ? [chain.join("/")] : [])].map((folder) => ({
				op: "create",
				outline: folder,
				folder,
			})),
		});
		await h.actor("approver", "human", ["read", "produce", "answer"]);
		await h.call("admin", {
			do: "grant.set",
			actor: "approver",
			project: "scratch",
			can: ["read", "produce", "answer"],
			roles: ["approver"],
		});
		const approver = await h.app.database.read(async (db) => await actorByName(db, "approver", 1));
		if (!approver) throw new Error("no approver");
		if (who === "role:auditor") {
			await h.actor("auditor", "human", ["read", "produce", "answer"]);
			await h.call("admin", {
				do: "grant.set",
				actor: "auditor",
				project: "scratch",
				can: ["read", "produce", "answer"],
				roles: ["auditor"],
			});
		}
		const clauses = [...PRESETS.standard.clauses];
		clauses.splice(
			clauses.findIndex((clause) => clause.id === "adopt-agent"),
			1,
			{
				id: "looser-folder",
				kind: "adopt",
				when: shape === "budget" ? ["folder:sandbox"] : ["folder:fin/n", "folder:other/n"],
				ask: { who, agents: "answer", notProducer: false, reason: "optional" },
				...(who === "rule" ? { answer: { is: "reject" } } : {}),
				blocks: "nothing",
			},
			{
				id: "stricter-catch-all",
				kind: "adopt",
				when: ["author:agent"],
				ask: { who: "role:approver", agents: "none", notProducer: false, reason: "required" },
				blocks: "nothing",
			},
		);
		await h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const policy = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
			.items[0];
		if (!policy) throw new Error("no policy question");
		await h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		const edits: Edit[] = [
			{ op: "folder", folder: "A", name: "X" },
			{ op: "create", outline: "New case", folder: "X/N" },
			...(shape === "budget"
				? chain.map(
						(name, i): Edit => ({
							op: "folder",
							folder: chain.slice(0, i + 1).join("/"),
							name: `${name}a`,
						}),
					)
				: []),
			{ op: "folder", folder: "A", name: "Fin" },
			...(shape === "union" ? ([{ op: "folder", folder: "C", name: "Other" }] satisfies Edit[]) : []),
		];
		const agent = await h.actor("writer", "agent", ["read", "produce", "answer"]);
		const pending = await h.call<Proposed>("propose", { edits }, agent);
		expect(pending.status).toBe("open");
		await h.call("propose", { edits: [{ op: "folder", folder: "C", name: "X" }] });
		const question = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
			.items[0];
		if (!question) throw new Error("no folder question");
		const member = await h.actor("plain", "human", ["read", "produce", "answer"]);
		const incompatible = who === "role:auditor" || who === "author";
		const ask = incompatible
			? "an admin who is not an agent with a reason"
			: "a member with role approver who is not an agent with a reason";
		expect(
			await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, member),
		).toMatchObject([{ status: "forbidden", needs: ask }]);
		expect(await h.call("get", { refs: [pending.question] })).toMatchObject([
			{
				state: "open",
				needs: `${ask}; accepting refused: folder path "X" is ambiguous during the proposal; reorder the folder edits`,
			},
		]);
		expect(
			await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, agent),
		).toMatchObject([{ status: "forbidden", needs: ask }]);
		expect(
			await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, approver),
		).toMatchObject([incompatible ? { status: "forbidden", needs: ask } : { status: "invalid", needs: "a reason" }]);
		await h.call("propose", { edits: [{ op: "folder", folder: "X", name: "Elsewhere" }] });
		expect(await h.call("get", { refs: [pending.question] })).toMatchObject([
			{ state: "open", needs: "a member with role approver who is not an agent with a reason" },
		]);
		await h.call("propose", { edits: [{ op: "folder", folder: "Elsewhere", name: "X" }] });
		expect(
			await h.call(
				"decide",
				{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" }, reason: "No longer needed" },
				incompatible ? undefined : approver,
			),
		).toMatchObject([{ status: "decided" }]);
	});

	test.each([
		["wide", 0, ""],
		["deep", 16, "a"],
		["deep", 12, "ab"],
	] as const)("a refused %s replay bounds candidate work at depth %i with renames %s", async (shape, depth, names) => {
		const chain = Array.from({ length: depth }, (_, i) => `L${i}`);
		const edits: Edit[] = [{ op: "folder", folder: "S", name: "X" }];
		let scope: string;
		if (shape === "wide") {
			await h.call("propose", {
				edits: Array.from({ length: 200 }, (_, i) => ({
					op: "create",
					outline: `Case ${i} #guarded`,
					folder: `F${i % 50}/G${i}`,
				})),
			});
			edits[0] = { op: "folder", folder: "F0", name: "X" };
			for (let i = 0; i < 998; i++) {
				if (i % 4 === 0) edits.push({ op: "create", outline: `N${i}`, folder: `X/N${i}` });
				else if (i % 4 === 1) edits.push({ op: "place", cases: [`C-${1 + (i % 200)}`], folder: `X/P${i % 50}` });
				else if (i % 4 === 2) edits.push({ op: "folder", name: `M${i}`, parent: `X/N${i - 2}` });
				else edits.push({ op: "folder", folder: `F${1 + (i % 49)}/G${1 + (i % 49)}`, name: `R${i}` });
			}
			edits.push({ op: "folder", folder: "F0", name: "Fin" });
			scope = "folder:fin/n0/m2";
		} else {
			await h.call("propose", {
				edits: [
					{ op: "create", outline: "Deep #guarded", folder: chain.join("/") },
					{ op: "create", outline: "Source", folder: "S" },
				],
			});
			edits.push({ op: "create", outline: "T", folder: "X/N" });
			for (let i = 0; i < chain.length; i++)
				for (const name of names)
					edits.push({ op: "folder", folder: chain.slice(0, i + 1).join("/"), name: `${chain[i]}${name}` });
			edits.push({ op: "create", outline: "Deep2", folder: "X/N/Q" }, { op: "folder", folder: "S", name: "Fin" });
			scope = `folder:${chain
				.map((name) => `${name}${names.at(-1)}`)
				.join("/")
				.toLowerCase()}`;
		}
		const clauses = [...PRESETS.standard.clauses];
		await h.actor("approver", "human", ["read", "produce", "answer"]);
		await h.call("admin", {
			do: "grant.set",
			actor: "approver",
			project: "scratch",
			can: ["read", "produce", "answer"],
			roles: ["approver"],
		});
		clauses.splice(
			clauses.findIndex((clause) => clause.id === "adopt-agent"),
			0,
			{
				id: "deep-review",
				kind: "adopt",
				when: ["author:agent", scope, "tag:guarded"],
				ask: { who: "role:approver", agents: "none", notProducer: false, reason: "required" },
				blocks: "nothing",
			},
		);
		await h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const policy = (await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }))
			.items[0];
		if (!policy) throw new Error("no policy question");
		await h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		const pending = await h.call<Proposed>("propose", { edits }, agent);
		expect(pending.status).toBe("open");
		await h.call("propose", { edits: [{ op: "folder", name: "X" }] });
		// Count actual path candidates, including duplicates, rather than elapsed time on a shared machine.
		const add = Set.prototype.add;
		let candidates = 0;
		const limit = 25_000 + 100 * edits.length;
		const spy = spyOn(Set.prototype, "add").mockImplementation(function (this: Set<unknown>, value: unknown) {
			if (typeof value === "string" && value.includes("/")) candidates++;
			return add.call(this, value);
		});
		let reply: Reply;
		try {
			reply = await h.raw("inbox", { kind: "adopt" });
		} finally {
			spy.mockRestore();
		}
		budget("folder path candidates", candidates, limit, "candidates");
		expect(reply).toMatchObject({
			ok: true,
			result: {
				items: [
					{
						q: pending.question,
						state: "open",
						needs:
							'a member with role approver who is not an agent with a reason; accepting refused: folder path "X" is ambiguous during the proposal; reorder the folder edits',
					},
				],
			},
		});
	});

	test.each(["\u200b", " \u200b "])("a folder name empty after cleaning is refused: %s", async (name) => {
		expect(await h.raw("propose", { edits: [{ op: "folder", name }] })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect((await h.call<{ items: unknown[] }>("find", { in: "folders" })).items.length).toBe(0);
	});

	test("canonical lookup reuses an existing NFD folder without rewriting it", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Café" }] });
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE folders SET name = $1 WHERE name = 'Café'"), ["Cafe\u0301"]),
				),
		);
		await h.call("propose", { edits: [{ op: "create", outline: "Second", folder: "Café" }] });
		expect((await h.call<{ items: unknown[] }>("find", { in: "folders" })).items.length).toBe(1);
		expect((await h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] })).map((view) => view.folder.path)).toEqual([
			"Cafe\u0301",
			"Cafe\u0301",
		]);
		for (const folder of ["Café", "Cafe\u0301", "Café\u200b"]) {
			expect((await h.call<{ items: { ref: string }[] }>("find", { folder })).items.map((item) => item.ref)).toEqual([
				"C-1",
				"C-2",
			]);
		}
	});

	test("the save is a recorded decision made by the policy's rule", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		const ledger = await h.call<{
			items: { kind: string; decision: { answer: { is: string }; rule: string | null; by: string[] } }[];
		}>("inbox", { state: "decided" });
		expect(ledger.items).toHaveLength(1);
		expect(ledger.items[0]?.decision).toMatchObject({ answer: { is: "accept" }, rule: "adopt-any", by: ["policy"] });
	});

	test("the same command twice writes once", async () => {
		const input = { edits: [{ op: "create", outline: "A case" }], cmd: "cmd-0000000001" };
		const first = await h.call<Proposed>("propose", input);
		const second = await h.call<Proposed>("propose", input);
		expect(second).toEqual(first);
		const count = async (table: string) =>
			(
				await h.app.database.read(
					async (db) => await db.get(sql<readonly SqlValue[], { n: number }>(`SELECT count(*) AS n FROM ${table}`), []),
				)
			)?.n;
		expect([await count("cases"), await count("versions"), await count("proposals"), await count("decisions")]).toEqual(
			[1, 1, 1, 1],
		);
		expect((await h.call<{ count: number }>("find", { in: "folders" })).count).toBe(1);
	});

	test("the canonical Markdown round-trips through the server", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		const [md] = await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" });
		expect(md?.md).toContain("## Steps");
		const again = await h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, md: md?.md }] });
		expect(again.proposal).toBeNull(); // nothing changed, so nothing was proposed
	});

	test("a Markdown edit without a fields header preserves free-form values", async () => {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Original", fields: { legacy: "Keep me" } } }] });
		const reply = await h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: "---\ntitle: Edited\n---\n## Steps\n" }],
		});
		expect(reply.status).toBe("adopted");
		expect(await storedBody()).toMatchObject({
			title: "Edited",
			fields: { legacy: "Keep me" },
		});
	});

	test.each([
		["fields:", {}],
		["fields: {}", {}],
		["fields:\n  risk: low", { risk: "low" }],
	])("a Markdown edit with %s replaces the field map", async (header, fields) => {
		await h.call("propose", {
			edits: [{ op: "create", body: { title: "Original", fields: { risk: "high", legacy: "Keep me" } } }],
		});
		const reply = await h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: `---\ntitle: Edited\n${header}\n---\n## Steps\n` }],
		});
		expect(reply.status).toBe("adopted");
		expect((await storedBody()).fields).toEqual(fields);
	});

	test("a stale Markdown edit without fields merges a concurrent field change", async () => {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Original", fields: { risk: "high" } } }] });
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { fields: { risk: "low" } } }] });
		const reply = await h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: "---\ntitle: Edited\n---\n## Steps\n" }],
		});
		expect(reply.status).toBe("adopted");
		expect(reply.conflicts).toEqual([]);
		expect(reply.cases[0]?.version).toBe(3);
		expect(await storedBody()).toMatchObject({
			title: "Edited",
			fields: { risk: "low" },
		});
	});
});

describe("editing", () => {
	beforeEach(async () => {
		await h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
	});
	const steps = async () => (await h.call<CaseView[]>("get", { refs: ["C-1"] }))[0]?.steps ?? [];

	test("an edit is version 2 and the diff is by step", async () => {
		const next = (await steps()).map((s, i) =>
			i === 1 ? { ...s, expected: "Total shows $90.00 (10% off $100.00)" } : s,
		);
		const reply = await h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { steps: next } }],
			reason: "be exact",
		});
		expect(reply.cases[0]).toMatchObject({ ref: "C-1", version: 2 });
		const diff = await h.call<{ summary: string }>("history", { ref: "C-1", from: 1, to: 2 });
		expect(diff.summary).toContain("expected");
		const list = await h.call<{ versions: { version: number; reason: string | null; summary: string }[] }>("history", {
			ref: "C-1",
		});
		expect(list.versions.map((v) => v.version)).toEqual([2, 1]);
		expect(list.versions[0]?.reason).toBe("be exact");
	});

	test("two edits to different fields on the same base merge", async () => {
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon: percentage" } }] });
		const mine = (await steps()).map((s, i) => (i === 0 ? { ...s, action: "Open the cart with one $200.00 item" } : s));
		const reply = await h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { steps: mine } }],
		});
		expect(reply.status).toBe("adopted");
		const [view] = await h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect(view?.version).toBe(3);
		expect(view?.title).toBe("Coupon: percentage");
		expect(view?.steps[0]?.action).toBe("Open the cart with one $200.00 item");
	});

	test("two edits to the same field conflict: nothing is overwritten and the author resolves it", async () => {
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Theirs" } }] });
		const reply = await h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }],
		});
		expect(reply.status).toBe("conflict");
		expect(reply.conflicts).toEqual([{ case: "C-1", addresses: [{ kind: "field", name: "title" }] }]);
		expect((await h.call<CaseView[]>("get", { refs: ["C-1"] }))[0]?.title).toBe("Theirs");

		const queue = await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox");
		const q = queue.items[0];
		expect(q?.q).toBe(reply.question ?? "");
		const refused = await h.call<{ status: string }[]>("decide", {
			q: q?.q,
			onEvidence: q?.evidenceHash,
			answer: { is: "accept" },
		});
		expect(refused[0]).toMatchObject({
			status: "invalid",
			needs: "one of merge, reject: `accept` does not apply to this proposal",
		});
		const body = {
			title: "Mine and theirs",
			pre: "",
			steps: await steps(),
			methods: ["human"],
			automate: "none",
			fields: {},
		};
		const merged = await h.call<{ status: string }[]>("decide", {
			q: q?.q,
			onEvidence: q?.evidenceHash,
			answer: { is: "merge", body },
		});
		expect(merged[0]?.status).toBe("decided");
		expect((await h.call<CaseView[]>("get", { refs: ["C-1"] }))[0]).toMatchObject({
			title: "Mine and theirs",
			version: 3,
		});
	});

	test("a proposal read after its case moved shows the body that accepting it writes", async () => {
		const s = await harness({ preset: "standard" });
		try {
			await s.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
			const agent = await s.actor("writer", "agent", ["read", "produce"]);
			const proposed = await s.call<Proposed>(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon: percentage" } }] },
				agent,
			);
			expect(proposed.status).toBe("open");
			await s.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "Signed in as robin" } }] });
			const [read] = await s.call<{ edits: { head: number; body: { title: string; pre: string } }[] }[]>("get", {
				refs: [proposed.proposal],
			});
			expect(read?.edits[0]).toMatchObject({
				head: 2,
				body: { title: "Coupon: percentage", pre: "Signed in as robin" },
			});
			const [question] = await s.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
			await s.call("decide", { q: proposed.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } });
			expect((await s.call<CaseView[]>("get", { refs: ["C-1"] }))[0]).toMatchObject({
				version: 3,
				title: "Coupon: percentage",
				pre: "Signed in as robin",
			});
		} finally {
			await s.close();
		}
	});

	test("a proposal read pages all 250 edits without hiding the last 50", async () => {
		const edits = Array.from({ length: 250 }, (_, i) => ({ op: "create", outline: `Case ${i}` }));
		const s = await harness({ preset: "standard" });
		try {
			const agent = await s.actor("writer", "agent", ["read", "produce"]);
			const proposed = await s.call<Proposed>("propose", { edits }, agent);
			type Page = { count: number; cursor: string | null; edits: { body: { title: string } }[] };
			const [read] = await s.call<Page[]>("get", { refs: [proposed.proposal] });
			expect([read?.count, read?.edits.length]).toEqual([250, 200]);
			expect(typeof read?.cursor).toBe("string");
			const [last] = await s.call<Page[]>("get", { refs: [proposed.proposal], cursor: read?.cursor });
			expect([last?.count, last?.edits.length, last?.cursor]).toEqual([250, 50, null]);
			expect([read?.edits[0]?.body.title, last?.edits[0]?.body.title, last?.edits.at(-1)?.body.title]).toEqual([
				"Case 0",
				"Case 200",
				"Case 249",
			]);
			for (const cursor of ["bad", read?.cursor?.replace(/^\d+/, "999")]) {
				await expect(s.call("get", { refs: [proposed.proposal], cursor })).rejects.toThrow(
					"that is not a cursor of this proposal",
				);
			}
			await expect(
				s.call("get", { refs: [proposed.proposal, proposed.proposal], cursor: read?.cursor }),
			).rejects.toThrow("a proposal cursor needs exactly one P- ref");
			await s.call("propose", { edits: [{ op: "create", outline: "New case" }] });
			await expect(s.call("get", { refs: [proposed.proposal], cursor: read?.cursor })).rejects.toThrow(
				"The project changed. Read the proposal again from its first page.",
			);
		} finally {
			await s.close();
		}
	});

	test("a proposal read names the case a move asks to follow, and ranking places it by the guide's rule", async () => {
		const s = await harness({ preset: "standard" });
		try {
			await s.call("propose", {
				edits: [
					{ op: "create", outline: "One", folder: "A" },
					{ op: "create", outline: "Two", folder: "A" },
					{ op: "create", outline: "Three", folder: "B" },
					{ op: "create", outline: "Four", folder: "B" },
				],
			});
			const agent = await s.actor("writer", "agent", ["read", "produce"]);
			const proposed = await s.call<Proposed>(
				"propose",
				{
					edits: [
						{ op: "place", cases: ["C-3"], folder: "A", after: "C-1" },
						// C-3 is in A once the edit before it is applied, so C-4 lands after it.
						{ op: "place", cases: ["C-4"], folder: "A", after: "C-3" },
						// A case placed after itself goes to the end of its folder.
						{ op: "place", cases: ["C-2"], after: "C-2" },
						// An anchor in another folder puts the case at the end too.
						{ op: "place", cases: ["C-1"], folder: "B", after: "C-2" },
					],
				},
				agent,
			);
			expect(proposed.status).toBe("open");
			const [read] = await s.call<{ edits: { after?: string }[] }[]>("get", { refs: [proposed.proposal] });
			expect(read?.edits.map((edit) => edit.after)).toEqual(["C-1", "C-3", "C-2", "C-2"]);
			const [question] = await s.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
			await s.call("decide", { q: proposed.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } });
			const order = async (folder: string) =>
				(await s.call<{ items: { ref: string }[] }>("find", { in: "cases", folder })).items.map((item) => item.ref);
			expect([await order("A"), await order("B")]).toEqual([["C-3", "C-4", "C-2"], ["C-1"]]);
		} finally {
			await s.close();
		}
	});

	test("a move after a folder edit, and a move with its anchor, land by the guide's rule", async () => {
		const s = await harness({ preset: "standard" });
		try {
			await s.call("propose", {
				edits: [
					{ op: "create", outline: "One", folder: "A" },
					{ op: "create", outline: "Two", folder: "A" },
					{ op: "create", outline: "Three", folder: "B" },
					{ op: "create", outline: "Four", folder: "B" },
					{ op: "create", outline: "Five", folder: "B" },
				],
			});
			const agent = await s.actor("writer", "agent", ["read", "produce"]);
			const proposed = await s.call<Proposed>(
				"propose",
				{
					edits: [
						// Once A is renamed, "Renamed" is A, so C-3 lands after C-1 there.
						{ op: "folder", folder: "A", name: "Renamed" },
						{ op: "place", cases: ["C-3"], folder: "Renamed", after: "C-1" },
						// C-5 moves with C-4, its anchor, so the two land where C-5 stood.
						{ op: "place", cases: ["C-4", "C-5"], after: "C-5" },
					],
				},
				agent,
			);
			const [read] = await s.call<{ edits: { after?: string }[] }[]>("get", { refs: [proposed.proposal] });
			expect(read?.edits.map((edit) => edit.after)).toEqual([undefined, "C-1", "C-5"]);
			const [question] = await s.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
			await s.call("decide", { q: proposed.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } });
			const order = async (folder: string) =>
				(await s.call<{ items: { ref: string }[] }>("find", { in: "cases", folder })).items.map((item) => item.ref);
			expect([await order("Renamed"), await order("B")]).toEqual([
				["C-1", "C-3", "C-2"],
				["C-4", "C-5"],
			]);
		} finally {
			await s.close();
		}
	});

	test("cases from two folders moved together each go where the guide says in their own folder", async () => {
		for (const after of [null, "C-1"]) {
			const s = await harness();
			try {
				await s.call("propose", {
					edits: [
						{ op: "create", outline: "One", folder: "A" },
						...["Two", "Three", "Four", "Five", "Six"].map((title) => ({
							op: "create",
							outline: title,
							folder: "B",
						})),
					],
				});
				await s.call("propose", { edits: [{ op: "place", cases: ["C-1", "C-2"], after }] });
				const order = async (folder: string) =>
					(await s.call<{ items: { ref: string }[] }>("find", { in: "cases", folder })).items.map((item) => item.ref);
				// C-1 is the only case in A. C-1 is not in B, so C-2 goes to the end of B: a rank made in A does not
				// place a case in B.
				expect([await order("A"), await order("B")]).toEqual([["C-1"], ["C-3", "C-4", "C-5", "C-6", "C-2"]]);
			} finally {
				await s.close();
			}
		}
	});

	test("a proposal that moves two folders into each other can be read and rejected", async () => {
		const s = await harness({ preset: "standard" });
		try {
			await s.call("propose", {
				edits: [
					{ op: "create", outline: "One", folder: "A" },
					{ op: "create", outline: "Two", folder: "B" },
				],
			});
			const agent = await s.actor("writer", "agent", ["read", "produce"]);
			const proposed = await s.call<Proposed>(
				"propose",
				{
					edits: [
						{ op: "folder", folder: "A", parent: "B" },
						{ op: "folder", folder: "B", parent: "A" },
						{ op: "place", cases: ["C-2"], folder: "Missing" },
					],
				},
				agent,
			);
			const [read] = await s.call<{ edits: unknown[] }[]>("get", { refs: [proposed.proposal] });
			expect(read?.edits).toHaveLength(3);
			const [question] = await s.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
			const [reply] = await s.call<{ status: string }[]>("decide", {
				q: proposed.question,
				onEvidence: question?.evidenceHash,
				answer: { is: "reject" },
			});
			expect(reply?.status).toBe("decided");
		} finally {
			await s.close();
		}
	});

	test("restore makes a new version and keeps the history", async () => {
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Changed" } }] });
		const reply = await h.call<Proposed>("propose", { edits: [{ op: "restore", case: "C-1", to: 1 }] });
		expect(reply.cases[0]).toMatchObject({ version: 3 });
		const [view] = await h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect(view?.title).toBe("Checkout applies a percentage coupon");
		const first = (await h.call<CaseView[]>("get", { refs: ["C-1"], version: 1 }))[0];
		expect(view?.hash).toBe(first?.hash ?? "");
	});
});

describe("a proposal that waits while its case moves on", () => {
	type Read = {
		edits: { body: { title: string; steps: { id: string }[] }; current: { title: string }; refused: string | null }[];
	};
	let agent: Awaited<ReturnType<Harness["actor"]>>;
	beforeEach(async () => {
		await h.close();
		h = await harness({ preset: "standard" });
		await h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		agent = await h.actor("helper", "agent", ["read", "produce"]);
	});
	const proposeAsAgent = async (body: Record<string, unknown>) => {
		const waiting = await h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body }] }, agent);
		expect(waiting.status).toBe("open");
		return waiting;
	};
	const retitle = async (title: string, base: number) =>
		await h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base, body: { title } }] });
	const read = async (proposal: string | null) => (await h.call<Read[]>("get", { refs: [proposal] }))[0]?.edits[0];
	const accept = async (question: string | null) => {
		const [item] = await h.call<{ evidenceHash: string }[]>("get", { refs: [question] });
		return (
			await h.call<{ status: string; needs: string | null }[]>("decide", {
				q: question,
				onEvidence: item?.evidenceHash,
				answer: { is: "accept" },
			})
		)[0];
	};

	test("reads as what accepting it writes: merged with the newer version, as the merge on accepting does", async () => {
		const [view] = await h.call<CaseView[]>("get", { refs: ["C-1"] });
		const reordered = [...(view?.steps ?? [])].reverse();
		const waiting = await proposeAsAgent({ steps: reordered });
		await retitle("Updated by a person", 1);

		const edit = await read(waiting.proposal);
		expect(edit?.current.title).toBe("Updated by a person");
		expect(edit?.body.title).toBe("Updated by a person");
		expect(edit?.body.steps.map((step) => step.id)).toEqual(reordered.map((step) => step.id));
		expect(edit?.refused).toBeNull();

		expect((await accept(waiting.question))?.status).toBe("decided");
		const [accepted] = await h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect({ title: accepted?.title, steps: accepted?.steps.map((step) => step.id) }).toEqual({
			title: edit?.body.title,
			steps: edit?.body.steps.map((step) => step.id),
		});
	});

	test("says that accepting is refused, in the words accepting refuses with, when the newer version cannot merge", async () => {
		const waiting = await proposeAsAgent({ title: "Retitled by the agent" });
		await retitle("Retitled by a person", 1);
		const refusal = "C-1 changed after this proposal was made; redo the proposal on version 2";
		// Refused, the edit is shown as it was proposed.
		expect(await read(waiting.proposal)).toMatchObject({ refused: refusal, body: { title: "Retitled by the agent" } });
		expect(await accept(waiting.question)).toMatchObject({ status: "conflict", needs: refusal });
	});

	test("says that accepting is refused when the body no longer meets the policy's field definitions", async () => {
		const setFields = async (choices: string[]) => {
			const policy = await h.call<{ version: number; settings: Record<string, unknown> }>("admin", {
				do: "policy.show",
				project: "scratch",
			});
			const fields = { risk: { kind: "choice", label: "Risk", required: false, choices } };
			const reply = await h.call<Proposed>("propose", {
				edits: [{ op: "policy", base: policy.version, settings: { ...policy.settings, fields } }],
			});
			if (reply.question) expect((await accept(reply.question))?.status).toBe("decided");
		};
		await setFields(["low", "high"]);
		const waiting = await proposeAsAgent({ fields: { risk: "high" } });
		await setFields(["low"]);
		const refusal = (await read(waiting.proposal))?.refused;
		expect(refusal).toStartWith("case custom fields are not valid:");
		expect(await accept(waiting.question)).toMatchObject({ status: "invalid", needs: refusal });
	});

	test("reads each edit on its own, so a proposal whose edits refuse each other reads clean and accepting refuses it", async () => {
		const waiting = await h.call<Proposed>(
			"propose",
			{
				edits: [
					{ op: "edit", case: "C-1", base: 1, body: { title: "First" } },
					{ op: "edit", case: "C-1", base: 1, body: { title: "Second" } },
				],
			},
			agent,
		);
		expect(waiting.status).toBe("open");
		const [proposal] = await h.call<Read[]>("get", { refs: [waiting.proposal] });
		expect(proposal?.edits.map((edit) => [edit.body.title, edit.refused])).toEqual([
			["First", null],
			["Second", null],
		]);
		// Accepting applies them in order: the second meets a version the first made. The answer says so.
		expect(await accept(waiting.question)).toMatchObject({
			status: "conflict",
			needs: "C-1 changed after this proposal was made; redo the proposal on version 2",
		});
	});

	test("once decided, reads as it was proposed: a later version adds nothing to it and refuses nothing", async () => {
		const waiting = await proposeAsAgent({ title: "Retitled by the agent" });
		expect((await accept(waiting.question))?.status).toBe("decided");
		await retitle("Retitled again", 2);
		expect(await read(waiting.proposal)).toMatchObject({
			body: { title: "Retitled by the agent" },
			current: { title: "Retitled again" },
			refused: null,
		});
	});
});

describe("organising", () => {
	test("a bulk move and retag of 300 cases is one proposal, one decision, one point on the clock", async () => {
		const edits = Array.from({ length: 300 }, (_, i) => ({ op: "create", outline: `Case ${i}`, folder: "inbox" }));
		await h.call("propose", { edits });
		const cases = Array.from({ length: 300 }, (_, i) => `C-${i + 1}`);
		const count = async (table: string) =>
			(
				await h.app.database.read(
					async (db) => await db.get(sql<readonly SqlValue[], { n: number }>(`SELECT count(*) AS n FROM ${table}`), []),
				)
			)?.n ?? 0;
		const proposals = await count("proposals");
		const decisions = await count("decisions");
		const before =
			(
				await h.app.database.read(
					async (db) => await db.get(sql<readonly SqlValue[], { seq: number }>("SELECT seq FROM projects"), []),
				)
			)?.seq ?? 0;
		const reply = await h.call<Proposed>("propose", {
			edits: [{ op: "place", cases, folder: "checkout/regression", tags: { add: ["regression"] } }],
		});
		expect(reply.status).toBe("adopted");
		const after =
			(
				await h.app.database.read(
					async (db) => await db.get(sql<readonly SqlValue[], { seq: number }>("SELECT seq FROM projects"), []),
				)
			)?.seq ?? 0;
		expect(after).toBe(before + 1);
		expect([(await count("proposals")) - proposals, (await count("decisions")) - decisions]).toEqual([1, 1]);
		const found = await h.call<{ items: { ref: string; tags: string[] }[] }>("find", {
			folder: "checkout/regression",
			limit: 500,
		});
		expect(found.items).toHaveLength(300);
		expect(found.items.map((c) => c.ref)).toEqual(cases); // order kept
		expect(found.items.every((c) => c.tags.includes("regression"))).toBe(true);
		const versions = (
			await h.app.database.read(
				async (db) => await db.get(sql<readonly SqlValue[], { n: number }>("SELECT count(*) AS n FROM versions"), []),
			)
		)?.n;
		expect(versions).toBe(300); // a move is history, not a new version
	});

	test("search finds by word and prefix, and by ref", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: OUTLINE },
				{ op: "create", outline: "Login rejects an expired password\n  Enter the old password > Error shown" },
			],
		});
		const byWord = await h.call<{ items: { ref: string }[] }>("find", { text: "coupon" });
		expect(byWord.items.map((c) => c.ref)).toEqual(["C-1"]);
		const byPrefix = await h.call<{ items: { ref: string }[] }>("find", { text: "expired pass" });
		expect(byPrefix.items.map((c) => c.ref)).toEqual(["C-2"]);
		expect((await h.call<{ items: { ref: string }[] }>("find", { text: "C-2" })).items[0]?.ref).toBe("C-2");
		expect((await h.call<{ items: unknown[] }>("find", { text: '"*) OR 1=1 --' })).items).toEqual([]);
		await h.call("propose", {
			edits: [
				{ op: "create", folder: "Ranked", tags: ["ranked"], outline: "Needle\n  Check > Good" },
				{ op: "create", folder: "Ranked", tags: ["ranked"], outline: "Other\n  Needle needle needle needle > Good" },
			],
		});
		for (const scope of [{}, { folder: "Ranked" }, { tags: ["ranked"] }]) {
			const ranked = await h.call<{ items: { ref: string }[] }>("find", { text: "needle", ...scope });
			expect(ranked.items.map((item) => item.ref)).toEqual(["C-3", "C-4"]);
		}
	});

	test("a search by ref keeps to the folder, the tags and the state it is narrowed by", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", folder: "Checkout", tags: ["checkout"], outline: "Coupon applies\n  Apply > Lower" },
				{ op: "create", folder: "Accounts", outline: "Password resets\n  Reset > Access" },
			],
		});
		const refs = async (input: Record<string, unknown>) =>
			(await h.call<{ items: { ref: string }[] }>("find", input)).items.map((c) => c.ref);
		expect(await refs({ text: "C-1", folder: "Checkout" })).toEqual(["C-1"]);
		expect(await refs({ text: "C-2", folder: "Checkout" })).toEqual([]);
		expect(await refs({ text: "2", folder: "Checkout", deep: true })).toEqual([]);
		expect(await refs({ text: "C-2", tags: ["checkout"] })).toEqual([]);
		expect(await refs({ text: "C-1", tags: ["checkout"] })).toEqual(["C-1"]);
		expect(await refs({ text: "C-2", state: "archived" })).toEqual([]);
		expect(await refs({ text: "C-2" })).toEqual(["C-2"]);
	});

	test("a search too broad to rank is bounded: newest first, title matches first, and it says the count is unknown", async () => {
		const batch = (from: number, n: number) =>
			Array.from({ length: n }, (_, i) => ({ op: "create", outline: `Common thing ${from + i}\n  Step > Result` }));
		await h.call("propose", { edits: batch(0, 1100) });
		await h.call("propose", { edits: batch(1100, 1000) });
		await h.call("propose", { edits: [{ op: "create", outline: "Rare needle\n  A common step > Result" }] });
		const broad = await h.call<{
			count: number | null;
			cursor: string | null;
			items: { ref: string; title: string }[];
		}>("find", {
			text: "common",
			limit: 5,
		});
		expect(broad.count).toBeNull(); // more than can be ranked: the caller is told the number is not known
		expect(broad.items.map((c) => c.ref)).toEqual(["C-2100", "C-2099", "C-2098", "C-2097", "C-2096"]); // in the title, newest first
		// Its order holds only for what one page reads, so it has no next page: a cursor into it reads nothing more.
		expect(broad.cursor).toBeNull();
		expect(await h.call("find", { text: "common", limit: 5, cursor: "5" })).toMatchObject({
			items: [],
			cursor: null,
			count: null,
		});
		const narrow = await h.call<{ count: number | null; items: { ref: string }[] }>("find", { text: "common needle" });
		expect(narrow).toMatchObject({ count: 1, items: [{ ref: "C-2101" }] });
		const ranked = await h.call<{ count: number | null; items: { ref: string }[] }>("find", { text: "thing 1500" });
		expect(ranked.count).toBe(1);
	});

	test("a search's count and its pages do not depend on the page size", async () => {
		await h.call("propose", {
			edits: Array.from({ length: 600 }, (_, i) => ({ op: "create", outline: `Needle ${i}\n  Step > Result` })),
		});
		type Page = { count: number | null; cursor: string | null; items: { ref: string }[] };
		for (const limit of [50, 100, 200]) {
			const refs: string[] = [];
			let page = await h.call<Page>("find", { text: "needle", limit });
			expect(page.count).toBe(600);
			refs.push(...page.items.map((c) => c.ref));
			while (page.cursor) {
				page = await h.call<Page>("find", { text: "needle", limit, cursor: page.cursor });
				expect(page.count).toBe(600);
				refs.push(...page.items.map((c) => c.ref));
			}
			expect(refs).toHaveLength(600);
			expect(new Set(refs).size).toBe(600);
		}
		// Narrowed by a tag the cases do not have: the count is of what qualifies, not of what matches.
		expect(await h.call<Page>("find", { text: "needle", tags: ["absent"], limit: 50 })).toMatchObject({
			count: 0,
			cursor: null,
			items: [],
		});
		expect(await h.raw("find", { text: "needle", cursor: "3:abc" })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
	});

	test("archiving hides a case from lists and keeps it readable", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		await h.call("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		expect((await h.call<{ items: unknown[] }>("find", {})).items).toEqual([]);
		expect((await h.call<{ state: string }[]>("get", { refs: ["C-1"] }))[0]?.state).toBe("archived");
	});

	test("archived search matches cannot hide the active match or change its count", async () => {
		for (const [from, length] of [
			[0, 1100],
			[1100, 1001],
		] as const) {
			await h.call("propose", {
				edits: Array.from({ length }, (_, i) => ({
					op: "create",
					folder: "Regression",
					outline: `Checkout common ${from + i}\n  Check > Pass`,
				})),
			});
		}
		await h.call("propose", {
			edits: [{ op: "state", cases: Array.from({ length: 2100 }, (_, i) => `C-${i + 2}`), to: "archived" }],
		});
		type Page = { count: number | null; cursor: string | null; items: { ref: string }[] };
		for (const limit of [5, 50, 200]) {
			for (const scope of [{}, { folder: "Regression" }, { state: "active" }]) {
				const found = await h.call<Page>("find", { text: "common", limit, ...scope });
				expect(found.items.map((item) => item.ref)).toEqual(["C-1"]);
				expect(found.count).toBe(1);
				expect(found.cursor).toBeNull();
			}
		}
		expect(await h.call<Page>("find", { limit: 5 })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
		expect(await h.call("plan", { name: "Search regression", select: { text: "common" } })).toMatchObject({ slots: 1 });
		expect(await h.call<Page>("find", { text: "common", state: "archived", limit: 5 })).toMatchObject({
			count: null,
			items: [{ ref: "C-2101" }, { ref: "C-2100" }, { ref: "C-2099" }, { ref: "C-2098" }, { ref: "C-2097" }],
		});
	});

	test.each(["data", "md"] as const)(
		"conditional %s case reads refresh changed tags, coverage and state",
		async (as) => {
			await h.call("propose", { edits: [{ op: "create", outline: "Checkout #smoke @REQ-1\n  Check > Pass" }] });
			type Document = { hash: string; etag?: string; md?: string; tags?: string[]; covers?: string[]; state?: string };
			const before = (await h.call<Document[]>("get", { refs: ["C-1"], as }))[0];
			if (!before) throw new Error("missing case");
			await h.call("propose", {
				edits: [
					{ op: "place", cases: ["C-1"], tags: { set: ["critical"] } },
					{ op: "cover", case: "C-1", requirement: "REQ-2", on: true },
					{ op: "state", cases: ["C-1"], to: "archived" },
				],
			});
			const conditional = await h.call<Document[]>("get", {
				refs: ["C-1"],
				as,
				unless: { "C-1": before.etag ?? before.hash },
			});
			if (as === "md") {
				expect(conditional[0]?.md).toContain("tags: [critical]");
				expect(conditional[0]?.md).toContain("covers: [REQ-1, REQ-2]");
			} else {
				expect(conditional[0]).toMatchObject({ tags: ["critical"], covers: ["REQ-1", "REQ-2"], state: "archived" });
			}
			expect(conditional).toEqual(await h.call("get", { refs: ["C-1"], as }));
		},
	);

	test("a document etag covers each requested field and keeps the body hash for reviews", async () => {
		await h.call("propose", {
			edits: [{ op: "create", folder: "Regression", outline: "Checkout #smoke @REQ-1\n  Check > Pass" }],
		});
		const read = async (input = {}) => {
			const [doc] = await h.call<Record<string, unknown>[]>("get", { refs: ["C-1"], ...input });
			if (!doc) throw new Error("missing case");
			return doc;
		};
		const created = await read();
		for (const [edit, expected] of [
			[{ op: "place", cases: ["C-1"], tags: { set: ["critical"] } }, { tags: ["critical"] }],
			[{ op: "cover", case: "C-1", requirement: "REQ-2", on: true }, { covers: ["REQ-1", "REQ-2"] }],
			[{ op: "place", cases: ["C-1"], folder: "Moved" }, { folder: { path: "Moved" } }],
			[{ op: "folder", folder: "Moved", name: "Renamed" }, { folder: { path: "Renamed" } }],
			[{ op: "state", cases: ["C-1"], to: "archived" }, { state: "archived" }],
		] as const) {
			const before = await read();
			expect(await read({ unless: { "C-1": before.etag } })).toEqual({
				ref: "C-1",
				unchanged: true,
				hash: created.hash,
				etag: before.etag,
			});
			await h.call("propose", { edits: [edit] });
			const changed = await read({ unless: { "C-1": before.etag } });
			expect(changed).toMatchObject(expected);
			expect(changed.hash).toBe(created.hash);
			expect(changed.etag).not.toBe(before.etag);
		}
		const beforeEdit = await read();
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Changed checkout" } }] });
		expect(await read({ unless: { "C-1": beforeEdit.etag } })).toMatchObject({ title: "Changed checkout", version: 2 });
		const titleOnly = await read({ fields: ["title"] });
		expect(await read({ fields: ["title"], unless: { "C-1": titleOnly.etag } })).toMatchObject({ unchanged: true });
		expect(await read({ unless: { "C-1": titleOnly.etag } })).toMatchObject({
			tags: ["critical"],
			covers: ["REQ-1", "REQ-2"],
		});
		expect(await read({ as: "md", unless: { "C-1": (await read()).etag } })).toMatchObject({
			md: expect.stringContaining("Changed checkout"),
		});
		expect(await read({ version: 1, unless: { "C-1": created.etag } })).toMatchObject({
			title: "Checkout",
			version: 1,
		});
		expect(await read({ unless: { "C-1": (await read()).hash } })).toMatchObject({ title: "Changed checkout" });
	});

	test.each(["human", "ci", "agent"] as const)(
		"%s proof returns the selected result's identity in get and find",
		async (kind) => {
			await h.call("propose", {
				edits: [{ op: "create", body: { title: "Checkout", methods: ["human", "auto", "agent"] } }],
			});
			const method = kind === "ci" ? "auto" : kind;
			const author = await h.actor("proof-author", kind, ["read", "record"]);
			const other = await h.actor("later-author", kind, ["read", "record"]);
			const report = async (run: string, as: typeof author) =>
				await h.call(
					"report",
					{
						run,
						...(kind === "agent" ? { model: "example-model" } : {}),
						results: [{ test: { case: "C-1" }, outcome: "pass" }],
					},
					as,
				);
			await h.call("plan", { name: "First", select: {} });
			await report("R-1", author);
			const original = z
				.object({ id: z.number(), name: z.string().nullable(), at: z.number() })
				.parse(
					(await h.call<{ entries: Record<string, unknown>[] }>("timeline", { ref: "C-1" })).entries.find(
						(entry) => entry.t === "result",
					),
				);
			const read = async () => {
				const [doc] = await h.call<Record<string, unknown>[]>("get", { refs: ["C-1"], fields: ["proof"] });
				return Proofs.parse(doc?.proof)[method];
			};
			expect(await read()).toEqual({
				id: original.id,
				version: 1,
				by: "proof-author",
				method,
				model: kind === "agent" ? "example-model" : null,
				name: original.name,
				outcome: "pass",
				at: original.at,
				current: true,
				basis: "exact",
			});
			await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Updated" } }] });
			expect(await read()).toMatchObject({ id: original.id, version: 1, by: "proof-author", current: false });
			const found = (await h.call<{ items: Record<string, unknown>[] }>("find", { in: "cases" })).items[0];
			expect(Proofs.parse(found?.proof)[method]).toEqual(await read());
			await h.call("plan", { name: "Second", select: {} });
			await report("R-2", other);
			expect(await read()).toMatchObject({ version: 2, by: "later-author", current: true, basis: "exact" });
			expect((await read())?.id).not.toBe(original.id);
		},
	);

	test("conditional data reads refresh proof without a body edit", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout\n  Check > Pass" }] });
		const [before] = await h.call<{ etag: string; hash: string }[]>("get", { refs: ["C-1"] });
		if (!before) throw new Error("missing case");
		await h.call("plan", { name: "Smoke", select: { cases: ["C-1"] } });
		await h.call("report", { run: "R-1", results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(await h.call("get", { refs: ["C-1"], unless: { "C-1": before.etag } })).toMatchObject([
			{ hash: before.hash, title: "Checkout", proof: { human: { outcome: "pass", current: true } } },
		]);
	});
});

test("a sliced savepoint closed early rolls back and drops the after-commit work it queued", async () => {
	const ran: string[] = [];
	await h.app.database.write(async (db) => {
		await db.transaction(async () => {
			await db.exec("CREATE TEMP TABLE t (x bigint) ON COMMIT DROP");
			db.afterCommit(() => {
				ran.push("before");
			});
			const steps = db.savepointSteps(async function* () {
				await db.exec("INSERT INTO t VALUES (1)");
				db.afterCommit(() => {
					ran.push("inside");
				});
				yield;
				return 1;
			});
			await steps.next();
			await steps.return(undefined as never);
			expect(await db.one(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM t"))).toEqual({ n: 0 });
		});
		expect(ran).toEqual(["before"]);
		await db.transaction(() =>
			db.afterCommit(() => {
				ran.push("next");
			}),
		);
	});
	expect(ran).toEqual(["before", "next"]);
});

test("choosing current restores a deleted step named order through the registry", async () => {
	const base = { ...emptyBody("Order step"), steps: [{ id: "order", action: "Before", expected: null }] };
	const current = { ...base, steps: [{ id: "order", action: "Current change", expected: null }] };
	const mine = { ...base, steps: [] };
	await h.call("propose", { edits: [{ op: "create", body: base }] });
	await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: current }] });
	const overlap = await h.call<ProposeReply>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: mine }] });
	expect(overlap.status).toBe("conflict");
	expect(overlap.conflicts).toEqual([{ case: "C-1", addresses: [{ kind: "step", id: "order" }] }]);
	const [proposal] = await h.call<{ edits: { body: CaseBody; current: CaseBody; conflicts: Conflict[] }[] }[]>("get", {
		refs: [overlap.proposal],
	});
	const edit = proposal?.edits[0];
	const conflict = edit?.conflicts[0];
	if (!edit || !conflict) throw Error("Missing step conflict");
	const chosen = applyMergeChoice({ merged: edit.body, source: edit.current, address: conflict.address });
	const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [overlap.question] });
	expect(
		(
			await h.call<{ status: string }[]>("decide", {
				q: overlap.question,
				onEvidence: question?.evidenceHash,
				answer: { is: "merge", body: chosen },
			})
		)[0]?.status,
	).toBe("decided");
	expect((await storedBody()).steps).toEqual([{ id: "order", action: "Current change", expected: null }]);
});

test("choosing current keeps the current fragment pin named order through the registry", async () => {
	const fragment = { ...emptyBody("Fragment"), steps: [{ id: "ab", action: "v1", expected: null }] };
	await h.call("propose", { edits: [{ op: "create", kind: "fragment", body: fragment }] });
	for (const version of [2, 3])
		await h.call("propose", {
			edits: [
				{
					op: "edit",
					case: "C-1",
					base: version - 1,
					body: { steps: [{ id: "ab", action: `v${version}`, expected: null }] },
				},
			],
		});
	const pin = (version: number) => ({ id: "order", use: { fragment: "C-1", version }, action: "", expected: null });
	const base = { ...emptyBody("Pinned case"), steps: [pin(1)] };
	const current = { ...base, steps: [pin(3)] };
	const mine = { ...base, steps: [pin(2)] };
	await h.call("propose", { edits: [{ op: "create", body: base }] });
	await h.call("propose", { edits: [{ op: "edit", case: "C-2", base: 1, body: current }] });
	const overlap = await h.call<ProposeReply>("propose", { edits: [{ op: "edit", case: "C-2", base: 1, body: mine }] });
	expect(overlap.status).toBe("conflict");
	expect(overlap.conflicts).toEqual([{ case: "C-2", addresses: [{ kind: "step", id: "order" }] }]);
	const [proposal] = await h.call<{ edits: { body: CaseBody; current: CaseBody; conflicts: Conflict[] }[] }[]>("get", {
		refs: [overlap.proposal],
	});
	const edit = proposal?.edits[0];
	const conflict = edit?.conflicts[0];
	if (!edit || !conflict) throw Error("Missing pin conflict");
	const chosen = applyMergeChoice({ merged: edit.body, source: edit.current, address: conflict.address });
	const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [overlap.question] });
	expect(
		(
			await h.call<{ status: string }[]>("decide", {
				q: overlap.question,
				onEvidence: question?.evidenceHash,
				answer: { is: "merge", body: chosen },
			})
		)[0]?.status,
	).toBe("decided");
	const [saved] = await h.call<{ md: string }[]>("get", { refs: ["C-2"], as: "md" });
	const parsed = parseCase(saved?.md ?? "");
	if (!parsed.ok) throw Error("Invalid saved case");
	expect(parsed.doc.body.steps).toEqual([
		{ id: "order", use: { fragment: "C-1", version: 3 }, action: "", expected: null },
	]);
});

describe("authoritative placement effects", () => {
	const propose = async (edits: Edit[]) => ProposeReply.parse(await h.call("propose", { edits }));
	test("a partial state change names only written cases and a no-op has no inverse", async () => {
		await propose([
			{ op: "create", body: { title: "Already archived" } },
			{ op: "create", body: { title: "Still active" } },
		]);
		await propose([{ op: "state", cases: ["C-1"], to: "archived" }]);
		const reply = await propose([{ op: "state", cases: ["C-1", "C-2"], to: "archived" }]);
		expect(reply.placements).toEqual([{ op: "state", cases: ["C-2"], to: "active" }]);
		expect((await propose([{ op: "state", cases: ["C-1", "C-2"], to: "archived" }])).placements).toEqual([]);
		await propose(reply.placements);
		expect((await h.call<{ state: string }[]>("get", { refs: ["C-1", "C-2"] })).map((row) => row.state)).toEqual([
			"archived",
			"active",
		]);
	});

	test("command recovery retains the original placement effects without writing them twice", async () => {
		await propose([{ op: "create", body: { title: "Retry placement" } }]);
		const input = { cmd: "recorded-placement", edits: [{ op: "state", cases: ["C-1"], to: "archived" }] };
		const first = ProposeReply.parse(await h.call("propose", input));
		expect(first.placements).toEqual([{ op: "state", cases: ["C-1"], to: "active" }]);
		expect(ProposeReply.parse(await h.call("propose", input))).toEqual(first);
		expect(
			(await h.call<{ entries: { t: string }[] }>("timeline", { ref: "C-1" })).entries.filter(
				(entry) => entry.t === "placement",
			),
		).toHaveLength(1);
	});

	test("tag inverses exclude no-ops and preserve unrelated tags added after the write", async () => {
		await propose([
			{ op: "create", tags: ["shared"], body: { title: "Has tag" } },
			{ op: "create", body: { title: "Needs tag" } },
		]);
		const added = await propose([{ op: "place", cases: ["C-1", "C-2"], tags: { add: ["shared"] } }]);
		expect(added.placements).toEqual([{ op: "place", cases: ["C-2"], tags: { add: [], remove: ["shared"] } }]);
		await propose([{ op: "place", cases: ["C-2"], tags: { add: ["other"] } }]);
		await propose(added.placements);
		expect((await h.call<{ tags: string[] }[]>("get", { refs: ["C-1", "C-2"] })).map((row) => row.tags)).toEqual([
			["shared"],
			["other"],
		]);
		const removed = await propose([{ op: "place", cases: ["C-1", "C-2"], tags: { remove: ["shared"] } }]);
		expect(removed.placements).toEqual([{ op: "place", cases: ["C-1"], tags: { add: ["shared"], remove: [] } }]);
		await propose(removed.placements);
		expect((await propose([{ op: "place", cases: ["C-1"], tags: { add: ["shared"] } }])).placements).toEqual([]);
	});

	test("a folder inverse uses the folder at the write, including after a rename", async () => {
		await propose([
			{ op: "create", folder: "Original", tags: ["kept"], body: { title: "Moved twice" } },
			{ op: "folder", name: "Concurrent" },
		]);
		await propose([{ op: "place", cases: ["C-1"], folder: "Concurrent" }]);
		const before = (await h.call<{ folder: { id: number } }[]>("get", { refs: ["C-1"] }))[0]?.folder.id;
		const moved = await propose([{ op: "place", cases: ["C-1"], folder: "Destination" }]);
		expect(moved.placements).toEqual([{ op: "place", cases: ["C-1"], folder: before, rank: expect.any(String) }]);
		await propose([{ op: "folder", folder: "Concurrent", name: "Renamed" }]);
		await propose(moved.placements);
		expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([{ folder: { path: "Renamed" }, tags: ["kept"] }]);
	});

	test("effects reverse repeated changes to a case in the same proposal", async () => {
		await propose([{ op: "create", body: { title: "Several changes" } }]);
		const changed = await propose([
			{ op: "state", cases: ["C-1"], to: "archived" },
			{ op: "place", cases: ["C-1"], tags: { add: ["first"] } },
			{ op: "place", cases: ["C-1"], tags: { add: ["second"] } },
		]);
		expect(changed.placements).toHaveLength(3);
		await propose(changed.placements);
		expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([{ state: "active", tags: [] }]);
	});
});

describe("placement reply boundaries and order", () => {
	const propose = async (edits: Edit[]) => ProposeReply.parse(await h.call("propose", { edits }));
	const order = async (folder: string) =>
		(await h.call<{ items: { ref: string }[] }>("find", { in: "cases", folder })).items.map((row) => row.ref);

	for (const operation of ["propose", "decide"] as const) {
		test(`${operation} hides prior placement metadata without read, including command replay`, async () => {
			await h.close();
			h = await harness({ preset: "standard" });
			await propose([{ op: "create", folder: "Private", tags: ["private-tag"], body: { title: "Protected case" } }]);
			const reader = await h.actor("writer", operation === "propose" ? "human" : "agent", ["read", "produce"]);
			const blind = await h.actor(
				"blind-writer",
				"human",
				operation === "decide" ? ["produce", "answer"] : ["produce"],
			);
			expect((await h.raw("get", { refs: ["C-1"] }, blind)).ok).toBe(false);
			const input = {
				edits: [
					{ op: "place", cases: ["C-1"], folder: "Destination", tags: { set: [] } },
					{ op: "state", cases: ["C-1"], to: "archived" },
				],
			};
			const proposed = ProposeReply.parse(
				await h.call("propose", { ...input, cmd: "blind-placement" }, operation === "propose" ? blind : reader),
			);
			if (operation === "propose") {
				expect(proposed.status).toBe("adopted");
				expect(proposed.placements).toEqual([]);
				expect(
					ProposeReply.parse(await h.call("propose", { ...input, cmd: "blind-placement" }, blind)).placements,
				).toEqual([]);
			} else {
				const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
				const answer = {
					q: proposed.question,
					onEvidence: question?.evidenceHash,
					answer: { is: "accept" },
					cmd: "blind-decision",
				};
				const [reply] = await h.call<DecideReply[]>("decide", answer, blind);
				expect(reply?.status).toBe("decided");
				expect(reply?.effects?.placements).toEqual([]);
				expect((await h.call<DecideReply[]>("decide", answer, blind))[0]?.effects?.placements).toEqual([]);
			}
			const [detail] = await h.call<{ decision: { id: number; effects: { placements: Edit[] } } }[]>("get", {
				refs: [proposed.question],
			});
			expect(detail?.decision.effects.placements).toMatchObject([
				{ op: "state", cases: ["C-1"], to: "active" },
				{ op: "place", cases: ["C-1"], tags: { add: ["private-tag"] } },
			]);
		});
	}

	test("replay filters effects after the caller loses read access", async () => {
		await propose([{ op: "create", tags: ["private-tag"], body: { title: "Revoked read" } }]);
		const actor = await h.actor("reader-writer", "human", ["read", "produce"]);
		const input = { cmd: "read-before-revoke", edits: [{ op: "place", cases: ["C-1"], tags: { set: [] } }] };
		expect(ProposeReply.parse(await h.call("propose", input, actor)).placements).toHaveLength(1);
		expect(ProposeReply.parse(await h.call("propose", input, { ...actor, can: ["produce"] })).placements).toEqual([]);
	});

	test("legacy recorded create outcomes recover without duplicating the case", async () => {
		const input = { cmd: "pre-placements-create", edits: [{ op: "create", body: { title: "Old create reply" } }] };
		const { placements: _placements, ...old } = ProposeReply.parse(await h.call("propose", input));
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE commands SET outcome = $1 WHERE id = $2"), [
							JSON.stringify(old),
							input.cmd,
						]),
				),
		);
		const fate = await h.call<{ reply: unknown }>("command", { cmd: input.cmd });
		expect(ProposeReply.parse(fate.reply).placements).toEqual([]);
		expect(ProposeReply.parse(await h.call("propose", input)).placements).toEqual([]);
		expect(await order("Unsorted")).toEqual(["C-1"]);
	});

	test("API 2 refuses a version-1 server before a retried create writes", async () => {
		let writes = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/health") return Response.json({ ok: true, apiVersion: 1 });
				writes++;
				return Response.json({
					ok: true,
					result: { proposal: "P-1", status: "adopted", question: null, needs: null, cases: [], conflicts: [] },
				});
			},
		});
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const client = new Client({ url: `http://127.0.0.1:${server.port}`, project: "scratch", token: undefined });
				await expect(
					client.call("propose", { edits: [{ op: "create", body: { title: "Never written" } }] }),
				).rejects.toMatchObject({ code: "incompatible" });
			}
			expect(writes).toBe(0);
		} finally {
			await server.stop(true);
		}
	});

	for (const destination of ["A", "B"]) {
		test(`move inverses restore exact order from ${destination}`, async () => {
			await propose([1, 2, 3].map((n) => ({ op: "create", folder: "A", body: { title: `Ordered ${n}` } })));
			const changed = await propose([
				{ op: "place", cases: ["C-2"], folder: destination, ...(destination === "A" ? { after: "C-3" } : {}) },
			]);
			expect(await order("A")).toEqual(destination === "A" ? ["C-1", "C-3", "C-2"] : ["C-1", "C-3"]);
			await propose(changed.placements);
			expect(await order("A")).toEqual(["C-1", "C-2", "C-3"]);
		});
	}

	test("bulk move inverse preserves order even after the original folder is archived", async () => {
		await propose([1, 2, 3, 4].map((n) => ({ op: "create", folder: "A", body: { title: `Bulk ordered ${n}` } })));
		const moved = await propose([{ op: "place", cases: ["C-1", "C-2", "C-3"], folder: "B" }]);
		await propose([{ op: "folder", folder: "A", archive: true }]);
		await propose(moved.placements);
		expect(await order("A")).toEqual(["C-1", "C-2", "C-3", "C-4"]);
		expect((await h.call<{ items: { ref: string }[] }>("find", { in: "cases" })).items).toHaveLength(4);
		expect(
			(await h.call<{ items: { path: string; state: string }[] }>("find", { in: "folders" })).items.find(
				(row) => row.path === "A",
			)?.state,
		).toBe("archived");
	});

	test("moving to the existing position records no effect", async () => {
		await propose([1, 2, 3].map((n) => ({ op: "create", folder: "A", body: { title: `Already positioned ${n}` } })));
		expect((await propose([{ op: "place", cases: ["C-3"], folder: "A" }])).placements).toEqual([]);
		expect((await propose([{ op: "place", cases: ["C-2", "C-3"], folder: "A" }])).placements).toEqual([]);
		expect((await propose([{ op: "place", cases: ["C-2", "C-3"], after: "C-1" }])).placements).toEqual([]);
	});
	for (const rank of ["", "a", "a00", "a0!", "not-a-key"]) {
		test(`invalid recorded rank ${JSON.stringify(rank)} cannot corrupt ordering`, async () => {
			await propose([{ op: "create", body: { title: "Valid ordering" } }]);
			expect(await h.raw("propose", { edits: [{ op: "place", cases: ["C-1"], rank }] })).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
			await propose([{ op: "create", body: { title: "Next valid ordering" } }]);
			expect(await order("Unsorted")).toEqual(["C-1", "C-2"]);
		});
	}
	test("a move inverse keeps every case pageable when a new case occupies the old rank", async () => {
		await propose([1, 2, 3].map((n) => ({ op: "create", folder: "A", body: { title: `Slot ${n}` } })));
		const moved = await propose([{ op: "place", cases: ["C-2"], folder: "B" }]);
		await propose([{ op: "create", folder: "A", after: "C-1", body: { title: "New occupant" } }]);
		await propose(moved.placements);
		const refs: string[] = [];
		let cursor: string | null = null;
		do {
			const page: { items: { ref: string }[]; cursor: string | null } = await h.call("find", {
				in: "cases",
				folder: "A",
				limit: 1,
				cursor: cursor ?? undefined,
			});
			refs.push(...page.items.map((row) => row.ref));
			cursor = page.cursor;
		} while (cursor);
		expect(refs).toHaveLength(4);
		expect(refs.filter((ref) => ref !== "C-4")).toEqual(["C-1", "C-2", "C-3"]);
	});
	test("a recorded rank cannot name multiple cases or an after anchor", async () => {
		await propose([1, 2].map((n) => ({ op: "create", body: { title: `Rank input ${n}` } })));
		for (const edit of [
			{ op: "place", cases: ["C-1", "C-2"], rank: "a0" },
			{ op: "place", cases: ["C-1"], rank: "a0", after: "C-2" },
		])
			expect(await h.raw("propose", { edits: [edit] })).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(await order("Unsorted")).toEqual(["C-1", "C-2"]);
	});
});

describe("conflict-merge placement effects", () => {
	const propose = async (edits: Edit[], as = h.owner) => ProposeReply.parse(await h.call("propose", { edits }, as));
	const conflictFor = async (as = h.owner, tagged = true) => {
		await propose([{ op: "create", tags: ["kept", "removed"], body: { title: "Base" } }]);
		await propose([{ op: "edit", case: "C-1", base: 1, body: { title: "Theirs" } }]);
		const edits: Edit[] = [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }];
		if (tagged) edits.push({ op: "place", cases: ["C-1"], tags: { add: ["merged-tag"], remove: ["removed"] } });
		const pending = await propose(edits, as);
		expect(pending.status).toBe("conflict");
		if (!pending.question) throw new Error("no conflict question");
		if (tagged) await propose([{ op: "place", cases: ["C-1"], tags: { add: ["concurrent"] } }]);
		return pending.question;
	};
	const resolution = async (q: string, body = emptyBody("Resolved")) => {
		const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [q] });
		return { q, onEvidence: question?.evidenceHash, answer: { is: "merge", body } };
	};
	const inverse = [{ op: "place", cases: ["C-1"], tags: { add: ["removed"], remove: ["merged-tag"] } }];

	for (const read of [true, false]) {
		test(`a tag-delta merge returns placement effects ${read ? "to a reader" : "without disclosing them to its produce-only author"}`, async () => {
			const author = await h.actor("merge-author", "human", read ? ["read", "produce"] : ["produce"]);
			const q = await conflictFor(author);
			const input = { ...(await resolution(q)), cmd: read ? "reader-merge" : "blind-merge" };
			const first = await h.call<DecideReply[]>("decide", input, author);
			const [reply] = first;
			expect(await h.call<DecideReply[]>("decide", input, author)).toEqual(first);
			expect(reply).toMatchObject({ status: "decided", effects: { status: "adopted" } });
			expect(reply?.effects?.placements).toEqual(read ? inverse : []);
			const [stored] = await h.call<{ decision: { effects: Record<string, unknown> } }[]>("get", { refs: [q] });
			expect(stored?.decision.effects.placements).toEqual(inverse);
			expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([
				{ version: 3, tags: ["concurrent", "kept", "merged-tag"] },
			]);
			if (read) {
				await propose(ProposeReply.shape.placements.parse(reply?.effects?.placements), author);
				expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([
					{ version: 3, title: "Resolved", tags: ["concurrent", "kept", "removed"] },
				]);
			}
		});
	}

	test("command replay retains merge placement effects without recording the tag delta twice", async () => {
		const q = await conflictFor();
		const input = { ...(await resolution(q)), cmd: "merge-with-placement-effects" };
		const first = await h.call<DecideReply[]>("decide", input);
		expect(first[0]?.effects?.placements).toEqual(inverse);
		const timeline = async () => await h.call<{ entries: unknown[] }>("timeline", { ref: "C-1" });
		const before = await timeline();
		expect(await h.call<DecideReply[]>("decide", input)).toEqual(first);
		expect(await timeline()).toEqual(before);
		const recovered = await h.call<{ reply: DecideReply[] }>("command", { cmd: input.cmd });
		expect(recovered.reply).toEqual(first);
	});

	test("an unchanged merge explicitly returns no placement effects", async () => {
		const q = await conflictFor(h.owner, false);
		const [reply] = await h.call<DecideReply[]>("decide", await resolution(q, emptyBody("Theirs")));
		expect(reply).toMatchObject({ status: "decided", effects: { status: "unchanged", placements: [] } });
	});

	test("a replacement waiting for review explicitly returns no placement effects", async () => {
		const q = await conflictFor();
		const policy = await propose([{ op: "policy", preset: "strict" }]);
		const [question] = await h.call<{ evidenceHash: string }[]>("get", { refs: [policy.question] });
		await h.call("decide", { q: policy.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } });
		const [reply] = await h.call<DecideReply[]>("decide", await resolution(q));
		expect(reply).toMatchObject({ status: "decided", effects: { status: "open", placements: [] } });
		expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([
			{ version: 2, tags: ["concurrent", "kept", "removed"] },
		]);
	});

	test("a replacement that meets another body conflict explicitly returns no placement effects", async () => {
		const q = await conflictFor();
		await propose([{ op: "edit", case: "C-1", base: 2, body: { title: "Changed again" } }]);
		const [reply] = await h.call<DecideReply[]>("decide", await resolution(q));
		expect(reply).toMatchObject({ status: "decided", effects: { status: "conflict", placements: [] } });
		expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([
			{ version: 3, title: "Changed again", tags: ["concurrent", "kept", "removed"] },
		]);
	});
});

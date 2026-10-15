import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCase } from "../src/core/markdown.ts";
import type { DecideReply, Edit, ProposeReply } from "../src/core/ops.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { Db } from "../src/server/kernel/db.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke, invokeAsync, type Reply } from "../src/server/ops/registry.ts";
import { open } from "../src/server/start.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness();
});
afterEach(() => h.close());

type Proposed = {
	proposal: string | null;
	status: string;
	question: string | null;
	cases: { ref: string; version: number; hash: string }[];
	conflicts: { case: string; paths: string[] }[];
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

const storedBody = () => {
	const [result] = h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" });
	const parsed = parseCase(result?.md ?? "");
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
	return parsed.doc.body;
};

describe("atomic bulk proposals", () => {
	const count = 450;
	const creates = (): Edit[] =>
		Array.from({ length: count }, (_, i) => ({ op: "create", outline: `Bulk case ${i}\n  Check > Pass` }));
	const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
	const disk = () => {
		const dir = mkdtempSync(join(tmpdir(), "mainworthy-bulk-"));
		const config = defaultConfig({ MAINWORTHY_DATA: dir, MAINWORTHY_OWNER: "robin" });
		const instance = open(config);
		const call = (op: string, input: unknown = {}) => ({ op, input, project: "scratch", actor: () => instance.owner });
		const raw = (op: string, input: unknown = {}) => invoke(instance.app, OPS, call(op, input));
		return {
			...instance,
			config,
			call,
			raw,
			close() {
				instance.app.close();
				rmSync(dir, { recursive: true, force: true });
			},
		};
	};
	const result = <T>(reply: Reply): T => {
		if (!reply.ok) throw new Error(JSON.stringify(reply.error));
		return reply.result as T;
	};
	const storedCount = (instance: ReturnType<typeof disk>, table: "cases" | "versions" | "decisions") =>
		instance.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
	const acceptance = (instance: ReturnType<typeof disk>, proposed: ProposeReply) => {
		const question = result<{ evidenceHash: string }[]>(instance.raw("get", { refs: [proposed.question] }))[0];
		return {
			q: proposed.question,
			onEvidence: question?.evidenceHash,
			answer: { is: "accept" },
			reason: "Reviewed all cases",
		};
	};
	const strict = (instance: ReturnType<typeof disk>) => {
		const policy = result<ProposeReply>(instance.raw("propose", { edits: [{ op: "policy", preset: "strict" }] }));
		expect(result<DecideReply[]>(instance.raw("decide", acceptance(instance, policy)))[0]?.status).toBe("decided");
	};

	test.each(["map", "finding", "policy"] as const)(
		"case creation from %s answers yields without publishing partial effects",
		async (kind) => {
			const instance = disk();
			try {
				const total = kind === "finding" ? 200 : count;
				const questionKind = kind === "finding" ? "finding" : "map";
				if (kind !== "finding") {
					const policy = result<ProposeReply>(instance.raw("propose", { edits: [{ op: "policy", unlinked: "ask" }] }));
					expect(result<DecideReply[]>(instance.raw("decide", acceptance(instance, policy)))[0]?.status).toBe(
						"decided",
					);
					result(instance.raw("report", ciReport({ commit: "ba1c0001", n: total })));
				} else {
					result(
						instance.raw("claim", {
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
					instance.raw("inbox", { kind: questionKind, limit: 200 }),
				).items;
				expect(questions).toHaveLength(kind === "finding" ? total : 1);
				const pendingPolicy =
					kind === "policy"
						? result<ProposeReply>(instance.raw("propose", { edits: [{ op: "policy", unlinked: "create" }] }))
						: null;
				const input = {
					all: pendingPolicy
						? [acceptance(instance, pendingPolicy)]
						: questions.map((question) => ({
								q: question.q,
								onEvidence: question.evidenceHash,
								answer: kind === "map" ? { is: "create" } : { is: "accept", apply: true },
							})),
					cmd: `bulk-${kind}`,
				};
				let done = false;
				const saving = invokeAsync(instance.app, OPS, instance.call("decide", input));
				void saving.then(() => {
					done = true;
				});
				let partial = false;
				while (!done) {
					await tick();
					const written = storedCount(instance, "cases");
					if (done || written === 0 || written === total) continue;
					partial = true;
					expect(result(instance.raw("find"))).toMatchObject({ count: 0, items: [] });
					expect(
						result<{ items: unknown[] }>(instance.raw("inbox", { kind: questionKind, limit: 200 })).items,
					).toHaveLength(questions.length);
				}
				const saved = result<DecideReply[]>(await saving);
				expect(saved.map((reply) => reply.status)).toEqual(questions.map(() => "decided"));
				expect(result(instance.raw("find"))).toMatchObject({ count: total });
				expect(result(instance.raw("inbox", { kind: questionKind }))).toMatchObject({ items: [] });
				expect(result<DecideReply[]>(await invokeAsync(instance.app, OPS, instance.call("decide", input)))).toEqual(
					saved,
				);
				if (kind !== "finding") {
					const receipt = result<{ basis: { assumed: number; unresolved: number } }>(
						instance.raw("report", ciReport({ commit: "ba1c0002", n: total })),
					);
					expect(receipt.basis).toMatchObject({ assumed: total, unresolved: 0 });
				}
				expect(partial).toBe(true);
			} finally {
				await instance.app.gate.run(() => {});
				instance.close();
			}
		},
	);

	test("sealing a bulk proposal that needs review also answers reads before publishing it", async () => {
		const instance = disk();
		try {
			strict(instance);
			let done = false;
			const sealing = invokeAsync(instance.app, OPS, instance.call("propose", { edits: creates() }));
			void sealing.then(() => {
				done = true;
			});
			let during = false;
			while (!done) {
				await tick();
				if (done) break;
				during = true;
				expect(result(instance.raw("find"))).toMatchObject({ count: 0 });
				expect(instance.raw("get", { refs: ["P-2"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
			}
			const proposed = result<ProposeReply>(await sealing);
			expect(proposed).toMatchObject({ proposal: "P-2", status: "open", cases: [] });
			expect(result<unknown[]>(instance.raw("get", { refs: [proposed.proposal] }))[0]).toMatchObject({ ref: "P-2" });
			expect(during).toBe(true);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	});

	test("a bulk save answers reads between slices and publishes the complete proposal and decision once", async () => {
		const instance = disk();
		try {
			const events: unknown[] = [];
			instance.app.subscribe((event) => events.push(event));
			let done = false;
			const saving = invokeAsync(
				instance.app,
				OPS,
				instance.call("propose", { edits: creates(), cmd: "bulk-save-01" }),
			);
			void saving.then(() => {
				done = true;
			});
			let partial = false;
			while (!done) {
				await tick();
				const written = storedCount(instance, "cases");
				if (written === 0 || written === count) continue;
				partial = true;
				expect(result(instance.raw("find"))).toMatchObject({ count: 0, items: [] });
				expect(instance.raw("get", { refs: ["P-1"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
				expect(result(instance.raw("inbox"))).toMatchObject({ items: [] });
				expect(events).toHaveLength(0);
			}
			const saved = result<ProposeReply>(await saving);
			expect(saved.status).toBe("adopted");
			expect(saved.cases).toHaveLength(count);
			expect(result(instance.raw("find"))).toMatchObject({ count });
			expect(storedCount(instance, "versions")).toBe(count);
			expect(storedCount(instance, "decisions")).toBe(1);
			expect(events).toHaveLength(1);
			expect(partial).toBe(true);
			expect(
				result<ProposeReply>(
					await invokeAsync(instance.app, OPS, instance.call("propose", { edits: creates(), cmd: "bulk-save-01" })),
				),
			).toEqual(saved);
			expect(storedCount(instance, "versions")).toBe(count);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	});

	test("accepting a bulk proposal answers reads without exposing half its cases or a decided question", async () => {
		const instance = disk();
		try {
			strict(instance);
			const proposed = result<ProposeReply>(instance.raw("propose", { edits: creates() }));
			expect(proposed.status).toBe("open");
			const question = result<{ evidenceHash: string }[]>(instance.raw("get", { refs: [proposed.question] }))[0];
			let done = false;
			const accepting = invokeAsync(
				instance.app,
				OPS,
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
				await tick();
				const written = storedCount(instance, "cases");
				if (written === 0 || written === count) continue;
				partial = true;
				expect(result(instance.raw("find"))).toMatchObject({ count: 0 });
				expect(result(instance.raw("find", { text: "Bulk" }))).toMatchObject({ count: 0 });
				expect(result<unknown[]>(instance.raw("get", { refs: [proposed.question] }))[0]).toMatchObject({
					state: "open",
				});
			}
			expect(result<DecideReply[]>(await accepting)[0]).toMatchObject({
				status: "decided",
				effects: { cases: expect.any(Array) },
			});
			expect(result(instance.raw("find"))).toMatchObject({ count });
			expect(result<unknown[]>(instance.raw("get", { refs: [proposed.question] }))[0]).toMatchObject({
				state: "decided",
			});
			expect(partial).toBe(true);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	});

	test.each(["edit", "place", "state"] as const)(
		"a bulk %s keeps every case at its previous state between slices",
		async (op) => {
			const instance = disk();
			try {
				const created = result<ProposeReply>(instance.raw("propose", { edits: creates() }));
				const refs = created.cases.map((row) => row.ref);
				const edits: Edit[] =
					op === "edit"
						? refs.map((ref) => ({ op: "edit", case: ref, base: 1, body: { title: `Changed ${ref}` } }))
						: op === "place"
							? [{ op, cases: refs, tags: { add: ["changed"] }, folder: "Moved" }]
							: [{ op, cases: refs, to: "archived" }];
				const condition = op === "edit" ? "head = 2" : op === "place" ? "tags = '[\"changed\"]'" : "state = 'archived'";
				let done = false;
				const saving = invokeAsync(instance.app, OPS, instance.call("propose", { edits }));
				void saving.then(() => {
					done = true;
				});
				let partial = false;
				while (!done) {
					await tick();
					const changed =
						instance.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM cases WHERE ${condition}`).get()
							?.n ?? 0;
					if (changed === 0 || changed === count) continue;
					partial = true;
					expect(result(instance.raw("find"))).toMatchObject({ count });
					expect(result<unknown[]>(instance.raw("get", { refs: ["C-1", `C-${count}`] }))).toMatchObject([
						{ title: "Bulk case 0", version: 1, tags: [], state: "active" },
						{ title: `Bulk case ${count - 1}`, version: 1, tags: [], state: "active" },
					]);
				}
				expect(result<ProposeReply>(await saving).status).toBe("adopted");
				expect(
					instance.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM cases WHERE ${condition}`).get()?.n,
				).toBe(count);
				expect(partial).toBe(true);
			} finally {
				await instance.app.gate.run(() => {});
				instance.close();
			}
		},
	);

	test("a late adoption conflict rolls back earlier slices and leaves the next batched answer usable", async () => {
		const instance = disk();
		try {
			strict(instance);
			const edits = creates();
			edits.push({ op: "create", outline: "Last case", aliases: ["bulk:last"] });
			const pending = result<ProposeReply>(instance.raw("propose", { edits }));
			const competitor = result<ProposeReply>(
				instance.raw("propose", { edits: [{ op: "create", outline: "Alias holder", aliases: ["bulk:last"] }] }),
			);
			expect(result<DecideReply[]>(instance.raw("decide", acceptance(instance, competitor)))[0]?.status).toBe(
				"decided",
			);
			const next = result<ProposeReply>(instance.raw("propose", { edits: [{ op: "create", outline: "Next answer" }] }));
			const replies = result<DecideReply[]>(
				await invokeAsync(
					instance.app,
					OPS,
					instance.call("decide", {
						all: [acceptance(instance, pending), acceptance(instance, next)],
					}),
				),
			);
			expect(replies.map((reply) => reply.status)).toEqual(["conflict", "decided"]);
			expect(replies[0]?.needs).toBe("case alias bulk:last is already in use");
			expect(result(instance.raw("find"))).toMatchObject({ count: 2 });
			expect(storedCount(instance, "versions")).toBe(2);
			expect(storedCount(instance, "decisions")).toBe(3);
			expect(result<unknown[]>(instance.raw("get", { refs: [pending.question] }))[0]).toMatchObject({ state: "open" });
			expect(result<CaseView[]>(instance.raw("get", { refs: ["C-1", "C-2"] })).map((row) => row.title)).toEqual([
				"Alias holder",
				"Next answer",
			]);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	});

	test.each(["propose", "decide"])(
		"a process killed between %s slices leaves no partial adoption after restart",
		async (op) => {
			const instance = disk();
			let child: ReturnType<typeof Bun.spawn> | undefined;
			try {
				let input: unknown = { edits: creates(), cmd: "bulk-crash-01" };
				let pending: ProposeReply | undefined;
				if (op === "decide") {
					strict(instance);
					pending = result<ProposeReply>(instance.raw("propose", { edits: creates() }));
					input = { ...acceptance(instance, pending), cmd: "bulk-crash-01" };
				}
				const before = storedCount(instance, "decisions");
				const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
				const running = Bun.spawn(
					[
						process.execPath,
						"-e",
						`
import { OPS } from ${module("../src/server/ops/index.ts")};
import { invokeAsync } from ${module("../src/server/ops/registry.ts")};
import { open } from ${module("../src/server/start.ts")};
const { config, op, input } = JSON.parse(await Bun.stdin.text());
const { app, owner } = open(config);
const operation = OPS[op];
if (!("steps" in operation)) throw new Error("the bulk operation has no slices");
const paused = { ...operation, *steps(ctx, input) {
	const steps = operation.steps(ctx, input);
	for (let step = steps.next(); ; step = steps.next()) {
		if (step.done) return step.value;
		const count = app.db.raw.query("SELECT count(*) AS n FROM cases").get().n;
		if (count > 0 && count < ${count}) {
			process.stdout.write("PARTIAL " + count + "\\n");
			for (;;) yield;
		}
		yield step.value;
	}
} };
await invokeAsync(app, { ...OPS, [op]: paused }, { op, project: "scratch", input, actor: () => owner });
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
				const restarted = open(instance.config);
				try {
					const raw = (operation: string, body: unknown = {}) =>
						invoke(restarted.app, OPS, {
							op: operation,
							project: "scratch",
							input: body,
							actor: () => restarted.owner,
						});
					expect(result(raw("find"))).toMatchObject({ count: 0 });
					for (const table of ["cases", "versions", "placements", "search_docs", "commands"]) {
						expect(restarted.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(
							0,
						);
					}
					expect(restarted.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM decisions").get()?.n).toBe(
						before,
					);
					if (pending)
						expect(result<unknown[]>(raw("get", { refs: [pending.question] }))[0]).toMatchObject({ state: "open" });
					else expect(raw("get", { refs: ["P-1"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
					const retried = raw(op, input);
					expect(retried.ok).toBe(true);
					expect(raw(op, input)).toEqual(retried);
					expect(result(raw("find"))).toMatchObject({ count });
					expect(restarted.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM versions").get()?.n).toBe(
						count,
					);
					expect(restarted.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM decisions").get()?.n).toBe(
						before + 1,
					);
				} finally {
					restarted.app.close();
				}
			} finally {
				if (child) {
					child.kill("SIGKILL");
					await child.exited;
				}
				instance.close();
			}
		},
	);
});

describe("capture", () => {
	test("an outline becomes C-1, version 1, with steps, expected results, a tag and a requirement", () => {
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "create", outline: OUTLINE, folder: "checkout/coupons" }],
		});
		expect(reply.status).toBe("adopted");
		expect(reply.cases).toEqual([{ ref: "C-1", version: 1, hash: expect.any(String) }]);
		const [view] = h.call<CaseView[]>("get", { refs: ["C-1"] });
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

	test("suite writes clean Unicode folder paths and tags", () => {
		h.call("propose", {
			edits: [{ op: "create", outline: "Unicode", folder: " Cafe\u0301\u200b / Child ", tags: ["#Crit\u200bical"] }],
		});
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({
			folder: { path: "Café/Child" },
			tags: ["critical"],
		});
		h.call("propose", {
			edits: [{ op: "place", cases: ["C-1"], folder: "Re\u0301sume\u0301", tags: { set: ["re\u200bview"] } }],
		});
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({
			folder: { path: "Résumé" },
			tags: ["review"],
		});
	});

	test("folder creation and rename use the same Unicode cleaning as paths", () => {
		h.call("propose", { edits: [{ op: "folder", name: " Cafe\u0301\u200b " }] });
		h.call("propose", { edits: [{ op: "create", outline: "Unicode", folder: "Café" }] });
		expect(h.call<{ items: unknown[] }>("find", { in: "folders" }).items.length).toBe(1);
		h.call("propose", { edits: [{ op: "folder", folder: "Café", name: " Re\u0301sume\u0301\u200b " }] });
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]?.folder.path).toBe("Résumé");
	});

	test.each(["\u200b", " \u200b "])("a folder name empty after cleaning is refused: %s", (name) => {
		expect(h.raw("propose", { edits: [{ op: "folder", name }] })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(h.call<{ items: unknown[] }>("find", { in: "folders" }).items.length).toBe(0);
	});

	test("canonical lookup reuses an existing NFD folder without rewriting it", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Café" }] });
		h.app.db.raw.query("UPDATE folders SET name = ? WHERE name = 'Café'").run("Cafe\u0301");
		h.call("propose", { edits: [{ op: "create", outline: "Second", folder: "Café" }] });
		expect(h.call<{ items: unknown[] }>("find", { in: "folders" }).items.length).toBe(1);
		expect(h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] }).map((view) => view.folder.path)).toEqual([
			"Cafe\u0301",
			"Cafe\u0301",
		]);
		for (const folder of ["Café", "Cafe\u0301", "Café\u200b"]) {
			expect(h.call<{ items: { ref: string }[] }>("find", { folder }).items.map((item) => item.ref)).toEqual([
				"C-1",
				"C-2",
			]);
		}
	});

	test("the save is a recorded decision made by the policy's rule", () => {
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		const ledger = h.call<{
			items: { kind: string; decision: { answer: { is: string }; rule: string | null; by: string[] } }[];
		}>("inbox", { state: "decided" });
		expect(ledger.items).toHaveLength(1);
		expect(ledger.items[0]?.decision).toMatchObject({ answer: { is: "accept" }, rule: "adopt-any", by: ["policy"] });
	});

	test("the same command twice writes once", () => {
		const input = { edits: [{ op: "create", outline: "A case" }], cmd: "cmd-0000000001" };
		const first = h.call<Proposed>("propose", input);
		const second = h.call<Proposed>("propose", input);
		expect(second).toEqual(first);
		const count = (table: string) =>
			h.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n;
		expect([count("cases"), count("versions"), count("proposals"), count("decisions")]).toEqual([1, 1, 1, 1]);
		expect(h.call<{ count: number }>("find", { in: "folders" }).count).toBe(1);
	});

	test("the canonical Markdown round-trips through the server", () => {
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		const [md] = h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" });
		expect(md?.md).toContain("## Steps");
		const again = h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, md: md?.md }] });
		expect(again.proposal).toBeNull(); // nothing changed, so nothing was proposed
	});

	test("a Markdown edit without a fields header preserves free-form values", () => {
		h.call("propose", { edits: [{ op: "create", body: { title: "Original", fields: { legacy: "Keep me" } } }] });
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: "---\ntitle: Edited\n---\n## Steps\n" }],
		});
		expect(reply.status).toBe("adopted");
		expect(storedBody()).toMatchObject({
			title: "Edited",
			fields: { legacy: "Keep me" },
		});
	});

	test.each([
		["fields:", {}],
		["fields: {}", {}],
		["fields:\n  risk: low", { risk: "low" }],
	])("a Markdown edit with %s replaces the field map", (header, fields) => {
		h.call("propose", {
			edits: [{ op: "create", body: { title: "Original", fields: { risk: "high", legacy: "Keep me" } } }],
		});
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: `---\ntitle: Edited\n${header}\n---\n## Steps\n` }],
		});
		expect(reply.status).toBe("adopted");
		expect(storedBody().fields).toEqual(fields);
	});

	test("a stale Markdown edit without fields merges a concurrent field change", () => {
		h.call("propose", { edits: [{ op: "create", body: { title: "Original", fields: { risk: "high" } } }] });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { fields: { risk: "low" } } }] });
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: "---\ntitle: Edited\n---\n## Steps\n" }],
		});
		expect(reply.status).toBe("adopted");
		expect(reply.conflicts).toEqual([]);
		expect(reply.cases[0]?.version).toBe(3);
		expect(storedBody()).toMatchObject({
			title: "Edited",
			fields: { risk: "low" },
		});
	});
});

describe("editing", () => {
	beforeEach(() => {
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
	});
	const steps = () => h.call<CaseView[]>("get", { refs: ["C-1"] })[0]?.steps ?? [];

	test("an edit is version 2 and the diff is by step", () => {
		const next = steps().map((s, i) => (i === 1 ? { ...s, expected: "Total shows $90.00 (10% off $100.00)" } : s));
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { steps: next } }],
			reason: "be exact",
		});
		expect(reply.cases[0]).toMatchObject({ ref: "C-1", version: 2 });
		const diff = h.call<{ summary: string }>("history", { ref: "C-1", from: 1, to: 2 });
		expect(diff.summary).toContain("expected");
		const list = h.call<{ versions: { version: number; reason: string | null; summary: string }[] }>("history", {
			ref: "C-1",
		});
		expect(list.versions.map((v) => v.version)).toEqual([2, 1]);
		expect(list.versions[0]?.reason).toBe("be exact");
	});

	test("two edits to different fields on the same base merge", () => {
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon: percentage" } }] });
		const mine = steps().map((s, i) => (i === 0 ? { ...s, action: "Open the cart with one $200.00 item" } : s));
		const reply = h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { steps: mine } }] });
		expect(reply.status).toBe("adopted");
		const [view] = h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect(view?.version).toBe(3);
		expect(view?.title).toBe("Coupon: percentage");
		expect(view?.steps[0]?.action).toBe("Open the cart with one $200.00 item");
	});

	test("two edits to the same field conflict: nothing is overwritten and the author resolves it", () => {
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Theirs" } }] });
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }],
		});
		expect(reply.status).toBe("conflict");
		expect(reply.conflicts).toEqual([{ case: "C-1", paths: ["title"] }]);
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]?.title).toBe("Theirs");

		const queue = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox");
		const q = queue.items[0];
		expect(q?.q).toBe(reply.question ?? "");
		const refused = h.call<{ status: string }[]>("decide", {
			q: q?.q,
			onEvidence: q?.evidenceHash,
			answer: { is: "accept" },
		});
		expect(refused[0]?.status).toBe("conflict");
		const body = {
			title: "Mine and theirs",
			pre: "",
			steps: steps(),
			methods: ["human"],
			automate: "none",
			fields: {},
		};
		const merged = h.call<{ status: string }[]>("decide", {
			q: q?.q,
			onEvidence: q?.evidenceHash,
			answer: { is: "merge", body },
		});
		expect(merged[0]?.status).toBe("decided");
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({ title: "Mine and theirs", version: 3 });
	});

	test("restore makes a new version and keeps the history", () => {
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Changed" } }] });
		const reply = h.call<Proposed>("propose", { edits: [{ op: "restore", case: "C-1", to: 1 }] });
		expect(reply.cases[0]).toMatchObject({ version: 3 });
		const [view] = h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect(view?.title).toBe("Checkout applies a percentage coupon");
		const first = h.call<CaseView[]>("get", { refs: ["C-1"], version: 1 })[0];
		expect(view?.hash).toBe(first?.hash ?? "");
	});
});

describe("organising", () => {
	test("a bulk move and retag of 300 cases is one proposal, one decision, one point on the clock", () => {
		const edits = Array.from({ length: 300 }, (_, i) => ({ op: "create", outline: `Case ${i}`, folder: "inbox" }));
		h.call("propose", { edits });
		const cases = Array.from({ length: 300 }, (_, i) => `C-${i + 1}`);
		const count = (table: string) =>
			h.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
		const proposals = count("proposals");
		const decisions = count("decisions");
		const before = h.app.db.raw.query<{ seq: number }, []>("SELECT seq FROM projects").get()?.seq ?? 0;
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "place", cases, folder: "checkout/regression", tags: { add: ["regression"] } }],
		});
		expect(reply.status).toBe("adopted");
		const after = h.app.db.raw.query<{ seq: number }, []>("SELECT seq FROM projects").get()?.seq ?? 0;
		expect(after).toBe(before + 1);
		expect([count("proposals") - proposals, count("decisions") - decisions]).toEqual([1, 1]);
		const found = h.call<{ items: { ref: string; tags: string[] }[] }>("find", {
			folder: "checkout/regression",
			limit: 500,
		});
		expect(found.items).toHaveLength(300);
		expect(found.items.map((c) => c.ref)).toEqual(cases); // order kept
		expect(found.items.every((c) => c.tags.includes("regression"))).toBe(true);
		const versions = h.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM versions").get()?.n;
		expect(versions).toBe(300); // a move is history, not a new version
	});

	test("search finds by word and prefix, and by ref", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: OUTLINE },
				{ op: "create", outline: "Login rejects an expired password\n  Enter the old password > Error shown" },
			],
		});
		const byWord = h.call<{ items: { ref: string }[] }>("find", { text: "coupon" });
		expect(byWord.items.map((c) => c.ref)).toEqual(["C-1"]);
		const byPrefix = h.call<{ items: { ref: string }[] }>("find", { text: "expired pass" });
		expect(byPrefix.items.map((c) => c.ref)).toEqual(["C-2"]);
		expect(h.call<{ items: { ref: string }[] }>("find", { text: "C-2" }).items[0]?.ref).toBe("C-2");
		expect(h.call<{ items: unknown[] }>("find", { text: '"*) OR 1=1 --' }).items).toEqual([]);
	});

	test("a search by ref keeps to the folder, the tags and the state it is narrowed by", () => {
		h.call("propose", {
			edits: [
				{ op: "create", folder: "Checkout", tags: ["checkout"], outline: "Coupon applies\n  Apply > Lower" },
				{ op: "create", folder: "Accounts", outline: "Password resets\n  Reset > Access" },
			],
		});
		const refs = (input: Record<string, unknown>) =>
			h.call<{ items: { ref: string }[] }>("find", input).items.map((c) => c.ref);
		expect(refs({ text: "C-1", folder: "Checkout" })).toEqual(["C-1"]);
		expect(refs({ text: "C-2", folder: "Checkout" })).toEqual([]);
		expect(refs({ text: "2", folder: "Checkout", deep: true })).toEqual([]);
		expect(refs({ text: "C-2", tags: ["checkout"] })).toEqual([]);
		expect(refs({ text: "C-1", tags: ["checkout"] })).toEqual(["C-1"]);
		expect(refs({ text: "C-2", state: "archived" })).toEqual([]);
		expect(refs({ text: "C-2" })).toEqual(["C-2"]);
	});

	test("a search too broad to rank is bounded: newest first, title matches first, and it says the count is unknown", () => {
		const batch = (from: number, n: number) =>
			Array.from({ length: n }, (_, i) => ({ op: "create", outline: `Common thing ${from + i}\n  Step > Result` }));
		h.call("propose", { edits: batch(0, 1100) });
		h.call("propose", { edits: batch(1100, 1000) });
		h.call("propose", { edits: [{ op: "create", outline: "Rare needle\n  A common step > Result" }] });
		const broad = h.call<{ count: number | null; items: { ref: string; title: string }[] }>("find", {
			text: "common",
			limit: 5,
		});
		expect(broad.count).toBeNull(); // more than can be ranked: the caller is told the number is not known
		expect(broad.items.map((c) => c.ref)).toEqual(["C-2100", "C-2099", "C-2098", "C-2097", "C-2096"]); // in the title, newest first
		const narrow = h.call<{ count: number | null; items: { ref: string }[] }>("find", { text: "common needle" });
		expect(narrow).toMatchObject({ count: 1, items: [{ ref: "C-2101" }] });
		const ranked = h.call<{ count: number | null; items: { ref: string }[] }>("find", { text: "thing 1500" });
		expect(ranked.count).toBe(1);
	});

	test("archiving hides a case from lists and keeps it readable", () => {
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		h.call("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		expect(h.call<{ items: unknown[] }>("find", {}).items).toEqual([]);
		expect(h.call<{ state: string }[]>("get", { refs: ["C-1"] })[0]?.state).toBe("archived");
	});
});

test("a sliced savepoint closed early rolls back and drops the after-commit work it queued", () => {
	const db = new Db(":memory:");
	db.exec("CREATE TABLE t (x INTEGER)");
	const ran: string[] = [];
	db.begin();
	db.afterCommit(() => ran.push("before"));
	const steps = db.savepointSteps(function* () {
		db.exec("INSERT INTO t VALUES (1)");
		db.afterCommit(() => ran.push("inside"));
		yield;
		return 1;
	});
	steps.next();
	// An abandoned request closes its generator at a slice boundary, without a throw.
	steps.return(undefined as never);
	expect(db.raw.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
	db.commit();
	expect(ran).toEqual(["before"]);
	db.transaction(() => db.afterCommit(() => ran.push("next")));
	expect(ran).toEqual(["before", "next"]);
});

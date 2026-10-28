import { expect, test } from "bun:test";
import { GetReply } from "../src/core/replies.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { harness } from "./helpers.ts";

test("case automation reads use constant statements for growing inventories and repeated refs", async () => {
	const h = await harness({ unlinked: "ask" });
	try {
		await h.call("propose", {
			edits: ["Small inventory", "Large inventory"].map((title) => ({ op: "create", body: { title } })),
		});
		const results = Array.from({ length: 201 }, (_, i) => ({
			test: { key: `test-${i}`, file: "inventory.test.ts" },
			outcome: "pass",
		}));
		await h.call("report", { target: { session: "discovery" }, results });
		const inbox = await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "map" });
		const question = inbox.items[0];
		if (!question) throw new Error("Expected mapping question");
		await h.call("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: {
				is: "link",
				pairs: results.map((_, i) => [`T-${i + 1}`, i === 0 ? "C-1" : "C-2"]),
			},
		});
		await h.call("report", { target: { session: "linked" }, results });
		const reader = await h.actor("reader", "human", ["read"]);
		const read = async (refs: string[]) => {
			h.app.database.resetStatementCount();
			const reply = await h.call<{ tests: { last: unknown }[] }[]>("get", { refs }, reader);
			return { reply, statements: h.app.database.statementCount };
		};
		const small = await read(["C-1"]);
		const large = await read(["C-2"]);
		expect(small.reply[0]?.tests).toHaveLength(1);
		expect(large.reply[0]?.tests).toHaveLength(200);
		expect(large.reply[0]?.tests.every((test) => test.last !== null)).toBe(true);
		console.log(`Case inventory statements: 1 test=${small.statements}, 200 tests=${large.statements}`);
		expect(large.statements).toBe(small.statements);
		const repeated = await read(Array.from({ length: 200 }, () => "C-2"));
		expect(repeated.reply).toEqual(Array.from({ length: 200 }, () => large.reply).flat());
		console.log(`Case inventory statements: 1 ref=${large.statements}, 200 refs=${repeated.statements}`);
		expect(repeated.statements).toBe(large.statements);
	} finally {
		await h.close();
	}
});

test("get reads an exact old result with diagnostics only in its project and with read permission", async () => {
	const h = await harness();
	try {
		const sent = await h.call<{ results: number[] }>("report", {
			target: { session: "sample" },
			buildUrl: "https://example.com/build/42",
			results: [
				{
					test: { key: "checkout" },
					outcome: "fail",
					failure: { message: "wrong total", detail: "checkout.ts:42" },
					steps: [{ step: "coupon", outcome: "fail" }],
				},
			],
		});
		const id = sent.results[0];
		if (id === undefined) throw new Error("Expected result");
		for (let i = 0; i < 21; i++)
			await h.call("report", {
				target: { session: `later-${i}` },
				results: [{ test: { key: "checkout" }, outcome: "pass" }],
			});
		const test = (await h.call<{ last: { id: number }[] }[]>("get", { refs: ["T-1"] }))[0];
		expect(test?.last.some((result) => result.id === id)).toBe(false);
		expect(GetReply.parse(await h.call("get", { refs: [`result:${id}`] }))).toMatchObject([
			{
				ref: `result:${id}`,
				id,
				test: "T-1",
				message: "wrong total",
				detail: "checkout.ts:42",
				steps: [{ step: "coupon", outcome: "fail" }],
				build: "https://example.com/build/42",
			},
		]);
		await h.call("admin", { do: "project.create", key: "another", preset: "loose" });
		expect(
			await invoke(h.app, OPS, {
				op: "get",
				project: "another",
				input: { refs: [`result:${id}`] },
				actor: async () => h.owner,
			}),
		).toMatchObject({ ok: false, error: { code: "not_found" } });
		const recorder = await h.actor("recorder", "ci", ["record"]);
		expect(await h.raw("get", { refs: [`result:${id}`] }, recorder)).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		for (const ref of ["result:999999", "result:-1", "result:1x", "result:999999999999999999999999999999999999"])
			expect(await h.raw("get", { refs: [ref] })).toMatchObject({
				ok: false,
				error: { code: "not_found", message: `${ref} not found` },
			});
	} finally {
		await h.close();
	}
});

test("case automation inventory separates links from current and historical evidence", async () => {
	const h = await harness({ unlinked: "ask" });
	try {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Manual checkout" } }] });
		const read = async () => GetReply.parse(await h.call("get", { refs: ["C-1"] }))[0];
		expect(await read()).toMatchObject({ tests: [], proof: { auto: null } });
		await h.call("report", {
			target: { session: "discovery" },
			results: [
				{ test: { key: "checkout", file: "checkout.test.ts" }, outcome: "pass" },
				{ test: { key: "payment", file: "checkout.test.ts" }, outcome: "pass" },
			],
		});
		const inbox = await h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "map" });
		const question = inbox.items[0];
		if (!question) throw new Error("Expected mapping question");
		await h.call("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: {
				is: "link",
				pairs: [
					["T-1", "C-1"],
					["T-2", "C-1"],
				],
			},
		});
		expect(await read()).toMatchObject({
			tests: [
				{ t: "T-1", last: null },
				{ t: "T-2", last: null },
			],
			proof: { auto: null },
		});
		await h.call("report", {
			target: { session: "linked" },
			results: [
				{ test: { key: "checkout" }, outcome: "pass" },
				{ test: { key: "payment" }, outcome: "fail", failure: { message: "declined" } },
			],
		});
		expect(await read()).toMatchObject({
			tests: [
				{ t: "T-1", last: { outcome: "pass", version: 1, current: true } },
				{ t: "T-2", last: { outcome: "fail", version: 1, current: true } },
			],
		});
		// A later result of T-1 that counted for no case (it names another case) leaves this case's last result.
		await h.call("propose", { edits: [{ op: "create", outline: "Another case" }] });
		const declined = await h.call<{ rejected: unknown[]; declined?: unknown[] }>("report", {
			target: { session: "elsewhere" },
			results: [{ test: { key: "checkout" }, annotation: { case: "C-2" }, outcome: "fail", failure: { message: "x" } }],
		});
		expect([...(declined.declined ?? []), ...declined.rejected]).toHaveLength(1);
		expect(await read()).toMatchObject({
			tests: [
				{ t: "T-1", last: { outcome: "pass", version: 1, current: true } },
				{ t: "T-2", last: { outcome: "fail", version: 1, current: true } },
			],
		});
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Updated checkout" } }] });
		expect(await read()).toMatchObject({
			tests: [
				{ last: { outcome: "pass", version: 1, current: false } },
				{ last: { outcome: "fail", version: 1, current: false } },
			],
		});
		await h.call("decide", { undo: question.q });
		expect(await read()).toMatchObject({ tests: [], proof: { auto: { outcome: "fail", version: 1, current: false } } });
	} finally {
		await h.close();
	}
});

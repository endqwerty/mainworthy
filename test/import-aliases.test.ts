import { expect, test } from "bun:test";
import type { ProposeReply } from "../src/core/ops.ts";
import { harness } from "./helpers.ts";

test("aliases are witnessed case creation and idempotent with propose", () => {
	const h = harness();
	try {
		const input = {
			edits: [{ op: "create", body: { title: "Imported" }, aliases: ["C1234"] }],
			cmd: "import-alias-once",
		};
		const first = h.call<ProposeReply>("propose", input);
		expect(h.call<ProposeReply>("propose", input)).toEqual(first);
		expect(h.call("get", { refs: ["C1234"] })).toMatchObject([{ ref: "C-1", title: "Imported" }]);
		expect(h.call("history", { ref: "C1234" })).toMatchObject({ versions: [{ version: 1 }] });
		const stored = h.app.db.raw.query<{ aliases: string }, []>("SELECT aliases FROM cases").get();
		expect(stored?.aliases).toBe('["C1234"]');
		expect(first.status).toBe("adopted");
	} finally {
		h.close();
	}
});

test("an alias conflict rolls back the whole proposal, including earlier new cases", () => {
	const h = harness();
	try {
		h.call("propose", { edits: [{ op: "create", body: { title: "Existing" }, aliases: ["C1234"] }] });
		const refused = h.raw("propose", {
			edits: [
				{ op: "create", body: { title: "Would be new" }, aliases: ["C1235"] },
				{ op: "create", body: { title: "Duplicate" }, aliases: ["C1234"] },
			],
		});
		expect(refused).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(h.raw("get", { refs: ["C1235"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(h.call("find", {})).toMatchObject({ items: [{ title: "Existing" }] });
		expect(
			h.raw("propose", {
				edits: [
					{ op: "create", body: { title: "One" }, aliases: ["SAME"] },
					{ op: "create", body: { title: "Two" }, aliases: ["SAME"] },
				],
			}),
		).toMatchObject({ ok: false, error: { code: "conflict" } });
	} finally {
		h.close();
	}
});

test("pending proposals create no aliases and recheck alias ownership when adopted", () => {
	const h = harness({ preset: "strict" });
	try {
		const input = { edits: [{ op: "create", body: { title: "Imported" }, aliases: ["C1234"] }] };
		const first = h.call<ProposeReply>("propose", input);
		const second = h.call<ProposeReply>("propose", {
			edits: [{ op: "create", body: { title: "Also pending" }, aliases: ["OLD2"] }, ...input.edits],
		});
		expect(first.status).toBe("open");
		expect(second.status).toBe("open");
		expect(h.raw("get", { refs: ["C1234"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const items = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox").items;
		const accept = (q: string | null) => {
			const item = items.find((item) => item.q === q);
			if (!item) throw new Error("missing adoption question");
			return h.call<{ status: string }[]>("decide", {
				q: item.q,
				onEvidence: item.evidenceHash,
				answer: { is: "accept" },
				reason: "Accept imported cases",
			});
		};
		expect(accept(first.question)[0]?.status).toBe("decided");
		expect(accept(second.question)[0]?.status).toBe("conflict");
		expect(h.raw("get", { refs: ["OLD2"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(h.call("get", { refs: ["C1234"] })).toMatchObject([{ ref: "C-1", title: "Imported" }]);
		expect(h.call<{ items: unknown[] }>("find", {}).items).toHaveLength(1);
	} finally {
		h.close();
	}
});

test("the registry rejects reserved aliases and callers without produce capability", () => {
	const h = harness();
	try {
		for (const alias of ["C-1", "Q-1", "123", "bad alias"])
			expect(h.raw("propose", { edits: [{ op: "create", body: { title: "Bad" }, aliases: [alias] }] })).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
		const reader = h.actor("reader", "human", ["read"]);
		expect(
			h.raw("propose", { edits: [{ op: "create", body: { title: "No capability" }, aliases: ["OLD1"] }] }, reader),
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(h.call<{ items: unknown[] }>("find", {}).items).toHaveLength(0);
	} finally {
		h.close();
	}
});

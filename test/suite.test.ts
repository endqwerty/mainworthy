import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, harness } from "./helpers.ts";

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

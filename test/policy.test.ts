// Policy is data over one model (principle P5): the same operations and the same rows under loose, standard and
// strict; only who answers changes. Also: what an agent may and may not do, and what agents read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ANSWER_KEYS, ANSWERS, type Ask, Clause, KINDS, standingOf } from "../src/core/kinds.ts";
import type { GateStatus, InboxReply, ReportReceipt } from "../src/core/ops.ts";
import { missingCatchAll, PRESET_NAMES, PRESETS } from "../src/core/presets.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness();
});
afterEach(() => h.close());
/** Replaces the default loose project with one under another preset, and another choice for tests with no case. */
const use = (preset: string, unlinked?: "ask" | "track" | "create"): void => {
	h.close();
	h = harness({ preset, ...(unlinked ? { unlinked } : {}) });
};

type Proposed = {
	proposal: string | null;
	status: string;
	question: string | null;
	needs: string | null;
	cases: { ref: string; version: number }[];
};
const first = <T>(items: T[]): T => {
	const item = items[0];
	if (item === undefined) throw new Error("expected at least one item");
	return item;
};
const queue = (input: Record<string, unknown> = {}) => h.call<InboxReply>("inbox", input);
const title = (ref: string) => h.call<{ title: string }[]>("get", { refs: [ref] })[0]?.title;

describe("who may answer", () => {
	const ask = (more: Partial<Ask>): Ask => ({
		who: "member",
		agents: "none",
		notProducer: false,
		reason: "optional",
		...more,
	});
	const person = (can: string[]) => ({ kind: "human" as const, can: can as never });
	const agent = (can: string[]) => ({ kind: "agent" as const, can: can as never });
	const standing = (actor: ReturnType<typeof person> | ReturnType<typeof agent>, clause: Ask, isProducer = false) =>
		standingOf({ actor, ask: clause, isAuthor: false, isProducer });

	test("a clause is held to everything it asks, whichever of its conditions comes first", () => {
		// The role and "did not produce the evidence" together: an administrator who reported the failure is out.
		const adminNotProducer = ask({ who: "admin", notProducer: true });
		expect(standing(person(["read", "answer", "admin"]), adminNotProducer, true)).toBe("forbidden");
		expect(standing(person(["read", "answer", "admin"]), adminNotProducer, false)).toBe("counts");
		expect(standing(person(["read", "answer"]), adminNotProducer, false)).toBe("forbidden");
		// The role and "an agent may answer" together: an agent that is not an administrator only advises.
		const adminOrAgent = ask({ who: "admin", agents: "answer" });
		expect(standing(agent(["read", "produce", "answer"]), adminOrAgent)).toBe("advice");
		expect(standing(agent(["read", "produce", "answer", "admin"]), adminOrAgent)).toBe("counts");
		expect(
			standing(
				agent(["read", "produce", "answer", "admin"]),
				ask({ who: "admin", agents: "answer", notProducer: true }),
				true,
			),
		).toBe("advice");
		expect(standing(agent(["read", "produce", "answer", "admin"]), ask({ who: "admin" }))).toBe("forbidden");
		// An author clause too: "did not produce the evidence" is not skipped for the author, nor for the
		// administrator who may stand in for one.
		const authorNotProducer = ask({ who: "author", agents: "answer", notProducer: true });
		const asAuthor = (actor: ReturnType<typeof person> | ReturnType<typeof agent>, isProducer: boolean) =>
			standingOf({ actor, ask: authorNotProducer, isAuthor: true, isProducer });
		expect(asAuthor(person(["read", "produce", "answer"]), true)).toBe("forbidden");
		expect(asAuthor(person(["read", "produce", "answer"]), false)).toBe("counts");
		expect(asAuthor(agent(["read", "produce", "answer"]), true)).toBe("forbidden");
		expect(standing(person(["read", "answer", "admin"]), authorNotProducer, true)).toBe("forbidden");
		expect(standing(person(["read", "answer", "admin"]), authorNotProducer, false)).toBe("counts");
		expect(standing(person(["read", "answer", "admin"]), ask({ who: "author" }), true)).toBe("counts");
		// What already held: a member clause.
		expect(standing(person(["read", "answer"]), ask({ notProducer: true }), true)).toBe("forbidden");
		expect(standing(agent(["read", "produce", "answer"]), ask({ agents: "answer" }))).toBe("counts");
		expect(standing(agent(["read", "produce", "answer"]), ask({ agents: "advise" }))).toBe("advice");
	});
});

describe("the presets", () => {
	test("every preset is valid and total: no kind of question is left without an owner", () => {
		for (const name of PRESET_NAMES) {
			const preset = PRESETS[name];
			for (const clause of preset.clauses) expect(Clause.safeParse(clause).success).toBe(true);
			expect(missingCatchAll(preset.clauses)).toEqual([]);
			for (const clause of preset.clauses.filter((c) => c.ask.who === "rule")) {
				expect(ANSWERS[clause.kind].safeParse(clause.answer).success).toBe(true);
			}
		}
	});

	test("every answer has one key, and no two answers of a kind share a key", () => {
		// The two answers with no key of their own: a merge carries the merged text, and `unlink` is not offered in
		// the queue. Every other answer a kind accepts must have a key, so removing one from the table fails here.
		const keyless: Record<string, string[]> = { adopt: ["merge"], map: ["unlink"] };
		for (const kind of KINDS) {
			const keys = ANSWER_KEYS[kind] as Record<string, string>;
			const answers = Object.values(keys);
			expect(new Set(answers).size).toBe(answers.length);
			const accepted = (ANSWERS[kind].options as readonly { shape: { is: { value: string } } }[]).map(
				(option) => option.shape.is.value,
			);
			expect([...answers, ...(keyless[kind] ?? [])].sort()).toEqual([...accepted].sort());
			for (const answer of answers)
				expect(
					ANSWERS[kind].safeParse({
						is: answer,
						pairs: [["T-1", "C-1"]],
						body: { title: "", pre: "", steps: [], methods: ["human"], automate: "none", fields: {} },
					}).success,
				).toBe(true);
		}
	});
});

describe("agent edits", () => {
	test("loose: an agent's edit is adopted by the rule and marked as the agent's", () => {
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		const reply = h.call<Proposed>(
			"propose",
			{ edits: [{ op: "create", outline: "Agent wrote this\n  Do it > Done" }] },
			agent,
		);
		expect(reply.status).toBe("adopted");
		const versions = h.call<{ versions: { by: string; kind: string }[] }>("history", { ref: "C-1" });
		expect(first(versions.versions)).toMatchObject({ by: "writer", kind: "agent" });
	});

	test("standard: an agent's edit waits for a person; the agent cannot accept it; a person's own edit does not wait", () => {
		use("standard");
		const agent = h.actor("writer", "agent", ["read", "produce", "answer"]);
		h.call("propose", { edits: [{ op: "create", outline: "Human wrote this\n  Do it > Done" }] });
		const reply = h.call<Proposed>(
			"propose",
			{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent retitled this" } }] },
			agent,
		);
		expect(reply).toMatchObject({ status: "open", needs: "a member who is not an agent" });
		expect(title("C-1")).toBe("Human wrote this");

		const q = first(queue().items);
		expect(q).toMatchObject({ kind: "adopt", producer: "agent" });
		const own = h.call<{ status: string }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } },
			agent,
		);
		expect(own[0]?.status).toBe("forbidden");
		const accepted = h.call<{ status: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
		expect(accepted[0]?.status).toBe("decided");
		expect(title("C-1")).toBe("Agent retitled this");
		const versions = h.call<{ versions: { by: string; kind: string }[] }>("history", { ref: "C-1" });
		expect(first(versions.versions)).toMatchObject({ by: "writer", kind: "agent" });
	});

	test("standard: a rejected proposal changes nothing and stays in the ledger", () => {
		use("standard");
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		h.call("propose", { edits: [{ op: "create", outline: "Keep me" }] });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Clobbered" } }] }, agent);
		const q = first(queue().items);
		h.call("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "reject" },
			reason: "not what the spec says",
		});
		expect(title("C-1")).toBe("Keep me");
		const ledger = queue({ state: "decided", kind: "adopt" });
		expect(ledger.items.find((item) => item.decision?.answer.is === "reject")?.decision?.reason).toBe(
			"not what the spec says",
		);
	});

	test("a person's edit made meanwhile is never overwritten by an agent's older proposal", () => {
		use("standard");
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		h.call("propose", { edits: [{ op: "create", outline: "Original" }] });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent's title" } }] }, agent);
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Person's title" } }] });
		const q = first(queue().items);
		const reply = h.call<{ status: string; needs: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
		expect(reply[0]?.status).toBe("conflict");
		expect(title("C-1")).toBe("Person's title");
	});
});

describe("changing the policy", () => {
	test("D4: the same data works under loose, standard and strict; the switch is itself a recorded decision", () => {
		h.call("propose", { edits: [{ op: "create", outline: "A case\n  Step > Result" }] });
		h.call("report", ciReport({ commit: "aaaa0001", n: 3, fail: { 0: "expected 1, got 2" } }));
		const before = h.call<GateStatus>("gate", { commit: "aaaa0001" });

		for (const preset of ["standard", "strict", "loose"]) {
			const proposed = h.call<Proposed>("propose", { edits: [{ op: "policy", preset }] });
			expect(proposed.status).toBe("open"); // the policy is an admin's to change, under every preset
			const q = first(queue({ kind: "adopt" }).items);
			const decided = h.call<{ status: string; effects: { policyVersion: number } }[]>("decide", {
				q: q.q,
				onEvidence: q.evidenceHash,
				answer: { is: "accept" },
				reason: `try ${preset}`,
			});
			expect(decided[0]?.status).toBe("decided");
			expect(h.call<{ preset: string }>("admin", { do: "policy.show", project: "scratch" }).preset).toBe(preset);
			expect(h.call<GateStatus>("gate", { commit: "aaaa0001" })).toEqual(before);
			expect(title("C-1")).toBe("A case");
		}
		expect(h.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM policies").get()?.n).toBe(4);
	});

	test("strict: a person's own edit waits for someone, with a reason", () => {
		use("strict");
		const reply = h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Needs review" }] });
		expect(reply.status).toBe("open");
		const q = first(queue().items);
		const noReason = h.call<{ status: string; needs: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
		expect(noReason[0]).toMatchObject({ status: "invalid", needs: "a reason" });
		const ok = h.call<{ status: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
			reason: "reviewed against the spec",
		});
		expect(ok[0]?.status).toBe("decided");
		expect(title("C-1")).toBe("Needs review");
	});

	test("a policy that leaves a kind of question unowned is refused", () => {
		const clauses = PRESETS.loose.clauses.filter((clause) => clause.kind !== "finding");
		const reply = h.raw("propose", { edits: [{ op: "policy", clauses }] });
		expect(reply).toMatchObject({ ok: false, error: { code: "invalid" } });
	});

	test("a project is listed under a preset's name only while it has the preset's clauses", () => {
		// The help the web shows for a preset goes by this name, and a project admin cannot read the clauses.
		const listed = () => first(h.call<{ key: string; policy: string }[]>("admin", { do: "project.list" })).policy;
		expect(listed()).toBe("loose");
		h.call("propose", { edits: [{ op: "policy", preset: "loose", clauses: PRESETS.strict.clauses }] });
		const q = first(queue({ kind: "adopt" }).items);
		// No reason: a policy change is an admin's under every preset, and asks for none.
		h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
		const stored = h.call<{ preset: string; clauses: unknown[] }>("admin", { do: "policy.show", project: "scratch" });
		expect(stored.preset).toBe("loose");
		expect(stored.clauses).toEqual(JSON.parse(JSON.stringify(PRESETS.strict.clauses)));
		expect(listed()).toBe("custom");
	});

	test("strict: a policy change needs an admin and no reason, as the guide says", () => {
		use("strict");
		h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const q = first(queue({ kind: "adopt" }).items);
		const decided = h.call<{ status: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
		expect(decided[0]?.status).toBe("decided");
		expect(h.call<{ preset: string }>("admin", { do: "policy.show", project: "scratch" }).preset).toBe("standard");
	});
});

describe("findings", () => {
	test("an agent's review opens one question per finding, is not raised twice, and an accepted suggestion becomes the agent's proposal", () => {
		use("standard");
		const agent = h.actor("reviewer", "agent", ["read", "produce"]);
		h.call("propose", {
			edits: [{ op: "create", outline: "Checkout applies a coupon\n  Apply SAVE10 > Total updates" }],
		});
		const view = h.call<{ hash: string; steps: { id: string }[] }[]>("get", { refs: ["C-1"] })[0];
		const step = first(view?.steps ?? []).id;
		const finding = {
			on: `C-1#${step}`,
			category: "cannot-fail",
			note: "'Total updates' is true for any change, including the wrong one.",
			suggest: { expected: "Total shows $90.00 (10% off $100.00)" },
		};

		const claimed = h.call<{ opened: string[]; known: unknown[]; reviewed: number }>(
			"claim",
			{ lens: "adversarial-review", reviewed: [`C-1@${view?.hash}`], findings: [finding] },
			agent,
		);
		expect(claimed).toMatchObject({ opened: ["Q-2"], known: [], reviewed: 1 });
		const again = h.call<{ opened: string[]; known: unknown[] }>(
			"claim",
			{ lens: "adversarial-review", findings: [finding] },
			agent,
		);
		expect(again.opened).toEqual([]);
		expect(again.known).toEqual([{ q: "Q-2", state: "open", answer: null, by: null }]);

		const q = first(queue({ kind: "finding" }).items);
		const accepted = h.call<{ status: string; effects: { proposal: string; status: string; adopt: string } }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept", apply: true } },
		);
		expect(accepted[0]).toMatchObject({ status: "decided", effects: { status: "open" } }); // standard: the agent's proposal still needs a person
		const adopt = first(queue({ kind: "adopt" }).items);
		expect(adopt.evidence).toMatchObject({ author: "reviewer" });
		h.call("decide", { q: adopt.q, onEvidence: adopt.evidenceHash, answer: { is: "accept" } });
		const after = h.call<{ steps: { expected: string }[]; version: number }[]>("get", { refs: ["C-1"] })[0];
		expect(after).toMatchObject({ version: 2 });
		expect(first(after?.steps ?? []).expected).toBe("Total shows $90.00 (10% off $100.00)");
	});
});

/** Changes what happens to a test with no case, as a project's admin does: a proposal and its acceptance. */
const setUnlinked = (unlinked: string): { status: string; effects: { ruled?: number } } => {
	const proposed = h.call<Proposed>("propose", { edits: [{ op: "policy", unlinked }] });
	const asked = first(queue({ kind: "adopt", on: proposed.proposal }).items);
	return first(
		h.call<{ status: string; effects: { ruled?: number } }[]>("decide", {
			q: asked.q,
			onEvidence: asked.evidenceHash,
			answer: { is: "accept" },
		}),
	);
};
const unlinkedTests = () => h.call<{ count: number }>("find", { in: "tests", unlinked: true }).count;

describe("unlinked tests", () => {
	test.each(["loose", "standard"])(
		"%s: tests with no case are tracked by the rule and still gate the build; nobody is asked",
		(preset) => {
			use(preset);
			const receipt = h.call<ReportReceipt>("report", ciReport({ commit: "bbbb0001", n: 5 }));
			expect(receipt.unlinked).toBe(5);
			expect(queue().counts.open).toBe(0);
			expect(first(queue({ state: "decided", kind: "map" }).items).decision).toMatchObject({
				answer: { is: "track" },
				rule: "map-track",
			});
			expect(receipt.gate?.verdict).toBe("passed");
		},
	);

	test("strict starts by asking, and a new project may start with another choice than its preset's", () => {
		use("strict");
		h.call("report", ciReport({ commit: "bbbb0001", n: 2 }));
		expect(queue().counts.map).toBe(1);
		h.call("admin", { do: "project.create", key: "asked", preset: "standard", unlinked: "ask" });
		const projects = h.call<{ key: string; policy: string; unlinked: string }[]>("admin", { do: "project.list" });
		expect(projects.map((p) => [p.key, p.policy, p.unlinked])).toEqual([
			["scratch", "strict", "ask"],
			["asked", "standard", "ask"],
		]);
	});

	test("ask: one question per file; `create` makes a case per test through the ordinary adopt path and links them", () => {
		use("standard");
		expect(setUnlinked("ask")).toMatchObject({ status: "decided" });
		h.call("report", ciReport({ commit: "bbbb0002", n: 3, file: "tests/checkout/coupon.spec.ts" }));
		const q = first(queue({ kind: "map" }).items);
		expect(q.title).toBe("3 tests in tests/checkout/coupon.spec.ts have no case");
		const decided = h.call<{ status: string; effects: { created: string[] } }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "create" },
		});
		expect(decided[0]).toMatchObject({ status: "decided", effects: { created: ["C-1", "C-2", "C-3"] } });
		const made = h.call<{ title: string; folder: { path: string }; methods: string[]; tests: { name: string }[] }[]>(
			"get",
			{ refs: ["C-1"] },
		)[0];
		expect(made).toMatchObject({ title: "test 0", folder: { path: "checkout" }, methods: ["auto"] });
		expect(made?.tests).toEqual([{ t: "T-1", name: "test 0", file: "tests/checkout/coupon.spec.ts" }] as never);
		const next = h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "bbbb0003", n: 3, file: "tests/checkout/coupon.spec.ts" }),
		);
		expect(next.basis).toEqual({ exact: 0, assumed: 3, unresolved: 0 });
		// undo unlinks, and keeps both decisions
		h.call("decide", { undo: q.q });
		expect(unlinkedTests()).toBe(3);
	});

	test("a link stands when another test turns up in its file: only the new test is asked about", () => {
		use("standard", "ask");
		const file = "tests/checkout/coupon.spec.ts";
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		h.call("report", ciReport({ commit: "bbbb0011", n: 2, file }));
		const asked = first(queue({ kind: "map" }).items);
		h.call("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "link", pairs: [["T-1", "C-1"]] } });
		expect(unlinkedTests()).toBe(1);
		h.call("report", ciReport({ commit: "bbbb0012", n: 3, file }));
		expect(unlinkedTests()).toBe(2);
		expect(queue({ kind: "map" }).items.map((item) => item.title)).toEqual([`2 tests in ${file} have no case`]);
		expect(h.call<{ tests: { t: string }[] }[]>("get", { refs: ["C-1"] })[0]?.tests.map((t) => t.t)).toEqual(["T-1"]);
		// The link is still its own decision, and still the person's to take back.
		expect(first(h.call<{ status: string }[]>("decide", { undo: asked.q }))).toMatchObject({ status: "reopened" });
		expect(unlinkedTests()).toBe(3);
	});

	test("a person who answered while people were asked overruled no rule: a rule the policy gets later answers", () => {
		use("standard", "ask");
		const file = "tests/checkout/coupon.spec.ts";
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		h.call("report", ciReport({ commit: "bbbb0013", n: 2, file }));
		const asked = first(queue({ kind: "map" }).items);
		h.call("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "link", pairs: [["T-1", "C-1"]] } });
		h.call("report", ciReport({ commit: "bbbb0014", n: 3, file }));
		expect(queue().counts.map).toBe(1);
		expect(setUnlinked("track")).toMatchObject({ effects: { ruled: 1 } });
		expect(queue().counts.open).toBe(0);
	});

	test("a person who linked a test the rule had tracked is asked about the file's next test: the rule was overruled", () => {
		use("standard");
		const file = "tests/checkout/coupon.spec.ts";
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		h.call("report", ciReport({ commit: "bbbb0015", n: 2, file }));
		const tracked = first(queue({ state: "decided", kind: "map" }).items);
		h.call("decide", {
			q: tracked.q,
			onEvidence: tracked.evidenceHash,
			answer: { is: "link", pairs: [["T-1", "C-1"]] },
		});
		h.call("report", ciReport({ commit: "bbbb0016", n: 3, file }));
		expect(queue({ kind: "map" }).items.map((item) => item.title)).toEqual([`2 tests in ${file} have no case`]);
	});

	test("an override is judged by the policy it was given under, not by the clause names of the policy in force", () => {
		const file = "tests/checkout/coupon.spec.ts";
		const changeClauses = (change: (clauses: Clause[]) => Clause[]) => {
			const proposed = h.call<Proposed>("propose", {
				edits: [{ op: "policy", clauses: change(structuredClone(PRESETS.standard.clauses)) }],
			});
			const asked = first(queue({ kind: "adopt", on: proposed.proposal }).items);
			return first(
				h.call<{ effects: { ruled?: number } }[]>("decide", {
					q: asked.q,
					onEvidence: asked.evidenceHash,
					answer: { is: "accept" },
				}),
			).effects.ruled;
		};
		// A person linked a test the rule had tracked. Renaming the rule's clause does not undo that they overruled it.
		use("standard");
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		h.call("report", ciReport({ commit: "bbbb0018", n: 2, file }));
		const tracked = first(queue({ state: "decided", kind: "map" }).items);
		h.call("decide", {
			q: tracked.q,
			onEvidence: tracked.evidenceHash,
			answer: { is: "link", pairs: [["T-1", "C-1"]] },
		});
		h.call("report", ciReport({ commit: "bbbb0019", n: 3, file }));
		expect(queue().counts.map).toBe(1);
		const renamed = changeClauses((clauses) =>
			clauses.map((clause) => (clause.id === "map-track" ? { ...clause, id: "renamed-track" } : clause)),
		);
		expect(renamed).toBeUndefined();
		expect(queue().counts.map).toBe(1);
		// A person linked a test while people were asked. Making the clause they answered under a rule later does
		// not turn their answer into an override.
		use("standard", "ask");
		h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		h.call("report", ciReport({ commit: "bbbb0020", n: 2, file }));
		const asked = first(queue({ kind: "map" }).items);
		h.call("decide", { q: asked.q, onEvidence: asked.evidenceHash, answer: { is: "link", pairs: [["T-1", "C-1"]] } });
		h.call("report", ciReport({ commit: "bbbb0021", n: 3, file }));
		expect(queue().counts.map).toBe(1);
		const ruled = changeClauses((clauses) =>
			clauses.map((clause) =>
				clause.id === "map-any"
					? {
							...clause,
							ask: { ...clause.ask, who: "rule" as const, agents: "none" as const },
							answer: { is: "track" },
						}
					: clause,
			),
		);
		expect(ruled).toBe(1);
		expect(queue().counts.open).toBe(0);
	});

	test("changing the choice answers every open question, however many one report raised", () => {
		use("standard", "ask");
		// More than a thousand questions from one report share ranks in the queue's order.
		const files = 2001;
		h.call("report", {
			target: { commit: "bbbb0022", branch: "main" },
			results: Array.from({ length: files }, (_, i) => ({
				test: { key: `tests/f${i}.spec.ts::one`, name: "one", file: `tests/f${i}.spec.ts` },
				outcome: "pass",
			})),
		});
		expect(queue().counts.map).toBe(files);
		expect(setUnlinked("track")).toMatchObject({ effects: { ruled: files } });
		expect(queue().counts.open).toBe(0);
	});

	test("create: a report makes a case for each test with none and links it; nobody is asked, and nothing is made twice", () => {
		use("standard");
		setUnlinked("create");
		const pipeline = h.actor("pipeline", "ci", ["record"]);
		const receipt = h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "bbbb0004", n: 3, file: "tests/checkout/coupon.spec.ts" }),
			pipeline,
		);
		expect(receipt.unlinked).toBe(3);
		expect(queue().counts.open).toBe(0);
		expect(unlinkedTests()).toBe(0);
		expect(first(queue({ state: "decided", kind: "map" }).items).decision).toMatchObject({
			answer: { is: "create" },
			rule: "map-create",
		});
		const made = h.call<{ title: string; folder: { path: string }; tests: { t: string }[] }[]>("get", {
			refs: ["C-1", "C-2", "C-3"],
		});
		expect(made.map((c) => [c.title, c.folder.path, c.tests.map((t) => t.t)])).toEqual([
			["test 0", "checkout", ["T-1"]],
			["test 1", "checkout", ["T-2"]],
			["test 2", "checkout", ["T-3"]],
		]);
		// The same tests again, and one more in the file: only the new one gets a case.
		const next = h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "bbbb0005", n: 4, file: "tests/checkout/coupon.spec.ts" }),
			pipeline,
		);
		expect(next.basis).toEqual({ exact: 0, assumed: 3, unresolved: 1 });
		expect(h.call<{ count: number }>("find", { in: "cases" }).count).toBe(4);
		expect(unlinkedTests()).toBe(0);
		expect(queue().counts.open).toBe(0);
	});

	test("create under standard: an agent's new case waits for a person, so its report leaves the file's question open", () => {
		use("standard", "create");
		const agent = h.actor("runner", "agent", ["read", "produce"]);
		h.call("report", ciReport({ commit: "bbbb0017", n: 2 }), agent);
		expect(queue().counts.map).toBe(1);
		expect(h.call<{ count: number }>("find", { in: "cases" }).count).toBe(0);
		expect(unlinkedTests()).toBe(2);
	});

	test("changing the choice answers every open question about a file at once, with no new report", () => {
		use("standard");
		setUnlinked("ask");
		for (const file of ["tests/a.spec.ts", "tests/b.spec.ts", "tests/c.spec.ts"])
			h.call("report", ciReport({ commit: "bbbb0006", n: 2, file, job: file }));
		expect(queue().counts.map).toBe(3);
		expect(setUnlinked("track")).toMatchObject({ status: "decided", effects: { ruled: 3 } });
		expect(queue().counts.open).toBe(0);
		const settled = queue({ state: "decided", kind: "map" }).items;
		expect(settled.map((item) => item.decision?.rule)).toEqual(["map-track", "map-track", "map-track"]);
		expect(unlinkedTests()).toBe(6);
		// Asking again opens nothing by itself: the rule's answers stand until a file's tests change.
		setUnlinked("ask");
		expect(queue().counts.open).toBe(0);
		h.call("report", ciReport({ commit: "bbbb0007", n: 3, file: "tests/a.spec.ts", job: "tests/a.spec.ts" }));
		expect(queue({ kind: "map" }).items.map((item) => item.title)).toEqual(["3 tests in tests/a.spec.ts have no case"]);
		// And `create` takes what is open: the cases are made by whoever changed the choice.
		expect(setUnlinked("create")).toMatchObject({ effects: { ruled: 1 } });
		expect(h.call<{ count: number }>("find", { in: "cases" }).count).toBe(3);
		// The two files the rule tracked are left as they were decided.
		expect(unlinkedTests()).toBe(4);
	});

	test("a question a person took back from the rule stays with people when the policy changes", () => {
		use("standard");
		h.call("report", ciReport({ commit: "bbbb0008", n: 2 }));
		const tracked = first(queue({ state: "decided", kind: "map" }).items);
		h.call("decide", { undo: tracked.q });
		expect(queue().counts.map).toBe(1);
		// Any change to the policy lets its rules look at the open questions again.
		expect(setUnlinked("create").effects.ruled).toBeUndefined();
		expect(queue().counts.map).toBe(1);
		expect(unlinkedTests()).toBe(2);
	});

	test("create is refused where a person adopts every new case: the rule would make none and say nothing", () => {
		use("strict");
		const refused = h.raw("propose", { edits: [{ op: "policy", unlinked: "create" }] });
		expect(refused).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(refused.ok ? "" : refused.error.message).toContain("choose ask or track");
		// `track` is open to it: the rule answers, and nobody gives a reason for a file nobody looked at.
		h.call("report", ciReport({ commit: "bbbb0009", n: 2 }));
		expect(queue().counts.map).toBe(1);
		const proposed = h.call<Proposed>("propose", { edits: [{ op: "policy", unlinked: "track" }] });
		const asked = first(queue({ kind: "adopt", on: proposed.proposal }).items);
		const reply = first(
			h.call<{ status: string; effects: { ruled?: number } }[]>("decide", {
				q: asked.q,
				onEvidence: asked.evidenceHash,
				answer: { is: "accept" },
				reason: "nobody maps unit tests here",
			}),
		);
		expect(reply).toMatchObject({ status: "decided", effects: { ruled: 1 } });
		expect(queue().counts.open).toBe(0);
	});

	test("a policy stored before the setting existed keeps asking as its clauses say", () => {
		use("standard");
		const old = PRESETS.standard.clauses.filter((clause) => !["map-track", "map-create"].includes(clause.id));
		h.app.db.raw
			.query("UPDATE policies SET clauses = ?, settings = ?")
			.run(
				JSON.stringify(old),
				JSON.stringify({ basis: "exact-or-assumed", holds: { flakyDays: 14, infraThisTargetOnly: true } }),
			);
		h.call("report", ciReport({ commit: "bbbb0010", n: 2 }));
		expect(queue().counts.map).toBe(1);
		const projects = h.call<{ policy: string; unlinked: string }[]>("admin", { do: "project.list" });
		expect(projects[0]).toMatchObject({ policy: "custom", unlinked: "ask" });
	});
});

describe("what an agent reads", () => {
	test("impact names the cases a change touches and why; since returns only what moved; get skips what the caller holds", () => {
		use("standard", "ask");
		const agent = h.actor("reviewer", "agent", ["read", "produce"]);
		h.call("propose", {
			edits: [
				{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" },
				{ op: "create", outline: "Unrelated\n  Open settings > Settings open" },
			],
		});
		h.call("report", {
			target: { commit: "cccc0001", branch: "main" },
			results: [{ test: { key: "tests/coupon.spec.ts::applies", file: "tests/coupon.spec.ts" }, outcome: "pass" }],
		});
		const map = first(queue({ kind: "map" }).items);
		h.call("decide", { q: map.q, onEvidence: map.evidenceHash, answer: { is: "link", pairs: [["T-1", "C-1"]] } });
		h.call("report", {
			target: {
				commit: "cccc0002",
				branch: "fix-coupon",
				pr: 482,
				base: "cccc0001",
				files: ["tests/coupon.spec.ts", "src/checkout/tax.ts"],
				title: "Fix coupon rounding",
			},
			results: [
				{
					test: { key: "tests/coupon.spec.ts::applies", file: "tests/coupon.spec.ts" },
					outcome: "fail",
					failure: { message: "expected 90.00, got 100.00" },
				},
			],
		});

		type Impact = {
			counts: Record<string, number>;
			cases: { id: string; hash: string; why: string[]; reviewed?: boolean; open?: { q: string }[] }[];
			uncovered: string[];
			cursor: string;
			gate: { verdict: string };
		};
		const impact = h.call<Impact>("impact", { change: "pr:482" }, agent);
		expect(impact.counts).toEqual({ cases: 1, unreviewed: 1, failing: 1, uncovered: 1 });
		expect(first(impact.cases)).toMatchObject({ id: "C-1", why: ["test:tests/coupon.spec.ts", "failing", "question"] });
		expect(first(impact.cases).open).toHaveLength(1);
		expect(impact.uncovered).toEqual(["src/checkout/tax.ts"]);
		expect(impact.gate.verdict).toBe("blocked");

		const held = first(impact.cases).hash;
		expect(h.call<Record<string, unknown>[]>("get", { refs: ["C-1"], unless: { "C-1": held } }, agent)).toEqual([
			{ ref: "C-1", unchanged: true, hash: held },
		]);
		h.call("claim", { lens: "adversarial-review", about: "pr:482", reviewed: [`C-1@${held}`], findings: [] }, agent);
		expect(first(h.call<Impact>("impact", { change: "pr:482" }, agent).cases).reviewed).toBe(true);
		expect(first(h.call<Impact>("impact", { change: "pr:482", ledger: false }, agent).cases).reviewed).toBeUndefined();

		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon applies exactly" } }] });
		const moved = h.call<{ changed: { ref: string; changed: string }[]; cursor: string }>(
			"since",
			{ cursor: impact.cursor },
			agent,
		);
		expect(moved.changed).toEqual([
			{
				ref: "C-1",
				version: 2,
				hash: expect.any(String),
				title: "Coupon applies exactly",
				state: "active",
				changed: "title",
			},
		] as never);
		expect(h.call<{ changed: unknown[] }>("since", { cursor: moved.cursor }, agent).changed).toEqual([]);
	});

	test("check finds cases that cannot fail", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "Has no steps" },
				{ op: "create", outline: "No expectation\n  Click the button" },
				{ op: "create", outline: "Fine\n  Click > It opens" },
			],
		});
		const result = h.call<{ problems: { rule: string; ref: string }[]; counts: Record<string, number> }>("check");
		expect(result.problems.map((p) => [p.rule, p.ref])).toEqual([
			["no-steps", "C-1"],
			["no-expected", "C-2"],
		]);
	});
});

describe("forgetting a person", () => {
	test("removes who they were and keeps what they did; their token stops working", () => {
		const dana = h.actor("dana", "human", ["read", "produce", "answer"]);
		h.call("propose", { edits: [{ op: "create", outline: "Written by Dana" }] }, dana);
		const forgotten = h.call<{ forgotten: string; tokensRevoked: number }>("admin", {
			do: "actor.forget",
			name: "dana",
		});
		expect(forgotten).toEqual({ forgotten: expect.stringMatching(/^forgotten-\d+$/), tokensRevoked: 1 });
		const versions = h.call<{ versions: { by: string }[] }>("history", { ref: "C-1" });
		expect(first(versions.versions).by).toBe(forgotten.forgotten);
		expect(title("C-1")).toBe("Written by Dana"); // the record itself is untouched
		expect(
			h.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM tokens WHERE revoked_at IS NULL").get()?.n,
		).toBe(0);
		expect(h.raw("admin", { do: "actor.forget", name: "robin" })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
	});
});

describe("a conflicted proposal", () => {
	test("its agent author may withdraw it and try again, but cannot push it through", () => {
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		h.call("propose", { edits: [{ op: "create", outline: "Original" }] });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "A person's title" } }] });
		const stale = h.call<Proposed>(
			"propose",
			{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "The agent's title" } }] },
			agent,
		);
		expect(stale.status).toBe("conflict");
		expect(stale.needs).toContain("propose again on the current version");
		const q = first(queue({ kind: "adopt" }).items);
		const body = { title: "The agent's title", pre: "", steps: [], methods: ["human"], automate: "none", fields: {} };
		const pushed = h.call<{ status: string }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "merge", body } },
			agent,
		);
		expect(pushed[0]?.status).toBe("forbidden");
		const withdrawn = h.call<{ status: string }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "reject" } },
			agent,
		);
		expect(withdrawn[0]?.status).toBe("decided");
		expect(title("C-1")).toBe("A person's title");
		const retry = h.call<Proposed>(
			"propose",
			{ edits: [{ op: "edit", case: "C-1", base: 2, body: { title: "The agent's title" } }] },
			agent,
		);
		expect(retry.status).toBe("adopted");
	});
});

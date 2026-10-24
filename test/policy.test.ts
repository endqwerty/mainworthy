// Policy is data over one model (principle P5): the same operations and the same rows under loose, standard and
// strict; only who answers changes. Also: what an agent may and may not do, and what agents read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ANSWER_KEYS, ANSWERS, type Ask, Clause, KINDS, type Policy, standingOf } from "../src/core/kinds.ts";
import { parseCase } from "../src/core/markdown.ts";
import { emptyBody } from "../src/core/model.ts";
import type { GateStatus, InboxReply, PlanReply, ReportReceipt } from "../src/core/ops.ts";
import { missingCatchAll, PRESET_NAMES, PRESETS } from "../src/core/presets.ts";
import { HANDLERS } from "../src/server/decisions/kinds.ts";
import { actorByName, invitedPerson } from "../src/server/identity/identity.ts";
import { Database, isForeignKeyViolation, type SqlValue, sql } from "../src/server/kernel/db.ts";
import { invalid } from "../src/server/kernel/errors.ts";

import { type CurrentPolicy, currentPolicy, policyAt } from "../src/server/policy/policy.ts";
import { exportArchive, importArchive, linesOf } from "../src/server/transfer/transfer.ts";
import { testDatabase } from "./db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
	h = await harness();
});
afterEach(async () => await h.close());
/** Replaces the default loose project with one under another preset, and another choice for tests with no case. */
const use = async (preset: string, unlinked?: "ask" | "track" | "create"): Promise<void> => {
	await h.close();
	h = await harness({ preset, ...(unlinked ? { unlinked } : {}) });
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
const queue = async (input: Record<string, unknown> = {}) => await h.call<InboxReply>("inbox", input);
const title = async (ref: string) => (await h.call<{ title: string }[]>("get", { refs: [ref] }))[0]?.title;

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

describe("named role grants", () => {
	test("a policy refuses a role nobody holds in its project", async () => {
		const clauses = PRESETS.strict.clauses.map((clause) =>
			clause.id === "adopt-any" ? { ...clause, ask: { ...clause.ask, who: "role:nobody-holds" } } : clause,
		);
		const propose = async () => await h.raw("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const refused = {
			ok: false,
			error: {
				code: "invalid",
				message: "clause adopt-any: no eligible actor holds role nobody-holds in this project",
			},
		};
		expect(await propose()).toMatchObject(refused);
		expect((await queue()).items).toEqual([]);
		const reviewer = await h.actor("role-holder", "human", ["read"]);
		await h.call("admin", { do: "project.create", key: "other" });
		await h.call("admin", {
			do: "grant.set",
			actor: reviewer.name,
			project: "other",
			can: ["read", "produce", "answer"],
			roles: ["nobody-holds"],
		});
		expect(await propose()).toMatchObject(refused);
		await h.call("admin", {
			do: "grant.set",
			actor: reviewer.name,
			project: "scratch",
			can: ["read"],
			roles: ["nobody-holds"],
		});
		expect(await propose()).toMatchObject(refused);
		await h.call("admin", { do: "grant.set", actor: reviewer.name, can: ["read", "produce", "answer"] });
		// Its global grant supplies answer and produce, so the scoped role can count here.
		expect(await propose()).toMatchObject({ ok: true, result: { status: "open" } });
	});

	test("a personal role uses team permissions and loses eligibility when membership ends", async () => {
		await h.actor("team-approver", "human", ["read"]);
		await h.call("admin", { do: "team.create", name: "Reviewers" });
		await h.call("admin", { do: "team.grant.set", team: "Reviewers", project: "scratch", can: ["produce", "answer"] });
		await h.call("admin", { do: "team.member.add", team: "Reviewers", person: "team-approver" });
		const clauses = PRESETS.strict.clauses.map((clause) =>
			clause.id === "adopt-any" ? { ...clause, ask: { ...clause.ask, who: "role:approver" } } : clause,
		);
		const propose = async () => await h.raw("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const refused = {
			ok: false,
			error: { code: "invalid", message: "clause adopt-any: no eligible actor holds role approver in this project" },
		};
		expect(await propose()).toMatchObject(refused);
		await h.call("admin", {
			do: "grant.set",
			actor: "team-approver",
			project: "scratch",
			can: ["read"],
			roles: ["approver"],
		});
		expect(await h.app.database.read(async (db) => await actorByName(db, "team-approver", 1))).toMatchObject({
			can: ["read", "record", "produce", "answer"],
			roles: ["approver"],
		});
		expect(await propose()).toMatchObject({ ok: true, result: { status: "open" } });
		const question = first((await queue({ kind: "adopt" })).items);
		const accept = async () =>
			await h.call<{ status: string }[]>("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "accept" },
			});
		await h.call("admin", { do: "team.member.remove", team: "Reviewers", person: "team-approver" });
		expect(await accept()).toMatchObject([{ status: "invalid" }]);
		await h.call("admin", { do: "team.member.add", team: "Reviewers", person: "team-approver" });
		expect(await accept()).toMatchObject([{ status: "decided" }]);
	});

	test("a settings-only proposal keeps the role-holder requirement", async () => {
		await h.actor("settings-approver", "human", ["read", "produce", "answer"]);
		await h.call("admin", {
			do: "grant.set",
			actor: "settings-approver",
			can: ["read", "produce", "answer"],
			roles: ["approver"],
		});
		const clauses = PRESETS.strict.clauses.map((clause) =>
			clause.id === "signoff-any" ? { ...clause, ask: { ...clause.ask, who: "role:approver" } } : clause,
		);
		await h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const question = first((await queue({ kind: "adopt" })).items);
		expect(
			await h.call<{ status: string }[]>("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "accept" },
			}),
		).toMatchObject([{ status: "decided" }]);
		await h.call("admin", {
			do: "grant.set",
			actor: "settings-approver",
			can: ["read", "produce", "answer"],
			roles: [],
		});
		const policy = await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
		const edit = {
			op: "policy",
			base: policy.version,
			settings: { ...policy.settings, holds: { ...policy.settings.holds, flakyDays: 7 } },
		};
		expect(await h.raw("propose", { edits: [edit] })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "clause signoff-any: no eligible actor holds role approver in this project" },
		});
		expect((await h.call<Policy>("admin", { do: "policy.show", project: "scratch" })).settings.holds.flakyDays).toBe(
			policy.settings.holds.flakyDays,
		);
		expect(await h.raw("propose", { edits: [{ ...edit, clauses: PRESETS.strict.clauses }] })).toMatchObject({
			ok: true,
			result: { status: "open" },
		});
	});

	test("a policy rechecks role holders when its waiting proposal is accepted", async () => {
		const reviewer = await h.actor("role-holder", "human", ["read", "produce", "answer"]);
		const grant = async (roles: string[]) =>
			await h.call("admin", { do: "grant.set", actor: reviewer.name, can: ["read", "produce", "answer"], roles });
		await grant(["approver"]);
		const clauses = PRESETS.strict.clauses.map((clause) =>
			clause.id === "adopt-any" ? { ...clause, ask: { ...clause.ask, who: "role:approver" } } : clause,
		);
		await h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const question = first((await queue({ kind: "adopt" })).items);
		await grant([]);
		const accept = async () =>
			await h.call<{ status: string; needs: string }[]>("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "accept" },
			});
		expect(await accept()).toMatchObject([
			{ status: "invalid", needs: "clause adopt-any: no eligible actor holds role approver in this project" },
		]);
		expect((await h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" })).version).toBe(1);
		expect((await queue({ kind: "adopt" })).items.map((item) => item.q)).toEqual([question.q]);
		await grant(["approver"]);
		expect(await accept()).toMatchObject([{ status: "decided" }]);
		expect((await h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" })).version).toBe(2);
	});

	test("an agent with a role counts only when the clause permits agent answers", async () => {
		const agent = await h.actor("role-agent", "agent", ["read", "produce", "answer"]);
		await h.call("admin", {
			do: "grant.set",
			actor: agent.name,
			can: ["read", "produce", "answer"],
			roles: ["approver"],
		});
		const clauses = (agents: "answer" | "none") =>
			PRESETS.strict.clauses.map((clause) =>
				clause.id === "adopt-any" ? { ...clause, ask: { ...clause.ask, who: "role:approver", agents } } : clause,
			);
		expect(await h.raw("propose", { edits: [{ op: "policy", base: 1, clauses: clauses("none") }] })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		await h.call("propose", { edits: [{ op: "policy", base: 1, clauses: clauses("answer") }] });
		const policyQuestion = first((await queue({ kind: "adopt" })).items);
		await h.call("decide", { q: policyQuestion.q, onEvidence: policyQuestion.evidenceHash, answer: { is: "accept" } });
		await h.call("propose", { edits: [{ op: "create", outline: "An agent may review this" }] });
		const question = first((await queue({ kind: "adopt" })).items);
		expect(
			await h.call<{ status: string }[]>(
				"decide",
				{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" }, reason: "reviewed" },
				(await h.app.database.read(async (db) => await actorByName(db, agent.name, 1))) ?? agent,
			),
		).toMatchObject([{ status: "decided" }]);
		expect(await title("C-1")).toBe("An agent may review this");
	});

	test("a grant keeps its roles per project and removing it removes those roles", async () => {
		const reviewer = await h.actor("reviewer", "human", ["read", "produce", "answer"]);
		await h.call("admin", { do: "project.create", key: "other" });
		await h.call("admin", {
			do: "grant.set",
			actor: reviewer.name,
			project: "scratch",
			can: ["read", "produce", "answer"],
			roles: ["approver", "lead", "approver"],
		});
		await h.call("admin", { do: "token.create", actor: reviewer.name, kind: "human" });
		expect(
			await h.app.database.write(
				async (db) =>
					await db.transaction(
						async () => await invitedPerson(h.app, db, { name: reviewer.name, can: [], project: 0 }),
					),
			),
		).toMatchObject({
			name: reviewer.name,
			isNew: false,
		});
		const actors = async () =>
			await h.call<{ name: string; grants: { project: string; can: string[]; roles: string[] }[] }[]>("admin", {
				do: "actor.list",
			});
		expect((await actors()).find((actor) => actor.name === reviewer.name)?.grants).toEqual([
			{ project: "*", can: ["read", "record", "produce", "answer"], roles: [] },
			{ project: "scratch", can: ["read", "record", "produce", "answer"], roles: ["approver", "lead"] },
		]);
		await h.call("admin", {
			do: "grant.set",
			actor: reviewer.name,
			can: ["read", "produce", "answer"],
			roles: ["auditor"],
		});
		expect((await h.app.database.read(async (db) => await actorByName(db, reviewer.name, 1)))?.roles).toEqual([
			"auditor",
			"approver",
			"lead",
		]);
		expect((await h.app.database.read(async (db) => await actorByName(db, reviewer.name, 2)))?.roles).toEqual([
			"auditor",
		]);
		await h.call("admin", { do: "grant.set", actor: reviewer.name, can: ["read", "produce", "answer"], roles: [] });
		await h.call("admin", { do: "grant.remove", actor: reviewer.name, project: "scratch" });
		expect((await actors()).find((actor) => actor.name === reviewer.name)?.grants).toEqual([
			{ project: "*", can: ["read", "record", "produce", "answer"], roles: [] },
		]);
	});
	test("named role eligibility keeps every other condition and validates role selectors", () => {
		const ask: Ask = { who: "role:approver", agents: "answer", notProducer: true, reason: "required" };
		const person = { kind: "human", can: ["produce", "answer"], roles: ["approver"] } as const;
		const standing = (actor: Parameters<typeof standingOf>[0]["actor"], isProducer = false) =>
			standingOf({ actor, ask, isAuthor: false, isProducer });
		expect(standing(person)).toBe("counts");
		expect(standing(person, true)).toBe("forbidden");
		expect(standing({ ...person, roles: [] })).toBe("forbidden");
		expect(standing({ ...person, can: ["produce", "admin"] })).toBe("forbidden");
		expect(standing({ ...person, kind: "ci" })).toBe("forbidden");
		expect(standing({ ...person, kind: "agent" })).toBe("counts");
		expect(standing({ ...person, kind: "agent" }, true)).toBe("advice");
		expect(standing({ ...person, kind: "agent", roles: [] })).toBe("advice");
		expect(
			standingOf({
				actor: { ...person, kind: "agent" },
				ask: { ...ask, agents: "none" },
				isAuthor: false,
				isProducer: false,
			}),
		).toBe("forbidden");
		for (const who of ["role:", "role:Approver", "role:a b", `role:${"a".repeat(33)}`])
			expect(Clause.safeParse({ ...PRESETS.strict.clauses[0], ask: { ...ask, who } }).success).toBe(false);
	});

	test("a named role requires that project role, answer permission, independence and a reason", async () => {
		const reviewer = await h.actor("reviewer", "human", ["read", "produce", "answer"]);
		const clauses = PRESETS.strict.clauses.map((clause) =>
			clause.id === "adopt-any"
				? { ...clause, ask: { who: "role:approver", agents: "none", notProducer: true, reason: "required" } }
				: clause,
		);
		await h.call("admin", {
			do: "grant.set",
			actor: reviewer.name,
			can: ["read", "produce", "answer"],
			roles: ["approver"],
		});
		await h.call("propose", {
			edits: [
				{ op: "policy", base: (await h.app.database.read(async (db) => await currentPolicy(db, 1))).version, clauses },
			],
		});
		const policyQuestion = first((await queue({ kind: "adopt" })).items);
		await h.call("decide", { q: policyQuestion.q, onEvidence: policyQuestion.evidenceHash, answer: { is: "accept" } });
		await h.call("admin", { do: "grant.set", actor: reviewer.name, can: ["read", "produce", "answer"], roles: [] });
		const proposed = await h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Role reviewed case" }] });
		const question = first((await queue({ kind: "adopt" })).items);
		expect(proposed.needs).toContain("approver");
		const answer = async (as = h.owner, reason?: string) =>
			first(
				await h.call<{ status: string; needs: string }[]>(
					"decide",
					{
						q: question.q,
						onEvidence: question.evidenceHash,
						answer: { is: "accept" },
						...(reason ? { reason } : {}),
					},
					as,
				),
			);
		expect((await answer(h.owner, "admin alone is insufficient")).status).toBe("forbidden");
		expect((await answer(reviewer, "not an approver yet")).status).toBe("forbidden");
		await h.call("admin", {
			do: "grant.set",
			actor: reviewer.name,
			project: "scratch",
			can: ["read", "produce", "answer"],
			roles: ["approver"],
		});
		// The harness carries actors by value; re-read authority exactly as a real request does.
		const current = async () =>
			(await h.app.database.read(async (db) => await actorByName(db, reviewer.name, 1))) ?? reviewer;
		expect((await answer(await current())).status).toBe("invalid");
		expect(await h.raw("get", { refs: ["C-1"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect((await answer(await current(), "independent review complete")).status).toBe("decided");
		expect(await title("C-1")).toBe("Role reviewed case");
		const own = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "create", outline: "Own proposal" }] },
			await current(),
		);
		const ownQuestion = first((await queue({ kind: "adopt" })).items);
		expect(own.status).toBe("open");
		expect(
			first(
				await h.call<{ status: string }[]>(
					"decide",
					{
						q: ownQuestion.q,
						onEvidence: ownQuestion.evidenceHash,
						answer: { is: "accept" },
						reason: "my own review",
					},
					await current(),
				),
			).status,
		).toBe("forbidden");
	});
});

describe("rule answers", () => {
	const edited = async (answer: unknown) => {
		const policy = await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.map((clause) => (clause.id === "map-track" ? { ...clause, answer } : clause));
		return { policy, edit: { op: "policy", base: policy.version, clauses } };
	};

	test("a proposal refuses a rule answer its question kind does not accept, and stores nothing", async () => {
		const { policy, edit } = await edited({ is: "approve" });
		expect(await h.raw("propose", { edits: [edit] })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "Clause map-track needs a valid map rule answer." },
		});
		expect(await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" })).toEqual(
			policy,
		);
		expect((await queue()).items).toEqual([]);
	});

	test("automatic creation refuses a policy whose rule rejects new cases", async () => {
		const policy = await h.call<CurrentPolicy>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.map((clause) =>
			clause.id === "adopt-any" ? { ...clause, answer: { is: "reject" } } : clause,
		);
		expect(await h.raw("propose", { edits: [{ op: "policy", base: 1, clauses, unlinked: "create" }] })).toMatchObject({
			ok: false,
			error: {
				code: "invalid",
				message: "tests with no case need a rule that accepts new cases automatically: choose ask or track",
			},
		});
		expect(await h.call<CurrentPolicy>("admin", { do: "policy.show", project: "scratch" })).toEqual(policy);
		const receipt = await h.call<ReportReceipt>("report", ciReport({ commit: "bbbb0564", n: 1 }));
		expect(receipt).toMatchObject({ questions: [], unlinked: 1 });
		expect(first((await queue({ kind: "map", state: "decided" })).items).decision).toMatchObject({
			answer: { is: "track" },
		});
	});

	test("creating cases refuses a rejection rule and leaves its question open", async () => {
		const policy = await h.call<CurrentPolicy>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.map((clause) =>
			clause.id === "adopt-any" ? { ...clause, answer: { is: "reject" } } : clause,
		);
		await h.call("propose", { edits: [{ op: "policy", base: 1, clauses, unlinked: "ask" }] });
		const adopt = first((await queue({ kind: "adopt" })).items);
		expect(
			await h.call("decide", { q: adopt.q, onEvidence: adopt.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "decided" }]);
		await h.call("report", ciReport({ commit: "bbbb0564", n: 1 }));
		const map = first((await queue({ kind: "map" })).items);
		expect(await h.call("decide", { q: map.q, onEvidence: map.evidenceHash, answer: { is: "create" } })).toMatchObject([
			{
				status: "invalid",
				needs:
					"this policy does not accept new cases automatically: change the adoption rule, or propose the cases, have them adopted, then link",
			},
		]);
		expect((await queue({ kind: "map" })).items.map((item) => [item.q, item.state, item.decision])).toEqual([
			[map.q, "open", null],
		]);
		expect(await h.call("find", { in: "cases" })).toMatchObject({ count: 0, items: [], cursor: null });
		expect(await h.call("find", { in: "tests", unlinked: true })).toMatchObject({ count: 1 });
	});

	test("automatic creation leaves its question open when a folder rule rejects the sealed cases", async () => {
		const policy = await h.call<CurrentPolicy>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.flatMap((clause) =>
			clause.id === "adopt-any"
				? [{ ...clause, id: "reject-checkout", when: ["folder:checkout"], answer: { is: "reject" } }, clause]
				: [clause],
		);
		await h.call("propose", { edits: [{ op: "policy", base: 1, clauses, unlinked: "create" }] });
		const adopt = first((await queue({ kind: "adopt" })).items);
		expect(
			await h.call("decide", { q: adopt.q, onEvidence: adopt.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "decided" }]);
		const receipt = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "bbbb0564", n: 1, file: "tests/checkout/coupon.spec.ts" }),
		);
		const map = first((await queue({ kind: "map" })).items);
		expect(receipt).toMatchObject({ questions: [], unlinked: 1 });
		expect(map).toMatchObject({ state: "open", decision: null });
		expect(await h.call("decide", { q: map.q, onEvidence: map.evidenceHash, answer: { is: "create" } })).toMatchObject([
			{
				status: "invalid",
				needs: "the adoption rule did not create every requested case; no tests were linked",
			},
		]);
		expect(await h.call("find", { in: "cases" })).toMatchObject({ count: 0, items: [], cursor: null });
		expect(await h.call("find", { in: "tests", unlinked: true })).toMatchObject({ count: 1 });
	});

	test("a merge rule that can match a conflict-free proposal is refused", async () => {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Original" } }] });
		const policy = await h.call<CurrentPolicy>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.map((clause) =>
			clause.id === "adopt-any" ? { ...clause, answer: { is: "merge", body: emptyBody("Forced") } } : clause,
		);
		expect(await h.raw("propose", { edits: [{ op: "policy", base: 1, clauses }] })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "Clause adopt-any: a merge rule must require conflict." },
		});
		expect(
			await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Edited" } }] }),
		).toMatchObject({
			status: "adopted",
		});
		expect(await title("C-1")).toBe("Edited");
	});

	test("a stored merge rule does not generate replacements for a conflict-free proposal", async () => {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Original" } }] });
		const policy = await h.call<CurrentPolicy>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.map((clause) =>
			clause.id === "adopt-any" ? { ...clause, answer: { is: "merge", body: emptyBody("Forced") } } : clause,
		);
		// An already accepted policy from a release that allowed this rule.
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE policies SET clauses = $1"), [JSON.stringify(clauses)]),
				),
		);
		// Stop the broken implementation before unbounded recursion can occupy the test worker.
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.exec(
							`CREATE FUNCTION bound_merge_proposals_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM proposals) >= 4 THEN RAISE EXCEPTION 'merge rule generated repeated proposals'; END IF; RETURN NEW; END $$; CREATE TRIGGER bound_merge_proposals BEFORE INSERT ON proposals FOR EACH ROW EXECUTE FUNCTION bound_merge_proposals_fn()`,
						),
				),
		);
		expect(
			await h.raw("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Edited" } }] }),
		).toMatchObject({
			ok: true,
			result: { status: "open", proposal: "P-2" },
		});
		expect(
			await h.app.database.read(
				async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM proposals")),
			),
		).toEqual({ n: 2 });
		expect(await title("C-1")).toBe("Original");
		const question = first((await queue({ kind: "adopt" })).items);
		expect(
			await h.call("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "merge", body: emptyBody("Forced") },
			}),
		).toMatchObject([{ status: "invalid", needs: "one of accept, reject: `merge` does not apply to this proposal" }]);
		expect(
			await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "decided" }]);
		expect(await title("C-1")).toBe("Edited");
	});

	test("a conflict-only merge rule adopts its replacement once under the ordinary adoption rule", async () => {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Original" } }] });
		const policy = await h.call<CurrentPolicy>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.map((clause) =>
			clause.id === "adopt-conflict"
				? { ...clause, ask: { ...clause.ask, who: "rule" }, answer: { is: "merge", body: emptyBody("Resolved") } }
				: clause,
		);
		await h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const adopt = first((await queue({ kind: "adopt" })).items);
		expect(
			await h.call("decide", { q: adopt.q, onEvidence: adopt.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "decided" }]);
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Head" } }] });
		expect(
			await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }] }),
		).toMatchObject({
			status: "adopted",
		});
		expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([{ title: "Resolved", version: 3 }]);
		expect(
			await h.app.database.read(
				async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM proposals")),
			),
		).toEqual({ n: 5 });
		expect((await queue({ kind: "adopt" })).items).toEqual([]);
	});

	// The rows an older release could store: a policy whose map-track clause answers `approve`.
	const bad = (clauses: string): string =>
		JSON.stringify(
			(JSON.parse(clauses) as Clause[]).map((c) => (c.id === "map-track" ? { ...c, answer: { is: "approve" } } : c)),
		);

	test("a pending proposal holding such a clause is refused when decided, and the policy stays", async () => {
		const { policy, edit } = await edited({ is: "create", folder: "Imported" });
		expect(await h.raw("propose", { edits: [edit] })).toMatchObject({ ok: true, result: { status: "open" } });
		const stored = await h.app.database.read(
			async (db) =>
				await db.all(sql<readonly [], { id: number; resolved: string }>("SELECT id, resolved FROM proposals")),
		);
		expect(stored).toHaveLength(1);
		const [row] = stored;
		const resolved = JSON.parse(row?.resolved ?? "[]") as { op: string; policy: Policy }[];
		for (const entry of resolved)
			if (entry.op === "policy") entry.policy.clauses = JSON.parse(bad(JSON.stringify(entry.policy.clauses)));
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE proposals SET resolved = $1 WHERE id = $2"), [
							JSON.stringify(resolved),
							row?.id ?? 0,
						]),
				),
		);
		const question = first((await queue({ kind: "adopt" })).items);
		expect(
			await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "invalid", needs: "Clause map-track needs a valid map rule answer." }]);
		expect(await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" })).toEqual(
			policy,
		);
	});

	test("an archive whose current policy holds such a clause is refused whole", async () => {
		const row = await h.app.database.read(
			async (db) =>
				await db.get(
					sql<readonly [], { version: number; clauses: string }>(
						"SELECT version, clauses FROM policies ORDER BY version DESC",
					),
				),
		);
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE policies SET clauses = $1 WHERE version = $2"), [
							bad(row?.clauses ?? "[]"),
							row?.version ?? 0,
						]),
				),
		);
		const chunks: string[] = [];
		await h.app.database.write(
			async (db) => await db.transaction(async () => await exportArchive(db, (chunk) => chunks.push(chunk))),
		);
		const restoredFixture = await testDatabase();
		const restored = await Database.open({ url: restoredFixture.url });
		try {
			await expect(restored.write(async (db) => await importArchive(db, linesOf(chunks.join(""))))).rejects.toThrow(
				"archive policy of project scratch is refused: Clause map-track needs a valid map rule answer.",
			);
			expect(
				await restored.read(
					async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM projects")),
				),
			).toEqual({
				n: 0,
			});
			expect(
				await restored.read(
					async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM policies")),
				),
			).toEqual({
				n: 0,
			});
		} finally {
			await restored.close();
			await restoredFixture.close();
		}
	});
});

describe("the presets", () => {
	test("every preset is valid and total: no kind of question is left without an owner", () => {
		for (const name of PRESET_NAMES) {
			const preset = PRESETS[name];
			expect(preset.settings.emptyReports).toBe("pending");
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
	const scopePolicy = async (when: string[], agentFallback = false) => {
		const clauses = [
			...PRESETS.loose.clauses.slice(0, 3),
			{
				id: "adopt-scoped-agent",
				kind: "adopt",
				when: ["author:agent", ...when],
				ask: { who: "member", agents: "none", notProducer: false, reason: "optional" },
				blocks: "nothing",
			},
			...(agentFallback
				? [
						{
							id: "adopt-other-agent",
							kind: "adopt",
							when: ["author:agent"],
							ask: { who: "member", agents: "answer", notProducer: false, reason: "optional" },
							blocks: "nothing",
						},
					]
				: []),
			...PRESETS.loose.clauses.slice(3),
		];
		await h.call("propose", {
			edits: [
				{
					op: "policy",
					base: (await h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" })).version,
					clauses,
				},
			],
		});
		const q = first((await queue({ kind: "adopt" })).items);
		expect(
			(
				await h.call<{ status: string }[]>("decide", {
					q: q.q,
					onEvidence: q.evidenceHash,
					answer: { is: "accept" },
				})
			)[0]?.status,
		).toBe("decided");
	};

	test.each([
		["folder:cafe\u0301", "folder:café"],
		// Lower case can make a new composable pair, so the suggested form must already be in NFC.
		["folder:T\u0308", "folder:\u1e97"],
		["folder:checkout\u200b", "folder:checkout"],
		["tag:crit\u200bical", "tag:critical"],
		["folder:checkout/", "folder:checkout"],
		["folder:/checkout", "folder:checkout"],
		["folder: checkout", "folder:checkout"],
		["folder:Checkout/Coupons", "folder:checkout/coupons"],
		["folder: checkout // Coupons / ", "folder:checkout/coupons"],
		["folder:checkout/ .. /coupons", "folder:checkout/../coupons"],
		["tag:Critical", "tag:critical"],
		["tag:#critical", "tag:critical"],
		["tag: critical ", "tag:critical"],
		["tag: #Critical ", "tag:critical"],
	])("a policy refuses %s and names its normalised form", async (predicate, normalised) => {
		const clauses = structuredClone(PRESETS.standard.clauses);
		const clause = clauses.find((item) => item.id === "adopt-agent");
		if (!clause) throw new Error("expected the agent adoption clause");
		clause.when.push(predicate);
		const reply = await h.raw("propose", {
			edits: [
				{
					op: "policy",
					base: (await h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" })).version,
					clauses,
				},
			],
		});
		expect(reply).toMatchObject({ ok: false, error: { code: "invalid" } });
		if (reply.ok) throw new Error(`accepted ${predicate}`);
		expect(reply.error.message).toContain(`clause "${clause.id}"`);
		expect(reply.error.message).toContain(JSON.stringify(predicate));
		expect(reply.error.message).toContain(JSON.stringify(normalised));
		expect(await h.call("admin", { do: "policy.show", project: "scratch" })).toMatchObject({ preset: "loose" });
		expect((await queue()).counts.open).toBe(0);
	});

	test.each(["folder:", "folder:/ /", "folder:\u200b", "tag:\u200b", "tag:", "tag:..", "tag:two words"])(
		"a policy refuses an invalid scope predicate %s",
		async (predicate) => {
			const clauses = structuredClone(PRESETS.standard.clauses);
			const clause = clauses.find((item) => item.id === "adopt-agent");
			if (!clause) throw new Error("expected the agent adoption clause");
			clause.when.push(predicate);
			expect(
				await h.raw("propose", {
					edits: [
						{
							op: "policy",
							base: (await h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" })).version,
							clauses,
						},
					],
				}),
			).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
		},
	);

	test.each([
		["folder:checkout/", "Checkout/Coupons"],
		["folder:/ checkout // COUPONS /", "Checkout/Coupons"],
		["folder:checkout/ .. /coupons", "Checkout/../Coupons"],
		["tag: #Critical ", "Other"],
	])("a stored %s still holds an agent edit for a person", async (predicate, folder) => {
		await h.call("propose", { edits: [{ op: "create", outline: "Original", folder, tags: ["critical"] }] });
		await scopePolicy([predicate.startsWith("tag:") ? "tag:critical" : "folder:checkout"]);
		const policy = await h.call<{ clauses: Clause[] }>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.map((clause) =>
			clause.id === "adopt-scoped-agent" ? { ...clause, when: ["author:agent", predicate] } : clause,
		);
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE policies SET clauses = $1"), [JSON.stringify(clauses)]),
				),
		);
		const agent = await h.actor("scoped-writer", "agent", ["read", "produce", "answer"]);
		const proposed = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent edit" } }] },
			agent,
		);
		expect(proposed.status).toBe("open");
		expect(await title("C-1")).toBe("Original");
		const q = first((await queue({ kind: "adopt" })).items);
		expect(
			(
				await h.call<{ status: string }[]>(
					"decide",
					{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } },
					agent,
				)
			)[0]?.status,
		).toBe("forbidden");
	});

	test.each([
		["folder:café", "cafe\u0301", "critical"],
		["folder:cafe\u0301", "café", "critical"],
		["folder:checkout\u200b", "checkout", "critical"],
		["tag:crit\u200bical", "Other", "critical"],
		["tag:critical", "Other", "crit\u200bical"],
	])("a stored %s matches existing Unicode scope names", async (predicate, folder, tag) => {
		await h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Original", tags: ["critical"] }] });
		await scopePolicy([predicate.startsWith("tag:") ? "tag:critical" : "folder:checkout"]);
		const policy = await h.call<{ clauses: Clause[] }>("admin", { do: "policy.show", project: "scratch" });
		const clauses = policy.clauses.map((clause) =>
			clause.id === "adopt-scoped-agent" ? { ...clause, when: ["author:agent", predicate] } : clause,
		);
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE policies SET clauses = $1"), [JSON.stringify(clauses)]),
				),
		);
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE folders SET name = $1 WHERE name = 'Original'"), [folder]),
				),
		);
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () => await db.run(sql<readonly SqlValue[]>("UPDATE cases SET tags = $1"), [JSON.stringify([tag])]),
				),
		);
		const agent = await h.actor("unicode-writer", "agent", ["read", "produce", "answer"]);
		expect(
			(
				await h.call<Proposed>(
					"propose",
					{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent edit" } }] },
					agent,
				)
			).status,
		).toBe("open");
		expect(await title("C-1")).toBe("Original");
		const q = first((await queue({ kind: "adopt" })).items);
		expect(
			(
				await h.call<{ status: string }[]>(
					"decide",
					{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } },
					agent,
				)
			)[0]?.status,
		).toBe("forbidden");
	});

	test("canonical folder predicates preserve spaces and literal dot-dot segments", async () => {
		await scopePolicy(["folder:check out/.."]);
		const agent = await h.actor("scoped-writer", "agent", ["read", "produce"]);
		expect(
			(
				await h.call<Proposed>(
					"propose",
					{ edits: [{ op: "create", outline: "Literal", folder: "Check Out/../Coupons" }] },
					agent,
				)
			).status,
		).toBe("open");
		expect(
			(await h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Other", folder: "Coupons" }] }, agent))
				.status,
		).toBe("adopted");
	});

	test("folder clauses hold an agent's nested and mixed proposal for a person", async () => {
		await scopePolicy(["folder:checkout"]);
		const agent = await h.actor("scoped-writer", "agent", ["read", "produce", "answer"]);
		expect(
			(await h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Outside", folder: "Other" }] }, agent))
				.status,
		).toBe("adopted");
		const proposed = await h.call<Proposed>(
			"propose",
			{
				edits: [
					{ op: "create", outline: "Allowed", folder: "Other" },
					{ op: "create", outline: "Review me", folder: "Checkout/Coupons" },
				],
			},
			agent,
		);
		expect(proposed.status).toBe("open");
		expect(await h.raw("get", { refs: ["C-2"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const q = first((await queue({ kind: "adopt" })).items);
		expect(
			(
				await h.call<{ status: string }[]>(
					"decide",
					{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } },
					agent,
				)
			)[0]?.status,
		).toBe("forbidden");
		expect(
			(
				await h.call<{ status: string }[]>("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } })
			)[0]?.status,
		).toBe("decided");
		expect(await title("C-3")).toBe("Review me");
	});

	test("tag clauses cover inline tags and prevent removing a protected tag to escape review", async () => {
		await scopePolicy(["tag:critical"]);
		const agent = await h.actor("scoped-writer", "agent", ["read", "produce"]);
		expect(
			(await h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Inline #critical" }] }, agent)).status,
		).toBe("open");
		await h.call("propose", { edits: [{ op: "create", outline: "Human", tags: ["critical"] }] });
		expect(
			(
				await h.call<Proposed>(
					"propose",
					{ edits: [{ op: "place", cases: ["C-1"], tags: { remove: ["critical"] } }] },
					agent,
				)
			).status,
		).toBe("open");
		expect((await h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Outside" }] }, agent)).status).toBe(
			"adopted",
		);
	});

	test("repeated link edits retain the scope of every proposed tag change", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Original" }] });
		await scopePolicy(["tag:critical"]);
		const agent = await h.actor("link-writer", "agent", ["read", "produce", "answer"]);
		const proposed = await h.call<Proposed>(
			"propose",
			{
				edits: [
					{ op: "cover", case: "C-1", requirement: "REQ-1", on: true },
					{ op: "place", cases: ["C-1"], tags: { add: ["critical"] } },
					{ op: "place", cases: ["C-1"], tags: { remove: ["critical"] } },
					{ op: "cover", case: "C-1", requirement: "REQ-2", on: true },
				],
			},
			agent,
		);
		expect(proposed.status).toBe("open");
		const q = first((await queue({ kind: "adopt" })).items);
		expect(q.q).toBe(proposed.question ?? "");
		const answer = { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } };
		expect((await h.call<{ status: string }[]>("decide", answer, agent))[0]?.status).toBe("forbidden");
		expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([{ version: 1, tags: [], covers: [] }]);
		expect((await h.call<{ status: string }[]>("decide", answer))[0]?.status).toBe("decided");
		expect(await h.call("get", { refs: ["C-1"] })).toMatchObject([
			{ version: 1, tags: [], covers: ["REQ-1", "REQ-2"] },
		]);
	});

	test("folder clauses cover both sides of a move and folder renames", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "Inside", folder: "Checkout/Coupons" },
				{ op: "create", outline: "Outside", folder: "Other" },
			],
		});
		await scopePolicy(["folder:checkout"]);
		const agent = await h.actor("scoped-writer", "agent", ["read", "produce"]);
		for (const edit of [
			{ op: "place", cases: ["C-1"], folder: "Other" },
			{ op: "place", cases: ["C-2"], folder: "Checkout/Coupons" },
			{ op: "folder", folder: "Checkout", name: "Renamed" },
			{ op: "folder", folder: "Other", parent: "Checkout" },
		])
			expect((await h.call<Proposed>("propose", { edits: [edit] }, agent)).status).toBe("open");
	});

	test("renaming an ancestor requires review for protected descendants and tagged cases", async () => {
		await h.call("propose", {
			edits: [{ op: "create", outline: "Protected", folder: "Parent/Checkout", tags: ["critical"] }],
		});
		const agent = await h.actor("scoped-writer", "agent", ["read", "produce"]);
		for (const predicate of ["folder:parent/checkout", "tag:critical"]) {
			await scopePolicy([predicate]);
			expect(
				(await h.call<Proposed>("propose", { edits: [{ op: "folder", folder: "Parent", name: "Renamed" }] }, agent))
					.status,
			).toBe("open");
		}
	});

	test.each([false, true])(
		"combined ancestor and child renames require review, child first: %s",
		async (childFirst) => {
			await h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Public/Temp" }] });
			await scopePolicy(["folder:checkout/secure"]);
			const agent = await h.actor("writer", "agent", ["read", "produce"]);
			const renames = [
				{ op: "folder", folder: "Public", name: "Checkout" },
				{ op: "folder", folder: "Public/Temp", name: "Secure" },
			];
			if (childFirst) renames.reverse();
			const proposed = await h.call<Proposed>(
				"propose",
				{
					edits: [...renames, { op: "edit", case: "C-1", base: 1, body: { title: "Agent changed protected content" } }],
				},
				agent,
			);
			expect(proposed).toMatchObject({ status: "open", needs: "a member who is not an agent" });
			expect(await title("C-1")).toBe("Original");
			const q = first((await queue({ kind: "adopt" })).items);
			expect(proposed).toMatchObject({ question: q.q });
			expect(
				(
					await h.call<{ status: string }[]>("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } })
				)[0]?.status,
			).toBe("decided");
			expect((await h.call<{ title: string; folder: { path: string } }[]>("get", { refs: ["C-1"] }))[0]).toMatchObject({
				title: "Agent changed protected content",
				folder: { path: "Checkout/Secure" },
			});
		},
	);

	test.each(["create", "place"])("a %s before combined renames is reviewed at its final path", async (op) => {
		await h.call("propose", {
			edits: [
				{ op: "folder", name: "Public" },
				{ op: "folder", name: "Temp", parent: "Public" },
				{ op: "create", outline: "Outside", folder: "Other" },
			],
		});
		await scopePolicy(["folder:checkout/secure"]);
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		const edit =
			op === "create"
				? { op, outline: "New case", folder: "Public/Temp" }
				: { op, cases: ["C-1"], folder: "Public/Temp" };
		expect(
			await h.call<Proposed>(
				"propose",
				{
					edits: [
						edit,
						{ op: "folder", folder: "Public", name: "Checkout" },
						{ op: "folder", folder: "Public/Temp", name: "Secure" },
					],
				},
				agent,
			),
		).toMatchObject({ status: "open", needs: "a member who is not an agent" });
		expect((await h.call<{ folder: { path: string } }[]>("get", { refs: ["C-1"] }))[0]?.folder.path).toBe("Other");
	});

	test("combined renames of empty folders still require review", async () => {
		await h.call("propose", { edits: [{ op: "folder", name: "Temp", parent: "Public" }] });
		await scopePolicy(["folder:checkout/secure"]);
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		expect(
			await h.call<Proposed>(
				"propose",
				{
					edits: [
						{ op: "folder", folder: "Public", name: "Checkout" },
						{ op: "folder", folder: "Public/Temp", name: "Secure" },
					],
				},
				agent,
			),
		).toMatchObject({ status: "open", needs: "a member who is not an agent" });
		expect(await h.call("find", { in: "folders" })).toMatchObject({
			items: [{ path: "Public" }, { path: "Public/Temp" }],
		});
	});

	test("a temporary protected path in a batch still requires review", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Public/Temp" }] });
		await scopePolicy(["folder:checkout/secure"]);
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		expect(
			await h.call<Proposed>(
				"propose",
				{
					edits: [
						{ op: "folder", folder: "Public", name: "Checkout" },
						{ op: "folder", folder: "Public/Temp", name: "Secure" },
						{ op: "folder", folder: "Public", name: "Other" },
					],
				},
				agent,
			),
		).toMatchObject({ status: "open", needs: "a member who is not an agent" });
		expect(await title("C-1")).toBe("Original");
	});

	test("a pending child rename rechecks its final path after an ancestor changes", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Public/Temp" }] });
		await scopePolicy(["folder:checkout/secure"], true);
		const agent = await h.actor("writer", "agent", ["read", "produce", "answer"]);
		const proposed = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "folder", folder: "Public/Temp", name: "Secure" }] },
			agent,
		);
		expect(proposed.status).toBe("open");
		await h.call("propose", { edits: [{ op: "folder", folder: "Public", name: "Checkout" }] });
		const q = first((await queue({ kind: "adopt" })).items);
		expect(q.q).toBe(proposed.question ?? "");
		expect(
			(
				await h.call<{ status: string }[]>(
					"decide",
					{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } },
					agent,
				)
			)[0]?.status,
		).toBe("forbidden");
		expect((await h.call<{ folder: { path: string } }[]>("get", { refs: ["C-1"] }))[0]?.folder.path).toBe(
			"Checkout/Temp",
		);
		expect(
			(
				await h.call<{ status: string }[]>("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } })
			)[0]?.status,
		).toBe("decided");
		expect((await h.call<{ folder: { path: string } }[]>("get", { refs: ["C-1"] }))[0]?.folder.path).toBe(
			"Checkout/Secure",
		);
	});

	test("pending proposals are answered against the case's current folder and tags", async () => {
		for (const predicate of ["folder:checkout", "tag:critical"]) {
			await scopePolicy([predicate], true);
			await h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Other" }] });
			const caseRef = predicate.startsWith("folder:") ? "C-1" : "C-2";
			const agent = await h.actor(`scoped-${caseRef}`, "agent", ["read", "produce", "answer"]);
			const proposal = await h.call<Proposed>(
				"propose",
				{ edits: [{ op: "edit", case: caseRef, base: 1, body: { title: "Agent title" } }] },
				agent,
			);
			await h.call("propose", {
				edits: [{ op: "place", cases: [caseRef], folder: "Checkout", tags: { add: ["critical"] } }],
			});
			const q = (await queue({ kind: "adopt" })).items.find((q) => q.q === proposal.question);
			if (!q) throw new Error("proposal question missing");
			expect(
				(
					await h.call<{ status: string }[]>(
						"decide",
						{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } },
						agent,
					)
				)[0]?.status,
			).toBe("forbidden");
			expect(await title(caseRef)).toBe("Original");
		}
	});

	test("loose: an agent's edit is adopted by the rule and marked as the agent's", async () => {
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		const reply = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "create", outline: "Agent wrote this\n  Do it > Done" }] },
			agent,
		);
		expect(reply.status).toBe("adopted");
		const versions = await h.call<{ versions: { by: string; kind: string }[] }>("history", { ref: "C-1" });
		expect(first(versions.versions)).toMatchObject({ by: "writer", kind: "agent" });
	});

	test("standard: an agent's edit waits for a person; the agent cannot accept it; a person's own edit does not wait", async () => {
		await use("standard");
		const agent = await h.actor("writer", "agent", ["read", "produce", "answer"]);
		await h.call("propose", { edits: [{ op: "create", outline: "Human wrote this\n  Do it > Done" }] });
		const reply = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent retitled this" } }] },
			agent,
		);
		expect(reply).toMatchObject({ status: "open", needs: "a member who is not an agent" });
		expect(await title("C-1")).toBe("Human wrote this");

		const q = first((await queue()).items);
		expect(q).toMatchObject({ kind: "adopt", producer: "agent" });
		const own = await h.call<{ status: string }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } },
			agent,
		);
		expect(own[0]?.status).toBe("forbidden");
		const accepted = await h.call<{ status: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
		expect(accepted[0]?.status).toBe("decided");
		expect(await title("C-1")).toBe("Agent retitled this");
		const versions = await h.call<{ versions: { by: string; kind: string }[] }>("history", { ref: "C-1" });
		expect(first(versions.versions)).toMatchObject({ by: "writer", kind: "agent" });
	});

	test("standard: a rejected proposal changes nothing and stays in the ledger", async () => {
		await use("standard");
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		await h.call("propose", { edits: [{ op: "create", outline: "Keep me" }] });
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Clobbered" } }] }, agent);
		const q = first((await queue()).items);
		await h.call("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "reject" },
			reason: "not what the spec says",
		});
		expect(await title("C-1")).toBe("Keep me");
		const ledger = await queue({ state: "decided", kind: "adopt" });
		expect(ledger.items.find((item) => item.decision?.answer.is === "reject")?.decision?.reason).toBe(
			"not what the spec says",
		);
	});

	test("a person's edit made meanwhile is never overwritten by an agent's older proposal", async () => {
		await use("standard");
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		await h.call("propose", { edits: [{ op: "create", outline: "Original" }] });
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Agent's title" } }] }, agent);
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Person's title" } }] });
		const q = first((await queue()).items);
		const reply = await h.call<{ status: string; needs: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
		expect(reply[0]?.status).toBe("conflict");
		expect(await title("C-1")).toBe("Person's title");
	});
});

describe("policy proposal bases", () => {
	const current = async () =>
		await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
	const accept = async (proposal: Proposed, actor = h.owner) => {
		const q = first((await queue({ kind: "adopt", on: proposal.proposal })).items);
		return first(
			await h.call<{ status: string; needs: string }[]>(
				"decide",
				{
					q: q.q,
					onEvidence: q.evidenceHash,
					answer: { is: "accept" },
				},
				actor,
			),
		);
	};

	test("one proposal refuses a second policy edit before it records anything", async () => {
		const before = await current();
		const refused = await h.raw("propose", {
			edits: [
				{ op: "create", outline: "Must not be recorded" },
				{ op: "policy", preset: "strict" },
				{ op: "policy", unlinked: "ask" },
			],
		});
		expect(refused).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "send only one policy edit per proposal" },
		});
		expect(await current()).toEqual(before);
		expect((await queue({ kind: "adopt" })).items).toEqual([]);
		expect(await h.call<{ count: number; items: unknown[] }>("find", {})).toMatchObject({ count: 0, items: [] });
	});

	test("a waiting proposal made before policy versions asks to be redone without claiming a change", async () => {
		const before = await current();
		const waiting = await h.call<Proposed>("propose", {
			edits: [
				{ op: "create", outline: "Must not be partly adopted" },
				{ op: "policy", preset: "strict" },
			],
		});
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly []>("UPDATE proposals SET resolved = (resolved::jsonb #- '{1,base}')::text")),
				),
		);
		expect(await accept(waiting)).toMatchObject({
			status: "conflict",
			needs: "this proposal was made before policy versions; redo it on the current policy",
		});
		expect(await current()).toEqual(before);
		expect((await queue({ kind: "adopt" })).items).toMatchObject([{ q: waiting.question }]);
		expect(await h.call<{ count: number; items: unknown[] }>("find", {})).toMatchObject({ count: 0, items: [] });
	});

	test("P2: simultaneous saves on one version cannot both replace the policy", async () => {
		const sam = await h.actor("sam", "human", ["read", "produce", "answer", "admin"]);
		const base = await current();
		const proposals = await Promise.all(
			await mapAsync(
				[h.owner, sam],
				async (actor, index) =>
					await h.call<Proposed>(
						"propose",
						{
							edits: [
								{
									op: "policy",
									base: base.version,
									clauses: base.clauses,
									settings: { ...base.settings, holds: { ...base.settings.holds, flakyDays: 11 + index } },
								},
							],
						},
						actor,
					),
			),
		);
		expect((await accept(first(proposals))).status).toBe("decided");
		expect((await accept(first(proposals.slice(1)), sam)).status).toBe("conflict");
		expect((await current()).settings.holds.flakyDays).toBe(11);
		expect((await current()).version).toBe(base.version + 1);
		expect((await queue({ kind: "adopt" })).items).toMatchObject([{ q: first(proposals.slice(1)).question }]);
		expect((await queue({ kind: "adopt", state: "decided" })).items).toHaveLength(1);
		const stale = await h.raw(
			"propose",
			{ edits: [{ op: "policy", base: base.version, settings: base.settings }] },
			sam,
		);
		expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
	});

	test("P6: accepting a waiting proposal cannot revert a policy adopted meanwhile", async () => {
		const sam = await h.actor("sam", "human", ["read", "produce", "answer", "admin"]);
		const before = await current();
		const setup = await h.call<Proposed>("propose", {
			edits: [
				{
					op: "policy",
					base: before.version,
					clauses: before.clauses.map((c) =>
						c.id === "adopt-policy" ? { ...c, ask: { ...c.ask, notProducer: true } } : c,
					),
				},
			],
		});
		expect((await accept(setup)).status).toBe("decided");
		const base = await current();
		const waiting = await h.call<Proposed>("propose", {
			edits: [
				{ op: "create", outline: "Must not be partially adopted" },
				{
					op: "policy",
					base: base.version,
					clauses: base.clauses,
					settings: { ...base.settings, holds: { ...base.settings.holds, flakyDays: 6 } },
				},
			],
		});
		expect((await accept(waiting)).status).toBe("forbidden");
		// Another admin changes the basis while the first proposal waits.
		const other = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "policy", base: base.version, settings: { ...base.settings, basis: "exact" } }] },
			sam,
		);
		expect((await accept(other)).status).toBe("decided");
		const after = await current();
		expect((await accept(waiting, sam)).status).toBe("conflict");
		expect(await current()).toEqual(after);
		expect((await current()).settings.basis).toBe("exact");
		expect((await queue({ kind: "adopt" })).items).toMatchObject([{ q: waiting.question }]);
		expect(await h.call<{ count: number; items: unknown[] }>("find", {})).toMatchObject({ count: 0, items: [] });
	});

	test("intent-only callers without a base still cannot adopt over an intervening policy", async () => {
		const preset = await h.call<Proposed>("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const unlinked = await h.call<Proposed>("propose", { edits: [{ op: "policy", unlinked: "ask" }] });
		expect((await accept(unlinked)).status).toBe("decided");
		expect((await accept(preset)).status).toBe("conflict");
		expect(await current()).toMatchObject({ version: 2, preset: "loose", settings: { unlinked: "ask" } });
	});

	test("whole-table callers must name the version they read", async () => {
		const base = await current();
		for (const change of [{ clauses: base.clauses }, { settings: base.settings }])
			expect(await h.raw("propose", { edits: [{ op: "policy", ...change }] })).toMatchObject({
				ok: false,
				error: { code: "invalid" },
			});
		expect(await current()).toEqual(base);
	});
});

describe("changing the policy", () => {
	test("D4: the same data works under loose, standard and strict; the switch is itself a recorded decision", async () => {
		await h.call("propose", { edits: [{ op: "create", outline: "A case\n  Step > Result" }] });
		await h.call("report", ciReport({ commit: "aaaa0001", n: 3, fail: { 0: "expected 1, got 2" } }));
		const before = await h.call<GateStatus>("gate", { commit: "aaaa0001" });

		for (const preset of ["standard", "strict", "loose"]) {
			const proposed = await h.call<Proposed>("propose", { edits: [{ op: "policy", preset }] });
			expect(proposed.status).toBe("open"); // the policy is an admin's to change, under every preset
			const q = first((await queue({ kind: "adopt" })).items);
			const decided = await h.call<{ status: string; effects: { policyVersion: number } }[]>("decide", {
				q: q.q,
				onEvidence: q.evidenceHash,
				answer: { is: "accept" },
				reason: `try ${preset}`,
			});
			expect(decided[0]?.status).toBe("decided");
			expect((await h.call<{ preset: string }>("admin", { do: "policy.show", project: "scratch" })).preset).toBe(
				preset,
			);
			expect(await h.call<GateStatus>("gate", { commit: "aaaa0001" })).toEqual(before);
			expect(await title("C-1")).toBe("A case");
		}
		expect(
			(
				await h.app.database.read(
					async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM policies")),
				)
			)?.n,
		).toBe(4);
	});

	test("strict: a person's own edit waits for someone, with a reason", async () => {
		await use("strict");
		const reply = await h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Needs review" }] });
		expect(reply.status).toBe("open");
		const q = first((await queue()).items);
		const noReason = await h.call<{ status: string; needs: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
		expect(noReason[0]).toMatchObject({ status: "invalid", needs: "a reason" });
		const ok = await h.call<{ status: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
			reason: "reviewed against the spec",
		});
		expect(ok[0]?.status).toBe("decided");
		expect(await title("C-1")).toBe("Needs review");
	});

	test("a policy that leaves a kind of question unowned is refused", async () => {
		const clauses = PRESETS.loose.clauses.filter((clause) => clause.kind !== "finding");
		const reply = await h.raw("propose", {
			edits: [
				{
					op: "policy",
					base: (await h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" })).version,
					clauses,
				},
			],
		});
		expect(reply).toMatchObject({ ok: false, error: { code: "invalid" } });
	});

	test("a project is listed under a preset's name only while it has the preset's clauses", async () => {
		// The help the web shows for a preset goes by this name, and a project admin cannot read the clauses.
		const listed = async () =>
			first(await h.call<{ key: string; policy: string }[]>("admin", { do: "project.list" })).policy;
		expect(await listed()).toBe("loose");
		await h.call("propose", { edits: [{ op: "policy", base: 1, preset: "loose", clauses: PRESETS.strict.clauses }] });
		const q = first((await queue({ kind: "adopt" })).items);
		// No reason: a policy change is an admin's under every preset, and asks for none.
		await h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } });
		const stored = await h.call<{ preset: string; clauses: unknown[] }>("admin", {
			do: "policy.show",
			project: "scratch",
		});
		expect(stored.preset).toBe("loose");
		expect(stored.clauses).toEqual(JSON.parse(JSON.stringify(PRESETS.strict.clauses)));
		expect(await listed()).toBe("custom");
	});

	test("strict: a policy change needs an admin and no reason, as the guide says", async () => {
		await use("strict");
		await h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const q = first((await queue({ kind: "adopt" })).items);
		const decided = await h.call<{ status: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
		expect(decided[0]?.status).toBe("decided");
		expect((await h.call<{ preset: string }>("admin", { do: "policy.show", project: "scratch" })).preset).toBe(
			"standard",
		);
	});
});

describe("findings", () => {
	test("a claimed new-case suggestion keeps its content and creates the case once when accepted", async () => {
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout applies a coupon" }] });
		const suggest = {
			case: {
				title: "Coupon can be removed",
				folder: "checkout/coupons",
				steps: ["Apply SAVE10 > Total shows $90.00", "Remove the coupon > Total shows $100.00"],
			},
		};
		const claim = {
			cmd: "new-case-claim",
			lens: "adversarial-review",
			findings: [{ on: "C-1", category: "uncovered-path", note: "Removing the coupon is not covered.", suggest }],
		};
		const claimed = await h.call("claim", claim, agent);
		expect(await h.call<typeof claimed>("claim", claim, agent)).toEqual(claimed);
		const q = first((await queue({ kind: "finding" })).items);
		expect(q.evidence).toMatchObject({ suggest });
		const stored = await h.app.database.read(
			async (db) => await db.all(sql<readonly [], { suggest: string }>("SELECT suggest FROM findings")),
		);
		expect(stored.map((row) => JSON.parse(row.suggest))).toEqual([suggest]);
		const accept = {
			cmd: "accept-new-case",
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept", apply: true },
		};
		const accepted = await h.call<{ status: string; effects: { status: string } }[]>("decide", accept);
		expect(first(accepted)).toMatchObject({ status: "decided", effects: { status: "adopted" } });
		expect(await h.call<typeof accepted>("decide", accept)).toEqual(accepted);
		expect(
			first(await h.call<{ status: string }[]>("decide", { ...accept, cmd: "accept-new-case-again" })).status,
		).toBe("already");
		expect((await h.call<{ count: number }>("find", { in: "cases" })).count).toBe(2);
		const created = first(await h.call<Record<string, unknown>[]>("get", { refs: ["C-2"] }));
		expect(created).toMatchObject({
			title: "Coupon can be removed",
			folder: { path: "checkout/coupons" },
			version: 1,
			steps: [
				{ action: "Apply SAVE10", expected: "Total shows $90.00" },
				{ action: "Remove the coupon", expected: "Total shows $100.00" },
			],
		});
	});

	test("an agent's review opens one question per finding, is not raised twice, and an accepted suggestion becomes the agent's proposal", async () => {
		await use("standard");
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
		await h.call("propose", {
			edits: [{ op: "create", outline: "Checkout applies a coupon\n  Apply SAVE10 > Total updates" }],
		});
		const view = (await h.call<{ hash: string; steps: { id: string }[] }[]>("get", { refs: ["C-1"] }))[0];
		const step = first(view?.steps ?? []).id;
		const finding = {
			on: `C-1#${step}`,
			category: "cannot-fail",
			note: "'Total updates' is true for any change, including the wrong one.",
			suggest: { expected: "Total shows $90.00 (10% off $100.00)" },
		};

		const claimed = await h.call<{ opened: string[]; known: unknown[]; reviewed: number }>(
			"claim",
			{ lens: "adversarial-review", reviewed: [`C-1@${view?.hash}`], findings: [finding] },
			agent,
		);
		expect(claimed).toMatchObject({ opened: ["Q-2"], known: [], reviewed: 1 });
		const again = await h.call<{ opened: string[]; known: unknown[] }>(
			"claim",
			{ lens: "adversarial-review", findings: [finding] },
			agent,
		);
		expect(again.opened).toEqual([]);
		expect(again.known).toEqual([{ q: "Q-2", state: "open", answer: null, by: null }]);

		const q = first((await queue({ kind: "finding" })).items);
		const accepted = await h.call<{ status: string; effects: { proposal: string; status: string; adopt: string } }[]>(
			"decide",
			{ cmd: "accept-step-suggestion", q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept", apply: true } },
		);
		expect(accepted[0]).toMatchObject({ status: "decided", effects: { status: "open" } }); // standard: the agent's proposal still needs a person
		expect(
			await h.call<typeof accepted>("decide", {
				cmd: "accept-step-suggestion",
				q: q.q,
				onEvidence: q.evidenceHash,
				answer: { is: "accept", apply: true },
			}),
		).toEqual(accepted);
		const adopt = first((await queue({ kind: "adopt" })).items);
		expect(adopt.evidence).toMatchObject({ author: "reviewer" });
		await h.call("decide", { q: adopt.q, onEvidence: adopt.evidenceHash, answer: { is: "accept" } });
		const after = (await h.call<{ steps: { expected: string }[]; version: number }[]>("get", { refs: ["C-1"] }))[0];
		expect(after).toMatchObject({ version: 2 });
		expect(first(after?.steps ?? []).expected).toBe("Total shows $90.00 (10% off $100.00)");
	});
});

describe("policy adoption reconsiders open questions", () => {
	test("new rules settle waiting proposals, findings and failures without another report", async () => {
		await use("standard");
		await h.call("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
		const pending = await h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Coupon works" }] }, agent);
		await h.call(
			"claim",
			{
				lens: "review",
				findings: [{ on: "C-1", category: "ambiguous", note: "Coupon handling needs review" }],
			},
			agent,
		);
		await h.call("report", ciReport({ commit: "base0001", n: 1, fail: { 0: "runner unavailable" } }));
		expect((await queue()).items.map((item) => item.kind)).toEqual(["failure", "finding", "adopt"]);
		const clauses = PRESETS.loose.clauses.map((clause) => {
			if (clause.id === "failure-any" || clause.id === "finding-any")
				return {
					...clause,
					ask: { ...clause.ask, who: "rule" },
					answer: { is: clause.kind === "failure" ? "infra" : "reject" },
				};
			return clause;
		});
		const policy = await h.call<Policy & { version: number }>("admin", { do: "policy.show", project: "scratch" });
		const proposed = await h.call<Proposed>("propose", { edits: [{ op: "policy", base: policy.version, clauses }] });
		const adoption = first((await queue({ kind: "adopt", on: proposed.proposal })).items);
		expect(
			await h.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "decided", effects: { ruled: 3 } }]);
		expect((await queue()).items).toEqual([]);
		expect(await title("C-2")).toBe("Coupon works");
		expect(first((await queue({ kind: "adopt", on: pending.proposal, state: "decided" })).items)).toMatchObject({
			decision: { answer: { is: "accept" }, by: ["policy"], rule: "adopt-any" },
		});
		expect(first((await queue({ kind: "finding", state: "decided" })).items)).toMatchObject({
			decision: { answer: { is: "reject" }, by: ["policy"], rule: "finding-any" },
		});
		expect(await h.call("gate", { commit: "base0001" })).toMatchObject({
			verdict: "passed",
			tally: { excused: 1, unexplained: 0 },
		});
	});

	test("loose closes a passed strict planned run on another line by rule", async () => {
		await use("strict", "track");
		const proposal = await h.call<Proposed>("propose", { edits: [{ op: "create", outline: "Checkout works" }] });
		const adoption = first((await queue({ kind: "adopt", on: proposal.proposal })).items);
		await h.call("decide", {
			q: adoption.q,
			onEvidence: adoption.evidenceHash,
			answer: { is: "accept" },
			reason: "reviewed the case",
		});
		const planned = await h.call<PlanReply>("plan", {
			name: "another line",
			select: { cases: ["C-1"] },
			accepts: { commit: "base0001" },
		});
		await h.call("report", {
			run: planned.run,
			target: { commit: "base0001", branch: "main" },
			results: [{ test: { case: "C-1" }, outcome: "pass" }],
		});
		const signoff = first((await queue({ kind: "signoff" })).items);
		expect(signoff).toMatchObject({ state: "open", needs: "one member who is not an agent with a reason" });
		expect(await h.call("get", { refs: [planned.run] })).toMatchObject([{ state: "open", verdict: "passed" }]);
		await h.call("propose", { edits: [{ op: "policy", preset: "loose" }] });
		const policy = first((await queue({ kind: "adopt" })).items);
		expect(
			await h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([{ status: "decided" }]);
		expect(await h.call("get", { refs: [planned.run] })).toMatchObject([{ state: "closed", verdict: "passed" }]);
		expect((await queue({ kind: "signoff" })).items).toEqual([]);
		expect(first((await queue({ kind: "signoff", state: "decided" })).items)).toMatchObject({
			q: signoff.q,
			decision: { answer: { is: "approve" }, by: ["policy"], rule: "signoff-passed" },
		});
	});
});

/** Changes what happens to a test with no case, as a project's admin does: a proposal and its acceptance. */
const setUnlinked = async (unlinked: string): Promise<{ status: string; effects: { ruled?: number } }> => {
	const proposed = await h.call<Proposed>("propose", { edits: [{ op: "policy", unlinked }] });
	const asked = first((await queue({ kind: "adopt", on: proposed.proposal })).items);
	return first(
		await h.call<{ status: string; effects: { ruled?: number } }[]>("decide", {
			q: asked.q,
			onEvidence: asked.evidenceHash,
			answer: { is: "accept" },
		}),
	);
};
const unlinkedTests = async () => (await h.call<{ count: number }>("find", { in: "tests", unlinked: true })).count;

describe("unlinked tests", () => {
	test.each(["loose", "standard"])(
		"%s: tests with no case are tracked by the rule and still gate the build; nobody is asked",
		async (preset) => {
			await use(preset);
			const receipt = await h.call<ReportReceipt>("report", ciReport({ commit: "bbbb0001", n: 5 }));
			expect(receipt.unlinked).toBe(5);
			expect((await queue()).counts.open).toBe(0);
			expect(first((await queue({ state: "decided", kind: "map" })).items).decision).toMatchObject({
				answer: { is: "track" },
				rule: "map-track",
			});
			expect(receipt.gate?.verdict).toBe("passed");
		},
	);

	test("strict starts by asking, and a new project may start with another choice than its preset's", async () => {
		await use("strict");
		await h.call("report", ciReport({ commit: "bbbb0001", n: 2 }));
		expect((await queue()).counts.map).toBe(1);
		await h.call("admin", { do: "project.create", key: "asked", preset: "standard", unlinked: "ask" });
		const projects = await h.call<{ key: string; policy: string; unlinked: string }[]>("admin", { do: "project.list" });
		expect(projects.map((p) => [p.key, p.policy, p.unlinked])).toEqual([
			["scratch", "strict", "ask"],
			["asked", "standard", "ask"],
		]);
	});

	test("ask: one question per file; `create` makes a case per test through the ordinary adopt path and links them", async () => {
		await use("standard");
		expect(await setUnlinked("ask")).toMatchObject({ status: "decided" });
		await h.call("report", ciReport({ commit: "bbbb0002", n: 3, file: "tests/checkout/coupon.spec.ts" }));
		const q = first((await queue({ kind: "map" })).items);
		expect(q.title).toBe("3 tests in tests/checkout/coupon.spec.ts have no case");
		const decided = await h.call<{ status: string; effects: { created: string[] } }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "create" },
		});
		expect(decided[0]).toMatchObject({ status: "decided", effects: { created: ["C-1", "C-2", "C-3"] } });
		const made = (
			await h.call<{ title: string; folder: { path: string }; methods: string[]; tests: { name: string }[] }[]>("get", {
				refs: ["C-1"],
			})
		)[0];
		expect(made).toMatchObject({ title: "test 0", folder: { path: "checkout" }, methods: ["auto"] });
		expect(made?.tests).toEqual([{ t: "T-1", name: "test 0", file: "tests/checkout/coupon.spec.ts" }] as never);
		const next = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "bbbb0003", n: 3, file: "tests/checkout/coupon.spec.ts" }),
		);
		expect(next.basis).toEqual({ exact: 0, assumed: 3, unresolved: 0 });
		// undo unlinks, and keeps both decisions
		await h.call("decide", { undo: q.q });
		expect(await unlinkedTests()).toBe(3);
	});

	test("tests that name no file are asked about as a group, the question lists them, and `create` makes their cases", async () => {
		await use("standard", "ask");
		const bare = (i: number) => ({
			test: { key: `bare ${i}`, name: `bare ${i}` },
			outcome: "pass" as const,
			durationMs: 10,
		});
		const { target, job, attempt } = ciReport({ commit: "bbbb0004", n: 0 });
		await h.call("report", { target, job, attempt, results: [bare(0), bare(1), bare(2)] });
		const q = first((await queue({ kind: "map" })).items);
		expect(q.title).toBe("3 tests in (no file) have no case");
		expect(q.evidence).toMatchObject({ file: "(no file)", count: 3 });
		expect((q.evidence as { tests: { name: string }[] }).tests.map((test) => test.name)).toEqual([
			"bare 0",
			"bare 1",
			"bare 2",
		]);
		const decided = await h.call<{ status: string; effects: { created: string[] } }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "create" },
		});
		expect(decided[0]).toMatchObject({ status: "decided", effects: { created: ["C-1", "C-2", "C-3"] } });
		expect(await unlinkedTests()).toBe(0);
		// A file that is really called "(no file)" shares the question, and its tests are answered with it.
		await h.call("report", {
			...ciReport({ commit: "bbbb0005", n: 0 }),
			results: [
				bare(3),
				{ test: { key: "literal", name: "literal", file: "(no file)" }, outcome: "pass" as const, durationMs: 10 },
			],
		});
		const both = first((await queue({ kind: "map" })).items);
		expect((both.evidence as { tests: { name: string }[] }).tests.map((test) => test.name)).toEqual([
			"bare 3",
			"literal",
		]);
		expect(
			(
				await h.call<{ effects: { created: string[] } }[]>("decide", {
					q: both.q,
					onEvidence: both.evidenceHash,
					answer: { is: "create" },
				})
			)[0]?.effects.created,
		).toEqual(["C-4", "C-5"]);
		expect(await unlinkedTests()).toBe(0);
	});

	test("a link stands when another test turns up in its file: only the new test is asked about", async () => {
		await use("standard", "ask");
		const file = "tests/checkout/coupon.spec.ts";
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await h.call("report", ciReport({ commit: "bbbb0011", n: 2, file }));
		const asked = first((await queue({ kind: "map" })).items);
		await h.call("decide", {
			q: asked.q,
			onEvidence: asked.evidenceHash,
			answer: { is: "link", pairs: [["T-1", "C-1"]] },
		});
		expect(await unlinkedTests()).toBe(1);
		await h.call("report", ciReport({ commit: "bbbb0012", n: 3, file }));
		expect(await unlinkedTests()).toBe(2);
		expect((await queue({ kind: "map" })).items.map((item) => item.title)).toEqual([`2 tests in ${file} have no case`]);
		expect((await h.call<{ tests: { t: string }[] }[]>("get", { refs: ["C-1"] }))[0]?.tests.map((t) => t.t)).toEqual([
			"T-1",
		]);
		// The link is still its own decision, and still the person's to take back.
		expect(first(await h.call<{ status: string }[]>("decide", { undo: asked.q }))).toMatchObject({
			status: "reopened",
		});
		expect(await unlinkedTests()).toBe(3);
	});

	test("a person who answered while people were asked overruled no rule: a rule the policy gets later answers", async () => {
		await use("standard", "ask");
		const file = "tests/checkout/coupon.spec.ts";
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await h.call("report", ciReport({ commit: "bbbb0013", n: 2, file }));
		const asked = first((await queue({ kind: "map" })).items);
		await h.call("decide", {
			q: asked.q,
			onEvidence: asked.evidenceHash,
			answer: { is: "link", pairs: [["T-1", "C-1"]] },
		});
		await h.call("report", ciReport({ commit: "bbbb0014", n: 3, file }));
		expect((await queue()).counts.map).toBe(1);
		expect(await setUnlinked("track")).toMatchObject({ effects: { ruled: 1 } });
		expect((await queue()).counts.open).toBe(0);
	});

	test("a person who linked a test the rule had tracked is asked about the file's next test: the rule was overruled", async () => {
		await use("standard");
		const file = "tests/checkout/coupon.spec.ts";
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await h.call("report", ciReport({ commit: "bbbb0015", n: 2, file }));
		const tracked = first((await queue({ state: "decided", kind: "map" })).items);
		await h.call("decide", {
			q: tracked.q,
			onEvidence: tracked.evidenceHash,
			answer: { is: "link", pairs: [["T-1", "C-1"]] },
		});
		await h.call("report", ciReport({ commit: "bbbb0016", n: 3, file }));
		expect((await queue({ kind: "map" })).items.map((item) => item.title)).toEqual([`2 tests in ${file} have no case`]);
	});

	test("an override is judged by the policy it was given under, not by the clause names of the policy in force", async () => {
		const file = "tests/checkout/coupon.spec.ts";
		const changeClauses = async (change: (clauses: Clause[]) => Clause[]) => {
			const proposed = await h.call<Proposed>("propose", {
				edits: [
					{
						op: "policy",
						base: (await h.call<{ version: number }>("admin", { do: "policy.show", project: "scratch" })).version,
						clauses: change(structuredClone(PRESETS.standard.clauses)),
					},
				],
			});
			const asked = first((await queue({ kind: "adopt", on: proposed.proposal })).items);
			return first(
				await h.call<{ effects: { ruled?: number } }[]>("decide", {
					q: asked.q,
					onEvidence: asked.evidenceHash,
					answer: { is: "accept" },
				}),
			).effects.ruled;
		};
		// A person linked a test the rule had tracked. Renaming the rule's clause does not undo that they overruled it.
		await use("standard");
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await h.call("report", ciReport({ commit: "bbbb0018", n: 2, file }));
		const tracked = first((await queue({ state: "decided", kind: "map" })).items);
		await h.call("decide", {
			q: tracked.q,
			onEvidence: tracked.evidenceHash,
			answer: { is: "link", pairs: [["T-1", "C-1"]] },
		});
		await h.call("report", ciReport({ commit: "bbbb0019", n: 3, file }));
		expect((await queue()).counts.map).toBe(1);
		const renamed = await changeClauses((clauses) =>
			clauses.map((clause) => (clause.id === "map-track" ? { ...clause, id: "renamed-track" } : clause)),
		);
		expect(renamed).toBeUndefined();
		expect((await queue()).counts.map).toBe(1);
		// A person linked a test while people were asked. Making the clause they answered under a rule later does
		// not turn their answer into an override.
		await use("standard", "ask");
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await h.call("report", ciReport({ commit: "bbbb0020", n: 2, file }));
		const asked = first((await queue({ kind: "map" })).items);
		await h.call("decide", {
			q: asked.q,
			onEvidence: asked.evidenceHash,
			answer: { is: "link", pairs: [["T-1", "C-1"]] },
		});
		await h.call("report", ciReport({ commit: "bbbb0021", n: 3, file }));
		expect((await queue()).counts.map).toBe(1);
		const ruled = await changeClauses((clauses) =>
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
		expect((await queue()).counts.open).toBe(0);
	});

	test("changing the choice answers every open question, however many one report raised", async () => {
		await use("standard", "ask");
		// More than a thousand questions from one report share ranks in the queue's order.
		const files = 2001;
		await h.call("report", {
			target: { commit: "bbbb0022", branch: "main" },
			results: Array.from({ length: files }, (_, i) => ({
				test: { key: `tests/f${i}.spec.ts::one`, name: "one", file: `tests/f${i}.spec.ts` },
				outcome: "pass",
			})),
		});
		expect((await queue()).counts.map).toBe(files);
		expect(await setUnlinked("track")).toMatchObject({ effects: { ruled: files } });
		expect((await queue()).counts.open).toBe(0);
		const ledger = await h.app.database.read(
			async (db) =>
				await db.one(
					sql<readonly [], { n: number; decisions: number }>(
						"SELECT count(*) AS n, count(DISTINCT d.id) AS decisions FROM questions q JOIN decisions d ON d.id = q.decision JOIN actors a ON a.id = (d.signers::jsonb->0->>'by')::bigint WHERE q.kind = 'map' AND q.state = 'decided' AND (q.ask::jsonb)->>'who' = 'rule' AND d.kind = 'map' AND (d.answer::jsonb)->>'is' = 'track' AND d.basis = q.basis AND d.on_evidence = q.evidence_hash AND d.holds::jsonb = jsonb_build_array(jsonb_build_object('until', 'basis-changes', 'basis', q.basis)) AND d.expires_at IS NULL AND d.supersedes IS NULL AND d.effects::jsonb = '{}'::jsonb AND a.kind = 'rule'",
					),
				),
		);
		expect(ledger).toEqual({ n: files, decisions: files });
	});

	test("in the queue a test with no case comes after every question that wants a judgement, however new it is", async () => {
		await use("standard", "ask");
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
		await h.call("propose", { edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" }] });
		await h.call("report", ciReport({ commit: "bbbb0030", n: 1, file: "tests/first.spec.ts" }));
		await h.call(
			"propose",
			{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon applies once" } }] },
			agent,
		);
		await h.call(
			"claim",
			{ lens: "review", findings: [{ on: "C-1", category: "ambiguous", note: "Say which total" }] },
			agent,
		);
		await h.call(
			"report",
			ciReport({ commit: "bbbb0031", n: 2, fail: { 0: "expected 90, got 100" }, file: "tests/second.spec.ts" }),
		);
		expect((await queue()).items.map((item) => item.kind)).toEqual(["failure", "finding", "adopt", "map", "map"]);
		// Among themselves they are newest first, like the rest.
		expect((await queue({ kind: "map" })).items.map((item) => item.title)).toEqual([
			"2 tests in tests/second.spec.ts have no case",
			"1 test in tests/first.spec.ts has no case",
		]);
	});

	test("create: a report makes a case for each test with none and links it; nobody is asked, and nothing is made twice", async () => {
		await use("standard");
		await setUnlinked("create");
		const pipeline = await h.actor("pipeline", "ci", ["record"]);
		const receipt = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "bbbb0004", n: 3, file: "tests/checkout/coupon.spec.ts" }),
			pipeline,
		);
		expect(receipt.unlinked).toBe(3);
		expect((await queue()).counts.open).toBe(0);
		expect(await unlinkedTests()).toBe(0);
		expect(first((await queue({ state: "decided", kind: "map" })).items).decision).toMatchObject({
			answer: { is: "create" },
			rule: "map-create",
		});
		const made = await h.call<{ title: string; folder: { path: string }; tests: { t: string }[] }[]>("get", {
			refs: ["C-1", "C-2", "C-3"],
		});
		expect(made.map((c) => [c.title, c.folder.path, c.tests.map((t) => t.t)])).toEqual([
			["test 0", "checkout", ["T-1"]],
			["test 1", "checkout", ["T-2"]],
			["test 2", "checkout", ["T-3"]],
		]);
		// The same tests again, and one more in the file: only the new one gets a case.
		const next = await h.call<ReportReceipt>(
			"report",
			ciReport({ commit: "bbbb0005", n: 4, file: "tests/checkout/coupon.spec.ts" }),
			pipeline,
		);
		expect(next.basis).toEqual({ exact: 0, assumed: 3, unresolved: 1 });
		expect((await h.call<{ count: number }>("find", { in: "cases" })).count).toBe(4);
		expect(await unlinkedTests()).toBe(0);
		expect((await queue()).counts.open).toBe(0);
	});

	test("create under standard: an agent's new case waits for a person, so its report leaves the file's question open", async () => {
		await use("standard", "create");
		const agent = await h.actor("runner", "agent", ["read", "produce"]);
		await h.call("report", ciReport({ commit: "bbbb0017", n: 2 }), agent);
		expect((await queue()).counts.map).toBe(1);
		expect((await h.call<{ count: number }>("find", { in: "cases" })).count).toBe(0);
		expect(await unlinkedTests()).toBe(2);
	});

	test("changing the choice answers every open question about a file at once, with no new report", async () => {
		await use("standard");
		await setUnlinked("ask");
		for (const file of ["tests/a.spec.ts", "tests/b.spec.ts", "tests/c.spec.ts"])
			await h.call("report", ciReport({ commit: "bbbb0006", n: 2, file, job: file }));
		expect((await queue()).counts.map).toBe(3);
		expect(await setUnlinked("track")).toMatchObject({ status: "decided", effects: { ruled: 3 } });
		expect((await queue()).counts.open).toBe(0);
		const settled = (await queue({ state: "decided", kind: "map" })).items;
		expect(settled.map((item) => item.decision?.rule)).toEqual(["map-track", "map-track", "map-track"]);
		expect(await unlinkedTests()).toBe(6);
		// Asking again opens nothing by itself: the rule's answers stand until a file's tests change.
		await setUnlinked("ask");
		expect((await queue()).counts.open).toBe(0);
		await h.call("report", ciReport({ commit: "bbbb0007", n: 3, file: "tests/a.spec.ts", job: "tests/a.spec.ts" }));
		expect((await queue({ kind: "map" })).items.map((item) => item.title)).toEqual([
			"3 tests in tests/a.spec.ts have no case",
		]);
		// And `create` takes what is open: the cases are made by whoever changed the choice.
		expect(await setUnlinked("create")).toMatchObject({ effects: { ruled: 1 } });
		expect((await h.call<{ count: number }>("find", { in: "cases" })).count).toBe(3);
		// The two files the rule tracked are left as they were decided.
		expect(await unlinkedTests()).toBe(4);
	});

	test("a question a person took back from the rule stays with people when the policy changes", async () => {
		await use("standard");
		await h.call("report", ciReport({ commit: "bbbb0008", n: 2 }));
		const tracked = first((await queue({ state: "decided", kind: "map" })).items);
		await h.call("decide", { undo: tracked.q });
		expect((await queue()).counts.map).toBe(1);
		// Any change to the policy lets its rules look at the open questions again.
		expect((await setUnlinked("create")).effects.ruled).toBeUndefined();
		expect((await queue()).counts.map).toBe(1);
		expect(await unlinkedTests()).toBe(2);
	});

	test("create is refused where a person adopts every new case: the rule would make none and say nothing", async () => {
		await use("strict");
		const refused = await h.raw("propose", { edits: [{ op: "policy", unlinked: "create" }] });
		expect(refused).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(refused.ok ? "" : refused.error.message).toContain("choose ask or track");
		// `track` is open to it: the rule answers, and nobody gives a reason for a file nobody looked at.
		await h.call("report", ciReport({ commit: "bbbb0009", n: 2 }));
		expect((await queue()).counts.map).toBe(1);
		const proposed = await h.call<Proposed>("propose", { edits: [{ op: "policy", unlinked: "track" }] });
		const asked = first((await queue({ kind: "adopt", on: proposed.proposal })).items);
		const reply = first(
			await h.call<{ status: string; effects: { ruled?: number } }[]>("decide", {
				q: asked.q,
				onEvidence: asked.evidenceHash,
				answer: { is: "accept" },
				reason: "nobody maps unit tests here",
			}),
		);
		expect(reply).toMatchObject({ status: "decided", effects: { ruled: 1 } });
		expect((await queue()).counts.open).toBe(0);
	});

	test("a policy stored before the setting existed keeps asking as its clauses say", async () => {
		await use("standard");
		const old = PRESETS.standard.clauses.filter((clause) => !["map-track", "map-create"].includes(clause.id));
		await h.app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						await db.run(sql<readonly SqlValue[]>("UPDATE policies SET clauses = $1, settings = $2"), [
							JSON.stringify(old),
							JSON.stringify({ basis: "exact-or-assumed", holds: { flakyDays: 14, infraThisTargetOnly: true } }),
						]),
				),
		);
		await h.call("report", ciReport({ commit: "bbbb0010", n: 2 }));
		expect((await queue()).counts.map).toBe(1);
		const projects = await h.call<{ policy: string; unlinked: string }[]>("admin", { do: "project.list" });
		expect(projects[0]).toMatchObject({ policy: "custom", unlinked: "ask" });
		expect(await h.call("admin", { do: "policy.show", project: "scratch" })).toMatchObject({
			settings: { emptyReports: "pending" },
		});
	});
});

describe("what an agent reads", () => {
	type ReviewImpact = {
		cases: { id: string; hash: string; reviewed?: boolean }[];
		counts: { cases: number; unreviewed: number };
		cursor: string;
	};
	const reviewFixture = async () => {
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
		await h.call("propose", {
			edits: ["Coupon applies", "Coupon expires"].map((title) => ({
				op: "create",
				outline: `${title}\n  Apply coupon > Correct total`,
				covers: ["WEB-290"],
			})),
		});
		const report = async (pr: number, commit: string) =>
			await h.call("report", {
				target: { commit, pr, title: "WEB-290: fix coupons" },
				results: [{ test: { case: "C-1" }, outcome: "pass" }],
			});
		await report(482, "cccc0001");
		const read = async (change = "pr:482", since?: string) =>
			await h.call<ReviewImpact>("impact", { change, since }, agent);
		const initial = await read();
		const claim = async (patch: string, cases = initial.cases, about = "pr:482") =>
			await h.call(
				"claim",
				{
					lens: "adversarial-review",
					about,
					patch,
					reviewed: cases.map((row) => `${row.id}@${row.hash}`),
				},
				agent,
			);
		return { agent, report, read, claim, initial };
	};

	test("a review of one change does not review another change at the same commit and case version", async () => {
		const f = await reviewFixture();
		await f.claim("cccc0001");
		expect((await f.read()).counts).toMatchObject({ cases: 2, unreviewed: 0 });
		await f.report(483, "cccc0001");
		expect((await f.read("pr:483")).counts).toMatchObject({ cases: 2, unreviewed: 2 });
	});

	test("A5: a pushed fix invalidates reviews, including unchanged cases requested since a cursor", async () => {
		const f = await reviewFixture();
		await f.claim("cccc0001");
		const reviewed = await f.read();
		await f.report(482, "cccc0002");
		expect((await f.read()).counts).toMatchObject({ cases: 2, unreviewed: 2 });
		expect(await f.read("pr:482", reviewed.cursor)).toMatchObject({
			cases: f.initial.cases,
			counts: { cases: 2, unreviewed: 2 },
		});
		// A late claim must keep the patch actually read, even after the head moved.
		await f.claim("cccc0001");
		expect((await f.read()).counts.unreviewed).toBe(2);
		await f.claim("cccc0002");
		expect((await f.read()).counts.unreviewed).toBe(0);
		const timeline = await h.call<{ entries: { t: string }[] }>("timeline", { ref: "C-1" });
		expect(timeline.entries.filter((entry) => entry.t === "review")).toHaveLength(2);
	});

	test("a review without an exact change basis, or by another caller, cannot cover the change", async () => {
		const f = await reviewFixture();
		const reviewed = f.initial.cases.map((row) => `${row.id}@${row.hash}`);
		for (const basis of [{}, { about: "pr:482" }, { patch: "cccc0001" }]) {
			await h.call("claim", { lens: "review", reviewed, ...basis }, f.agent);
			expect((await f.read()).counts.unreviewed).toBe(2);
		}
		await f.claim("cccc0001");
		expect((await f.read()).counts.unreviewed).toBe(0);
		expect((await h.call<ReviewImpact>("impact", { change: "pr:482" })).counts.unreviewed).toBe(2);
	});

	test("A5: unchanged patch preserves reviews and a case edit invalidates only that case", async () => {
		const f = await reviewFixture();
		await f.claim("cccc0001");
		const reviewed = await f.read();
		await f.report(482, "cccc0001");
		expect((await f.read()).counts).toMatchObject({ cases: 2, unreviewed: 0 });
		expect((await f.read("pr:482", reviewed.cursor)).cases).toEqual([]);
		await h.call("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon applies exactly" } }],
		});
		const moved = await f.read("pr:482", reviewed.cursor);
		expect(moved.counts).toMatchObject({ cases: 1, unreviewed: 1 });
		expect(moved.cases.map((row) => row.id)).toEqual(["C-1"]);
		expect((await f.read()).counts).toMatchObject({ cases: 2, unreviewed: 1 });
	});

	test("impact names the cases a change touches and why; since returns only what moved; get skips what the caller holds", async () => {
		await use("standard", "ask");
		const agent = await h.actor("reviewer", "agent", ["read", "produce"]);
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total is 90" },
				{ op: "create", outline: "Unrelated\n  Open settings > Settings open" },
			],
		});
		await h.call("report", {
			target: { commit: "cccc0001", branch: "main" },
			results: [{ test: { key: "tests/coupon.spec.ts::applies", file: "tests/coupon.spec.ts" }, outcome: "pass" }],
		});
		const map = first((await queue({ kind: "map" })).items);
		await h.call("decide", { q: map.q, onEvidence: map.evidenceHash, answer: { is: "link", pairs: [["T-1", "C-1"]] } });
		await h.call("report", {
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
		const impact = await h.call<Impact>("impact", { change: "pr:482" }, agent);
		expect(impact.counts).toEqual({ cases: 1, unreviewed: 1, failing: 1, uncovered: 1 });
		expect(first(impact.cases)).toMatchObject({ id: "C-1", why: ["test:tests/coupon.spec.ts", "failing", "question"] });
		expect(first(impact.cases).open).toHaveLength(1);
		expect(impact.uncovered).toEqual(["src/checkout/tax.ts"]);
		expect(impact.gate.verdict).toBe("blocked");

		const held = first(impact.cases).hash;
		const document = first(await h.call<{ etag: string; hash: string }[]>("get", { refs: ["C-1"] }, agent));
		expect(document.hash).toBe(held);
		expect(
			await h.call<Record<string, unknown>[]>("get", { refs: ["C-1"], unless: { "C-1": document.etag } }, agent),
		).toEqual([{ ref: "C-1", unchanged: true, hash: held, etag: document.etag }]);
		await h.call(
			"claim",
			{ lens: "adversarial-review", about: "pr:482", patch: "cccc0002", reviewed: [`C-1@${held}`], findings: [] },
			agent,
		);
		expect(first((await h.call<Impact>("impact", { change: "pr:482" }, agent)).cases).reviewed).toBe(true);
		expect(
			first((await h.call<Impact>("impact", { change: "pr:482", ledger: false }, agent)).cases).reviewed,
		).toBeUndefined();

		await h.call("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon applies exactly" } }],
		});
		const moved = await h.call<{ changed: { ref: string; changed: string }[]; cursor: string }>(
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
		expect((await h.call<{ changed: unknown[] }>("since", { cursor: moved.cursor }, agent)).changed).toEqual([]);
	});

	test("check finds cases that cannot fail", async () => {
		await h.call("propose", {
			edits: [
				{ op: "create", outline: "Has no steps" },
				{ op: "create", outline: "No expectation\n  Click the button" },
				{ op: "create", outline: "Fine\n  Click > It opens" },
			],
		});
		const result = await h.call<{ problems: { rule: string; ref: string }[]; counts: Record<string, number> }>("check");
		expect(result.problems.map((p) => [p.rule, p.ref])).toEqual([
			["no-steps", "C-1"],
			["no-expected", "C-2"],
		]);
	});
});

describe("forgetting a person", () => {
	test("removes who they were and keeps what they did; their token stops working", async () => {
		const dana = await h.actor("dana", "human", ["read", "produce", "answer"]);
		await h.call("propose", { edits: [{ op: "create", outline: "Written by Dana" }] }, dana);
		const forgotten = await h.call<{ forgotten: string; tokensRevoked: number }>("admin", {
			do: "actor.forget",
			name: "dana",
		});
		expect(forgotten).toEqual({ forgotten: expect.stringMatching(/^forgotten-\d+$/), tokensRevoked: 1 });
		const versions = await h.call<{ versions: { by: string }[] }>("history", { ref: "C-1" });
		expect(first(versions.versions).by).toBe(forgotten.forgotten);
		expect(await title("C-1")).toBe("Written by Dana"); // the record itself is untouched
		expect(
			(
				await h.app.database.read(
					async (db) =>
						await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM tokens WHERE revoked_at IS NULL")),
				)
			)?.n,
		).toBe(0);
		expect(await h.raw("admin", { do: "actor.forget", name: "robin" })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
	});
});

describe("a conflicted proposal", () => {
	test("its agent author may withdraw it and try again, but cannot push it through", async () => {
		const agent = await h.actor("writer", "agent", ["read", "produce"]);
		await h.call("propose", { edits: [{ op: "create", outline: "Original" }] });
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "A person's title" } }] });
		const stale = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "The agent's title" } }] },
			agent,
		);
		expect(stale.status).toBe("conflict");
		expect(stale.needs).toContain("propose again on the current version");
		const q = first((await queue({ kind: "adopt" })).items);
		const body = { title: "The agent's title", pre: "", steps: [], methods: ["human"], automate: "none", fields: {} };
		const pushed = await h.call<{ status: string }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "merge", body } },
			agent,
		);
		expect(pushed[0]?.status).toBe("forbidden");
		const withdrawn = await h.call<{ status: string }[]>(
			"decide",
			{ q: q.q, onEvidence: q.evidenceHash, answer: { is: "reject" } },
			agent,
		);
		expect(withdrawn[0]?.status).toBe("decided");
		expect(await title("C-1")).toBe("A person's title");
		const retry = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "edit", case: "C-1", base: 2, body: { title: "The agent's title" } }] },
			agent,
		);
		expect(retry.status).toBe("adopted");
	});
});

describe("project custom field definitions", () => {
	const policy = async () => await h.call<CurrentPolicy>("admin", { do: "policy.show", project: "scratch" });
	const accept = async (proposal: Proposed) => {
		const q = first((await queue({ kind: "adopt" })).items.filter((q) => q.q === proposal.question));
		return await h.call<{ status: string; needs?: string }[]>("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "accept" },
		});
	};
	const define = async () => {
		const settings = {
			...(await policy()).settings,
			fields: {
				risk: { kind: "choice", label: "Risk", required: true, choices: ["low", "high"] },
				notes: { kind: "text", label: "Notes", required: false },
			},
		};
		const proposed = await h.call<Proposed>("propose", {
			edits: [{ op: "policy", base: (await policy()).version, settings }],
		});
		expect(proposed.status).toBe("open");
		expect((await policy()).settings).not.toHaveProperty("fields");
		expect((await accept(proposed))[0]?.status).toBe("decided");
		expect((await policy()).settings).toHaveProperty("fields", settings.fields);
	};

	test("definitions are decided, validate content, preserve free fields and survive preset changes", async () => {
		await define();
		for (const fields of [{}, { risk: "medium" }, { risk: " " }]) {
			const refused = await h.raw("propose", { edits: [{ op: "create", body: { title: "Invalid", fields } }] });
			expect(refused.ok).toBe(false);
			if (!refused.ok) expect(refused.error.message).toContain("risk");
		}
		const fields = { risk: "high", notes: "Free text", legacy: "Keep me" };
		expect(
			(await h.call<Proposed>("propose", { edits: [{ op: "create", body: { title: "Valid", fields } }] })).status,
		).toBe("adopted");
		await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Edited" } }] });
		const md = (await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" }))[0]?.md;
		expect(md).toContain("legacy: Keep me");
		expect(md).toContain("risk: high");
		const definitions = (await policy()).settings;
		await accept(await h.call<Proposed>("propose", { edits: [{ op: "policy", preset: "standard" }] }));
		expect((await policy()).settings).toHaveProperty("fields", definitions.fields);
	});

	test("settings without fields retain definitions, and an explicit empty map removes them", async () => {
		await define();
		const { fields, ...settings } = (await policy()).settings;
		settings.holds.flakyDays = 7;
		expect(
			(
				await accept(
					await h.call<Proposed>("propose", { edits: [{ op: "policy", base: (await policy()).version, settings }] }),
				)
			)[0]?.status,
		).toBe("decided");
		expect((await policy()).settings.fields).toEqual(fields);
		expect((await policy()).settings.holds.flakyDays).toBe(7);
		expect(
			(
				await accept(
					await h.call<Proposed>("propose", {
						edits: [{ op: "policy", base: (await policy()).version, settings: { ...settings, fields: {} } }],
					}),
				)
			)[0]?.status,
		).toBe("decided");
		expect((await policy()).settings.fields).toEqual({});
	});

	test("older cases keep missing, blank and obsolete values while unrelated content changes", async () => {
		for (const fields of [{}, { risk: " " }, { risk: "obsolete", legacy: "Keep me" }])
			await h.call("propose", { edits: [{ op: "create", body: { title: "Before definitions", fields } }] });
		await define();
		for (const ref of ["C-1", "C-2", "C-3"]) {
			expect(
				(
					await h.call<Proposed>("propose", {
						edits: [{ op: "edit", case: ref, base: 1, body: { title: "Edited", pre: "Changed precondition" } }],
					})
				).status,
			).toBe("adopted");
			expect(await title(ref)).toBe("Edited");
			// A valid optional value can change without filling a different, unchanged required value.
			expect(
				(
					await h.call<Proposed>("propose", {
						edits: [
							{
								op: "edit",
								case: ref,
								base: 2,
								body: {
									fields: {
										...(ref === "C-2" ? { risk: " " } : ref === "C-3" ? { risk: "obsolete", legacy: "Keep me" } : {}),
										notes: "Added notes",
									},
								},
							},
						],
					})
				).status,
			).toBe("adopted");
		}
		const md = first(await h.call<{ md: string }[]>("get", { refs: ["C-3"], as: "md" })).md;
		expect(md).toContain("risk: obsolete");
		expect(md).toContain("legacy: Keep me");
		for (const fields of [{ risk: "bad" }, { risk: "" }, {}]) {
			const reply = await h.raw("propose", { edits: [{ op: "edit", case: "C-3", base: 3, body: { fields } }] });
			expect(reply.ok).toBe(false);
			if (!reply.ok) expect(reply.error.message).toContain("risk");
		}
		expect(
			(
				await h.call<Proposed>("propose", {
					edits: [{ op: "edit", case: "C-3", base: 3, body: { fields: { risk: "low", legacy: "Keep me" } } }],
				})
			).status,
		).toBe("adopted");
		expect(
			(
				await h.raw("propose", {
					edits: [{ op: "edit", case: "C-3", base: 4, body: { fields: {} } }],
				})
			).ok,
		).toBe(false);
	});

	test("Markdown edits preserve required fields unless the header explicitly replaces them", async () => {
		await define();
		await h.call("propose", { edits: [{ op: "create", body: { title: "Original", fields: { risk: "high" } } }] });
		const edit = await h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: "---\ntitle: Edited\n---\n## Steps\n" }],
		});
		expect(edit.status).toBe("adopted");
		const read = async () => first(await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" })).md;
		const recorded = await read();
		expect(edit.cases[0]?.version).toBe(2);
		expect(recorded).toContain("title: Edited");
		expect(recorded).toContain("risk: high");
		const refused = await h.raw("propose", {
			edits: [{ op: "edit", case: "C-1", base: 2, md: "---\ntitle: Cleared\nfields: {}\n---\n## Steps\n" }],
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error.message).toContain("Risk is required");
		expect(await read()).toBe(recorded);
	});

	test.each([{}, { risk: " " }, { risk: "obsolete", legacy: "Keep me" }])(
		"Markdown omission keeps unchanged historical fields: %j",
		async (fields) => {
			await h.call("propose", { edits: [{ op: "create", body: { title: "Before definitions", fields } }] });
			await define();
			const edit = await h.call<Proposed>("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, md: "---\ntitle: Edited\n---\n## Steps\n" }],
			});
			expect(edit.status).toBe("adopted");
			expect(edit.cases[0]?.version).toBe(2);
			const md = first(await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" })).md;
			expect(md).toContain("title: Edited");
			const parsed = parseCase(md);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.doc.body.fields).toEqual(fields);
		},
	);

	test("pending Markdown omission preserves historical fields and merges current fields at adoption", async () => {
		await h.call("propose", {
			edits: [{ op: "create", body: { title: "Before definitions", fields: { risk: "obsolete", legacy: "Keep me" } } }],
		});
		await accept(await h.call<Proposed>("propose", { edits: [{ op: "policy", preset: "standard" }] }));
		const agent = await h.actor("markdown-editor", "agent", ["read", "produce"]);
		const propose = async (title: string, base: number) =>
			await h.call<Proposed>(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base, md: `---\ntitle: ${title}\n---\n## Steps\n` }] },
				agent,
			);
		const pending = await propose("Pending title", 1);
		await define();
		expect((await accept(pending))[0]?.status).toBe("decided");
		const read = async () => first(await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" })).md;
		expect(await read()).toContain("risk: obsolete");
		const stale = await propose("Merged title", 2);
		await h.call("propose", {
			edits: [{ op: "edit", case: "C-1", base: 2, body: { fields: { risk: "low", legacy: "Keep me" } } }],
		});
		expect((await accept(stale))[0]?.status).toBe("decided");
		expect(parseCase(await read())).toMatchObject({
			ok: true,
			doc: { body: { title: "Merged title", fields: { risk: "low", legacy: "Keep me" } } },
		});
	});

	test("a pending content proposal is revalidated against definitions at adoption", async () => {
		await accept(await h.call<Proposed>("propose", { edits: [{ op: "policy", preset: "standard" }] }));
		const agent = await h.actor("field-writer", "agent", ["read", "produce"]);
		const pending = await h.call<Proposed>(
			"propose",
			{ edits: [{ op: "create", body: { title: "Waiting", fields: { risk: "medium" } } }] },
			agent,
		);
		await define();
		expect((await accept(pending))[0]).toMatchObject({ status: "invalid", needs: expect.stringContaining("risk") });
		expect((await h.call<{ items: unknown[] }>("find", { in: "cases" })).items).toHaveLength(0);
	});

	test("pending edits inherit unchanged old values and merge current values at adoption", async () => {
		await h.call("propose", { edits: [{ op: "create", body: { title: "Before definitions" } }] });
		await accept(await h.call<Proposed>("propose", { edits: [{ op: "policy", preset: "standard" }] }));
		const agent = await h.actor("field-editor", "agent", ["read", "produce"]);
		const pending = await h.call<Proposed>(
			"propose",
			{
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Pending title" } }],
			},
			agent,
		);
		await define();
		expect((await accept(pending))[0]?.status).toBe("decided");
		expect(await title("C-1")).toBe("Pending title");
		const stale = await h.call<Proposed>(
			"propose",
			{
				edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "A stale edit" } }],
			},
			agent,
		);
		await h.call("propose", {
			edits: [{ op: "edit", case: "C-1", base: 2, body: { fields: { risk: "low" } } }],
		});
		expect((await accept(stale))[0]?.status).toBe("decided");
		const md = first(await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" })).md;
		expect(md).toContain("risk: low");
		expect(md).toContain("A stale edit");
		expect(await title("C-1")).toBe("Pending title");
	});

	test("a pending field change must meet definitions introduced before adoption", async () => {
		await h.call("propose", {
			edits: [{ op: "create", body: { title: "Before definitions", fields: { risk: "high" } } }],
		});
		await accept(await h.call<Proposed>("propose", { edits: [{ op: "policy", preset: "standard" }] }));
		const agent = await h.actor("field-editor", "agent", ["read", "produce"]);
		const pending = await h.call<Proposed>(
			"propose",
			{
				edits: [{ op: "edit", case: "C-1", base: 1, body: { fields: { risk: "obsolete" } } }],
			},
			agent,
		);
		await define();
		expect((await accept(pending))[0]).toMatchObject({ status: "invalid", needs: expect.stringContaining("risk") });
		expect(first(await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" })).md).toContain("risk: high");
	});

	test("definitions never rewrite history, and Markdown, policy history and decisions survive an archive", async () => {
		await h.call("propose", {
			edits: [{ op: "create", body: { title: "Before definitions", fields: { risk: "obsolete", legacy: "Keep me" } } }],
		});
		await define();
		const before = await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md", version: 1 });
		expect(before[0]?.md).toContain("risk: obsolete");
		expect(
			(
				await h.call<Proposed>("propose", {
					edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Unchanged old values" } }],
				})
			).status,
		).toBe("adopted");
		await h.call("propose", {
			edits: [{ op: "edit", case: "C-1", base: 2, body: { fields: { risk: "low", legacy: "Keep me" } } }],
		});
		expect((await h.raw("propose", { edits: [{ op: "restore", case: "C-1", to: 1 }] })).ok).toBe(false);
		const md = first(await h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" })).md;
		await h.call("propose", { edits: [{ op: "create", md }] });
		expect(first(await h.call<{ md: string }[]>("get", { refs: ["C-2"], as: "md" })).md).toContain("legacy: Keep me");
		const chunks: string[] = [];
		await h.app.database.write(
			async (db) => await db.transaction(async () => await exportArchive(db, (chunk) => chunks.push(chunk))),
		);
		const restoredFixture = await testDatabase();
		const restored = await Database.open({ url: restoredFixture.url });
		try {
			await restored.write(async (db) => await importArchive(db, linesOf(chunks.join(""))));
			expect(await restored.read(async (db) => await currentPolicy(db, 1))).toEqual(await policy());
			expect((await restored.read(async (db) => await policyAt(db, 1, 1)))?.settings.fields).toBeUndefined();
			expect((await restored.read(async (db) => await policyAt(db, 1, 2)))?.settings.fields).toEqual(
				(await policy()).settings.fields,
			);
			for (const table of ["versions", "policies", "proposals", "decisions"]) {
				expect(
					await restored.read(
						async (db) => await db.all(sql<readonly [], Record<string, unknown>>(`SELECT * FROM ${table}`)),
					),
				).toEqual(
					await h.app.database.read(
						async (db) => await db.all(sql<readonly [], Record<string, unknown>>(`SELECT * FROM ${table}`)),
					),
				);
			}
		} finally {
			await restored.close();
			await restoredFixture.close();
		}
	});

	test("definitions reject invalid choices and validate every content edit against a batch's final policy", async () => {
		for (const choices of [[], ["low", "low"], [" "], ["low\nhigh"]]) {
			expect(
				(
					await h.raw("propose", {
						edits: [
							{
								op: "policy",
								base: (await policy()).version,
								settings: {
									...(
										await policy()
									).settings,
									fields: {
										risk: { kind: "choice", label: "Risk", required: false, choices },
									},
								},
							},
						],
					})
				).ok,
			).toBe(false);
		}
		const settings = {
			...(await policy()).settings,
			fields: { risk: { kind: "text", label: "Risk", required: true } },
		};
		for (const edits of [
			[
				{ op: "policy", base: (await policy()).version, settings },
				{ op: "create", body: { title: "Missing" } },
			],
			[
				{ op: "create", body: { title: "Missing" } },
				{ op: "policy", base: (await policy()).version, settings },
			],
		])
			expect((await h.raw("propose", { edits })).ok).toBe(false);
		expect((await h.call<{ items: unknown[] }>("find", { in: "cases" })).items).toHaveLength(0);
		expect((await policy()).settings.fields).toBeUndefined();
		const proposed = await h.call<Proposed>("propose", {
			edits: [
				{ op: "create", body: { title: "With value", fields: { risk: "high" } } },
				{ op: "policy", base: (await policy()).version, settings },
			],
		});
		expect((await accept(proposed))[0]?.status).toBe("decided");
		await h.call("admin", { do: "project.create", key: "other" });
		expect((await h.call<Policy>("admin", { do: "policy.show", project: "other" })).settings.fields).toBeUndefined();
	});

	test("required fields cannot make automatic case creation fail during report processing", async () => {
		await define();
		const refused = await h.raw("propose", { edits: [{ op: "policy", unlinked: "create" }] });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error.message).toContain("required custom fields");
		const fields = { notes: { kind: "text", label: "Notes", required: false } };
		await accept(
			await h.call<Proposed>("propose", {
				edits: [
					{
						op: "policy",
						base: (await policy()).version,
						settings: { ...(await policy()).settings, fields },
						unlinked: "create",
					},
				],
			}),
		);
		await h.call("report", ciReport({ commit: "fields-auto-create", n: 1 }));
		expect((await h.call<{ items: unknown[] }>("find", { in: "cases" })).items).toHaveLength(1);
		const settings = {
			...(await policy()).settings,
			fields: { risk: { kind: "text", label: "Risk", required: true } },
		};
		expect((await h.raw("propose", { edits: [{ op: "policy", base: (await policy()).version, settings }] })).ok).toBe(
			false,
		);
	});
});

async function mapAsync<T, R>(rows: readonly T[], callback: (value: T, index: number) => Promise<R>) {
	const out: R[] = [];
	for (const [index, row] of rows.entries()) out.push(await callback(row, index));
	return out;
}

test("a statement refusal in one answer leaves both neighboring batch answers committed", async () => {
	await use("standard");
	await h.call(
		"report",
		ciReport({ commit: "answer-savepoint", n: 3, fail: { 0: "first cause", 1: "refused cause", 2: "last cause" } }),
	);
	const questions = (await h.call<InboxReply>("inbox", { kind: "failure" })).items;
	expect(questions).toHaveLength(3);
	const refused = questions[1];
	if (!refused) throw new Error("missing refusal question");
	const original = HANDLERS.failure.effect;
	HANDLERS.failure.effect = async function* (ctx, witness, question, answer, tools) {
		if (`Q-${question.no}` === refused.q) {
			try {
				await ctx.db.run(sql("INSERT INTO depends_on(run, decision, expires_at) VALUES (0, 0, NULL)"));
			} catch (error) {
				if (isForeignKeyViolation(error)) throw invalid("the answer effect was refused");
				throw error;
			}
		}
		return yield* original(ctx, witness, question, answer, tools);
	};
	try {
		const replies = await h.call<{ status: string }[]>("decide", {
			all: questions.map((question) => ({ q: question.q, onEvidence: question.evidenceHash, answer: { is: "flaky" } })),
		});
		expect(replies.map((reply) => reply.status)).toEqual(["decided", "invalid", "decided"]);
	} finally {
		HANDLERS.failure.effect = original;
	}
	expect(await h.call("gate", { commit: "answer-savepoint" })).toMatchObject({ tally: { excused: 2, unexplained: 1 } });
	expect((await h.call<InboxReply>("inbox", { kind: "failure" })).items.map((question) => question.q)).toEqual([
		refused.q,
	]);
});

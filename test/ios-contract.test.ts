// The iOS app is a client nobody here compiles: it is Swift, and this check runs on Linux. What it reads of the
// server is written in `scripts/ios/contract.ts`, and this file holds the server to it: real replies, from a
// real instance, read the way the app reads them. It also holds the Swift that is written from this repository
// to what the repository says now.
//
// A failure here means the app would stop reading a reply. Change the contract with the server, write the Swift
// again and say so in the pull request: `ios/README.md`, "When the contract test fails".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { z } from "zod";
import {
	AnswerCommand,
	ChangeEvent,
	ChangeGate,
	ChangeImpact,
	ChangeList,
	ChangeRun,
	CountedResults,
	DecideReply,
	EVIDENCE,
	Inbox,
	MergeReceiptResults,
	PasskeyChallenge,
	Proposal,
	ProviderStart,
	Question,
	Refusal,
	SampleResult,
	SessionEnd,
	SessionInfo,
	SessionRow,
	SignInMethods,
	SignInReply,
	TestDetail,
	TestList,
	TokenRevoke,
	TokenRow,
} from "../scripts/ios/contract.ts";
import { type TestInstance, testInstance } from "../scripts/ios/instance.ts";
import { mismatches, type Shape } from "../scripts/ios/shape.ts";
import { generated } from "../scripts/ios/swift.ts";
import { KINDS } from "../src/core/kinds.ts";
import { totpCode } from "../src/server/identity/totp.ts";
import { OPS } from "../src/server/ops/index.ts";
import { ciReport } from "./helpers.ts";
import { cleanUp as cleanUpPeople, joined, must, world } from "./people-support.ts";

const WHAT_TO_DO =
	"The iOS app reads this (scripts/ios/contract.ts). If the change is meant, change the contract, run `bun scripts/ios.ts gen` and see ios/README.md.";

let server: TestInstance;
let project = "";
let strict = "";
beforeAll(async () => {
	server = await testInstance();
	const made = async (kind: string): Promise<string> => {
		const reply = await send("POST", "/test/project", { kind });
		return (reply as { result: { project: string } }).result.project;
	};
	project = await made("standard");
	strict = await made("strict");
});
afterAll(() => server?.stop());

async function send(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
	const response = await fetch(`${server.url}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${server.token}`,
			...(method === "POST" ? { "content-type": "application/json" } : {}),
			...headers,
		},
		...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
	});
	return (await response.json()) as unknown;
}
/** The result of a call that must succeed, as the server sent it: nothing in between has read it. */
async function result(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
	const reply = (await send(method, path, body)) as { ok: boolean; result?: unknown };
	if (!reply.ok) throw new Error(`${method} ${path}: ${JSON.stringify(reply)}`);
	const name = path.split("/").at(-1) ?? "";
	const definition = method === "POST" ? OPS[name] : undefined;
	if (definition) {
		const checked = definition.output.safeParse(reply.result);
		expect(checked.success ? [] : checked.error.issues, `${name} registry reply`).toEqual([]);
	}
	return reply.result;
}
const op = (key: string, name: string, input: unknown) => result("POST", `/api/p/${key}/${name}`, input);

test("report recovery fixtures start with unfilled pinned cases and recover one submitted result", async () => {
	const { project: key, run } = z
		.object({ project: z.string(), run: z.string() })
		.parse(await result("POST", "/test/project", { kind: "run" }));
	const slots = z
		.object({ items: z.array(z.object({ case: z.string(), version: z.number(), fills: z.array(z.unknown()) })) })
		.parse(await op(key, "find", { in: "slots", run }));
	expect(slots.items).toHaveLength(6);
	expect(slots.items.every((slot) => slot.fills.length === 0)).toBe(true);
	const slot = slots.items[0];
	if (!slot) throw new Error("the recovery fixture has no slot");
	const input = {
		cmd: crypto.randomUUID(),
		run,
		results: [
			{ test: { case: slot.case }, outcome: "fail", note: "Original note", steps: [{ step: "s1", outcome: "fail" }] },
		],
	};
	const receipt = await op(key, "report", input);
	expect(await op(key, "report", input)).toEqual(receipt);
	expect(await op(key, "command", { cmd: input.cmd })).toMatchObject({ state: "done", reply: receipt });
	const timeline = z
		.object({ entries: z.array(z.object({ t: z.string(), note: z.string().nullish() })) })
		.parse(await op(key, "timeline", { ref: slot.case }));
	expect(timeline.entries.filter((entry) => entry.t === "result")).toEqual([
		expect.objectContaining({ note: "Original note" }),
	]);
});

test("the iPhone reads the bound authenticator step and its completed recovery-code sign-in", async () => {
	const instance = await world();
	try {
		const password = "a password for authenticator sign-in";
		const cookie = await joined(instance, "phone-code", password);
		const enrolment = await instance.ok<{ challenge: string; secret: string }>(
			"credential",
			{ do: "totp.begin" },
			{ cookie },
		);
		const enrolled = await instance.ok<{ recoveryCodes: string[] }>(
			"credential",
			{
				do: "totp.confirm",
				challenge: enrolment.challenge,
				code: totpCode(enrolment.secret, Math.floor(instance.clock.now() / 30_000)),
			},
			{ cookie },
		);
		const pending = await instance.post<{ signedIn: boolean; secondFactor: { challenge: string } }>("/api/login", {
			name: "phone-code",
			password,
		});
		expect(pending.status).toBe(200);
		holds("POST /api/login, second factor", SignInReply, must(pending));
		expect(must(pending).signedIn).toBe(false);
		expect(pending.cookie).toMatch(/^mainworthy_ceremony=[A-Za-z0-9_-]{43}$/);
		const completed = await instance.post(
			"/api/login",
			{
				challenge: must(pending).secondFactor.challenge,
				code: enrolled.recoveryCodes[0],
			},
			{ cookie: pending.cookie },
		);
		expect(completed.status).toBe(200);
		holds("POST /api/login, completed second factor", SignInReply, must(completed));
		expect(must(completed)).toEqual({ signedIn: true });
		expect(completed.cookie).toMatch(/^mainworthy_sid=[A-Za-z0-9_-]{43}$/);
	} finally {
		await cleanUpPeople();
	}
});

test("the iPhone reads a native passkey challenge from the configured instance", async () => {
	const instance = await world({ publicUrl: "https://mainworthy.example:8443" });
	try {
		const reply = await instance.post("/api/login/challenge", { native: true });
		expect(reply.status).toBe(200);
		if (!reply.body.ok) throw new Error(reply.text);
		holds("POST /api/login/challenge", PasskeyChallenge, reply.body.result);
	} finally {
		await cleanUpPeople();
	}
});

test("the iPhone reads why native passkey sign-in is unavailable", async () => {
	const instance = await world({ publicUrl: "http://localhost:7357" });
	try {
		const reply = await instance.post("/api/login/challenge", { native: true });
		expect(reply.status).toBe(400);
		if (reply.body.ok) throw new Error("expected native passkey sign-in to be unavailable");
		holds("POST /api/login/challenge refusal", Refusal, reply.body.error);
		expect(reply.body.error).toMatchObject({ code: "invalid", details: { passkey: "native-unavailable" } });
	} finally {
		await cleanUpPeople();
	}
});

test("the iPhone token list and replayed revocation read real admin replies", async () => {
	const made = z.object({ actor: z.string(), token: z.string() }).parse(
		await result("POST", "/api/admin", {
			do: "token.create",
			actor: "phone-contract-pipeline",
			kind: "ci",
			can: ["read"],
			label: "Contract pipeline",
			expires: "1h",
		}),
	);
	const readTokens = async () => {
		const rows = z.array(z.unknown()).parse(await result("POST", "/api/admin", { do: "token.list" }));
		for (const row of rows) holds("token.list", TokenRow, row);
		return z.array(z.object({ id: z.number(), actor: z.string() })).parse(rows);
	};
	const token = (await readTokens()).find((row) => row.actor === made.actor);
	expect(token).toBeDefined();
	await fetch(`${server.url}/api/session`, { headers: { authorization: `Bearer ${made.token}` } });
	await readTokens();
	const input = { do: "token.revoke", id: token?.id, cmd: crypto.randomUUID() };
	const revoked = await result("POST", "/api/admin", input);
	holds("token.revoke", TokenRevoke, revoked);
	expect(revoked).toEqual({ revoked: true });
	expect(await result("POST", "/api/admin", input)).toEqual({ revoked: true });
	const already = await result("POST", "/api/admin", { ...input, cmd: crypto.randomUUID() });
	holds("token.revoke already", TokenRevoke, already);
	expect(already).toEqual({ revoked: false });
	await readTokens();
});

function holds(what: string, shape: Shape, reply: unknown): void {
	expect(mismatches(shape, reply), `${what}. ${WHAT_TO_DO}`).toEqual([]);
}

type Item = { q: string; kind: string; evidence: unknown; evidenceHash: string };
const open = async (key: string): Promise<Item[]> =>
	((await op(key, "inbox", { state: "open", limit: 100 })) as { items: Item[] }).items;

describe("what the iOS app reads", () => {
	test("Settled decodes the answer and its ending on a dissolved failure question", async () => {
		const { project: key } = z.object({ project: z.string() }).parse(await result("POST", "/test/project", {}));
		await op(
			key,
			"report",
			ciReport({ commit: "native408a", branch: "fix", pr: 408, n: 1, fail: { 0: "native contract trace failure" } }),
		);
		const question = z
			.object({ items: z.array(z.object({ q: z.string(), title: z.string(), evidenceHash: z.string() })) })
			.parse(await op(key, "inbox", { kind: "failure" }))
			.items.find((item) => item.title === "native contract trace failure");
		if (!question) throw new Error("expected a failure question");
		await op(key, "decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: { is: "test" },
			reason: "The assertion needs a fix.",
		});
		await op(key, "report", ciReport({ commit: "native408b", branch: "fix", pr: 408, n: 1 }));
		const inbox = await op(key, "inbox", { state: "decided", on: "pr:408" });
		holds("Settled, ended answer", Inbox, inbox);
		expect(inbox).toMatchObject({
			items: [
				{
					q: question.q,
					state: "dissolved",
					decision: {
						rule: "passed",
						reason: "Every test it named passed on native408b where it had failed; the answer ended.",
						fixedIn: { change: "pr:408", state: "open" },
						supersedes: { answer: { is: "test" }, by: ["robin"], reason: "The assertion needs a fix." },
					},
				},
			],
		});
		const read = z.array(z.unknown()).parse(await op(key, "get", { refs: [question.q] }))[0];
		holds("get, ended answer", Question, read);
	});
	test("a native map answer cannot replace an answer recorded while its sheet was open", async () => {
		const made = z.object({ project: z.string() }).parse(await result("POST", "/test/project", {}));
		const question = (await open(made.project)).find((item) => item.kind === "map");
		if (!question) throw new Error("the scenario has no map question");
		const input = { q: question.q, onEvidence: question.evidenceHash };
		const tracked = await op(made.project, "decide", { ...input, answer: { is: "track" } });
		expect(tracked).toMatchObject([{ status: "decided" }]);
		for (const batch of [false, true]) {
			const one = { ...input, ifOpen: true, answer: { is: "create" } };
			const reply = await op(made.project, "decide", batch ? { all: [one] } : one);
			expect(reply).toMatchObject([
				{ status: "conflict", needs: "the question is no longer open; read it again before answering" },
			]);
			const [refused] = z.array(z.unknown()).parse(reply);
			holds("decide, competing map answer", DecideReply, refused);
		}
		expect(await op(made.project, "find", { in: "cases", text: "Shipping accepts an address" })).toMatchObject({
			items: [],
		});
		const receipt = z.array(z.object({ decision: z.number() })).parse(tracked)[0];
		if (!receipt) throw new Error("the tracked answer has no receipt");
		const withdrawal = { undo: [{ q: question.q, ifDecision: receipt.decision }], cmd: "native-selection-undo" };
		const withdrawn = z.array(z.unknown()).parse(await op(made.project, "decide", withdrawal));
		expect(withdrawn).toMatchObject([{ q: question.q, status: "reopened" }]);
		for (const reply of withdrawn) holds("decide, selection withdrawal", DecideReply, reply);
		expect(await op(made.project, "decide", withdrawal)).toEqual(withdrawn);
	});

	test("the iOS test instance publishes the real anonymous privacy route and records the opened URL", async () => {
		const openings = () => result("GET", "/test/privacy-openings");
		expect(await openings()).toEqual({ urls: [] });
		const redirect = await fetch(`${server.url}/privacy`, { redirect: "manual" });
		expect(redirect.status).toBe(308);
		expect(redirect.headers.get("location")).toBe("/docs/privacy");
		const policy = await fetch(new URL(redirect.headers.get("location") ?? "", server.url));
		expect(policy.status).toBe(200);
		expect(await policy.text()).toContain('<h1 id="privacy">Privacy</h1>');
		expect(await openings()).toEqual({ urls: [`${server.url}/privacy`] });
		const anonymous = await fetch(`${server.url}/test/privacy-openings`);
		expect(anonymous.status).toBe(401);
	});

	test("native provider discovery, authorization and session use the generated contract", async () => {
		holds("GET /api/login/methods", SignInMethods, await result("GET", "/api/login/methods"));
		const verifier = "v".repeat(43);
		const request = {
			challenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"),
			state: "s".repeat(43),
			callback: "com.mainworthy.app://signin/oidc",
			instance: server.url,
		};
		const begun = await result("POST", "/api/login/oidc/native", request);
		holds("POST /api/login/oidc/native", ProviderStart, begun);
		const { url } = z.object({ url: z.string() }).parse(begun);
		const authorized = await fetch(url, { redirect: "manual" });
		const back = authorized.headers.get("location") ?? "";
		const done = await fetch(back, { redirect: "manual" });
		const native = new URL(done.headers.get("location") ?? "");
		const exchanged = await fetch(`${server.url}/api/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				nativeOidc: {
					code: native.searchParams.get("code"),
					verifier,
					callback: request.callback,
					instance: server.url,
				},
			}),
		});
		expect(exchanged.status).toBe(200);
		holds("POST /api/login, native", SignInReply, (await exchanged.json()).result);
	});

	test("who is signed in, with a token and with the session a password opens", async () => {
		holds("GET /api/session", SessionInfo, await result("GET", "/api/session"));
		const session = z
			.object({ projects: z.array(z.object({ key: z.string(), identity: z.string().min(1) })) })
			.parse(await result("GET", "/api/session"));
		const projects = z
			.array(z.object({ key: z.string(), identity: z.string().min(1) }))
			.parse(await result("POST", "/api/admin", { do: "project.list" }));
		expect(session.projects.find((row) => row.key === project)?.identity).toBe(
			projects.find((row) => row.key === project)?.identity,
		);
		// The app holds a session cookie, never a token, so this is the reply it reads.
		const signedIn = await fetch(`${server.url}/api/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(server.person),
		});
		holds("POST /api/login", SignInReply, (await signedIn.json()).result);
		const cookie = (signedIn.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
		// The app reads the cookie from the header as text: this is the pattern it looks for (`Server.swift`).
		expect(cookie).toMatch(/^mainworthy_sid=[A-Za-z0-9_-]{43}$/);
		const mine = (await (await fetch(`${server.url}/api/session`, { headers: { cookie } })).json()) as {
			result: { session: unknown };
		};
		holds("GET /api/session, with a cookie", SessionInfo, mine.result);
		expect(mine.result.session).toBeNumber();
	});

	test("a reused sign-in name has a different actor id for saved device answers", async () => {
		const name = "outbox-person";
		const password = "a password for saved answer tests";
		async function identity() {
			const invited = z
				.object({ code: z.string() })
				.parse(await result("POST", "/api/invitation", { do: "create", name }));
			const joined = await fetch(`${server.url}/api/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ invitation: invited.code, password }),
			});
			const cookie = (joined.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
			const envelope = z.object({
				ok: z.literal(true),
				result: z.object({ actor: z.string(), actorId: z.number().int() }),
			});
			return envelope.parse(await (await fetch(`${server.url}/api/session`, { headers: { cookie } })).json()).result;
		}
		const first = await identity();
		await result("POST", "/api/admin", { do: "actor.forget", name });
		const second = await identity();
		expect(first.actor).toBe(name);
		expect(second.actor).toBe(name);
		expect(first.actorId).not.toBe(second.actorId);
	});

	test("the queue, and the evidence of every kind of question", async () => {
		const reply = await op(project, "inbox", { state: "open", limit: 100 });
		holds("inbox", Inbox, reply);
		const items = [...(await open(project)), ...(await open(strict))];
		const seen = new Set<string>();
		for (const item of items) {
			seen.add(item.kind);
			const shape: Shape | undefined = (EVIDENCE as Record<string, Shape>)[item.kind];
			if (shape) holds(`the evidence of ${item.q}, a ${item.kind} question`, shape, item.evidence);
			if (item.kind === "failure") {
				const { sample } = z.object({ sample: z.number() }).parse(item.evidence);
				expect(EVIDENCE.failure.zod.parse(item.evidence)).toMatchObject({ sample });
				const [read] = z.array(z.unknown()).parse(await op(project, "get", { refs: [`result:${sample}`] }));
				holds("get sample result", SampleResult, read);
				expect(read).toMatchObject({ id: sample, ref: `result:${sample}` });
			}
		}
		// The scenario leaves one of each kind open. A kind that stops arriving would stop being checked.
		expect([...seen].sort()).toEqual([...KINDS].sort());
	});

	test("a slot dispute is readable in the queue and by its ref", async () => {
		const made = z.object({ project: z.string() }).parse(await result("POST", "/test/project", {}));
		const planned = z
			.object({ run: z.string() })
			.parse(await op(made.project, "plan", { name: "Disputed slot", select: { cases: ["C-1"] } }));
		await op(made.project, "report", {
			run: planned.run,
			results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "expected 10, got 12" } }],
		});
		const token = z.object({ token: z.string() }).parse(
			await result("POST", "/api/admin", {
				do: "token.create",
				actor: `passer-${made.project}`,
				kind: "human",
				can: ["read", "produce"],
				project: made.project,
			}),
		).token;
		const passed = await send(
			"POST",
			`/api/p/${made.project}/report`,
			{ run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] },
			{ authorization: `Bearer ${token}` },
		);
		expect(passed).toMatchObject({ ok: true });
		const inbox = await op(made.project, "inbox", { kind: "failure" });
		holds("inbox with a slot dispute", Inbox, inbox);
		const dispute = (await open(made.project)).find(
			(item) => z.object({ slot: z.number(), run: z.literal(planned.run) }).safeParse(item.evidence).success,
		);
		if (!dispute) throw new Error("the scenario has no slot dispute");
		holds("slot failure evidence", EVIDENCE.failure, dispute.evidence);
		expect(dispute.evidence).toMatchObject({ branch: null, message: "expected 10, got 12", hints: ["disputed"] });
		const [question] = z.array(z.unknown()).parse(await op(made.project, "get", { refs: [dispute.q] }));
		holds("get a slot dispute", Question, question);
	});

	test("the documents of a proposed edit", async () => {
		const adopt = (await open(project)).find((item) => item.kind === "adopt");
		const ref = (adopt?.evidence as { proposal?: string } | undefined)?.proposal;
		if (!ref) throw new Error("the scenario has no proposal that waits");
		const rows = (await op(project, "get", { refs: [ref] })) as unknown[];
		expect(rows).toHaveLength(1);
		holds(`get ${ref}`, Proposal, rows[0]);
		// The app shows what an edit changes by setting the two documents side by side.
		expect(rows[0]).toMatchObject({ edits: [{ op: "edit", body: {}, current: {} }] });
		// A person changes the case meanwhile. What the app shows as proposed is what accepting writes: with it.
		const edited = z.object({ edits: z.array(z.object({ case: z.string(), base: z.number() })) }).parse(rows[0])
			.edits[0];
		await op(project, "propose", {
			edits: [{ op: "edit", case: edited?.case, base: edited?.base, body: { title: "Retitled meanwhile" } }],
		});
		const [later] = (await op(project, "get", { refs: [ref] })) as unknown[];
		holds(`get ${ref} after its case moved on`, Proposal, later);
		expect(later).toMatchObject({
			edits: [{ body: { title: "Retitled meanwhile" }, current: { title: "Retitled meanwhile" }, refused: null }],
		});
	});

	test("one question read by its ref, and a proposal that makes a case", async () => {
		const [first] = await open(project);
		if (!first) throw new Error("the scenario has no open question");
		const rows = (await op(project, "get", { refs: [first.q] })) as unknown[];
		expect(rows).toHaveLength(1);
		holds(`get ${first.q}`, Question, rows[0]);
		// Under the strict policy a new case waits for a person, so its proposal can be read.
		const proposed = (await op(strict, "propose", {
			reason: "A second case.",
			edits: [
				{
					op: "create",
					outline: "The cart opens\n  Open the cart > The cart is shown",
					folder: "Checkout",
					tags: ["checkout"],
					covers: ["WEB-290"],
				},
			],
		})) as { proposal: string };
		const [made] = (await op(strict, "get", { refs: [proposed.proposal] })) as unknown[];
		holds(`get ${proposed.proposal}`, Proposal, made);
		// The app says where a new case goes from these three.
		expect(made).toMatchObject({
			edits: [{ op: "create", folder: "Checkout", tags: ["checkout"], covers: ["WEB-290"] }],
		});
	});

	test("a proposal with a policy and a folder edit beside a new case", async () => {
		// The app reads every edit of a proposal it lists. One whose fields it reads as a case body (`current`)
		// must not carry a policy there: on 2026-10-16 that stopped the app reading such a proposal at all.
		const proposed = (await op(strict, "propose", {
			edits: [
				{ op: "create", outline: "Returns are refunded\n  Return the item > The refund is shown" },
				{ op: "folder", name: "Returns", archive: true },
				{ op: "policy", unlinked: "ask" },
			],
		})) as { proposal: string };
		const [made] = (await op(strict, "get", { refs: [proposed.proposal] })) as unknown[];
		holds(`get ${proposed.proposal}`, Proposal, made);
	});

	test("every kind of question has an evidence shape", () => {
		// A kind added to the server is one the app shows without its evidence until it is given a shape.
		expect(Object.keys(EVIDENCE).sort(), WHAT_TO_DO).toEqual([...KINDS].sort());
	});

	test("an answer, an answer on evidence that changed, and a withdrawal", async () => {
		const failure = (await open(project)).find((item) => item.kind === "failure");
		if (!failure) throw new Error("the scenario has no failure question");
		const decide = async (input: Record<string, unknown>): Promise<unknown> => {
			const replies = (await op(project, "decide", input)) as unknown[];
			expect(replies).toHaveLength(1);
			return replies[0];
		};
		const stale = await decide({ q: failure.q, onEvidence: "000000000000", answer: { is: "flaky" } });
		holds("decide on changed evidence", DecideReply, stale);
		expect(stale).toMatchObject({ status: "conflict", evidence: failure.evidenceHash });
		const decided = await decide({ q: failure.q, onEvidence: failure.evidenceHash, answer: { is: "flaky" } });
		holds("decide", DecideReply, decided);
		expect(decided).toMatchObject({ status: "decided" });
		const receipt = z.object({ decision: z.number() }).parse(decided).decision;
		const replacement = await decide({ q: failure.q, onEvidence: failure.evidenceHash, answer: { is: "defect" } });
		const current = z.object({ decision: z.number() }).parse(replacement).decision;
		holds("inbox, decided", Inbox, await op(project, "inbox", { state: "decided", limit: 100 }));
		const overtaken = await decide({ undo: failure.q, ifDecision: receipt });
		holds("decide, undo of a replaced decision", DecideReply, overtaken);
		expect(overtaken).toMatchObject({ status: "conflict" });
		const withdrawn = await decide({ undo: failure.q, ifDecision: current });
		holds("decide, undo", DecideReply, withdrawn);
		expect(withdrawn).toMatchObject({ status: "reopened" });
	});

	test("a saved answer's command before sending and after its reply is recorded", async () => {
		const made = z.object({ project: z.string() }).parse(await result("POST", "/test/project", {}));
		const failure = (await open(made.project)).find((item) => item.kind === "failure");
		if (!failure) throw new Error("the scenario has no failure question");
		const cmd = "ios-saved-answer-contract";
		const missing = await op(made.project, "command", { cmd });
		holds("unrecorded answer command", AnswerCommand, missing);
		expect(missing).toMatchObject({ state: "none" });
		const reply = await op(made.project, "decide", {
			cmd,
			q: failure.q,
			onEvidence: failure.evidenceHash,
			ifOpen: true,
			answer: { is: "flaky" },
		});
		expect(reply).toMatchObject([{ q: failure.q, status: "decided" }]);
		const recorded = await op(made.project, "command", { cmd });
		holds("recorded answer command", AnswerCommand, recorded);
		expect(recorded).toMatchObject({ state: "done", reply });
	});

	test("an event of the change stream", async () => {
		const stream = await fetch(`${server.url}/api/p/${project}/events`, {
			headers: { authorization: `Bearer ${server.token}` },
		});
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("the change stream has no body");
		// The stream says how long to wait before it is opened again, and then nothing until something changes.
		const decoder = new TextDecoder();
		let text = decoder.decode((await reader.read()).value);
		await op(project, "propose", { edits: [{ op: "folder", name: "Returns" }] });
		while (!text.includes("data: ")) text += decoder.decode((await reader.read()).value);
		await reader.cancel();
		const line = text.split("\n").find((part) => part.startsWith("data: "));
		holds("an event", ChangeEvent, JSON.parse((line ?? "").slice("data: ".length)));
	});
});

describe("the app's screens", () => {
	test("no view sends a request of its own", () => {
		// The Swift package's access rules keep a view from the client (`package`). They cannot keep it from
		// the system's own networking, so this does: a view asks a class of MainworthyScreens, and that class
		// asks the client, which is the one place a request is made and the cookie is held.
		const reaching = /\b(URLSession|URLRequest|NWConnection|CFNetwork|WKWebView)\b|^import (Network|WebKit)\b/m;
		const views = [...new Glob("ios/App/**/*.swift").scanSync(".")];
		expect(views.length).toBeGreaterThan(5);
		expect(views.filter((file) => reaching.test(readFileSync(file, "utf8")))).toEqual([]);
	});
});

describe("the Swift that is written from this repository", () => {
	for (const [path, content] of Object.entries(generated())) {
		test(`${path} is current`, () => {
			let committed = "";
			try {
				committed = readFileSync(path, "utf8");
			} catch {}
			expect(committed === content, `${path} is not what the repository says now: run \`bun scripts/ios.ts gen\``).toBe(
				true,
			);
		});
	}
});

// Each Runs shape is held to replies of a project made for this test alone.
describe("what Runs reads", () => {
	test("planning, ordered slots, pinned cases, reports and corrections", async () => {
		const {
			Run,
			RunPage,
			SlotPage,
			PinnedCase,
			RunFolders,
			RunPlanReply,
			RunPlanCommand,
			RunCaseCount,
			RunReportReply,
		} = await import("../scripts/ios/contract.ts");
		const made = z
			.object({ result: z.object({ project: z.string() }) })
			.parse(await send("POST", "/test/project", { kind: "standard" }));
		const key = made.result.project;
		holds("find runs", RunPage, await op(key, "find", { in: "runs", limit: 1 }));
		holds("find folders", RunFolders, await op(key, "find", { in: "folders" }));
		const select = { tags: ["regression"] };
		const count = await op(key, "find", { in: "cases", select, limit: 1 });
		holds("runnable case count", RunCaseCount, count);
		expect(z.object({ count: z.number() }).parse(count).count).toBe(3);
		const cmd = crypto.randomUUID();
		const planned = await op(key, "plan", { name: "Manual check", select, cmd });
		holds("plan", RunPlanReply, planned);
		const command = await op(key, "command", { cmd });
		holds("plan command", RunPlanCommand, command);
		expect(z.object({ state: z.string(), reply: z.unknown() }).parse(command)).toMatchObject({
			state: "done",
			reply: planned,
		});
		const run = z.object({ run: z.string() }).parse(planned).run;
		const rows = z.array(z.unknown()).parse(await op(key, "get", { refs: [run] }));
		holds("get run", Run, rows[0]);
		const slots = await op(key, "find", { in: "slots", run, limit: 1 });
		holds("find slots", SlotPage, slots);
		const slot = z.object({ items: z.array(z.object({ case: z.string(), version: z.number() })) }).parse(slots)
			.items[0];
		if (!slot) throw new Error("the plan made no slot");
		const cases = z.array(z.unknown()).parse(await op(key, "get", { refs: [slot.case], version: slot.version }));
		holds("get pinned case", PinnedCase, cases[0]);
		let corrects: number | undefined;
		let original: number | undefined;
		for (const outcome of ["pass", "fail", "skip", "blocked"]) {
			const reply = await op(key, "report", {
				run,
				results: [
					{
						test: { case: slot.case },
						outcome,
						...(corrects ? { corrects } : {}),
						...(outcome === "fail" ? { steps: [{ step: "s1", outcome: "fail" }], note: "Observed on phone" } : {}),
					},
				],
			});
			holds(`report ${outcome}`, RunReportReply, reply);
			const receipt = z
				.object({ results: z.array(z.number()), rejected: z.array(z.unknown()), declined: z.array(z.unknown()) })
				.parse(reply);
			expect(receipt.rejected).toEqual([]);
			expect(receipt.declined).toEqual([]);
			corrects = receipt.results[0];
			original ??= corrects;
			expect(corrects).toBeNumber();
			const filled = await op(key, "find", { in: "slots", run });
			holds(`slots after ${outcome}`, SlotPage, filled);
			const result = z
				.object({
					items: z.array(z.object({ fills: z.array(z.object({ result: z.number(), atStep: z.string().nullable() })) })),
				})
				.parse(filled)
				.items.flatMap((item) => item.fills)
				.find((fill) => fill.result === corrects);
			expect(result?.atStep).toBe(outcome === "fail" ? "s1" : null);
		}
		expect(
			await send("POST", `/api/p/${key}/report`, {
				run,
				results: [{ test: { case: slot.case }, outcome: "pass", corrects: original }],
			}),
		).toEqual({
			ok: false,
			error: {
				code: "conflict",
				message: `result ${original} was already corrected; read the latest results and correct the current result instead`,
			},
		});
		holds("slots after correction", SlotPage, await op(key, "find", { in: "slots", run }));
	});
});

describe("what Changes and Your sessions read", () => {
	test("the list, gate, affected cases and failing tests of a change", async () => {
		const key = "pr:482";
		holds("find changes", ChangeList, await op(project, "find", { in: "changes", limit: 500 }));
		const gate = await op(project, "gate", { change: key });
		holds("gate of a change", ChangeGate, gate);
		const run = z.object({ run: z.string() }).parse(gate).run;
		const rows = z.array(z.unknown()).parse(await op(project, "get", { refs: [run] }));
		expect(rows).toHaveLength(1);
		holds("get the head run", ChangeRun, rows[0]);
		const impact = await op(project, "impact", { change: key });
		holds("impact", ChangeImpact, impact);
		const head = "3333333333333333333333333333333333333333";
		expect(rows[0]).toMatchObject({ ref: run, accepts: { commit: head }, change: { key, head } });
		expect(impact).toMatchObject({ change: { key, head }, gate: { run } });
		expect(rows[0]).toMatchObject({ failing: [{ name: "Shop check 1", case: expect.stringMatching(/^C-/) }] });
	});

	test("the results a change's gate counted, the tests, and one test with its latest results", async () => {
		const own = z.object({ result: z.object({ project: z.string() }) }).parse(await send("POST", "/test/project", {}));
		const key = own.result.project;
		const all = await op(key, "find", { in: "results", change: "pr:482", limit: 2 });
		holds("find results of a change", CountedResults, all);
		// The test with no case is counted with the rest, and the tally is the whole gate's whatever the page.
		expect(all).toMatchObject({ count: 5, tally: { pass: 4, unexplained: 1 }, cursor: expect.any(String) });
		const unexplained = await op(key, "find", { in: "results", change: "pr:482", state: "unexplained" });
		holds("find results by standing", CountedResults, unexplained);
		expect(unexplained).toMatchObject({ count: 1, items: [{ name: "Shop check 1", question: expect.any(String) }] });
		const tracked = await op(key, "find", { in: "results", change: "pr:482", text: "shipping" });
		expect(tracked).toMatchObject({ items: [{ name: "Shipping accepts an address", case: null, standing: "pass" }] });
		const ref = z.object({ items: z.array(z.object({ test: z.string() })) }).parse(tracked).items[0]?.test;
		const proposed = z.object({ question: z.string() }).parse(
			await op(key, "propose", {
				edits: [{ op: "quarantine", test: ref, base: null, exit: { kind: "person" } }],
				reason: "Unreliable address service",
			}),
		);
		const waiting = (await open(key)).find((item) => item.q === proposed.question);
		if (!waiting) throw new Error("the quarantine did not wait for an answer");
		const accepted = await op(key, "decide", {
			q: waiting.q,
			onEvidence: waiting.evidenceHash,
			answer: { is: "accept" },
			reason: "It fails when the address service is slow",
		});
		expect(accepted).toMatchObject([{ status: "decided" }]);
		const tests = await op(key, "find", { in: "tests", limit: 100 });
		holds("find tests", TestList, tests);
		const unlinked = await op(key, "find", { in: "tests", unlinked: true, text: "shipping" });
		holds("find tests with no case", TestList, unlinked);
		expect(unlinked).toMatchObject({
			items: [{ ref, case: null, quarantine: { active: true, reason: "It fails when the address service is slow" } }],
		});
		await op(key, "report", {
			target: { commit: "3333333333333333333333333333333333333333", repo: "acme/shop", pr: 482 },
			job: "runner",
			results: [
				{
					test: { key: "tests/e2e/shipping.spec.ts::shipping::address" },
					outcome: "pass",
					tries: [{ outcome: "fail", durationMs: 25, failure: { message: "Address lookup timed out" } }],
				},
			],
		});
		const rows = z.array(z.unknown()).parse(await op(key, "get", { refs: [ref] }));
		expect(rows).toHaveLength(1);
		holds(`get ${ref}`, TestDetail, rows[0]);
		expect(TestDetail.zod.parse(rows[0])).toMatchObject({
			case: null,
			last: [
				{
					outcome: "pass",
					job: "runner",
					passedOnRetry: null,
					tries: [{ outcome: "fail", message: "Address lookup timed out", durationMs: 25 }],
				},
				{ outcome: "pass", change: "pr:482", job: "shop", tries: [], passedOnRetry: null },
			],
		});
	});

	test("a run's accepted commit stays its own when its change has a newer head", async () => {
		const own = z.object({ result: z.object({ project: z.string() }) }).parse(await send("POST", "/test/project", {}));
		const key = own.result.project;
		const oldGate = z.object({ run: z.string() }).parse(await op(key, "gate", { change: "pr:482" }));
		const head = "4444444444444444444444444444444444444444";
		await op(key, "report", {
			target: { commit: head, repo: "acme/shop", branch: "new-coupon", pr: 482 },
			job: "contract",
			results: [{ test: { key: "contract-pass" }, outcome: "pass" }],
		});
		const rows = z.array(z.unknown()).parse(await op(key, "get", { refs: [oldGate.run] }));
		holds("the earlier run with the current change", ChangeRun, rows[0]);
		expect(rows[0]).toMatchObject({
			accepts: { commit: "3333333333333333333333333333333333333333" },
			change: { key: "pr:482", head, branch: "coupon-total" },
		});
		const impact = await op(key, "impact", { change: "pr:482" });
		holds("the newer impact", ChangeImpact, impact);
		const gate = await op(key, "gate", { change: "pr:482" });
		holds("the newer gate", ChangeGate, gate);
		const run = z.object({ run: z.string() }).parse(gate).run;
		expect(run).not.toBe(oldGate.run);
		expect(impact).toMatchObject({ change: { key: "pr:482", head }, gate: { run } });
		const { RunPage } = await import("../scripts/ios/contract.ts");
		const runs = await op(key, "find", { in: "runs", change: "pr:482" });
		holds("the change's runs", RunPage, runs);
		const listed = z.object({ items: z.array(z.object({ ref: z.string() })) }).parse(runs).items;
		expect(listed.map((item) => item.ref)).toEqual([run, oldGate.run]);
		holds("every run", RunPage, await op(key, "find", { in: "runs", limit: 100 }));
	});

	test("an ended change retains its last gate and reports its end", async () => {
		const own = z.object({ result: z.object({ project: z.string() }) }).parse(await send("POST", "/test/project", {}));
		const key = own.result.project;
		await op(key, "change", { change: "pr:482", state: "merged" });
		const list = await op(key, "find", { in: "changes" });
		holds("ended changes", ChangeList, list);
		expect(list).toMatchObject({ items: [{ state: "merged", verdict: "blocked" }] });
		holds("ended change gate", ChangeGate, await op(key, "gate", { change: "pr:482" }));
		// A change's own page reads its state from impact: it may be older than the newest the list holds.
		const impact = await op(key, "impact", { change: "pr:482" });
		holds("ended change impact", ChangeImpact, impact);
		const frozen = z
			.object({ change: z.object({ mergeReceipt: z.object({ id: z.number() }).nullable() }) })
			.parse(impact).change.mergeReceipt;
		if (frozen)
			holds(
				"receipt results",
				MergeReceiptResults,
				await op(key, "find", { in: "receipt-results", receipt: frozen.id, limit: 1 }),
			);
		expect(impact).toMatchObject({ change: { key: "pr:482", state: "merged" } });
	});

	test("a gate waiting for shards lists them beside its reason", async () => {
		const { RunPage } = await import("../scripts/ios/contract.ts");
		const own = z.object({ result: z.object({ project: z.string() }) }).parse(await send("POST", "/test/project", {}));
		const key = own.result.project;
		const shard = (commit: string, index: number, target: Record<string, unknown>) =>
			op(key, "report", {
				target: { commit, repo: "acme/shop", ...target },
				job: "shop",
				shard: { index, of: 3 },
				results: [{ test: { key: `shop::shard ${index}`, name: `Shard ${index}` }, outcome: "pass" }],
			});
		await shard("5555555555555555555555555555555555555555", 1, { branch: "estimate", pr: 483 });
		const waiting = [{ job: "shop", env: "", missing: [2, 3], of: 3 }];
		const gate = await op(key, "gate", { change: "pr:483" });
		holds("a gate waiting for shards", ChangeGate, gate);
		expect(gate).toMatchObject({ waiting });
		const runs = await op(key, "find", { in: "runs", change: "pr:483" });
		holds("a run waiting for shards", RunPage, runs);
		expect(runs).toMatchObject({ items: [{ waiting }] });
		await op(key, "change", { change: "pr:483", state: "merged", landing: { commit: "6".repeat(40), branch: "main" } });
		await shard("6".repeat(40), 2, { branch: "main" });
		const list = await op(key, "find", { in: "changes" });
		holds("a landing waiting for shards", ChangeList, list);
		const landed = z.object({ items: z.array(z.object({ key: z.string() }).passthrough()) }).parse(list).items;
		expect(landed.find((item) => item.key === "pr:483")).toMatchObject({ landing: { waiting: [{ missing: [1, 3] }] } });
	});

	test("a cookie lists and ends its own session", async () => {
		const signed = await fetch(`${server.url}/api/login`, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "Mainworthy for iPhone tests" },
			body: JSON.stringify(server.person),
		});
		const cookie = (signed.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
		const call = async (body: unknown) => {
			const response = await fetch(`${server.url}/api/session`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie },
				body: JSON.stringify(body),
			});
			return z.object({ ok: z.literal(true), result: z.unknown() }).parse(await response.json()).result;
		};
		const rows = z.array(z.unknown()).parse(await call({ do: "list" }));
		for (const row of rows) holds("a session", SessionRow, row);
		const mine = z
			.array(z.object({ id: z.number(), current: z.boolean() }))
			.parse(rows)
			.find((row) => row.current);
		expect(mine).toBeDefined();
		holds("end session", SessionEnd, await call({ do: "end", id: mine?.id }));
	});
});

describe("what the iPhone Suite reads", () => {
	test("cases, a cursor page, search, folders, tags and case versions", async () => {
		const { SuiteCases, SuiteFolders, SuiteTags, SuiteDocument, SuiteHistory } = await import(
			"../scripts/ios/contract.ts"
		);
		const key = z.object({ project: z.string() }).parse(await result("POST", "/test/project", {})).project;
		const first = await op(key, "find", { in: "cases", limit: 2 });
		holds("find cases", SuiteCases, first);
		const page = z
			.object({ items: z.array(z.object({ ref: z.string() })), cursor: z.string().nullable() })
			.parse(first);
		expect(page.cursor).toBeString();
		holds("find cases, next page", SuiteCases, await op(key, "find", { in: "cases", limit: 2, cursor: page.cursor }));
		holds("find cases, search", SuiteCases, await op(key, "find", { in: "cases", text: "password" }));
		holds("find folders", SuiteFolders, await op(key, "find", { in: "folders" }));
		holds("find tags", SuiteTags, await op(key, "find", { in: "tags" }));
		const ref = page.items[0]?.ref;
		const docs = z.array(z.unknown()).parse(await op(key, "get", { refs: [ref] }));
		holds("get case", SuiteDocument, docs[0]);
		expect(docs[0]).toMatchObject({ hasFragments: false });
		expect(docs[0]).not.toHaveProperty("sourceSteps");
		const old = z.array(z.unknown()).parse(await op(key, "get", { refs: [ref], version: 1 }));
		holds("get case version", SuiteDocument, old[0]);
		holds("history", SuiteHistory, await op(key, "history", { ref }));
	});

	test("a pinned case still decodes its shared instructions and native editing guard", async () => {
		const { SuiteDocument } = await import("../scripts/ios/contract.ts");
		const key = z.object({ project: z.string() }).parse(await result("POST", "/test/project", {})).project;
		const created = z.object({ status: z.literal("adopted"), cases: z.array(z.object({ ref: z.string() })) });
		const fragment = created.parse(
			await op(key, "propose", {
				edits: [
					{
						op: "create",
						kind: "fragment",
						body: { title: "Shared setup", steps: [{ id: "ab", action: "Sign in", expected: "Ready" }] },
					},
				],
			}),
		).cases[0]?.ref;
		if (!fragment) throw new Error("Missing fragment ref");
		const consumer = created.parse(
			await op(key, "propose", {
				edits: [
					{ op: "create", body: { title: "Shared checkout", steps: [{ id: "cd", use: { fragment, version: 1 } }] } },
				],
			}),
		).cases[0]?.ref;
		if (!consumer) throw new Error("Missing consumer ref");
		const docs = z.array(z.unknown()).parse(await op(key, "get", { refs: [consumer] }));
		holds("get case with pinned steps", SuiteDocument, docs[0]);
		expect(docs[0]).toMatchObject({
			ref: consumer,
			hasFragments: true,
			sourceSteps: [{ id: "cd", use: { fragment, version: 1 } }],
			steps: [{ action: "Sign in", expected: "Ready" }],
		});
	});

	test("adopted, waiting and overlapping proposals", async () => {
		const { SuiteProposeReply, SuiteProposalQuestion } = await import("../scripts/ios/contract.ts");
		const create = {
			edits: [
				{ op: "create", body: { title: "A native case", steps: [{ id: "a0", action: "Open", expected: null }] } },
			],
		};
		const made = await op(project, "propose", create);
		holds("propose create", SuiteProposeReply, made);
		const ref = z.object({ cases: z.array(z.object({ ref: z.string() })) }).parse(made).cases[0]?.ref;
		expect(ref).toBeString();
		const edit = (title: string) => ({ edits: [{ op: "edit", case: ref, base: 1, body: { title } }] });
		holds("propose edit", SuiteProposeReply, await op(project, "propose", edit("First title")));
		const overlap = await op(project, "propose", edit("Second title"));
		holds("propose overlap", SuiteProposeReply, overlap);
		expect(overlap).toMatchObject({
			status: "conflict",
			conflicts: [{ addresses: [{ kind: "field", name: "title" }] }],
		});
		const waiting = await op(strict, "propose", { ...create, reason: "Check it before adoption." });
		holds("propose waiting", SuiteProposeReply, waiting);
		expect(waiting).toMatchObject({ status: "open" });
		const question = z.object({ question: z.string() }).parse(waiting).question;
		const [open] = z.array(z.unknown()).parse(await op(strict, "get", { refs: [question] }));
		holds("get waiting proposal question", SuiteProposalQuestion, open);
		expect(open).toMatchObject({ q: question, decision: null });
		const evidenceHash = z.object({ evidenceHash: z.string() }).parse(open).evidenceHash;
		const decided = await op(strict, "decide", {
			q: question,
			onEvidence: evidenceHash,
			answer: { is: "accept" },
			reason: "Reviewed the native case.",
		});
		const [accepted] = z.array(z.unknown()).parse(await op(strict, "get", { refs: [question] }));
		holds("get accepted proposal question", SuiteProposalQuestion, accepted);
		const cases = z
			.array(z.object({ effects: z.object({ cases: z.array(z.object({ ref: z.string(), version: z.number() })) }) }))
			.parse(decided)[0]?.effects.cases;
		expect(accepted).toMatchObject({ q: question, decision: { answer: { is: "accept" }, effects: { cases } } });
	});
});

describe("what the iPhone conflict resolver reads", () => {
	test("a combined conflict can be decoded before the phone directs its author to the web", async () => {
		const { ConflictProposal } = await import("../scripts/ios/contract.ts");
		const key = z.object({ project: z.string() }).parse(await result("POST", "/test/project", {})).project;
		const made = z
			.object({ cases: z.array(z.object({ ref: z.string() })) })
			.parse(await op(key, "propose", { edits: [{ op: "create", body: { title: "Base" } }] }));
		const ref = made.cases[0]?.ref;
		await op(key, "propose", { edits: [{ op: "edit", case: ref, base: 1, body: { title: "Current" } }] });
		const overlap = z.object({ proposal: z.string() }).parse(
			await op(key, "propose", {
				edits: [
					{ op: "edit", case: ref, base: 1, body: { title: "Mine" } },
					{ op: "place", cases: [ref], tags: { add: ["critical"] } },
					{ op: "cover", case: ref, requirement: "REQ-100", on: true },
				],
			}),
		);
		const [proposal] = z.array(z.unknown()).parse(await op(key, "get", { refs: [overlap.proposal] }));
		holds("combined conflict proposal", ConflictProposal, proposal);
	});

	test("a full conflict, its merge effects and its recorded command reply", async () => {
		const { ConflictProposal, MergeReply, MergeCommand, SuiteProposalQuestion } = await import(
			"../scripts/ios/contract.ts"
		);
		const key = z.object({ project: z.string() }).parse(await result("POST", "/test/project", {})).project;
		const made = z
			.object({ cases: z.array(z.object({ ref: z.string() })) })
			.parse(await op(key, "propose", { edits: [{ op: "create", body: { title: "Base" } }] }));
		const ref = made.cases[0]?.ref;
		const edit = (title: string) => ({ edits: [{ op: "edit", case: ref, base: 1, body: { title } }] });
		await op(key, "propose", edit("Current"));
		const overlap = z
			.object({ question: z.string(), proposal: z.string() })
			.parse(await op(key, "propose", edit("Mine")));
		const [proposal] = z.array(z.unknown()).parse(await op(key, "get", { refs: [overlap.proposal] }));
		holds("get conflict proposal", ConflictProposal, proposal);
		// The queue reads the same reply and says why it cannot be accepted as it is.
		holds("get conflict proposal, as the queue reads it", Proposal, proposal);
		expect(proposal).toMatchObject({
			edits: [{ refused: `${ref} has an unresolved conflict; its author must resolve it` }],
		});
		expect(proposal).toMatchObject({ edits: [{ base: 1, mine: { title: "Mine" }, current: { title: "Current" } }] });
		const [q] = z
			.array(z.object({ evidenceHash: z.string() }))
			.parse(await op(key, "get", { refs: [overlap.question] }));
		const [refused] = z.array(z.unknown()).parse(
			await op(key, "decide", {
				q: overlap.question,
				onEvidence: q?.evidenceHash,
				answer: {
					is: "merge",
					body: {
						title: "Resolved #critical @REQ-899",
						pre: "",
						steps: [],
						methods: ["human"],
						automate: "none",
						fields: {},
					},
				},
			}),
		);
		holds("unparsed inline merge refusal", MergeReply, refused);
		expect(refused).toMatchObject({ status: "invalid", effects: null });
		const cmd = "ios-conflict-contract";
		holds("command before sending", MergeCommand, await op(key, "command", { cmd }));
		const [reply] = z.array(z.unknown()).parse(
			await op(key, "decide", {
				q: overlap.question,
				onEvidence: q?.evidenceHash,
				answer: {
					is: "merge",
					body: { title: "Resolved", pre: "", steps: [], methods: ["human"], automate: "none", fields: {} },
				},
				cmd,
			}),
		);
		holds("merge effects", MergeReply, reply);
		expect(reply).toMatchObject({ status: "decided", effects: { status: "adopted", cases: [{ ref, version: 3 }] } });
		const [mergedQuestion] = z.array(z.unknown()).parse(await op(key, "get", { refs: [overlap.question] }));
		holds("get immediately adopted merge question", SuiteProposalQuestion, mergedQuestion);
		expect(mergedQuestion).toMatchObject({
			decision: { answer: { is: "merge" }, effects: { cases: [{ ref, version: 3 }] } },
		});
		const recorded = await op(key, "command", { cmd });
		holds("recorded merge", MergeCommand, recorded);
		expect(recorded).toMatchObject({ state: "done", reply: [reply] });
	});
});

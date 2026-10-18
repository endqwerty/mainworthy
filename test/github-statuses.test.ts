import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Instance, start } from "../src/app/start.ts";
import { InboxReply } from "../src/core/ops.ts";
import { ruleActor } from "../src/server/identity/identity.ts";
import { defaultConfig, openApp } from "../src/server/kernel/app.ts";
import { findProject, makeCtx } from "../src/server/kernel/ctx.ts";
import { sweep } from "../src/server/ops/jobs.ts";
import { acceptReport } from "../src/server/ops/writes.ts";
import { githubStatusesPort } from "../src/server/statuses/github.ts";
import type { StatusDraft } from "../src/server/statuses/port.ts";
import { deliverCommitStatuses } from "../src/server/statuses/statuses.ts";
import { exportArchive, importArchive } from "../src/server/transfer/transfer.ts";
import { type Harness, harness } from "./helpers.ts";

const commit = "a".repeat(40);
const credential = "test-statuses-credential";
const github = { project: "scratch", repository: "example/shop", token: credential };
let instance: Instance | undefined;
let directory: string | undefined;
let h: Harness | undefined;
afterEach(async () => {
	await instance?.stop();
	instance = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	h?.close();
	h = undefined;
});

const Wire = z.object({
	state: z.enum(["pending", "success", "failure", "error"]),
	context: z.literal("mainworthy/gate"),
	description: z.string().max(140),
	target_url: z.string(),
});
type Request = { url: string; init: RequestInit | undefined; body: z.infer<typeof Wire> };
function remote(reply?: (request: Request) => Response | Promise<Response>) {
	const requests: Request[] = [];
	const transport: typeof fetch = Object.assign(
		async (...args: Parameters<typeof fetch>) => {
			const [url, init] = args;
			const request = { url: String(url), init, body: Wire.parse(JSON.parse(String(init?.body))) };
			requests.push(request);
			return reply ? reply(request) : response();
		},
		{ preconnect: fetch.preconnect },
	);
	return { requests, port: githubStatusesPort(github, transport) };
}
function response(): Response {
	return new Response(credential, { status: 201 });
}
function setup() {
	const fixture = harness();
	h = fixture;
	Object.assign(fixture.app.config, { github, githubStatuses: true, publicUrl: "https://mainworthy.example" });
	return fixture;
}
function report(
	fixture: Harness,
	outcome: "pass" | "fail" | "skip" = "fail",
	target = { commit, repo: github.repository, pr: 55 },
) {
	return fixture.call("report", {
		target,
		results: [
			{
				test: { key: "checkout" },
				outcome,
				...(outcome === "fail" ? { failure: { message: "Expected 90, got 100" } } : {}),
			},
		],
	});
}
function question(fixture: Harness) {
	const found = fixture.call<InboxReply>("inbox").items.find((item) => item.kind === "failure");
	if (!found) throw new Error("expected a failure question");
	return found;
}

test("the minute job posts a commit gate and posts a newer status in the same context after a decision", async () => {
	directory = mkdtempSync(join(tmpdir(), "mainworthy-statuses-"));
	let now = 1_800_000_000_000;
	const config = {
		...defaultConfig({}),
		owner: "robin",
		dataDir: directory,
		port: 0,
		github,
		githubStatuses: true,
		publicUrl: "https://mainworthy.example",
	};
	const sent: { url: string; method: string | undefined; body: unknown }[] = [];
	const original = globalThis.fetch;
	const fake = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				if (!String(input).startsWith("https://api.github.com/")) return original(input, init);
				sent.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body ?? "null")) });
				Wire.parse(JSON.parse(String(init?.body)));
				return Promise.resolve(response());
			},
			{ preconnect: original.preconnect },
		),
	);
	try {
		instance = start(config, () => ({ ui: null }), { readers: 0, now: () => now });
		const post = async (op: string, input: unknown = {}) => {
			const response = await original(`${instance?.url}/api/p/scratch/${op}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			expect(response.status).toBe(200);
			return z.object({ ok: z.literal(true), result: z.unknown() }).parse(await response.json()).result;
		};
		await post("report", {
			target: { commit, repo: github.repository, pr: 55 },
			results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Expected 90, got 100" } }],
		});
		expect(sent).toHaveLength(0);
		await instance.minute();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			url: `https://api.github.com/repos/example/shop/statuses/${commit}`,
			method: "POST",
			body: {
				context: "mainworthy/gate",
				state: "error",
				target_url: "https://mainworthy.example/p/scratch/changes/pr%3A55",
				description: expect.stringContaining("blocked:"),
			},
		});
		const question = InboxReply.parse(await post("inbox")).items.find((item) => item.kind === "failure");
		if (!question) throw new Error("expected a failure question");
		await post("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: { is: "infra", note: "Runner unavailable" },
		});
		now += 60_000;
		await instance.minute();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatchObject({
			url: `https://api.github.com/repos/example/shop/statuses/${commit}`,
			method: "POST",
			body: { state: "success", description: expect.stringContaining("passed:") },
		});
		now += 60_000;
		await instance.minute();
		expect(sent).toHaveLength(2);
	} finally {
		await instance?.stop();
		instance = undefined;
		fake.mockRestore();
	}
});

test("all four verdicts map to commit status states", async () => {
	const fixture = setup();
	const fake = remote();
	report(fixture);
	await deliverCommitStatuses(fixture.app, fake.port);
	const q = question(fixture);
	fixture.call("decide", {
		q: q.q,
		onEvidence: q.evidenceHash,
		answer: { is: "defect", ref: "https://github.com/example/shop/issues/1" },
	});
	fixture.advance(60_000);
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.at(-1)?.body).toMatchObject({
		state: "failure",
		description: expect.stringContaining("failed:"),
	});
	const project = findProject(fixture.app.db, "scratch");
	if (!project) throw new Error("expected scratch");
	fixture.app.db.transaction(() =>
		acceptReport(makeCtx(fixture.app, project, fixture.owner, true), {
			target: { commit, repo: github.repository, pr: 55 },
			attempt: 2,
			results: [{ test: { key: "checkout" }, outcome: "pass" }],
		}),
	);
	fixture.advance(60_000);
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.at(-1)).toMatchObject({
		url: `https://api.github.com/repos/example/shop/statuses/${commit}`,
		body: {
			state: "pending",
			description: "pending: 1 report accepted and not yet applied",
		},
	});
	expect(fake.requests.at(-1)?.body).not.toHaveProperty("status");
	const first = fake.requests.find((request) => request.init?.method === "POST");
	expect(new Headers(first?.init?.headers).get("Authorization")).toBe(`Bearer ${credential}`);
	expect(first?.init?.redirect).toBe("error");
	expect(first?.init?.signal).toBeInstanceOf(AbortSignal);
});

test("busy commits coalesce decisions and withdrawals and overlapping jobs release the writer", async () => {
	const fixture = setup();
	report(fixture);
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<Response>();
	let request: Request | undefined;
	const fake = remote((value) => {
		if (value.init?.method !== "POST") return response();
		request = value;
		entered.resolve();
		return finish.promise;
	});
	const delivery = deliverCommitStatuses(fixture.app, fake.port);
	expect(deliverCommitStatuses(fixture.app, fake.port)).toBe(delivery);
	await entered.promise;
	if (!request) throw new Error("expected a status post");
	try {
		await fixture.app.gate.run(() => {
			const q = question(fixture);
			fixture.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "infra" } });
			fixture.call("decide", { undo: q.q });
			const reopened = question(fixture);
			fixture.call("decide", { q: reopened.q, onEvidence: reopened.evidenceHash, answer: { is: "infra" } });
		});
	} finally {
		finish.resolve(response());
		await delivery;
	}
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
	fixture.advance(60_000);
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.map((value) => value.init?.method)).toEqual(["POST", "POST"]);
	expect(fake.requests.at(-1)?.body).toMatchObject({ state: "success" });
	const decided = fixture.call<InboxReply>("inbox", { state: "decided" }).items.find((item) => item.kind === "failure");
	if (!decided) throw new Error("expected the decided failure");
	fixture.call("decide", { undo: decided.q });
	fixture.advance(60_000);
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.at(-1)?.body).toMatchObject({ state: "error" });
});

test("failed status posts stay due and an accepted post clears the last error", async () => {
	const fixture = setup();
	report(fixture);
	let refuse = true;
	const fake = remote(() => (refuse ? new Response(credential, { status: 403 }) : response()));
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await deliverCommitStatuses(fixture.app, fake.port);
		expect(fixture.app.db.raw.query("SELECT state, sent FROM commit_statuses").get()).toEqual({
			state: "queued",
			sent: null,
		});
		refuse = false;
		fixture.advance(60_000);
		await deliverCommitStatuses(fixture.app, fake.port);
		expect(fake.requests.map((request) => request.body.state)).toEqual(["error", "error"]);
		expect(fixture.app.db.raw.query("SELECT state, error FROM commit_statuses").get()).toEqual({
			state: "complete",
			error: null,
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
		expect(JSON.stringify(fixture.app.db.raw.query("SELECT * FROM commit_statuses").all())).not.toContain(credential);
	} finally {
		log.mockRestore();
	}
});

test("a lost first reply retries the latest gate without reading remote state", async () => {
	const fixture = setup();
	report(fixture);
	let lose = true;
	const fake = remote(() => {
		if (lose) throw new Error(credential);
		return response();
	});
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await deliverCommitStatuses(fixture.app, fake.port);
		const q = question(fixture);
		fixture.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "infra" } });
		expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
		lose = false;
		fixture.advance(60_000);
		await deliverCommitStatuses(fixture.app, fake.port);
		expect(fake.requests.map((request) => [request.init?.method, request.body.state])).toEqual([
			["POST", "error"],
			["POST", "success"],
		]);
		expect(fixture.app.db.raw.query("SELECT state, error FROM commit_statuses").get()).toEqual({
			state: "complete",
			error: null,
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
	} finally {
		log.mockRestore();
	}
});

test("only opted-in counted reports for the configured project and repository enroll commit statuses", async () => {
	const fixture = setup();
	const fake = remote();
	fixture.app.config.githubStatuses = false;
	report(fixture);
	fixture.app.config.githubStatuses = true;
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests).toEqual([]);
	report(fixture, "pass", { commit: "b".repeat(40), repo: "other/repository", pr: 55 });
	const agent = fixture.actor("agent", "agent", ["read", "produce"]);
	fixture.call(
		"report",
		{
			target: { commit: "c".repeat(40), repo: github.repository, pr: 55 },
			results: [{ test: { key: "agent" }, outcome: "pass" }],
		},
		agent,
	);
	report(fixture, "pass", { commit: "abcdef123", repo: github.repository, pr: 55 });
	fixture.app.config.github = { ...github, project: "other" };
	report(fixture, "pass", { commit: "d".repeat(40), repo: github.repository, pr: 55 });
	fixture.app.config.github = github;
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests).toEqual([]);
	const receipt = report(fixture, "pass", { commit: "e".repeat(40), repo: github.repository, pr: 55 });
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.find((value) => value.init?.method === "POST")?.body).toMatchObject({
		state: "success",
	});
	expect(fake.requests[0]?.url).toBe(`https://api.github.com/repos/example/shop/statuses/${"e".repeat(40)}`);
	expect(JSON.stringify(receipt)).not.toContain(credential);
});

test("archives omit commit status state and restoring one does not enroll historical commits", async () => {
	const fixture = setup();
	report(fixture, "pass");
	const chunks: string[] = [];
	exportArchive(fixture.app.db, (chunk) => chunks.push(chunk));
	expect(chunks.join("")).not.toContain('"t":"commit_statuses"');
	expect(chunks.join("")).not.toContain(credential);
	const restored = openApp(fixture.app.config, { memory: true });
	try {
		importArchive(restored.db, chunks.join("").trimEnd().split("\n"));
		const fake = remote();
		await deliverCommitStatuses(restored, fake.port);
		expect(fake.requests).toEqual([]);
		expect(restored.db.raw.query("SELECT count(*) AS n FROM commit_statuses").get()).toEqual({ n: 0 });
	} finally {
		restored.close();
	}
});

test("configuration opts in explicitly and never quotes a malformed credential", () => {
	const env = {
		MAINWORTHY_GITHUB_PROJECT: "scratch",
		MAINWORTHY_GITHUB_REPOSITORY: github.repository,
		MAINWORTHY_GITHUB_TOKEN: credential,
		MAINWORTHY_PUBLIC_URL: "https://mainworthy.example",
	};
	expect(defaultConfig(env).githubStatuses).toBeUndefined();
	expect(defaultConfig({ ...env, MAINWORTHY_GITHUB_STATUSES: "1" })).toMatchObject({ githubStatuses: true, github });
	for (const input of [
		{ ...env, MAINWORTHY_GITHUB_STATUSES: "yes" },
		{ ...env, MAINWORTHY_GITHUB_STATUSES: "1", MAINWORTHY_PUBLIC_URL: undefined },
		{ ...env, MAINWORTHY_GITHUB_STATUSES: "1", MAINWORTHY_GITHUB_TOKEN: `${credential}\ninvalid` },
		{ MAINWORTHY_GITHUB_STATUSES: "1", MAINWORTHY_PUBLIC_URL: env.MAINWORTHY_PUBLIC_URL },
	]) {
		expect(() => defaultConfig(input)).toThrow(/MAINWORTHY_/);
		try {
			defaultConfig(input);
		} catch (error) {
			expect(String(error)).not.toContain(credential);
		}
	}
});

test("the adapter bounds descriptions and ignores reply bodies", async () => {
	const draft: StatusDraft = {
		commit,
		verdict: "pending",
		reason: `pending: ${"x".repeat(300)}`,
		url: "https://mainworthy.example/p/scratch/changes/pr%3A55",
	};
	const fake = remote();
	await fake.port.post(draft);
	expect(fake.requests[0]).toMatchObject({
		url: `https://api.github.com/repos/example/shop/statuses/${commit}`,
		init: { method: "POST" },
		body: {
			state: "pending",
			context: "mainworthy/gate",
			description: `pending: ${"x".repeat(131)}`,
			target_url: draft.url,
		},
	});
});

test("a row interrupted during delivery retries after its existing minute delay", async () => {
	const fixture = setup();
	report(fixture);
	fixture.app.db.raw
		.query("UPDATE commit_statuses SET state = 'sending', sent = NULL, next_at = ?")
		.run(fixture.app.now() + 60_000);
	const fake = remote();
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
	fixture.advance(60_000);
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.map((request) => [request.init?.method, request.body.state])).toEqual([["POST", "error"]]);
	expect(fixture.app.db.raw.query("SELECT state, error FROM commit_statuses").get()).toEqual({
		state: "complete",
		error: null,
	});
});

test("expired holds post the current status after the same sweep the minute job runs", async () => {
	const fixture = setup();
	report(fixture);
	const q = question(fixture);
	fixture.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } });
	const fake = remote();
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.at(-1)?.body).toMatchObject({ state: "success" });
	fixture.advance(15 * 86_400_000);
	await fixture.app.gate.run(() => sweep(fixture.app, ruleActor(fixture.app.db).id));
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.at(-1)).toMatchObject({
		url: `https://api.github.com/repos/example/shop/statuses/${commit}`,
		body: { state: "error", description: expect.stringContaining("blocked:") },
	});
});

test("shutdown records the in-flight reply and restart preserves accepted status and queued commits", async () => {
	directory = mkdtempSync(join(tmpdir(), "mainworthy-statuses-stop-"));
	let now = 1_800_000_000_000;
	const config = {
		...defaultConfig({}),
		owner: "robin",
		dataDir: directory,
		port: 0,
		github,
		githubStatuses: true,
		publicUrl: "https://mainworthy.example",
	};
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<Response>();
	let pending: Request | undefined;
	const slow = remote((request) => {
		if (request.init?.method !== "POST") return response();
		pending = request;
		entered.resolve();
		return finish.promise;
	});
	instance = start(config, () => ({ ui: null }), { readers: 0, now: () => now, statusPort: slow.port });
	const post = async (op: string, input: unknown) => {
		const reply = await fetch(`${instance?.url}/api/p/scratch/${op}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		expect(reply.status).toBe(200);
		return z.object({ ok: z.literal(true), result: z.unknown() }).parse(await reply.json()).result;
	};
	for (const sha of [commit, "b".repeat(40)])
		await post("report", {
			target: { commit: sha, repo: github.repository, pr: 55 },
			results: [{ test: { key: "checkout" }, outcome: "pass" }],
		});
	const minute = instance.minute();
	await entered.promise;
	if (!pending) throw new Error("expected a pending status post");
	const stopping = instance.stop();
	try {
		expect(instance.stop()).toBe(stopping);
		expect(await Promise.race([stopping.then(() => "stopped"), Bun.sleep(10).then(() => "waiting")])).toBe("waiting");
	} finally {
		finish.resolve(response());
		await minute;
		await stopping;
		instance = undefined;
	}
	const resumed = remote();
	instance = start(config, () => ({ ui: null }), { readers: 0, now: () => now, statusPort: resumed.port });
	expect(instance.app.db.raw.query("SELECT commit_sha, state FROM commit_statuses ORDER BY commit_sha").all()).toEqual([
		{ commit_sha: commit, state: "complete" },
		{ commit_sha: "b".repeat(40), state: "queued" },
	]);
	await instance.minute();
	expect(resumed.requests[0]?.url).toBe(`https://api.github.com/repos/example/shop/statuses/${"b".repeat(40)}`);
	expect(resumed.requests[0]?.body).toMatchObject({
		state: "success",
	});
	now += 60_000;
	await instance.minute();
	expect(resumed.requests.filter((request) => request.init?.method === "POST")).toHaveLength(1);
});

test("an older reply cannot complete a replacement row or bypass its minute limit", async () => {
	const fixture = setup();
	report(fixture);
	const old = fixture.app.db.raw.query<{ nonce: string }, []>("SELECT nonce FROM commit_statuses").get();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<Response>();
	const fake = remote(() => {
		entered.resolve();
		return finish.promise;
	});
	const delivery = deliverCommitStatuses(fixture.app, fake.port);
	await entered.promise;
	try {
		await fixture.app.gate.run(() => {
			fixture.app.db.raw.query("DELETE FROM commit_statuses").run();
			fixture.call("report", {
				target: { commit, repo: github.repository, pr: 55 },
				attempt: 2,
				results: [{ test: { key: "checkout" }, outcome: "pass" }],
			});
		});
	} finally {
		finish.resolve(response());
		await delivery;
	}
	const replacement = fixture.app.db.raw
		.query<{ nonce: string; state: string }, []>("SELECT nonce, state FROM commit_statuses")
		.get();
	expect(replacement?.nonce).not.toBe(old?.nonce);
	expect(replacement?.state).toBe("queued");
	expect(fake.requests.map((request) => request.body.state)).toEqual(["error"]);
	fixture.advance(60_000);
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.map((request) => request.body.state)).toEqual(["error", "success"]);
	expect(fixture.app.db.raw.query("SELECT state, error FROM commit_statuses").get()).toEqual({
		state: "complete",
		error: null,
	});
});

test("a minute handles twenty commits and leaves the rest for the next run", async () => {
	const fixture = setup();
	for (let n = 1; n <= 21; n++)
		report(fixture, "pass", { commit: n.toString(16).padStart(40, "0"), repo: github.repository, pr: n });
	const fake = remote();
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(20);
	expect(fake.requests.filter((request) => request.init?.method === "POST")).toHaveLength(20);
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
	fixture.advance(60_000);
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(1);
	expect(fake.requests.at(-1)?.url).toBe(
		`https://api.github.com/repos/example/shop/statuses/${(21).toString(16).padStart(40, "0")}`,
	);
	expect(fake.requests.at(-1)?.body).toMatchObject({ state: "success" });
});

test("a fresh upload that returns to the delivered verdict and reason sends no redundant update", async () => {
	const fixture = setup();
	report(fixture, "pass");
	const fake = remote();
	await deliverCommitStatuses(fixture.app, fake.port);
	fixture.call("report", {
		target: { commit, repo: github.repository, pr: 55 },
		attempt: 2,
		results: [{ test: { key: "checkout" }, outcome: "pass" }],
	});
	fixture.advance(60_000);
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
	expect(
		fake.requests.filter((request) => request.init?.method !== "GET").map((request) => request.body.description),
	).toEqual(["passed: 1 result proven"]);
});

test("a lost success reply followed by undo republishes the blocked gate", async () => {
	const fixture = setup();
	report(fixture);
	let remoteState: string | undefined;
	let loseSuccess = true;
	const fake = remote((request) => {
		if (request.body) remoteState = request.body.state;
		if (request.body?.state === "success" && loseSuccess) {
			loseSuccess = false;
			throw new Error(credential);
		}
		return response();
	});
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await deliverCommitStatuses(fixture.app, fake.port);
		const q = question(fixture);
		fixture.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "infra" } });
		fixture.advance(60_000);
		await deliverCommitStatuses(fixture.app, fake.port);
		expect(remoteState).toBe("success");
		fixture.call("decide", { undo: q.q });
		expect(fixture.call<{ verdict: string }>("gate", { commit, repo: github.repository }).verdict).toBe("blocked");
		fixture.advance(60_000);
		await deliverCommitStatuses(fixture.app, fake.port);
		fixture.advance(60_000);
		await deliverCommitStatuses(fixture.app, fake.port);
		expect(remoteState).toBe("error");
	} finally {
		log.mockRestore();
	}
});

test("a first post returning 500 retries the current gate on a later minute", async () => {
	const fixture = setup();
	report(fixture);
	let posts = 0;
	let remoteState: string | undefined;
	const fake = remote((request) => {
		if (request.init?.method === "POST") {
			if (++posts === 1) return new Response(credential, { status: 500 });
			remoteState = request.body?.state;
		}
		return response();
	});
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await deliverCommitStatuses(fixture.app, fake.port);
		expect(posts).toBe(1);
		for (let minute = 0; minute < 5; minute++) {
			fixture.advance(60_000);
			await deliverCommitStatuses(fixture.app, fake.port);
		}
		expect(posts).toBe(2);
		expect(remoteState).toBe("error");
	} finally {
		log.mockRestore();
	}
});

test("accepted commits stop reconciliation after thirty inactive days and a new report resumes it", async () => {
	const fixture = setup();
	report(fixture);
	const q = question(fixture);
	fixture.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "infra" } });
	const fake = remote();
	await deliverCommitStatuses(fixture.app, fake.port);
	fixture.advance(29 * 86_400_000);
	fixture.call("decide", { undo: q.q });
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.map((request) => request.body.state)).toEqual(["success", "error"]);
	const reopened = question(fixture);
	fixture.call("decide", { q: reopened.q, onEvidence: reopened.evidenceHash, answer: { is: "infra" } });
	fixture.advance(60_000);
	await deliverCommitStatuses(fixture.app, fake.port);
	fixture.advance(30 * 86_400_000);
	fixture.call("decide", { undo: reopened.q });
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
	expect(fake.requests.map((request) => request.body.state)).toEqual(["success", "error", "success"]);
	fixture.call("report", {
		target: { commit, repo: github.repository, pr: 55 },
		attempt: 2,
		results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Still failing" } }],
	});
	await deliverCommitStatuses(fixture.app, fake.port);
	expect(fake.requests.map((request) => request.body.state)).toEqual(["success", "error", "success", "error"]);
});

test("a failed post remains due even after thirty days", async () => {
	const fixture = setup();
	report(fixture);
	let fail = true;
	const fake = remote(() => (fail ? new Response(credential, { status: 500 }) : response()));
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await deliverCommitStatuses(fixture.app, fake.port);
		fixture.advance(31 * 86_400_000);
		fail = false;
		await deliverCommitStatuses(fixture.app, fake.port);
		expect(fake.requests.map((request) => request.body.state)).toEqual(["error", "error"]);
		expect(fixture.app.db.raw.query("SELECT state, error FROM commit_statuses").get()).toEqual({
			state: "complete",
			error: null,
		});
	} finally {
		log.mockRestore();
	}
});

test("P6 a refused 422 commit backs off and stops during one simulated day until a counted report resumes it", async () => {
	const fixture = setup();
	report(fixture);
	const start = fixture.app.now();
	const times: number[] = [];
	let refuse = true;
	const fake = remote(() => {
		times.push(fixture.app.now() - start);
		return refuse ? new Response(credential, { status: 422 }) : response();
	});
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		for (let minute = 0; minute <= 1440; minute++) {
			await deliverCommitStatuses(fixture.app, fake.port);
			fixture.advance(60_000);
		}
		console.info(`P6 posts for a 422 commit over one day: ${fake.requests.length}`);
		expect(times.map((time) => time / 60_000)).toEqual([
			0, 1, 3, 7, 15, 31, 63, 123, 183, 243, 303, 363, 423, 483, 543, 603,
		]);
		expect(fake.requests.at(-1)?.body.state).toBe("error");
		expect(fixture.app.db.raw.query("SELECT state, error FROM commit_statuses").get()).toEqual({
			state: "stopped",
			error:
				"GitHub commit status delivery stopped after 16 unsuccessful attempts; check repository access and Commit statuses write permission, then send a new counted report.",
		});
		expect(log.mock.calls.filter(([line]) => String(line).includes("delivery stopped"))).toHaveLength(1);
		const q = question(fixture);
		fixture.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "infra" } });
		fixture.advance(31 * 86_400_000);
		expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
		refuse = false;
		fixture.call("report", {
			target: { commit, repo: github.repository, pr: 55 },
			attempt: 2,
			results: [{ test: { key: "checkout" }, outcome: "pass" }],
		});
		await deliverCommitStatuses(fixture.app, fake.port);
		expect(fake.requests).toHaveLength(17);
		expect(fake.requests.at(-1)?.body.state).toBe("success");
	} finally {
		log.mockRestore();
	}
});

for (const status of [403, 429]) {
	test(`${status} pauses every row until both retry-after and the rate-limit reset have elapsed`, async () => {
		const fixture = setup();
		report(fixture, "pass");
		report(fixture, "pass", { commit: "b".repeat(40), repo: github.repository, pr: 56 });
		const reset = fixture.app.now() + 900_000;
		let refuse = true;
		const fake = remote(() =>
			refuse
				? new Response(credential, {
						status,
						headers: { "retry-after": "600", "x-ratelimit-reset": String(Math.ceil(reset / 1000)) },
					})
				: response(),
		);
		const log = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(1);
			fixture.advance(600_000);
			expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
			// Even a newly enrolled row must wait for the shared pause.
			report(fixture, "pass", { commit: "c".repeat(40), repo: github.repository, pr: 57 });
			fixture.advance(299_000);
			expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
			refuse = false;
			fixture.advance(2000);
			expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(3);
			expect(fake.requests.map((request) => request.body.state)).toEqual(["success", "success", "success", "success"]);
		} finally {
			log.mockRestore();
		}
	});
}

for (const status of [403, 429]) {
	for (const remaining of ["0", "5000", null]) {
		test(`${status} with remaining ${remaining} uses reset only when the limit is exhausted`, async () => {
			const fixture = setup();
			report(fixture, "pass");
			const headers = new Headers({ "x-ratelimit-reset": String(Math.ceil((fixture.app.now() + 3_000_000) / 1000)) });
			if (remaining !== null) headers.set("x-ratelimit-remaining", remaining);
			let refuse = true;
			const fake = remote(() => (refuse ? new Response(credential, { status, headers }) : response()));
			const log = spyOn(console, "error").mockImplementation(() => undefined);
			try {
				expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(1);
				refuse = false;
				fixture.advance(59_000);
				expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
				fixture.advance(1000);
				expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(remaining === "0" ? 0 : 1);
				fixture.advance(2_941_000);
				await deliverCommitStatuses(fixture.app, fake.port);
				expect(fake.requests.map((request) => request.body.state)).toEqual(["success", "success"]);
			} finally {
				log.mockRestore();
			}
		});
	}
}

test("the rolling hour permits 240 status posts across jobs and resumes when the oldest posts expire", async () => {
	const fixture = setup();
	for (let n = 1; n <= 241; n++)
		report(fixture, "pass", { commit: n.toString(16).padStart(40, "0"), repo: github.repository, pr: n });
	const fake = remote();
	for (let minute = 0; minute < 12; minute++) {
		expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(20);
		expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
		fixture.advance(60_000);
	}
	expect(fake.requests).toHaveLength(240);
	fixture.advance(47 * 60_000);
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
	fixture.advance(60_000);
	expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(1);
	expect(fake.requests.at(-1)).toMatchObject({
		url: `https://api.github.com/repos/example/shop/statuses/${(241).toString(16).padStart(40, "0")}`,
		body: { state: "success" },
	});
});

for (const failure of ["permission", "lost reply"]) {
	test(`a lasting ${failure} stops after sixteen attempts and accepted delivery resets the back-off`, async () => {
		const fixture = setup();
		report(fixture);
		let reject = true;
		const fake = remote(() => {
			if (!reject) return response();
			if (failure === "lost reply") throw new Error(credential);
			return new Response(credential, { status: 403 });
		});
		const log = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			for (let minute = 0; minute <= 1440; minute++) {
				await deliverCommitStatuses(fixture.app, fake.port);
				fixture.advance(60_000);
			}
			expect(fake.requests).toHaveLength(16);
			expect(fixture.app.db.raw.query("SELECT state FROM commit_statuses").get()).toEqual({ state: "stopped" });
			reject = false;
			fixture.call("report", {
				target: { commit, repo: github.repository, pr: 55 },
				attempt: 2,
				results: [{ test: { key: "checkout" }, outcome: "pass" }],
			});
			await deliverCommitStatuses(fixture.app, fake.port);
			expect(fake.requests.at(-1)?.body.state).toBe("success");
			fixture.call("report", {
				target: { commit, repo: github.repository, pr: 55 },
				attempt: 3,
				results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Failed again" } }],
			});
			fixture.advance(60_000);
			await deliverCommitStatuses(fixture.app, fake.port);
			expect(fake.requests).toHaveLength(18);
			expect(fake.requests.at(-1)?.body.state).toBe("error");
			expect(fixture.app.db.raw.query("SELECT state, attempts FROM commit_statuses").get()).toEqual({
				state: "complete",
				attempts: 0,
			});
			expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
		} finally {
			log.mockRestore();
		}
	});
}

for (const deadline of ["HTTP date", "ten-year seconds", "ten-year HTTP date", "ten-year reset"]) {
	test(`a ${deadline} rate-limit pause survives restart and is capped at one day`, async () => {
		directory = mkdtempSync(join(tmpdir(), "mainworthy-statuses-rate-"));
		let now = 1_800_000_000_000;
		const config = {
			...defaultConfig({}),
			owner: "robin",
			dataDir: directory,
			port: 0,
			github,
			githubStatuses: true,
			publicUrl: "https://mainworthy.example",
		};
		const pause = deadline === "HTTP date" ? 600_000 : 86_400_000;
		const far = now + 3650 * 86_400_000;
		const headers = new Headers();
		if (deadline === "ten-year reset") {
			headers.set("x-ratelimit-remaining", "0");
			headers.set("x-ratelimit-reset", String(far / 1000));
		} else {
			headers.set(
				"retry-after",
				deadline === "ten-year seconds"
					? String(3650 * 86_400)
					: new Date(deadline === "HTTP date" ? now + pause : far).toUTCString(),
			);
		}
		const limited = remote(() => new Response(credential, { status: 403, headers }));
		const log = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			instance = start(config, () => ({ ui: null }), { readers: 0, now: () => now, statusPort: limited.port });
			for (const sha of [commit, "b".repeat(40)]) {
				const reply = await fetch(`${instance.url}/api/p/scratch/report`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						target: { commit: sha, repo: github.repository, pr: 55 },
						results: [{ test: { key: "checkout" }, outcome: "pass" }],
					}),
				});
				expect(reply.status).toBe(200);
			}
			await instance.minute();
			expect(limited.requests).toHaveLength(1);
			await instance.stop();
			instance = undefined;
			const accepted = remote();
			instance = start(config, () => ({ ui: null }), { readers: 0, now: () => now, statusPort: accepted.port });
			now += pause - 1000;
			await instance.minute();
			expect(accepted.requests).toHaveLength(0);
			now += 1000;
			await instance.minute();
			expect(accepted.requests.map((request) => request.body.state)).toEqual(["success", "success"]);
			expect(instance.app.db.raw.query("SELECT posts FROM commit_status_delivery").get()).toEqual({
				posts: JSON.stringify(pause < 3_600_000 ? [now - pause, now, now] : [now, now]),
			});
		} finally {
			log.mockRestore();
		}
	});
}

test("repeated rate limits increase the shared delay even when each post is for a different commit", async () => {
	const fixture = setup();
	for (let n = 1; n <= 8; n++)
		report(fixture, "pass", { commit: n.toString(16).padStart(40, "0"), repo: github.repository, pr: n });
	const start = fixture.app.now();
	const times: number[] = [];
	const fake = remote(() => {
		times.push((fixture.app.now() - start) / 60_000);
		return new Response(credential, { status: 429 });
	});
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		for (let minute = 0; minute <= 123; minute++) {
			await deliverCommitStatuses(fixture.app, fake.port);
			fixture.advance(60_000);
		}
		expect(times).toEqual([0, 1, 3, 7, 15, 31, 63, 123]);
		expect(new Set(fake.requests.map((request) => request.url)).size).toBe(8);
		expect(fake.requests.at(-1)?.body.state).toBe("success");
	} finally {
		log.mockRestore();
	}
});

test("an interrupted sixteenth attempt stops once and a counted report with unchanged content resumes it", async () => {
	const fixture = setup();
	report(fixture, "pass");
	fixture.app.db.raw.query("UPDATE commit_statuses SET state = 'sending', attempts = 16").run();
	const fake = remote();
	const log = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
		expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(0);
		expect(log.mock.calls).toHaveLength(1);
		expect(fixture.app.db.raw.query("SELECT state FROM commit_statuses").get()).toEqual({ state: "stopped" });
		fixture.call("report", {
			target: { commit, repo: github.repository, pr: 55 },
			attempt: 2,
			results: [{ test: { key: "checkout" }, outcome: "pass" }],
		});
		expect(await deliverCommitStatuses(fixture.app, fake.port)).toBe(1);
		expect(fake.requests[0]?.body).toMatchObject({ state: "success", description: "passed: 1 result proven" });
	} finally {
		log.mockRestore();
	}
});

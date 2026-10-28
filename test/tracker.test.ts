import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, start } from "../src/app/start.ts";
import type { InboxReply } from "../src/core/ops.ts";
import type { TrackerItem, TrackerReceipt } from "../src/core/tracker.ts";
import { type App, defaultConfig, openApp } from "../src/server/kernel/app.ts";
import { Database, type SqlValue, sql } from "../src/server/kernel/db.ts";
import { pollDefectHolds, stopTrackerPolls, waitTrackerPolls } from "../src/server/ops/tracker-holds.ts";
import { githubPort } from "../src/server/trackers/github.ts";
import { jiraPort } from "../src/server/trackers/jira.ts";
import type { DefectDraft, TrackerPort } from "../src/server/trackers/port.ts";
import { deliverTrackerRequests } from "../src/server/trackers/requests.ts";
import { exportArchive, importArchive } from "../src/server/transfer/transfer.ts";
import { testDatabase } from "./db.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

function rejectTrackerCompletion(app: App, message: string) {
	const write = app.database.write.bind(app.database);
	return spyOn(app.database, "write").mockImplementation(
		async (fn, options) =>
			await write(async (db) => {
				const run = db.run.bind(db);
				const writes = spyOn(db, "run").mockImplementation(async (statement, ...params) => {
					if (statement.text.includes("UPDATE tracker_requests") && statement.text.includes("issue ="))
						throw new Error(message);
					return await run(statement, ...params);
				});
				try {
					return await fn(db);
				} finally {
					writes.mockRestore();
				}
			}, options),
	);
}

const credential = "test-tracker-credential";
const github = { project: "scratch", repository: "example/shop", token: credential };
const jira = {
	project: "scratch",
	site: "https://example.atlassian.net",
	projectKey: "QA",
	issueType: "Bug",
	email: "robin@example.com",
	token: credential,
};
const jiraItem = {
	ref: "jira:https://example.atlassian.net#QA-42",
	url: "https://example.atlassian.net/browse/QA-42",
	state: "open",
} as const;
const item = {
	ref: "github:example/shop#42",
	url: "https://github.com/example/shop/issues/42",
	state: "open",
} as const;
const port: TrackerPort = { createDefect: async () => item, getItem: async () => item };

for (const tracker of ["github", "jira"] as const) {
	test(`${tracker} closure ends a defect through a recorded decision and asks the still-failing question again`, async () => {
		directory = mkdtempSync(join(tmpdir(), "mainworthy-tracker-closure-"));
		const issue = tracker === "github" ? item : jiraItem;
		const keys: string[] = [];
		let closed = false;
		instance = await start(
			{
				...defaultConfig({ MAINWORTHY_DATABASE_URL: (await testDatabase()).url }),
				owner: "robin",
				dataDir: directory,
				port: 0,
				...(tracker === "github" ? { github } : { jira }),
			},
			() => ({ ui: null }),
			{
				trackerPort:
					tracker === "github"
						? githubPort(
								github,
								transport((url) => {
									keys.push(new URL(url).pathname.split("/").at(-1) ?? "");
									return Response.json({ number: 42, state: closed ? "closed" : "open" });
								}),
							)
						: jiraPort(
								jira,
								transport((url) => {
									keys.push(new URL(url).pathname.split("/").at(-1) ?? "");
									return Response.json({
										key: "QA-42",
										fields: { status: { statusCategory: { key: closed ? "done" : "indeterminate" } } },
									});
								}),
							),
			},
		);
		const post = async (operation: string, input: unknown = {}) => {
			const response = await fetch(`${instance?.url}/api/p/scratch/${operation}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			const body = await response.json();
			expect(body.ok).toBe(true);
			return body.result;
		};
		await post("report", {
			target: { session: "closure-check" },
			results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Expected 90, got 100" } }],
		});
		const question = (await post("inbox")).items.find((q: { kind: string }) => q.kind === "failure");
		const answer = await post("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: { is: "defect", ref: issue.url },
			reason: "Tracked defect",
		});
		expect(answer[0].status).toBe("decided");
		const decision = answer[0].decision;
		expect((await post("inbox")).items.filter((q: { kind: string }) => q.kind === "failure")).toHaveLength(0);
		closed = true;
		await instance.minute();
		expect((await post("inbox")).items.filter((q: { kind: string }) => q.kind === "failure")).toHaveLength(1);
		expect(keys).toEqual([tracker === "github" ? "42" : "QA-42"]);
		const ending = await instance.app.database.read(
			async (db) =>
				await db.get(
					sql<readonly SqlValue[], { answer: string; signers: string }>(
						"SELECT answer, signers FROM decisions WHERE supersedes = $1 ORDER BY id DESC LIMIT 1",
					),
					[decision],
				),
		);
		expect(ending && JSON.parse(ending.answer)).toEqual({ is: "outdated" });
		expect(ending?.signers).toContain(issue.url);
		expect(
			await instance.app.database.read(
				async (db) =>
					await db.get(sql<readonly SqlValue[], Record<string, unknown>>("SELECT count(*) AS n FROM excuses"), []),
			),
		).toEqual({ n: 0 });
		await instance.minute();
		expect(keys).toHaveLength(1);
	});
}
let h: Harness;
let instance: Instance | undefined;
let directory: string | undefined;
afterEach(async () => {
	await instance?.stop();
	instance = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	await h?.close();
});

async function failure() {
	h = await harness();
	h.app.config.github = github;
	await h.call("propose", { edits: [{ op: "create", outline: "Checkout total" }] });
	await h.call("report", {
		target: { commit: "abcdef123", repo: "example/shop" },
		buildUrl: "https://ci.example/build/42",
		results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "Expected 90, got 100" } }],
	});
	const result = (
		await h.app.database.read(
			async (db) => await db.get(sql<readonly SqlValue[], { id: number }>("SELECT id FROM results"), []),
		)
	)?.id;
	if (!result) throw new Error("expected the reported result");
	return result;
}

const transport = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
	Object.assign(async (...args: Parameters<typeof fetch>) => respond(String(args[0]), args[1]), {
		preconnect: fetch.preconnect,
	});

test("Jira's REST v3 adapter creates an ADF defect and reads status categories from a fake Jira server", async () => {
	const requests: { path: string; method: string; authorization: string | null; body: unknown }[] = [];
	let category = "indeterminate";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				path: url.pathname + url.search,
				method: request.method,
				authorization: request.headers.get("authorization"),
				body: request.method === "POST" ? await request.json() : null,
			});
			if (request.method === "POST")
				return Response.json(
					{ id: "10042", key: "QA-42", self: `${jira.site}/rest/api/3/issue/10042` },
					{ status: 201 },
				);
			return Response.json({ key: "QA-42", fields: { status: { name: "Done", statusCategory: { key: category } } } });
		},
	});
	try {
		const adapter = jiraPort(
			jira,
			transport((url, init) => fetch(`${server.url.origin}${new URL(url).pathname}${new URL(url).search}`, init)),
		);
		expect(
			await adapter.createDefect({ title: "A failure", body: "Recorded evidence\n\nExpected <90>, got 100" }),
		).toEqual(jiraItem);
		category = "done";
		expect(await adapter.getItem("QA-42")).toEqual({ ...jiraItem, state: "closed" });
		expect(requests.map(({ path, method }) => [path, method])).toEqual([
			["/rest/api/3/issue", "POST"],
			["/rest/api/3/issue/QA-42?fields=status", "GET"],
			["/rest/api/3/issue/QA-42?fields=status", "GET"],
		]);
		expect(requests[0]?.authorization).toBe(`Basic ${Buffer.from(`${jira.email}:${credential}`).toString("base64")}`);
		expect(requests[0]?.body).toEqual({
			fields: {
				project: { key: "QA" },
				issuetype: { name: "Bug" },
				summary: "A failure",
				description: {
					type: "doc",
					version: 1,
					content: [
						{ type: "paragraph", content: [{ type: "text", text: "Recorded evidence" }] },
						{ type: "paragraph", content: [] },
						{ type: "paragraph", content: [{ type: "text", text: "Expected <90>, got 100" }] },
					],
				},
			},
		});
		await expect(adapter.getItem("../QA-42")).rejects.toThrow("configured project");
		await expect(adapter.getItem("OTHER-42")).rejects.toThrow("configured project");
	} finally {
		await server.stop(true);
	}
});

test("Jira queues through the existing registry and neither credentials nor delivery state enter an archive", async () => {
	const result = await failure();
	const configured = defaultConfig({
		MAINWORTHY_JIRA_PROJECT: "scratch",
		MAINWORTHY_JIRA_SITE: "https://example.atlassian.net",
		MAINWORTHY_JIRA_PROJECT_KEY: "QA",
		MAINWORTHY_JIRA_ISSUE_TYPE: "Bug",
		MAINWORTHY_JIRA_EMAIL: "robin@example.com",
		MAINWORTHY_JIRA_TOKEN: credential,
	}).jira;
	if (!configured) throw new Error("Jira configuration was not read");
	expect(configured).toMatchObject({ issueType: "Bug", email: "robin@example.com", token: credential });
	h.app.config.jira = configured;
	await h.call("tracker", { do: "create", result, cmd: "jira-create-001" });
	expect(
		await h.app.database.read(
			async (db) =>
				await db.get(
					sql<readonly SqlValue[], Record<string, unknown>>(
						"SELECT repository, state FROM tracker_requests WHERE id = 'jira-create-001'",
					),
					[],
				),
		),
	).toEqual({ repository: "jira:https://example.atlassian.net#QA", state: "queued" });
	const drafts: DefectDraft[] = [];
	await deliverTrackerRequests(h.app, {
		createDefect: async (draft) => {
			drafts.push(draft);
			return jiraItem;
		},
		getItem: async () => jiraItem,
	});
	expect(drafts[0]?.body).toContain("Case: C-1@v1");
	expect(await h.call("tracker-status", { id: "jira-create-001" })).toMatchObject({
		state: "complete",
		issue: jiraItem,
	});
	await h.call("tracker", { do: "link", key: "QA-42", result, cmd: "jira-link-0001" });
	const keys: string[] = [];
	await deliverTrackerRequests(h.app, {
		...port,
		getItem: async (key) => {
			keys.push(key);
			return jiraItem;
		},
	});
	expect(keys).toEqual(["QA-42"]);
	expect(await h.raw("tracker", { do: "link", key: "OTHER-42", result, cmd: "jira-link-other" })).toMatchObject({
		ok: false,
		error: { code: "invalid" },
	});
	const archive: string[] = [];
	await h.app.database.read(async (db) => await exportArchive(db, (chunk) => archive.push(chunk)));
	const contents = archive.join("");
	for (const secret of [credential, jira.email, Buffer.from(`${jira.email}:${credential}`).toString("base64")]) {
		expect(contents).not.toContain(secret);
		expect(
			JSON.stringify(
				await h.app.database.read(
					async (db) =>
						await db.all(sql<readonly SqlValue[], Record<string, unknown>>("SELECT * FROM tracker_requests"), []),
				),
			),
		).not.toContain(secret);
	}
	expect(contents).not.toContain('"t":"tracker_requests"');
	expect(contents).not.toContain('"t":"tracker_polls"');
});

test("Jira rejects wrong issues, malformed categories, failures and redirects without exposing response text or retrying creation", async () => {
	const result = await failure();
	h.app.config.jira = jira;
	for (const [index, response] of [
		new Response(`${credential} ${jira.email}`, { status: 401 }),
		new Response(credential, { status: 302, headers: { Location: "https://elsewhere.example/issue" } }),
		Response.json({ key: "OTHER-42" }, { status: 201 }),
		Response.json({ key: 42 }, { status: 201 }),
		new Response(credential, { status: 201 }),
	].entries()) {
		const id = `jira-failed-${index}`;
		await h.call("tracker", { do: "create", result, cmd: id });
		let calls = 0;
		const adapter = jiraPort(
			jira,
			transport((_url, init) => {
				calls++;
				expect(init?.redirect).toBe("error");
				return response;
			}),
		);
		await deliverTrackerRequests(h.app, adapter);
		const status = await h.call<TrackerReceipt>("tracker-status", { id });
		expect(status).toMatchObject({ state: "failed", issue: null });
		expect(status.error).toContain("Jira");
		expect(JSON.stringify(status)).not.toContain(credential);
		expect(await deliverTrackerRequests(h.app, adapter)).toBe(0);
		expect(calls).toBe(1);
	}
	for (const body of [
		{ key: "QA-43", fields: { status: { statusCategory: { key: "done" } } } },
		{ key: "QA-42", fields: { status: { name: "Done" } } },
		{ key: "QA-42", fields: { status: { statusCategory: { key: "unknown" } } } },
	])
		await expect(
			jiraPort(
				jira,
				transport(() => Response.json(body)),
			).getItem("QA-42"),
		).rejects.toThrow("requested issue and status category");
});

test("a Jira create whose follow-up status read fails is left uncertain and is never created again automatically", async () => {
	const result = await failure();
	h.app.config.jira = jira;
	let creates = 0;
	let reads = 0;
	await h.call("tracker", { do: "create", result, cmd: "jira-created-uncertain" });
	const adapter = jiraPort(
		jira,
		transport((_url, init) => {
			if (init?.method === "POST") {
				creates++;
				return Response.json({ key: "QA-42" }, { status: 201 });
			}
			reads++;
			throw new Error(`${credential} ${jira.email}`);
		}),
	);
	expect(await deliverTrackerRequests(h.app, adapter)).toBe(1);
	const status = await h.call<TrackerReceipt>("tracker-status", { id: "jira-created-uncertain" });
	expect(status).toMatchObject({ state: "failed", issue: null });
	expect(status.error).toContain("check Jira before creating another issue");
	expect(JSON.stringify(status)).not.toContain(credential);
	expect(JSON.stringify(status)).not.toContain(jira.email);
	expect(await deliverTrackerRequests(h.app, adapter)).toBe(0);
	expect([creates, reads]).toEqual([1, 1]);
});

test("malformed Jira process configuration is refused without quoting email, token or site credentials", () => {
	const env = {
		MAINWORTHY_JIRA_PROJECT: "scratch",
		MAINWORTHY_JIRA_SITE: jira.site,
		MAINWORTHY_JIRA_PROJECT_KEY: "QA",
		MAINWORTHY_JIRA_ISSUE_TYPE: "Bug",
		MAINWORTHY_JIRA_EMAIL: jira.email,
		MAINWORTHY_JIRA_TOKEN: credential,
	};
	for (const config of [
		{ MAINWORTHY_JIRA_TOKEN: credential },
		{ ...env, MAINWORTHY_JIRA_SITE: `https://${credential}@example.atlassian.net` },
		{ ...env, MAINWORTHY_JIRA_SITE: "http://example.atlassian.net" },
		{ ...env, MAINWORTHY_JIRA_SITE: `${jira.site}/rest/api/3` },
		{ ...env, MAINWORTHY_JIRA_PROJECT_KEY: "../QA" },
		{ ...env, MAINWORTHY_JIRA_TOKEN: `${credential}\nprivate` },
		{ ...env, MAINWORTHY_JIRA_EMAIL: `robin:${credential}@example.com` },
		{ ...env, MAINWORTHY_JIRA_ISSUE_TYPE: `Bug\n${credential}` },
	]) {
		try {
			defaultConfig(config);
			throw new Error("configuration should be refused");
		} catch (error) {
			expect(String(error)).toContain("MAINWORTHY_JIRA");
			expect(String(error)).not.toContain(credential);
			expect(String(error)).not.toContain(jira.email);
		}
	}
});

async function heldDefect(ref: string = item.url) {
	await failure();
	const question = (await h.call<InboxReply>("inbox")).items.find((row) => row.kind === "failure");
	if (!question) throw new Error("expected a failure question");
	const answer = await h.call<{ decision: number }[]>("decide", {
		q: question.q,
		onEvidence: question.evidenceHash,
		answer: { is: "defect", ref },
	});
	return { question, decision: answer[0]?.decision };
}

for (const scenario of ["401", "404", "network", "undefined", "moved"] as const) {
	test(`unreadable Jira hold exposes a safe actionable diagnostic in get, queue and history: ${scenario}`, async () => {
		const { question, decision } = await heldDefect(jiraItem.url);
		h.app.config.jira = jira;
		const logged = spyOn(console, "warn").mockImplementation(() => undefined);
		const since = new Date(h.app.now()).toISOString();
		const adapter = jiraPort(
			jira,
			transport(() => {
				if (scenario === "network") throw new Error(credential);
				if (scenario === "401" || scenario === "404") return new Response(credential, { status: Number(scenario) });
				return Response.json({
					key: scenario === "moved" ? "QA-43" : "QA-42",
					fields: { status: { statusCategory: { key: scenario === "undefined" ? "undefined" : "done" } } },
					detail: credential,
				});
			}),
		);
		try {
			expect(await pollDefectHolds(h.app, adapter)).toBe(0);
			const detail = (
				await h.call<{ decision: { id: number; trackerError?: string } }[]>("get", { refs: [question.q] })
			)[0];
			const text = detail?.decision.trackerError;
			expect(text).toContain(`The tracker could not be read since ${since}:`);
			const action = {
				"401": "Renew the tracker token",
				"404": "Check the issue key and account permissions",
				network: "Check the tracker connection",
				undefined: "Set a Jira status category",
				moved: "Answer the failure again with the new issue key",
			}[scenario];
			expect(text).toContain(action);
			expect(
				(await h.call<InboxReply>("inbox", { state: "decided" })).items.find((row) => row.q === question.q)?.decision,
			).toMatchObject({ id: decision, trackerError: text });
			expect(
				(await h.call<{ questions: { decision: unknown }[] }>("timeline", { ref: "C-1" })).questions,
			).toContainEqual(expect.objectContaining({ decision: expect.objectContaining({ trackerError: text }) }));
			expect(logged.mock.calls).toHaveLength(1);
			expect(JSON.stringify(logged.mock.calls)).toContain(text ?? "missing diagnostic");
			h.advance(60_000);
			expect(await pollDefectHolds(h.app, adapter)).toBe(0);
			expect(logged.mock.calls).toHaveLength(1);
			expect(
				(await h.call<{ decision: { trackerError?: string } }[]>("get", { refs: [question.q] }))[0]?.decision
					.trackerError,
			).toBe(text);
			for (const secret of [credential, jira.email, Buffer.from(`${jira.email}:${credential}`).toString("base64")]) {
				expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
				expect(JSON.stringify(detail)).not.toContain(secret);
			}
			expect(
				await h.app.database.read(
					async (db) =>
						await db.get(sql<readonly SqlValue[], Record<string, unknown>>("SELECT count(*) AS n FROM excuses"), []),
				),
			).toEqual({ n: 1 });
			h.advance(120_000);
			expect(await pollDefectHolds(h.app, { ...port, getItem: async () => jiraItem })).toBe(0);
			expect(
				(await h.call<{ decision: { trackerError?: string } }[]>("get", { refs: [question.q] }))[0]?.decision
					.trackerError,
			).toBeUndefined();
			h.advance(60_000);
			await pollDefectHolds(h.app, adapter);
			expect(logged.mock.calls).toHaveLength(2);
		} finally {
			logged.mockRestore();
		}
	});
}

test("several holds on one failing issue log once, while a different failing issue has its own log", async () => {
	h = await harness();
	h.app.config.github = github;
	await h.call("report", {
		target: { session: "shared-issue" },
		results: ["Alpha failure", "Beta failure", "Gamma failure"].map((message, i) => ({
			test: { key: `test-${i}` },
			outcome: "fail",
			failure: { message },
		})),
	});
	const questions = (await h.call<InboxReply>("inbox", { kind: "failure" })).items;
	expect(questions).toHaveLength(3);
	for (const [i, q] of questions.entries())
		await h.call("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "defect", ref: i === 2 ? "github:example/shop#43" : item.url },
		});
	const logged = spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		const adapter = githubPort(
			github,
			transport(() => new Response(credential, { status: 401 })),
		);
		await pollDefectHolds(h.app, adapter);
		expect(logged.mock.calls.map((call) => call[1])).toEqual([
			{ project: "scratch", issue: "42", diagnostic: expect.stringContaining("HTTP 401. Renew the tracker token") },
			{ project: "scratch", issue: "43", diagnostic: expect.stringContaining("HTTP 401. Renew the tracker token") },
		]);
		h.advance(60_000);
		await pollDefectHolds(h.app, adapter);
		expect(logged.mock.calls).toHaveLength(2);
		expect(
			(await h.call<InboxReply>("inbox", { state: "decided" })).items.filter((q) => q.decision?.trackerError),
		).toHaveLength(3);
		expect(JSON.stringify(logged.mock.calls)).not.toContain(credential);
	} finally {
		logged.mockRestore();
	}
});

test("open issues and failed reads keep holds, back off persistently, and a later closure changes the gate", async () => {
	await heldDefect();
	let calls = 0;
	let state: "fail" | "open" | "closed" = "fail";
	const adapter: TrackerPort = {
		...port,
		getItem: async () => {
			calls++;
			if (state === "fail") throw new Error(credential);
			return { ...item, state };
		},
	};
	expect(await h.call("gate", { commit: "abcdef123", repo: "example/shop" })).toMatchObject({
		verdict: "failed",
		tally: { attributed: 1 },
	});
	expect(await pollDefectHolds(h.app, adapter)).toBe(0);
	const schedule = async () =>
		await h.app.database.read(
			async (db) =>
				await db.get(
					sql<readonly SqlValue[], { next_at: number; attempts: number; error: string }>(
						"SELECT next_at, attempts, error FROM tracker_polls",
					),
					[],
				),
		);
	expect((await schedule())?.attempts).toBe(1);
	expect((await schedule())?.error).not.toContain(credential);
	expect(await pollDefectHolds(h.app, adapter)).toBe(0);
	expect(calls).toBe(1);
	h.advance(((await schedule())?.next_at ?? 0) - h.app.now());
	expect(await pollDefectHolds(h.app, adapter)).toBe(0);
	expect((await schedule())?.next_at).toBe(h.app.now() + 120_000);
	state = "open";
	h.advance(120_000);
	expect(await pollDefectHolds(h.app, adapter)).toBe(0);
	expect((await schedule())?.attempts).toBe(0);
	expect((await h.call<InboxReply>("inbox")).items.filter((q) => q.kind === "failure")).toHaveLength(0);
	state = "closed";
	h.advance(60_000);
	expect(await pollDefectHolds(h.app, adapter)).toBe(1);
	expect(await h.call("gate", { commit: "abcdef123", repo: "example/shop" })).toMatchObject({
		verdict: "blocked",
		tally: { unexplained: 1 },
	});
	expect((await h.call<InboxReply>("inbox")).items.filter((q) => q.kind === "failure")).toHaveLength(1);
});

test("tracker closure keeps an ended defect and its reason in Settled when its change is gone", async () => {
	h = await harness();
	h.app.config.github = github;
	await h.call(
		"report",
		ciReport({ commit: "tracker408a", branch: "fix", pr: 408, n: 1, fail: { 0: "expected 90, got 100" } }),
	);
	const question = (await h.call<InboxReply>("inbox", { kind: "failure" })).items[0];
	if (!question) throw new Error("expected a failure question");
	await h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "defect", ref: item.url } });
	await h.call("change", { change: "pr:408", state: "closed" });
	expect(await pollDefectHolds(h.app, { ...port, getItem: async () => ({ ...item, state: "closed" }) })).toBe(1);
	const ended = {
		q: question.q,
		state: "dissolved",
		decision: {
			answer: { is: "outdated" },
			rule: "tracker-closed",
			reason: "Tracker issue https://github.com/example/shop/issues/42 is closed; the defect hold ended.",
			supersedes: { answer: { is: "defect", ref: item.url }, by: ["robin"] },
		},
	};
	expect(await h.call("get", { refs: [question.q] })).toMatchObject([ended]);
	expect((await h.call<InboxReply>("inbox", { state: "decided", kind: "failure" })).items).toMatchObject([ended]);
});

for (const change of ["answer", "configuration", "archive"] as const) {
	test(`a delayed closed reply cannot end a hold after the ${change} changes`, async () => {
		const { question, decision } = await heldDefect();
		const originalDatabase = h.app.database;
		const entered = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<TrackerItem>();
		const polling = pollDefectHolds(h.app, {
			...port,
			getItem: () => {
				entered.resolve();
				return reply.promise;
			},
		});
		await entered.promise;
		expect(await pollDefectHolds(h.app, port)).toBe(0);
		if (change === "answer")
			await h.call("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "expected" },
				reason: "Expected while changing checkout",
			});
		if (change === "configuration") h.app.config.github = { ...github, repository: "example/other" };
		if (change === "archive") {
			const archive: string[] = [];
			await h.app.database.read(async (db) => await exportArchive(db, (chunk) => archive.push(chunk)));
			const restored = await Database.open({ url: (await testDatabase()).url });
			await restored.write(
				async (db) => await db.transaction(async () => await importArchive(db, archive.join("").trimEnd().split("\n"))),
			);
			const replaced = h.app.database;
			h.app.database = restored;
			await replaced.close();
			expect(
				await restored.read(
					async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM tracker_polls")),
				),
			).toEqual({ n: 0 });
		}
		reply.resolve({ ...item, state: "closed" });
		expect(await polling).toBe(0);
		expect((await h.call<InboxReply>("inbox")).items.filter((q) => q.kind === "failure")).toHaveLength(0);
		expect(
			await h.app.database.read(
				async (db) =>
					await db.get(
						sql<readonly SqlValue[], { n: number }>(
							'SELECT count(*) AS n FROM decisions WHERE supersedes = $1 AND answer = \'{"is":"outdated"}\'',
						),
						[decision ?? 0],
					),
			),
		).toEqual({ n: 0 });
		if (h.app.database !== originalDatabase) {
			await h.app.database.close();
			h.app.database = originalDatabase;
		}
	});
}

test("polling only recognizes exact configured issue references and never accepts another issue's closure", async () => {
	await heldDefect("https://github.com/example/elsewhere/issues/42");
	expect(await pollDefectHolds(h.app, port)).toBe(0);
	expect(
		await h.app.database.read(
			async (db) =>
				await db.get(sql<readonly SqlValue[], Record<string, unknown>>("SELECT count(*) AS n FROM tracker_polls"), []),
		),
	).toEqual({ n: 0 });
	const q = await h.app.database.read(
		async (db) =>
			await db.get(
				sql<readonly SqlValue[], { no: number; evidence_hash: string }>(
					"SELECT no, evidence_hash FROM questions WHERE kind = 'failure'",
				),
				[],
			),
	);
	await h.call("decide", { q: `Q-${q?.no}`, onEvidence: q?.evidence_hash, answer: { is: "defect", ref: item.ref } });
	expect(
		await pollDefectHolds(h.app, {
			...port,
			getItem: async () => ({
				ref: "github:example/shop#43",
				url: "https://github.com/example/shop/issues/43",
				state: "closed",
			}),
		}),
	).toBe(0);
	expect(
		await h.app.database.read(
			async (db) =>
				await db.get(sql<readonly SqlValue[], Record<string, unknown>>("SELECT count(*) AS n FROM excuses"), []),
		),
	).toEqual({ n: 1 });
	h.advance(60_000);
	expect(await pollDefectHolds(h.app, { ...port, getItem: async () => ({ ...item, state: "closed" }) })).toBe(1);
});

test("stopping polling waits for its in-flight reply and never starts another read", async () => {
	await heldDefect();
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<TrackerItem>();
	let reads = 0;
	const adapter: TrackerPort = {
		...port,
		getItem: () => {
			reads++;
			entered.resolve();
			return reply.promise;
		},
	};
	const polling = pollDefectHolds(h.app, adapter);
	await entered.promise;
	stopTrackerPolls(h.app);
	const waiting = waitTrackerPolls(h.app);
	reply.resolve({ ...item, state: "closed" });
	await waiting;
	expect(await polling).toBe(1);
	expect(await pollDefectHolds(h.app, adapter)).toBe(0);
	expect(reads).toBe(1);
	expect((await h.call<InboxReply>("inbox")).items.filter((q) => q.kind === "failure")).toHaveLength(1);
});

test("polling back-off survives an instance restart", async () => {
	directory = mkdtempSync(join(tmpdir(), "mainworthy-poll-restart-"));
	const logged = spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		let now = 1_800_000_000_000;
		let calls = 0;
		let closed = false;
		const config = {
			...defaultConfig({ MAINWORTHY_DATABASE_URL: (await testDatabase()).url }),
			owner: "robin",
			dataDir: directory,
			port: 0,
			github,
		};
		const options = {
			now: () => now,
			trackerPort: {
				...port,
				getItem: async () => {
					calls++;
					if (!closed) throw new Error("Tracker temporarily unavailable");
					return { ...item, state: "closed" as const };
				},
			},
		};
		instance = await start(config, () => ({ ui: null }), options);
		const post = async (operation: string, input: unknown = {}) => {
			const response = await fetch(`${instance?.url}/api/p/scratch/${operation}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			const body = await response.json();
			expect(body.ok).toBe(true);
			return body.result;
		};
		await post("report", {
			target: { session: "poll-restart" },
			results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Expected 90, got 100" } }],
		});
		const q = (await post("inbox")).items.find((row: { kind: string }) => row.kind === "failure");
		await post("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "defect", ref: item.url } });
		await instance.minute();
		expect(calls).toBe(1);
		const diagnostic = (await post("get", { refs: [q.q] }))[0].decision.trackerError;
		expect(diagnostic).toContain(`The tracker could not be read since ${new Date(now).toISOString()}`);
		expect(logged.mock.calls).toHaveLength(1);
		await instance.stop();
		instance = await start(config, () => ({ ui: null }), options);
		now += 59_999;
		await instance.minute();
		expect(calls).toBe(1);
		expect((await post("inbox")).items.filter((row: { kind: string }) => row.kind === "failure")).toHaveLength(0);
		expect((await post("get", { refs: [q.q] }))[0].decision.trackerError).toBe(diagnostic);
		now++;
		await instance.minute();
		expect(calls).toBe(2);
		expect(logged.mock.calls).toHaveLength(1);
		expect((await post("get", { refs: [q.q] }))[0].decision.trackerError).toBe(diagnostic);
		closed = true;
		now += 120_000;
		await instance.minute();
		expect(calls).toBe(3);
		expect((await post("inbox")).items.filter((row: { kind: string }) => row.kind === "failure")).toHaveLength(1);
	} finally {
		logged.mockRestore();
	}
});

test("ending a defect whose failure has been replaced by a pass does not reopen an obsolete question", async () => {
	await heldDefect();
	await h.call("report", {
		target: { commit: "abcdef123", repo: "example/shop" },
		attempt: 2,
		results: [{ test: { case: "C-1" }, outcome: "pass" }],
	});
	await pollDefectHolds(h.app, { ...port, getItem: async () => ({ ...item, state: "closed" }) });
	expect((await h.call<InboxReply>("inbox")).items.filter((q) => q.kind === "failure")).toHaveLength(0);
	expect(await h.call("gate", { commit: "abcdef123", repo: "example/shop" })).toMatchObject({ verdict: "passed" });
});

test("twenty due polls per minute are fair to later decisions", async () => {
	h = await harness();
	h.app.config.github = github;
	await h.call("report", {
		target: { session: "many-defects" },
		results: Array.from({ length: 21 }, (_, index) => ({
			test: { key: `test-${index}` },
			outcome: "fail",
			failure: { message: `Different failure ${String.fromCharCode(65 + index)}` },
		})),
	});
	const questions = (await h.call<InboxReply>("inbox")).items.filter((q) => q.kind === "failure");
	expect(questions).toHaveLength(21);
	for (const [index, q] of questions.entries())
		await h.call("decide", {
			q: q.q,
			onEvidence: q.evidenceHash,
			answer: { is: "defect", ref: `https://github.com/example/shop/issues/${index + 1}` },
		});
	const keys: string[] = [];
	const adapter: TrackerPort = {
		...port,
		getItem: async (key) => {
			keys.push(key);
			return { ref: `github:example/shop#${key}`, url: `https://github.com/example/shop/issues/${key}`, state: "open" };
		},
	};
	await pollDefectHolds(h.app, adapter);
	expect(keys).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 1)));
	h.advance(60_000);
	await pollDefectHolds(h.app, adapter);
	expect(keys[20]).toBe("21");
});

test("a failure can queue a GitHub defect with its recorded case version and build", async () => {
	const result = await failure();
	await h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Renamed case" } }] });
	const input = { do: "create", result, cmd: "tracker-create-01" };
	expect(await h.call<TrackerReceipt>("tracker", input)).toEqual({
		id: input.cmd,
		state: "queued",
		result,
		issue: null,
		error: null,
	});
	const sent: DefectDraft[] = [];
	await deliverTrackerRequests(h.app, {
		...port,
		createDefect: async (draft) => {
			sent.push(draft);
			return item;
		},
	});
	expect(sent).toHaveLength(1);
	expect(sent[0]?.title).toBe("Failure: Checkout total");
	for (const text of [
		"Case: C-1@v1",
		`Result: ${result} (fail)`,
		"code:example/shop@abcdef123",
		"https://ci.example/build/42",
		"Expected 90, got 100",
		"title: Checkout total",
	])
		expect(sent[0]?.body).toContain(text);
	expect(sent[0]?.body).not.toContain("Renamed case");
	expect(await h.call<TrackerReceipt>("tracker-status", { id: input.cmd })).toEqual({
		id: input.cmd,
		result,
		state: "complete",
		issue: item,
		error: null,
	});
	expect(await h.call("tracker", input)).toMatchObject({ state: "queued" });
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);
	expect(await h.raw("tracker", { ...input, do: "link", key: "42" })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	const question = (await h.call<InboxReply>("inbox")).items.find((q) => q.kind === "failure");
	if (!question) throw new Error("expected the failure question");
	expect(question.state).toBe("open");
	expect(
		await h.call("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: { is: "defect", ref: item.url },
		}),
	).toMatchObject([{ status: "decided", effects: { defect: item.url } }]);
});

test("GitHub's port sends the prefilled issue and validates existing issues without creating one", async () => {
	const sent: { url: string; init: RequestInit | undefined }[] = [];
	const adapter = githubPort(
		github,
		transport((url, init) => {
			sent.push({ url, init });
			return Response.json({ number: 42, state: "open" }, { status: init?.method === "POST" ? 201 : 200 });
		}),
	);
	expect(await adapter.createDefect({ title: "A failure", body: "Recorded evidence" })).toEqual(item);
	expect(await adapter.getItem("42")).toEqual(item);
	expect(sent.map((request) => [request.url, request.init?.method])).toEqual([
		["https://api.github.com/repos/example/shop/issues", "POST"],
		["https://api.github.com/repos/example/shop/issues/42", "GET"],
	]);
	expect(sent[0]?.init?.body).toBe('{"title":"A failure","body":"Recorded evidence"}');
	expect(new Headers(sent[0]?.init?.headers).get("Authorization")).toBe(`Bearer ${credential}`);
	expect(sent[0]?.init?.redirect).toBe("error");
	await expect(adapter.getItem("../elsewhere")).rejects.toThrow("positive issue number");
});

test("link requests record a verified reference and leave the failure decision to the caller", async () => {
	const result = await failure();
	await h.call("tracker", { do: "link", key: "42", result, cmd: "tracker-link-001" });
	const keys: string[] = [];
	await deliverTrackerRequests(h.app, {
		...port,
		getItem: async (key) => {
			keys.push(key);
			return { ...item, state: "closed" };
		},
	});
	expect(keys).toEqual(["42"]);
	expect(await h.call("tracker-status", { id: "tracker-link-001" })).toMatchObject({
		state: "complete",
		issue: { ...item, state: "closed" },
	});
	expect((await h.call<InboxReply>("inbox")).counts.failure).toBe(1);
});

test("GitHub failures and invalid replies expose no response text or credential and never retry creation", async () => {
	const result = await failure();
	for (const [index, response] of [
		new Response(credential, { status: 401 }),
		Response.json({ number: 42, state: "open", pull_request: {} }, { status: 201 }),
		Response.json({ number: "42", state: "open" }, { status: 201 }),
		new Response(credential, { status: 201 }),
	].entries()) {
		const id = `tracker-error-${index}`;
		await h.call("tracker", { do: "create", result, cmd: id });
		await deliverTrackerRequests(
			h.app,
			githubPort(
				github,
				transport(() => response),
			),
		);
		const status = await h.call<TrackerReceipt>("tracker-status", { id });
		expect(status.state).toBe("failed");
		expect(status.issue).toBeNull();
		expect(status.error).toMatch(/GitHub/);
		expect(JSON.stringify(status)).not.toContain(credential);
	}
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);
	const contents: string[] = [];
	await h.app.database.read(async (db) => await exportArchive(db, (chunk) => contents.push(chunk)));
	expect(contents.join("")).not.toContain(credential);
	expect(contents.join("")).not.toContain('"t":"tracker_requests"');
});

test("request validation, project permissions and result ownership are checked before queuing", async () => {
	const result = await failure();
	const input = { do: "create", result, cmd: "tracker-check-01" };
	const reader = await h.actor("reader", "agent", ["read"]);
	expect(await h.raw("tracker", input, reader)).toMatchObject({ ok: false, error: { code: "forbidden" } });
	expect(await h.raw("tracker", { ...input, token: credential })).toMatchObject({
		ok: false,
		error: { code: "invalid" },
	});
	expect(await h.raw("tracker", { ...input, cmd: undefined })).toMatchObject({ ok: false, error: { code: "invalid" } });
	expect(await h.raw("tracker", { ...input, do: "link", key: "../42" })).toMatchObject({
		ok: false,
		error: { code: "invalid" },
	});
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.run(
						sql<readonly SqlValue[], Record<string, unknown>>("UPDATE results SET outcome = 'pass' WHERE id = $1"),
						[result],
					),
			),
	);
	expect(await h.raw("tracker", input)).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "A defect needs a failed or errored result." },
	});
	await h.call("admin", { do: "project.create", key: "other" });
	const other = await h.app.database.read(
		async (db) =>
			await db.get(sql<readonly SqlValue[], { id: number }>("SELECT id FROM projects WHERE key = 'other'"), []),
	);
	if (!other) throw new Error("expected the other project");
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.run(
						sql<readonly SqlValue[], Record<string, unknown>>("UPDATE results SET project = $1 WHERE id = $2"),
						[other.id, result],
					),
			),
	);
	expect(await h.raw("tracker", input)).toMatchObject({
		ok: false,
		error: { code: "not_found", message: "result not found" },
	});
	expect(
		await h.app.database.read(
			async (db) =>
				await db.get(
					sql<readonly SqlValue[], Record<string, unknown>>("SELECT count(*) AS n FROM tracker_requests"),
					[],
				),
		),
	).toEqual({ n: 0 });
});

test("tracker requires read even for a producer’s own recorded case result", async () => {
	const ownerResult = await failure();
	const producer = await h.actor("producer", "agent", ["produce"]);
	const foreign = await h.raw(
		"tracker",
		{ do: "create", result: ownerResult, cmd: "tracker-foreign-result" },
		producer,
	);
	expect(foreign).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	const absent = await h.raw(
		"tracker",
		{ do: "create", result: ownerResult + 1_000_000, cmd: "tracker-absent-result" },
		producer,
	);
	expect(absent).toEqual(foreign);
	expect(
		await h.app.database.read(
			async (db) =>
				await db.get(
					sql<readonly SqlValue[], Record<string, unknown>>("SELECT count(*) AS n FROM tracker_requests"),
					[],
				),
		),
	).toEqual({ n: 0 });

	await h.call(
		"report",
		{
			target: { session: "producer-result" },
			results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "Producer failure" } }],
		},
		producer,
	);
	const ownResult = (
		await h.app.database.read(
			async (db) =>
				await db.get(sql<readonly SqlValue[], { id: number }>("SELECT id FROM results WHERE actor = $1"), [
					producer.id,
				]),
		)
	)?.id;
	if (!ownResult) throw new Error("expected the producer's result");
	for (const action of [{ do: "preview" }, { do: "create" }, { do: "link", key: "42" }] as const) {
		expect(
			await h.raw("tracker", { ...action, result: ownResult, cmd: `tracker-own-${action.do}` }, producer),
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
	}
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);

	const readerProducer = await h.actor("reader-producer", "agent", ["read", "produce"]);
	expect(
		(
			await h.call<TrackerReceipt>(
				"tracker",
				{ do: "create", result: ownerResult, cmd: "tracker-readable-result" },
				readerProducer,
			)
		).state,
	).toBe("queued");
});

test("delivery releases the writer while waiting and overlapping jobs send only once", async () => {
	const result = await failure();
	await h.call("tracker", { do: "create", result, cmd: "tracker-wait-001" });
	let complete: (value: typeof item) => void = () => {
		throw new Error("delivery did not start");
	};
	const waiting = new Promise<typeof item>((resolve) => {
		complete = resolve;
	});
	const started = Promise.withResolvers<void>();
	const adapter: TrackerPort = {
		...port,
		createDefect: () => {
			started.resolve();
			return waiting;
		},
	};
	const delivery = deliverTrackerRequests(h.app, adapter);
	await started.promise;
	const peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	const overlapping = deliverTrackerRequests(peer, adapter);
	await h.call("propose", { edits: [{ op: "create", outline: "Another case" }] });
	expect(await h.call("tracker-status", { id: "tracker-wait-001" })).toMatchObject({ state: "sending" });
	complete(item);
	expect((await delivery) + (await overlapping)).toBe(1);
	await peer.close();
	expect(await deliverTrackerRequests(h.app, adapter)).toBe(0);
});

test("an archive drops pending delivery and an old response cannot attach to a replacement request", async () => {
	const result = await failure();
	const archive: string[] = [];
	await h.app.database.read(async (db) => await exportArchive(db, (chunk) => archive.push(chunk)));
	const restored = await Database.open({ url: (await testDatabase()).url });
	try {
		await restored.write(
			async (db) => await db.transaction(async () => await importArchive(db, archive.join("").trimEnd().split("\n"))),
		);
		expect(
			await restored.read(
				async (db) => await db.get(sql<readonly [], { n: number }>("SELECT count(*) AS n FROM tracker_requests")),
			),
		).toEqual({ n: 0 });
	} finally {
		await restored.close();
	}
	const input = { do: "create", result, cmd: "tracker-restore1" };
	await h.call("tracker", input);
	let complete: (value: TrackerItem) => void = () => {
		throw new Error("delivery did not start");
	};
	const waiting = new Promise<TrackerItem>((resolve) => {
		complete = resolve;
	});
	let calls = 0;
	const started = Promise.withResolvers<void>();
	const delivery = deliverTrackerRequests(h.app, {
		...port,
		createDefect: () => {
			started.resolve();
			return ++calls === 1 ? waiting : Promise.resolve(item);
		},
	});
	await started.promise;
	await h.app.database.write(
		async (db) =>
			await db.transaction(async () => {
				await db.run(sql<readonly SqlValue[], Record<string, unknown>>("DELETE FROM tracker_requests"), []);
				await db.run(sql<readonly SqlValue[], Record<string, unknown>>("DELETE FROM commands WHERE id = $1"), [
					input.cmd,
				]);
			}),
	);
	expect(await h.raw("tracker-status", { id: input.cmd })).toMatchObject({ ok: false, error: { code: "not_found" } });
	await h.call("tracker", input);
	complete({ ...item, ref: "github:example/shop#41", url: "https://github.com/example/shop/issues/41" });
	await delivery;
	expect(calls).toBe(2);
	// The old response was ignored. The new request gets its own delivery on the same worker's next turn.
	expect(await h.call("tracker-status", { id: input.cmd })).toMatchObject({ state: "complete", issue: item });
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);
});

test("a sending request is left uncertain after restart and a changed configuration sends nothing", async () => {
	const result = await failure();
	await h.call("tracker", { do: "create", result, cmd: "tracker-crash-01" });
	await h.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.run(
						sql<readonly SqlValue[], Record<string, unknown>>("UPDATE tracker_requests SET state = 'sending'"),
						[],
					),
			),
	);
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);
	expect(await h.call("tracker-status", { id: "tracker-crash-01" })).toMatchObject({ state: "sending", issue: null });
	await h.call("tracker", { do: "create", result, cmd: "tracker-config1" });
	h.app.config.github = { ...github, project: "other" };
	await deliverTrackerRequests(h.app, port);
	expect(await h.call("tracker-status", { id: "tracker-config1" })).toMatchObject({
		state: "failed",
		error: "The configured tracker project or repository changed; the request was not sent.",
	});
});

test("tracker configuration is opt-in and malformed configuration never quotes credentials", () => {
	expect(defaultConfig({}).github).toBeUndefined();
	expect(
		defaultConfig({
			MAINWORTHY_GITHUB_PROJECT: "scratch",
			MAINWORTHY_GITHUB_REPOSITORY: "example/shop",
			MAINWORTHY_GITHUB_TOKEN: credential,
		}).github,
	).toEqual(github);
	for (const config of [
		{ MAINWORTHY_GITHUB_TOKEN: credential },
		{
			MAINWORTHY_GITHUB_PROJECT: "scratch",
			MAINWORTHY_GITHUB_REPOSITORY: "https://other.example/repo",
			MAINWORTHY_GITHUB_TOKEN: credential,
		},
	]) {
		expect(() => defaultConfig(config)).toThrow(/MAINWORTHY_GITHUB/);
		try {
			defaultConfig(config);
		} catch (error) {
			expect(String(error)).not.toContain(credential);
		}
	}
});

test("the HTTP operations preserve queued and uncertain requests across restart and deliver through the minute job", async () => {
	directory = mkdtempSync(join(tmpdir(), "mainworthy-tracker-"));
	const config = {
		...defaultConfig({ MAINWORTHY_DATABASE_URL: (await testDatabase()).url }),
		owner: "robin",
		dataDir: directory,
		port: 0,
		github,
	};
	instance = await start(config, () => ({ ui: null }), { trackerPort: port });
	const post = async (operation: string, input: unknown) => {
		const response = await fetch(`${instance?.url}/api/p/scratch/${operation}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return { status: response.status, body: await response.json() };
	};
	expect(
		await post("report", {
			target: { session: "local-check" },
			results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Expected 90, got 100" } }],
		}),
	).toMatchObject({ status: 200, body: { ok: true } });
	const result = (
		await instance.app.database.read(
			async (db) => await db.get(sql<readonly SqlValue[], { id: number }>("SELECT id FROM results"), []),
		)
	)?.id;
	expect(await post("tracker", { do: "create", result, cmd: "tracker-http-01" })).toMatchObject({
		status: 200,
		body: { ok: true, result: { state: "queued" } },
	});
	expect(await post("tracker", { do: "create", result, cmd: "tracker-http-02" })).toMatchObject({
		status: 200,
		body: { ok: true, result: { state: "queued" } },
	});
	await instance.app.database.write(
		async (db) =>
			await db.transaction(
				async () =>
					await db.run(
						sql<readonly SqlValue[], Record<string, unknown>>(
							"UPDATE tracker_requests SET state = 'sending' WHERE id = 'tracker-http-02'",
						),
						[],
					),
			),
	);
	await instance.stop();
	instance = await start(config, () => ({ ui: null }), { trackerPort: port });
	expect(await post("tracker-status", { id: "tracker-http-01" })).toMatchObject({
		status: 200,
		body: { ok: true, result: { state: "queued" } },
	});
	await instance.minute();
	expect(await post("tracker-status", { id: "tracker-http-01" })).toMatchObject({
		status: 200,
		body: { ok: true, result: { state: "complete", issue: item } },
	});
	expect(await post("tracker-status", { id: "tracker-http-02" })).toMatchObject({
		status: 200,
		body: { ok: true, result: { state: "sending", issue: null } },
	});
});

test("stopping persists the in-flight tracker reply and leaves queued requests for the next start", async () => {
	directory = mkdtempSync(join(tmpdir(), "mainworthy-tracker-stop-"));
	const config = {
		...defaultConfig({ MAINWORTHY_DATABASE_URL: (await testDatabase()).url }),
		owner: "robin",
		dataDir: directory,
		port: 0,
		github,
	};
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<TrackerItem>();
	let calls = 0;
	instance = await start(config, () => ({ ui: null }), {
		trackerPort: {
			...port,
			createDefect: () => {
				calls++;
				entered.resolve();
				return reply.promise;
			},
		},
	});
	const post = async (operation: string, input: unknown) => {
		const response = await fetch(`${instance?.url}/api/p/scratch/${operation}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return response.json();
	};
	expect(
		await post("report", {
			target: { session: "shutdown-check" },
			results: [{ test: { key: "checkout" }, outcome: "fail", failure: { message: "Expected 90, got 100" } }],
		}),
	).toMatchObject({ ok: true });
	const result = (
		await instance.app.database.read(
			async (db) => await db.get(sql<readonly SqlValue[], { id: number }>("SELECT id FROM results"), []),
		)
	)?.id;
	const ids = Array.from({ length: 6 }, (_, index) => `tracker-stop-0${index + 1}`);
	for (const cmd of ids)
		expect(await post("tracker", { do: "create", result, cmd })).toMatchObject({
			ok: true,
			result: { state: "queued" },
		});
	const minute = instance.minute();
	await entered.promise;
	const stopping = instance.stop();
	try {
		expect(instance.stop()).toBe(stopping);
		expect(await Promise.race([stopping.then(() => "stopped"), Bun.sleep(20).then(() => "waiting")])).toBe("waiting");
	} finally {
		reply.resolve(item);
		await minute;
		await stopping;
	}
	expect(calls).toBe(1);
	instance = await start(config, () => ({ ui: null }), { trackerPort: port });
	expect(await post("tracker-status", { id: "tracker-stop-01" })).toMatchObject({
		ok: true,
		result: { state: "complete", issue: item },
	});
	for (const id of ids.slice(1))
		expect(await post("tracker-status", { id })).toMatchObject({ ok: true, result: { state: "queued", issue: null } });
	await instance.minute();
	for (const id of ids)
		expect(await post("tracker-status", { id })).toMatchObject({
			ok: true,
			result: { state: "complete", issue: item },
		});
});

test("a tracker delivery rejected during HTTP drain does not create an unhandled rejection", async () => {
	directory = mkdtempSync(join(tmpdir(), "mainworthy-tracker-reject-"));
	const config = {
		...defaultConfig({ MAINWORTHY_DATABASE_URL: (await testDatabase()).url }),
		owner: "robin",
		dataDir: directory,
		port: 0,
		github,
	};
	const entered = Promise.withResolvers<void>();
	const trackerReply = Promise.withResolvers<TrackerItem>();
	instance = await start(config, () => ({ ui: null }), {
		trackerPort: {
			...port,
			createDefect: () => {
				entered.resolve();
				return trackerReply.promise;
			},
		},
	});
	const current = instance;
	const post = (operation: string, input: unknown) =>
		fetch(`${current.url}/api/p/scratch/${operation}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
	await post("report", {
		target: { session: "reject-during-stop" },
		results: [{ test: { key: "checkout" }, outcome: "fail" }],
	});
	const result = (
		await current.app.database.read(
			async (db) => await db.get(sql<readonly SqlValue[], { id: number }>("SELECT id FROM results"), []),
		)
	)?.id;
	expect(await (await post("tracker", { do: "create", result, cmd: "tracker-stop-reject" })).json()).toMatchObject({
		ok: true,
		result: { state: "queued" },
	});
	const logged = spyOn(console, "error").mockImplementation(() => undefined);
	const minute = current.minute();
	await entered.promise;
	const reading = Promise.withResolvers<void>();
	const readReply = Promise.withResolvers<void>();
	const read = current.app.database.read.bind(current.app.database);
	const reads = spyOn(current.app.database, "read").mockImplementationOnce(async (fn, options) => {
		reading.resolve();
		await readReply.promise;
		return await read(fn, options);
	});
	const http = post("find", { in: "cases" });
	await reading.promise;
	const write = rejectTrackerCompletion(current.app, "tracker reply write failed");
	const stopping = current.stop();
	const outcome = stopping.then(
		() => "stopped",
		(error: unknown) => String(error),
	);
	try {
		trackerReply.resolve(item);
		await minute;
		expect(logged.mock.calls).toContainEqual([
			"[mainworthy] job failed",
			expect.objectContaining({ kind: "tracker-request" }),
		]);
		expect(await Promise.race([outcome, Bun.sleep(20).then(() => "draining")])).toBe("draining");
		readReply.resolve();
		expect(await (await http).json()).toMatchObject({ ok: true, result: { items: [] } });
		expect(await outcome).toBe("stopped");
	} finally {
		write.mockRestore();
		reads.mockRestore();
		logged.mockRestore();
		readReply.resolve();
		await http;
		await outcome;
		await current.app.close();
		instance = undefined;
	}
});

test("a tracker delivery rejected after HTTP drain still completes shutdown and logs once", async () => {
	directory = mkdtempSync(join(tmpdir(), "mainworthy-tracker-after-drain-"));
	const config = {
		...defaultConfig({ MAINWORTHY_DATABASE_URL: (await testDatabase()).url }),
		owner: "robin",
		dataDir: directory,
		port: 0,
		github,
	};
	const entered = Promise.withResolvers<void>();
	const trackerReply = Promise.withResolvers<TrackerItem>();
	instance = await start(config, () => ({ ui: null }), {
		trackerPort: {
			...port,
			createDefect: () => {
				entered.resolve();
				return trackerReply.promise;
			},
		},
	});
	const current = instance;
	const post = async (operation: string, input: unknown) => {
		const response = await fetch(`${current.url}/api/p/scratch/${operation}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		return response.json();
	};
	expect(
		await post("report", {
			target: { session: "reject-after-drain" },
			results: [{ test: { key: "checkout" }, outcome: "fail" }],
		}),
	).toMatchObject({ ok: true });
	const result = (
		await current.app.database.read(
			async (db) => await db.get(sql<readonly SqlValue[], { id: number }>("SELECT id FROM results"), []),
		)
	)?.id;
	expect(await post("tracker", { do: "create", result, cmd: "tracker-after-drain" })).toMatchObject({
		ok: true,
		result: { state: "queued" },
	});
	const logged = spyOn(console, "error").mockImplementation(() => undefined);
	const databaseClosed = spyOn(current.app.database, "close");
	const minute = current.minute();
	await entered.promise;
	const write = rejectTrackerCompletion(current.app, "tracker reply write failed after drain");
	const outcome = current.stop().then(
		() => "stopped",
		(error: unknown) => String(error),
	);
	try {
		expect(await Promise.race([outcome, Bun.sleep(50).then(() => "waiting")])).toBe("waiting");
		trackerReply.resolve(item);
		await minute;
		expect(await outcome).toBe("stopped");
		expect(databaseClosed.mock.calls).toEqual([[]]);
		await expect(
			current.app.database.read(async (db) => await db.get(sql<readonly [], { n: number }>("SELECT 1 AS n"))),
		).rejects.toThrow(/closed/i);
		expect(logged.mock.calls).toEqual([
			["[mainworthy] job failed", expect.objectContaining({ kind: "tracker-request" })],
		]);
	} finally {
		trackerReply.resolve(item);
		await minute;
		await outcome;
		write.mockRestore();
		databaseClosed.mockRestore();
		logged.mockRestore();
		await current.app.close();
		instance = undefined;
	}
});

test("tracker preview is exactly the delivered draft and confirmed retries send once", async () => {
	const result = await failure();
	const preview = await h.call<{ destination: string; title: string; body: string; confirm: string }>("tracker", {
		do: "preview",
		result,
		cmd: "confirmed-test-001",
	});
	expect(preview.destination).toBe("example/shop");
	expect(preview.body).toContain("Project: scratch");
	expect(preview.body).toContain("Case: C-1@v1");
	expect(preview.body).toContain("abcdef123");
	const input = { do: "create", result, cmd: "confirmed-test-001", confirm: preview.confirm };
	await h.call("tracker", input);
	const drafts: DefectDraft[] = [];
	const receiving = {
		...port,
		createDefect: async (draft: DefectDraft) => {
			drafts.push(draft);
			return item;
		},
	};
	await deliverTrackerRequests(h.app, receiving);
	await h.call("tracker", input);
	await deliverTrackerRequests(h.app, receiving);
	expect(drafts).toEqual([{ title: preview.title, body: preview.body }]);
});

test("tracker refuses a stale destination confirmation without sending; CLI needs no digest", async () => {
	const result = await failure();
	const preview = await h.call<{ confirm: string }>("tracker", { do: "preview", result, cmd: "preview-test-002" });
	h.app.config.github = { ...github, repository: "example/public" };
	expect(
		await h.raw("tracker", { do: "create", result, cmd: "confirmed-test-002", confirm: preview.confirm }),
	).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("review") } });
	delete h.app.config.github;
	expect(
		await h.raw("tracker", { do: "create", result, cmd: "removed-config-001", confirm: preview.confirm }),
	).toMatchObject({ ok: false, error: { code: "conflict" } });
	h.app.config.github = { ...github, repository: "example/public" };
	let sent = 0;
	const receiving = {
		...port,
		createDefect: async () => {
			sent++;
			return item;
		},
	};
	expect(await deliverTrackerRequests(h.app, receiving)).toBe(0);
	expect(sent).toBe(0);
	await h.call("tracker", { do: "create", result, cmd: "cli-no-digest-001" });
	await deliverTrackerRequests(h.app, receiving);
	expect(sent).toBe(1);
});

for (const [table, reference] of [
	["tests", "test"],
	["targets", "target"],
	["batches", "batch"],
	["cases", "basis_case"],
] as const) {
	test(`tracker refuses cross-project ${reference} evidence`, async () => {
		const result = await failure();
		await h.call("admin", { do: "project.create", key: "other", preset: "loose" });
		await h.app.database.write(async (db) =>
			db.transaction(async () => {
				await db.run(
					sql<readonly SqlValue[]>(
						`UPDATE ${table} SET project = (SELECT id FROM projects WHERE key = 'other') WHERE id = (SELECT ${reference} FROM results WHERE id = $1)`,
					),
					[result],
				);
			}),
		);
		for (const action of [{ do: "preview" }, { do: "create" }, { do: "link", key: "42" }] as const) {
			expect(await h.raw("tracker", { ...action, result, cmd: `foreign-${reference}-${action.do}` })).toMatchObject({
				ok: false,
				error: { code: "not_found" },
			});
		}
		expect(await deliverTrackerRequests(h.app, port)).toBe(0);
	});
}

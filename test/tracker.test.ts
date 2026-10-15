import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxReply } from "../src/core/ops.ts";
import type { TrackerItem, TrackerReceipt } from "../src/core/tracker.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { Db } from "../src/server/kernel/db.ts";
import { migrate } from "../src/server/kernel/migrate.ts";
import { type Instance, start } from "../src/server/start.ts";
import { githubPort } from "../src/server/trackers/github.ts";
import type { DefectDraft, TrackerPort } from "../src/server/trackers/port.ts";
import { deliverTrackerRequests } from "../src/server/trackers/requests.ts";
import { exportArchive, importArchive } from "../src/server/transfer/transfer.ts";
import { type Harness, harness } from "./helpers.ts";

const credential = "test-tracker-credential";
const github = { project: "scratch", repository: "example/shop", token: credential };
const item = {
	ref: "github:example/shop#42",
	url: "https://github.com/example/shop/issues/42",
	state: "open",
} as const;
const port: TrackerPort = { createDefect: async () => item, getItem: async () => item };
let h: Harness;
let instance: Instance | undefined;
let directory: string | undefined;
afterEach(async () => {
	await instance?.stop();
	instance = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	h?.close();
});

function failure() {
	h = harness();
	h.app.config.github = github;
	h.call("propose", { edits: [{ op: "create", outline: "Checkout total" }] });
	h.call("report", {
		target: { commit: "abcdef123", repo: "example/shop" },
		buildUrl: "https://ci.example/build/42",
		results: [{ test: { case: "C-1" }, outcome: "fail", failure: { message: "Expected 90, got 100" } }],
	});
	const result = h.app.db.raw.query<{ id: number }, []>("SELECT id FROM results").get()?.id;
	if (!result) throw new Error("expected the reported result");
	return result;
}

const transport = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
	Object.assign(async (...args: Parameters<typeof fetch>) => respond(String(args[0]), args[1]), {
		preconnect: fetch.preconnect,
	});

test("a failure can queue a GitHub defect with its recorded case version and build", async () => {
	const result = failure();
	h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Renamed case" } }] });
	const input = { do: "create", result, cmd: "tracker-create-01" };
	expect(h.call<TrackerReceipt>("tracker", input)).toEqual({
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
	expect(h.call<TrackerReceipt>("tracker-status", { id: input.cmd })).toEqual({
		id: input.cmd,
		result,
		state: "complete",
		issue: item,
		error: null,
	});
	expect(h.call("tracker", input)).toMatchObject({ state: "queued" });
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);
	expect(h.raw("tracker", { ...input, do: "link", key: "42" })).toMatchObject({
		ok: false,
		error: { code: "conflict" },
	});
	const question = h.call<InboxReply>("inbox").items.find((q) => q.kind === "failure");
	if (!question) throw new Error("expected the failure question");
	expect(question.state).toBe("open");
	expect(
		h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "defect", ref: item.url } }),
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
	const result = failure();
	h.call("tracker", { do: "link", key: "42", result, cmd: "tracker-link-001" });
	const keys: string[] = [];
	await deliverTrackerRequests(h.app, {
		...port,
		getItem: async (key) => {
			keys.push(key);
			return { ...item, state: "closed" };
		},
	});
	expect(keys).toEqual(["42"]);
	expect(h.call("tracker-status", { id: "tracker-link-001" })).toMatchObject({
		state: "complete",
		issue: { ...item, state: "closed" },
	});
	expect(h.call<InboxReply>("inbox").counts.failure).toBe(1);
});

test("GitHub failures and invalid replies expose no response text or credential and never retry creation", async () => {
	const result = failure();
	for (const [index, response] of [
		new Response(credential, { status: 401 }),
		Response.json({ number: 42, state: "open", pull_request: {} }, { status: 201 }),
		Response.json({ number: "42", state: "open" }, { status: 201 }),
		new Response(credential, { status: 201 }),
	].entries()) {
		const id = `tracker-error-${index}`;
		h.call("tracker", { do: "create", result, cmd: id });
		await deliverTrackerRequests(
			h.app,
			githubPort(
				github,
				transport(() => response),
			),
		);
		const status = h.call<TrackerReceipt>("tracker-status", { id });
		expect(status.state).toBe("failed");
		expect(status.issue).toBeNull();
		expect(status.error).toMatch(/GitHub/);
		expect(JSON.stringify(status)).not.toContain(credential);
	}
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);
	const contents: string[] = [];
	exportArchive(h.app.db, (chunk) => contents.push(chunk));
	expect(contents.join("")).not.toContain(credential);
	expect(contents.join("")).not.toContain('"t":"tracker_requests"');
});

test("request validation, project permissions and result ownership are checked before queuing", () => {
	const result = failure();
	const input = { do: "create", result, cmd: "tracker-check-01" };
	const reader = h.actor("reader", "agent", ["read"]);
	expect(h.raw("tracker", input, reader)).toMatchObject({ ok: false, error: { code: "forbidden" } });
	expect(h.raw("tracker", { ...input, token: credential })).toMatchObject({ ok: false, error: { code: "invalid" } });
	expect(h.raw("tracker", { ...input, cmd: undefined })).toMatchObject({ ok: false, error: { code: "invalid" } });
	expect(h.raw("tracker", { ...input, do: "link", key: "../42" })).toMatchObject({
		ok: false,
		error: { code: "invalid" },
	});
	h.app.db.raw.query("UPDATE results SET outcome = 'pass' WHERE id = ?").run(result);
	expect(h.raw("tracker", input)).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "A defect needs a failed or errored result." },
	});
	h.call("admin", { do: "project.create", key: "other" });
	const other = h.app.db.raw.query<{ id: number }, []>("SELECT id FROM projects WHERE key = 'other'").get();
	if (!other) throw new Error("expected the other project");
	h.app.db.raw.query("UPDATE results SET project = ? WHERE id = ?").run(other.id, result);
	expect(h.raw("tracker", input)).toMatchObject({
		ok: false,
		error: { code: "not_found", message: "result not found" },
	});
	expect(h.app.db.raw.query("SELECT count(*) AS n FROM tracker_requests").get()).toEqual({ n: 0 });
});

test("delivery releases the writer while waiting and overlapping jobs send only once", async () => {
	const result = failure();
	h.call("tracker", { do: "create", result, cmd: "tracker-wait-001" });
	let complete: (value: typeof item) => void = () => {
		throw new Error("delivery did not start");
	};
	const waiting = new Promise<typeof item>((resolve) => {
		complete = resolve;
	});
	const adapter: TrackerPort = { ...port, createDefect: () => waiting };
	const delivery = deliverTrackerRequests(h.app, adapter);
	expect(deliverTrackerRequests(h.app, adapter)).toBe(delivery);
	await h.app.gate.run(() => h.call("propose", { edits: [{ op: "create", outline: "Another case" }] }));
	expect(h.call("tracker-status", { id: "tracker-wait-001" })).toMatchObject({ state: "sending" });
	complete(item);
	expect(await delivery).toBe(1);
	expect(await deliverTrackerRequests(h.app, adapter)).toBe(0);
});

test("an archive drops pending delivery and an old response cannot attach to a replacement request", async () => {
	const result = failure();
	const archive: string[] = [];
	exportArchive(h.app.db, (chunk) => archive.push(chunk));
	const restored = new Db(":memory:");
	try {
		migrate(restored, ":memory:");
		importArchive(restored, archive.join("").trimEnd().split("\n"));
		expect(restored.raw.query("SELECT count(*) AS n FROM tracker_requests").get()).toEqual({ n: 0 });
	} finally {
		restored.close();
	}
	const input = { do: "create", result, cmd: "tracker-restore1" };
	h.call("tracker", input);
	let complete: (value: TrackerItem) => void = () => {
		throw new Error("delivery did not start");
	};
	const waiting = new Promise<TrackerItem>((resolve) => {
		complete = resolve;
	});
	let calls = 0;
	const delivery = deliverTrackerRequests(h.app, {
		...port,
		createDefect: () => (++calls === 1 ? waiting : Promise.resolve(item)),
	});
	await h.app.gate.run(() => {
		h.app.db.raw.query("DELETE FROM tracker_requests").run();
		h.app.db.raw.query("DELETE FROM commands WHERE id = ?").run(input.cmd);
		expect(h.raw("tracker-status", { id: input.cmd })).toMatchObject({ ok: false, error: { code: "not_found" } });
		h.call("tracker", input);
	});
	complete({ ...item, ref: "github:example/shop#41", url: "https://github.com/example/shop/issues/41" });
	await delivery;
	expect(calls).toBe(2);
	// The old response was ignored. The new request gets its own delivery on the same worker's next turn.
	expect(h.call("tracker-status", { id: input.cmd })).toMatchObject({ state: "complete", issue: item });
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);
});

test("a sending request is left uncertain after restart and a changed configuration sends nothing", async () => {
	const result = failure();
	h.call("tracker", { do: "create", result, cmd: "tracker-crash-01" });
	h.app.db.raw.query("UPDATE tracker_requests SET state = 'sending'").run();
	expect(await deliverTrackerRequests(h.app, port)).toBe(0);
	expect(h.call("tracker-status", { id: "tracker-crash-01" })).toMatchObject({ state: "sending", issue: null });
	h.call("tracker", { do: "create", result, cmd: "tracker-config1" });
	h.app.config.github = { ...github, project: "other" };
	await deliverTrackerRequests(h.app, port);
	expect(h.call("tracker-status", { id: "tracker-config1" })).toMatchObject({
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
	const config = { ...defaultConfig({}), owner: "robin", dataDir: directory, port: 0, github };
	instance = start(config, () => ({ ui: null }), { readers: 0, trackerPort: port });
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
	const result = instance.app.db.raw.query<{ id: number }, []>("SELECT id FROM results").get()?.id;
	expect(await post("tracker", { do: "create", result, cmd: "tracker-http-01" })).toMatchObject({
		status: 200,
		body: { ok: true, result: { state: "queued" } },
	});
	expect(await post("tracker", { do: "create", result, cmd: "tracker-http-02" })).toMatchObject({
		status: 200,
		body: { ok: true, result: { state: "queued" } },
	});
	instance.app.db.raw.query("UPDATE tracker_requests SET state = 'sending' WHERE id = 'tracker-http-02'").run();
	await instance.stop();
	instance = start(config, () => ({ ui: null }), { readers: 0, trackerPort: port });
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
	const config = { ...defaultConfig({}), owner: "robin", dataDir: directory, port: 0, github };
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<TrackerItem>();
	let calls = 0;
	instance = start(config, () => ({ ui: null }), {
		readers: 0,
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
	const result = instance.app.db.raw.query<{ id: number }, []>("SELECT id FROM results").get()?.id;
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
	instance = start(config, () => ({ ui: null }), { readers: 0, trackerPort: port });
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
	const config = { ...defaultConfig({}), owner: "robin", dataDir: directory, port: 0, github };
	const entered = Promise.withResolvers<void>();
	const trackerReply = Promise.withResolvers<TrackerItem>();
	instance = start(config, () => ({ ui: null }), {
		readers: 1,
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
	const result = current.app.db.raw.query<{ id: number }, []>("SELECT id FROM results").get()?.id;
	expect(await (await post("tracker", { do: "create", result, cmd: "tracker-stop-reject" })).json()).toMatchObject({
		ok: true,
		result: { state: "queued" },
	});
	const logged = spyOn(console, "error").mockImplementation(() => undefined);
	const minute = current.minute();
	await entered.promise;
	const pool = current.app.readers;
	if (!pool) throw new Error("No reader pool");
	const reading = Promise.withResolvers<void>();
	const readReply = Promise.withResolvers<void>();
	const run = pool.run.bind(pool);
	const reads = spyOn(pool, "run").mockImplementation(async (call, fallback) => {
		reading.resolve();
		await readReply.promise;
		return run(call, fallback);
	});
	const http = post("find", { in: "cases" });
	await reading.promise;
	const write = spyOn(current.app.db, "run").mockImplementationOnce(() => {
		throw new Error("tracker reply write failed");
	});
	const stopping = current.stop();
	const outcome = stopping.then(
		() => "stopped",
		(error: unknown) => String(error),
	);
	try {
		trackerReply.resolve(item);
		await minute;
		expect(logged.mock.calls).toContainEqual([
			"[mainworthy] sending tracker requests failed:",
			expect.objectContaining({ message: "tracker reply write failed" }),
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
		await pool.stop();
		current.app.close();
		instance = undefined;
	}
});

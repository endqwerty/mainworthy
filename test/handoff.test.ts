import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, start } from "../src/app/start.ts";
import type { HandoffReceipt } from "../src/core/handoff.ts";
import type { InboxReply } from "../src/core/ops.ts";
import { deliverHandoffs, type HandoffPayload, recoverHandoffs } from "../src/server/handoffs/handoffs.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { ciReport, type Harness, harness } from "./helpers.ts";

const secret = "test-handoff-signing-secret";
type Received = { body: string; signature: string | null; delivery: string | null };

let h: Harness | undefined;
let instance: Instance | undefined;
let directory: string | undefined;
let endpoint: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
	await instance?.stop();
	instance = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	h?.close();
	h = undefined;
	await endpoint?.stop(true);
	endpoint = undefined;
});

/** An agent's endpoint on this machine that keeps what it was sent and answers with `status`. */
function agent(status = 200): { url: string; received: Received[] } {
	const received: Received[] = [];
	endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			received.push({
				body: await request.text(),
				signature: request.headers.get("x-mainworthy-signature"),
				delivery: request.headers.get("x-mainworthy-delivery"),
			});
			return new Response(null, { status });
		},
	});
	return { url: `http://127.0.0.1:${endpoint.port}/hooks/fix`, received };
}

/** A project whose pipeline reported one failing test, with a build link and further output. */
function failing(url: string): { h: Harness; q: string } {
	const harnessed = harness();
	h = harnessed;
	harnessed.app.config.handoff = { project: "scratch", url, secret };
	harnessed.app.config.publicUrl = "https://mainworthy.example/";
	harnessed.call("report", {
		...ciReport({ commit: "abcdef1234567890", branch: "fix-total", n: 2 }),
		buildUrl: "https://ci.example/build/42",
		results: [
			{
				test: { key: "tests/checkout.spec.ts::total", name: "checkout total", file: "tests/checkout.spec.ts" },
				outcome: "fail",
				failure: { message: "expected 90, got 100", detail: "at total (src/checkout.ts:12:3)" },
			},
		],
	});
	const question = harnessed.call<InboxReply>("inbox", { kind: "failure" }).items[0];
	if (!question) throw new Error("expected a failure question");
	return { h: harnessed, q: question.q };
}

test("a hand-off posts the failure, signed with the secret, and its status says it was sent", async () => {
	const { url, received } = agent();
	const { h, q } = failing(url);
	expect(h.call<HandoffReceipt>("handoff", { question: q, cmd: "handoff-cmd-01" })).toMatchObject({
		id: "handoff-cmd-01",
		question: q,
		state: "queued",
		error: null,
	});
	await deliverHandoffs(h.app);
	expect(received).toHaveLength(1);
	const [sent] = received;
	if (!sent) throw new Error("expected one post");
	expect(sent.signature).toBe(`sha256=${createHmac("sha256", secret).update(sent.body).digest("hex")}`);
	expect(sent.delivery).toBe("handoff-cmd-01");
	const payload = JSON.parse(sent.body) as HandoffPayload;
	expect(payload).toMatchObject({
		id: "handoff-cmd-01",
		project: "scratch",
		question: q,
		url: `https://mainworthy.example/p/scratch/queue/${q.slice(2)}`,
		message: "expected 90, got 100",
		tests: [{ name: "checkout total" }],
		target: "abcdef123456",
		branch: "fix-total",
		build: "https://ci.example/build/42",
	});
	expect(payload.brief).toContain(`Mainworthy question ${q} in project scratch`);
	expect(payload.brief).toContain("checkout total");
	expect(payload.brief).toContain("Build: https://ci.example/build/42");
	expect(payload.brief).toContain("at total (src/checkout.ts:12:3)");
	expect(payload.brief).toContain("fix the cause");
	expect(h.call<HandoffReceipt>("handoff-status", { question: q })).toMatchObject({ state: "sent", error: null });
	// The same command again writes nothing and sends nothing.
	h.call("handoff", { question: q, cmd: "handoff-cmd-01" });
	await deliverHandoffs(h.app);
	expect(received).toHaveLength(1);
});

test("an endpoint that refuses, or cannot be reached, leaves a failed hand-off that says why", async () => {
	const { url } = agent(500);
	const { h, q } = failing(url);
	h.call("handoff", { question: q, cmd: "handoff-cmd-02" });
	await deliverHandoffs(h.app);
	expect(h.call<HandoffReceipt>("handoff-status", { question: q })).toMatchObject({
		state: "failed",
		error:
			"The agent's endpoint answered HTTP 500. It may have started anyway: look for the agent's work before sending again.",
	});
	await endpoint?.stop(true);
	h.call("handoff", { question: q, cmd: "handoff-cmd-03" });
	await deliverHandoffs(h.app);
	expect(h.call<HandoffReceipt>("handoff-status", { question: q })).toMatchObject({
		id: "handoff-cmd-03",
		state: "failed",
		error: "The agent's endpoint could not be reached; check that it is running before sending again.",
	});
});

test("a hand-off the server was sending when it stopped is failed at start, not sent again", async () => {
	const { url, received } = agent();
	const { h, q } = failing(url);
	h.call("handoff", { question: q, cmd: "handoff-cmd-04" });
	h.app.db.raw.query("UPDATE handoffs SET state = 'sending'").run();
	recoverHandoffs(h.app);
	await deliverHandoffs(h.app);
	expect(received).toHaveLength(0);
	expect(h.call<HandoffReceipt>("handoff-status", { question: q })).toMatchObject({
		state: "failed",
		error:
			"The server stopped while sending this. It may have arrived: look for the agent's thread before sending again.",
	});
});

test("only a failure question, on a configured project, by someone who may answer, is handed off", () => {
	const { url } = agent();
	const { h, q } = failing(url);
	expect(h.call("handoff-status", { question: q })).toBeNull();
	const reader = h.actor("pat", "human", ["read"]);
	expect(h.raw("handoff", { question: q, cmd: "handoff-cmd-05" }, reader)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	const bot = h.actor("bot", "agent", ["read", "produce"]);
	expect(h.raw("handoff", { question: q, cmd: "handoff-cmd-06" }, bot)).toMatchObject({
		ok: false,
		error: { code: "forbidden" },
	});
	h.call("propose", { edits: [{ op: "create", outline: "Checkout total" }] });
	h.call("report", {
		target: { session: "local-check" },
		results: [{ test: { key: "checkout" }, outcome: "pass" }],
	});
	const other = h.call<InboxReply>("inbox").items.find((item) => item.kind !== "failure");
	if (other)
		expect(h.raw("handoff", { question: other.q, cmd: "handoff-cmd-07" })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: "Only a failure question can be handed to an agent." },
		});
	delete h.app.config.handoff;
	expect(h.raw("handoff", { question: q, cmd: "handoff-cmd-08" })).toMatchObject({
		ok: false,
		error: { code: "invalid", message: "Handing a failure to an agent is not configured for this project." },
	});
	expect(h.app.db.raw.query("SELECT count(*) AS n FROM handoffs").get()).toEqual({ n: 0 });
});

test("the configuration takes all three settings or none, and never repeats the secret", () => {
	const all = {
		MAINWORTHY_HANDOFF_PROJECT: "mainworthy",
		MAINWORTHY_HANDOFF_URL: "https://agent.example/hooks/abc",
		MAINWORTHY_HANDOFF_SECRET: secret,
	};
	expect(defaultConfig(all).handoff).toEqual({
		project: "mainworthy",
		url: "https://agent.example/hooks/abc",
		secret,
	});
	expect(defaultConfig({}).handoff).toBeUndefined();
	for (const config of [
		{ ...all, MAINWORTHY_HANDOFF_SECRET: "" },
		{ ...all, MAINWORTHY_HANDOFF_URL: "http://agent.example/hooks/abc" },
		{ ...all, MAINWORTHY_HANDOFF_URL: "not an address" },
		{ ...all, MAINWORTHY_HANDOFF_SECRET: "short" },
		{ ...all, MAINWORTHY_HANDOFF_PROJECT: "two words" },
	]) {
		expect(() => defaultConfig(config)).toThrow(/MAINWORTHY_HANDOFF/);
		try {
			defaultConfig(config);
		} catch (error) {
			expect(String(error)).not.toContain(secret);
		}
	}
	expect(defaultConfig({ ...all, MAINWORTHY_HANDOFF_URL: "http://127.0.0.1:9/hook" }).handoff?.url).toBe(
		"http://127.0.0.1:9/hook",
	);
});

test("the session tells a page which projects hand failures to an agent", async () => {
	directory = mkdtempSync(join(tmpdir(), "mainworthy-handoff-"));
	const handoff = { project: "scratch", url: "https://agent.example/hooks/abc", secret };
	instance = start(
		{ ...defaultConfig({}), owner: "robin", dataDir: directory, port: 0, handoff },
		() => ({ ui: null }),
		{
			readers: 0,
		},
	);
	// A local instance starts with the project `scratch`.
	const response = await fetch(`${instance.url}/api/admin`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ do: "project.create", key: "other", preset: "loose" }),
	});
	expect(response.status).toBe(200);
	const session = (await (await fetch(`${instance.url}/api/session`)).json()) as {
		result: { projects: { key: string; handoff: boolean }[] };
	};
	expect(session.result.projects.map(({ key, handoff }) => ({ key, handoff }))).toEqual([
		{ key: "scratch", handoff: true },
		{ key: "other", handoff: false },
	]);
});

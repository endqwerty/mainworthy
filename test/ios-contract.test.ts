// The iOS app is a client nobody here compiles: it is Swift, and this check runs on Linux. What it reads of the
// server is written in `scripts/ios/contract.ts`, and this file holds the server to it: real replies, from a
// real instance, read the way the app reads them. It also holds the Swift that is written from this repository
// to what the repository says now.
//
// A failure here means the app would stop reading a reply. Change the contract with the server, write the Swift
// again and say so in the pull request: `ios/README.md`, "When the contract test fails".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ChangeEvent, DecideReply, EVIDENCE, Inbox, Proposal, SessionInfo } from "../scripts/ios/contract.ts";
import { type TestInstance, testInstance } from "../scripts/ios/instance.ts";
import { mismatches, type Shape } from "../scripts/ios/shape.ts";
import { generated } from "../scripts/ios/swift.ts";
import { KINDS } from "../src/core/kinds.ts";

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
afterAll(() => server.stop());

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
	return reply.result;
}
const op = (key: string, name: string, input: unknown) => result("POST", `/api/p/${key}/${name}`, input);

function holds(what: string, shape: Shape, reply: unknown): void {
	expect(mismatches(shape, reply), `${what}. ${WHAT_TO_DO}`).toEqual([]);
}

type Item = { q: string; kind: string; evidence: unknown; evidenceHash: string };
const open = async (key: string): Promise<Item[]> =>
	((await op(key, "inbox", { state: "open", limit: 100 })) as { items: Item[] }).items;

describe("what the iOS app reads", () => {
	test("who is signed in", async () => {
		holds("GET /api/session", SessionInfo, await result("GET", "/api/session"));
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
		}
		// The scenario leaves one of each kind open. A kind that stops arriving would stop being checked.
		expect([...seen].sort()).toEqual([...KINDS].sort());
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
		holds("inbox, decided", Inbox, await op(project, "inbox", { state: "decided", limit: 100 }));
		const withdrawn = await decide({ undo: failure.q });
		holds("decide, undo", DecideReply, withdrawn);
		expect(withdrawn).toMatchObject({ status: "reopened" });
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

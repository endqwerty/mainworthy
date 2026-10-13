import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OP_LIST } from "../server/ops/index.ts";
import { COMMAND_NAMES } from "./dispatch.ts";
import { GENERATED_COMMANDS } from "./generated.ts";
import { COMMIT, outputWith, RED_XML, withInstance } from "./test-support.ts";

const Ref = z.object({ ref: z.string() });
const Found = z.object({ items: z.array(Ref) });
const Question = z.object({ q: z.string(), evidenceHash: z.string(), kind: z.string() });
const Inbox = z.object({ items: z.array(Question) });
const Token = z.object({ token: z.string() });
const Created = z.object({ cases: z.array(Ref) });
const Receipt = z.object({ batch: z.number(), fresh: z.boolean(), counts: z.object({ total: z.number() }) });

test("red report, blocked gate, generated decision, passed gate without another report", async () => {
	await withInstance(async ({ cli, instance }) => {
		const report = await cli([
			"report",
			RED_XML,
			"--commit",
			COMMIT,
			"--branch",
			"main",
			"--job",
			"e2e",
			"--attempt",
			"2",
		]);
		expect(report.code).toBe(0);
		expect(report.stderr).toBe("");
		expect(report.stdout).toContain("mainworthy report  scratch @ 9f3c2ab  (main)  attempt 2  job e2e");
		expect(report.stdout).toContain("2 results   1 pass   1 fail   0 skip");
		expect(report.stdout).toMatch(/1 new\s+Q-\d+/);
		expect(report.stdout).toContain("expected 90.00, got 100.00");
		const blocked = await cli(["gate", "--commit", COMMIT]);
		expect(blocked.code).toBe(2);
		expect(blocked.stdout).toContain("blocked:");
		expect(blocked.stdout).toContain("needs an answer");
		const inbox = outputWith(Inbox, await cli(["inbox", "--kind", "failure"]));
		const question = inbox.items[0];
		expect(question).toBeDefined();
		if (!question) throw new Error("the failed upload did not open its failure question");
		const decision = await cli([
			"decide",
			"--json",
			JSON.stringify({
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "infra" },
				reason: "Test environment was unavailable",
			}),
		]);
		expect(decision.code).toBe(0);
		expect(decision.stdout).toContain('"status": "decided"');
		const passed = await cli(["gate", "--commit", COMMIT]);
		expect(passed.code).toBe(0);
		expect(passed.stdout).toContain("passed:");
		expect(passed.stdout).not.toContain("needs an answer");
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM batches").get()?.n).toBe(1);
	});
});

test("repeated report returns the same receipt, writes one batch, and names the duplicate", async () => {
	await withInstance(async ({ cli, instance }) => {
		const argv = ["report", RED_XML, "--commit", COMMIT, "--branch", "main"];
		const first = await cli(argv);
		const again = await cli(argv);
		expect(first.code).toBe(0);
		expect(again.code).toBe(0);
		expect(again.stdout).toBe(`${first.stdout}  already received; nothing was written\n`);
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM batches").get()?.n).toBe(1);
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM results").get()?.n).toBe(2);
		const machine = outputWith(Receipt, await cli([...argv, "--json", "--compact"]));
		expect(machine.fresh).toBe(false);
		expect(machine.counts.total).toBe(2);
	});
});

test("missing commit names both ways out and an explicit session uploads", async () => {
	await withInstance(async ({ cli }) => {
		const missing = await cli(["report", RED_XML]);
		expect(missing.code).toBe(4);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toContain("missing commit");
		expect(missing.stderr).toContain("--commit");
		expect(missing.stderr).toContain("--session");
		const session = await cli(["report", RED_XML, "--session", "exploration"]);
		expect(session.code).toBe(0);
		expect(session.stdout).toContain('session "exploration" (no build identity)');
	});
});

test("CI environment supplies report identity and the default gate target", async () => {
	await withInstance(async ({ cli }) => {
		const env = {
			GITHUB_ACTIONS: "true",
			GITHUB_SHA: COMMIT,
			GITHUB_REF: "refs/heads/main",
			GITHUB_REF_NAME: "main",
			GITHUB_REPOSITORY: "acme/web",
			GITHUB_RUN_ID: "123",
			GITHUB_RUN_ATTEMPT: "2",
			GITHUB_JOB: "e2e",
		};
		const report = await cli(["report", RED_XML], { env });
		expect(report.code).toBe(0);
		expect(report.stdout).toContain("9f3c2ab  (main)  attempt 2  job e2e");
		expect((await cli(["gate"], { env })).code).toBe(2);
	});
});

test("a pipeline's token runs both pipeline lines and nothing else, and its secret is absent from token list", async () => {
	await withInstance(async ({ cli }) => {
		const issued = await cli(["--project", "scratch", "token", "new", "--ci", "pipeline", "--json"]);
		expect(issued.code).toBe(0);
		expect(issued.stdout).toContain("will not be shown again");
		expect(outputWith(z.object({ can: z.array(z.string()) }), issued).can).toEqual(["record"]);
		const { token } = outputWith(Token, issued);
		const env = { MAINWORTHY_TOKEN: token, MAINWORTHY_PROJECT: "scratch" };
		const report = await cli(["report", RED_XML, "--commit", COMMIT], { env });
		expect(report.code).toBe(0);
		// Blocked: the verdict and the open question, with a token that may not read the queue.
		const gate = await cli(["gate", "--commit", COMMIT], { env });
		expect([gate.code, gate.stderr]).toEqual([2, ""]);
		expect(gate.stdout).toMatch(/mainworthy gate {4}blocked: .*\n {2}Q-\d+ needs an answer/);
		const inbox = outputWith(Inbox, await cli(["inbox", "--kind", "failure"]));
		const question = inbox.items[0];
		if (!question) throw new Error("no failure question");
		const refused = await cli(
			[
				"decide",
				"--json",
				JSON.stringify({ q: question.q, onEvidence: question.evidenceHash, answer: { is: "infra" } }),
			],
			{ env },
		);
		expect(refused.code).toBe(4);
		expect(refused.stderr).toContain("forbidden:");
		const list = await cli(["token", "list"]);
		expect(list.stdout).toContain("pipeline");
		expect(list.stdout).not.toContain(token);

		// What it may do is listed with its project, changed by name, and taken away by name.
		expect((await cli(["actor", "list"])).stdout).toContain("ci     pipeline  scratch  record");
		const widened = await cli(["--project", "scratch", "actor", "grant", "pipeline", "--can", "read,record"]);
		expect(widened.stdout).toBe("pipeline on scratch: read, record\n");
		const beyond = await cli(["--project", "scratch", "actor", "grant", "pipeline", "--can", "produce"]);
		expect([beyond.code, beyond.stderr]).toEqual([4, expect.stringContaining("a pipeline may hold read and record")]);
		const dropped = await cli(["--project", "scratch", "actor", "ungrant", "pipeline"]);
		expect(dropped.stdout).toBe("pipeline holds no grant on scratch any more\n");
		expect((await cli(["report", RED_XML, "--commit", COMMIT], { env })).stderr).toContain("forbidden:");

		const tokens = outputWith(z.array(z.object({ id: z.number() })), await cli(["token", "list", "--json"]));
		const id = tokens[0]?.id;
		if (id === undefined) throw new Error("issued token is absent from list");
		expect((await cli(["token", "revoke", String(id)])).code).toBe(0);
		expect((await cli(["report", RED_XML, "--commit", COMMIT], { env })).stderr).toContain("unauthenticated:");
	});
});

test("standard policy records both a proposal and a decision and prints its clause table", async () => {
	await withInstance(async ({ cli, instance }) => {
		const changed = await cli(["policy", "use", "standard"]);
		expect(changed.code).toBe(0);
		expect(changed.stdout).toContain("proposal P-");
		expect(changed.stdout).toContain("decision");
		expect(changed.stdout).toContain("both recorded");
		const shown = await cli(["policy", "show"]);
		expect(shown.code).toBe(0);
		expect(shown.stdout).toContain("policy: standard");
		expect(shown.stdout).toContain("who answers");
		expect(shown.stdout).toContain("agent's answer");
		expect(shown.stdout).toContain("author:agent");
		expect(shown.stdout).toContain("hint:disputed");
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM decisions").get()?.n).toBe(1);
	});
});

test("outline stdin, get --md, and fmt round trip the canonical case", async () => {
	await withInstance(async ({ cli, directory }) => {
		const created = await cli(["new", "-"], {
			input: "Coupon applies\n  Open the cart > One item\n  Apply SAVE10 > Total is 90.00\n",
		});
		expect(created.code).toBe(0);
		expect(created.stdout).toBe("C-1\n");
		const got = await cli(["get", "C-1", "--md"]);
		expect(got.code).toBe(0);
		expect(got.stdout).toContain("title: Coupon applies");
		expect(got.stdout).toContain("id: C-1");
		const file = join(directory, "case.md");
		await writeFile(file, got.stdout);
		const fmt = await cli(["fmt", file]);
		expect(fmt.code).toBe(0);
		expect(fmt.stdout).toBe(got.stdout);
		expect((await cli(["get", "--refs", "C-1", "--fields", "title", "--compact"])).stdout.trim()).not.toContain("\n");
	});
});

test("Markdown parse errors include source lines and exit 4", async () => {
	await withInstance(async ({ cli, directory }) => {
		const file = join(directory, "invalid.md");
		await writeFile(file, "---\ntitle: Broken\n");
		const result = await cli(["fmt", file]);
		expect(result.code).toBe(4);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`${file}:`);
		expect(result.stderr).toContain("Missing closing ---");
	});
});

test("check groups real suite problems by rule and exits 1", async () => {
	await withInstance(async ({ cli }) => {
		expect((await cli(["check"])).code).toBe(0);
		await cli(["new"], { input: "An incomplete case\n  Do something\n" });
		const result = await cli(["check"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no-expected (1)");
		expect(result.stdout).toContain("C-1");
	});
});

for (const suffix of [".mainworthy", ".mainworthy.gz"]) {
	test(`export/import${suffix} preserves the case list in a fresh running instance`, async () => {
		await withInstance(async (source) => {
			const created = await source.cli(["new", "--json"], {
				input: "Coupon applies\n  Apply SAVE10 > Total is 90.00\n",
			});
			expect(outputWith(Created, created).cases[0]?.ref).toBe("C-1");
			const archive = join(source.directory, `export${suffix}`);
			expect((await source.cli(["export", "--out", archive])).code).toBe(0);
			await withInstance(async (target) => {
				const imported = await target.cli(["import", archive]);
				expect(imported.stderr).toBe("");
				expect(imported.code).toBe(0);
				expect(imported.stdout).toContain("previous session may no longer exist");
				expect(outputWith(Found, await target.cli(["find"]))).toEqual(outputWith(Found, await source.cli(["find"])));
				const md = await target.cli(["get", "C-1", "--md"]);
				expect(md.stdout).toBe((await source.cli(["get", "C-1", "--md"])).stdout);
			});
		});
	});
}

test("all registry operations have generated commands, global help and --help", async () => {
	await withInstance(async ({ cli }) => {
		const help = await cli(["help"]);
		expect(help.code).toBe(0);
		for (const op of OP_LIST) {
			expect(COMMAND_NAMES.has(op.name)).toBe(true);
			expect(GENERATED_COMMANDS.has(op.name)).toBe(true);
			expect(help.stdout).toContain(op.summary);
			const result = await cli([op.name, "--help"]);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(op.summary);
			expect(result.stdout).toContain("--json");
		}
	});
});

test("generated flags handle booleans, numbers, repeated arrays and union fields", async () => {
	await withInstance(async ({ cli }) => {
		await cli(["new"], { input: "Coupon applies\n  Apply SAVE10 > Total is 90.00\n" });
		const result = await cli([
			"find",
			"--in",
			"cases",
			"--deep",
			"false",
			"--limit",
			"5",
			"--tags",
			"a,b",
			"--tags",
			"c",
			"--compact",
		]);
		expect(result.code).toBe(0);
		expect(outputWith(Found, result).items).toEqual([]);
		expect(result.stdout.trim()).not.toContain("\n");
		const admin = await cli(["admin", "--do", "project.list"]);
		expect(admin.code).toBe(0);
		expect(admin.stdout).toContain('"key": "scratch"');
		const bad = await cli(["find", "--limit", "oops"]);
		expect(bad.code).toBe(4);
		expect(bad.stderr).toContain("--limit needs a number");
	});
});

test("project ambiguity names the projects; command-line project overrides environment", async () => {
	await withInstance(async ({ cli, client }) => {
		await client.call("admin", { do: "project.create", key: "other" });
		const ambiguous = await cli(["find"]);
		expect(ambiguous.code).toBe(4);
		expect(ambiguous.stderr).toContain("scratch, other");
		const chosen = await cli(["--project", "scratch", "find"], { env: { MAINWORTHY_PROJECT: "absent" } });
		expect(chosen.code).toBe(0);
	});
});

test("connection and operation errors are single-line diagnostics with exit 4", async () => {
	await withInstance(async ({ cli }) => {
		const unreachable = await cli(["find", "--url", "http://127.0.0.1:1"]);
		expect(unreachable.code).toBe(4);
		expect(unreachable.stderr).toContain("start the server with mainworthy serve");
		expect(unreachable.stderr.trim().split("\n")).toHaveLength(1);
		const missing = await cli(["get", "C-999"]);
		expect(missing.code).toBe(4);
		expect(missing.stderr).toContain("not_found:");
		expect(missing.stderr.trim().split("\n")).toHaveLength(1);
	});
});

test("passed/failed/blocked/pending gate exit codes stay distinct", async () => {
	await withInstance(async ({ cli }) => {
		const pending = await cli(["gate", "--commit", COMMIT, "--wait", "0.02", "--json"]);
		expect(pending.code).toBe(3);
		expect(pending.stdout).toContain('"verdict": "pending"');
		await cli(["report", RED_XML, "--commit", COMMIT]);
		const question = outputWith(Inbox, await cli(["inbox", "--kind", "failure"])).items[0];
		if (!question) throw new Error("no failure question");
		await cli([
			"decide",
			"--json",
			JSON.stringify({ q: question.q, onEvidence: question.evidenceHash, answer: { is: "defect" } }),
		]);
		const failed = await cli(["gate", "--commit", COMMIT]);
		expect(failed.code).toBe(1);
		expect(failed.stdout).toContain("failed:");
	});
});

test("health exits 0 when the server answers and 1 when nothing does, with no token", async () => {
	await withInstance(async ({ cli, instance }) => {
		const up = await cli(["health"]);
		expect(up.code).toBe(0);
		expect(up.stdout).toBe(`healthy: Mainworthy 0.1.0 at ${instance.url}\n`);
		const down = await cli(["health", "--url", "http://127.0.0.1:9"]);
		expect(down.code).toBe(1);
		expect(down.stdout).toBe("not answering: http://127.0.0.1:9\n");
	});
}, 20_000);

test("open prints the running web UI URL", async () => {
	await withInstance(async ({ cli, instance }) => {
		const result = await cli(["open"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`${instance.url}\n`);
	});
});

test("gate --wait observes evidence that arrives while it is polling", async () => {
	await withInstance(async ({ cli, client }) => {
		const waiting = cli(["gate", "--commit", COMMIT, "--wait", "1.5"]);
		await Bun.sleep(300);
		await client.call("report", {
			target: { commit: COMMIT, branch: "main" },
			results: [{ test: { key: "passing-test" }, outcome: "pass" }],
		});
		const result = await waiting;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("passed:");
	});
});

test("the generated gate JSON input uses the same reserved verdict exit codes", async () => {
	await withInstance(async ({ cli }) => {
		const result = await cli(["gate", "--json", JSON.stringify({ commit: COMMIT }), "--compact"]);
		expect(result.code).toBe(3);
		expect(result.stdout).toContain('"verdict":"pending"');
	});
});

test("policy use checks the caller's project permission, including a scoped admin token", async () => {
	await withInstance(async ({ cli, client }) => {
		const token = Token.parse(
			await client.call("admin", {
				do: "token.create",
				actor: "maintainer",
				kind: "human",
				can: ["read", "produce", "answer", "admin"],
				project: "scratch",
			}),
		).token;
		const changed = await cli(["policy", "use", "standard"], { env: { MAINWORTHY_TOKEN: token } });
		expect(changed.code).toBe(0);
		expect(changed.stdout).toContain("both recorded");
		expect((await cli(["policy", "show"])).stdout).toContain("policy: standard");
	});
});

test("JUnit parser warnings go only to stderr", async () => {
	await withInstance(async ({ cli, directory }) => {
		const file = join(directory, "warning.xml");
		await writeFile(file, '<testsuite name="warnings"><testcase name="missing duration" time="invalid"/></testsuite>');
		const result = await cli(["report", file, "--commit", COMMIT, "--json"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("Invalid testcase duration");
		expect(outputWith(Receipt, result).counts.total).toBe(1);
		expect(result.stdout).not.toContain("Invalid testcase duration");
	});
});

test("an adapter rejects operation flags it cannot translate", async () => {
	await withInstance(async ({ cli }) => {
		await cli(["new"], { input: "Coupon applies\nApply SAVE10 > Total is 90.00" });
		for (const argv of [
			["get", "C-1", "--fields", "title"],
			["report", RED_XML, "--commit", COMMIT, "--cmd", "explicit-key"],
		]) {
			const result = await cli(argv);
			expect(result.code).toBe(4);
			expect(result.stderr).toContain("operation flag");
			expect(result.stderr).toContain("--json");
		}
	});
});

test("empty case input exits 4 and writes no case", async () => {
	await withInstance(async ({ cli, client }) => {
		const result = await cli(["new"], { input: "  \n" });
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("outline");
		expect((await client.call("find", {})).items).toEqual([]);
	});
});

test("schema errors are readable single-line diagnostics", async () => {
	await withInstance(async ({ cli }) => {
		const result = await cli(["token", "revoke", "abc"]);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("id:");
		expect(result.stderr).not.toContain("[;");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
	});
});

test("corrupt gzip is an archive error while the server remains reachable", async () => {
	await withInstance(async ({ cli, directory }) => {
		const file = join(directory, "invalid.mainworthy.gz");
		await writeFile(file, "this is not gzip");
		const result = await cli(["import", file]);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("invalid gzip archive");
		expect(result.stderr).not.toContain("start the server");
		expect((await cli(["open"])).code).toBe(0);
	});
});

test("malformed server data is refused before an adapter reads it", async () => {
	await withInstance(
		async ({ cli }) => {
			const result = await cli(["report", RED_XML, "--commit", COMMIT]);
			expect(result.code).toBe(4);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("internal: the server returned invalid report data");
		},
		{ routes: { "/api/p/scratch/report": () => new Response(JSON.stringify({ ok: true, result: {}, seq: 1 })) } },
	);
});

test("a generated decision batch prints its successful and refused items before exiting 4", async () => {
	await withInstance(async ({ cli, client }) => {
		await client.call("report", {
			target: { commit: COMMIT },
			results: [
				{ test: { key: "one" }, outcome: "fail", failure: { message: "one failed" } },
				{ test: { key: "two" }, outcome: "fail", failure: { message: "two failed" } },
			],
		});
		const questions = (await client.call("inbox", { kind: "failure" })).items;
		const first = questions[0];
		const second = questions[1];
		if (!first || !second) throw new Error("two causes were not opened");
		const result = await cli([
			"decide",
			"--json",
			JSON.stringify({
				all: [
					{ q: first.q, onEvidence: first.evidenceHash, answer: { is: "infra" } },
					{ q: second.q, onEvidence: second.evidenceHash, answer: { is: "not-an-answer" } },
				],
			}),
		]);
		expect(result.code).toBe(4);
		expect(result.stdout).toContain('"status": "decided"');
		expect(result.stdout).toContain('"status": "invalid"');
	});
});

test("a JSON payload refuses flags that would otherwise be ignored", async () => {
	await withInstance(async ({ cli }) => {
		const result = await cli(["gate", "--json", JSON.stringify({ commit: COMMIT }), "--wait", "1"]);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("cannot be combined");
	});
});

test("an HTTP 200 proxy page cannot replace an existing export", async () => {
	await withInstance(
		async ({ cli, directory }) => {
			const file = join(directory, "backup.mainworthy");
			await writeFile(file, "previous backup");
			const result = await cli(["export", "--out", file]);
			expect(result.code).toBe(4);
			expect(await Bun.file(file).text()).toBe("previous backup");
		},
		{
			routes: {
				"/api/export": () => new Response("<html>proxy login</html>", { headers: { "content-type": "text/html" } }),
			},
		},
	);
});

test("a declined case annotation is visible and its failure stays in the gate", async () => {
	await withInstance(async ({ cli, directory }) => {
		const file = join(directory, "declined.xml");
		await writeFile(
			file,
			'<testsuite name="unknown"><testcase name="test @C-999@v1"><failure message="failed"/></testcase></testsuite>',
		);
		const report = await cli(["report", file, "--commit", COMMIT]);
		expect(report.code).toBe(0);
		expect(report.stdout).toContain("1 case/version claims declined; results kept without a case");
		expect(report.stderr).toContain("C-999");
		expect(report.stderr.trim().split("\n")).toHaveLength(1);
		expect((await cli(["gate", "--commit", COMMIT])).code).toBe(2);
	});
});

test("JSON input accepts leading whitespace and newlines", async () => {
	await withInstance(async ({ cli }) => {
		const result = await cli(["find", "--json", '\n  {"in":"cases","limit":1}\n']);
		expect(result.code).toBe(0);
		expect(outputWith(Found, result).items).toEqual([]);
	});
});

test("an early refusal of a large valid gzip reports authorization, not corrupt data", async () => {
	await withInstance(async (source) => {
		await source.client.call("propose", {
			edits: [
				{
					op: "create",
					body: {
						title: "Large archive",
						pre: randomBytes(1_500_000).toString("base64"),
						methods: ["human"],
						steps: [],
					},
				},
			],
		});
		const file = join(source.directory, "valid.mainworthy.gz");
		expect((await source.cli(["export", "--out", file])).code).toBe(0);
		await withInstance(
			async ({ cli, client }) => {
				for (const token of ["", "unknown-token"]) {
					const result = await cli(["import", file], { env: { MAINWORTHY_TOKEN: token } });
					expect(result.code).toBe(4);
					expect(result.stderr).toContain("unauthenticated:");
					expect(result.stderr).not.toContain("invalid gzip");
				}
				const token = Token.parse(
					await client.call("admin", { do: "token.create", actor: "pipeline", kind: "ci", can: ["read", "record"] }),
				).token;
				const denied = await cli(["import", file], { env: { MAINWORTHY_TOKEN: token } });
				expect(denied.code).toBe(4);
				expect(denied.stderr).toContain("forbidden:");
				expect(denied.stderr).not.toContain("invalid gzip");
			},
			{ mode: "server" },
		);
	});
});

test("an empty MAINWORTHY_URL, MAINWORTHY_TOKEN or MAINWORTHY_PROJECT is the same as none", async () => {
	// A pipeline passes a setting that is not configured as an empty string, not as an absent variable.
	await withInstance(async ({ cli, instance }) => {
		const empty = { MAINWORTHY_URL: "", MAINWORTHY_TOKEN: "", MAINWORTHY_PROJECT: "" };
		// No address named: the server on this machine, at its port.
		const health = await cli(["health", "--json"], { env: { ...empty, MAINWORTHY_PORT: new URL(instance.url).port } });
		expect(health.stderr).toBe("");
		expect(JSON.parse(health.stdout)).toMatchObject({ healthy: true });
		// An empty port is no port either: the built-in one, whether or not anything listens there.
		const port = await cli(["health", "--json"], { env: { ...empty, MAINWORTHY_PORT: "" } });
		expect(JSON.parse(port.stdout)).toMatchObject({ url: "http://127.0.0.1:7357" });
		// No token and no project named: the local session and the only project.
		const inbox = await cli(["inbox", "--json", "{}", "--url", instance.url], { env: empty });
		expect(inbox.stderr).toBe("");
		expect(inbox.code).toBe(0);
	});
});

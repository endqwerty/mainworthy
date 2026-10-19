import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import api1Actors from "../../test/fixtures/cli/actor-list-api1.json";
import { ciReport } from "../../test/helpers.ts";
import { Policy } from "../core/kinds.ts";
import { QuestionItem, type ReportInput } from "../core/ops.ts";
import { API_VERSION } from "../core/version.ts";
import { OP_LIST } from "../server/ops/index.ts";
import { Client, plainHttpToAnotherMachine } from "./client.ts";
import { printGate } from "./commands/gate.ts";
import { printReceipt } from "./commands/report.ts";
import { ADAPTER_COMMANDS, COMMAND_NAMES } from "./dispatch.ts";
import { GENERATED_COMMANDS } from "./generated.ts";
import { MAX_SEED_UNLINKED_FILES, seed, unitTests } from "./seed.ts";
import { gitTarget } from "./target.ts";
import { COMMIT, inThisProcess, outputWith, RED_XML, withInstance } from "./test-support.ts";

const Ref = z.object({ ref: z.string() });
const Found = z.object({ items: z.array(Ref) });
const Question = z.object({ q: z.string(), evidenceHash: z.string(), kind: z.string() });
const Inbox = z.object({ items: z.array(Question) });
const Token = z.object({ token: z.string() });
const Created = z.object({ cases: z.array(Ref) });
const Receipt = z.object({ batch: z.number(), fresh: z.boolean(), counts: z.object({ total: z.number() }) });

test("report prints a conflict for a CI correction whose result was already corrected", async () => {
	await withInstance(async ({ client, cli }) => {
		const { token } = Token.parse(
			await client.call("admin", {
				do: "token.create",
				actor: "correction-pipeline",
				kind: "ci",
				can: ["read", "record"],
				project: "scratch",
			}),
		);
		const pipeline = new Client({ url: client.url, token, project: "scratch" });
		const input = { target: { commit: "clicorrect611" } };
		const original = (
			await pipeline.call("report", { ...input, results: [{ test: { key: "test" }, outcome: "pass" }] })
		).results[0];
		await pipeline.call("report", {
			...input,
			results: [{ test: { key: "test" }, outcome: "fail", note: "Broken", corrects: original }],
		});
		const refused = await cli(
			[
				"report",
				"--project",
				"scratch",
				"--json",
				JSON.stringify({ ...input, results: [{ test: { key: "test" }, outcome: "pass", corrects: original }] }),
			],
			{ env: { MAINWORTHY_TOKEN: token } },
		);
		expect(refused).toMatchObject({
			code: 4,
			stdout: "",
			stderr: `conflict: result ${original} was already corrected; read the latest results and correct the current result instead\n`,
		});
	});
});

for (const refusal of ["reason", "admin"] as const) {
	test(`decide prints a refused inherited replacement when the cause requires ${refusal}`, async () => {
		await withInstance(async ({ client, cli }) => {
			const policy = Policy.extend({ version: z.number() }).parse(
				await client.call("admin", { do: "policy.show", project: "scratch" }),
			);
			await client.call("propose", {
				edits: [
					{
						op: "policy",
						base: policy.version,
						clauses: policy.clauses.map((clause) =>
							clause.kind === "failure" && clause.ask.who !== "rule"
								? {
										...clause,
										ask: {
											...clause.ask,
											...(refusal === "reason" ? { reason: "required" as const } : { who: "admin" as const }),
										},
									}
								: clause,
						),
					},
				],
			});
			const adoption = (await client.call("inbox", { kind: "adopt" })).items[0];
			if (!adoption) throw new Error("missing policy adoption");
			await client.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
			await client.call("report", ciReport({ commit: "clibase530", n: 1, fail: { 0: "same cause" } }));
			await client.call(
				"report",
				ciReport({ commit: "clifix530", pr: 530, base: "clibase530", n: 1, fail: { 0: "same cause" } }),
			);
			const automatic = (await client.call("inbox", { state: "decided", kind: "failure", on: "pr:530" })).items[0];
			if (!automatic) throw new Error("missing inherited answer");
			const { token } = Token.parse(
				await client.call("admin", {
					do: "token.create",
					actor: "member",
					kind: "human",
					can: ["read", "produce", "answer"],
					project: "scratch",
				}),
			);
			const result = await cli(
				[
					"decide",
					"--project",
					"scratch",
					"--json",
					JSON.stringify({ q: automatic.q, onEvidence: automatic.evidenceHash, answer: { is: "defect" } }),
				],
				refusal === "admin" ? { env: { MAINWORTHY_TOKEN: token } } : {},
			);
			expect(result.code).toBe(4);
			expect(JSON.parse(result.stdout)).toMatchObject([
				{
					q: automatic.q,
					status: refusal === "reason" ? "invalid" : "forbidden",
					needs: refusal === "reason" ? "a reason" : "an admin",
					decision: null,
				},
			]);
			expect(result.stderr).toContain(refusal === "reason" ? "invalid: a reason" : "forbidden: an admin");
			expect(await client.call("gate", { commit: "clifix530" })).toMatchObject({
				verdict: "passed",
				tally: { excused: 1, unexplained: 0 },
			});
		});
	});
}

test("get prints who answered a failure and the recorded reason its answer ended", async () => {
	await withInstance(async ({ client, cli }) => {
		await client.call(
			"report",
			ciReport({ commit: "cli408a", branch: "fix", pr: 408, n: 1, fail: { 0: "expected 90, got 100" } }),
		);
		const question = (await client.call("inbox", { kind: "failure" })).items[0];
		if (!question) throw new Error("expected a failure question");
		await client.call("decide", {
			q: question.q,
			onEvidence: question.evidenceHash,
			answer: { is: "test" },
			reason: "Fix the assertion.",
		});
		await client.call("report", ciReport({ commit: "cli408b", branch: "fix", pr: 408, n: 1 }));
		const printed = await cli(["get", question.q]);
		expect(printed.code).toBe(0);
		expect(z.array(QuestionItem).parse(JSON.parse(printed.stdout))).toMatchObject([
			{
				q: question.q,
				state: "dissolved",
				decision: {
					answer: { is: "outdated" },
					rule: "passed",
					reason: "Every test it named passed on cli408b where it had failed; the answer ended.",
					supersedes: { answer: { is: "test" }, by: ["robin"], reason: "Fix the assertion." },
				},
			},
		]);
	});
});

test("git target detection stops after one Git process outside a repository or without commits", async () => {
	await withInstance(async ({ directory }) => {
		const bin = join(directory, "bin");
		const log = join(directory, "git-calls");
		const git = Bun.which("git");
		if (!git) throw new Error("git is required for target detection tests");
		await mkdir(bin);
		await writeFile(join(bin, "git"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GIT_CALL_LOG"\nexec "$REAL_GIT" "$@"\n', {
			mode: 0o755,
		});
		for (const checkout of ["plain", "unborn"]) {
			const cwd = join(directory, checkout);
			await mkdir(cwd);
			if (checkout === "unborn") expect(Bun.spawnSync([git, "init", "--quiet", cwd]).exitCode).toBe(0);
			await writeFile(log, "");
			const result = await inThisProcess(
				`git target in ${checkout}`,
				async () => {
					process.stdout.write(JSON.stringify(gitTarget()));
					return 0;
				},
				{
					cwd,
					input: "",
					environment: {
						PATH: bin,
						HOME: directory,
						REAL_GIT: git,
						GIT_CALL_LOG: log,
						GIT_CEILING_DIRECTORIES: directory,
					},
				},
			);
			expect(result).toEqual({ code: 0, stdout: "null", stderr: "" });
			expect(await Bun.file(log).text()).toBe("rev-parse HEAD\n");
		}
	});
});

test("git target detection preserves branch, detached HEAD and missing origin metadata", async () => {
	await withInstance(async ({ directory }) => {
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["git", ...args], { cwd: directory });
			expect(result.exitCode).toBe(0);
			return result.stdout.toString().trim();
		};
		git("init", "--quiet", "--initial-branch=feature");
		git(
			"-c",
			"user.name=robin",
			"-c",
			"user.email=robin@example.com",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"--allow-empty",
			"-m",
			"Initial",
		);
		const commit = git("rev-parse", "HEAD");
		git("remote", "add", "origin", "https://github.com/acme/web.git");
		for (const state of ["branch", "detached", "no-origin"]) {
			if (state === "detached") git("checkout", "--quiet", "--detach");
			if (state === "no-origin") {
				git("checkout", "--quiet", "feature");
				git("remote", "remove", "origin");
			}
			const result = await inThisProcess(
				`git target with ${state}`,
				async () => {
					process.stdout.write(JSON.stringify(gitTarget()));
					return 0;
				},
				{ cwd: directory, input: "", environment: { PATH: process.env.PATH ?? "", HOME: directory } },
			);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toEqual({
				commit,
				...(state === "detached" ? {} : { branch: "feature" }),
				...(state === "no-origin" ? {} : { repo: "acme/web" }),
			});
		}
	});
});

test("get prints folder archive and placement proposals with nullable edit fields", async () => {
	await withInstance(async ({ client, cli, run }) => {
		await client.call("propose", {
			edits: [
				{ op: "create", outline: "Movable case" },
				{ op: "folder", name: "Empty" },
			],
		});
		const proposed = z.object({ proposal: z.string() });
		const archive = proposed.parse(
			await client.call("propose", { edits: [{ op: "folder", folder: "Empty", archive: true }] }),
		);
		const place = proposed.parse(
			await client.call("propose", { edits: [{ op: "place", cases: ["C-1"], folder: "Moved" }] }),
		);
		const reply = await cli(["get", archive.proposal, "--json"]);
		expect(reply.stderr).toBe("");
		expect(reply.code).toBe(0);
		expect(
			outputWith(z.array(z.object({ ref: z.string(), edits: z.array(z.record(z.string(), z.unknown())) })), reply),
		).toEqual([{ ref: archive.proposal, edits: [{ op: "folder", folder: "Empty", name: null, archive: true }] }]);
		const moved = await run(["get", place.proposal, "--json"]);
		expect(moved.code).toBe(0);
		expect(moved.stderr).toBe("");
		expect(
			outputWith(z.array(z.object({ ref: z.string(), edits: z.array(z.record(z.string(), z.unknown())) })), moved),
		).toEqual([
			{ ref: place.proposal, edits: [{ op: "place", cases: ["C-1"], folder: "Moved", tags: null, after: "" }] },
		]);
	});
});

// Captured from main ceee7b57's local server, before actor.list included teams.
test("actor list reads main's API 1 reply without teams", async () => {
	await withInstance(
		async ({ cli, run }) => {
			const listed = await cli(["actor", "list"]);
			expect(listed.stderr).toBe("");
			expect(listed.code).toBe(0);
			expect(listed.stdout).toBe(
				"rule   policy  no grant\nhuman  robin  *  read, record, produce, answer, plan, admin\n",
			);
			const json = await run(["actor", "list", "--json"]);
			expect(json.code).toBe(0);
			expect(json.stderr).toBe("");
			expect(JSON.parse(json.stdout)).toEqual([
				{ name: "policy", kind: "rule", disabled: false, grants: [], teams: [] },
				{
					name: "robin",
					kind: "human",
					disabled: false,
					teams: [],
					grants: [{ project: "*", can: ["read", "record", "produce", "answer", "plan", "admin"], roles: [] }],
				},
			]);
		},
		{ routes: { "/api/admin": () => Response.json(api1Actors) } },
	);
});

test("generated admin commands manage teams and actor list attributes their grants", async () => {
	await withInstance(async ({ cli, run, client }) => {
		await client.call("admin", { do: "token.create", actor: "team-person", kind: "human", can: ["read"] });
		const created = await cli(["admin", "--do", "team.create", "--name", "Quality"]);
		expect(created.code).toBe(0);
		for (const args of [
			["--do", "team.grant.set", "--team", "Quality", "--can", "produce", "--project", "scratch"],
			["--do", "team.member.add", "--team", "Quality", "--person", "team-person"],
		])
			expect((await run(["admin", ...args])).code).toBe(0);
		const listed = await run(["actor", "list"]);
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain("scratch  record, produce  from team Quality");
		expect(listed.stdout).toContain("*  read");
		const history = await run(["admin", "--do", "team.history", "--team", "Quality"]);
		expect(history.code).toBe(0);
		expect(history.stdout).toContain('"member.add"');
		expect(
			(await run(["admin", "--do", "team.member.remove", "--team", "Quality", "--person", "team-person"])).code,
		).toBe(0);
		expect((await run(["actor", "list"])).stdout).not.toContain("from team Quality");
	});
});

test("actor grant assigns, lists, preserves and clears named roles", async () => {
	await withInstance(async ({ cli, run, client }) => {
		await client.call("admin", {
			do: "token.create",
			actor: "role-cli",
			kind: "human",
			can: ["read", "produce", "answer"],
		});
		const assigned = await cli([
			"actor",
			"grant",
			"role-cli",
			"--project",
			"scratch",
			"--can",
			"read,produce,answer",
			"--roles",
			"approver,lead",
		]);
		expect([assigned.code, assigned.stdout]).toEqual([
			0,
			"role-cli on scratch: read, produce, answer; roles: approver, lead\n",
		]);
		expect((await run(["actor", "list"])).stdout).toContain(
			"scratch  read, record, produce, answer  roles: approver, lead",
		);
		const kept = await run([
			"actor",
			"grant",
			"role-cli",
			"--project",
			"scratch",
			"--can",
			"read,produce,answer",
			"--json",
		]);
		expect(outputWith(z.object({ roles: z.array(z.string()) }), kept).roles).toEqual(["approver", "lead"]);
		const cleared = await run([
			"actor",
			"grant",
			"role-cli",
			"--project",
			"scratch",
			"--can",
			"read,produce,answer",
			"--roles=",
			"--json",
		]);
		expect(outputWith(z.object({ roles: z.array(z.string()) }), cleared).roles).toEqual([]);
		const invalid = await run([
			"actor",
			"grant",
			"role-cli",
			"--project",
			"scratch",
			"--can",
			"read",
			"--roles",
			"Approver",
		]);
		expect(invalid.code).toBe(4);
	});
});

test("actor forget requires a named confirmation, removes access, and preserves the self and owner guards", async () => {
	await withInstance(
		async ({ cli, run, client }) => {
			const made = Token.parse(await client.call("admin", { do: "token.create", actor: "forget-cli", kind: "human" }));
			const listed = outputWith(
				z.array(z.object({ name: z.string(), owner: z.boolean().optional() })),
				await run(["actor", "list", "--json"]),
			);
			expect(listed.find((actor) => actor.name === "robin")).toEqual({ name: "robin", owner: true });
			expect(listed.find((actor) => actor.name === "forget-cli")).toEqual({ name: "forget-cli", owner: false });
			const unconfirmed = await run(["actor", "forget", "forget-cli"]);
			expect(unconfirmed.code).toBe(4);
			expect(unconfirmed.stderr).toContain("--confirm forget-cli");
			expect(unconfirmed.stderr).toContain("text the person typed in cases and notes stay");
			expect(unconfirmed.stderr).toContain("authenticator secrets and recovery-code hashes");
			expect(unconfirmed.stderr).toContain("Linked provider identities and recovery email addresses are erased");
			expect(unconfirmed.stderr).toContain("token network addresses");
			expect(unconfirmed.stderr).toContain("attachments");
			expect((await run(["actor", "forget", "forget-cli", "--confirm", "somebody-else"])).code).toBe(4);
			expect((await run(["actor", "list"])).stdout).toContain("forget-cli");
			const forgotten = await cli(["actor", "forget", "forget-cli", "--confirm", "forget-cli", "--json"]);
			expect(forgotten.code).toBe(0);
			expect(outputWith(z.object({ forgotten: z.string(), tokensRevoked: z.number() }), forgotten)).toEqual({
				forgotten: "forgotten-3",
				tokensRevoked: 1,
			});
			expect((await run(["actor", "list"], { env: { MAINWORTHY_TOKEN: made.token } })).code).toBe(4);
			await client.call("admin", { do: "token.create", actor: "forget-one-token", kind: "human" });
			const singular = await run(["actor", "forget", "forget-one-token", "--confirm", "forget-one-token"]);
			expect(singular.code).toBe(0);
			expect(singular.stdout).toBe("Forgotten as forgotten-4. 1 token revoked. History and typed text stay.\n");
			const self = await run(["actor", "forget", "robin", "--confirm", "robin"]);
			expect(self.stderr).toContain("you cannot forget yourself");
			const admin = Token.parse(
				await client.call("admin", { do: "token.create", actor: "other-admin", kind: "human" }),
			);
			const owner = await run(["actor", "forget", "robin", "--confirm", "robin"], {
				env: { MAINWORTHY_TOKEN: admin.token },
			});
			expect(owner.stderr).toContain("owns this instance and is not forgotten");
		},
		{ mode: "server" },
	);
});

test("announce binds an artifact through HTTP and release reports use its build instead of a detected commit", async () => {
	await withInstance(async ({ cli, run, client }) => {
		const sourceCommit = "1".repeat(40);
		const digest = `sha256:${"a".repeat(64)}`;
		const announced = await cli([
			"announce",
			"--deploy",
			"rc3",
			"--env",
			"staging",
			"--digest",
			digest,
			"--repo",
			"acme/web",
			"--commit",
			sourceCommit,
			"--cmd",
			"deploy-http-1",
		]);
		expect([announced.code, announced.stderr]).toEqual([0, ""]);
		expect(JSON.parse(announced.stdout)).toMatchObject({
			build: "rc3",
			digest,
			env: "staging",
			code: [{ repo: "acme/web", commit: sourceCommit }],
		});
		await client.call("propose", { edits: [{ op: "create", outline: "Checkout\n  Open cart > Empty" }] });
		const undeployed = 'build rc3 has not been deployed to "prodution"; deployed environments: "staging"';
		await expect(
			client.call("report", {
				target: { build: "rc3", env: "prodution" },
				results: [{ test: { case: "C-1" }, outcome: "pass" }],
			}),
		).rejects.toThrow(undeployed);
		await expect(
			client.call("plan", {
				name: "Typo release",
				select: { cases: ["C-1"] },
				accepts: { build: "rc3", env: "prodution" },
			}),
		).rejects.toThrow(undeployed);
		const planned = await client.call("plan", {
			name: "Release",
			select: { cases: ["C-1"] },
			accepts: { build: "rc3", env: "staging" },
		});
		const sent = await run(["report", RED_XML, "--build", "rc3", "--env", "staging"], {
			env: {
				GITHUB_ACTIONS: "true",
				GITHUB_SHA: sourceCommit,
				GITHUB_REPOSITORY: "acme/web",
				GITHUB_REF: "refs/heads/main",
			},
		});
		expect([sent.code, sent.stderr]).toEqual([0, ""]);
		expect(sent.stdout).toContain('scratch @ build "rc3" (staging)');
		expect(sent.stdout).toContain("use gate --run with a planned release run");
		await client.call("report", { run: planned.run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		const gate = await run(["gate", "--run", planned.run]);
		expect([gate.code, gate.stderr]).toEqual([0, ""]);
		expect(gate.stdout).toContain("passed: 1 result proven");
		const events = await run(["find", "--in", "deployments"]);
		expect(JSON.parse(events.stdout)).toMatchObject({
			items: [
				{ build: "rc3", digest, env: "staging", attestation: { by: expect.any(String), at: expect.any(Number) } },
			],
		});
		const rebound = await run([
			"announce",
			"--deploy",
			"rc3",
			"--env",
			"production",
			"--digest",
			`sha256:${"b".repeat(64)}`,
		]);
		expect([rebound.code, rebound.stderr]).toEqual([4, expect.stringContaining("conflict:")]);
		const mixed = await run(["report", RED_XML, "--build", "rc3", "--commit", sourceCommit]);
		expect([mixed.code, mixed.stderr]).toEqual([4, expect.stringContaining("--build cannot be combined")]);
		const mixedHead = await run(["report", RED_XML, "--build", "rc3", "--head", sourceCommit]);
		expect([mixedHead.code, mixedHead.stderr]).toEqual([4, expect.stringContaining("--build cannot be combined")]);
	});
});

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
		// The same files again are answered with the first receipt, gate line included: it still says blocked, and
		// the command says on stderr that it is the old one and where the verdict now is.
		const again = await cli([
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
		expect(again.code).toBe(0);
		expect(again.stdout).toContain("mainworthy gate    blocked:");
		expect(again.stdout).toEndWith("  already received; nothing was written\n");
		expect(again.stderr).toBe(
			"mainworthy: this report was received before. Its receipt, and the gate line in it, are as they were then; `mainworthy gate` says what the verdict is now.\n",
		);
	});
});

test("report --head follows the code host after a reset while keeping the tested commit exact", async () => {
	await withInstance(async ({ cli, client }) => {
		const target = { commit: COMMIT, repo: "acme/web", branch: "feature", pr: 12 };
		await client.call("report", { target, results: [{ test: { key: "old" }, outcome: "pass" }] });
		await client.call("report", {
			target: { ...target, commit: "newhead1" },
			results: [{ test: { key: "new" }, outcome: "fail", failure: { message: "defect" } }],
		});
		expect((await client.call("gate", { change: "pr:12" })).verdict).toBe("blocked");
		const receipt = await cli(
			["report", RED_XML, "--commit", "newhead1", "--pr", "12", "--branch", "feature", "--head", COMMIT],
			{ env: { MAINWORTHY_COMMIT: "newhead1", MAINWORTHY_REPO: "acme/web" } },
		);
		expect(receipt.code).toBe(0);
		expect(receipt.stderr).toBe("");
		expect((await client.call("gate", { change: "pr:12" })).verdict).toBe("passed");
		expect((await client.call("gate", { commit: "newhead1", repo: "acme/web" })).verdict).toBe("blocked");
	});
});

test("repeated report returns the same receipt, writes one batch, and names the duplicate", async () => {
	await withInstance(async ({ run, instance }) => {
		const argv = ["report", RED_XML, "--commit", COMMIT, "--branch", "main"];
		const first = await run(argv);
		const again = await run(argv);
		expect(first.code).toBe(0);
		expect(again.code).toBe(0);
		expect(again.stdout).toBe(`${first.stdout}  already received; nothing was written\n`);
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM batches").get()?.n).toBe(1);
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM results").get()?.n).toBe(2);
		const machine = outputWith(Receipt, await run([...argv, "--json", "--compact"]));
		expect(machine.fresh).toBe(false);
		expect(machine.counts.total).toBe(2);
	});
});

for (const policy of ["track", "ask", "create"] as const) {
	test(`report receipt describes recorded result bases under ${policy}, including policy changes and replay`, async () => {
		await withInstance(async ({ cli, run, client, directory }) => {
			expect((await run(["policy", "tests", policy])).code).toBe(0);
			const file = join(directory, "passing.xml");
			await writeFile(file, '<testsuite><testcase name="one" classname="checkout" /></testsuite>');
			const argv = ["report", file, "--commit", COMMIT, "--branch", "main"];
			const first = await cli(argv);
			expect([first.code, first.stderr]).toEqual([0, ""]);
			expect((await client.call("find", { in: "cases" })).count).toBe(policy === "create" ? 1 : 0);
			expect((await client.call("inbox", { kind: "map" })).items).toHaveLength(policy === "ask" ? 1 : 0);
			expect(first.stdout).toContain("  1 result had no case or version when recorded\n");
			expect(first.stdout).toContain("  1 result   1 pass   0 fail   0 skip");
			expect(first.stdout).toContain("  basis: unresolved 1 result (no case or version when recorded)\n");

			const repeated = join(directory, "repeated.xml");
			await writeFile(
				repeated,
				'<testsuite><testcase name="two" classname="checkout" /><testcase name="two" classname="checkout" /></testsuite>',
			);
			const plural = await run(["report", repeated, "--commit", COMMIT]);
			expect([plural.code, plural.stderr]).toEqual([0, ""]);
			expect((await client.call("find", { in: "tests" })).items).toHaveLength(2);
			expect(plural.stdout).toContain("  2 results had no case or version when recorded\n");
			expect(plural.stdout).toContain("  2 results   2 pass   0 fail   0 skip");
			expect(plural.stdout).toContain("  basis: unresolved 2 results (no case or version when recorded)\n");

			if (policy === "ask") {
				await client.call("propose", { edits: [{ op: "create", outline: "Checkout" }] });
				const [question] = (await client.call("inbox", { kind: "map" })).items;
				if (!question) throw new Error("the upload did not ask for a case link");
				expect(
					await client.call("decide", {
						q: question.q,
						onEvidence: question.evidenceHash,
						answer: { is: "link", pairs: [["T-1", "C-1"]] },
					}),
				).toMatchObject([{ status: "decided" }]);
				const linkedReplay = await run(argv);
				expect(linkedReplay.code).toBe(0);
				expect(linkedReplay.stdout).toBe(`${first.stdout}  already received; nothing was written\n`);
			}

			expect((await run(["policy", "tests", policy === "create" ? "track" : "create"])).code).toBe(0);
			const again = await run(argv);
			expect(again.code).toBe(0);
			expect(again.stdout).toBe(`${first.stdout}  already received; nothing was written\n`);
			expect(again.stderr).toBe(
				"mainworthy: this report was received before. Its receipt, and the gate line in it, are as they were then; `mainworthy gate` says what the verdict is now.\n",
			);
			const machine = await run([...argv, "--json"]);
			expect(machine.code).toBe(0);
			expect(JSON.parse(machine.stdout)).toMatchObject({
				fresh: false,
				unlinked: 1,
				basis: { exact: 0, assumed: 0, unresolved: 1 },
			});

			if (policy === "track") await client.call("propose", { edits: [{ op: "create", outline: "Checkout" }] });
			const assumed = join(directory, "assumed.xml");
			await writeFile(assumed, '<testsuite><testcase name="single assumed @C-1" /></testsuite>');
			const singleBasis = await run(["report", assumed, "--commit", COMMIT]);
			expect([singleBasis.code, singleBasis.stderr]).toEqual([0, ""]);
			expect(singleBasis.stdout).toContain(
				"  basis: assumed 1 result (case version current when recorded; add a version manifest for exact)\n",
			);
			const mixed = join(directory, "mixed.xml");
			await writeFile(
				mixed,
				'<testsuite><testcase name="exact @C-1@v1" /><testcase name="assumed @C-1" /><testcase name="also assumed @C-1" /><testcase name="unmapped" /></testsuite>',
			);
			const mixedArgv = ["report", mixed, "--commit", COMMIT];
			const bases = await run(mixedArgv);
			expect([bases.code, bases.stderr]).toEqual([0, ""]);
			expect(bases.stdout).toContain("  4 results   4 pass   0 fail   0 skip");
			expect(bases.stdout).toContain(
				"  basis: exact 1 result, assumed 2 results (case versions current when recorded; add a version manifest for exact), unresolved 1 result (no case or version when recorded)\n",
			);
			expect(
				await client.call("propose", {
					edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Updated checkout" } }],
				}),
			).toMatchObject({ status: "adopted", cases: [{ ref: "C-1", version: 2 }] });
			const basesReplay = await run(mixedArgv);
			expect(basesReplay.code).toBe(0);
			expect(basesReplay.stdout).toBe(`${bases.stdout}  already received; nothing was written\n`);
		});
	});
}

test("missing commit names both ways out and an explicit session uploads", async () => {
	await withInstance(async ({ run }) => {
		const missing = await run(["report", RED_XML]);
		expect(missing.code).toBe(4);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toContain("missing commit");
		expect(missing.stderr).toContain("--commit");
		expect(missing.stderr).toContain("--session");
		const session = await run(["report", RED_XML, "--session", "exploration"]);
		expect(session.code).toBe(0);
		expect(session.stdout).toContain('session "exploration" (no build identity)');
	});
});

test("CI environment supplies report identity and the default gate target", async () => {
	await withInstance(async ({ run }) => {
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
		const report = await run(["report", RED_XML], { env });
		expect(report.code).toBe(0);
		expect(report.stdout).toContain("9f3c2ab  (main)  attempt 2  job e2e");
		expect((await run(["gate"], { env })).code).toBe(2);
	});
});

test("a pipeline's token runs both pipeline lines and nothing else, and its secret is absent from token list", async () => {
	await withInstance(async ({ run }) => {
		const issued = await run(["--project", "scratch", "token", "new", "--ci", "pipeline", "--json"]);
		expect(issued.code).toBe(0);
		expect(issued.stdout).toContain("will not be shown again");
		expect(outputWith(z.object({ can: z.array(z.string()) }), issued).can).toEqual(["record"]);
		const { token } = outputWith(Token, issued);
		const env = { MAINWORTHY_TOKEN: token, MAINWORTHY_PROJECT: "scratch" };
		const report = await run(["report", RED_XML, "--commit", COMMIT], { env });
		expect(report.code).toBe(0);
		// Blocked: the verdict and the open question, with a token that may not read the queue.
		const gate = await run(["gate", "--commit", COMMIT], { env });
		expect([gate.code, gate.stderr]).toEqual([2, ""]);
		expect(gate.stdout).toMatch(/mainworthy gate {4}blocked: .*\n {2}Q-\d+ needs an answer/);
		const inbox = outputWith(Inbox, await run(["inbox", "--kind", "failure"]));
		const question = inbox.items[0];
		if (!question) throw new Error("no failure question");
		const refused = await run(
			[
				"decide",
				"--json",
				JSON.stringify({ q: question.q, onEvidence: question.evidenceHash, answer: { is: "infra" } }),
			],
			{ env },
		);
		expect(refused.code).toBe(4);
		expect(refused.stderr).toContain("forbidden:");
		const list = await run(["token", "list"]);
		expect(list.stdout).toContain("pipeline");
		expect(list.stdout).not.toContain(token);

		// What it may do is listed with its project, changed by name, and taken away by name.
		expect((await run(["actor", "list"])).stdout).toContain("ci     pipeline  scratch  record");
		const widened = await run(["--project", "scratch", "actor", "grant", "pipeline", "--can", "read,record"]);
		expect(widened.stdout).toBe("pipeline on scratch: read, record\n");
		const beyond = await run(["--project", "scratch", "actor", "grant", "pipeline", "--can", "produce"]);
		expect([beyond.code, beyond.stderr]).toEqual([4, expect.stringContaining("a pipeline may hold read and record")]);
		const dropped = await run(["--project", "scratch", "actor", "ungrant", "pipeline"]);
		expect(dropped.stdout).toBe("pipeline holds no grant on scratch any more\n");
		// With no grant on the project, the token is told what it would be told of a project that does not exist:
		// a refusal that named the capability would confirm the project's key to any token.
		expect((await run(["report", RED_XML, "--commit", COMMIT], { env })).stderr).toBe(
			"not_found: no project named scratch, or no grant on it\n",
		);

		const tokens = outputWith(z.array(z.object({ id: z.number() })), await run(["token", "list", "--json"]));
		const id = tokens[0]?.id;
		if (id === undefined) throw new Error("issued token is absent from list");
		expect((await run(["token", "revoke", String(id)])).code).toBe(0);
		expect((await run(["report", RED_XML, "--commit", COMMIT], { env })).stderr).toContain("unauthenticated:");
	});
});

test("standard policy records both a proposal and a decision and prints its clause table", async () => {
	await withInstance(async ({ run, instance }) => {
		const changed = await run(["policy", "use", "standard"]);
		expect(changed.code).toBe(0);
		expect(changed.stdout).toContain("proposal P-");
		expect(changed.stdout).toContain("decision");
		expect(changed.stdout).toContain("both recorded");
		const shown = await run(["policy", "show"]);
		expect(shown.code).toBe(0);
		expect(shown.stdout).toContain("policy: standard");
		expect(shown.stdout).toContain("tests with no case: track");
		expect(shown.stdout).toContain("who answers");
		expect(shown.stdout).toContain("agent's answer");
		expect(shown.stdout).toContain("author:agent");
		expect(shown.stdout).toContain("hint:disputed");
		const snapshot = outputWith(
			z.object({ version: z.number(), preset: z.string() }),
			await run(["policy", "show", "--json"]),
		);
		expect(snapshot).toEqual({ version: 2, preset: "standard" });
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM decisions").get()?.n).toBe(1);
	});
});

test("change says a pull request ended, and the questions about it are no longer asked", async () => {
	await withInstance(async ({ run, client }) => {
		await client.call("report", {
			target: { commit: "cafe0002", branch: "fix", pr: 482 },
			results: [
				{
					test: { key: "tests/a.spec.ts::one", file: "tests/a.spec.ts" },
					outcome: "fail",
					failure: { message: "expected 90, got 100" },
				},
			],
		});
		const asked = (await client.call("inbox", { kind: "failure" })).items[0]?.q;
		// The command is the operation, with its input as flags. One start of it is enough to hold that: what the
		// operation does with every other input is held where it costs no process (test/evidence.test.ts).
		const ended = await run(["change", "--change", "pr:482", "--state", "merged", "--compact"]);
		expect(ended.stderr).toBe("");
		expect(ended.stdout).toBe(`{"change":"pr:482","state":"merged","questions":["${asked}"],"already":false}\n`);
		expect((await client.call("inbox", {})).counts.open).toBe(0);
		expect(await client.call("change", { change: "pr:482", state: "open" })).toMatchObject({
			state: "open",
			already: false,
		});
		expect((await client.call("inbox", {})).counts.failure).toBe(1);
	});
});

test("report --shard sends which shard of its job a report is, and the gate names the shards it waits for", async () => {
	await withInstance(async ({ run }) => {
		const sent = await run(["report", RED_XML, "--commit", COMMIT, "--job", "tests", "--shard", "1/2"]);
		expect(sent.code).toBe(0);
		expect(sent.stdout).toContain("job tests  shard 1/2");
		expect(sent.stdout).toContain(
			"blocked: 1 failure unexplained, 1 question open; still waiting for shard 2 of 2 of job tests",
		);
		const gate = await run(["gate", "--commit", COMMIT, "--json"]);
		expect(JSON.parse(gate.stdout)).toMatchObject({
			verdict: "blocked",
			waiting: [{ job: "tests", missing: [2], of: 2 }],
		});
		const wrong = await run(["report", RED_XML, "--commit", COMMIT, "--shard", "2of2"]);
		expect(wrong.code).toBe(4);
		expect(wrong.stderr).toContain("--shard takes index/count, for example 2/6");
	});
});

test("CI can declare nothing required and a recorded policy choice controls the gate exit code", async () => {
	await withInstance(
		async ({ cli, run, client }) => {
			const pipeline = z.object({ token: z.string() }).parse(
				await client.call("admin", {
					do: "token.create",
					actor: "pipeline",
					kind: "ci",
					project: "scratch",
					can: ["read", "record"],
				}),
			);
			const env = { MAINWORTHY_TOKEN: pipeline.token };
			const sent = await cli(["report", "--nothing-required", "--commit", COMMIT], { env });
			expect(sent.code).toBe(0);
			expect(sent.stdout).toContain("  0 results   0 pass   0 fail   0 skip");
			expect(sent.stdout).toContain("  0 results had no case or version when recorded\n  basis: none\n");
			expect(sent.stdout).toContain("pending:");
			expect((await run(["gate", "--commit", COMMIT], { env })).code).toBe(3);
			const changed = await run(["policy", "empty", "nothing-required"]);
			expect(changed.code).toBe(0);
			expect(changed.stdout).toContain("empty reports: nothing-required; proposal");
			expect(changed.stdout).toContain("are both recorded");
			const passed = await run(["gate", "--commit", COMMIT], { env });
			expect(passed.code).toBe(0);
			expect(passed.stdout).toContain("the pipeline declared nothing required under the project's policy");
			expect((await run(["policy", "show"])).stdout).toContain("empty reports: nothing-required");
			expect((await run(["policy", "empty", "always"])).code).toBe(4);
			expect((await run(["report", RED_XML, "--nothing-required", "--commit", COMMIT], { env })).code).toBe(4);
			expect((await run(["policy", "use", "standard"])).code).toBe(0);
			expect((await run(["gate", "--commit", COMMIT], { env })).code).toBe(3);
		},
		{ mode: "server" },
	);
});

test("policy tests changes what happens to a test with no case, and says how many open questions the rule answered", async () => {
	await withInstance(async ({ run, client }) => {
		const asking = await run(["policy", "tests", "ask"]);
		expect(asking.stdout).toMatch(/^tests with no case: ask; proposal P-1 and decision \d+ are both recorded\n$/);
		for (const file of ["tests/a.spec.ts", "tests/b.spec.ts"])
			await client.call("report", {
				target: { commit: "cafe0001", branch: "main" },
				job: file,
				results: [{ test: { key: `${file}::one`, file }, outcome: "pass" }],
			});
		expect((await client.call("inbox", {})).counts.map).toBe(2);
		const tracking = await run(["policy", "tests", "track"]);
		expect(tracking.code).toBe(0);
		expect(tracking.stdout).toContain("tests with no case: track;");
		expect(tracking.stdout).toEndWith("; 2 open questions answered by the rule\n");
		expect((await client.call("inbox", {})).counts.open).toBe(0);
		// The choice is not the preset: the project is still `loose`.
		expect(await client.call("admin", { do: "project.list" })).toMatchObject([{ policy: "loose", unlinked: "track" }]);
		const wrong = await run(["policy", "tests", "sometimes"]);
		expect(wrong.code).not.toBe(0);
		expect(wrong.stderr).toContain("policy tests needs ask, track or create");
	});
});

test("outline stdin, get --md, and fmt round trip the canonical case", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		const created = await cli(["new", "-"], {
			input: "Coupon applies\n  Open the cart > One item\n  Apply SAVE10 > Total is 90.00\n",
		});
		expect(created.code).toBe(0);
		expect(created.stdout).toBe("C-1\n");
		const got = await run(["get", "C-1", "--md"]);
		expect(got.code).toBe(0);
		expect(got.stdout).toContain("title: Coupon applies");
		expect(got.stdout).toContain("id: C-1");
		const file = join(directory, "case.md");
		await writeFile(file, got.stdout);
		const fmt = await run(["fmt", file]);
		expect(fmt.code).toBe(0);
		expect(fmt.stdout).toBe(got.stdout);
		expect((await run(["get", "--refs", "C-1", "--fields", "title", "--compact"])).stdout.trim()).not.toContain("\n");
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
	await withInstance(async ({ run }) => {
		expect((await run(["check"])).code).toBe(0);
		await run(["new"], { input: "An incomplete case\n  Do something\n" });
		const result = await run(["check"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("no-expected (1)");
		expect(result.stdout).toContain("C-1");
	});
});

for (const suffix of [".mainworthy", ".mainworthy.gz"]) {
	test(`export/import${suffix} preserves the case list in a fresh running instance`, async () => {
		await withInstance(async (source) => {
			const created = await source.run(["new", "--json"], {
				input: "Coupon applies\n  Apply SAVE10 > Total is 90.00\n",
			});
			expect(outputWith(Created, created).cases[0]?.ref).toBe("C-1");
			const archive = join(source.directory, `export${suffix}`);
			expect((await source.run(["export", "--out", archive])).code).toBe(0);
			await withInstance(async (target) => {
				const imported = await target.run(["import", archive]);
				expect(imported.stderr).toBe("");
				expect(imported.code).toBe(0);
				expect(imported.stdout).toContain("previous session may no longer exist");
				expect(outputWith(Found, await target.run(["find"]))).toEqual(outputWith(Found, await source.run(["find"])));
				const md = await target.run(["get", "C-1", "--md"]);
				expect(md.stdout).toBe((await source.run(["get", "C-1", "--md"])).stdout);
			});
		});
	});
}

// The command's help for each operation is asked of `runCli` in this process: one real start for `help`, and the
// hundred more a start for each operation took are 0.001 s each. Started one after another, as processes, they took
// 3.6 to 4.2 s on a CI runner and ran into the default five seconds twice on `main` on 2026-10-13 (issue #154).
test("all registry operations have generated commands, global help and --help", async () => {
	await withInstance(async ({ cli, run }) => {
		const help = await cli(["help"]);
		expect(help.code).toBe(0);
		const adapters = await Promise.all([...ADAPTER_COMMANDS.values()].map((load) => load()));
		expect([...ADAPTER_COMMANDS.keys()]).toEqual(adapters.map((command) => command.name));
		const helps = await Promise.all(OP_LIST.map((op) => run([op.name, "--help"])));
		for (const [index, op] of OP_LIST.entries()) {
			expect(COMMAND_NAMES.has(op.name)).toBe(true);
			expect(GENERATED_COMMANDS.has(op.name)).toBe(true);
			expect(help.stdout).toContain(op.summary);
			const result = helps[index];
			expect([op.name, result?.code]).toEqual([op.name, 0]);
			expect(result?.stdout).toContain(op.summary);
			expect(result?.stdout).toContain("--json");
		}
	});
});

// `run` stands in for `cli` in most of this file, so this is the test that holds the two together: the same
// argument vectors, environments and standard input give the same output and exit code in the process and in
// the executable. Each case is one that leaves the instance as it was, so the second run sees what the first did.
test("run in the test's process gives what the executable gives", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		// A file named from the working directory: read from there by both, or the two answers differ.
		await mkdir(join(directory, "cases"));
		await writeFile(join(directory, "cases", "invalid.md"), "---\ntitle: Broken\n");
		const ci = { GITHUB_ACTIONS: "true", GITHUB_SHA: COMMIT, GITHUB_REF_NAME: "main", GITHUB_JOB: "e2e" };
		const cases: [string[], { input?: string; env?: Record<string, string>; cwd?: string }?][] = [
			[["health"]],
			[["policy", "show"]],
			[["check"]],
			[["find", "--limit", "oops"]],
			[["get", "C-999"]],
			[["fmt", "invalid.md"], { cwd: join(directory, "cases") }],
			[["open"]],
			[["new"], { input: "  \n" }],
			[["report", RED_XML], { env: { MAINWORTHY_PROJECT: "scratch" }, cwd: tmpdir() }],
			[["gate", "--wait", "0.02", "--json"], { env: ci }],
			[["find", "--url", "http://127.0.0.1:1"]],
			[["frobnicate"]],
		];
		const both = await Promise.all(
			cases.map(async ([argv, options]) => ({
				argv: argv.join(" "),
				executable: await cli(argv, options),
				here: await run(argv, options),
			})),
		);
		for (const { argv, executable, here } of both) expect({ argv, ...here }).toEqual({ argv, ...executable });
		expect(both.map((result) => result.here.code)).toEqual([0, 0, 0, 4, 4, 4, 0, 4, 4, 3, 4, 4]);
		expect(process.env.MAINWORTHY_URL).toBeUndefined();
	});
});

// `run` returns what a command writes through `process.stdout.write` and `process.stderr.write`, so the command line
// must reach the terminal through them and by no other way. This reads the source as text and holds it to that: only
// the output module, the error printer and the two commands that print a case as it is name the process's streams;
// nothing names another way to the terminal; and only the code that asks git for the commit starts a process. It is
// strict (a comment that names one of these fails too) and it knows only the ways listed: the tests that start the
// executable are what proves its output, and `run` is a sample of it.
test("the command line reaches the terminal only through the two write functions that run reads", async () => {
	const streams = ["output.ts", "errors.ts", "commands/fmt.ts", "commands/get.ts"];
	const rules: { what: string; pattern: RegExp; allowed: string[] }[] = [
		{ what: "the process's streams", pattern: /\bprocess\s*\.\s*std(out|err)\b/, allowed: streams },
		{ what: "console", pattern: /\bconsole\b/, allowed: [] },
		{ what: "Bun's streams", pattern: /\bBun\s*\.\s*std(out|err)\b/, allowed: [] },
		{ what: "a device file", pattern: /\/dev\/(std(out|err)|fd\/|tty)/, allowed: [] },
		{
			what: "a write to a descriptor",
			pattern: /\b(writev?Sync|createWriteStream)\b|\bfs\s*\.\s*writev?\b/,
			allowed: [],
		},
		{
			what: "a child process",
			pattern: /\bchild_process\b|\bBun\s*\.\s*spawn|\bspawn(Sync)?\s*\(/,
			allowed: ["target.ts"],
		},
		{ what: "a child that inherits the streams", pattern: /["'`]inherit["'`]/, allowed: [] },
	];
	const found: string[] = [];
	for await (const file of new Glob("**/*.ts").scan({ cwd: import.meta.dir })) {
		if (file.endsWith(".test.ts") || file === "test-support.ts") continue;
		const lines = (await Bun.file(join(import.meta.dir, file)).text()).split("\n");
		for (const [index, text] of lines.entries())
			for (const rule of rules)
				if (rule.pattern.test(text) && !rule.allowed.includes(file))
					found.push(`src/cli/${file}:${index + 1} names ${rule.what}`);
	}
	expect(found).toEqual([]);
});

// Two things a process gives and a call in the test's process cannot: its output is complete when it exits, and it
// can be stopped. `inThisProcess` keeps each from passing silently.
test("a command that writes after it ended, or outlives its time, fails where it was run in the process", async () => {
	const given = { environment: { PATH: process.env.PATH ?? "" }, cwd: tmpdir(), input: "" };
	const before = { home: process.env.HOME, cwd: process.cwd() };
	const quiet = () => inThisProcess("quiet", async () => 0, given);
	const untouched = () => expect({ home: process.env.HOME, cwd: process.cwd() }).toEqual(before);

	// Written after the command ended. The executable would have printed it; the next command says so, once.
	const answered = await inThisProcess(
		"late",
		async () => {
			setTimeout(() => process.stderr.write("written late\n"), 5);
			return 0;
		},
		given,
	);
	expect(answered).toEqual({ stdout: "", stderr: "", code: 0 });
	await Bun.sleep(20);
	await expect(quiet()).rejects.toThrow(
		'a command wrote after it had ended, which run did not return: "written late\\n"',
	);
	expect(await quiet()).toEqual({ stdout: "", stderr: "", code: 0 });

	// One that outlives its time cannot be stopped as a child is. It is refused, and so is the next, until it ends.
	let end = (): void => {};
	const slow = new Promise<number>((resolve) => {
		end = () => resolve(0);
	});
	await expect(inThisProcess("slow", () => slow, { ...given, limitMs: 20 })).rejects.toThrow(
		"slow did not finish in 0.02 s",
	);
	untouched();
	await expect(quiet()).rejects.toThrow("slow ran out of its time earlier and is still running in this process");
	end();
	await slow;
	expect(await quiet()).toEqual({ stdout: "", stderr: "", code: 0 });

	// A directory that is not there fails before the command starts, and leaves the process as it was.
	await expect(
		quiet().then(() => inThisProcess("nowhere", async () => 0, { ...given, cwd: join(tmpdir(), "mainworthy-absent") })),
	).rejects.toThrow();
	untouched();
	expect(await quiet()).toEqual({ stdout: "", stderr: "", code: 0 });
});

test("generated flags handle booleans, numbers, repeated arrays and union fields", async () => {
	await withInstance(async ({ run }) => {
		await run(["new"], { input: "Coupon applies\n  Apply SAVE10 > Total is 90.00\n" });
		const result = await run([
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
		const admin = await run(["admin", "--do", "project.list"]);
		expect(admin.code).toBe(0);
		expect(admin.stdout).toContain('"key": "scratch"');
		const bad = await run(["find", "--limit", "oops"]);
		expect(bad.code).toBe(4);
		expect(bad.stderr).toContain("--limit needs a number");
	});
});

test("project ambiguity names the projects; command-line project overrides environment", async () => {
	await withInstance(async ({ run, client }) => {
		await client.call("admin", { do: "project.create", key: "other" });
		const ambiguous = await run(["find"]);
		expect(ambiguous.code).toBe(4);
		expect(ambiguous.stderr).toContain("scratch, other");
		const chosen = await run(["--project", "scratch", "find"], { env: { MAINWORTHY_PROJECT: "absent" } });
		expect(chosen.code).toBe(0);
	});
});

test("connection and operation errors are single-line diagnostics with exit 4", async () => {
	await withInstance(async ({ run }) => {
		const unreachable = await run(["find", "--url", "http://127.0.0.1:1"]);
		expect(unreachable.code).toBe(4);
		expect(unreachable.stderr).toContain("start the server with mainworthy serve");
		expect(unreachable.stderr.trim().split("\n")).toHaveLength(1);
		const missing = await run(["get", "C-999"]);
		expect(missing.code).toBe(4);
		expect(missing.stderr).toContain("not_found:");
		expect(missing.stderr.trim().split("\n")).toHaveLength(1);
	});
});

test("connection diagnostics and health output omit URL credentials from flags and the environment", async () => {
	await withInstance(async ({ cli, run }) => {
		const url = "http://robin:synthetic-url-password@127.0.0.1:1";
		const stderr = "connection: cannot connect to http://127.0.0.1:1; start the server with mainworthy serve\n";
		expect(await cli(["find", "--url", url])).toEqual({ code: 4, stdout: "", stderr });
		expect(await run(["find"], { env: { MAINWORTHY_URL: url } })).toEqual({ code: 4, stdout: "", stderr });
		expect(await run(["health", "--url", url])).toEqual({
			code: 1,
			stdout: "not answering: http://127.0.0.1:1\n",
			stderr: "",
		});
		const health = await run(["health", "--json"], { env: { MAINWORTHY_URL: url } });
		expect(JSON.parse(health.stdout)).toEqual({
			url: "http://127.0.0.1:1",
			healthy: false,
			version: null,
			commit: null,
			apiVersion: null,
			compatible: false,
		});
		expect(health.code).toBe(1);
		for (const [address, shown] of [
			["http://robin@127.0.0.1:1", "http://127.0.0.1:1"],
			["http://:synthetic-url-password@127.0.0.1:1", "http://127.0.0.1:1"],
			["http://robin:p%40ss%3Aword@[::1]:1/base?x=1#anchor", "http://[::1]:1/base?x=1#anchor"],
		] satisfies [string, string][]) {
			const result = await run(["find", "--url", address]);
			expect(result).toEqual({
				code: 4,
				stdout: "",
				stderr: `connection: cannot connect to ${shown}; start the server with mainworthy serve\n`,
			});
		}
	});
});

test("passed/failed/blocked/pending gate exit codes stay distinct", async () => {
	await withInstance(async ({ run }) => {
		const pending = await run(["gate", "--commit", COMMIT, "--wait", "0.02", "--json"]);
		expect(pending.code).toBe(3);
		expect(pending.stdout).toContain('"verdict": "pending"');
		await run(["report", RED_XML, "--commit", COMMIT]);
		const question = outputWith(Inbox, await run(["inbox", "--kind", "failure"])).items[0];
		if (!question) throw new Error("no failure question");
		await run([
			"decide",
			"--json",
			JSON.stringify({ q: question.q, onEvidence: question.evidenceHash, answer: { is: "defect" } }),
		]);
		const failed = await run(["gate", "--commit", COMMIT]);
		expect(failed.code).toBe(1);
		expect(failed.stdout).toContain("failed:");
	});
});

test("health exits 0 when the server answers and 1 when nothing does, with no token", async () => {
	await withInstance(async ({ cli, run, instance }) => {
		const up = await run(["health"]);
		expect(up.code).toBe(0);
		expect(up.stdout).toBe(`healthy: Mainworthy 0.1.0 at ${instance.url}\n`);
		const down = await cli(["health", "--url", "http://127.0.0.1:9"]);
		expect(down.code).toBe(1);
		expect(down.stdout).toBe("not answering: http://127.0.0.1:9\n");
	});
	// Loopback refuses port 9 at once, but `health` gives an address that does not answer 2.5 s (its own limit in
	// `commands/health.ts`) before it says so, and a network that drops the packet instead would use all of it.
}, 20_000);

test("health prints the first 12 characters of the commit the server reports, and all of it with --json", async () => {
	const sha = "2f6b67e1ac063e6ac29c9fe45fdae07137b81c76";
	await withInstance(
		async ({ run, instance }) => {
			const text = await run(["health"]);
			expect(text.code).toBe(0);
			expect(text.stdout).toBe(`healthy: Mainworthy 0.1.0 (commit ${sha.slice(0, 12)}) at ${instance.url}\n`);
			const json = await run(["health", "--json"]);
			expect(JSON.parse(json.stdout)).toEqual({
				url: instance.url,
				healthy: true,
				version: "0.1.0",
				commit: sha,
				apiVersion: 1,
				compatible: true,
			});
		},
		{ env: { MAINWORTHY_COMMIT: sha } },
	);
});

test("health stays compatible with a server that reports no commit", async () => {
	// An older server answers `{"ok":true,"version":"0.1.0"}`; a newer one with no commit answers `"commit":null`.
	const answers = [
		{ ok: true, version: "0.1.0" },
		{ ok: true, version: "0.1.0", commit: null },
	];
	for (const body of answers) {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(body) });
		try {
			await withInstance(async ({ run }) => {
				const url = `http://127.0.0.1:${server.port}`;
				const text = await run(["health", "--url", url]);
				expect(text.code).toBe(0);
				expect(text.stdout).toBe(`healthy: Mainworthy 0.1.0 at ${url}\n`);
				const json = await run(["health", "--url", url, "--json"]);
				expect(JSON.parse(json.stdout)).toEqual({
					url,
					healthy: true,
					version: "0.1.0",
					commit: null,
					apiVersion: null,
					compatible: false,
				});
			});
		} finally {
			await server.stop(true);
		}
	}
});

test("open prints the running web UI URL", async () => {
	await withInstance(async ({ run, instance }) => {
		const result = await run(["open"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`${instance.url}\n`);
	});
});

test("gate --wait observes evidence that arrives while it is polling", async () => {
	await withInstance(async ({ run, client }) => {
		const waiting = run(["gate", "--commit", COMMIT, "--wait", "1.5"]);
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
	await withInstance(async ({ run }) => {
		const result = await run(["gate", "--json", JSON.stringify({ commit: COMMIT }), "--compact"]);
		expect(result.code).toBe(3);
		expect(result.stdout).toContain('"verdict":"pending"');
	});
});

test("a generated command refuses a reply its operation's schema does not describe, as the adapter does", async () => {
	const gate = {
		run: null,
		verdict: "blocked",
		reason: "blocked: one open",
		tally: {},
		open: [],
		url: null,
		stale: false,
	};
	const { reason: _reason, ...withoutReason } = gate;
	let reply: unknown = gate;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			if (new URL(req.url).pathname === "/healthz")
				return Response.json({ ok: true, version: "0.1.0", apiVersion: API_VERSION });
			return reply instanceof Response ? reply.clone() : Response.json({ ok: true, result: reply, seq: 1 });
		},
	});
	try {
		await withInstance(async ({ run }) => {
			const base = ["--url", `http://127.0.0.1:${server.port}`, "--project", "scratch"];
			const json = ["gate", "--json", JSON.stringify({ commit: "c0ffee01" }), ...base];
			reply = gate;
			const readable = await run(json);
			expect([readable.code, readable.stderr]).toEqual([2, ""]);
			for (const [what, unreadable] of [
				["a result that is no gate", "blocked"],
				["a missing field", { verdict: "blocked" }],
				["a missing reason", withoutReason],
				["an unknown verdict", { ...gate, verdict: "maybe" }],
				["an envelope that is no envelope", new Response("proxy page")],
			] as const) {
				reply = unreadable;
				const result = await run(json);
				expect([what, result.code, result.stdout]).toEqual([what, 4, ""]);
				expect(result.stderr).toContain(
					unreadable instanceof Response
						? "the server returned an invalid response (HTTP 200)"
						: "internal: the server returned invalid gate data",
				);
				const human = await run(["gate", "--commit", "c0ffee01", ...base]);
				expect([what, human.code]).toEqual([what, 4]);
				expect(human.stderr).toBe(result.stderr);
			}
			reply = {};
			const find = await run(["find", "--json", "{}", ...base]);
			expect([find.code, find.stdout]).toEqual([4, ""]);
			expect(find.stderr).toContain("internal: the server returned invalid find data");
		});
	} finally {
		await server.stop(true);
	}
});

test("policy use checks the caller's project permission, including a scoped admin token", async () => {
	await withInstance(async ({ run, client }) => {
		const token = Token.parse(
			await client.call("admin", {
				do: "token.create",
				actor: "maintainer",
				kind: "human",
				can: ["read", "produce", "answer", "admin"],
				project: "scratch",
			}),
		).token;
		const changed = await run(["policy", "use", "standard"], { env: { MAINWORTHY_TOKEN: token } });
		expect(changed.code).toBe(0);
		expect(changed.stdout).toContain("both recorded");
		expect((await run(["policy", "show"])).stdout).toContain("policy: standard");
	});
});

test("policy use keeps an acceptance refusal's status and needs", async () => {
	await withInstance(async ({ client, cli, run }) => {
		const policy = Policy.extend({ version: z.number() }).parse(
			await client.call("admin", { do: "policy.show", project: "scratch" }),
		);
		await client.call("propose", {
			edits: [
				{
					op: "policy",
					base: policy.version,
					clauses: [
						{
							id: "accept-policy",
							kind: "adopt",
							when: ["policy", "answer:accept"],
							ask: { who: "admin", agents: "none", notProducer: true, reason: "optional" },
							blocks: "nothing",
						},
						...policy.clauses,
					],
				},
			],
		});
		const adoption = (await client.call("inbox", { kind: "adopt" })).items[0];
		if (!adoption) throw new Error("missing policy adoption");
		await client.call("decide", { q: adoption.q, onEvidence: adoption.evidenceHash, answer: { is: "accept" } });
		const refused = await cli(["policy", "use", "standard", "--json"]);
		expect(refused.code).toBe(4);
		expect(JSON.parse(refused.stdout)).toMatchObject({
			decision: [{ status: "forbidden", needs: "an admin who did not produce the evidence who is not an agent" }],
		});
		expect(refused.stderr).toBe("forbidden: an admin who did not produce the evidence who is not an agent\n");
		const text = await run(["policy", "use", "standard"]);
		expect(text.code).toBe(4);
		expect(text.stderr).toBe("forbidden: an admin who did not produce the evidence who is not an agent\n");
		expect(Policy.parse(await client.call("admin", { do: "policy.show", project: "scratch" })).clauses).toEqual([
			{
				id: "accept-policy",
				kind: "adopt",
				when: ["policy", "answer:accept"],
				ask: { who: "admin", agents: "none", notProducer: true, reason: "optional" },
				blocks: "nothing",
			},
			...policy.clauses,
		]);
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

test("native Playwright JSON reaches the same report operation as JUnit", async () => {
	await withInstance(async ({ cli }) => {
		const file = new URL("../../test/fixtures/reports/playwright.json", import.meta.url).pathname;
		const result = await cli(["report", file, "--commit", COMMIT, "--json"]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).counts).toEqual({ total: 4, pass: 2, fail: 1, skip: 1, error: 0, blocked: 0 });
	});
});

test("all native formats use the real report receipt, preserve unlinked tests, and reject bad inputs without writes", async () => {
	await withInstance(async ({ run, instance, directory }) => {
		const reportFile = (name: string) => new URL(`../../test/fixtures/reports/${name}`, import.meta.url).pathname;
		const native = ["jest.json", "vitest.json", "pytest.json", "sample.trx"];
		for (const file of native) {
			const result = await run(["report", reportFile(file), "--commit", COMMIT, "--job", file, "--json"]);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			const receipt = JSON.parse(result.stdout);
			expect(receipt.counts.total).toBe(file === "pytest.json" ? 4 : 3);
			expect(receipt.counts.fail).toBe(1);
			expect(receipt.unlinked).toBe(file === "pytest.json" ? 4 : 3);
			const repeated = await run(["report", reportFile(file), "--commit", COMMIT, "--job", file, "--json"]);
			expect(repeated.code).toBe(0);
			expect(JSON.parse(repeated.stdout).fresh).toBe(false);
		}
		const bad = join(directory, "bad.json");
		await writeFile(bad, '{"testResults":null}');
		for (const argv of [
			["report", reportFile("playwright.json"), bad, "--commit", COMMIT],
			["report", reportFile("jest.json"), "--format", "pytest", "--commit", COMMIT],
			["report", reportFile("jest.json"), "--format", "not-a-format", "--commit", COMMIT],
		]) {
			const result = await run(argv);
			expect(result.code).toBe(4);
			expect(result.stderr).toContain("invalid:");
		}
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM batches").get()?.n).toBe(4);
		const mixed = await run([
			"report",
			RED_XML,
			reportFile("jest.json"),
			"--commit",
			COMMIT,
			"--job",
			"mixed",
			"--json",
		]);
		expect(mixed.code).toBe(0);
		expect(JSON.parse(mixed.stdout).counts.total).toBe(5);
		const explicit = await run([
			"report",
			reportFile("vitest.json"),
			"--format",
			"vitest",
			"--commit",
			COMMIT,
			"--job",
			"explicit",
			"--json",
		]);
		expect(explicit.code).toBe(0);
		expect(JSON.parse(explicit.stdout).counts.total).toBe(3);
	});
});

test("an adapter rejects operation flags it cannot translate", async () => {
	await withInstance(async ({ run }) => {
		await run(["new"], { input: "Coupon applies\nApply SAVE10 > Total is 90.00" });
		for (const argv of [
			["get", "C-1", "--fields", "title"],
			["report", RED_XML, "--commit", COMMIT, "--cmd", "explicit-key"],
		]) {
			const result = await run(argv);
			expect(result.code).toBe(4);
			expect(result.stderr).toContain("operation flag");
			expect(result.stderr).toContain("--json");
		}
	});
});

test("empty case input exits 4 and writes no case", async () => {
	await withInstance(async ({ run, client }) => {
		const result = await run(["new"], { input: "  \n" });
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("outline");
		expect((await client.call("find", {})).items).toEqual([]);
	});
});

test("schema errors are readable single-line diagnostics", async () => {
	await withInstance(async ({ run }) => {
		const result = await run(["token", "revoke", "abc"]);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("id:");
		expect(result.stderr).not.toContain("[;");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
	});
});

test("corrupt gzip is an archive error while the server remains reachable", async () => {
	await withInstance(async ({ run, directory }) => {
		const file = join(directory, "invalid.mainworthy.gz");
		await writeFile(file, "this is not gzip");
		const result = await run(["import", file]);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("invalid gzip archive");
		expect(result.stderr).not.toContain("start the server");
		expect((await run(["open"])).code).toBe(0);
	});
});

test("malformed server data is refused before an adapter reads it", async () => {
	await withInstance(
		async ({ run }) => {
			const result = await run(["report", RED_XML, "--commit", COMMIT]);
			expect(result.code).toBe(4);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("internal: the server returned invalid report data");
		},
		{ routes: { "/api/p/scratch/report": () => new Response(JSON.stringify({ ok: true, result: {}, seq: 1 })) } },
	);
});

test("a generated decision batch prints its successful and refused items before exiting 4", async () => {
	await withInstance(async ({ run, client }) => {
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
		const result = await run([
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
	await withInstance(async ({ run }) => {
		const result = await run(["gate", "--json", JSON.stringify({ commit: COMMIT }), "--wait", "1"]);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("cannot be combined");
	});
});

test("an HTTP 200 proxy page cannot replace an existing export", async () => {
	await withInstance(
		async ({ run, directory }) => {
			const file = join(directory, "backup.mainworthy");
			await writeFile(file, "previous backup");
			const result = await run(["export", "--out", file]);
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
	await withInstance(async ({ run, directory }) => {
		const file = join(directory, "declined.xml");
		await writeFile(
			file,
			'<testsuite name="unknown"><testcase name="test @C-999@v1"><failure message="failed"/></testcase></testsuite>',
		);
		const report = await run(["report", file, "--commit", COMMIT]);
		expect(report.code).toBe(0);
		expect(report.stdout).toContain("  1 case/version claim declined; 1 result kept without a case\n");
		expect(report.stderr).toContain("C-999");
		expect(report.stderr.trim().split("\n")).toHaveLength(1);
		expect((await run(["gate", "--commit", COMMIT])).code).toBe(2);
		await writeFile(
			file,
			'<testsuite name="unknown"><testcase name="first @C-999@v1"><failure message="failed"/></testcase><testcase name="second @C-998@v1" /></testsuite>',
		);
		const two = await run(["report", file, "--commit", COMMIT]);
		expect(two.code).toBe(0);
		expect(two.stdout).toContain("  2 case/version claims declined; 2 results kept without a case\n");
		expect(two.stderr.trim().split("\n")).toHaveLength(2);
	});
});

test("report receipt counts skipped attachments separately from kept results", async () => {
	await withInstance(async ({ cli, run, directory }) => {
		const file = join(directory, "attachments.xml");
		const one = '<testcase name="one"><system-out>[[ATTACHMENT|missing.png]]</system-out></testcase>';
		await writeFile(file, `<testsuite>${one}</testsuite>`);
		const first = await cli(["report", file, "--session", "one skipped"]);
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("  1 attachment skipped; 1 result kept\n");
		expect(first.stderr).toContain("Attachment markers ignored");
		await writeFile(file, `<testsuite>${one}<testcase name="two" /></testsuite>`);
		const twoResults = await run(["report", file, "--session", "one skipped two results"]);
		expect(twoResults.code).toBe(0);
		expect(twoResults.stdout).toContain("  1 attachment skipped; 2 results kept\n");
		await writeFile(file, `<testsuite>${one}${one.replace('name="one"', 'name="two"')}</testsuite>`);
		const two = await run(["report", file, "--session", "two skipped"]);
		expect(two.code).toBe(0);
		expect(two.stdout).toContain("  2 attachments skipped; 2 results kept\n");
		const machine = await run(["report", file, "--session", "two skipped", "--json"]);
		expect(machine.code).toBe(0);
		expect(JSON.parse(machine.stdout)).toMatchObject({ counts: { total: 2 }, skippedAttachments: 2, fresh: false });
	});
});

test("JSON input accepts leading whitespace and newlines", async () => {
	await withInstance(async ({ run }) => {
		const result = await run(["find", "--json", '\n  {"in":"cases","limit":1}\n']);
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
		expect((await source.run(["export", "--out", file])).code).toBe(0);
		await withInstance(
			async ({ run, client }) => {
				for (const token of ["", "unknown-token"]) {
					const result = await run(["import", file], { env: { MAINWORTHY_TOKEN: token } });
					expect(result.code).toBe(4);
					expect(result.stderr).toContain("unauthenticated:");
					expect(result.stderr).not.toContain("invalid gzip");
				}
				const token = Token.parse(
					await client.call("admin", { do: "token.create", actor: "pipeline", kind: "ci", can: ["read", "record"] }),
				).token;
				const denied = await run(["import", file], { env: { MAINWORTHY_TOKEN: token } });
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
	await withInstance(async ({ run, instance }) => {
		const empty = { MAINWORTHY_URL: "", MAINWORTHY_TOKEN: "", MAINWORTHY_PROJECT: "" };
		// No address named: the server on this machine, at its port.
		const health = await run(["health", "--json"], { env: { ...empty, MAINWORTHY_PORT: new URL(instance.url).port } });
		expect(health.stderr).toBe("");
		expect(JSON.parse(health.stdout)).toMatchObject({ healthy: true });
		// An empty port is no port either: the built-in one, whether or not anything listens there.
		const port = await run(["health", "--json"], { env: { ...empty, MAINWORTHY_PORT: "" } });
		expect(JSON.parse(port.stdout)).toMatchObject({ url: "http://127.0.0.1:7357" });
		// No token and no project named: the local session and the only project.
		const inbox = await run(["inbox", "--json", "{}", "--url", instance.url], { env: empty });
		expect(inbox.stderr).toBe("");
		expect(inbox.code).toBe(0);
	});
});

const Seeded = z.object({ project: z.string(), cases: z.number(), run: z.string(), questions: z.array(z.string()) });
const Projects = z.array(z.object({ key: z.string(), seq: z.number(), policy: z.string() }));
const Actors = z.array(
	z.object({ name: z.string(), grants: z.array(z.object({ project: z.string(), can: z.array(z.string()) })) }),
);
const Tokens = z.array(z.object({ actor: z.string(), expiresAt: z.number().nullable() }));
const projects = async (client: Client) => Projects.parse(await client.call("admin", { do: "project.list" }));
const grantsOf = async (client: Client, actor: string) =>
	Actors.parse(await client.call("admin", { do: "actor.list" })).find((row) => row.name === actor)?.grants;
const casesIn = async (client: Client, project: string) =>
	(await new Client({ ...client.options, project }).call("find", { limit: 500 })).items.length;

test("seed fills a project it makes, and leaves its pipeline and agent nothing outside it or after an hour", async () => {
	await withInstance(async ({ run, client, instance }) => {
		const started = Date.now();
		const result = await run(["seed", "demo", "--cases", "12"]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		// The failing test on `main` and on the pull request, the agent's finding and its edit, a test with no case,
		// and the shop's unit tests: sixty files that no case names, one question each.
		expect(result.stdout).toMatch(/^seeded demo: 12 cases, run R-\d+, 65 questions\n/);
		expect(result.stdout).toEndWith(`${instance.url}/p/demo/suite\n`);
		expect(await casesIn(client, "demo")).toBe(12);
		expect((await projects(client)).find((project) => project.key === "demo")?.policy).toBe("standard");
		// The project the instance started with is not the one that was named.
		expect(await casesIn(client, "scratch")).toBe(0);
		expect(await grantsOf(client, "pipeline")).toEqual([{ project: "demo", can: ["read", "record"] }]);
		expect((await grantsOf(client, "reviewer"))?.map((grant) => grant.project)).toEqual(["demo"]);
		const tokens = Tokens.parse(await client.call("admin", { do: "token.list" }));
		expect(tokens.map((token) => token.actor).sort()).toEqual(["pipeline", "reviewer"]);
		for (const token of tokens) {
			expect(token.expiresAt).toBeGreaterThan(started);
			expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
		}
		// The demo keeps the queue a first real project has: many rows that want one answer. They are distinct
		// files in a believable tree, and one change of the project's choice answers them all.
		const demo = new Client({ ...client.options, project: "demo" });
		const unlinked = (await demo.call("inbox", { kind: "map", limit: 500 })).items;
		expect(unlinked).toHaveLength(61);
		const files = unlinked.map((item) => z.object({ file: z.string() }).parse(item.evidence).file);
		expect(new Set(files).size).toBe(61);
		expect(files.filter((file) => file.startsWith("tests/unit/"))).toHaveLength(60);
		const choice = await demo.call("propose", { edits: [{ op: "policy", unlinked: "track" }] });
		const asked = (await demo.call("inbox", { kind: "adopt", on: choice.proposal ?? "" })).items[0];
		const tracked = await demo.call("decide", {
			q: asked?.q ?? "",
			onEvidence: asked?.evidenceHash ?? "",
			answer: { is: "accept" },
		});
		expect(tracked[0]?.effects).toMatchObject({ ruled: 61 });
		expect((await demo.call("inbox", {})).counts).toMatchObject({ open: 4, failure: 2 });
	});
});

test("seed sent again writes nothing twice, and a second project is seeded beside the first", async () => {
	await withInstance(async ({ run, client }) => {
		const first = outputWith(Seeded, await run(["seed", "demo", "--cases", "12", "--json"]));
		const seq = (await projects(client)).find((project) => project.key === "demo")?.seq;
		const again = await run(["seed", "demo", "--cases", "12", "--json"]);
		expect(again.code).toBe(0);
		expect(outputWith(Seeded, again)).toEqual(first);
		expect(await casesIn(client, "demo")).toBe(12);
		expect((await projects(client)).find((project) => project.key === "demo")?.seq).toBe(seq);
		// Another count is another request: it is refused in words about the seed, and adds no case.
		const other = await run(["seed", "demo", "--cases", "20"]);
		expect(other.code).toBe(4);
		expect(other.stderr).toContain("was seeded with another number of cases");
		expect(await casesIn(client, "demo")).toBe(12);
		// The command ids and the two actors of the first seed do not stand in the way of a second project.
		// It takes two files of unit tests where the first took sixty: the five questions and two more.
		const beside = await run(["seed", "demo-2", "--cases", "3", "--unlinked-files", "2", "--json"]);
		expect(beside.stderr).toBe("");
		expect(outputWith(Seeded, beside)).toMatchObject({ project: "demo-2", cases: 3 });
		expect(outputWith(Seeded, beside).questions).toHaveLength(7);
		expect((await grantsOf(client, "pipeline"))?.map((grant) => grant.project)).toEqual(["demo", "demo-2"]);
		expect(await casesIn(client, "demo")).toBe(12);
	});
});

test("seed leaves alone a project that holds work, a name it was not given, and a count it cannot write", async () => {
	await withInstance(async ({ run, client }) => {
		await run(["new"], { input: "Coupon applies\nApply SAVE10 > Total is 90.00" });
		const held = await run(["seed", "scratch"]);
		expect(held.code).toBe(4);
		expect(held.stderr).toContain("project scratch already holds cases, tests or runs");
		// The project a pipeline reports to is in MAINWORTHY_PROJECT: seed does not read it, and refuses the flag.
		const unnamed = await run(["seed"], { env: { MAINWORTHY_PROJECT: "scratch" } });
		expect(unnamed.stderr).toContain("usage: mainworthy seed <project>");
		const flagged = await run(["seed", "demo", "--project", "scratch"]);
		expect(flagged.stderr).toContain("seed takes the project as its argument");
		for (const count of ["0", "1.5", "100001"]) {
			const refused = await run(["seed", "demo", "--cases", count]);
			expect(refused.code).toBe(4);
			expect(refused.stderr).toContain("seed writes from 1 to 100000 cases");
		}
		// The same for the files of unit tests, asked of the function the command calls: it refuses before it
		// writes, so no project is made. At the most it reports, every file is its own.
		for (const unlinkedFiles of [-1, 1.5, MAX_SEED_UNLINKED_FILES + 1])
			await expect(seed(client, { project: "refused", cases: 3, unlinkedFiles })).rejects.toThrow(
				"seed reports from 0 to 500 files of tests with no case",
			);
		expect((await projects(client)).map((project) => project.key)).not.toContain("refused");
		const most = unitTests(MAX_SEED_UNLINKED_FILES);
		const perFile = Map.groupBy(most, (result) => ("file" in result.test ? result.test.file : undefined));
		expect(perFile.size).toBe(MAX_SEED_UNLINKED_FILES);
		expect([...perFile.values()].every((tests) => tests.length >= 1 && tests.length <= 9)).toBe(true);
		expect(new Set(most.map((result) => ("key" in result.test ? result.test.key : ""))).size).toBe(most.length);
		// A person of the name the demo's pipeline takes: refused before the project is made.
		await client.call("admin", { do: "token.create", actor: "pipeline", kind: "human", can: ["read"] });
		const taken = await run(["seed", "demo", "--cases", "3"]);
		expect(taken.code).toBe(4);
		expect(taken.stderr).toContain("actor pipeline exists and is a human, not a ci");
		expect((await projects(client)).map((project) => project.key)).toEqual(["scratch"]);
		expect(await casesIn(client, "scratch")).toBe(1);
		expect(await grantsOf(client, "reviewer")).toBeUndefined();
	});
});

test("seed is refused to a caller who does not administer before anything is made, and the owner's token seeds", async () => {
	await withInstance(
		async ({ run, client }) => {
			const member = Token.parse(
				await client.call("admin", {
					do: "token.create",
					actor: "sam",
					kind: "human",
					can: ["read", "produce", "answer", "plan"],
				}),
			).token;
			for (const project of ["scratch", "demo"]) {
				const refused = await run(["seed", project, "--cases", "3"], { env: { MAINWORTHY_TOKEN: member } });
				expect(refused.code).toBe(4);
				expect(refused.stderr).toContain("forbidden:");
			}
			expect((await projects(client)).map((project) => project.key)).toEqual(["scratch"]);
			expect(await casesIn(client, "scratch")).toBe(0);
			expect(await grantsOf(client, "pipeline")).toBeUndefined();
			const seeded = await run(["seed", "demo", "--cases", "3"]);
			expect(seeded.stderr).toBe("");
			expect(seeded.code).toBe(0);
			expect(await casesIn(client, "demo")).toBe(3);
		},
		{ mode: "server" },
	);
});

// Issue #119. A token reaches the server only through `Client.request`, so that is where a token bound for plain
// http on another machine is said once. The addresses below are not real: `viaServer` answers them from the
// instance, so no test depends on the network or on an address the machine has.
const PLAIN = "http://files.example.test";

/** Answers every `fetch` of the command from the running instance, whatever address it names, and notes it. */
async function viaServer<T>(
	instance: { url: string },
	run: () => Promise<T>,
	options: { refuse?: boolean | "authenticated"; healthResponse?: Response } = {},
): Promise<{ result: T; asked: { url: string; authorization: string | null; apiVersion: string | null }[] }> {
	const asked: { url: string; authorization: string | null; apiVersion: string | null }[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (input: Request | string | URL, init?: RequestInit) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			asked.push({
				url,
				authorization: headers.get("authorization"),
				apiVersion: headers.get("x-mainworthy-api-version"),
			});
			process.stderr.write("[fetch]\n");
			if (options.refuse === true || (options.refuse === "authenticated" && headers.has("authorization")))
				throw new TypeError("connection refused");
			if (new URL(url).pathname === "/healthz" && options.healthResponse) return options.healthResponse.clone();
			return real(url.replace(/^https?:\/\/[^/]+/, instance.url), init);
		},
		{ preconnect: real.preconnect },
	);
	try {
		return { result: await run(), asked };
	} finally {
		globalThis.fetch = real;
	}
}

const PLAIN_WARNING = `warning: the token is sent to ${PLAIN} over plain http and travels unencrypted; use an https address\n`;

test("all client diagnostics omit URL credentials while requests keep the configured address", async () => {
	await withInstance(
		async ({ run, instance }) => {
			const url = "http://robin:synthetic-url-password@files.example.test";
			const base = ["find", "--url", url];
			const checks: { options: NonNullable<Parameters<typeof viaServer>[2]>; message: string }[] = [
				{ options: { healthResponse: new Response("unavailable", { status: 503 }) }, message: "answered 503" },
				{ options: { healthResponse: new Response("invalid JSON") }, message: "invalid JSON" },
				{
					options: { healthResponse: Response.json({ ok: true, version: "0.1.0", apiVersion: 999 }) },
					message: "does not advertise it",
				},
				{ options: { refuse: "authenticated" }, message: "cannot connect" },
			];
			for (const { options, message } of checks) {
				const { result, asked } = await viaServer(instance, () => run(base), options);
				expect(result.code).toBe(4);
				expect(result.stderr).toContain(message);
				expect(result.stderr).toContain(PLAIN);
				expect(result.stderr).not.toContain("robin");
				expect(result.stderr).not.toContain("synthetic-url-password");
				expect(asked[0]?.url).toBe(`${url}/healthz`);
			}
			const { result } = await viaServer(instance, () => run(base));
			expect(result.code).toBe(0);
			expect(result.stderr).toBe(`[fetch]\n${PLAIN_WARNING}[fetch]\n[fetch]\n`);
		},
		{ mode: "server" },
	);
});

test("health, open, gate, receipts and seed summaries omit URL credentials in text and JSON", async () => {
	await withInstance(async ({ run, instance }) => {
		const url = "http://robin:synthetic-url-password@files.example.test";
		const invoke = async (argv: string[]) => {
			const { result } = await viaServer(instance, () => run([...argv, "--url", url]));
			expect(result.stderr).not.toContain("robin");
			expect(result.stderr).not.toContain("synthetic-url-password");
			expect(result.stdout).not.toContain("robin");
			expect(result.stdout).not.toContain("synthetic-url-password");
			return result;
		};
		expect((await invoke(["health"])).stdout).toBe(`healthy: Mainworthy 0.1.0 at ${PLAIN}\n`);
		expect(JSON.parse((await invoke(["health", "--json"])).stdout).url).toBe(PLAIN);
		expect((await invoke(["open"])).stdout).toBe(`${PLAIN}\n`);
		expect(JSON.parse((await invoke(["open", "--json"])).stdout)).toEqual({ url: PLAIN });
		const receipt = await invoke(["report", RED_XML, "--commit", COMMIT]);
		expect(receipt.code).toBe(0);
		expect(receipt.stdout).toContain("mainworthy gate    blocked:");
		const gate = await invoke(["gate", "--commit", COMMIT]);
		expect(gate.code).toBe(2);
		expect(gate.stdout).toContain("mainworthy gate    blocked:");
		const seed = await invoke(["seed", "demo", "--cases", "3", "--days", "1", "--unlinked-files", "0", "--json"]);
		expect(seed.code).toBe(0);
		expect(JSON.parse(seed.stdout).url).toBe(`${PLAIN}/p/demo/suite`);
	});
});

test("gate and receipt links remove credentials after resolving their URLs", async () => {
	await withInstance(async ({ client, directory }) => {
		const report: ReportInput = {
			target: { commit: COMMIT },
			results: [{ test: { key: "passing" }, outcome: "pass" }],
		};
		const receipt = await client.call("report", report);
		const gate = { ...(await client.call("gate", { commit: COMMIT })), url: "/p/scratch/runs/R-1" };
		const result = await inThisProcess(
			"print gate and receipt links",
			async () => {
				const url = "http://robin:synthetic-url-password@files.example.test";
				printGate(gate, url);
				printReceipt({ project: "scratch", report, receipt: { ...receipt, gate }, url });
				return 0;
			},
			{ cwd: directory, input: "", environment: { PATH: process.env.PATH ?? "", HOME: directory } },
		);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain("robin");
		expect(result.stdout).not.toContain("synthetic-url-password");
		expect(result.stdout.match(/http:\/\/files\.example\.test\/p\/scratch\/runs\/R-1/g)).toHaveLength(2);
	});
});

test("a token bound for plain http on another machine is warned of once, on stderr, before the first authenticated request", async () => {
	await withInstance(
		async ({ run, instance }) => {
			const token = instance.generatedToken ?? "";
			const { result, asked } = await viaServer(instance, () => run(["find", "--url", PLAIN, "--compact"]));
			// The health probe sends no token; the session and operation follow, with one warning ahead of them.
			expect(asked.map((request) => request.authorization)).toEqual([null, `Bearer ${token}`, `Bearer ${token}`]);
			expect(asked.map((request) => request.apiVersion)).toEqual([null, "1", "1"]);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe(`[fetch]\n${PLAIN_WARNING}[fetch]\n[fetch]\n`);
			expect(outputWith(Found, result).items).toEqual([]);
			expect(result.stdout).not.toContain("warning");
			expect(result.stdout).not.toContain(token);
			expect(result.stderr).not.toContain(token);
			// The next run is another run: it says it again.
			const again = await viaServer(instance, () => run(["find", "--url", PLAIN, "--compact"]));
			expect(again.result.stderr.split("warning:")).toHaveLength(2);
		},
		{ mode: "server" },
	);
});

test("a token is not warned of for https, for this machine, or when none is sent", async () => {
	await withInstance(
		async ({ run, instance }) => {
			for (const url of [
				"https://files.example.test",
				"http://localhost:7357",
				"http://LOCALHOST",
				"http://127.0.0.1:7357",
				"http://127.200.3.4",
				"http://[::1]:7357",
				"http://robin:secret@localhost:7357",
			]) {
				const { result, asked } = await viaServer(instance, () => run(["find", "--url", url]));
				expect([url, result.code, result.stderr]).toEqual([url, 0, "[fetch]\n[fetch]\n[fetch]\n"]);
				expect(asked).toHaveLength(3);
			}
			// No token, none sent, nothing to say: the health check sends none either.
			const bare = await viaServer(instance, () => run(["find", "--url", PLAIN], { env: { MAINWORTHY_TOKEN: "" } }));
			expect(bare.result.stderr).not.toContain("warning:");
			// After the health probe, the session is refused. Neither request carries a token.
			expect(bare.asked.map((request) => request.authorization)).toEqual([null, null]);
		},
		{ mode: "server" },
	);
});

test("the warning comes before an authenticated connection that fails", async () => {
	await withInstance(
		async ({ run, instance }) => {
			const { result, asked } = await viaServer(instance, () => run(["find", "--url", PLAIN]), {
				refuse: "authenticated",
			});
			expect(asked.map((request) => request.authorization)).toEqual([null, `Bearer ${instance.generatedToken}`]);
			expect(result.code).toBe(4);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				`[fetch]\n${PLAIN_WARNING}[fetch]\nconnection: cannot connect to ${PLAIN}; start the server with mainworthy serve\n`,
			);
		},
		{ mode: "server" },
	);
});

test("the executable does not warn of a token when its unauthenticated health probe fails", async () => {
	// 0.0.0.0 is not this machine's address by the rule above, and a connection to it is refused at once on Linux
	// and on macOS, so one real start fails its health probe without sending a token.
	await withInstance(async ({ cli, run }) => {
		const argv = ["find", "--url", "http://0.0.0.0:1", "--token", "abc"];
		const real = await cli(argv);
		expect(real.stdout).toBe("");
		expect(real.code).toBe(4);
		expect(real.stderr).toBe(
			"connection: cannot connect to http://0.0.0.0:1; start the server with mainworthy serve\n",
		);
		expect(await run(argv)).toEqual(real);
	});
});

test("plainHttpToAnotherMachine knows this machine from another by its address, not by how it starts", () => {
	for (const url of [
		"http://example.com",
		"http://10.0.0.5:7357",
		"http://192.168.1.20",
		"http://0.0.0.0:7357",
		"http://127.0.0.1.example.com",
		"http://localhost.example.com",
		"http://notlocalhost",
		"http://[2001:db8::1]:7357",
		"http://[::2]",
		"http://128.0.0.1",
	])
		expect([url, plainHttpToAnotherMachine(url)]).toEqual([url, true]);
	for (const url of [
		"https://example.com",
		"https://10.0.0.5",
		"http://localhost",
		"http://localhost:7357",
		"http://LocalHost./",
		"http://127.0.0.1",
		"http://127.255.255.254:80",
		"http://[::1]",
		"http://[::1]:7357",
	])
		expect([url, plainHttpToAnotherMachine(url)]).toEqual([url, false]);
});

test("--token-file reads the token from a file, trims it, and refuses what cannot be a token", async () => {
	await withInstance(
		async ({ run, instance, directory }) => {
			const token = instance.generatedToken ?? "";
			const none = { MAINWORTHY_TOKEN: "" };
			const write = async (name: string, content: string) => {
				const file = join(directory, name);
				await writeFile(file, content);
				return file;
			};
			// Without a token the server refuses, so what follows is the file's doing.
			expect((await run(["find"], { env: none })).stderr).toContain("unauthenticated:");
			for (const content of [token, `${token}\n`, `${token}\r\n`, `  ${token}\n\n`, `\t${token} \n`]) {
				const file = await write("token", content);
				const found = await run(["find", "--token-file", file, "--compact"], { env: none });
				expect([JSON.stringify(content), found.code, found.stderr]).toEqual([JSON.stringify(content), 0, ""]);
				expect(outputWith(Found, found).items).toEqual([]);
			}
			const file = await write("token", token);
			// The flag wins over the variable, as `--token` does.
			expect((await run(["find", "--token-file", file], { env: { MAINWORTHY_TOKEN: "wrong" } })).code).toBe(0);
			expect((await run(["find", "--token", "wrong"], { env: { MAINWORTHY_TOKEN_FILE: file, ...none } })).code).toBe(4);
			// The variable names a file, as the flag does.
			expect((await run(["find"], { env: { MAINWORTHY_TOKEN_FILE: file, ...none } })).code).toBe(0);
			expect((await run(["find"], { env: { MAINWORTHY_TOKEN_FILE: "", ...none } })).stderr).toContain(
				"unauthenticated:",
			);

			const secret = "s3cret-value that is not a token";
			for (const [content, said] of [
				["", "is empty"],
				[" \n\n", "is empty"],
				[`${secret}\nsecond line`, "holds more than a token"],
			] as const) {
				const bad = await write("bad", content);
				const refused = await run(["find", "--token-file", bad], { env: none });
				expect([refused.code, refused.stdout]).toEqual([4, ""]);
				expect(refused.stderr).toBe(`invalid: the token file ${bad} ${said}\n`);
				expect(refused.stderr).not.toContain("s3cret");
			}
			const missing = join(directory, "absent");
			const unread = await run(["find", "--token-file", missing], { env: none });
			expect([unread.code, unread.stdout, unread.stderr]).toEqual([
				4,
				"",
				`invalid: cannot read the token file ${missing}\n`,
			]);
			// A directory is a file that cannot be read too.
			expect((await run(["find", "--token-file", directory], { env: none })).stderr).toBe(
				`invalid: cannot read the token file ${directory}\n`,
			);
			// Two ways to give the token are not one: refused before anything is read or asked.
			const both = await run(["find", "--token", token, "--token-file", file]);
			expect([both.code, both.stdout, both.stderr]).toEqual([
				4,
				"",
				"invalid: give the token with --token or with --token-file, not both\n",
			]);
			const variables = await run(["find"], { env: { MAINWORTHY_TOKEN: token, MAINWORTHY_TOKEN_FILE: file } });
			expect([variables.code, variables.stderr]).toEqual([
				4,
				"invalid: MAINWORTHY_TOKEN and MAINWORTHY_TOKEN_FILE are both set; set one\n",
			]);
		},
		{ mode: "server" },
	);
});

test.each(["health", "fmt"])("%s ignores unused token files and token conflicts", async (command) => {
	await withInstance(async ({ run, instance, directory }) => {
		const file = join(directory, "case.md");
		const markdown =
			"---\nkind: case\ntitle: Coupon applies\nmethods: [human]\ncovers: []\ntags: []\n---\n## Steps\n- Apply coupon ^apply\n  > Total is reduced\n";
		await writeFile(file, markdown);
		const argv = command === "fmt" ? [command, file] : [command];
		const missing = join(directory, "absent-token");
		for (const [flags, env] of [
			[[], { MAINWORTHY_TOKEN_FILE: missing }],
			[["--token-file", missing], {}],
			[[], { MAINWORTHY_TOKEN: "unused-secret", MAINWORTHY_TOKEN_FILE: missing }],
			[["--token", "unused-secret", "--token-file", missing], {}],
		] satisfies [string[], Record<string, string>][]) {
			const result = await run([...argv, ...flags], { env });
			expect(result).toEqual({
				code: 0,
				stdout: command === "fmt" ? markdown : `healthy: Mainworthy 0.1.0 at ${instance.url}\n`,
				stderr: "",
			});
		}
	});
});

test.each([513, 32_768])("a %i-character token file is refused before a request", async (length) => {
	await withInstance(async ({ run, instance, directory }) => {
		const file = join(directory, "oversized-token");
		const token = "synthetic-secret-".padEnd(length, "x");
		await writeFile(file, token);
		const { result, asked } = await viaServer(instance, () => run(["find", "--token-file", file]));
		expect(result).toEqual({
			code: 4,
			stdout: "",
			stderr: `invalid: the token file ${file} ${length > 4096 ? "is larger than 4096 bytes" : "holds a token longer than 512 characters"}\n`,
		});
		expect(asked).toEqual([]);
		expect(result.stderr).not.toContain("synthetic-secret-");
	});
});

test("token files accept the server's longest token and preserve flag precedence", async () => {
	const token = "custom-owner-".padEnd(512, "x");
	await withInstance(
		async ({ run, directory }) => {
			const file = join(directory, "owner-token");
			const missing = join(directory, "absent-token");
			for (const content of [`${token}\r\n`, token.padEnd(4096, " ")]) {
				await writeFile(file, content);
				for (const [flags, env] of [
					[["--token-file", file], { MAINWORTHY_TOKEN: "wrong", MAINWORTHY_TOKEN_FILE: missing }],
					[["--token", token], { MAINWORTHY_TOKEN: "wrong", MAINWORTHY_TOKEN_FILE: missing }],
					[[], { MAINWORTHY_TOKEN_FILE: file }],
				] satisfies [string[], Record<string, string>][]) {
					const found = await run(["find", ...flags, "--compact"], { env });
					expect([found.code, found.stderr]).toEqual([0, ""]);
					expect(outputWith(Found, found).items).toEqual([]);
				}
			}
			await writeFile(file, token.padEnd(4097, " "));
			const oversized = await run(["find"], { env: { MAINWORTHY_TOKEN_FILE: file } });
			expect(oversized).toEqual({
				code: 4,
				stdout: "",
				stderr: `invalid: the token file ${file} is larger than 4096 bytes\n`,
			});
			const unread = await run(["find", "--token-file", missing], { env: { MAINWORTHY_TOKEN: token } });
			expect(unread).toEqual({
				code: 4,
				stdout: "",
				stderr: `invalid: cannot read the token file ${missing}\n`,
			});
		},
		{ mode: "server", env: { MAINWORTHY_OWNER_TOKEN: token } },
	);
});

test("the help says to prefer the variable to --token, and offers a file", async () => {
	await withInstance(async ({ run }) => {
		for (const argv of [["help"], ["find", "--help"], ["serve", "--help"]]) {
			const help = await run(argv);
			expect([argv.join(" "), help.code]).toEqual([argv.join(" "), 0]);
			expect(help.stdout).toContain("--token-file");
			expect(help.stdout).toContain("MAINWORTHY_TOKEN");
			expect(help.stdout).toMatch(/process list/);
		}
	});
});

test("real report outputs use git top level or cwd for stable Jest and Vitest keys", async () => {
	await withInstance(async ({ cli, run, instance, directory }) => {
		const expected = ["passes @C-1@v1", "fails", "skipped", "todo", "parameter 1", "parameter 2", "retry"].map(
			(name) => ({ key: `tests/sample.test.js::checkout::${name}`, file: "tests/sample.test.js" }),
		);
		for (const checkout of ["git", "second-git", "plain"]) {
			const folder = join(directory, checkout);
			await mkdir(join(folder, "nested"), { recursive: true });
			const root = await realpath(folder);
			const nested = join(root, "nested");
			if (checkout !== "plain") expect(Bun.spawnSync(["git", "init", "--quiet", root]).exitCode).toBe(0);
			const alias = join(directory, `${checkout}-link`);
			await symlink(root, alias, "dir");
			for (const format of ["jest", "vitest"]) {
				const fixture = new URL(`../../test/fixtures/reports/real-${format}.json`, import.meta.url);
				const file = join(directory, `${checkout}-${format}.json`);
				await writeFile(file, (await Bun.file(fixture).text()).replaceAll("/home/robin/project", root));
				const command = checkout === "git" && format === "jest" ? cli : run;
				const result = await command(
					["report", file, "--session", "real-tools", "--job", `${checkout}-${format}`, "--json"],
					{
						cwd: checkout !== "plain" ? nested : root,
					},
				);
				expect(result.stderr).toBe("");
				expect(result.code).toBe(0);
				expect(JSON.parse(result.stdout).counts).toEqual({ total: 7, pass: 4, fail: 1, skip: 2, error: 0, blocked: 0 });
				const linked = await run(
					["report", file, "--session", "real-tools", "--job", `${checkout}-${format}`, "--json"],
					{ cwd: alias },
				);
				expect(linked.code).toBe(0);
				expect(JSON.parse(linked.stdout).fresh).toBe(false);
				expect(
					instance.app.db.raw.query<{ key: string; file: string }, []>("SELECT key, file FROM tests ORDER BY id").all(),
				).toEqual(expected);
			}
		}
		const other = join(await realpath(directory), "other-checkout");
		await mkdir(other);
		expect(Bun.spawnSync(["git", "init", "--quiet", other]).exitCode).toBe(0);
		for (const format of ["jest", "vitest"]) {
			const file = join(directory, `git-${format}.json`);
			for (const cwd of [other, "/"]) {
				const refused = await run(["report", file, "--session", "real-tools", "--job", "refused"], { cwd });
				expect(refused.code).toBe(4);
				expect(refused.stderr).toContain(
					`${file}: Jest/Vitest ${cwd === "/" ? "filesystem root" : "outside root"}: ${cwd}`,
				);
			}
			const relativeRootFile = join(directory, `relative-root-${format}.json`);
			await writeFile(
				relativeRootFile,
				JSON.stringify({ ...JSON.parse(await Bun.file(file).text()), rootDir: "relative/root" }),
			);
			const refused = await run(["report", relativeRootFile, "--session", "real-tools"], { cwd: other });
			expect(refused.code).toBe(4);
			expect(refused.stderr).toContain(`${relativeRootFile}: Jest/Vitest root must be absolute: relative/root`);
		}
		expect(instance.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM batches").get()?.n).toBe(6);
		for (const [format, counts] of [
			["pytest", { total: 8, pass: 3, fail: 2, skip: 2, error: 1, blocked: 0 }],
			["playwright", { total: 7, pass: 4, fail: 1, skip: 2, error: 0, blocked: 0 }],
		] as const) {
			const file = new URL(`../../test/fixtures/reports/real-${format}.json`, import.meta.url).pathname;
			const result = await run(["report", file, "--session", "real-tools", "--job", format, "--json"]);
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout).counts).toEqual(counts);
			if (format === "pytest") expect(JSON.parse(result.stdout).questions).toHaveLength(3);
		}
	});
});

test("version reports the CLI contract without reaching a server or reading a token", async () => {
	await withInstance(async ({ run, instance }) => {
		const { result, asked } = await viaServer(
			instance,
			() => run(["version", "--json"], { env: { MAINWORTHY_TOKEN_FILE: "/missing/token" } }),
			{ refuse: true },
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ version: "0.1.0", apiVersion: 1 });
		expect(asked).toEqual([]);
	});
});

test("an incompatible or unversioned server receives no CLI operation or credentials", async () => {
	for (const apiVersion of [undefined, 0, 2, "1", null]) {
		const received: { path: string; token: string | null }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				received.push({ path: new URL(req.url).pathname, token: req.headers.get("authorization") });
				return Response.json(
					new URL(req.url).pathname === "/healthz"
						? { ok: true, version: "0.1.0", apiVersion }
						: { ok: true, result: {} },
				);
			},
		});
		try {
			await withInstance(async ({ run }) => {
				const result = await run([
					"change",
					"--project",
					"scratch",
					"--change",
					"pr:482",
					"--state",
					"merged",
					"--url",
					`http://127.0.0.1:${server.port}`,
					"--token",
					"private-token",
				]);
				expect(result.code).toBe(4);
				expect(result.stderr).toContain("incompatible:");
				expect(result.stderr).toContain("CLI requires API 1");
				expect(received).toEqual([{ path: "/healthz", token: null }]);
			});
		} finally {
			await server.stop(true);
		}
	}
});

test("a redirecting health probe does not warn that a token was sent", async () => {
	await withInstance(async ({ run, instance }) => {
		const { result, asked } = await viaServer(
			instance,
			() => run(["find", "--url", PLAIN, "--token", "private-token"]),
			{
				healthResponse: new Response(null, {
					status: 301,
					headers: { location: "https://mainworthy.example/healthz" },
				}),
			},
		);
		expect(result.code).toBe(4);
		expect(asked).toEqual([{ url: `${PLAIN}/healthz`, authorization: null, apiVersion: null }]);
		expect(result.stderr).not.toContain("warning:");
		expect(result.stderr).toContain("the server answered 301 to /healthz");
	});
});

test("health probe diagnostics distinguish redirects, HTTP failures and invalid JSON", async () => {
	const received: { path: string; token: string | null }[] = [];
	let response = new Response(null, { status: 301, headers: { location: "https://mainworthy.example/healthz" } });
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			received.push({ path: new URL(req.url).pathname, token: req.headers.get("authorization") });
			return response.clone();
		},
	});
	try {
		await withInstance(async ({ run }) => {
			for (const [reply, message] of [
				[response, "redirect to origin https://mainworthy.example; set --url to https://mainworthy.example"],
				[new Response("proxy unavailable", { status: 503 }), "the server answered 503 to /healthz"],
				[new Response("proxy page"), "the server answered 200 to /healthz with invalid JSON"],
			] as const) {
				response = reply;
				received.length = 0;
				const result = await run(["find", "--url", `http://127.0.0.1:${server.port}`, "--token", "private-token"]);
				expect(result.code).toBe(4);
				expect(result.stderr).toContain(message);
				expect(result.stderr).not.toContain("start the server");
				expect(result.stderr).not.toContain("incompatible:");
				expect(received).toEqual([{ path: "/healthz", token: null }]);
			}
		});
	} finally {
		await server.stop(true);
	}
});

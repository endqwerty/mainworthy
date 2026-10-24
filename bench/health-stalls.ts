// A separate-process HTTP probe. Profile runs are diagnostic, never latency samples.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { Client } from "../src/cli/client.ts";
import { ensure } from "./contracts.ts";
import { buildDataset, Metadata, Parameters } from "./dataset.ts";

type Sample = { phase: string; ms: number; at: number };
const Sample = z.object({ phase: z.string(), ms: z.number(), at: z.number() });
const Demo = z.object({ run: z.string(), workSlot: z.number().nullable() });
const Command = z.discriminatedUnion("type", [
	z.object({ type: z.literal("phase"), phase: z.string() }),
	z.object({ type: z.literal("renew") }),
	z.object({ type: z.literal("stop") }),
]);
const Evidence = z.object({ results: z.literal(4000), tries: z.literal(200), attachments: z.literal(20) });
const Message = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ready"), url: z.string(), secret: z.string() }),
	z.object({ type: z.literal("ack") }),
	z.object({ type: z.literal("stopped"), lags: z.array(Sample), evidence: Evidence }),
]);

async function modules(root: string) {
	const startup: typeof import("../src/app/start.ts") = await import(`${root}/src/app/start.ts`);
	const dataset: typeof import("./dataset.ts") = await import(`${root}/bench/dataset.ts`);
	const archive: typeof import("../src/surfaces/archive.ts") = await import(`${root}/src/surfaces/archive.ts`);
	const demo: typeof import("../src/cli/demo.ts") = await import(`${root}/src/cli/demo.ts`);
	const seeding: typeof import("../src/cli/seed.ts") = await import(`${root}/src/cli/seed.ts`);
	return { ...startup, ...dataset, ...archive, ...demo, ...seeding };
}

async function server(root: string, directory: string, demoFile: string) {
	const { start, config, archiveRoutes, renewDemoWork, ciActor } = await modules(root);
	const instance = await start({ ...config(directory), databaseUrl: fixture.url }, (app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }));
	const ci = await ciActor(instance.app);
	const demo = Demo.parse(JSON.parse(readFileSync(demoFile, "utf8")));
	let phase = "idle";
	let last = performance.now();
	const lags: Sample[] = [];
	const timer = setInterval(() => {
		const now = performance.now();
		const ms = now - last - 20;
		if (ms > 10) lags.push({ phase, ms, at: Date.now() });
		last = now;
	}, 20);
	process.on("message", async (raw: unknown) => {
		const command = Command.parse(raw);
		switch (command.type) {
			case "phase":
				phase = command.phase;
				break;
			case "renew": {
				const lease = () =>
					instance.app.database.read(async (db) =>
						z
							.object({ until: z.number() })
							.parse((await db.allDynamic("SELECT until FROM slot_leases WHERE slot = $1", [demo.workSlot]))[0]),
					);
				const previous = (await lease()).until;
				await renewDemoWork(instance, "demo", demo);
				ensure((await lease()).until > previous, "demo renewal must extend the lease");
				break;
			}
			case "stop": {
				const results =
					"SELECT r.id FROM results r JOIN batches b ON b.id = r.batch JOIN targets t ON t.id = b.target WHERE t.commit_sha = 'bench-health'";
				const count = (query: string) =>
					instance.app.database.read(
						async (db) => z.object({ n: z.number() }).parse((await db.allDynamic(query))[0]).n,
					);
				const evidence = Evidence.parse({
					results: await count(`SELECT count(*) n FROM results WHERE id IN (${results})`),
					tries: await count(`SELECT count(*) n FROM result_tries WHERE result IN (${results})`),
					attachments: await count(`SELECT count(*) n FROM attachments WHERE result IN (${results})`),
				});
				await Bun.sleep(100);
				clearInterval(timer);
				await instance.stop();
				await new Promise<void>((resolve, reject) => {
					if (!process.send) throw new Error("probe server needs an IPC channel");
					process.send({ type: "stopped", lags, evidence }, (error) => (error ? reject(error) : resolve()));
				});
				process.disconnect?.();
				return;
			}
		}
		process.send?.({ type: "ack" });
	});
	process.send?.({ type: "ready", url: instance.url, secret: ci.secret });
}

async function seed(directory: string, root: string) {
	const dataset = await buildDataset({
		dir: directory,
		parameters: Parameters.parse({
			cases: 10_000,
			tests: 4000,
			results: 100_000,
			openQuestions: 5000,
			queueTimeMs: 30_000,
		}),
	});
	const { start, config, archiveRoutes, seed: seedDemo, cloneDataset, postgres } = await modules(root);
	const fixture = await cloneDataset(directory, directory);
	const instance = await start({ ...config(directory), databaseUrl: fixture.url }, (app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }));
	try {
		const demo = await seedDemo(new Client({ url: instance.url, token: undefined, project: "demo" }), {
			project: "demo",
			cases: 500,
			unlinkedFiles: 10,
			days: 2,
		});
		ensure(demo.workSlot !== null, "demo fixture needs its featured work slot");
		await Bun.write(`${directory}/demo.json`, JSON.stringify({ run: demo.run, workSlot: demo.workSlot }));
		console.log(JSON.stringify({ counts: dataset.metadata.counts }));
	} finally {
		await instance.stop();
		postgres("pg_dump", [
			"--format=custom",
			"--no-owner",
			"--no-privileges",
			"--file",
			directory + "/baseline.dump",
			fixture.url,
		]);
		await fixture.close();
	}
}

async function probe(dataset: string, artifacts: string, root: string, profile: boolean) {
	const { ingestInput, cloneDataset } = await modules(root);
	const metadata = Metadata.parse(JSON.parse(readFileSync(`${dataset}/dataset.json`, "utf8")));
	const directory = mkdtempSync(`${artifacts}/health-`);
	const fixture = await cloneDataset(dataset, directory);
	cpSync(`${dataset}/blobs`, `${directory}/blobs`, { recursive: true });
	let receive: (message: unknown) => void = () => {};
	const next = () =>
		new Promise<unknown>((resolve) => {
			receive = resolve;
		});
	const ready = next();
	const child = Bun.spawn(
		[
			process.execPath,
			...(profile ? ["--cpu-prof", `--cpu-prof-dir=${artifacts}`] : []),
			import.meta.filename,
			"--server",
			root,
			directory,
			`${dataset}/demo.json`,
		],
		{
			env: { ...process.env, NODE_ENV: "production" },
			stdout: "pipe",
			stderr: "inherit",
			ipc: (message) => receive(message),
		},
	);
	const output = new Response(child.stdout).text();
	const wait = async (reply: Promise<unknown>) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				reply,
				child.exited.then(async (code) => {
					await Bun.sleep(10);
					throw new Error(`probe server exited ${code} before replying`);
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("probe server did not reply within 60 seconds")), 60_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	const send = async (command: z.infer<typeof Command>) => {
		const reply = next();
		child.send(command);
		return Message.parse(await wait(reply));
	};
	let stop = false;
	let phase = "idle";
	let errors = 0;
	const health: Sample[] = [];
	const rows: { phase: string; ms: number; output: unknown }[] = [];
	let polling: Promise<void> | undefined;
	try {
		const message = Message.parse(await wait(ready));
		if (message.type !== "ready") throw new Error("server did not become ready");
		const client = new Client({ url: message.url, token: undefined, project: "benchmark" });
		const ci = client.with({ token: message.secret });
		polling = (async () => {
			while (!stop) {
				const started = performance.now();
				const observed = phase;
				try {
					const response = await fetch(`${message.url}/healthz`);
					if (response.status !== 200 || !z.object({ ok: z.literal(true) }).safeParse(await response.json()).success)
						errors++;
				} catch {
					errors++;
				}
				health.push({ phase: observed, ms: performance.now() - started, at: Date.now() });
				await Bun.sleep(125);
			}
		})();
		const run = async (name: string, work: () => Promise<unknown>) => {
			phase = name;
			await send({ type: "phase", phase });
			await Bun.sleep(150);
			const started = performance.now();
			const result = await work();
			rows.push({ phase, ms: performance.now() - started, output: result });
			await Bun.sleep(150);
		};
		console.log(
			JSON.stringify({ bun: Bun.version, cores: cpus().length, load: loadavg(), counts: metadata.counts, profile }),
		);
		const input = ingestInput(metadata, "health", 4000);
		input.results = input.results.map((result, index) => ({
			...result,
			...(index % 40 === 0
				? {
						tries: [
							{ outcome: "fail" as const, durationMs: 100, failure: { message: "retry transient" } },
							{ outcome: "pass" as const, durationMs: 40 },
						],
					}
				: {}),
			...(index % 200 === 0
				? {
						attachments: [{ name: "ci.log", data: Buffer.from("sample CI attachment".repeat(500)).toString("base64") }],
					}
				: {}),
		}));
		await run("report-4000-tries-attachments", async () => {
			const receipt = await ci.call("report", input);
			ensure(
				receipt.fresh && receipt.counts.total === 4000 && receipt.rejected.length === 0,
				"complete fresh report required",
			);
			return { batch: receipt.batch, counts: receipt.counts };
		});
		await run("gate", () => client.call("gate", { commit: "bench-health" }));
		await run("change-merge", () => client.call("change", { change: metadata.change, state: "merged" }));
		await run("change-reopen", () => client.call("change", { change: metadata.change, state: "open" }));
		await run("renewDemoWork", () => send({ type: "renew" }));
		await run("archive-export", async () => {
			const response = await client.request("/api/export");
			ensure(response.status === 200, "export must succeed");
			const bytes = (await response.arrayBuffer()).byteLength;
			ensure(bytes > 1000, "export must contain data");
			return { bytes };
		});
		await run("find-large", async () => {
			const found = await client.call("find", { text: "checkout", limit: 500 });
			ensure(found.items.length > 0, "find must read cases");
			return { items: found.items.length };
		});
		await run("queue", async () => {
			const inbox = await client.call("inbox", { limit: 500 });
			ensure(inbox.items.length > 0, "queue must read questions");
			return { counts: inbox.counts, items: inbox.items.length };
		});
		const policy = z
			.object({ version: z.number() })
			.parse(await client.call("admin", { do: "policy.show", project: "benchmark" }));
		const proposal = await client.call("propose", {
			edits: [{ op: "policy", base: policy.version, preset: "loose" }],
			reason: "health probe policy",
		});
		ensure(proposal.status === "open" && proposal.question !== null, "policy proposal must await adoption");
		const questionRef = proposal.question;
		const [question] = await client.call("get", { refs: [questionRef] });
		const evidence = z.object({ evidenceHash: z.string() }).parse(question);
		await run("policy-adoption", async () => {
			const decided = await client.call("decide", {
				q: questionRef,
				onEvidence: evidence.evidenceHash,
				answer: { is: "accept" },
				reason: "health probe policy",
			});
			ensure(decided[0]?.status === "decided", "policy must be adopted");
			const stored = z
				.object({ version: z.number(), preset: z.string() })
				.parse(await client.call("admin", { do: "policy.show", project: "benchmark" }));
			ensure(stored.version === policy.version + 1 && stored.preset === "loose", "new policy must persist");
			return decided;
		});
		stop = true;
		await polling;
		const stopped = await send({ type: "stop" });
		if (stopped.type !== "stopped") throw new Error("server did not stop");
		console.log(
			JSON.stringify({
				errors,
				evidence: stopped.evidence,
				rows: rows.map((row) => {
					const samples = health.filter((sample) => sample.phase === row.phase);
					const lags = stopped.lags.filter((sample) => sample.phase === row.phase);
					return {
						...row,
						healthMax: Math.max(0, ...samples.map((s) => s.ms)),
						samples: samples.length,
						lagMax: Math.max(0, ...lags.map((s) => s.ms)),
						stalls: [...samples, ...lags].filter((s) => s.ms > 250),
					};
				}),
				health,
				lags: stopped.lags,
			}),
		);
		ensure(errors === 0, "health probes must succeed");
		ensure((await child.exited) === 0, "server must exit successfully");
	} finally {
		stop = true;
		await polling;
		child.kill();
		await child.exited;
		const text = await output;
		if (text) console.error(text);
		await fixture.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

const args = process.argv.slice(2);
const [mode, first, second, third] = args.filter((arg) => arg !== "--profile");
const root = dirname(dirname(import.meta.filename));
if (mode === "--server" && first && second && third) await server(first, second, third);
else if (mode === "--seed" && first) await seed(resolve(first), root);
else if (mode && first) await probe(resolve(mode), resolve(first), resolve(second ?? root), args.includes("--profile"));
else
	throw new Error("usage: bun bench/health-stalls.ts --seed <dataset> | <dataset> <scratch> [source root] [--profile]");

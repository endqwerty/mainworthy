import { cpus, loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GateStatus, ReportReceipt } from "../src/core/ops.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { ciReport, harness } from "../test/helpers.ts";
import { ensure } from "./contracts.ts";
import { profile } from "./profile.ts";

type Engine = { name: string; invoke: typeof invoke; ops: typeof OPS };

async function fixture(siblings: number) {
	const h = await harness();
	const ci = await h.actor("pipeline", "ci", ["read", "record"]);
	await h.call("report", ciReport({ commit: "base0001", n: 1, fail: { 0: "same cause" } }), ci);
	for (let i = 1; i <= siblings; i++) {
		await h.call(
			"report",
			ciReport({
				commit: `head${String(i).padStart(8, "0")}`,
				pr: i,
				base: "base0001",
				n: 1,
				fail: { 0: "same cause" },
			}),
			ci,
		);
	}
	return { h, ci };
}

/** Times the real registry's complete accept/apply path. Setup and output assertions are outside its timer. */
async function main() {
	const engines: Engine[] = [];
	const compare = process.argv.indexOf("--compare");
	if (compare >= 0) {
		const root = process.argv[compare + 1];
		if (!root) throw new Error("--compare needs a checkout or archive export of the baseline revision");
		const registry: { invoke: typeof invoke } = await import(
			pathToFileURL(resolve(root, "src/server/ops/registry.ts")).href
		);
		const index: { OPS: typeof OPS } = await import(pathToFileURL(resolve(root, "src/server/ops/index.ts")).href);
		engines.push({ name: "before", invoke: registry.invoke, ops: index.OPS });
	}
	engines.push({ name: "after", invoke, ops: OPS });
	const machine = { cores: cpus().length, loadBefore: loadavg(), bun: Bun.version };
	const fixtures = [];
	for (const siblings of [100, 1_000, 3_000]) {
		for (const engine of engines) {
			console.error(`Preparing ${siblings} siblings for ${engine.name}`);
			fixtures.push({
				siblings,
				engine,
				...(await fixture(siblings)),
				samples: [] as number[],
				attempt: 1,
				now: 1_800_001_000_000,
			});
		}
	}
	type Fixture = (typeof fixtures)[number];
	const call = async (f: Fixture, op: string, input: unknown): Promise<unknown> => {
		f.h.app.now = () => ++f.now;
		const reply = await f.engine.invoke(f.h.app, f.engine.ops, {
			op,
			project: "scratch",
			input,
			actor: async () => f.ci,
		});
		if (!reply.ok) throw new Error(`${op}: ${reply.error.code}: ${reply.error.message}`);
		return reply.result;
	};
	const input = (f: Fixture) =>
		ciReport({
			commit: "head00000001",
			pr: 1,
			base: "base0001",
			n: 1,
			fail: { 0: "same cause" },
			attempt: ++f.attempt,
		});
	const check = async (f: Fixture, result: unknown) => {
		const receipt = ReportReceipt.parse(result);
		ensure(
			receipt.fresh && receipt.counts.fail === 1 && receipt.results.length === 1,
			"a fresh failure must be stored",
		);
		const gate = GateStatus.parse(await call(f, "gate", { commit: "head00000001" }));
		ensure(
			gate.verdict === "passed" && gate.tally.excused === 1 && gate.tally.unexplained === 0,
			"the base failure must be inherited",
		);
		ensure(receipt.gate?.verdict === gate.verdict, "the receipt and the gate must agree");
	};
	try {
		for (let round = -1; round < 7; round++) {
			for (const f of round % 2 === 0 ? fixtures : [...fixtures].reverse()) {
				const report = input(f);
				const start = performance.now();
				const result = await call(f, "report", report);
				const ms = performance.now() - start;
				await check(f, result);
				if (round >= 0) f.samples.push(ms);
			}
		}
		const rows = fixtures.map((f) => {
			const sorted = [...f.samples].sort((a, b) => a - b);
			return {
				engine: f.engine.name,
				siblings: f.siblings,
				median: sorted[3],
				min: sorted[0],
				max: sorted.at(-1),
				samples: f.samples,
			};
		});
		const diagnostics = [];
		for (const f of fixtures.filter((f) => f.siblings === 3_000)) {
			let result: unknown;
			diagnostics.push(
				await profile(f.h.app, {
					name: `${f.engine.name}: report with 3000 siblings`,
					budget: null,
					iterations: 1,
					correctness: "fresh inherited failure",
					prepare: () => {
						const report = input(f);
						const runReport = async () => {
							result = await call(f, "report", report);
							return result;
						};
						return runReport;
					},
					check: async (result) => await check(f, result),
				}),
			);
			await check(f, result);
		}
		console.log(
			JSON.stringify(
				{
					machine: { ...machine, loadAfter: loadavg() },
					errors: 0,
					checked: fixtures.length * 8,
					rows,
					diagnostics,
				},
				null,
				2,
			),
		);
	} finally {
		for (const f of fixtures) await f.h.close();
	}
}

if (import.meta.main) await main();

// Measure the maximum supported result count through the actual registry and verify committed rows.
import { cpus, loadavg } from "node:os";
import { type ReportInput, ReportReceipt } from "../src/core/ops.ts";
import { lockActors } from "../src/server/identity/identity.ts";
import type { App } from "../src/server/kernel/app.ts";
import { type Ctx, findProject, lockProject } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { COMMIT, defineOp, invoke } from "../src/server/ops/registry.ts";
import { reportOp, reportSteps } from "../src/server/ops/writes.ts";
import { ciReport, harness } from "../test/helpers.ts";
import { profile } from "./profile.ts";

const allowOverlap = process.argv.includes("--allow-overlap");
const observedOverlaps = new Set<string>();
function requireExclusiveMachine(): void {
	const running = Bun.spawnSync({
		cmd: [
			"pgrep",
			"-fl",
			"(^|/)bun ([^[:space:]]*/)?scripts/check[.]ts( |$)|(^|/)bun ([^[:space:]]*/)?bench/|(^|/)bun run test( |$)",
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (running.exitCode !== 0 && running.exitCode !== 1)
		throw new Error("cannot verify whether another whole-suite runner is active");
	const others = running.stdout
		.toString()
		.trim()
		.split("\n")
		.filter((line) => line && Number(line.split(/\s+/)[0]) !== process.pid);
	if (!others.length) return;
	for (const line of others) observedOverlaps.add(line);
	console.error(JSON.stringify({ diagnostic: "machine-overlap", permitted: allowOverlap, processes: others }));
	if (!allowOverlap)
		throw new Error(
			"lock-wait measurement refused: another suite or bench is active; use --allow-overlap and record the shared result",
		);
}

/** Diagnostic only: the real report has committed 100,000 test rows before any plan is captured. */
export async function lookupPlans(
	app: App,
	actor: number,
	input: ReportInput,
	emit: (value: unknown) => void = (value) => console.log(JSON.stringify(value)),
): Promise<void> {
	const keys = input.results.slice(0, 200).map((result) => {
		if (!("key" in result.test)) throw new Error("the plan workload requires automated test keys");
		return result.test.key;
	});
	const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
	await app.database.write((db) =>
		db.transaction(async () => {
			await lockActors(db, [actor]);
			const hint = await findProject(db, "scratch");
			const project = hint ? await lockProject(db, hint.id) : null;
			if (!project) throw new Error("the plan workload has no project");
			emit({
				diagnostic: "test-lookup-indexes",
				rows: await db.allDynamic("SELECT count(*) AS n FROM tests"),
				indexes: await db.allDynamic(
					"SELECT indexname,indexdef FROM pg_indexes WHERE tablename='tests' ORDER BY indexname",
				),
			});
			for (const statistics of ["observed", "analyzed"] as const) {
				if (statistics === "analyzed") await db.exec("ANALYZE tests");
				const estimates = await db.allDynamic("SELECT reltuples,relpages FROM pg_class WHERE oid='tests'::regclass");
				for (const mode of ["auto", "force_custom_plan", "force_generic_plan"] as const) {
					await db.exec(`SET LOCAL plan_cache_mode = ${mode}`);
					await db.exec(
						"PREPARE lock_tests_lookup(bigint,text[]) AS SELECT * FROM tests WHERE project=$1 AND key=ANY($2::text[])",
					);
					for (const match of [true, false]) {
						const requested = match ? keys : keys.map((key) => `missing:${key}`);
						const execute = `EXECUTE lock_tests_lookup(${project.id},ARRAY[${requested.map(literal).join(",")}]::text[])`;
						// Auto mode must reach PostgreSQL's custom/generic-plan decision, not just its first execution.
						for (let repeat = 0; repeat < (mode === "auto" ? 6 : 1); repeat++) {
							const rows = await db.allDynamic(execute);
							if (rows.length !== (match ? keys.length : 0)) throw new Error("the lookup returned incorrect rows");
						}
						const plan = await db.allDynamic<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${execute}`);
						emit({
							diagnostic: "test-lookup-plan",
							statistics,
							mode,
							match,
							keys: requested.length,
							estimates,
							prepared: await db.allDynamic(
								"SELECT generic_plans,custom_plans FROM pg_prepared_statements WHERE name='lock_tests_lookup'",
							),
							plan: plan.map((row) => row["QUERY PLAN"]),
						});
					}
					await db.exec("DEALLOCATE lock_tests_lookup");
				}
			}
		}),
	);
}
if (import.meta.main) {
	requireExclusiveMachine();
	const diagnostic = process.argv[2] === "--profile";
	const plans = process.argv[2] === "--plans";
	const rounds = diagnostic || plans ? 1 : Number(process.argv[2] ?? 5);
	if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5)
		throw new Error("measure from one to five complete reports");
	const states = plans ? (["fresh"] as const) : (["fresh", "existing"] as const);
	console.log(JSON.stringify({ cpus: cpus().length, load: loadavg(), results: 100000, rounds, states, allowOverlap }));
	for (let round = 0; round < rounds; round++) {
		requireExclusiveMachine();
		const h = await harness({ unlinked: "track" });
		const ci = await h.actor("pipeline", "ci", ["read", "record"]);
		let applicationStart = 0;
		let applicationMs = 0;
		let maximumPauseMs = 0;
		let pauses = 0;
		const op = defineOp({
			...reportOp,
			effect: "write",
			async *steps(ctx: Ctx, input: ReportInput) {
				const iterator = reportSteps(ctx, input);
				for (;;) {
					const step = await iterator.next();
					if (step.done) {
						applicationMs = performance.now() - applicationStart;
						return step.value;
					}
					if (step.value === COMMIT) {
						yield step.value;
						applicationStart = performance.now();
					} else {
						const start = performance.now();
						yield step.value;
						maximumPauseMs = Math.max(maximumPauseMs, performance.now() - start);
						pauses++;
					}
				}
			},
		});
		try {
			for (const state of states) {
				requireExclusiveMachine();
				applicationStart = 0;
				applicationMs = 0;
				maximumPauseMs = 0;
				pauses = 0;
				const input = ciReport({ commit: (state === "fresh" ? "f" : "e").repeat(40), n: 100000 });
				const before = process.cpuUsage();
				const start = performance.now();
				const run = () =>
					invoke(h.app, { ...OPS, report: op }, { op: "report", project: "scratch", input, actor: async () => ci });
				const check = async (reply: Awaited<ReturnType<typeof run>>) => {
					if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
					const receipt = ReportReceipt.parse(reply.result);
					if (!receipt.fresh || receipt.counts.total !== 100000)
						throw new Error("measurement did not apply a fresh complete report");
					const stored = await h.app.database.read((db) =>
						db.allDynamic<{ n: number }>("SELECT count(*) AS n FROM results GROUP BY batch ORDER BY batch"),
					);
					if (stored.length !== (state === "fresh" ? 1 : 2) || stored.some((batch) => batch.n !== 100000))
						throw new Error("measurement did not commit exactly 100000 results per report");
				};
				if (plans) {
					await check(await run());
					await lookupPlans(h.app, ci.id, input);
					requireExclusiveMachine();
					continue;
				}
				if (diagnostic) {
					const result = await profile(h.app, {
						name: `maximum-report-${state}-diagnostic`,
						budget: null,
						iterations: 1,
						correctness: "100000 committed results",
						prepare: () => run,
						check: async (reply) => check(reply as Awaited<ReturnType<typeof run>>),
					});
					requireExclusiveMachine();
					console.log(JSON.stringify(result));
					continue;
				}
				const reply = await run();
				const elapsedMs = performance.now() - start;
				requireExclusiveMachine();
				const cpu = process.cpuUsage(before);
				await check(reply);
				console.log(
					JSON.stringify({
						round,
						state,
						applicationMs,
						maximumPauseMs,
						pauses,
						elapsedMs,
						cpuMs: (cpu.user + cpu.system) / 1000,
						stored: state === "fresh" ? 100000 : 200000,
						overlaps: [...observedOverlaps],
					}),
				);
			}
		} finally {
			await h.close();
		}
	}
}

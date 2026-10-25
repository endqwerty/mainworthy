// Measure identity requests while a real report holds its application transaction.
import { cpus, loadavg } from "node:os";
import { type ReportInput, ReportReceipt } from "../src/core/ops.ts";
import { createToken, hashToken, signInWithToken } from "../src/server/identity/identity.ts";
import type { Ctx } from "../src/server/kernel/ctx.ts";
import { OPS } from "../src/server/ops/index.ts";
import { COMMIT, defineOp, invoke } from "../src/server/ops/registry.ts";
import { reportOp, reportSteps } from "../src/server/ops/writes.ts";
import { drainDatabaseDrops } from "../test/db.ts";
import { ciReport, harness } from "../test/helpers.ts";

const rounds = Number(process.argv[2] ?? 5);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5) throw new Error("choose one to five rounds");
console.log(JSON.stringify({ cpus: cpus().length, load: loadavg(), results: 5000, rounds, sharedMachine: true }));
for (let round = 0; round < rounds; round++) {
	for (const queued of [false, true]) {
		const h = await harness({ unlinked: "track" });
		const holding = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let applicationStart = 0;
		let applicationMs = 0;
		try {
			const ci = await h.actor("pipeline", "ci", ["read", "record"]);
			await h.actor("member", "human", ["read"]);
			const token = await createToken(h.app, {
				actor: h.owner.name,
				kind: "human",
				can: [],
				project: 0,
				label: "sign-in",
			});
			const report = defineOp({
				...reportOp,
				effect: "write",
				async *steps(ctx: Ctx, input: ReportInput) {
					const iterator = reportSteps(ctx, input);
					let pause = false;
					for (;;) {
						const step = await iterator.next();
						if (step.done) {
							applicationMs = performance.now() - applicationStart;
							return step.value;
						}
						if (pause) {
							pause = false;
							holding.resolve();
							await resume.promise;
						}
						yield step.value;
						if (step.value === COMMIT) {
							applicationStart = performance.now();
							pause = true;
						}
					}
				},
			});
			const reporting = invoke(
				h.app,
				{ ...OPS, report },
				{
					op: "report",
					project: "scratch",
					input: ciReport({ commit: "identity-contention", n: 5000 }),
					actor: async () => ci,
				},
			);
			const waiters = async () =>
				(
					await h.app.database.read((db) =>
						db.allDynamic<{ n: number }>(
							"SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
						),
					)
				)[0]?.n ?? 0;
			async function until(predicate: () => Promise<boolean>) {
				const end = performance.now() + 5000;
				while (performance.now() < end) {
					if (await predicate()) return;
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				throw new Error("contention did not reach its expected state");
			}
			await holding.promise;
			let grant: ReturnType<typeof h.raw> | undefined;
			if (queued) {
				grant = h.raw("admin", { do: "grant.set", actor: "member", project: "scratch", can: ["read"] });
				await until(async () => (await waiters()) >= 1);
			}
			let completed = 0;
			const signin = (async () => {
				const start = performance.now();
				const opened = await signInWithToken(h.app, token.secret, { userAgent: null, address: null });
				if (opened.kind !== "opening" || !(await opened.signedIn)) throw new Error("sign-in did not succeed");
				completed++;
				return performance.now() - start;
			})();
			const creating = (async () => {
				const start = performance.now();
				const made = await createToken(h.app, {
					actor: "new-person",
					kind: "human",
					can: [],
					project: 0,
					label: "concurrent",
				});
				completed++;
				return { ms: performance.now() - start, made };
			})();
			await until(async () => completed === 2 || (queued && (await waiters()) >= 3));
			const completedBeforeReportRelease = completed === 2;
			resume.resolve();
			const [reply, signinMs, created, granted] = await Promise.all([reporting, signin, creating, grant]);
			if (!reply.ok || (granted && !granted.ok)) throw new Error("report or grant refused");
			if (ReportReceipt.parse(reply.result).counts.total !== 5000) throw new Error("wrong receipt");
			const rows = await h.app.database.read((db) =>
				db.allDynamic<{ results: number; tokens: number; sessions: number }>(
					"SELECT (SELECT count(*) FROM results) AS results, (SELECT count(*) FROM tokens WHERE hash = $1) AS tokens, (SELECT count(*) FROM sessions WHERE actor = $2) AS sessions",
					[hashToken(created.made.secret), h.owner.id],
				),
			);
			if (rows[0]?.results !== 5000 || rows[0].tokens !== 1 || rows[0].sessions !== 1)
				throw new Error("committed work is incomplete");
			console.log(
				JSON.stringify({
					round,
					queued,
					applicationMs,
					signinMs,
					tokenCreationMs: created.ms,
					completedBeforeReportRelease,
					...rows[0],
				}),
			);
		} finally {
			resume.resolve();
			await h.close();
			await drainDatabaseDrops();
		}
	}
}

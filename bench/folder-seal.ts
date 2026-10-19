// Compare sealing through the registry, excluding adoption and fixture construction.
// Usage: bun bench/folder-seal.ts /path/to/baseline/export [repeats]
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import type { Edit, ProposeReply } from "../src/core/ops.ts";

if (process.argv[2] === "--sample") {
	const root = process.argv[3];
	const kind = process.argv[4];
	const count = Number(process.argv[5]);
	assert(root && (kind === "create" || kind === "rename") && Number.isInteger(count) && count > 0);
	const { harness }: typeof import("../test/helpers.ts") = await import(`${root}/test/helpers.ts`);
	const h = harness({ preset: "standard" });
	try {
		const project = h.app.db.raw.query<{ id: number }, []>("SELECT id FROM projects WHERE key = 'scratch'").get();
		assert(project);
		const insert = h.app.db.raw.prepare(
			"INSERT INTO folders(project, parent, name, rank, rev) VALUES (?, NULL, ?, ?, 0)",
		);
		h.app.db.raw.transaction(() => {
			for (let i = 0; i < count; i++) insert.run(project.id, `Folder ${i}`, `rank-${i}`);
		})();
		const agent = h.actor("folder-writer", "agent", ["read", "produce"]);
		const edits: Edit[] = Array.from({ length: count }, (_, i) =>
			kind === "create"
				? { op: "folder", name: `New ${i}` }
				: { op: "folder", folder: `Folder ${i}`, name: `Renamed ${i}` },
		);
		const cpu = process.cpuUsage();
		const start = performance.now();
		const reply = h.call<ProposeReply>("propose", { edits }, agent);
		const ms = performance.now() - start;
		const used = process.cpuUsage(cpu);
		assert.equal(reply.status, "open");
		assert.equal(reply.proposal, "P-1");
		const stored = h.app.db.raw.query<{ resolved: string }, []>("SELECT resolved FROM proposals WHERE no = 1").get();
		assert(stored);
		assert.deepEqual(
			JSON.parse(stored.resolved).map((edit: { name: string }) => edit.name),
			edits.map((edit) => ("name" in edit ? edit.name : null)),
		);
		assert.equal(h.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM folders").get()?.n, count);
		console.log(
			JSON.stringify({ kind, count, ms, cpuMs: (used.user + used.system) / 1000, sealed: edits.length, errors: 0 }),
		);
	} finally {
		h.close();
	}
} else {
	const baseline = process.argv[2];
	const repeats = Number(process.argv[3] ?? 5);
	assert(baseline && Number.isInteger(repeats) && repeats >= 5, "supply a baseline checkout and at least five repeats");
	const head = resolve(import.meta.dir, "..");
	const medians = new Map<string, number>();
	for (const kind of ["create", "rename"]) {
		for (const count of [100, 1000, 5000]) {
			const samples: Record<"before" | "after", number[]> = { before: [], after: [] };
			for (let run = 0; run < repeats; run++) {
				for (const side of ["before", "after"] as const) {
					const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
						[
							process.execPath,
							import.meta.path,
							"--sample",
							side === "before" ? resolve(baseline) : head,
							kind,
							String(count),
						],
						{ stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "production" } },
					);
					const [stdout, stderr, code]: [string, string, number] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					assert.equal(code, 0, stderr);
					const sample: { ms: number; sealed: number; errors: number } = JSON.parse(stdout);
					assert.equal(sample.sealed, count);
					assert.equal(sample.errors, 0);
					samples[side].push(sample.ms);
					console.log(JSON.stringify({ side, run, ...JSON.parse(stdout) }));
				}
			}
			for (const side of ["before", "after"] as const) {
				const sorted = samples[side].toSorted((a, b) => a - b);
				const median = sorted[Math.floor(sorted.length / 2)];
				assert(median !== undefined);
				medians.set(`${kind}/${count}/${side}`, median);
				console.log(JSON.stringify({ kind, count, side, median, min: sorted[0], max: sorted.at(-1) }));
			}
		}
	}
	for (const kind of ["create", "rename"]) {
		const small = medians.get(`${kind}/1000/after`);
		const large = medians.get(`${kind}/5000/after`);
		assert(small && large);
		assert(large / small < 10, `${kind} sealing growth ${large / small}: expected <10 for 5x the batch`);
	}
}

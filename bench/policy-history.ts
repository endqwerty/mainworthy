import { cpus, loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GateStatus, InboxReply } from "../src/core/ops.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { ciReport, harness } from "../test/helpers.ts";
import { profile } from "./profile.ts";

const compare = process.argv[2];
const engines = [{ name: "after", invoke, ops: OPS }];
if (compare)
	engines.unshift({
		name: "before",
		invoke: (await import(pathToFileURL(resolve(compare, "src/server/ops/registry.ts")).href)).invoke,
		ops: (await import(pathToFileURL(resolve(compare, "src/server/ops/index.ts")).href)).OPS,
	});
console.log(JSON.stringify({ machine: { cores: cpus().length, load: loadavg(), bun: Bun.version } }));
for (const size of [100, 300]) {
	const h = await harness();
	try {
		await h.call("report", ciReport({ commit: "base0001", n: 1, fail: { 0: "same cause" } }));
		for (let pr = 1; pr <= size + 1; pr++) {
			await h.call(
				"report",
				ciReport({ commit: `history-${pr}`, pr, base: "base0001", n: 1, fail: { 0: "same cause" } }),
			);
			if (pr <= size) await h.call("change", { change: `pr:${pr}`, state: "closed" });
		}
		for (let round = 0; round < 5; round++) {
			for (const engine of round % 2 ? [...engines].reverse() : engines) {
				for (const preset of ["standard", "loose"]) {
					await h.call("propose", { edits: [{ op: "policy", preset }] });
					const q = InboxReply.parse(await h.call("inbox", { kind: "adopt" })).items[0];
					if (!q) throw new Error("no adoption");
					h.app.database.resetStatementCount();
					const t = performance.now();
					const reply = await engine.invoke(h.app, engine.ops, {
						op: "decide",
						project: "scratch",
						input: { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } },
						actor: async () => h.owner,
					});
					const ms = performance.now() - t;
					const statements = h.app.database.statementCount;
					if (!reply.ok) throw new Error(JSON.stringify(reply));
					const g = GateStatus.parse(await h.call("gate", { commit: `history-${size + 1}` }));
					if (g.tally.excused !== (preset === "loose" ? 1 : 0)) throw new Error("active gate did not update");
					console.log(JSON.stringify({ size, round, engine: engine.name, preset, ms, statements }));
				}
			}
		}
		await h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const q = InboxReply.parse(await h.call("inbox", { kind: "adopt" })).items[0];
		if (!q) throw new Error("no adoption");
		console.log(
			JSON.stringify(
				await profile(h.app, {
					name: `adoption-${size}`,
					prepare: () => () => h.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } }),
					check: () => {},
					budget: null,
					iterations: 1,
					correctness: "active gate follows adopted policy",
				}),
			),
		);
	} finally {
		await h.close();
	}
}

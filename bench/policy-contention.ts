import { Client } from "../src/cli/client.ts";
import { InboxReply } from "../src/core/ops.ts";
import { serve } from "../src/surfaces/http.ts";
import { ciReport, harness } from "../test/helpers.ts";

if (process.argv.includes("--server")) {
	const h = await harness();
	await h.call("report", ciReport({ commit: "base0001", n: 1, fail: { 0: "same cause" } }));
	for (let pr = 1; pr <= 101; pr++) {
		await h.call(
			"report",
			ciReport({ commit: `history-${pr}`, pr, base: "base0001", n: 1, fail: { 0: "same cause" } }),
		);
		if (pr <= 100) await h.call("change", { change: `pr:${pr}`, state: "closed" });
	}
	const server = serve(h.app, h.owner, { ui: null });
	process.send?.({ url: `http://127.0.0.1:${server.port}` });
	process.on("message", async () => {
		await server.stop(true);
		await h.close();
		process.exit(0);
	});
} else {
	let ready: (url: string) => void = () => {};
	const url = new Promise<string>((r) => {
		ready = r;
	});
	const child = Bun.spawn([process.execPath, import.meta.path, "--server"], {
		stdout: "inherit",
		stderr: "inherit",
		ipc(message) {
			if (message && typeof message === "object" && "url" in message && typeof message.url === "string")
				ready(message.url);
		},
	});
	try {
		const client = new Client({ url: await url, project: "scratch", token: undefined });
		for (let round = 0; round < 5; round++) {
			for (const preset of ["standard", "loose"] as const) {
				await client.call("propose", { edits: [{ op: "policy", preset }] });
				const q = InboxReply.parse(await client.call("inbox", { kind: "adopt" })).items[0];
				if (!q) throw new Error("no adoption");
				const start = performance.now();
				const adoption = client
					.call("decide", { q: q.q, onEvidence: q.evidenceHash, answer: { is: "accept" } })
					.then((result) => ({ result, ms: performance.now() - start }));
				await Bun.sleep(5);
				const readStart = performance.now();
				const read = client
					.call("gate", { commit: "history-101" })
					.then((result) => ({ result, ms: performance.now() - readStart }));
				const saveStart = performance.now();
				const save = client
					.call("propose", { edits: [{ op: "create", outline: `Saved during ${preset} ${round}` }] })
					.then((result) => ({ result, ms: performance.now() - saveStart }));
				const [a, r, s] = await Promise.all([adoption, read, save]);
				const gate = await client.call("gate", { commit: "history-101" });
				if (gate.tally.excused !== (preset === "loose" ? 1 : 0)) throw new Error("gate mismatch");
				console.log(
					JSON.stringify({
						round,
						preset,
						adoptionMs: a.ms,
						readMs: r.ms,
						saveMs: s.ms,
						adoption: a.result,
						save: s.result,
					}),
				);
			}
		}
	} finally {
		child.send("stop");
		await child.exited;
	}
}

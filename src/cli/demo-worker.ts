import { parentPort, workerData } from "node:worker_threads";
import { actorByName } from "../server/identity/identity.ts";
import { openApp } from "../server/kernel/app.ts";
import { type DemoResetData, resetDemoSteps } from "./demo.ts";

const data: DemoResetData = workerData;
if (!parentPort) throw new Error("a demo reset needs its parent thread");
const port = parentPort;
const progress = (step: string, ms: number) => port.postMessage({ kind: "progress", step, ms });
const opening = performance.now();
const app = openApp(data.config, {
	now: () => Date.now() + data.clockOffset,
});
progress("open reset database", performance.now() - opening);
try {
	const finding = performance.now();
	const owner = actorByName(app.db, data.owner, 0);
	progress("find demo owner", performance.now() - finding);
	if (!owner) throw new Error("the demo owner no longer exists");
	const resume = () =>
		new Promise<void>((resolve, reject) => {
			port.once("message", (message: unknown) =>
				message === "continue" ? resolve() : reject(new Error("invalid demo reset continuation")),
			);
		});
	// Audit beside the server's writes twice at most. A project written to faster than that (a minute job, a busy
	// pipeline) is audited under the gate, where nothing can make the audit stale; the first rounds warm the cache.
	for (let round = 1; ; round++) {
		const checking = performance.now();
		const version = round <= 2 ? app.db.foreignKeySnapshot() : undefined;
		if (version !== undefined) progress("preflight foreign keys", performance.now() - checking);
		const ready = resume();
		port.postMessage({ kind: "ready" });
		await ready;
		const steps = resetDemoSteps(app, owner, data.project, data.legacySeq, progress, version);
		let stale = false;
		try {
			for (;;) {
				const step = steps.next();
				if (step.done) {
					stale = step.value === "stale";
					break;
				}
				const continued = resume();
				port.postMessage({ kind: "pause", step: "removed" });
				await continued;
			}
		} finally {
			steps.return(undefined);
		}
		if (!stale) break;
		port.postMessage({ kind: "retry" });
	}
} finally {
	const closing = performance.now();
	app.close();
	progress("close reset database", performance.now() - closing);
}
port.postMessage({ kind: "done" });

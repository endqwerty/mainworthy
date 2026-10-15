import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { actorByName } from "../server/identity/identity.ts";
import { defaultConfig, openApp } from "../server/kernel/app.ts";
import { resetDemoSteps } from "./demo.ts";

const data = z
	.object({
		dataDir: z.string(),
		owner: z.string(),
		project: z.string(),
		legacySeq: z.number().nullable(),
		clockOffset: z.number(),
	})
	.parse(workerData);
if (!parentPort) throw new Error("a demo reset needs its parent thread");
const port = parentPort;
const app = openApp(defaultConfig({ MAINWORTHY_DATA: data.dataDir }), {
	now: () => Date.now() + data.clockOffset,
});
try {
	const owner = actorByName(app.db, data.owner, 0);
	if (!owner) throw new Error("the demo owner no longer exists");
	const steps = resetDemoSteps(app, owner, data.project, data.legacySeq, (step, ms) => {
		port.postMessage({ kind: "progress", step, ms });
	});
	try {
		for (let step = steps.next(); !step.done; step = steps.next()) {
			await new Promise<void>((resolve, reject) => {
				port.once("message", (message: unknown) =>
					message === "continue" ? resolve() : reject(new Error("invalid demo reset continuation")),
				);
				port.postMessage({ kind: "pause", step: "removed" });
			});
		}
	} finally {
		steps.return();
	}
	port.postMessage({ kind: "done" });
} finally {
	app.close();
}

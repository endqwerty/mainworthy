// Poll from another thread so the server cannot pause its own load generator.
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

const { url } = z.object({ url: z.string() }).parse(workerData);
if (!parentPort) throw new Error("archive polling needs a parent thread");
const port = parentPort;
let done = false;
port.on("message", () => {
	done = true;
});
let longest = 0;
let samples = 0;
let errors = 0;
do {
	const started = performance.now();
	try {
		const response = await fetch(`${url}/healthz`);
		const health = z.object({ ok: z.literal(true) }).safeParse(await response.json());
		if (response.status !== 200 || !health.success) errors++;
	} catch {
		errors++;
	}
	longest = Math.max(longest, performance.now() - started);
	samples++;
	if (samples === 1) port.postMessage("ready");
	await Bun.sleep(5);
} while (!done);
port.postMessage({ longest, samples, errors });
port.close();

import { z } from "zod";
import { openPage, startServer } from "./support.ts";

const server = await startServer({ cases: 2000 });
const harness = await openPage(server);
try {
	await harness.page.waitForFunction(
		() => Number(document.querySelector('[data-testid="case-list"]')?.getAttribute("data-loaded")) >= 2000,
	);
	const cdp = await harness.context.newCDPSession(harness.page);
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.start");
	for (let i = 0; i < 30; i++) {
		await harness.page.keyboard.press("c");
		await harness.page.keyboard.press("Escape");
	}
	await harness.page.keyboard.press("c");
	await harness.page.keyboard.type("Profile sample");
	await harness.page.keyboard.press("Enter");
	await harness.page.keyboard.type("a".repeat(30));
	const report = z
		.object({
			profile: z.object({
				nodes: z.array(
					z.object({ id: z.number(), callFrame: z.object({ functionName: z.string(), url: z.string() }) }),
				),
				samples: z.array(z.number()),
			}),
		})
		.parse(await cdp.send("Profiler.stop"));
	const counts = new Map<number, number>();
	for (const sample of report.profile.samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);
	console.info(
		JSON.stringify(
			report.profile.nodes
				.map((node) => ({
					function: node.callFrame.functionName,
					source: node.callFrame.url.replace(server.url, "<server>"),
					samples: counts.get(node.id) ?? 0,
				}))
				.filter((node) => node.samples > 0)
				.sort((a, b) => b.samples - a.samples)
				.slice(0, 12),
		),
	);
} finally {
	await harness.close();
	await server.stop();
}

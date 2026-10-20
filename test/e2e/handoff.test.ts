import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ciReport } from "../helpers.ts";
import { browserAvailable, openPage, startServer } from "./support.ts";

const secret = "e2e-handoff-signing-secret";

(browserAvailable ? test : test.skip)(
	"a failure is copied for any agent, and a tap on a phone hands it to the configured one",
	async () => {
		const received: { body: string; signature: string | null }[] = [];
		const endpoint = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				received.push({ body: await request.text(), signature: request.headers.get("x-mainworthy-signature") });
				return new Response(null, { status: 202 });
			},
		});
		const server = await startServer({ handoff: { url: `http://127.0.0.1:${endpoint.port}/hook`, secret } });
		const pages: Awaited<ReturnType<typeof openPage>>[] = [];
		try {
			await server.api(
				"report",
				ciReport({ commit: "c0ffee0001", branch: "fix-total", n: 2, fail: { 1: "expected 90, got 100" } }),
			);
			const q = (await server.api("inbox", { kind: "failure" })).items[0]?.q;
			if (!q) throw new Error("expected a failure question");
			const path = `/p/scratch/queue/${q.slice(2)}`;

			const desktop = await openPage(server, { path });
			pages.push(desktop);
			desktop.page.setDefaultTimeout(8000);
			await desktop.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
			await desktop.page.getByRole("button", { name: "Copy for an agent" }).click();
			await desktop.page.waitForFunction(() => document.querySelector("#stat")?.textContent?.includes("Copied"));
			const copied = await desktop.page.evaluate(() => navigator.clipboard.readText());
			expect(copied).toContain(`Mainworthy question ${q} in project scratch`);
			expect(copied).toContain(`${server.url}${path}`);
			expect(copied).toContain("expected 90, got 100");
			expect(copied).toContain("- T-2 test 1");
			expect(received).toEqual([]);

			const phone = await openPage(server, { path, device: "phone" });
			pages.push(phone);
			phone.page.setDefaultTimeout(8000);
			await phone.page.getByRole("button", { name: "Hand to the agent" }).tap();
			await phone.page.getByRole("status").filter({ hasText: "Sent to the agent" }).waitFor();
			await phone.page.getByRole("button", { name: "Hand to the agent again" }).waitFor();
			expect(received).toHaveLength(1);
			const [post] = received;
			expect(post?.signature).toBe(
				`sha256=${createHmac("sha256", secret)
					.update(post?.body ?? "")
					.digest("hex")}`,
			);
			expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
				project: "scratch",
				question: q,
				message: "expected 90, got 100",
				branch: "fix-total",
			});
			expect([...desktop.errors, ...phone.errors]).toEqual([]);
		} finally {
			for (const view of pages) await view.close();
			await server.stop();
			await endpoint.stop(true);
		}
	},
	60_000,
);

// The browser the tests of one file share (`support.ts`): what a test may rely on from the one before it.
import { expect, test } from "bun:test";
import { browserAvailable, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"two pages share the browser and none of what a page stores",
	async () => {
		const server = await startServer({ source: true });
		const first = await openPage(server);
		try {
			await first.page.evaluate(() => localStorage.setItem("left-behind", "by the first page"));
			await first.context.addCookies([{ name: "left-behind", value: "1", url: server.url }]);
			const second = await openPage(server);
			try {
				expect(second.context.browser()).toBe(first.context.browser());
				expect(second.context).not.toBe(first.context);
				expect(await second.page.evaluate(() => localStorage.getItem("left-behind"))).toBeNull();
				expect((await first.context.cookies()).map((cookie) => cookie.name)).toContain("left-behind");
				expect((await second.context.cookies()).map((cookie) => cookie.name)).not.toContain("left-behind");
				// Each is signed in on its own: closing one leaves the other its session.
				await first.close();
				await second.page.reload();
				await second.page.waitForSelector("#app");
			} finally {
				await second.close();
			}
		} finally {
			await first.close().catch(() => {});
			await server.stop();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"after the shared browser has died, the next page has a new one",
	async () => {
		// Bun ends the processes of a test that ran out of time. The tests after it must not fail for that.
		const server = await startServer();
		try {
			const first = await openPage(server);
			const dead = first.context.browser();
			await dead?.close();
			const second = await openPage(server);
			try {
				expect(second.context.browser()).not.toBe(dead);
				expect(second.context.browser()?.isConnected()).toBe(true);
				await second.page.waitForSelector("#app");
			} finally {
				await second.close();
			}
		} finally {
			await server.stop();
		}
	},
	30_000,
);

import { expect, test } from "bun:test";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5RkAAAAASUVORK5CYII=";
test.skipIf(!browserAvailable)(
	"paste a screenshot into a failed slot, retain files per slot, and display raster evidence with safe downloads",
	async () => {
		const server = await startServer({ cases: 0, seed: false });
		await server.api("propose", {
			edits: [
				{ op: "create", outline: "Screen failure\n  Open > Visible" },
				{ op: "create", outline: "Second slot\n  Open > Visible" },
			],
		});
		const run = await server.api("plan", { name: "Attachments", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		try {
			const { page } = h;
			const note = page.getByRole("textbox", { name: "Result note", disabled: false });
			await note.waitFor();
			await page.keyboard.press("1");
			expect(await page.locator(".run-control-hint").innerText()).toContain("Step 1 marked.");
			await note.evaluate((input, data) => {
				const transfer = new DataTransfer();
				transfer.items.add(
					new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], "pasted.png", { type: "image/png" }),
				);
				input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
			}, PNG);
			await page.getByRole("button", { name: "Remove pasted.png" }).waitFor();
			await page.keyboard.press("j");
			expect(await page.getByRole("button", { name: "Remove pasted.png" }).count()).toBe(0);
			await page.keyboard.press("k");
			await page.getByRole("button", { name: "Remove pasted.png" }).waitFor();
			await page.getByLabel("Attach a file", { exact: true }).setInputFiles({
				name: "page.html",
				mimeType: "text/html",
				buffer: Buffer.from("<script>window.attachmentExecuted=true</script>"),
			});
			await page.getByRole("button", { name: "Remove page.html" }).waitFor();
			await note.fill("Screenshot of the failure");
			await page.keyboard.press("Enter");
			await eventually(
				async () =>
					(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result").length,
				(count) => count === 1,
			);
			const recorded = (await server.api("timeline", { ref: "C-1" })).entries.find((entry) => entry.t === "result");
			if (recorded?.t !== "result" || !recorded.atStep) throw new Error("The failed step was not recorded");
			const evidence = await server.api("attachment", { result: recorded.id });
			expect(evidence.kind === "list" && evidence.items.every((item) => item.at === recorded.atStep)).toBe(true);
			await page.keyboard.press("k");
			const screenshot = page.getByRole("img", { name: "pasted.png" });
			await screenshot.waitFor();
			expect(
				await eventually(
					() =>
						screenshot.evaluate(
							(image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1,
						),
					(ready) => ready,
				),
			).toBe(true);
			// Read, the image lets its object URL go: the bytes are not kept twice for as long as the page is open.
			expect(
				await screenshot.evaluate(
					(image) =>
						new Promise<string>((settled) => {
							const probe = new Image();
							probe.onload = () => settled("still held");
							probe.onerror = () => settled("released");
							probe.src = (image as HTMLImageElement).src;
						}),
				),
			).toBe("released");
			expect(await page.locator("iframe,object,embed").count()).toBe(0);
			const download = page.waitForEvent("download");
			await page.getByRole("button", { name: "Download page.html" }).click();
			expect((await download).suggestedFilename()).toBe("page.html");
			expect(await page.evaluate(() => "attachmentExecuted" in window)).toBe(false);
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			await page.getByText("Timeline", { exact: true }).waitFor();
			await page.getByRole("img", { name: "pasted.png" }).waitFor();
		} finally {
			await h.close();
			await server.stop();
		}
	},
	30000,
);

test.skipIf(!browserAvailable)(
	"files selected while a report is pending belong only to the next result",
	async () => {
		const server = await startServer({ cases: 0, seed: false });
		await server.api("propose", { edits: [{ op: "create", outline: "Pending evidence\n  Open > Visible" }] });
		const run = await server.api("plan", { name: "Pending attachments", select: {} });
		const h = await openPage(server, { path: `/p/scratch/runs/${run.run.slice(2)}` });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let reports = 0;
		try {
			const { page } = h;
			await page.route("**/report", async (route) => {
				reports++;
				if (reports === 1) {
					entered.resolve();
					await release.promise;
				}
				await route.continue();
			});
			const picker = page.getByLabel("Attach a file", { exact: true });
			await picker.setInputFiles({ name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") });
			await page.getByRole("button", { name: "Remove first.txt" }).waitFor();
			const note = page.getByRole("textbox", { name: "Result note" });
			await note.fill("First result");
			await page.keyboard.press("Enter");
			await entered.promise;
			await picker.setInputFiles({ name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") });
			await page.getByRole("button", { name: "Remove second.txt" }).waitFor();
			await note.fill("Second result");
			await page.keyboard.press("Enter");
			release.resolve();
			const entries = await eventually(
				async () => (await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
				(items) => items.length === 2,
			);
			const first = entries.find((entry) => entry.note === "First result");
			const second = entries.find((entry) => entry.note === "Second result");
			if (!first || !second) throw new Error("Both results were not saved");
			const files = await server.api("attachment", { result: first.id });
			const later = await server.api("attachment", { result: second.id });
			expect(files.kind === "list" && files.items.map((item) => item.name)).toEqual(["first.txt"]);
			expect(later.kind === "list" && later.items.map((item) => item.name)).toEqual(["second.txt"]);
		} finally {
			release.resolve();
			await h.close();
			await server.stop();
		}
	},
	30000,
);

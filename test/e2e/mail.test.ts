import { expect, test } from "bun:test";
import { fakeSmtp } from "../mail-support.ts";
import { browserAvailable, eventually, openPage, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"mail enables invitation, verification and reset pages, and reset keeps the person signed out",
	async () => {
		const smtp = await fakeSmtp();
		const server = await startServer({ mode: "server", mail: { port: smtp.port } });
		const browser = await openPage(server, { signedIn: false });
		try {
			const { page } = browser;
			await page.getByRole("link", { name: "Forgot your password?" }).click();
			await page.getByRole("heading", { name: "Reset your password" }).waitFor();
			if (process.env.MAINWORTHY_MAIL_SCREENSHOT)
				await page.screenshot({ path: process.env.MAINWORTHY_MAIL_SCREENSHOT, fullPage: true });
			await page.getByLabel("Email address", { exact: true }).fill("unknown@example.com");
			await page.getByRole("button", { name: "Send reset link", exact: true }).click();
			await page
				.getByText("If this address is verified for an account, a reset link will arrive. Check your inbox.", {
					exact: true,
				})
				.waitFor();
			expect(smtp.messages).toHaveLength(0);
			await page.getByRole("button", { name: "Back to sign-in" }).click();
			await page.locator("#token").fill(server.token);
			await page.getByRole("button", { name: "Sign in with the token", exact: true }).click();
			await page.locator("#app").waitFor();
			await page.goto(`${server.url}/p/scratch/settings`);
			await page.getByRole("option", { name: "People", exact: true }).click();
			await page.locator("#invite-name").fill("mail-browser");
			await page.locator("#invite-email").fill("robin@example.com");
			await page.getByRole("button", { name: "Make invitation link", exact: true }).click();
			const invitation = await eventually(
				async () => smtp.messages.find((message) => message.text.includes("/invite#"))?.text ?? "",
				(text) => text.includes("/invite#"),
			);
			const invitationCode = /\/invite#([A-Za-z0-9_-]+)/.exec(invitation)?.[1];
			expect((await page.request.post(`${server.url}/api/logout`, { data: {} })).status()).toBe(200);
			await page.goto(`${server.url}/invite#${invitationCode}`);
			await page.locator("#invite-password").fill("a quite long browser password");
			await page.locator("#invite-password-again").fill("a quite long browser password");
			await page.getByRole("button", { name: "Accept and sign in" }).click();
			await page.locator("#app").waitFor();
			await page.goto(`${server.url}/p/scratch/settings`);
			await page.getByRole("option", { name: "Your sign-in", exact: true }).click();
			await page.getByLabel("Email address", { exact: true }).fill("robin@example.com");
			await page.getByRole("button", { name: "Send verification link" }).click();
			const verification = await eventually(
				async () => smtp.messages.find((message) => message.text.includes("/email#"))?.text ?? "",
				(text) => text.includes("/email#"),
			);
			const code = /\/email#([A-Za-z0-9_-]+)/.exec(verification)?.[1];
			await page.goto(`${server.url}/email#${code}`);
			await page.getByRole("button", { name: "Verify email", exact: true }).click();
			await page.getByText("Your email address is verified.", { exact: true }).waitFor();
			await page.goto(`${server.url}/reset`);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			await page.route("**/api/login", async (route) => {
				if (route.request().postDataJSON()?.resetRequest === "delayed@example.com") {
					entered.resolve();
					await release.promise;
					await route.fulfill({ contentType: "application/json", body: '{"ok":true,"result":{"requested":true}}' });
				} else await route.continue();
			});
			await page.getByLabel("Email address", { exact: true }).fill("delayed@example.com");
			await page.getByRole("button", { name: "Send reset link", exact: true }).click();
			await entered.promise;
			expect(
				(await page.request.post(`${server.url}/api/login`, { data: { resetRequest: "robin@example.com" } })).status(),
			).toBe(200);
			const reset = await eventually(
				async () => smtp.messages.find((message) => message.text.includes("/reset#"))?.text ?? "",
				(text) => text.includes("/reset#"),
			);
			const resetCode = /\/reset#([A-Za-z0-9_-]+)/.exec(reset)?.[1];
			await page.goto(`${server.url}/reset#${resetCode}`);
			const oldReply = page.waitForResponse(
				(response) =>
					response.url().endsWith("/api/login") &&
					response.request().postDataJSON()?.resetRequest === "delayed@example.com",
			);
			release.resolve();
			await oldReply;
			await page.getByLabel("New password", { exact: true }).fill("a quite different browser password");
			await page.getByRole("button", { name: "Reset password", exact: true }).click();
			await page.getByText(/Your password was reset and your existing sessions ended/).waitFor();
			await page.getByRole("button", { name: "Back to sign-in" }).click();
			await page.locator("#signin-name").waitFor();
			expect(await page.locator("#app").count()).toBe(0);
		} finally {
			await browser.close();
			await server.stop();
			await smtp.close();
		}
	},
	30_000,
);

test.skipIf(!browserAvailable)(
	"an instance without SMTP hides reset and invitation mail controls",
	async () => {
		const server = await startServer({ mode: "server" });
		const browser = await openPage(server, { signedIn: false });
		try {
			const { page } = browser;
			await page.locator("#token").waitFor();
			expect(await page.getByRole("link", { name: "Forgot your password?" }).count()).toBe(0);
			await page.locator("#token").fill(server.token);
			await page.getByRole("button", { name: "Sign in with the token", exact: true }).click();
			await page.locator("#app").waitFor();
			await page.goto(`${server.url}/p/scratch/settings`);
			await page.getByRole("option", { name: "People", exact: true }).click();
			await page.locator("#invite-name").waitFor();
			expect(await page.locator("#invite-email").count()).toBe(0);
		} finally {
			await browser.close();
			await server.stop();
		}
	},
	20_000,
);

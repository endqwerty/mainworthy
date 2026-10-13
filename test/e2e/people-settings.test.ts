// What a person does about their own sign-in in Settings, and what an admin does about other people's: the
// password, the sessions, and invitations.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import type { Capability } from "../../src/core/kinds.ts";
import { browserAvailable, eventually, openPage, type PageHarness, type Server, startServer } from "./support.ts";

let server: Server;
beforeAll(async () => {
	if (browserAvailable) server = await startServer({ mode: "server" });
});
afterAll(async () => {
	await server?.stop();
});

const OLD = "the first password";
const NEW = "the second password";

/**
 * A person who signs in with a name and a password, made as a script would: invited by the owner, accepted
 * with no page. Accepting signs the script in, and it signs out again, so the person starts with no session.
 */
async function person(name: string, can?: Capability[]): Promise<void> {
	const made = await server.api("invitation", { do: "create", name, ...(can ? { can } : {}) });
	if (!("code" in made)) throw new Error("no invitation was made");
	const post = (path: string, body: unknown, cookie?: string) =>
		fetch(`${server.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			body: JSON.stringify(body),
		});
	const accepted = await post("/api/login", { invitation: made.code, password: OLD });
	if (!accepted.ok) throw new Error(`the invitation was not accepted: ${accepted.status}`);
	const cookie = accepted.headers.getSetCookie().find((set) => set.startsWith("mainworthy_sid="));
	await post("/api/logout", {}, cookie?.split(";")[0]);
}
const section = (page: Page, name: string) => page.getByRole("option", { name, exact: true }).click();
const rows = (page: Page) => page.locator(".settings-row");

test.skipIf(!browserAvailable)(
	"changing the password ends the person's other session; the sessions list ends another session, then this browser's",
	async () => {
		await person("sam", ["read", "answer"]);
		let one: PageHarness | null = null;
		let two: PageHarness | null = null;
		try {
			one = await openPage(server, { as: { name: "sam", password: OLD }, path: "/p/scratch/settings" });
			two = await openPage(server, { as: { name: "sam", password: OLD } });
			const { page } = one;
			page.setDefaultTimeout(8000);

			await section(page, "Your sessions");
			await rows(page).nth(1).waitFor();
			expect(await rows(page).count()).toBe(2);
			expect(await rows(page).filter({ hasText: "this browser" }).count()).toBe(1);
			expect(await rows(page).first().innerText()).toContain("password");
			// Where each was opened and last used from, as the server saw the browser.
			for (const text of await rows(page).allInnerTexts()) {
				expect(text).toMatch(/opened with the password from 127\.0\.0\.1 · /);
				expect(text).toMatch(/last used \S+ from 127\.0\.0\.1 · /);
			}

			// A wrong current password changes nothing, says so beside the field, and keeps what was typed.
			await section(page, "Your sign-in");
			// `n` goes to the new password, as it goes to a new token or a new project in their sections.
			await page.locator("#password-next").waitFor();
			await page.keyboard.press("n");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("password-next");
			await page.keyboard.type(NEW);
			await page.getByText("19 characters", { exact: true }).waitFor();
			await page.locator("#password-current").fill("not the password");
			await page.locator("#password-again").fill(NEW);
			// Wrong too often: the wait is said beside the current password, and nothing typed is lost. A test
			// answers in the server's place, because a real block would refuse the right password below as well.
			await page.route("**/api/account/password", (route) =>
				route.fulfill({
					status: 429,
					headers: { "retry-after": "7" },
					json: { ok: false, error: { code: "limited", message: "too many failed attempts; try again in 7 seconds" } },
				}),
			);
			await page.locator("#password-again").press("Enter");
			await page
				.locator("#password-current + [role=status]")
				.filter({ hasText: "Too many attempts. Try again in 7 seconds." })
				.waitFor();
			expect(await page.locator("#password-next").inputValue()).toBe(NEW);
			expect(await page.locator("#app").count()).toBe(1);
			await page.unroute("**/api/account/password");
			await page.locator("#password-again").press("Enter");
			await page.getByRole("status").filter({ hasText: "The current password is not right." }).waitFor();
			expect(await page.locator("#password-next").inputValue()).toBe(NEW);
			await page.locator("#password-current").fill(OLD);
			await page.keyboard.press("Enter");
			await page.getByRole("status").filter({ hasText: "Password changed. 1 other session ended." }).waitFor();
			// The fields are empty again: the password is not left on the page.
			expect(await page.locator("#password-next").inputValue()).toBe("");

			// The other browser is signed out; this one is not.
			await two.page.reload();
			await two.page.locator("#signin-name").waitFor();
			await section(page, "Your sessions");
			await eventually(
				() => rows(page).count(),
				(count) => count === 1,
			);
			expect(await page.locator("#app").count()).toBe(1);

			// The other browser signs in again, with the new password, and is in the list.
			await two.page.locator("#signin-name").fill("sam");
			await two.page.locator("#signin-password").fill(NEW);
			await two.page.keyboard.press("Enter");
			await two.page.locator("#app").waitFor();
			await section(page, "Your sign-in");
			await section(page, "Your sessions");
			await rows(page).nth(1).waitFor();
			const other = rows(page).filter({ hasNotText: "this browser" });
			expect(await other.count()).toBe(1);
			await other.getByRole("button", { name: "End" }).click();
			await eventually(
				() => rows(page).count(),
				(count) => count === 1,
			);
			await two.page.reload();
			await two.page.locator("#signin-name").waitFor();

			// Ending this browser's own session is signing out.
			await rows(page).filter({ hasText: "this browser" }).getByRole("button", { name: "End" }).click();
			await page.locator("#signin-name").waitFor();
			expect(await page.locator("#app").count()).toBe(0);
			// The two refusals this journey asked for: the wait a test answered, and the wrong current password.
			expect(one.errors).toEqual([
				"Failed to load resource: the server responded with a status of 429 (Too Many Requests)",
				"Failed to load resource: the server responded with a status of 403 (Forbidden)",
			]);
			expect(two.errors).toEqual([]);
		} finally {
			await one?.close();
			await two?.close();
		}
	},
	40_000,
);

test.skipIf(!browserAvailable)(
	"an admin invites somebody, sees the link once and revokes it, and makes a recovery link for a person who exists",
	async () => {
		await person("tess", ["read"]);
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = browser;
			page.setDefaultTimeout(8000);
			await browser.context.grantPermissions(["clipboard-read", "clipboard-write"]);
			/** The newest invitation for a name, of one purpose, as the server lists it. */
			const invitation = async (name: string, purpose: "join" | "recover") => {
				const list = await server.api("invitation", { do: "list" });
				return Array.isArray(list) ? list.filter((row) => row.name === name && row.purpose === purpose).at(-1) : null;
			};
			const shows = (code: string) =>
				fetch(`${server.url}/api/login/challenge`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ invitation: code }),
				}).then((reply) => reply.status);

			await section(page, "People");
			await page.locator("#invite-name").fill("kim");
			// What they may do starts as what a person needs to work. `admin` is not ticked, and a line under the
			// boxes says what ticking it gives.
			const may = page.locator(".settings-capabilities label");
			expect(await may.filter({ has: page.locator("input:checked") }).allInnerTexts()).toEqual([
				"read",
				"record",
				"produce",
				"answer",
				"plan",
			]);
			expect(await may.filter({ has: page.locator("input:not(:checked)") }).allInnerTexts()).toEqual(["admin"]);
			await page.getByText("admin lets a person change the policy", { exact: false }).waitFor();
			await page.getByRole("checkbox", { name: "plan", exact: true }).uncheck();
			await page.locator("#invite-project").selectOption("scratch");
			await page.locator("#invite-expires").focus();
			await page.locator("#invite-expires").selectOption("1w");
			// The select gave focus back, so the next plain key is the section's own: `n` goes to the name.
			await page.keyboard.press("n");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("invite-name");
			expect(await page.locator("#invite-name").inputValue()).toBe("kim");
			await page.keyboard.press("Enter");

			const link = page.getByLabel("Invitation link");
			await link.waitFor();
			const address = await link.inputValue();
			expect(address).toMatch(new RegExp(`^${server.url}/invite#[A-Za-z0-9_-]{20,}$`));
			const code = address.split("#")[1] ?? "";
			expect(await shows(code)).toBe(200);
			await page.getByText("kim · read, record, produce, answer · scratch", { exact: false }).waitFor();
			await page.getByRole("button", { name: "Copy link" }).click();
			await page.getByText("Link copied.", { exact: true }).waitFor();
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
			// The name is empty for the next person; the link is gone when it is dismissed, and is not shown again.
			expect(await page.locator("#invite-name").inputValue()).toBe("");
			await page.getByRole("button", { name: "Dismiss link" }).click();
			expect(await link.count()).toBe(0);
			expect(await page.content()).not.toContain(code);

			// The open invitation, with who made it and when it runs out. Revoked, the link accepts nothing.
			// (kim is a person from the moment they are invited, so there is a row for them further down too.)
			const open = rows(page).filter({ hasText: "kim" }).filter({ hasText: "to join" });
			await open.waitFor();
			expect(await open.innerText()).toContain("made by robin");
			expect(await open.innerText()).toContain("runs out in 7d");
			// What it grants, which holds no `admin`: the server made kim with what was ticked.
			expect(await open.innerText()).toContain("scratch: read, record, produce, answer · made by");
			expect(await invitation("kim", "join")).toMatchObject({
				grants: [{ project: "scratch", can: ["read", "record", "produce", "answer"] }],
			});
			await page.getByRole("button", { name: "Revoke the invitation for kim" }).click();
			await open.waitFor({ state: "detached" });
			expect(await invitation("kim", "join")).toMatchObject({ state: "revoked", createdBy: "robin" });
			expect(await shows(code)).toBe(404);

			// An inviter who wants an admin ticks the box, and it is off again for the person after.
			await page.locator("#invite-name").fill("lee");
			await page.getByRole("checkbox", { name: "admin", exact: true }).check();
			await page.locator("#invite-name").press("Enter");
			await page.getByText("lee · read, record, produce, answer, admin · scratch", { exact: false }).waitFor();
			expect(await page.getByRole("checkbox", { name: "admin", exact: true }).isChecked()).toBe(false);
			await page.getByRole("button", { name: "Dismiss link" }).click();

			// A name that signs in already is not invited as new: the form says where a recovery link is made.
			await page.locator("#invite-name").fill("tess");
			await page.getByText("tess signs in here already.", { exact: false }).waitFor();
			expect(await page.getByRole("button", { name: "Make invitation link" }).isDisabled()).toBe(true);
			await page.locator("#invite-name").fill("");

			// The recovery link asks first, and says what it replaces.
			await page.getByRole("button", { name: "Recovery link for tess" }).click();
			await page.getByText("it replaces every way tess signs in", { exact: false }).waitFor();
			expect(await invitation("tess", "recover")).toBeUndefined();
			await page.getByRole("button", { name: "Make the recovery link" }).click();
			await link.waitFor();
			expect(await invitation("tess", "recover")).toMatchObject({ state: "open" });
			expect(await shows((await link.inputValue()).split("#")[1] ?? "")).toBe(200);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
		}
	},
	40_000,
);

test.skipIf(!browserAvailable)(
	"a person who is not an admin sees no People section, and an admin who is not the owner is told who makes a recovery link",
	async () => {
		await person("uri", ["read", "answer"]);
		await person("ada");
		let reader: PageHarness | null = null;
		let admin: PageHarness | null = null;
		try {
			reader = await openPage(server, { as: { name: "uri", password: OLD }, path: "/p/scratch/settings" });
			await reader.page.getByRole("option", { name: "Your sessions", exact: true }).waitFor();
			const listed = reader.page.getByRole("listbox", { name: "Settings sections" }).getByRole("option");
			expect(await listed.allInnerTexts()).toEqual([
				"Policy",
				"Tokens",
				"Projects",
				"Connect",
				"Your sign-in",
				"Your sessions",
			]);
			expect(reader.errors).toEqual([]);

			admin = await openPage(server, { as: { name: "ada", password: OLD }, path: "/p/scratch/settings" });
			const { page } = admin;
			page.setDefaultTimeout(8000);
			await section(page, "People");
			// ada administers and does not own the instance. The server lets ada make a recovery link for ada and
			// for nobody else, and that is what the page offers: no button that would be answered 403.
			await rows(page).filter({ hasText: "uri" }).waitFor();
			expect(
				await page
					.getByRole("button", { name: /^Recovery link for / })
					.evaluateAll((all) => all.map((b) => b.ariaLabel)),
			).toEqual(["Recovery link for ada"]);
			await page.getByText("For anybody else the owner of the instance makes it", { exact: false }).waitFor();
			await page.getByRole("button", { name: "Recovery link for ada" }).click();
			await page.getByRole("button", { name: "Make the recovery link" }).click();
			await page.getByLabel("Invitation link for ada").waitFor();
			expect(admin.errors).toEqual([]);
		} finally {
			await reader?.close();
			await admin?.close();
		}
	},
	40_000,
);

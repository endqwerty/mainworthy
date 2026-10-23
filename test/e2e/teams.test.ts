import { expect, test } from "bun:test";
import { z } from "zod";
import api1Actors from "../fixtures/cli/actor-list-api1.json";
import { advanceClock, browserAvailable, openPage, type PageHarness, startServer } from "./support.ts";

test.skipIf(!browserAvailable)(
	"People manages teams and shows their grants; removing membership ends permission immediately",
	async () => {
		const server = await startServer({ mode: "server" });
		let browser: PageHarness | null = null;
		try {
			const made = await server.api("admin", {
				do: "token.create",
				actor: "team-person",
				kind: "human",
				can: ["read"],
			});
			const { token } = z.object({ token: z.string() }).parse(made);
			browser = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = browser;
			await page.getByRole("option", { name: "People", exact: true }).click();
			const teams = page.getByRole("region", { name: "Teams", exact: true });
			await teams
				.getByText("Teams grant permissions only. Assign named roles on each person's own grant.", { exact: false })
				.waitFor();
			await teams.getByLabel("New team name").fill("Quality");
			await teams.getByRole("button", { name: "Create team", exact: true }).click();
			await teams.getByRole("heading", { name: "Quality", exact: true }).waitFor();
			await teams.getByLabel("Grant on", { exact: true }).selectOption("scratch");
			await teams
				.getByRole("group", { name: "Team permissions" })
				.getByRole("checkbox", { name: "produce", exact: true })
				.check();
			await page.route("**/api/admin", (route) =>
				route.request().postDataJSON().do === "team.grant.set" ? route.abort() : route.continue(),
			);
			await teams.getByRole("button", { name: "Set team grant", exact: true }).click();
			await teams.getByRole("status").filter({ hasText: "the page cannot tell whether the team changed" }).waitFor();
			expect(await teams.getByRole("checkbox", { name: "produce", exact: true }).isChecked()).toBe(true);
			expect(await teams.getByLabel("Grant on", { exact: true }).inputValue()).toBe("scratch");
			await page.unroute("**/api/admin");
			await teams.getByRole("button", { name: "Set team grant", exact: true }).click();
			await teams.getByText("scratch: record, produce", { exact: true }).waitFor();
			await teams.getByLabel("Person to add").selectOption("team-person");
			await teams.getByRole("button", { name: "Add team member", exact: true }).click();
			await page.getByText("From team Quality: scratch: record, produce", { exact: true }).waitFor();
			await server.api("propose", { edits: [{ op: "create", outline: "Team authored case" }] }, { token });
			await teams.getByRole("button", { name: "Remove team-person from Quality", exact: true }).click();
			await page
				.getByText("From team Quality: scratch: record, produce", { exact: true })
				.waitFor({ state: "detached" });
			await expect(
				server.api("propose", { edits: [{ op: "create", outline: "Refused after removal" }] }, { token }),
			).rejects.toThrow("produce");
			const found = await server.api("find", {}, { token });
			expect(found.count).toBe(1);
			await teams.getByRole("button", { name: "Remove scratch grant from Quality", exact: true }).click();
			await teams.getByText("This team has no grants.", { exact: true }).waitFor();
			expect(browser.errors).toEqual(["Failed to load resource: net::ERR_FAILED"]);
		} finally {
			await browser?.close();
			await server.stop();
		}
	},
	25_000,
);

test.skipIf(!browserAvailable)(
	"People reads main's API 1 actor reply without teams",
	async () => {
		const server = await startServer({ mode: "server" });
		let browser: PageHarness | null = null;
		try {
			browser = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = browser;
			await page.route("**/api/admin", (route) =>
				route.request().postDataJSON().do === "actor.list" ? route.fulfill({ json: api1Actors }) : route.continue(),
			);
			await page.getByRole("option", { name: "People", exact: true }).click();
			await page
				.getByText("Own grants: every project: read, record, produce, answer, plan, admin", { exact: true })
				.waitFor();
			expect(await page.getByRole("button", { name: "Create team", exact: true }).isVisible()).toBe(true);
			expect(browser.errors).toEqual([]);
		} finally {
			await browser?.close();
			await server.stop();
		}
	},
	15_000,
);

test.skipIf(!browserAvailable)(
	"admin team grants and membership additions prompt for the caller's proof",
	async () => {
		const server = await startServer({ mode: "server" });
		let browser: PageHarness | null = null;
		try {
			await server.api("admin", { do: "token.create", actor: "team-target", kind: "human", can: ["read"] });
			browser = await openPage(server, { path: "/p/scratch/settings" });
			const { page } = browser;
			expect(
				(
					await page.request.post(`${server.url}/api/account/password`, { data: { next: "the owner password" } })
				).status(),
			).toBe(200);
			await page.getByRole("option", { name: "People", exact: true }).click();
			const teams = page.getByRole("region", { name: "Teams", exact: true });
			await teams.getByLabel("New team name").fill("Administrators");
			await teams.getByRole("button", { name: "Create team", exact: true }).click();
			await teams.getByRole("heading", { name: "Administrators", exact: true }).waitFor();
			await teams.getByRole("checkbox", { name: "admin", exact: true }).check();
			const confirm = async () => {
				const proof = teams.getByRole("region", { name: "Confirm your sign-in", exact: true });
				await proof.getByLabel("Password", { exact: true }).fill("the owner password");
				await proof.getByRole("button", { name: "Confirm credential", exact: true }).click();
			};
			await teams.getByRole("button", { name: "Set team grant", exact: true }).click();
			await confirm();
			await teams.getByRole("status").filter({ hasText: "Team updated." }).waitFor();
			await advanceClock(server, 10 * 60_000 + 1);
			await teams.getByLabel("Person to add").selectOption("team-target");
			await teams.getByRole("button", { name: "Add team member", exact: true }).click();
			await confirm();
			await teams.getByRole("button", { name: "Remove team-target from Administrators", exact: true }).waitFor();
			expect(browser.errors).toEqual(
				Array(2).fill("Failed to load resource: the server responded with a status of 403 (Forbidden)"),
			);
		} finally {
			await browser?.close();
			await server.stop();
		}
	},
	30_000,
);

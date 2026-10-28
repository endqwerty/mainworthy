// `mainworthy invite` against a real server: the link is printed once, a list never shows it, and a revoked
// invitation signs nobody in. The long test starts no process: its commands are run by `runCli` in the test's own
// process (`run` in `test-support.ts`).
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type Provider, provider, stopProviders } from "../../test/oidc-support.ts";
import type { Instance } from "../app/start.ts";
import { outputWith, withInstance } from "./test-support.ts";

afterEach(() => stopProviders());

const PUBLIC = "https://mainworthy.example";
/** What an instance is told of the provider people accept an invitation through. */
const withProvider = (idp: Provider): Record<string, string> => {
	const { issuer, clientId, clientSecret, name } = idp.config();
	return {
		MAINWORTHY_PUBLIC_URL: PUBLIC,
		MAINWORTHY_OIDC_ISSUER: issuer,
		MAINWORTHY_OIDC_CLIENT_ID: clientId,
		MAINWORTHY_OIDC_CLIENT_SECRET: clientSecret,
		MAINWORTHY_OIDC_NAME: name,
	};
};

/**
 * Accepts an invitation as the page at its link does: begins with the provider, signs in there as `subject` and
 * hands the answer back. The status of the first reply that is not a success, or of the last.
 */
async function accept(instance: Instance, idp: Provider, invitation: string, subject: string): Promise<number> {
	const post = (path: string, body: unknown, cookie = "") =>
		fetch(`${instance.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			body: JSON.stringify(body),
		});
	const begun = await post("/api/login/oidc", { invitation });
	if (begun.status !== 200) return begun.status;
	const ceremony = begun.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	idp.next({ subject });
	const answer = await fetch((await begun.json()).result.url, { redirect: "manual" });
	const query = new URL(answer.headers.get("location") ?? "").search;
	return (await post("/api/login", { oidc: query }, ceremony)).status;
}

test("serve does not start with a public address it cannot use, and says why before it opens the data", async () => {
	await withInstance(async ({ cli, directory }) => {
		const refused = await cli(["serve"], {
			env: { MAINWORTHY_PUBLIC_URL: "http://192.168.1.20:7357", MAINWORTHY_PORT: "0" },
		});
		expect(refused.code).toBe(4);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toContain("MAINWORTHY_PUBLIC_URL is not an address this instance can use");
		// The line does not repeat the value, which may carry a password.
		expect(refused.stderr).not.toContain("192.168.1.20");
		expect(existsSync(join(directory, ".mainworthy"))).toBe(false);
	});
});

const Invited = z.object({
	id: z.number(),
	name: z.string(),
	purpose: z.string(),
	link: z.string(),
	code: z.string(),
	can: z.array(z.string()),
	project: z.string(),
});
const Listed = z.array(z.object({ id: z.number(), name: z.string(), purpose: z.string(), state: z.string() }));
const UNTIL = String.raw`until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC`;

test("invite new prints the link once, invite list never shows the code, and invite revoke withdraws it", async () => {
	const idp = await provider();
	await withInstance(
		async ({ run, instance }) => {
			const before = Date.now();
			const made = await run([
				"invite",
				"new",
				"sam",
				"--can",
				"read,answer",
				"--project",
				"scratch",
				"--expires",
				"7d",
			]);
			expect(`${made.code} ${made.stderr}`).toBe("0 ");
			const lines = made.stdout.trimEnd().split("\n");
			expect(lines[0]).toMatch(new RegExp(`^invitation 1 for "sam" \\(may read, answer on scratch\\), ${UNTIL}$`));
			const code = /^https:\/\/mainworthy\.example\/invite#([A-Za-z0-9_-]{43})$/.exec(lines[1] ?? "")?.[1] ?? "";
			expect(code).toHaveLength(43);
			expect(lines[2]).toBe(
				"This link is shown once. Hand it to sam: it works once, when they sign in at the identity provider.",
			);
			expect(lines).toHaveLength(3);
			// Seven days from now, as the flag said.
			const until = Date.parse(`${/until (.*) UTC/.exec(lines[0] ?? "")?.[1]?.replace(" ", "T")}:00Z`);
			expect(Math.abs(until - (before + 7 * 86_400_000))).toBeLessThan(120_000);

			const listed = await run(["invite", "list"]);
			expect(listed.stdout).toMatch(
				new RegExp(`^1 {2}sam {2}join {2}open {2}${UNTIL} {2}by robin {2}may read, answer on scratch\n$`),
			);
			expect(listed.stdout).not.toContain(code);
			expect(outputWith(Listed, await run(["invite", "list", "--json"]))).toMatchObject([
				{ id: 1, name: "sam", purpose: "join", state: "open" },
			]);

			// The link works: the code in it accepts the invitation over HTTP, through the provider.
			const second = outputWith(Invited, await run(["invite", "new", "pat", "--json"]));
			// With no grant named, a new person may do everything, as a new person's token may.
			expect(second).toMatchObject({
				id: 2,
				name: "pat",
				purpose: "join",
				link: `https://mainworthy.example/invite#${second.code}`,
				can: ["read", "record", "produce", "answer", "plan", "admin"],
				project: "*",
			});
			const revoked = await run(["invite", "revoke", "2"]);
			expect(revoked.stdout).toBe("invitation 2 revoked\n");
			expect((await run(["invite", "revoke", "2"])).stdout).toBe(
				"invitation 2 was already used or revoked, or does not exist\n",
			);
			expect(await accept(instance, idp, second.code, "sub-pat")).toBe(404);
			expect(await accept(instance, idp, code, "sub-sam")).toBe(200);
			expect((await run(["invite", "list"])).stdout).toMatch(
				/^1 {2}sam {2}join {2}used.*\n2 {2}pat {2}join {2}revoked/,
			);
			// A person who exists is sent a recovery, and the command says what accepting it does.
			const recovery = await run(["invite", "new", "sam"]);
			expect(recovery.stdout).toMatch(
				new RegExp(
					`^invitation 3 for "sam" \\(a recovery: accepting it replaces the identities and tokens sam had\\), ${UNTIL}\n`,
				),
			);
			expect(recovery.stdout).toContain("every identity and token sam had stops working");

			// What the command refuses, it refuses before it asks the server.
			for (const argv of [
				["invite"],
				["invite", "new"],
				["invite", "new", "a", "b"],
				["invite", "revoke"],
				["invite", "revoke", "x"],
			]) {
				const bad = await run(argv);
				expect(`${argv.join(" ")}: ${bad.code}`).toBe(`${argv.join(" ")}: 4`);
			}
			const long = await run(["invite", "new", "lee", "--expires", "31d"]);
			expect(long.code).toBe(4);
			expect(long.stderr).toContain("30d");
			expect((await run(["invite", "new", "lee", "--expires", "soon"])).code).toBe(4);
			expect(outputWith(Listed, await run(["invite", "list", "--json"])).map((row) => row.name)).toEqual([
				"sam",
				"pat",
				"sam",
			]);
			// The operation is a command of its own too, as every operation is.
			const generic = await run(["invitation", "--do", "list"]);
			expect(generic.code).toBe(0);
			expect(generic.stdout).toContain('"name": "pat"');
		},
		{ env: withProvider(idp) },
	);
});

test("an instance with no identity provider makes no invitation, and the command says what to set", async () => {
	await withInstance(async ({ run }) => {
		const refused = await run(["invite", "new", "sam"]);
		expect(refused.code).not.toBe(0);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toContain("this instance has no identity provider");
		expect(refused.stderr).toContain("MAINWORTHY_OIDC_ISSUER");
		expect((await run(["invite", "list"])).stdout).toBe("No invitations.\n");
	});
});

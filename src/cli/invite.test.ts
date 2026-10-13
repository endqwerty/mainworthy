// `mainworthy invite` through the real command, against a real server: the link is printed once, a list never
// shows it, and a revoked invitation signs nobody in.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { outputWith, withInstance } from "./test-support.ts";

test("serve does not start with a public address it cannot use for passkeys, and says why before it opens the data", async () => {
	await withInstance(async ({ cli, directory }) => {
		const refused = await cli(["serve"], {
			env: { MAINWORTHY_PUBLIC_URL: "http://192.168.1.20:7357", MAINWORTHY_PORT: "0" },
		});
		expect(refused.code).toBe(4);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toContain("MAINWORTHY_PUBLIC_URL is not an address this instance can use for passkeys");
		// The line does not repeat the value, which may carry a password.
		expect(refused.stderr).not.toContain("192.168.1.20");
		expect(existsSync(join(directory, ".mainworthy"))).toBe(false);
	});
});

const Invited = z.object({ id: z.number(), name: z.string(), purpose: z.string(), link: z.string(), code: z.string() });
const Listed = z.array(z.object({ id: z.number(), name: z.string(), purpose: z.string(), state: z.string() }));
const UNTIL = String.raw`until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC`;

test("invite new prints the link once, invite list never shows the code, and invite revoke withdraws it", async () => {
	await withInstance(
		async ({ cli, instance }) => {
			const before = Date.now();
			const made = await cli([
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
			expect(lines[2]).toBe("This link is shown once. Hand it to sam: it works once.");
			expect(lines).toHaveLength(3);
			// Seven days from now, as the flag said.
			const until = Date.parse(`${/until (.*) UTC/.exec(lines[0] ?? "")?.[1]?.replace(" ", "T")}:00Z`);
			expect(Math.abs(until - (before + 7 * 86_400_000))).toBeLessThan(120_000);

			const listed = await cli(["invite", "list"]);
			expect(listed.stdout).toMatch(
				new RegExp(`^1 {2}sam {2}join {2}open {2}${UNTIL} {2}by robin {2}may read, answer on scratch\n$`),
			);
			expect(listed.stdout).not.toContain(code);
			expect(outputWith(Listed, await cli(["invite", "list", "--json"]))).toMatchObject([
				{ id: 1, name: "sam", purpose: "join", state: "open" },
			]);

			// The link works: the code in it accepts the invitation over HTTP.
			const accept = (invitation: string) =>
				fetch(`${instance.url}/api/login`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ invitation, password: "correct horse battery staple" }),
				});
			const second = outputWith(Invited, await cli(["invite", "new", "pat", "--json"]));
			expect(second).toMatchObject({
				id: 2,
				name: "pat",
				purpose: "join",
				link: `https://mainworthy.example/invite#${second.code}`,
			});
			const revoked = await cli(["invite", "revoke", "2"]);
			expect(revoked.stdout).toBe("invitation 2 revoked\n");
			expect((await cli(["invite", "revoke", "2"])).stdout).toBe(
				"invitation 2 was already used or revoked, or does not exist\n",
			);
			expect((await accept(second.code)).status).toBe(401);
			expect((await accept(code)).status).toBe(200);
			expect((await cli(["invite", "list"])).stdout).toMatch(
				/^1 {2}sam {2}join {2}used.*\n2 {2}pat {2}join {2}revoked/,
			);
			// A person who exists is sent a recovery, and the command says what accepting it does.
			const recovery = await cli(["invite", "new", "sam"]);
			expect(recovery.stdout).toMatch(
				new RegExp(
					`^invitation 3 for "sam" \\(a recovery: accepting it replaces every way sam signs in\\), ${UNTIL}\n`,
				),
			);
			expect(recovery.stdout).toContain("every password and passkey sam had stops working");

			// What the command refuses, it refuses before it asks the server.
			for (const argv of [
				["invite"],
				["invite", "new"],
				["invite", "new", "a", "b"],
				["invite", "revoke"],
				["invite", "revoke", "x"],
			]) {
				const bad = await cli(argv);
				expect(`${argv.join(" ")}: ${bad.code}`).toBe(`${argv.join(" ")}: 4`);
			}
			const long = await cli(["invite", "new", "lee", "--expires", "31d"]);
			expect(long.code).toBe(4);
			expect(long.stderr).toContain("30d");
			expect((await cli(["invite", "new", "lee", "--expires", "soon"])).code).toBe(4);
			expect(outputWith(Listed, await cli(["invite", "list", "--json"])).map((row) => row.name)).toEqual([
				"sam",
				"pat",
				"sam",
			]);
		},
		{ env: { MAINWORTHY_PUBLIC_URL: "https://mainworthy.example" } },
	);
	// It starts the command sixteen times, one after another: more than the default 5 s on a busy runner.
}, 20_000);

test("with no public address the link is relative and the command says what to put before it", async () => {
	await withInstance(async ({ cli }) => {
		const made = await cli(["invite", "new", "sam"]);
		expect(made.code).toBe(0);
		expect(made.stdout).toMatch(/^\/invite#[A-Za-z0-9_-]{43}$/m);
		expect(made.stdout).toContain("MAINWORTHY_PUBLIC_URL");
		// With no grant named, a new person may do everything, as a new person's token may.
		expect(made.stdout).toContain("(may read, record, produce, answer, plan, admin on *)");
		// The operation is a command of its own too, as every operation is.
		const listed = await cli(["invitation", "--do", "list"]);
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain('"name": "sam"');
	});
});

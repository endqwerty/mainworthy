// A Mainworthy for the iOS app's tests: a real server on this machine, in server mode, so the app signs in as it
// does on a phone. The owner signs in with a token and one more person with a name and a password.
//
// A test asks it for a project of its own (`POST /test/project`), filled by `scenario.ts`, so no test reads what
// another one answered. That route exists here and nowhere in the product.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Instance, start } from "../../src/server/start.ts";
import { passedRun, scenario } from "./scenario.ts";

export const OWNER = "robin";
export const TOKEN = "ios-test-owner-0123456789abcdef";
export const PERSON = { name: "sam", password: "a password for the tests" } as const;

export type TestInstance = {
	url: string;
	token: string;
	person: typeof PERSON;
	stop: () => Promise<void>;
};

const Ask = z.object({ kind: z.enum(["standard", "strict"]).default("standard") });
const Invited = z.object({ ok: z.literal(true), result: z.object({ code: z.string() }) });

export async function testInstance(): Promise<TestInstance> {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-ios-"));
	let instance: Instance | null = null;
	// Another origin, which only counts what reaches it: a client that follows a redirect there is seen.
	let reached = 0;
	let elsewhere: ReturnType<typeof Bun.serve> | null = null;
	const stop = async (): Promise<void> => {
		await elsewhere?.stop(true);
		await instance?.stop();
		rmSync(dataDir, { recursive: true, force: true });
	};
	// A server that could not be started or set up is handed to nobody, so nobody else would stop it or remove
	// what it wrote: that is done here.
	try {
		const other = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				reached += 1;
				return Response.json({ ok: true, result: {} });
			},
		});
		elsewhere = other;
		const made = start(
			{
				dataDir,
				host: "127.0.0.1",
				port: 0,
				mode: "server",
				owner: OWNER,
				ownerToken: TOKEN,
				commit: null,
				sessionIdleMs: 14 * 86_400_000,
				sessionMaxMs: 90 * 86_400_000,
				proxy: null,
				// A test signs in many times. The cost a real instance hashes a password at would be most of its run.
				passwordCost: { memoryCost: 8, timeCost: 1 },
			},
			() => ({
				ui: null,
				routes: {
					"/test/project": async (req) => {
						const asked = Ask.safeParse(await req.json().catch(() => ({})));
						if (!asked.success) return Response.json({ ok: false, error: { code: "invalid", message: "kind" } });
						const key = `t-${randomBytes(5).toString("hex")}`;
						const result =
							asked.data.kind === "strict"
								? { project: key, run: await passedRun(made.url, TOKEN, key) }
								: await scenario(made.url, TOKEN, key);
						return Response.json({ ok: true, result });
					},
					"/test/elsewhere": () => Response.redirect(`http://127.0.0.1:${other.port}/api/session`, 307),
					"/test/elsewhere-seen": () => Response.json({ ok: true, result: { requests: reached } }),
				},
			}),
			{ readers: 0 },
		);
		instance = made;
		const post = (path: string, body: unknown, token?: string) =>
			fetch(`${made.url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
				body: JSON.stringify(body),
			});
		const invited = Invited.parse(
			await (await post("/api/invitation", { do: "create", name: PERSON.name }, TOKEN)).json(),
		);
		const joined = await post("/api/login", { invitation: invited.result.code, password: PERSON.password });
		if (!joined.ok) throw new Error(`the test person could not join: ${joined.status} ${await joined.text()}`);
		return { url: made.url, token: TOKEN, person: PERSON, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

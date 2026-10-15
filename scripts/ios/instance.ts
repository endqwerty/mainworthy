// A Mainworthy for the iOS app's tests: a real server on this machine, in server mode, so the app signs in as it
// does on a phone. The owner and one more person sign in with a name and a password. The owner's token is for
// what a test sets up through the API, as a script would: the app takes no token.
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
const OWNER_PASSWORD = "the owner's password for the tests";

export type TestInstance = {
	url: string;
	token: string;
	person: typeof PERSON;
	owner: { name: string; password: string };
	stop: () => Promise<void>;
};

const Ask = z.object({ kind: z.enum(["standard", "strict"]).default("standard") });
const Invited = z.object({ ok: z.literal(true), result: z.object({ code: z.string() }) });
const Issued = z.object({ ok: z.literal(true), result: z.object({ token: z.string() }) });

export async function testInstance(): Promise<TestInstance> {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-ios-"));
	let token = TOKEN;
	let instance: Instance | null = null;
	// Another origin, which only counts what reaches it: a client that follows a redirect there is seen.
	let reached = 0;
	let elsewhere: ReturnType<typeof Bun.serve> | null = null;
	let answerProxy: ReturnType<typeof Bun.serve> | null = null;
	const unavailable = new Set<string>();
	const stop = async (): Promise<void> => {
		await answerProxy?.stop(true);
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
								? { project: key, run: await passedRun(made.url, token, key) }
								: await scenario(made.url, token, key);
						return Response.json({ ok: true, result });
					},
					"/test/answer-connection": async (req) => {
						const parsed = z.object({ project: z.string(), unavailable: z.boolean() }).safeParse(await req.json());
						if (!parsed.success) return Response.json({ ok: false }, { status: 400 });
						const path = `/api/p/${encodeURIComponent(parsed.data.project)}/decide`;
						if (parsed.data.unavailable) unavailable.add(path);
						else unavailable.delete(path);
						answerProxy ??= Bun.serve({
							hostname: "127.0.0.1",
							port: 0,
							fetch: (request) => {
								const url = new URL(request.url);
								if (unavailable.has(url.pathname))
									return Response.json(
										{ ok: false, error: { code: "internal", message: "The answer could not be recorded." } },
										{ status: 500 },
									);
								return fetch(new Request(`${made.url}${url.pathname}${url.search}`, request), { redirect: "manual" });
							},
						});
						return Response.json({ ok: true, result: { url: `http://127.0.0.1:${answerProxy.port}` } });
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
		// Each is given a password by an invitation. Owner recovery revokes the startup token, so the recovered
		// session makes a new one for setup requests.
		for (const [name, password] of [
			[PERSON.name, PERSON.password],
			[OWNER, OWNER_PASSWORD],
		]) {
			const invited = Invited.parse(await (await post("/api/invitation", { do: "create", name }, token)).json());
			const joined = await post("/api/login", { invitation: invited.result.code, password });
			if (!joined.ok) throw new Error(`${name} could not join: ${joined.status} ${await joined.text()}`);
			if (name === OWNER) {
				const issued = await fetch(`${made.url}/api/admin`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						cookie: (joined.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
					},
					body: JSON.stringify({ do: "token.create", actor: OWNER, kind: "human", label: "iOS test setup" }),
				});
				token = Issued.parse(await issued.json()).result.token;
			}
		}
		return { url: made.url, token, person: PERSON, owner: { name: OWNER, password: OWNER_PASSWORD }, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

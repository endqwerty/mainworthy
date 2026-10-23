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
import { type Instance, start, VERSION } from "../../src/app/start.ts";
import { Client } from "../../src/cli/client.ts";
import { seed } from "../../src/cli/seed.ts";
import { removeProject } from "../../src/server/transfer/transfer.ts";
import { docsRoutes } from "../../src/surfaces/docs/site.ts";
import { type Provider, provider } from "../../test/oidc-support.ts";
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

const Ask = z.object({ kind: z.enum(["standard", "strict", "demo"]).default("standard") });
const Invited = z.object({ ok: z.literal(true), result: z.object({ code: z.string() }) });
const Issued = z.object({ ok: z.literal(true), result: z.object({ token: z.string() }) });

export async function testInstance(): Promise<TestInstance> {
	const dataDir = mkdtempSync(join(tmpdir(), "mainworthy-ios-"));
	let token = TOKEN;
	let instance: Instance | null = null;
	let idp: Provider | null = null;
	// Another origin, which only counts what reaches it: a client that follows a redirect there is seen.
	let reached = 0;
	const privacyOpenings: string[] = [];
	let elsewhere: ReturnType<typeof Bun.serve> | null = null;
	let answerProxy: ReturnType<typeof Bun.serve> | null = null;
	let planProxy: ReturnType<typeof Bun.serve> | null = null;
	let questionProxy: ReturnType<typeof Bun.serve> | null = null;
	const questions = new Map<string, { arrived: boolean; wait: Promise<void>; release: () => void }>();
	type PlanDelivery =
		| { kind: "unreadable" }
		| { kind: "hold" | "before-unreadable"; arrived: boolean; wait: Promise<void>; release: () => void };
	const plans = new Map<string, PlanDelivery>();
	const unavailable = new Map<string, "rejected" | "uncertain">();
	const stop = async (): Promise<void> => {
		for (const delivery of plans.values()) if (delivery.kind !== "unreadable") delivery.release();
		for (const delivery of questions.values()) delivery.release();
		await questionProxy?.stop(true);
		await planProxy?.stop(true);
		await answerProxy?.stop(true);
		await elsewhere?.stop(true);
		await instance?.stop();
		idp?.stop();
		rmSync(dataDir, { recursive: true, force: true });
	};
	// A server that could not be started or set up is handed to nobody, so nobody else would stop it or remove
	// what it wrote: that is done here.
	try {
		idp = await provider({ subject: "ios-sam" });
		const other = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				reached += 1;
				return Response.json({ ok: true, result: {} });
			},
		});
		elsewhere = other;
		const made = await start(
			{
				dataDir,
				oidc: idp.config(),
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
				// Run the same public handlers as `serveCommand`, observing the browser handoff without
				// depending on how Safari displays its address bar. Redirects and page content stay shared.
				open: Object.fromEntries(
					Object.entries(docsRoutes(VERSION)).map(([path, handler]) => [
						path,
						(req: Request) => {
							if (new URL(req.url).pathname === "/privacy") privacyOpenings.push(req.url);
							return handler(req);
						},
					]),
				),
				routes: {
					"/test/project": async (req) => {
						const asked = Ask.safeParse(await req.json().catch(() => ({})));
						if (!asked.success) return Response.json({ ok: false, error: { code: "invalid", message: "kind" } });
						const key = `t-${randomBytes(5).toString("hex")}`;
						const result =
							asked.data.kind === "strict"
								? { project: key, run: await passedRun(made.url, token, key) }
								: asked.data.kind === "demo"
									? {
											project: key,
											...(await seed(new Client({ url: made.url, token, project: key }), {
												project: key,
												cases: 12,
												days: 0,
											})),
										}
									: await scenario(made.url, token, key);
						return Response.json({ ok: true, result });
					},
					"/test/replace-project": async (req) => {
						const { project } = z.object({ project: z.string() }).parse(await req.json());
						await made.app.gate.run(async () => {
							await removeProject(made.app.db, project);
						});
						return Response.json({
							ok: true,
							result: await scenario(made.url, token, project, `${project}-${randomBytes(5).toString("hex")}`),
						});
					},
					"/test/plan-connection": async (req) => {
						const parsed = z
							.object({
								project: z.string(),
								mode: z.enum(["hold", "before-unreadable", "unreadable", "normal", "status"]),
								operation: z.enum(["plan", "report", "find"]).default("plan"),
							})
							.safeParse(await req.json());
						if (!parsed.success) return Response.json({ ok: false }, { status: 400 });
						const path = `/api/p/${encodeURIComponent(parsed.data.project)}/${parsed.data.operation}`;
						if (parsed.data.mode !== "status") {
							const previous = plans.get(path);
							if (previous && previous.kind !== "unreadable") previous.release();
							plans.delete(path);
							if (parsed.data.mode === "hold" || parsed.data.mode === "before-unreadable") {
								const gate = Promise.withResolvers<void>();
								plans.set(path, {
									kind: parsed.data.mode,
									arrived: false,
									wait: gate.promise,
									release: () => gate.resolve(),
								});
							} else if (parsed.data.mode === "unreadable") plans.set(path, { kind: "unreadable" });
						}
						planProxy ??= Bun.serve({
							hostname: "127.0.0.1",
							port: 0,
							idleTimeout: 0,
							fetch: async (request) => {
								const url = new URL(request.url);
								const delivery = plans.get(url.pathname);
								if (delivery?.kind === "before-unreadable") {
									delivery.arrived = true;
									await delivery.wait;
								}
								const reply = await fetch(new Request(`${made.url}${url.pathname}${url.search}`, request), {
									redirect: "manual",
								});
								if (delivery?.kind === "unreadable" || delivery?.kind === "before-unreadable")
									return new Response("unreadable write receipt");
								if (delivery?.kind === "hold") {
									delivery.arrived = true;
									await delivery.wait;
								}
								return reply;
							},
						});
						const delivery = plans.get(path);
						return Response.json({
							ok: true,
							result: {
								url: `http://127.0.0.1:${planProxy.port}`,
								committed: delivery?.kind === "hold" && delivery.arrived,
								arrived: delivery && delivery.kind !== "unreadable" && delivery.arrived,
							},
						});
					},
					"/test/question-connection": async (req) => {
						const parsed = z
							.object({ project: z.string(), question: z.string(), mode: z.enum(["hold", "normal", "status"]) })
							.safeParse(await req.json());
						if (!parsed.success) return Response.json({ ok: false }, { status: 400 });
						const path = `/api/p/${encodeURIComponent(parsed.data.project)}/get`;
						const key = `${path}:${parsed.data.question}`;
						if (parsed.data.mode !== "status") {
							questions.get(key)?.release();
							questions.delete(key);
							if (parsed.data.mode === "hold") {
								const gate = Promise.withResolvers<void>();
								questions.set(key, { arrived: false, wait: gate.promise, release: () => gate.resolve() });
							}
						}
						questionProxy ??= Bun.serve({
							hostname: "127.0.0.1",
							port: 0,
							idleTimeout: 0,
							fetch: async (request) => {
								const url = new URL(request.url);
								const input = z.object({ refs: z.array(z.string()) }).safeParse(
									await request
										.clone()
										.json()
										.catch(() => null),
								);
								const delivery =
									input.success && input.data.refs.length === 1
										? questions.get(`${url.pathname}:${input.data.refs[0]}`)
										: undefined;
								const reply = await fetch(new Request(`${made.url}${url.pathname}${url.search}`, request), {
									redirect: "manual",
								});
								if (delivery) {
									delivery.arrived = true;
									await delivery.wait;
								}
								return reply;
							},
						});
						return Response.json({
							ok: true,
							result: { url: `http://127.0.0.1:${questionProxy.port}`, arrived: questions.get(key)?.arrived ?? false },
						});
					},
					"/test/answer-connection": async (req) => {
						const parsed = z
							.object({
								project: z.string(),
								unavailable: z.boolean(),
								failure: z.enum(["rejected", "uncertain"]).default("rejected"),
							})
							.safeParse(await req.json());
						if (!parsed.success) return Response.json({ ok: false }, { status: 400 });
						const path = `/api/p/${encodeURIComponent(parsed.data.project)}/decide`;
						if (parsed.data.unavailable) unavailable.set(path, parsed.data.failure);
						else unavailable.delete(path);
						answerProxy ??= Bun.serve({
							hostname: "127.0.0.1",
							port: 0,
							fetch: (request) => {
								const url = new URL(request.url);
								if (unavailable.get(url.pathname) === "uncertain") return new Response("unreadable reply");
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
					"/test/privacy-openings": () => Response.json({ ok: true, result: { urls: privacyOpenings } }),
				},
			}),
			{ readers: 0 },
		);
		instance = made;
		const publicUrl = made.url.replace("127.0.0.1", "localhost");
		made.app.config.publicUrl = publicUrl;
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
			if (name === PERSON.name) {
				const cookie = (joined.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
				const begun = await fetch(`${made.url}/api/login/oidc`, {
					method: "POST",
					headers: { "content-type": "application/json", cookie },
					body: JSON.stringify({ link: true }),
				});
				const { result } = z.object({ result: z.object({ url: z.string() }) }).parse(await begun.json());
				const authorization = await fetch(result.url, { redirect: "manual" });
				const back = new URL(authorization.headers.get("location") ?? "");
				const linked = await fetch(`${made.url}/api/login`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						cookie: `${cookie}; ${(begun.headers.getSetCookie()[0] ?? "").split(";")[0]}`,
					},
					body: JSON.stringify({ oidc: back.search }),
				});
				if (!linked.ok) throw new Error(`test provider could not be linked: ${linked.status}`);
			}
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
		return { url: publicUrl, token, person: PERSON, owner: { name: OWNER, password: OWNER_PASSWORD }, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

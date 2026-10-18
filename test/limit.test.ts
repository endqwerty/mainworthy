// The limit on failed authentication, on a real listener: who is counted, what a blocked caller is told, and what
// passes all the same. The rule itself (how many, how long, what is forgotten) is `limiter.test.ts`'s; this file
// is about where the server applies it. Time is the test's own clock, so no block is waited for.
//
// Every request here comes from the loopback address, which is never counted. A request gets an address the way
// a visitor behind a proxy does: the instance trusts the loopback peer as its proxy and reads the address that
// peer wrote in `x-client-address`.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Instance, start } from "../src/app/start.ts";
import { CLI_ENTRY } from "../src/cli/test-support.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";
import { clientAddress } from "../src/surfaces/http.ts";
import { mcpRoute } from "../src/surfaces/mcp.ts";

/** The owner's token as an operator sets it by hand: not in the form the server generates, so it gets no pass. */
const TOKEN = "owner-secret-0123456789";
const HEADER = "x-client-address";
const SECOND = 1000;
const T0 = 1_800_000_000_000;

const dirs: string[] = [];
const running: Instance[] = [];
afterEach(async () => {
	for (const instance of running.splice(0)) await instance.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-limit-"));
	dirs.push(dir);
	return dir;
}

type Clock = { now: () => number; advance: (ms: number) => void };
function clockAt(start = T0): Clock {
	let at = start;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		},
	};
}

/** What `mainworthy serve` reads from the environment, for an instance behind a proxy on the loopback address. */
const BEHIND_PROXY = { MAINWORTHY_TRUSTED_PROXY: "127.0.0.1", MAINWORTHY_CLIENT_ADDRESS_HEADER: "X-Client-Address" };

/**
 * A server-mode instance whose owner holds `TOKEN`, with the MCP and archive routes. Its configuration is read
 * from the environment as the real command reads it; `proxy` is the two variables, or none of them. With
 * `ownerToken` null the environment names no token, and the start makes the owner's.
 */
function boot(
	clock: Clock = clockAt(),
	proxy: Record<string, string> = BEHIND_PROXY,
	ownerToken: string | null = TOKEN,
): Instance {
	const config = defaultConfig({
		MAINWORTHY_DATA: scratch(),
		MAINWORTHY_PORT: "0",
		MAINWORTHY_MODE: "server",
		MAINWORTHY_OWNER: "robin",
		...(ownerToken === null ? {} : { MAINWORTHY_OWNER_TOKEN: ownerToken }),
		...proxy,
	});
	const instance = start(
		config,
		(app, owner) => ({ ui: null, routes: { "/mcp": mcpRoute(app), ...archiveRoutes(app, owner) } }),
		{ readers: 0, now: clock.now },
	);
	running.push(instance);
	return instance;
}

type Sent = Record<string, string>;
const bearer = (token: string): Sent => ({ authorization: `Bearer ${token}` });
/** The header the proxy writes: this request came from `address`. */
const from = (address: string): Sent => ({ [HEADER]: address });
const A = "203.0.113.9";
const B = "198.51.100.7";

let made = 0;
/** A secret nobody holds, as a person would type one. No two share their first 8 characters. */
const wrong = (): string => `${String(made++).padStart(4, "0")}-not-a-token-0123456789`;
/** A secret nobody holds, in the form the server generates. No two share the 8 characters after the marker. */
const wrongGenerated = (): string => `cb_${String(made++).padStart(8, "0")}${"x".repeat(24)}`;

const Refusal = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });
/**
 * A reply in one line: `200`, `401 unauthenticated`, `429 limited, retry after 1`. A reply that is not a JSON
 * refusal (a stream, an archive) is its status alone, and its body is let go.
 */
async function said(response: Response): Promise<string> {
	const retry = response.headers.get("retry-after");
	const after = retry === null ? "" : `, retry after ${retry}`;
	if (response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
		await response.body?.cancel();
		return `${response.status}${after}`;
	}
	const refusal = Refusal.safeParse(await response.json());
	return `${response.status} ${refusal.success ? refusal.data.error.code : "?"}${after}`;
}
/** Asks who the caller is: the cheapest request that needs a session. */
const who = async (instance: Instance, headers: Sent): Promise<string> =>
	said(await fetch(`${instance.url}/api/session`, { headers }));
const postJson = (instance: Instance, path: string, body: unknown, headers: Sent = {}): Promise<Response> =>
	fetch(`${instance.url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
const signIn = (instance: Instance, token: string, headers: Sent = {}): Promise<Response> =>
	postJson(instance, "/api/login", { token }, headers);

/** Five wrong tokens from one address, each refused as any wrong token is. The fifth is the one that blocks. */
async function block(instance: Instance, address: string): Promise<void> {
	for (let i = 0; i < 5; i++) {
		expect(await who(instance, { ...from(address), ...bearer(wrong()) })).toBe("401 unauthenticated");
	}
}

describe("a bearer token", () => {
	test("the fifth wrong token from an address blocks it: the next request is 429 and its token is not looked at", async () => {
		const instance = boot();
		await block(instance, A);
		// The owner's own token, which works: the block answers before any credential is read.
		const refused = await fetch(`${instance.url}/api/session`, { headers: { ...from(A), ...bearer(TOKEN) } });
		expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "1"]);
		expect(Refusal.parse(await refused.json()).error).toEqual({
			code: "limited",
			message: "too many failed attempts; try again in 1 second",
		});
		expect(await who(instance, { ...from(A), ...bearer(wrong()) })).toBe("429 limited, retry after 1");
	});

	test("the block ends when the clock passes it, and the next failure doubles it", async () => {
		const clock = clockAt();
		const instance = boot(clock);
		const asOwner = { ...from(A), ...bearer(TOKEN) };
		await block(instance, A);
		clock.advance(SECOND - 1);
		expect(await who(instance, asOwner)).toBe("429 limited, retry after 1");
		clock.advance(1);
		expect(await who(instance, asOwner)).toBe("200");
		// A success does not clear the address: one more failure from it, and the block is twice as long.
		expect(await who(instance, { ...from(A), ...bearer(wrong()) })).toBe("401 unauthenticated");
		expect(await who(instance, asOwner)).toBe("429 limited, retry after 2");
		clock.advance(2 * SECOND);
		expect(await who(instance, asOwner)).toBe("200");
		expect(await who(instance, { ...from(A), ...bearer(wrong()) })).toBe("401 unauthenticated");
		expect(await who(instance, asOwner)).toBe("429 limited, retry after 4");
	});

	test("another address is not affected, and neither is another instance in the same process", async () => {
		const instance = boot();
		await block(instance, A);
		expect(await who(instance, { ...from(B), ...bearer(wrong()) })).toBe("401 unauthenticated");
		expect(await who(instance, { ...from(B), ...bearer(TOKEN) })).toBe("200");
		expect(await who(instance, { ...from(A), ...bearer(TOKEN) })).toBe("429 limited, retry after 1");
		// Each instance counts for itself: the same address is free on a second one.
		expect(await who(boot(), { ...from(A), ...bearer(TOKEN) })).toBe("200");
	});

	test("five wrong secrets that share their first 8 characters block those characters for every address", async () => {
		const instance = boot();
		for (let i = 1; i <= 5; i++) {
			const guess = { ...from(`203.0.113.${i}`), ...bearer(`guess-me-${i}-0123456789`) };
			expect(await who(instance, guess)).toBe("401 unauthenticated");
		}
		expect(await who(instance, { ...from("203.0.113.6"), ...bearer("guess-me-6-0123456789") })).toBe(
			"429 limited, retry after 1",
		);
		// No address was blocked: each failed once. Another secret from the same new address is read.
		expect(await who(instance, { ...from("203.0.113.6"), ...bearer(wrong()) })).toBe("401 unauthenticated");
		expect(await who(instance, { ...from("203.0.113.6"), ...bearer(TOKEN) })).toBe("200");
	});

	test("a right generated token passes a blocked address; a wrong one in that form is 429 and is not counted", async () => {
		const clock = clockAt();
		const instance = boot(clock);
		const created = await postJson(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "pipeline", kind: "agent", can: ["read"], project: "scratch" },
			bearer(TOKEN),
		);
		const generated = z.object({ result: z.object({ token: z.string() }) }).parse(await created.json()).result.token;
		expect(generated).toMatch(/^cb_[0-9a-zA-Z]{32}$/);

		await block(instance, A);
		expect(await who(instance, { ...from(A), ...bearer(generated) })).toBe("200");
		for (let i = 0; i < 10; i++) {
			expect(await who(instance, { ...from(A), ...bearer(wrongGenerated()) })).toBe("429 limited, retry after 1");
		}
		// The pass reported nothing either: the address is as blocked as before for a token a person chose.
		expect(await who(instance, { ...from(A), ...bearer(generated) })).toBe("200");
		expect(await who(instance, { ...from(A), ...bearer(TOKEN) })).toBe("429 limited, retry after 1");
		// Had the ten been counted, each would have doubled the block. The next failure doubles it once.
		clock.advance(SECOND);
		expect(await who(instance, { ...from(A), ...bearer(wrong()) })).toBe("401 unauthenticated");
		expect(await who(instance, { ...from(A), ...bearer(TOKEN) })).toBe("429 limited, retry after 2");
	});

	test("an owner token from the environment gets no pass, though it is written in the form the server generates", async () => {
		// A person chose it, whatever it looks like: `cb_` and 32 letters somebody typed are not 190 random bits.
		const chosen = "cb_OwnerChoseThisTokenByHand0123456";
		expect(chosen).toMatch(/^cb_[0-9a-zA-Z]{32}$/);
		const instance = boot(clockAt(), BEHIND_PROXY, chosen);
		const created = await postJson(
			instance,
			"/api/admin",
			{ do: "token.create", actor: "pipeline", kind: "agent", can: ["read"], project: "scratch" },
			{ ...from(B), ...bearer(chosen) },
		);
		const made = z.object({ result: z.object({ token: z.string() }) }).parse(await created.json()).result.token;

		await block(instance, A);
		expect(await who(instance, { ...from(A), ...bearer(chosen) })).toBe("429 limited, retry after 1");
		expect(await said(await signIn(instance, chosen, from(A)))).toBe("429 limited, retry after 1");
		// A token `token.create` made still passes, and the owner's works from an address that is not blocked.
		expect(await who(instance, { ...from(A), ...bearer(made) })).toBe("200");
		expect(await who(instance, { ...from(B), ...bearer(chosen) })).toBe("200");

		// The owner's token a start made, because the environment named none, is the server's own: it passes.
		const other = boot(clockAt(), BEHIND_PROXY, null);
		await block(other, A);
		expect(await who(other, { ...from(A), ...bearer(other.generatedToken ?? "") })).toBe("200");
	});

	test("/mcp, the archive and the change stream answer 429 for a token from a blocked address", async () => {
		const instance = boot();
		const routes = (address: string): Promise<Response>[] => {
			const headers = { ...from(address), ...bearer(TOKEN) };
			return [
				postJson(
					instance,
					"/mcp",
					{
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "limit-test", version: "1" },
						},
					},
					{ ...headers, accept: "application/json, text/event-stream" },
				),
				fetch(`${instance.url}/api/export`, { headers }),
				fetch(`${instance.url}/api/p/scratch/events`, { headers }),
			];
		};
		await block(instance, A);
		const blocked: string[] = [];
		for (const reply of routes(A)) blocked.push(await said(await reply));
		expect(blocked).toEqual(Array(3).fill("429 limited, retry after 1"));
		// The same three requests from an address that is not blocked are served.
		const served: string[] = [];
		for (const reply of routes(B)) served.push(await said(await reply));
		expect(served).toEqual(Array(3).fill("200"));
	});

	test("an import replaces the tokens and not the count of who was guessing at them", async () => {
		const instance = boot();
		await block(instance, A);
		const asOwner = { ...from(B), ...bearer(TOKEN) };
		const archive = await (await fetch(`${instance.url}/api/export`, { headers: asOwner })).text();
		const imported = await fetch(`${instance.url}/api/import`, { method: "POST", headers: asOwner, body: archive });
		expect(imported.status).toBe(200);
		// The owner's token went with the rows it was in, so from an address that is free it is a wrong token now.
		expect(await who(instance, asOwner)).toBe("401 unauthenticated");
		expect(await who(instance, { ...from(A), ...bearer(wrong()) })).toBe("429 limited, retry after 1");
	});
});

describe("a session cookie", () => {
	test("is never blocked and never counted, right or wrong, even from a blocked address", async () => {
		const instance = boot();
		const signedIn = await signIn(instance, TOKEN, from(A));
		expect(signedIn.status).toBe(200);
		const cookie = (signedIn.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
		expect(cookie).toMatch(/^mainworthy_sid=.{43}$/);

		await block(instance, A);
		expect(await who(instance, { ...from(A), ...bearer(TOKEN) })).toBe("429 limited, retry after 1");
		for (let i = 0; i < 3; i++) expect(await who(instance, { ...from(A), cookie })).toBe("200");
		// Using the session reported no success either: the address is still blocked for a token.
		expect(await who(instance, { ...from(A), ...bearer(TOKEN) })).toBe("429 limited, retry after 1");

		// A cookie that names no session is refused every time, and is no failure of its address.
		const stale = { ...from(B), cookie: `mainworthy_sid=${"A".repeat(43)}` };
		for (let i = 0; i < 6; i++) expect(await who(instance, stale)).toBe("401 unauthenticated");
		expect(await who(instance, { ...from(B), ...bearer(TOKEN) })).toBe("200");
	});
});

describe("POST /api/login", () => {
	test("is limited by the same keys as a bearer token", async () => {
		const clock = clockAt();
		const instance = boot(clock);
		// Three failed sign-ins and two failed bearer tokens from one address are five failures of that address.
		for (let i = 0; i < 3; i++)
			expect(await said(await signIn(instance, wrong(), from(A)))).toBe("401 unauthenticated");
		for (let i = 0; i < 2; i++) {
			expect(await who(instance, { ...from(A), ...bearer(wrong()) })).toBe("401 unauthenticated");
		}
		const refused = await signIn(instance, TOKEN, from(A));
		expect(refused.headers.getSetCookie()).toEqual([]);
		expect(await said(refused)).toBe("429 limited, retry after 1");
		expect(await who(instance, { ...from(A), ...bearer(TOKEN) })).toBe("429 limited, retry after 1");
		// Sign-out is not limited: it ends a session and proves nothing.
		expect(await said(await postJson(instance, "/api/logout", {}, from(A)))).toBe("200");

		clock.advance(SECOND);
		const signedIn = await signIn(instance, TOKEN, from(A));
		expect(signedIn.headers.getSetCookie()[0]).toMatch(/^mainworthy_sid=.{43};/);
		expect(await said(signedIn)).toBe("200");
	});

	test("a prefix blocked by failed sign-ins is blocked for a bearer token too", async () => {
		const instance = boot();
		for (let i = 1; i <= 5; i++) {
			const reply = await signIn(instance, `owner-secret-wrong-${i}`, from(`203.0.113.${i}`));
			expect(await said(reply)).toBe("401 unauthenticated");
		}
		expect(await who(instance, { ...from(B), ...bearer(TOKEN) })).toBe("429 limited, retry after 1");
		expect(await said(await signIn(instance, TOKEN, from(B)))).toBe("429 limited, retry after 1");
	});
});

describe("the client's address", () => {
	/** Wrong tokens, no two alike in their first 8 characters, each sent with these headers: six, or `count`. */
	async function sixWrong(instance: Instance, headers: Sent, count = 6): Promise<string[]> {
		const replies: string[] = [];
		for (let i = 0; i < count; i++) replies.push(await who(instance, { ...headers, ...bearer(wrong()) }));
		return replies;
	}
	const NEVER_BLOCKED = Array(6).fill("401 unauthenticated");

	test("the check docs/deploy.md gives an operator tells a header with the visitor's address from one with the proxy's", async () => {
		// Step 3 of "Behind a proxy": eight wrong tokens from one network, then two from another a while later.
		const clock = clockAt();
		const instance = boot(clock);
		expect(await sixWrong(instance, from(A), 8)).toEqual([
			...Array(5).fill("401 unauthenticated"),
			...Array(3).fill("429 limited, retry after 1"),
		]);
		clock.advance(60 * SECOND);
		// The header holds each visitor's own address: the other network has failed twice, and is not blocked.
		expect(await sixWrong(instance, from(B), 2)).toEqual(Array(2).fill("401 unauthenticated"));
		// The header holds one address for everybody, the proxy's: the other network's first wrong token is one
		// more failure of the address that was blocked, and its second is refused.
		expect(await sixWrong(instance, from(A), 2)).toEqual(["401 unauthenticated", "429 limited, retry after 2"]);
	});

	test("the header is believed from a trusted peer", async () => {
		expect(await sixWrong(boot(), from(A))).toEqual([
			...Array(5).fill("401 unauthenticated"),
			"429 limited, retry after 1",
		]);
	});

	test("the header is ignored from a peer that is not a trusted proxy", async () => {
		// The proxy is another machine. This request comes from the loopback address, which is then its own
		// address and is not counted, whatever it says about itself.
		const instance = boot(clockAt(), { ...BEHIND_PROXY, MAINWORTHY_TRUSTED_PROXY: "10.9.9.9, 2001:db8::/32" });
		expect(await sixWrong(instance, from(A))).toEqual(NEVER_BLOCKED);
	});

	test("a trusted peer whose header is missing, or holds two addresses, gives the request no address", async () => {
		const instance = boot();
		expect(await sixWrong(instance, {})).toEqual(NEVER_BLOCKED);
		expect(await sixWrong(instance, from(`${A}, ${B}`))).toEqual(NEVER_BLOCKED);
		expect(await sixWrong(instance, from(`${A}:443`))).toEqual(NEVER_BLOCKED);
		// One address, and a private one: another proxy's, which is no visitor's and is not counted either.
		expect(await sixWrong(instance, from("10.1.2.3"))).toEqual(NEVER_BLOCKED);
	});

	test("without the two variables a loopback peer is not counted per address, whatever headers it sends", async () => {
		const instance = boot(clockAt(), {});
		expect(await sixWrong(instance, { ...from(A), "x-forwarded-for": A, "cf-connecting-ip": A })).toEqual(
			NEVER_BLOCKED,
		);
	});

	test("a public peer is its own address: its header is read only when it is a trusted proxy", () => {
		// No request of this file can come from a public address, so the listener is stood in for here.
		const peer = (address: string | null) => ({
			requestIP: () => (address === null ? null : { address, family: "IPv4" as const, port: 40_000 }),
		});
		const request = new Request("http://mainworthy.example/api/session", { headers: from(A) });
		const config = (env: Record<string, string>) => defaultConfig({ MAINWORTHY_DATA: "unused", ...env });
		const trusting = (proxy: string) =>
			config({ MAINWORTHY_TRUSTED_PROXY: proxy, MAINWORTHY_CLIENT_ADDRESS_HEADER: HEADER });

		expect(clientAddress(request, peer(B), config({}))).toBe(B);
		expect(clientAddress(request, peer(B), trusting("192.0.2.1"))).toBe(B);
		expect(clientAddress(request, peer(B), trusting("198.51.100.0/24"))).toBe(A);
		expect(clientAddress(request, peer(`::ffff:${B}`), trusting(B))).toBe(A);
		expect(clientAddress(request, peer(null), trusting("0.0.0.0/0"))).toBeNull();
		const bare = new Request("http://mainworthy.example/api/session");
		expect(clientAddress(bare, peer(B), trusting(B))).toBeNull();
	});

	test("one variable without the other, or a malformed proxy entry, stops the start and says which", async () => {
		/** Runs the real command with these variables: its exit code, what it printed, and whether it made data. */
		const serve = async (env: Record<string, string>) => {
			const home = scratch();
			const child = Bun.spawn([process.execPath, CLI_ENTRY, "serve"], {
				cwd: home,
				env: { PATH: process.env.PATH ?? "", HOME: home, USER: "robin", MAINWORTHY_PORT: "0", ...env },
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			});
			// A start that is not refused listens until it is stopped: it is given three seconds to refuse.
			const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
			try {
				const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
				return { code, stderr: stderr.trim(), opened: existsSync(join(home, ".mainworthy")) };
			} finally {
				clearTimeout(timeout);
				child.kill("SIGKILL");
			}
		};
		const [noHeader, noProxy, malformed, loose] = await Promise.all([
			serve({ MAINWORTHY_TRUSTED_PROXY: "10.0.0.0/8" }),
			serve({ MAINWORTHY_CLIENT_ADDRESS_HEADER: "cf-connecting-ip", MAINWORTHY_TRUSTED_PROXY: "" }),
			serve({ MAINWORTHY_TRUSTED_PROXY: "10.0.0.0/8, 172.16.0.0/33", MAINWORTHY_CLIENT_ADDRESS_HEADER: "x-real-ip" }),
			serve({ MAINWORTHY_TRUSTED_PROXY: "10.0.0.5/8", MAINWORTHY_CLIENT_ADDRESS_HEADER: "x-real-ip" }),
		]);
		expect(noHeader).toEqual({
			code: 4,
			stderr:
				"invalid: MAINWORTHY_TRUSTED_PROXY is set and MAINWORTHY_CLIENT_ADDRESS_HEADER is not: name the header in which that proxy writes the client's address, or unset both",
			opened: false,
		});
		expect(noProxy).toEqual({
			code: 4,
			stderr:
				"invalid: MAINWORTHY_CLIENT_ADDRESS_HEADER is set and MAINWORTHY_TRUSTED_PROXY is not: name the addresses of the proxy whose header is to be believed, or unset both",
			opened: false,
		});
		expect(malformed).toEqual({
			code: 4,
			stderr: 'invalid: MAINWORTHY_TRUSTED_PROXY: "172.16.0.0/33" is not an address or a range such as 10.0.0.0/8',
			opened: false,
		});
		expect(loose).toEqual({
			code: 4,
			stderr:
				'invalid: MAINWORTHY_TRUSTED_PROXY: "10.0.0.5/8" has bits set after its prefix; a range starts at its first address',
			opened: false,
		});
	});

	test("the two variables are read as written: empty is unset, and a header name must be one", () => {
		const read = (env: Record<string, string>) => defaultConfig({ MAINWORTHY_DATA: "unused", ...env }).proxy;
		expect(read({})).toBeNull();
		expect(read({ MAINWORTHY_TRUSTED_PROXY: "", MAINWORTHY_CLIENT_ADDRESS_HEADER: "" })).toBeNull();
		const proxy = read({
			MAINWORTHY_TRUSTED_PROXY: " 10.0.0.0/8 ,::1",
			MAINWORTHY_CLIENT_ADDRESS_HEADER: " CF-Connecting-IP ",
		});
		expect(proxy?.header).toBe("cf-connecting-ip");
		expect(["10.1.2.3", "::1", "::ffff:10.1.2.3", "11.0.0.1", null].map((peer) => proxy?.peers.contains(peer))).toEqual(
			[true, true, true, false, false],
		);
		for (const header of ["x forwarded for", "x-real-ip:", "x-real-ip, forwarded"]) {
			expect(() => read({ MAINWORTHY_TRUSTED_PROXY: "10.0.0.1", MAINWORTHY_CLIENT_ADDRESS_HEADER: header })).toThrow(
				`MAINWORTHY_CLIENT_ADDRESS_HEADER is "${header}", which is not the name of a header`,
			);
		}
		// A list of commas and spaces names nobody: a proxy the operator meant to trust would be a peer like any other.
		expect(() => read({ MAINWORTHY_TRUSTED_PROXY: " , ", MAINWORTHY_CLIENT_ADDRESS_HEADER: "x-real-ip" })).toThrow(
			"MAINWORTHY_TRUSTED_PROXY names no address",
		);
	});
});

describe("the CLI", () => {
	test("prints the refusal with the seconds to wait, and exits non-zero", async () => {
		const instance = boot();
		// The CLI's own requests come from the loopback address and carry no address, so what blocks it here is
		// the first 8 characters of its token: five wrong guesses at them, from anywhere.
		for (let i = 1; i <= 5; i++) {
			const guess = { ...from(`203.0.113.${i}`), ...bearer(`owner-secret-wrong-${i}`) };
			expect(await who(instance, guess)).toBe("401 unauthenticated");
		}
		const home = scratch();
		const child = Bun.spawn([process.execPath, CLI_ENTRY, "find"], {
			cwd: home,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				MAINWORTHY_URL: instance.url,
				MAINWORTHY_TOKEN: TOKEN,
				MAINWORTHY_PROJECT: "scratch",
			},
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
		try {
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, stdout, stderr }).toEqual({
				code: 4,
				stdout: "",
				stderr: "limited: too many failed attempts; try again in 1 second\n",
			});
		} finally {
			clearTimeout(timeout);
			child.kill("SIGKILL");
		}
	});
});

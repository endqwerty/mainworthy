// The headers every reply carries: the policy by itself, then on a real listener for each kind of route, for the
// web UI as the executable holds it (a list of built files) and as a start from source serves it (Bun's bundle).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SESSION_LIFETIMES } from "../src/server/kernel/app.ts";
import { type Instance, start } from "../src/server/start.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";
import { docsRoutes } from "../src/surfaces/docs/site.ts";
import {
	arrivedOverHttps,
	type Content,
	contentSecurityPolicy,
	securityHeaders,
	trustworthyOrigin,
} from "../src/surfaces/headers.ts";
import { mcpRoute } from "../src/surfaces/mcp.ts";
import { withHeadersOnEvery } from "../src/surfaces/with-headers.ts";
import sourceUi from "../src/web/index.html";

const PAGE =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const OTHER = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HASH = "ES8VF47udzjVFFPh4RhgcgjUrADRd1Ef0GD9UagS2mY=";
/** The page's policy as Bun's development bundle needs it: `PAGE` with two directives widened. */
const developmentPage = (hashes: string[]): string =>
	PAGE.replace(
		"script-src 'self'",
		["script-src 'self' blob:", ...hashes.map((hash) => `'sha256-${hash}'`)].join(" "),
	).replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
const plain = { url: "http://127.0.0.1:7357/api/session", forwardedProto: null };

describe("the policy", () => {
	test("the app's page may load its own script, style sheet and icon, talk to its own origin, and nothing else", () => {
		expect(contentSecurityPolicy({ kind: "page" })).toBe(PAGE);
	});

	test("the development page differs in three things: scripts from a blob, its inline scripts by hash, inline styles", () => {
		expect(contentSecurityPolicy({ kind: "development-page", inlineScripts: [HASH] })).toBe(developmentPage([HASH]));
		expect(developmentPage([HASH])).toBe(
			`default-src 'none'; script-src 'self' blob: 'sha256-${HASH}'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
		);
	});

	test("what is not a hash never reaches the header, where it would be read as policy", () => {
		const policy = contentSecurityPolicy({
			kind: "development-page",
			inlineScripts: ["x'; script-src *; '", "'unsafe-inline'", "", HASH.slice(1)],
		});
		expect(policy).toBe(developmentPage([]));
	});

	test("no policy lets an inline script or an eval run, or trusts another host or a data address", () => {
		const policies = [
			{ kind: "page" },
			{ kind: "development-page", inlineScripts: [HASH] },
			{ kind: "other" },
		] satisfies Content[];
		for (const content of policies) {
			const policy = contentSecurityPolicy(content);
			const scripts = policy.split("; ").find((directive) => directive.startsWith("script-src")) ?? "";
			expect(scripts).not.toContain("unsafe");
			expect(policy).not.toMatch(/unsafe-eval|\*|https?:|data:/);
			expect(policy).toContain("default-src 'none'");
			expect(policy).toContain("frame-ancestors 'none'");
			expect(policy).toContain("base-uri 'none'");
		}
		// Only the development page allows anything inline at all, and only styles.
		expect(contentSecurityPolicy({ kind: "page" })).not.toContain("unsafe");
		expect(contentSecurityPolicy({ kind: "other" })).not.toContain("unsafe");
	});

	test("the opener policy is sent where a browser honours it: over https and to this machine, not to a network name over plain http", () => {
		const facts = (url: string, forwardedProto: string | null = null) => ({ url, forwardedProto });
		const sent = (url: string, forwardedProto: string | null = null) =>
			securityHeaders(facts(url, forwardedProto), { kind: "other" })["cross-origin-opener-policy"] ?? null;
		for (const url of [
			"https://mainworthy.example/",
			"http://localhost:7357/",
			"http://app.localhost:7357/",
			"http://127.0.0.1:7357/",
			"http://127.8.9.10/",
			"http://[::1]:7357/",
		])
			expect(`${url} ${sent(url)}`).toBe(`${url} same-origin`);
		expect(sent("http://10.0.0.5:7357/", "https")).toBe("same-origin");
		// A browser logs "The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was
		// untrustworthy" for each of these, and the browser tests count a logged error as a failure.
		for (const url of ["http://mainworthy.example/", "http://10.0.0.5:7357/", "http://localhost.example/", ""])
			expect(`${url} ${sent(url)}`).toBe(`${url} null`);
		expect(trustworthyOrigin(facts("http://127.0.0.1.example/"))).toBe(false);
	});

	test("a reply that is not the page may load and run nothing", () => {
		expect(contentSecurityPolicy({ kind: "other" })).toBe(OTHER);
	});

	test("every reply gets the same five headers beside its policy", () => {
		expect(securityHeaders(plain, { kind: "other" })).toEqual({
			"content-security-policy": OTHER,
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"x-frame-options": "DENY",
			"cross-origin-opener-policy": "same-origin",
			"cross-origin-resource-policy": "same-origin",
		});
	});

	test("https is the request's own scheme, or the first element of what the proxy reports, in any case", () => {
		const https: [string, string | null][] = [
			["https://mainworthy.example/", null],
			["HTTPS://mainworthy.example/", null],
			["http://10.0.0.5:7357/", "https"],
			["http://10.0.0.5:7357/", "HTTPS"],
			["http://10.0.0.5:7357/", "https,http"],
			["http://10.0.0.5:7357/", " Https , http"],
		];
		const http: [string, string | null][] = [
			["http://127.0.0.1:7357/", null],
			["http://127.0.0.1:7357/", ""],
			["http://127.0.0.1:7357/", "http"],
			["http://127.0.0.1:7357/", "http, https"],
			["http://127.0.0.1:7357/", "wss"],
			["http://127.0.0.1:7357/?next=https://elsewhere.example", null],
			["", null],
		];
		for (const [url, forwardedProto] of https) expect(arrivedOverHttps({ url, forwardedProto })).toBe(true);
		for (const [url, forwardedProto] of http) expect(arrivedOverHttps({ url, forwardedProto })).toBe(false);
	});

	test("https only is promised for a year, for this host alone, and only to a request that came over https", () => {
		expect(securityHeaders(plain, { kind: "page" })["strict-transport-security"]).toBeUndefined();
		expect(securityHeaders({ ...plain, forwardedProto: "https" }, { kind: "page" })["strict-transport-security"]).toBe(
			"max-age=31536000",
		);
	});
});

const TOKEN = "headers-owner-token-0123456789abcdef";
const dirs: string[] = [];
const running: Instance[] = [];
afterEach(async () => {
	for (const instance of running.splice(0)) await instance.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-headers-"));
	dirs.push(dir);
	return dir;
};

/** A server-mode instance with every surface `mainworthy serve` has, and one route that fails. */
function boot(ui: unknown = null): Instance {
	const instance = start(
		{
			dataDir: scratch(),
			host: "127.0.0.1",
			port: 0,
			mode: "server",
			owner: "robin",
			ownerToken: TOKEN,
			commit: null,
			...SESSION_LIFETIMES,
			proxy: null,
		},
		(app, owner) => ({
			ui,
			routes: {
				"/mcp": mcpRoute(app),
				...archiveRoutes(app, owner),
				"/api/fails": () => {
					throw new Error("a route that fails");
				},
			},
		}),
	);
	running.push(instance);
	return instance;
}

const FIXED = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
};
/** The policy headers of a reply, and nothing else of it. */
const carried = (reply: Pick<Response, "headers">): Record<string, string | null> =>
	Object.fromEntries(
		[...Object.keys(FIXED), "content-security-policy", "strict-transport-security"].map((name) => [
			name,
			reply.headers.get(name),
		]),
	);
/** `known`: whether the reply's route was handed the request. Bun's error handler is not, so a 500 is not. */
const expected = (policy: string, https: boolean, known = true) => ({
	...FIXED,
	"cross-origin-opener-policy": known ? "same-origin" : null,
	"content-security-policy": policy,
	"strict-transport-security": https && known ? "max-age=31536000" : null,
});

const bearer = { authorization: `Bearer ${TOKEN}` };
const json = { "content-type": "application/json" };
const INITIALIZE = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "headers-test", version: "1" } },
});

/** One request of each kind the server answers without the web UI: its route, and the status that proves it. */
const REQUESTS: { name: string; path: string; init?: RequestInit; status: number; type?: string }[] = [
	{ name: "the health check", path: "/healthz", status: 200 },
	{ name: "the API description", path: "/api/openapi.json", status: 200 },
	{ name: "the session", path: "/api/session", init: { headers: bearer }, status: 200 },
	{ name: "the session, refused", path: "/api/session", status: 401 },
	{
		name: "a sign-in",
		path: "/api/login",
		init: { method: "POST", headers: json, body: JSON.stringify({ token: TOKEN }) },
		status: 200,
	},
	{
		name: "a sign-in, refused",
		path: "/api/login",
		init: { method: "POST", headers: json, body: JSON.stringify({ token: "not-the-token" }) },
		status: 401,
	},
	{ name: "a sign-out", path: "/api/logout", init: { method: "POST" }, status: 200 },
	{
		name: "an operation",
		path: "/api/p/scratch/find",
		init: { method: "POST", headers: { ...json, ...bearer }, body: "{}" },
		status: 200,
	},
	{
		name: "an operation without a token",
		path: "/api/p/scratch/find",
		init: { method: "POST", headers: json, body: "{}" },
		status: 401,
	},
	{
		name: "an operation on a project that does not exist",
		path: "/api/p/nowhere/find",
		init: { method: "POST", headers: { ...json, ...bearer }, body: "{}" },
		status: 404,
	},
	{
		name: "an operation with a body that is not JSON",
		path: "/api/p/scratch/find",
		init: { method: "POST", headers: { ...json, ...bearer }, body: "{" },
		status: 400,
	},
	{
		name: "an instance operation",
		path: "/api/admin",
		init: { method: "POST", headers: { ...json, ...bearer }, body: JSON.stringify({ do: "token.list" }) },
		status: 200,
	},
	{
		name: "the change stream",
		path: "/api/p/scratch/events",
		init: { headers: bearer },
		status: 200,
		type: "text/event-stream",
	},
	{ name: "the change stream, refused", path: "/api/p/scratch/events", status: 401 },
	{ name: "an export", path: "/api/export", init: { headers: bearer }, status: 200, type: "application/x-ndjson" },
	{ name: "an export, refused", path: "/api/export", status: 401 },
	{ name: "an import with the wrong method", path: "/api/import", init: { headers: bearer }, status: 405 },
	{
		name: "an import that is not an archive",
		path: "/api/import",
		init: { method: "POST", headers: bearer, body: "not an archive\n" },
		status: 400,
	},
	{
		name: "an MCP call",
		path: "/mcp",
		init: {
			method: "POST",
			headers: { ...json, ...bearer, accept: "application/json, text/event-stream" },
			body: INITIALIZE,
		},
		status: 200,
	},
	{ name: "an MCP call with the wrong method", path: "/mcp", init: { headers: bearer }, status: 405 },
	{
		name: "an MCP call, refused",
		path: "/mcp",
		init: { method: "POST", headers: json, body: INITIALIZE },
		status: 401,
	},
	{ name: "a path that is no route", path: "/api/p/scratch/find/more", status: 404 },
	{ name: "a method that is no route", path: "/api/session", init: { method: "DELETE" }, status: 404 },
	{ name: "a route that fails", path: "/api/fails", init: { headers: bearer }, status: 500 },
];

describe("on a real listener, without the web UI", () => {
	for (const scheme of ["http", "https"] as const) {
		test(`every route's reply carries the headers when the request came over ${scheme}`, async () => {
			const failures = spyOn(console, "error").mockImplementation(() => {});
			try {
				const instance = boot();
				for (const request of REQUESTS) {
					const headers = {
						...Object.fromEntries(new Headers(request.init?.headers)),
						...(scheme === "https" ? { "x-forwarded-proto": "https" } : {}),
					};
					const reply = await fetch(`${instance.url}${request.path}`, { ...request.init, headers });
					expect(reply.status, request.name).toBe(request.status);
					// Bun hands its error handler no request, so a 500 cannot know how the browser arrived or where:
					// it goes without the two headers a browser honours only on an origin it trusts.
					expect(carried(reply), request.name).toEqual(expected(OTHER, scheme === "https", request.status !== 500));
					// The headers are added to what the route wrote, not put in its place.
					if (request.type) expect(reply.headers.get("content-type"), request.name).toBe(request.type);
					await reply.body?.cancel();
				}
				expect(failures).toHaveBeenCalledTimes(1);
			} finally {
				failures.mockRestore();
			}
		});
	}

	test("a route's own headers stay: the cookie of a sign-in, the methods a 405 allows, no-store on the API", async () => {
		const instance = boot();
		const signedIn = await fetch(`${instance.url}/api/login`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ token: TOKEN }),
		});
		expect(signedIn.headers.getSetCookie()[0]).toStartWith("mainworthy_sid=");
		expect(signedIn.headers.get("cache-control")).toBe("no-store");
		expect(signedIn.headers.get("content-type")).toBe("application/json; charset=utf-8");
		const refused = await fetch(`${instance.url}/mcp`, { headers: bearer });
		expect(refused.headers.get("allow")).toBe("POST");
	});

	test("a proxy's list of schemes counts by its first element, whatever its case", async () => {
		const instance = boot();
		const sent = async (forwarded: string) =>
			(await fetch(`${instance.url}/healthz`, { headers: { "x-forwarded-proto": forwarded } })).headers.get(
				"strict-transport-security",
			);
		expect(await sent("https, http")).toBe("max-age=31536000");
		expect(await sent("HTTPS")).toBe("max-age=31536000");
		expect(await sent("http, https")).toBeNull();
		expect(await sent("http")).toBeNull();
	});

	test("a route that Bun would answer itself, where no header can be added, is refused when the server starts", () => {
		expect(() => withHeadersOnEvery({ "/fixed": new Response("fixed") })).toThrow("/fixed");
		expect(() => withHeadersOnEvery({ "/file": { GET: Bun.file("package.json") } })).toThrow("GET /file");
		expect(() => withHeadersOnEvery({ "/page": sourceUi })).toThrow("/page");
	});
});

describe("a route that answers without a session and writes the policy of its own pages", () => {
	const OWN = "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'self'";
	const SANDBOXED = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'self'";
	const open = (): Instance => {
		const instance = start(
			{
				dataDir: scratch(),
				host: "127.0.0.1",
				port: 0,
				mode: "server",
				owner: "robin",
				ownerToken: TOKEN,
				commit: null,
				proxy: null,
				...SESSION_LIFETIMES,
			},
			() => ({
				ui: null,
				open: {
					"/open/page": () =>
						new Response("<p>a page</p>", {
							headers: {
								"content-type": "text/html; charset=utf-8",
								"content-security-policy": OWN,
								"referrer-policy": "same-origin",
								"x-frame-options": "ALLOWALL",
							},
						}),
					"/open/sandboxed": () =>
						new Response("<p>a diagram</p>", {
							headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": SANDBOXED },
						}),
					"/open/closed": () =>
						new Response("<p>nobody frames this</p>", {
							headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" },
						}),
					"/open/moved": () => new Response(null, { status: 308, headers: { location: "/open/page" } }),
				},
			}),
		);
		running.push(instance);
		return instance;
	};

	test("keeps that policy and its referrer rule, gets the framing header that policy means, and every other header", async () => {
		const instance = open();
		const page = await fetch(`${instance.url}/open/page`);
		expect(carried(page)).toEqual({
			...FIXED,
			"content-security-policy": OWN,
			"referrer-policy": "same-origin",
			// The route's own framing header does not stand: the header is the policy's `frame-ancestors`, restated.
			"x-frame-options": "SAMEORIGIN",
			"strict-transport-security": null,
		});
		const sandboxed = await fetch(`${instance.url}/open/sandboxed`, { headers: { "x-forwarded-proto": "https" } });
		expect(carried(sandboxed)).toEqual({
			...FIXED,
			"content-security-policy": SANDBOXED,
			"x-frame-options": "SAMEORIGIN",
			"strict-transport-security": "max-age=31536000",
		});
		// A policy that lets nobody frame the reply keeps the framing header at its strictest.
		const closed = await fetch(`${instance.url}/open/closed`);
		expect(closed.headers.get("x-frame-options")).toBe("DENY");
	});

	test("a reply of such a route that carries no policy gets the one for everything else", async () => {
		const instance = open();
		const moved = await fetch(`${instance.url}/open/moved`, { redirect: "manual" });
		expect(moved.status).toBe(308);
		expect(carried(moved)).toEqual(expected(OTHER, false));
	});

	test("the documentation's pages keep their policy: a page may frame a diagram, and a diagram stays sandboxed", async () => {
		const instance = start(
			{
				dataDir: scratch(),
				host: "127.0.0.1",
				port: 0,
				mode: "server",
				owner: "robin",
				ownerToken: TOKEN,
				commit: null,
				proxy: null,
				...SESSION_LIFETIMES,
			},
			() => ({ ui: null, open: docsRoutes("0.0.0") }),
		);
		running.push(instance);
		const page = await fetch(`${instance.url}/docs/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("frame-src 'self'");
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
		expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(page.headers.get("x-content-type-options")).toBe("nosniff");
		expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
		const styles = await fetch(`${instance.url}/docs/assets/site.css`);
		expect(styles.status).toBe(200);
		expect(styles.headers.get("x-frame-options")).toBe("DENY");
	});
});

describe("the web UI as the executable holds it: a list of built files", () => {
	const SCRIPT = 'console.log("the app");';
	/** What Bun puts on an HTML import when it builds an executable, over files of this test's own. */
	function built(): unknown {
		const root = scratch();
		const file = (name: string, text: string, type: string, etag: string) => {
			writeFileSync(join(root, name), text);
			return { path: join(root, name), loader: "file", isEntry: true, headers: { etag, "content-type": type } };
		};
		return {
			index: join(root, "index-h7qagb7x.html"),
			files: [
				file("chunk-ehzzqme2.js", SCRIPT, "text/javascript;charset=utf-8", "rrFff1eUjuI"),
				file(
					"index-h7qagb7x.html",
					"<!doctype html><title>Mainworthy</title>",
					"text/html;charset=utf-8",
					"EefXqjCLpz0",
				),
				file("chunk-dsth2dfw.css", "body{margin:0}", "text/css;charset=utf-8", "bdl6caKNz9w"),
				file("icon-y24xhkpb.svg", "<svg/>", "image/svg+xml", "voJkPRGzNks"),
				file("notice.txt", "a file whose name says nothing of its content", "text/plain", "Qm9vS2VlcGVy"),
			],
		};
	}

	test("the page carries the strict policy at every address the app routes, and is checked again on each visit", async () => {
		const instance = boot(built());
		for (const path of ["/", "/p/scratch/suite/c/1", "/index-h7qagb7x.html", "/chunk-unknown.js", "/api/nothing"]) {
			const reply = await fetch(`${instance.url}${path}`, { headers: { "x-forwarded-proto": "https" } });
			expect(reply.status, path).toBe(200);
			expect(carried(reply), path).toEqual(expected(PAGE, true));
			expect(reply.headers.get("content-type"), path).toBe("text/html;charset=utf-8");
			expect(reply.headers.get("cache-control"), path).toBe("no-cache");
			expect(reply.headers.get("etag"), path).toBe('"EefXqjCLpz0"');
			expect(await reply.text(), path).toBe("<!doctype html><title>Mainworthy</title>");
		}
	});

	test("a script, a style sheet and the icon carry the headers, their own type, and may be kept for good", async () => {
		const instance = boot(built());
		for (const [path, type, body] of [
			["/chunk-ehzzqme2.js", "text/javascript;charset=utf-8", SCRIPT],
			["/chunk-dsth2dfw.css", "text/css;charset=utf-8", "body{margin:0}"],
			["/icon-y24xhkpb.svg", "image/svg+xml", "<svg/>"],
		]) {
			const reply = await fetch(`${instance.url}${path}`);
			expect(reply.status, path).toBe(200);
			expect(carried(reply), path).toEqual(expected(OTHER, false));
			expect(reply.headers.get("content-type"), path).toBe(type ?? "");
			expect(reply.headers.get("cache-control"), path).toBe("public, max-age=31536000, immutable");
			expect(await reply.text(), path).toBe(body ?? "");
		}
		// Kept for good only because the name changes when the content does. A file with a plain name is asked for
		// again each time, like the page.
		const plainName = await fetch(`${instance.url}/notice.txt`);
		expect(plainName.headers.get("cache-control")).toBe("no-cache");
		expect(carried(plainName)).toEqual(expected(OTHER, false));
	});

	test("a browser that holds a file is told so, with the headers; HEAD has no body; nothing but GET and HEAD is taken", async () => {
		const instance = boot(built());
		// `*` is "whatever you have of it": the browser holds some version, and a name with its hash has only one.
		for (const held of ['"rrFff1eUjuI"', 'W/"rrFff1eUjuI"', '"other", "rrFff1eUjuI"', "*", " * "]) {
			const reply = await fetch(`${instance.url}/chunk-ehzzqme2.js`, { headers: { "if-none-match": held } });
			expect(reply.status, held).toBe(304);
			expect(carried(reply), held).toEqual(expected(OTHER, false));
			expect(await reply.text(), held).toBe("");
		}
		const stale = await fetch(`${instance.url}/chunk-ehzzqme2.js`, { headers: { "if-none-match": '"older"' } });
		expect(stale.status).toBe(200);
		const page = await fetch(`${instance.url}/`, { headers: { "if-none-match": '"EefXqjCLpz0"' } });
		expect(page.status).toBe(304);
		expect(carried(page)).toEqual(expected(PAGE, false));
		const head = await fetch(`${instance.url}/chunk-ehzzqme2.js`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(SCRIPT.length));
		expect(carried(head)).toEqual(expected(OTHER, false));
		expect(await head.text()).toBe("");
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
			const reply = await fetch(`${instance.url}/p/scratch/suite`, { method });
			expect(reply.status, method).toBe(405);
			expect(reply.headers.get("allow"), method).toBe("GET, HEAD");
			expect(carried(reply), method).toEqual(expected(OTHER, false));
		}
	});

	test("only the listed files are served: an address cannot reach a file beside them", async () => {
		const instance = boot(built());
		const beside = join(scratch(), "secret.txt");
		writeFileSync(beside, "not part of the bundle");
		for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", `/${encodeURIComponent(beside)}`, "//etc/passwd"]) {
			const reply = await fetch(`${instance.url}${path}`);
			expect(await reply.text(), path).toBe("<!doctype html><title>Mainworthy</title>");
		}
	});

	test("an API route is still the API's when the UI takes every other path", async () => {
		const instance = boot(built());
		const reply = await fetch(`${instance.url}/api/session`, { headers: bearer });
		expect(reply.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(carried(reply)).toEqual(expected(OTHER, false));
	});
});

describe("the web UI from source: Bun's development bundle, passed on with the headers", () => {
	const scriptsIn = (html: string): string[] =>
		[...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((script) => script[1] ?? "");
	const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("base64");

	test("the page allows the inline scripts that are in it, by hash, and its files carry the headers", async () => {
		const instance = boot(sourceUi);
		const reply = await fetch(`${instance.url}/p/scratch/suite`, { headers: { "x-forwarded-proto": "https" } });
		const html = await reply.text();
		expect(reply.status).toBe(200);
		const inline = scriptsIn(html);
		// If Bun stops writing a script into the page, the development policy can lose its hash and this test says so.
		expect(inline.length).toBeGreaterThan(0);
		expect(carried(reply)).toEqual(expected(developmentPage(inline.map(sha256)), true));
		// The bundle carries code from others without their notices; the page names where they are (decision 0025).
		expect(html).toContain('<link rel="license" href="/docs/licence"');
		const files = [...html.matchAll(/(?:src|href)="(\/_bun\/[^"]+)"/g)].map((match) => match[1] ?? "");
		expect(files.some((file) => file.endsWith(".js"))).toBe(true);
		expect(files.some((file) => file.endsWith(".css"))).toBe(true);
		for (const file of files) {
			const asset = await fetch(`${instance.url}${file}`);
			expect(asset.status, file).toBe(200);
			expect(carried(asset), file).toEqual(expected(OTHER, false));
			expect((await asset.arrayBuffer()).byteLength, file).toBeGreaterThan(0);
		}
	});

	/**
	 * A WebSocket handshake written by hand, as a browser sends it, so that the answer can be read: a WebSocket
	 * client says only that it failed. `Host` is the listener's own unless the test names another.
	 */
	function handshake(
		instance: Instance,
		path: string,
		sent: Record<string, string>,
	): Promise<{ status: number; headers: Headers; body: string }> {
		const { host, port } = new URL(instance.url);
		const lines = [
			`GET ${path} HTTP/1.1`,
			...Object.entries({
				Host: host,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				...sent,
			}).map(([name, value]) => `${name}: ${value}`),
		];
		return new Promise((resolve, reject) => {
			const socket = connect(Number(port), "127.0.0.1");
			let received = "";
			const answered = (): boolean => {
				const end = received.indexOf("\r\n\r\n");
				if (end < 0) return false;
				const [first = "", ...rest] = received.slice(0, end).split("\r\n");
				const headers = new Headers(
					rest.map((line): [string, string] => [line.split(": ")[0] ?? "", line.split(": ")[1] ?? ""]),
				);
				const status = Number(first.split(" ")[1]);
				const body = received.slice(end + 4);
				// A reply with a body is whole when the body is; a socket that was opened has none to wait for.
				if (status !== 101 && body.length < Number(headers.get("content-length") ?? 0)) return false;
				socket.destroy();
				resolve({ status, headers, body: status === 101 ? "" : body });
				return true;
			};
			socket.on("data", (chunk) => {
				received += chunk.toString("latin1");
				answered();
			});
			socket.on("error", reject);
			socket.on("close", () => {
				if (!answered()) reject(new Error(`the listener closed the connection after: ${received}`));
			});
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		});
	}

	test("the page's own reload socket opens: this server's Origin, on the path the development page asks for", async () => {
		const instance = boot(sourceUi);
		const html = await (await fetch(`${instance.url}/`)).text();
		const client = [...html.matchAll(/src="(\/_bun\/client\/[^"]+)"/g)].map((match) => match[1] ?? "")[0];
		// The path is Bun's, in the script it serves with the development page. If Bun moves it, this says so.
		expect(await (await fetch(`${instance.url}${client}`)).text()).toContain('"/_bun/hmr"');
		for (const sent of [{ Origin: instance.url }, { Origin: instance.url, "Sec-Fetch-Site": "same-origin" }]) {
			expect((await handshake(instance, "/_bun/hmr", sent)).status).toBe(101);
		}
		// A client that is not a browser sends no Origin. Bun's own route opened for it, and no page can be it.
		expect((await handshake(instance, "/_bun/hmr", {})).status).toBe(101);
	});

	test("a page on another site cannot open the reload socket: its Origin is refused, with the headers, and nothing is opened", async () => {
		const instance = boot(sourceUi);
		await (await fetch(`${instance.url}/`)).text();
		const { host } = new URL(instance.url);
		for (const sent of [
			{ Origin: "http://other.invalid" },
			{ Origin: "null" },
			{ Origin: "not an origin" },
			// The same host over another scheme or on another port is another origin.
			{ Origin: `https://${host}` },
			{ Origin: "http://127.0.0.1:1" },
			// A browser says which site asked, also when it sends no Origin.
			{ "Sec-Fetch-Site": "cross-site" },
			{ Origin: instance.url, "Sec-Fetch-Site": "same-site" },
		]) {
			const reply = await handshake(instance, "/_bun/hmr", sent);
			expect(reply.status, JSON.stringify(sent)).toBe(403);
			expect(carried(reply), JSON.stringify(sent)).toEqual(expected(OTHER, false));
		}
	});

	test("the reload socket does not open under a name the bundler does not serve, whatever Origin comes with it", async () => {
		const instance = boot(sourceUi);
		await (await fetch(`${instance.url}/`)).text();
		// A page reached through a name that resolves here (DNS rebinding) is same-origin with that name. Bun's
		// development server refuses the name, and it is shown the name the visitor sent, not the relay's own.
		for (const sent of [
			{ Host: "other.invalid", Origin: "http://other.invalid" },
			{ Host: "other.invalid" },
			{ Host: "other.invalid:7357", Origin: "http://other.invalid:7357", "Sec-Fetch-Site": "same-origin" },
		]) {
			const reply = await handshake(instance, "/_bun/hmr", sent);
			expect(reply.status, JSON.stringify(sent)).toBe(403);
			// No opener policy: a browser does not honour one from a network name over plain http.
			expect(carried(reply), JSON.stringify(sent)).toEqual(expected(OTHER, false, false));
		}
	});

	test("only the reload socket's path is made a socket: an upgrade asked of any other path is answered as that path", async () => {
		const instance = boot(sourceUi);
		const page = await (await fetch(`${instance.url}/`)).text();
		for (const path of ["/not-a-websocket", "/p/scratch/suite", "/_bun/hmr/", "/_bun/hmrx", "/x/_bun/hmr"]) {
			const reply = await handshake(instance, path, { Origin: instance.url });
			expect(reply.status, path).toBe(200);
			expect(reply.headers.get("content-type"), path).toBe("text/html;charset=utf-8");
			expect(reply.body, path).toBe(page);
		}
		// An API route was never the web UI's to answer.
		expect((await handshake(instance, "/api/session", { Origin: instance.url })).status).toBe(401);
	});

	test("the reload socket is relayed to the bundler, and what the page posts to it arrives", async () => {
		const instance = boot(sourceUi);
		await (await fetch(`${instance.url}/`)).text();
		const socket = new WebSocket(`${instance.url.replace("http", "ws")}/_bun/hmr`);
		socket.binaryType = "arraybuffer";
		try {
			const first = await new Promise<number>((resolve, reject) => {
				socket.onmessage = (event: MessageEvent<ArrayBuffer>) => resolve(event.data.byteLength);
				socket.onerror = () => reject(new Error("the reload socket did not open"));
				socket.onclose = () => reject(new Error("the reload socket closed before it said anything"));
			});
			// The development server greets a page with its version before anything else.
			expect(first).toBeGreaterThan(0);
		} finally {
			socket.onclose = null;
			socket.close();
		}
		const posted = await fetch(`${instance.url}/_bun/unref`, { method: "POST", body: "00000000" });
		expect(posted.status).not.toBe(405);
		expect(carried(posted)).toEqual(expected(OTHER, false));
	});

	test("the bundler's socket directory goes when its process ends, and one that was left behind goes at the next start", async () => {
		const temporary = scratch();
		// No process has this id (it is above what Linux and macOS give out), so its directory is abandoned.
		const abandoned = "mainworthy-ui-2147483646-abandoned";
		const running = `mainworthy-ui-${process.pid}-running`;
		const unrelated = "mainworthy-e2e-port-7400";
		for (const name of [abandoned, running, unrelated]) mkdirSync(join(temporary, name));
		writeFileSync(join(temporary, abandoned, "ui.sock"), "");
		const source = `
			import { mkdirSync, readdirSync } from "node:fs";
			import ui from ${JSON.stringify(new URL("../src/web/index.html", import.meta.url).pathname)};
			import { uiSurface } from ${JSON.stringify(new URL("../src/surfaces/ui.ts", import.meta.url).pathname)};
			// What a restart under \`bun --watch\` leaves: the same process starts the program again.
			mkdirSync(process.env.TMPDIR + "/mainworthy-ui-" + process.pid + "-earlier");
			uiSurface(ui, () => true);
			console.log(JSON.stringify(readdirSync(process.env.TMPDIR)));
		`;
		const child = Bun.spawn([process.execPath, "-e", source], {
			env: { PATH: process.env.PATH ?? "", TMPDIR: temporary },
			stdout: "pipe",
			stderr: "inherit",
		});
		const during = z.array(z.string()).parse(JSON.parse(await new Response(child.stdout).text()));
		expect(await child.exited).toBe(0);
		const own = during.filter((name) => name.startsWith(`mainworthy-ui-${child.pid}-`));
		expect(own).toHaveLength(1);
		expect(own).not.toEqual([`mainworthy-ui-${child.pid}-earlier`]);
		expect(readdirSync(join(temporary, running))).toEqual([]);
		expect(during.sort()).toEqual([unrelated, ...own, running].sort());
		expect(readdirSync(temporary).sort()).toEqual([unrelated, running].sort());
	});
});

describe("the executable, built the way `bun run build` builds it", () => {
	test("serves the page, the script and the style sheet built into it, with the headers, and listens nowhere else", async () => {
		// The files above are this test's own. These are the ones Bun really puts into an executable: if a later Bun
		// lists them differently, the server would not start, or would serve them bare, and this test says so.
		const manifest = z
			.object({ scripts: z.object({ build: z.string() }) })
			.parse(await Bun.file(new URL("../package.json", import.meta.url)).json());
		const directory = scratch();
		const executable = join(directory, "mainworthy");
		// Split as the shell does: a quoted word (the banner) is one word, without its quotes.
		const words = [...manifest.scripts.build.replace("dist/mainworthy", executable).matchAll(/'([^']*)'|(\S+)/g)].map(
			(word) => word[1] ?? word[2] ?? "",
		);
		// `NODE_ENV=production bun build ...`: the assignments the script makes, then the command.
		const assigned = words.filter((word) => /^[A-Z_]+=/.test(word));
		const [, ...build] = words.slice(assigned.length);
		expect(build).toContain(executable);
		// `bun test` runs with NODE_ENV=test, which a build that does not set its own would inherit: this test builds
		// the way a shell with some other NODE_ENV would, and the script must still make the production bundle.
		const built = Bun.spawn([process.execPath, ...build], {
			env: { ...process.env, ...Object.fromEntries(assigned.map((word) => word.split("="))) },
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "ignore",
			stderr: "pipe",
		});
		expect(await built.exited, await new Response(built.stderr).text()).toBe(0);

		// The container is built by the same command, not by a copy of it that can drift.
		expect(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")).toContain(
			`RUN ${manifest.scripts.build.replace("dist/mainworthy", "/out/mainworthy")}\n`,
		);

		const data = scratch();
		const child = Bun.spawn([executable, "serve"], {
			cwd: data,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: data,
				USER: "robin",
				TMPDIR: data,
				MAINWORTHY_DATA: data,
				MAINWORTHY_PORT: "0",
				MAINWORTHY_MODE: "server",
				MAINWORTHY_OWNER_TOKEN: TOKEN,
				MAINWORTHY_READERS: "1",
			},
			stdout: "pipe",
			stderr: "inherit",
			stdin: "ignore",
		});
		try {
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let printed = "";
			while (!/http:\/\/127\.0\.0\.1:\d+/.test(printed)) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error(`the executable stopped before it printed its address: ${printed}`);
				printed += decoder.decode(chunk.value, { stream: true });
			}
			reader.releaseLock();
			const url = /http:\/\/127\.0\.0\.1:\d+/.exec(printed)?.[0] ?? "";

			const page = await fetch(`${url}/p/scratch/suite`, { headers: { "x-forwarded-proto": "https" } });
			const html = await page.text();
			expect(page.status).toBe(200);
			expect(carried(page)).toEqual(expected(PAGE, true));
			expect(page.headers.get("content-type")).toBe("text/html;charset=utf-8");
			expect(page.headers.get("cache-control")).toBe("no-cache");
			// The built page has no script of its own in it: that is what lets its policy refuse every inline script.
			expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
			// The licence page is a page of the docs, not a file of the build (decision 0025).
			expect(html).toContain('<link rel="license" href="/docs/licence"');
			const files = [...html.matchAll(/(?:src|href)="(\/(?!docs\/)[^"]+)"/g)].map((match) => match[1] ?? "");
			expect(files.map((file) => file.replace(/^.*\./, "")).sort()).toEqual(["css", "js", "svg"]);
			for (const file of files) {
				const asset = await fetch(`${url}${file}`);
				expect(asset.status, file).toBe(200);
				expect(carried(asset), file).toEqual(expected(OTHER, false));
				expect(asset.headers.get("content-type"), file).not.toContain("text/html");
				expect(asset.headers.get("cache-control"), file).toBe("public, max-age=31536000, immutable");
				// A name that carries a hash of the content is what makes "keep it for good" true.
				expect(file).toMatch(/-[a-z0-9]{8}\.\w+$/);
				const body = await asset.text();
				expect(body.length, file).toBeGreaterThan(0);
				if (file.endsWith(".js")) {
					// The production bundle: 618 KB when measured (2026-10-13). A build that did not set NODE_ENV made the
					// development bundle whatever else it was told (the JSX runtime's `jsxDEV` at every element, 882 KB),
					// and nothing said so.
					expect(body.includes("jsxDEV"), "the web script is a development build").toBe(false);
					// The minifier drops the licence comments of the packages in it: the file names where they are.
					expect(body.startsWith("/*! Mainworthy, Apache-2.0."), "the web script names its licences").toBe(true);
					expect(body.slice(0, 200)).toContain("/docs/licence */");
					expect(new TextEncoder().encode(body).byteLength, "the web script outgrew its budget").toBeLessThan(700_000);
				}
				const again = await fetch(`${url}${file}`, { headers: { "if-none-match": asset.headers.get("etag") ?? "" } });
				expect(again.status, file).toBe(304);
				const any = await fetch(`${url}${file}`, { headers: { "if-none-match": "*" } });
				expect(any.status, file).toBe(304);
			}
			const api = await fetch(`${url}/api/session`, { headers: bearer });
			expect(api.status).toBe(200);
			expect(carried(api)).toEqual(expected(OTHER, false));
			// The executable serves its files itself: it has no bundler behind it and so no socket of one.
			expect(readdirSync(data).filter((name) => name.startsWith("mainworthy-ui-"))).toEqual([]);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
		}
	}, 30_000);
});

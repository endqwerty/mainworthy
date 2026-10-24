// What the web client knows of the server without importing it (`src/web` imports only `src/core`, which
// `test/architecture.test.ts` holds): which operations are the instance's, and so where each one is sent. The
// list is in the core, and here it is compared with the registry, so the two cannot drift apart unnoticed.
import { expect, spyOn, test } from "bun:test";
import { INSTANCE_OPS } from "../src/core/api.ts";
import { API_VERSION, API_VERSION_HEADER } from "../src/core/version.ts";
import { OP_LIST } from "../src/server/ops/index.ts";
import { ApiError, call, exchange, session, UnreadableReply, unauthenticatedEvent } from "../src/web/lib/api.ts";
import {
	deviceClearKey,
	deviceSession,
	sessionCurrent,
	setDevicePerson,
	suspendDeviceSession,
} from "../src/web/lib/device.ts";
import { signOut } from "../src/web/lib/signin.ts";

test("the client's list of instance operations is the registry's, so each is sent to the path that serves it", () => {
	const registered: string[] = OP_LIST.filter((op) => op.scope === "instance").map((op) => op.name);
	expect<string[]>([...INSTANCE_OPS].sort()).toEqual(registered.sort());
});

test("every web request declares its API version and preserves a reload refusal", async () => {
	const versions: (string | null)[] = [];
	const message = "This page needs an update. Reload before trying again.";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			versions.push(request.headers.get(API_VERSION_HEADER));
			return Response.json({ ok: false, error: { code: "conflict", message } }, { status: 409 });
		},
	});
	const transport = globalThis.fetch;
	const redirected = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
				transport(new URL(String(input), server.url), init),
			{ preconnect: transport.preconnect },
		),
	);
	try {
		for (const request of [
			() => call("find", {}),
			() => session(),
			() => exchange("/api/login/methods"),
			() => exchange("/api/login", { body: {} }),
		]) {
			const error = await request().catch((error: unknown) => error);
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ code: "conflict", message, status: 409 });
		}
		expect(versions).toEqual(Array(4).fill(String(API_VERSION)));
	} finally {
		redirected.mockRestore();
		await server.stop(true);
	}
});

test("call rejects replies that do not match the operation before returning typed data", async () => {
	let result: unknown = null;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ ok: true, result, seq: null }),
	});
	try {
		const options = { url: server.url.origin, project: "scratch" };
		for (result of [null, { items: [], cursor: null }, { items: [], cursor: null, counts: { failure: "zero" } }]) {
			const reply = await call("inbox", {}, options).catch((error: unknown) => error);
			expect(reply).toBeInstanceOf(UnreadableReply);
			expect(reply).not.toBeInstanceOf(ApiError);
			expect(reply).toMatchObject({ message: "The server answered something this page cannot read; reload." });
		}
		result = { items: [], cursor: null, counts: { failure: 0 } };
		expect(await call("inbox", {}, options)).toEqual({ items: [], cursor: null, counts: { failure: 0 } });
	} finally {
		await server.stop(true);
	}
});

/** Only resolves relative URLs for Bun; the request and delayed reply cross a real HTTP connection. */
async function deviceReply(
	run: (http: { arrived: Promise<void>; release: (status: number) => void }) => Promise<void>,
	options: { login?: unknown; logout?: "success" | "lost"; storage?: "unavailable" | "read-only" | "write-only" } = {},
) {
	const arrived = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<number>();
	const info = {
		actor: "robin",
		actorId: 1,
		kind: "human",
		can: ["read"],
		mode: "server",
		via: "cookie",
		session: 1,
		credentials: null,
		owner: true,
		version: "0.1.0",
		projects: [],
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/api/login" && "login" in options) return Response.json({ ok: true, result: options.login });
			if (path === "/api/logout" && options.logout) {
				if (options.logout === "lost") return new Response("Reply lost", { status: 502 });
				return Response.json({ ok: true, result: {} });
			}
			arrived.resolve();
			const status = await reply.promise;
			return Response.json(
				status === 200
					? { ok: true, result: info }
					: { ok: false, error: { code: "unauthenticated", message: "This session ended." } },
				{ status },
			);
		},
	});
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const stored = new Map<string, string>();
	Reflect.set(globalThis, "window", new EventTarget());
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => {
				if (options.storage === "unavailable" || options.storage === "write-only") throw new Error("No storage read");
				return stored.get(key) ?? null;
			},
			setItem: (key: string, value: string) => {
				if (options.storage === "unavailable" || options.storage === "read-only") throw new Error("No storage write");
				stored.set(key, value);
			},
		},
	});
	const transport = globalThis.fetch;
	const redirected = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
				transport(new URL(String(input), server.url), init),
			{ preconnect: transport.preconnect },
		),
	);
	suspendDeviceSession();
	try {
		await run({ arrived: arrived.promise, release: reply.resolve });
	} finally {
		reply.resolve(200);
		redirected.mockRestore();
		if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
		else Reflect.deleteProperty(globalThis, "localStorage");
		suspendDeviceSession();
		await server.stop(true);
	}
}

const ownedRequests = {
	session: () => session(),
	"explicit session": () => session({ owner: deviceSession() }),
	"signed-in exchange": () =>
		exchange("/api/account/password", { body: { next: "a replacement password" }, signedIn: true }),
	operation: () => call("credential", { do: "list" }),
};

for (const [name, request] of Object.entries(ownedRequests)) {
	for (const change of [
		"another actor",
		"same actor signs in again",
		"same actor in another tab",
		"another tab signs A to B to A",
		"device data cleared",
	])
		for (const status of [200, 401])
			test(`a delayed ${name} ${status} cannot affect the session after ${change}`, () =>
				deviceReply(async ({ arrived, release }) => {
					setDevicePerson({ actor: "robin", actorId: 1 });
					let signedOut = 0;
					window.addEventListener(unauthenticatedEvent, () => signedOut++);
					const pending = request().catch((error: unknown) => error);
					await arrived;
					if (change === "device data cleared") localStorage.setItem(deviceClearKey, "cleared-in-another-tab");
					else if (change === "same actor in another tab" || change === "another tab signs A to B to A") {
						if (change === "another tab signs A to B to A") localStorage.setItem("mainworthy:auth-generation", "B");
						localStorage.setItem("mainworthy:auth-generation", "A-new-session");
					} else {
						suspendDeviceSession();
						setDevicePerson(change === "another actor" ? { actor: "sam", actorId: 2 } : { actor: "robin", actorId: 1 });
					}
					const current = deviceSession();
					release(status);
					const result = await pending;
					expect(result).toBeInstanceOf(ApiError);
					expect(result).toMatchObject({ code: "unauthenticated", status: null });
					expect(signedOut).toBe(0);
					expect(deviceSession()).toEqual(current);
					if (change !== "device data cleared") expect(sessionCurrent(current)).toBe(true);
				}));

	test(`a current ${name} 401 still signs out`, () =>
		deviceReply(async ({ arrived, release }) => {
			setDevicePerson({ actor: "robin", actorId: 1 });
			let signedOut = 0;
			window.addEventListener(unauthenticatedEvent, () => signedOut++);
			const pending = request().catch((error: unknown) => error);
			await arrived;
			release(401);
			expect(await pending).toMatchObject({ code: "unauthenticated", status: 401, message: "This session ended." });
			expect(signedOut).toBe(1);
			expect(sessionCurrent(deviceSession())).toBe(false);
		}));
}

test("an inactive startup session can succeed", () =>
	deviceReply(async ({ arrived, release }) => {
		const pending = session();
		await arrived;
		release(200);
		expect(await pending).toMatchObject({ actor: "robin", actorId: 1, session: 1, via: "cookie" });
	}));

test("an unsigned login refusal keeps its server error without signing out", () =>
	deviceReply(async ({ arrived, release }) => {
		let signedOut = 0;
		window.addEventListener(unauthenticatedEvent, () => signedOut++);
		const pending = exchange("/api/login", { body: { token: "wrong-token" } }).catch((error: unknown) => error);
		await arrived;
		release(401);
		expect(await pending).toMatchObject({ code: "unauthenticated", status: 401, message: "This session ended." });
		expect(signedOut).toBe(0);
	}));

test("call sends an instance operation to /api/<op> and a project's operation to /api/p/<project>/<op>", async () => {
	const paths: string[] = [];
	const echo = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			paths.push(path);
			return Response.json({
				ok: true,
				result: path.endsWith("/inbox") ? { items: [], counts: {}, cursor: null } : [],
				seq: null,
			});
		},
	});
	try {
		const options = { url: `http://127.0.0.1:${echo.port}`, project: "web", token: "not-read-by-the-echo" };
		expect(await call("session", { do: "list" }, options)).toEqual([]);
		expect(await call("credential", { do: "list" }, options)).toEqual([]);
		expect(await call("invitation", { do: "list" }, options)).toEqual([]);
		expect(await call("admin", { do: "token.list" }, options)).toEqual([]);
		expect(await call("inbox", {}, options)).toEqual({ items: [], counts: {}, cursor: null });
		expect(paths).toEqual(["/api/session", "/api/credential", "/api/invitation", "/api/admin", "/api/p/web/inbox"]);
	} finally {
		await echo.stop(true);
	}
});

for (const storage of [undefined, "unavailable", "read-only", "write-only"] as const)
	for (const transition of ["login", "logout"] as const)
		test(`successful ${transition} discards a held response with ${storage ?? "working"} storage without ending UI ownership`, () =>
			deviceReply(
				async ({ arrived, release }) => {
					setDevicePerson({ actor: "robin", actorId: 1 });
					const owner = deviceSession();
					let signedOut = 0;
					window.addEventListener(unauthenticatedEvent, () => signedOut++);
					const pending = session().catch((error: unknown) => error);
					await arrived;
					await exchange(transition === "login" ? "/api/login" : "/api/logout", { body: {} });
					release(401);
					expect(await pending).toMatchObject({ code: "unauthenticated", status: null });
					expect(signedOut).toBe(0);
					expect(sessionCurrent(owner)).toBe(true);
				},
				{ login: { signedIn: true }, logout: "success", ...(storage ? { storage } : {}) },
			));

for (const result of [
	{ signedIn: false, secondFactor: { challenge: "second-factor", expiresAt: 123 } },
	{ linked: true },
	{ requested: true },
	{ verified: true },
	{ changed: true },
])
	test(`a non-session login reply ${JSON.stringify(result)} leaves a held session current`, () =>
		deviceReply(
			async ({ arrived, release }) => {
				setDevicePerson({ actor: "robin", actorId: 1 });
				const pending = session();
				await arrived;
				await exchange("/api/login", { body: {} });
				release(200);
				expect(await pending).toMatchObject({ actor: "robin", actorId: 1, session: 1 });
			},
			{ login: result },
		));

test("ordinary session reads and identity adoption leave an earlier response usable", () =>
	deviceReply(async ({ arrived, release }) => {
		setDevicePerson({ actor: "robin", actorId: 1 });
		const pending = session();
		await arrived;
		release(200);
		const info = await session();
		setDevicePerson(info);
		expect(await pending).toMatchObject({ actor: "robin", actorId: 1, session: 1 });
	}));

for (const clear of [false, true])
	test(`a lost logout reply is not confirmed by a stale session refusal with clear=${clear}`, () =>
		deviceReply(
			async ({ arrived, release }) => {
				setDevicePerson({ actor: "robin", actorId: 1 });
				const owner = deviceSession();
				const pending = signOut({ clear });
				await arrived;
				await exchange("/api/login", { body: {} });
				release(200);
				expect(await pending).toBe("signed-in");
				expect(sessionCurrent(owner)).toBe(true);
			},
			{ login: { signedIn: true }, logout: "lost" },
		));

test("busy is a retryable operation refusal in both clients and is never retried automatically", async () => {
	const { readEnvelope, unwrap } = await import("../src/cli/client.ts");
	const { CliError } = await import("../src/cli/errors.ts");
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return Response.json(
				{ ok: false, error: { code: "busy", message: "retry the same request with the same command id" } },
				{ status: 503 },
			);
		},
	});
	try {
		const error = await call(
			"propose",
			{ cmd: "busy-client-command", edits: [{ op: "create", body: { title: "preserved" } }] },
			{ url: server.url.origin, project: "scratch" },
		).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ code: "busy", retryable: true, status: 503 });
		const envelope = await readEnvelope(await fetch(server.url));
		let cli: unknown;
		try {
			unwrap(envelope);
		} catch (error) {
			cli = error;
		}
		expect(cli).toBeInstanceOf(CliError);
		expect(cli).toMatchObject({ code: "busy", retryable: true });
		expect(requests).toBe(2);
	} finally {
		await server.stop(true);
	}
});

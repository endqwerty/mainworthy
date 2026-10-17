// What the web client knows of the server without importing it (`src/web` imports only `src/core`, which
// `test/architecture.test.ts` holds): which operations are the instance's, and so where each one is sent. The
// list is in the core, and here it is compared with the registry, so the two cannot drift apart unnoticed.
import { expect, spyOn, test } from "bun:test";
import { INSTANCE_OPS } from "../src/core/api.ts";
import { OP_LIST } from "../src/server/ops/index.ts";
import { ApiError, call, exchange, session, unauthenticatedEvent } from "../src/web/lib/api.ts";
import {
	deviceClearKey,
	deviceSession,
	sessionCurrent,
	setDevicePerson,
	suspendDeviceSession,
} from "../src/web/lib/device.ts";

test("the client's list of instance operations is the registry's, so each is sent to the path that serves it", () => {
	const registered: string[] = OP_LIST.filter((op) => op.scope === "instance").map((op) => op.name);
	expect<string[]>([...INSTANCE_OPS].sort()).toEqual(registered.sort());
});

/** Only resolves relative URLs for Bun; the request and delayed reply cross a real HTTP connection. */
async function deviceReply(
	run: (http: { arrived: Promise<void>; release: (status: number) => void }) => Promise<void>,
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
		async fetch() {
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
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => stored.set(key, value),
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
	for (const change of ["another actor", "same actor signs in again", "device data cleared"])
		for (const status of [200, 401])
			test(`a delayed ${name} ${status} cannot affect the session after ${change}`, () =>
				deviceReply(async ({ arrived, release }) => {
					setDevicePerson({ actor: "robin", actorId: 1 });
					let signedOut = 0;
					window.addEventListener(unauthenticatedEvent, () => signedOut++);
					const pending = request().catch((error: unknown) => error);
					await arrived;
					if (change === "device data cleared") localStorage.setItem(deviceClearKey, "cleared-in-another-tab");
					else {
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
	// A listener that answers with the path it was asked for, in the envelope an operation replies with.
	const echo = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => Response.json({ ok: true, result: new URL(req.url).pathname, seq: null }),
	});
	try {
		const options = { url: `http://127.0.0.1:${echo.port}`, project: "web", token: "not-read-by-the-echo" };
		expect<unknown>(await call("session", { do: "list" }, options)).toBe("/api/session");
		expect<unknown>(await call("credential", { do: "list" }, options)).toBe("/api/credential");
		expect<unknown>(await call("invitation", { do: "list" }, options)).toBe("/api/invitation");
		expect<unknown>(await call("admin", { do: "token.list" }, options)).toBe("/api/admin");
		expect<unknown>(await call("inbox", {}, options)).toBe("/api/p/web/inbox");
	} finally {
		await echo.stop(true);
	}
});

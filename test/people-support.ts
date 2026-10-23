// What the tests of people share: an instance on a real listener with the test's own clock, the requests a
// browser and a script make, and an authenticator written from the specification, as the passkey verifier's
// unit tests have one. Everything said to the server and everything it answered is kept, so a test can search it.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, start } from "../src/app/start.ts";
import { API_VERSION, API_VERSION_HEADER } from "../src/core/version.ts";
import type {
	AssertionOptions,
	AssertionResponse,
	RegistrationOptions,
	RegistrationResponse,
} from "../src/server/identity/webauthn.ts";
import { type Config, defaultConfig } from "../src/server/kernel/app.ts";
import { archiveRoutes } from "../src/surfaces/archive.ts";

/** The owner of every instance here, and the token the owner signs in with. */
export const OWNER = "kim";
export const TOKEN = "owner-secret-0123456789";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = 1_800_000_000_000;
/** Where people open the instance: the relying party of its passkeys. No request in a test is sent there. */
export const PUBLIC = "https://mainworthy.example";

export type Clock = { now: () => number; advance: (ms: number) => void };
export function clockAt(start = T0): Clock {
	let at = start;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		},
	};
}

export type Sent = Record<string, string>;
export const bearer = (token: string): Sent => ({ authorization: `Bearer ${token}` });
/** The header the proxy of a `proxied` world writes: this request came from `address`. */
export const from = (address: string): Sent => ({ "x-client-address": address });
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** What the server answers: an operation's envelope, or a route's, which carries no sequence number. */
export type Body<T> =
	| { ok: true; result: T; seq?: number | null }
	| { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
export type Answer<T> = {
	status: number;
	body: Body<T>;
	text: string;
	setCookies: string[];
	cookie: string;
	/** The `Retry-After` header, or null. */
	retryAfter: string | null;
};
/** A reply in one line: `200`, `401 unauthenticated`, `429 limited, retry after 1`. */
export const said = (reply: Answer<unknown>): string =>
	`${reply.status}${reply.body.ok ? "" : ` ${reply.body.error.code}`}${reply.retryAfter === null ? "" : `, retry after ${reply.retryAfter}`}`;
/** The result of an answer that must be a success. */
export function must<T>(reply: Answer<T>): T {
	if (!reply.body.ok) throw new Error(`refused: ${reply.status} ${reply.text}`);
	return reply.body.result;
}

export type World = {
	instance: Instance;
	clock: Clock;
	dataDir: string;
	/** Every reply the server gave in this test, headers and body, as text. */
	replies: string[];
	post: <T = unknown>(path: string, body: unknown, headers?: Sent) => Promise<Answer<T>>;
	get: <T = unknown>(path: string, headers?: Sent) => Promise<Answer<T>>;
	/** One operation of the registry, as the owner unless `headers` says who. */
	op: <T = unknown>(name: string, input: Record<string, unknown>, headers?: Sent) => Promise<Answer<T>>;
	/** The same, for a call that must succeed: its result. */
	ok: <T = unknown>(name: string, input: Record<string, unknown>, headers?: Sent) => Promise<T>;
	/** The status of `GET /api/session` for whoever the headers say. */
	status: (headers: Sent) => Promise<number>;
	/** Every byte the instance has on disk: the database, its write-ahead log and the log's index. */
	disk: () => Buffer;
	/** What was written: the database and its log, without the log's index, which a reader marks too. */
	written: () => Buffer;
	rows: <T>(query: string) => T[];
};

const worlds: World[] = [];
const dirs: string[] = [];
/** Stops every instance a test started and removes its directory. Each test file calls it after each test. */
export async function cleanUp(): Promise<void> {
	for (const world of worlds.splice(0)) await world.instance.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-people-"));
	dirs.push(dir);
	return dir;
}

export type Boot = {
	clock?: Clock;
	dataDir?: string;
	/** `null` is an instance that was told no public address, where passkeys are off. */
	publicUrl?: string | null;
	mode?: Config["mode"];
	/**
	 * The instance is behind a proxy on the loopback address that writes the visitor's address in
	 * `x-client-address`, so a test's request comes from the address it names (`from`). Without it every request
	 * comes from loopback, which is never counted by its address.
	 */
	proxied?: boolean;
	/** An identity provider people may sign in through (`test/oidc-support.ts` makes one). */
	oidc?: Config["oidc"];
	requireAdminMfa?: boolean;
};
/** A server-mode instance whose owner signs in with `TOKEN`. Passwords are hashed at a cost a test can afford. */
export async function world(options: Boot = {}): Promise<World> {
	const clock = options.clock ?? clockAt();
	const dataDir = options.dataDir ?? scratch();
	const mode = options.mode ?? "server";
	const publicUrl = options.publicUrl === undefined ? PUBLIC : options.publicUrl;
	const instance = await start(
		{
			dataDir,
			host: "127.0.0.1",
			port: 0,
			mode,
			owner: OWNER,
			ownerToken: mode === "server" ? TOKEN : null,
			commit: null,
			sessionIdleMs: 14 * DAY,
			sessionMaxMs: 90 * DAY,
			proxy: options.proxied
				? defaultConfig({ MAINWORTHY_TRUSTED_PROXY: "127.0.0.1", MAINWORTHY_CLIENT_ADDRESS_HEADER: "X-Client-Address" })
						.proxy
				: null,
			passwordCost: { memoryCost: 8, timeCost: 1 },
			...(publicUrl === null ? {} : { publicUrl }),
			...(options.oidc ? { oidc: options.oidc } : {}),
			...(options.requireAdminMfa ? { requireAdminMfa: true } : {}),
		},
		(app, owner) => ({ ui: null, routes: archiveRoutes(app, owner) }),
		{ readers: 0, now: clock.now },
	);
	const replies: string[] = [];
	const send = async <T>(method: string, path: string, body: unknown, headers: Sent): Promise<Answer<T>> => {
		const response = await fetch(`${instance.url}${path}`, {
			method,
			headers: {
				[API_VERSION_HEADER]: String(API_VERSION),
				...(method === "POST" ? { "content-type": "application/json" } : {}),
				...headers,
			},
			...(method === "POST" ? { body: JSON.stringify(body) } : {}),
		});
		const text = await response.text();
		replies.push(`${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${text}`);
		const setCookies = response.headers.getSetCookie();
		return {
			status: response.status,
			body: JSON.parse(text) as Body<T>,
			text,
			setCookies,
			// The first cookie of the reply as a browser sends it back: `name=value`.
			cookie: (setCookies[0] ?? "").split(";")[0] ?? "",
			retryAfter: response.headers.get("retry-after"),
		};
	};
	const post = <T>(path: string, body: unknown, headers: Sent = {}) => send<T>("POST", path, body, headers);
	const op = <T>(name: string, input: Record<string, unknown>, headers: Sent = bearer(TOKEN)) =>
		post<T>(`/api/${name}`, input, headers);
	const made: World = {
		instance,
		clock,
		dataDir,
		replies,
		post,
		get: (path, headers = {}) => send("GET", path, undefined, headers),
		op,
		async ok<T>(name: string, input: Record<string, unknown>, headers?: Sent): Promise<T> {
			const reply = await op<T>(name, input, headers);
			if (!reply.body.ok) throw new Error(`${name} ${JSON.stringify(input)}: ${reply.status} ${reply.text}`);
			return reply.body.result;
		},
		status: async (headers) => (await fetch(`${instance.url}/api/session`, { headers })).status,
		disk: () => Buffer.concat(readdirSync(dataDir).map((name) => readFileSync(join(dataDir, name)))),
		written: () =>
			Buffer.concat(
				readdirSync(dataDir)
					.filter((name) => !name.endsWith("-shm"))
					.map((name) => readFileSync(join(dataDir, name))),
			),
		rows: <T>(query: string) => instance.app.reader.raw.query<T, []>(query).all(),
	};
	worlds.push(made);
	return made;
}

export type Invited = { id: number; name: string; purpose: string; code: string; link: string; expiresAt: number };
/** Invites a person as the owner does. */
export const invite = (w: World, input: Record<string, unknown>, headers?: Sent): Promise<Invited> =>
	w.ok<Invited>("invitation", { do: "create", ...input }, headers);

/** Invites a person and accepts with a password: the cookie of the session that opens, as `name=value`. */
export async function joined(
	w: World,
	name: string,
	password: string,
	grant: Record<string, unknown> = { can: ["read"], project: "scratch" },
): Promise<string> {
	const { code } = await invite(w, { name, ...grant });
	const accepted = await w.post("/api/login", { invitation: code, password });
	if (accepted.status !== 200) throw new Error(`${name} did not join: ${accepted.status} ${accepted.text}`);
	return accepted.cookie;
}

/** Signs in with a name and a password. */
export const signIn = (w: World, name: string, password: string, headers: Sent = {}) =>
	w.post<{ signedIn: boolean }>("/api/login", { name, password }, headers);

/** Holds the write gate, as a long report does, until `release`. */
export function holdGate(instance: Instance): { release: () => Promise<void> } {
	let open = (): void => {};
	const held = instance.app.gate.run(
		() =>
			new Promise<void>((resolve) => {
				open = resolve;
			}),
	);
	return {
		release: () => {
			open();
			return held;
		},
	};
}

/**
 * Resolves once `count` more callers have asked for the write gate. A request does its reading first and asks
 * for the gate afterwards, so this is how a test knows that a request it sent is waiting there and not still
 * on its way.
 */
export function waitingAtGate(instance: Instance, count: number): Promise<void> {
	const gate = instance.app.gate;
	const run = gate.run;
	return new Promise((resolve) => {
		let seen = 0;
		gate.run = (fn) => {
			seen++;
			if (seen === count) {
				gate.run = run;
				// After the caller's own turn of the loop, so that it is in the queue when the test goes on.
				setImmediate(resolve);
			}
			return run(fn);
		};
	});
}

const encoded = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const digest = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

/** What a test may change about one answer of the authenticator. */
export type Twist = {
	/** The counter the answer carries, in place of the next one. */
	signCount?: number;
	/** The user handle the answer carries: another text, or null for none. */
	userHandle?: string | null;
	/** The origin the browser writes, in place of the page's. */
	origin?: string;
	/** The authenticator did not check who the person is (no fingerprint, face or PIN): only that somebody is there. */
	unverified?: boolean;
	/** The client data begins with a UTF-8 byte-order mark, which a reader of JSON drops and a signature covers. */
	bom?: boolean;
};

/**
 * An authenticator holding one ES256 key, and the browser around it: it takes the options the server answers
 * and makes what the page would send. Its counter grows by one with each sign-in.
 */
export type Authenticator = {
	/** The credential id, base64url. */
	readonly id: string;
	register: (options: RegistrationOptions, twist?: Twist) => RegistrationResponse;
	assert: (options: AssertionOptions, twist?: Twist) => AssertionResponse;
};
export function authenticator(origin = PUBLIC): Authenticator {
	const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const id = randomBytes(32);
	const jwk = pair.publicKey.export({ format: "jwk" });
	// The key in COSE form, as an authenticator writes it into its data: {1: 2, 3: -7, -1: 1, -2: x, -3: y}.
	const cose = Buffer.concat([
		Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
		Buffer.from(jwk.x ?? "", "base64url"),
		Buffer.from([0x22, 0x58, 0x20]),
		Buffer.from(jwk.y ?? "", "base64url"),
	]);
	let counter = 0;
	let filedUnder: string | null = null;
	const data = (rpId: string, flags: number, signCount: number, credential: boolean): Buffer => {
		const fixed = Buffer.alloc(37);
		digest(Buffer.from(rpId)).copy(fixed, 0);
		fixed.writeUInt8(flags, 32);
		fixed.writeUInt32BE(signCount, 33);
		if (!credential) return fixed;
		const length = Buffer.alloc(2);
		length.writeUInt16BE(id.length);
		return Buffer.concat([fixed, Buffer.alloc(16), length, id, cose]);
	};
	const clientData = (type: string, challenge: string, twist: Twist): Buffer =>
		Buffer.concat([
			Buffer.from(twist.bom ? [0xef, 0xbb, 0xbf] : []),
			Buffer.from(JSON.stringify({ type, challenge, origin: twist.origin ?? origin, crossOrigin: false })),
		]);
	return {
		id: encoded(id),
		register(options, twist = {}) {
			filedUnder = options.user.id;
			return {
				id: encoded(id),
				clientDataJSON: encoded(clientData("webauthn.create", options.challenge, twist)),
				authenticatorData: encoded(
					data(options.rp.id, twist.unverified ? UP | AT : UP | UV | AT, twist.signCount ?? 0, true),
				),
				publicKey: encoded(pair.publicKey.export({ format: "der", type: "spki" })),
				publicKeyAlgorithm: -7,
				transports: ["internal"],
			};
		},
		assert(options, twist = {}) {
			counter = twist.signCount ?? counter + 1;
			const client = clientData("webauthn.get", options.challenge, twist);
			const authenticatorData = data(options.rpId, twist.unverified ? UP : UP | UV, counter, false);
			const handle = twist.userHandle === undefined ? filedUnder : twist.userHandle;
			return {
				id: encoded(id),
				clientDataJSON: encoded(client),
				authenticatorData: encoded(authenticatorData),
				signature: encoded(sign("sha256", Buffer.concat([authenticatorData, digest(client)]), pair.privateKey)),
				...(handle === null ? {} : { userHandle: handle }),
			};
		},
	};
}

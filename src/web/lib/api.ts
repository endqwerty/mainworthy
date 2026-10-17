import { z } from "zod";
import { type Api, type Envelope, ERROR_CODES, INSTANCE_OPS, type OpName, type SessionInfo } from "../../core/api.ts";
import { Unlinked } from "../../core/kinds.ts";
import {
	authenticationGeneration,
	authenticationUnchanged,
	type DeviceSession,
	deviceSession,
	publishAuthentication,
	sessionCurrent,
	sessionUnchanged,
	suspendDeviceSession,
} from "./device.ts";

const Wire = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), result: z.unknown(), seq: z.number().nullable().optional() }),
	z.object({
		ok: z.literal(false),
		error: z.object({
			code: z.enum(ERROR_CODES),
			message: z.string(),
			details: z.record(z.string(), z.unknown()).optional(),
		}),
	}),
]);
const Session = z.object({
	actor: z.string(),
	actorId: z.number().int(),
	kind: z.enum(["human", "agent", "ci", "rule"]),
	can: z.array(z.string()),
	mode: z.enum(["local", "server"]),
	via: z.enum(["token", "cookie", "local"]),
	session: z.number().nullable(),
	credentials: z.object({ password: z.boolean(), passkeys: z.number() }).nullable(),
	owner: z.boolean(),
	version: z.string(),
	projects: z.array(
		z.object({
			key: z.string(),
			name: z.string(),
			seq: z.number(),
			createdAt: z.number(),
			policy: z.string(),
			unlinked: Unlinked,
			demo: z.boolean(),
			can: z.array(z.string()),
		}),
	),
});

type Refusal = Extract<Envelope<unknown>, { ok: false }>["error"];
export class ApiError extends Error {
	constructor(
		readonly code: Refusal["code"],
		message: string,
		/** What the server added for the page to act on, such as who a browser is signed in as. */
		readonly details: Readonly<Record<string, unknown>> = {},
		/** The HTTP status of the reply that refused. Null for a refusal the page made itself, before asking. */
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "ApiError";
	}
}
export const unauthenticatedEvent = "mainworthy:unauthenticated";
/**
 * The page is signed in no more: its session ended, or the person signed out. What the device keeps for the
 * person is set aside and the app shows the sign-in page.
 */
export function signedOut(): void {
	suspendDeviceSession();
	window.dispatchEvent(new Event(unauthenticatedEvent));
}
function refuse(error: Refusal, status: number): never {
	if (error.code === "unauthenticated" && typeof window !== "undefined") signedOut();
	throw new ApiError(error.code, error.message, error.details, status);
}
export type CallOptions = {
	project?: string;
	url?: string;
	token?: string;
	signal?: AbortSignal;
	keepalive?: boolean;
	owner?: DeviceSession;
};

const instanceOps: readonly OpName[] = INSTANCE_OPS;

/** The operation map owns input and reply types; wire envelopes are validated at this boundary. */
export async function call<O extends OpName>(
	op: O,
	input: Api[O]["input"],
	options: CallOptions = {},
): Promise<Api[O]["reply"]> {
	const owner =
		typeof window !== "undefined" && !options.token && !options.url ? (options.owner ?? deviceSession()) : null;
	const authentication = owner ? authenticationGeneration() : null;
	const assertOwner = (): void => {
		if (owner && (!sessionCurrent(owner) || (authentication && !authenticationUnchanged(authentication))))
			throw new ApiError("unauthenticated", "The session changed. Your input is kept for the person who typed it.");
	};
	assertOwner();

	const project =
		options.project ??
		(typeof location === "undefined" ? "scratch" : decodeURIComponent(location.pathname.split("/")[2] ?? "scratch"));
	const path = instanceOps.includes(op) ? `/api/${op}` : `/api/p/${encodeURIComponent(project)}/${op}`;
	const response = await fetch(`${options.url ?? ""}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(owner ? { "X-Mainworthy-As": String(owner.actorId) } : {}),
			...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
		},
		body: JSON.stringify(input),
		...(options.signal ? { signal: options.signal } : {}),
		keepalive: options.keepalive ?? false,
	});
	const envelope = Wire.parse(await response.json());
	assertOwner();
	if (!envelope.ok) refuse(envelope.error, response.status);
	return envelope.result as Api[O]["reply"];
}
export async function session(
	options: { owner?: DeviceSession; signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<SessionInfo> {
	const owner = options.owner ?? deviceSession();
	const authentication = authenticationGeneration();
	const response = await fetch("/api/session", {
		...(options.signal ? { signal: options.signal } : {}),
		keepalive: options.keepalive ?? false,
	});
	const envelope = Wire.parse(await response.json());
	if (!authenticationUnchanged(authentication) || !(options.owner ? sessionCurrent(owner) : sessionUnchanged(owner)))
		throw new ApiError("unauthenticated", "The session changed. Your input is kept.");
	if (!envelope.ok) refuse(envelope.error, response.status);
	const info = Session.parse(envelope.result);
	// The pages show a project's content. A project the caller holds a grant on and may not read is not one of them.
	return { ...info, projects: info.projects.filter((project) => project.can.includes("read")) };
}
/**
 * What a page says of a reply that was refused for too many failed attempts (`limited`, 429): how long to wait,
 * and nothing about what was counted. The server says how long in a header; a proxy that dropped it leaves the
 * sentence without a number.
 */
function waitSentence(response: Response): string {
	const seconds = Number(response.headers.get("retry-after") ?? "");
	const wait =
		Number.isInteger(seconds) && seconds > 0 ? `in ${seconds} ${seconds === 1 ? "second" : "seconds"}` : "later";
	return `Too many attempts. Try again ${wait}.`;
}
/**
 * One of the routes that are not operations: signing in and out, and setting a password (`signin.ts` has a
 * function for each). With a body it is a POST. `signedIn` says the page asks as the person it is signed in as:
 * the request names them, so the server refuses it when the cookie has become somebody else's, and a 401 means
 * the session ended, as it does for an operation. Without it nobody is signed in yet, and a 401 is a refusal
 * for the caller to show.
 */
export async function exchange(
	path: string,
	{ body, signedIn = false }: { body?: unknown; signedIn?: boolean } = {},
): Promise<unknown> {
	const owner = signedIn ? deviceSession() : null;
	const authentication = owner ? authenticationGeneration() : null;
	const response = await fetch(
		path,
		body === undefined
			? {}
			: {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(owner ? { "X-Mainworthy-As": String(owner.actorId) } : {}),
					},
					body: JSON.stringify(body),
				},
	);
	const envelope = Wire.parse(await response.json());
	if (owner && (!sessionCurrent(owner) || (authentication && !authenticationUnchanged(authentication))))
		throw new ApiError("unauthenticated", "The session changed. Your input is kept.");
	if (envelope.ok) {
		if (path === "/api/logout" || z.object({ signedIn: z.literal(true) }).safeParse(envelope.result).success)
			publishAuthentication();
		return envelope.result;
	}
	// Every one of these routes may be answered `limited`: a wrong token, password, passkey or invitation code
	// too often, or a wrong current password. The sentence is the same wherever it is shown.
	const error =
		envelope.error.code === "limited" ? { ...envelope.error, message: waitSentence(response) } : envelope.error;
	if (signedIn) refuse(error, response.status);
	throw new ApiError(error.code, error.message, error.details, response.status);
}

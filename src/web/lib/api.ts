import { z } from "zod";
import { type Api, type Envelope, ERROR_CODES, INSTANCE_OPS, type OpName, type SessionInfo } from "../../core/api.ts";
import { Unlinked } from "../../core/kinds.ts";
import { FieldDefinitions } from "../../core/model.ts";
import { REPLIES } from "../../core/replies.ts";
import {
	data as schemaData,
	flag as schemaFlag,
	nullableNumber as schemaNullableNumber,
	number as schemaNumber,
	text as schemaText,
	texts as schemaTexts,
	unknownValue as schemaUnknownValue,
	whole as schemaWhole,
} from "../../core/schema.ts";
import { API_VERSION, API_VERSION_HEADER } from "../../core/version.ts";
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
	z.object({ ok: z.literal(true), result: schemaUnknownValue, seq: schemaNullableNumber.optional() }),
	z.object({
		ok: z.literal(false),
		error: z.object({
			code: z.enum(ERROR_CODES),
			message: schemaText,
			details: schemaData.optional(),
		}),
	}),
]);
const Session = z.object({
	actor: schemaText,
	actorId: schemaWhole,
	kind: z.enum(["human", "agent", "ci", "rule"]),
	can: schemaTexts,
	mode: z.enum(["local", "server"]),
	via: z.enum(["token", "cookie", "local"]),
	session: schemaNullableNumber,
	credentials: z.object({ password: schemaFlag, passkeys: schemaNumber }).nullable(),
	owner: schemaFlag,
	version: schemaText,
	projects: z.array(
		z.object({
			key: schemaText,
			identity: schemaText,
			name: schemaText,
			seq: schemaNumber,
			createdAt: schemaNumber,
			policy: schemaText,
			unlinked: Unlinked,
			fieldDefinitions: FieldDefinitions.optional(),
			demo: schemaFlag,
			can: schemaTexts,
			handoff: schemaFlag,
		}),
	),
});

type Refusal = Extract<Envelope<unknown>, { ok: false }>["error"];
/**
 * The server answered `ok`, in a shape this page cannot read: a tab from before a deploy that changed the reply.
 * Not an `ApiError`: the server did not refuse, so a write may have been recorded, and a caller that keeps a
 * command for a write that may have happened keeps it.
 */
export class UnreadableReply extends Error {
	constructor() {
		super("The server answered something this page cannot read; reload.");
		this.name = "UnreadableReply";
	}
}

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
function sessionChanged(): never {
	throw new ApiError("unauthenticated", "The session changed. Your input is kept for the person who typed it.");
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
const replySchemas: { [O in OpName]: z.ZodType<Api[O]["reply"]> } = REPLIES;
const headers = { "content-type": "application/json", [API_VERSION_HEADER]: String(API_VERSION) };

/** The operation map owns input and reply types; envelopes and replies are validated at this boundary. */
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
			sessionChanged();
	};
	assertOwner();

	const project =
		options.project ??
		(typeof location === "undefined" ? "scratch" : decodeURIComponent(location.pathname.split("/")[2] ?? "scratch"));
	const path = instanceOps.includes(op) ? `/api/${op}` : `/api/p/${encodeURIComponent(project)}/${op}`;
	const response = await fetch(`${options.url ?? ""}${path}`, {
		method: "POST",
		headers: {
			...headers,
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
	const parsed = replySchemas[op].safeParse(envelope.result);
	if (!parsed.success) throw new UnreadableReply();
	return parsed.data;
}
export async function session(
	options: { owner?: DeviceSession; signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<SessionInfo> {
	const owner = options.owner ?? deviceSession();
	const authentication = authenticationGeneration();
	const response = await fetch("/api/session", {
		headers,
		...(options.signal ? { signal: options.signal } : {}),
		keepalive: options.keepalive ?? false,
	});
	const envelope = Wire.parse(await response.json());
	if (!authenticationUnchanged(authentication) || !(options.owner ? sessionCurrent(owner) : sessionUnchanged(owner)))
		sessionChanged();
	if (!envelope.ok) refuse(envelope.error, response.status);
	const info = Session.parse(envelope.result);
	// The pages show a project's content. A project the caller holds a grant on and may not read is not one of them.
	return { ...info, projects: info.projects.filter((project) => project.can.includes("read")) };
}
/**
 * What a page says of a reply that was refused for too many attempts (`limited`, 429): how long to wait,
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
	const response = await fetch(path, {
		headers: { ...headers, ...(owner ? { "X-Mainworthy-As": String(owner.actorId) } : {}) },
		...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
	});
	const envelope = Wire.parse(await response.json());
	if (owner && (!sessionCurrent(owner) || (authentication && !authenticationUnchanged(authentication))))
		sessionChanged();
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

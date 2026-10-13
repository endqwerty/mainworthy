import { z } from "zod";
import { type Api, type Envelope, ERROR_CODES, type OpName, type SessionInfo } from "../../core/api.ts";
import { type DeviceSession, deviceSession, sessionCurrent, suspendDeviceSession } from "./device.ts";

const Wire = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), result: z.unknown(), seq: z.number().nullable().optional() }),
	z.object({
		ok: z.literal(false),
		error: z.object({
			code: z.enum(ERROR_CODES),
			message: z.string(),
		}),
	}),
]);
const Session = z.object({
	actor: z.string(),
	kind: z.enum(["human", "agent", "ci", "rule"]),
	can: z.array(z.string()),
	mode: z.enum(["local", "server"]),
	via: z.enum(["token", "cookie", "local"]),
	version: z.string(),
	projects: z.array(
		z.object({
			key: z.string(),
			name: z.string(),
			seq: z.number(),
			createdAt: z.number(),
			policy: z.string(),
			can: z.array(z.string()),
		}),
	),
});

export class ApiError extends Error {
	constructor(
		readonly code: Extract<Envelope<unknown>, { ok: false }>["error"]["code"],
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}
export const unauthenticatedEvent = "mainworthy:unauthenticated";
function refuse(error: Extract<Envelope<unknown>, { ok: false }>["error"], message = error.message): never {
	if (error.code === "unauthenticated" && typeof window !== "undefined") {
		suspendDeviceSession();
		window.dispatchEvent(new Event(unauthenticatedEvent));
	}
	throw new ApiError(error.code, message);
}
export type CallOptions = {
	project?: string;
	url?: string;
	token?: string;
	signal?: AbortSignal;
	keepalive?: boolean;
	owner?: DeviceSession;
};

/** The operation map owns input and reply types; wire envelopes are validated at this boundary. */
export async function call<O extends OpName>(
	op: O,
	input: Api[O]["input"],
	options: CallOptions = {},
): Promise<Api[O]["reply"]> {
	const owner =
		typeof window !== "undefined" && !options.token && !options.url ? (options.owner ?? deviceSession()) : null;
	const assertOwner = (): void => {
		if (owner && !sessionCurrent(owner))
			throw new ApiError("unauthenticated", "The session changed. Your input is kept for the person who typed it.");
	};
	assertOwner();

	const project =
		options.project ??
		(typeof location === "undefined" ? "scratch" : decodeURIComponent(location.pathname.split("/")[2] ?? "scratch"));
	const path = op === "admin" ? `/api/${op}` : `/api/p/${encodeURIComponent(project)}/${op}`;
	const response = await fetch(`${options.url ?? ""}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(owner ? { "X-Mainworthy-As": encodeURIComponent(owner.person) } : {}),
			...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
		},
		body: JSON.stringify(input),
		...(options.signal ? { signal: options.signal } : {}),
		keepalive: options.keepalive ?? false,
	});
	const envelope = Wire.parse(await response.json());
	assertOwner();
	if (!envelope.ok) refuse(envelope.error);
	return envelope.result as Api[O]["reply"];
}
export async function session(
	options: { owner?: DeviceSession; signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<SessionInfo> {
	const envelope = Wire.parse(
		await (
			await fetch("/api/session", {
				...(options.signal ? { signal: options.signal } : {}),
				keepalive: options.keepalive ?? false,
			})
		).json(),
	);
	if (options.owner && !sessionCurrent(options.owner))
		throw new ApiError("unauthenticated", "The session changed. Your input is kept.");
	if (!envelope.ok) refuse(envelope.error);
	const info = Session.parse(envelope.result);
	// The pages show a project's content. A project the caller holds a grant on and may not read is not one of them.
	return { ...info, projects: info.projects.filter((project) => project.can.includes("read")) };
}
export async function login(token: string): Promise<void> {
	const response = await fetch("/api/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token }),
	});
	const envelope = Wire.parse(await response.json());
	if (envelope.ok) return;
	if (envelope.error.code !== "limited") refuse(envelope.error, "That token was not accepted. Try again.");
	// Too many wrong tokens, from this address or at this token. The server says how long to wait in a header;
	// a proxy that dropped it leaves the sentence without a number.
	const seconds = Number(response.headers.get("retry-after") ?? "");
	const wait =
		Number.isInteger(seconds) && seconds > 0 ? `in ${seconds} ${seconds === 1 ? "second" : "seconds"}` : "later";
	refuse(envelope.error, `Too many attempts. Try again ${wait}.`);
}

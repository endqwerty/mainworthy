import { z } from "zod";
import type { Api, Envelope, OpName, SessionInfo } from "../../core/api.ts";

const Wire = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), result: z.unknown(), seq: z.number().nullable().optional() }),
	z.object({
		ok: z.literal(false),
		error: z.object({
			code: z.enum(["invalid", "unauthenticated", "forbidden", "not_found", "conflict", "internal"]),
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
		z.object({ key: z.string(), name: z.string(), seq: z.number(), createdAt: z.number(), policy: z.string() }),
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
export type CallOptions = { project?: string; url?: string; token?: string; signal?: AbortSignal; keepalive?: boolean };

/** The operation map owns input and reply types; wire envelopes are validated at this boundary. */
export async function call<O extends OpName>(
	op: O,
	input: Api[O]["input"],
	options: CallOptions = {},
): Promise<Api[O]["reply"]> {
	const project =
		options.project ??
		(typeof location === "undefined" ? "scratch" : decodeURIComponent(location.pathname.split("/")[2] ?? "scratch"));
	const path = op === "admin" ? `/api/${op}` : `/api/p/${encodeURIComponent(project)}/${op}`;
	const response = await fetch(`${options.url ?? ""}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
		},
		body: JSON.stringify(input),
		...(options.signal ? { signal: options.signal } : {}),
		keepalive: options.keepalive ?? false,
	});
	const envelope = Wire.parse(await response.json());
	if (!envelope.ok) throw new ApiError(envelope.error.code, envelope.error.message);
	return envelope.result as Api[O]["reply"];
}
export async function session(): Promise<SessionInfo> {
	const envelope = Wire.parse(await (await fetch("/api/session")).json());
	if (!envelope.ok) throw new ApiError(envelope.error.code, envelope.error.message);
	return Session.parse(envelope.result);
}
export async function login(token: string): Promise<void> {
	const envelope = Wire.parse(
		await (
			await fetch("/api/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token }),
			})
		).json(),
	);
	if (!envelope.ok) throw new ApiError(envelope.error.code, "That token was not accepted. Try again.");
}

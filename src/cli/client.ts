import { z } from "zod";
import { type Api, type Envelope, ERROR_CODES, type OpName, type SessionInfo } from "../core/api.ts";
import { Unlinked } from "../core/kinds.ts";
import { OPS } from "../server/ops/index.ts";
import type { Reply } from "../server/ops/registry.ts";
import type { Args } from "./args.ts";
import { CliError } from "./errors.ts";
import { REPLY_SCHEMAS } from "./replies.ts";

const ErrorSchema = z.object({
	code: z.enum(ERROR_CODES),
	message: z.string(),
	details: z.record(z.string(), z.unknown()).optional(),
});
const EnvelopeSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), result: z.unknown(), seq: z.number().nullable().optional().default(null) }),
	z.object({ ok: z.literal(false), error: ErrorSchema }),
]);
const SessionSchema = z.object({
	actor: z.string(),
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
			unlinked: Unlinked.optional(),
			can: z.array(z.string()).default([]),
		}),
	),
}) satisfies z.ZodType<SessionInfo>;

export type ClientOptions = { url: string; token: string | undefined; project: string | undefined };

/**
 * Command-line flags override the environment. An absent token lets the server authenticate loopback local mode.
 * An environment variable that is set and empty counts as absent: that is how a pipeline passes a setting nobody
 * configured (`MAINWORTHY_URL: ${{ vars.MAINWORTHY_URL }}`).
 */
export function clientOptions(args: Args, env: Record<string, string | undefined> = process.env): ClientOptions {
	return {
		url: args.value("url") ?? (env.MAINWORTHY_URL || "http://127.0.0.1:7357"),
		token: args.value("token") ?? (env.MAINWORTHY_TOKEN || undefined),
		project: args.value("project") ?? (env.MAINWORTHY_PROJECT || undefined),
	};
}

/** Parses the HTTP envelope before its result is trusted under the shared Api contract. */
export async function readEnvelope(response: Response): Promise<Envelope<unknown>> {
	const body: unknown = await response.json().catch(() => null);
	const parsed = EnvelopeSchema.safeParse(body);
	if (!parsed.success)
		throw new CliError("internal", `the server returned an invalid response (HTTP ${response.status})`);
	return parsed.data;
}

export function unwrap(reply: Envelope<unknown>): unknown {
	if (!reply.ok) throw new CliError(reply.error.code, reply.error.message);
	return reply.result;
}

/** A typed HTTP client; every operation uses the registry's scope and the shared input/reply map. */
export class Client {
	readonly url: string;
	private sessionPromise: Promise<SessionInfo> | undefined;

	constructor(readonly options: ClientOptions) {
		const parsed = z.url().safeParse(options.url);
		if (!parsed.success || !/^https?:\/\//.test(parsed.data))
			throw new CliError("invalid", "--url must be an HTTP or HTTPS URL");
		this.url = parsed.data.replace(/\/+$/, "");
	}

	/** Request bodies and response bodies remain streams for archive transfer. */
	async request(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
		try {
			return await fetch(`${this.url}${path}`, { ...init, headers });
		} catch {
			throw new CliError("connection", `cannot connect to ${this.url}; start the server with mainworthy serve`);
		}
	}

	session(): Promise<SessionInfo> {
		this.sessionPromise ??= this.request("/api/session")
			.then(readEnvelope)
			.then(unwrap)
			.then((body) => {
				const parsed = SessionSchema.safeParse(body);
				if (!parsed.success) throw new CliError("internal", "the server returned invalid session information");
				return parsed.data;
			});
		return this.sessionPromise;
	}

	async project(): Promise<string> {
		if (this.options.project) return this.options.project;
		const { projects } = await this.session();
		if (projects.length === 1 && projects[0]) return projects[0].key;
		const existing = projects.map((project) => project.key).join(", ") || "none visible";
		throw new CliError("invalid", `choose a project with --project or MAINWORTHY_PROJECT; projects: ${existing}`);
	}

	/** Returns the validated envelope, including failures, for MCP's protocol-level forwarding. */
	async forward(op: string, project: string | null, input: unknown): Promise<Reply> {
		const path =
			project === null
				? `/api/${encodeURIComponent(op)}`
				: `/api/p/${encodeURIComponent(project)}/${encodeURIComponent(op)}`;
		const reply = await readEnvelope(
			await this.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			}),
		);
		if (reply.ok) return reply;
		const { code, message, details } = reply.error;
		return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
	}

	async operation(op: string, input: unknown): Promise<unknown> {
		const definition = OPS[op];
		if (!definition) throw new CliError("invalid", `unknown operation ${op}`);
		return unwrap(await this.forward(op, definition.scope === "project" ? await this.project() : null, input));
	}

	async call<N extends OpName>(op: N, input: Api[N]["input"]): Promise<Api[N]["reply"]> {
		const result = await this.operation(op, input);
		const parsed = REPLY_SCHEMAS[op].safeParse(result);
		if (!parsed.success) throw new CliError("internal", `the server returned invalid ${op} data`);
		return parsed.data;
	}
}

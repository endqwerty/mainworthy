import { closeSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { type Api, type Envelope, ERROR_CODES, type OpName, type SessionInfo } from "../core/api.ts";
import { Unlinked } from "../core/kinds.ts";
import { FieldDefinitions } from "../core/model.ts";
import { API_VERSION, API_VERSION_HEADER, ApiHealth, AT_HEADER } from "../core/version.ts";
import { TOKEN_MAX } from "../server/identity/identity.ts";
import { OPS } from "../server/ops/index.ts";
import type { Reply } from "../server/ops/registry.ts";
import type { Args } from "./args.ts";
import { CliError } from "./errors.ts";
import { UpgradingHealth } from "./health.ts";
import { displayUrl, warning } from "./output.ts";
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
			identity: z.string(),
			name: z.string(),
			seq: z.number(),
			createdAt: z.number(),
			policy: z.string(),
			unlinked: Unlinked.optional(),
			fieldDefinitions: FieldDefinitions.optional(),
			demo: z.boolean(),
			can: z.array(z.string()).default([]),
			handoff: z.boolean().default(false),
		}),
	),
}) satisfies z.ZodType<SessionInfo>;

export type ClientOptions = {
	url: string;
	token: string | undefined;
	project: string | undefined;
	/** CI may supply a transport that waits out a deploy and owns its request timeouts. */
	request?: (url: string, init?: RequestInit) => Promise<Response>;
};

const TOKEN_FILE_MAX = 4096;

/** The token in a file: the content without the whitespace around it. The file is named in a refusal, never quoted. */
function tokenFromFile(path: string): string {
	let text: string;
	try {
		const file = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(TOKEN_FILE_MAX + 1);
			let size = 0;
			while (size < buffer.length) {
				const read = readSync(file, buffer, size, buffer.length - size, null);
				if (read === 0) break;
				size += read;
			}
			if (size > TOKEN_FILE_MAX)
				throw new CliError("invalid", `the token file ${path} is larger than ${TOKEN_FILE_MAX} bytes`);
			text = buffer.toString("utf8", 0, size);
		} finally {
			closeSync(file);
		}
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError("invalid", `cannot read the token file ${path}`);
	}
	const token = text.trim();
	if (token.length > TOKEN_MAX)
		throw new CliError("invalid", `the token file ${path} holds a token longer than ${TOKEN_MAX} characters`);
	if (token === "") throw new CliError("invalid", `the token file ${path} is empty`);
	if (/\s/.test(token)) throw new CliError("invalid", `the token file ${path} holds more than a token`);
	return token;
}

/**
 * Commands with no credentials ignore token options. Otherwise flags override the environment. An absent token
 * lets the server authenticate loopback local mode.
 * An environment variable that is set and empty counts as absent: that is how a pipeline passes a setting nobody
 * configured (`MAINWORTHY_URL: ${{ vars.MAINWORTHY_URL }}`). The token comes from `--token` or `--token-file`, else
 * from `MAINWORTHY_TOKEN` or `MAINWORTHY_TOKEN_FILE`; two ways at one level are refused, not chosen between.
 */
export function clientOptions(
	args: Args,
	credentials: "none" | "token",
	env: Record<string, string | undefined> = process.env,
): ClientOptions {
	const options = {
		url: args.value("url") ?? (env.MAINWORTHY_URL || "http://127.0.0.1:7357"),
		project: args.value("project") ?? (env.MAINWORTHY_PROJECT || undefined),
	};
	if (credentials === "none") return { ...options, token: undefined };
	const flag = args.value("token");
	const flagFile = args.value("token-file");
	if (flag !== undefined && flagFile !== undefined)
		throw new CliError("invalid", "give the token with --token or with --token-file, not both");
	if (env.MAINWORTHY_TOKEN && env.MAINWORTHY_TOKEN_FILE && flag === undefined && flagFile === undefined)
		throw new CliError("invalid", "MAINWORTHY_TOKEN and MAINWORTHY_TOKEN_FILE are both set; set one");
	const file =
		flagFile ?? (flag === undefined && !env.MAINWORTHY_TOKEN ? env.MAINWORTHY_TOKEN_FILE || undefined : undefined);
	return {
		...options,
		token: file !== undefined ? tokenFromFile(file) : (flag ?? (env.MAINWORTHY_TOKEN || undefined)),
	};
}

/**
 * True for an `http:` address that names another machine: a token sent there travels in the clear. This machine is
 * `localhost`, any `127.x.x.x` and `[::1]`, named as the server names them (`docs/guide/configuration.md`).
 */
export function plainHttpToAnotherMachine(address: string): boolean {
	const url = new URL(address);
	if (url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	const loopback = host === "localhost" || host === "[::1]" || /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host);
	return !loopback;
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
	private compatibilityPromise: Promise<void> | undefined;
	private sessionPromise: Promise<SessionInfo> | undefined;

	/** `notice` is shared by the clients of one run, so what is said once is said once for the run. */
	constructor(
		readonly options: ClientOptions,
		private readonly notice = { plainHttp: false },
	) {
		const parsed = z.url().safeParse(options.url);
		if (!parsed.success || !/^https?:\/\//.test(parsed.data))
			throw new CliError("invalid", "--url must be an HTTP or HTTPS URL");
		this.url = parsed.data.replace(/\/+$/, "");
	}

	/** The same server and run with other options (`seed` acts as the actors it makes). */
	with(changes: Partial<ClientOptions>): Client {
		return new Client({ ...this.options, ...changes }, this.notice);
	}

	/**
	 * Every request a command makes passes here, so this is the one place that says, before the first request that
	 * carries a token to plain http on another machine, that the token travels unencrypted. It goes to standard error
	 * and does not stop the request: a person on a network of their own may mean it. It names the address, not the token.
	 */
	private warnOfPlainHttp(): void {
		if (this.notice.plainHttp || !plainHttpToAnotherMachine(this.url)) return;
		this.notice.plainHttp = true;
		warning(
			`warning: the token is sent to ${new URL(this.url).origin} over plain http and travels unencrypted; use an https address`,
		);
	}

	private async compatible(): Promise<void> {
		let response: Response;
		try {
			response = await (this.options.request ?? fetch)(`${this.url}/healthz`, {
				redirect: "manual",
				...(this.options.request ? {} : { signal: AbortSignal.timeout(5000) }),
			});
		} catch {
			throw new CliError(
				"connection",
				`cannot connect to ${displayUrl(this.url)}; start the server with mainworthy serve`,
			);
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			const origin = location && URL.canParse(location, this.url) ? new URL(location, this.url).origin : null;
			throw new CliError(
				"connection",
				`the server answered ${response.status} to /healthz${origin ? `; redirect to origin ${origin}; set --url to ${origin}` : "; a redirect without a valid Location header"}`,
			);
		}
		if (!response.ok)
			throw new CliError("connection", `the server answered ${response.status} to /healthz at ${displayUrl(this.url)}`);
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new CliError(
				"connection",
				`the server answered ${response.status} to /healthz with invalid JSON at ${displayUrl(this.url)}`,
			);
		}
		if (UpgradingHealth.safeParse(body).success)
			throw new CliError("connection", `the server at ${displayUrl(this.url)} is upgrading; try again shortly`);
		const health = ApiHealth.safeParse(body);
		if (!health.success || health.data.apiVersion !== API_VERSION)
			throw new CliError(
				"incompatible",
				`CLI requires API ${API_VERSION}; the server at ${displayUrl(this.url)} does not advertise it; use a CLI and server with the same API version (mainworthy version; mainworthy health --json)`,
			);
	}

	/** Request bodies and response bodies remain streams for archive transfer. */
	async request(path: string, init: RequestInit = {}): Promise<Response> {
		this.compatibilityPromise ??= this.compatible();
		await this.compatibilityPromise;
		const headers = new Headers(init.headers);
		headers.set(API_VERSION_HEADER, String(API_VERSION));
		if (this.options.token) {
			headers.set("authorization", `Bearer ${this.options.token}`);
			this.warnOfPlainHttp();
		}
		try {
			return await (this.options.request ?? fetch)(`${this.url}${path}`, { ...init, headers });
		} catch {
			throw new CliError(
				"connection",
				`cannot connect to ${displayUrl(this.url)}; start the server with mainworthy serve`,
			);
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

	/**
	 * Returns the validated envelope, including failures, for MCP's protocol-level forwarding. `at` says when the
	 * request happened, which only a write to a demo project takes (`seed`).
	 */
	async forward(op: string, project: string | null, input: unknown, at?: number): Promise<Reply> {
		if (
			op === "report" &&
			typeof input === "object" &&
			input !== null &&
			!Array.isArray(input) &&
			(!("cmd" in input) || input.cmd === undefined)
		)
			input = { ...input, cmd: crypto.randomUUID() };
		const path =
			project === null
				? `/api/${encodeURIComponent(op)}`
				: `/api/p/${encodeURIComponent(project)}/${encodeURIComponent(op)}`;
		const reply = await readEnvelope(
			await this.request(path, {
				method: "POST",
				headers: { "content-type": "application/json", ...(at === undefined ? {} : { [AT_HEADER]: String(at) }) },
				body: JSON.stringify(input),
			}),
		);
		if (reply.ok) return reply;
		const { code, message, details } = reply.error;
		return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
	}

	/**
	 * The one place a successful reply is read: it is checked against `schema` before anyone sees it, so no caller
	 * prints, or chooses an exit code from, a reply its operation does not describe (decision 0035).
	 */
	private async checked<T>(op: string, schema: z.ZodType<T>, input: unknown, at?: number): Promise<T> {
		const definition = OPS[op];
		if (!definition) throw new CliError("invalid", `unknown operation ${op}`);
		const result = unwrap(
			await this.forward(op, definition.scope === "project" ? await this.project() : null, input, at),
		);
		const parsed = schema.safeParse(result);
		if (!parsed.success) throw new CliError("internal", `the server returned invalid ${op} data`);
		return parsed.data;
	}

	/** An operation named at run time (the generated commands): its reply is checked against the registry's schema. */
	async operation(op: string, input: unknown, at?: number): Promise<unknown> {
		const definition = OPS[op];
		if (!definition) throw new CliError("invalid", `unknown operation ${op}`);
		return this.checked(op, definition.output, input, at);
	}

	async call<N extends OpName>(op: N, input: Api[N]["input"], at?: number): Promise<Api[N]["reply"]> {
		return this.checked(op, REPLY_SCHEMAS[op], input, at);
	}
}

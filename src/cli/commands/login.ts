import { CredentialInput, PasswordEntry, PersonalTokenCreated } from "../../core/people.ts";
import { assertPositionals } from "../args.ts";
import { plainHttpToAnotherMachine, readEnvelope, unwrap } from "../client.ts";
import { CliError } from "../errors.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

async function secretFile(path: string | undefined, flag: string): Promise<string> {
	if (!path) throw new CliError("invalid", `--${flag} is required; keep the secret in a private file`);
	try {
		const file = Bun.file(path);
		if (file.size > 4096) throw new Error("too large");
		const text = await file.text();
		if (Buffer.byteLength(text) > 4096) throw new Error("too large");
		return text.replace(/\r?\n$/, "");
	} catch {
		throw new CliError("invalid", `cannot read --${flag}; use a file of at most 4096 bytes`);
	}
}
const cookieOf = (response: Response, kind: "sid" | "ceremony"): string | undefined =>
	response.headers
		.getSetCookie()
		.find((cookie) => new RegExp(`^(?:__Host-)?mainworthy_${kind}=[^;]+;`).test(cookie))
		?.split(";")[0];

export const loginCommand: AdapterCommand = {
	name: "login",
	summary:
		"Sign in with a password and, when enrolled, an authenticator or recovery code. Print a personal CLI token once.",
	usage: "login --name <name> --password-file <path> [--code-file <path>] [--label <label>] [--expires 30d] [--json]",
	flags: [
		{ name: "name", kind: "string", description: "Your sign-in name, or your email address." },
		{
			name: "password-file",
			kind: "string",
			description: "A private file holding your password. One final newline is ignored.",
		},
		{
			name: "code-file",
			kind: "string",
			description: "A private file holding a current authenticator code or unused recovery code.",
		},
		{ name: "label", kind: "string", description: "The personal token label. Default: command line." },
		{ name: "expires", kind: "string", description: "How long the personal token lasts. Default: 30d; at most 365d." },
	],
	async run(args, client) {
		assertPositionals(args, 0, 0, loginCommand.usage);
		const name = args.value("name");
		if (!name) throw new CliError("invalid", "--name is required");
		if (plainHttpToAnotherMachine(client.url))
			throw new CliError("invalid", "use HTTPS to send a password to another machine");
		const tokenInput = CredentialInput.parse({
			do: "token.create",
			label: args.value("label") ?? "command line",
			expires: args.value("expires") ?? "30d",
			cmd: crypto.randomUUID(),
		});
		const password = await secretFile(args.value("password-file"), "password-file");
		const send = (path: string, body: unknown, cookie?: string) =>
			client.request(path, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
				headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
				body: JSON.stringify(body),
			});
		let response = await send("/api/login", { name, password });
		const first = PasswordEntry.parse(unwrap(await readEnvelope(response)));
		if (!first.signedIn) {
			const code = (await secretFile(args.value("code-file"), "code-file")).trim();
			const ceremony = cookieOf(response, "ceremony");
			if (!ceremony) throw new CliError("internal", "the server did not provide the second-step cookie");
			response = await send("/api/login", { challenge: first.secondFactor.challenge, code }, ceremony);
			const completed = PasswordEntry.parse(unwrap(await readEnvelope(response)));
			if (!completed.signedIn) throw new CliError("internal", "the server did not complete the second step");
		}
		const cookie = cookieOf(response, "sid");
		if (!cookie) throw new CliError("internal", "the server did not provide a sign-in session");
		try {
			const token = PersonalTokenCreated.parse(
				unwrap(await readEnvelope(await send("/api/credential", tokenInput, cookie))),
			);
			if (args.has("json")) printJson(token, args.bool("compact"));
			else {
				line(token.token);
				line("Shown once. Store this personal token in MAINWORTHY_TOKEN or a private token file.");
			}
			return 0;
		} finally {
			await send("/api/logout", {}, cookie).catch(() => undefined);
		}
	},
};

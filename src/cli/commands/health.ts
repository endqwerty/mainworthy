import { assertPositionals } from "../args.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

/**
 * The container's health check. It needs no token and reads no project: `/healthz` says the process is up and
 * which version it is. Without `--url` or `CASEBOOK_URL` it asks the server on this machine at `CASEBOOK_PORT`.
 */
export const healthCommand: AdapterCommand = {
	name: "health",
	summary: "Check that the server answers. Exit 0 when it does, 1 when it does not.",
	usage: "health [--url <url>] [--json]",
	flags: [],
	async run(args, client) {
		assertPositionals(args, 0, 0, healthCommand.usage);
		const named = args.value("url") ?? process.env.CASEBOOK_URL;
		const url = named ? client.url : `http://127.0.0.1:${process.env.CASEBOOK_PORT || "7357"}`;
		let version: string | null = null;
		try {
			const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2500) });
			const body: unknown = await response.json().catch(() => null);
			if (response.ok && typeof body === "object" && body !== null && "ok" in body && body.ok === true) {
				version = "version" in body && typeof body.version === "string" ? body.version : "";
			}
		} catch {}
		if (args.has("json")) printJson({ url, healthy: version !== null, version }, args.bool("compact"));
		else line(version !== null ? `healthy: Casebook ${version} at ${url}` : `not answering: ${url}`);
		return version !== null ? 0 : 1;
	},
};

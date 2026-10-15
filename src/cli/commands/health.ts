import { API_VERSION, ApiHealth } from "../../core/version.ts";
import { assertPositionals } from "../args.ts";
import { line, printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

/**
 * The container's health check. It needs no token and reads no project: `/healthz` says the process is up and
 * which version and, when it knows, which commit it is (an older server reports no commit). Without `--url` or `MAINWORTHY_URL` it asks the server on this machine at `MAINWORTHY_PORT`.
 */
export const healthCommand: AdapterCommand = {
	name: "health",
	summary: "Check that the server answers. Exit 0 when it does, 1 when it does not.",
	usage: "health [--url <url>] [--json]",
	flags: [],
	async run(args, client) {
		assertPositionals(args, 0, 0, healthCommand.usage);
		const named = args.value("url") ?? process.env.MAINWORTHY_URL;
		const url = named ? client.url : `http://127.0.0.1:${process.env.MAINWORTHY_PORT || "7357"}`;
		let version: string | null = null;
		let commit: string | null = null;
		let apiVersion: number | null = null;
		try {
			const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2500) });
			const body: unknown = await response.json().catch(() => null);
			if (response.ok && typeof body === "object" && body !== null && "ok" in body && body.ok === true) {
				const api = ApiHealth.safeParse(body);
				apiVersion = api.success ? api.data.apiVersion : null;
				version = "version" in body && typeof body.version === "string" ? body.version : "";
				// Only a full commit is shown: the address may be any server, and a reply must not put its own text on the terminal.
				commit =
					"commit" in body && typeof body.commit === "string" && /^[0-9a-f]{40}$/.test(body.commit)
						? body.commit
						: null;
			}
		} catch {}
		if (args.has("json"))
			printJson(
				{ url, healthy: version !== null, version, commit, apiVersion, compatible: apiVersion === API_VERSION },
				args.bool("compact"),
			);
		else if (version === null) line(`not answering: ${url}`);
		else line(`healthy: Mainworthy ${version}${commit ? ` (commit ${commit.slice(0, 12)})` : ""} at ${url}`);
		return version !== null ? 0 : 1;
	},
};

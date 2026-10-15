import { AnnounceInput } from "../../core/ops.ts";
import { assertPositionals } from "../args.ts";
import { CliError } from "../errors.ts";
import { printJson } from "../output.ts";
import type { AdapterCommand } from "./types.ts";

export const announceCommand: AdapterCommand = {
	name: "announce",
	summary: "Announce a deployed build. A new artifact needs its digest, repository and full commit.",
	usage: "announce --deploy <build> --env <env> [--digest sha256:<hash> --repo <repo> --commit <sha>]",
	flags: [
		{ name: "deploy", kind: "string", description: "Build label." },
		{ name: "env", kind: "string", description: "Environment deployed to." },
		{ name: "digest", kind: "string", description: "Artifact's SHA-256 digest." },
		{ name: "repo", kind: "string", description: "Source repository." },
		{ name: "commit", kind: "string", description: "Full source commit hash." },
		{ name: "cmd", kind: "string", description: "Idempotency key for this deployment." },
	],
	async run(args, client) {
		assertPositionals(args, 0, 0, announceCommand.usage);
		if (args.has("repo") !== args.has("commit")) throw new CliError("invalid", "supply both --repo and --commit");
		const input = AnnounceInput.parse({
			deploy: args.value("deploy"),
			env: args.value("env"),
			...(args.has("digest") ? { digest: args.value("digest") } : {}),
			...(args.has("repo") ? { code: [{ repo: args.value("repo"), commit: args.value("commit") }] } : {}),
			...(args.has("cmd") ? { cmd: args.value("cmd") } : {}),
		});
		printJson(await client.call("announce", input), args.bool("compact"));
		return 0;
	},
};

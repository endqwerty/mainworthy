import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { TargetIn } from "../core/ops.ts";
import { detectTarget } from "../surfaces/ci-env.ts";
import type { Args, Flag } from "./args.ts";
import { CliError } from "./errors.ts";

export const TARGET_FLAGS: readonly Flag[] = [
	{ name: "commit", kind: "string", description: "Commit tested. Overrides CI/Git detection." },
	{ name: "branch", kind: "string", description: "Branch tested." },
	{ name: "pr", kind: "number", description: "Pull request number." },
	{ name: "base", kind: "string", description: "Base commit of the change." },
	{ name: "head", kind: "string", description: "Current change head read from the code host. Never inferred from CI." },
	{ name: "env", kind: "string", description: "Test environment." },
];

function gitValue(args: string[]): string | undefined {
	try {
		const value = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

/** Source paths are relative to the checkout, including when report runs in a subdirectory. */
export function reportRoot(): string {
	return gitValue(["rev-parse", "--show-toplevel"]) ?? process.cwd();
}

/** Converts SSH and HTTP remotes to the owner/repository identity used in targets. */
export function repoOf(remote: string | undefined): string | undefined {
	if (!remote) return undefined;
	const path = remote.includes("://") ? new URL(remote).pathname : remote.replace(/^[^:]+:/, "");
	const parts = path
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	return parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
}

/** Git is a read-only fallback when a CI environment does not identify the build. */
export function gitTarget(): { commit?: string; branch?: string; repo?: string } | null {
	const commit = gitValue(["rev-parse", "HEAD"]);
	const branch = gitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
	const repo = repoOf(gitValue(["remote", "get-url", "origin"]));
	if (!commit) return null;
	return { commit, ...(branch && branch !== "HEAD" ? { branch } : {}), ...(repo ? { repo } : {}) };
}

export function detectedTarget(): ReturnType<typeof detectTarget> {
	return detectTarget(process.env, {
		git: gitTarget,
		readFile(path) {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
	});
}

/** Explicit session targets have no build identity; commit flags override detected CI/Git metadata. */
export function reportTarget(args: Args, detected: ReturnType<typeof detectTarget>): TargetIn | undefined {
	const session = args.value("session");
	if (session !== undefined) {
		if (TARGET_FLAGS.some((flag) => args.has(flag.name)))
			throw new CliError(
				"invalid",
				"--session has no build identity; omit commit, branch, PR, base, head and environment flags",
			);
		return TargetIn.parse({ session });
	}
	const original = detected.target && "commit" in detected.target ? detected.target : undefined;
	const commit = args.value("commit") ?? original?.commit;
	if (!commit) {
		if (args.has("run")) return undefined;
		throw new CliError(
			"invalid",
			`missing ${detected.missing.join(", ") || "commit"}; provide --commit <sha> or --session <name> (a session has no build identity)`,
		);
	}
	return TargetIn.parse({
		...original,
		commit,
		...(args.has("branch") ? { branch: args.value("branch") } : {}),
		...(args.has("pr") ? { pr: args.number("pr") } : {}),
		...(args.has("base") ? { base: args.value("base") } : {}),
		...(args.has("head") ? { head: args.value("head") } : {}),
		...(args.has("env") ? { env: args.value("env") } : {}),
	});
}

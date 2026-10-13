// Which Casebook the gate job reports to. A deployed one, named by CASEBOOK_URL, keeps the decisions people made
// about earlier runs, so it is used whenever it can be. When it cannot be reached, or does not describe `report`
// and `gate` as this checkout does, the job starts its own for this one run: that one knows no earlier decision,
// so it never passes what the deployed one would have blocked for a failing test. A credential the deployed
// instance refuses is neither: it is somebody's mistake, and the job fails and says so.
//
// One instance per run, chosen once. `scripts/ci-gate.ts` asks here and nowhere else.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openApi } from "../src/surfaces/http.ts";

export type Choice =
	/** Report to the deployed instance, to this project: the one named, or the only one the token may record on. */
	| { use: "deployed"; url: string; project: string; why: string }
	/** Start a Casebook for this job. `warn` when a deployed one was configured and could not be used. */
	| { use: "own"; warn: boolean; why: string }
	/** The configuration is wrong. Nothing is reported. */
	| { use: "none"; why: string };

type Environment = Record<string, string | undefined>;
export type Probe = {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	/** How often `/healthz` is asked before the instance counts as unreachable, and the wait between two tries. */
	attempts: number;
	pauseMs: number;
	timeoutMs: number;
};
/** A runner that has just joined a tailnet resolves the name and gets its first answer within a few seconds. */
export const PROBE: Probe = { fetch, attempts: 3, pauseMs: 1000, timeoutMs: 5000 };

const PIPELINE_OPS = ["report", "gate"] as const;
const Description = z.object({ paths: z.record(z.string(), z.unknown()) });
const Session = z.object({
	ok: z.literal(true),
	result: z.object({ projects: z.array(z.object({ key: z.string(), can: z.array(z.string()) })) }),
});

/** The same text for the same value, whatever order its keys were written in. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) => {
		if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
		return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	});
}

/**
 * The pipeline operations an API description describes differently from this checkout: their input, and what
 * they ask of the caller. A reply's shape is not in the description (issue #52), so a change to one is not seen.
 */
export function contractDifferences(theirs: unknown, ours: unknown = openApi()): string[] {
	const [remote, local] = [Description.safeParse(theirs), Description.parse(ours)];
	return PIPELINE_OPS.filter((op) => {
		const path = `/api/p/{project}/${op}`;
		return !remote.success || canonical(remote.data.paths[path]) !== canonical(local.paths[path]);
	});
}

/** Chooses the instance for this run. It reads; it reports nothing and starts nothing. */
export async function chooseInstance(env: Environment, probe: Probe = PROBE): Promise<Choice> {
	const url = env.CASEBOOK_URL?.replace(/\/+$/, "");
	if (!url) return { use: "own", warn: false, why: "CASEBOOK_URL is not set" };
	const get = (path: string, headers: Record<string, string> = {}) =>
		probe.fetch(`${url}${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(probe.timeoutMs) });
	const own = (why: string): Choice => ({
		use: "own",
		warn: true,
		why: `${why}; the decisions kept at ${url} do not count in this run`,
	});

	let unreachable = "";
	for (let attempt = 1; attempt <= probe.attempts; attempt++) {
		try {
			const health = await get("/healthz");
			unreachable = health.ok ? "" : `it answered ${health.status}`;
		} catch (error) {
			unreachable = error instanceof Error ? error.message : String(error);
		}
		if (unreachable === "") break;
		if (attempt < probe.attempts) await Bun.sleep(probe.pauseMs);
	}
	if (unreachable !== "") return own(`${url} cannot be reached (${unreachable})`);

	let differences: string[];
	try {
		differences = contractDifferences(await (await get("/api/openapi.json")).json());
	} catch {
		differences = [...PIPELINE_OPS];
	}
	if (differences.length > 0)
		return own(`${url} describes ${differences.join(" and ")} differently from this checkout (another version)`);

	const token = env.CASEBOOK_TOKEN;
	const response = await get("/api/session", token ? { authorization: `Bearer ${token}` } : {}).catch(() => null);
	if (response === null || response.status >= 500) return own(`${url} did not say who this job is`);
	if (response.status === 401)
		return {
			use: "none",
			why: `${url} refuses ${token ? "CASEBOOK_TOKEN (revoked or mistyped)" : "a job with no CASEBOOK_TOKEN"}`,
		};
	const session = Session.safeParse(await response.json().catch(() => null));
	if (!session.success) return own(`${url} did not say who this job is`);
	const recordable = session.data.result.projects
		.filter((project) => project.can.includes("record"))
		.map((entry) => entry.key);
	const named = env.CASEBOOK_PROJECT;
	// With no project named it is the one the token may record on. The CLI is told which: left to itself it takes
	// the only project the session names, and the session also names the ones the token may only read.
	const project = named ? recordable.find((key) => key === named) : recordable.length === 1 ? recordable[0] : undefined;
	if (project === undefined) {
		const held = recordable.join(", ") || "none";
		return {
			use: "none",
			why: named
				? `the token may not record results on project ${named} at ${url} (it may on: ${held})`
				: `CASEBOOK_PROJECT is not set and the token may record on ${recordable.length} projects at ${url} (${held})`,
		};
	}
	return { use: "deployed", url, project, why: `${url}, project ${project}` };
}

/** One sentence for the log and the run's summary page: which Casebook decided, and why that one. */
export function describeChoice(choice: Choice): string {
	if (choice.use === "deployed") return `Reported to the deployed Casebook: ${choice.why}.`;
	if (choice.use === "none") return `Nothing was reported: ${choice.why}.`;
	return `Reported to a Casebook started for this job: ${choice.why}.`;
}

/**
 * Starts a Casebook for this job: its own data directory, a port the system picks, the owner of the machine as
 * the caller. Returns the environment a `casebook` command needs to reach it, and how to stop it. The caller
 * stops it on every way out: a server left running outlives the job and holds its output open.
 */
export async function startOwn(cli: string): Promise<{ env: Environment; stop: () => void }> {
	const data = mkdtempSync(join(tmpdir(), "casebook-ci-"));
	const child = Bun.spawn([process.execPath, cli, "serve"], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: data,
			CASEBOOK_DATA: data,
			CASEBOOK_PORT: "0",
			CASEBOOK_HOST: "127.0.0.1",
		},
		stdout: "pipe",
		stderr: "inherit",
	});
	const stop = (): void => {
		// Not asked to finish what it is doing: nothing is in flight when the job is done with it, and the data goes.
		child.kill("SIGKILL");
		rmSync(data, { recursive: true, force: true });
	};
	// The server's first line ends with its address.
	let printed = "";
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + 15_000;
	while (!printed.includes("\n")) {
		const chunk = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
		if (chunk === null || chunk.done) break;
		printed += decoder.decode(chunk.value, { stream: true });
	}
	reader.releaseLock();
	const url = /(http:\/\/\S+)\s*$/.exec(printed.split("\n")[0] ?? "")?.[1];
	if (!url) {
		stop();
		throw new Error(`the job's own Casebook did not start: ${printed.trim() || "it printed nothing"}`);
	}
	console.log(`Started a Casebook for this job: ${url} (process ${child.pid})`);
	// The token and the project are the deployed instance's: neither goes to this one, which has its own project.
	return { env: { CASEBOOK_URL: url, CASEBOOK_TOKEN: "", CASEBOOK_PROJECT: "" }, stop };
}

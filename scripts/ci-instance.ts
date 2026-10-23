// Which Mainworthy the gate job reports to. A deployed one, named by MAINWORTHY_URL, keeps the decisions people made
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
import { UpgradingHealth } from "../src/cli/health.ts";
import { API_VERSION, API_VERSION_HEADER, ApiHealth } from "../src/core/version.ts";
import { openApi } from "../src/surfaces/http.ts";

export type Choice =
	/** Report to the deployed instance, to this project: the one named, or the only one the token may record on. */
	| { use: "deployed"; url: string; project: string; why: string }
	/** Start a Mainworthy for this job. `warn` when a deployed one was configured and could not be used. */
	| { use: "own"; warn: boolean; why: string }
	/** The configuration is wrong. Nothing is reported. */
	| { use: "none"; why: string };

export type Environment = Record<string, string | undefined>;
export type Probe = {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	/** How often `/healthz` is asked before the instance counts as unreachable, and the wait between two tries. */
	attempts: number;
	pauseMs: number;
	timeoutMs: number;
};
/** A runner that has just joined a tailnet resolves the name and gets its first answer within a few seconds. */
export const PROBE: Probe = { fetch, attempts: 3, pauseMs: 1000, timeoutMs: 5000 };

/**
 * CI's JSON requests can meet a deploy after the instance was chosen. Every command shares one deadline,
 * rather than waiting another four minutes for each shard. Ordinary CLI commands never use this transport.
 */
export function deploymentFetch(
	probe: Probe = { fetch, attempts: 12, pauseMs: 10_000, timeoutMs: 10_000 },
): Probe["fetch"] {
	const deadline = Date.now() + probe.attempts * probe.timeoutMs + (probe.attempts - 1) * probe.pauseMs;
	return async (url, init = {}) => {
		for (let attempt = 1; ; attempt++) {
			const left = deadline - Date.now();
			const timeout = AbortSignal.timeout(left > 0 ? Math.min(probe.timeoutMs, left) : probe.timeoutMs);
			try {
				const response = await probe.fetch(url, {
					...init,
					signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
				});
				if (![502, 503, 504].includes(response.status)) {
					// Read CI's finite JSON replies inside the attempt, including a connection lost after headers.
					// Definite refusals are returned untouched and never retried, even if their body cannot be read.
					const buffered =
						response.ok && response.body !== null ? new Response(await response.arrayBuffer(), response) : response;
					if (
						!buffered.ok ||
						new URL(url).pathname !== "/healthz" ||
						!UpgradingHealth.safeParse(
							await buffered
								.clone()
								.json()
								.catch(() => null),
						).success
					)
						return buffered;
					if (attempt >= probe.attempts || Date.now() + probe.pauseMs >= deadline) return buffered;
				} else {
					if (attempt >= probe.attempts || Date.now() + probe.pauseMs >= deadline) return response;
					await response.body?.cancel();
				}
			} catch (error) {
				if (init.signal?.aborted || attempt >= probe.attempts || Date.now() + probe.pauseMs >= deadline) throw error;
			}
			await Bun.sleep(probe.pauseMs);
		}
	};
}

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
 * they ask of the caller. The API version also covers replies and operation meaning.
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
	const url = env.MAINWORTHY_URL?.replace(/\/+$/, "");
	if (!url) return { use: "own", warn: false, why: "MAINWORTHY_URL is not set" };
	const get = (path: string, headers: Record<string, string> = {}) =>
		probe.fetch(`${url}${path}`, {
			headers: { [API_VERSION_HEADER]: String(API_VERSION), ...headers },
			redirect: "error",
			signal: AbortSignal.timeout(probe.timeoutMs),
		});
	const own = (why: string): Choice => ({
		use: "own",
		warn: true,
		why: `${why}; the decisions kept at ${url} do not count in this run`,
	});

	let unreachable = "";
	let compatible = false;
	for (let attempt = 1; attempt <= probe.attempts; attempt++) {
		try {
			const health = await get("/healthz");
			unreachable = health.ok ? "" : `it answered ${health.status}`;
			if (health.ok) {
				const body: unknown = await health.json().catch(() => null);
				if (UpgradingHealth.safeParse(body).success) unreachable = "it is upgrading";
				const parsed = ApiHealth.safeParse(body);
				compatible = parsed.success && parsed.data.apiVersion === API_VERSION;
			}
		} catch (error) {
			unreachable = error instanceof Error ? error.message : String(error);
		}
		if (unreachable === "") break;
		if (attempt < probe.attempts) await Bun.sleep(probe.pauseMs);
	}
	if (unreachable !== "") return own(`${url} cannot be reached (${unreachable})`);

	if (!compatible) return own(`${url} does not support CLI API ${API_VERSION}`);

	let differences: string[];
	try {
		differences = contractDifferences(await (await get("/api/openapi.json")).json());
	} catch {
		differences = [...PIPELINE_OPS];
	}
	if (differences.length > 0)
		return own(`${url} describes ${differences.join(" and ")} differently from this checkout (another version)`);

	const token = env.MAINWORTHY_TOKEN;
	const response = await get("/api/session", token ? { authorization: `Bearer ${token}` } : {}).catch(() => null);
	if (response === null || response.status >= 500) return own(`${url} did not say who this job is`);
	if (response.status === 401)
		return {
			use: "none",
			why: `${url} refuses ${token ? "MAINWORTHY_TOKEN (revoked or mistyped)" : "a job with no MAINWORTHY_TOKEN"}`,
		};
	// An instance limits failed attempts, and answers 429 to a token whose address or first characters failed
	// too often. That is a credential the instance refuses and not an instance to give up on: a token the
	// instance generated, as a pipeline's is, passes a block when it is right.
	if (response.status === 429)
		return {
			use: "none",
			why: `${url} tells MAINWORTHY_TOKEN to wait after too many failed attempts (429): it is revoked or mistyped, or not a token the instance generated`,
		};
	const session = Session.safeParse(await response.json().catch(() => null));
	if (!session.success) return own(`${url} did not say who this job is`);
	const recordable = session.data.result.projects
		.filter((project) => project.can.includes("record"))
		.map((entry) => entry.key);
	const named = env.MAINWORTHY_PROJECT;
	// With no project named it is the one the token may record on. The CLI is told which: left to itself it takes
	// the only project the session names, and the session also names the ones the token may only read.
	const project = named ? recordable.find((key) => key === named) : recordable.length === 1 ? recordable[0] : undefined;
	if (project === undefined) {
		const held = recordable.join(", ") || "none";
		return {
			use: "none",
			why: named
				? `the token may not record results on project ${named} at ${url} (it may on: ${held})`
				: `MAINWORTHY_PROJECT is not set and the token may record on ${recordable.length} projects at ${url} (${held})`,
		};
	}
	return { use: "deployed", url, project, why: `${url}, project ${project}` };
}

/** One sentence for the log and the run's summary page: which Mainworthy decided, and why that one. */
export function describeChoice(choice: Choice): string {
	if (choice.use === "deployed") return `Reported to the deployed Mainworthy: ${choice.why}.`;
	if (choice.use === "none") return `Nothing was reported: ${choice.why}.`;
	return `Reported to a Mainworthy started for this job: ${choice.why}.`;
}

/** A Mainworthy this job started. */
export type Own = {
	/** Kills the server and removes its data. Safe at any moment after `startOwn` returned, and more than once. */
	stop: () => void;
	/** The environment a `mainworthy` command needs to reach it, once it listens. */
	ready: Promise<Environment>;
};

/**
 * Starts a Mainworthy for this job: its own data directory, a port the system picks, the owner of the machine as
 * the caller. It returns at once, before the server listens, so the caller holds `stop` from the moment there is
 * something to stop: a server left running outlives the job and holds its output open.
 */
export function startOwn(cli: string): Own {
	const data = mkdtempSync(join(tmpdir(), "mainworthy-ci-"));
	const child = Bun.spawn([process.execPath, cli, "serve"], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: data,
			MAINWORTHY_DATA: data,
			MAINWORTHY_PORT: "0",
			MAINWORTHY_HOST: "127.0.0.1",
			...(process.env.MAINWORTHY_READERS !== undefined ? { MAINWORTHY_READERS: process.env.MAINWORTHY_READERS } : {}),
		},
		stdout: "pipe",
		stderr: "inherit",
	});
	const stop = (): void => {
		// Not asked to finish what it is doing: nothing is in flight when the job is done with it, and the data goes.
		child.kill("SIGKILL");
		rmSync(data, { recursive: true, force: true });
	};
	const listening = async (): Promise<Environment> => {
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
			throw new Error(`the job's own Mainworthy did not start: ${printed.trim() || "it printed nothing"}`);
		}
		console.log(`Started a Mainworthy for this job: ${url} (process ${child.pid})`);
		// The token and the project are the deployed instance's: neither goes to this one, which has its own project.
		return { MAINWORTHY_URL: url, MAINWORTHY_TOKEN: "", MAINWORTHY_PROJECT: "" };
	};
	return { stop, ready: listening() };
}

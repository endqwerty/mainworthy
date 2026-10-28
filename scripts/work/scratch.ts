// A directory for one task's scratch files, and the only way to delete one. It is under `~/.cache`, never in a
// worktree (the architecture test reads every file in it), and a delete takes the one directory a `make` returned:
// a pattern, a directory nobody made with `make` and another place are refused, so cleaning up cannot remove
// another agent's files.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The file `make` leaves in a directory; `remove` deletes only a directory that has it. */
export const MARKER = ".mw-scratch";

export const defaultRoot = (): string => join(homedir(), ".cache");

/** A new empty directory `<root>/mw-<name>-XXXXXX`, and its real path. */
export function make(name: string, root = defaultRoot()): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
		throw new Error(`a scratch name is lower-case words joined by -, not "${name}"`);
	mkdirSync(root, { recursive: true });
	const directory = realpathSync(mkdtempSync(join(root, `mw-${name}-`)));
	// The marker says where it was made, so a copy of it in another directory proves nothing.
	writeFileSync(join(directory, MARKER), `${directory}\n`);
	return directory;
}

const hasOwnMarker = (real: string): boolean => {
	try {
		return readFileSync(join(real, MARKER), "utf8").trim() === real;
	} catch {
		return false;
	}
};

/** Why `directory` may not be deleted, or null when it may. */
export function refusal(given: string, root = defaultRoot()): string | null {
	// `alias/` and `alias/.` name a link's target as far as the file system is concerned; `resolve` drops both.
	const directory = resolve(given);
	if (/[*?[\]{}]/.test(directory)) return `${directory} is a pattern; give the one directory \`scratch new\` printed`;
	if (!existsSync(directory)) return `${directory} is not there`;
	if (lstatSync(directory).isSymbolicLink()) return `${directory} is a link; give the directory itself`;
	const real = realpathSync(directory);
	if (dirname(real) !== realpathSync(root)) return `${real} is not directly under ${root}`;
	if (!basename(real).startsWith("mw-") || !hasOwnMarker(real))
		return `${real} was not made by \`scratch new\`, so it may be another agent's`;
	return null;
}

/** Deletes a directory `make` made, and nothing else. */
export function remove(given: string, root = defaultRoot()): string {
	const why = refusal(given, root);
	if (why !== null) throw new Error(why);
	const real = realpathSync(resolve(given));
	const pg = resolve(import.meta.dir, "../pg.ts");
	const owners: string[] = [];
	const findCheckouts = (path: string): void => {
		if (existsSync(join(path, "scripts/pg.ts"))) owners.push(realpathSync(path));
		for (const entry of readdirSync(path, { withFileTypes: true }))
			if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git")
				findCheckouts(join(path, entry.name));
	};
	if (existsSync(join(defaultRoot(), "mainworthy/pg"))) {
		findCheckouts(real);
		// Load the helper before it deletes an export that may contain this very script.
		const result = Bun.spawnSync([process.execPath, pg, "cleanup-scratch", real, realpathSync(root), ...owners], {
			cwd: defaultRoot(),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(`scratch PostgreSQL cleanup failed: ${result.stderr.toString().trim()}`);
		if (result.stderr.length > 0) console.warn(result.stderr.toString().trim());
	} else rmSync(real, { recursive: true });
	return real;
}

/** A temporary run uses the same path-bound marker as task scratch, plus all processes that can still use it. */
export function markOwned(directory: string, pids: readonly number[] = [process.pid]): void {
	const real = realpathSync(directory);
	writeFileSync(join(real, MARKER), `${real}\n`);
	writeFileSync(join(real, `${MARKER}-owner`), `${pids.join("\n")}\n`);
}

/** Recover only marked run directories. An unknown process state is treated as alive. */
export function sweepOwned(root: string, prefix: "mainworthy-check-" | "mainworthy-e2e-"): void {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
		const directory = join(realpathSync(root), entry.name);
		try {
			if (!hasOwnMarker(directory)) continue;
			const pids = readFileSync(join(directory, `${MARKER}-owner`), "utf8")
				.trim()
				.split("\n")
				.map(Number);
			if (!pids.length || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) continue;
			const namePid = prefix === "mainworthy-e2e-" ? Number(/^mainworthy-e2e-(\d+)-/.exec(entry.name)?.[1]) : undefined;
			if (namePid !== undefined) {
				if (!Number.isSafeInteger(namePid) || namePid <= 0) continue;
				pids.push(namePid);
			}
			if (
				pids.some((pid) => {
					try {
						process.kill(pid, 0);
						return true;
					} catch (error) {
						return !(error instanceof Error && "code" in error && error.code === "ESRCH");
					}
				})
			)
				continue;
			rmSync(directory, { recursive: true, force: true });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
}

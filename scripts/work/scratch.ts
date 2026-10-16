// A directory for one task's scratch files, and the only way to delete one. It is under `~/.cache`, never in a
// worktree (the architecture test reads every file in it), and a delete takes the one directory a `make` returned:
// a pattern, a directory nobody made with `make` and another place are refused, so cleaning up cannot remove
// another agent's files.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
export function refusal(directory: string, root = defaultRoot()): string | null {
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
export function remove(directory: string, root = defaultRoot()): string {
	const why = refusal(directory, root);
	if (why !== null) throw new Error(why);
	const real = realpathSync(directory);
	rmSync(real, { recursive: true });
	return real;
}

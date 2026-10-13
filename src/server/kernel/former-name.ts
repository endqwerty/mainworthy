// The project was called Casebook until 2026-10-13 (decision 0014). An install made before then keeps its data in
// `~/.casebook/casebook.db`. This module moves that data to where this build looks, once, when the server starts.
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, databasePath, defaultDataDir } from "./app.ts";
import { foldLog } from "./db.ts";

const FORMER_DIR = ".casebook";
const FORMER_FILE = "casebook.db";

/**
 * Moves what an install under the former name left on disk, and says what it did, one line per step.
 *
 * `~/.casebook` becomes `~/.mainworthy` when the instance uses the default data directory and has none yet. Then
 * `casebook.db` in the data directory becomes `mainworthy.db`: its write-ahead log is folded into the file first,
 * so the one rename carries every committed row. Each step looks at what is on disk, so a start that was cut
 * off between two steps is finished by the next one. Nothing is moved onto an existing file or directory.
 *
 * Throws, before anything moves, when another process has the former database open: renaming it then would
 * split that process's writes from the file this one reads.
 */
export function adoptFormerInstall(config: Config, env: Record<string, string | undefined>): string[] {
	const done: string[] = [];
	const formerDir = join(dirname(config.dataDir), FORMER_DIR);
	const formerDirExists = config.dataDir === defaultDataDir(env) && existsSync(formerDir);
	const moveDir = formerDirExists && !existsSync(config.dataDir);
	const current = databasePath(config.dataDir);
	// Where the former database is now, before the directory moves.
	const found = join(moveDir ? formerDir : config.dataDir, FORMER_FILE);
	const moveFile = existsSync(found) && !existsSync(current);
	if (moveFile && !foldLog(found)) throw new Error(`${found} is open in another process; stop it, then start again`);
	if (moveDir) {
		renameSync(formerDir, config.dataDir);
		done.push(`moved ${formerDir} to ${config.dataDir}`);
	} else if (formerDirExists) {
		done.push(`${formerDir} is still there and is not read; ${config.dataDir} is in use`);
	}
	if (moveFile) {
		const former = join(config.dataDir, FORMER_FILE);
		renameSync(former, current);
		// SQLite removes the log when it folds it, and leaves the log's index. It belongs to no file now.
		rmSync(`${former}-shm`, { force: true });
		done.push(`moved ${former} to ${current}`);
	}
	return done;
}

// The step `carry-data` in compose.coolify.yaml, which copies the deployment's volume from its former name to
// `mainworthy-data` before the app starts. The script is read from the file and run with the system's `sh`, on
// two directories in place of the volumes.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

type Compose = { services: Record<string, { entrypoint: string[] }> };

function volumes() {
	const dir = mkdtempSync(join(tmpdir(), "mw-carry-"));
	dirs.push(dir);
	const from = join(dir, "from");
	const to = join(dir, "to");
	mkdirSync(join(from, "blobs"), { recursive: true });
	mkdirSync(to);
	writeFileSync(join(from, "mainworthy.db"), "the database");
	writeFileSync(join(from, "mainworthy.db-wal"), "rows committed since the last checkpoint");
	writeFileSync(join(from, "blobs", "b1"), "an attachment");
	writeFileSync(join(from, "before-rename.ndjson.gz"), "an export");
	return { from, to };
}

function carry(from: string, to: string) {
	const compose = Bun.YAML.parse(readFileSync("compose.coolify.yaml", "utf8")) as Compose;
	const [shell, flags, script] = compose.services["carry-data"].entrypoint;
	// Compose reads `$$` as one `$`; the paths are the two mounts.
	const local = script
		.replaceAll("$$", "$")
		.replaceAll(/\/from\b/g, from)
		.replaceAll(/\/to\b/g, to);
	const run = Bun.spawnSync([shell, flags, local], { stderr: "pipe", stdout: "pipe" });
	return { code: run.exitCode, out: run.stdout.toString().trim() };
}

function tree(dir: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const path = join(entry.parentPath, entry.name);
				return [path.slice(dir.length + 1), readFileSync(path, "utf8")];
			}),
	);
}

test("the first start copies the whole volume, and a later one copies nothing", () => {
	const { from, to } = volumes();
	expect(carry(from, to)).toEqual({ code: 0, out: "carry-data: copied casebook-data to mainworthy-data" });
	expect(tree(to)).toEqual(tree(from));

	writeFileSync(join(to, "mainworthy.db"), "written by the app since");
	expect(carry(from, to)).toEqual({
		code: 0,
		out: "carry-data: mainworthy-data holds a database, nothing to copy",
	});
	expect(readFileSync(join(to, "mainworthy.db"), "utf8")).toBe("written by the app since");
});

test("a copy that stopped half-way is made again from an empty volume", () => {
	const { from, to } = volumes();
	writeFileSync(join(to, ".carrying"), "");
	writeFileSync(join(to, "mainworthy.db"), "the first half");
	writeFileSync(join(to, "blobs"), "a file where the volume has a directory");
	writeFileSync(join(to, ".left-over"), "");

	expect(carry(from, to).code).toBe(0);
	expect(tree(to)).toEqual(tree(from));
});

test.skipIf(process.getuid?.() === 0)("a copy that fails stops the step, and the next start copies again", () => {
	// Root reads a file whatever its mode, so this test needs another user.
	const { from, to } = volumes();
	chmodSync(join(from, "mainworthy.db-wal"), 0o000);
	const failed = carry(from, to);
	expect(failed.code).not.toBe(0);
	expect(readdirSync(to)).toContain(".carrying");

	chmodSync(join(from, "mainworthy.db-wal"), 0o600);
	expect(carry(from, to).code).toBe(0);
	expect(tree(to)).toEqual(tree(from));
});

test("a volume with no database is not copied", () => {
	const { from, to } = volumes();
	rmSync(join(from, "mainworthy.db"));
	expect(carry(from, to)).toEqual({
		code: 0,
		out: "carry-data: casebook-data holds no database, nothing to copy",
	});
	expect(readdirSync(to)).toEqual([]);
});

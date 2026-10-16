// Running a program and reading what it prints: the one place the commands of `scripts/work.ts` do it.
export type Ran = { status: number; out: string; err: string };

/** Runs `argv` and waits. A program that is missing is a failed run with the reason, not a throw. */
export async function run(
	argv: readonly string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Ran> {
	try {
		const child = Bun.spawn([...argv], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			env: { ...process.env, ...options.env },
		});
		const [out, err, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { status, out, err };
	} catch (error) {
		return { status: 127, out: "", err: error instanceof Error ? error.message : String(error) };
	}
}

/** What a program prints when it succeeds; throws with what it said when it does not. */
export async function read(argv: readonly string[], options: { cwd?: string } = {}): Promise<string> {
	const done = await run(argv, options);
	if (done.status !== 0) throw new Error(`${argv.join(" ")} failed (exit ${done.status}): ${done.err.trim()}`);
	return done.out.trim();
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

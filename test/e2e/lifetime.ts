/** A fixture gets only the read end of its lifetime pipe. No descendant can inherit its owner's write end. */
export function watchLifetime(stop: () => Promise<void>): void {
	let stopping: Promise<void> | undefined;
	const shutdown = () =>
		(stopping ??= (async () => {
			const force = setTimeout(() => process.exit(1), 1_000);
			try {
				await stop();
				clearTimeout(force);
				process.exit(0);
			} catch (error) {
				console.error("test fixture shutdown:", error);
				process.exit(1);
			}
		})());
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] satisfies NodeJS.Signals[]) process.on(signal, shutdown);
	if (process.env.MAINWORTHY_TEST_LIFETIME) {
		process.stdin.on("end", shutdown);
		process.stdin.on("error", shutdown);
		process.stdin.resume();
	}
}

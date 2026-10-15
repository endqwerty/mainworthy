/** Drives the same sliced operation synchronously for CLI, startup, and in-process callers. */
export function complete<T>(steps: Generator<void, T, void>): T {
	for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

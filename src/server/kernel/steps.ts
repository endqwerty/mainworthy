/** Drives the same sliced operation synchronously for CLI, startup, and in-process callers. */
export async function complete<T>(steps: AsyncGenerator<void, T, void>): Promise<T> {
	for (let step = await steps.next(); ; step = await steps.next()) if (step.done) return step.value;
}

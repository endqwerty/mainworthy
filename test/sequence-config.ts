// Every PR and local check runs seeds 1–3; the daily workflow runs their superset 1–40.
// Forty preserves the former coverage (493 s recorded across six files), with setup/reporting room in 25 minutes.
export const SEQUENCE_SEEDS = { pr: 3, daily: 40 } as const;

export function sequenceSeeds(env: Record<string, string | undefined>): number[] {
	const positive = (name: string, fallback: number) => {
		const value = env[name] === undefined ? fallback : Number(env[name]);
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
		return value;
	};
	const count = positive("MAINWORTHY_SEQUENCE_SEEDS", SEQUENCE_SEEDS.pr);
	const first = positive("MAINWORTHY_SEQUENCE_FIRST", 1);
	return Array.from({ length: count }, (_, index) => first + index);
}

export function sequenceFailure(file: string, seed: number, detail: unknown): string {
	return `Reproduce: MAINWORTHY_SEQUENCE_FIRST=${seed} MAINWORTHY_SEQUENCE_SEEDS=1 bun test ${file}\n${JSON.stringify(detail, null, 2)}`;
}

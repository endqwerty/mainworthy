import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How far past its baseline a measurement may go before it fails. Above the baseline a budget only warns; ten times
 * it is "a big enough jump that it's fair to mark a test as failed if it suddenly exceeds that and for it to be
 * flagged for review. Only intentionally meaning to do that should be allowed" (the owner, 2026-10-24). Meaning to is
 * changing the baseline in the same pull request and saying why. A baseline of 0 counts as 1 here.
 */
export const FAIL_MULTIPLE = 10;

/** Any test phase can report one; invalid measurements are errors. */
export function budget(name: string, measured: number, limit: number, unit: string): void {
	if (!Number.isFinite(measured) || !Number.isFinite(limit))
		throw new Error(`${name}: the measurement and baseline must be finite`);
	if (measured <= limit) return;
	if (measured > FAIL_MULTIPLE * Math.max(limit, 1))
		throw new Error(
			`${name}: ${measured} ${unit} is more than ${FAIL_MULTIPLE} times its baseline of ${limit} ${unit}. If that is intended, change the baseline in this pull request and say why.`,
		);
	const warning = `WARNING: ${name}: ${measured} ${unit} exceeds baseline ${limit} ${unit}.`;
	const directory = process.env.MAINWORTHY_BUDGET_REPORTS;
	if (directory) appendFileSync(join(directory, `${process.pid}.txt`), `${warning}\n`);
	else console.warn(warning);
}

/** Every process writes its own file inside one check run's private directory. */
export function budgetWarnings(directory: string): string {
	return readdirSync(directory)
		.sort()
		.map((file) => readFileSync(join(directory, file), "utf8"))
		.join("")
		.trimEnd();
}

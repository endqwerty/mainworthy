import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A measured baseline is advisory; invalid measurements remain errors. Any test phase can report one. */
export function budget(name: string, measured: number, limit: number, unit: string): void {
	if (!Number.isFinite(measured) || !Number.isFinite(limit))
		throw new Error(`${name}: the measurement and baseline must be finite`);
	if (measured <= limit) return;
	const warning = `WARNING: ${name}: ${measured} ${unit} exceeds baseline ${limit} ${unit}.`;
	const directory = process.env.MAINWORTHY_BUDGET_REPORTS;
	if (directory) appendFileSync(join(directory, `${process.pid}.txt`), `${warning}\n`);
	else console.warn(warning);
}

/**
 * How much slower than its baseline hostile input may be before it fails. A budget never fails, but input an attacker
 * controls is a safety question, not a speed one: a quadratic parser on a crafted report would hold the thread that
 * answers reads for minutes, and no user gains from that. Ten times catches such a blow-up, not a busy machine.
 */
export const HOSTILE_INPUT_MULTIPLE = 10;

/** A budget for input an attacker controls: it warns above the baseline and fails above ten times it. */
export function hostileInputBudget(name: string, measured: number, baseline: number, unit: string): void {
	budget(name, measured, baseline, unit);
	if (measured > HOSTILE_INPUT_MULTIPLE * baseline)
		throw new Error(
			`${name}: ${measured} ${unit} is more than ${HOSTILE_INPUT_MULTIPLE} times its baseline of ${baseline} ${unit}; hostile input must not stall the server`,
		);
}

/** Every process writes its own file inside one check run's private directory. */
export function budgetWarnings(directory: string): string {
	return readdirSync(directory)
		.sort()
		.map((file) => readFileSync(join(directory, file), "utf8"))
		.join("")
		.trimEnd();
}

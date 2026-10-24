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

/** Every process writes its own file inside one check run's private directory. */
export function budgetWarnings(directory: string): string {
	return readdirSync(directory)
		.sort()
		.map((file) => readFileSync(join(directory, file), "utf8"))
		.join("")
		.trimEnd();
}

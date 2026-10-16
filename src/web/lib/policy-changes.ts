import { type Clause, describeAsk, type Policy } from "../../core/kinds.ts";

/** A value written the same way whatever the order of its keys, so two policies compare by what they say. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "none";
}

/** Every setting of a policy by its path (`holds.flakyDays`), so a change to one can be named. */
function settingLeaves(value: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
	if (value && typeof value === "object" && !Array.isArray(value))
		for (const [key, item] of Object.entries(value)) settingLeaves(item, path ? `${path}.${key}` : key, out);
	else out.set(path, typeof value === "string" ? value : canonical(value));
	return out;
}

const clauseText = (clause: Clause): string =>
	`${clause.id}: ${clause.kind} when ${clause.when.join(" and ")}, asks ${describeAsk(clause.ask)}, agents ${clause.ask.agents}${clause.answer === undefined ? "" : `, answers ${canonical(clause.answer)}`}, blocks ${clause.blocks}`;

/** Each way the policy accepting writes differs from the one in force: preset, settings, clauses and their order. */
export function policyChanges(current: Policy, next: Policy): string[] {
	const lines: string[] = [];
	if (current.preset !== next.preset) lines.push(`Preset ${current.preset} becomes ${next.preset}`);
	const was = settingLeaves(current.settings);
	const now = settingLeaves(next.settings);
	for (const key of new Set([...was.keys(), ...now.keys()]))
		if (was.get(key) !== now.get(key))
			lines.push(`Setting ${key}: ${was.get(key) ?? "none"} becomes ${now.get(key) ?? "none"}`);
	const before = new Map(current.clauses.map((clause) => [clause.id, clause]));
	const after = new Map(next.clauses.map((clause) => [clause.id, clause]));
	for (const clause of next.clauses) {
		const old = before.get(clause.id);
		if (!old) lines.push(`Adds clause ${clauseText(clause)}`);
		else if (canonical(old) !== canonical(clause))
			lines.push(`Changes clause ${clauseText(old)}; it becomes ${clauseText(clause)}`);
	}
	for (const clause of current.clauses) if (!after.has(clause.id)) lines.push(`Removes clause ${clauseText(clause)}`);
	// The first clause that matches wins, so where a clause stands decides as much as what it says.
	const order = (clauses: Clause[]) => clauses.map((clause) => clause.id).join(", ");
	if (order(current.clauses) !== order(next.clauses))
		lines.push(`The first clause that matches wins. The order becomes ${order(next.clauses)}`);
	return lines;
}

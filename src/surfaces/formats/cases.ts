import { z } from "zod";
import { type CaseBody, emptyBody, REQUIREMENT_KEY, TAG } from "../../core/model.ts";
import { CaseAlias, type Edit, ProposeInput } from "../../core/ops.ts";

export const CaseImportFormat = z.enum(["csv", "testrail", "qase"]);
export type CaseImportFormat = z.infer<typeof CaseImportFormat>;
type Create = Extract<Edit, { op: "create" }>;
type ImportedCase = Create & { body: CaseBody; aliases: string[] };
type Row = Record<string, string>;

/** RFC 4180 records, including doubled quotes and multiline cells. No delimiter or encoding guesses. */
function csv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let state: "plain" | "quoted" | "closed" = "plain";
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (state === "quoted") {
			if (char === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else state = "closed";
			} else cell += char;
			continue;
		}
		if (char === "," || char === "\n" || char === "\r") {
			row.push(cell);
			cell = "";
			state = "plain";
			if (char !== ",") {
				if (char === "\r" && text[i + 1] === "\n") i++;
				if (row.some((value) => value !== "")) rows.push(row);
				row = [];
			}
		} else if (char === '"' && cell === "" && state === "plain") state = "quoted";
		else {
			if (state === "closed" || char === '"')
				throw new Error(`CSV record ${rows.length + 1}: unexpected character beside a quote`);
			cell += char;
		}
	}
	if (state === "quoted") throw new Error(`CSV record ${rows.length + 1}: unclosed quoted cell`);
	row.push(cell);
	if (row.some((value) => value !== "")) rows.push(row);
	return rows;
}

function execution(value: string): Pick<ReturnType<typeof emptyBody>, "methods" | "automate"> {
	switch (value.trim().toLowerCase()) {
		case "auto":
		case "automated":
			return { methods: ["auto"], automate: "none" };
		case "wanted":
		case "to-be-automated":
			return { methods: ["human"], automate: "wanted" };
		case "not-applicable":
			return { methods: ["human"], automate: "not-applicable" };
		case "":
		case "manual":
		case "human":
		case "none":
		case "is-not-automated":
			return { methods: ["human"], automate: "none" };
		default:
			throw new Error(
				`unknown execution type ${JSON.stringify(value)}; use manual, automated, to-be-automated or not-applicable`,
			);
	}
}

/** Qase examples use numbered lines, JSON strings in v2 classic steps, and tabs for child steps. */
function qaseColumn(text: string, encoded: boolean): { key: string; value: string }[] {
	const out: { key: string; value: string }[] = [];
	const path: string[] = [];
	for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (!line.trim()) continue;
		const match = /^(\t*)([1-9]\d*)\. ?(.*)$/.exec(line);
		if (!match) throw new Error("Qase step columns need numbered lines");
		const depth = match[1]?.length ?? 0;
		if (depth > path.length) throw new Error("Qase nested step has no parent");
		path.length = depth;
		path.push(match[2] ?? "");
		let value = match[3] ?? "";
		if (encoded) value = z.string().parse(JSON.parse(value));
		out.push({ key: path.join("."), value });
	}
	return out;
}

function qaseSteps(row: Row, v2: boolean): ReturnType<typeof emptyBody>["steps"] {
	if (row.steps_type && row.steps_type !== "classic" && row.steps_type !== "gherkin")
		throw new Error(`unknown Qase steps_type ${JSON.stringify(row.steps_type)}`);
	const actions = qaseColumn(row.steps_actions ?? "", v2 && row.steps_type !== "gherkin");
	const results = qaseColumn(row.steps_result ?? row.steps_results ?? "", v2);
	const data = qaseColumn(row.steps_data ?? "", v2);
	for (const column of [results, data]) {
		if (column.length && (column.length !== actions.length || column.some((entry, i) => entry.key !== actions[i]?.key)))
			throw new Error("Qase step actions, results and data must have matching numbered entries");
	}
	return actions.map((entry, i) => {
		if (!entry.value.trim()) throw new Error("Qase step action is empty");
		const input = data[i]?.value;
		return {
			id: (i + 1).toString(36).padStart(2, "0"),
			action: `${entry.key.includes(".") ? `[${entry.key}] ` : ""}${entry.value}${input ? `\n\nData: ${input}` : ""}`,
			expected: results[i]?.value || null,
		};
	});
}

/** Sources and supported export variants are recorded in decision 0047. Parsing completes before propose runs. */
export function parseCaseImport(text: string, format: CaseImportFormat, prefix = "QASE"): Create[] {
	if (text.length > 32 * 1024 * 1024) throw new Error("case CSV is larger than 32 MB");
	const records = csv(text.replace(/^\uFEFF/, "").replace(/^sep=,\r?\n/, ""));
	const headers = records.shift();
	if (!headers?.length || headers.some((key) => !key.trim()) || new Set(headers).size !== headers.length)
		throw new Error("CSV needs unique, nonempty column headers");
	const titleKey = format === "testrail" ? "Title" : "title";
	if (!headers.includes(titleKey)) throw new Error(`CSV needs a ${titleKey} column`);
	const idKey = format === "testrail" ? "ID" : format === "qase" && headers.includes("v2.id") ? "v2.id" : "id";
	if (format !== "csv" && !headers.includes(idKey)) throw new Error(`CSV needs an ${idKey} column`);
	if (format === "qase") CaseAlias.parse(`${prefix}-1`);
	const rows = records.map((values, i) => {
		if (values.length > headers.length) throw new Error(`CSV record ${i + 2}: more values than headers`);
		return Object.fromEntries(headers.map((header, j) => [header, values[j] ?? ""]));
	});
	const suites = new Map<string, { parent: string; name: string }>();
	if (format === "qase")
		for (const row of rows) {
			if (!row.suite_id || !row.suite) continue;
			const suite = { parent: row.suite_parent_id ?? "", name: row.suite };
			const previous = suites.get(row.suite_id);
			if (previous && (previous.parent !== suite.parent || previous.name !== suite.name))
				throw new Error(`Qase suite ${row.suite_id} has conflicting definitions`);
			suites.set(row.suite_id, suite);
		}
	const suitePath = (id: string): string => {
		const names: string[] = [];
		const seen = new Set<string>();
		while (id) {
			if (seen.has(id)) throw new Error("Qase suite parents form a cycle");
			seen.add(id);
			const suite = suites.get(id);
			if (!suite) throw new Error(`Qase suite ${id} is missing`);
			if (suite.name.includes("/")) throw new Error("Qase suite names containing / need renaming before import");
			names.unshift(suite.name);
			id = suite.parent;
		}
		return names.join("/");
	};
	const edits: ImportedCase[] = [];
	const sections: string[] = [];
	const aliases = new Set<string>();
	let previousId = "";
	let previous: ImportedCase | undefined;
	for (const [i, row] of rows.entries()) {
		try {
			const id = (row[idKey] ?? "").trim();
			const title = (row[titleKey] ?? "").trim();
			if (format === "qase" && row.suite_without_cases === "1" && !title && !id) continue;
			const action = format === "testrail" ? row["Steps (Step)"] || row.Steps || "" : row.steps || "";
			const expected =
				format === "testrail" ? row["Steps (Expected Result)"] || row["Expected Result"] || "" : row.expected || "";
			if (
				format === "testrail" &&
				previous &&
				((!id && !title) || (id === previousId && title === previous.body.title))
			) {
				if (!action) throw new Error("TestRail continuation row needs a step action");
				previous.body.steps.push({
					id: (previous.body.steps.length + 1).toString(36).padStart(2, "0"),
					action,
					expected: expected || null,
				});
				previous.body.fields[`import.testrail.row.${i + 2}`] = JSON.stringify(row);
				continue;
			}
			if (!title || title.length > 300) throw new Error("case title must contain 1 to 300 characters");
			if (format !== "csv" && !id) throw new Error("case id is missing");
			const alias = id ? (format === "qase" ? `${prefix}-${id}` : id) : null;
			if (alias) {
				CaseAlias.parse(alias);
				if (aliases.has(alias)) throw new Error(`duplicate case alias ${alias}`);
				aliases.add(alias);
			}
			if (format === "qase" && !/^[1-9]\d*$/.test(id)) throw new Error("Qase case id must be a positive integer");
			if (format === "testrail" && !/^C[1-9]\d*$/.test(id)) throw new Error("TestRail case id must look like C1234");
			let kind = row.execution_type ?? "";
			if (format === "qase") kind = row.automation ?? "";
			if (format === "testrail")
				kind = row["Automation Type"] || (/^(automated|manual)$/i.test(row.Type ?? "") ? row.Type : "") || "";
			const body = {
				...emptyBody(title),
				...execution(kind),
				pre: row[format === "testrail" ? "Preconditions" : "preconditions"] ?? "",
				fields: { [`import.${format}.row.${i + 2}`]: JSON.stringify(row) },
			};
			if (format === "qase") body.steps = qaseSteps(row, idKey === "v2.id");
			else if (action) body.steps = [{ id: "01", action, expected: expected || null }];
			else if (expected) throw new Error("expected result has no step action");
			let folder = row.folder || undefined;
			if (format === "qase" && row.suite_id) folder = suitePath(row.suite_id);
			if (format === "testrail" && row.Section) {
				const depth = row["Section Depth"] ? Number(row["Section Depth"]) : 0;
				if (!Number.isInteger(depth) || depth < 0 || depth > sections.length)
					throw new Error("TestRail section depth has a missing parent");
				if (row.Section.includes("/"))
					throw new Error("TestRail section names containing / need renaming before import");
				sections.length = depth;
				sections.push(row.Section);
				folder = sections.join("/");
			}
			const tags = (row.tags ?? "")
				.split(",")
				.map((tag) => tag.trim())
				.filter((tag) => TAG.test(tag));
			const covers = (row.References ?? "")
				.split(",")
				.map((key) => key.trim())
				.filter((key) => REQUIREMENT_KEY.test(key));
			previous = { op: "create", body, aliases: alias ? [alias] : [], ...(folder ? { folder } : {}), tags, covers };
			edits.push(previous);
			previousId = id;
			if (edits.length > 5000) throw new Error("an import accepts at most 5,000 cases; split the CSV");
		} catch (error) {
			throw new Error(`CSV record ${i + 2}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!edits.length) throw new Error("CSV contains no cases");
	ProposeInput.parse({ edits });
	return edits;
}

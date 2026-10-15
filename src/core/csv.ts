import { z } from "zod";
import { CaseBody, cleanPath, emptyBody, type FieldDefinitions, fieldErrors } from "./model.ts";
import { CaseAlias, cmd } from "./ops.ts";

/** RFC 4180 records, including doubled quotes and multiline cells. No delimiter or encoding guesses. */
export function parseCsv(text: string): string[][] {
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

export function csvExecution(value: string): Pick<ReturnType<typeof emptyBody>, "methods" | "automate"> {
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

export const CsvMapping = z.strictObject({
	id: z.string().min(1).max(200),
	title: z.string().min(1).max(200),
	steps: z.string().min(1).max(200).optional(),
	expected: z.string().min(1).max(200).optional(),
	folder: z.string().min(1).max(200).optional(),
	pre: z.string().min(1).max(200).optional(),
	execution: z.string().min(1).max(200).optional(),
	fields: z.record(z.string().min(1).max(80), z.string().min(1).max(200)).optional(),
});
export type CsvMapping = z.infer<typeof CsvMapping>;

export const CsvImportInput = z
	.strictObject({
		csv: z
			.string()
			.min(1)
			.max(8 * 1024 * 1024)
			.refine((text) => new TextEncoder().encode(text).length <= 8 * 1024 * 1024, "CSV is larger than 8 MB")
			.describe("UTF-8 CSV file content, with headers."),
		mapping: CsvMapping.optional(),
		preset: z.literal("testrail").optional(),
		confirm: z
			.string()
			.regex(/^[a-f0-9]{12}$/)
			.optional()
			.describe("The confirmation from the dry run. Omit to preview."),
		cmd,
	})
	.refine(
		(input) => input.mapping !== undefined || input.preset !== undefined,
		"supply a column mapping or the testrail preset",
	);
export type CsvImportInput = z.infer<typeof CsvImportInput>;

export const CsvImportRow = z.object({
	record: z.number().int().positive(),
	alias: z.string().nullable(),
	folder: z.string(),
	body: CaseBody.nullable(),
	errors: z.array(z.string()),
});
export type CsvImportRow = z.infer<typeof CsvImportRow>;

/** One CSV record is one case. Newlines inside a quoted step cell belong to that one step. */
export function mapCsv(
	text: string,
	supplied: CsvMapping | undefined,
	definitions: FieldDefinitions,
	preset?: "testrail",
): {
	headers: string[];
	rows: CsvImportRow[];
} {
	const records = parseCsv(text.replace(/^\uFEFF/, "").replace(/^sep=,\r?\n/, ""));
	const headers = records.shift()?.map((header) => header.trim());
	if (!headers?.length || headers.some((key) => !key) || new Set(headers).size !== headers.length)
		throw new Error("CSV needs unique, nonempty column headers");
	if (!records.length) throw new Error("CSV contains no cases");
	if (records.length > 5000) throw new Error("an import accepts at most 5,000 cases; split the CSV");
	const optional = (column: string): string | undefined => (headers.includes(column) ? column : undefined);
	const mapping =
		supplied ??
		(preset === "testrail"
			? {
					id: "ID",
					title: "Title",
					steps: optional("Steps (Step)") ?? optional("Steps"),
					expected: optional("Steps (Expected Result)") ?? optional("Expected Result"),
					pre: optional("Preconditions"),
					folder: optional("Section"),
					execution: optional("Automation Type") ?? optional("Type"),
				}
			: undefined);
	if (!mapping) throw new Error("supply a column mapping or the testrail preset");
	const sections: string[] = [];
	const columns = [
		mapping.id,
		mapping.title,
		mapping.steps,
		mapping.expected,
		mapping.folder,
		mapping.pre,
		mapping.execution,
		...Object.values(mapping.fields ?? {}),
	].filter((key) => key !== undefined);
	for (const column of columns)
		if (!headers.includes(column)) throw new Error(`CSV has no column ${JSON.stringify(column)}`);
	const positions = new Map(headers.map((key, index) => [key, index]));
	const rows = records.map((values, index): CsvImportRow => {
		const errors: string[] = [];
		if (values.length !== headers.length) errors.push(`expected ${headers.length} cells, got ${values.length}`);
		const cell = (column: string | undefined): string =>
			column === undefined ? "" : (values[positions.get(column) ?? -1] ?? "");
		const id = cell(mapping.id).trim();
		const alias = CaseAlias.safeParse(id);
		if (!id) errors.push("foreign id is required");
		else if (!alias.success) errors.push(`invalid case alias ${JSON.stringify(id)}`);
		const title = cell(mapping.title).trim().replace(/\s+/g, " ");
		if (!title || title.length > 300) errors.push("case title must contain 1 to 300 characters");
		let rawFolder = cell(mapping.folder);
		if (preset === "testrail" && mapping.folder === "Section" && rawFolder) {
			const depthText = cell(optional("Section Depth"));
			const depth = depthText ? Number(depthText) : 0;
			if (!Number.isInteger(depth) || depth < 0 || depth > sections.length || rawFolder.includes("/")) {
				errors.push("TestRail section depth needs its parent and section names cannot contain /");
			} else {
				sections.length = depth;
				sections.push(rawFolder);
				rawFolder = sections.join("/");
			}
		}
		const parts = cleanPath(rawFolder || "Unsorted");
		if (!parts.length || rawFolder.length > 400 || parts.some((part) => part.length > 120))
			errors.push("folder needs a path of at most 400 characters and names of at most 120 characters");
		const body = emptyBody(title);
		body.pre = cell(mapping.pre).trim();
		const action = cell(mapping.steps).trim();
		const expected = cell(mapping.expected).trim();
		if (action) body.steps = [{ id: "01", action, expected: expected || null }];
		else if (expected) errors.push("expected result has no step action");
		try {
			Object.assign(
				body,
				csvExecution(
					preset === "testrail" &&
						mapping.execution === "Type" &&
						!/^(automated|manual)$/i.test(cell(mapping.execution).trim())
						? ""
						: cell(mapping.execution),
				),
			);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		body.fields = Object.fromEntries(
			Object.entries(mapping.fields ?? {}).map(([key, column]) => {
				if (!Object.hasOwn(definitions, key)) errors.push(`custom field ${key} has no project definition`);
				return [key, cell(column)];
			}),
		);
		errors.push(...fieldErrors(body.fields, definitions));
		return { record: index + 2, alias: alias.success ? alias.data : null, folder: parts.join("/"), body, errors };
	});
	const counts = new Map<string, number>();
	for (const row of rows) if (row.alias) counts.set(row.alias, (counts.get(row.alias) ?? 0) + 1);
	for (const row of rows) {
		if (row.alias && (counts.get(row.alias) ?? 0) > 1) row.errors.push(`duplicate case alias ${row.alias} in this CSV`);
		if (row.errors.length) row.body = null;
	}
	return { headers, rows };
}

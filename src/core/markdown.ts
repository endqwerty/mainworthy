import { newStepId } from "./ids.ts";
import { CaseDoc, type Step } from "./model.ts";
import { escapeControls, reportJson } from "./text.ts";

export type CaseParseResult = { ok: true; doc: CaseDoc } | { ok: false; errors: { line: number; message: string }[] };
type ParseError = Extract<CaseParseResult, { ok: false }>["errors"][number];
type StringResult = { kind: "value"; value: string } | { kind: "error"; message: string };
type HeaderEntry = { key: string; value: string };

const headerKeys = new Set(["id", "kind", "title", "methods", "automate", "covers", "tags", "fields"]);
const trailingId = / \^([a-z0-9]{2,8})$/;
const headerPair = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+)):[ \t]*(.*)$/s;

function scalar(text: string): string {
	if (
		text === "" ||
		text.trim() !== text ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: quote controls so JSON escapes remain reversible.
		/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069:"'[\]{},#\\]/.test(text) ||
		/^[-?!&*|>%@`]/.test(text) ||
		/^(?:null|true|false|~|[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)$/i.test(text)
	)
		return reportJson(text).replaceAll("##[", "\\u0023#[");
	return text;
}

const lineEscapes: Record<string, string> = {
	"\t": "\\t",
	" ": "\\s",
	"##[": "\\u0023#[",
};

function encodeLine(text: string): string {
	return escapeControls(text.replace(/##\[|[\\\t^]|^[ >#!-]/g, (part) => lineEscapes[part] ?? `\\${part}`)).replace(
		/^(\s*)::/,
		"$1\\u003a:",
	);
}

function decodeLine(text: string): string {
	let output = "";
	for (let index = 0; index < text.length; index++) {
		const char = text.charAt(index);
		if (char !== "\\" || index + 1 >= text.length) {
			output += char;
			continue;
		}
		const next = text.charAt(index + 1);
		if (next === "u" && /^[0-9a-f]{4}$/i.test(text.slice(index + 2, index + 6))) {
			output += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16));
			index += 5;
		} else if (next === "t" || next === "r" || next === "s" || "\\^>-#!".includes(next)) {
			output += next === "t" ? "\t" : next === "r" ? "\r" : next === "s" ? " " : next;
			index++;
		} else output += char;
	}
	return output;
}

/** Prints the canonical, lossless case format. Header strings use YAML-style quoting; body escapes are documented in CHECKS.md. */
export function printCase(doc: CaseDoc): string {
	const { body } = doc;
	const lines = ["---"];
	if (doc.ref !== null) lines.push(`id: ${scalar(doc.ref)}`);
	lines.push(`kind: ${doc.kind ?? "case"}`, `title: ${scalar(body.title)}`, `methods: [${body.methods.join(", ")}]`);
	if (body.automate !== "none") lines.push(`automate: ${body.automate}`);
	lines.push(`covers: [${doc.covers.map(scalar).join(", ")}]`, `tags: [${doc.tags.map(scalar).join(", ")}]`);
	const fieldKeys = Object.keys(body.fields).sort();
	if (fieldKeys.length > 0) {
		lines.push("fields:");
		for (const key of fieldKeys) lines.push(`  ${scalar(key)}: ${scalar(body.fields[key] ?? "")}`);
	}
	lines.push("---");
	if (body.pre !== "") {
		lines.push("## Preconditions", ...body.pre.split("\n").map(encodeLine), "");
	}
	lines.push("## Steps");
	for (const step of body.steps) {
		if (step.use) {
			lines.push(`- !use ${step.use.fragment}@v${step.use.version} ^${step.id}`);
			continue;
		}
		const [first = "", ...rest] = step.action.split("\n");
		lines.push(`- ${encodeLine(first)} ^${step.id}`);
		for (const line of rest) lines.push(`  ${encodeLine(line)}`);
		if (step.expected !== null) {
			for (const line of step.expected.split("\n")) lines.push(`  > ${encodeLine(line)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function readScalar(text: string): StringResult {
	const value = text.trim();
	if (value.startsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(value);
			return typeof decoded === "string"
				? { kind: "value", value: decoded }
				: { kind: "error", message: "Expected a quoted string" };
		} catch {
			return { kind: "error", message: "Invalid double-quoted string" };
		}
	}
	if (value.startsWith("'")) {
		if (!/^'(?:[^']|'')*'$/.test(value)) return { kind: "error", message: "Invalid single-quoted string" };
		return { kind: "value", value: value.slice(1, -1).replace(/''/g, "'") };
	}
	return { kind: "value", value };
}

function readPair(text: string): HeaderEntry | null {
	const match = headerPair.exec(text);
	if (!match) return null;
	const key = readScalar(match[1] ?? "");
	return key.kind === "value" ? { key: key.value, value: match[2] ?? "" } : null;
}

function readArray({ text, line, errors }: { text: string; line: number; errors: ParseError[] }): string[] {
	const value = text.trim();
	if (!value.startsWith("[") || !value.endsWith("]")) {
		errors.push({ line, message: "Expected a flow array such as [human, auto]" });
		return [];
	}
	const inner = value.slice(1, -1);
	if (inner.trim() === "") return [];
	const tokens: string[] = [];
	let quote = "";
	let escaped = false;
	let start = 0;
	for (let index = 0; index < inner.length; index++) {
		const char = inner.charAt(index);
		if (quote === '"' && char === "\\" && !escaped) {
			escaped = true;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote && char === quote) {
			if (quote === "'" && inner.charAt(index + 1) === "'") index++;
			else quote = "";
		} else if (!quote && (char === '"' || char === "'")) quote = char;
		else if (!quote && char === ",") {
			tokens.push(inner.slice(start, index));
			start = index + 1;
		}
	}
	if (quote) errors.push({ line, message: "Unclosed quote in array" });
	tokens.push(inner.slice(start));
	const result: string[] = [];
	for (const token of tokens) {
		const decoded = readScalar(token);
		if (decoded.kind === "error") errors.push({ line, message: decoded.message });
		else result.push(decoded.value);
	}
	return result;
}

type PendingStep = { id: string; action: string[]; expected: string[] | null; line: number };

/** Reads canonical cases and hand-written headers/steps, reporting source lines. Missing ids are deterministic and collision-free. */
export function parseCase(text: string, defaults: Pick<CaseDoc["body"], "fields"> = { fields: {} }): CaseParseResult {
	const normalised = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const lines = normalised.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const errors: ParseError[] = [];
	if (lines[0] !== "---") return { ok: false, errors: [{ line: 1, message: "Expected --- to begin the header" }] };
	const end = lines.indexOf("---", 1);
	if (end === -1) return { ok: false, errors: [{ line: lines.length, message: "Missing closing --- for the header" }] };
	const header = new Map<string, { value: string; line: number }>();
	const fieldEntries: [string, string][] = [];
	const fieldKeys = new Set<string>();
	let inFields = false;
	for (let index = 1; index < end; index++) {
		const raw = lines[index] ?? "";
		const line = index + 1;
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
		if (inFields && /^[ \t]/.test(raw)) {
			const pair = readPair(raw.trimStart());
			if (!pair) {
				errors.push({ line, message: "Invalid fields entry" });
				continue;
			}
			const value = readScalar(pair.value);
			if (fieldKeys.has(pair.key)) errors.push({ line, message: `Duplicate field ${pair.key}` });
			fieldKeys.add(pair.key);
			if (value.kind === "error") errors.push({ line, message: value.message });
			else fieldEntries.push([pair.key, value.value]);
			continue;
		}
		inFields = false;
		const pair = readPair(raw);
		if (!pair) {
			errors.push({ line, message: "Invalid header entry" });
			continue;
		}
		if (!headerKeys.has(pair.key)) errors.push({ line, message: `Unknown header key ${pair.key}` });
		if (header.has(pair.key)) errors.push({ line, message: `Duplicate header key ${pair.key}` });
		header.set(pair.key, { value: pair.value, line });
		if (pair.key === "fields") {
			inFields = true;
			if (pair.value !== "" && pair.value !== "{}") errors.push({ line, message: "fields must be an indented map" });
		}
	}
	function headerString({ key, fallback }: { key: string; fallback: string }): string {
		const entry = header.get(key);
		if (!entry) return fallback;
		const value = readScalar(entry.value);
		if (value.kind === "error") {
			errors.push({ line: entry.line, message: value.message });
			return fallback;
		}
		return value.value;
	}
	function headerArray({ key, fallback }: { key: string; fallback: string[] }): string[] {
		const entry = header.get(key);
		return entry ? readArray({ text: entry.value, line: entry.line, errors }) : fallback;
	}
	const kind = headerString({ key: "kind", fallback: "case" });
	if (kind !== "case" && kind !== "fragment") {
		errors.push({ line: header.get("kind")?.line ?? 1, message: "kind must be case or fragment" });
	}
	const taken = new Set<string>();
	for (let index = end + 1; index < lines.length; index++) {
		const raw = lines[index] ?? "";
		if (/^[-*+] /.test(raw)) {
			const id = trailingId.exec(raw)?.[1];
			if (id) taken.add(id);
		}
	}
	const steps: Step[] = [];
	const stepLines: number[] = [];
	const pre: string[] = [];
	let section: "before" | "pre" | "steps" = "before";
	let seenSteps = false;
	let pending: PendingStep | null = null;
	function finishStep(): void {
		if (!pending) return;
		steps.push({ id: pending.id, action: pending.action.join("\n"), expected: pending.expected?.join("\n") ?? null });
		stepLines.push(pending.line);
		pending = null;
	}
	for (let index = end + 1; index < lines.length; index++) {
		const raw = lines[index] ?? "";
		const line = index + 1;
		if (raw === "## Preconditions" && section === "before") {
			section = "pre";
			continue;
		}
		if (raw === "## Steps") {
			if (seenSteps) errors.push({ line, message: "Duplicate Steps section; escape a literal heading as \\#" });
			if (section === "pre" && pre.at(-1) === "") pre.pop();
			section = "steps";
			seenSteps = true;
			continue;
		}
		switch (section) {
			case "before":
				if (raw.trim() !== "") errors.push({ line, message: "Expected ## Preconditions or ## Steps" });
				break;
			case "pre":
				pre.push(decodeLine(raw));
				break;
			case "steps": {
				if (/^[-*+] /.test(raw)) {
					finishStep();
					const match = trailingId.exec(raw);
					const id = match?.[1] ?? newStepId(taken, () => 0);
					taken.add(id);
					const content = raw.slice(2, match ? match.index : undefined);
					const use = /^!use (C-[1-9]\d*)@v([1-9]\d*)$/.exec(content);
					if (use) {
						steps.push({ id, action: "", expected: null, use: { fragment: use[1] ?? "", version: Number(use[2]) } });
						stepLines.push(line);
					} else if (content.startsWith("!use ")) errors.push({ line, message: "Expected !use C-1@v1" });
					else pending = { id, action: [decodeLine(content)], expected: null, line };
				} else if (pending && /^ {2}>(?: |$)/.test(raw)) {
					pending.expected ??= [];
					pending.expected.push(decodeLine(raw.startsWith("  > ") ? raw.slice(4) : ""));
				} else if (pending && raw.startsWith("  ")) {
					pending.action.push(decodeLine(raw.slice(2)));
				} else if (pending && raw.startsWith(">")) {
					pending.expected ??= [];
					pending.expected.push(decodeLine(raw.slice(raw.startsWith("> ") ? 2 : 1)));
				} else if (raw.trim() !== "") {
					errors.push({ line, message: "Expected a step or an indented continuation" });
				}
				break;
			}
			default: {
				const exhaustive: never = section;
				return exhaustive;
			}
		}
	}
	finishStep();
	if (!seenSteps) errors.push({ line: end + 2, message: "Missing ## Steps section" });
	const candidate = {
		...(kind === "fragment" ? { kind } : {}),
		ref: header.has("id") ? headerString({ key: "id", fallback: "" }) : null,
		body: {
			title: headerString({ key: "title", fallback: "" }),
			pre: pre.join("\n"),
			steps,
			methods: headerArray({ key: "methods", fallback: ["human"] }),
			automate: headerString({ key: "automate", fallback: "none" }),
			fields: header.has("fields") ? Object.fromEntries(fieldEntries) : defaults.fields,
		},
		tags: headerArray({ key: "tags", fallback: [] }),
		covers: headerArray({ key: "covers", fallback: [] }),
	};
	const validated = CaseDoc.safeParse(candidate);
	if (!validated.success) {
		for (const issue of validated.error.issues) {
			const path = issue.path;
			const key = String(path[0] === "body" ? path[1] : path[0]);
			const stepIndex = key === "steps" && typeof path[2] === "number" ? path[2] : null;
			errors.push({
				line: stepIndex === null ? (header.get(key)?.line ?? 1) : (stepLines[stepIndex] ?? end + 2),
				message: `${path.join(".")}: ${issue.message}`,
			});
		}
	}
	if (errors.length > 0) return { ok: false, errors };
	return validated.success
		? { ok: true, doc: { ...validated.data, body: { ...validated.data.body, fields: candidate.body.fields } } }
		: { ok: false, errors };
}

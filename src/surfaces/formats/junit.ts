import type { ResultIn } from "../../core/ops.ts";

type Attributes = Partial<Record<"name" | "file" | "classname" | "time" | "status" | "message" | "value", string>>;
type CaseElement = {
	kind: "case";
	tag: string;
	result: ResultIn;
	retries: number;
	integrity: "intact" | "damaged";
	previous: CaseElement | null;
};
type FailureElement = {
	kind: "failure";
	tag: string;
	report: NonNullable<ResultIn["failure"]> | null;
	detail: string;
	line: string;
	hasMessage: boolean;
	previous: FailureElement | null;
};
type SuiteElement = {
	kind: "suite";
	tag: string;
	path: string;
	file: string | undefined;
	firstResult: number;
	problem: NonNullable<ResultIn["failure"]> | null;
};
type Element =
	| CaseElement
	| FailureElement
	| SuiteElement
	| { kind: "ignored"; tag: string; propertyCase: CaseElement | null }
	| { kind: "other"; tag: string };
type Warn = (message: string, offset: number) => void;

const attributePattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
function stableName(value: string): string {
	let end = value.length;
	let changed = false;
	while (end > 0) {
		let tail = end;
		while (tail > 0 && /\s/.test(value[tail - 1] ?? "")) tail--;
		const closer = value[tail - 1];
		if (closer !== ")" && closer !== "]") break;
		const start = value.lastIndexOf(closer === ")" ? "(" : "[", tail - 1);
		if (start < 0) break;
		const marker = value.slice(start + 1, tail - 1).trim();
		if (marker.slice(0, 5).toLowerCase() !== "retry") break;
		let count = marker.slice(5).trim();
		if (count.startsWith("#")) count = count.slice(1).trim();
		if (!/^\d+$/.test(count)) break;
		end = start;
		changed = true;
	}
	return changed ? value.slice(0, end).trimEnd() : value;
}

function normalisePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function annotation(value: string, property = false): ResultIn["annotation"] {
	const match = (property ? /^@?(C-\d+)(?:@v(\d+))?$/ : /@(C-\d+)(?:@v(\d+))?(?![\w@-])/).exec(value.trim());
	const caseRef = match?.[1];
	if (caseRef === undefined) return undefined;
	const versionText = match?.[2];
	if (versionText === undefined) return { case: caseRef };
	const version = Number(versionText);
	return Number.isSafeInteger(version) ? { case: caseRef, version } : undefined;
}

function decode(value: string, offset: number, warn: Warn): string {
	if (!value.includes("&")) return value;
	return value.replace(/&([^;\s<&]*);?/g, (whole: string, entity: string, index: number) => {
		if (whole.endsWith(";")) {
			switch (entity) {
				case "amp":
					return "&";
				case "lt":
					return "<";
				case "gt":
					return ">";
				case "quot":
					return '"';
				case "apos":
					return "'";
			}
			if (/^#(?:\d+|x[\da-f]+)$/i.test(entity)) {
				const point = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
				if (
					point === 9 ||
					point === 10 ||
					point === 13 ||
					(point >= 32 && point <= 0xd7ff) ||
					(point >= 0xe000 && point <= 0xfffd) ||
					(point >= 0x10000 && point <= 0x10ffff)
				) {
					return String.fromCodePoint(point);
				}
			}
		}
		warn("Invalid or unsupported XML entity", offset + index);
		return whole;
	});
}

function attributes(content: string, from: number, to: number, offset: number, warn: Warn): Attributes {
	const result: Attributes = {};
	const seen = new Set<string>();
	let position = from;
	while (position < to) {
		const beforeWhitespace = position;
		while (position < to && /\s/.test(content[position] ?? "")) position++;
		if (position >= to) break;
		if (position === beforeWhitespace) warn("Missing whitespace before XML attribute", offset + position);
		attributePattern.lastIndex = position;
		const match = attributePattern.exec(content);
		const name = match?.[1];
		const value = match?.[2] ?? match?.[3];
		if (match === null || name === undefined || value === undefined || attributePattern.lastIndex > to) {
			warn("Malformed XML attribute", offset + position);
			const next = content.indexOf(" ", position);
			if (next < 0) break;
			position = next + 1;
			continue;
		}
		const valueStart = attributePattern.lastIndex - value.length - 1;
		if (!/^[A-Za-z_][\w.:-]*$/.test(name)) warn("Malformed XML attribute name", offset + position);
		if (seen.has(name)) warn("Duplicate XML attribute", offset + position);
		seen.add(name);
		if (value.includes("<")) warn("Unescaped < in XML attribute", offset + valueStart + value.indexOf("<"));
		const decoded = decode(value, offset + valueStart, warn);
		switch (name) {
			case "name":
			case "file":
			case "classname":
			case "time":
			case "status":
			case "message":
			case "value":
				result[name] = decoded;
		}
		position = attributePattern.lastIndex;
	}
	return result;
}

function appendFailure(element: FailureElement, text: string): void {
	if (element.report === null) return;
	if (element.detail.length < 20_000) element.detail += text.slice(0, 20_000 - element.detail.length);
	if (element.hasMessage) return;
	let pending = element.line + text;
	let end = pending.search(/[\r\n]/);
	while (end >= 0) {
		const line = pending.slice(0, end).trim();
		if (line.length > 0) {
			element.report.message = line.slice(0, 4000);
			element.hasMessage = true;
			return;
		}
		pending = pending.slice(end + 1);
		end = pending.search(/[\r\n]/);
	}
	element.line = pending.trimStart().slice(0, 4000);
	if (element.line.length === 4000) {
		element.report.message = element.line;
		element.hasMessage = true;
	}
}

function boundedKey(key: string, offset: number, warn: Warn): string {
	if (key.length <= 1000) return key;
	warn("Test key truncated to 1,000 characters", offset);
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
	return `${key.slice(0, 991)}#${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Reads JUnit XML in document order without a DOM or dependencies. Malformed input yields recovered results
 * and warnings with UTF-8 byte offsets. Nested suite names use `::`; `options.file` labels warnings only.
 * Incomplete/damaged cases cannot pass; damage outside a testcase invalidates recovered suite/report evidence.
 * Orphan failures retain their diagnostics and suite setup errors mark affected cases as errors. Casebook properties
 * override name annotations. Warnings are capped at 1,000 plus a count of omitted warnings.
 */
export function parseJUnit(
	xml: string,
	options?: { file?: string },
): { results: ResultIn[]; suites: number; warnings: string[] } {
	const results: ResultIn[] = [];
	const warnings: string[] = [];
	let suites = 0;
	const encoder = new TextEncoder();
	let warningPosition = 0;
	let warningBytes = 0;
	let omittedWarnings = 0;
	const byteOffset = (offset: number) => {
		const from = Math.min(warningPosition, offset);
		const to = Math.max(warningPosition, offset);
		let bytes = encoder.encode(xml.slice(from, to)).length;
		if (
			from < to &&
			xml.charCodeAt(from - 1) >= 0xd800 &&
			xml.charCodeAt(from - 1) <= 0xdbff &&
			xml.charCodeAt(from) >= 0xdc00 &&
			xml.charCodeAt(from) <= 0xdfff
		)
			bytes -= 2;
		warningBytes += offset >= warningPosition ? bytes : -bytes;
		warningPosition = offset;
		return warningBytes;
	};
	const warn: Warn = (message, offset) => {
		if (warnings.length >= 1000) {
			omittedWarnings++;
			return;
		}
		const bytes = byteOffset(offset);
		warnings.push(`${options?.file ? `${options.file}: ` : ""}${message} at byte offset ${bytes}`);
	};
	if (!xml.trimStart().startsWith("<")) {
		warn("Empty or non-XML JUnit report", 0);
		return { results, suites, warnings };
	}
	const stack: Element[] = [];
	const elementPositions = new Map<string, number[]>();
	const pushElement = (element: Element) => {
		const positions = elementPositions.get(element.tag);
		if (positions === undefined) elementPositions.set(element.tag, [stack.length]);
		else positions.push(stack.length);
		stack.push(element);
	};
	const popElement = () => {
		const element = stack.pop();
		if (element !== undefined) elementPositions.get(element.tag)?.pop();
		return element;
	};
	const suiteStack: SuiteElement[] = [];
	let reportProblem: NonNullable<ResultIn["failure"]> | null = null;
	let currentCase: CaseElement | null = null;
	let currentFailure: FailureElement | null = null;
	let ignoredDepth = 0;
	let rootSeen = false;
	let position = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
	let syntaxWarnings = 0;
	const warnMalformed: Warn = (message, offset) => {
		syntaxWarnings++;
		if (currentCase !== null) currentCase.integrity = "damaged";
		else {
			const suite = suiteStack.at(-1);
			if (suite === undefined) reportProblem ??= { message: "Malformed JUnit report" };
			else suite.problem ??= { message: "Malformed JUnit suite" };
		}
		warn(message, offset);
	};
	const invalidate = (from: number, problem: NonNullable<ResultIn["failure"]>) => {
		for (let index = from; index < results.length; index++) {
			const result = results[index];
			if (result !== undefined && (result.outcome === "pass" || result.outcome === "skip")) {
				result.outcome = "error";
				result.failure = { ...problem };
				delete result.note;
			}
		}
	};

	const finish = (element: Element, closed = true) => {
		switch (element.kind) {
			case "suite":
				if (element.problem !== null) invalidate(element.firstResult, element.problem);
				suiteStack.pop();
				break;
			case "case":
				if (
					(!closed || element.integrity === "damaged") &&
					(element.result.outcome === "pass" || element.result.outcome === "skip")
				) {
					element.result.outcome = "error";
					element.result.failure = { message: "Incomplete or malformed JUnit testcase" };
				}
				if (element.result.outcome === "pass" && element.retries > 0)
					element.result.note = `passed after ${element.retries} retries`;
				currentCase = element.previous;
				break;
			case "failure":
				if (element.report !== null) {
					element.report.detail = element.detail;
					if (!element.hasMessage) element.report.message = element.line.trim().slice(0, 4000);
				}
				currentFailure = element.previous;
				break;
			case "ignored":
				ignoredDepth--;
				break;
			case "other":
				break;
			default: {
				const exhaustive: never = element;
				return exhaustive;
			}
		}
	};
	const text = (from: number, to: number, cdata = false) => {
		if (currentFailure?.report !== null && currentFailure !== null && ignoredDepth === 0) {
			const value = xml.slice(from, to);
			appendFailure(currentFailure, cdata ? value : decode(value, from, warnMalformed));
		} else if (stack.length === 0 && xml.slice(from, to).trim().length > 0) {
			warnMalformed("Content outside the JUnit root", from);
		}
	};
	const limited = (value: string, limit: number, label: string, offset: number) => {
		if (value.length > limit) warn(`${label} truncated to ${limit} characters`, offset);
		return value.slice(0, limit);
	};

	while (position < xml.length) {
		const start = xml.indexOf("<", position);
		if (start < 0) {
			text(position, xml.length);
			position = xml.length;
			break;
		}
		text(position, start);
		if (xml.startsWith("<!--", start) || xml.startsWith("<?", start) || xml.startsWith("<![CDATA[", start)) {
			const cdata = xml.startsWith("<![CDATA[", start);
			const prefix = cdata ? 9 : xml.startsWith("<!--", start) ? 4 : 2;
			const suffix = cdata ? "]]>" : prefix === 4 ? "-->" : "?>";
			const end = xml.indexOf(suffix, start + prefix);
			if (cdata) text(start + prefix, end < 0 ? xml.length : end, true);
			if (end < 0) {
				warnMalformed("Unterminated XML comment, declaration or CDATA", start);
				position = xml.length;
				break;
			}
			position = end + suffix.length;
			continue;
		}
		let end = start + 1;
		let quote = "";
		let brackets = 0;
		const declaration = xml.startsWith("<!", start);
		for (; end < xml.length; end++) {
			const char = xml[end];
			if (quote !== "") {
				if (char === quote) quote = "";
			} else if (char === '"' || char === "'") quote = char;
			else if (declaration && char === "[") brackets++;
			else if (declaration && char === "]") brackets--;
			else if (char === ">" && brackets === 0) break;
			else if (char === "<" && !declaration) break;
		}
		if (end === xml.length || xml[end] === "<") {
			warnMalformed("Unterminated XML element", start);
			position = end;
			continue;
		}
		position = end + 1;
		if (declaration) {
			if (rootSeen || !/^<!DOCTYPE\s/.test(xml.slice(start, start + 11)))
				warnMalformed("Unexpected XML declaration", start);
			continue;
		}
		const content = xml.slice(start + 1, end);
		const closing = content.startsWith("/");
		const match = /^([A-Za-z_][\w.:-]*)/.exec(closing ? content.slice(1) : content);
		const tag = match?.[1];
		if (tag === undefined) {
			warnMalformed("Malformed XML element name", start);
			continue;
		}
		const name = tag.slice(tag.lastIndexOf(":") + 1);
		if (closing) {
			if (content.slice(tag.length + 1).trim() !== "") warnMalformed("Malformed XML closing element", start);
			const found = elementPositions.get(tag)?.at(-1);
			if (found === undefined) {
				warnMalformed(`Unexpected closing element </${tag}>`, start);
				continue;
			}
			if (found !== stack.length - 1) warnMalformed(`Mismatched closing element </${tag}>`, start);
			while (stack.length > found) {
				const element = popElement();
				if (element !== undefined) finish(element, stack.length === found);
			}
			continue;
		}
		if (!rootSeen) {
			rootSeen = true;
			if (name !== "testsuites" && name !== "testsuite")
				warnMalformed("Expected <testsuites> or <testsuite> root", start);
		} else if (stack.length === 0) warnMalformed("Multiple XML roots", start);
		const selfClosing = content.trimEnd().endsWith("/");
		const parent = stack.at(-1);
		const propertyCase = parent?.kind === "ignored" ? parent.propertyCase : parent?.kind === "case" ? parent : null;
		const warningsBeforeAttributes = syntaxWarnings;
		const attrs =
			ignoredDepth === 0 || (name === "property" && propertyCase !== null)
				? attributes(
						content,
						tag.length,
						selfClosing ? content.lastIndexOf("/") : content.length,
						start + 1,
						warnMalformed,
					)
				: {};
		let element: Element = { kind: "other", tag };
		if (name === "property" && propertyCase !== null && attrs.name === "casebook") {
			const claim = annotation(attrs.value ?? "", true);
			if (claim !== undefined) propertyCase.result.annotation = claim;
		} else if (ignoredDepth === 0) {
			const retry =
				name === "flakyFailure" || name === "rerunFailure" || name === "flakyError" || name === "rerunError";
			if (name === "system-out" || name === "system-err" || name === "properties" || retry) {
				if (retry && currentCase !== null) currentCase.retries++;
				element = { kind: "ignored", tag, propertyCase: name === "properties" ? currentCase : null };
				ignoredDepth++;
			} else if (name === "testsuite") {
				const suite = suiteStack.at(-1);
				const suiteName = normalisePath(attrs.name ?? "");
				element = {
					kind: "suite",
					tag,
					path: suiteName ? (suite?.path ? `${suite.path}::${suiteName}` : suiteName) : (suite?.path ?? ""),
					file: attrs.file ? normalisePath(attrs.file) : suite?.file,
					firstResult: results.length,
					problem: null,
				};
				suiteStack.push(element);
				suites++;
			} else if (name === "testcase") {
				if (currentCase !== null) warnMalformed("Nested testcase element", start);
				const suite = suiteStack.at(-1);
				const nameText = attrs.name ?? "";
				if (attrs.name === undefined) warn("Testcase has no name", start);
				const file = attrs.file ? normalisePath(attrs.file) : suite?.file;
				const prefix = file || normalisePath(attrs.classname ?? "");
				const key = [prefix, suite?.path, stableName(nameText)].filter(Boolean).join("::") || "unnamed testcase";
				const status = attrs.status?.toLowerCase();
				const result: ResultIn = {
					test: {
						key: boundedKey(key, start, warn),
						name: limited(nameText, 500, "Test name", start),
						...(file === undefined ? {} : { file: limited(file, 500, "Test file", start) }),
					},
					outcome: status === "skipped" || status === "notrun" || status === "disabled" ? "skip" : "pass",
				};
				if (attrs.time !== undefined) {
					const seconds = Number(attrs.time.trim().replace(",", "."));
					const milliseconds = Math.round(seconds * 1000);
					if (attrs.time.trim() !== "" && seconds >= 0 && Number.isSafeInteger(milliseconds))
						result.durationMs = milliseconds;
					else warn("Invalid testcase duration", start);
				}
				const claim = annotation(nameText);
				if (claim !== undefined) result.annotation = claim;
				element = {
					kind: "case",
					tag,
					result,
					retries: 0,
					integrity: syntaxWarnings === warningsBeforeAttributes ? "intact" : "damaged",
					previous: currentCase,
				};
				currentCase = element;
				results.push(result);
			} else if (name === "failure" || name === "error") {
				const suite = suiteStack.at(-1);
				const orphan = currentCase === null;
				if (orphan) warnMalformed(`${name} element outside a testcase`, start);
				const result =
					currentCase?.result ??
					(suite === undefined || results.length > suite.firstResult ? results.at(-1) : undefined);
				const outcome = name === "error" ? "error" : "fail";
				const selected =
					result === undefined || (result.outcome !== "error" && (outcome === "error" || result.outcome !== "fail"));
				const report = selected ? { message: limited(attrs.message ?? "", 4000, "Failure message", start) } : null;
				if (report !== null && result !== undefined) {
					result.outcome = outcome;
					result.failure = report;
				}
				if (orphan && report !== null) {
					if (suite === undefined) reportProblem = report;
					else suite.problem = report;
				}
				element = {
					kind: "failure",
					tag,
					report,
					detail: "",
					line: "",
					hasMessage: attrs.message !== undefined,
					previous: currentFailure,
				};
				currentFailure = element;
			} else if (name === "skipped" && currentCase !== null && currentCase.result.outcome === "pass") {
				currentCase.result.outcome = "skip";
			}
		}
		if (selfClosing) finish(element);
		else pushElement(element);
	}
	if (stack.length > 0) warnMalformed("Unclosed XML elements at end of report", xml.length);
	while (stack.length > 0) {
		const element = popElement();
		if (element !== undefined) finish(element, false);
	}
	if (!rootSeen && warnings.length === 0) warn("No JUnit root found", xml.length);
	if (reportProblem !== null) invalidate(0, reportProblem);
	if (omittedWarnings > 0)
		warnings.push(
			`${options?.file ? `${options.file}: ` : ""}${omittedWarnings} additional warnings omitted at byte offset ${byteOffset(xml.length)}`,
		);
	return { results, suites, warnings };
}

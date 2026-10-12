import type { ResultIn } from "../../core/ops.ts";

type Attributes = Partial<Record<"name" | "file" | "classname" | "time" | "status" | "message" | "value", string>>;
type KeyDigest = { first: number; second: number; firstPower: number; secondPower: number; length: number };
type DamageSpan = { from: number; to: number; problem: NonNullable<ResultIn["failure"]> };
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
	pathDigest: KeyDigest;
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

const attributePattern = /([^ \t\r\n=/>]+)[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/y;
const nameStart =
	"[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF" +
	"\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD" +
	"\\u{10000}-\\u{EFFFF}]";
const namePattern = new RegExp(
	"^(" + nameStart + "(?:" + nameStart + "|[-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040])*)",
	"u",
);
const declarationPattern = new RegExp(
	"^xml[ \\t\\r\\n]+version[ \\t\\r\\n]*=[ \\t\\r\\n]*([\"'])1\\.\\d+\\1" +
		"(?:[ \\t\\r\\n]+encoding[ \\t\\r\\n]*=[ \\t\\r\\n]*([\"'])[A-Za-z][A-Za-z0-9._-]*\\2)?" +
		"(?:[ \\t\\r\\n]+standalone[ \\t\\r\\n]*=[ \\t\\r\\n]*([\"'])(?:yes|no)\\3)?[ \\t\\r\\n]*$",
);
// biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 excludes these characters.
const invalidCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;

function digest(value: string): KeyDigest {
	let first = 0;
	let second = 0;
	let firstPower = 1;
	let secondPower = 1;
	for (let index = 0; index < value.length; index++) {
		first = (Math.imul(first, 33) + value.charCodeAt(index)) | 0;
		second = (Math.imul(second, 65599) + value.charCodeAt(index)) | 0;
		firstPower = Math.imul(firstPower, 33);
		secondPower = Math.imul(secondPower, 65599);
	}
	return { first, second, firstPower, secondPower, length: value.length };
}

function appendDigest(prefix: KeyDigest, suffix: KeyDigest): KeyDigest {
	return {
		first: (Math.imul(prefix.first, suffix.firstPower) + suffix.first) | 0,
		second: (Math.imul(prefix.second, suffix.secondPower) + suffix.second) | 0,
		firstPower: Math.imul(prefix.firstPower, suffix.firstPower),
		secondPower: Math.imul(prefix.secondPower, suffix.secondPower),
		length: prefix.length + suffix.length,
	};
}

const emptyDigest = digest("");
const separatorDigest = digest("::");

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

function keyPart(value: string): string {
	return value.trim() ? value : "";
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
	const invalid = invalidCharacter.exec(value);
	if (invalid !== null) warn("Invalid XML character", offset + invalid.index);
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
			if (/^#(?:\d+|x[\da-fA-F]+)$/.test(entity)) {
				const point = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
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
		while (position < to && /[ \t\r\n]/.test(content[position] ?? "")) position++;
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
		if (namePattern.exec(name)?.[0] !== name) warn("Malformed XML attribute name", offset + position);
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

function testKey(
	prefix: string,
	suite: SuiteElement | undefined,
	name: string,
	cache: Map<string, KeyDigest>,
	offset: number,
	warn: Warn,
): string {
	const pathLength = suite?.pathDigest.length ?? 0;
	const parts = Number(prefix.length > 0) + Number(pathLength > 0) + Number(name.length > 0);
	const length = prefix.length + pathLength + name.length + Math.max(parts - 1, 0) * 2;
	if (length <= 1000) return [prefix, suite?.path, name].filter(Boolean).join("::").trim() || "unnamed testcase";
	warn("Test key truncated to 1,000 characters", offset);
	let hash = emptyDigest;
	if (prefix.length > 0) {
		const saved = cache.get(prefix);
		hash = saved ?? digest(prefix);
		if (saved === undefined) cache.set(prefix, hash);
	}
	if (suite !== undefined && pathLength > 0)
		hash = hash.length > 0 ? appendDigest(appendDigest(hash, separatorDigest), suite.pathDigest) : suite.pathDigest;
	if (name.length > 0)
		hash = hash.length > 0 ? appendDigest(appendDigest(hash, separatorDigest), digest(name)) : digest(name);
	const shown = [prefix.slice(0, 983), suite?.path, name.slice(0, 983)].filter(Boolean).join("::").slice(0, 983);
	return `${shown}#${(hash.first >>> 0).toString(16).padStart(8, "0")}${(hash.second >>> 0).toString(16).padStart(8, "0")}`;
}

/** Applies nested damage scopes in closure order and visits each result at most once. */
function applyDamage(results: ResultIn[], spans: DamageSpan[]): void {
	if (spans.length === 0) return;
	const next = Array.from({ length: results.length + 1 }, (_, index) => index);
	const pending = (index: number) => {
		let found = index;
		while (found < results.length && next[found] !== found) found = next[found] ?? results.length;
		let current = index;
		while (current < found) {
			const parent = next[current] ?? found;
			next[current] = found;
			current = parent;
		}
		return found;
	};
	for (const span of spans) {
		for (let index = pending(span.from); index < span.to; index = pending(index + 1)) {
			const result = results[index];
			if (result !== undefined && (result.outcome === "pass" || result.outcome === "skip")) {
				result.outcome = "error";
				result.failure = { ...span.problem };
				delete result.note;
			}
			next[index] = pending(index + 1);
		}
	}
}

/**
 * Reads JUnit XML in document order without a DOM or dependencies. Malformed input yields recovered results
 * and warnings with UTF-8 byte offsets. Nested suite names use `::`; `options.file` labels warnings only.
 * Incomplete/damaged cases cannot pass; damage outside a testcase invalidates recovered suite/report evidence.
 * Orphan failures are diagnosed; testcase failures retain their diagnostics. Suite setup errors mark affected cases
 * as errors. Casebook properties override name annotations. Warnings are capped at 1,000 plus an omitted count.
 * Suite failures without testcases remain warnings; the parser never invents an execution to carry them.
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
	const damagedSpans: DamageSpan[] = [];
	const prefixDigests = new Map<string, KeyDigest>();
	let reportProblem: NonNullable<ResultIn["failure"]> | null = null;
	let currentCase: CaseElement | null = null;
	let currentFailure: FailureElement | null = null;
	let ignoredDepth = 0;
	let rootSeen = false;
	let position = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
	const warnMalformed: Warn = (message, offset) => {
		if (currentCase !== null) currentCase.integrity = "damaged";
		else {
			const suite = suiteStack.at(-1);
			if (suite === undefined) reportProblem ??= { message: "Malformed JUnit report" };
			else suite.problem ??= { message: "Malformed JUnit suite" };
		}
		warn(message, offset);
	};

	const finish = (element: Element, closed = true) => {
		switch (element.kind) {
			case "suite":
				if (element.problem !== null)
					damagedSpans.push({ from: element.firstResult, to: results.length, problem: element.problem });
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
		if (from === to || ignoredDepth > 0) return;
		const value = xml.slice(from, to);
		let decoded = value;
		if (cdata) {
			const invalid = invalidCharacter.exec(value);
			if (invalid !== null) warnMalformed("Invalid XML character", from + invalid.index);
		} else {
			const delimiter = value.indexOf("]]>");
			if (delimiter >= 0) warnMalformed("Unexpected CDATA closing delimiter", from + delimiter);
			decoded = decode(value, from, warnMalformed);
		}
		if (currentFailure?.report !== null && currentFailure !== null && ignoredDepth === 0) {
			appendFailure(currentFailure, decoded);
		} else if (stack.length === 0 && /[^ \t\r\n]/.test(value)) {
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
			else if (prefix === 4 && end >= 0 && xml.indexOf("--", start + prefix) < end)
				warnMalformed("Invalid XML comment", start);
			else if (prefix === 2) {
				const first = xml[start + 2] ?? "";
				if (!/[A-Za-z_:]/.test(first) && (first.charCodeAt(0) < 0xc0 || first === ""))
					warnMalformed("Malformed XML processing instruction", start);
				if (/^<\?xml(?=[ \t\r\n?])/i.test(xml.slice(start, start + 7))) {
					if (rootSeen || start !== (xml.charCodeAt(0) === 0xfeff ? 1 : 0))
						warnMalformed("Unexpected XML declaration", start);
					else if (end >= 0 && !declarationPattern.test(xml.slice(start + 2, end)))
						warnMalformed("Malformed XML declaration", start);
				}
			}
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
		let unescapedLessThan = -1;
		const declaration = xml.startsWith("<!", start);
		for (; end < xml.length; end++) {
			const char = xml[end];
			if (quote !== "") {
				if (char === quote) quote = "";
				else if (char === "<" && !declaration && unescapedLessThan < 0) unescapedLessThan = end;
			} else if (declaration && char === "<" && xml.startsWith("<!--", end)) {
				const commentEnd = xml.indexOf("-->", end + 4);
				if (commentEnd < 0) {
					end = xml.length;
					break;
				}
				end = commentEnd + 2;
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
			if (rootSeen || !/^<!DOCTYPE[ \t\r\n]/.test(xml.slice(start, start + 11)))
				warnMalformed("Unexpected XML declaration", start);
			continue;
		}
		const content = xml.slice(start + 1, end);
		const closing = content.startsWith("/");
		const match = namePattern.exec(closing ? content.slice(1) : content);
		const tag = match?.[1];
		if (tag === undefined) {
			warnMalformed("Malformed XML element name", start);
			continue;
		}
		const name = tag.slice(tag.lastIndexOf(":") + 1);
		if (closing) {
			if (/[^ \t\r\n]/.test(content.slice(tag.length + 1))) warnMalformed("Malformed XML closing element", start);
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
		let headerDamaged = false;
		const warnAttribute: Warn = (message, offset) => {
			headerDamaged = true;
			if (name === "testcase" || name === "testsuite") warn(message, offset);
			else warnMalformed(message, offset);
		};
		if (unescapedLessThan >= 0) warnAttribute("Unescaped < in XML attribute", unescapedLessThan);
		if (selfClosing && content.lastIndexOf("/") !== content.length - 1)
			warnAttribute("Whitespace after XML self-closing slash", end - 1);
		const attrs =
			ignoredDepth === 0 || (name === "property" && propertyCase !== null)
				? attributes(
						content,
						tag.length,
						selfClosing ? content.lastIndexOf("/") : content.length,
						start + 1,
						warnAttribute,
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
				const suiteName = keyPart(normalisePath(attrs.name ?? ""));
				const pathDigest = suiteName
					? suite !== undefined && suite.pathDigest.length > 0
						? appendDigest(appendDigest(suite.pathDigest, separatorDigest), digest(suiteName))
						: digest(suiteName)
					: (suite?.pathDigest ?? emptyDigest);
				const path = suiteName
					? suite?.path
						? suite.path.length === 1000
							? suite.path
							: `${suite.path}::${suiteName}`.slice(0, 1000)
						: suiteName.slice(0, 1000)
					: (suite?.path ?? "");
				element = {
					kind: "suite",
					tag,
					path,
					pathDigest,
					file: attrs.file ? normalisePath(attrs.file) : suite?.file,
					firstResult: results.length,
					problem: headerDamaged ? { message: "Malformed JUnit suite" } : null,
				};
				suiteStack.push(element);
				suites++;
			} else if (name === "testcase") {
				if (currentCase !== null) warnMalformed("Nested testcase element", start);
				const suite = suiteStack.at(-1);
				const nameText = attrs.name ?? "";
				if (attrs.name === undefined) warn("Testcase has no name", start);
				const file = attrs.file ? normalisePath(attrs.file) : suite?.file;
				const prefix = keyPart(file || normalisePath(attrs.classname ?? ""));
				const status = attrs.status?.toLowerCase();
				const result: ResultIn = {
					test: {
						key: testKey(prefix, suite, keyPart(stableName(nameText)), prefixDigests, start, warn),
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
					integrity: headerDamaged || currentCase !== null ? "damaged" : "intact",
					previous: currentCase,
				};
				currentCase = element;
				results.push(result);
			} else if (name === "failure" || name === "error") {
				const suite = suiteStack.at(-1);
				const orphan = currentCase === null;
				if (orphan) warnMalformed(`${name} element outside a testcase`, start);
				const previous = suite === undefined || results.length > suite.firstResult ? results.at(-1) : undefined;
				const result =
					currentCase?.result ?? (previous?.outcome === "pass" || previous?.outcome === "skip" ? previous : undefined);
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
	if (reportProblem !== null) damagedSpans.push({ from: 0, to: results.length, problem: reportProblem });
	applyDamage(results, damagedSpans);
	if (omittedWarnings > 0)
		warnings.push(
			`${options?.file ? `${options.file}: ` : ""}${omittedWarnings} additional warnings omitted at byte offset ${byteOffset(xml.length)}`,
		);
	return { results, suites, warnings };
}

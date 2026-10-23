import type { ResultIn } from "../../core/ops.ts";
import { clip, reportJson } from "../../core/text.ts";

export type ParsedResult = ResultIn & { attachmentPaths?: string[] };
export type ParsedReport = { results: ParsedResult[]; warnings: string[] };

/** Quote external identifiers for one diagnostic line, including terminal controls JSON leaves unescaped. */
export function reportIdentifier(value: string): string {
	const shortened = clip(value, 120);
	return reportJson(shortened + (shortened.length < value.length ? "…" : ""));
}

/** JUnit's 1,000-warning policy, shared by native formats without XML byte-offset context. */
export function reportWarnings() {
	const warnings: string[] = [];
	let omitted = 0;
	return {
		add(message: () => string): void {
			if (warnings.length < 1000) warnings.push(clip(message(), 1000));
			else omitted++;
		},
		finish(): string[] {
			return omitted ? [...warnings, `${omitted} additional warnings omitted`] : warnings;
		},
	};
}

const reportPath = (value: string): string => value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");

/** Native formats use the same file/class, suite and stable-name identity as JUnit. */
export function nativeResult(input: {
	name: string;
	file?: string;
	className?: string | undefined;
	suites: string[];
	outcome: ResultIn["outcome"];
	durationMs?: number | undefined;
	detail?: string | undefined;
	message?: string | undefined;
	retries?: number;
	/** The runner's earlier tries, oldest first (decision 0129). */
	tries?: NonNullable<ResultIn["tries"]>;
	annotation?: ResultIn["annotation"];
}): ResultIn {
	const withoutRetry = input.name.replace(/(?:\s*\(retry\s*#?\s*\d+\)|\s*\[retry\s*#?\s*\d+\])+\s*$/i, "");
	const stableName = withoutRetry === input.name ? input.name : withoutRetry.trimEnd();
	const file = input.file === undefined ? undefined : reportPath(input.file);
	const parts = [file || reportPath(input.className ?? ""), ...input.suites.map(reportPath), stableName].filter(
		(part) => part.trim(),
	);
	let key = parts.join("::") || "unnamed testcase";
	if (key.length > 1000) {
		let first = 0;
		let second = 0;
		for (let index = 0; index < key.length; index++) {
			first = (Math.imul(first, 33) + key.charCodeAt(index)) | 0;
			second = (Math.imul(second, 65599) + key.charCodeAt(index)) | 0;
		}
		key = `${clip(key, 983)}#${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
	} else key = key.trim();
	const result: ResultIn = {
		test: { key, name: clip(input.name, 500), ...(file === undefined ? {} : { file: clip(file, 500) }) },
		outcome: input.outcome,
	};
	if (input.durationMs !== undefined) {
		const durationMs = Math.round(input.durationMs);
		if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new Error("Invalid test duration");
		result.durationMs = durationMs;
	}
	if (input.outcome === "fail" || input.outcome === "error") {
		const detail = input.detail?.trim() || `Test ${input.outcome === "fail" ? "failed" : "errored"}`;
		result.failure = {
			message: clip(input.message?.trim() || detail.split(/\r?\n/)[0] || detail, 4000),
			detail: clip(detail, 20_000),
		};
	}
	const claim = input.annotation;
	if (claim !== undefined) result.annotation = claim;
	if (input.retries && input.outcome === "pass") result.note = `passed after ${input.retries} retries`;
	if (input.tries?.length) result.tries = input.tries;
	return result;
}

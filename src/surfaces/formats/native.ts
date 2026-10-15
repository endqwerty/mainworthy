import { caseAnnotation } from "../../core/case-annotation.ts";
import type { ResultIn } from "../../core/ops.ts";

export type ParsedReport = { results: ResultIn[]; warnings: string[] };

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
		key = `${key.slice(0, 983)}#${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
	} else key = key.trim();
	const result: ResultIn = {
		test: { key, name: input.name.slice(0, 500), ...(file === undefined ? {} : { file: file.slice(0, 500) }) },
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
			message: (input.message?.trim() || detail.split(/\r?\n/)[0] || detail).slice(0, 4000),
			detail: detail.slice(0, 20_000),
		};
	}
	const claim = input.annotation ?? caseAnnotation(input.name);
	if (claim !== undefined) result.annotation = claim;
	if (input.retries && input.outcome === "pass") result.note = `passed after ${input.retries} retries`;
	return result;
}

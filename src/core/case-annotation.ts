import type { ResultIn } from "./ops.ts";
import { CaseAlias } from "./proposals.ts";

/** Reads explicit case metadata, preserving the case and punctuation of aliases. */
export function caseAnnotation(value: string): ResultIn["annotation"] {
	const match = /^@?([a-z0-9][a-z0-9_.:/-]*)(?:@v(\d+))?$/i.exec(value.trim());
	const identifier = match?.[1];
	if (identifier === undefined) return undefined;
	if (!/^C-\d+$/.test(identifier) && !CaseAlias.safeParse(identifier).success) return undefined;
	const version = match?.[2] === undefined ? undefined : Number(match[2]);
	if (version !== undefined && !Number.isSafeInteger(version)) return undefined;
	return { case: identifier, ...(version === undefined ? {} : { version }) };
}

/** Names are free text: only native refs and aliases known to the project claim a case. */
export function caseNameAnnotation(value: string, hasAlias: (alias: string) => boolean): ResultIn["annotation"] {
	let last: ResultIn["annotation"];
	for (const token of value.matchAll(/@([a-z0-9][a-z0-9_.:/@-]*)/gi)) {
		const text = token[1]?.replace(/[.,:;!?]+$/, "");
		if (text === undefined) continue;
		const native = /^(C-\d+)(?:@v(\d+))?(?![\w@-])/i.exec(text);
		const claim = caseAnnotation(native?.[0].toUpperCase() ?? text);
		if (claim !== undefined && (native !== null || hasAlias(claim.case))) last = claim;
	}
	return last;
}

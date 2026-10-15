import { CaseAlias, type ResultIn } from "./ops.ts";

/** Reads a case ref or foreign alias, preserving the case of aliases. */
export function caseAnnotation(value: string, property = false): ResultIn["annotation"] {
	const token = (property ? /^@?([a-z0-9][a-z0-9_.:/@-]*)$/i : /@([a-z0-9][a-z0-9_.:/@-]*)/i).exec(value.trim())?.[1];
	if (token === undefined) return undefined;
	const match =
		(property ? /^(C-\d+)(?:@v(\d+))?$/i : /^(C-\d+)(?:@v(\d+))?(?![\w@-])/i).exec(token) ??
		/^([a-z0-9][a-z0-9_.:/-]*)(?:@v(\d+))?$/i.exec(token);
	const identifier = match?.[1];
	if (identifier === undefined) return undefined;
	const native = /^C-\d+$/i.test(identifier);
	if (!native && !CaseAlias.safeParse(identifier).success) return undefined;
	const caseRef = native ? identifier.toUpperCase() : identifier;
	const version = match?.[2] === undefined ? undefined : Number(match[2]);
	if (version !== undefined && !Number.isSafeInteger(version)) return undefined;
	return { case: caseRef, ...(version === undefined ? {} : { version }) };
}

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { CaseBody } from "./model.ts";

/** Encodes JSON values with lexically sorted object keys and ordered arrays; rejects values JSON cannot represent losslessly. */
export function canonicalJson(value: unknown): string {
	const ancestors = new Set<object>();
	function encode(item: unknown): string {
		if (item === null) return "null";
		if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
		if (typeof item === "number") {
			if (!Number.isFinite(item)) throw new TypeError("Canonical JSON requires finite numbers");
			return JSON.stringify(item);
		}
		if (typeof item !== "object") throw new TypeError(`Canonical JSON cannot encode ${typeof item}`);
		if (ancestors.has(item)) throw new TypeError("Canonical JSON cannot encode cycles");
		ancestors.add(item);
		try {
			if (Array.isArray(item)) return `[${Array.from(item, (entry: unknown) => encode(entry)).join(",")}]`;
			const prototype: unknown = Object.getPrototypeOf(item);
			if (prototype !== Object.prototype && prototype !== null)
				throw new TypeError("Canonical JSON requires plain objects");
			const entries = Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			if (Object.getOwnPropertySymbols(item).length > 0)
				throw new TypeError("Canonical JSON cannot encode symbol keys");
			return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry)}`).join(",")}}`;
		} finally {
			ancestors.delete(item);
		}
	}
	return encode(value);
}

function digest(text: string): string {
	return bytesToHex(sha256(utf8ToBytes(text))).slice(0, 12);
}

/** Hashes the whole body in title/pre/steps/methods/automate/fields order; inline step keys are id/action/expected, pins are id/use, field keys sorted. */
export function versionHash(body: CaseBody): string {
	const steps = body.steps.map((step) =>
		step.use
			? { id: step.id, use: { fragment: step.use.fragment, version: step.use.version } }
			: { id: step.id, action: step.action, expected: step.expected },
	);
	return digest(
		`{"title":${JSON.stringify(body.title)},"pre":${JSON.stringify(body.pre)},"steps":${JSON.stringify(steps)},"methods":${JSON.stringify(body.methods)},"automate":${JSON.stringify(body.automate)},"fields":${canonicalJson(body.fields)}}`,
	);
}

function trimLineEnds(text: string): string {
	return text.replace(/[^\S\n]+(?=\n|$)/g, "");
}

/** Hashes only preconditions and ordered action/expected claims or fragment pins, with whitespace at each line end removed. */
export function claimHash(body: CaseBody): string {
	return digest(
		JSON.stringify({
			pre: trimLineEnds(body.pre),
			steps: body.steps.map((step) =>
				step.use
					? { use: { fragment: step.use.fragment, version: step.use.version } }
					: {
							action: trimLineEnds(step.action),
							expected: step.expected === null ? null : trimLineEnds(step.expected),
						},
			),
		}),
	);
}

/** Returns the first 12 SHA-256 hex characters of canonical JSON, independent of object insertion order. */
export function contentHash(value: unknown): string {
	return digest(canonicalJson(value));
}

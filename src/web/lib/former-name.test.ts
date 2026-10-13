import { expect, test } from "bun:test";
import { adoptFormerKeys } from "./former-name.ts";

function store(entries: Record<string, string>) {
	const map = new Map(Object.entries(entries));
	return {
		map,
		get length() {
			return map.size;
		},
		key: (index: number) => [...map.keys()][index] ?? null,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
	};
}

test("keys kept under the former name move to the new prefix, and nothing else is touched", () => {
	const kept = store({
		"casebook:theme": "dark",
		"casebook:dana:draft:scratch:7": '{"title":"Checkout"}',
		"casebook:session-person": "dana",
		"mainworthy:dana:steps:scratch:C-1": "[1,2]",
		"another-app:casebook:theme": "light",
	});
	adoptFormerKeys(kept);
	expect(Object.fromEntries(kept.map)).toEqual({
		"mainworthy:theme": "dark",
		"mainworthy:dana:draft:scratch:7": '{"title":"Checkout"}',
		"mainworthy:session-person": "dana",
		"mainworthy:dana:steps:scratch:C-1": "[1,2]",
		"another-app:casebook:theme": "light",
	});
});

test("what the page already wrote under the new name is not overwritten by a former key", () => {
	const kept = store({ "casebook:theme": "dark", "mainworthy:theme": "light" });
	adoptFormerKeys(kept);
	expect(Object.fromEntries(kept.map)).toEqual({ "mainworthy:theme": "light" });
});

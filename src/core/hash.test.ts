import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { canonicalJson, claimHash, contentHash, versionHash } from "./hash.ts";
import { bodyArbitrary, exampleBody } from "./test-support.ts";

describe("canonical hashes", () => {
	test("uses synchronous SHA-256 and twelve lowercase hex characters", () => {
		expect(contentHash(null)).toBe("74234e98afe7");
		expect(contentHash({ b: 1, a: 2 })).toMatch(/^[0-9a-f]{12}$/);
		expect(canonicalJson({ b: 1, a: [2, { z: true, c: null }] })).toBe('{"a":[2,{"c":null,"z":true}],"b":1}');
	});
	test("sorts numeric-looking and prototype-like keys lexically", () => {
		const value = Object.fromEntries([
			["2", "two"],
			["10", "ten"],
			["__proto__", "safe"],
		]);
		expect(canonicalJson(value)).toBe('{"10":"ten","2":"two","__proto__":"safe"}');
	});
	test("rejects cycles and non-JSON values without silently dropping content", () => {
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		for (const value of [
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			1n,
			Symbol("x"),
			() => {},
			new Date(),
			cycle,
			{ bad: undefined },
			[undefined],
		]) {
			expect(() => contentHash(value)).toThrow(TypeError);
		}
	});
	test("permits shared references and treats negative zero as JSON zero", () => {
		const shared = { x: 1 };
		expect(contentHash([shared, shared])).toBe(contentHash([{ x: 1 }, { x: 1 }]));
		expect(contentHash(-0)).toBe(contentHash(0));
	});
	test("claim whitespace is trimmed at line ends but leading whitespace and internal numbers matter", () => {
		const body = {
			...exampleBody(),
			pre: "a\t \r\nb  ",
			steps: [{ id: "a1", action: "Act  \nAgain\t", expected: "expected 90.00, got 100.00  " }],
		};
		const trimmed = {
			...body,
			pre: "a\nb",
			steps: [{ id: "a1", action: "Act\nAgain", expected: "expected 90.00, got 100.00" }],
		};
		expect(claimHash(body)).toBe(claimHash(trimmed));
		expect(versionHash(body)).not.toBe(versionHash(trimmed));
		expect(claimHash({ ...trimmed, pre: " a\nb" })).not.toBe(claimHash(trimmed));
	});
	test("evidence hashing ignores key insertion order recursively", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				function reorder(input: unknown): unknown {
					if (Array.isArray(input)) return input.map((entry: unknown) => reorder(entry));
					if (input !== null && typeof input === "object")
						return Object.fromEntries(
							Object.entries(input)
								.reverse()
								.map(([key, entry]) => [key, reorder(entry)]),
						);
					return input;
				}
				expect(contentHash(value)).toBe(contentHash(reorder(value)));
			}),
			{ numRuns: 300 },
		);
	});
	test("version hashing ignores body, step and custom-field insertion order", () => {
		fc.assert(
			fc.property(bodyArbitrary, (body) => {
				const reordered = {
					fields: Object.fromEntries(Object.entries(body.fields).reverse()),
					automate: body.automate,
					methods: body.methods,
					steps: body.steps.map(({ id, action, expected }) => ({ expected, action, id })),
					pre: body.pre,
					title: body.title,
				};
				expect(versionHash(body)).toBe(versionHash(reordered));
			}),
		);
	});
	test("version hashing is sensitive to every covered field", () => {
		fc.assert(
			fc.property(bodyArbitrary, (body) => {
				const original = versionHash(body);
				const changes = [
					{ ...body, title: `${body.title}x` },
					{ ...body, pre: `${body.pre}x` },
					{ ...body, methods: [...body.methods, "human"] satisfies typeof body.methods },
					{ ...body, automate: body.automate === "none" ? "wanted" : "none" } satisfies typeof body,
					{ ...body, fields: { ...body.fields, changed: `${body.fields.changed ?? ""}x` } },
					{ ...body, steps: [...body.steps, { id: "zz", action: "new", expected: null }] },
				];
				for (const changed of changes) expect(versionHash(changed)).not.toBe(original);
				for (const key of ["id", "action", "expected"]) {
					const first = body.steps[0];
					if (!first) continue;
					const step =
						key === "id"
							? { ...first, id: first.id === "zz" ? "yy" : "zz" }
							: key === "action"
								? { ...first, action: `${first.action}x` }
								: { ...first, expected: `${first.expected ?? ""}x` };
					expect(versionHash({ ...body, steps: [step, ...body.steps.slice(1)] })).not.toBe(original);
				}
			}),
		);
	});
	test("claim hashing ignores all uncovered fields", () => {
		fc.assert(
			fc.property(bodyArbitrary, (body) => {
				expect(
					claimHash({
						...body,
						title: `${body.title}x`,
						methods: ["agent"],
						automate: "wanted",
						fields: { arbitrary: "value" },
						steps: body.steps.map((step, index) => ({ ...step, id: `z${index}` })),
					}),
				).toBe(claimHash(body));
			}),
		);
	});
	test("claim hashing is sensitive to every claim field and step order", () => {
		fc.assert(
			fc.property(bodyArbitrary, (body) => {
				const original = claimHash(body);
				expect(claimHash({ ...body, pre: `${body.pre}\nx` })).not.toBe(original);
				const first = body.steps[0];
				if (first) {
					expect(
						claimHash({ ...body, steps: [{ ...first, action: `${first.action}\nx` }, ...body.steps.slice(1)] }),
					).not.toBe(original);
					expect(
						claimHash({
							...body,
							steps: [{ ...first, expected: `${first.expected ?? ""}\nx` }, ...body.steps.slice(1)],
						}),
					).not.toBe(original);
				}
			}),
		);
		const body = exampleBody();
		expect(claimHash({ ...body, steps: [...body.steps].reverse() })).not.toBe(claimHash(body));
	});
});

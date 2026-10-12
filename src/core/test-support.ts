import fc from "fast-check";
import type { CaseBody, CaseDoc, Step } from "./model.ts";

export const textArbitrary = fc.oneof(
	fc.string({ maxLength: 80 }),
	fc.string({ unit: "binary", maxLength: 80 }),
	fc.constantFrom(
		"",
		"\n",
		"\r\n",
		"\t",
		"  leading and trailing  ",
		"## Steps\n\n- test ^a1",
		"\\t > # -",
		"💡 café 東京",
		"\u0000\ud800",
		"\u2028",
		"\u2029",
	),
);
export const nonemptyTextArbitrary = textArbitrary.filter((text) => text.length > 0);
export const stepArbitrary: fc.Arbitrary<Step> = fc.record({
	id: fc.stringMatching(/^[a-z0-9]{2,8}$/),
	action: nonemptyTextArbitrary,
	expected: fc.option(nonemptyTextArbitrary, { nil: null }),
});
export const bodyArbitrary: fc.Arbitrary<CaseBody> = fc.record({
	title: textArbitrary,
	pre: textArbitrary,
	steps: fc.uniqueArray(stepArbitrary, { selector: (step) => step.id, maxLength: 12 }),
	methods: fc.array(fc.constantFrom("human", "auto", "agent"), { minLength: 1, maxLength: 4 }),
	automate: fc.constantFrom("none", "wanted", "not-applicable"),
	fields: fc.dictionary(textArbitrary, textArbitrary, { maxKeys: 5 }),
});
export const docArbitrary: fc.Arbitrary<CaseDoc> = fc.record({
	ref: fc.option(textArbitrary, { nil: null }),
	body: fc.oneof(
		bodyArbitrary,
		fc.tuple(bodyArbitrary, fc.array(stepArbitrary, { maxLength: 12 })).map(([body, steps]) => ({ ...body, steps })),
	),
	tags: fc.array(textArbitrary, { maxLength: 5 }),
	covers: fc.array(textArbitrary, { maxLength: 5 }),
});

export function exampleBody(): CaseBody {
	return {
		title: "Checkout applies a percentage coupon",
		pre: "Signed in as a customer with an empty cart.",
		steps: [
			{ id: "a1", action: "Open the cart with one $100.00 item", expected: null },
			{ id: "b7", action: "Apply coupon SAVE10", expected: "Total shows $90.00" },
			{ id: "c3", action: "Reload the page", expected: "Coupon is still applied" },
		],
		methods: ["human"],
		automate: "none",
		fields: {},
	};
}

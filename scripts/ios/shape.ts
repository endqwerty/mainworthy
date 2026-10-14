// The small language `contract.ts` is written in. A shape says what the iOS app reads of one reply, once, and
// two things are made from it: the check a real reply is held to (`zod`, run by `test/ios-contract.test.ts` on
// any machine) and the Swift type that decodes it (`swift`, written by `bun scripts/ios.ts gen`). The app has
// no other description of a reply, so the two cannot disagree.
//
// A shape names only what the app reads. A reply may carry more: a field the server adds changes nothing here.
import { z } from "zod";

export type Field = { key: string; shape: Shape; doc: string | null };
export type Struct = { name: string; doc: string; fields: readonly Field[] };
export type Shape = {
	/** What a reply must look like for the app to read it. */
	zod: z.ZodType;
	/** The Swift type the app decodes it into. */
	swift: string;
	/** Every struct this shape names, itself included when it is one. */
	structs: readonly Struct[];
	/** Must the key be there even when its value is null (`nullable`)? Swift then refuses a reply without it. */
	present?: true;
};

const plain = (zod: z.ZodType, swift: string): Shape => ({ zod, swift, structs: [] });

export const text = plain(z.string(), "String");
export const whole = plain(z.number().int(), "Int");
export const number = plain(z.number(), "Double");
export const flag = plain(z.boolean(), "Bool");
/** A moment: milliseconds since 1970, as the server writes every time. */
export const moment = plain(z.number(), "Double");
/** A value the app passes on or shows as it is, whatever it holds. */
export const anything = plain(z.unknown(), "JSONValue");

export const list = (of: Shape): Shape => ({ zod: z.array(of.zod), swift: `[${of.swift}]`, structs: of.structs });
export const dictionary = (of: Shape): Shape => ({
	zod: z.record(z.string(), of.zod),
	swift: `[String: ${of.swift}]`,
	structs: of.structs,
});
/** A field the server may leave out or send as null. Swift reads both as nil. Everything else must be there. */
export const maybe = (of: Shape): Shape => ({ zod: of.zod.nullish(), swift: `${of.swift}?`, structs: of.structs });
/**
 * A field that is always there and may be null: a step's expected result, which is null where the author has
 * not said. A reply that leaves it out is not one where the author said nothing, so the check and the Swift
 * that decodes it both refuse it.
 */
export const nullable = (of: Shape): Shape => ({
	zod: of.zod.nullable(),
	swift: `${of.swift}?`,
	structs: of.structs,
	present: true,
});

/**
 * An object the app reads these fields of. A field is a shape, or a shape with a sentence about it that
 * becomes the field's comment in Swift.
 */
export function struct(name: string, doc: string, fields: Record<string, Shape | readonly [Shape, string]>): Shape {
	const read: Field[] = Object.entries(fields).map(([key, value]) =>
		"zod" in value ? { key, shape: value, doc: null } : { key, shape: value[0], doc: value[1] },
	);
	const own: Struct = { name, doc, fields: read };
	const nested = read.flatMap((field) => field.shape.structs);
	return {
		zod: z.object(Object.fromEntries(read.map((field) => [field.key, field.shape.zod]))),
		swift: name,
		structs: [...nested, own],
	};
}

/**
 * Why a reply is not what the app reads, one line for each field that is wrong, or nothing when it is.
 * `$.items[0].evidenceHash: expected string, received undefined` names the field the way a reader finds it.
 */
export function mismatches(shape: Shape, reply: unknown): string[] {
	const parsed = shape.zod.safeParse(reply);
	if (parsed.success) return [];
	return parsed.error.issues.map((issue) => {
		const path = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("");
		return `$${path}: ${issue.message}`;
	});
}

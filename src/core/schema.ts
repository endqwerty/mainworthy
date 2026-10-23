// Immutable primitive schemas shared by browser and server contracts.
import { z } from "zod";

export const text = z.string();
export const number = z.number();
export const whole = z.number().int();
export const flag = z.boolean();
export const unknownValue = z.unknown();
export const nullableText = text.nullable();
export const nullableNumber = number.nullable();
export const nullableWhole = whole.nullable();
export const texts = z.array(text);
export const data = z.record(text, unknownValue);
export const counts = z.record(text, number);

export const optionalText = text.optional();
export const optionalTexts = texts.optional();
export const optionalFlag = flag.optional();
